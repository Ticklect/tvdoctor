import { rm } from "node:fs/promises";

const WINDOWS_TRANSIENT_CLEANUP_ERRORS = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
// npm/Playwright child processes and Windows Defender can retain a just-used
// package tree briefly after the process that owned it has exited. Ten seconds
// proved too short on a real package-smoke run, so keep retrying transient
// Windows directory locks for up to roughly 30 seconds before failing closed.
const WINDOWS_CLEANUP_ATTEMPTS = 120;
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 250;

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
