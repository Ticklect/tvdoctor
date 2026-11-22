import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { compareResponsivePageEvidence, RESPONSIVE_VIEWPORTS,
  type ResponsivePageEvidenceComparison, type ResponsiveScanResult } from "./responsive-scan.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface ResponsiveComparisonRow {
  readonly viewport: "mobile" | "tablet" | "desktop";
  readonly width: number;
  readonly height: number;
  readonly beforeFindings: number;
  readonly afterFindings: number;
  readonly beforeScreenshot: string | null;
  readonly afterScreenshot: string | null;
  readonly beforeRules: readonly string[];
  readonly afterRules: readonly string[];
  readonly evidenceComparison: ResponsivePageEvidenceComparison | null;
}

export interface ResponsiveComparison {
  readonly schemaVersion: "tvdoctor.responsive-comparison/v1";
  readonly status: "observed" | "partial";
  readonly sameOrigin: true;
  readonly beforeStatus: ResponsiveScanResult["status"];
  readonly afterStatus: ResponsiveScanResult["status"];
  readonly beforeDeferred: number;
  readonly afterDeferred: number;
  readonly rows: readonly ResponsiveComparisonRow[];
  readonly classification: "human-review-required";
}

function inside(parent: string, candidate: string): boolean {
  const rest = relative(parent, candidate);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !rest.startsWith("/")
    && !rest.startsWith("\\") && !/^[a-z]:/iu.test(rest));
}

