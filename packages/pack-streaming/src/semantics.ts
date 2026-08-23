import type {
  FocusTarget,
  StateSnapshot,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { StreamingElementDescriptor } from "./types.js";

export const STREAMING_DESTRUCTIVE_ACTION_TERMS = [
  "account",
  "buy",
  "checkout",
  "confirm purchase",
  "delete",
  "log out",
  "logout",
  "order",
  "payment",
  "profile",
  "purchase",
  "remove",
  "rent",
  "sign out",
  "subscribe",
  "subscription",
  "trial",
] as const;

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

export interface SemanticNodeEntry {
  readonly node: UiNodeSnapshot;
  readonly ancestors: readonly UiNodeSnapshot[];
  readonly order: number;
}

export interface RankedSemanticCandidate extends SemanticNodeEntry {
  readonly score: number;
  readonly descriptor: StreamingElementDescriptor;
}

export type StreamingSemanticTarget =
  | "appearance"
  | "caption-track"
  | "captions"
  | "content"
  | "play"
  | "seek-backward"
  | "seek-forward"
  | "settings"
  | "text-colour"
  | "toggle-play"
  | "volume-control";

export const STREAMING_UI_TREE_LIMITS = {
  maxNodes: 4_096,
  maxDepth: 128,
  maxTextLength: 1_024,
} as const;

const MAX_NORMALISED_SEMANTIC_INPUT = STREAMING_UI_TREE_LIMITS.maxTextLength
  * (STREAMING_UI_TREE_LIMITS.maxDepth * 3 + 8);

export interface PlaybackProgressObservation {
  readonly descriptor: StreamingElementDescriptor;
  readonly provenance: string;
  readonly value: number;
}

function assertBoundedText(value: unknown, label: string): asserts value is string | null | undefined {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new TypeError(`${label} must be a string, null, or undefined.`);
  }
  if (typeof value === "string" && value.length > STREAMING_UI_TREE_LIMITS.maxTextLength) {
    throw new RangeError(`${label} exceeded the streaming semantic text limit.`);
  }
}

export function normaliseSemanticText(value: string | null | undefined): string {
  if (typeof value === "string" && value.length > MAX_NORMALISED_SEMANTIC_INPUT) {
    throw new RangeError("Semantic text exceeded the bounded normalisation input limit.");
  }
  return value?.normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ") ?? "";
}

function nodeOwnText(node: UiNodeSnapshot): string {
  return normaliseSemanticText([node.name, node.text].filter((value) => value !== null).join(" "));
}

export function semanticContext(entry: SemanticNodeEntry): string {
  return normaliseSemanticText([
    ...entry.ancestors.flatMap((ancestor) => [ancestor.name, ancestor.text]),
    entry.node.name,
    entry.node.text,
  ].filter((value) => value !== null).join(" "));
}

export function describeStreamingElement(node: UiNodeSnapshot): StreamingElementDescriptor {
  return {
    stableId: node.stableId,
    role: node.role,
    name: node.name ?? node.text,
    bounds: node.bounds,
    visible: node.visible,
    enabled: node.enabled,
    focusable: node.focusable,
    selectionState: node.selectionState,
    valueNow: node.valueNow,
  };
}

