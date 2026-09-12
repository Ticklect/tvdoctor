import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OperationDeadlineExceeded,
  runWithOperationDeadline,
} from "../src/index.js";

describe("operation deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a successful operation and clears its deadline timer", async () => {
    vi.useFakeTimers();

    await expect(runWithOperationDeadline(
      { timeoutMs: 1_000 },
      async (signal) => {
        expect(signal.aborted).toBe(false);
        return "complete";
      },
    )).resolves.toBe("complete");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the active operation before reporting a deadline", async () => {
    let operationSignal: AbortSignal | undefined;
    let abortedBeforeRejection = false;

    const result = runWithOperationDeadline(
      { timeoutMs: 20 },
      async (signal) => {
        operationSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            abortedBeforeRejection = signal.aborted;
            reject(signal.reason);
          }, { once: true });
        });
      },
    );

    await expect(result).rejects.toBeInstanceOf(OperationDeadlineExceeded);
    expect(operationSignal?.aborted).toBe(true);
    expect(abortedBeforeRejection).toBe(true);
  });

  it("forwards caller cancellation without reclassifying it as a deadline", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const result = runWithOperationDeadline(
      { timeoutMs: 1_000, signal: controller.signal },
      async () => await new Promise<void>(() => undefined),
    );

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });

  it.each([0, -1, Number.NaN, 2_147_483_648])(
    "rejects invalid timeout %s before starting work",
    async (timeoutMs) => {
      let started = false;
      await expect(runWithOperationDeadline({ timeoutMs }, async () => {
        started = true;
      })).rejects.toThrow(/timeoutMs/u);
      expect(started).toBe(false);
    },
  );
});
