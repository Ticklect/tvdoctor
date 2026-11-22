import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";

import { isSafeTerminalArgument } from "./terminal.js";

export const SPA_JOURNEY_LIMITS = {
  maxStates: 40,
  maxActions: 240,
  maxDepth: 8,
  maxDurationMs: 120_000,
  maxCandidatesPerState: 48,
  maxDomElements: 512,
  maxGraphEdges: 240,
  maxDeferred: 240,
} as const;

export interface SpaJourneyRequest {
  readonly target: string;
  readonly outputDirectory: string;
  readonly maxStates?: number;
  /** Counts every action, including every attempted replay click. */
  readonly maxActions?: number;
  readonly maxDepth?: number;
  readonly maxDurationMs?: number;
  /** Explicit opt-out from locally stored Back-state PNGs; never affects detection. */
  readonly screenshots?: boolean;
  /** Additional, opt-in Chromium actions; a site can mutate even on a GET or ARIA click. */
  readonly verifyIssues?: boolean;
  /** Extra opt-in: dynamic same-origin HTML/JS resources may cause server side effects. */
  readonly allowDynamicResources?: boolean;
  readonly signal?: AbortSignal;
}

export interface SpaJourneyStep {
  readonly index: number;
  readonly kind: "anchor" | "menu-toggle" | "dialog-toggle" | "disclosure-toggle";
  readonly targetFingerprint: string;
  /** Verified state after this step, never a guessed target. */
  readonly checkpoint: string;
}

export interface SpaJourneyState {
  readonly id: string;
  readonly routeIdentity: string;
  readonly depth: number;
  /** Replay from the initial page is checkpoint-verified at every step. */
  readonly replay: readonly SpaJourneyStep[];
  readonly candidatesObserved: number;
}

export interface SpaJourneyEdge {
  readonly from: string;
  readonly to: string | null;
  readonly kind: SpaJourneyStep["kind"];
  readonly targetFingerprint: string;
  readonly targetIndex: number;
  readonly status: "observed" | "deferred" | "drift" | "blocked";
  readonly reason: string | null;
  readonly replay: readonly SpaJourneyStep[];
}

export interface SpaJourneyDeferred {
  readonly from: string;
  readonly targetFingerprint: string | null;
  readonly reason: "max-states" | "max-actions" | "max-depth" | "deadline-exceeded" | "cancelled"
    | "replay-drift" | "blocked-action" | "candidate-limit" | "graph-limit" | "observation-failed"
    | "history-back-limit" | "history-back-interruption-unchecked" | "runtime-event-limit"
    | "post-action-unsettled";
}

type RuntimeEventKind = "page-error" | "console-error" | "http-response" | "request-failed";
type RuntimeResourceType = "stylesheet" | "script" | "image" | "font" | "media" | "other";

export interface SpaJourneyRuntimeEvent {
  readonly kind: RuntimeEventKind;
  /** The verified forward edge, never an inferred association with a Back/replay. */
  readonly sourceStateId: string;
  readonly observedStateId: string;
  /** SHA-256 prefix of PUBLIC rule/edge/state/kind/status/resource metadata only. */
  readonly eventFingerprint: string;
  readonly httpStatus?: number;
  readonly resourceType?: RuntimeResourceType;
}

export interface SpaJourneyIssue {
  readonly rule: "spa.expanded-panel-mismatch" | "spa.history-back-stale-view"
    | "spa.history-back-interrupted-stale-view" | "spa.runtime-page-error"
    | "spa.runtime-console-error" | "spa.http-response-error" | "spa.network-request-failed"
    | "spa.route-content-missing";
  readonly stateId: string;
  readonly edgeIndex: number;
  readonly confidence: "heuristic";
  readonly reviewRequired: true;
  readonly evidence: "observed-dom-after-action" | "observed-dom-after-history-back"
    | "observed-dom-after-interrupted-history-back" | "observed-runtime-event-after-action";
  readonly runtimeEvent?: SpaJourneyRuntimeEvent;
  /** Bounded independent browser-context replay. Never changes heuristic confidence. */
  readonly verification?: {
    readonly status: "reobserved" | "not-reobserved" | "deferred";
    readonly reason: "matched-observation" | "observation-differed" | "source-checkpoint-drift"
      | "action-blocked" | "post-action-unsettled" | "budget-exhausted" | "unsupported-rule";
    /** Safe public digest; no page text, URL, stack or console argument is persisted. */
    readonly fingerprint: string;
    readonly replayStepsVerified: number;
    readonly actions: number;
    readonly durationMs: number;
  };
  /** Captured from an actual browser Back, never inferred from forward replay. */
  readonly historyBack?: {
    readonly expectedStateId: string;
    readonly observedStateId: string;
    readonly expectedRouteIdentity: string;
    readonly observedRouteIdentity: string;
    readonly beforeHeadingFingerprint: string;
    readonly forwardHeadingFingerprint: string;
    readonly returnedHeadingFingerprint: string;
    readonly historyDelta: number;
    readonly settledSamples: number;
    /** Present only for independently witnessed two-step interrupted browser Back. */
    readonly interruptedBack?: {
      readonly intermediateStateId: string;
      readonly finalForwardStateId: string;
      readonly intermediateRouteIdentity: string;
    };
    /** Optional local PNG taken after this genuine Back observation, not forward replay. */
    readonly screenshot?: {
      /** Relative to the SPA report directory; edge number binds image to witness. */
      readonly path: string;
      readonly sha256: string;
      readonly byteLength: number;
    };
  };
}

export interface SpaJourneyResult {
  readonly schemaVersion: "tvdoctor.spa-journey/v1";
  readonly status: "completed" | "partial" | "failed" | "cancelled";
  readonly targetIdentity: string;
  readonly states: readonly SpaJourneyState[];
  readonly edges: readonly SpaJourneyEdge[];
  readonly deferred: readonly SpaJourneyDeferred[];
  readonly issues: readonly SpaJourneyIssue[];
  readonly terminationReasons: readonly string[];
  readonly actionsUsed: number;
  readonly replayActions: number;
  readonly driftCount: number;
  readonly unsafeRequestsBlocked: number;
  readonly unsafeCandidatesSkipped: number;
  readonly candidatesTruncated: boolean;
  readonly budgets: { readonly maxStates: number; readonly maxActions: number; readonly maxDepth: number; readonly maxDurationMs: number };
}

export interface SpaJourneyDependencies {
  readonly launchBrowser?: () => Promise<Browser>;
}

interface LiveCandidate {
  readonly index: number;
  readonly kind: SpaJourneyStep["kind"];
  readonly marker: string;
  /** Transient policy inputs, never serialized into persistent evidence. */
  readonly href: string;
  readonly label: string;
  readonly expanded: boolean | null;
  readonly controlledVisible: boolean | null;
}

interface LiveSnapshot {
  readonly url: string;
  readonly documentToken: string;
  /** Visible explicit ARIA busy/progress state; never serialized as page text. */
  readonly semanticBusy: boolean;
  readonly historyTransitions: number;
  readonly historyPushes: number;
  readonly signals: readonly string[];
  readonly headings: readonly string[];
  /** Browser-computed content presence only; no main text crosses this boundary. */
  readonly visibleMainCount: number;
  readonly substantiveMainContent: boolean;
  readonly emptyMainContent: boolean;
  readonly mainContentInspectionComplete: boolean;
  readonly candidates: readonly LiveCandidate[];
  readonly candidatesTruncated: boolean;
  readonly unsafeCandidatesSkipped: number;
}

interface Observation {
  readonly id: string;
  readonly routeIdentity: string;
  readonly semanticBusy: boolean;
  readonly documentToken: string;
  readonly historyTransitions: number;
  readonly historyPushes: number;
  readonly headingFingerprint: string;
  readonly headingCount: number;
  readonly visibleMainCount: number;
  readonly substantiveMainContent: boolean;
  readonly emptyMainContent: boolean;
  readonly mainContentInspectionComplete: boolean;
  readonly candidates: readonly (LiveCandidate & { readonly fingerprint: string })[];
  readonly candidatesTruncated: boolean;
  readonly unsafeCandidatesSkipped: number;
}

interface QueueItem {
  readonly id: string;
  readonly replay: readonly SpaJourneyStep[];
  readonly depth: number;
  readonly candidates: Observation["candidates"];
}

interface CapturedRuntimeEvent {
  readonly kind: RuntimeEventKind;
  readonly httpStatus?: number;
  readonly resourceType?: RuntimeResourceType;
}

interface RuntimeCapture {
  readonly events: CapturedRuntimeEvent[];
  truncated: boolean;
}

const MAX_RUNTIME_EVENTS_PER_ACTION = 16;
const MAX_RUNTIME_ISSUES = 64;
/** Only suspicious, otherwise settled empty routes pay this additional hydration window. */
const EMPTY_ROUTE_GRACE_MS = 2_000;

