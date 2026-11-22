import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import { hasOnlyEmptyDirectories, removeTemporaryTree, windowsNativeCleanupScript } from "./package-smoke-cleanup.mjs";

test("only locked, artifact-free temporary directories may defer Windows cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "tvdoctor-package-smoke-empty-test-"));
  // The recursive test teardown must not reach outside this directly owned
  // temporary leaf even if a caller changes the ambient working directory.
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.match(basename(root), /^tvdoctor-package-smoke-empty-test-/u);
  try {
    const consumer = join(root, "consumer");
    await mkdir(join(consumer, "nested"), { recursive: true });
    assert.equal(await hasOnlyEmptyDirectories(root), true);
    const packageFile = join(consumer, "nested", "package.json");
    await writeFile(packageFile, '{"name":"package-should-not-survive"}');
    assert.equal(await hasOnlyEmptyDirectories(root), false);
    await rm(packageFile);
    assert.equal(await hasOnlyEmptyDirectories(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retries transient Windows EBUSY cleanup failures until the tree can be removed", async () => {
  let attempts = 0;
  const delays = [];

  await removeTemporaryTree("C:\\Temp\\tvdoctor-package-smoke-test", {
    platform: "win32",
    remove: async () => {
      attempts += 1;
      if (attempts < 4) {
        const error = new Error("resource busy or locked");
        error.code = "EBUSY";
        throw error;
      }
    },
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [250, 250, 250]);
});

test("does not retry non-transient cleanup errors", async () => {
  let attempts = 0;

  await assert.rejects(
    removeTemporaryTree("C:\\Temp\\tvdoctor-package-smoke-test", {
      platform: "win32",
      remove: async () => {
        attempts += 1;
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      },
      delay: async () => undefined,
    }),
    /permission denied/u,
  );

  assert.equal(attempts, 1);
});

test("native Windows cleanup fallback parses and safely exits for a nonexistent owned temp leaf", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only native fallback");
    return;
  }
  const missing = join(tmpdir(), `tvdoctor-package-smoke-parser-test-${randomUUID()}`);
  await assert.rejects(stat(missing), { code: "ENOENT" });
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsNativeCleanupScript()], {
    encoding: "utf8",
    env: { ...process.env, TVDOCTOR_SMOKE_OWNED_TEMP: missing },
    timeout: 8_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  await assert.rejects(stat(missing), { code: "ENOENT" });
});
