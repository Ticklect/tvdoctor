import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page } from "playwright";

/**
 * Standalone PUBLIC route oracle. It is deliberately NOT a general-purpose
 * browser scanner or an authReady assertion. The caller owns the separate
 * fresh QA regression gate. Neither a missing later finding nor HTTP 200 alone
 * can establish FIXED.
 *
 * An exact authored fingerprint of substantive expected <main> text is required
 * for FIXED, in addition to a unique visible authored heading. A counterfeit
 * reproducing ALL of this trusted text remains indistinguishable to a browser;
 * callers must not advertise security/authenticity certification.
 */
const ORIGINAL_VERSION = "tvdoctor.public-route-health-original/v1" as const;
const CAPTURE_VERSION = "tvdoctor.public-route-health-capture/v1" as const;
const VERIFY_VERSION = "tvdoctor.public-route-health-verification/v1" as const;
const ROUTE_PATH = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;
const SHA = /^[0-9a-f]{64}$/u;
const MAX_ORIGINAL = 4 * 1024;
const DEFAULT_SETTLE_MS = 180;

export interface PublicRouteHealthRoute {
  /** A canonical HTTP(S) origin, not a URL with path, query or fragment. */
  readonly baseUrl: string;
  /** An exact, safe, same-origin public document GET path. */
  readonly path: string;
  /** Expected accessible name of exactly one visible heading inside <main>. */
  readonly heading: string;
  /**
   * SHA256 of normalised expected MAIN visible text, authored independently
   * of the broken-page capture. Without this independent trust anchor,
   * verification returns INCONCLUSIVE even when HTTP200 and heading match.
   */
  readonly expectedMainTextSha256?: string | undefined;
}

export interface PublicRouteHealthDocument {
  readonly requestUrl: string;
  readonly responseUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly method: string;
  readonly mainFrameDocument: boolean;
  readonly redirectCount: number;
  readonly navigationCount: number;
  readonly contentType: string | null;
}

export interface PublicRouteHealthContent {
  readonly finalUrl: string;
  readonly navigationCount: number;
  readonly headingCount: number;
  readonly headingVisible: boolean;
  readonly mainCount: number;
  readonly headingInMainCount: number;
  readonly headingInMainVisible: boolean;
  /** SHA of the observed bounded DOM ancestor path from heading to MAIN. */
  readonly headingContextSha256: string | null;
  /** The same physical heading DOM node was retained since first observation. */
  readonly sameHeadingNode: boolean;
  readonly mainTextSha256: string | null;
  readonly mainTextLength: number;
  /** A clear error/access shell disqualifies a repaired state. */
  readonly errorOrLoginShell: boolean;
}

/** Mock this small browser boundary in unit tests. Production uses Chromium. */
export interface PublicRouteHealthBrowser {
  navigate(url: string): Promise<PublicRouteHealthDocument>;
  inspect(heading: string): Promise<PublicRouteHealthContent>;
  close(): Promise<void>;
}

export type PublicRouteHealthBrowserFactory = () => Promise<PublicRouteHealthBrowser>;

export interface PublicRouteHealthCaptureOptions {
  readonly authorized: boolean;
  readonly route: PublicRouteHealthRoute;
  /** Fresh directory, canonical existing parent; creates original.json ONLY. */
  readonly outputRoot: string;
  readonly createBrowser?: PublicRouteHealthBrowserFactory;
}

export interface PublicRouteHealthCaptureResult {
  readonly schemaVersion: typeof CAPTURE_VERSION;
  readonly classification: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly originalPath: string | null;
  readonly originalSha256: string | null;
  readonly reason: string | null;
}

export interface PublicRouteHealthVerifyOptions {
  readonly authorized: boolean;
  readonly route: PublicRouteHealthRoute;
  /** Exact original.json created by capture; not a caller-authored issue. */
  readonly originalPath: string;
  /** Out-of-band SHA256 pin returned by the original capture. REQUIRED. */
  readonly expectedOriginalSha256: string;
  readonly outputRoot: string;
  readonly createBrowser?: PublicRouteHealthBrowserFactory;
  /** Injectable clock wait for deterministic tests. Production remains bounded. */
  readonly pause?: (milliseconds: number) => Promise<void>;
}

export interface PublicRouteHealthVerifyResult {
  readonly schemaVersion: typeof VERIFY_VERSION;
  readonly classification: "REPRODUCED" | "FIXED" | "INCONCLUSIVE";
  readonly originalSha256: string | null;
  /** Standalone verdict; prime must run a fresh QA regression independently. */
  readonly regressionChecked: false;
  readonly reason: string | null;
}

