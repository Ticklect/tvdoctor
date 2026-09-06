import { compileIssueReplay, executeReplay } from "@tvdoctor/core";
import type { TVDoctorIssue } from "@tvdoctor/protocol";
import type { StreamingReplayResult } from "./types.js";
import type { StreamingSession } from "./streaming-runtime.js";

export async function replayIssue(
  session: StreamingSession,
  issue: TVDoctorIssue,
): Promise<StreamingReplayResult> {
  const compiled = compileIssueReplay(issue);
  if (compiled.status !== "compiled") {
    return {
      issueId: issue.id,
      status: "unavailable",
      reason: { message: compiled.reason.message },
      actionsPressed: 0,
    };
  }
  if (compiled.plan.totalActions > session.remainingActions()) {
    return {
      issueId: issue.id,
      status: "unavailable",
      reason: { message: "The global streaming-pack action budget had insufficient room for replay." },
      actionsPressed: 0,
    };
  }
  const result = await executeReplay(session.replayDriver(), compiled.plan, {
    budgets: {
      maxActions: session.remainingActions(),
      maxDurationMs: Math.max(1, Math.floor(session.remainingDuration())),
    },
    now: session.now,
  });
  return {
    issueId: issue.id,
    status: result.status,
    reason: result.reason,
    actionsPressed: result.actionsPressed,
  };
}
