export const ARTIFACT_STATUSES = ["available", "unavailable", "failed"] as const;

export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_KINDS = [
  "screenshot",
  "ui-tree",
  "transition",
  "console-log",
  "trace",
  "navigation-path",
  "replay",
  "report",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

interface ArtifactIdentity {
  readonly id: string;
  readonly kind: ArtifactKind;
}

export interface AvailableArtifactDescriptor extends ArtifactIdentity {
  readonly status: "available";
  /** Portable, POSIX-style path relative to the report bundle root. */
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  /** Lower-case hexadecimal SHA-256, or null when hashing was unavailable. */
  readonly sha256: string | null;
}

export interface UnavailableArtifactDescriptor extends ArtifactIdentity {
  readonly status: "unavailable";
  readonly reason: string;
}

export interface FailedArtifactDescriptor extends ArtifactIdentity {
  readonly status: "failed";
  readonly reason: string;
}

export type ArtifactDescriptor =
  | AvailableArtifactDescriptor
  | UnavailableArtifactDescriptor
  | FailedArtifactDescriptor;
