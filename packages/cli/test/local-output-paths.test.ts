import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalOutputRoot, canonicalRegisteredFile } from "../src/local-output-paths.js";

describe("owned local filesystem paths", () => {
  it.runIf(process.platform === "win32")("normalizes trusted path spellings before creating scan directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tvdoctor-root-case-"));
    try {
      const canonical = await realpath(directory);
      const alias = directory.toUpperCase();
      expect(alias).not.toBe(canonical);
      expect(canonicalOutputRoot(join(alias, "session"))).toBe(join(canonical, "session"));

      const file = join(directory, "journey.json");
      await writeFile(file, "{}");
      await expect(canonicalRegisteredFile(join(alias, "journey.json"))).resolves.toBe(await realpath(file));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a linked output root and a linked journey ancestor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tvdoctor-root-link-"));
    const original = join(directory, "original");
    const redirect = join(directory, "redirect");
    try {
      await mkdir(original);
      await writeFile(join(original, "journey.json"), "{}");
      await symlink(original, redirect, process.platform === "win32" ? "junction" : "dir");
      expect(() => canonicalOutputRoot(redirect)).toThrow("ordinary directory");
      await expect(canonicalRegisteredFile(join(redirect, "journey.json"))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
