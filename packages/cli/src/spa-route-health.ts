import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page, type Request } from "playwright";

/**
 * Independent, authorized PUBLIC SPA route witness. This is not based on the
 * disappearance of a SPA heuristic issue. The original must be a directly
 * observed, exact same-document History transition with a blank destination.
 * The independently authored expected main SHA is the repaired-state oracle.
 * Neither a successful standalone verification nor an absent finding is a QA
 * acceptance result; the caller owns a separate fresh QA regression gate.
 */
const ORIGINAL_VERSION = "tvdoctor.spa-route-health-original/v1" as const;
const CAPTURE_VERSION = "tvdoctor.spa-route-health-capture/v1" as const;
const VERIFY_VERSION = "tvdoctor.spa-route-health-verification/v1" as const;
const SHA = /^[0-9a-f]{64}$/u;
const PATH = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;
const RISKY_PATH = /(?:^|\/)(?:api|auth|login|logout|signin|signout|checkout|cart|buy|purchase|pay|payment|subscribe|delete|remove|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order)(?:\/|$)/iu;
const MAX_ORIGINAL_BYTES = 4096;
const MAX_MAIN_LENGTH = 50_000;
const HYDRATION_WINDOW_MS = 2_200;
const STABLE_INTERVAL_MS = 180;

export interface SpaRouteHealthConfig {
  /** A canonical HTTP(S) origin, no credentials, path, query or fragment. */
  readonly baseUrl: string;
  /** Exact GET document route that the fresh browser opens. */
  readonly sourcePath: string;
  /** Distinct, canonical same-origin client History destination. */
  readonly destinationPath: string;
  /** Independently authored unique accessible link name on source route. */
  readonly linkName: string;
  /** Independently authored unique visible heading inside repaired <main>. */
  readonly heading: string;
  /** SHA-256 of independently authored expected healthy visible MAIN text. */
  readonly expectedMainTextSha256: string;
}

export interface SpaRouteHealthDocument {
  readonly requestUrl: string;
  readonly responseUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly method: string;
  readonly mainFrameDocument: boolean;
  readonly redirectCount: number;
  readonly navigationCount: number;
  readonly html: boolean;
}

/** Transient data only. None of the observed content hashes/URLs are saved. */
export interface SpaRouteHealthObservation {
  readonly finalUrl: string;
  readonly documentToken: string;
  readonly navigationCount: number;
  readonly historyTransitions: number;
  readonly historyPushes: number;
  readonly historyReplaces: number;
  readonly historyPops: number;
  readonly blockedRequests: number;
  readonly unexpectedPages: number;
  readonly mainCount: number;
  readonly mainVisible: boolean;
  readonly mainIdentity: number;
  readonly mainTextLength: number;
  readonly mainTextSha256: string | null;
  /** Count of non-shell visible MAIN text chars; capped at 256. */
  readonly contentCharacters: number;
  readonly contentInspectedCompletely: boolean;
  readonly busy: boolean;
  readonly authOrErrorShell: boolean;
  readonly intentionalEmptyState: boolean;
  readonly headingCount: number;
  readonly headingInMainCount: number;
  readonly headingVisible: boolean;
  readonly linkCount: number;
  readonly linkSafe: boolean;
}

export interface SpaRouteHealthBrowser {
  navigateSource(url: string): Promise<SpaRouteHealthDocument>;
  observe(input: { readonly destinationUrl: string; readonly linkName: string;
    readonly heading: string }): Promise<SpaRouteHealthObservation>;
  /** Must activate exactly the inspected unique safe link, not a fresh selector. */
  activateLink(): Promise<boolean>;
  pause(milliseconds: number): Promise<void>;
  close(): Promise<void>;
}

export type SpaRouteHealthBrowserFactory = () => Promise<SpaRouteHealthBrowser>;

export interface SpaRouteHealthCaptureOptions {
  readonly authorized: boolean;
  readonly route: SpaRouteHealthConfig;
  readonly outputRoot: string;
  /** Test injection. Production uses isolated, guarded Chromium. */
  readonly createBrowser?: SpaRouteHealthBrowserFactory;
}

export interface SpaRouteHealthCaptureResult {
  readonly schemaVersion: typeof CAPTURE_VERSION;
  readonly classification: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  /** Private file location; callers must not publish this path. */
  readonly originalPath: string | null;
  readonly originalSha256: string | null;
  readonly reason: string | null;
}

export interface SpaRouteHealthVerifyOptions {
  readonly authorized: boolean;
  readonly route: SpaRouteHealthConfig;
  readonly originalPath: string;
  readonly expectedOriginalSha256: string;
  readonly outputRoot: string;
  readonly createBrowser?: SpaRouteHealthBrowserFactory;
}

export interface SpaRouteHealthVerifyResult {
  readonly schemaVersion: typeof VERIFY_VERSION;
  readonly classification: "ROUTE_CONTENT_RESTORED" | "REPRODUCED" | "INCONCLUSIVE";
  readonly originalSha256: string | null;
  /** A separate fresh QA regression scan is REQUIRED before acceptance/PASS. */
  readonly regressionChecked: false;
  readonly reason: string | null;
}

