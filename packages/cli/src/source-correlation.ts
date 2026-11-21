import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { TVDoctorIssue } from "@tvdoctor/protocol";
import {
  sanitiseUntrustedText,
  stableJson,
  type ArtifactStore,
  type JsonValue,
} from "@tvdoctor/reporters";

export const SOURCE_CORRELATION_JSON_PATH = "exports/source-correlation.json";
export const SOURCE_CORRELATION_MARKDOWN_PATH = "exports/source-correlation.md";

export interface SourceCorrelationLimits {
  readonly maxDirectories: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxIdentifiers: number;
  readonly maxFindings: number;
  readonly maxMatches: number;
  readonly maxMatchesPerIdentifier: number;
}

export const DEFAULT_SOURCE_CORRELATION_LIMITS: SourceCorrelationLimits = {
  maxDirectories: 512,
  maxFiles: 2_500,
  maxFileBytes: 512 * 1_024,
  maxTotalBytes: 24 * 1_024 * 1_024,
  maxIdentifiers: 96,
  maxFindings: 128,
  maxMatches: 256,
  maxMatchesPerIdentifier: 16,
};

type FindingActionability = "VERIFIED" | "REVIEW";
type IdentifierRole = "fromElement" | "expectedElement" | "observedElement";

export interface SourceCorrelationMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface SourceCorrelationIdentifier {
  readonly value: string;
  readonly roles: readonly IdentifierRole[];
  readonly matches: readonly SourceCorrelationMatch[];
}

export interface SourceCorrelationFinding {
  readonly issueId: string;
  readonly actionability: FindingActionability;
  readonly identifiers: readonly SourceCorrelationIdentifier[];
}

export interface SourceCorrelationResult {
  readonly schemaVersion: "tvdoctor.source-correlation/v1";
  readonly status: "complete" | "bounded";
  readonly boundedBy: readonly string[];
  readonly scanned: {
    readonly directories: number;
    readonly files: number;
    readonly bytes: number;
    readonly skippedBinary: number;
    readonly skippedGeneratedOrVendor: number;
    readonly skippedOversize: number;
    readonly skippedUnreadable: number;
  };
  readonly limits: SourceCorrelationLimits;
  readonly findings: readonly SourceCorrelationFinding[];
}

export interface WriteSourceCorrelationRequest {
  readonly store: ArtifactStore;
  readonly sourceRoot: string;
  readonly issues: readonly TVDoctorIssue[];
  readonly excludeRoots?: readonly string[];
  readonly limits?: Partial<SourceCorrelationLimits>;
}

export interface SourceCorrelationArtifacts {
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly result: SourceCorrelationResult;
}

const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "gen",
  "generated",
  "node_modules",
  "out",
  "target",
  "vendor",
  "vendors",
]);

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".7z", ".a", ".apk", ".avi", ".bin", ".bmp", ".class", ".db", ".dll",
  ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg",
  ".lockb", ".mov", ".mp3", ".mp4", ".o", ".obj", ".otf", ".pdf", ".png",
  ".so", ".sqlite", ".tar", ".tif", ".tiff", ".ttf", ".webm", ".webp",
  ".woff", ".woff2", ".zip",
]);

const GENERIC_ELEMENT_LABELS: ReadonlySet<string> = new Set([
  "alert",
  "alertdialog",
  "button",
  "checkbox",
  "dialog",
  "gridcell",
  "heading",
  "link",
  "listbox",
  "menu",
  "menuitem",
  "option",
  "radio",
  "region",
  "searchbox",
  "slider",
  "switch",
  "tab",
  "textbox",
]);

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === ""
    || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function actionability(issue: TVDoctorIssue): FindingActionability | null {
  if (issue.severity === "info"
    || issue.rule === "remote.startup-blocker"
    || issue.confidence === "unobservable") {
    return null;
  }
  if (issue.confidence === "deterministic"
    && issue.evidence.some((evidence) => evidence.kind === "deterministic-failure")
    && issue.reproduction.status === "available"
    && issue.reproduction.confidence === "deterministic") {
    return "VERIFIED";
  }
  return "REVIEW";
}