export function flattenUiTree(nodes: readonly UiNodeSnapshot[]): readonly SemanticNodeEntry[] {
  if (!Array.isArray(nodes)) throw new TypeError("The UI tree roots must be an array.");
  if (nodes.length > STREAMING_UI_TREE_LIMITS.maxNodes) {
    throw new RangeError("The UI tree exceeded the streaming semantic node limit.");
  }
  const result: SemanticNodeEntry[] = [];
  const visited = new Set<UiNodeSnapshot>();
  const pending: {
    readonly node: UiNodeSnapshot;
    readonly ancestors: readonly UiNodeSnapshot[];
    readonly depth: number;
  }[] = [];
  let scheduled = nodes.length;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node !== undefined) pending.push({ node, ancestors: [], depth: 0 });
  }
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { node, ancestors, depth } = current;
    if (typeof node !== "object" || node === null || !Array.isArray(node.children)) {
      throw new TypeError("The UI tree contained a malformed node.");
    }
    if (visited.has(node)) {
      throw new RangeError("The UI tree contained a repeated or cyclic node reference.");
    }
    if (depth > STREAMING_UI_TREE_LIMITS.maxDepth) {
      throw new RangeError("The UI tree exceeded the streaming semantic depth limit.");
    }
    visited.add(node);
    assertBoundedText(node.stableId, "UI node stableId");
    assertBoundedText(node.role, "UI node role");
    assertBoundedText(node.name, "UI node name");
    assertBoundedText(node.text, "UI node text");
    result.push({ node, ancestors, order: result.length });
    if (node.children.length > STREAMING_UI_TREE_LIMITS.maxNodes) {
      throw new RangeError("The UI tree exceeded the streaming semantic node limit.");
    }
    if (node.children.length > 0 && depth >= STREAMING_UI_TREE_LIMITS.maxDepth) {
      throw new RangeError("The UI tree exceeded the streaming semantic depth limit.");
    }
    scheduled += node.children.length;
    if (scheduled > STREAMING_UI_TREE_LIMITS.maxNodes) {
      throw new RangeError("The UI tree exceeded the streaming semantic node limit.");
    }
    const childAncestors = [...ancestors, node];
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        pending.push({ node: child, ancestors: childAncestors, depth: depth + 1 });
      }
    }
  }
  return result;
}

function availableEntries(snapshot: StateSnapshot): readonly SemanticNodeEntry[] {
  return snapshot.uiTree.status === "available" ? flattenUiTree(snapshot.uiTree.value) : [];
}

/** Restricts matching to the deepest visible modal surface when one exists. */
export function activeSurfaceEntries(snapshot: StateSnapshot): readonly SemanticNodeEntry[] {
  const entries = availableEntries(snapshot);
  const modalEntries = entries.filter((entry) => entry.node.visible === true && entry.node.modal === true);
  if (modalEntries.length === 0) return entries;
  const modal = [...modalEntries].sort((left, right) => (
    right.ancestors.length - left.ancestors.length || left.order - right.order
  ))[0];
  if (modal === undefined) return entries;
  return entries.filter((entry) => entry.node === modal.node || entry.ancestors.includes(modal.node));
}

export function isInteractiveNode(node: UiNodeSnapshot): boolean {
  const role = normaliseSemanticText(node.role);
  return INTERACTIVE_ROLES.has(role);
}

export function isSafeStreamingCandidate(
  node: UiNodeSnapshot,
  context = "",
): boolean {
  if (node.visible !== true || node.enabled === false || !isInteractiveNode(node)) return false;
  const semantics = normaliseSemanticText(`${nodeOwnText(node)} ${context}`);
  const paddedSemantics = ` ${semantics} `;
  return !STREAMING_DESTRUCTIVE_ACTION_TERMS.some((term) => (
    paddedSemantics.includes(` ${normaliseSemanticText(term)} `)
  ));
}

function includesAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function hasSemanticToken(value: string, token: string): boolean {
  return ` ${value} `.includes(` ${normaliseSemanticText(token)} `);
}

const CONTENT_CARD_MUTATION_TERMS = [
  "accept",
  "add",
  "apply",
  "back",
  "buy",
  "cancel",
  "claim",
  "clear",
  "confirm",
  "delete",
  "download",
  "enter",
  "favorite",
  "favourite",
  "follow",
  "help",
  "install",
  "like",
  "mark",
  "menu",
  "next",
  "play",
  "previous",
  "privacy",
  "purchase",
  "rate",
  "redeem",
  "remove",
  "rent",
  "resume",
  "save",
  "search",
  "send",
  "settings",
  "share",
  "skip",
  "submit",
  "subscribe",
  "trailer",
  "vote",
  "watchlist",
] as const;

