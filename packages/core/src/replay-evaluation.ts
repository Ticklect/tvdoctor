import type { FocusTarget, StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";

import type {
  ReplayElementSelector,
  ReplayElementStateAssertion,
  ReplayElementStateExpectation,
  ReplayModalOpenIdentity,
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

/**
 * Chromium can focus BODY after an explicit blur while reporting no active
 * interactive focus target. page-observation omits HTML and exposes BODY as
 * one anonymous top-level node. Never disregard a focused identified node.
 */
function meaningfulFocusedNodes(snapshot: StateSnapshot): readonly UiNodeSnapshot[] {
  if (snapshot.uiTree.status !== "available") return [];
  const roots = new Set(snapshot.uiTree.value);
  return flattenUiTree(snapshot.uiTree.value).filter((node) => {
    if (node.focused !== true) return false;
    return !(snapshot.focusedElement.status === "available" && snapshot.focusedElement.value === null
      && roots.has(node) && node.stableId === null && node.role === null && node.name === null);
  });
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

interface CompleteUiTreeMetadata {
  readonly status: "available";
  readonly value: { readonly truncated: false };
}

function hasCompleteUiTree(snapshot: StateSnapshot): boolean {
  const metadata = (snapshot as StateSnapshot & { readonly uiTreeMetadata?: CompleteUiTreeMetadata }).uiTreeMetadata;
  return snapshot.uiTree.status === "available"
    && metadata?.status === "available" && metadata.value?.truncated === false;
}

function namedIdentity(node: UiNodeSnapshot): boolean {
  return typeof node.role === "string" && node.role.trim().length > 0
    && typeof node.name === "string" && node.name.trim().length > 0;
}

function stableIdentity(node: { readonly stableId?: string | null }): boolean {
  return typeof node.stableId === "string" && node.stableId.trim().length > 0;
}

function visibleModal(node: UiNodeSnapshot): boolean {
  return node.visible === true && node.modal === true
    && (node.role === "dialog" || node.role === "alertdialog");
}

/**
 * ID-less dialogs must have one unambiguous, accessible source and modal.
 * Never treat a missing ID as a wildcard for a partially identified source.
 */
function idlessModalCheckpoint(
  snapshot: StateSnapshot,
  sourceElement: string | null,
  expectedModal: string | null,
): { readonly modal: UiNodeSnapshot; readonly source: UiNodeSnapshot } | null {
  if (!hasCompleteUiTree(snapshot) || snapshot.uiTree.status !== "available"
    || snapshot.location.status !== "available"
    || snapshot.focusedElement.status !== "available"
    || sourceElement === null || expectedModal === null) return null;
  const focus = snapshot.focusedElement.value;
  if (focus === null || stableIdentity(focus)
    || typeof focus.role !== "string" || !focus.role.trim()
    || typeof focus.name !== "string" || !focus.name.trim()
    || focus.name !== sourceElement) return null;
  const nodes = flattenUiTree(snapshot.uiTree.value);
  const modals = nodes.filter(visibleModal);
  const focused = nodes.filter((node) => node.focused === true);
  const sources = nodes.filter((node) => node.role === focus.role && node.name === focus.name);
  const modal = modals[0];
  const source = sources[0];
  if (modals.length !== 1 || sources.length !== 1 || focused.length !== 1
    || modal === undefined || source === undefined || focused[0] !== source
    || stableIdentity(modal) || stableIdentity(source)
    || !namedIdentity(modal) || modal.name !== expectedModal
    || source.visible !== true || source.enabled !== true || source.focusable !== true
    || !containsNode(modal, source)) return null;
  return { modal, source };
}

/** Require exact IDs, or an unambiguous wholly ID-less semantic checkpoint, before Tab. */
export function evaluateKeyboardModalCheckpoint(
  snapshot: StateSnapshot,
  sourceElement: string | null,
  expectedModal: string | null,
): PredicateEvaluation {
  if (!hasCompleteUiTree(snapshot)
    || snapshot.uiTree.status !== "available"
    || snapshot.location.status !== "available"
    || snapshot.focusedElement.status !== "available"
    || sourceElement === null || expectedModal === null) {
    return { status: "unobservable", detail: "The modal source checkpoint lacks a complete tree, route or exact source identity." };
  }
  const focus = snapshot.focusedElement.value;
  if (focus === null) {
    return { status: "unobservable", detail: "The original keyboard source has no focus identity." };
  }
  if (!stableIdentity(focus)) {
    const semantic = idlessModalCheckpoint(snapshot, sourceElement, expectedModal);
    if (semantic === null || !retainedModalControls(semantic.modal, semantic.modal, true)) {
      return { status: "unobservable", detail: "The ID-less modal source lacks unique, complete semantic identity." };
    }
    return { status: "match", detail: "Unique named ID-less modal and focused source were observed in a complete tree." };
  }
  const nodes = flattenUiTree(snapshot.uiTree.value);
  const sourceNodes = nodes.filter((node) => node.stableId === focus.stableId);
  const modalNodes = nodes.filter(visibleModal);
  if (sourceNodes.length !== 1 || modalNodes.length !== 1) {
    return { status: "unobservable", detail: "The original focus or modal is not unique in the complete UI tree." };
  }
  const source = sourceNodes[0];
  const modal = modalNodes[0];
  if (source === undefined || modal === undefined
    || source.focused !== true || source.visible !== true || source.enabled !== true
    || source.focusable !== true
    || !stableIdentity(modal)
    || typeof modal.name !== "string" || modal.name.trim().length === 0
    || nodes.filter((node) => node.focused === true).length !== 1) {
    return { status: "unobservable", detail: "The original focus or modal has insufficient trustworthy identity." };
  }
  if (focus.role !== undefined && focus.role !== source.role
    || focus.name !== undefined && focus.name !== source.name) {
    return { status: "unobservable", detail: "The focused target conflicts with its unique UI-tree node." };
  }
  if (focus.stableId !== sourceElement
    || modal.stableId !== expectedModal
    || !containsNode(modal, source)) {
    return { status: "mismatch", detail: "The exact original keyboard source or modal checkpoint changed." };
  }
  return { status: "match", detail: "Exact original modal and focused source were observed in a complete tree." };
}

interface ModalControlIdentity {
  readonly key: string;
  readonly semanticKey: string;
  readonly role: string;
  readonly name: string;
  /** Only accessible, named containers affect the control's semantic parentage. */
  readonly ancestry: readonly string[];
  readonly originalFocusable: boolean;
}

const MAX_MODAL_IDENTITY_NODES = 512;
const MAX_MODAL_FOCUSABLE_CONTROLS = 64;
const MAX_MODAL_SEMANTIC_DEPTH = 32;

/**
 * Snapshot a bounded semantic witness for the original modal's controls.
 * We keep the identity of controls that were usable at the checkpoint, while
 * ignoring unrelated page content, text updates, focus changes and newly
 * introduced controls. A plain anonymous layout wrapper is not semantic
 * parentage; a named group, region, or other accessible container is.
 */
function modalControlIdentities(
  modal: UiNodeSnapshot,
  checkpoint: boolean,
): readonly ModalControlIdentity[] | null {
  const controls: ModalControlIdentity[] = [];
  let focusableCount = 0;
  const pending: { readonly node: UiNodeSnapshot; readonly ancestry: readonly string[] }[] =
    modal.children.map((node) => ({ node, ancestry: [] }));
  const visited = new Set<UiNodeSnapshot>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { node, ancestry } = current;
    if (visited.has(node) || visited.size >= MAX_MODAL_IDENTITY_NODES) return null;
    visited.add(node);
    const originalFocusable = node.focusable === true && node.visible === true && node.enabled === true;
    if (checkpoint && originalFocusable) {
      focusableCount += 1;
      if (typeof node.role !== "string" || node.role.trim().length === 0
        || typeof node.name !== "string" || node.name.trim().length === 0
        || focusableCount > MAX_MODAL_FOCUSABLE_CONTROLS) {
        return null;
      }
    }
    const id = typeof node.stableId === "string" && node.stableId.trim().length > 0
      ? node.stableId : null;
    const role = typeof node.role === "string" && node.role.trim().length > 0 ? node.role : null;
    const name = typeof node.name === "string" && node.name.trim().length > 0 ? node.name : null;
    if (id !== null || (role !== null && name !== null)) {
      controls.push({
        key: id !== null ? `id:${id}` : `name:${JSON.stringify([role, name])}`,
        semanticKey: JSON.stringify([id, role, name]),
        role: role ?? "",
        name: name ?? "",
        ancestry,
        originalFocusable,
      });
    }
    // Named accessible ancestors are stable semantic structure; anonymous
    // layout wrappers and their changing text are intentionally ignored.
    const ancestor = role !== null && name !== null
      ? JSON.stringify([id, role, name]) : null;
    const nextAncestry = ancestor === null ? ancestry : [...ancestry, ancestor];
    if (nextAncestry.length > MAX_MODAL_SEMANTIC_DEPTH) return null;
    for (const child of node.children) pending.push({ node: child, ancestry: nextAncestry });
  }
  return controls;
}

function retainedModalControls(
  before: UiNodeSnapshot,
  after: UiNodeSnapshot,
  idless = false,
): boolean {
  const original = modalControlIdentities(before, true);
  const observed = modalControlIdentities(after, false);
  if (original === null || observed === null) return false;
  const witnessed = original.filter((entry) => entry.originalFocusable);
  if (witnessed.length === 0) return false;
  // A control cannot be proven unchanged if its ID/name is ambiguous in either
  // complete tree. Newly added, independently identified controls are permitted.
  for (const entry of witnessed) {
    if (original.filter((candidate) => candidate.key === entry.key).length !== 1) return false;
    const matches = observed.filter((candidate) => candidate.key === entry.key);
    if (matches.length !== 1) return false;
    const match = matches[0];
    if (match === undefined || !match.originalFocusable
      || match.role !== entry.role || match.name !== entry.name
      || match.ancestry.length !== entry.ancestry.length
      || match.ancestry.some((ancestor, index) => ancestor !== entry.ancestry[index])) return false;
    if (idless && entry.ancestry.some((ancestor) =>
      original.filter((candidate) => candidate.semanticKey === ancestor).length !== 1
      || observed.filter((candidate) => candidate.semanticKey === ancestor).length !== 1)) return false;
  }
  return true;
}

function retainedIdlessModalSource(
  checkpoint: StateSnapshot,
  observed: StateSnapshot,
  sourceName: string,
  modalName: string,
): PredicateEvaluation {
  const original = idlessModalCheckpoint(checkpoint, sourceName, modalName);
  if (original === null || observed.uiTree.status !== "available") {
    return { status: "unobservable", detail: "The ID-less source checkpoint is ambiguous or unavailable." };
  }
  const latest = flattenUiTree(observed.uiTree.value);
  const visibleModals = latest.filter(visibleModal);
  const modal = visibleModals[0];
  const matches = latest.filter((node) => node.role === original.source.role
    && node.name === original.source.name);
  const source = matches[0];
  if (visibleModals.length !== 1 || modal === undefined
    || modal.role !== original.modal.role || modal.name !== original.modal.name
    || stableIdentity(modal)
    || matches.length !== 1 || source === undefined || stableIdentity(source)
    || source.visible !== true || source.enabled !== true || source.focusable !== true
    || !containsNode(modal, source)
    || !retainedModalControls(original.modal, modal, true)) {
    return { status: "unobservable", detail: "The ID-less modal, source or original focusable subtree changed." };
  }
  return { status: "match", detail: "The unique original ID-less modal and source retained semantic hierarchy." };
}

/**
 * Stable modal IDs alone cannot rule out replacing a dialog with an unrelated
 * modal. The original source control must also survive inside that same modal,
 * with its original accessible identity. It need not remain focused after Tab.
 */
export function evaluateRetainedKeyboardSource(
  checkpoint: StateSnapshot,
  observed: StateSnapshot,
  sourceId: string | null,
  modalId: string | null,
): PredicateEvaluation {
  if (sourceId === null || modalId === null || !hasCompleteUiTree(checkpoint)
    || !hasCompleteUiTree(observed) || checkpoint.uiTree.status !== "available"
    || observed.uiTree.status !== "available") {
    return { status: "unobservable", detail: "The original modal source cannot be compared across complete UI trees." };
  }
  // The original focus witness determines which *entire* identity mode is
  // allowed. A partial ID/semantic mismatch cannot downgrade ID requirements.
  const focus = checkpoint.focusedElement.status === "available"
    ? checkpoint.focusedElement.value : null;
  if (focus !== null && !stableIdentity(focus)) {
    return retainedIdlessModalSource(checkpoint, observed, sourceId, modalId);
  }
  const initial = flattenUiTree(checkpoint.uiTree.value);
  const latest = flattenUiTree(observed.uiTree.value);
  const originalSources = initial.filter((node) => node.stableId === sourceId);
  const currentSources = latest.filter((node) => node.stableId === sourceId);
  const originalModals = initial.filter((node) => node.stableId === modalId
    && node.modal === true && node.visible === true
    && (node.role === "dialog" || node.role === "alertdialog"));
  const currentModals = latest.filter((node) => node.stableId === modalId
    && node.modal === true && node.visible === true
    && (node.role === "dialog" || node.role === "alertdialog"));
  if (originalSources.length !== 1 || currentSources.length !== 1
    || originalModals.length !== 1 || currentModals.length !== 1
    || latest.filter((node) => node.visible && node.modal
      && (node.role === "dialog" || node.role === "alertdialog")).length !== 1) {
    return { status: "unobservable", detail: "The original source or retained modal disappeared or became ambiguous." };
  }
  const before = originalSources[0];
  const after = currentSources[0];
  const originalModal = originalModals[0];
  const modal = currentModals[0];
  if (before === undefined || after === undefined || modal === undefined || originalModal === undefined
    || typeof before.role !== "string" || typeof before.name !== "string"
    || !before.name.trim() || typeof after.role !== "string" || typeof after.name !== "string"
    || before.role !== after.role || before.name !== after.name
    || before.visible !== after.visible || before.enabled !== after.enabled
    || before.focusable !== after.focusable || after.focusable !== true
    || typeof originalModal.name !== "string" || !originalModal.name.trim()
    || modal.role !== originalModal.role || modal.name !== originalModal.name
    || !containsNode(originalModal, before)
    || !containsNode(modal, after)
    || !retainedModalControls(originalModal, modal)) {
    return { status: "unobservable", detail: "The modal or its source changed accessible identity or containment." };
  }
  return { status: "match", detail: "The exact original source remained in the original modal." };
}

/** A modal-open fix starts with a unique *opener*; the modal is not yet present. */
export function evaluateModalOpenCheckpoint(
  snapshot: StateSnapshot,
  identity: ReplayModalOpenIdentity,
): PredicateEvaluation {
  if (!hasCompleteUiTree(snapshot) || snapshot.uiTree.status !== "available"
    || snapshot.location.status !== "available"
    || snapshot.focusedElement.status !== "available") {
    return { status: "unobservable", detail: "The modal-open checkpoint requires a complete tree and available focus/route." };
  }
  const nodes = flattenUiTree(snapshot.uiTree.value);
  const modalNodes = nodes.filter((node) => node.modal === true && node.visible === true
    && (node.role === "dialog" || node.role === "alertdialog"));
  const openerNodes = nodes.filter((node) => node.stableId === identity.opener.stableId);
  if (modalNodes.length !== 0 || openerNodes.length !== 1) {
    return { status: "unobservable", detail: "The initial screen must contain one unique opener and no open modal." };
  }
  const opener = openerNodes[0];
  const focus = snapshot.focusedElement.value;
  if (opener === undefined || focus === null
    || focus.stableId !== identity.opener.stableId
    || opener.role !== identity.opener.role || opener.name !== identity.opener.name
    || opener.visible !== true || opener.enabled !== true || opener.focusable !== true
    || opener.focused !== true || meaningfulFocusedNodes(snapshot).length !== 1
    || (focus.role !== undefined && focus.role !== identity.opener.role)
    || (focus.name !== undefined && focus.name !== identity.opener.name)) {
    return { status: "unobservable", detail: "The exact safe modal opener is not uniquely focused at the checkpoint." };
  }
  return { status: "match", detail: "Unique named opener focused with no visible modal before SELECT." };
}

/** Positive before/after oracles for an independently observed safe modal-open SELECT. */
export function evaluateModalOpenOutcome(
  checkpoint: StateSnapshot,
  observed: StateSnapshot,
  identity: ReplayModalOpenIdentity,
  phase: "reproduced" | "fixed",
): PredicateEvaluation {
  const source = evaluateModalOpenCheckpoint(checkpoint, identity);
  if (source.status !== "match") return source;
  if (!hasCompleteUiTree(observed) || observed.uiTree.status !== "available"
    || observed.location.status !== "available"
    || checkpoint.location.status !== "available"
    || observed.location.value !== checkpoint.location.value
    || observed.focusedElement.status !== "available") {
    return { status: "unobservable", detail: "The newly opened modal, focus or original route is not observable." };
  }
  const nodes = flattenUiTree(observed.uiTree.value);
  const modalNodes = nodes.filter((node) => node.modal === true && node.visible === true
    && (node.role === "dialog" || node.role === "alertdialog"));
  const openerNodes = nodes.filter((node) => node.stableId === identity.opener.stableId);
  if (modalNodes.length !== 1 || openerNodes.length !== 1) {
    return { status: "unobservable", detail: "Exactly one visible modal and one retained opener are required." };
  }
  const modal = modalNodes[0];
  const opener = openerNodes[0];
  if (modal === undefined || opener === undefined
    || modal.stableId !== identity.modal.stableId
    || modal.role !== identity.modal.role || modal.name !== identity.modal.name
    || opener.role !== identity.opener.role || opener.name !== identity.opener.name
    || opener.visible !== true || opener.enabled !== true || opener.focusable !== true
    || containsNode(modal, opener)
    || nodes.filter((node) => node.stableId === identity.modal.stableId).length !== 1) {
    return { status: "unobservable", detail: "The modal or opener identity changed after SELECT." };
  }
  const focus = observed.focusedElement.value;
  if (focus === null || typeof focus.stableId !== "string" || focus.stableId.length === 0) {
    return { status: "unobservable", detail: "A unique interactive focus target was not observable after opening the modal." };
  }
  const focusMatches = nodes.filter((node) => node.stableId === focus.stableId);
  const active = focusMatches[0];
  if (focusMatches.length !== 1 || active === undefined || active.focused !== true
    || active.visible !== true || active.enabled !== true || active.focusable !== true
    || meaningfulFocusedNodes(observed).length !== 1
    || (focus.role !== undefined && focus.role !== active.role)
    || (focus.name !== undefined && focus.name !== active.name)) {
    return { status: "unobservable", detail: "After SELECT, focus cannot be uniquely correlated with a visible enabled control." };
  }
  if (phase === "reproduced") {
    return active === opener
      ? { status: "match", detail: "The original opener retained focus outside the newly opened modal." }
      : { status: "mismatch", detail: "Focus did not remain on the opener." };
  }
  return active !== modal && containsNode(modal, active)
    ? { status: "match", detail: "Focus entered an enabled, visible descendant of the exact new modal." }
    : { status: "mismatch", detail: "Focus did not enter the newly opened modal." };
}

function containsNode(root: UiNodeSnapshot, candidate: UiNodeSnapshot): boolean {
  const pending = [root];
  const visited = new Set<UiNodeSnapshot>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || visited.has(node)) continue;
    if (node === candidate) return true;
    visited.add(node);
    pending.push(...node.children);
  }
  return false;
}

