import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { safeTarget } from "./cli.js";

export type ZeroConfigTarget =
  | { readonly kind: "web"; readonly target: string }
  | { readonly kind: "android-apk"; readonly apkPath: string };

export type ZeroConfigClassification =
  | { readonly status: "target"; readonly target: ZeroConfigTarget }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "not-target" };

export interface ZeroConfigTargetDependencies {
  readonly stat?: (path: string) => Promise<{ readonly isFile: () => boolean }>;
  readonly resolvePath?: (path: string) => string;
}

export async function classifyZeroConfigTarget(
  input: string,
  dependencies: ZeroConfigTargetDependencies = {},
): Promise<ZeroConfigClassification> {
  const web = safeTarget(input);
  if (web !== null) {
    return { status: "target", target: { kind: "web", target: web } };
  }

  if (/^https?:/iu.test(input)) {
    return {
      status: "invalid",
      message: "Enter an absolute HTTP(S) URL without credentials.",
    };
  }

  if (!/\.apk$/iu.test(input)) return { status: "not-target" };

  const apkPath = (dependencies.resolvePath ?? resolve)(input);
  try {
    const metadata = await (dependencies.stat ?? stat)(apkPath);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    return {
      status: "invalid",
      message: "The APK path must point to a readable .apk file.",
    };
  }

  return { status: "target", target: { kind: "android-apk", apkPath } };
}