function exactIdentifier(value: string | null): string | null {
  if (value === null) return null;
  const candidate = value.trim();
  if (candidate.length < 2 || candidate.length > 256) return null;
  if (candidate !== sanitiseUntrustedText(candidate, 256)) return null;
  if (/\s/u.test(candidate)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(candidate)) return null;
  if (!/^[\p{L}\p{N}_.:$@/#-]+$/u.test(candidate)) return null;
  if (GENERIC_ELEMENT_LABELS.has(candidate.toLowerCase())) return null;
  return candidate;
}

function findingIdentifiers(issue: TVDoctorIssue): readonly {
  readonly value: string;
  readonly roles: readonly IdentifierRole[];
}[] {
  if (issue.transition === null) return [];
  const values: readonly (readonly [IdentifierRole, string | null])[] = [
    ["fromElement", issue.transition.fromElement],
    ["expectedElement", issue.transition.expectedElement],
    ["observedElement", issue.transition.observedElement],
  ];
  const byValue = new Map<string, Set<IdentifierRole>>();
  for (const [role, raw] of values) {
    const identifier = exactIdentifier(raw);
    if (identifier === null) continue;
    const roles = byValue.get(identifier) ?? new Set<IdentifierRole>();
    roles.add(role);
    byValue.set(identifier, roles);
  }
  return [...byValue.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([value, roles]) => ({ value, roles: [...roles].sort() }));
}

function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  const sampleLength = Math.min(buffer.length, 8_192);
  if (sampleLength === 0) return false;
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index] ?? 0;
    if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) suspicious += 1;
  }
  return suspicious / sampleLength > 0.08;
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<{
  readonly buffer: Buffer;
  readonly exceeded: boolean;
}> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      buffer: buffer.subarray(0, Math.min(bytesRead, maximumBytes)),
      exceeded: bytesRead > maximumBytes,
    };
  } finally {
    await handle.close();
  }
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /^[\p{L}\p{N}_.:$@/#-]$/u.test(character);
}

function lineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function locationForOffset(starts: readonly number[], offset: number): { readonly line: number; readonly column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle] ?? 0;
    const next = starts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < start) high = middle - 1;
    else if (offset >= next) low = middle + 1;
    else return { line: middle + 1, column: offset - start + 1 };
  }
  return { line: 1, column: offset + 1 };
}

function portableRelativePath(root: string, file: string): string | null {
  const difference = relative(root, file);
  if (difference === ""
    || difference === ".."
    || difference.startsWith(`..${sep}`)
    || isAbsolute(difference)) {
    return null;
  }
  return sanitiseUntrustedText(difference.split(sep).join("/"), 1_024);
}

function addBound(boundaries: Set<string>, reason: string): void {
  boundaries.add(reason);
}

