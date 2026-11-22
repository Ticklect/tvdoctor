import type { StateSnapshot } from "@tvdoctor/protocol";
import type { ExplorationResult } from "./explorer-contracts.js";
import {
  activeNodes,
  flattenSnapshot,
  frontierCoverageComplete,
  focusNode,
  inSubtree,
  metadataForNode,
  metadataForTarget,
  nodeIdentity,
  focusedTarget,
  semanticFindingIdentity,
  visibleDialog,
} from "./navigation-diagnostic-context.js";
import {
  actionSource,
  diagnosticTarget,
  elementLabel,
  issue,
  type FindingCandidate,
} from "./navigation-diagnostic-findings.js";
import {
  NAVIGATION_DIAGNOSTIC_RULES,
  type NavigationDiagnostics,
} from "./navigation-diagnostic-contracts.js";
import { createSemanticIssueId } from "./semantic-issue-id.js";

function outsideBrowserViewport(snapshot: StateSnapshot): { readonly width: number; readonly height: number } | null {
  const observed = snapshot as StateSnapshot & {
    readonly viewport?: {
      readonly status: "available" | "unavailable";
      readonly value?: { readonly width: unknown; readonly height: unknown };
    };
  };
  if (observed.viewport?.status !== "available") return null;
  const width = observed.viewport.value?.width;
  const height = observed.viewport.value?.height;
  const focus = focusedTarget(snapshot);
  const bounds = focus?.bounds;
  if (typeof width !== "number" || typeof height !== "number"
    || !Number.isFinite(width) || !Number.isFinite(height)
    || width <= 0 || height <= 0 || bounds === undefined
    || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return null;
  // Full exclusion only: a clipped edge is not proof of a user-visible issue.
  return bounds.x + bounds.width <= -2 || bounds.y + bounds.height <= -2
    || bounds.x >= width + 2 || bounds.y >= height + 2
    ? { width, height } : null;
}

/**
 * Production Chromium snapshots wrap tree metadata in an Observation; older
 * driver fixtures sometimes provide a direct { truncated } object. Unknown
 * metadata must never be interpreted as explicit complete coverage.
 */
function treeCoverage(snapshot: StateSnapshot): "complete" | "truncated" | "unknown" {
  const raw = (snapshot as StateSnapshot & { readonly uiTreeMetadata?: unknown }).uiTreeMetadata;
  if (raw === undefined || raw === null || typeof raw !== "object") return "unknown";
  const value = raw as { readonly truncated?: unknown; readonly status?: unknown; readonly value?: unknown };
  const observed = value.status === "available" ? value.value : value.status === undefined ? value : null;
  if (observed === null || typeof observed !== "object") return "unknown";
  const truncated = (observed as { readonly truncated?: unknown }).truncated;
  return truncated === true ? "truncated" : truncated === false ? "complete" : "unknown";
}

/** A missing/truncated DOM or a second modal makes containment ambiguous. */
function soleObservedModal(snapshot: StateSnapshot): ReturnType<typeof visibleDialog> {
  if (snapshot.uiTree.status !== "available") return null;
  if (treeCoverage(snapshot) === "truncated") return null;
  // An explicitly unavailable production metadata observation is not proof.
  if ((snapshot as StateSnapshot & { readonly uiTreeMetadata?: unknown }).uiTreeMetadata !== undefined
    && treeCoverage(snapshot) === "unknown") return null;
  const dialogs = flattenSnapshot(snapshot).filter(({ node, ancestors }) =>
    node.modal === true && node.visible === true
    && ancestors.every((ancestor) => ancestor.visible === true)
    && (node.role === "dialog" || node.role === "alertdialog"));
  return dialogs.length === 1 ? dialogs[0] ?? null : null;
}

function sameObservedLocation(before: StateSnapshot, after: StateSnapshot): boolean {
  return before.location.status === "available" && after.location.status === "available"
    && before.location.value === after.location.value;
}

/**
 * Unlike a dismissing Escape, Tab leaving an unchanged active modal with no
 * browser focus has an independent positive fix predicate: focus is restored
 * to a visible, enabled descendant of that same modal after the same key.
 * Only complete Chromium-style tree observations can establish this defect.
 */
function retainedModalWithLostKeyboardFocus(
  before: StateSnapshot,
  after: StateSnapshot,
  beforeNodes: ReturnType<typeof flattenSnapshot>,
  afterNodes: ReturnType<typeof flattenSnapshot>,
): { readonly source: ReturnType<typeof metadataForNode>; readonly dialog: ReturnType<typeof metadataForNode> } | null {
  if (treeCoverage(before) !== "complete" || treeCoverage(after) !== "complete"
    || !sameObservedLocation(before, after)
    || after.focusedElement.status !== "available" || after.focusedElement.value !== null) return null;

  const beforeDialog = soleObservedModal(before);
  const afterDialog = soleObservedModal(after);
  if (beforeDialog === null || afterDialog === null) return null;
  const modalId = beforeDialog.node.stableId;
  if (modalId === null || modalId.trim().length === 0
    || beforeDialog.node.name === null || beforeDialog.node.name.trim().length === 0
    || beforeDialog.node.role !== afterDialog.node.role
    || beforeDialog.node.name !== afterDialog.node.name
    || modalId !== afterDialog.node.stableId
    || beforeNodes.filter((entry) => entry.node.stableId === modalId).length !== 1
    || afterNodes.filter((entry) => entry.node.stableId === modalId).length !== 1) return null;

  const sourceFocus = focusedTarget(before);
  const source = focusNode(before, beforeNodes);
  const sourceId = source?.node.stableId;
  if (source === null || sourceId === null || sourceId === undefined || sourceId.trim().length === 0
    || sourceFocus === null || sourceFocus.stableId !== sourceId
    || sourceFocus.role !== source.node.role || sourceFocus.name !== source.node.name
    || !inSubtree(source, beforeDialog) || source.node === beforeDialog.node
    || source.node.focused !== true || source.node.visible !== true
    || source.node.enabled !== true || source.node.focusable !== true
    || beforeNodes.filter((entry) => entry.node.focused === true).length !== 1
    || beforeNodes.filter((entry) => entry.node.stableId === sourceId).length !== 1) return null;

  // A replaced modal or an absent/disabled source control cannot prove the
  // same interaction was retained. Chromium's page observation includes body
  // as the single root, but the normalised UI-tree protocol drops HTML tags.
  // After blur(), this root can be marked focused+focusable even while the
  // canonical focusedElement is available(null). Allow only that structural
  // root, never a focused descendant or an ambiguous forest.
  const retainedSources = afterNodes.filter((entry) => entry.node.stableId === sourceId
    && inSubtree(entry, afterDialog) && entry.node.visible === true
    && entry.node.enabled === true && entry.node.focusable === true
    && entry.node.role === source.node.role && entry.node.name === source.node.name);
  const roots = afterNodes.filter((entry) => entry.ancestors.length === 0);
  const structuralRoot = roots.length === 1 && roots[0]?.node.role === null
    && roots[0]?.node.stableId === null ? roots[0] : null;
  if (retainedSources.length !== 1 || afterNodes.some((entry) => {
    if (entry.node.focused !== true || entry.node.focusable !== true) return false;
    return entry !== structuralRoot;
  })) return null;

  return { source: metadataForNode(source.node), dialog: metadataForNode(afterDialog.node) };
}

/**
 * A new aria-modal dialog must receive keyboard focus when opened by a
 * keyboard-activated control. Require a source control that remains unchanged
 * and focused, a newly observed unique modal with an eligible descendant, and
 * complete snapshots on the same route. Preserve the original post-action
 * dialog's accessible identity for independent replay verification.
 */
function modalOpenedWithoutFocusTransfer(
  before: StateSnapshot,
  after: StateSnapshot,
  beforeNodes: ReturnType<typeof flattenSnapshot>,
  afterNodes: ReturnType<typeof flattenSnapshot>,
): { readonly opener: ReturnType<typeof metadataForNode>; readonly dialog: ReturnType<typeof metadataForNode> } | null {
  if (treeCoverage(before) !== "complete" || treeCoverage(after) !== "complete"
    || !sameObservedLocation(before, after)) return null;
  if (beforeNodes.some((entry) => entry.node.modal === true && entry.node.visible === true
    && (entry.node.role === "dialog" || entry.node.role === "alertdialog")
    && entry.ancestors.every((ancestor) => ancestor.visible === true))) return null;

  const modal = soleObservedModal(after);
  const modalNode = modal?.node;
  if (modal === null || modalNode === undefined || modalNode.stableId === null
    || modalNode.stableId.trim().length === 0 || modalNode.stableId.length > 256
    || modalNode.name === null || modalNode.name.trim().length === 0 || modalNode.name.length > 256
    || afterNodes.filter((entry) => entry.node.stableId === modalNode.stableId).length !== 1) return null;

  const initialTarget = focusedTarget(before);
  const initial = focusNode(before, beforeNodes);
  const sourceId = initial?.node.stableId;
  if (initialTarget === null || initial === null || sourceId === null || sourceId === undefined
    || sourceId.trim().length === 0 || sourceId.length > 256
    || initial.node.role !== "button" || initial.node.name === null
    || initial.node.name.trim().length === 0 || initial.node.name.length > 256
    || initialTarget.stableId !== sourceId || initialTarget.role !== initial.node.role
    || initialTarget.name !== initial.node.name
    || initial.node.focused !== true || initial.node.visible !== true
    || initial.node.enabled !== true || initial.node.focusable !== true
    || beforeNodes.filter((entry) => entry.node.focused === true).length !== 1
    || beforeNodes.filter((entry) => entry.node.stableId === sourceId).length !== 1) return null;

  const laterTarget = focusedTarget(after);
  const later = focusNode(after, afterNodes);
  if (laterTarget === null || later === null || later.node.stableId !== sourceId
    || laterTarget.stableId !== sourceId || laterTarget.role !== initial.node.role
    || laterTarget.name !== initial.node.name
    || later.node.role !== initial.node.role || later.node.name !== initial.node.name
    || later.node.focused !== true || later.node.visible !== true
    || later.node.enabled !== true || later.node.focusable !== true
    || inSubtree(later, modal)
    || afterNodes.filter((entry) => entry.node.stableId === sourceId).length !== 1
    || afterNodes.filter((entry) => entry.node.focused === true).length !== 1) return null;

  // This modal has an actionable focus destination; an empty decorative panel
  // would not independently prove a focus-transfer defect.
  if (!afterNodes.some((entry) => inSubtree(entry, modal) && entry.node !== modalNode
    && entry.node.stableId !== null && entry.node.visible === true
    && entry.node.enabled === true && entry.node.focusable === true)) return null;

  return { opener: metadataForNode(initial.node), dialog: metadataForNode(modalNode) };
}

/**
 * Keyboard-specific diagnostics for a bounded, observed focus graph. These
 * deliberately avoid spatial D-pad expectations and do not infer that Tab
 * wrapping or moving to browser chrome is a failure.
 */
export function diagnoseKeyboardNavigation(result: ExplorationResult): NavigationDiagnostics {
  const screens = new Map(result.graph.screens.states.map((screen) => [screen.id, screen]));
  const findings = new Map<string, FindingCandidate>();

  const add = (finding: FindingCandidate): void => {
    const identity = semanticFindingIdentity(finding, screens);
    if (!findings.has(identity)) findings.set(identity, finding);
  };

  for (const attempt of result.graph.actions) {
    if (attempt.actionResult.key !== attempt.key
      || attempt.actionResult.outcome !== "applied"
      || attempt.toScreenStateId === null
      || attempt.toFocusStateId === null) continue;

    const beforeNodes = flattenSnapshot(attempt.beforeSnapshot);
    const afterNodes = flattenSnapshot(attempt.afterSnapshot);
    if (attempt.key === "BACK") {
      const beforeDialog = soleObservedModal(attempt.beforeSnapshot);
      if (beforeDialog !== null && attempt.afterSnapshot.uiTree.status === "available"
        && treeCoverage(attempt.afterSnapshot) !== "truncated"
        && ((attempt.afterSnapshot as StateSnapshot & { readonly uiTreeMetadata?: unknown }).uiTreeMetadata === undefined
          || treeCoverage(attempt.afterSnapshot) === "complete")
        && visibleDialog(afterNodes) === null
        && sameObservedLocation(attempt.beforeSnapshot, attempt.afterSnapshot)
        && focusNode(attempt.beforeSnapshot, beforeNodes) !== null
        && attempt.afterSnapshot.focusedElement.status === "available"
        && attempt.afterSnapshot.focusedElement.value === null
        && activeNodes(attempt.afterSnapshot).some((entry) => entry.node.focusable === true
          && entry.node.enabled === true && entry.node.visible === true)) {
        const dialogElement = metadataForNode(beforeDialog.node);
        const classification = "heuristic" as const;
        add({
          classification,
          issue: issue(
            NAVIGATION_DIAGNOSTIC_RULES.keyboardEscapeFocusLoss,
            classification,
            "medium",
            "Focus was lost when Escape closed a modal",
            "After an applied Escape input closed an observed dialog, browser focus was absent despite visible controls. This may be intentional; review the dismissal context.",
            attempt.toScreenStateId,
            "Focus returns to a meaningful control after the dialog is dismissed.",
            "The dialog closed and the browser reported no focused element.",
            { fromElement: elementLabel(dialogElement), action: "BACK", expectedElement: null, observedElement: null },
            attempt.actionSequence,
            "Observed Escape dismissal and missing focus, with visible focusable page controls. This is review-only; the original trigger was not proven.",
            attempt.id,
            "reload",
          ),
          source: actionSource(attempt),
          target: diagnosticTarget(attempt.toScreenStateId, attempt.toFocusStateId, null, null, null),
        });
      }
      continue;
    }
    if (attempt.key === "SELECT") {
      const opened = modalOpenedWithoutFocusTransfer(
        attempt.beforeSnapshot, attempt.afterSnapshot, beforeNodes, afterNodes,
      );
      if (opened !== null) {
        const classification = "deterministic" as const;
        add({
          classification,
          issue: issue(
            NAVIGATION_DIAGNOSTIC_RULES.keyboardModalOpenFocusNotTransferred,
            classification,
            "high",
            "Opening a modal did not transfer keyboard focus into it",
            "Select opened a new visible modal dialog, but focus remained on the original page button outside the modal.",
            attempt.toScreenStateId,
            `Focus transfers to a visible enabled control inside ${elementLabel(opened.dialog) ?? "the new modal"}.`,
            `The newly opened modal stayed visible while ${elementLabel(opened.opener) ?? "its trigger"} retained keyboard focus.`,
            {
              fromElement: elementLabel(opened.opener), action: "SELECT",
              expectedElement: elementLabel(opened.dialog), observedElement: elementLabel(opened.opener),
            },
            attempt.actionSequence,
            "Complete same-route Chromium snapshots show a uniquely identified keyboard opener, no prior active modal, and a new visible modal with eligible controls while browser focus remained on the opener.",
            attempt.id,
            "reload",
            [{
              kind: "verified-fact",
              source: "tvdoctor.keyboard.modal-open/v1",
              summary: JSON.stringify({
                modal: {
                  stableId: opened.dialog.stableId,
                  role: opened.dialog.role,
                  name: opened.dialog.name,
                },
                opener: {
                  stableId: opened.opener.stableId,
                  role: opened.opener.role,
                  name: opened.opener.name,
                },
              }),
              artifact: null,
            }],
          ),
          source: actionSource(attempt),
          target: diagnosticTarget(
            attempt.toScreenStateId, attempt.toFocusStateId,
            opened.dialog, opened.dialog, opened.opener,
          ),
        });
      }
      continue;
    }
    if (attempt.key !== "TAB" && attempt.key !== "SHIFT_TAB") continue;
    const modalFocusLoss = retainedModalWithLostKeyboardFocus(
      attempt.beforeSnapshot, attempt.afterSnapshot, beforeNodes, afterNodes,
    );
    if (modalFocusLoss !== null) {
      const classification = "deterministic" as const;
      add({
        classification,
        issue: issue(
          NAVIGATION_DIAGNOSTIC_RULES.keyboardModalTabFocusLoss,
          classification,
          "high",
          "Tab removed keyboard focus from an active modal",
          "The same observed modal remained open after Tab, but the browser lost focus while its original focusable control was still present.",
          attempt.toScreenStateId,
          `Focus stays on a visible, enabled descendant of ${elementLabel(modalFocusLoss.dialog) ?? "the active modal"}.`,
          "The browser reported no focused element after Tab while the same modal and source control remained present.",
          {
            fromElement: elementLabel(modalFocusLoss.source),
            action: attempt.key,
            expectedElement: elementLabel(modalFocusLoss.dialog),
            observedElement: null,
          },
          attempt.actionSequence,
          "Complete before/after DOM trees identified one unchanged visible modal and source control; applied Tab left browser focus explicitly null with no other focusable tree node focused.",
          attempt.id,
          "reload",
        ),
        source: actionSource(attempt),
        target: diagnosticTarget(
          attempt.toScreenStateId, attempt.toFocusStateId,
          modalFocusLoss.dialog, modalFocusLoss.dialog, null,
        ),
      });
    }
    const offscreen = outsideBrowserViewport(attempt.afterSnapshot);
    const afterFocused = focusNode(attempt.afterSnapshot, afterNodes);
    const afterTarget = focusedTarget(attempt.afterSnapshot);
    if (offscreen !== null && afterFocused?.node.visible === true
      && afterFocused.node.focused === true && afterFocused.node.focusable === true
      && afterTarget !== null) {
      const observedElement = metadataForTarget(afterTarget);
      const classification = "heuristic" as const;
      add({
        classification,
        issue: issue(
          NAVIGATION_DIAGNOSTIC_RULES.keyboardOffscreenFocus,
          classification,
          "medium",
          "Keyboard focus is outside the browser viewport",
          "After an applied Tab input, the browser's focused element has bounds entirely outside the observed viewport. Scrolling or intentional positioning may explain this; review the visual evidence.",
          attempt.toScreenStateId,
          "The active keyboard focus target is visible within the viewport after focus settles.",
          `Focus is entirely outside the ${String(offscreen.width)}×${String(offscreen.height)} viewport.`,
          { fromElement: null, action: attempt.key, expectedElement: null, observedElement: elementLabel(observedElement) },
          attempt.actionSequence,
          "The browser reported a focused, visible and focusable node whose captured viewport-relative rectangle did not intersect the available viewport; this is a review-only geometric observation.",
          attempt.id,
          "reload",
        ),
        source: actionSource(attempt),
        target: diagnosticTarget(attempt.toScreenStateId, attempt.toFocusStateId, observedElement, null, observedElement),
      });
    }
    const beforeDialog = soleObservedModal(attempt.beforeSnapshot);
    const afterDialog = soleObservedModal(attempt.afterSnapshot);
    if (beforeDialog === null || afterDialog === null) continue;

    // Both observations must identify the same still-open modal. A dialog
    // dismissal followed by movement to page content is valid navigation.
    const dialogIdentity = nodeIdentity(beforeDialog.node);
    if (dialogIdentity === null || dialogIdentity !== nodeIdentity(afterDialog.node)
      || !sameObservedLocation(attempt.beforeSnapshot, attempt.afterSnapshot)) continue;

    const beforeFocus = focusNode(attempt.beforeSnapshot, beforeNodes);
    const afterFocus = focusNode(attempt.afterSnapshot, afterNodes);
    if (beforeFocus === null || afterFocus === null
      || !inSubtree(beforeFocus, beforeDialog)
      || inSubtree(afterFocus, afterDialog)
      || beforeFocus.node.visible !== true
      || afterFocus.node.visible !== true
      || beforeFocus.node.focused !== true
      || afterFocus.node.focused !== true) continue;

    const sourceElement = metadataForNode(beforeFocus.node);
    const observedElement = metadataForNode(afterFocus.node);
    const dialogElement = metadataForNode(afterDialog.node);
    const classification = "deterministic" as const;
    const finding: FindingCandidate = {
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.keyboardModalFocusEscape,
        classification,
        "high",
        "Keyboard focus escapes an open modal dialog",
        "Tab moved focus from inside an open modal to a control outside it while the same modal remained visible.",
        attempt.toScreenStateId,
        `Focus stays within ${elementLabel(dialogElement) ?? "the open modal"} until the modal closes.`,
        `${attempt.key} moved focus to ${elementLabel(observedElement) ?? "a page control"} outside the still-open modal.`,
        {
          fromElement: elementLabel(sourceElement),
          action: attempt.key,
          expectedElement: elementLabel(dialogElement),
          observedElement: elementLabel(observedElement),
        },
        attempt.actionSequence,
        "Before and after the applied keyboard action, the same modal was visible. Exactly matched focus moved from a modal descendant to a visible control outside its subtree.",
        attempt.id,
        "reload",
      ),
      source: actionSource(attempt),
      target: diagnosticTarget(
        attempt.toScreenStateId,
        attempt.toFocusStateId,
        dialogElement,
        dialogElement,
        observedElement,
      ),
    };
    add(finding);
  }

  // A stuck sequential focus is a lead, not proof. A page can legitimately
  // contain a one-control modal or custom tab cycle. Require BOTH directions,
  // at least one other eligible sibling, and a fully exhausted known frontier.
  if (frontierCoverageComplete(result)
    && result.actionOrder.includes("TAB") && result.actionOrder.includes("SHIFT_TAB")) {
    for (const state of result.graph.focus.states) {
      const currentId = focusedTarget(state.representativeSnapshot)?.stableId;
      if (currentId === undefined) continue;
      const siblingCount = activeNodes(state.representativeSnapshot).filter((entry) =>
        entry.node.visible === true && entry.node.enabled === true
        && entry.node.focusable === true && entry.node.stableId !== null
        && entry.node.stableId !== currentId).length;
      if (siblingCount === 0) continue;
      const outgoing = result.graph.actions.filter((attempt) => attempt.fromFocusStateId === state.id
        && attempt.actionResult.outcome === "applied");
      const stuck = (["TAB", "SHIFT_TAB"] as const).every((key) => {
        const attempts = result.graph.actions.filter((attempt) =>
          attempt.fromFocusStateId === state.id && attempt.key === key);
        return attempts.length > 0 && attempts.every((attempt) =>
          attempt.actionResult.key === key
          && attempt.actionResult.outcome === "applied"
          && attempt.toScreenStateId === state.screenStateId
          && attempt.toFocusStateId === state.id
          && focusedTarget(attempt.beforeSnapshot)?.stableId === currentId
          && focusedTarget(attempt.afterSnapshot)?.stableId === currentId);
      });
      if (!stuck) continue;
      const witness = outgoing.find((attempt) => attempt.key === "TAB");
      if (witness === undefined) continue;
      const element = focusedTarget(witness.beforeSnapshot);
      const metadata = element === null ? null : metadataForTarget(element);
      const classification = "heuristic" as const;
      add({
        classification,
        issue: issue(
          NAVIGATION_DIAGNOSTIC_RULES.keyboardPossibleTrap,
          classification,
          "medium",
          "Possible keyboard focus trap",
          "Tab and Shift+Tab both returned to the same observed control while other active focusable controls were visible. This pattern needs manual confirmation.",
          state.screenStateId,
          "At least one adjacent eligible control can be reached by sequential keyboard navigation.",
          `${String(siblingCount)} other eligible controls were visible; both tested directions stayed on the same focused control.`,
          { fromElement: elementLabel(metadata), action: "TAB", expectedElement: null, observedElement: elementLabel(metadata) },
          witness.actionSequence,
          "Both directional tab inputs were applied and directly observed as self-loops from a fully explored state. Focus-trap intent is unverified.",
          witness.id,
          "reload",
        ),
        source: actionSource(witness, "action-pair", outgoing.find((entry) => entry.key === "SHIFT_TAB")?.id ?? null, true),
        target: diagnosticTarget(state.screenStateId, state.id, metadata, null, metadata),
      });
    }
  }

  // Only consider observed, stable, enabled, sequentially focusable controls
  // in a fully enumerated screen. Missing targets in partial runs are untested,
  // never "unreachable" findings. Dynamic content and deliberate tab order
  // still require human review.
  if (frontierCoverageComplete(result) && result.actionOrder.includes("TAB")) {
    for (const screen of result.graph.screens.states) {
      const root = screen.representativeSnapshot;
      if (root.uiTree.status !== "available" || treeCoverage(root) !== "complete") continue;
      const states = result.graph.focus.states.filter((state) => state.screenStateId === screen.id);
      const observedIds = new Set(states.flatMap((state) => {
        const id = focusedTarget(state.representativeSnapshot)?.stableId;
        return id === undefined ? [] : [id];
      }));
      const candidates = activeNodes(root).filter(({ node }) =>
        node.stableId !== null && node.visible === true
        && node.focusable === true && node.enabled === true
        && (node.role === "button" || node.role === "link")
        && !observedIds.has(node.stableId));
      // A representative snapshot alone may contain a transient control
      // removed on the very next focus state. Never call that unreachable.
      const stableCandidate = (id: string): boolean => states.length > 0 && states.every((state) => {
        if (state.representativeSnapshot.uiTree.status !== "available") return false;
        if (treeCoverage(state.representativeSnapshot) !== "complete") return false;
        const matching = activeNodes(state.representativeSnapshot).filter(({ node }) =>
          node.stableId === id && node.visible === true
          && node.enabled === true && node.focusable === true);
        return matching.length === 1;
      });
      const identities = candidates.map(({ node }) => node.stableId);
      // Duplicate IDs make target matching ambiguous; do not report them.
      for (const { node } of candidates.slice(0, 32)) {
        if (identities.filter((id) => id === node.stableId).length !== 1) continue;
        if (node.stableId === null || !stableCandidate(node.stableId)) continue;
        const metadata = metadataForNode(node);
        const classification = "heuristic" as const;
        const witness = result.graph.actions.find((attempt) => attempt.fromScreenStateId === screen.id
          && attempt.key === "TAB");
        const path = witness?.actionSequence ?? screen.discoveredBy;
        add({
          classification,
          issue: issue(
            NAVIGATION_DIAGNOSTIC_RULES.keyboardUnvisitedControl,
            classification,
            "medium",
            "Visible control was not visited by keyboard traversal",
            "A visible, enabled, focusable control was present in a complete UI snapshot but was never observed receiving focus. This is a review signal, not proof it cannot be reached.",
            screen.id,
            `${elementLabel(metadata) ?? "The control"} can be focused using an appropriate keyboard route.`,
            "No observed focus state matched the control during a completed sequential keyboard run.",
            { fromElement: null, action: "TAB", expectedElement: elementLabel(metadata), observedElement: null },
            path,
            "The known Tab traversal frontier was complete and the DOM hierarchy untruncated; no observed focus state matched this uniquely identified control.",
            witness?.id ?? null,
            "reload",
          ),
          source: { kind: "screen-analysis", screenStateId: screen.id, focusStateId: null,
            element: metadata, actionAttemptId: witness?.id ?? null,
            relatedActionAttemptId: null, actionSequence: path, locallyComplete: true },
          target: diagnosticTarget(screen.id, null, metadata, metadata, null),
        });
      }
    }
  }

  const ordered = [...findings.entries()].sort(([left], [right]) => left.localeCompare(right));
  const wrapped = ordered.map(([identity, finding]) => ({
    ...finding,
    issue: { ...finding.issue, id: createSemanticIssueId("NAV", identity) },
  }));
  return {
    findings: wrapped,
    deterministicFindings: wrapped.filter((finding) => finding.classification === "deterministic"),
    heuristicFindings: wrapped.filter((finding) => finding.classification === "heuristic"),
  };
}
