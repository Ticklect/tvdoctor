import type {
  FocusTarget,
  StateSnapshot,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { WebElementDescriptor } from "./types.js";

export const WEB_UI_TREE_LIMITS = {
  maxNodes: 4_096,
  maxDepth: 128,
  maxTextLength: 1_024,
  maxAbsoluteCoordinate: 1_000_000,
} as const;

export const UNSAFE_SETTINGS_TERMS = [
  "account",
  "billing",
  "buy",
  "checkout",
  "clear data",
  "confirm purchase",
  "delete",
  "erase",
  "factory reset",
  "log out",
  "logout",
  "order",
  "parental pin",
  "payment",
  "profile",
  "purchase",
  "remove",
  "rent",
  "reset app",
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
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

export interface SemanticNodeEntry {
  readonly node: UiNodeSnapshot;
  readonly ancestors: readonly UiNodeSnapshot[];
  readonly order: number;
}

export type WebSemanticTarget =
  | "details-marker"
  | "search-input"
  | "search-navigation"
  | "search-result"
  | "search-submit"
  | "settings-navigation";

export interface RankedWebCandidate extends SemanticNodeEntry {
  readonly score: number;
  readonly descriptor: WebElementDescriptor;
}

function assertBoundedText(value: unknown, label: string): asserts value is string | null | undefined {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new TypeError(`${label} must be a string, null, or undefined.`);
  }
  if (typeof value === "string" && value.length > WEB_UI_TREE_LIMITS.maxTextLength) {
    throw new RangeError(`${label} exceeded the web semantic text limit.`);
  }
}

function assertNullableBoolean(value: unknown, label: string): void {
  if (value !== null && typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean or null.`);
  }
}

function assertBounds(node: UiNodeSnapshot): void {
  if (node.bounds === null) return;
  const values = [node.bounds.x, node.bounds.y, node.bounds.width, node.bounds.height];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("UI node bounds must contain finite numbers.");
  }
  if (values.some((value) => Math.abs(value) > WEB_UI_TREE_LIMITS.maxAbsoluteCoordinate)) {
    throw new RangeError("UI node bounds exceeded the web coordinate limit.");
  }
  if (node.bounds.width < 0 || node.bounds.height < 0) {
    throw new RangeError("UI node bounds width and height must not be negative.");
  }
}

export function normaliseWebSemanticText(value: string | null | undefined): string {
  if (typeof value === "string" && value.length > WEB_UI_TREE_LIMITS.maxTextLength * 512) {
    throw new RangeError("Semantic text exceeded the bounded normalisation input limit.");
  }
  return value?.normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ") ?? "";
}

export function flattenWebUiTree(nodes: readonly UiNodeSnapshot[]): readonly SemanticNodeEntry[] {
  if (!Array.isArray(nodes)) throw new TypeError("The UI tree roots must be an array.");
  if (nodes.length > WEB_UI_TREE_LIMITS.maxNodes) {
    throw new RangeError("The UI tree exceeded the web semantic node limit.");
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
    const item = pending.pop();
    if (item === undefined) break;
    const { node, ancestors, depth } = item;
    if (typeof node !== "object" || node === null || !Array.isArray(node.children)) {
      throw new TypeError("The UI tree contained a malformed node.");
    }
    if (visited.has(node)) {
      throw new RangeError("The UI tree contained a repeated or cyclic node reference.");
    }
    if (depth > WEB_UI_TREE_LIMITS.maxDepth) {
      throw new RangeError("The UI tree exceeded the web semantic depth limit.");
    }

    visited.add(node);
    assertBoundedText(node.stableId, "UI node stableId");
    assertBoundedText(node.role, "UI node role");
    assertBoundedText(node.name, "UI node name");
    assertBoundedText(node.text, "UI node text");
    assertNullableBoolean(node.visible, "UI node visible");
    assertNullableBoolean(node.enabled, "UI node enabled");
    assertNullableBoolean(node.focusable, "UI node focusable");
    assertNullableBoolean(node.focused, "UI node focused");
    assertNullableBoolean(node.modal, "UI node modal");
    if (node.selectionState !== null && !["on", "off", "mixed"].includes(node.selectionState)) {
      throw new TypeError("UI node selectionState was invalid.");
    }
    if (node.valueNow !== null && !Number.isFinite(node.valueNow)) {
      throw new TypeError("UI node valueNow must be finite or null.");
    }
    assertBounds(node);
    result.push({ node, ancestors, order: result.length });

    if (node.children.length > WEB_UI_TREE_LIMITS.maxNodes) {
      throw new RangeError("The UI tree exceeded the web semantic node limit.");
    }
    if (node.children.length > 0 && depth >= WEB_UI_TREE_LIMITS.maxDepth) {
      throw new RangeError("The UI tree exceeded the web semantic depth limit.");
    }
    scheduled += node.children.length;
    if (scheduled > WEB_UI_TREE_LIMITS.maxNodes) {
      throw new RangeError("The UI tree exceeded the web semantic node limit.");
    }
    const childAncestors = [...ancestors, node];
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push({ node: child, ancestors: childAncestors, depth: depth + 1 });
    }
  }

  return result;
}

function availableEntries(snapshot: StateSnapshot): readonly SemanticNodeEntry[] {
  return snapshot.uiTree.status === "available" ? flattenWebUiTree(snapshot.uiTree.value) : [];
}

/** Restricts matching to the deepest visible modal surface when one exists. */
export function activeWebSurfaceEntries(snapshot: StateSnapshot): readonly SemanticNodeEntry[] {
  const entries = availableEntries(snapshot);
  const modals = entries.filter((entry) => entry.node.visible === true && entry.node.modal === true);
  if (modals.length === 0) return entries;
  const modal = [...modals].sort((left, right) => (
    right.ancestors.length - left.ancestors.length || left.order - right.order
  ))[0];
  if (modal === undefined) return entries;
  return entries.filter((entry) => entry.node === modal.node || entry.ancestors.includes(modal.node));
}

export function ownText(node: UiNodeSnapshot): string {
  return normaliseWebSemanticText([node.name, node.text].filter((value) => value !== null).join(" "));
}

const MAX_VISIBLE_SURFACE_SIGNATURE_ENTRIES = 96;
const MAX_VISIBLE_SURFACE_TEXT_LENGTH = 160;

/**
 * Summarises visible semantic content that appeared after an action but was
 * absent before it. State identity intentionally compresses surfaces to
 * focus/headings/main/modals, so informational additions such as a status note
 * need this bounded companion signal for isolated pointer proofs.
 */
export function distinctVisibleSurfaceChange(
  before: StateSnapshot,
  after: StateSnapshot,
): string | null {
  if (before.uiTree.status === "unavailable" || after.uiTree.status === "unavailable") return null;
  const collect = (roots: readonly UiNodeSnapshot[]): Set<string> => {
    const entries = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0 && entries.size < MAX_VISIBLE_SURFACE_SIGNATURE_ENTRIES) {
      const node = pending.shift();
      if (node === undefined) break;
      if (node.visible === true) {
        const text = ownText(node).slice(0, MAX_VISIBLE_SURFACE_TEXT_LENGTH);
        if (text.length > 0) entries.add(`${normaliseWebSemanticText(node.role)}|${text}`);
      }
      pending.push(...node.children);
    }
    return entries;
  };
  const beforeEntries = collect(before.uiTree.value);
  for (const key of collect(after.uiTree.value)) {
    if (!beforeEntries.has(key)) return key.split("|")[1] ?? null;
  }
  return null;
}

export function webSemanticContext(entry: SemanticNodeEntry): string {
  return normaliseWebSemanticText([
    ...entry.ancestors.flatMap((ancestor) => [ancestor.name, ancestor.text]),
    entry.node.name,
    entry.node.text,
  ].filter((value) => value !== null).join(" "));
}

function hasToken(value: string, token: string): boolean {
  return ` ${value} `.includes(` ${normaliseWebSemanticText(token)} `);
}

export function isWebInteractiveNode(node: UiNodeSnapshot): boolean {
  return INTERACTIVE_ROLES.has(normaliseWebSemanticText(node.role));
}

export function isSafeWebControl(node: UiNodeSnapshot, context = ""): boolean {
  if (node.visible !== true || node.enabled === false || !isWebInteractiveNode(node)) return false;
  const semantics = ` ${normaliseWebSemanticText(`${ownText(node)} ${context}`)} `;
  return !UNSAFE_SETTINGS_TERMS.some((term) => semantics.includes(` ${normaliseWebSemanticText(term)} `));
}

/**
 * Activating ambiguous settings rows can mutate state. Only unmistakable menu
 * navigation is eligible; toggles/value controls and destructive context fail closed.
 */
export function isSafeSettingsSubmenu(entry: SemanticNodeEntry): boolean {
  if (!isSafeWebControl(entry.node, webSemanticContext(entry))) return false;
  if (entry.node.selectionState !== null || entry.node.valueNow !== null) return false;
  const own = ownText(entry.node);
  const role = normaliseWebSemanticText(entry.node.role);
  return role === "link" && /\b(menu|settings|preferences|options|accessibility)\b/u.test(own);
}

export function describeWebElement(node: UiNodeSnapshot): WebElementDescriptor {
  return {
    stableId: node.stableId,
    role: node.role,
    name: node.name ?? node.text,
    bounds: node.bounds,
    visible: node.visible,
    enabled: node.enabled,
    focusable: node.focusable,
  };
}

function scoreCandidate(target: WebSemanticTarget, entry: SemanticNodeEntry): number | null {
  const node = entry.node;
  const own = ownText(node);
  const context = webSemanticContext(entry);
  const role = normaliseWebSemanticText(node.role);
  if (target !== "details-marker" && !isSafeWebControl(node, context)) return null;
  let score = role === "button" ? 20 : role === "link" ? 15 : 8;

  switch (target) {
    case "search-navigation":
      if (!hasToken(own, "search") || role === "textbox" || role === "searchbox") return null;
      if (own === "search") score += 100;
      if (/\b(nav|navigation|primary|rail)\b/u.test(context)) score += 40;
      if (/\b(submit|find|go)\b/u.test(own)) score -= 80;
      return score;
    case "search-input":
      if (role !== "textbox" && role !== "searchbox" && !/\b(query|search input)\b/u.test(own)) return null;
      return score + 140;
    case "search-submit":
      if (!/\b(search|submit|find)\b/u.test(own) || role === "textbox" || role === "searchbox") return null;
      if (/\b(nav|navigation|primary|rail)\b/u.test(context) && own === "search") score -= 100;
      if (/\b(query|results|keyboard|submit)\b/u.test(context)) score += 100;
      return score;
    case "search-result":
      if (/\b(clear|delete|space|keyboard|keypad|submit)\b/u.test(own)) return null;
      if (!/\b(result|results)\b/u.test(context)) return null;
      return score + 120;
    case "settings-navigation":
      if (!hasToken(own, "settings")
        || /\b(account|payment|player)\b/u.test(own)
        || /\b(player controls|while watching|transport controls)\b/u.test(context)) return null;
      if (own === "settings") score += 100;
      if (/\b(nav|navigation|primary|rail)\b/u.test(context)) score += 35;
      return score;
    case "details-marker":
      if (node.visible !== true) return null;
      if (/\b(details|episode|play|resume|watch now)\b/u.test(`${own} ${context}`)) return 100;
      return null;
  }
}

export function rankWebCandidates(
  snapshot: StateSnapshot,
  target: WebSemanticTarget,
): readonly RankedWebCandidate[] {
  return activeWebSurfaceEntries(snapshot)
    .map((entry): RankedWebCandidate | null => {
      const score = scoreCandidate(target, entry);
      return score === null ? null : {
        ...entry,
        score,
        descriptor: describeWebElement(entry.node),
      };
    })
    .filter((entry): entry is RankedWebCandidate => entry !== null)
    .sort((left, right) => (
      right.score - left.score
      || ownText(left.node).localeCompare(ownText(right.node), "en")
      || normaliseWebSemanticText(left.node.role).localeCompare(normaliseWebSemanticText(right.node.role), "en")
      || left.order - right.order
    ));
}

export function rankOnScreenKeyboardKeys(
  snapshot: StateSnapshot,
  character: string,
): readonly RankedWebCandidate[] {
  if ([...character].length !== 1) {
    throw new TypeError("An on-screen keyboard target must be exactly one Unicode code point.");
  }
  const expected = character === " " ? "space" : normaliseWebSemanticText(character);
  return activeWebSurfaceEntries(snapshot)
    .map((entry): RankedWebCandidate | null => {
      const own = ownText(entry.node);
      const context = webSemanticContext(entry);
      if (!isSafeWebControl(entry.node, context)) return null;
      if (!/\b(keyboard|keypad|search key)\b/u.test(context)) return null;
      const ownTokens = own.split(" ").filter((token) => token.length > 0);
      // Browser snapshots can expose the same short label as both accessible
      // name and direct text ("N N"). Accept only a bounded repetition of the
      // exact requested semantic token; unrelated labels remain excluded.
      const exact = character === " "
        ? hasToken(own, "space")
        : ownTokens.length > 0
          && ownTokens.length <= 4
          && ownTokens.every((token) => token === expected);
      if (!exact) return null;
      return {
        ...entry,
        score: 200 + (normaliseWebSemanticText(entry.node.role) === "button" ? 20 : 0),
        descriptor: describeWebElement(entry.node),
      };
    })
    .filter((entry): entry is RankedWebCandidate => entry !== null)
    .sort((left, right) => right.score - left.score || left.order - right.order);
}

function focusMatchesNode(focus: FocusTarget | null, node: UiNodeSnapshot): boolean {
  if (focus?.stableId === undefined || node.stableId === null || focus.stableId !== node.stableId) return false;
  const roleMatches = focus.role === undefined
    || (node.role !== null && normaliseWebSemanticText(focus.role) === normaliseWebSemanticText(node.role));
  const nodeName = node.name ?? node.text;
  const nameMatches = focus.name === undefined
    || (nodeName !== null && normaliseWebSemanticText(focus.name) === normaliseWebSemanticText(nodeName));
  return roleMatches && nameMatches;
}

export function focusedWebEntry(snapshot: StateSnapshot): SemanticNodeEntry | null {
  if (snapshot.focusedElement.status !== "available") return null;
  const focus = snapshot.focusedElement.value;
  if (focus?.stableId === undefined) return null;
  const matches = availableEntries(snapshot).filter((entry) => entry.node.stableId === focus.stableId);
  if (matches.length !== 1) return null;
  const match = matches[0];
  return match !== undefined && focusMatchesNode(focus, match.node) ? match : null;
}

export function focusedWebCandidate(
  snapshot: StateSnapshot,
  target: WebSemanticTarget,
): RankedWebCandidate | null {
  const focused = focusedWebEntry(snapshot);
  if (focused === null) return null;
  const matches = rankWebCandidates(snapshot, target).filter((candidate) => candidate.node === focused.node);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function webDescriptorMatches(
  left: WebElementDescriptor,
  right: WebElementDescriptor,
): boolean {
  if (left.stableId === null || right.stableId === null || left.stableId !== right.stableId) return false;
  const rolesMatch = left.role === null || right.role === null
    || normaliseWebSemanticText(left.role) === normaliseWebSemanticText(right.role);
  const namesMatch = left.name === null || right.name === null
    || normaliseWebSemanticText(left.name) === normaliseWebSemanticText(right.name);
  return rolesMatch && namesMatch;
}

function boundedFocusText(value: string | undefined, label: string): string {
  assertBoundedText(value, label);
  return normaliseWebSemanticText(value);
}

function boundedStableId(value: string | undefined): string {
  assertBoundedText(value, "Focused element stableId");
  return value?.normalize("NFKC") ?? "";
}

export function webSemanticStateIdentity(snapshot: StateSnapshot): string | null {
  if (snapshot.uiTree.status === "unavailable" || snapshot.focusedElement.status === "unavailable") return null;
  const focus = snapshot.focusedElement.value;
  if (focus?.stableId !== undefined && focusedWebEntry(snapshot) === null) {
    return null;
  }
  const surface = activeWebSurfaceEntries(snapshot)
    .filter((entry) => entry.node.visible === true && (
      entry.node.modal === true
      || normaliseWebSemanticText(entry.node.role) === "heading"
      || normaliseWebSemanticText(entry.node.role) === "main"
    ))
    .slice(0, 16)
    .map((entry) => [normaliseWebSemanticText(entry.node.role), ownText(entry.node)]);
  if (focus === null) return JSON.stringify({ focus: null, surface });

  const stableId = boundedStableId(focus.stableId) || null;
  const fallbackBounds = stableId !== null || focus.bounds === undefined
    ? null
    : [focus.bounds.x, focus.bounds.y, focus.bounds.width, focus.bounds.height].map((value) => {
      if (!Number.isFinite(value) || Math.abs(value) > WEB_UI_TREE_LIMITS.maxAbsoluteCoordinate) {
        throw new RangeError("Focused element bounds exceeded the web coordinate limit.");
      }
      return Math.round(value / 8) * 8;
    });
  if (fallbackBounds !== null && ((fallbackBounds[2] ?? 0) < 0 || (fallbackBounds[3] ?? 0) < 0)) {
    throw new RangeError("Focused element bounds width and height must not be negative.");
  }
  return JSON.stringify({
    focus: {
      stableId,
      role: boundedFocusText(focus.role, "Focused element role"),
      name: boundedFocusText(focus.name, "Focused element name"),
      bounds: fallbackBounds,
    },
    surface,
  });
}
