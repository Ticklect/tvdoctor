import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { AvailableArtifactDescriptor, ArtifactKind } from "@tvdoctor/protocol";

export const ISSUE_EVIDENCE_SLOTS = [
  "before-screenshot",
  "after-screenshot",
  "ui-excerpt",
  "transition",
  "console-log",
  "navigation-path",
  "replay",
  "trace",
] as const;

export type IssueEvidenceSlot = (typeof ISSUE_EVIDENCE_SLOTS)[number];

export interface ArtifactStoreOptions {
  readonly overwrite?: boolean;
}

export interface IssueArtifactLocation {
  readonly artifactId: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
}

export interface WriteIssueArtifactRequest {
  readonly issueId: string;
  readonly slot: IssueEvidenceSlot;
  readonly data: Uint8Array | string;
  readonly mediaType?: string;
}

export interface DescribeIssueArtifactRequest {
  readonly issueId: string;
  readonly slot: IssueEvidenceSlot;
  readonly mediaType?: string;
}

interface SlotDetails {
  readonly extension: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
}

const SAFE_PATH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function isUnsafePortableSegment(segment: string): boolean {
  return segment.length === 0
    || segment.length > 255
    || segment === "."
    || segment === ".."
    || /[<>:"|?*]/u.test(segment)
    || /[. ]$/u.test(segment)
    || WINDOWS_RESERVED_SEGMENT.test(segment);
}

export function assertPortableRelativePath(reference: string): void {
  if (reference.length === 0 || reference.length > 1_024 || reference !== reference.trim()) {
    throw new TypeError("Artifact references must contain 1-1024 characters.");
  }
  if (reference.includes("\\")
    || reference.includes("%")
    || hasControlCharacters(reference)
    || reference.startsWith("/")
    || /^[A-Za-z]:/u.test(reference)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference)) {
    throw new TypeError("Artifact references must be relative POSIX paths.");
  }
  if (reference.split("/").some((segment) => isUnsafePortableSegment(segment))) {
    throw new TypeError("Artifact references contain a segment that is not portable across supported hosts.");
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (value.length === 0
    || value.length > 200
    || !SAFE_PATH_IDENTIFIER.test(value)
    || isUnsafePortableSegment(value)) {
    throw new TypeError(`${label} must be a portable identifier.`);
  }
}

function slotDetails(slot: IssueEvidenceSlot, requestedMediaType?: string): SlotDetails {
  switch (slot) {
    case "before-screenshot":
    case "after-screenshot": {
      const mediaType = requestedMediaType ?? "image/png";
      if (mediaType !== "image/png" && mediaType !== "image/jpeg") {
        throw new TypeError("Screenshot evidence must be image/png or image/jpeg.");
      }
      return { extension: mediaType === "image/png" ? "png" : "jpg", kind: "screenshot", mediaType };
    }
    case "ui-excerpt":
      return { extension: "json", kind: "ui-tree", mediaType: "application/json" };
    case "transition":
      return { extension: "json", kind: "transition", mediaType: "application/json" };
    case "console-log":
      return { extension: "json", kind: "console-log", mediaType: "application/json" };
    case "navigation-path":
      return { extension: "json", kind: "navigation-path", mediaType: "application/json" };
    case "replay":
      return { extension: "yaml", kind: "replay", mediaType: "text/yaml" };
    case "trace":
      return { extension: "zip", kind: "trace", mediaType: "application/zip" };
  }
}

function relativeIssueArtifactPath(
  issueId: string,
  slot: IssueEvidenceSlot,
  extension: string,
): string {
  if (slot === "replay") return `replays/${issueId}.${extension}`;
  return `evidence/${issueId}/${slot}.${extension}`;
}

export class ArtifactStore {
  readonly #outputRoot: string;
  readonly #realOutputRoot: string;
  readonly #overwrite: boolean;
  #temporarySequence = 0;

  private constructor(outputRoot: string, realOutputRoot: string, overwrite: boolean) {
    this.#outputRoot = outputRoot;
    this.#realOutputRoot = realOutputRoot;
    this.#overwrite = overwrite;
  }

  static async create(outputRoot: string, options: ArtifactStoreOptions = {}): Promise<ArtifactStore> {
    const absoluteRoot = resolve(outputRoot);
    await mkdir(absoluteRoot, { recursive: true });
    const realRoot = await realpath(absoluteRoot);
    return new ArtifactStore(absoluteRoot, realRoot, options.overwrite ?? false);
  }

  get outputRoot(): string {
    return this.#outputRoot;
  }

  issueArtifactLocation(
    issueId: string,
    slot: IssueEvidenceSlot,
    mediaType?: string,
  ): IssueArtifactLocation {
    assertSafeIdentifier(issueId, "Issue ID");
    const details = slotDetails(slot, mediaType);
    const relativePath = relativeIssueArtifactPath(issueId, slot, details.extension);
    assertPortableRelativePath(relativePath);
    const absolutePath = resolve(this.#outputRoot, ...relativePath.split("/"));
    if (!isContained(this.#outputRoot, absolutePath)) {
      throw new Error("Generated artifact path escaped the output root.");
    }
    return {
      artifactId: `${issueId}:${slot}`,
      absolutePath,
      relativePath,
      kind: details.kind,
      mediaType: details.mediaType,
    };
  }

  /** Validate/create the real parent before handing a destination to a driver. */
  async reserveIssueArtifact(
    issueId: string,
    slot: IssueEvidenceSlot,
    mediaType?: string,
  ): Promise<IssueArtifactLocation> {
    const location = this.issueArtifactLocation(issueId, slot, mediaType);
    await this.#ensureSafeParent(location.absolutePath);
    try {
      const existing = await lstat(location.absolutePath);
      if (existing.isSymbolicLink()) throw new Error("Refusing to reserve an artifact symlink.");
      if (!this.#overwrite) throw new Error(`Artifact already exists: ${location.relativePath}`);
      if (!existing.isFile()) throw new Error("Artifact destination is not a regular file.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return location;
  }

  async writeIssueArtifact(request: WriteIssueArtifactRequest): Promise<AvailableArtifactDescriptor> {
    const location = this.issueArtifactLocation(request.issueId, request.slot, request.mediaType);
    await this.#atomicWrite(location.relativePath, request.data);
    return await this.#describe(location);
  }

  async describeExistingIssueArtifact(
    request: DescribeIssueArtifactRequest,
  ): Promise<AvailableArtifactDescriptor> {
    const location = this.issueArtifactLocation(request.issueId, request.slot, request.mediaType);
    return await this.#describe(location);
  }

  async writeBundleFile(relativePath: string, data: Uint8Array | string): Promise<string> {
    await this.#atomicWrite(relativePath, data);
    return resolve(this.#outputRoot, ...relativePath.split("/"));
  }

  async #ensureSafeParent(absolutePath: string): Promise<void> {
    const parent = dirname(absolutePath);
    if (!isContained(this.#outputRoot, parent)) {
      throw new Error("Artifact parent escaped the output root.");
    }
    const relativeParent = relative(this.#outputRoot, parent);
    let current = this.#outputRoot;
    for (const segment of relativeParent === "" ? [] : relativeParent.split(sep)) {
      current = resolve(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          throw new Error("Artifact parent contains a symbolic link or junction.");
        }
        if (!metadata.isDirectory()) throw new Error("Artifact parent is not a directory.");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        await mkdir(current);
      }
      const realCurrent = await realpath(current);
      if (!isContained(this.#realOutputRoot, realCurrent)) {
        throw new Error("Artifact parent resolves outside the output root.");
      }
    }
  }

  async #atomicWrite(relativePath: string, data: Uint8Array | string): Promise<void> {
    assertPortableRelativePath(relativePath);
    const absolutePath = resolve(this.#outputRoot, ...relativePath.split("/"));
    if (!isContained(this.#outputRoot, absolutePath)) {
      throw new Error("Artifact path escaped the output root.");
    }
    await this.#ensureSafeParent(absolutePath);

    try {
      const existing = await lstat(absolutePath);
      if (existing.isSymbolicLink()) throw new Error("Refusing to overwrite an artifact symlink.");
      if (!this.#overwrite) throw new Error(`Artifact already exists: ${relativePath}`);
      if (!existing.isFile()) throw new Error("Artifact destination is not a regular file.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    this.#temporarySequence += 1;
    const temporaryPath = `${absolutePath}.${String(process.pid)}.${String(this.#temporarySequence)}.tmp`;
    try {
      await writeFile(temporaryPath, data, { flag: "wx" });
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch {
        // Preserve the original write failure; the controlled temp file can be
        // removed by the caller if the host denied cleanup.
      }
      throw error;
    }
  }

  async #describe(location: IssueArtifactLocation): Promise<AvailableArtifactDescriptor> {
    const metadata = await lstat(location.absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Evidence artifact must be a regular non-symlink file.");
    }
    const realFile = await realpath(location.absolutePath);
    if (!isContained(this.#realOutputRoot, realFile)) {
      throw new Error("Evidence artifact resolves outside the output root.");
    }
    const data = await readFile(realFile);
    const currentMetadata = await stat(realFile);
    return {
      id: location.artifactId,
      kind: location.kind,
      status: "available",
      path: location.relativePath,
      mediaType: location.mediaType,
      byteLength: currentMetadata.size,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  }
}

export async function createArtifactStore(
  outputRoot: string,
  options: ArtifactStoreOptions = {},
): Promise<ArtifactStore> {
  return await ArtifactStore.create(outputRoot, options);
}