interface CanonicalRoute {
  readonly sourceUrl: string;
  readonly destinationUrl: string;
  readonly configSha256: string;
  readonly sourceRouteSha256: string;
  readonly destinationRouteSha256: string;
  readonly linkNameSha256: string;
  readonly headingSha256: string;
  readonly expectedMainTextSha256: string;
}

interface OriginalWitness {
  readonly schemaVersion: typeof ORIGINAL_VERSION;
  readonly browserAuthority: "isolated-chromium-source-get-and-history-push";
  readonly nonce: string;
  readonly configSha256: string;
  readonly sourceRouteSha256: string;
  readonly destinationRouteSha256: string;
  readonly linkNameSha256: string;
  readonly headingSha256: string;
  readonly expectedMainTextSha256: string;
  readonly sourceDocumentStatus: 200;
  readonly sourceDocumentNavigations: 1;
  readonly sourceSubstantiveMainObserved: true;
  readonly destinationBlankMainObserved: true;
  readonly sameDocument: true;
  readonly exactHistoryPushes: 1;
  readonly noRedirectsOrBlockedRequests: true;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const hashExpectedSpaMainText = (text: string): string =>
  sha256(text.normalize("NFKC").replace(/\s+/gu, " ").trim());

function canonical(input: SpaRouteHealthConfig): CanonicalRoute {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join("|") !== [
      "baseUrl", "sourcePath", "destinationPath", "linkName", "heading", "expectedMainTextSha256",
    ].sort().join("|")
    || typeof input.baseUrl !== "string" || input.baseUrl.length > 2048
    || typeof input.sourcePath !== "string" || typeof input.destinationPath !== "string"
    || input.sourcePath.length > 512 || input.destinationPath.length > 512
    || !PATH.test(input.sourcePath) || !PATH.test(input.destinationPath)
    || input.sourcePath.includes("..") || input.destinationPath.includes("..")
    || RISKY_PATH.test(input.sourcePath) || RISKY_PATH.test(input.destinationPath)
    || input.sourcePath === input.destinationPath
    || typeof input.linkName !== "string" || typeof input.heading !== "string"
    || ![input.linkName, input.heading].every((value) => value.length > 0 && value.length <= 128
      && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value))
    || typeof input.expectedMainTextSha256 !== "string"
    || !SHA.test(input.expectedMainTextSha256)) throw new Error("invalid-spa-route-config");
  const base = new URL(input.baseUrl);
  if (!["http:", "https:"].includes(base.protocol)
    || base.username !== "" || base.password !== ""
    || base.search !== "" || base.hash !== "" || base.pathname !== "/"
    || base.href !== `${base.origin}/`
    || (input.baseUrl !== base.origin && input.baseUrl !== base.href)) throw new Error("invalid-spa-origin");
  const sourceUrl = new URL(input.sourcePath, base).href;
  const destinationUrl = new URL(input.destinationPath, base).href;
  if (new URL(sourceUrl).pathname !== input.sourcePath || new URL(destinationUrl).pathname !== input.destinationPath) {
    throw new Error("noncanonical-spa-path");
  }
  return {
    sourceUrl, destinationUrl,
    configSha256: sha256(JSON.stringify(["spa-config/v1", base.origin, input.sourcePath,
      input.destinationPath, input.linkName, input.heading, input.expectedMainTextSha256])),
    sourceRouteSha256: sha256(JSON.stringify(["spa-source/v1", base.origin, input.sourcePath])),
    destinationRouteSha256: sha256(JSON.stringify(["spa-destination/v1", base.origin, input.destinationPath])),
    linkNameSha256: sha256(JSON.stringify(["spa-link/v1", input.linkName])),
    headingSha256: sha256(JSON.stringify(["spa-heading/v1", input.heading])),
    expectedMainTextSha256: input.expectedMainTextSha256,
  };
}

function validDocument(document: SpaRouteHealthDocument, sourceUrl: string): boolean {
  return document !== null && typeof document === "object"
    && document.requestUrl === sourceUrl && document.responseUrl === sourceUrl
    && document.finalUrl === sourceUrl && document.status === 200
    && document.method === "GET" && document.mainFrameDocument === true
    && document.redirectCount === 0 && document.navigationCount === 1 && document.html === true;
}

function validObservation(value: SpaRouteHealthObservation): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || typeof value.finalUrl !== "string" || typeof value.documentToken !== "string"
    || !/^[a-z0-9]{1,64}$/iu.test(value.documentToken)
    || typeof value.mainVisible !== "boolean" || typeof value.busy !== "boolean"
    || typeof value.authOrErrorShell !== "boolean" || typeof value.linkSafe !== "boolean"
    || typeof value.intentionalEmptyState !== "boolean"
    || typeof value.contentInspectedCompletely !== "boolean"
    || !(value.mainTextSha256 === null || SHA.test(value.mainTextSha256))) return false;
  for (const number of [
    value.navigationCount, value.historyTransitions, value.historyPushes, value.historyReplaces,
    value.historyPops, value.blockedRequests, value.unexpectedPages, value.mainCount,
    value.mainIdentity, value.mainTextLength, value.contentCharacters,
    value.headingCount, value.headingInMainCount, value.linkCount,
  ]) if (!Number.isSafeInteger(number) || number < 0 || number > MAX_MAIN_LENGTH) return false;
  return value.contentCharacters <= 256 && value.mainTextLength <= MAX_MAIN_LENGTH
    && value.headingInMainCount <= value.headingCount
    && (!value.mainVisible || value.mainCount === 1)
    && (value.mainCount !== 1 || value.mainIdentity > 0);
}

