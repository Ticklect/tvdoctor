import { createHash } from "node:crypto";
import {
  observeSafeFocusedLinkDocumentFailure,
  sanitiseSnapshotUrl,
  type PlaywrightWebDriver,
  type SafeLinkDocumentFailureFinding,
} from "@tvdoctor/driver-web";
import type { ActionResult, DriverOperationOptions, TVDoctorDriver, TVDoctorIssue } from "@tvdoctor/protocol";
import { idlessFocusedSafeLink } from "./node-audit-navigation.js";

function withheld(): ActionResult {
  return {
    key: "SELECT", outcome: "unsupported", timing: { inputSentAtMs: Date.now() },
    message: "SELECT withheld: the live ID-less link or its original semantic identity could not be safely verified.",
  };
}

/** Compatible with pre-rebuild driver declarations in a shared checkout. */
function observerIdentity(observer: object): string | null {
  return "sourceIdentityHmac" in observer && typeof observer.sourceIdentityHmac === "string"
    ? observer.sourceIdentityHmac : null;
}

/**
 * An ElementHandle pins the *physical* original anchor. Matching a role/name
 * or href alone cannot detect a replacement with identical accessible text.
 * Return all potentially private observations only to the caller's memory.
 */
async function inspectLiveIdlessLink(handle: {
  evaluate<R>(fn: (reference: {
    readonly element: Element | null;
    readonly parents: readonly Element[];
  }) => R | Promise<R>): Promise<R>;
}): Promise<{ readonly href: string; readonly name: string; readonly parents: string } | null> {
  return await handle.evaluate((reference) => {
    const element = reference.element;
    if (!(element instanceof HTMLAnchorElement) || element !== document.activeElement
      || !element.isConnected || element.id !== "" || element.closest("form,[inert],[aria-hidden='true']") !== null
      || element.hasAttribute("onclick") || element.hasAttribute("download")
      || element.hasAttribute("ping") || element.getAttribute("aria-disabled") === "true"
      || (element.getAttribute("role") !== null && element.getAttribute("role") !== "link")
      || element.hasAttribute("aria-haspopup") || element.hasAttribute("aria-controls")
      || element.hasAttribute("aria-expanded")
      || (element.target !== "" && element.target !== "_self")
      || element.relList.contains("external")) return null;
    const style = window.getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility !== "visible"
      || style.pointerEvents === "none" || Number(style.opacity) <= 0
      || element.getClientRects().length === 0
      || bounds.width < 2 || bounds.height < 2 || bounds.bottom <= 0
      || bounds.right <= 0 || bounds.top >= innerHeight || bounds.left >= innerWidth) return null;
    const href = element.getAttribute("href");
    const name = (element.getAttribute("aria-label") || element.innerText || "")
      .replace(/\s+/gu, " ").trim();
    if (href === null || name.length === 0 || name.length > 160
      || document.querySelectorAll("a[href]").length > 2_048
      || [...document.querySelectorAll("a[href]")]
        .filter((anchor) => anchor.getAttribute("href") === href).length !== 1) return null;
    const path: string[] = [];
    let ancestor: Element | null = element.parentElement;
    let cursor = 0;
    while (ancestor !== null && path.length < 32) {
      // Physical ancestor equality rejects reparenting to lookalike nodes
      // whose tags, semantic names and positions happen to be identical.
      if (ancestor !== reference.parents[cursor]) return null;
      cursor++;
      const parent = ancestor.parentElement;
      path.push(JSON.stringify([
        ancestor.tagName, ancestor.id, ancestor.getAttribute("role"),
        ancestor.getAttribute("aria-label"),
        parent === null ? 0 : [...parent.children].indexOf(ancestor),
      ]));
      ancestor = parent;
    }
    if (ancestor !== null || cursor !== reference.parents.length) return null;
    return { href, name, parents: path.join("/") };
  });
}

/**
 * The normal safeKeyboard policy intentionally excludes ID-less controls.
 * Only this explicitly opt-in safe-link wrapper can reach its narrow exception,
 * AFTER a complete semantic witness and the independent live href observer.
 */
