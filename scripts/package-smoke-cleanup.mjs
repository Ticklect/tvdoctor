import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const WINDOWS_TRANSIENT_CLEANUP_ERRORS = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
// npm/Playwright child processes and Windows Defender can retain a just-used
// package tree briefly after the process that owned it has exited. Ten seconds
// proved too short on a real package-smoke run, so keep retrying transient
// Windows directory locks for up to roughly 30 seconds before failing closed.
const WINDOWS_CLEANUP_ATTEMPTS = 120;
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 250;

// Allow for a cold PowerShell start on Windows CI before the bounded delete retries.
export const WINDOWS_NATIVE_CLEANUP_TIMEOUT_MS = 30_000;

/** The fallback accepts the owned path as environment data, never shell text. */
export function windowsNativeCleanupScript() {
  return [
    "$target = [IO.Path]::GetFullPath($env:TVDOCTOR_SMOKE_OWNED_TEMP)",
    "$parent = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\\', '/')",
    "if (-not [string]::Equals([IO.Path]::GetDirectoryName($target), $parent, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($target).StartsWith('tvdoctor-package-smoke-', [StringComparison]::Ordinal)) { throw 'Unsafe smoke cleanup target' }",
    "for ($i = 0; $i -lt 8; $i++) {",
    "  if (-not [IO.Directory]::Exists($target)) { exit 0 }",
    "  try { [IO.Directory]::Delete('\\\\?\\' + $target, $true); exit 0 }",
    "  catch { if ($i -eq 7) { throw }; Start-Sleep -Milliseconds 500 }",
    "}",
  ].join("\n");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function removeTemporaryTree(path, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const remove = dependencies.remove ?? ((target) => rm(target, {
    recursive: true,
    force: true,
  }));
  const delay = dependencies.delay ?? sleep;
  const maximumAttempts = platform === "win32" ? WINDOWS_CLEANUP_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await remove(path);
      return;
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
      if (platform !== "win32"
        || typeof code !== "string"
        || !WINDOWS_TRANSIENT_CLEANUP_ERRORS.has(code)
        || attempt === maximumAttempts) {
        throw error;
      }
      await delay(WINDOWS_CLEANUP_RETRY_DELAY_MS);
    }
  }
}

/**
 * A Windows process may retain a directory handle after all package files
 * have been removed. Only an owned tree containing *no files or symlinks*
 * can be left for later OS cleanup; failure to inspect stays a hard failure.
 */
export async function hasOnlyEmptyDirectories(root) {
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    let metadata;
    try { metadata = await lstat(directory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    count += 1;
    if (count > 128) return false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      pending.push(join(directory, entry.name));
    }
  }
  return true;
}
