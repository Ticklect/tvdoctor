import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { EXPLORATION_BUDGET_PROFILES } from "@tvdoctor/core";

import type { CliContext, TestCommandRequest, TestCommandResult, TestRunMode } from "./cli.js";
import { defaultOutputDirectory } from "./product-output.js";
import { renderSpaJourneyGraph } from "./spa-graph.js";
import { runSpaJourneyScan, type SpaJourneyResult } from "./spa-journey.js";
import { safeDisplayUrl, sanitizeTerminalText } from "./terminal.js";

/** A conservative static-HTML site discovery surface. No browser actions are used to find links. */
export const SITE_SCAN_LIMITS = {
  maxPages: 20,
  defaultPages: 5,
  maxLinksPerPage: 64,
  maxQueuedRoutes: 128,
  maxHtmlBytes: 256 * 1024,
  discoveryTimeoutMs: 8_000,
} as const;

export const SITE_HELP_TEXT = `Usage:
  tvdoctor site URL --input keyboard [--mode quick|standard|deep] [--max-pages N] [--output PATH] [--keyboard-interactions] [--spa] [--no-spa-screenshots] [--spa-verify-issues] [--spa-allow-dynamic-resources]

Scan a bounded set of static same-origin HTML anchor routes with keyboard navigation.
Only safe-looking HTTP(S) GET links without query strings are discovered. HTML
discovery does not run JavaScript or click controls. Unsafe redirects, links
outside the origin, mutation-looking routes and excessive links are skipped. Existing
single-page keyboard scans write their own reports under pages/NNN/; site-index.json
and site-index.md record incomplete coverage and routes left unexplored.
--max-pages defaults to 5 (maximum 20). --mode defaults to quick.
--keyboard-interactions additionally enables policy-checked Enter/Escape.
--spa opts into experimental, separately bounded same-origin client-side UI
state discovery and checkpoint replay. Results are recorded under spa/ and
linked in the site index. It never authorizes arbitrary form submissions.
--no-spa-screenshots disables private post-Back screenshot evidence without
disabling state or heading detection (requires --spa).
--spa-verify-issues explicitly opts into fresh, bounded browser action replay
of selected heuristic SPA findings (requires --spa). Repeating apparently
safe interactions can still modify page storage or server state; use only on
sites you own or are authorised to test. Re-observation is not proof of a bug.
--spa-allow-dynamic-resources permits action-time same-origin fetch() of .html
fragments and imported .js/.mjs scripts. These GETs and scripts can have side effects; use only on
disposable sites you are authorised to test. Default network safety is unchanged.
If spa.route-content-missing appears, it is REVIEW only. On an owned disposable
app with independently authored healthy content, see tvdoctor spa-route-health
--help to capture a SHA-pinned blank original, verify repair and run fresh QA.`;

export interface SiteScanOptions {
  readonly target: string;
  readonly mode: TestRunMode;
  readonly maxPages: number;
  readonly outputPath: string;
  readonly keyboardInteractions: boolean;
  readonly spa?: boolean;
  readonly spaScreenshots?: boolean;
  /** Explicit permission for extra browser actions in a fresh verification context. */
  readonly spaVerifyIssues?: boolean;
  /** Extra read-permission for dynamic HTML templates on authorised disposable apps. */
  readonly spaDynamicResources?: boolean;
}

export interface SiteSpaSummary {
  readonly status: "completed" | "partial" | "cancelled" | "failed";
  readonly statesObserved: number;
  readonly transitionsTested: number;
  readonly deferredStates: number;
  /** Review leads from bounded SPA observations, not asserted accessibility defects. */
  readonly reviewLeads: number;
  /** Review-only client-route blank-main observations; never a verified bug count. */
  readonly routeContentReviewLeads?: number;
  readonly reportPath: "spa/spa-journey.json" | null;
  readonly graphPath?: "spa/graph.html";
  readonly reason: string | null;
}

export interface SiteRouteResult {
  readonly url: string;
  readonly status: "completed" | "partial" | "failed" | "skipped";
  readonly reportPath: string | null;
  readonly issueCount: number;
  readonly discoveredLinks: number;
  readonly discovery: "complete" | "truncated" | "unavailable";
  readonly reason: string | null;
}

/** A safe static anchor whose destination returned an actual HTTP error to a GET. */
export interface SiteLinkResponseLead {
  readonly from: string;
  readonly to: string;
  readonly statusCode: number;
  readonly evidence: "observed-http-get";
  readonly reviewRequired: true;
}