function isSource(value: SpaRouteHealthObservation, route: CanonicalRoute): boolean {
  return validObservation(value) && value.finalUrl === route.sourceUrl
    && value.documentToken.length > 0 && value.navigationCount === 1
    && value.historyTransitions === 0 && value.historyPushes === 0
    && value.historyReplaces === 0 && value.historyPops === 0
    && value.blockedRequests === 0 && value.unexpectedPages === 0
    && value.mainCount === 1 && value.mainVisible && value.mainIdentity > 0
    && value.contentInspectedCompletely && value.contentCharacters >= 64
    && !value.busy && !value.authOrErrorShell
    && value.linkCount === 1 && value.linkSafe;
}

function isDestination(value: SpaRouteHealthObservation, before: SpaRouteHealthObservation,
  route: CanonicalRoute): boolean {
  return validObservation(value)
    && value.finalUrl === route.destinationUrl
    && value.documentToken === before.documentToken
    && value.navigationCount === 1 && value.historyTransitions === 1
    && value.historyPushes === 1 && value.historyReplaces === 0 && value.historyPops === 0
    && value.blockedRequests === 0 && value.unexpectedPages === 0
    && value.mainCount === 1 && value.mainVisible && value.mainIdentity > 0
    && value.contentInspectedCompletely && !value.busy && !value.authOrErrorShell
    && !value.intentionalEmptyState;
}

function sourceStillStable(first: SpaRouteHealthObservation, second: SpaRouteHealthObservation): boolean {
  return first.finalUrl === second.finalUrl && first.documentToken === second.documentToken
    && first.mainIdentity === second.mainIdentity && first.mainTextSha256 === second.mainTextSha256
    && first.contentCharacters === second.contentCharacters && first.linkCount === second.linkCount
    && second.linkSafe;
}

const browserInput = (route: SpaRouteHealthConfig, canonicalRoute: CanonicalRoute) => ({
  destinationUrl: canonicalRoute.destinationUrl, linkName: route.linkName, heading: route.heading,
});

async function sourceProof(browser: SpaRouteHealthBrowser, route: SpaRouteHealthConfig,
  value: CanonicalRoute): Promise<SpaRouteHealthObservation | null> {
  const input = browserInput(route, value);
  for (let index = 0; index < 10; index++) {
    const first = await browser.observe(input);
    if (isSource(first, value)) {
      await browser.pause(STABLE_INTERVAL_MS);
      const second = await browser.observe(input);
      if (isSource(second, value) && sourceStillStable(first, second)) return second;
    }
    if (index < 9) await browser.pause(STABLE_INTERVAL_MS);
  }
  return null;
}

async function transition(browser: SpaRouteHealthBrowser, before: SpaRouteHealthObservation,
  route: SpaRouteHealthConfig, value: CanonicalRoute): Promise<SpaRouteHealthObservation | null> {
  if (!await browser.activateLink()) return null;
  const input = browserInput(route, value);
  for (let index = 0; index < 7; index++) {
    const observed = await browser.observe(input);
    if (isDestination(observed, before, value)) return observed;
    // We allow a bounded delay before the first History push, but no
    // intermediate route, extra hop or changed main document.
    if (!validObservation(observed) || observed.documentToken !== before.documentToken
      || observed.navigationCount !== 1 || observed.blockedRequests !== 0
      || observed.unexpectedPages !== 0 || observed.historyTransitions > 1
      || observed.historyPushes > 1 || observed.historyReplaces > 0 || observed.historyPops > 0
      || (observed.finalUrl !== value.sourceUrl && observed.finalUrl !== value.destinationUrl)
      || (observed.finalUrl === value.destinationUrl && !isDestination(observed, before, value))) return null;
    if (index < 6) await browser.pause(STABLE_INTERVAL_MS);
  }
  return null;
}

async function blankProof(browser: SpaRouteHealthBrowser, first: SpaRouteHealthObservation,
  before: SpaRouteHealthObservation, route: SpaRouteHealthConfig,
  value: CanonicalRoute): Promise<boolean> {
  if (!isDestination(first, before, value) || first.contentCharacters !== 0) return false;
  const input = browserInput(route, value);
  // All nine further independent samples must remain completely blank across
  // >2 seconds. A delayed rendering, busy state or drift invalidates the proof.
  for (let index = 0; index < Math.ceil(HYDRATION_WINDOW_MS / 250); index++) {
    await browser.pause(250);
    const next = await browser.observe(input);
    if (!isDestination(next, before, value) || next.mainIdentity !== first.mainIdentity
      || next.contentCharacters !== 0) return false;
  }
  return true;
}

