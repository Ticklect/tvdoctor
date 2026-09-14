import { describe, expect, it } from "vitest";

import { classifyZeroConfigTarget } from "../src/zero-config-target.js";

describe("zero-config target classification", () => {
  it("classifies canonical HTTP and HTTPS targets", async () => {
    await expect(classifyZeroConfigTarget("https://example.test/tv")).resolves.toEqual({
      status: "target",
      target: { kind: "web", target: "https://example.test/tv" },
    });
    await expect(classifyZeroConfigTarget("http://example.test/tv")).resolves.toEqual({
      status: "target",
      target: { kind: "web", target: "http://example.test/tv" },
    });
  });

  it("rejects explicit HTTP targets with embedded credentials", async () => {
    await expect(classifyZeroConfigTarget("https://user:secret@example.test/tv")).resolves.toEqual({
      status: "invalid",
      message: "Enter an absolute HTTP(S) URL without credentials.",
    });
  });

  it("rejects malformed explicit HTTP targets", async () => {
    await expect(classifyZeroConfigTarget("https://")).resolves.toEqual({
      status: "invalid",
      message: "Enter an absolute HTTP(S) URL without credentials.",
    });
  });

  it("classifies a readable apk without launching Android tooling", async () => {
    const result = await classifyZeroConfigTarget("D:/apps/example.apk", {
      resolvePath: (value) => value,
      stat: async () => ({ isFile: () => true }),
    });
    expect(result).toEqual({
      status: "target",
      target: { kind: "android-apk", apkPath: "D:/apps/example.apk" },
    });
  });

  it("accepts a Windows apk path containing spaces after shell parsing", async () => {
    const path = "D:\\apps\\Example TV.apk";
    await expect(classifyZeroConfigTarget(path, {
      resolvePath: (value) => value,
      stat: async () => ({ isFile: () => true }),
    })).resolves.toEqual({
      status: "target",
      target: { kind: "android-apk", apkPath: path },
    });
  });

  it("rejects missing apk paths", async () => {
    await expect(classifyZeroConfigTarget("D:/apps/missing.apk", {
      resolvePath: (value) => value,
      stat: async () => { throw new Error("ENOENT"); },
    })).resolves.toEqual({
      status: "invalid",
      message: "The APK path must point to a readable .apk file.",
    });
  });

  it("rejects directories that merely end in .apk", async () => {
    await expect(classifyZeroConfigTarget("D:/apps/folder.apk", {
      resolvePath: (value) => value,
      stat: async () => ({ isFile: () => false }),
    })).resolves.toEqual({
      status: "invalid",
      message: "The APK path must point to a readable .apk file.",
    });
  });

  it("keeps arbitrary command-like text out of target autodetection", async () => {
    await expect(classifyZeroConfigTarget("something-unknown")).resolves.toEqual({
      status: "not-target",
    });
  });
});
