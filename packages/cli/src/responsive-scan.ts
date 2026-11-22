import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { sanitiseSnapshotUrl } from "@tvdoctor/driver-web";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { isSafeTerminalArgument } from "./terminal.js";

/** Fixed browser sizes. The TV driver keeps its independent 1280x720 default. */
export const RESPONSIVE_VIEWPORTS = [
  { id: "mobile", width: 390, height: 844 },
  { id: "tablet", width: 768, height: 1024 },
  { id: "desktop", width: 1280, height: 720 },
] as const;

export type ResponsiveViewport = (typeof RESPONSIVE_VIEWPORTS)[number];
export type ResponsiveRule = "responsive.document-overflow" | "responsive.offscreen-control"
  | "responsive.clipped-control" | "responsive.control-overlap" | "responsive.obscured-control";
export type ResponsiveFailure = "browser-unavailable" | "navigation-failed" | "unsafe-redirect"
  | "observation-failed" | "screenshot-failed" | "deadline-exceeded" | "cancelled";

export interface ResponsiveFinding {
  readonly id: string;
  readonly rule: ResponsiveRule;
  readonly confidence: "heuristic";
  readonly reviewRequired: true;
  readonly viewport: ResponsiveViewport["id"];
  readonly routeIdentity: string;
  readonly overflowPx: number | null;
  /** Index in the bounded DOM traversal; never an untrusted identifier or label. */
  readonly controlIndex: number | null;
  readonly controlTag: string | null;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  /** Compact geometry; no DOM text, selectors or HTML are retained. */
  readonly comparisonBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly visibleAreaRatio?: number;
  readonly overlapAreaRatio?: number;
  readonly relatedControlIndex?: number;
  /** Fraction of sampled click points intercepted by a non-interactive overlay. */
  readonly occludedSampleRatio?: number;
  /** Relative local screenshot path, shared among findings from the same page. */
  readonly screenshot: string | null;
}

export interface ResponsivePageResult {
  readonly routeIdentity: string;
  readonly viewport: ResponsiveViewport["id"];
  readonly status: "completed" | "partial" | "failed";
  readonly failure: ResponsiveFailure | null;
  readonly documentWidth: number | null;
  readonly viewportWidth: number;
  readonly controlsInspected: number;
  readonly controlsTruncated: boolean;
  readonly findingsTruncated: boolean;
  readonly geometryPairsChecked?: number;
  readonly geometryPairsTruncated?: boolean;
  /** Bounded repeat observations; false means no layout defect was promoted. */
  readonly measurementSamples?: number;
  readonly layoutStable?: boolean;
  readonly screenshotStatus: "available" | "disabled" | "failed" | "not-needed";
  readonly screenshot: string | null;
  readonly findings: readonly ResponsiveFinding[];
}

export interface ResponsiveScanRequest {
  readonly target: string;
  readonly outputDirectory: string;
  /** Default 3, maximum 12 distinct same-origin pages. */
  readonly maxPages?: number;
  /** Default 2000, maximum 5000 inspected DOM elements per page. */
  readonly maxElementsPerPage?: number;
  /** Default 12, maximum 30 findings per page/viewport. */
  readonly maxFindingsPerPage?: number;
  /** Default 45000, maximum 120000 ms for the whole scan. */
  readonly maxDurationMs?: number;
  readonly captureScreenshots?: boolean;
  /** Opt-in before/after evidence: capture all three first-route viewports even when no heuristic fired. */
  readonly captureComparisonEvidence?: boolean;
  readonly signal?: AbortSignal;
}

export interface ResponsiveScanResult {
  readonly status: "completed" | "partial" | "cancelled";
  readonly targetIdentity: string;
  readonly viewports: typeof RESPONSIVE_VIEWPORTS;
  readonly pagesDiscovered: number;
  readonly pagesDeferred: number;
  readonly linksSkippedByPolicy: number;
  readonly discoveryTruncated: boolean;
  readonly pages: readonly ResponsivePageResult[];
  readonly findings: readonly ResponsiveFinding[];
  readonly terminationReasons: readonly (ResponsiveFailure | "page-limit" | "element-limit" | "finding-limit" | "link-limit" | "geometry-pair-limit" | "layout-unstable")[];
  /** Screenshots contain raw rendered website content. Keep the artifact directory private. */
  readonly evidenceContainsRenderedPageContent: boolean;
}

export interface ResponsivePageEvidenceComparison {
  readonly comparable: boolean;
  readonly reason: "different-route" | "different-viewport" | "partial-observation" | null;
  /** These are observation changes, not automatically proven fixes/regressions. */
  readonly noLongerObserved: readonly { readonly id: string; readonly rule: ResponsiveRule }[];
  readonly newlyObserved: readonly { readonly id: string; readonly rule: ResponsiveRule }[];
  readonly stillObserved: readonly { readonly id: string; readonly rule: ResponsiveRule }[];
  readonly beforeDocumentWidth: number | null;
  readonly afterDocumentWidth: number | null;
}

/** Fail-closed comparison of two stable, fully observed passes of the same route+viewport. */
export function compareResponsivePageEvidence(
  before: ResponsivePageResult,
  after: ResponsivePageResult,
): ResponsivePageEvidenceComparison {
  const reason = before.routeIdentity !== after.routeIdentity ? "different-route"
    : before.viewport !== after.viewport ? "different-viewport"
      : before.status !== "completed" || after.status !== "completed"
        || before.layoutStable !== true || after.layoutStable !== true
        || before.controlsTruncated || after.controlsTruncated
        || before.findingsTruncated || after.findingsTruncated
        || before.geometryPairsTruncated === true || after.geometryPairsTruncated === true
        ? "partial-observation" : null;
  if (reason !== null) return {
    comparable: false, reason, noLongerObserved: [], newlyObserved: [], stillObserved: [],
    beforeDocumentWidth: before.documentWidth, afterDocumentWidth: after.documentWidth,
  };
  const oldIds = new Set(before.findings.map((finding) => finding.id));
  const currentIds = new Set(after.findings.map((finding) => finding.id));
  const compact = (finding: ResponsiveFinding): { readonly id: string; readonly rule: ResponsiveRule } =>
    ({ id: finding.id, rule: finding.rule });
  return {
    comparable: true, reason: null,
    noLongerObserved: before.findings.filter((finding) => !currentIds.has(finding.id)).map(compact),
    newlyObserved: after.findings.filter((finding) => !oldIds.has(finding.id)).map(compact),
    stillObserved: after.findings.filter((finding) => oldIds.has(finding.id)).map(compact),
    beforeDocumentWidth: before.documentWidth, afterDocumentWidth: after.documentWidth,
  };
}

interface ResponsiveDependencies {
  readonly launchBrowser?: () => Promise<Browser>;
}

