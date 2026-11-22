import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Page, Response } from "playwright";

/**
 * Passive evidence for a failed *document* reached through an already
 * authorised keyboard activation. Nothing here clicks, navigates, submits
 * forms, fetches a URL, or replays the action.
 *
 * A 404/410/5xx document response is a direct observation of a failed route,
 * not proof of a repaired version. The caller must present it for REVIEW.
 * Even opt-in keyboard activation cannot establish that application event
 * handlers or server GET handlers are free of side effects; use authorised,
 * disposable testing environments only.
 */
export const WEB_SAFE_LINK_DOCUMENT_FAILURE_RULE = "web.safe-link-document-failure" as const;

const MAX_ID_LENGTH = 120;
const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/u;
// Only opaque identity ever crosses to the CLI. A process-local secret stops
// offline dictionary guesses against private routes, labels and link IDs.
// REVIEW IDs need deduplication within a scan, not cross-run replay stability.
const SOURCE_IDENTITY_KEY = randomBytes(32);
const UNSAFE_PATH_PART = /(?:^|[._-])(?:account|activate|admin|api|apply|approve|auth|billing|buy|cancel|cart|checkout|confirm|create|delete|destroy|disable|download|edit|enable|erase|export|finalize|login|logout|order|payment|pay|post|publish|purchase|remove|reset|revoke|save|send|signin|signout|subscribe|submit|transfer|unsubscribe|update|upload|user|users|write)(?:$|[._-])/iu;
const ASSET_PATH = /\.(?:css|js|mjs|json|xml|csv|pdf|zip|exe|png|jpe?g|webp|svg|gif|woff2?|ttf|ico|map|mp4|webm)$/iu;

interface SafeFocusedLink {
  readonly href: string;
  readonly stableId: string;
  /** Used only to derive an opaque identity for ID-less ordinary anchors. */
  readonly accessibleLabel: string;
}

export interface SafeLinkDocumentFailureFinding {
  readonly rule: typeof WEB_SAFE_LINK_DOCUMENT_FAILURE_RULE;
  readonly classification: "review";
  readonly severity: "high";
  readonly sourceStableId: string;
  readonly action: "SELECT";
  readonly status: number;
  readonly evidence: "main-frame-get-document-http-error";
  readonly reproduction: "unavailable";
}

export interface SafeLinkNavigationObserver {
  /**
   * Opaque, per-process identity for a specific IDful source-route/target
   * pair. Null for IDless sources (whose sourceStableId already includes its
   * route and target). Never retain/return raw URL or link text here.
   */
  readonly sourceIdentityHmac: string | null;
  /** Return a review-only observation after the existing safe action settles. */
  finish(result: { readonly key: "SELECT"; readonly outcome: "applied" | "inconclusive" | "failed" | "unsupported" }): SafeLinkDocumentFailureFinding | null;
  /** Stop listening without claiming anything about the result. */
  dispose(): void;
}

function safeDestination(raw: string, base: string): string | null {
  if (raw.length === 0 || raw.length > 1_024 || raw.includes("\\") || raw.includes("?") || raw.includes("#")) {
    return null;
  }
  let current: URL;
  let target: URL;
  try {
    current = new URL(base);
    target = new URL(raw, current);
  } catch {
    return null;
  }
  if ((current.protocol !== "http:" && current.protocol !== "https:")
    || (target.protocol !== "http:" && target.protocol !== "https:")
    || current.origin !== target.origin || current.username !== "" || current.password !== ""
    || target.username !== "" || target.password !== ""
    || target.search !== "" || target.hash !== "" || target.pathname.includes("//")
    || target.href === current.href) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.pathname);
  } catch {
    return null;
  }
  if (decoded.includes("%") || decoded.includes("\\") || decoded.includes("//")
    || decoded.includes("?") || decoded.includes("#")
    || ASSET_PATH.test(decoded)
    || decoded.split("/").some((part) => UNSAFE_PATH_PART.test(part))) return null;
  try {
    const source = decodeURIComponent(current.pathname);
    if (source.includes("%") || source.includes("\\") || source.includes("//")
      || source.split("/").some((part) => UNSAFE_PATH_PART.test(part))) return null;
  } catch {
    return null;
  }
  return target.href;
}

function terminalHttpError(status: number): boolean {
  return status === 404 || status === 410 || (status >= 500 && status <= 599);
}

/**
 * Arms an observer ONLY if Chromium shows a unique, visible, enabled focused
 * HTML anchor whose destination is a simple same-origin GET route.
 *
 * The caller is still responsible for enforcing its existing safe SELECT
 * policy. A null return means the control/action is not eligible for proof.
 */
