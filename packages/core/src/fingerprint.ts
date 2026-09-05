import type {
  ElementBounds,
  FocusTarget,
  StateSnapshot,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";

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

function normaliseLocation(value: string): string {
  const withoutVolatileSuffix = value.split(/[?#]/u, 1)[0] ?? value;
  return normaliseGeneratedParts(withoutVolatileSuffix.replace(/\/+$/u, ""));
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
  return value === undefined ? "" : normaliseGeneratedParts(value);
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

function structureFor(nodes: readonly UiNodeSnapshot[]): StructureComputation {
  let nodeCount = 0;
  let stableIdentifierCount = 0;
  let roleCount = 0;
  let geometryCount = 0;
  let truncated = false;

  let visitedNodes = 0;
  const visit = (node: UiNodeSnapshot, depth: number, collectionItem: boolean): { signature: string; exposesFocus: boolean } => {
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
    const stableIdentifier = collectionItem ? "" : normaliseStableIdentifier(node.stableId);
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
    // Text/icon decoration inside an already focusable control cannot become a
    // distinct TV focus target. Android view binding may add or remove those
    // descendants asynchronously, so retain only children that can expose a
    // nested focus target. Unknown focusability remains conservative.
    const childSignatures: string[] = [];
    let exposesFocus = node.focusable !== false;
    for (const child of node.children) {
      const result = visit(child, depth + 1, childIsCollectionItem);
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
    return { signature: `(${stableIdentifier}|${role}|${enabled}|${observedBoolean(node.focusable)}|${observedBoolean(node.modal)}${children})`, exposesFocus };
  };

  const roots: string[] = [];
  for (const node of nodes) {
    roots.push(visit(node, 0, false).signature);
    if (visitedNodes >= MAX_FINGERPRINT_NODES) { truncated = true; break; }
  }
  const signature = `${roots.join("")}${truncated ? "!truncated" : ""}`;
  return { signature, stableIdentifierCount, roleCount, geometryCount, nodeCount };
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
    hasStrongStructure ||= structure.nodeCount > 1 && structure.roleCount > 0;
  } else {
    signatures.push("tree=?");
  }

  const confidence: MatchConfidence = independentSignalCount >= 2 || hasStrongStructure
    ? "high"
    : independentSignalCount === 1
      ? "medium"
      : "low";
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
  const signals: FingerprintSignal[] = [];
  if (stableIdentifier.length > 0) signals.push("focused-stable-identifier");
  if (role.length > 0) signals.push("focused-role");
  if (identityName.length > 0) signals.push("focused-name");
  if (stableIdentifier.length === 0 && geometry.length > 0) signals.push("focused-geometry");

  const confidence: MatchConfidence = stableIdentifier.length > 0
    ? "high"
    : role.length > 0 && (name.length > 0 || geometry.length > 0)
      ? "medium"
      : "low";
  return {
    signature: stableIdentifier.length > 0
      ? `${stableIdentifier}|${role}`
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
 * query strings, fragments, generated numeric/UUID portions, and timestamps are
 * deliberately excluded or normalised to reduce volatile state churn.
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
