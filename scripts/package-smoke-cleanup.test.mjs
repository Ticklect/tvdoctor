import assert from "node:assert/strict";
import test from "node:test";

import { removeTemporaryTree } from "./package-smoke-cleanup.mjs";

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