export async function observeSafeFocusedLinkDocumentFailure(
  page: Page,
): Promise<SafeLinkNavigationObserver | null> {
  if (page.isClosed()) return null;
  const originalUrl = page.url();
  const selected = await page.evaluate((): SafeFocusedLink | null => {
    const node = document.activeElement;
    if (!(node instanceof HTMLAnchorElement) || !node.isConnected
      || node.closest("form,[inert],[aria-hidden='true']") !== null
      || node.hasAttribute("download") || node.hasAttribute("ping")
      || node.getAttribute("aria-disabled") === "true"
      || node.hasAttribute("onclick")
      || (node.getAttribute("role") !== null && node.getAttribute("role") !== "link")
      || node.hasAttribute("aria-haspopup") || node.hasAttribute("aria-controls")
      || node.hasAttribute("aria-expanded")
      || (node.target !== "" && node.target !== "_self")
      || node.relList.contains("external")) return null;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility !== "visible"
      || style.pointerEvents === "none" || Number(style.opacity) <= 0
      || node.getClientRects().length === 0) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth) return null;
    const href = node.getAttribute("href");
    if (href === null) return null;
    const id = node.id;
    if (id.length > 0) {
      if (document.querySelectorAll("[id]").length > 2048
        || [...document.querySelectorAll("[id]")].filter((candidate) => candidate.id === id).length !== 1) {
        return null;
      }
      return { stableId: id, href, accessibleLabel: "" };
    }
    // Mainstream anchors often have no id. Accept an ID-less source only if
    // its literal href is unique and it has a bounded visible accessible name;
    // never turn a positional selector into a purported stable identity.
    const label = (node.getAttribute("aria-label") || node.innerText || "").replace(/\s+/gu, " ").trim();
    if (label.length === 0 || label.length > 160
      || document.querySelectorAll("a[href]").length > 2_048
      || [...document.querySelectorAll("a[href]")]
        .filter((candidate) => candidate.getAttribute("href") === href).length !== 1) return null;
    return { stableId: "", href, accessibleLabel: label };
  }).catch(() => null);
  if (selected === null || (selected.stableId.length > 0
    && (selected.stableId.length > MAX_ID_LENGTH || !SAFE_ID.test(selected.stableId)))) return null;
  const expectedHref = safeDestination(selected.href, originalUrl);
  if (expectedHref === null) return null;
  const sourceStableId = selected.stableId || `link-${createHash("sha256")
    .update(JSON.stringify([originalUrl, expectedHref, selected.accessibleLabel]))
    .digest("hex").slice(0, 32)}`;
  // IDs like "help" routinely repeat on different pages. Do not make the
  // CLI deduplicate two distinct broken links because their DOM IDs match.
  const sourceIdentityHmac = selected.stableId.length === 0 ? null
    : createHmac("sha256", SOURCE_IDENTITY_KEY)
      .update(JSON.stringify(["idful-document-link/v2", originalUrl, expectedHref, selected.stableId]))
      .digest("hex");

  let failureStatus: number | null = null;
  let disqualified = false;
  let active = true;
  let receivedResponses = 0;
  const onResponse = (response: Response): void => {
    if (!active) return;
    const request = response.request();
    if (!request.isNavigationRequest() || request.resourceType() !== "document") return;
    let main = false;
    try { main = request.frame() === page.mainFrame(); } catch { disqualified = true; }
    if (!main) return;
    receivedResponses += 1;
    // Redirect chains, multiple main-frame navigations, non-GET or unexpected
    // routes cannot be attributed to this exact focused link.
    if (receivedResponses !== 1 || request.method() !== "GET"
      || request.redirectedFrom() !== null || request.redirectedTo() !== null
      || response.url() !== expectedHref) {
      disqualified = true;
      return;
    }
    if (terminalHttpError(response.status())) failureStatus = response.status();
  };
  page.on("response", onResponse);
  const dispose = (): void => {
    if (!active) return;
    active = false;
    page.off("response", onResponse);
  };
  return {
    sourceIdentityHmac,
    dispose,
    finish: (result) => {
      if (!active) return null;
      dispose();
      if (result.key !== "SELECT" || result.outcome !== "applied" || disqualified
        || failureStatus === null || receivedResponses !== 1 || page.isClosed()
        || page.url() !== expectedHref) return null;
      return {
        rule: WEB_SAFE_LINK_DOCUMENT_FAILURE_RULE,
        classification: "review",
        severity: "high",
        sourceStableId,
        action: "SELECT",
        status: failureStatus,
        evidence: "main-frame-get-document-http-error",
        reproduction: "unavailable",
      };
    },
  };
}
