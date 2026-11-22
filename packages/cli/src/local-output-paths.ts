import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve filesystem aliases on trusted output configuration before reserving child paths. */
export function canonicalOutputRoot(configuredPath: string): string {
  let candidate = resolve(configuredPath);
  const missing: string[] = [];
  for (;;) {
    const existing = lstatSync(candidate, { throwIfNoEntry: false });
    if (existing !== undefined) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new TypeError("The configured output root must be an ordinary directory.");
      }
      return join(realpathSync.native(candidate), ...missing.reverse());
    }
    const parent = dirname(candidate);
    if (parent === candidate) throw new TypeError("The configured output root has no existing parent.");
    missing.push(basename(candidate));
    candidate = parent;
  }
}

/** Windows can give the same ordinary file several spellings, including DOS short names. */
export async function canonicalRegisteredFile(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (canonical === path) return canonical;
  if (process.platform !== "win32") throw new TypeError("The registered file path contains an alias.");

  // A short name or case alias is an ordinary filesystem entry. A junction or
  // symlink is a redirect, which cannot substitute another file for a registration.
  let candidate = path;
  for (;;) {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new TypeError("The registered file path uses a symbolic link or junction.");
    }
    const parent = dirname(candidate);
    if (parent === candidate) return canonical;
    candidate = parent;
  }
}