interface LayoutObservation {
  readonly documentWidth: number;
  readonly viewportWidth: number;
  readonly controlsInspected: number;
  readonly controlsTruncated: boolean;
  readonly findingsTruncated: boolean;
  readonly geometryPairsChecked: number;
  readonly geometryPairsTruncated: boolean;
  readonly sampledControlGeometry: readonly { readonly index: number; readonly bounds: NonNullable<ResponsiveFinding["bounds"]> }[];
  readonly offscreen: readonly {
    readonly index: number;
    readonly tag: string;
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }[];
  readonly clipped: readonly {
    readonly index: number;
    readonly tag: string;
    readonly bounds: NonNullable<ResponsiveFinding["bounds"]>;
    readonly clippingBounds: NonNullable<ResponsiveFinding["bounds"]>;
    readonly visibleAreaRatio: number;
  }[];
  readonly overlaps: readonly {
    readonly index: number;
    readonly tag: string;
    readonly bounds: NonNullable<ResponsiveFinding["bounds"]>;
    readonly otherIndex: number;
    readonly otherBounds: NonNullable<ResponsiveFinding["bounds"]>;
    readonly overlapAreaRatio: number;
  }[];
  readonly obscured: readonly {
    readonly index: number;
    readonly tag: string;
    readonly bounds: NonNullable<ResponsiveFinding["bounds"]>;
    readonly blockerBounds: NonNullable<ResponsiveFinding["bounds"]>;
    readonly occludedSampleRatio: number;
  }[];
}

const MAX_LINKS_PER_PAGE = 250;
const NAVIGATION_TIMEOUT_MS = 8_000;
const MAX_GEOMETRY_CONTROLS = 160;
const MAX_GEOMETRY_PAIRS = 2_048;
const MAX_SCROLL_TARGETS = 2;
const SCROLL_FRACTIONS = [0.5, 1] as const;
const VIEWPORT_ORDER = [RESPONSIVE_VIEWPORTS[2], RESPONSIVE_VIEWPORTS[1], RESPONSIVE_VIEWPORTS[0]] as const;

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`Responsive scan limit must be an integer between 1 and ${String(maximum)}.`);
  }
  return value;
}