async function loadBundle(folder: string): Promise<{ readonly root: string; readonly result: ResponsiveScanResult }> {
  const root = await realpath(resolve(folder));
  const source = resolve(root, "responsive-result.json");
  const path = await realpath(source);
  if (path !== source || !inside(root, path) || (await stat(path)).size > MAX_JSON_BYTES) {
    throw new Error("Responsive report is missing, oversized or redirects outside its report directory.");
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid responsive report.");
  const value = raw as Record<string, unknown>;
  if (!["completed", "partial", "cancelled"].includes(String(value["status"]))
    || !Array.isArray(value["pages"]) || value["pages"].length > 36
    || !Array.isArray(value["findings"]) || value["findings"].length > 360
    || !Array.isArray(value["viewports"]) || value["viewports"].length !== 3
    || !value["viewports"].every((item, index) => {
      const expected = RESPONSIVE_VIEWPORTS[index];
      return expected !== undefined && item !== null && typeof item === "object"
        && (item as Record<string, unknown>)["id"] === expected.id
        && (item as Record<string, unknown>)["width"] === expected.width
        && (item as Record<string, unknown>)["height"] === expected.height;
    }) || typeof value["targetIdentity"] !== "string"
    || !Number.isSafeInteger(value["pagesDeferred"])) throw new Error("Invalid or unsupported responsive report.");
  if (!value["pages"].every((item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const page = item as Record<string, unknown>;
    return RESPONSIVE_VIEWPORTS.some((viewport) => viewport.id === page["viewport"])
      && ["completed", "partial", "failed"].includes(String(page["status"]))
      && (page["screenshot"] === null || (typeof page["screenshot"] === "string"
        && /^responsive\/(?:mobile|tablet|desktop)\/page-[0-9]{2}\.png$/u.test(page["screenshot"])))
      && Array.isArray(page["findings"]) && page["findings"].length <= 30
      && page["findings"].every((candidate: unknown) => candidate !== null && typeof candidate === "object"
        && !Array.isArray(candidate) && typeof (candidate as Record<string, unknown>)["rule"] === "string"
        && ["responsive.document-overflow", "responsive.offscreen-control", "responsive.clipped-control",
          "responsive.control-overlap", "responsive.obscured-control"]
          .includes((candidate as Record<string, unknown>)["rule"] as string)
        && (candidate as Record<string, unknown>)["confidence"] === "heuristic"
        && (candidate as Record<string, unknown>)["reviewRequired"] === true);
  })) throw new Error("Malformed page observations or unsafe screenshot paths in responsive report.");
  const result = value as unknown as ResponsiveScanResult;
  try {
    const target = new URL(result.targetIdentity);
    if (!/^https?:$/u.test(target.protocol) || target.username || target.password) throw new Error();
  } catch { throw new Error("Cannot validate responsive report target identity."); }
  return { root, result };
}

async function copyEvidence(
  root: string, source: string | null, viewport: string, destination: string, side: "before" | "after",
): Promise<string | null> {
  if (source === null || !new RegExp(`^responsive/${viewport}/page-[0-9]{2}\\.png$`, "u").test(source)) return null;
  const input = resolve(root, ...source.split("/"));
  if (!inside(root, input)) return null;
  try {
    const resolved = await realpath(input);
    const metadata = await lstat(input);
    if (resolved !== input || !metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < PNG_HEADER.length || metadata.size > MAX_SCREENSHOT_BYTES) return null;
    const bytes = await readFile(input);
    if (!bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) return null;
    const relativeOutput = `${side}/${viewport}.png`;
    // Write the exact bytes checked above; reopening the input via copyFile
    // would allow a symlink swap between validation and copying.
    await writeFile(join(destination, `${viewport}.png`), bytes, { flag: "wx" });
    return relativeOutput;
  } catch { return null; }
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

export function renderResponsiveComparison(report: ResponsiveComparison): string {
  const cards = report.rows.map((row) => {
    const frame = (side: "before" | "after", image: string | null, rules: readonly string[]): string =>
      `<div class="sample"><h3>${side === "before" ? "Before" : "After"}</h3>
      ${image === null ? "<p>Screenshot unavailable; observation is incomplete.</p>"
        : `<a href="${image}"><img loading="lazy" src="${image}" alt="${side} at ${row.viewport} viewport"></a>`}
      <p>${rules.length === 0 ? "No geometry review leads observed" : escapeHtml(rules.join(", "))}</p></div>`;
    const comparisons = row.evidenceComparison;
    const comparison = comparisons === null ? "No paired observations available"
      : comparisons.comparable ? `${String(comparisons.noLongerObserved.length)} no longer observed, ${String(comparisons.newlyObserved.length)} newly observed, ${String(comparisons.stillObserved.length)} still observed (same stable route) — review required`
        : `Different or incomplete route observations (${escapeHtml(comparisons.reason ?? "unknown")}); issue identities cannot be compared`;
    return `<section><h2>${escapeHtml(row.viewport)} (${String(row.width)} × ${String(row.height)})</h2>
      <p>Review leads: ${String(row.beforeFindings)} before / ${String(row.afterFindings)} after — changes are not proof of a fix. ${comparison}.</p>
      <div class="pair">${frame("before", row.beforeScreenshot, row.beforeRules)}${frame("after", row.afterScreenshot, row.afterRules)}</div></section>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
    <meta name="referrer" content="no-referrer"><title>TVDoctor responsive comparison</title>
    <style>:root{font:15px system-ui,sans-serif;background:#f5f7fb;color:#17263b}body{margin:0}
    header{background:#14243d;color:white;padding:35px max(24px,calc((100vw - 1120px)/2))}
    h1{font-size:clamp(27px,4vw,41px);margin:8px 0}p{line-height:1.6}main{max-width:1120px;margin:auto;padding:25px}
    section{margin:30px 0}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:15px}
    .sample{background:white;border:1px solid #dbe2ec;border-radius:11px;padding:16px;min-width:0}
    img{display:block;width:100%;height:auto;max-height:650px;object-fit:contain;border:1px solid #dee5ed}
    .note{border-left:3px solid #506fa3;background:#eaf0fa;padding:15px}
    a{color:#1d58a3}</style></head><body><header><small>TVDOCTOR / LOCAL EVIDENCE REVIEW</small>
    <h1>Responsive before / after</h1><p>Side-by-side screenshots and bounded layout observations from the first route in each independent scan, matched by viewport size (not proven semantic equivalence). No URLs, page text or secrets are embedded in this HTML.</p></header>
    <main><div class="note"><strong>${report.status === "observed" ? "Both bounded viewport matrices observed" : "Partial comparison — evidence missing"}</strong>
    <p>Before: ${report.beforeStatus}, ${String(report.beforeDeferred)} deferred routes. After: ${report.afterStatus}, ${String(report.afterDeferred)} deferred routes.
    Different page content, animation, CSS and viewport timing may explain any difference. All findings are heuristics and require human review.</p></div>
    ${cards}<p><a href="responsive-comparison.json">View sanitized comparison JSON</a></p>
    <p>These copied screenshots may contain private rendered application content. Do not share before inspecting.</p></main></body></html>\n`;
}

export async function compareResponsiveBundles(beforeDirectory: string, afterDirectory: string, outputDirectory: string): Promise<ResponsiveComparison> {
  const before = await loadBundle(beforeDirectory);
  const after = await loadBundle(afterDirectory);
  if (new URL(before.result.targetIdentity).origin !== new URL(after.result.targetIdentity).origin) {
    throw new Error("Before and after reports must belong to the same origin.");
  }
  const output = resolve(outputDirectory);
  if (inside(before.root, output) || inside(after.root, output)
    || inside(output, before.root) || inside(output, after.root)) {
    throw new Error("Comparison output must not overlap an input report directory.");
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // exclusive: never overwrite an existing bundle
  await mkdir(join(output, "before"));
  await mkdir(join(output, "after"));
  const rows: ResponsiveComparisonRow[] = [];
  for (const viewport of RESPONSIVE_VIEWPORTS) {
    const first = before.result.pages.find((page) => page.viewport === viewport.id);
    const second = after.result.pages.find((page) => page.viewport === viewport.id);
    const rules = (page: typeof first): readonly string[] => page === undefined ? [] : page.findings.map((finding) => finding.rule).slice(0, 30);
    rows.push({ viewport: viewport.id, width: viewport.width, height: viewport.height,
      beforeFindings: first?.findings.length ?? 0, afterFindings: second?.findings.length ?? 0,
      beforeScreenshot: await copyEvidence(before.root, first?.screenshot ?? null, viewport.id, join(output, "before"), "before"),
      afterScreenshot: await copyEvidence(after.root, second?.screenshot ?? null, viewport.id, join(output, "after"), "after"),
      beforeRules: rules(first), afterRules: rules(second),
      evidenceComparison: first === undefined || second === undefined ? null : compareResponsivePageEvidence(first, second),
    });
  }
  const status: ResponsiveComparison["status"] = before.result.status === "completed" && after.result.status === "completed"
    && rows.every((row) => row.beforeScreenshot !== null && row.afterScreenshot !== null)
    && before.result.pages.every((page) => page.layoutStable === true)
    && after.result.pages.every((page) => page.layoutStable === true) ? "observed" : "partial";
  const report: ResponsiveComparison = {
    schemaVersion: "tvdoctor.responsive-comparison/v1", status, sameOrigin: true,
    beforeStatus: before.result.status, afterStatus: after.result.status,
    beforeDeferred: before.result.pagesDeferred, afterDeferred: after.result.pagesDeferred,
    rows, classification: "human-review-required",
  };
  for (const [name, data] of [["responsive-comparison.json", `${JSON.stringify(report, null, 2)}\n`],
    ["report.html", renderResponsiveComparison(report)]] as const) {
    const path = join(output, name);
    await writeFile(`${path}.tmp`, data, "utf8");
    await rename(`${path}.tmp`, path);
  }
  return report;
}
