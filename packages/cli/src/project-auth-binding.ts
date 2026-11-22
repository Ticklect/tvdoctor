import { createHash } from "node:crypto";

/** Report metadata binding the original authored protected-content oracle.
 * Only a digest is persisted; accessible page names and private journey paths
 * are never echoed in public reports or CI summaries. */
export const PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY = "authReadySha256";

export interface ProjectAuthReadyMarker {
  readonly role: "heading" | "region" | "button";
  readonly name: string;
}

export function projectAuthReadyDigest(marker: ProjectAuthReadyMarker): string {
  if ((marker.role !== "heading" && marker.role !== "region" && marker.role !== "button")
    || typeof marker.name !== "string" || marker.name.length === 0 || marker.name.length > 128
    || marker.name.trim() !== marker.name || /[\p{Cc}\p{Cf}]/u.test(marker.name)) {
    throw new TypeError("Invalid protected content assertion.");
  }
  return createHash("sha256").update(JSON.stringify({ role: marker.role, name: marker.name })).digest("hex");
}
