import type {
  ElementBounds,
  FocusTarget,
  StateSnapshot,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { ExplorationTermination } from "./explorer-contracts.js";

/**
 * Drivers may extend StateSnapshot with observation metadata. Structural
 * truncation hides potential navigation targets, unlike bounded text labels.
 * Unknown truncation causes are conservatively treated as structural.
 */
function omittedUiTreeReasons(snapshot: StateSnapshot): readonly string[] {
  const metadata = (snapshot as StateSnapshot & { readonly uiTreeMetadata?: unknown }).uiTreeMetadata;
  if (typeof metadata !== "object" || metadata === null
    || !("status" in metadata) || metadata.status !== "available"
    || !("value" in metadata)) return [];
  const value = metadata.value;
  if (typeof value !== "object" || value === null
    || !("truncated" in value) || value.truncated !== true) return [];
  const rawReasons = "truncationReasons" in value ? value.truncationReasons : undefined;
  if (!Array.isArray(rawReasons)) return ["unspecified"];
  const reasons = rawReasons.filter((reason): reason is string => (
    reason === "captured-nodes" || reason === "scanned-nodes" || reason === "depth"
  ));
  if (reasons.length > 0) return reasons;
  return rawReasons.length > 0 && rawReasons.every((reason) => reason === "text")
    ? [] : ["unspecified"];
}

/** Keeps final coverage honest without mutating graph structure or driver data. */
export function createExplorationCoverageRecorder() {
  const examinedSnapshots = new WeakSet<StateSnapshot>();
  const reasons = new Set<string>();
  const unsupportedKeys = new Set<string>();
  let truncatedSnapshots = 0;
  let unappliedActions = 0;
  return {
    observe(snapshot: StateSnapshot): void {
      if (examinedSnapshots.has(snapshot)) return;
      examinedSnapshots.add(snapshot);
      const omitted = omittedUiTreeReasons(snapshot);
      if (omitted.length === 0) return;
      truncatedSnapshots += 1;
      for (const reason of omitted) reasons.add(reason);
    },
    recordAction(key: string, outcome: string): void {
      if (outcome === "applied") return;
      unappliedActions += 1;
      unsupportedKeys.add(`${key}:${outcome}`);
    },
    decorateTermination(termination: ExplorationTermination): ExplorationTermination {
      const omissions: string[] = [];
      if (truncatedSnapshots > 0) {
        omissions.push(
          `UI-tree enumeration truncated in ${String(truncatedSnapshots)} observed snapshot(s) `
          + `(${[...reasons].sort().join(", ")}); unobserved controls may remain`,
        );
      }
      if (unappliedActions > 0) {
        omissions.push(
          `${String(unappliedActions)} attempted remote action(s) were not applied `
          + `(${[...unsupportedKeys].sort().join(", ")}); those navigation edges are unverified`,
        );
      }
      if (omissions.length === 0) return termination;
      // Queue exhaustion describes the stopping condition, not proof of full
      // coverage. Preserve stronger max-actions/restoration termination reasons.
      return {
        ...termination,
        complete: false,
        detail: [termination.detail, `Incomplete coverage: ${omissions.join("; ")}.`]
          .filter((detail): detail is string => detail !== undefined && detail.length > 0)
          .join(" ").slice(0, 500),
      };
    },
  };
}

export type MatchConfidence = "high" | "medium" | "low";

export type FingerprintSignal =
  | "location"
  | "ui-structure"
  | "stable-identifiers"
  | "roles"
  | "geometry"
  | "focused-stable-identifier"
  | "focused-role"
  | "focused-name"
  | "focused-geometry"
  | "selection-state"
  | "action-mode"
  | "truncated"
  | "no-focused-element"
  | "unavailable";

/** A compact, JSON-safe description of how state identity was established. */
export interface StateFingerprint {
  readonly value: string;
  readonly confidence: MatchConfidence;
  readonly signals: readonly FingerprintSignal[];
}

export interface SnapshotFingerprint {
  /** Structural identity. Focus flags and focused-element identity are excluded. */
  readonly screen: StateFingerprint;
  /** Focus identity within the structural screen. */
  readonly focus: StateFingerprint;
  /** Identity of the ScreenState/FocusState pair. */
  readonly stateValue: string;
  readonly confidence: MatchConfidence;
}

interface StructureComputation {
  readonly signature: string;
  readonly stableIdentifierCount: number;
  readonly roleCount: number;
  readonly geometryCount: number;
  readonly nodeCount: number;
  readonly truncated: boolean;
  readonly selectionCount: number;
  readonly actionModeCount: number;
}

export interface ComputedSnapshotFingerprint {
  readonly fingerprint: SnapshotFingerprint;
  /** Collision-free canonical identities used by the in-memory visited sets. */
  readonly screenIdentity: string;
  readonly focusIdentity: string;
  readonly stateIdentity: string;
}

const MAX_FINGERPRINT_NODES = 2_048;
const MAX_FINGERPRINT_DEPTH = 64;
const MAX_SIGNAL_LENGTH = 256;
const MAX_NAVIGATION_QUERY_LENGTH = 4_096;
const MAX_REPEATED_ITEM_SAMPLES = 32;
const VOLATILE_ROLES: ReadonlySet<string> = new Set([
  "log",
  "marquee",
  "progressbar",
  "status",
  "timer",
]);
const VIRTUALISED_COLLECTION_ROLES: ReadonlySet<string> = new Set([
  "carousel",
  "feed",
  "grid",
  "list",
  "listbox",
  "tree",
]);
const SELECTION_ROLES: ReadonlySet<string> = new Set([
  "button", "checkbox", "radio", "switch", "tab", "option", "menuitemcheckbox", "menuitemradio",
]);
const NAVIGATION_QUERY_KEYS: ReadonlySet<string> = new Set([
  "route", "routevariant", "view", "screen", "tab", "panel", "section", "mode", "page", "step",
  "id", "item", "content", "video", "title", "episode",
]);
const ACTION_MODE_NAMES: ReadonlySet<string> = new Set([
  "play", "playing", "pause", "paused", "resume", "mute", "muted", "unmute", "unmuted",
  "expand", "expanded", "collapse", "collapsed", "enable", "enabled", "disable", "disabled",
  "show", "hide",
]);

const CONFIDENCE_RANK: Readonly<Record<MatchConfidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

function lowestConfidence(left: MatchConfidence, right: MatchConfidence): MatchConfidence {
  return CONFIDENCE_RANK[left] <= CONFIDENCE_RANK[right] ? left : right;
}

function bounded(value: string): string {
  return value.slice(0, MAX_SIGNAL_LENGTH);
}

function normaliseWhitespace(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normaliseGeneratedParts(value: string): string {
  return bounded(normaliseWhitespace(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/giu, "<hex>")
    .replace(/\d+(?:\.\d+)?/gu, "#"));
}

/**
 * Overflow cannot be safely interpreted as a collection of query pairs. Keep a
 * compact identity for the ENTIRE raw value, including the unseen suffix, so
 * two long routes differing beyond the parser budget are not simply merged.
 * Hashing is linear in the already-observed input and constant in extra memory;
 * the query parser and its sorting/allocation never see more than 4 KiB.
 */
function oversizedSelectorIdentity(value: string): string {
  return `!oversized:${value.length}:${hash32(value, 0x811c9dc5)}${hash32(value, 0x9e3779b9)}`;
}

/** Only explicit navigation selectors are identity; clocks, tokens and incidental queries are not. */
function navigationSelectors(value: string): string {
  if (value.length > MAX_NAVIGATION_QUERY_LENGTH) return oversizedSelectorIdentity(value);
  const entries = [...new URLSearchParams(value)].flatMap(([name, selector]) => {
    const key = normaliseWhitespace(name);
    if (!NAVIGATION_QUERY_KEYS.has(key) || selector.trim().length === 0) return [];
    return [`${key}=${normaliseStableIdentifier(selector)}`];
  });
  return entries.sort().join("&");
}

function normaliseLocation(value: string): string {
  const fragmentIndex = value.indexOf("#");
  const beforeFragment = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : value.slice(fragmentIndex + 1);
  const queryIndex = beforeFragment.indexOf("?");
  const path = queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : beforeFragment.slice(queryIndex + 1);
  const pathname = path.replace(/\/+$/u, "");
  // Numeric pathname segments in web apps often select different resources.
  // Folding /title/1 and /title/2 can silently suppress distinct routes.
  // Keep the original generated-number behaviour for app:// observer paths.
  const base = /^https?:\/\//iu.test(pathname)
    ? normaliseStableIdentifier(pathname)
      + (pathname.length > MAX_SIGNAL_LENGTH ? oversizedSelectorIdentity(pathname) : "")
    : normaliseGeneratedParts(pathname);
  const selectors = navigationSelectors(query);
  // Hash routing is a distinct screen; #frame-12 and ordinary anchors are not.
  const hashRoute = fragment.replace(/^!/u, "");
  const hashQueryIndex = hashRoute.indexOf("?");
  const hashPath = hashQueryIndex < 0 ? hashRoute : hashRoute.slice(0, hashQueryIndex);
  const hashQuery = hashQueryIndex < 0 ? "" : navigationSelectors(hashRoute.slice(hashQueryIndex + 1));
  const hashIdentity = hashRoute.startsWith("/")
    ? `path:${hashPath.length > MAX_NAVIGATION_QUERY_LENGTH ? oversizedSelectorIdentity(hashPath) : normaliseStableIdentifier(hashPath)}${hashQuery === "" ? "" : `?${hashQuery}`}`
    : navigationSelectors(hashRoute);
  const suffix = [selectors, hashIdentity].filter((part) => part.length > 0);
  return suffix.length === 0 ? base : `${base}\u001d${suffix.join("\u001d")}`;
}

function normaliseRole(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : normaliseWhitespace(value);
}

function normaliseStableIdentifier(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  // Numeric suffixes in explicit TV/resource IDs are commonly meaningful
  // (card-1, card-2, ...). Only normalise shapes that are overwhelmingly
  // likely to be generated rather than erasing every number.
  return bounded(normaliseWhitespace(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/giu, "<hex>"));
}

function normaliseName(value: string | undefined): string {
  if (value === undefined) return "";
  const label = normaliseWhitespace(value);
  // A focus target without an explicit ID may be a recycled card whose
  // accessible name is its only item identity. Episode/season/chapter numbers
  // identify different activations; treating every digit as volatile merges
  // these distinct focus states. Playback times remain incidental.
  if (/\b(?:episode|season|chapter|part)\s+\d+\b/u.test(label)) {
    return bounded(label.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, "<time>"));
  }
  return normaliseGeneratedParts(value);
}

function finiteBucket(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value / 16)) : "?";
}