function ancestorSemanticContext(entry: SemanticNodeEntry): string {
  return normaliseSemanticText(entry.ancestors.flatMap((ancestor) => (
    [ancestor.name, ancestor.text]
  )).filter((value) => value !== null).join(" "));
}

function isPositiveContentAction(own: string, entry: SemanticNodeEntry): boolean {
  if (own === "details" || own.startsWith("details ")) return true;
  if (own === "watch now" || own.startsWith("watch now ")) return true;
  if (/\b(open|view|show|explore|browse)\b.*\b(detail|details|film|movie|show|series|programme|program|title|content|episode)\b/u.test(own)) {
    return true;
  }
  const context = ancestorSemanticContext(entry);
  const titleContext = includesAny(context, [
    "catalogue",
    "carousel",
    "content",
    "continue watching",
    "episode",
    "featured",
    "film",
    "movie",
    "poster",
    "programme",
    "recommend",
    "row",
    "series",
    "shelf",
    "show",
    "title",
  ]);
  const genericLabel = new Set([
    "catalogue",
    "continue watching",
    "featured",
    "featured films",
    "film",
    "home",
    "movie",
    "movies",
    "series",
    "show",
    "shows",
  ]).has(own);
  const mutation = CONTENT_CARD_MUTATION_TERMS.some((term) => hasSemanticToken(own, term))
    || own.includes("my list")
    || own.includes("sign in")
    || own.includes("sign out")
    || own.includes("log in")
    || own.includes("log out");
  return titleContext
    && !genericLabel
    && !mutation
    && own.length >= 2
    && own.length <= 160;
}

function hasCaptionTrackSemantics(entry: SemanticNodeEntry, allowOff: boolean): boolean {
  const own = nodeOwnText(entry.node);
  const context = semanticContext(entry);
  if (includesAny(own, ["appearance", "colour", "color"])) return false;
  if (!allowOff && (hasSemanticToken(own, "off") || hasSemanticToken(own, "none"))) return false;
  const direct = includesAny(own, ["caption", "english", "español", "spanish", "subtitle"])
    || hasSemanticToken(own, "cc")
    || (allowOff && (hasSemanticToken(own, "off") || hasSemanticToken(own, "none")));
  const contextualSelection = entry.node.selectionState !== null
    && own.length > 0
    && includesAny(context, ["caption", "subtitle"]);
  return direct || contextualSelection;
}

