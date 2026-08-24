import type { UiNodeSnapshot } from "@tvdoctor/protocol";

/** Independent defensive limits for snapshots supplied by third-party drivers. */
export const NAVIGATION_UI_TREE_LIMITS = {
  maxNodes: 10_000,
  maxDepth: 256,
  maxTextLength: 16_384,
} as const;

export interface BoundedUiTreeEntry {
  readonly node: UiNodeSnapshot;
  readonly ancestors: readonly UiNodeSnapshot[];
  readonly order: number;
}

function assertBoundedText(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${label} must be a string or null.`);
  }
  if (typeof value === "string" && value.length > NAVIGATION_UI_TREE_LIMITS.maxTextLength) {
    throw new RangeError(`${label} exceeded the navigation diagnostic text limit.`);
  }
}

/**
 * Iteratively validates and flattens a driver-owned UI tree. The traversal is
 * deliberately independent from exploration budgets: an untrusted snapshot
 * cannot consume an unbounded call stack or defer validation to a later rule.
 */
export function flattenBoundedUiTree(
  roots: readonly UiNodeSnapshot[],
): readonly BoundedUiTreeEntry[] {
  if (!Array.isArray(roots)) throw new TypeError("The UI tree roots must be an array.");
  if (roots.length > NAVIGATION_UI_TREE_LIMITS.maxNodes) {
    throw new RangeError("The UI tree exceeded the navigation diagnostic node limit.");
  }

  const entries: BoundedUiTreeEntry[] = [];
  const visited = new Set<UiNodeSnapshot>();
  const pending: {
    readonly node: UiNodeSnapshot;
    readonly ancestors: readonly UiNodeSnapshot[];
    readonly depth: number;
  }[] = [];
  let scheduled = roots.length;

  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const node = roots[index];
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
    if (depth > NAVIGATION_UI_TREE_LIMITS.maxDepth) {
      throw new RangeError("The UI tree exceeded the navigation diagnostic depth limit.");
    }

    visited.add(node);
    assertBoundedText(node.stableId, "UI node stableId");
    assertBoundedText(node.role, "UI node role");
    assertBoundedText(node.name, "UI node name");
    assertBoundedText(node.text, "UI node text");
    entries.push({ node, ancestors, order: entries.length });

    if (node.children.length > NAVIGATION_UI_TREE_LIMITS.maxNodes) {
      throw new RangeError("The UI tree exceeded the navigation diagnostic node limit.");
    }
    if (node.children.length > 0 && depth >= NAVIGATION_UI_TREE_LIMITS.maxDepth) {
      throw new RangeError("The UI tree exceeded the navigation diagnostic depth limit.");
    }
    scheduled += node.children.length;
    if (scheduled > NAVIGATION_UI_TREE_LIMITS.maxNodes) {
      throw new RangeError("The UI tree exceeded the navigation diagnostic node limit.");
    }

    const childAncestors = [...ancestors, node];
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        pending.push({ node: child, ancestors: childAncestors, depth: depth + 1 });
      }
    }
  }

  return entries;
}
