import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  NodeAdbCommandExecutor,
  type AdbChildProcess,
  type AdbProcessSpawner,
} from "../src/index.js";

class ControlledChild extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}

describe("bounded shell-free subprocess execution", () => {
  it("passes argument arrays without shell interpolation", async () => {
    const executor = new NodeAdbCommandExecutor(process.execPath);
    const marker = "$(this-must-not-execute); & also-not-a-command";
    const result = await executor.execute([
      "-e",
      "process.stdout.write(process.argv[1] ?? '')",
      marker,
    ]);

    expect(Buffer.from(result.stdout).toString("utf8")).toBe(marker);
    expect(result.exitCode).toBe(0);
  });

  it("rejects NUL arguments, excessive output, non-zero exit, and hung processes", async () => {
    const executor = new NodeAdbCommandExecutor(process.execPath);
    await expect(executor.execute(["bad\0argument"])).rejects.toThrow("NUL");
    await expect(executor.execute(
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      { maxOutputBytes: 128 },
    )).rejects.toThrow("exceeded 128 bytes");
    await expect(executor.execute(["-e", "process.stderr.write('safe failure'); process.exit(7)"]))
      .rejects.toThrow("safe failure");
    const startedAt = performance.now();
    await expect(executor.execute(
      ["-e", "setInterval(() => undefined, 1000)"],
      { timeoutMs: 30 },
    )).rejects.toThrow("timed out");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("escalates graceful termination and settles even when a child never closes", async () => {
    const child = new ControlledChild();
    let spawnOptions: Parameters<AdbProcessSpawner>[2] | undefined;
    const processSpawner: AdbProcessSpawner = (_executable, _arguments, options) => {
      spawnOptions = options;
      return child as unknown as AdbChildProcess;
    };
    const executor = new NodeAdbCommandExecutor("controlled-adb", {
      hardKillWaitMs: 20,
      processSpawner,
      terminationGraceMs: 20,
      timeoutMs: 20,
    });

    const startedAt = performance.now();
    await expect(executor.execute(["devices"])).rejects.toThrow("timed out after 20 ms");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(child.signals).toEqual([undefined, "SIGKILL"]);
    expect(spawnOptions).toEqual({
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  });

  it("uses the same bounded escalation for abort signals", async () => {
    const child = new ControlledChild();
    const processSpawner: AdbProcessSpawner = () => child as unknown as AdbChildProcess;
    const executor = new NodeAdbCommandExecutor("controlled-adb", {
      hardKillWaitMs: 20,
      processSpawner,
      terminationGraceMs: 20,
    });
    const controller = new AbortController();
    const execution = executor.execute(["shell", "getprop"], { signal: controller.signal });
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(child.signals).toEqual([undefined, "SIGKILL"]);
  });
});