function boundsSignature(bounds: ElementBounds | null | undefined): string {
  if (bounds === null || bounds === undefined) {
    return "";
  }
  return [bounds.x, bounds.y, bounds.width, bounds.height].map(finiteBucket).join(",");
}

function observedBoolean(value: boolean | null): string {
  if (value === null) return "?";
  return value ? "1" : "0";
}

/** Recognise a narrow set of mode-changing labels, but not changing media times. */
function actionMode(name: string | null | undefined): string {
  if (name === null || name === undefined) return "";
  const stableName = normaliseWhitespace(name)
    .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/u, "");
  return ACTION_MODE_NAMES.has(stableName) ? stableName : "";
}

function selectionSignature(node: UiNodeSnapshot, role: string, repeatedItem: boolean): string {
  if (node.selectionState === null || !SELECTION_ROLES.has(role)) return "";
  // Non-focusable presentation buttons often mirror selection without being a TV control.
  if (role === "button" && node.focusable === false) return "";
  // Roving selection on equivalent carousel cards changes as the rail scrolls;
  // switches, radios and checkboxes remain material even inside ordinary lists.
  if (repeatedItem && role === "button") return "";
  return `|selected:${node.selectionState}`;
}

function repeatedCollectionPattern(node: UiNodeSnapshot): string | null {
  // Nonfocusable numbered wrappers (e.g. settings row-1/row-2) must not
  // erase the distinct static controls nested inside them.
  if (node.focusable === false || node.stableId === null
    || node.stableId.length > MAX_SIGNAL_LENGTH) return null;
  const identifier = normaliseStableIdentifier(node.stableId);
  if (!/\d/u.test(identifier)) return null;
  const role = normaliseRole(node.role);
  return role === "" ? null : `${role}:${identifier.replace(/\d+/gu, "#")}`;
}

