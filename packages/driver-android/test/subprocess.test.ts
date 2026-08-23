import { describe, expect, it } from "vitest";
import { NodeAdbCommandExecutor } from "../src/index.js";

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
});
