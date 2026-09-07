import { MAX_REPLAY_DURATION_MS } from "./replay-contracts.js";

export interface ReplayDeadline {
  readonly expiresAtMs: number;
  readonly now: () => number;
}

export class ReplayDeadlineExceeded extends Error {
  public constructor() {
    super("The replay duration budget was exhausted.");
    this.name = "ReplayDeadlineExceeded";
  }
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withinDeadline<T>(
  deadline: ReplayDeadline,
  operation: () => T | Promise<T>,
): Promise<T> {
  const remainingMs = deadline.expiresAtMs - deadline.now();
  if (!(remainingMs > 0)) throw new ReplayDeadlineExceeded();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ReplayDeadlineExceeded()), Math.min(remainingMs, MAX_REPLAY_DURATION_MS));
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function elapsed(now: () => number, startedAtMs: number): number {
  try {
    const duration = now() - startedAtMs;
    return Number.isFinite(duration) ? Math.max(0, duration) : 0;
  } catch {
    return 0;
  }
}