async function pressIdlessSafeLink(
  browser: PlaywrightWebDriver,
  issues: TVDoctorIssue[],
  originalRawUrl: string,
  operation?: DriverOperationOptions,
): Promise<ActionResult> {
  operation?.signal?.throwIfAborted();
  const page = browser.getPage();
  if (page.isClosed() || page.url() !== originalRawUrl) return withheld();
  const before = await browser.snapshot(operation);
  const semantic = idlessFocusedSafeLink(before);
  // Browser snapshots contain an opaque route identity, never page.url().
  // Pin the raw URL privately as well: a hash/query drift may be invisible to
  // sanitiseSnapshotUrl and must not authorize a different live document.
  const expectedLocation = sanitiseSnapshotUrl(originalRawUrl);
  if (semantic === null || before.location.status !== "available"
    || before.location.value !== expectedLocation
    || page.url() !== originalRawUrl) return withheld();
  const handle = await page.evaluateHandle(() => {
    const element = document.activeElement;
    const parents: Element[] = [];
    let ancestor = element?.parentElement ?? null;
    while (ancestor !== null && parents.length < 32) {
      parents.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    return { element, parents };
  }).catch(() => null);
  if (handle === null) return withheld();
  let observer: Awaited<ReturnType<typeof observeSafeFocusedLinkDocumentFailure>> = null;
  try {
    const original = await inspectLiveIdlessLink(handle).catch(() => null);
    if (original === null || original.name !== semantic.name
      || page.url() !== originalRawUrl) return withheld();
    observer = await observeSafeFocusedLinkDocumentFailure(page).catch(() => null);
    if (observer === null || page.url() !== originalRawUrl) return withheld();
    const current = await browser.snapshot(operation);
    const currentSemantic = idlessFocusedSafeLink(current);
    if (current.location.status !== "available" || current.location.value !== expectedLocation
      || page.url() !== originalRawUrl
      || currentSemantic?.name !== semantic.name
      || currentSemantic.contextIdentity !== semantic.contextIdentity) return withheld();
    const latest = await inspectLiveIdlessLink(handle).catch(() => null);
    if (latest === null || latest.href !== original.href || latest.name !== original.name
      || latest.parents !== original.parents || page.url() !== originalRawUrl) return withheld();
    operation?.signal?.throwIfAborted();
    // The pinned DOM node has not been replaced, reparented or repointed,
    // and the live observer rejected unsafe hrefs, queries and redirects.
    const result = await browser.press("SELECT", operation);
    const witness = observer.finish({ key: "SELECT", outcome: result.outcome });
    if (witness !== null) {
      const issue = reviewIssue(witness, observerIdentity(observer));
      if (!issues.some((entry) => entry.id === issue.id)) issues.push(issue);
    }
    return result;
  } catch {
    if (operation?.signal?.aborted === true) throw operation.signal.reason;
    return withheld();
  } finally {
    observer?.dispose();
    await handle.dispose().catch(() => undefined);
  }
}

function reviewIssue(witness: SafeLinkDocumentFailureFinding, sourceIdentityHmac?: string | null): TVDoctorIssue {
  // Do not expose the original URL, path, anchor text, or even the source
  // DOM ID: application UI can include private tenant/customer data.
  // The HMAC (when present) includes the private original route, destination
  // and DOM ID. Never report any of those values or the HMAC itself.
  // Legacy/mock observers without this property retain the earlier ID scheme.
  const key = typeof sourceIdentityHmac === "string" && /^[a-f0-9]{64}$/u.test(sourceIdentityHmac)
    ? ["idful-document-link/v2", witness.rule, sourceIdentityHmac, witness.status]
    : [witness.rule, witness.sourceStableId, witness.status];
  const digest = createHash("sha256").update(JSON.stringify(key))
    .digest("hex").slice(0, 32).toUpperCase();
  return {
    id: `TVDOCTOR-WEB-${digest}`,
    rule: witness.rule, pack: "navigation", severity: "high",
    confidence: "heuristic", screen: null,
    title: `Document navigation returned HTTP ${String(witness.status)}`,
    description: "A narrowly permitted same-origin document link returned an error response during an actual keyboard activation. This is a REVIEW lead: the route's intended behavior, reproduction reliability and corrected state have not been independently verified.",
    expected: "The document destination should load the intended page without a terminal HTTP error.",
    observed: `A top-level GET navigation returned HTTP ${String(witness.status)} after an opt-in safe-link keyboard activation.`,
    transition: null,
    evidence: [{
      kind: "heuristic-warning",
      summary: "One real main-frame document GET failed; the source was a uniquely focused eligible link. Background XHR/assets and unrelated navigation are excluded. No destination, secret or source ID was retained.",
      source: "PlaywrightWebDriver:safe-link-document-response/v1", artifact: null,
    }],
    reproduction: { status: "unavailable",
      reason: "An action-correlated error is only an observed review lead. There is no safely replayed rule-specific corrected-state oracle." },
  };
}

/**
 * Adds a narrow opt-in link-GET action to the existing, policy-checked web
 * exploration driver. No observer can perform an action by itself.
 */
export function createSafeLinkNavigationDriver(options: {
  readonly browser: PlaywrightWebDriver;
  readonly safeKeyboard: TVDoctorDriver;
  readonly policyDriver: TVDoctorDriver;
  readonly issues: TVDoctorIssue[];
}): TVDoctorDriver {
  const { browser, safeKeyboard, policyDriver, issues } = options;
  return {
    capabilities: (operation) => safeKeyboard.capabilities(operation),
    snapshot: (operation) => safeKeyboard.snapshot(operation),
    ...(safeKeyboard.reset === undefined ? {} : {
      reset: (strategy, operation) => safeKeyboard.reset?.(strategy, operation) ?? Promise.resolve(),
    }),
    press: async (key, operation) => {
      if (key !== "SELECT") return safeKeyboard.press(key, operation);
      operation?.signal?.throwIfAborted();
      // A complete semantic witness is a prerequisite, never proof of a safe
      // destination. The live observer still owns the independent href gate.
      const initialRawUrl = browser.getPage().url();
      const initial = await browser.snapshot(operation).catch(() => null);
      if (initial !== null && idlessFocusedSafeLink(initial) !== null) {
        if (browser.getPage().url() !== initialRawUrl
          || initial.location.status !== "available"
          || initial.location.value !== sanitiseSnapshotUrl(initialRawUrl)) return withheld();
        return pressIdlessSafeLink(browser, issues, initialRawUrl, operation);
      }
      // Even when a semantic snapshot says "link", a live href may have been
      // changed by the app. If validation fails, original button policy wins.
      const observer = await observeSafeFocusedLinkDocumentFailure(browser.getPage()).catch(() => null);
      if (observer === null) return safeKeyboard.press(key, operation);
      try {
        // Still use existing side-effect/semantic policy; unlike the normal
        // keyboard-only wrapper it permits links that passed the live href gate.
        const result = await policyDriver.press(key, operation);
        const witness = observer.finish({ key: "SELECT", outcome: result.outcome });
        if (witness !== null) {
          const issue = reviewIssue(witness, observerIdentity(observer));
          if (!issues.some((entry) => entry.id === issue.id)) issues.push(issue);
        }
        return result;
      } finally {
        observer.dispose();
      }
    },
  };
}
