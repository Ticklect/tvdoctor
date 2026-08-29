import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ANDROID_OBSERVER_PROTOCOL_VERSION } from "./observer-protocol.js";

export interface AndroidObserverAsset {
  readonly apkPath: string;
  readonly packageName: string;
  readonly versionName: string;
  readonly protocolVersion: number;
  readonly sha256: string;
  readonly certificateSha256: string;
}

export async function resolveAndroidObserverAsset(): Promise<AndroidObserverAsset> {
  const apkPath = fileURLToPath(new URL("../observer/tvdoctor-observer.apk", import.meta.url));
  const manifestPath = fileURLToPath(new URL("../observer/observer-manifest.json", import.meta.url));
  const [apk, metadata, manifestText] = await Promise.all([
    readFile(apkPath),
    stat(apkPath),
    readFile(manifestPath, "utf8"),
  ]);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error("Packaged Android observer APK is missing or empty.");
  const parsed = JSON.parse(manifestText.replace(/^\uFEFF/u, "")) as Record<string, unknown>;
  if (parsed["packageName"] !== "org.tvdoctor.observer"
    || typeof parsed["versionName"] !== "string"
    || parsed["protocolVersion"] !== ANDROID_OBSERVER_PROTOCOL_VERSION
    || typeof parsed["sha256"] !== "string"
    || typeof parsed["certificateSha256"] !== "string"
    || !/^[0-9a-f]{64}$/u.test(parsed["certificateSha256"])) {
    throw new Error("Packaged Android observer manifest is invalid or incompatible.");
  }
  const sha256 = createHash("sha256").update(apk).digest("hex");
  if (sha256 !== parsed["sha256"]) throw new Error("Packaged Android observer APK checksum validation failed.");
  return {
    apkPath,
    packageName: parsed["packageName"],
    versionName: parsed["versionName"],
    protocolVersion: parsed["protocolVersion"],
    sha256,
    certificateSha256: parsed["certificateSha256"],
  } as AndroidObserverAsset;
}
