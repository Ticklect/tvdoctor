export interface AndroidDisplayReadyOptions {
  readonly executeAdb: (arguments_: readonly string[]) => Promise<string>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly pollIntervalMs?: number;
}

export interface AndroidDisplayReadyResult {
  readonly attempts: number;
  readonly powerState: string;
  readonly displayState: string;
  readonly inputState: string;
}

export function androidDisplayReady(
  powerState: string,
  displayState: string,
  inputState: string,
): boolean;
export function ensureAndroidDisplayReady(
  options: AndroidDisplayReadyOptions,
): Promise<AndroidDisplayReadyResult>;