function targetScore(target: StreamingSemanticTarget, entry: SemanticNodeEntry): number | null {
  const own = nodeOwnText(entry.node);
  const context = semanticContext(entry);
  const role = normaliseSemanticText(entry.node.role);
  if (!isSafeStreamingCandidate(entry.node, context)) return null;

  let score = role === "button" ? 20 : role === "link" ? 12 : 8;
  switch (target) {
    case "content": {
      if (includesAny(own, ["preview", "trailer", "more info"])) return null;
      const explicit = isPositiveContentAction(own, entry);
      const contextual = includesAny(context, [
        "catalogue",
        "continue watching",
        "episode",
        "featured",
        "film",
        "movie",
        "series",
        "show",
      ]);
      if (!explicit) return null;
      if (explicit) score += 80;
      if (contextual) score += 30;
      if (own.includes("details")) score += 20;
      if (entry.node.focusable === true) score += 10;
      return score;
    }
    case "play":
      if (!includesAny(own, ["play", "resume", "watch now"]) || includesAny(own, ["pause", "preview", "trailer"])) return null;
      if (own === "play" || own.startsWith("play ") || own === "resume" || own.startsWith("resume ")) score += 100;
      if (includesAny(context, ["details", "episode"])) score += 35;
      return score;
    case "toggle-play":
      if (!includesAny(own, ["pause", "play"])) return null;
      if (includesAny(context, ["player", "transport", "controls"])) score += 50;
      if (own === "pause" || own === "play") score += 80;
      return score;
    case "volume-control": {
      const volumeSemantics = includesAny(own, [
        "audio boost",
        "boost dialogue",
        "dialogue boost",
        "mute",
        "sound boost",
        "volume",
      ]);
      if (!volumeSemantics || !includesAny(context, ["player", "transport", "controls"])) return null;
      return score + 120;
    }
    case "seek-forward":
      if (!includesAny(own, ["forward", "skip forward", "seek forward"])) return null;
      return score + (includesAny(context, ["player", "transport", "controls"]) ? 100 : 40);
    case "seek-backward":
      if (!includesAny(own, ["rewind", "back 10", "backward", "seek backward"])) return null;
      return score + (includesAny(context, ["player", "transport", "controls"]) ? 100 : 40);
    case "settings":
      if (!own.includes("settings") || includesAny(own, ["account", "app settings"])) return null;
      return score + (includesAny(context, ["player", "playing", "transport", "controls"]) ? 120 : 50);
    case "captions":
      if (!includesAny(own, ["captions", "closed captions", "subtitles"]) && !hasSemanticToken(own, "cc")) return null;
      if (includesAny(own, ["appearance", "colour", "color"])) return null;
      return score + (includesAny(context, ["player settings", "while watching", "controls"]) ? 110 : 60);
    case "caption-track":
      if (!hasCaptionTrackSemantics(entry, false)) return null;
      if (entry.node.selectionState !== "off") return null;
      return score + (includesAny(context, ["caption", "subtitle"]) ? 100 : 30);
    case "appearance":
      if (!includesAny(own, ["appearance", "customisation", "customization", "style"])) return null;
      return score + (includesAny(context, ["caption", "subtitle", "font", "colour", "color"]) ? 120 : 40);
    case "text-colour": {
      const textColour = /\b(text|font|foreground) (colour|color)\b/u.test(own)
        || own.includes("text colour")
        || own.includes("text color")
        || own.includes("font colour")
        || own.includes("font color")
        || own === "colour"
        || own === "color";
      if (!textColour) return null;
      return score + (includesAny(context, ["appearance", "caption", "subtitle"]) ? 140 : 50);
    }
  }
}

export function rankSemanticCandidates(
  snapshot: StateSnapshot,
  target: StreamingSemanticTarget,
): readonly RankedSemanticCandidate[] {
  return activeSurfaceEntries(snapshot)
    .map((entry): RankedSemanticCandidate | null => {
      const score = targetScore(target, entry);
      return score === null ? null : {
        ...entry,
        score,
        descriptor: describeStreamingElement(entry.node),
      };
    })
    .filter((entry): entry is RankedSemanticCandidate => entry !== null)
    .sort((left, right) => {
      const leftOwn = nodeOwnText(left.node);
      const rightOwn = nodeOwnText(right.node);
      const leftContext = semanticContext(left);
      const rightContext = semanticContext(right);
      return right.score - left.score
        || leftOwn.localeCompare(rightOwn, "en")
        || normaliseSemanticText(left.node.role).localeCompare(normaliseSemanticText(right.node.role), "en")
        || leftContext.localeCompare(rightContext, "en")
        || left.order - right.order;
    });
}

export function focusMatchesNode(focus: FocusTarget | null, node: UiNodeSnapshot): boolean {
  if (focus?.stableId === undefined || node.stableId === null || focus.stableId !== node.stableId) {
    return false;
  }
  const roleMatches = focus.role === undefined
    || (node.role !== null
      && normaliseSemanticText(focus.role) === normaliseSemanticText(node.role));
  const nodeName = node.name ?? node.text;
  const nameMatches = focus.name === undefined
    || (nodeName !== null
      && normaliseSemanticText(focus.name) === normaliseSemanticText(nodeName));
  return roleMatches && nameMatches;
}

export function focusedEntry(snapshot: StateSnapshot): SemanticNodeEntry | null {
  if (snapshot.focusedElement.status !== "available") return null;
  const focus = snapshot.focusedElement.value;
  if (focus === null) return null;
  if (focus.stableId === undefined) return null;
  const stableIdMatches = availableEntries(snapshot).filter((entry) => (
    entry.node.stableId === focus.stableId
  ));
  if (stableIdMatches.length !== 1) return null;
  const match = stableIdMatches[0];
  return match !== undefined && focusMatchesNode(focus, match.node) ? match : null;
}

