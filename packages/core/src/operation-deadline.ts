const MAX_TIMER_MS = 2_147_483_647;

export interface OperationDeadlineOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export class OperationDeadlineExceeded extends Error {
  constructor() {
    super("The operation deadline was exceeded.");
    this.name = "OperationDeadlineExceeded";
  }
}

function validTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new TypeError("timeoutMs must be a positive safe integer within the platform timer limit.");
  }
}

export async function runWithOperationDeadline<T>(
  options: OperationDeadlineOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  validTimeout(options.timeoutMs);
  if (typeof operation !== "function") throw new TypeError("operation must be a function.");

  const deadlineController = new AbortController();
  const signal = options.signal === undefined
    ? deadlineController.signal
    : AbortSignal.any([options.signal, deadlineController.signal]);
  signal.throwIfAborted();

  const deadlineError = new OperationDeadlineExceeded();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  timer = setTimeout(() => deadlineController.abort(deadlineError), options.timeoutMs);

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(signal)),
      aborted,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
  }
}