function healthy(value: SpaRouteHealthObservation, before: SpaRouteHealthObservation,
  route: SpaRouteHealthConfig, expected: CanonicalRoute): boolean {
  return isDestination(value, before, expected)
    && value.headingCount === 1 && value.headingInMainCount === 1
    && value.headingVisible && value.mainTextLength >= Math.max(64, route.heading.length + 24)
    && value.mainTextSha256 === expected.expectedMainTextSha256;
}

async function positiveProof(browser: SpaRouteHealthBrowser,
  before: SpaRouteHealthObservation, route: SpaRouteHealthConfig,
  value: CanonicalRoute): Promise<boolean> {
  const input = browserInput(route, value);
  for (let index = 0; index < Math.ceil(HYDRATION_WINDOW_MS / STABLE_INTERVAL_MS); index++) {
    const first = await browser.observe(input);
    if (!isDestination(first, before, value)) return false;
    if (healthy(first, before, route, value)) {
      let stable = true;
      // Ensure the authored MAIN fingerprint persists across 630ms and that
      // hydration does not replace the accepted main node.
      for (let nextIndex = 0; nextIndex < 3; nextIndex++) {
        await browser.pause(210);
        const next = await browser.observe(input);
        if (!healthy(next, before, route, value)
          || next.mainIdentity !== first.mainIdentity
          || next.mainTextLength !== first.mainTextLength) { stable = false; break; }
      }
      if (stable) return true;
      return false;
    }
    if (index + 1 < Math.ceil(HYDRATION_WINDOW_MS / STABLE_INTERVAL_MS)) {
      await browser.pause(STABLE_INTERVAL_MS);
    }
  }
  return false;
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()
    || await realpath(absolute) !== absolute) throw new Error("unsafe-directory");
  return absolute;
}

async function freshDirectory(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096
    || path.includes("\0")) throw new Error("invalid-output");
  const absolute = resolve(path);
  await canonicalDirectory(dirname(absolute));
  await mkdir(absolute, { mode: 0o700 });
  return canonicalDirectory(absolute);
}

async function writeOnce(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function readPinnedOriginal(path: string, expectedSha: string): Promise<Buffer> {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096
    || path.includes("\0") || basename(path) !== "original.json" || !SHA.test(expectedSha)) {
    throw new Error("invalid-original-reference");
  }
  const absolute = resolve(path);
  await canonicalDirectory(dirname(absolute));
  const first = await lstat(absolute);
  if (!first.isFile() || first.isSymbolicLink() || first.size < 1
    || first.size > MAX_ORIGINAL_BYTES || await realpath(absolute) !== absolute) {
    throw new Error("unsafe-original");
  }
  const handle = await open(absolute, "r");
  let data: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== first.ino || opened.size !== first.size) {
      throw new Error("changed-original");
    }
    data = Buffer.alloc(first.size);
    for (let offset = 0; offset < data.length;) {
      const part = await handle.read(data, offset, data.length - offset, offset);
      if (part.bytesRead <= 0) throw new Error("incomplete-original");
      offset += part.bytesRead;
    }
  } finally { await handle.close(); }
  const last = await lstat(absolute);
  if (!last.isFile() || last.isSymbolicLink() || first.ino !== last.ino
    || first.mtimeMs !== last.mtimeMs || first.size !== last.size
    || sha256(data) !== expectedSha) throw new Error("original-tampered");
  return data;
}

function distinctRoots(output: string, original: string): boolean {
  const a = resolve(output), b = resolve(dirname(original));
  const within = (parent: string, child: string): boolean => {
    const rest = relative(parent, child);
    return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
  };
  return !within(a, b) && !within(b, a);
}

function exactOriginal(raw: unknown, route: CanonicalRoute): raw is OriginalWitness {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  const keys = ["schemaVersion", "browserAuthority", "nonce", "configSha256",
    "sourceRouteSha256", "destinationRouteSha256", "linkNameSha256", "headingSha256",
    "expectedMainTextSha256", "sourceDocumentStatus", "sourceDocumentNavigations",
    "sourceSubstantiveMainObserved", "destinationBlankMainObserved", "sameDocument",
    "exactHistoryPushes", "noRedirectsOrBlockedRequests"];
  return Object.keys(value).sort().join("|") === keys.sort().join("|")
    && value["schemaVersion"] === ORIGINAL_VERSION
    && value["browserAuthority"] === "isolated-chromium-source-get-and-history-push"
    && typeof value["nonce"] === "string"
    && /^[a-f0-9-]{36}$/u.test(value["nonce"])
    && value["configSha256"] === route.configSha256
    && value["sourceRouteSha256"] === route.sourceRouteSha256
    && value["destinationRouteSha256"] === route.destinationRouteSha256
    && value["linkNameSha256"] === route.linkNameSha256
    && value["headingSha256"] === route.headingSha256
    && value["expectedMainTextSha256"] === route.expectedMainTextSha256
    && value["sourceDocumentStatus"] === 200
    && value["sourceDocumentNavigations"] === 1
    && value["sourceSubstantiveMainObserved"] === true
    && value["destinationBlankMainObserved"] === true
    && value["sameDocument"] === true
    && value["exactHistoryPushes"] === 1
    && value["noRedirectsOrBlockedRequests"] === true;
}

