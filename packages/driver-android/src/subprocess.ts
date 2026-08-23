import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { constants } from "node:fs";
import type {
  AdbCommandExecutor,
  AdbCommandOptions,
  AdbCommandResult,
} from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return candidate;
}

function safeArgument(value: string): string {
  if (value.includes("\0")) throw new TypeError("ADB arguments cannot contain NUL bytes.");
  return value;
}

function printable(value: Uint8Array, maximumLength = 2_000): string {
  let safe = "";
  for (const character of Buffer.from(value).toString("utf8")) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe += codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13
      || (codePoint >= 127 && codePoint <= 159)
      ? " "
      : character;
  }
  return safe
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}

function commandLabel(arguments_: readonly string[]): string {
  return arguments_.slice(0, 6).map((argument) => {
    if (/token|password|secret|authorization|cookie/iu.test(argument)) return "[REDACTED]";
    return argument.length > 120 ? `${argument.slice(0, 117)}...` : argument;
  }).join(" ");
}

export class NodeAdbCommandExecutor implements AdbCommandExecutor {
  readonly #adbPath: string;
  readonly #defaultMaxOutputBytes: number;
  readonly #defaultTimeoutMs: number;

  constructor(
    adbPath: string,
    defaults: { readonly maxOutputBytes?: number; readonly timeoutMs?: number } = {},
  ) {
    if (adbPath.trim().length === 0 || adbPath.includes("\0")) {
      throw new TypeError("adbPath must be a non-empty executable path.");
    }
    this.#adbPath = adbPath;
    this.#defaultMaxOutputBytes = positiveInteger(
      defaults.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.#defaultTimeoutMs = positiveInteger(
      defaults.timeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      "timeoutMs",
    );
  }

  async execute(
    arguments_: readonly string[],
    options: AdbCommandOptions = {},
  ): Promise<AdbCommandResult> {
    const timeoutMs = positiveInteger(options.timeoutMs, this.#defaultTimeoutMs, "timeoutMs");
    if (timeoutMs > MAX_TIMER_MS) throw new TypeError("timeoutMs exceeds the platform timer limit.");
    const maxOutputBytes = positiveInteger(
      options.maxOutputBytes,
      this.#defaultMaxOutputBytes,
      "maxOutputBytes",
    );
    const safeArguments = arguments_.map(safeArgument);

    return await new Promise<AdbCommandResult>((resolve, reject) => {
      const child = spawn(this.#adbPath, safeArguments, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: Error | null = null;
      let completed = false;

      const stop = (error: Error): void => {
        failure ??= error;
        child.kill();
      };
      const collect = (target: Buffer[], chunk: Buffer, stream: "stderr" | "stdout"): void => {
        if (completed) return;
        if (stream === "stdout") stdoutBytes += chunk.byteLength;
        else stderrBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          stop(new Error(`ADB output exceeded ${String(maxOutputBytes)} bytes.`));
          return;
        }
        target.push(Buffer.from(chunk));
      };

      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
      child.once("error", (error) => {
        failure ??= error;
      });

      const timer = setTimeout(() => {
        stop(new Error(`ADB command timed out after ${String(timeoutMs)} ms.`));
      }, timeoutMs);

      child.once("close", (code) => {
        completed = true;
        clearTimeout(timer);
        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);
        if (failure !== null) {
          reject(failure);
          return;
        }
        const exitCode = code ?? -1;
        if (exitCode !== 0) {
          const details = printable(stderrBuffer).length > 0
            ? printable(stderrBuffer)
            : printable(stdoutBuffer);
          reject(new Error(
            `ADB command failed (${String(exitCode)}): ${commandLabel(safeArguments)}${details.length === 0 ? "" : ` — ${details}`}`,
          ));
          return;
        }
        resolve({
          stdout: new Uint8Array(stdoutBuffer),
          stderr: printable(stderrBuffer),
          exitCode,
        });
      });
    });
  }
}

/** Resolve an SDK-local adb executable without requiring shell PATH mutation. */
export async function resolveAdbExecutable(
  explicitPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (explicitPath !== undefined) return explicitPath;
  const sdkRoot = environment["ANDROID_SDK_ROOT"] ?? environment["ANDROID_HOME"];
  if (sdkRoot !== undefined && sdkRoot.trim().length > 0) {
    const candidate = join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to PATH. The actual spawn failure stays explicit to the caller.
    }
  }
  const pathEntries = (environment["PATH"] ?? "").split(delimiter);
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  for (const entry of pathEntries) {
    if (entry.trim().length === 0) continue;
    const candidate = join(entry, executable);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return "adb";
}