function structureFor(nodes: readonly UiNodeSnapshot[]): StructureComputation {
  let nodeCount = 0;
  let stableIdentifierCount = 0;
  let roleCount = 0;
  let geometryCount = 0;
  let truncated = false;
  let selectionCount = 0;
  let actionModeCount = 0;

  let visitedNodes = 0;
  const visit = (node: UiNodeSnapshot, depth: number, collectionItem: boolean, repeatedItem = false): { signature: string; exposesFocus: boolean } => {
    if (visitedNodes >= MAX_FINGERPRINT_NODES) {
      truncated = true;
      return { signature: "!", exposesFocus: true };
    }
    visitedNodes += 1;
    if (depth >= MAX_FINGERPRINT_DEPTH) {
      truncated = true;
      return { signature: "!", exposesFocus: true };
    }

    const role = normaliseRole(node.role);
    const selection = selectionSignature(node, role, repeatedItem);
    // Collection cards use recycled identifiers. Static settings choices in a
    // list retain their explicit IDs so swapping which control is selected does
    // not collapse to an unordered set of identical selection states.
    const stableIdentifier = repeatedItem && selection.length === 0
      ? ""
      : normaliseStableIdentifier(node.stableId);
    // Hidden DOM is frequently template/sprite/cache state rather than the
    // observable navigation surface. It is excluded only when the driver
    // explicitly reports it as invisible; unknown visibility remains.
    if (node.visible === false) {
      return { signature: "", exposesFocus: false };
    }
    // Live regions and progress/timer nodes are evidence, not screen identity.
    // They commonly appear after the first key press or update every second.
    if (VOLATILE_ROLES.has(role)) {
      return { signature: "", exposesFocus: false };
    }

    nodeCount += 1;
    const geometry = boundsSignature(node.bounds);
    if (stableIdentifier.length > 0) stableIdentifierCount += 1;
    if (role.length > 0) roleCount += 1;
    if (geometry.length > 0) geometryCount += 1;

    const childIsCollectionItem = collectionItem || VIRTUALISED_COLLECTION_ROLES.has(role);
    const repeatedPatterns = new Map<string, number>();
    if (VIRTUALISED_COLLECTION_ROLES.has(role)) {
      // A bounded sibling sample distinguishes repeated numbered cards from
      // ordinary choices without scanning an unbounded virtualised list twice.
      for (let index = 0; index < Math.min(node.children.length, MAX_REPEATED_ITEM_SAMPLES); index += 1) {
        const child = node.children[index];
        if (child === undefined) continue;
        const pattern = repeatedCollectionPattern(child);
        if (pattern !== null) repeatedPatterns.set(pattern, (repeatedPatterns.get(pattern) ?? 0) + 1);
      }
    }
    // Text/icon decoration inside an already focusable control cannot become a
    // distinct TV focus target. Android view binding may add or remove those
    // descendants asynchronously, so retain only children that can expose a
    // nested focus target. Unknown focusability remains conservative.
    const childSignatures: string[] = [];
    let exposesFocus = node.focusable !== false;
    for (const child of node.children) {
      const pattern = repeatedPatterns.size === 0 ? null : repeatedCollectionPattern(child);
      const childRepeated = repeatedItem || (pattern !== null && (repeatedPatterns.get(pattern) ?? 0) >= 2);
      const result = visit(child, depth + 1, childIsCollectionItem, childRepeated);
      exposesFocus ||= result.exposesFocus;
      if (node.focusable !== true || result.exposesFocus) childSignatures.push(result.signature);
      if (visitedNodes >= MAX_FINGERPRINT_NODES) { truncated = true; break; }
    }
    const children = VIRTUALISED_COLLECTION_ROLES.has(role)
      ? [...new Set(childSignatures)].sort().join("")
      : childSignatures.join("");
    // The focused flag is intentionally absent: it belongs to FocusState.
    // Viewport visibility is incidental: scrolling a carousel changes which
    // cards are visible without changing their navigation identity.
    // Absolute bounds are deliberately a confidence signal, not identity:
    // focus transforms and scrollIntoView change them without changing screen.
    // Android frequently toggles `enabled` on presentation-only TextViews while
    // asynchronously rebinding a collection. That cannot change the TV
    // navigation surface when the node is explicitly non-focusable. Preserve
    // enabled state for controls (and unknown focusability), where it remains
    // semantically meaningful.
    const enabled = node.focusable === false ? "-" : observedBoolean(node.enabled);
    if (selection.length > 0) selectionCount += 1;
    const mode = !repeatedItem && role === "button" && node.focusable !== false && stableIdentifier.length > 0
      ? actionMode(node.name)
      : "";
    if (mode.length > 0) actionModeCount += 1;
    return {
      signature: `(${stableIdentifier}|${role}|${enabled}|${observedBoolean(node.focusable)}|${observedBoolean(node.modal)}${selection}${mode === "" ? "" : `|mode:${mode}`}${children})`,
      exposesFocus,
    };
  };

  const roots: string[] = [];
  for (const node of nodes) {
    roots.push(visit(node, 0, false).signature);
    if (visitedNodes >= MAX_FINGERPRINT_NODES) { truncated = true; break; }
  }
  const signature = `${roots.join("")}${truncated ? "!truncated" : ""}`;
  return { signature, stableIdentifierCount, roleCount, geometryCount, nodeCount, truncated,
    selectionCount, actionModeCount };
}

