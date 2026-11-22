import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CliContext, TestRunMode } from "./cli.js";
import { defaultOutputDirectory } from "./product-output.js";
import { compareResponsiveBundles } from "./responsive-compare.js";
import {
  RESPONSIVE_VIEWPORTS,
  runResponsiveScan,
  type ResponsiveScanRequest,
  type ResponsiveScanResult,
} from "./responsive-scan.js";
import { isSafeTerminalArgument, sanitizeTerminalText } from "./terminal.js";

export const RESPONSIVE_HELP_TEXT = `Usage:
  tvdoctor responsive URL [--mode quick|standard|deep] [--max-pages N] [--capture-comparison-evidence] [--output PATH]
  tvdoctor responsive compare BEFORE_REPORT_DIR AFTER_REPORT_DIR --output NEW_OUTPUT_DIR

Audit up to 12 same-origin routes at mobile (390px), tablet (768px), and desktop
(1280px) browser widths. Quick, standard, and deep select increasing bounded
DOM and time limits. Defaults: standard mode, 3 pages. Generates a local
responsive-result.json and report.html; review findings and PNG screenshot
evidence under responsive/ before treating a layout defect as verified.
Partial and cancelled scans never claim complete coverage.

--capture-comparison-evidence includes screenshots of the first route at all
three viewports even when no layout warning is found; use on both baseline and
repaired scans before comparing. This can retain private rendered page content.

The compare subcommand creates a self-contained local before/after screenshot
review from two saved responsive scan bundles on the same origin. It never
labels a changed layout heuristic as a verified fix. The output must be new.`;

export interface ResponsiveCommandOptions {
  readonly target: string;
  readonly mode: TestRunMode;
  readonly maxPages: number;
  readonly outputPath: string;
  readonly captureComparisonEvidence?: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function parseNonemptyPath(value: string): boolean {
  return value.trim() === value && value.length > 0 && value.length <= 1024 && !value.includes("\0");
}

export function parseResponsiveArguments(args: readonly string[]): ResponsiveCommandOptions | string {
  let target: string | undefined;
  let mode: TestRunMode = "standard";
  let maxPages = 3;
  let outputPath: string | undefined;
  let captureComparisonEvidence = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--capture-comparison-evidence") {
      if (captureComparisonEvidence) return "--capture-comparison-evidence may be specified only once";
      captureComparisonEvidence = true;
      continue;
    }
    if (argument.startsWith("--")) {
      if (!["--mode", "--max-pages", "--output"].includes(argument)) return `unknown responsive option: ${argument}`;
      if (seen.has(argument)) return `${argument} may be specified only once`;
      seen.add(argument);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return `${argument} requires a value`;
      if (argument === "--mode") {
        if (value !== "quick" && value !== "standard" && value !== "deep") return "--mode must be quick, standard, or deep";
        mode = value;
      }
      if (argument === "--max-pages") {
        if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value))
          || Number(value) < 1 || Number(value) > 12) return "--max-pages must be an integer between 1 and 12";
        maxPages = Number(value);
      }
      if (argument === "--output") {
        if (!parseNonemptyPath(value)) return "--output requires a bounded non-empty path";
        outputPath = value;
      }
      index += 1;
      continue;
    }
    if (target !== undefined) return "responsive accepts exactly one URL";
    target = argument;
  }
  if (target === undefined || !isSafeTerminalArgument(target, 2048)) {
    return "responsive requires a bounded absolute HTTP(S) URL";
  }
  let url: URL;
  try { url = new URL(target); } catch { return "responsive requires an absolute HTTP(S) URL"; }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== "") return "responsive requires HTTP(S) without credentials";
  return {
    target: url.href,
    mode,
    maxPages,
    outputPath: outputPath ?? defaultOutputDirectory({ target: url.href, mode: `responsive-${mode}` }),
    ...(captureComparisonEvidence ? { captureComparisonEvidence: true } : {}),
  };
}

