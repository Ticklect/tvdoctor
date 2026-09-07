import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type {
  TestCommandRequest,
  TestCommandResult,
} from "./cli.js";
import type { NodeAuditDependencies } from "./node-audit-contracts.js";
import { runAudit } from "./node-audit-runner.js";

export {
  EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS,
  MAX_EVIDENCE_CAPTURE_DURATION_MS,
  MAX_ISSUES_WITH_FRESH_EVIDENCE,
  REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY,
  REPLAY_TARGET_OVERRIDE_REQUIRED,
  type AuditRunProducts,
  type CapturedIssue,
  type NodeAuditDependencies,
} from "./node-audit-contracts.js";
export {
  EVIDENCE_EXCERPT_MAX_NODES,
  boundedSnapshot,
  captureIssue,
  captureIssuesWithinBudget,
  freshEvidenceDriftReason,
} from "./node-audit-evidence.js";
export {
  reserveAuditOutput,
  targetRequiresReplayOverride,
  writeAuditAuxiliaryArtifacts,
} from "./node-audit-output.js";
export {
  exhaustedBudgets,
  packCoverage,
  partialRunDetails,
} from "./node-audit-selection.js";

export function createNodeAuditOperation(
  dependencies: NodeAuditDependencies = {},
): (request: TestCommandRequest) => Promise<TestCommandResult> {
  const createDriver = dependencies.createDriver ?? (() => new PlaywrightWebDriver({
    browserLaunchOptions: { handleSIGINT: false },
    settle: { ambientChurnEscape: true },
  }));
  return async (request) => runAudit(request, createDriver);
}