function screenComputation(snapshot: StateSnapshot): {
  readonly signature: string;
  readonly confidence: MatchConfidence;
  readonly signals: readonly FingerprintSignal[];
} {
  const signatures: string[] = [];
  const signals: FingerprintSignal[] = [];
  let independentSignalCount = 0;
  let hasStrongStructure = false;

  if (snapshot.location.status === "available" && snapshot.location.value.trim().length > 0) {
    signatures.push(`location=${normaliseLocation(snapshot.location.value)}`);
    signals.push("location");
    independentSignalCount += 1;
  } else {
    signatures.push("location=?");
  }

  if (snapshot.uiTree.status === "available" && snapshot.uiTree.value.length > 0) {
    const structure = structureFor(snapshot.uiTree.value);
    signatures.push(`tree=${structure.signature}`);
    signals.push("ui-structure");
    independentSignalCount += 1;
    if (structure.stableIdentifierCount > 0) {
      signals.push("stable-identifiers");
      hasStrongStructure = true;
    }
    if (structure.roleCount > 0) signals.push("roles");
    if (structure.geometryCount > 0) signals.push("geometry");
    if (structure.selectionCount > 0) signals.push("selection-state");
    if (structure.actionModeCount > 0) signals.push("action-mode");
    const structurallyTruncated = structure.truncated || omittedUiTreeReasons(snapshot).length > 0;
    if (structurallyTruncated) signals.push("truncated");
    hasStrongStructure ||= structure.nodeCount > 1 && structure.roleCount > 0;
    // Unseen suffixes can contain controls with different navigation behaviour.
    // A strong prefix does not prove the full screen is the same state.
    if (structurallyTruncated) hasStrongStructure = false;
  } else {
    signatures.push("tree=?");
  }

  let confidence: MatchConfidence = independentSignalCount >= 2 || hasStrongStructure
    ? "high"
    : independentSignalCount === 1
      ? "medium"
      : "low";
  if (signals.includes("truncated")) {
    confidence = lowestConfidence(confidence, independentSignalCount >= 2 ? "medium" : "low");
  }
  return {
    signature: signatures.join("\u001f"),
    confidence,
    signals: signals.length === 0 ? ["unavailable"] : signals,
  };
}