export function focusedCandidate(
  snapshot: StateSnapshot,
  target: StreamingSemanticTarget,
): RankedSemanticCandidate | null {
  const focused = focusedEntry(snapshot);
  if (focused === null) return null;
  const matches = rankSemanticCandidates(snapshot, target).filter((candidate) => (
    candidate.node === focused.node
  ));
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function nodeMatchesStreamingDescriptor(
  node: UiNodeSnapshot,
  descriptor: StreamingElementDescriptor,
): boolean {
  if (
    descriptor.stableId === null
    || node.stableId === null
    || descriptor.stableId !== node.stableId
  ) {
    return false;
  }
  const roleMatches = descriptor.role === null
    || (node.role !== null
      && normaliseSemanticText(descriptor.role) === normaliseSemanticText(node.role));
  const nodeName = node.name ?? node.text;
  const nameMatches = descriptor.name === null
    || (nodeName !== null
      && normaliseSemanticText(descriptor.name) === normaliseSemanticText(nodeName));
  return roleMatches && nameMatches;
}

export function uniqueDescriptorEntry(
  snapshot: StateSnapshot,
  descriptor: StreamingElementDescriptor,
): SemanticNodeEntry | null {
  if (descriptor.stableId === null) return null;
  const allStableIdMatches = availableEntries(snapshot).filter((entry) => (
    entry.node.stableId === descriptor.stableId
  ));
  if (allStableIdMatches.length !== 1) return null;
  const match = allStableIdMatches[0];
  if (match === undefined || !nodeMatchesStreamingDescriptor(match.node, descriptor)) return null;
  return activeSurfaceEntries(snapshot).some((entry) => entry.node === match.node) ? match : null;
}

export function semanticStateIdentity(snapshot: StateSnapshot): string | null {
  if (snapshot.uiTree.status === "unavailable" || snapshot.focusedElement.status === "unavailable") {
    return null;
  }
  const focus = snapshot.focusedElement.value;
  if (focus !== null) {
    assertBoundedText(focus.stableId, "Focused element stableId");
    assertBoundedText(focus.role, "Focused element role");
    assertBoundedText(focus.name, "Focused element name");
  }
  const surface = activeSurfaceEntries(snapshot);
  const surfaceNames = surface
    .filter((entry) => entry.node.visible === true && (
      entry.node.modal === true
      || entry.node.role === "heading"
      || entry.node.role === "main"
    ))
    .map((entry) => [normaliseSemanticText(entry.node.role), nodeOwnText(entry.node)])
    .slice(0, 16);
  const stableFocusId = focus === null ? null : normaliseSemanticText(focus.stableId) || null;
  const fallbackBounds = focus?.bounds === undefined
    || stableFocusId !== null
    || !Number.isFinite(focus.bounds.x)
    || !Number.isFinite(focus.bounds.y)
    || !Number.isFinite(focus.bounds.width)
    || !Number.isFinite(focus.bounds.height)
    ? null
    : [focus.bounds.x, focus.bounds.y, focus.bounds.width, focus.bounds.height]
      .map((value) => Math.round(value / 8) * 8);
  // Stable controls use semantic provenance only because focus transforms and
  // sub-pixel layout can move them across resets. Coarse geometry remains a
  // fallback for observations that do not expose a stable ID.
  const focusIdentity = focus === null ? null : [
    stableFocusId,
    normaliseSemanticText(focus.role),
    normaliseSemanticText(focus.name),
    fallbackBounds,
  ];
  return JSON.stringify({ surfaceNames, focus: focusIdentity });
}

export function semanticElementLabel(
  descriptor: StreamingElementDescriptor | null,
): string | null {
  if (descriptor === null) return null;
  const stableId = descriptor.stableId?.trim();
  if (stableId !== undefined && stableId.length > 0) return stableId;
  const name = descriptor.name?.trim();
  if (name !== undefined && name.length > 0) return name;
  const role = descriptor.role?.trim();
  return role !== undefined && role.length > 0 ? role : null;
}

export function progressValue(snapshot: StateSnapshot): number | null {
  return playbackProgressObservation(snapshot)?.value ?? null;
}

function finiteBoundsIdentity(node: UiNodeSnapshot): readonly number[] | null {
  const bounds = node.bounds;
  if (
    bounds === null
    || !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
  ) {
    return null;
  }
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => Math.round(value * 10) / 10);
}

