import type { ExplorationResult, NavigationDiagnosticFinding } from "@tvdoctor/core";
import type { TestCommandRequest } from "./cli.js";

/**
 * The Northstar packaged demo is a *known intentionally broken fixture*: its
 * explicit script contract maps the hero's RIGHT input to the missing More Info
 * target. Only that named, observed, fully traversed fixture can be classified
 * as deterministic. Arbitrary-app geometric reachability remains REVIEW.
 */
export function applyControlledDemoContract(
  request: TestCommandRequest,
  result: ExplorationResult,
  findings: readonly NavigationDiagnosticFinding[],
): readonly NavigationDiagnosticFinding[] {
  if (request.packagedDemo !== true || request.targetName !== "Northstar controlled demo"
    || result.termination.complete !== true || result.termination.reason !== "queue-exhausted"
    || (result.termination.remainingFrontierEntries ?? 0) !== 0
    || (result.termination.remainingCandidateActions ?? 0) !== 0
    || result.statistics.pendingStates !== 0 || (result.statistics.deferredStates ?? 0) !== 0
    || request.inputMode === "keyboard") return findings;
  let target: URL;
  try { target = new URL(request.target); } catch { return findings; }
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1"
    || target.pathname !== "/" || target.hash !== ""
    || target.searchParams.size !== 1
    || target.searchParams.get("tvdoctorDemo") !== "navigation") return findings;
  const matches = findings.filter(({ issue }) =>
    issue.rule === "remote.reachability"
    && issue.transition?.action === "RIGHT"
    && issue.transition.fromElement === "hero-watch"
    && issue.transition.expectedElement === "hero-more-info"
    && issue.transition.observedElement === "hero-watch"
    && issue.reproduction.status === "available"
  );
  if (matches.length !== 1) return findings;
  return findings.map((finding) => {
    if (finding !== matches[0] || finding.issue.reproduction.status !== "available") return finding;
    return {
      ...finding,
      classification: "deterministic" as const,
      issue: {
        ...finding.issue,
        confidence: "deterministic" as const,
        description: "In the known packaged Northstar fixture, RIGHT from hero-watch is deliberately miswired to remain on hero-watch instead of its explicitly expected hero-more-info target. The scan observed that exact seeded contract violation.",
        expected: "The controlled Northstar fixture's hero RIGHT action reaches hero-more-info.",
        reproduction: { ...finding.issue.reproduction, confidence: "deterministic" as const },
        evidence: [{
          kind: "deterministic-failure" as const,
          summary: "Predeclared fixture contract: RIGHT from hero-watch should reach hero-more-info; the observed result remained hero-watch. Applies only to Northstar controlled demo.",
          source: "Northstar packaged seeded-navigation contract",
          artifact: null,
        }],
      },
    };
  });
}