function resourceType(value: string): RuntimeResourceType {
  return value === "stylesheet" || value === "script" || value === "image"
    || value === "font" || value === "media" ? value : "other";
}

function runtimeRule(kind: RuntimeEventKind): SpaJourneyIssue["rule"] {
  switch (kind) {
    case "page-error": return "spa.runtime-page-error";
    case "console-error": return "spa.runtime-console-error";
    case "http-response": return "spa.http-response-error";
    case "request-failed": return "spa.network-request-failed";
  }
}

const RISKY_PART = /(?:^|[/_.,;=-])(?:accept|activate|add|admin|api|apply|approve|auth|billing|buy|cancel|cart|checkout|confirm|create|delete|destroy|disable|download|edit|enable|erase|export|finalize|login|logout|order|payment|pay|post|publish|purchase|remove|reset|revoke|save|send|signin|signout|subscribe|submit|transfer|unsubscribe|update|upload|user|users|write)(?=$|[/_.,;=-])/iu;
const RISKY_WORD = /\b(?:account|approve|buy|cancel|checkout|confirm|delete|destroy|disable|download|edit|erase|login|logout|order|pay|purchase|remove|reset|revoke|save|send|signin|signout|subscribe|submit|transfer|unsubscribe|update|upload)\b/iu;
const ASSET_EXTENSION = /\.(?:css|js|mjs|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|webp|map)$/iu;

function hash(...values: readonly string[]): string {
  return createHash("sha256").update(values.join("\u001f")).digest("hex").slice(0, 20);
}

function safeUrl(raw: string, base: string, origin: string): URL | null {
  if (!isSafeTerminalArgument(raw, 2048) || raw.includes("\\")) return null;
  let url: URL;
  try { url = new URL(raw, base); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin
    || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.href.includes("?")) return null;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (path.includes("\\") || path.includes("//") || path.includes("%")
    || RISKY_PART.test(path) || /\.(?:pdf|zip|exe|csv|json|mp4|webm)$/iu.test(path)) return null;
  // Hash routes are allowed, but only for non-action path segments and without
  // encoded query strings, credentials, separators or JavaScript expressions.
  let fragment: string;
  try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { return null; }
  if (fragment.length > 160 || [...fragment].some((character) => character.charCodeAt(0) === 0 || "?\\<>".includes(character)) || fragment.includes("//")
    || RISKY_PART.test(fragment) || fragment.includes("%")) return null;
  return url;
}