function focusTargetSignature(target: FocusTarget): {
  readonly signature: string;
  readonly confidence: MatchConfidence;
  readonly signals: readonly FingerprintSignal[];
} {
  const stableIdentifier = normaliseStableIdentifier(target.stableId);
  const role = normaliseRole(target.role);
  const name = normaliseName(target.name);
  const geometry = boundsSignature(target.bounds);
  // A stable identifier is stronger than a potentially volatile accessible
  // name (for example, a Play button that includes current media time).
  const identityName = stableIdentifier.length > 0 ? "" : name;
  // Recycled TV card slots can keep the same DOM/test identifier as their
  // content is rebound. Numbered episode/season/chapter/part names are
  // explicit navigation targets rather than volatile labels, even when the
  // surrounding slot exposes a stable identifier. Retain that material
  // discriminator without making every changing label an identity change.
  const numberedContentName = stableIdentifier.length > 0
    && /\b(?:episode|season|chapter|part)\s+\d+\b/u.test(name) ? name : "";
  const mode = stableIdentifier.length > 0 && role === "button" ? actionMode(target.name) : "";
  const signals: FingerprintSignal[] = [];
  if (stableIdentifier.length > 0) signals.push("focused-stable-identifier");
  if (role.length > 0) signals.push("focused-role");
  if (identityName.length > 0 || numberedContentName.length > 0) signals.push("focused-name");
  if (stableIdentifier.length === 0 && geometry.length > 0) signals.push("focused-geometry");
  if (mode.length > 0) signals.push("action-mode");

  const confidence: MatchConfidence = stableIdentifier.length > 0
    ? "high"
    : role.length > 0 && (name.length > 0 || geometry.length > 0)
      ? "medium"
      : "low";
  return {
    signature: stableIdentifier.length > 0
      ? `${stableIdentifier}|${role}${mode.length === 0 ? "" : `|mode:${mode}`}${numberedContentName === "" ? "" : `|item:${numberedContentName}`}`
      : `${stableIdentifier}|${role}|${identityName}|${geometry}`,
    confidence,
    signals: signals.length === 0 ? ["unavailable"] : signals,
  };
}

