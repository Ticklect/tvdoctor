import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
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

export interface IssueEvidenceSlotDetails {
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

export function issueEvidenceSlotDetails(
  slot: IssueEvidenceSlot,
  requestedMediaType?: string,
): IssueEvidenceSlotDetails {
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

export function relativeIssueArtifactPath(
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
    const rootMetadata = await lstat(absoluteRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("Artifact output root must be a real directory, not a symbolic link or junction.");
    }
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
    const details = issueEvidenceSlotDetails(slot, mediaType);
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

  /**
   * In overwrite mode, remove the old canonical completeness marker before
   * replacing any derivative. A failed refresh can then leave an incomplete
   * directory, but it cannot masquerade as a coherent completed bundle.
   */
  async prepareReportBundleWrite(): Promise<void> {
    if (!this.#overwrite) return;
    const markerPath = resolve(this.#outputRoot, "report.json");
    try {
      const metadata = await lstat(markerPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Existing report.json completeness marker is not a regular non-link file.");
      }
      const realMarker = await realpath(markerPath);
      if (!isContained(this.#realOutputRoot, realMarker)) {
        throw new Error("Existing report.json completeness marker resolves outside the output root.");
      }
      await unlink(markerPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  /**
   * Verify that a descriptor still names the exact immutable bytes inside this
   * store. Bundle writers call this before publishing any report derivative.
   */
  async verifyAvailableArtifact(descriptor: AvailableArtifactDescriptor): Promise<void> {
    assertPortableRelativePath(descriptor.path);
    const absolutePath = resolve(this.#outputRoot, ...descriptor.path.split("/"));
    if (!isContained(this.#outputRoot, absolutePath)) {
      throw new Error(`Artifact ${descriptor.id} escaped the output root.`);
    }
    const metadata = await lstat(absolutePath).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") {
        throw new Error(`Available artifact ${descriptor.id} is missing: ${descriptor.path}`);
      }
      throw error;
    });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Available artifact ${descriptor.id} must be a regular non-link file.`);
    }
    const realFile = await realpath(absolutePath);
    if (!isContained(this.#realOutputRoot, realFile)) {
      throw new Error(`Available artifact ${descriptor.id} resolves outside the output root.`);
    }
    const currentMetadata = await stat(realFile);
    if (!currentMetadata.isFile() || currentMetadata.size !== descriptor.byteLength) {
      throw new Error(`Available artifact ${descriptor.id} byte length does not match its descriptor.`);
    }
    if (descriptor.sha256 === null) {
      throw new Error(`Available artifact ${descriptor.id} is missing its SHA-256 digest.`);
    }
    // Artifacts can legitimately be large traces or screenshots. Hash them as
    // a bounded-memory stream instead of loading descriptor-controlled sizes.
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(realFile)) hash.update(chunk);
    const digest = hash.digest("hex");
    if (digest !== descriptor.sha256) {
      throw new Error(`Available artifact ${descriptor.id} SHA-256 does not match its descriptor.`);
    }
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
    const temporaryPath = `${absolutePath}.${String(process.pid)}.${String(this.#temporarySequence)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, data, { flag: "wx" });
      if (this.#overwrite) {
        await rename(temporaryPath, absolutePath);
      } else {
        // A hard link publishes the same-filesystem temporary file with
        // atomic no-replace semantics on every supported host. Plain rename
        // would overwrite a concurrently created destination on POSIX.
        await link(temporaryPath, absolutePath);
        try {
          await unlink(temporaryPath);
        } catch {
          // The destination is complete. A controlled temp-link cleanup
          // failure must not turn a successful publication into a false error.
        }
      }
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