export interface SiteScanIndex {
  readonly schemaVersion: "tvdoctor.site-index/v1";
  /** Complete means this bounded static anchor frontier ended, never complete site coverage. */
  readonly discoveryScope: "static-html-anchors" | "static-html-anchors+bounded-spa";
  readonly target: string;
  readonly inputMode: "keyboard";
  readonly mode: TestRunMode;
  readonly maxPages: number;
  readonly status: "complete" | "partial" | "failed";
  readonly termination: readonly string[];
  readonly pagesScanned: number;
  readonly pagesDiscovered: number;
  readonly issueCount: number;
  /** Separately counted HTTP response leads; 404/5xx may be intentional or transient. */
  readonly linkResponseLeads?: readonly SiteLinkResponseLead[];
  readonly routes: readonly SiteRouteResult[];
  /** Known accepted routes not scanned because a bound or interruption stopped work. */
  readonly pendingRoutes: readonly string[];
  readonly omittedLinks: number;
  readonly spaJourney?: SiteSpaSummary;
}

interface DiscoveryResult {
  readonly links: readonly string[];
  readonly truncated: boolean;
  readonly omitted: number;
  readonly redirected: boolean;
}

const RISKY_ROUTE_PART = /(?:^|[/_.,;=-])(?:accept|activate|add|admin|api|apply|approve|auth|billing|buy|cancel|cart|checkout|confirm|create|delete|disable|download|edit|enable|erase|export|finalize|log-?in|log-?out|order|payment|pay|post|publish|purchase|remove|reset|revoke|save|send|sign-?in|sign-?out|subscribe|submit|transfer|unsubscribe|update|upload|user|users|write)(?=$|[/_.,;=-])/iu;
const RISKY_ACTION_TEXT = /\b(?:accept|activate|add|apply|approve|buy|cancel|checkout|create|delete|disable|enable|erase|finalize|log\s*out|order|pay|post|publish|purchase|remove|reset|revoke|save|send|sign\s*out|subscribe|submit|transfer|unsubscribe|update|upload)\b/iu;
const DOCUMENT_EXTENSION = /\.(?:7z|avi|css|csv|exe|gif|gz|ico|jpeg|jpg|js|json|mp3|mp4|pdf|png|tar|webm|webp|xml|zip)$/iu;

function decodeHtml(value: string): string | null {
  let unknown = false;
  const decoded = value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/giu, (_match, entity: string) => {
    if (entity.startsWith("#")) {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isInteger(number) && number > 0 && number <= 0x10ffff
        && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : "";
    }
    switch (entity.toLowerCase()) {
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
      case "lt": return "<";
      case "gt": return ">";
      default: unknown = true; return "";
    }
  });
  return unknown ? null : decoded;
}

function canonicalRoute(href: string, base: URL, origin: string): string | null {
  if (href.length === 0 || href.length > 2048 || href.startsWith("#") || [...href].some((char) => (
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "\\"
  ))) return null;
  const decoded = decodeHtml(href);
  if (decoded === null || decoded.includes("\0")) return null;
  let url: URL;
  try { url = new URL(decoded, base); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.origin !== origin || url.username !== "" || url.password !== ""
    || url.search !== "" || url.href.includes("?")) return null;
  url.hash = "";
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  // Reject obfuscated routes (including percent-encoded slashes) rather than
  // trying to guess which route the application server will ultimately serve.
  if (pathname.includes("%") || pathname.includes("\\") || pathname.includes("//")
    || pathname.split("/").some((part) => part === ".." || part === ".")
    || RISKY_ROUTE_PART.test(pathname) || DOCUMENT_EXTENSION.test(pathname)) return null;
  return url.href;
}