interface OriginalWitness {
  readonly schemaVersion: typeof ORIGINAL_VERSION;
  readonly source: "chromium-main-frame-document-get";
  readonly nonce: string;
  readonly routeSha256: string;
  readonly headingSha256: string;
  readonly expectedMainTextSha256: string | null;
  readonly originalStatus: 404 | 410;
  readonly exactRoute: true;
  readonly redirects: 0;
}

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

/** Author can compute this from the expected healthy page; never from the 404. */
export function hashExpectedPublicMainText(text: string): string {
  return sha256(text.normalize("NFKC").replace(/\s+/gu, " ").trim());
}

function canonicalRoute(input: PublicRouteHealthRoute): {
  readonly url: string; readonly routeHash: string; readonly headingHash: string;
  readonly expectedMain: string | null;
} {
  if (input === null || typeof input !== "object"
    || typeof input.baseUrl !== "string" || input.baseUrl.length > 2048
    || typeof input.path !== "string" || input.path.length > 512
    || !ROUTE_PATH.test(input.path) || input.path.split("/").includes("..")
    || typeof input.heading !== "string" || input.heading.length < 1
    || input.heading.length > 128 || input.heading.trim() !== input.heading
    || /[\p{Cc}\p{Cf}]/u.test(input.heading)) throw new Error("invalid-route-expectation");
  const base = new URL(input.baseUrl);
  if ((base.protocol !== "http:" && base.protocol !== "https:")
    || base.username !== "" || base.password !== ""
    || base.search !== "" || base.hash !== "" || base.pathname !== "/"
    || base.href !== `${base.origin}/`
    || (input.baseUrl !== base.origin && input.baseUrl !== base.href)) {
    throw new Error("invalid-route-origin");
  }
  const url = new URL(input.path, base);
  if (url.origin !== base.origin || url.pathname !== input.path
    || url.search !== "" || url.hash !== "") throw new Error("invalid-route-path");
  const main = input.expectedMainTextSha256;
  if (main !== undefined && (typeof main !== "string" || !SHA.test(main))) {
    throw new Error("invalid-content-fingerprint");
  }
  return { url: url.href, routeHash: sha256(JSON.stringify(["public-document/v1", base.origin, input.path])),
    headingHash: sha256(JSON.stringify(["heading", input.heading])),
    expectedMain: main ?? null };
}

function validDocument(doc: PublicRouteHealthDocument, url: string): boolean {
  return doc !== null && typeof doc === "object"
    && doc.requestUrl === url && doc.responseUrl === url && doc.finalUrl === url
    && doc.mainFrameDocument === true && doc.method === "GET"
    && doc.redirectCount === 0 && doc.navigationCount === 1
    && Number.isInteger(doc.status) && doc.status >= 100 && doc.status <= 599;
}

function originalWitness(value: unknown): value is OriginalWitness {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const keys = ["schemaVersion", "source", "nonce", "routeSha256", "headingSha256",
    "expectedMainTextSha256", "originalStatus", "exactRoute", "redirects"];
  return Object.keys(obj).sort().join("|") === keys.sort().join("|")
    && obj["schemaVersion"] === ORIGINAL_VERSION
    && obj["source"] === "chromium-main-frame-document-get"
    && typeof obj["nonce"] === "string"
    && /^[0-9a-f-]{36}$/u.test(obj["nonce"])
    && typeof obj["routeSha256"] === "string" && SHA.test(obj["routeSha256"])
    && typeof obj["headingSha256"] === "string" && SHA.test(obj["headingSha256"])
    && (obj["expectedMainTextSha256"] === null
      || typeof obj["expectedMainTextSha256"] === "string" && SHA.test(obj["expectedMainTextSha256"]))
    && (obj["originalStatus"] === 404 || obj["originalStatus"] === 410)
    && obj["exactRoute"] === true && obj["redirects"] === 0;
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || await realpath(absolute) !== absolute) throw new Error("unsafe-directory");
  return absolute;
}

async function freshRoot(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096
    || path.includes("\0")) throw new Error("invalid-output");
  const output = resolve(path);
  await canonicalDirectory(dirname(output));
  await mkdir(output, { mode: 0o700 });
  return await canonicalDirectory(output);
}

