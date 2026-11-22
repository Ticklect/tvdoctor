import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pin the existing public entrypoint's exact stdout/stderr/exit behavior. The
// binary is built before this test; all commands below are browser-free.
const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");

const cases: readonly {
  readonly name: string;
  readonly args: readonly string[];
  readonly code: number;
  readonly fingerprint: string;
}[] = [
  // Pin intentional public QA, independent batch fix verification, handoff and project commands;
  // all other fresh-process behaviors remain unchanged.
  { name: "global help", args: ["--help"], code: 0, fingerprint: "de73668a4048d41ebf367b6e705549412a58884628a0fb71f69d4f0ae2fe09a7" },
  { name: "version", args: ["--version"], code: 0, fingerprint: "d07b99e171f729a6309de676d23b16323abec3ce15eb29d554957028e8ed7c28" },
  { name: "subcommand help", args: ["help", "test"], code: 0, fingerprint: "ad237e4ec56e8a3237722613da86066292f447bc71d0524b7a6f7ae4bd48ac0d" },
  { name: "local UI help", args: ["ui", "--help"], code: 0, fingerprint: "05baa42276cee355d5e6261cd9e3fb87916ba206f80623837c7e5d289ff8e9f5" },
  { name: "local UI short help", args: ["ui", "-h"], code: 0, fingerprint: "05baa42276cee355d5e6261cd9e3fb87916ba206f80623837c7e5d289ff8e9f5" },
  { name: "privacy", args: ["privacy"], code: 0, fingerprint: "a09a7e387b9d3437435c114e42cc9c0ab95b29435cc606095aa666c9f36e030c" },
  { name: "unknown command", args: ["not-a-real-tvdoctor-command"], code: 2, fingerprint: "1d8cc191fa3e0cb87c221d35cb7f8a362c32edd37bbc5d43456bf8cd9a335c5b" },
];

describe("cold CLI entrypoint output parity", () => {
  for (const { name, args, code, fingerprint } of cases) {
    it(`preserves ${name} in a fresh Node process`, () => {
      const child = spawnSync(process.execPath, [entrypoint, ...args], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(code);
      if (name === "global help") {
        expect(child.stdout).toContain("TVDoctor — UI debugging for coding agents");
        expect(child.stdout).toContain("tvdoctor-mcp");
        expect(child.stdout).toContain("node packages/cli/dist/mcp-bin.js");
        expect(child.stdout).toContain("check URL");
        expect(child.stdout).toContain("findings --report");
        expect(child.stdout).toContain("verify-fix");
        expect(child.stdout).toContain("project-verify");
        expect(child.stdout).toContain("project-accept --config");
        expect(child.stdout).toContain("handoff");
        expect(child.stdout).toContain("qa URL");
        expect(child.stdout).toContain("qa-verify --original");
        expect(child.stdout).toContain("qa-accept --original");
        expect(child.stdout).toContain("replay");
        expect(child.stdout).toContain("baseline");
      }
      expect(createHash("sha256")
        .update(JSON.stringify({ code: child.status, stdout: child.stdout, stderr: child.stderr }))
        .digest("hex")).toBe(fingerprint);
    });
  }

  it("keeps UI invalid-port argument errors and exit code", () => {
    const child = spawnSync(process.execPath, [entrypoint, "ui", "--port", "bogus"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("Usage: tvdoctor ui [--port PORT] (0–65535)\n");
  });
});