function boundedLimits(overrides: Partial<SourceCorrelationLimits> | undefined): SourceCorrelationLimits {
  const merged = { ...DEFAULT_SOURCE_CORRELATION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Source correlation limit ${name} must be a positive safe integer.`);
    }
  }
  return merged;
}

async function resolvedExistingPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

export function githubWorkspaceSourceRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (environment["GITHUB_ACTIONS"] !== "true") return undefined;
  const workspace = environment["GITHUB_WORKSPACE"]?.trim();
  if (workspace === undefined || workspace.length === 0 || workspace.includes("\0") || !isAbsolute(workspace)) {
    return undefined;
  }
  return workspace;
}

export async function correlateSource(
  sourceRoot: string,
  issues: readonly TVDoctorIssue[],
  options: {
    readonly excludeRoots?: readonly string[];
    readonly limits?: Partial<SourceCorrelationLimits>;
  } = {},
): Promise<SourceCorrelationResult> {
  const limits = boundedLimits(options.limits);
  const root = await realpath(resolve(sourceRoot));
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) throw new TypeError("Source correlation root must be a directory.");

  const exclusions = await Promise.all((options.excludeRoots ?? []).map(resolvedExistingPath));
  const boundedBy = new Set<string>();
  const candidates = issues
    .map((issue) => {
      const classification = actionability(issue);
      if (classification === null) return null;
      const identifiers = findingIdentifiers(issue);
      if (identifiers.length === 0) return null;
      return { issue, actionability: classification, identifiers };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => left.issue.id.localeCompare(right.issue.id, "en"));

  if (candidates.length > limits.maxFindings) addBound(boundedBy, "findings");
  const selectedCandidates = candidates.slice(0, limits.maxFindings);
  const allIdentifiers = [...new Set(selectedCandidates.flatMap((entry) => entry.identifiers.map(({ value }) => value)))]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (allIdentifiers.length > limits.maxIdentifiers) addBound(boundedBy, "identifiers");
  const identifiers = allIdentifiers.slice(0, limits.maxIdentifiers);
  const identifierSet = new Set(identifiers);
  const matches = new Map<string, SourceCorrelationMatch[]>(
    identifiers.map((identifier) => [identifier, []]),
  );

  let directories = 0;
  let files = 0;
  let bytes = 0;
  let skippedBinary = 0;
  let skippedGeneratedOrVendor = 0;
  let skippedOversize = 0;
  let skippedUnreadable = 0;
  let totalMatches = 0;
  const queue = [root];

  scan: while (queue.length > 0) {
    if (directories >= limits.maxDirectories) {
      addBound(boundedBy, "directories");
      break;
    }
    const directory = queue.shift();
    if (directory === undefined) break;
    directories += 1;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skippedUnreadable += 1;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (exclusions.some((excluded) => isContained(excluded, candidate))) {
        skippedGeneratedOrVendor += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          skippedGeneratedOrVendor += 1;
          continue;
        }
        queue.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files >= limits.maxFiles) {
        addBound(boundedBy, "files");
        break scan;
      }
      files += 1;
      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        skippedBinary += 1;
        continue;
      }
      let metadata;
      try {
        metadata = await stat(candidate);
      } catch {
        skippedUnreadable += 1;
        continue;
      }
      if (!metadata.isFile()) continue;
      if (metadata.size > limits.maxFileBytes) {
        skippedOversize += 1;
        continue;
      }
      const remainingBytes = limits.maxTotalBytes - bytes;
      if (remainingBytes <= 0) {
        addBound(boundedBy, "bytes");
        break scan;
      }
      if (metadata.size > remainingBytes) {
        addBound(boundedBy, "bytes");
        continue;
      }
      let realFile: string;
      let buffer: Buffer;
      try {
        realFile = await realpath(candidate);
        if (!isContained(root, realFile)) {
          skippedUnreadable += 1;
          continue;
        }
        const read = await readBoundedFile(realFile, Math.min(limits.maxFileBytes, remainingBytes));
        if (read.exceeded) {
          if (remainingBytes < limits.maxFileBytes) addBound(boundedBy, "bytes");
          else skippedOversize += 1;
          continue;
        }
        buffer = read.buffer;
      } catch {
        skippedUnreadable += 1;
        continue;
      }
      bytes += buffer.length;
      if (isBinary(buffer)) {
        skippedBinary += 1;
        continue;
      }
      const path = portableRelativePath(root, realFile);
      if (path === null) continue;
      const text = buffer.toString("utf8");
      const starts = lineStarts(text);
      for (const identifier of identifiers) {
        const identifierMatches = matches.get(identifier);
        if (identifierMatches === undefined || identifierMatches.length >= limits.maxMatchesPerIdentifier) continue;
        let offset = text.indexOf(identifier);
        while (offset >= 0) {
          const before = offset === 0 ? undefined : text[offset - 1];
          const afterOffset = offset + identifier.length;
          const after = afterOffset >= text.length ? undefined : text[afterOffset];
          if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) {
            const location = locationForOffset(starts, offset);
            identifierMatches.push({ path, ...location });
            totalMatches += 1;
            if (identifierMatches.length >= limits.maxMatchesPerIdentifier) {
              addBound(boundedBy, "matches-per-identifier");
              break;
            }
            if (totalMatches >= limits.maxMatches) {
              addBound(boundedBy, "matches");
              break scan;
            }
          }
          offset = text.indexOf(identifier, offset + Math.max(1, identifier.length));
        }
      }
    }
  }

  const findings: SourceCorrelationFinding[] = [];
  for (const candidate of selectedCandidates) {
    const correlatedIdentifiers = candidate.identifiers
      .filter(({ value }) => identifierSet.has(value))
      .map(({ value, roles }) => ({
        value: sanitiseUntrustedText(value, 256),
        roles,
        matches: matches.get(value) ?? [],
      }));
    if (correlatedIdentifiers.length === 0) continue;
    findings.push({
      issueId: sanitiseUntrustedText(candidate.issue.id, 256),
      actionability: candidate.actionability,
      identifiers: correlatedIdentifiers,
    });
  }

  return {
    schemaVersion: "tvdoctor.source-correlation/v1",
    status: boundedBy.size === 0 ? "complete" : "bounded",
    boundedBy: [...boundedBy].sort(),
    scanned: {
      directories,
      files,
      bytes,
      skippedBinary,
      skippedGeneratedOrVendor,
      skippedOversize,
      skippedUnreadable,
    },
    limits,
    findings,
  };
}

function markdownCode(value: string): string {
  return `\`${sanitiseUntrustedText(value, 1_024).replaceAll("`", "'")}\``;
}

export function renderSourceCorrelationMarkdown(result: SourceCorrelationResult): string {
  const lines = [
    "# Source correlation",
    "",
    "These are exact textual matches for element/resource identifiers observed in VERIFIED or REVIEW findings. TVDoctor does not infer filenames or components when the identifier text is absent.",
    "",
    `Scan status: **${result.status.toUpperCase()}**; ${String(result.scanned.files)} files / ${String(result.scanned.bytes)} bytes examined.`,
  ];
  if (result.boundedBy.length > 0) {
    lines.push("", `Bounds reached: ${result.boundedBy.map(markdownCode).join(", ")}.`);
  }
  if (result.findings.length === 0) {
    lines.push("", "No correlatable VERIFIED/REVIEW element identifiers were available.");
    return `${lines.join("\n")}\n`;
  }
  for (const finding of result.findings) {
    lines.push("", `## ${finding.actionability} ${markdownCode(finding.issueId)}`);
    for (const identifier of finding.identifiers) {
      const roleText = identifier.roles.join(", ");
      if (identifier.matches.length === 0) {
        lines.push(`- ${markdownCode(identifier.value)} (${roleText}): no exact source match`);
        continue;
      }
      lines.push(`- ${markdownCode(identifier.value)} (${roleText})`);
      for (const match of identifier.matches) {
        lines.push(`  - ${markdownCode(`${match.path}:${String(match.line)}:${String(match.column)}`)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function writeSourceCorrelationArtifacts(
  request: WriteSourceCorrelationRequest,
): Promise<SourceCorrelationArtifacts> {
  const result = await correlateSource(request.sourceRoot, request.issues, {
    ...(request.excludeRoots === undefined ? {} : { excludeRoots: request.excludeRoots }),
    ...(request.limits === undefined ? {} : { limits: request.limits }),
  });
  const jsonPath = await request.store.writeBundleFile(
    SOURCE_CORRELATION_JSON_PATH,
    `${stableJson(JSON.parse(JSON.stringify(result)) as JsonValue)}\n`,
  );
  const markdownPath = await request.store.writeBundleFile(
    SOURCE_CORRELATION_MARKDOWN_PATH,
    renderSourceCorrelationMarkdown(result),
  );
  return { jsonPath, markdownPath, result };
}
