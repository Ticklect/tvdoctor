import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type { ArtifactStore, ReportBundleOptions } from "@tvdoctor/reporters";

interface VideoEvidenceSidecar {
  readonly absolutePath: string;
  readonly relativePath: "video/audit-session.webm";
}

/**
 * Playwright occasionally leaves its finalized `page@*.webm` file after
 * saveAs fails on Windows. Accept exactly one real Chromium output in the
 * dedicated new report directory, copying it via the artifact store, instead
 * of telling the user the recording is unavailable while bytes exist.
 */
export async function recordedVideoSidecar(
  store: ArtifactStore,
  driver: PlaywrightWebDriver,
  requested: boolean,
): Promise<VideoEvidenceSidecar | null> {
  if (!requested || typeof driver.getRecordedVideoPath !== "function") return null;
  const expected = resolve(store.outputRoot, "video", "audit-session.webm");
  let candidate: string | null;
  try { candidate = driver.getRecordedVideoPath(); } catch { return null; }
  if (candidate === null) {
    let candidates: string[];
    try {
      candidates = (await readdir(resolve(store.outputRoot, "video")))
        .filter((name) => /^page@[a-f0-9]{32}\.webm$/u.test(name));
    } catch { return null; }
    if (candidates.length !== 1) return null;
    const source = resolve(store.outputRoot, "video", candidates[0] ?? "");
    try {
      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1
        || metadata.size > 256 * 1024 * 1024) return null;
      const [root, actual] = await Promise.all([realpath(store.outputRoot), realpath(source)]);
      const difference = relative(root, actual);
      if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) return null;
      await store.writeBundleFileStream("video/audit-session.webm", createReadStream(actual));
      candidate = expected;
    } catch { return null; }
  }
  if (resolve(candidate) !== expected) return null;
  try {
    const metadata = await lstat(expected);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const [realRoot, realFile] = await Promise.all([realpath(store.outputRoot), realpath(expected)]);
    const difference = relative(realRoot, realFile);
    if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) return null;
  } catch { return null; }
  return { absolutePath: expected, relativePath: "video/audit-session.webm" };
}

export function videoBundleOptions(video: VideoEvidenceSidecar | null): Pick<ReportBundleOptions, "htmlSidecars"> {
  if (video === null) return {};
  return { htmlSidecars: [{
    href: video.relativePath, label: "Audit session video", mediaType: "video/webm",
    warning: "Optional recording; may contain sensitive target content. Review before sharing.",
  }] };
}

export function videoDetails(requested: boolean, video: VideoEvidenceSidecar | null): readonly string[] {
  if (!requested) return [];
  return video === null
    ? ["Video evidence unavailable; audit classification does not depend on video recording."]
    : [`Video evidence: ${video.absolutePath} (optional; may contain sensitive target content).`];
}
