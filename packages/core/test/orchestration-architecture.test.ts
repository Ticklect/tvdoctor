import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const groups = [
  { package: "pack-streaming", facade: "runner", prefix: "streaming-", modules: ["runtime", "options", "search", "issues", "pointer-probe", "replay", "journey"] },
  { package: "core", facade: "explorer", prefix: "explorer-", modules: ["contracts", "options", "state", "frontier", "runtime"] },
  { package: "core", facade: "replay", prefix: "replay-", modules: ["contracts", "compilation", "evaluation", "deadline", "execution"] },
  { package: "core", facade: "navigation-diagnostics", prefix: "navigation-", modules: ["diagnostic-contracts", "diagnostic-context", "diagnostic-findings", "focus-rules", "modal-rules", "history-rules"] },
  { package: "cli", facade: "node-audit", prefix: "node-audit-", modules: ["contracts", "selection", "navigation", "evidence", "output", "runner"] },
] as const;

function physicalLines(source: string): number {
  return source.split("\n").length - Number(source.endsWith("\n"));
}

const read = async (path: string): Promise<string> => await readFile(new URL(path, root), "utf8");

describe("orchestration architecture", () => {
  for (const group of groups) {
    const directory = "packages/" + group.package + "/src/";
    it("keeps " + group.facade + " a small compatibility facade", async () => {
      expect(physicalLines(await read(directory + group.facade + ".ts"))).toBeLessThanOrEqual(350);
    });
    it("extracts bounded private " + group.facade + " responsibilities", async () => {
      const files = await readdir(new URL(directory, root));
      for (const suffix of group.modules) {
        expect(files).toContain(group.prefix + suffix + ".ts");
      }
      for (const file of files.filter((name) => name.startsWith(group.prefix) && name.endsWith(".ts") && name !== group.facade + ".ts")) {
        const source = await read(directory + file);
        expect(physicalLines(source), file).toBeLessThanOrEqual(650);
        const ownBarrel = new RegExp('(?:from\\s*|import\\s*\\()\\s*["\'](?:\\./index(?:\\.js|\\.ts)?|@tvdoctor/' + group.package + ')["\']');
        expect(source, file).not.toMatch(ownBarrel);
      }
    });
  }

  it("preserves the existing public facade entrypoints", async () => {
    const core = await read("packages/core/src/index.ts");
    for (const facade of ["explorer", "replay", "navigation-diagnostics"]) {
      expect(core).toContain('export * from "./' + facade + '.js";');
    }
    expect(await read("packages/pack-streaming/src/index.ts")).toContain('from "./runner.js"');
    // node-audit utilities are a direct-source compatibility surface.
    expect(await read("packages/cli/src/index.ts")).not.toMatch(/from ["']\.\/node-audit-/);
  });
});