function budget(mode: TestRunMode): Pick<ResponsiveScanRequest, "maxDurationMs" | "maxElementsPerPage" | "maxFindingsPerPage"> {
  if (mode === "quick") return { maxDurationMs: 30_000, maxElementsPerPage: 1_000, maxFindingsPerPage: 12 };
  if (mode === "deep") return { maxDurationMs: 120_000, maxElementsPerPage: 5_000, maxFindingsPerPage: 30 };
  return { maxDurationMs: 45_000, maxElementsPerPage: 2_000, maxFindingsPerPage: 12 };
}

function screenshotLink(path: string | null): string {
  if (path === null || !/^responsive\/(?:mobile|tablet|desktop)\/page-[0-9]{2}\.png$/u.test(path)) return "—";
  return `<a href="${path}" target="_blank" rel="noopener noreferrer">View image</a>`;
}

/** Self-contained overview with no raw URL, DOM text, tokens, query or private source markup. */
export function renderResponsiveReport(result: ResponsiveScanResult, mode: TestRunMode): string {
  const routeNumbers = new Map<string, number>();
  for (const page of result.pages) {
    if (!routeNumbers.has(page.routeIdentity)) routeNumbers.set(page.routeIdentity, routeNumbers.size + 1);
  }
  const counts = RESPONSIVE_VIEWPORTS.map((viewport) => {
    const entries = result.pages.filter((page) => page.viewport === viewport.id);
    return `<div class="metric"><span>${viewport.id.toUpperCase()}</span><strong>${String(entries.length)}</strong><small>${String(viewport.width)} × ${String(viewport.height)} pixels</small></div>`;
  }).join("\n");
  const findings = result.findings.map((finding) => {
    const routeNumber = routeNumbers.get(finding.routeIdentity);
    const routeLabel = routeNumber === undefined ? "Unnumbered" : `Route ${String(routeNumber).padStart(2, "0")}`;
    const explanation = finding.rule === "responsive.document-overflow"
      ? `Document exceeds viewport by ${String(finding.overflowPx ?? "?")}px`
      : finding.rule === "responsive.offscreen-control"
        ? `Control ${String(finding.controlIndex ?? "?")} is outside the visible viewport`
        : finding.rule === "responsive.clipped-control"
          ? `Control ${String(finding.controlIndex ?? "?")} may be clipped by its visible container`
        : finding.rule === "responsive.control-overlap"
          ? `Controls overlap near control ${String(finding.controlIndex ?? "?")}`
          : finding.rule === "responsive.obscured-control"
            ? `Control ${String(finding.controlIndex ?? "?")} is obscured at ${String(Math.round((finding.occludedSampleRatio ?? 0) * 100))}% of sampled points`
            : `Unclassified geometry observation at control ${String(finding.controlIndex ?? "?")}`;
    return `<tr><td>${routeLabel}</td><td>${finding.viewport}</td><td>${escapeHtml(explanation)}</td><td>Heuristic · review required</td><td>${screenshotLink(finding.screenshot)}</td></tr>`;
  }).join("\n");
  const pages = result.pages.map((page) => {
    const routeNumber = routeNumbers.get(page.routeIdentity);
    const label = routeNumber === undefined ? "Unnumbered" : `Route ${String(routeNumber).padStart(2, "0")}`;
    const status = page.status === "completed" ? "Observed" : page.status === "partial" ? "Partial" : "Unavailable";
    const detail = page.failure ?? (page.layoutStable === false ? "Unstable layout across repeated observations"
      : page.controlsTruncated || page.findingsTruncated ? "observation limit" : "—");
    return `<tr><td>${label}</td><td>${page.viewport}</td><td>${status}</td><td>${page.documentWidth ?? "—"}</td><td>${String(page.controlsInspected)}</td><td>${escapeHtml(detail)}</td><td>${screenshotLink(page.screenshot)}</td></tr>`;
  }).join("\n");
  const coverage = result.status === "completed" ? "Observed frontier complete"
    : result.status === "cancelled" ? "Cancelled · coverage incomplete" : "Partial · coverage incomplete";
  const reasons = result.terminationReasons.map((reason) => escapeHtml(reason)).join(", ") || "Known bounded frontier exhausted";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">
<title>TVDoctor responsive audit</title><style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:#f7f8fa;color:#162135}
*{box-sizing:border-box}body{margin:0}header{background:#111e35;color:#f9fbff;padding:38px max(24px,calc((100vw - 1050px)/2))}
.eyebrow{font-size:12px;letter-spacing:2px;font-weight:700;color:#a7d2f9}h1{font-size:clamp(28px,4vw,42px);margin:10px 0}header p{line-height:1.55;color:#c7d3e5;max-width:730px}
main{max-width:1100px;margin:0 auto;padding:28px 24px 70px}.status{display:inline-block;background:#e1ecfa;border-radius:24px;padding:9px 16px;font-weight:700;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:22px 0}.metric{background:#fff;border:1px solid #e3e8f0;border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:5px}
.metric span{font-weight:700;color:#55657c;letter-spacing:.08em;font-size:12px}.metric strong{font-size:31px}.metric small{color:#738092}
section{margin-top:34px}h2{font-size:20px}.table{overflow:auto;background:#fff;border:1px solid #e3e8f0;border-radius:12px}table{width:100%;border-collapse:collapse;min-width:670px}
th,td{text-align:left;padding:13px 16px;border-bottom:1px solid #edf0f5;font-size:13px;line-height:1.5}th{color:#53617b;font-weight:700;background:#f9fafc}tr:last-child td{border-bottom:0}
a{color:#1c5cb9;text-decoration:none;font-weight:650}a:hover{text-decoration:underline}.note{border-left:3px solid #6c91c9;padding:12px 17px;color:#516076;background:#edf3fb;line-height:1.65;border-radius:4px}
.muted{color:#627189;font-size:13px}
</style></head><body>
<header><div class="eyebrow">TVDOCTOR / BROWSER LAYOUT AUDIT</div><h1>Responsive findings</h1>
<p>Measured at three browser widths. This file contains summarized geometry and local evidence links; it intentionally omits target URLs, page text, credentials, and source markup.</p></header>
<main><div class="status">${coverage}</div>
<div class="grid"><div class="metric"><span>FINDINGS</span><strong>${String(result.findings.length)}</strong><small>Heuristics requiring review</small></div>
<div class="metric"><span>PAGES DISCOVERED</span><strong>${String(result.pagesDiscovered)}</strong><small>${String(result.pagesDeferred)} known routes deferred</small></div>
<div class="metric"><span>SCAN PROFILE</span><strong>${mode}</strong><small>${escapeHtml(reasons)}</small></div>${counts}</div>
	<section><h2>Potential layout problems</h2><p class="muted">Overflow, clipping, overlap and off-screen geometry may be intentional (including scrollable content and overlays). Every finding requires screenshot and behaviour review before filing a bug.</p>
<div class="table"><table><thead><tr><th>Route</th><th>Viewport</th><th>Observation</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>${findings || '<tr><td colspan="5">No layout heuristics found within the observed frontier.</td></tr>'}</tbody></table></div></section>
<section><h2>Coverage by route</h2><div class="table"><table><thead><tr><th>Route</th><th>Viewport</th><th>Status</th><th>Document width</th><th>Elements checked</th><th>Limit / failure</th><th>Evidence</th></tr></thead><tbody>${pages || '<tr><td colspan="7">No page observations completed.</td></tr>'}</tbody></table></div></section>
<section><h2>Evidence and limits</h2><p class="note">${escapeHtml(coverage)}. The scanner explores only bounded same-origin links. ${String(result.linksSkippedByPolicy)} link(s) were excluded by policy and ${String(result.pagesDeferred)} route(s) were deferred. Findings are review-only; screenshot files can contain private rendered page content. Keep the evidence directory private until reviewed.</p>
<p class="muted">Source data: <a href="responsive-result.json">responsive-result.json</a>. No complete-site, accessibility or physical-TV certification is claimed.</p></section>
</main></body></html>\n`;
}

function unavailableOverview(): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TVDoctor responsive scan unavailable</title></head><body><h1>Responsive scan could not finish</h1><p>No coverage or clean result is claimed. See the local error status.</p></body></html>\n';
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await writeFile(`${file}.tmp`, text, "utf8");
  await rename(`${file}.tmp`, file);
}

/** Direct CLI entrypoint, keeping result artifacts at a new non-overwriting output root. */
export async function runResponsiveCommand(
  args: readonly string[],
  context: CliContext,
  scanner: (request: ResponsiveScanRequest) => Promise<ResponsiveScanResult> = runResponsiveScan,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    context.io.writeStdout(`${RESPONSIVE_HELP_TEXT}\n`);
    return 0;
  }
  if (args[0] === "compare") {
    if (args.length !== 5 || args[3] !== "--output" || ![args[1], args[2], args[4]].every((path) =>
      typeof path === "string" && parseNonemptyPath(path))) {
      context.io.writeStderr("Usage: tvdoctor responsive compare BEFORE_REPORT_DIR AFTER_REPORT_DIR --output NEW_OUTPUT_DIR\n");
      return 2;
    }
    try {
      if (context.signal?.aborted === true) return 3;
      const report = await compareResponsiveBundles(args[1] as string, args[2] as string, args[4] as string);
      context.io.writeStdout(`Comparison: ${report.status.toUpperCase()}; 3 fixed viewports, human review required.\n`);
      context.io.writeStdout(`Overview: ${join(args[4] as string, "report.html")}\n`);
      return report.status === "observed" ? 0 : 3;
    } catch (error) {
      context.io.writeStderr(`Responsive comparison unavailable: ${sanitizeTerminalText(error instanceof Error ? error.message : "comparison-failed", { maximumLength: 160 })}\n`);
      return context.signal?.aborted === true ? 3 : 4;
    }
  }
  const options = parseResponsiveArguments(args);
  if (typeof options === "string") {
    context.io.writeStderr(`Invalid responsive scan: ${options}\n`);
    return 2;
  }
  try {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await mkdir(options.outputPath);
  } catch (error) {
    context.io.writeStderr(`Responsive output unavailable: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error), { maximumLength: 200 })}\n`);
    return 4;
  }
  context.io.writeStdout(`Responsive scan: ${options.mode}, up to ${String(options.maxPages)} pages at 3 viewports.\n`);
  try {
    const result = await scanner({
      target: options.target,
      outputDirectory: options.outputPath,
      maxPages: options.maxPages,
      ...(options.captureComparisonEvidence ? { captureComparisonEvidence: true } : {}),
      ...budget(options.mode),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    await writeAtomic(join(options.outputPath, "responsive-result.json"), `${JSON.stringify(result, null, 2)}\n`);
    await writeAtomic(join(options.outputPath, "report.html"), renderResponsiveReport(result, options.mode));
    context.io.writeStdout(`Responsive status: ${result.status.toUpperCase()}; ${String(result.pages.length)} observations; ${String(result.findings.length)} findings for review.\n`);
    context.io.writeStdout(`Overview: ${join(options.outputPath, "report.html")}\n`);
    // Completion is a coverage status, not a defect-free verdict: every finding is review-only.
    return result.status === "completed" ? 0 : 3;
  } catch (error) {
    const message = sanitizeTerminalText(error instanceof Error ? error.message : String(error), { maximumLength: 200 });
    try {
      await writeAtomic(join(options.outputPath, "responsive-failure.json"), `${JSON.stringify({ status: "failed", reason: message })}\n`);
      await writeAtomic(join(options.outputPath, "report.html"), unavailableOverview());
    } catch { /* Preserve the primary execution failure. */ }
    context.io.writeStderr(`Responsive scan failed: ${message}\n`);
    return context.signal?.aborted === true ? 3 : 4;
  }
}