function focusComputation(snapshot: StateSnapshot): {
  readonly signature: string;
  readonly confidence: MatchConfidence;
  readonly signals: readonly FingerprintSignal[];
} {
  if (snapshot.focusedElement.status === "unavailable") {
    return { signature: "focus=?", confidence: "low", signals: ["unavailable"] };
  }
  if (snapshot.focusedElement.value === null) {
    return { signature: "focus=none", confidence: "medium", signals: ["no-focused-element"] };
  }
  return focusTargetSignature(snapshot.focusedElement.value);
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function compactValue(prefix: string, signature: string): string {
  return `${prefix}-${hash32(signature, 0x811c9dc5)}${hash32(signature, 0x9e3779b9)}-${signature.length}`;
}

/**
 * Produces separate structural and focus fingerprints. Text content, focus flags,
 * incidental query strings, fragments, generated numeric/UUID portions, and
 * timestamps are excluded or normalised; explicit navigation route selectors,
 * choice states and well-known button modes remain material.
 */
export function fingerprintSnapshot(snapshot: StateSnapshot): SnapshotFingerprint {
  return computeSnapshotFingerprint(snapshot).fingerprint;
}

export function computeSnapshotFingerprint(snapshot: StateSnapshot): ComputedSnapshotFingerprint {
  const screen = screenComputation(snapshot);
  const focus = focusComputation(snapshot);
  const stateIdentity = `${screen.signature}\u001e${focus.signature}`;
  const fingerprint: SnapshotFingerprint = {
    screen: {
      value: compactValue("screen", screen.signature),
      confidence: screen.confidence,
      signals: screen.signals,
    },
    focus: {
      value: compactValue("focus", focus.signature),
      confidence: focus.confidence,
      signals: focus.signals,
    },
    stateValue: compactValue("state", stateIdentity),
    confidence: lowestConfidence(screen.confidence, focus.confidence),
  };
  return {
    fingerprint,
    screenIdentity: screen.signature,
    focusIdentity: focus.signature,
    stateIdentity,
  };
}
