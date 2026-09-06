import type { ExplorationResult } from "./explorer-contracts.js";
import {
  NAVIGATION_DIAGNOSTIC_RULES,
  type NavigationDiagnosticFinding,
  type NavigationDiagnosticOptions,
  type NavigationDiagnosticRule,
  type NavigationDiagnostics,
} from "./navigation-diagnostic-contracts.js";
import {
  compareText,
  semanticFindingIdentity,
} from "./navigation-diagnostic-context.js";
import type {
  FindingCandidate,
  NavigationRuleContext,
} from "./navigation-diagnostic-findings.js";
import {
  addLostFocusFindings,
  addSelfLoopFindings,
  addUnexpectedJumpFindings,
  addUnreachableFindings,
} from "./navigation-focus-rules.js";
import { addBackBehaviourFindings } from "./navigation-history-rules.js";
import {
  addConsentWallFindings,
  addFocusTrapFindings,
  addOverlayFocusLeakFindings,
} from "./navigation-modal-rules.js";
import { createSemanticIssueId } from "./semantic-issue-id.js";

export { NAVIGATION_DIAGNOSTIC_RULES };
export type {
  NavigationDiagnosticClassification,
  NavigationDiagnosticFinding,
  NavigationDiagnosticOptions,
  NavigationDiagnosticRule,
  NavigationDiagnostics,
  NavigationDiagnosticSource,
  NavigationDiagnosticSourceKind,
  NavigationDiagnosticTarget,
  NavigationElementMetadata,
} from "./navigation-diagnostic-contracts.js";

const RULE_ORDER: Readonly<Record<NavigationDiagnosticRule, number>> = {
  [NAVIGATION_DIAGNOSTIC_RULES.lostFocus]: 0,
  [NAVIGATION_DIAGNOSTIC_RULES.selfLoop]: 1,
  [NAVIGATION_DIAGNOSTIC_RULES.unreachable]: 2,
  [NAVIGATION_DIAGNOSTIC_RULES.focusTrap]: 3,
  [NAVIGATION_DIAGNOSTIC_RULES.consentWall]: 4,
  [NAVIGATION_DIAGNOSTIC_RULES.overlayFocusLeak]: 5,
  [NAVIGATION_DIAGNOSTIC_RULES.backBehaviour]: 6,
  [NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump]: 7,
};

/**
 * Applies conservative, fixture-independent navigation diagnostics to a frozen
 * exploration graph. It performs no driver I/O and returns a stable order.
 */
export function diagnoseNavigation(
  result: ExplorationResult,
  options: NavigationDiagnosticOptions = {},
): NavigationDiagnostics {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Navigation diagnostic options must be an object.");
  }
  if (options.resetStrategy !== undefined
    && options.resetStrategy !== "reload"
    && options.resetStrategy !== "relaunch"
    && options.resetStrategy !== "clear-data") {
    throw new TypeError("resetStrategy must be reload, relaunch, or clear-data.");
  }
  const resetStrategy = options.resetStrategy ?? "reload";
  const screenById = new Map(
    result.graph.screens.states.map((state) => [state.id, state]),
  );
  const candidates = new Map<string, FindingCandidate>();
  const append = (candidate: FindingCandidate): void => {
    const identity = semanticFindingIdentity(candidate, screenById);
    if (!candidates.has(identity)) candidates.set(identity, candidate);
  };
  const context: NavigationRuleContext = { result, resetStrategy, append };

  addLostFocusFindings(context);
  addSelfLoopFindings(context);
  addUnreachableFindings(context);
  addFocusTrapFindings(context);
  addConsentWallFindings(context);
  addOverlayFocusLeakFindings(context);
  addBackBehaviourFindings(context);
  addUnexpectedJumpFindings(context);

  const ordered = [...candidates.entries()].sort(([leftIdentity, left], [rightIdentity, right]) => {
    const leftOrder = RULE_ORDER[left.issue.rule as NavigationDiagnosticRule] ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = RULE_ORDER[right.issue.rule as NavigationDiagnosticRule] ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || compareText(leftIdentity, rightIdentity);
  });
  const findings = ordered.map(([identity, candidate]): NavigationDiagnosticFinding => ({
    classification: candidate.classification,
    issue: {
      ...candidate.issue,
      id: createSemanticIssueId("NAV", identity),
    },
    source: candidate.source,
    target: candidate.target,
  }));

  return {
    findings,
    deterministicFindings: findings.filter((finding) => finding.classification === "deterministic"),
    heuristicFindings: findings.filter((finding) => finding.classification === "heuristic"),
  };
}