function limits(request: SpaJourneyRequest): SpaJourneyResult["budgets"] {
  const bounded = (value: number | undefined, fallback: number, max: number, key: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${key} must be an integer 1..${String(max)}.`);
    return value;
  };
  return {
    maxStates: bounded(request.maxStates, 12, SPA_JOURNEY_LIMITS.maxStates, "maxStates"),
    maxActions: bounded(request.maxActions, 80, SPA_JOURNEY_LIMITS.maxActions, "maxActions"),
    maxDepth: bounded(request.maxDepth, 4, SPA_JOURNEY_LIMITS.maxDepth, "maxDepth"),
    maxDurationMs: bounded(request.maxDurationMs, 45_000, SPA_JOURNEY_LIMITS.maxDurationMs, "maxDurationMs"),
  };
}

/** Browser-side inspection does not mutate the page or export human-readable labels. */
async function liveSnapshot(page: Page): Promise<LiveSnapshot> {
  return await page.evaluate(({ domLimit, candidateLimit }) => {
    // page.evaluate runs in Chromium, not Node: keep this allowlist local to
    // the browser function rather than closing over a module-level regex.
    const riskyButtonLabel = /\b(?:activate|add|approve|archive|buy|cancel|checkout|confirm|create|delete|destroy|disable|download|edit|enable|erase|login|logout|order|pay|publish|purchase|remove|reset|revoke|save|send|signin|signout|subscribe|submit|transfer|unsubscribe|update|upload)\b/iu;
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      let current: Element | null = element;
      let ancestors = 0;
      while (current !== null && ancestors < 32) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0
          || current.hasAttribute("hidden") || current.hasAttribute("inert")
          || current.getAttribute("aria-hidden") === "true") return false;
        current = current.parentElement;
        ancestors += 1;
      }
      // Extremely deep styling ancestry was not inspected: fail closed.
      return current === null;
    };
    const short = (value: string | null): string => (value ?? "").trim().replace(/\s+/gu, " ").slice(0, 120);
    // Counters, clocks and generated numeric ids otherwise create a different
    // state on every snapshot and spuriously invalidate replay checkpoints.
    const semanticText = (value: string | null): string => short(value)
      .replace(/\b[0-9a-f]{8,}\b/giu, "#")
      .replace(/\b\d+(?:[.,:/-]\d+)*\b/gu, "#");
    const headings = [...document.querySelectorAll("main h1,main h2")].slice(0, 12)
      .filter(visible).map((node) => [node.tagName, short(node.getAttribute("id")), short(node.textContent)].join("|"));
    const mains = document.querySelectorAll("main");
    const soleMain = mains.length === 1 ? mains.item(0) : null;
    const visibleMainCount = soleMain !== null && visible(soleMain) ? 1 : 0;
    let mainContentInspectionComplete = visibleMainCount === 1;
    let visibleContentLength = 0;
    if (visibleMainCount === 1 && soleMain !== null) {
      // Exclude the persistent route shell (headings, navigation, buttons and
      // forms). Keep only bounded presence metadata, never application text.
      const walker = document.createTreeWalker(soleMain, NodeFilter.SHOW_TEXT);
      let textNodesInspected = 0;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (++textNodesInspected > 256) { mainContentInspectionComplete = false; break; }
        const parent = node.parentElement;
        if (parent === null || parent.closest("h1,h2,h3,h4,h5,h6,nav,header,footer,aside,button,a,form,label,script,style,template,noscript,svg,[role=navigation],[role=menu],[role=toolbar]")) continue;
        if (!visible(parent)) continue;
        visibleContentLength = Math.min(256, visibleContentLength
          + (node.textContent ?? "").slice(0, 257).trim().length);
      }
    }
    const semanticBusy = [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],main .loading,main [data-loading="true"]')]
      .slice(0, 100).some(visible);
    const allNodes = document.querySelectorAll("a[href],button");
    const nodes = [...allNodes].slice(0, domLimit);
    const candidates: LiveCandidate[] = [];
    const signals: string[] = [];
    let skipped = 0;
    let candidatesTruncated = allNodes.length > domLimit;
    for (const node of [...document.querySelectorAll("h1,h2,h3,[role=dialog],[role=menu],[role=navigation],[aria-expanded]")].slice(0, 120)) {
      // DOM text is used only transiently to derive a SHA-256 fingerprint in Node;
      // it is never included in the persistent graph or terminal messages.
      const expanded = node.getAttribute("aria-expanded") ?? "";
      signals.push([node.tagName, node.getAttribute("role"), semanticText(node.getAttribute("id")), expanded,
        visible(node) ? "visible" : "hidden", short(node.textContent).slice(0, 50)].join("|"));
    }
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined || !visible(node)) continue;
      if (node.closest("form,[contenteditable='true']") || node.hasAttribute("download")
        || node.getAttribute("target") === "_blank" || node.hasAttribute("disabled")
        || node.getAttribute("aria-disabled") === "true" || node.hasAttribute("form")) { skipped += 1; continue; }
      const label = short(node.getAttribute("aria-label") ?? node.textContent).toLowerCase();
      const role = node.getAttribute("role") ?? "";
      const control = node.getAttribute("aria-controls");
      const expandedValue = node.getAttribute("aria-expanded");
      const target = control === null ? null : document.getElementById(control);
      const controlledVisible = target === null ? null : visible(target);
      let kind: LiveCandidate["kind"] | null = null;
      if (node.tagName.toLowerCase() === "a" && node.hasAttribute("href")
        && (role === "" || role === "link" || (role === "menuitem" && node.closest("[role=menu]") !== null))) kind = "anchor";
      else if (node.tagName.toLowerCase() === "button" && (node as HTMLButtonElement).type === "button") {
        const modal = node.closest("[role='dialog'][aria-modal='true'],[role='alertdialog'][aria-modal='true']");
        const menu = /^(open|close|show|hide|toggle) (the )?(menu|navigation)$/u.test(label)
          || label === "menu" || label === "navigation";
        const dialog = /^(open|close|show|hide|toggle) (the )?(dialog|modal)$/u.test(label);
        const dismiss = /^(close|dismiss)( (the )?(dialog|modal))?$/u.test(label);
        // Named controls like "More options" or "Sections" are legitimate
        // nested menus when their ARIA relationship proves their semantics.
        const menuRelationship = node.getAttribute("aria-haspopup") === "menu"
          && target?.matches("nav,[role=navigation],[role=menu]") === true;
        if (!riskyButtonLabel.test(label) && (menu || menuRelationship) && target !== null && expandedValue !== null
          && (target.matches("nav,[role=navigation],[role=menu]") || node.getAttribute("aria-haspopup") === "menu")) {
          kind = "menu-toggle";
        } else if (!riskyButtonLabel.test(label) && dialog && target !== null && expandedValue !== "true"
          && target.matches("[role=dialog],[role=alertdialog]") && node.getAttribute("aria-haspopup") === "dialog") {
          kind = "dialog-toggle";
        } else if (dismiss && modal !== null && !/\b(billing|buy|checkout|order|payment|purchase|subscribe)\b/iu.test(modal.textContent ?? "")) {
          kind = "dialog-toggle";
        } else if (!riskyButtonLabel.test(label) && label.length > 0
          && expandedValue === "false" && target !== null
          && target.matches("section,[role=region]") && !target.contains(node)
          && node.getAttribute("aria-haspopup") === null) {
          // A collapsed ARIA disclosure is a bounded, reversible content
          // control, not an arbitrary command button. Retain this observation
          // even when the panel is already visible: aria-expanded=false with
          // a visible panel is exactly the mismatch we need to report.
          kind = "disclosure-toggle";
        }
      }
      if (kind === null) { skipped += 1; continue; }
      if (candidates.length >= candidateLimit) { candidatesTruncated = true; continue; }
      const href = node.tagName.toLowerCase() === "a" ? node.getAttribute("href") ?? "" : "";
      candidates.push({
        index, kind, href, label,
        marker: [node.tagName.toLowerCase(), role, label, semanticText(node.getAttribute("id")),
          // Exclude framework-generated CSS classes; they are non-semantic
          // implementation details and can churn on each render.
          href, semanticText(control), expandedValue ?? ""].join("|"),
        expanded: expandedValue === null ? null : expandedValue === "true",
        controlledVisible,
      });
    }
    return { url: location.href, documentToken: String(Reflect.get(window, "__tvdoctorSpaDocumentToken") ?? "missing"),
      semanticBusy, visibleMainCount, substantiveMainContent: visibleContentLength >= 64,
      emptyMainContent: visibleContentLength === 0, mainContentInspectionComplete,
      historyTransitions: Number(Reflect.get(window, "__tvdoctorSpaHistoryTransitions") ?? 0), signals, headings,
      historyPushes: Number(Reflect.get(window, "__tvdoctorSpaHistoryPushes") ?? 0),
      candidates, candidatesTruncated,
      unsafeCandidatesSkipped: skipped };
  }, { domLimit: SPA_JOURNEY_LIMITS.maxDomElements, candidateLimit: SPA_JOURNEY_LIMITS.maxCandidatesPerState });
}

function observe(raw: LiveSnapshot, origin: string, volatileSignals: ReadonlySet<number> = new Set()): Observation | null {
  const url = safeUrl(raw.url, raw.url, origin);
  if (url === null) return null;
  const candidates = raw.candidates.filter((candidate) => {
    if (candidate.kind !== "anchor") return true;
    if (RISKY_WORD.test(candidate.label)) return false;
    return safeUrl(candidate.href, raw.url, origin) !== null;
  }).map((candidate) => ({ ...candidate, fingerprint: hash(candidate.kind, candidate.marker) }));
  const routeIdentity = hash("route", url.pathname, url.hash);
  return {
    id: hash("state", url.pathname, url.hash,
      ...(raw.semanticBusy ? ["visible-semantic-busy"] : []),
      ...raw.signals.map((signal, index) => volatileSignals.has(index)
        ? `${signal.slice(0, signal.lastIndexOf("|"))}|[volatile-counter]` : signal),
      // An aria-controls target may be a plain <nav> or <div> without role;
      // its visibility is meaningful state even when aria-expanded is broken.
      ...raw.candidates.map((candidate) => `${candidate.marker}|controlled:${String(candidate.controlledVisible)}`)),
    routeIdentity,
    semanticBusy: raw.semanticBusy,
    documentToken: raw.documentToken,
    historyTransitions: raw.historyTransitions,
    historyPushes: raw.historyPushes,
    headingFingerprint: hash("headings", ...raw.headings),
    headingCount: raw.headings.length,
    visibleMainCount: raw.visibleMainCount,
    substantiveMainContent: raw.substantiveMainContent,
    emptyMainContent: raw.emptyMainContent,
    mainContentInspectionComplete: raw.mainContentInspectionComplete,
    candidates,
    candidatesTruncated: raw.candidatesTruncated,
    unsafeCandidatesSkipped: raw.unsafeCandidatesSkipped + raw.candidates.length - candidates.length,
  };
}

async function installNetworkGuard(context: BrowserContext, origin: string, launchUrl: string,
  stats: { blocked: number; bootstrapLoading: boolean; allowDynamicResources: boolean },
  scannerAbortedRequests: WeakSet<Request>): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const parsed = safeUrl(url, url, origin);
    // A safe-looking .png/.js URL can still mutate server state via GET.
    // Allow document/asset fetches only while the scanner itself explicitly
    // navigates to its authorised root for launch or checkpoint restoration.
    // Action-triggered and delayed post-load assets fail closed.
    const navigation = stats.bootstrapLoading && request.isNavigationRequest()
      && parsed?.href.split("#")[0] === launchUrl.split("#")[0];
    const staticAsset = stats.bootstrapLoading && parsed !== null
      && ["stylesheet", "script", "image", "font", "media"].includes(request.resourceType())
      && ASSET_EXTENSION.test(parsed.pathname);
    // Deliberately NOT the default. This is a narrow additional user-granted
    // permission for HTML-fragment fetches and imported JavaScript modules: a GET can
    // still mutate a server, so require explicit authorisation and keep the
    // original root, method, path and no-redirect checks in force.
    const dynamicResource = stats.allowDynamicResources && parsed !== null
      && ((request.resourceType() === "fetch" && /\.html$/iu.test(parsed.pathname))
        || (request.resourceType() === "script" && /\.(?:js|mjs)$/iu.test(parsed.pathname)));
    if (request.method() !== "GET" || parsed === null || (!navigation && !staticAsset && !dynamicResource)) {
      stats.blocked += 1;
      scannerAbortedRequests.add(request);
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    try {
      // Never follow even same-origin redirects: a redirect can hide an unsafe
      // destination or cause GET side effects before browser policy runs again.
      const response = await route.fetch({ maxRedirects: 0, timeout: 4_000 });
      if (response.status() >= 300 && response.status() < 400) {
        stats.blocked += 1;
        scannerAbortedRequests.add(request);
        await route.abort("blockedbyclient");
        return;
      }
      await route.fulfill({ response });
    } catch {
      // Route-fetch failures and scanner timeouts cannot be attributed to the
      // site's runtime as independently witnessed request failures.
      scannerAbortedRequests.add(request);
      await route.abort("failed").catch(() => undefined);
    }
  });
  // Stop client-side History API navigation to unsafe paths before the SPA
  // can commit location. This also rejects unsafe hash paths via pushState.
  await context.addInitScript(({ permittedOrigin, blockedSegments }) => {
    Object.defineProperty(window, "__tvdoctorSpaDocumentToken", { value: Math.random().toString(36), configurable: false });
    let transitions = 0;
    let pushes = 0;
    let lastUrl = location.href;
    const recordHistoryChange = () => {
      // A single native hash navigation may fire both popstate and hashchange.
      // Distinct push/replace/back locations must still count separately.
      if (location.href !== lastUrl) { transitions += 1; lastUrl = location.href; }
    };
    Object.defineProperty(window, "__tvdoctorSpaHistoryTransitions", { get: () => transitions, configurable: false });
    Object.defineProperty(window, "__tvdoctorSpaHistoryPushes", { get: () => pushes, configurable: false });
    window.addEventListener("popstate", recordHistoryChange);
    window.addEventListener("hashchange", recordHistoryChange);
    // Disable form submission and auxiliary tabs even if a site mislabels a
    // menu button. POSTs are independently blocked by the network guard.
    window.open = () => null;
    window.addEventListener("submit", (event) => event.preventDefault(), true);
    const unsafe = (value: unknown): boolean => {
      try {
        const url = new URL(value === undefined || value === null ? location.href : String(value), location.href);
        const path = decodeURIComponent(url.pathname).toLowerCase();
        const fragment = decodeURIComponent(url.hash.slice(1)).toLowerCase();
        return url.origin !== permittedOrigin || url.search.length > 0 || url.username.length > 0
          || url.password.length > 0 || path.includes("%") || fragment.includes("%")
          || path.includes("//") || fragment.includes("//") || fragment.includes("?")
          || blockedSegments.some((term) => new RegExp(`(?:^|[/_.,;=-])${term}(?=$|[/_.,;=-])`, "iu").test(path)
            || new RegExp(`(?:^|[/_.,;=-])${term}(?=$|[/_.,;=-])`, "iu").test(fragment));
      } catch { return true; }
    };
    const push = history.pushState.bind(history);
    const replace = history.replaceState.bind(history);
    history.pushState = (state, title, url) => {
      if (unsafe(url)) return;
      const previous = location.href;
      push(state, title, url);
      recordHistoryChange();
      if (location.href !== previous) pushes += 1;
    };
    history.replaceState = (state, title, url) => { if (unsafe(url)) return; replace(state, title, url); recordHistoryChange(); };
  }, { permittedOrigin: origin, blockedSegments: ["api", "account", "auth", "billing", "buy", "checkout", "delete", "logout", "order", "payment", "pay", "post", "purchase", "remove", "reset", "revoke", "save", "send", "signin", "signout", "subscribe", "submit", "transfer", "unsubscribe", "update", "upload", "user", "users", "write"] });
}

/** Bounded journey explorer. No arbitrary buttons, forms or submitted requests. */
export async function runSpaJourneyScan(
  request: SpaJourneyRequest,
  dependencies: SpaJourneyDependencies = {},
): Promise<SpaJourneyResult> {
  const budgets = limits(request);
  if (!isSafeTerminalArgument(request.target, 2048) || request.outputDirectory.trim() === ""
    || request.outputDirectory.length > 1024) throw new TypeError("SPA scan requires a bounded URL and output directory.");
  const root = safeUrl(request.target, request.target, (() => {
    try { return new URL(request.target).origin; } catch { return ""; }
  })());
  if (root === null) throw new TypeError("SPA scan root must be a safe HTTP(S) URL without credentials or action query/path.");
  const origin = root.origin;
  const outputDirectory = resolve(request.outputDirectory);
  const deadline = Date.now() + budgets.maxDurationMs;
  const states: SpaJourneyState[] = [];
  const edges: SpaJourneyEdge[] = [];
  const deferred: SpaJourneyDeferred[] = [];
  const issues: SpaJourneyIssue[] = [];
  const termination = new Set<string>();
  const queue: QueueItem[] = [];
  const seen = new Set<string>();
  const volatileSignals = new Set<number>();
  const stats = { blocked: 0, bootstrapLoading: false, allowDynamicResources: request.allowDynamicResources === true };
  const scannerAbortedRequests = new WeakSet<Request>();
  const outsideActionRequests = new WeakSet<Request>();
  const httpErrorRequests = new WeakSet<Request>();
  let activeRuntimeCapture: RuntimeCapture | null = null;
  let actionsUsed = 0;
  let replayActions = 0;
  let backProbes = 0;
  let interruptedBackProbes = 0;
  let driftCount = 0;
  let skipped = 0;
  let truncated = false;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const captureRuntime = (event: CapturedRuntimeEvent): void => {
    const capture = activeRuntimeCapture;
    if (capture === null) return;
    if (capture.events.length >= MAX_RUNTIME_EVENTS_PER_ACTION) {
      capture.truncated = true;
      return;
    }
    capture.events.push(event);
  };
  const recordRuntimeIssues = (captured: RuntimeCapture, before: Observation, after: Observation,
    edgeIndex: number, targetFingerprint: string): void => {
    if (captured.truncated) recordDeferred(before.id, targetFingerprint, "runtime-event-limit");
    const unique = new Set<string>();
    for (const event of captured.events) {
      const rule = runtimeRule(event.kind);
      // Hash derivation intentionally uses no URL, console message, stack, or
      // resource path. MCP can reproduce it from the saved public graph.
      const eventFingerprint = hash("runtime-event", rule, before.id, after.id, String(edgeIndex),
        event.kind, String(event.httpStatus ?? ""), event.resourceType ?? "");
      if (unique.has(eventFingerprint)) continue;
      unique.add(eventFingerprint);
      if (issues.filter((issue) => issue.runtimeEvent !== undefined).length >= MAX_RUNTIME_ISSUES) {
        recordDeferred(before.id, targetFingerprint, "runtime-event-limit");
        break;
      }
      issues.push({
        rule, stateId: after.id, edgeIndex, confidence: "heuristic", reviewRequired: true,
        evidence: "observed-runtime-event-after-action",
        runtimeEvent: {
          kind: event.kind, sourceStateId: before.id, observedStateId: after.id, eventFingerprint,
          ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }),
          ...(event.resourceType === undefined ? {} : { resourceType: event.resourceType }),
        },
      });
    }
  };

  const recordDeferred = (from: string, targetFingerprint: string | null, reason: SpaJourneyDeferred["reason"]): void => {
    termination.add(reason);
    if (deferred.length < SPA_JOURNEY_LIMITS.maxDeferred) deferred.push({ from, targetFingerprint, reason });
    else termination.add("deferred-truncated");
  };
  const deferQueuedState = (item: QueueItem, reason: SpaJourneyDeferred["reason"]): void => {
    if (item.candidates.length === 0) { recordDeferred(item.id, null, reason); return; }
    for (const candidate of item.candidates) {
      recordDeferred(item.id, candidate.fingerprint, reason);
      if (edges.length < SPA_JOURNEY_LIMITS.maxGraphEdges) edges.push({ from: item.id, to: null,
        kind: candidate.kind, targetFingerprint: candidate.fingerprint, targetIndex: candidate.index,
        status: "deferred", reason, replay: item.replay });
    }
  };
  const isCancelled = (): boolean => request.signal?.aborted === true;
  const timedOut = (): boolean => Date.now() >= deadline;
  const budgetAvailable = (): boolean => actionsUsed < budgets.maxActions && !timedOut() && !isCancelled();
  const stopReason = (): SpaJourneyDeferred["reason"] => isCancelled() ? "cancelled"
    : timedOut() ? "deadline-exceeded" : "max-actions";
  const snapshot = async (): Promise<Observation | null> => {
    if (page === null || isCancelled() || timedOut()) return null;
    const raw = await liveSnapshot(page);
    const current = observe(raw, origin, volatileSignals);
    if (current !== null) { skipped += current.unsafeCandidatesSkipped; truncated ||= current.candidatesTruncated; }
    return current;
  };
  const stableRootRaw = async (rootPage: Page): Promise<LiveSnapshot | null> => {
    // Loading shells are not root checkpoints. Wait for two repeatable
    // post-load observations without explicit busy signals, within a hard cap.
    // This also applies during root restoration: capture and restore must
    // start from the same ready state or every edge may become replay drift.
    const until = Math.min(deadline, Date.now() + 1_200);
    let previous = await liveSnapshot(rootPage).catch(() => null);
    if (previous === null) return null;
    let quiet = 0;
    while (!isCancelled() && !timedOut() && Date.now() < until && quiet < 2) {
      await rootPage.waitForTimeout(Math.min(95, Math.max(1, until - Date.now())));
      const next = await liveSnapshot(rootPage).catch(() => null);
      if (next === null) return null;
      const same = next.url === previous.url && next.documentToken === previous.documentToken
        && next.historyTransitions === previous.historyTransitions
        && JSON.stringify(next.signals) === JSON.stringify(previous.signals)
        && JSON.stringify(next.headings) === JSON.stringify(previous.headings);
      quiet = same && !next.semanticBusy ? quiet + 1 : 0;
      previous = next;
    }
    if (previous.semanticBusy) termination.add("startup-unsettled");
    return previous;
  };
  type Settlement = { readonly status: "settled"; readonly observation: Observation }
    | { readonly status: "unsettled" }
    | { readonly status: "unavailable" };
  const settledSnapshot = async (before: Observation): Promise<Settlement> => {
    if (page === null) return { status: "unavailable" };
    // Any first sample can be the pre-microtask shell. Require a *witnessed*
    // semantic change followed by two unchanged samples, not an arbitrary
    // final sample from a fixed 320ms window. This is not proof that a site
    // will never update again, only bounded evidence of quiescence.
    const until = Math.min(deadline, Date.now() + 1_050);
    let previous = await snapshot();
    if (previous === null) return { status: "unavailable" };
    let witnessedChange = false;
    let quietSamples = 0;
    while (!isCancelled() && !timedOut() && Date.now() < until) {
      const changed = previous.id !== before.id || previous.documentToken !== before.documentToken
        || previous.historyTransitions !== before.historyTransitions;
      witnessedChange ||= changed;
      // An explicitly busy region is only an intermediate shell, even if its
      // heading and ARIA tree stay identical through multiple short samples.
      if (witnessedChange && quietSamples >= 2 && !previous.semanticBusy) {
        return { status: "settled", observation: previous };
      }
      await page.waitForTimeout(Math.min(90, Math.max(1, until - Date.now())));
      const fresh = await snapshot();
      if (fresh === null) return { status: "unavailable" };
      quietSamples = fresh.id === previous.id && fresh.documentToken === previous.documentToken
        && fresh.historyTransitions === previous.historyTransitions ? quietSamples + 1 : 0;
      previous = fresh;
    }
    return { status: "unsettled" };
  };
  const confirmMissingRouteContent = async (
    before: Observation, after: Observation, targetFingerprint: string, blockedBeforeClick: number,
  ): Promise<boolean> => {
    // A successful pushState and a blank shell are observations, not a proof
    // of a bug. Wait beyond the ordinary settling window for slow hydration.
    // Any ambiguity leaves the route unclassified; no defect is certified.
    if (page === null || before.documentToken !== after.documentToken
      || before.routeIdentity === after.routeIdentity
      || after.historyTransitions - before.historyTransitions !== 1
      || after.historyPushes - before.historyPushes !== 1
      || before.headingCount === 0 || before.headingFingerprint !== after.headingFingerprint
      || before.visibleMainCount !== 1 || after.visibleMainCount !== 1
      || !before.mainContentInspectionComplete || !after.mainContentInspectionComplete
      || !before.substantiveMainContent || !after.emptyMainContent
      || before.semanticBusy || after.semanticBusy || stats.blocked !== blockedBeforeClick) return false;

    const activePage = page;
    const until = Date.now() + EMPTY_ROUTE_GRACE_MS;
    if (until + 150 >= deadline || !budgetAvailable()) {
      recordDeferred(before.id, targetFingerprint, "post-action-unsettled");
      return false;
    }
    while (Date.now() < until) {
      await activePage.waitForTimeout(Math.min(250, Math.max(1, until - Date.now())));
      const sample = await snapshot().catch(() => null);
      if (sample === null || stats.blocked !== blockedBeforeClick || sample.id !== after.id
        || sample.routeIdentity !== after.routeIdentity
        || sample.documentToken !== before.documentToken
        || sample.historyTransitions !== after.historyTransitions
        || sample.historyPushes !== after.historyPushes
        || sample.visibleMainCount !== 1 || !sample.mainContentInspectionComplete
        || sample.semanticBusy) {
        recordDeferred(before.id, targetFingerprint, "post-action-unsettled");
        return false;
      }
      // Even a short intentional empty-state message, such as "No results",
      // rules out the very narrow blank-main heuristic.
      if (!sample.emptyMainContent) return false;
    }
    return true;
  };
  const click = async (candidate: Observation["candidates"][number]): Promise<boolean> => {
    if (page === null || !budgetAvailable()) return false;
    actionsUsed += 1;
    let element: Awaited<ReturnType<ReturnType<Page["locator"]>["elementHandle"]>> | null = null;
    try {
      const timeout = Math.max(100, Math.min(2_000, deadline - Date.now()));
      // Bind to the actual DOM node, not a locator that can silently retarget
      // a different (potentially destructive) nth element after a rerender.
      element = await page.locator("a[href],button").nth(candidate.index).elementHandle({ timeout });
      if (element === null) return false;
      const fresh = observe(await liveSnapshot(page), origin, volatileSignals);
      const stillEligible = fresh?.candidates.some((value) => value.index === candidate.index
        && value.kind === candidate.kind && value.fingerprint === candidate.fingerprint) === true;
      const sameNode = await element.evaluate((node, index) => node.isConnected
        && document.querySelectorAll("a[href],button")[index] === node, candidate.index);
      if (!stillEligible || !sameNode) return false;
      await element.click({ timeout, noWaitAfter: true });
      await page.waitForTimeout(50);
      return true;
    } catch { return false; }
    finally { await element?.dispose().catch(() => undefined); }
  };
  const restore = async (path: readonly SpaJourneyStep[], expected: string): Promise<Observation | null> => {
    if (page === null || !budgetAvailable()) return null;
    try {
      stats.bootstrapLoading = true;
      let response: Awaited<ReturnType<Page["goto"]>>;
      try {
        response = await page.goto(root.href, { waitUntil: "domcontentloaded",
          timeout: Math.max(100, Math.min(4_000, deadline - Date.now())) });
      } finally { stats.bootstrapLoading = false; }
      if (response === null || response.status() >= 400) return null;
      const ready = await stableRootRaw(page);
      let current = ready === null ? null : observe(ready, origin, volatileSignals);
      if (current === null || current.id !== states[0]?.id) return null;
      for (const step of path) {
        const candidate = current.candidates.find((item) => item.index === step.index
          && item.kind === step.kind && item.fingerprint === step.targetFingerprint);
        if (candidate === undefined || !budgetAvailable()) return null;
        if (!await click(candidate)) return null;
        replayActions += 1;
        const previousDocument = current.documentToken;
        const previousTransitions = current.historyTransitions;
        const settlement = await settledSnapshot(current);
        if (settlement.status !== "settled") {
          if (settlement.status === "unsettled" && !isCancelled() && !timedOut()) termination.add("post-action-unsettled");
          return null;
        }
        current = settlement.observation;
        if (current.documentToken !== previousDocument
          || current.historyTransitions - previousTransitions > 1 || current.id !== step.checkpoint) return null;
      }
      return current.id === expected ? current : null;
    } catch { return null; }
  };
  const probeBrowserBack = async (before: Observation, forward: Observation, edgeIndex: number,
    targetFingerprint: string): Promise<void> => {
    if (page === null || before.routeIdentity === forward.routeIdentity || before.headingCount === 0
      || before.headingCount !== forward.headingCount
      || before.headingFingerprint === forward.headingFingerprint
      || forward.historyTransitions - before.historyTransitions !== 1
      || forward.historyPushes - before.historyPushes !== 1
      || forward.documentToken !== before.documentToken) return;
    // An observed forward edge does not imply its Back edge was visited.
    // Preserve every known but unprobed eligible Back path in the deferred
    // frontier instead of accidentally reporting a completed history audit.
    if (backProbes >= 2) { recordDeferred(forward.id, targetFingerprint, "history-back-limit"); return; }
    if (!budgetAvailable()) { recordDeferred(forward.id, targetFingerprint, stopReason()); return; }
    if (await page.evaluate(() => history.length).catch(() => 0) < 2) return;
    backProbes += 1;
    actionsUsed += 1; // Browser Back is a real traversal action, not free replay.
    let returned: Observation | null = null;
    let complete = false;
    try {
      // Use the browser automation channel, not page.evaluate(history.back).
      // An application can monkeypatch window.history.back and fake a URL
      // transition; only Chromium's own history traversal is Back evidence.
      await page.goBack({ waitUntil: "commit",
        timeout: Math.max(100, Math.min(1_500, deadline - Date.now())) });
      for (let attempt = 0; attempt < 8 && !timedOut() && !isCancelled(); attempt += 1) {
        await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
        const current = await snapshot();
        if (current === null || current.documentToken !== forward.documentToken
          || current.historyTransitions - forward.historyTransitions > 1) break;
        if (current.routeIdentity === before.routeIdentity
          && current.historyTransitions - forward.historyTransitions === 1) { returned = current; break; }
      }
      if (returned !== null) {
        // The URL returning is not sufficient. After the bounded async settle,
        // compare independently observed headings twice; do not infer Back
        // from the forward replay or persist any route/heading text.
        await page.waitForTimeout(Math.min(550, Math.max(1, deadline - Date.now())));
        const first = await snapshot();
        await page.waitForTimeout(Math.min(550, Math.max(1, deadline - Date.now())));
        const second = await snapshot();
        const valid = (sample: Observation | null): sample is Observation => sample !== null
          && sample.documentToken === forward.documentToken
          && sample.routeIdentity === before.routeIdentity
          && sample.historyTransitions - forward.historyTransitions === 1
          && sample.headingCount === before.headingCount;
        if (valid(first) && valid(second) && !timedOut() && !isCancelled()) {
          complete = true;
          if (first.headingFingerprint === forward.headingFingerprint
            && second.headingFingerprint === forward.headingFingerprint) {
            let screenshot: NonNullable<NonNullable<SpaJourneyIssue["historyBack"]>["screenshot"]> | undefined;
            let temporaryScreenshot: string | null = null;
            // Capture *after* the witnessed Back transition. A forward-click
            // screenshot is not evidence of history restoration. Failure to
            // capture never manufactures a video, replay or image descriptor.
            try {
              if (request.screenshots !== false && page !== null && !timedOut() && !isCancelled()
                && deadline - Date.now() >= 250) {
                const bytes = await page.screenshot({ type: "png", fullPage: false,
                  animations: "allow", timeout: Math.min(1_500, deadline - Date.now()) });
                if (bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024 * 1024) {
                  const current = await snapshot();
                  if (current !== null && current.routeIdentity === before.routeIdentity
                    && current.documentToken === forward.documentToken
                    && current.headingFingerprint === second.headingFingerprint
                    && current.historyTransitions - forward.historyTransitions === 1) {
                    const name = `back-edge-${String(edgeIndex + 1).padStart(3, "0")}.png`;
                    const directory = resolve(outputDirectory, "evidence");
                    await mkdir(directory, { recursive: true });
                    const file = resolve(directory, name);
                    temporaryScreenshot = `${file}.tmp`;
                    await writeFile(temporaryScreenshot, bytes);
                    await rename(temporaryScreenshot, file);
                    temporaryScreenshot = null;
                    screenshot = { path: `evidence/${name}`,
                      sha256: createHash("sha256").update(bytes).digest("hex"),
                      byteLength: bytes.byteLength };
                  }
                }
              }
            } catch { /* Capture is optional. The observed Back result remains heuristic only. */ }
            if (temporaryScreenshot !== null) await unlink(temporaryScreenshot).catch(() => undefined);
            issues.push({ rule: "spa.history-back-stale-view", stateId: forward.id,
              edgeIndex, confidence: "heuristic", reviewRequired: true,
              evidence: "observed-dom-after-history-back",
              historyBack: { expectedStateId: before.id, observedStateId: second.id,
                expectedRouteIdentity: before.routeIdentity, observedRouteIdentity: second.routeIdentity,
                beforeHeadingFingerprint: before.headingFingerprint,
                forwardHeadingFingerprint: forward.headingFingerprint,
                returnedHeadingFingerprint: second.headingFingerprint, historyDelta: 1, settledSamples: 2,
                ...(screenshot === undefined ? {} : { screenshot }) } });
          }
        }
      }
    } catch { /* Incomplete Back evidence must never be promoted to a finding. */ }
    if (!complete) recordDeferred(forward.id, targetFingerprint, isCancelled() ? "cancelled"
      : timedOut() ? "deadline-exceeded" : "observation-failed");
  };
  /** Separate, at-most-once test for a *rapid* pair of Chromium Back actions.
   * A saved forward replay establishes the two safe pushes but NEVER stands in
   * for either browser Back event or their own returned-route observations. */
  const probeInterruptedBrowserBack = async (
    parentPath: readonly SpaJourneyStep[], middle: Observation, final: Observation,
    edgeIndex: number, targetFingerprint: string,
  ): Promise<void> => {
    if (page === null || parentPath.length === 0 || middle.routeIdentity === final.routeIdentity
      || middle.headingFingerprint === final.headingFingerprint
      || final.historyTransitions - middle.historyTransitions !== 1
      || final.historyPushes - middle.historyPushes !== 1
      || final.documentToken !== middle.documentToken) return;
    const ancestorPath = parentPath.slice(0, -1);
    const ancestorId = ancestorPath.at(-1)?.checkpoint ?? states[0]?.id;
    const parentEdge = edges.find((edge) => edge.status === "observed"
      && edge.to === middle.id && edge.replay.length === parentPath.length
      && edge.replay.every((step, index) => step.checkpoint === parentPath[index]?.checkpoint
        && step.kind === parentPath[index]?.kind && step.targetFingerprint === parentPath[index]?.targetFingerprint));
    if (ancestorId === undefined || parentEdge?.from !== ancestorId || parentEdge.kind !== "anchor") return;
    if (interruptedBackProbes >= 1 || !budgetAvailable() || budgets.maxActions - actionsUsed < 4) {
      recordDeferred(final.id, targetFingerprint, interruptedBackProbes >= 1
        ? "history-back-interruption-unchecked" : stopReason());
      return;
    }
    const ancestor = await restore(ancestorPath, ancestorId);
    if (ancestor === null || ancestor.headingCount === 0 || ancestor.headingCount !== middle.headingCount
      || ancestor.routeIdentity === middle.routeIdentity || ancestor.headingFingerprint === middle.headingFingerprint) {
      recordDeferred(final.id, targetFingerprint, "history-back-interruption-unchecked"); return;
    }
    // This restore is a checked *setup* only. Both Back actions are separately
    // issued through Chromium, never synthesized by replaying earlier clicks.
    const lastStep = edges[edgeIndex]?.replay.at(-1);
    if (lastStep === undefined) {
      recordDeferred(final.id, targetFingerprint, "history-back-interruption-unchecked"); return;
    }
    const setup = await restore([...parentPath, lastStep], final.id);
    if (setup === null || setup.headingFingerprint !== final.headingFingerprint
      || setup.documentToken === "missing" || !budgetAvailable()
      || budgets.maxActions - actionsUsed < 2) {
      recordDeferred(final.id, targetFingerprint, "history-back-interruption-unchecked"); return;
    }
    interruptedBackProbes += 1;
    let validPair = false;
    try {
      actionsUsed += 1;
      await page.goBack({ waitUntil: "commit", timeout: Math.max(100, Math.min(1_500, deadline - Date.now())) });
      // Page.url() is Playwright's browser-owned navigation state, not an
      // application-overridable history.back() or DOM render checkpoint.
      // Avoid waiting for the intermediate page's slow render: doing so could
      // miss the actual interrupted-restore race we are attempting to test.
      const middleUrl = safeUrl(page.url(), page.url(), origin);
      const middleRouteConfirmed = middleUrl !== null
        && hash("route", middleUrl.pathname, middleUrl.hash) === middle.routeIdentity;
      if (middleRouteConfirmed && budgetAvailable()) {
        actionsUsed += 1;
        await page.goBack({ waitUntil: "commit", timeout: Math.max(100, Math.min(1_500, deadline - Date.now())) });
        let returned: Observation | null = null;
        for (let attempt = 0; attempt < 8 && !timedOut() && !isCancelled(); attempt += 1) {
          await page.waitForTimeout(75);
          const current = await snapshot();
          if (current?.documentToken !== setup.documentToken
            || (current !== null && current.historyTransitions - setup.historyTransitions > 2)) break;
          if (current !== null && current.routeIdentity === ancestor.routeIdentity
            && current.historyTransitions - setup.historyTransitions === 2) { returned = current; break; }
        }
        if (returned !== null) {
          // A delayed intermediate popstate callback may paint after ~680ms.
          // Require TWO matching *post-settle* samples, rather than comparing
          // a premature 550ms sample with the eventual stable stale view.
          await page.waitForTimeout(Math.min(800, Math.max(1, deadline - Date.now())));
          const observed1 = await snapshot();
          await page.waitForTimeout(Math.min(300, Math.max(1, deadline - Date.now())));
          const observed2 = await snapshot();
          const stable = (value: Observation | null): value is Observation => value !== null
            && value.documentToken === setup.documentToken && value.routeIdentity === ancestor.routeIdentity
            && value.headingCount === ancestor.headingCount
            && value.historyTransitions - setup.historyTransitions === 2;
          if (stable(observed1) && stable(observed2) && !timedOut() && !isCancelled()) {
            validPair = true;
            if (observed1.headingFingerprint === middle.headingFingerprint
              && observed2.headingFingerprint === middle.headingFingerprint) {
              let screenshot: NonNullable<NonNullable<SpaJourneyIssue["historyBack"]>["screenshot"]> | undefined;
              let temp: string | null = null;
              try {
                if (request.screenshots !== false && page !== null && deadline - Date.now() >= 250) {
                  const bytes = await page.screenshot({ type: "png", fullPage: false,
                    animations: "allow", timeout: Math.min(1_500, deadline - Date.now()) });
                  const confirm = await snapshot();
                  if (bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024 * 1024 && stable(confirm)
                    && confirm.headingFingerprint === observed2.headingFingerprint) {
                    const name = `back-interrupted-edge-${String(edgeIndex + 1).padStart(3, "0")}.png`;
                    const dir = resolve(outputDirectory, "evidence");
                    await mkdir(dir, { recursive: true });
                    const file = resolve(dir, name);
                    temp = `${file}.tmp`;
                    await writeFile(temp, bytes);
                    await rename(temp, file);
                    temp = null;
                    screenshot = { path: `evidence/${name}`, byteLength: bytes.byteLength,
                      sha256: createHash("sha256").update(bytes).digest("hex") };
                  }
                }
              } catch { /* Evidence capture optional; observed Back proof remains conservative. */ }
              if (temp !== null) await unlink(temp).catch(() => undefined);
              issues.push({ rule: "spa.history-back-interrupted-stale-view", stateId: final.id,
                edgeIndex, confidence: "heuristic", reviewRequired: true,
                evidence: "observed-dom-after-interrupted-history-back",
                historyBack: { expectedStateId: ancestor.id, observedStateId: observed2.id,
                  expectedRouteIdentity: ancestor.routeIdentity, observedRouteIdentity: observed2.routeIdentity,
                  beforeHeadingFingerprint: ancestor.headingFingerprint,
                  forwardHeadingFingerprint: middle.headingFingerprint,
                  returnedHeadingFingerprint: observed2.headingFingerprint, historyDelta: 2,
                  settledSamples: 2, interruptedBack: { intermediateStateId: middle.id,
                    intermediateRouteIdentity: middle.routeIdentity, finalForwardStateId: final.id },
                  ...(screenshot === undefined ? {} : { screenshot }) } });
            }
          }
        }
      }
    } catch { /* Never upgrade missing true browser Back proof into a finding. */ }
    if (!validPair) recordDeferred(final.id, targetFingerprint, isCancelled() ? "cancelled"
      : timedOut() ? "deadline-exceeded" : "history-back-interruption-unchecked");
  };

  try {
    if (isCancelled()) termination.add("cancelled");
    else {
      try { browser = await (dependencies.launchBrowser?.() ?? chromium.launch({ headless: true, handleSIGINT: false })); }
      catch { termination.add("browser-unavailable"); }
    }
    if (browser !== null && !isCancelled()) {
      context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      await installNetworkGuard(context, origin, root.href, stats, scannerAbortedRequests);
      const activeContext = context;
      page = await activeContext.newPage();
      page.on("request", (networkRequest) => {
        // A slow startup/replay resource must not be assigned to whichever
        // unrelated action happened to be in progress when it completed.
        if (activeRuntimeCapture === null) outsideActionRequests.add(networkRequest);
      });
      page.on("pageerror", () => captureRuntime({ kind: "page-error" }));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        // These console messages are generated by Chromium for blocked
        // network resources, not independently emitted application errors.
        if (/Failed to load resource|ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED|net::ERR_ABORTED/iu.test(message.text())) return;
        captureRuntime({ kind: "console-error" });
      });
      page.on("response", (response) => {
        const status = response.status();
        if (status !== 404 && status !== 410 && (status < 500 || status > 599)) return;
        const networkRequest = response.request();
        httpErrorRequests.add(networkRequest);
        if (scannerAbortedRequests.has(networkRequest) || outsideActionRequests.has(networkRequest)) return;
        captureRuntime({ kind: "http-response", httpStatus: status,
          resourceType: resourceType(networkRequest.resourceType()) });
      });
      page.on("requestfailed", (failedRequest) => {
        if (scannerAbortedRequests.has(failedRequest)
          || outsideActionRequests.has(failedRequest) || httpErrorRequests.has(failedRequest)) return;
        captureRuntime({ kind: "request-failed", resourceType: resourceType(failedRequest.resourceType()) });
      });
      context.on("page", (newPage) => { if (newPage !== page) void newPage.close().catch(() => undefined); });
      page.setDefaultNavigationTimeout(4_000);
      stats.bootstrapLoading = true;
      let response: Awaited<ReturnType<Page["goto"]>>;
      try {
        response = await page.goto(root.href, { waitUntil: "domcontentloaded",
          timeout: Math.min(4_000, budgets.maxDurationMs) }).catch(() => null);
      } finally { stats.bootstrapLoading = false; }
      const initial = response === null || response.status() >= 400 ? null : await (async () => {
        try {
          const before = await liveSnapshot(page as Page);
          const after = await stableRootRaw(page as Page);
          if (after === null) return null;
          const volatileCounter = (signal: string): string => signal
            .replace(/\b[0-9a-f]{8,}\b/giu, "#")
            .replace(/\b\d+(?:[.,:/-]\d+)*\b/gu, "#");
          for (let index = 0; index < Math.min(before.signals.length, after.signals.length); index += 1) {
            const first = before.signals[index];
            const second = after.signals[index];
            if (first !== undefined && second !== undefined && first !== second
              && volatileCounter(first) === volatileCounter(second)) volatileSignals.add(index);
          }
          return observe(after, origin, volatileSignals);
        } catch { return null; }
      })();
      if (initial === null) termination.add("root-unavailable");
      else {
        seen.add(initial.id);
        states.push({ id: initial.id, routeIdentity: initial.routeIdentity, depth: 0, replay: [], candidatesObserved: initial.candidates.length });
        queue.push({ id: initial.id, replay: [], depth: 0, candidates: initial.candidates });
      }

      while (queue.length > 0 && !isCancelled() && !timedOut()) {
        const item = queue.shift();
        if (item === undefined) break;
        const arrived = await restore(item.replay, item.id);
        if (arrived === null) {
          if (budgetAvailable()) driftCount += 1;
          deferQueuedState(item, budgetAvailable() ? "replay-drift" : stopReason());
          continue;
        }
        if (arrived.candidatesTruncated) recordDeferred(item.id, null, "candidate-limit");
        // Inspect the same strictly allowlisted frontier, but attempt proven
        // reversible controls and same-document hashes before anchors that can
        // trigger blocked full-document navigation. The latter can consume the
        // deadline under browser contention; never silently discard them.
        const priority = (value: Observation["candidates"][number]): number => value.kind !== "anchor" ? 0
          : value.href.startsWith("#") ? 1 : 2;
        const candidates = [...arrived.candidates].sort((a, b) => priority(a) - priority(b) || a.index - b.index);
        for (let candidatePosition = 0; candidatePosition < candidates.length; candidatePosition += 1) {
          const candidate = candidates[candidatePosition];
          if (candidate === undefined) break;
          const deferRemaining = (reason: SpaJourneyDeferred["reason"]): void => {
            // A budget or unexpected failure must never silently drop the
            // remaining *known* frontier on this state. The artifact cap is
            // visible through deferred-truncated rather than implied coverage.
            for (const remaining of candidates.slice(candidatePosition)) {
              recordDeferred(item.id, remaining.fingerprint, reason);
              if (edges.length < SPA_JOURNEY_LIMITS.maxGraphEdges) edges.push({
                from: item.id, to: null, kind: remaining.kind, targetFingerprint: remaining.fingerprint,
                targetIndex: remaining.index, status: "deferred", reason, replay: item.replay,
              });
            }
          };
          if (edges.length >= SPA_JOURNEY_LIMITS.maxGraphEdges) {
            deferRemaining("graph-limit");
            break;
          }
          const defer = (reason: SpaJourneyDeferred["reason"]): void => {
            recordDeferred(item.id, candidate.fingerprint, reason);
            edges.push({ from: item.id, to: null, kind: candidate.kind, targetFingerprint: candidate.fingerprint,
              targetIndex: candidate.index, status: "deferred", reason, replay: item.replay });
          };
          if (item.depth >= budgets.maxDepth) { defer("max-depth"); continue; }
          if (!budgetAvailable()) { deferRemaining(stopReason()); break; }
          const before = await restore(item.replay, item.id);
          if (before === null) {
            if (!budgetAvailable()) { deferRemaining(stopReason()); break; }
            driftCount += 1;
            defer("replay-drift"); continue;
          }
          const currentTarget = before.candidates.find((value) => value.index === candidate.index && value.kind === candidate.kind
            && value.fingerprint === candidate.fingerprint);
          if (currentTarget === undefined) { driftCount += 1; defer("replay-drift"); continue; }
          const captured: RuntimeCapture = { events: [], truncated: false };
          const blockedBeforeClick = stats.blocked;
          activeRuntimeCapture = captured;
          const clicked = await click(currentTarget);
          if (!clicked) {
            activeRuntimeCapture = null;
            recordDeferred(item.id, candidate.fingerprint, "blocked-action");
            edges.push({ from: item.id, to: null, kind: candidate.kind, targetFingerprint: candidate.fingerprint,
              targetIndex: candidate.index, status: "blocked", reason: "blocked-action", replay: item.replay });
            continue;
          }
          const settlement = await settledSnapshot(before).catch(() => ({ status: "unavailable" as const }));
          activeRuntimeCapture = null;
          if (settlement.status === "unsettled") {
            defer(isCancelled() ? "cancelled" : timedOut() ? "deadline-exceeded" : "post-action-unsettled");
            continue;
          }
          if (settlement.status === "unavailable") {
            // A blocked full-document anchor can detach its frame before the
            // browser produces a post-action observation. A verified root
            // restore lets us continue with a later reversible menu rather
            // than declaring its entire known sibling frontier lost.
            if (budgetAvailable() && await restore(item.replay, item.id) !== null) {
              recordDeferred(item.id, candidate.fingerprint, "blocked-action");
              edges.push({ from: item.id, to: null, kind: candidate.kind, targetFingerprint: candidate.fingerprint,
                targetIndex: candidate.index, status: "blocked", reason: "post-action-unavailable", replay: item.replay });
              continue;
            }
            deferRemaining(isCancelled() ? "cancelled" : timedOut() ? "deadline-exceeded" : "observation-failed");
            break;
          }
          const after = settlement.observation;
          if (after.documentToken !== before.documentToken) {
            recordDeferred(item.id, candidate.fingerprint, "blocked-action");
            edges.push({ from: item.id, to: null, kind: candidate.kind, targetFingerprint: candidate.fingerprint,
              targetIndex: candidate.index, status: "blocked", reason: "full-document-navigation", replay: item.replay });
            continue;
          }
          if (after.historyTransitions - before.historyTransitions > 1) {
            recordDeferred(item.id, candidate.fingerprint, "observation-failed");
            edges.push({ from: item.id, to: null, kind: candidate.kind, targetFingerprint: candidate.fingerprint,
              targetIndex: candidate.index, status: "deferred", reason: "multi-step-history", replay: item.replay });
            continue;
          }
          const nextStep: SpaJourneyStep = {
            index: candidate.index, kind: candidate.kind, targetFingerprint: candidate.fingerprint, checkpoint: after.id,
          };
          const fullPath = [...item.replay, nextStep];
          if (!seen.has(after.id) && states.length >= budgets.maxStates) { defer("max-states"); continue; }
          const edgeIndex = edges.length;
          edges.push({ from: item.id, to: after.id, kind: candidate.kind, targetFingerprint: candidate.fingerprint,
            targetIndex: candidate.index, status: "observed", reason: null, replay: fullPath });
          recordRuntimeIssues(captured, before, after, edgeIndex, candidate.fingerprint);
          if (candidate.kind === "anchor" && await confirmMissingRouteContent(
            before, after, candidate.fingerprint, blockedBeforeClick)) {
            issues.push({ rule: "spa.route-content-missing", stateId: after.id, edgeIndex,
              confidence: "heuristic", reviewRequired: true, evidence: "observed-dom-after-action" });
          }
          if (candidate.expanded !== null && candidate.controlledVisible !== null) {
            const next = after.candidates.find((value) => value.index === candidate.index && value.kind === candidate.kind);
            if (next !== undefined && next.expanded !== null && next.controlledVisible !== null
              && next.expanded !== next.controlledVisible) {
              issues.push({ rule: "spa.expanded-panel-mismatch", stateId: after.id, edgeIndex,
                confidence: "heuristic", reviewRequired: true, evidence: "observed-dom-after-action" });
            }
          }
          if (!seen.has(after.id)) {
            seen.add(after.id);
            states.push({ id: after.id, routeIdentity: after.routeIdentity, depth: item.depth + 1,
              replay: fullPath, candidatesObserved: after.candidates.length });
            queue.push({ id: after.id, replay: fullPath, depth: item.depth + 1, candidates: after.candidates });
          }
          if (candidate.kind === "anchor") {
            await probeBrowserBack(before, after, edgeIndex, candidate.fingerprint);
            await probeInterruptedBrowserBack(item.replay, before, after, edgeIndex, candidate.fingerprint);
          }
        }
      }
    }
    if (request.verifyIssues === true && browser !== null && issues.length > 0 && !isCancelled()) {
      // A recorded path is not a reproduction. Only an explicit user opt-in
      // permits extra interactions, each in a fresh isolated Chromium context.
      // Keep genuine browser-Back findings outside forward-action reproduction:
      // a history traversal cannot be inferred from replayed click checkpoints.
      await context?.close().catch(() => undefined);
      context = null;
      page = null;
      for (let position = 0; position < Math.min(4, issues.length); position += 1) {
        const issue = issues[position];
        if (issue === undefined) continue;
        const edge = edges[issue.edgeIndex];
        const started = Date.now();
        const previousActions = actionsUsed;
        let replayStepsVerified = 0;
        let reproductionStatus: NonNullable<SpaJourneyIssue["verification"]>["status"] = "deferred";
        let reason: NonNullable<SpaJourneyIssue["verification"]>["reason"] = "unsupported-rule";
        const repeatable = issue.rule === "spa.expanded-panel-mismatch"
          || issue.rule === "spa.runtime-page-error" || issue.rule === "spa.runtime-console-error";
        if (repeatable && edge?.status === "observed" && edge.to === issue.stateId) {
          reason = "budget-exhausted";
          if (budgetAvailable()) {
            try {
              context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
              await installNetworkGuard(context, origin, root.href, stats, scannerAbortedRequests);
              page = await context.newPage();
              page.setDefaultNavigationTimeout(4_000);
              const verificationPage = page;
              verificationPage.on("pageerror", () => captureRuntime({ kind: "page-error" }));
              verificationPage.on("console", (message) => {
                if (message.type() !== "error") return;
                if (/Failed to load resource|ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED|net::ERR_ABORTED/iu.test(message.text())) return;
                captureRuntime({ kind: "console-error" });
              });
              const before = await restore(edge.replay.slice(0, -1), edge.from);
              if (before === null) reason = "source-checkpoint-drift";
              else {
                replayStepsVerified = edge.replay.length - 1;
                const candidate = before.candidates.find((item) => item.index === edge.targetIndex
                  && item.kind === edge.kind && item.fingerprint === edge.targetFingerprint);
                if (candidate === undefined) reason = "source-checkpoint-drift";
                else {
                  const captured: RuntimeCapture = { events: [], truncated: false };
                  activeRuntimeCapture = captured;
                  const clicked = await click(candidate);
                  const settlement = clicked ? await settledSnapshot(before) : { status: "unavailable" as const };
                  activeRuntimeCapture = null;
                  if (!clicked) reason = "action-blocked";
                  else if (settlement.status !== "settled") reason = "post-action-unsettled";
                  else {
                    const after = settlement.observation;
                    const checkpointsMatch = after.id === edge.to && after.documentToken === before.documentToken;
                    const observed = issue.rule === "spa.expanded-panel-mismatch"
                      ? (() => {
                        const next = after.candidates.find((item) => item.index === candidate.index
                          && item.kind === candidate.kind);
                        return next !== undefined && next.expanded !== null
                          && next.controlledVisible !== null && next.expanded !== next.controlledVisible;
                      })()
                      : captured.events.some((event) => runtimeRule(event.kind) === issue.rule);
                    reproductionStatus = checkpointsMatch && observed ? "reobserved" : "not-reobserved";
                    reason = checkpointsMatch && observed ? "matched-observation" : "observation-differed";
                    replayStepsVerified += checkpointsMatch ? 1 : 0;
                  }
                }
              }
            } catch {
              reason = "source-checkpoint-drift";
            } finally {
              activeRuntimeCapture = null;
              await context?.close().catch(() => undefined);
              context = null;
              page = null;
            }
          }
        }
        const durationMs = Math.min(120_000, Math.max(0, Date.now() - started));
        const verification: NonNullable<SpaJourneyIssue["verification"]> = {
          status: reproductionStatus, reason,
          fingerprint: hash("fresh-verification", hash("route", root.pathname, root.hash), issue.rule,
            edge?.from ?? "", edge?.to ?? "", String(issue.edgeIndex), reproductionStatus, reason,
            String(replayStepsVerified)),
          replayStepsVerified, actions: actionsUsed - previousActions, durationMs,
        };
        issues[position] = { ...issue, verification };
        if (verification.status === "deferred") termination.add("verification-incomplete");
      }
    }
  } catch {
    termination.add(isCancelled() ? "cancelled" : "observation-failed");
  } finally {
    for (const item of queue) deferQueuedState(item, stopReason());
    if (isCancelled()) termination.add("cancelled");
    if (timedOut()) termination.add("deadline-exceeded");
    if (stats.blocked > 0) termination.add("unsafe-network-request-blocked");
    await context?.close().catch(() => { termination.add("browser-close-failed"); });
    await browser?.close().catch(() => { termination.add("browser-close-failed"); });
  }
  const status: SpaJourneyResult["status"] = isCancelled() ? "cancelled" : states.length === 0 ? "failed"
    : termination.size > 0 ? "partial" : "completed";
  const result: SpaJourneyResult = {
    schemaVersion: "tvdoctor.spa-journey/v1", status,
    targetIdentity: hash("route", root.pathname, root.hash),
    states, edges, deferred, issues, terminationReasons: [...termination],
    actionsUsed, replayActions, driftCount, unsafeRequestsBlocked: stats.blocked,
    unsafeCandidatesSkipped: skipped, candidatesTruncated: truncated, budgets,
  };
  await mkdir(outputDirectory, { recursive: true });
  const path = resolve(outputDirectory, "spa-journey.json");
  await writeFile(`${path}.tmp`, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(`${path}.tmp`, path);
  return result;
}

export const runSpaJourney = runSpaJourneyScan;