function captureInconclusive(reason: string): SpaRouteHealthCaptureResult {
  return { schemaVersion: CAPTURE_VERSION, classification: "INCONCLUSIVE",
    originalPath: null, originalSha256: null, reason };
}

function verification(classification: SpaRouteHealthVerifyResult["classification"],
  originalSha256: string | null, reason: string | null): SpaRouteHealthVerifyResult {
  return { schemaVersion: VERIFY_VERSION, classification,
    originalSha256, regressionChecked: false, reason };
}

/**
 * Production observer: a newly launched, cookieless Chromium context. Only the
 * exact source document GET and safe bootstrap assets may reach the server.
 * Every post-load request is blocked and invalidates the witness. The clicked
 * link can therefore only change client History state to prove this route.
 */
export async function createChromiumSpaRouteHealthBrowser(): Promise<SpaRouteHealthBrowser> {
  const browser: Browser = await chromium.launch({ headless: true, handleSIGINT: false });
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false,
      javaScriptEnabled: true });
    await context.addInitScript(() => {
      let last = location.href;
      let transitions = 0, pushes = 0, replaces = 0, pops = 0, nextId = 1;
      const identities = new WeakMap<Element, number>();
      const record = () => { if (location.href !== last) { transitions++; last = location.href; } };
      Object.defineProperty(window, "__tvdoctorSpaHealthDocumentToken",
        { value: Math.random().toString(36).slice(2) || "document", configurable: false });
      Object.defineProperty(window, "__tvdoctorSpaHealthCounters",
        { value: () => ({ transitions, pushes, replaces, pops }), configurable: false });
      Object.defineProperty(window, "__tvdoctorSpaHealthMainId", {
        value: (element: Element) => {
          let id = identities.get(element);
          if (id === undefined) { id = nextId++; identities.set(element, id); }
          return id;
        }, configurable: false,
      });
      const push = history.pushState.bind(history);
      const replace = history.replaceState.bind(history);
      history.pushState = (state, title, url) => { pushes++; push(state, title, url); record(); };
      history.replaceState = (state, title, url) => { replaces++; replace(state, title, url); record(); };
      addEventListener("popstate", () => { pops++; record(); });
      addEventListener("hashchange", record);
      // No form submissions, popups, browser-native purchases or downloads.
      window.open = () => null;
      addEventListener("submit", (event) => event.preventDefault(), true);
    });
    const activeContext = context;
    const page: Page = await activeContext.newPage();
    let bootstrap = false;
    let sourceUrl: string | null = null;
    let documentRequests = 0;
    let blockedRequests = 0;
    let unexpectedPages = 0;
    let inspectedLink: ElementHandle<SVGElement | HTMLElement> | null = null;
    let inspectedDestination: string | null = null;
    let inspectedName: string | null = null;
    page.on("request", (request) => {
      try {
        if (request.isNavigationRequest() && request.resourceType() === "document"
          && request.frame() === page.mainFrame()) documentRequests++;
      } catch { documentRequests++; }
    });
    page.on("download", () => { unexpectedPages++; });
    activeContext.on("page", (other) => {
      if (other !== page) { unexpectedPages++; void other.close().catch(() => undefined); }
    });
    await activeContext.route("**/*", async (route) => {
      const request: Request = route.request();
      const raw = request.url();
      let allowed = false;
      try {
        if (sourceUrl !== null && bootstrap && request.method() === "GET") {
          const target = new URL(sourceUrl);
          const resource = new URL(raw);
          const path = decodeURIComponent(resource.pathname);
          const safe = resource.origin === target.origin && resource.username === ""
            && resource.password === "" && resource.search === "" && resource.hash === ""
            && !path.includes("\\") && !path.includes("//") && !path.includes("%")
            && !RISKY_PATH.test(path);
          const document = request.isNavigationRequest() && request.resourceType() === "document"
            && raw === sourceUrl && documentRequests === 1;
          const bootstrapAsset = ["script", "stylesheet", "font", "image"].includes(request.resourceType())
            && /\.(?:js|mjs|css|woff|woff2|ttf|png|jpe?g|gif|svg|webp|ico)$/iu.test(path);
          allowed = safe && (document || bootstrapAsset);
        }
      } catch { /* untrusted request URLs fail closed */ }
      if (!allowed) {
        blockedRequests++;
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 4_000 });
        if (response.status() >= 300 && response.status() < 400) {
          blockedRequests++;
          await route.abort("blockedbyclient").catch(() => undefined);
        } else await route.fulfill({ response });
      } catch {
        blockedRequests++;
        await route.abort("failed").catch(() => undefined);
      }
    });
    const inspectLink = async (destinationUrl: string, linkName: string): Promise<{
      linkCount: number; linkSafe: boolean;
    }> => {
      await inspectedLink?.dispose().catch(() => undefined);
      inspectedLink = null;
      inspectedDestination = null;
      inspectedName = null;
      const locator = page.getByRole("link", { name: linkName, exact: true, includeHidden: true });
      const linkCount = await locator.count();
      if (linkCount !== 1) return { linkCount: Math.min(linkCount, MAX_MAIN_LENGTH), linkSafe: false };
      const link = await locator.elementHandle();
      if (link === null) return { linkCount, linkSafe: false };
      const valid = await link.evaluate((element, wanted) => {
        if (!(element instanceof HTMLAnchorElement) || !element.isConnected
          || element.getAttribute("role") !== null && element.getAttribute("role") !== "link"
          || element.href !== wanted || !element.hasAttribute("href")
          || element.hasAttribute("ping") || element.hasAttribute("download")
          || element.hasAttribute("target") || element.hasAttribute("disabled")
          || element.getAttribute("aria-disabled") === "true"
          || element.getAttribute("tabindex") === "-1" || element.closest("form,[contenteditable]")) return false;
        for (let current: Element | null = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("inert") || current.hasAttribute("hidden")
            || current.getAttribute("aria-hidden") === "true") return false;
          const css = getComputedStyle(current);
          if (css.display === "none" || css.visibility !== "visible"
            || Number(css.opacity) === 0 || css.pointerEvents === "none") return false;
          for (const attr of [...current.attributes]) {
            if (/^on[a-z]+$/iu.test(attr.name) || /^(?:hx-|data-(?:action|method|confirm|turbo-method|remote)|formaction)/iu.test(attr.name)) {
              return false;
            }
          }
          if (["onclick", "onmousedown", "onmouseup", "onpointerdown", "onpointerup",
            "ontouchstart", "onkeydown", "onkeypress"].some((name) =>
            typeof Reflect.get(current, name) === "function")) return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, destinationUrl).catch(() => false);
      if (valid) {
        inspectedLink = link;
        inspectedDestination = destinationUrl;
        inspectedName = linkName;
      }
      else await link.dispose().catch(() => undefined);
      return { linkCount, linkSafe: valid };
    };
    return {
      async navigateSource(url) {
        if (sourceUrl !== null) throw new Error("browser-already-navigated");
        sourceUrl = url;
        bootstrap = true;
        let response: Awaited<ReturnType<Page["goto"]>>;
        try { response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }); }
        finally { bootstrap = false; }
        if (response === null) throw new Error("source-document-response-missing");
        const request = response.request();
        let redirectCount = 0;
        for (let previous = request.redirectedFrom(); previous !== null; previous = previous.redirectedFrom()) {
          if (++redirectCount > 16) throw new Error("too-many-redirects");
        }
        let mainFrameDocument = false;
        try { mainFrameDocument = request.isNavigationRequest()
          && request.resourceType() === "document" && request.frame() === page.mainFrame(); }
        catch { /* an invalid request is rejected */ }
        return { requestUrl: request.url(), responseUrl: response.url(), finalUrl: page.url(),
          status: response.status(), method: request.method(),
          mainFrameDocument, redirectCount, navigationCount: documentRequests,
          html: /^text\/html(?:\s*;|$)/iu.test(response.headers()["content-type"] ?? "") };
      },
      async observe({ destinationUrl, linkName, heading }) {
        const main = page.locator("main");
        const mainCount = await main.count();
        const mainVisible = mainCount === 1 && await main.isVisible();
        const mainText = mainCount === 1 && mainVisible
          ? await main.evaluate((element) => (element as HTMLElement).innerText.slice(0, 50_001)) : "";
        const normalised = mainText.normalize("NFKC").replace(/\s+/gu, " ").trim();
        const details = await page.evaluate(() => {
          const visible = (element: Element): boolean => {
            if (element.getBoundingClientRect().width <= 0 || element.getBoundingClientRect().height <= 0) return false;
            let current: Element | null = element, steps = 0;
            while (current !== null && steps++ < 32) {
              const css = getComputedStyle(current);
              if (css.display === "none" || css.visibility !== "visible" || Number(css.opacity) === 0
                || current.hasAttribute("hidden") || current.hasAttribute("inert")
                || current.getAttribute("aria-hidden") === "true") return false;
              current = current.parentElement;
            }
            return current === null;
          };
          const main = document.querySelectorAll("main").length === 1 ? document.querySelector("main") : null;
          let count = 0, inspected = main !== null && visible(main);
          if (inspected && main !== null) {
            const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
            let nodes = 0;
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if (++nodes > 256) { inspected = false; break; }
              const parent = node.parentElement;
              if (parent === null || parent.closest("h1,h2,h3,h4,h5,h6,nav,header,footer,aside,button,a,form,label,script,style,template,noscript,svg,[role=navigation],[role=menu],[role=toolbar]")) continue;
              if (!visible(parent)) continue;
              count = Math.min(256, count + (node.textContent ?? "").slice(0, 257).trim().length);
            }
          }
          const busy = [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],main .loading,main [data-loading="true"]')]
            .slice(0, 100).some(visible);
          const intentionalEmptyState = main !== null && (
            [...main.querySelectorAll('[data-empty-state],[role="status"],[aria-live],.empty-state,.no-results')]
              .slice(0, 50).some(visible)
            || [...main.querySelectorAll("h1,h2,h3")].slice(0, 25).some((node) =>
              visible(node) && /^(?:no (?:results|items|records|matches)(?: found)?|nothing (?:here|found)|all caught up|empty (?:state|list))$/iu
                .test((node.textContent ?? "").trim())));
          const counters = Reflect.get(window, "__tvdoctorSpaHealthCounters") as
            (() => { transitions: number; pushes: number; replaces: number; pops: number }) | undefined;
          const identity = Reflect.get(window, "__tvdoctorSpaHealthMainId") as ((element: Element) => number) | undefined;
          return { documentToken: Reflect.get(window, "__tvdoctorSpaHealthDocumentToken") as string | undefined,
            mainIdentity: main !== null && identity !== undefined ? identity(main) : 0,
            counters: counters?.(), contentCharacters: count,
            contentInspectedCompletely: inspected, busy, intentionalEmptyState };
        });
        const namedHeading = page.getByRole("heading", { name: heading, exact: true, includeHidden: true });
        const headingCount = await namedHeading.count();
        const headingInMain = main.getByRole("heading", { name: heading, exact: true, includeHidden: true });
        const headingInMainCount = mainCount === 1 ? await headingInMain.count() : 0;
        const headingVisible = headingCount === 1 && headingInMainCount === 1
          && await namedHeading.isVisible() && await headingInMain.isVisible();
        const { linkCount, linkSafe } = await inspectLink(destinationUrl, linkName);
        const title = (await page.title()).trim();
        const firstText = await page.locator("body").evaluate((body) =>
          (body as HTMLElement).innerText.slice(0, 200).replace(/\s+/gu, " ").trim());
        const errorPattern = /^(?:404|410|403|401|not found|page not found|access denied|unauthorized|forbidden|sign in|log in|login)(?:\b|:)/iu;
        const authOrErrorShell = errorPattern.test(title) || errorPattern.test(firstText)
          || await page.locator('input[type="password"]:visible').count() > 0;
        return { finalUrl: page.url(), documentToken: details.documentToken ?? "",
          navigationCount: documentRequests,
          historyTransitions: details.counters?.transitions ?? -1,
          historyPushes: details.counters?.pushes ?? -1,
          historyReplaces: details.counters?.replaces ?? -1,
          historyPops: details.counters?.pops ?? -1,
          blockedRequests, unexpectedPages,
          mainCount, mainVisible, mainIdentity: details.mainIdentity,
          mainTextLength: normalised.length, mainTextSha256: normalised.length > 0 && normalised.length <= MAX_MAIN_LENGTH
            ? sha256(normalised) : null,
          contentCharacters: details.contentCharacters,
          contentInspectedCompletely: details.contentInspectedCompletely, busy: details.busy,
          authOrErrorShell, intentionalEmptyState: details.intentionalEmptyState,
          headingCount, headingInMainCount, headingVisible, linkCount, linkSafe };
      },
      async activateLink() {
        if (inspectedLink === null || inspectedDestination === null || inspectedName === null) return false;
        const handle = inspectedLink;
        try {
          if (await page.getByRole("link", { name: inspectedName, exact: true,
            includeHidden: true }).count() !== 1) return false;
          const safe = await handle.evaluate((node, wanted) => {
            if (!(node instanceof HTMLAnchorElement) || !node.isConnected
              || node.href !== wanted || node.hasAttribute("ping") || node.hasAttribute("download")
              || node.hasAttribute("target") || node.closest("form,[contenteditable]")
              || node.getAttribute("aria-disabled") === "true") return false;
            for (let current: Element | null = node; current !== null; current = current.parentElement) {
              if (current.hasAttribute("hidden") || current.hasAttribute("inert")
                || current.getAttribute("aria-hidden") === "true") return false;
              const style = getComputedStyle(current);
              if (style.display === "none" || style.visibility !== "visible"
                || Number(style.opacity) === 0 || style.pointerEvents === "none") return false;
              if ([...current.attributes].some((attr) => /^on[a-z]+$/iu.test(attr.name)
                || /^(?:hx-|data-(?:action|method|confirm|turbo-method|remote)|formaction)/iu.test(attr.name))) {
                return false;
              }
              if (["onclick", "onmousedown", "onmouseup", "onpointerdown", "onpointerup",
                "ontouchstart", "onkeydown", "onkeypress"].some((name) =>
                typeof Reflect.get(current, name) === "function")) return false;
            }
            return node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
          }, inspectedDestination);
          if (!safe) return false;
          await handle.click({ timeout: 2_000, noWaitAfter: true });
          return true;
        } catch { return false; }
      },
      async pause(milliseconds) { await page.waitForTimeout(milliseconds); },
      async close() {
        await inspectedLink?.dispose().catch(() => undefined);
        await activeContext.close();
        await browser.close();
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/** Only a fresh real original blank-main observation can create original.json. */
export async function captureSpaRouteHealthOriginal(
  options: SpaRouteHealthCaptureOptions,
): Promise<SpaRouteHealthCaptureResult> {
  if (options.authorized !== true) return captureInconclusive("authorization-required");
  let route: CanonicalRoute;
  try { route = canonical(options.route); } catch { return captureInconclusive("invalid-private-spa-config"); }
  let browser: SpaRouteHealthBrowser | null = null;
  try {
    browser = await (options.createBrowser?.() ?? createChromiumSpaRouteHealthBrowser());
    const document = await browser.navigateSource(route.sourceUrl);
    if (!validDocument(document, route.sourceUrl)) return captureInconclusive("source-document-not-exact-http200");
    const before = await sourceProof(browser, options.route, route);
    if (before === null) return captureInconclusive("source-link-or-content-unproven");
    const after = await transition(browser, before, options.route, route);
    if (after === null) return captureInconclusive("same-document-history-transition-unproven");
    if (!await blankProof(browser, after, before, options.route, route)) {
      return captureInconclusive("stable-blank-main-unproven");
    }
    const witness: OriginalWitness = {
      schemaVersion: ORIGINAL_VERSION,
      browserAuthority: "isolated-chromium-source-get-and-history-push",
      nonce: randomUUID(), configSha256: route.configSha256,
      sourceRouteSha256: route.sourceRouteSha256,
      destinationRouteSha256: route.destinationRouteSha256,
      linkNameSha256: route.linkNameSha256, headingSha256: route.headingSha256,
      expectedMainTextSha256: route.expectedMainTextSha256,
      sourceDocumentStatus: 200, sourceDocumentNavigations: 1,
      sourceSubstantiveMainObserved: true, destinationBlankMainObserved: true,
      sameDocument: true, exactHistoryPushes: 1, noRedirectsOrBlockedRequests: true,
    };
    const bytes = Buffer.from(`${JSON.stringify(witness, null, 2)}\n`, "utf8");
    const output = await freshDirectory(options.outputRoot);
    const originalPath = join(output, "original.json");
    await writeOnce(originalPath, bytes);
    return { schemaVersion: CAPTURE_VERSION, classification: "VERIFIED_ORIGINAL",
      originalPath, originalSha256: sha256(bytes), reason: null };
  } catch {
    return captureInconclusive("capture-execution-or-evidence-failed");
  } finally { await browser?.close().catch(() => undefined); }
}

/** Fresh and independent repaired-state oracle; standalone result is never PASS. */
export async function verifySpaRouteHealth(
  options: SpaRouteHealthVerifyOptions,
): Promise<SpaRouteHealthVerifyResult> {
  if (options.authorized !== true) return verification("INCONCLUSIVE", null, "authorization-required");
  let route: CanonicalRoute;
  try { route = canonical(options.route); } catch { return verification("INCONCLUSIVE", null, "invalid-private-spa-config"); }
  let originalSha: string;
  try {
    const bytes = await readPinnedOriginal(options.originalPath, options.expectedOriginalSha256);
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!exactOriginal(parsed, route)
      || typeof options.outputRoot !== "string"
      || !distinctRoots(options.outputRoot, options.originalPath)) {
      return verification("INCONCLUSIVE", null, "original-source-proof-mismatch");
    }
    originalSha = options.expectedOriginalSha256;
  } catch {
    return verification("INCONCLUSIVE", null, "original-source-proof-unavailable");
  }

  let browser: SpaRouteHealthBrowser | null = null;
  let result: SpaRouteHealthVerifyResult;
  try {
    browser = await (options.createBrowser?.() ?? createChromiumSpaRouteHealthBrowser());
    const document = await browser.navigateSource(route.sourceUrl);
    if (!validDocument(document, route.sourceUrl)) {
      result = verification("INCONCLUSIVE", originalSha, "source-document-changed-or-redirected");
    } else {
      const before = await sourceProof(browser, options.route, route);
      if (before === null) {
        result = verification("INCONCLUSIVE", originalSha, "source-link-or-content-drift");
      } else {
        const after = await transition(browser, before, options.route, route);
        if (after === null) result = verification("INCONCLUSIVE", originalSha, "same-document-history-transition-drift");
        else if (await positiveProof(browser, before, options.route, route)) {
          result = verification("ROUTE_CONTENT_RESTORED", originalSha, null);
        } else if (await blankProof(browser, await browser.observe(browserInput(options.route, route)),
          before, options.route, route)) {
          result = verification("REPRODUCED", originalSha, "original-blank-main-still-observed");
        } else {
          result = verification("INCONCLUSIVE", originalSha, "authored-content-or-stable-hydration-unproven");
        }
      }
    }
  } catch {
    result = verification("INCONCLUSIVE", originalSha, "verification-execution-failed");
  } finally { await browser?.close().catch(() => undefined); }
  try {
    const output = await freshDirectory(options.outputRoot);
    await writeOnce(join(output, "verification.json"), Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8"));
  } catch { return verification("INCONCLUSIVE", originalSha, "verification-output-unavailable"); }
  return result;
}