/** Extract actual opening anchor tags; ignore comments and script/style/template markup. */
export function staticSafeLinks(html: string, documentUrl: string): readonly string[] {
  const root = new URL(documentUrl);
  let base = root;
  let baseSeen = false;
  const discovered = new Set<string>();
  const content = html.slice(0, SITE_SCAN_LIMITS.maxHtmlBytes);
  const skipContents = new Set(["script", "style", "template", "noscript", "textarea"]);
  let cursor = 0;
  while (cursor < content.length && discovered.size <= SITE_SCAN_LIMITS.maxQueuedRoutes) {
    const start = content.indexOf("<", cursor);
    if (start < 0) break;
    if (content.startsWith("<!--", start)) {
      const end = content.indexOf("-->", start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    let end = start + 1;
    let quote: string | null = null;
    while (end < content.length && end - start <= 4096) {
      const char = content[end];
      if (quote !== null) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      end += 1;
    }
    if (content[end] !== ">" || end - start > 4096) break;
    cursor = end + 1;
    const token = content.slice(start + 1, end);
    const tag = /^\s*(\/?)\s*([a-z][\w:-]*)(?:\s|\/|$)/iu.exec(token);
    if (tag === null || tag[1] === "/") continue;
    const tagName = tag[2]?.toLowerCase();
    if (tagName === undefined) continue;
    if (skipContents.has(tagName)) {
      const rest = content.slice(cursor);
      const closing = new RegExp(`</\\s*${tagName}\\s*>`, "iu").exec(rest);
      if (closing === null) break;
      cursor += closing.index + closing[0].length;
      continue;
    }
    if (tagName !== "a" && tagName !== "base") continue;
    const href = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"`=<>]+))/iu.exec(token);
    const raw = href?.[1] ?? href?.[2] ?? href?.[3];
    if (raw === undefined) continue;
    if (tagName === "base") {
      if (!baseSeen) {
        baseSeen = true;
        const canonical = canonicalRoute(raw, root, root.origin);
        // A cross-origin or unsafe HTML base invalidates relative URL resolution.
        if (canonical === null) return [];
        base = new URL(canonical);
      }
      continue;
    }
    const anchorEnd = content.slice(cursor).search(/<\/\s*a\s*>/iu);
    const label = anchorEnd < 0 ? "" : content.slice(cursor, cursor + Math.min(anchorEnd, 512)).replace(/<[^>]*>/gu, " ");
    if (RISKY_ACTION_TEXT.test(label)) continue;
    const canonical = canonicalRoute(raw, base, root.origin);
    if (canonical !== null) discovered.add(canonical);
  }
  return [...discovered];
}

async function discoverRoutes(url: string, origin: string, signal?: AbortSignal): Promise<DiscoveryResult> {
  const deadline = AbortSignal.timeout(SITE_SCAN_LIMITS.discoveryTimeoutMs);
  const abort = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  let current = url;
  let redirects = 0;
  while (true) {
    abort.throwIfAborted();
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { Accept: "text/html", "User-Agent": "TVDoctor-site-scan/0.1" },
      signal: abort,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      const next = location === null ? null : canonicalRoute(location, new URL(current), origin);
      if (next === null || next === current || redirects >= 2) {
        throw new Error("unsafe-or-excessive-redirect");
      }
      redirects += 1;
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`http-${String(response.status)}`);
    }
    if (!/\btext\/html\b/iu.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      throw new Error("not-html");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("empty-html");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const remaining = SITE_SCAN_LIMITS.maxHtmlBytes - bytes;
        if (part.value.byteLength > remaining) {
          if (remaining > 0) chunks.push(part.value.subarray(0, remaining));
          bytes = SITE_SCAN_LIMITS.maxHtmlBytes;
          truncated = true;
          break;
        }
        chunks.push(part.value);
        bytes += part.value.byteLength;
      }
    } finally {
      if (truncated) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const html = Buffer.concat(chunks).toString("utf8");
    const found = staticSafeLinks(html, current);
    const links = found.slice(0, SITE_SCAN_LIMITS.maxLinksPerPage);
    return {
      links,
      truncated: truncated || found.length > links.length,
      omitted: Math.max(0, found.length - links.length) + (truncated ? 1 : 0),
      redirected: redirects > 0,
    };
  }
}

export function parseSiteArguments(args: readonly string[]): SiteScanOptions | string {
  let target: string | undefined;
  let mode: TestRunMode = "quick";
  let input: string | undefined;
  let maxPages: number = SITE_SCAN_LIMITS.defaultPages;
  let outputPath: string | undefined;
  let keyboardInteractions = false;
  let spa = false;
  let spaScreenshots = true;
  let spaVerifyIssues = false;
  let spaDynamicResources = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--keyboard-interactions") {
      if (keyboardInteractions) return "--keyboard-interactions may be specified only once";
      keyboardInteractions = true;
      continue;
    }
    if (arg === "--spa") {
      if (spa) return "--spa may be specified only once";
      spa = true;
      continue;
    }
    if (arg === "--no-spa-screenshots") {
      if (!spaScreenshots) return "--no-spa-screenshots may be specified only once";
      spaScreenshots = false;
      continue;
    }
    if (arg === "--spa-verify-issues") {
      if (spaVerifyIssues) return "--spa-verify-issues may be specified only once";
      spaVerifyIssues = true;
      continue;
    }
    if (arg === "--spa-allow-dynamic-resources") {
      if (spaDynamicResources) return "--spa-allow-dynamic-resources may be specified only once";
      spaDynamicResources = true;
      continue;
    }
    if (arg.startsWith("--")) {
      if (!["--input", "--mode", "--max-pages", "--output"].includes(arg)) return `unknown site option: ${arg}`;
      if (seen.has(arg)) return `${arg} may be specified only once`;
      seen.add(arg);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return `${arg} requires a value`;
      if (arg === "--input") input = value;
      if (arg === "--mode") {
        if (value !== "quick" && value !== "standard" && value !== "deep") return "--mode must be quick, standard, or deep";
        mode = value;
      }
      if (arg === "--max-pages") {
        if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value))
          || Number(value) < 1 || Number(value) > SITE_SCAN_LIMITS.maxPages) {
          return `--max-pages must be an integer between 1 and ${String(SITE_SCAN_LIMITS.maxPages)}`;
        }
        maxPages = Number(value);
      }
      if (arg === "--output") {
        if (value.trim() !== value || value.length === 0 || value.length > 1024 || value.includes("\0")) {
          return "--output requires a bounded non-empty path";
        }
        outputPath = value;
      }
      index += 1;
      continue;
    }
    if (target !== undefined) return "site accepts exactly one URL";
    target = arg;
  }
  if (target === undefined) return "site requires a URL";
  if (!spa && !spaScreenshots) return "--no-spa-screenshots requires --spa";
  if (!spa && spaVerifyIssues) return "--spa-verify-issues requires --spa";
  if (!spa && spaDynamicResources) return "--spa-allow-dynamic-resources requires --spa";
  if (input !== "keyboard") return "site requires --input keyboard";
  let parsed: URL;
  try { parsed = new URL(target); } catch { return "site target must be an absolute HTTP(S) URL without credentials"; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== "" || parsed.password !== "" || parsed.href.includes("?") || parsed.href.includes("#")) {
    return "site target must be an absolute HTTP(S) URL without credentials, query, or fragment";
  }
  if (canonicalRoute(parsed.href, parsed, parsed.origin) === null) return "site target appears to be an unsafe action route";
  return {
    target: parsed.href,
    mode,
    maxPages,
    outputPath: outputPath ?? defaultOutputDirectory({ target: parsed.href, mode: `site-${mode}` }),
    keyboardInteractions,
    ...(spa ? { spa: true } : {}),
    ...(spaScreenshots ? {} : { spaScreenshots: false }),
    ...(spaVerifyIssues ? { spaVerifyIssues: true } : {}),
    ...(spaDynamicResources ? { spaDynamicResources: true } : {}),
  };
}