function playbackProgressProvenance(entry: SemanticNodeEntry): string {
  return JSON.stringify({
    stableId: normaliseSemanticText(entry.node.stableId) || null,
    role: normaliseSemanticText(entry.node.role),
    name: nodeOwnText(entry.node),
    context: normaliseSemanticText(entry.ancestors.flatMap((ancestor) => (
      [ancestor.role, ancestor.name, ancestor.text]
    )).filter((value) => value !== null).join(" ")),
    bounds: finiteBoundsIdentity(entry.node),
  });
}

export function playbackProgressObservation(
  snapshot: StateSnapshot,
  expectedProvenance?: string,
): PlaybackProgressObservation | null {
  const candidates = activeSurfaceEntries(snapshot)
    .filter((entry) => {
      if (
        entry.node.visible !== true
        || normaliseSemanticText(entry.node.role) !== "progressbar"
        || entry.node.valueNow === null
        || !Number.isFinite(entry.node.valueNow)
      ) {
        return false;
      }
      const own = nodeOwnText(entry.node);
      const context = semanticContext(entry);
      if (includesAny(own, ["buffer", "download", "loading"])) return false;
      const ownPlayback = own.length === 0 || includesAny(own, [
        "elapsed",
        "playback",
        "position",
        "progress",
        "seek",
        "time",
        "timeline",
      ]);
      return ownPlayback && includesAny(context, [
        "controls",
        "playback",
        "player",
        "playing",
        "seek",
        "time",
        "timeline",
        "transport",
      ]);
    })
    .map((entry) => ({
      descriptor: describeStreamingElement(entry.node),
      provenance: playbackProgressProvenance(entry),
      value: entry.node.valueNow as number,
    }))
    .filter((candidate) => expectedProvenance === undefined
      || candidate.provenance === expectedProvenance);
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function selectedCaptionTrack(snapshot: StateSnapshot): StreamingElementDescriptor | null {
  if (snapshot.uiTree.status !== "available") return null;
  const stableIdCounts = new Map<string, number>();
  for (const { node } of flattenUiTree(snapshot.uiTree.value)) {
    if (node.stableId !== null) {
      stableIdCounts.set(node.stableId, (stableIdCounts.get(node.stableId) ?? 0) + 1);
    }
  }
  const matches = activeSurfaceEntries(snapshot).filter((entry) => (
    entry.node.visible === true
    && entry.node.selectionState === "on"
    && isInteractiveNode(entry.node)
    && isSafeStreamingCandidate(entry.node, semanticContext(entry))
    && hasCaptionTrackSemantics(entry, true)
    && entry.node.stableId !== null
    && stableIdCounts.get(entry.node.stableId) === 1
  ));
  return matches.length === 1 && matches[0] !== undefined
    ? describeStreamingElement(matches[0].node)
    : null;
}

export function isPlayerSettingsSurface(snapshot: StateSnapshot): boolean {
  return activeSurfaceEntries(snapshot).some((entry) => {
    if (entry.node.visible !== true) return false;
    const role = normaliseSemanticText(entry.node.role);
    if (!new Set(["dialog", "heading", "main"]).has(role)) return false;
    const own = nodeOwnText(entry.node);
    if (!hasSemanticToken(own, "settings")) return false;
    return role === "dialog"
      || includesAny(own, ["playback", "player", "watching"])
      || semanticContext(entry).includes("player");
  });
}