function safeTarget(value: string): URL {
  if (!isSafeTerminalArgument(value, 2_048)) {
    throw new TypeError("Responsive scan target must be a bounded HTTP(S) URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Responsive scan target must be an absolute HTTP(S) URL.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("Responsive scan targets must use HTTP(S) without embedded credentials.");
  }
  return parsed;
}

function permittedDiscoveryLink(raw: string, base: string, origin: string): URL | null {
  if (!isSafeTerminalArgument(raw, 2_048)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "") return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  // Crawling invokes only GET navigation, but some sites mutate on GET.
  if (/(?:^|\/)(?:logout|log-out|signout|sign-out|delete|destroy|remove|checkout|purchase|unsubscribe|payment)(?:\/|$)/iu.test(path)) return null;
  return parsed;
}

function token(...parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

async function observeLayout(page: Page, elementLimit: number, findingLimit: number): Promise<LayoutObservation> {
  return await page.evaluate(({ elementLimit: maxElements, findingLimit: maxFindings, maxGeometryControls, maxGeometryPairs }) => {
    const viewportWidth = window.innerWidth;
    const documentWidth = Math.max(
      document.documentElement?.scrollWidth ?? 0,
      document.body?.scrollWidth ?? 0,
    );
    const offscreen: {
      index: number;
      tag: string;
      bounds: { x: number; y: number; width: number; height: number };
    }[] = [];
    interface GeometryRect { x: number; y: number; width: number; height: number }
    interface GeometryCandidate {
      element: Element;
      index: number;
      tag: string;
      compactToggle: boolean;
      rect: DOMRect;
      bounds: GeometryRect;
      dialog: Element | null;
    }
    const geometryCandidates: GeometryCandidate[] = [];
    const clipped: {
      index: number; tag: string; bounds: GeometryRect;
      clippingBounds: GeometryRect; visibleAreaRatio: number;
    }[] = [];
    const overlaps: {
      index: number; tag: string; bounds: GeometryRect;
      otherIndex: number; otherBounds: GeometryRect; overlapAreaRatio: number;
    }[] = [];
    const obscured: {
      index: number; tag: string; bounds: GeometryRect;
      blockerBounds: GeometryRect; occludedSampleRatio: number;
    }[] = [];
    const round = (value: number): number => Math.round(value * 10) / 10;
    const boundsOf = (rect: DOMRect | { left: number; top: number; right: number; bottom: number }): GeometryRect => ({
      x: round(rect.left), y: round(rect.top),
      width: round(rect.right - rect.left), height: round(rect.bottom - rect.top),
    });
    const root = document.documentElement;
    if (root === null) {
      return { viewportWidth, documentWidth, controlsInspected: 0, controlsTruncated: false,
        findingsTruncated: false, geometryPairsChecked: 0, geometryPairsTruncated: false,
        sampledControlGeometry: [], offscreen, clipped, overlaps, obscured };
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const roles = new Set(["button", "link", "checkbox", "radio", "textbox", "combobox", "tab", "menuitem", "switch", "slider"]);
    let inspected = 0;
    let index = 0;
    let controlsTruncated = false;
    let findingsTruncated = false;
    let geometryPairsTruncated = false;
    let current: Node | null = root;
    while (current !== null) {
      if (inspected >= maxElements) {
        controlsTruncated = true;
        break;
      }
      inspected += 1;
      const element = current as Element;
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role")?.toLowerCase() ?? "";
      const candidate = ["button", "input", "select", "textarea", "summary"].includes(tag)
        || (tag === "a" && element.hasAttribute("href"))
        || roles.has(role)
        || element.getAttribute("tabindex") === "0";
      if (candidate) {
        index += 1;
        const rect = element.getBoundingClientRect();
        // Native radio/checkbox targets are often only 13-16 CSS pixels even
        // when their associated label is substantially larger. Their actual
        // center must remain hit-testable inside a nested scrolling panel.
        const compactToggle = tag === "input"
          && ["radio", "checkbox"].includes(element.getAttribute("type")?.toLowerCase() ?? "");
        if ((rect.width >= 30 && rect.height >= 18
          || compactToggle && rect.width >= 10 && rect.height >= 10) && Number.isFinite(rect.left)
          && Number.isFinite(rect.top) && Number.isFinite(rect.right) && Number.isFinite(rect.bottom)
          && rect.right > 5 && rect.left < viewportWidth - 5
          && rect.bottom > 5 && rect.top < window.innerHeight - 5) {
          let eligible = !element.matches(":disabled, [aria-disabled='true'], [aria-hidden='true'], [inert]");
          let ancestor: Element | null = element;
          let steps = 0;
          let clipLeft = -Infinity;
          let clipRight = Infinity;
          let clipTop = -Infinity;
          let clipBottom = Infinity;
          let hasClip = false;
          while (ancestor !== null && steps < 24 && eligible) {
            const style = window.getComputedStyle(ancestor);
            if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0
              || style.pointerEvents === "none" || ancestor.hasAttribute("inert")
              || ancestor.getAttribute("aria-hidden") === "true"
              || ((style.position === "sticky" || style.position === "fixed")
                && (!compactToggle || ancestor === element))) {
              eligible = false;
              break;
            }
            if (ancestor !== element && (/^(auto|scroll)$/u.test(style.overflowX)
              && ancestor.scrollWidth > ancestor.clientWidth + 2
              || /^(auto|scroll)$/u.test(style.overflowY)
              && ancestor.scrollHeight > ancestor.clientHeight + 2)) {
              // Do not classify clipping caused by a scrollport: the user can
              // reveal that content by scrolling. But a control fully inside
              // its scrollport can still be broken by a *different*, nested
              // overflow:hidden/clip ancestor. Continue inspecting those.
              const scrollRect = ancestor.getBoundingClientRect();
              // If an inner mask already clips the control, compare the
              // masked *visible* portion to the scrollport. Comparing the
              // unmasked control would wrongly discard genuine nested-mask
              // defects whenever its invisible tail crosses the scrollport.
              const visibleLeft = hasClip ? Math.max(rect.left, clipLeft) : rect.left;
              const visibleRight = hasClip ? Math.min(rect.right, clipRight) : rect.right;
              const visibleTop = hasClip ? Math.max(rect.top, clipTop) : rect.top;
              const visibleBottom = hasClip ? Math.min(rect.bottom, clipBottom) : rect.bottom;
              if (visibleRight <= visibleLeft || visibleBottom <= visibleTop
                || visibleLeft < scrollRect.left - 1 || visibleRight > scrollRect.right + 1
                || visibleTop < scrollRect.top - 1 || visibleBottom > scrollRect.bottom + 1) {
                eligible = false;
                break;
              }
            }
            if (ancestor !== element && (/(?:hidden|clip)/u.test(style.overflowX)
              || /(?:hidden|clip)/u.test(style.overflowY))) {
              const clippingRect = ancestor.getBoundingClientRect();
              if (/^(hidden|clip)$/u.test(style.overflowX)) {
                clipLeft = Math.max(clipLeft, clippingRect.left);
                clipRight = Math.min(clipRight, clippingRect.right);
                hasClip = true;
              }
              if (/^(hidden|clip)$/u.test(style.overflowY)) {
                clipTop = Math.max(clipTop, clippingRect.top);
                clipBottom = Math.min(clipBottom, clippingRect.bottom);
                hasClip = true;
              }
            }
            ancestor = ancestor.parentElement;
            steps += 1;
          }
          // Invisible descendants inside deeply nested controls are uncertain.
          if (ancestor !== null) eligible = false;
          if (eligible) {
            const tagForEvidence = ["a", "button", "input", "select", "textarea", "summary"].includes(tag) ? tag : "role-control";
            if (geometryCandidates.length < maxGeometryControls) {
              geometryCandidates.push({ element, index, tag: tagForEvidence, compactToggle, rect,
                bounds: boundsOf(rect), dialog: element.closest('[role="dialog"], [aria-modal="true"]') });
            } else {
              geometryPairsTruncated = true;
            }
            if (hasClip) {
              const visibleWidth = Math.max(0, Math.min(rect.right, clipRight) - Math.max(rect.left, clipLeft));
              const visibleHeight = Math.max(0, Math.min(rect.bottom, clipBottom) - Math.max(rect.top, clipTop));
              const ratio = (visibleWidth * visibleHeight) / (rect.width * rect.height);
              // Exclude totally hidden controls and tiny cosmetic edge crops.
              // Intentional masks remain possible: all evidence is heuristic.
              if (ratio >= 0.1 && ratio <= 0.55 && clipped.length < maxFindings) {
                clipped.push({ index, tag: tagForEvidence, bounds: boundsOf(rect),
                  clippingBounds: boundsOf({ left: Math.max(rect.left, clipLeft), top: Math.max(rect.top, clipTop),
                    right: Math.min(rect.right, clipRight), bottom: Math.min(rect.bottom, clipBottom) }),
                  visibleAreaRatio: round(ratio * 100) / 100 });
              } else if (ratio >= 0.1 && ratio <= 0.55) {
                findingsTruncated = true;
              }
            }
          }
        }
        if (rect.width > 1 && rect.height > 1 && Number.isFinite(rect.left)
          && rect.bottom > 1 && rect.top < window.innerHeight - 1
          && (rect.right <= -1 || rect.left >= viewportWidth + 1)) {
          let hiddenOrIntentionallyScrolled = false;
          let ancestor: Element | null = element;
          let levels = 0;
          while (ancestor !== null && levels < 24) {
            const style = window.getComputedStyle(ancestor);
            if (style.display === "none" || style.visibility === "hidden"
              || style.visibility === "collapse" || Number(style.opacity) === 0
              || ancestor.getAttribute("aria-hidden") === "true" || ancestor.hasAttribute("inert")) {
              hiddenOrIntentionallyScrolled = true;
              break;
            }
            if (ancestor !== element && /^(auto|scroll)$/u.test(style.overflowX)
              && ancestor.scrollWidth > ancestor.clientWidth + 2) {
              hiddenOrIntentionallyScrolled = true;
              break;
            }
            if (ancestor !== element && /^(hidden|clip)$/u.test(style.overflowX)) {
              const ancestorBounds = ancestor.getBoundingClientRect();
              if (rect.right <= ancestorBounds.left || rect.left >= ancestorBounds.right) {
                hiddenOrIntentionallyScrolled = true;
                break;
              }
            }
            ancestor = ancestor.parentElement;
            levels += 1;
          }
          // A deeply nested control cannot be classified confidently if its
          // ancestors could not all be checked for clipping or invisibility.
          if (ancestor !== null) hiddenOrIntentionallyScrolled = true;
          if (!hiddenOrIntentionallyScrolled) {
            if (offscreen.length === maxFindings) {
              findingsTruncated = true;
            } else if (!findingsTruncated) {
              offscreen.push({
                index,
                tag: ["a", "button", "input", "select", "textarea", "summary"].includes(tag) ? tag : "role-control",
                bounds: { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) },
              });
            }
          }
        }
      }
      current = walker.nextNode();
    }
    // Sort by visual row; comparisons end once later controls are entirely
    // below the current one. Both retained controls and evaluated pairs are capped.
    geometryCandidates.sort((a, b) => a.rect.top - b.rect.top || a.index - b.index);
    let geometryPairsChecked = 0;
    outer: for (let left = 0; left < geometryCandidates.length; left += 1) {
      const a = geometryCandidates[left];
      if (a === undefined) continue;
      for (let right = left + 1; right < geometryCandidates.length; right += 1) {
        const b = geometryCandidates[right];
        if (b === undefined) continue;
        if (b.rect.top >= a.rect.bottom) break;
        if (geometryPairsChecked >= maxGeometryPairs) { geometryPairsTruncated = true; break outer; }
        geometryPairsChecked += 1;
        if (a.dialog !== b.dialog || a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const overlapLeft = Math.max(a.rect.left, b.rect.left);
        const overlapRight = Math.min(a.rect.right, b.rect.right);
        const overlapTop = Math.max(a.rect.top, b.rect.top);
        const overlapBottom = Math.min(a.rect.bottom, b.rect.bottom);
        if (overlapRight - overlapLeft < 15 || overlapBottom - overlapTop < 12) continue;
        const intersection = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
        const smallestArea = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
        const ratio = intersection / smallestArea;
        if (ratio < 0.55) continue;
        const hitX = (overlapLeft + overlapRight) / 2;
        const hitY = (overlapTop + overlapBottom) / 2;
        if (hitX < 1 || hitX >= viewportWidth - 1 || hitY < 1 || hitY >= window.innerHeight - 1) continue;
        const hit = document.elementFromPoint(hitX, hitY);
        if (hit === null || (!a.element.contains(hit) && !b.element.contains(hit))) continue;
        // Check whether one of the controls' actual center points is blocked
        // by its neighbour. Mere bounding-box intersection is not enough.
        const blockedCenter = [a, b].some((entry) => {
          const centerX = (entry.rect.left + entry.rect.right) / 2;
          const centerY = (entry.rect.top + entry.rect.bottom) / 2;
          const peer = entry === a ? b : a;
          const centerHit = document.elementFromPoint(centerX, centerY);
          return centerHit !== null && peer.element.contains(centerHit)
            && !entry.element.contains(centerHit);
        });
        if (!blockedCenter) continue;
        if (overlaps.length >= maxFindings) { findingsTruncated = true; continue; }
        overlaps.push({ index: a.index, tag: a.tag, bounds: a.bounds,
          otherIndex: b.index, otherBounds: b.bounds, overlapAreaRatio: round(ratio * 100) / 100 });
      }
    }
    // Non-interactive overlays can intercept clicks without any control/control
    // box intersection. Sample a small fixed set of interior hit points; only
    // report a common physical blocker intercepting >=3 of 5 points. Sticky
    // headers, modal backdrops, intentional scroll areas and another
    // interactive control are excluded. Fixed navigation/scrims are eligible:
    // they may accidentally block controls behind a responsive sidebar.
    for (const candidate of geometryCandidates) {
      if (clipped.some((item) => item.index === candidate.index)) continue;
      if (obscured.length >= maxFindings) { findingsTruncated = true; break; }
      const rect = candidate.rect;
      if (rect.left < 0 || rect.right > viewportWidth || rect.top < 0 || rect.bottom > window.innerHeight) continue;
      const samplePoints = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      const blockers = new Map<Element, number>();
      for (const [xRatio, yRatio] of samplePoints) {
        if (xRatio === undefined || yRatio === undefined) continue;
        const hit = document.elementFromPoint(rect.left + rect.width * xRatio, rect.top + rect.height * yRatio);
        if (hit === null || hit === candidate.element || candidate.element.contains(hit)) continue;
        if (hit.contains(candidate.element) || candidate.element.contains(hit)) continue;
        // A small radio/checkbox is still obstructed when an unrelated
        // submit/filter button physically intercepts its center. For larger
        // controls retain the previous conservative exclusion of intentional
        // interactive-over-interactive overlaps (menus, drawers, etc.).
        if (hit.closest('[role="dialog"],[aria-modal="true"],[role="menu"]') !== null) continue;
        const hitControl = hit.closest('button,a[href],input,select,textarea,summary,[role="button"],[role="link"]');
        if (hitControl !== null && (!candidate.compactToggle || hitControl.contains(candidate.element))) continue;
        let overlay: Element | null = hit;
        let blockedBySticky = false;
        let depth = 0;
        while (overlay !== null && depth < 24) {
          const style = window.getComputedStyle(overlay);
          // Suppress an intended sticky header overlaying unrelated content,
          // but not a broken child CTA obscuring a radio inside the *same*
          // sticky panel. The sticky ancestor also contains that radio.
          if (style.position === "sticky" && !overlay.contains(candidate.element)) {
            blockedBySticky = true;
            break;
          }
          overlay = overlay.parentElement;
          depth += 1;
        }
        if (blockedBySticky || overlay !== null) continue;
        blockers.set(hit, (blockers.get(hit) ?? 0) + 1);
      }
      let topBlocker: Element | null = null;
      let count = 0;
      for (const [blocker, hits] of blockers) {
        if (hits > count) { topBlocker = blocker; count = hits; }
      }
      if (topBlocker === null || count < 3) continue;
      const blockerRect = topBlocker.getBoundingClientRect();
      if (blockerRect.width < 20 || blockerRect.height < 15
        || !Number.isFinite(blockerRect.left) || !Number.isFinite(blockerRect.top)) continue;
      obscured.push({ index: candidate.index, tag: candidate.tag, bounds: candidate.bounds,
        blockerBounds: boundsOf(blockerRect), occludedSampleRatio: round(count / samplePoints.length * 100) / 100 });
    }
    return { viewportWidth, documentWidth, controlsInspected: inspected, controlsTruncated,
      findingsTruncated, geometryPairsChecked, geometryPairsTruncated,
      sampledControlGeometry: geometryCandidates.map(({ index: controlIndex, bounds }) => ({ index: controlIndex, bounds })),
      offscreen, clipped, overlaps, obscured };
  }, { elementLimit, findingLimit, maxGeometryControls: MAX_GEOMETRY_CONTROLS, maxGeometryPairs: MAX_GEOMETRY_PAIRS });
}

interface ScrollTarget {
  readonly elementIndex: number;
  readonly parentElementIndex: number | null;
  readonly originalX: number;
  readonly originalY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Only browser-visible scrollports; no source text, selectors or route data leave the page. */
async function discoverScrollTargets(page: Page, elementLimit: number): Promise<{
  readonly targets: readonly ScrollTarget[];
  readonly truncated: boolean;
}> {
  return await page.evaluate(({ maxElements, maxTargets }) => {
    const root = document.documentElement;
    const targets: ScrollTarget[] = [];
    const tracked: HTMLElement[] = [];
    let truncated = false;
    if (root === null) return { targets, truncated };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = root;
    let index = 0;
    while (current !== null && index < maxElements) {
      const element = current as Element;
      if (element !== root && element !== document.body && element instanceof HTMLElement) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const maxX = Math.max(0, element.scrollWidth - element.clientWidth);
        const maxY = Math.max(0, element.scrollHeight - element.clientHeight);
        if (style.display !== "none" && style.visibility === "visible"
          && !element.closest('[aria-hidden="true"],[inert]') && Number(style.opacity) !== 0
          && rect.width >= 100 && rect.height >= 65 && rect.bottom > 10
          && rect.top < window.innerHeight - 10 && rect.right > 10 && rect.left < window.innerWidth - 10
          && ((maxY >= 90 && /^(auto|scroll)$/u.test(style.overflowY))
            || (maxX >= 90 && /^(auto|scroll)$/u.test(style.overflowX)))) {
          if (targets.length < maxTargets) {
            let parentElementIndex: number | null = null;
            for (let candidate = tracked.length - 1; candidate >= 0; candidate -= 1) {
              const earlier = tracked[candidate];
              if (earlier !== undefined && earlier.contains(element)) {
                parentElementIndex = targets[candidate]?.elementIndex ?? null;
                break;
              }
            }
            targets.push({ elementIndex: index, parentElementIndex, originalX: element.scrollLeft, originalY: element.scrollTop,
              maxX, maxY });
            tracked.push(element);
          } else {
            truncated = true;
            break;
          }
        }
      }
      current = walker.nextNode();
      index += 1;
    }
    // A capped DOM walk is already reflected by the parent observation's
    // controlsTruncated flag. This discovery never promises exhaustive coverage.
    return { targets, truncated };
  }, { maxElements: elementLimit, maxTargets: MAX_SCROLL_TARGETS });
}

/** Reacquire the same bounded DOM index; fail closed if the page restructured. */
async function setScrollPosition(page: Page, target: ScrollTarget, fraction: number): Promise<boolean> {
  return await page.evaluate(({ target: saved, fraction: progress }) => {
    const root = document.documentElement;
    if (root === null) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = root;
    let index = 0;
    while (current !== null && index < saved.elementIndex) {
      current = walker.nextNode();
      index += 1;
    }
    if (!(current instanceof HTMLElement) || index !== saved.elementIndex) return false;
    const maxX = Math.max(0, current.scrollWidth - current.clientWidth);
    const maxY = Math.max(0, current.scrollHeight - current.clientHeight);
    if (Math.abs(maxX - saved.maxX) > 3 || Math.abs(maxY - saved.maxY) > 3) return false;
    const requestedX = progress < 0 ? saved.originalX : saved.maxX >= 90 ? Math.round(maxX * progress) : saved.originalX;
    const requestedY = progress < 0 ? saved.originalY : saved.maxY >= 90 ? Math.round(maxY * progress) : saved.originalY;
    current.scrollTo({ left: requestedX, top: requestedY, behavior: "instant" });
    return Math.abs(current.scrollLeft - requestedX) <= 3 && Math.abs(current.scrollTop - requestedY) <= 3;
  }, { target, fraction });
}

interface ScrollStateEvidence {
  readonly observed: LayoutObservation | null;
  readonly screenshot: string | null;
  readonly incomplete: boolean;
  readonly screenshotFailed: boolean;
  readonly discoveryTruncated: boolean;
}

/**
 * Scroll only a small set of visible scrollports at midpoint/end. Each position
 * is measured twice, with an optional screenshot and third measurement in the
 * exact observed position. Scroll offsets are restored in finally, and a
 * different route/page never shares DOM or scroll state with this visit.
 */
async function observeNestedScrollStates(
  page: Page,
  baseline: LayoutObservation,
  elementLimit: number,
  findingLimit: number,
  options: {
    readonly outputDirectory: string;
    readonly viewport: ResponsiveViewport["id"];
    readonly routeIndex: number;
    readonly captureScreenshots: boolean;
    readonly deadline: number;
    readonly signal?: AbortSignal;
  },
): Promise<ScrollStateEvidence> {
  const discovered = await discoverScrollTargets(page, elementLimit);
  let observed: LayoutObservation | null = null;
  let screenshot: string | null = null;
  let incomplete = discovered.truncated;
  let screenshotFailed = false;
  const baselineKeys = new Set([
    ...baseline.obscured.map((control) => `obscured:${control.index}`),
    ...baseline.clipped.map((control) => `clipped:${control.index}`),
    ...baseline.overlaps.map((control) => `overlap:${control.index}:${control.otherIndex}`),
  ]);
  const novel = (sample: LayoutObservation): boolean =>
    sample.obscured.some((control) => !baselineKeys.has(`obscured:${control.index}`))
    || sample.clipped.some((control) => !baselineKeys.has(`clipped:${control.index}`))
    || sample.overlaps.some((control) => !baselineKeys.has(`overlap:${control.index}:${control.otherIndex}`));
  outer: for (const target of discovered.targets) {
    const parent = discovered.targets.find((candidate) => candidate.elementIndex === target.parentElementIndex);
    try {
      for (const fraction of SCROLL_FRACTIONS) {
        if (options.signal?.aborted || Date.now() + 220 >= options.deadline) {
          incomplete = true;
          break outer;
        }
        if (!await setScrollPosition(page, target, fraction)) {
          incomplete = true;
          break;
        }
        if (parent !== undefined && !await setScrollPosition(page, parent, 0.5)) {
          incomplete = true;
          break;
        }
        await page.waitForTimeout(75);
        const first = await observeLayout(page, elementLimit, findingLimit);
        await page.waitForTimeout(85);
        const second = await observeLayout(page, elementLimit, findingLimit);
        if (!sameMeasuredLayout(first, second)) {
          incomplete = true;
          continue;
        }
        if (!novel(second)) continue;
        let possibleScreenshot: string | null = null;
        if (options.captureScreenshots) {
          // Reserve 51..62 for the first observed scrolled state per route;
          // baseline 01..12 screenshots are never overwritten by scrolling.
          const relative = `responsive/${options.viewport}/page-${String(options.routeIndex + 51).padStart(2, "0")}.png`;
          try {
            await mkdir(resolve(options.outputDirectory, "responsive", options.viewport), { recursive: true });
            await page.screenshot({ path: resolve(options.outputDirectory, relative), type: "png",
              fullPage: false, animations: "allow",
              timeout: Math.max(1, Math.min(5_000, options.deadline - Date.now())) });
            possibleScreenshot = relative;
          } catch {
            screenshotFailed = true;
            incomplete = true;
            break outer;
          }
        }
        const afterScreenshot = await observeLayout(page, elementLimit, findingLimit);
        if (!sameMeasuredLayout(second, afterScreenshot)) {
          incomplete = true;
          // A screenshot of changing geometry cannot support a stable defect.
          screenshot = possibleScreenshot;
          break outer;
        }
        if (second.controlsTruncated || second.findingsTruncated || second.geometryPairsTruncated) {
          incomplete = true;
          break outer;
        }
        observed = second;
        screenshot = possibleScreenshot;
        break outer;
      }
    } finally {
      if (!await setScrollPosition(page, target, -1).catch(() => false)) {
        incomplete = true;
      }
      if (parent !== undefined && !await setScrollPosition(page, parent, -1).catch(() => false)) {
        incomplete = true;
      }
    }
  }
  if (!options.signal?.aborted && Date.now() + 50 < options.deadline && discovered.targets.length > 0) {
    // Restored offsets must also restore the original measured scene. Scroll
    // handlers/lazy hydration may alter DOM even when the numeric offsets
    // returned correctly; do not promote evidence if that happened.
    const restored = await observeLayout(page, elementLimit, findingLimit);
    if (!sameMeasuredLayout(baseline, restored)) incomplete = true;
  }
  return { observed, screenshot, incomplete, screenshotFailed, discoveryTruncated: discovered.truncated };
}

function sameMeasuredLayout(a: LayoutObservation, b: LayoutObservation): boolean {
  if (Math.abs(a.documentWidth - b.documentWidth) > 2 || a.controlsInspected !== b.controlsInspected
    || a.controlsTruncated !== b.controlsTruncated || a.geometryPairsTruncated !== b.geometryPairsTruncated) return false;
  const rectClose = (left: NonNullable<ResponsiveFinding["bounds"]>, right: NonNullable<ResponsiveFinding["bounds"]>): boolean =>
    Math.abs(left.x - right.x) <= 2 && Math.abs(left.y - right.y) <= 2
    && Math.abs(left.width - right.width) <= 2 && Math.abs(left.height - right.height) <= 2;
  const sameControls = (left: LayoutObservation["sampledControlGeometry"], right: LayoutObservation["sampledControlGeometry"]): boolean =>
    left.length === right.length && left.every((control, index) => {
      const next = right[index];
      return next !== undefined && control.index === next.index && rectClose(control.bounds, next.bounds);
    });
  const sameFindings = <T extends { readonly index: number; readonly bounds: NonNullable<ResponsiveFinding["bounds"]> }>(
    left: readonly T[], right: readonly T[],
  ): boolean => left.length === right.length && left.every((control, index) => {
    const next = right[index];
    return next !== undefined && control.index === next.index && rectClose(control.bounds, next.bounds);
  });
  const comparableGeometry = <T extends { readonly index: number; readonly bounds: NonNullable<ResponsiveFinding["bounds"]> }>(
    left: readonly T[], right: readonly T[], check: (one: T, two: T) => boolean,
  ): boolean => sameFindings(left, right) && left.every((one, index) => {
    const two = right[index];
    return two !== undefined && check(one, two);
  });
  return sameControls(a.sampledControlGeometry, b.sampledControlGeometry)
    && sameFindings(a.offscreen, b.offscreen)
    && comparableGeometry(a.clipped, b.clipped, (one, two) =>
      rectClose(one.clippingBounds, two.clippingBounds) && Math.abs(one.visibleAreaRatio - two.visibleAreaRatio) <= 0.05)
    && comparableGeometry(a.overlaps, b.overlaps, (one, two) =>
      one.otherIndex === two.otherIndex && rectClose(one.otherBounds, two.otherBounds)
      && Math.abs(one.overlapAreaRatio - two.overlapAreaRatio) <= 0.05)
    && comparableGeometry(a.obscured, b.obscured, (one, two) =>
      rectClose(one.blockerBounds, two.blockerBounds)
      && Math.abs(one.occludedSampleRatio - two.occludedSampleRatio) <= 0.05);
}

async function discoverLinks(page: Page): Promise<{ readonly links: readonly string[]; readonly truncated: boolean }> {
  return await page.evaluate((limit) => {
    const links: string[] = [];
    const anchors = document.getElementsByTagName("a");
    for (let index = 0; index < Math.min(anchors.length, limit); index += 1) {
      const anchor = anchors.item(index);
      if (anchor === null || !anchor.hasAttribute("href")) continue;
      if (anchor.getClientRects().length === 0 || anchor.closest('[aria-hidden="true"], [inert]') !== null) continue;
      const href = anchor.getAttribute("href");
      if (href !== null) links.push(href);
    }
    return { links, truncated: anchors.length > limit };
  }, MAX_LINKS_PER_PAGE);
}

/**
 * Standalone, bounded responsive audit. It does not click forms or run mutations;
 * findings are measured layout observations requiring human review.
 * No source HTML, link labels, unredacted paths, or URL query values enter results.
 */
export async function runResponsiveScan(
  request: ResponsiveScanRequest,
  dependencies: ResponsiveDependencies = {},
): Promise<ResponsiveScanResult> {
  const target = safeTarget(request.target);
  const targetRequestUrl = new URL(target.href);
  targetRequestUrl.hash = "";
  const pageLimit = bounded(request.maxPages, 3, 12);
  const elementLimit = bounded(request.maxElementsPerPage, 2_000, 5_000);
  const findingLimit = bounded(request.maxFindingsPerPage, 12, 30);
  const durationMs = bounded(request.maxDurationMs, 45_000, 120_000);
  if (request.outputDirectory.trim() === "") throw new TypeError("Responsive scan requires an output directory.");
  const outputDirectory = resolve(request.outputDirectory);
  const deadline = Date.now() + durationMs;
  const pages: ResponsivePageResult[] = [];
  const routes = [target.href];
  const seen = new Set(routes);
  const deferred = new Set<string>();
  const reasons = new Set<ResponsiveScanResult["terminationReasons"][number]>();
  let linksSkippedByPolicy = 0;
  let discoveryTruncated = false;
  let browser: Browser | null = null;

  try {
    if (request.signal?.aborted) reasons.add("cancelled");
    else {
      try {
        browser = await (dependencies.launchBrowser?.() ?? chromium.launch({ headless: true, handleSIGINT: false }));
      } catch {
        reasons.add("browser-unavailable");
      }
    }

    if (browser !== null) {
      for (const viewport of VIEWPORT_ORDER) {
        if (request.signal?.aborted) { reasons.add("cancelled"); break; }
        if (Date.now() >= deadline) { reasons.add("deadline-exceeded"); break; }
        let context: BrowserContext | null = null;
        try {
          context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: "block" });
          await context.route("**/*", async (route) => {
            const navigation = route.request().isNavigationRequest();
            let mainFrame = false;
            try { mainFrame = route.request().frame().parentFrame() === null; } catch { /* No frame for a service worker. */ }
            if (!navigation || !mainFrame) { await route.continue(); return; }
            if (permittedDiscoveryLink(route.request().url(), target.href, target.origin) === null
              && route.request().url() !== targetRequestUrl.href) {
              await route.abort("blockedbyclient");
              return;
            }
            // route.continue() can follow server redirects without invoking the
            // handler again. Fetch only the first hop and inspect Location before
            // handing the response to Chromium. This blocks unsafe GET redirects.
            try {
              const response = await route.fetch({ maxRedirects: 0, timeout: NAVIGATION_TIMEOUT_MS });
              if (response.status() >= 300 && response.status() < 400) {
                const location = response.headers()["location"];
                if (location !== undefined && permittedDiscoveryLink(location, route.request().url(), target.origin) === null) {
                  await route.abort("blockedbyclient");
                  return;
                }
              }
              await route.fulfill({ response });
            } catch {
              await route.abort("failed").catch(() => undefined);
            }
          });
          const page = await context.newPage();
          page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
          const count = viewport.id === "desktop" ? pageLimit : routes.length;
          for (let routeIndex = 0; routeIndex < count && routeIndex < routes.length; routeIndex += 1) {
            if (request.signal?.aborted) { reasons.add("cancelled"); break; }
            if (Date.now() >= deadline) { reasons.add("deadline-exceeded"); break; }
            const routeUrl = routes[routeIndex];
            if (routeUrl === undefined) break;
            const routeIdentity = sanitiseSnapshotUrl(routeUrl);
            let failure: ResponsiveFailure | null = null;
            let observed: LayoutObservation | null = null;
            let measurementSamples = 0;
            let layoutStable = false;
            let screenshot: string | null = null;
            let screenshotStatus: ResponsivePageResult["screenshotStatus"] = "not-needed";
            let scrollObservation: LayoutObservation | null = null;
            let scrollScreenshot: string | null = null;
            let scrollIncomplete = false;
            try {
              const response = await page.goto(routeUrl, {
                waitUntil: "domcontentloaded",
                timeout: Math.max(1, Math.min(NAVIGATION_TIMEOUT_MS, deadline - Date.now())),
              });
              if (response === null || response.status() >= 400) {
                failure = "navigation-failed";
              } else if (new URL(page.url()).origin !== target.origin) {
                failure = "unsafe-redirect";
              } else {
                // Hydrating/responsive pages can change geometry after the first
                // frame. Confirm three compatible bounded observations rather
                // than promoting one transient frame into a confident finding.
                await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
                const samples: LayoutObservation[] = [await observeLayout(page, elementLimit, findingLimit)];
                measurementSamples = 1;
                for (const delay of [90, 140, 110]) {
                  if (request.signal?.aborted || deadline - Date.now() <= delay + 20) break;
                  await page.waitForTimeout(delay);
                  samples.push(await observeLayout(page, elementLimit, findingLimit));
                  measurementSamples += 1;
                  const n = samples.length;
                  const latest = samples[n - 1];
                  const previous = samples[n - 2];
                  const beforePrevious = samples[n - 3];
                  if (latest !== undefined && previous !== undefined && beforePrevious !== undefined
                    && sameMeasuredLayout(latest, previous)
                    && sameMeasuredLayout(previous, beforePrevious)) {
                    layoutStable = true;
                    break;
                  }
                }
                observed = samples[samples.length - 1] ?? null;
                if (!layoutStable) {
                  reasons.add(request.signal?.aborted ? "cancelled" : Date.now() >= deadline ? "deadline-exceeded" : "layout-unstable");
                }
                if (viewport.id === "desktop") {
                  const discovery = await discoverLinks(page);
                  if (discovery.truncated) { discoveryTruncated = true; reasons.add("link-limit"); }
                  for (const link of discovery.links) {
                    const parsed = permittedDiscoveryLink(link, page.url(), target.origin);
                    if (parsed === null) { linksSkippedByPolicy += 1; continue; }
                    const href = parsed.href;
                    if (seen.has(href) || deferred.has(href)) continue;
                    if (routes.length < pageLimit) {
                      routes.push(href);
                      seen.add(href);
                    } else {
                      deferred.add(href);
                      reasons.add("page-limit");
                    }
                  }
                }
                const needsScreenshot = !layoutStable || observed === null || observed.documentWidth > observed.viewportWidth + 2
                  || observed.offscreen.length > 0 || observed.clipped.length > 0 || observed.overlaps.length > 0
                  || observed.obscured.length > 0 || (request.captureComparisonEvidence === true && routeIndex === 0);
                if (needsScreenshot && request.captureScreenshots === false) screenshotStatus = "disabled";
                if (needsScreenshot && request.captureScreenshots !== false) {
                  const relative = `responsive/${viewport.id}/page-${String(routeIndex + 1).padStart(2, "0")}.png`;
                  try {
                    await mkdir(resolve(outputDirectory, "responsive", viewport.id), { recursive: true });
                    // Disabling CSS animations would silently change the page
                    // geometry between the measurements and screenshot.
                    await page.screenshot({ path: resolve(outputDirectory, relative), type: "png", fullPage: false,
                      animations: "allow", timeout: Math.max(1, Math.min(5_000, deadline - Date.now())) });
                    screenshot = relative;
                    screenshotStatus = "available";
                    if (layoutStable && observed !== null) {
                      const afterScreenshot = await observeLayout(page, elementLimit, findingLimit);
                      measurementSamples += 1;
                      if (!sameMeasuredLayout(observed, afterScreenshot)) {
                        layoutStable = false;
                        reasons.add("layout-unstable");
                      }
                    }
                  } catch {
                    screenshotStatus = "failed";
                    failure = "screenshot-failed";
                  }
                }
                if (layoutStable && observed !== null && !needsScreenshot && failure === null && !request.signal?.aborted
                  && Date.now() + 250 < deadline) {
                  try {
                    const nested = await observeNestedScrollStates(page, observed, elementLimit, findingLimit, {
                      outputDirectory, viewport: viewport.id, routeIndex,
                      captureScreenshots: request.captureScreenshots !== false,
                      deadline, ...(request.signal === undefined ? {} : { signal: request.signal }),
                    });
                    scrollObservation = nested.observed;
                    scrollScreenshot = nested.screenshot;
                    scrollIncomplete = nested.incomplete;
                    if (nested.discoveryTruncated) reasons.add("element-limit");
                    if (nested.incomplete) reasons.add("layout-unstable");
                    if (nested.screenshotFailed) {
                      failure = "screenshot-failed";
                      reasons.add(failure);
                    }
                    if (scrollScreenshot !== null && screenshot === null) {
                      screenshot = scrollScreenshot;
                      screenshotStatus = "available";
                    } else if (scrollObservation !== null && request.captureScreenshots === false
                      && screenshotStatus === "not-needed") {
                      screenshotStatus = "disabled";
                    }
                  } catch {
                    scrollIncomplete = true;
                    reasons.add("layout-unstable");
                  }
                }
              }
            } catch {
              failure = request.signal?.aborted ? "cancelled" : Date.now() >= deadline ? "deadline-exceeded" : "navigation-failed";
            }
            if (failure !== null) reasons.add(failure);
            if (observed?.controlsTruncated) reasons.add("element-limit");
            if (observed?.findingsTruncated) reasons.add("finding-limit");
            if (observed?.geometryPairsTruncated) reasons.add("geometry-pair-limit");
            if (scrollObservation?.controlsTruncated) reasons.add("element-limit");
            if (scrollObservation?.geometryPairsTruncated) reasons.add("geometry-pair-limit");
            if (scrollObservation?.findingsTruncated) reasons.add("finding-limit");
            const findings: ResponsiveFinding[] = [];
            let pageFindingsTruncated = observed?.findingsTruncated ?? false;
            const addFinding = (finding: ResponsiveFinding): void => {
              if (findings.length >= findingLimit) {
                pageFindingsTruncated = true;
                reasons.add("finding-limit");
              } else {
                findings.push(finding);
              }
            };
            if (observed !== null && layoutStable) {
              if (observed.documentWidth > observed.viewportWidth + 2) {
                const overflow = Math.round((observed.documentWidth - observed.viewportWidth) * 10) / 10;
                addFinding({ id: `responsive-${token(routeIdentity, viewport.id, "overflow")}`,
                  rule: "responsive.document-overflow", confidence: "heuristic", reviewRequired: true,
                  viewport: viewport.id, routeIdentity, overflowPx: overflow, controlIndex: null,
                  controlTag: null, bounds: null, screenshot });
              }
              for (const control of observed.offscreen) {
                addFinding({ id: `responsive-${token(routeIdentity, viewport.id, "control", control.index)}`,
                  rule: "responsive.offscreen-control", confidence: "heuristic", reviewRequired: true,
                  viewport: viewport.id, routeIdentity, overflowPx: null, controlIndex: control.index,
                  controlTag: control.tag, bounds: control.bounds, screenshot });
              }
              for (const control of observed.clipped) {
                addFinding({ id: `responsive-${token(routeIdentity, viewport.id, "clip", control.index)}`,
                  rule: "responsive.clipped-control", confidence: "heuristic", reviewRequired: true,
                  viewport: viewport.id, routeIdentity, overflowPx: null, controlIndex: control.index,
                  controlTag: control.tag, bounds: control.bounds, comparisonBounds: control.clippingBounds,
                  visibleAreaRatio: control.visibleAreaRatio, screenshot });
              }
              for (const overlap of observed.overlaps) {
                addFinding({ id: `responsive-${token(routeIdentity, viewport.id, "overlap", overlap.index, overlap.otherIndex)}`,
                  rule: "responsive.control-overlap", confidence: "heuristic", reviewRequired: true,
                  viewport: viewport.id, routeIdentity, overflowPx: null, controlIndex: overlap.index,
                  controlTag: overlap.tag, bounds: overlap.bounds, comparisonBounds: overlap.otherBounds,
                  overlapAreaRatio: overlap.overlapAreaRatio,
                  relatedControlIndex: overlap.otherIndex, screenshot });
              }
              for (const overlay of observed.obscured) {
                addFinding({ id: `responsive-${token(routeIdentity, viewport.id, "obscured", overlay.index)}`,
                  rule: "responsive.obscured-control", confidence: "heuristic", reviewRequired: true,
                  viewport: viewport.id, routeIdentity, overflowPx: null, controlIndex: overlay.index,
                  controlTag: overlay.tag, bounds: overlay.bounds, comparisonBounds: overlay.blockerBounds,
                  occludedSampleRatio: overlay.occludedSampleRatio, screenshot });
              }
              if (scrollObservation !== null && !scrollIncomplete) {
                const known = new Set(findings.map((finding) => finding.id));
                for (const control of scrollObservation.clipped) {
                  const id = `responsive-${token(routeIdentity, viewport.id, "clip", control.index)}`;
                  if (known.has(id)) continue;
                  known.add(id);
                  addFinding({ id, rule: "responsive.clipped-control", confidence: "heuristic", reviewRequired: true,
                    viewport: viewport.id, routeIdentity, overflowPx: null, controlIndex: control.index,
                    controlTag: control.tag, bounds: control.bounds, comparisonBounds: control.clippingBounds,
                    visibleAreaRatio: control.visibleAreaRatio, screenshot: scrollScreenshot });
                }
                for (const control of scrollObservation.overlaps) {
                  const id = `responsive-${token(routeIdentity, viewport.id, "overlap", control.index, control.otherIndex)}`;
                  if (known.has(id)) continue;
                  known.add(id);
                  addFinding({ id, rule: "responsive.control-overlap", confidence: "heuristic", reviewRequired: true,
                    viewport: viewport.id, routeIdentity, overflowPx: null, controlIndex: control.index,
                    controlTag: control.tag, bounds: control.bounds, comparisonBounds: control.otherBounds,
                    overlapAreaRatio: control.overlapAreaRatio, relatedControlIndex: control.otherIndex,
                    screenshot: scrollScreenshot });
                }
                for (const control of scrollObservation.obscured) {
                  const id = `responsive-${token(routeIdentity, viewport.id, "obscured", control.index)}`;
                  if (known.has(id)) continue;
                  known.add(id);
                  addFinding({ id, rule: "responsive.obscured-control", confidence: "heuristic", reviewRequired: true,
                    viewport: viewport.id, routeIdentity, overflowPx: null, controlIndex: control.index,
                    controlTag: control.tag, bounds: control.bounds, comparisonBounds: control.blockerBounds,
                    occludedSampleRatio: control.occludedSampleRatio, screenshot: scrollScreenshot });
                }
              }
            }
            pages.push({ routeIdentity, viewport: viewport.id, status: observed === null ? "failed"
              : failure !== null || !layoutStable || scrollIncomplete || observed.controlsTruncated
                || pageFindingsTruncated || observed.geometryPairsTruncated ? "partial" : "completed",
              failure, documentWidth: observed?.documentWidth ?? null, viewportWidth: viewport.width,
              controlsInspected: observed?.controlsInspected ?? 0,
              controlsTruncated: observed?.controlsTruncated ?? false,
              findingsTruncated: pageFindingsTruncated,
              geometryPairsChecked: observed?.geometryPairsChecked ?? 0,
              geometryPairsTruncated: observed?.geometryPairsTruncated ?? false,
              measurementSamples, layoutStable,
              screenshotStatus, screenshot, findings });
          }
        } catch {
          reasons.add(request.signal?.aborted ? "cancelled" : "browser-unavailable");
        } finally {
          await context?.close().catch(() => { reasons.add("browser-unavailable"); });
        }
        if (reasons.has("cancelled") || reasons.has("deadline-exceeded")) break;
      }
    }
  } finally {
    await browser?.close().catch(() => { reasons.add("browser-unavailable"); });
  }

  const orderedPages = [...pages].sort((a, b) => {
    const aViewport = RESPONSIVE_VIEWPORTS.findIndex((viewport) => viewport.id === a.viewport);
    const bViewport = RESPONSIVE_VIEWPORTS.findIndex((viewport) => viewport.id === b.viewport);
    return aViewport - bViewport || a.routeIdentity.localeCompare(b.routeIdentity);
  });
  const findings = orderedPages.flatMap((page) => page.findings);
  const expected = routes.length * RESPONSIVE_VIEWPORTS.length;
  return {
    status: reasons.has("cancelled") ? "cancelled" : reasons.size > 0 || pages.length !== expected ? "partial" : "completed",
    targetIdentity: sanitiseSnapshotUrl(target.href), viewports: RESPONSIVE_VIEWPORTS,
    pagesDiscovered: routes.length, pagesDeferred: deferred.size, linksSkippedByPolicy,
    discoveryTruncated, pages: orderedPages, findings,
    terminationReasons: [...reasons],
    evidenceContainsRenderedPageContent: orderedPages.some((page) => page.screenshot !== null),
  };
}