function isInterrupted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function pageBudget(mode: TestRunMode): Pick<TestCommandRequest, "maxDurationMs" | "navigationBudgets"> {
  const base = EXPLORATION_BUDGET_PROFILES[mode];
  return {
    maxDurationMs: Math.min(base.maxDurationMs, mode === "deep" ? 120_000 : mode === "standard" ? 60_000 : 30_000),
    navigationBudgets: {
      maxActions: Math.min(base.maxActions, mode === "deep" ? 1000 : mode === "standard" ? 500 : 300),
      maxStates: Math.min(base.maxStates, 100),
      maxDepth: Math.min(base.maxDepth, 12),
    },
  };
}

function summaryMarkdown(index: SiteScanIndex): string {
  const lines = [
    "# TVDoctor site scan",
    "",
    `- Target: ${index.target}`,
    `- Input: keyboard (Tab / Shift+Tab)`,
    `- Coverage: **${index.status.toUpperCase()}**`,
    `- Pages scanned: ${String(index.pagesScanned)} / ${String(index.maxPages)} allowed`,
    `- Routes discovered: ${String(index.pagesDiscovered)}`,
    `- Findings: ${String(index.issueCount)}`,
    `- Broken-link HTTP response leads (review required): ${String(index.linkResponseLeads?.length ?? 0)}`,
    ...(index.spaJourney === undefined ? [] : [
      `- Experimental SPA exploration: **${index.spaJourney.status.toUpperCase()}**`,
      `- SPA states / observed transitions: ${String(index.spaJourney.statesObserved)} / ${String(index.spaJourney.transitionsTested)}`,
      `- SPA deferred branches: ${String(index.spaJourney.deferredStates)}; review leads: ${String(index.spaJourney.reviewLeads)}`,
      ...(index.spaJourney.routeContentReviewLeads === undefined ? [] : [
        `- Possible blank client-side routes (REVIEW only): ${String(index.spaJourney.routeContentReviewLeads)}`,
        ...(index.spaJourney.routeContentReviewLeads > 0 ? [
          "- Next: inspect the local SPA graph, reproduce the exact route on an authorised test app, check client router/data loading and intentional empty states. Use `tvdoctor spa-route-health --help` for an independently authored before/after recovery gate; HTTP 200 or a disappeared finding does not prove FIXED.",
        ] : []),
      ]),
      ...(index.spaJourney.graphPath === undefined ? [] : [`- SPA state graph: [View HTML graph](${index.spaJourney.graphPath})`]),
      ...(index.spaJourney.reportPath === null ? [] : [`- SPA replay evidence: [spa-journey.json](${index.spaJourney.reportPath})`]),
    ]),
    `- Termination: ${index.termination.length === 0 ? "none" : index.termination.join(", ")}`,
    "",
    "| Route | Status | Findings | Report | Discovery |",
    "| --- | --- | ---: | --- | --- |",
  ];
  const cell = (s: string): string => s.replace(/[|\r\n`<>]/gu, " ").slice(0, 512);
  for (const route of index.routes) {
    const report = route.reportPath === null ? "none" : `[report](${route.reportPath.replace(/\\/gu, "/")})`;
    lines.push(`| ${cell(route.url)} | ${route.status} | ${String(route.issueCount)} | ${report} | ${route.discovery}${route.reason === null ? "" : ` (${cell(route.reason)})`} |`);
  }
  if ((index.linkResponseLeads?.length ?? 0) > 0) {
    lines.push("", "## HTTP response leads from discovered links (review required)", "",
      "| Source route | Destination route | Observed GET status |", "| --- | --- | ---: |");
    for (const lead of index.linkResponseLeads ?? []) {
      lines.push(`| ${cell(lead.from)} | ${cell(lead.to)} | ${String(lead.statusCode)} |`);
    }
  }
  if (index.pendingRoutes.length > 0) {
    lines.push("", "## Known unscanned routes", "", ...index.pendingRoutes.map((url) => `- ${cell(url)}`));
  }
  if (index.omittedLinks > 0) lines.push("", `${String(index.omittedLinks)} additional link(s) were omitted by discovery limits.`);
  lines.push("", "Only observed routes and findings are reported. Static GET discovery does not establish full website coverage.", "");
  return lines.join("\n");
}

/** Privacy-minded offline site overview: paths and target labels are deliberately omitted. */
export function renderSiteReport(index: SiteScanIndex): string {
  const escapeHtml = (value: string): string => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
  const reportLink = (path: string | null): string => path !== null && /^pages\/[0-9]{3}\/report\.json$/u.test(path)
    ? `<a href="${path.replace(/\.json$/u, ".html")}">Open report</a>` : "No saved report";
  const rows = index.routes.map((route, row) => `<tr>
    <td>Route ${String(row + 1).padStart(2, "0")}</td>
    <td>${escapeHtml(route.status)}</td>
    <td>${String(route.issueCount)}</td>
    <td>${escapeHtml(route.discovery)}</td>
    <td>${reportLink(route.reportPath)}</td>
  </tr>`).join("\n");
  const spa = index.spaJourney;
  const linkLeads = index.linkResponseLeads ?? [];
  const linkLeadSection = linkLeads.length === 0 ? "" : `<section><h2>HTTP link response leads</h2>
    <p>${String(linkLeads.length)} discovered safe anchor(s) returned HTTP 404, 410 or 5xx to a GET. These are observed responses requiring review, not proven application defects.</p>
    <p>Source and destination URLs are available in the private site-index.json; they are omitted from this shareable page.</p>
    <table><thead><tr><th>Source</th><th>Destination</th><th>Observed HTTP status</th></tr></thead><tbody>${linkLeads.map((lead) => {
      const source = index.routes.findIndex((route) => route.url === lead.from);
      const destination = index.routes.findIndex((route) => route.url === lead.to);
      return `<tr><td>Route ${source < 0 ? "unknown" : String(source + 1).padStart(2, "0")}</td><td>Route ${destination < 0 ? "unknown" : String(destination + 1).padStart(2, "0")}</td><td>${String(lead.statusCode)}</td></tr>`;
    }).join("")}</tbody></table></section>`;
  const spaSection = spa === undefined ? "" : `<section><h2>Experimental SPA journey discovery</h2>
    <p>Only explicitly allowlisted reversible controls and client-side route changes are explored. This is not comprehensive application coverage.</p>
    <div class="metrics"><div><strong>${escapeHtml(spa.status.toUpperCase())}</strong><span>Journey status</span></div>
    <div><strong>${String(spa.statesObserved)}</strong><span>Observed states</span></div>
    <div><strong>${String(spa.transitionsTested)}</strong><span>Observed transitions</span></div>
    <div><strong>${String(spa.deferredStates)}</strong><span>Deferred branches</span></div>
    <div><strong>${String(spa.reviewLeads)}</strong><span>Review leads, not verified bugs</span></div></div>
    ${spa.routeContentReviewLeads === undefined ? "" : `<p><strong>${String(spa.routeContentReviewLeads)}</strong> possible blank client-side route(s) (REVIEW, not confirmed defects). Check the recorded journey and source app, verify intended content and hydration, then use <code>tvdoctor spa-route-health --help</code> for an independently authored before/after assertion with fresh QA. HTTP 200 alone cannot prove a fix.</p>`}
    <p>${spa.graphPath === "spa/graph.html" ? '<a href="spa/graph.html">View local HTML state graph</a> · ' : ""}${spa.reportPath === "spa/spa-journey.json" ? '<a href="spa/spa-journey.json">Open machine-readable replay evidence (JSON)</a>' : "Journey evidence unavailable"}</p>
  </section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>TVDoctor site coverage</title><style>
    :root{font:15px system-ui,-apple-system,Segoe UI,sans-serif;color:#19283f;background:#f5f7fb}
    *{box-sizing:border-box}body{margin:0}header{padding:35px max(22px,calc((100vw - 1050px)/2));background:#13243b;color:white}
    h1{font-size:clamp(27px,4vw,40px);margin:10px 0}header p{color:#d1d8e4;line-height:1.55}
    main{max-width:1094px;padding:27px 22px 70px;margin:auto}section{margin:30px 0}
    .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
    .metrics div{display:flex;flex-direction:column;gap:6px;border:1px solid #dfe4ed;border-radius:10px;padding:19px;background:white}
    strong{font-size:25px}span{font-size:12px;color:#64728a}h2{font-size:21px}
    table{width:100%;border-collapse:collapse;background:white;border:1px solid #dfe4ed}
    th,td{text-align:left;border-bottom:1px solid #e8ecf2;padding:13px;font-size:13px}
    th{background:#eaf0f7}a{color:#1b59a6}p{line-height:1.65}
    .note{border-left:3px solid #5079ba;padding:11px 16px;background:#e8f0fa}
    </style></head><body><header><small>TVDOCTOR / BOUNDED WEBSITE AUDIT</small><h1>Route and state coverage</h1>
    <p>Only observed pages, actions and evidence. URLs, credentials and page text are intentionally absent from this shareable overview.</p></header>
    <main><div class="metrics"><div><strong>${escapeHtml(index.status.toUpperCase())}</strong><span>Bounded scan status</span></div>
    <div><strong>${String(index.pagesScanned)}</strong><span>Static routes scanned (max ${String(index.maxPages)})</span></div>
    <div><strong>${String(index.pagesDiscovered)}</strong><span>Known routes</span></div>
    <div><strong>${String(index.pendingRoutes.length)}</strong><span>Routes left unvisited</span></div>
    <div><strong>${String(index.issueCount)}</strong><span>Page-audit findings</span></div></div>
    <section><h2>Visited routes</h2><table><thead><tr><th>Route</th><th>Audit status</th><th>Findings</th><th>Discovery</th><th>Evidence</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No static routes were audited.</td></tr>'}</tbody></table></section>
    ${linkLeadSection}${spaSection}<section class="note"><h2>Coverage limits</h2>
    <p>${index.termination.length === 0 ? "No known limit was hit within the explored frontier." : `${String(index.termination.length)} scan limit or interruption reason(s) recorded.`}
    Static link discovery uses safe-looking same-origin GET routes; some sites may implement side effects even on GET. No exhaustive website, accessibility or privacy certification is implied.
    ${String(index.omittedLinks)} links were omitted by discovery limits. Local screenshots and videos may include private content.</p>
    <p><a href="site-index.json">Inspect machine-readable coverage and deferred work (may contain private URLs)</a></p></section>
    </main></body></html>\n`;
}

async function writeSiteIndex(output: string, index: SiteScanIndex): Promise<void> {
  const json = join(output, "site-index.json");
  await writeFile(`${json}.tmp`, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(`${json}.tmp`, json);
  const markdown = join(output, "site-index.md");
  await writeFile(`${markdown}.tmp`, summaryMarkdown(index), "utf8");
  await rename(`${markdown}.tmp`, markdown);
  const html = join(output, "site-index.html");
  await writeFile(`${html}.tmp`, renderSiteReport(index), "utf8");
  await rename(`${html}.tmp`, html);
}

export async function scanSite(
  options: SiteScanOptions,
  scan: (request: TestCommandRequest) => Promise<TestCommandResult>,
  signal?: AbortSignal,
  discover: (url: string, origin: string, signal?: AbortSignal) => Promise<DiscoveryResult> = discoverRoutes,
  scanSpa: typeof runSpaJourneyScan = runSpaJourneyScan,
): Promise<SiteScanIndex> {
  // Reserving the output path without recursive overwrite keeps old report bundles safe.
  await mkdir(dirname(options.outputPath), { recursive: true });
  await mkdir(options.outputPath);
  await mkdir(join(options.outputPath, "pages"));
  const origin = new URL(options.target).origin;
  const queue = [options.target];
  const known = new Set(queue);
  const discoveredFrom = new Map<string, string>();
  const routes: SiteRouteResult[] = [];
  const linkResponseLeads: SiteLinkResponseLead[] = [];
  const termination = new Set<string>();
  let pagesScanned = 0;
  let omittedLinks = 0;
  let issueCount = 0;
  let spaJourney: SiteSpaSummary | undefined;

  const index = (): SiteScanIndex => ({
    schemaVersion: "tvdoctor.site-index/v1",
    discoveryScope: options.spa === true ? "static-html-anchors+bounded-spa" : "static-html-anchors",
    target: options.target,
    inputMode: "keyboard",
    mode: options.mode,
    maxPages: options.maxPages,
    status: routes.length === 0 || routes.every((route) => route.status === "failed" || route.status === "skipped")
      ? "failed"
      : termination.size > 0 || queue.length > 0 || routes.some((route) => route.status !== "completed") ? "partial" : "complete",
    termination: [...termination],
    pagesScanned,
    pagesDiscovered: known.size,
    issueCount,
    linkResponseLeads: [...linkResponseLeads],
    routes: [...routes],
    pendingRoutes: [...queue],
    omittedLinks,
    ...(spaJourney === undefined ? {} : { spaJourney }),
  });

  try {
    while (queue.length > 0 && pagesScanned < options.maxPages) {
      if (isInterrupted(signal)) { termination.add("interrupted"); break; }
      const url = queue.shift();
      if (url === undefined) break;
      let discovery: DiscoveryResult;
      try {
        discovery = await discover(url, origin, signal);
      } catch (error) {
        if (isInterrupted(signal)) termination.add("interrupted");
        else termination.add("discovery-unavailable");
        const reason = error instanceof Error ? error.message : "discovery-error";
        const responseStatus = /^http-(404|410|5[0-9]{2})$/u.exec(reason);
        const from = discoveredFrom.get(url);
        if (responseStatus !== null && from !== undefined) {
          linkResponseLeads.push({ from, to: url, statusCode: Number(responseStatus[1]),
            evidence: "observed-http-get", reviewRequired: true });
        }
        routes.push({ url, status: "skipped", reportPath: null, issueCount: 0,
          discoveredLinks: 0, discovery: "unavailable", reason: sanitizeTerminalText(reason, { maximumLength: 120 }) });
        await writeSiteIndex(options.outputPath, index());
        if (isInterrupted(signal)) break;
        continue;
      }

      for (const candidate of discovery.links) {
        // Revalidate injected discovery adapters and URLs from untrusted markup.
        const safe = canonicalRoute(candidate, new URL(url), origin);
        if (safe === null || known.has(safe)) continue;
        if (known.size >= SITE_SCAN_LIMITS.maxQueuedRoutes) {
          omittedLinks += 1;
          termination.add("max-discovered-routes");
          continue;
        }
        known.add(safe);
        discoveredFrom.set(safe, url);
        queue.push(safe);
      }
      omittedLinks += discovery.omitted;
      if (discovery.truncated) termination.add("html-discovery-truncated");

      pagesScanned += 1;
      const relativeReportPath = `pages/${String(pagesScanned).padStart(3, "0")}/report.json`;
      const expectedReportPath = join(options.outputPath, "pages", String(pagesScanned).padStart(3, "0"), "report.json");
      const request: TestCommandRequest = {
        target: url,
        inputMode: "keyboard",
        ...(options.keyboardInteractions ? { keyboardInteractions: true } : {}),
        mode: options.mode,
        packs: ["navigation"],
        outputPath: join(options.outputPath, "pages", String(pagesScanned).padStart(3, "0")),
        searchQuery: "N",
        disableRepetitionCompression: true,
        ...pageBudget(options.mode),
        ...(signal === undefined ? {} : { signal }),
      };
      let status: SiteRouteResult["status"] = "failed";
      let reportPath: string | null = null;
      let findings = 0;
      let reason: string | null = null;
      try {
        const result = await scan(request);
        status = result.status;
        findings = result.issueCount;
        if (result.reportPath !== null && resolve(result.reportPath) === resolve(expectedReportPath)
          && (await stat(expectedReportPath).catch(() => null))?.isFile() === true) {
          reportPath = relativeReportPath;
        } else {
          reason = "page-report-unavailable";
          if (status === "completed") status = "partial";
        }
        if (status !== "completed") termination.add(`page-${status}`);
        if (reportPath === null) termination.add("missing-page-report");
      } catch (error) {
        reason = sanitizeTerminalText(error instanceof Error ? error.message : "scan-failed", { maximumLength: 120 });
        termination.add(isInterrupted(signal) ? "interrupted" : "page-failed");
      }
      issueCount += findings;
      routes.push({
        url, status, reportPath, issueCount: findings, discoveredLinks: discovery.links.length,
        discovery: discovery.truncated ? "truncated" : "complete", reason,
      });
      await writeSiteIndex(options.outputPath, index());
    }
    if (queue.length > 0 && pagesScanned >= options.maxPages) termination.add("max-pages");
    if (isInterrupted(signal)) termination.add("interrupted");
    if (options.spa === true && !isInterrupted(signal)) {
      try {
        const spa: SpaJourneyResult = await scanSpa({
          target: options.target,
          outputDirectory: join(options.outputPath, "spa"),
          maxStates: Math.min(40, options.maxPages * 8),
          maxActions: options.mode === "quick" ? 80 : options.mode === "standard" ? 150 : 240,
          maxDepth: options.mode === "quick" ? 4 : options.mode === "standard" ? 6 : 8,
          maxDurationMs: options.mode === "quick" ? 15_000 : options.mode === "standard" ? 30_000 : 60_000,
          ...(options.spaScreenshots === false ? { screenshots: false } : {}),
          ...(options.spaVerifyIssues === true ? { verifyIssues: true } : {}),
          ...(options.spaDynamicResources === true ? { allowDynamicResources: true } : {}),
          ...(signal === undefined ? {} : { signal }),
        });
        const hasSavedReport = (await stat(join(options.outputPath, "spa", "spa-journey.json")).catch(() => null))?.isFile() === true;
        let hasSavedGraph = false;
        if (hasSavedReport) {
          try {
            const graphPath = join(options.outputPath, "spa", "graph.html");
            await writeFile(`${graphPath}.tmp`, renderSpaJourneyGraph(spa), "utf8");
            await rename(`${graphPath}.tmp`, graphPath);
            hasSavedGraph = true;
          } catch {
            termination.add("spa-graph-unavailable");
          }
        }
        spaJourney = {
          status: spa.status,
          statesObserved: spa.states.length,
          // A deferred or blocked edge is not an observed transition. Keep the
          // unfinished work separate rather than overstating interaction coverage.
          transitionsTested: spa.edges.filter((edge) => edge.status === "observed").length,
          deferredStates: spa.deferred.length,
          reviewLeads: spa.issues.length,
          routeContentReviewLeads: spa.issues.filter((issue) => issue.rule === "spa.route-content-missing").length,
          reportPath: hasSavedReport ? "spa/spa-journey.json" : null,
          ...(hasSavedGraph ? { graphPath: "spa/graph.html" as const } : {}),
          reason: spa.terminationReasons.length > 0 ? spa.terminationReasons.join(", ").slice(0, 200) : null,
        };
        if (spa.status !== "completed" || spa.deferred.length > 0 || !hasSavedReport) termination.add("spa-partial");
      } catch (error) {
        termination.add(isInterrupted(signal) ? "interrupted" : "spa-failed");
        spaJourney = {
          status: isInterrupted(signal) ? "cancelled" : "failed", statesObserved: 0,
          transitionsTested: 0, deferredStates: 0, reviewLeads: 0,
          reportPath: null,
          reason: sanitizeTerminalText(error instanceof Error ? error.message : "spa-scan-unavailable", { maximumLength: 160 }),
        };
      }
    }
  } finally {
    await writeSiteIndex(options.outputPath, index());
  }
  return index();
}

/** Source CLI command. Every accepted route calls the host's actual testTarget operation. */
export async function runSiteCommand(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    context.io.writeStdout(`${SITE_HELP_TEXT}\n`);
    return 0;
  }
  const parsed = parseSiteArguments(args);
  if (typeof parsed === "string") {
    context.io.writeStderr(`Invalid site scan: ${parsed}\n`);
    return 2;
  }
  const scan = context.operations?.testTarget;
  if (scan === undefined) {
    context.io.writeStderr("Web audit is unavailable in this CLI host.\n");
    return 4;
  }
  context.io.writeStdout(`Site: ${safeDisplayUrl(parsed.target)}; keyboard; ${parsed.mode}; limit ${String(parsed.maxPages)} pages${parsed.spa === true ? "; experimental SPA exploration" : ""}\n`);
  try {
    const result = await scanSite(parsed, (request) => scan(request), context.signal);
    context.io.writeStdout(`Site status: ${result.status.toUpperCase()}; scanned ${String(result.pagesScanned)}/${String(result.pagesDiscovered)} discovered; findings ${String(result.issueCount)}; HTTP link review leads ${String(result.linkResponseLeads?.length ?? 0)}\n`);
    if (result.spaJourney !== undefined) {
      context.io.writeStdout(`SPA: ${result.spaJourney.status.toUpperCase()}; ${String(result.spaJourney.statesObserved)} states, ${String(result.spaJourney.transitionsTested)} transitions, ${String(result.spaJourney.deferredStates)} deferred; ${String(result.spaJourney.reviewLeads)} review leads${result.spaJourney.routeContentReviewLeads === undefined ? "" : `, ${String(result.spaJourney.routeContentReviewLeads)} possible blank client-side routes (REVIEW only)`}\n`);
      if ((result.spaJourney.routeContentReviewLeads ?? 0) > 0) context.io.writeStdout("Next: open the local SPA graph and check expected content/hydration in an authorised test instance. Use tvdoctor spa-route-health --help for SHA-bound repair evidence and fresh QA; HTTP 200 or a vanished REVIEW never proves FIXED.\n");
      if (result.spaJourney.graphPath !== undefined) context.io.writeStdout(`SPA graph: ${join(parsed.outputPath, "spa", "graph.html")}\n`);
    }
    context.io.writeStdout(`Route index: ${join(parsed.outputPath, "site-index.json")}\n`);
    context.io.writeStdout(`Overview: ${join(parsed.outputPath, "site-index.html")}\n`);
    return result.status === "complete" ? 0 : result.status === "partial" ? 3 : 4;
  } catch (error) {
    context.io.writeStderr(`Site scan failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error), { maximumLength: 240 })}\n`);
    return context.signal?.aborted === true ? 3 : 4;
  }
}