function evaluateElementState(
  snapshot: StateSnapshot,
  selector: ReplayElementSelector,
  expectation: ReplayElementStateExpectation,
  checkpointSnapshot?: StateSnapshot,
): PredicateEvaluation {
  if (snapshot.uiTree.status === "unavailable") {
    return { status: "unobservable", detail: `UI tree is unavailable: ${snapshot.uiTree.reason}` };
  }
  const nodes = flattenUiTree(snapshot.uiTree.value);
  const matches = nodes.filter((node) => nodeMatchesSelector(node, selector));
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
  if (assertedProperties.length === 0 && expectation.containsFocus === undefined
    && expectation.focusAbsent === undefined
    && expectation.sameAsCheckpoint !== true) {
    return { status: "match", detail: `${label} is present, as asserted.` };
  }
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
  if (expectation.sameAsCheckpoint === true) {
    if (checkpointSnapshot === undefined || checkpointSnapshot.uiTree.status === "unavailable"
      || !hasCompleteUiTree(snapshot) || !hasCompleteUiTree(checkpointSnapshot)) {
      return { status: "unobservable", detail: `${label} identity could not be compared against a complete checkpoint tree.` };
    }
    const checkpointMatches = flattenUiTree(checkpointSnapshot.uiTree.value)
      .filter((candidate) => nodeMatchesSelector(candidate, selector));
    const checkpointNode = checkpointMatches[0];
    if (checkpointMatches.length !== 1 || checkpointNode === undefined) {
      return { status: "unobservable", detail: `${label} has no unique original identity.` };
    }
    const originalHasId = stableIdentity(checkpointNode);
    const observedHasId = stableIdentity(node);
    if (originalHasId !== observedHasId) {
      return { status: "mismatch", detail: `${label} identity changed after the action.` };
    }
    if (!originalHasId) {
      // Only modal-focus replay uses this ID-less semantic assertion.
      // Everything else retains strict stable-ID requirements.
      if (!((node.role === "dialog" || node.role === "alertdialog")
        && selector.roles !== undefined
        && selector.roles.every((role) => role === "dialog" || role === "alertdialog"))
        || !namedIdentity(checkpointNode) || !namedIdentity(node)
        || checkpointNode.role !== node.role || checkpointNode.name !== node.name
        || checkpointNode.modal !== true || node.modal !== true
        || !retainedModalControls(checkpointNode, node, true)) {
        return { status: "unobservable", detail: `${label} ID-less modal semantic continuity is not established.` };
      }
    } else if (checkpointNode.stableId !== node.stableId) {
      return { status: "mismatch", detail: `${label} identity changed after the action.` };
    }
    // Stable IDs are only selectors. A replacement dialog may deliberately
    // reuse the same DOM id while changing its accessible identity. Do not
    // certify that a different semantic dialog retained the original focus.
    // This is a semantic continuity check, not proof of DOM-node identity.
    if (typeof checkpointNode.role !== "string" || checkpointNode.role.length === 0
      || typeof node.role !== "string" || node.role.length === 0
      || typeof checkpointNode.name !== "string" || checkpointNode.name.trim().length === 0
      || typeof node.name !== "string" || node.name.trim().length === 0) {
      return { status: "unobservable", detail: `${label} has insufficient accessible identity to establish semantic continuity.` };
    }
    if (checkpointNode.role !== node.role || checkpointNode.name !== node.name
      || checkpointNode.modal !== node.modal) {
      return { status: "unobservable", detail: `${label} retained its stable ID but changed accessible identity or modal semantics.` };
    }
  }
  if (expectation.sameLocationAsCheckpoint === true) {
    if (checkpointSnapshot === undefined || snapshot.location.status !== "available"
      || checkpointSnapshot.location.status !== "available"
      || snapshot.location.value !== checkpointSnapshot.location.value) {
      return { status: "unobservable", detail: "The original route did not remain the same after the keyboard action." };
    }
  }
  if (expectation.focusAbsent === true) {
    if (!hasCompleteUiTree(snapshot) || snapshot.focusedElement.status !== "available") {
      return { status: "unobservable", detail: "Absent browser focus could not be confirmed in a complete tree." };
    }
    const focusedNodes = meaningfulFocusedNodes(snapshot);
    if (snapshot.focusedElement.value === null && focusedNodes.length === 0) {
      return { status: "match", detail: "Browser focus was explicitly null and no UI-tree node was focused." };
    }
    if ((snapshot.focusedElement.value === null) !== (focusedNodes.length === 0)) {
      return { status: "unobservable", detail: "Browser focus and complete UI tree disagree about absent focus." };
    }
    return { status: "mismatch", detail: "Browser focus was retained after the keyboard action." };
  }
  if (expectation.containsFocus !== undefined) {
    if (!hasCompleteUiTree(snapshot) || snapshot.focusedElement.status === "unavailable") {
      return { status: "unobservable", detail: `${label} focus containment could not be observed in a complete UI tree.` };
    }
    if (snapshot.focusedElement.value === null) {
      // Explicit null focus disproves positive containment when corroborated
      // by the complete tree. It does NOT prove negative containment; the
      // modal-escape rule requires a uniquely observed outside focus target.
      return meaningfulFocusedNodes(snapshot).length === 0 && expectation.containsFocus === true
        ? { status: "mismatch", detail: `${label} contains no focused descendant.` }
        : { status: "unobservable", detail: `${label} focus containment could not be observed.` };
    }
    const focusedTarget = snapshot.focusedElement.value;
    const matchingFocusNodes = stableIdentity(focusedTarget)
      ? nodes.filter((candidate) => candidate.stableId === focusedTarget.stableId)
      : typeof focusedTarget.role === "string" && focusedTarget.role.trim().length > 0
        && typeof focusedTarget.name === "string" && focusedTarget.name.trim().length > 0
        ? nodes.filter((candidate) => !stableIdentity(candidate)
          && candidate.role === focusedTarget.role && candidate.name === focusedTarget.name)
        : [];
    if (matchingFocusNodes.length !== 1) {
      return { status: "unobservable", detail: "The focused element could not be uniquely matched in the complete UI tree." };
    }
    const focusedNode = matchingFocusNodes[0];
    if (focusedNode === undefined || focusedNode.focused !== true) {
      return { status: "unobservable", detail: "The focused element identity conflicts with its UI-tree focus state." };
    }
    if (focusedNode.visible !== true || focusedNode.enabled !== true || focusedNode.focusable !== true) {
      return { status: "unobservable", detail: "The focused target is not a visible, enabled focusable control." };
    }
    if (focusedTarget.role !== undefined && focusedTarget.role !== focusedNode.role
      || focusedTarget.name !== undefined && focusedTarget.name !== focusedNode.name) {
      return { status: "unobservable", detail: "The focused target's accessible identity conflicts with its tree node." };
    }
    const focusedNodes = nodes.filter((candidate) => candidate.focused === true);
    if (focusedNodes.length !== 1 || focusedNodes[0] !== focusedNode) {
      return { status: "unobservable", detail: "The complete UI tree does not identify exactly one focused element." };
    }
    const isInside = containsNode(node, focusedNode);
    if (isInside !== expectation.containsFocus) {
      return { status: "mismatch", detail: `${label} focus containment did not match the assertion.` };
    }
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
  checkpointSnapshot?: StateSnapshot,
): readonly PredicateEvaluation[] {
  const evaluations: PredicateEvaluation[] = [];
  for (const assertion of assertions) {
    const expectation = assertion[phase];
    if (expectation !== undefined) {
      evaluations.push(evaluateElementState(snapshot, assertion.selector, expectation, checkpointSnapshot));
    }
  }
  return evaluations;
}