async function originalBytes(path: string, expectedHash: string): Promise<Buffer> {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096
    || path.includes("\0") || basename(path) !== "original.json"
    || !SHA.test(expectedHash)) throw new Error("invalid-original-reference");
  const absolute = resolve(path);
  await canonicalDirectory(dirname(absolute));
  const first = await lstat(absolute);
  if (!first.isFile() || first.isSymbolicLink() || first.size < 1
    || first.size > MAX_ORIGINAL || await realpath(absolute) !== absolute) {
    throw new Error("unsafe-original");
  }
  const handle = await open(absolute, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== first.ino || opened.size !== first.size) {
      throw new Error("changed-original");
    }
    bytes = Buffer.alloc(first.size);
    for (let at = 0; at < bytes.length;) {
      const read = await handle.read(bytes, at, bytes.length - at, at);
      if (read.bytesRead <= 0) throw new Error("truncated-original");
      at += read.bytesRead;
    }
  } finally { await handle.close(); }
  const last = await lstat(absolute);
  if (!last.isFile() || last.isSymbolicLink()
    || last.ino !== first.ino || last.size !== first.size || last.mtimeMs !== first.mtimeMs
    || sha256(bytes) !== expectedHash) throw new Error("original-tampered");
  return bytes;
}

function distinctOutput(output: string, originalPath: string): boolean {
  const a = resolve(output);
  const b = resolve(dirname(originalPath));
  const inside = (parent: string, child: string): boolean => {
    const rest = relative(parent, child);
    return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`)
      && !isAbsolute(rest));
  };
  return !inside(a, b) && !inside(b, a);
}

/**
 * Real observer uses a fresh, cookieless Chromium context. It never loads
 * journey/sessionStorage or follows client-authored link actions.
 */
export async function createChromiumPublicRouteHealthBrowser(): Promise<PublicRouteHealthBrowser> {
  const browser: Browser = await chromium.launch({ headless: true });
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({
      serviceWorkers: "block", acceptDownloads: false, javaScriptEnabled: true,
    });
    const page: Page = await context.newPage();
    let documentRequests = 0;
    let originalHeading: ElementHandle<SVGElement | HTMLElement> | null = null;
    page.on("request", (request) => {
      try {
        if (request.isNavigationRequest() && request.resourceType() === "document"
          && request.frame() === page.mainFrame()) documentRequests++;
      } catch { documentRequests++; }
    });
    return {
      async navigate(url) {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        if (response === null) throw new Error("missing-navigation-response");
        const request = response.request();
        let redirectCount = 0;
        for (let previous = request.redirectedFrom(); previous !== null; previous = previous.redirectedFrom()) {
          redirectCount++;
          if (redirectCount > 16) throw new Error("excessive-redirects");
        }
        let mainFrameDocument = false;
        try { mainFrameDocument = request.frame() === page.mainFrame()
          && request.isNavigationRequest() && request.resourceType() === "document"; } catch { /* invalid */ }
        return {
          requestUrl: request.url(), responseUrl: response.url(), finalUrl: page.url(),
          status: response.status(), method: request.method(), mainFrameDocument,
          redirectCount, navigationCount: documentRequests,
          contentType: response.headers()["content-type"] ?? null,
        };
      },
      async inspect(heading) {
        const headingLocator = page.getByRole("heading", { name: heading, exact: true, includeHidden: true });
        const main = page.locator("main");
        const innerHeading = main.getByRole("heading", { name: heading, exact: true, includeHidden: true });
        const headingCount = await headingLocator.count();
        const mainCount = await main.count();
        const headingInMainCount = mainCount === 1 ? await innerHeading.count() : 0;
        const visibleHeading = headingCount === 1 && await headingLocator.isVisible();
        const headingInMainVisible = headingInMainCount === 1 && await innerHeading.isVisible();
        let sameHeadingNode = false;
        let headingContextSha256: string | null = null;
        if (headingCount === 1 && headingInMainCount === 1 && headingInMainVisible) {
          const handle = await headingLocator.elementHandle();
          if (handle !== null) {
            if (originalHeading === null) {
              originalHeading = handle;
              sameHeadingNode = true;
            } else {
              sameHeadingNode = await originalHeading.evaluate((original, current) => original === current, handle)
                .catch(() => false);
              await handle.dispose().catch(() => undefined);
            }
            if (sameHeadingNode && originalHeading !== null) {
              const contextPath = await originalHeading.evaluate((element) => {
                const parts: (string | number | null)[][] = [];
                let cursor: Element | null = element;
                while (cursor !== null && parts.length < 32) {
                  const parent: Element | null = cursor.parentElement;
                  parts.push([cursor.tagName, cursor.id || null,
                    cursor.getAttribute("role"), cursor.getAttribute("aria-label"),
                    parent === null ? -1 : [...parent.children].indexOf(cursor)]);
                  if (cursor.tagName === "MAIN") return parts;
                  cursor = parent;
                }
                return null;
              }).catch(() => null);
              if (contextPath !== null && contextPath.length > 0) {
                headingContextSha256 = sha256(JSON.stringify(contextPath));
              }
            }
          }
        }
        const content = mainCount === 1 ? await main.innerText({ timeout: 2_000 }) : "";
        const normalised = content.normalize("NFKC").replace(/\s+/gu, " ").trim();
        const title = (await page.title()).trim();
        const body = await page.locator("body").innerText({ timeout: 2_000 });
        const firstText = body.replace(/\s+/gu, " ").trim().slice(0, 200);
        const shellText = /^(?:404|410|403|401|not found|page not found|access denied|unauthorized|forbidden|sign in|log in|login)(?:\b|:)/iu;
        const shell = shellText.test(title) || shellText.test(firstText)
          || await page.locator('input[type="password"]:visible').count() > 0;
        return {
          finalUrl: page.url(), navigationCount: documentRequests, headingCount,
          headingVisible: visibleHeading, mainCount, headingInMainCount,
          headingInMainVisible, headingContextSha256, sameHeadingNode,
          mainTextSha256: normalised ? sha256(normalised) : null,
          mainTextLength: normalised.length, errorOrLoginShell: shell,
        };
      },
      async close() {
        await originalHeading?.dispose().catch(() => undefined);
        await context?.close();
        await browser.close();
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}

function contentMatch(value: PublicRouteHealthContent, url: string, heading: string, expectedHash: string): boolean {
  return value !== null && value.finalUrl === url && value.navigationCount === 1
    && value.headingCount === 1 && value.headingVisible === true
    && value.mainCount === 1 && value.headingInMainCount === 1
    && value.headingInMainVisible === true && value.errorOrLoginShell === false
    && value.sameHeadingNode === true
    && typeof value.headingContextSha256 === "string" && SHA.test(value.headingContextSha256)
    && Number.isSafeInteger(value.mainTextLength)
    && value.mainTextLength >= Math.max(48, heading.length + 24)
    && value.mainTextSha256 === expectedHash;
}

const inconclusiveCapture = (reason: string): PublicRouteHealthCaptureResult => ({
  schemaVersion: CAPTURE_VERSION, classification: "INCONCLUSIVE",
  originalPath: null, originalSha256: null, reason,
});
const verdict = (
  classification: PublicRouteHealthVerifyResult["classification"],
  originalSha256: string | null,
  reason: string | null,
): PublicRouteHealthVerifyResult => ({
  schemaVersion: VERIFY_VERSION, classification, originalSha256,
  regressionChecked: false, reason,
});

/** Create a SHA-pinnable original only for one real nonredirected 404/410. */
export async function capturePublicRouteHealthOriginal(
  options: PublicRouteHealthCaptureOptions,
): Promise<PublicRouteHealthCaptureResult> {
  if (options?.authorized !== true) return inconclusiveCapture("authorization-required");
  let route: ReturnType<typeof canonicalRoute>;
  try { route = canonicalRoute(options.route); }
  catch { return inconclusiveCapture("invalid-public-route"); }
  let root: string;
  try { root = await freshRoot(options.outputRoot); }
  catch { return inconclusiveCapture("output-not-fresh-or-unsafe"); }
  let browser: PublicRouteHealthBrowser | null = null;
  try {
    browser = await (options.createBrowser ?? createChromiumPublicRouteHealthBrowser)();
    const response = await browser.navigate(route.url);
    if (!validDocument(response, route.url)
      || (response.status !== 404 && response.status !== 410)) {
      return inconclusiveCapture("original-negative-http-proof-unavailable");
    }
    const witness: OriginalWitness = {
      schemaVersion: ORIGINAL_VERSION, source: "chromium-main-frame-document-get",
      nonce: randomUUID(), routeSha256: route.routeHash, headingSha256: route.headingHash,
      expectedMainTextSha256: route.expectedMain,
      originalStatus: response.status, exactRoute: true, redirects: 0,
    };
    const bytes = Buffer.from(JSON.stringify(witness) + "\n", "utf8");
    if (bytes.length > MAX_ORIGINAL) return inconclusiveCapture("original-witness-too-large");
    const path = join(root, "original.json");
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    return { schemaVersion: CAPTURE_VERSION, classification: "VERIFIED_ORIGINAL",
      originalPath: path, originalSha256: sha256(bytes), reason: null };
  } catch {
    return inconclusiveCapture("original-observation-or-write-failed");
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/**
 * Independently visits repaired route in a NEW isolated Chromium context.
 * It never infers FIXED from absence of a finding, status 200, or heading alone.
 * The consumer must separately run a fresh regression scan before PASS.
 */
export async function verifyPublicRouteHealth(
  options: PublicRouteHealthVerifyOptions,
): Promise<PublicRouteHealthVerifyResult> {
  if (options?.authorized !== true) return verdict("INCONCLUSIVE", null, "authorization-required");
  let route: ReturnType<typeof canonicalRoute>;
  try { route = canonicalRoute(options.route); }
  catch { return verdict("INCONCLUSIVE", null, "invalid-public-route"); }
  if (typeof options.expectedOriginalSha256 !== "string"
    || !SHA.test(options.expectedOriginalSha256)
    || typeof options.originalPath !== "string"
    || typeof options.outputRoot !== "string"
    || !distinctOutput(options.outputRoot, options.originalPath)) {
    return verdict("INCONCLUSIVE", null, "unsafe-or-unpinned-original");
  }
  let original: Buffer;
  try {
    original = await originalBytes(options.originalPath, options.expectedOriginalSha256);
    const witness: unknown = JSON.parse(original.toString("utf8")) as unknown;
    if (!originalWitness(witness) || witness.routeSha256 !== route.routeHash
      || witness.headingSha256 !== route.headingHash
      || witness.expectedMainTextSha256 !== route.expectedMain) {
      return verdict("INCONCLUSIVE", null, "original-witness-or-authored-expectation-changed");
    }
  } catch { return verdict("INCONCLUSIVE", null, "original-proof-invalid-or-tampered"); }
  let root: string;
  try { root = await freshRoot(options.outputRoot); }
  catch { return verdict("INCONCLUSIVE", null, "output-not-fresh-or-unsafe"); }
  let browser: PublicRouteHealthBrowser | null = null;
  let result: PublicRouteHealthVerifyResult;
  try {
    browser = await (options.createBrowser ?? createChromiumPublicRouteHealthBrowser)();
    const response = await browser.navigate(route.url);
    if (!validDocument(response, route.url)) {
      result = verdict("INCONCLUSIVE", options.expectedOriginalSha256, "redirected-or-different-route");
    } else if (response.status === 404 || response.status === 410) {
      result = verdict("REPRODUCED", options.expectedOriginalSha256, null);
    } else if (response.status !== 200 || typeof response.contentType !== "string"
      || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.contentType)) {
      result = verdict("INCONCLUSIVE", options.expectedOriginalSha256, "unproven-healthy-document");
    } else if (route.expectedMain === null) {
      result = verdict("INCONCLUSIVE", options.expectedOriginalSha256, "independent-authored-content-proof-required");
    } else {
      const pause = options.pause ?? (async (ms: number): Promise<void> => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      });
      const first = await browser.inspect(options.route.heading);
      await pause(DEFAULT_SETTLE_MS);
      const second = await browser.inspect(options.route.heading);
      if (contentMatch(first, route.url, options.route.heading, route.expectedMain)
        && contentMatch(second, route.url, options.route.heading, route.expectedMain)
        && JSON.stringify(first) === JSON.stringify(second)) {
        result = verdict("FIXED", options.expectedOriginalSha256, null);
      } else {
        result = verdict("INCONCLUSIVE", options.expectedOriginalSha256, "authored-content-not-independently-proven");
      }
    }
  } catch {
    result = verdict("INCONCLUSIVE", options.expectedOriginalSha256, "verification-observation-unavailable");
  } finally {
    await browser?.close().catch(() => undefined);
  }
  // A concurrent mutation of an original artifact must invalidate a successful
  // or reproduced verdict. Write only the bounded verdict to the NEW output.
  try {
    await originalBytes(options.originalPath, options.expectedOriginalSha256);
  } catch { result = verdict("INCONCLUSIVE", null, "original-changed-during-verification"); }
  try {
    await writeFile(join(root, "verification.json"), JSON.stringify(result) + "\n",
      { flag: "wx", mode: 0o600 });
  } catch { return verdict("INCONCLUSIVE", null, "verification-output-write-failed"); }
  return result;
}
