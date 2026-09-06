import type { FocusTarget, StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";

import type {
  ReplayElementSelector,
  ReplayElementStateAssertion,
  ReplayElementStateExpectation,
} from "./replay-contracts.js";

export interface PredicateEvaluation {
  readonly status: "match" | "mismatch" | "unobservable" | "absent";
  readonly detail: string;
}

function focusTargetMatches(target: FocusTarget, label: string): boolean {
  if (target.stableId !== undefined && target.stableId.trim().length > 0) return target.stableId === label;
  if (target.name !== undefined && target.name.trim().length > 0) return target.name === label;
  return target.role === label;
}

export function evaluateFocus(snapshot: StateSnapshot, expected: string | null): PredicateEvaluation {
  if (snapshot.focusedElement.status === "unavailable") {
    return { status: "unobservable", detail: `Focus is unavailable: ${snapshot.focusedElement.reason}` };
  }
  const actual = snapshot.focusedElement.value;
  if (expected === null) {
    return actual === null
      ? { status: "match", detail: "No focus target was observed, as asserted." }
      : { status: "mismatch", detail: "A focus target was observed where none was asserted." };
  }
  if (actual === null) return { status: "mismatch", detail: `Expected focus on ${expected}, but no focus target was observed.` };
  return focusTargetMatches(actual, expected)
    ? { status: "match", detail: `Focus matched ${expected}.` }
    : { status: "mismatch", detail: `Focus did not match ${expected}.` };
}

function flattenUiTree(roots: readonly UiNodeSnapshot[]): readonly UiNodeSnapshot[] {
  const flattened: UiNodeSnapshot[] = [];
  const pending = [...roots].reverse();
  const visited = new Set<UiNodeSnapshot>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || visited.has(node)) continue;
    visited.add(node);
    flattened.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return flattened;
}

function nodeMatchesSelector(node: UiNodeSnapshot, selector: ReplayElementSelector): boolean {
  return (selector.stableId === undefined || node.stableId === selector.stableId)
    && (selector.role === undefined || node.role === selector.role)
    && (selector.roles === undefined || (node.role !== null && selector.roles.includes(node.role)))
    && (selector.name === undefined || node.name === selector.name);
}

function selectorLabel(selector: ReplayElementSelector): string {
  return selector.stableId ?? selector.name ?? selector.role ?? selector.roles?.join(" or ") ?? "element";
}

type ElementStateProperty = "present" | "visible" | "enabled" | "focusable" | "focused" | "modal";

function evaluateElementState(
  snapshot: StateSnapshot,
  selector: ReplayElementSelector,
  expectation: ReplayElementStateExpectation,
): PredicateEvaluation {
  if (snapshot.uiTree.status === "unavailable") {
    return { status: "unobservable", detail: `UI tree is unavailable: ${snapshot.uiTree.reason}` };
  }
  const matches = flattenUiTree(snapshot.uiTree.value).filter((node) => nodeMatchesSelector(node, selector));
  const label = selectorLabel(selector);
  if (expectation.present === false) {
    return matches.length === 0
      ? { status: "match", detail: `${label} is absent, as asserted.` }
      : { status: "mismatch", detail: `${label} is still present.` };
  }
  if (matches.length === 0) return { status: "mismatch", detail: `${label} is absent.` };
  const assertedProperties = ["visible", "enabled", "focusable", "focused", "modal"]
    .filter((key): key is Exclude<ElementStateProperty, "present"> => (
      expectation[key as Exclude<ElementStateProperty, "present">] !== undefined
    ));
  if (assertedProperties.length === 0) return { status: "match", detail: `${label} is present, as asserted.` };
  if (matches.length > 1) {
    return { status: "unobservable", detail: `${label} matched multiple UI nodes, so its state is ambiguous.` };
  }
  const node = matches[0];
  if (node === undefined) return { status: "mismatch", detail: `${label} is absent.` };
  for (const property of assertedProperties) {
    const actual = node[property];
    const expected = expectation[property];
    if (actual === null) return { status: "unobservable", detail: `${label}.${property} is unavailable.` };
    if (actual !== expected) return { status: "mismatch", detail: `${label}.${property} did not match the assertion.` };
  }
  return { status: "match", detail: `${label} matched its asserted state.` };
}

export function combinePredicates(predicates: readonly PredicateEvaluation[]): PredicateEvaluation {
  if (predicates.length === 0) return { status: "absent", detail: "No predicate was supplied." };
  const mismatch = predicates.find((predicate) => predicate.status === "mismatch");
  if (mismatch !== undefined) return mismatch;
  const unobservable = predicates.find((predicate) => predicate.status === "unobservable");
  if (unobservable !== undefined) return unobservable;
  return { status: "match", detail: "Every predicate matched." };
}

export function evaluateElementPhase(
  snapshot: StateSnapshot,
  assertions: readonly ReplayElementStateAssertion[],
  phase: "checkpoint" | "reproduced" | "fixed",
): readonly PredicateEvaluation[] {
  const evaluations: PredicateEvaluation[] = [];
  for (const assertion of assertions) {
    const expectation = assertion[phase];
    if (expectation !== undefined) evaluations.push(evaluateElementState(snapshot, assertion.selector, expectation));
  }
  return evaluations;
}
