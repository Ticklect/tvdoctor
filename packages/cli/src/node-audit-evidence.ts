import { compileIssueReplay } from "@tvdoctor/core";
import type {
  PlaywrightWebDriver,
  WebLogEntry,
} from "@tvdoctor/driver-web";
import type {
  ActionResult,
  RemoteKey,
  StateSnapshot,
  TVDoctorIssue,
  TVDoctorReplayV1,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import {
  sanitiseEvidenceJson,
  sanitiseUntrustedText,
  writeIssueEvidence,
  type ArtifactStore,
  type IssueEvidenceArtifactInput,
  type IssueEvidenceSlot,
} from "@tvdoctor/reporters";
import {
  EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS,
  MAX_EVIDENCE_CAPTURE_DURATION_MS,
  MAX_ISSUES_WITH_FRESH_EVIDENCE,
  type AuditRunProducts,
  type CapturedIssue,
} from "./node-audit-contracts.js";
import { sequenceForIssue } from "./node-audit-selection.js";

function asJson(value: unknown): import("@tvdoctor/reporters").JsonValue {
  return JSON.parse(JSON.stringify(value)) as import("@tvdoctor/reporters").JsonValue;
}

export const EVIDENCE_EXCERPT_MAX_NODES = 150;

/**
 * Bounded excerpt of a snapshot's UI tree for report embedding. Complex real
 * pages can produce trees whose serialised form would exceed the reporters'
 * sanitisation budget; this retains only the first N nodes depth-first.
 */
function boundedUiTree(tree: readonly UiNodeSnapshot[]): readonly UiNodeSnapshot[] {
  let retained = 0;
  const walk = (nodes: readonly UiNodeSnapshot[]): UiNodeSnapshot[] => {
    const result: UiNodeSnapshot[] = [];
    for (const node of nodes) {
      if (retained >= EVIDENCE_EXCERPT_MAX_NODES) return result;
      const { children, ...rest } = node;
      retained += 1;
      result.push({
        ...rest,
        ...(retained < EVIDENCE_EXCERPT_MAX_NODES && children.length > 0
          ? { children: walk(children) }
          : { children: [] }),
      });
    }
    return result;
  };
  return walk(tree);
}

export function boundedSnapshot(snapshot: StateSnapshot): StateSnapshot {
  if (snapshot.uiTree.status !== "available") return snapshot;
  return {
    ...snapshot,
    uiTree: { status: "available", value: boundedUiTree(snapshot.uiTree.value) },
  };
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error(`${label} exceeded the bounded evidence-capture deadline.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded the bounded evidence-capture deadline.`)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function captureContext(
  target: string,
  sequence: readonly RemoteKey[],
  createDriver: () => PlaywrightWebDriver,
  maximumDurationMs = EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS,
): Promise<{
  readonly before: StateSnapshot;
  readonly after: StateSnapshot;
  readonly beforePng: Uint8Array;
  readonly afterPng: Uint8Array;
  readonly action: ActionResult | null;
  readonly logs: readonly WebLogEntry[];
}> {
  const driver = createDriver();
  const deadlineMs = Date.now() + maximumDurationMs;
  try {
    await withinDeadline(
      driver.launch({ id: "cli-issue-evidence", launchUri: target }),
      deadlineMs,
      "Evidence browser launch",
    );
    const setup = sequence.length === 0 ? [] : sequence.slice(0, -1);
    for (const key of setup) {
      const result = await withinDeadline(driver.press(key), deadlineMs, `Evidence setup ${key}`);
      if (result.outcome !== "applied") throw new Error(`Evidence setup ${key} was ${result.outcome}.`);
    }
    const before = await withinDeadline(driver.snapshot(), deadlineMs, "Evidence before snapshot");
    const beforePng = await withinDeadline(
      driver.getPage().screenshot({ type: "png", animations: "disabled" }),
      deadlineMs,
      "Evidence before screenshot",
    );
    const assertion = sequence.at(-1);
    const action = assertion === undefined
      ? null
      : await withinDeadline(driver.press(assertion), deadlineMs, `Evidence assertion ${assertion}`);
    if (action !== null && action.outcome !== "applied") {
      throw new Error(`Evidence assertion ${assertion} was ${action.outcome}.`);
    }
    const after = await withinDeadline(driver.snapshot(), deadlineMs, "Evidence after snapshot");
    const afterPng = await withinDeadline(
      driver.getPage().screenshot({ type: "png", animations: "disabled" }),
      deadlineMs,
      "Evidence after screenshot",
    );
    const logs = await withinDeadline(driver.getLogs(), deadlineMs, "Evidence log capture");
    return { before, after, beforePng, afterPng, action, logs };
  } finally {
    await withinDeadline(
      driver.close(),
      Date.now() + 5_000,
      "Evidence browser cleanup",
    ).catch(() => undefined);
  }
}

function focusedIdentity(snapshot: StateSnapshot): string | null {
  if (snapshot.focusedElement.status !== "available") return null;
  const target = snapshot.focusedElement.value;
  for (const value of [target?.stableId, target?.name, target?.role]) {
    const candidate = value?.trim();
    if (candidate !== undefined && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Return a bounded reason when a fresh evidence journey no longer witnesses
 * the discovery transition. A stale transition must never be labelled as a
 * fresh observation merely because the action sequence still executes.
 */
export function freshEvidenceDriftReason(
  issue: TVDoctorIssue,
  context: Pick<Awaited<ReturnType<typeof captureContext>>, "before" | "after" | "action">,
): string | null {
  const transition = issue.transition;
  if (transition === null) return null;
  const before = focusedIdentity(context.before);
  const after = focusedIdentity(context.after);
  if (context.action === null || context.action.key !== transition.action) {
    return "Fresh evidence did not execute the recorded assertion action.";
  }
  if (transition.fromElement !== null && before !== transition.fromElement) {
    return "Fresh evidence reached a different pre-action focus identity than discovery.";
  }
  if (transition.observedElement !== null && after !== transition.observedElement) {
    return "Fresh evidence reached a different post-action focus identity than discovery.";
  }
  return null;
}

function replayText(replay: TVDoctorReplayV1): string {
  return `${JSON.stringify(replay, null, 2)}\n`;
}

function availablePath(
  paths: Readonly<Partial<Record<IssueEvidenceSlot, string>>>,
  slot: IssueEvidenceSlot,
): string | null {
  return paths[slot] ?? null;
}

function evidenceUnavailableIssue(sourceIssue: TVDoctorIssue, rawReason: string): TVDoctorIssue {
  const reason = sanitiseUntrustedText(rawReason, 600)
    || "Fresh issue evidence was unavailable.";
  return {
    ...sourceIssue,
    evidence: [
      ...sourceIssue.evidence.map((entry) => ({ ...entry, artifact: null })),
      {
        kind: "verified-fact",
        summary: reason,
        source: "TVDoctor bounded evidence capture",
        artifact: null,
      },
    ],
    reproduction: { status: "unavailable", reason },
  };
}

async function writeFailedCaptureEvidence(
  store: ArtifactStore,
  sourceIssue: TVDoctorIssue,
  sequence: readonly RemoteKey[],
  rawReason: string,
): Promise<CapturedIssue> {
  const reason = sanitiseUntrustedText(rawReason, 600)
    || "Fresh issue evidence was unavailable.";
  const written = await writeIssueEvidence(store, {
    issueId: sourceIssue.id,
    artifacts: [
      { slot: "before-screenshot", capture: { status: "failed", reason } },
      { slot: "after-screenshot", capture: { status: "failed", reason: "The bounded evidence journey did not complete." } },
      { slot: "ui-excerpt", capture: { status: "failed", reason: "The bounded evidence journey did not complete." } },
      { slot: "transition", capture: { status: "failed", reason: "A fresh matching transition was not observed." } },
      { slot: "console-log", capture: { status: "failed", reason: "The bounded evidence journey did not complete." } },
      {
        slot: "navigation-path",
        capture: {
          status: "available",
          format: "json",
          value: sanitiseEvidenceJson(asJson({ exactResetRelativeSequence: sequence })),
        },
      },
      { slot: "replay", capture: { status: "unavailable", reason: "Fresh evidence was inconclusive, so no replay was retained." } },
      { slot: "trace", capture: { status: "unavailable", reason: "Browser tracing was disabled." } },
    ],
  });
  return {
    issue: evidenceUnavailableIssue(sourceIssue, reason),
    artifacts: written.descriptors,
    replay: null,
    failed: true,
  };
}

export async function captureIssue(
  store: ArtifactStore,
  target: string,
  products: AuditRunProducts,
  sourceIssue: TVDoctorIssue,
  createDriver: () => PlaywrightWebDriver,
): Promise<CapturedIssue> {
  const sequence = sequenceForIssue(products, sourceIssue);
  const compiled = sourceIssue.reproduction.status === "available" ? compileIssueReplay(sourceIssue) : null;
  const plan = compiled?.status === "compiled" ? compiled.plan : null;
  const failedSlot = (slot: string, reason: string): IssueEvidenceArtifactInput => ({
    slot: slot as IssueEvidenceSlot,
    capture: { status: "failed", reason },
  });
  let context: Awaited<ReturnType<typeof captureContext>>;
  try {
    context = await captureContext(target, sequence, createDriver);
    const driftReason = freshEvidenceDriftReason(sourceIssue, context);
    if (driftReason !== null) throw new Error(driftReason);
  } catch (error) {
    return await writeFailedCaptureEvidence(
      store,
      sourceIssue,
      sequence,
      `Evidence capture was inconclusive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const safeArtifact = (
      slot: IssueEvidenceSlot,
      build: () => IssueEvidenceArtifactInput,
    ): IssueEvidenceArtifactInput => {
      try {
        return build();
      } catch (error) {
        return failedSlot(slot, `${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // Each JSON capture is bounded independently so one oversized payload
    // cannot suppress unrelated evidence. Pre-sanitising here converts a
    // would-be writeIssueEvidence abort into a per-slot failure.
    const artifacts = [
      safeArtifact("ui-excerpt", () => ({
        slot: "ui-excerpt" as const,
        capture: (() => {
          const value = sanitiseEvidenceJson(asJson({
            before: boundedSnapshot(context.before),
            after: boundedSnapshot(context.after),
          }));
          return { status: "available" as const, format: "json" as const, value };
        })(),
      })),
      safeArtifact("transition", () => ({
        slot: "transition" as const,
        capture: (() => {
          const value = sanitiseEvidenceJson(asJson({
            freshlyObserved: {
              beforeFocusedElement: focusedIdentity(context.before),
              action: context.action,
              afterFocusedElement: focusedIdentity(context.after),
            },
            recordedExpectedElement: sourceIssue.transition?.expectedElement ?? null,
          }));
          return { status: "available" as const, format: "json" as const, value };
        })(),
      })),
      safeArtifact("console-log", () => ({
        slot: "console-log" as const,
        capture: (() => {
          const value = sanitiseEvidenceJson(asJson(context.logs));
          return { status: "available" as const, format: "json" as const, value };
        })(),
      })),
    ];
    const written = await writeIssueEvidence(store, {
      issueId: sourceIssue.id,
      artifacts: [
        { slot: "before-screenshot", capture: { status: "available", format: "binary", data: context.beforePng, mediaType: "image/png" } },
        { slot: "after-screenshot", capture: { status: "available", format: "binary", data: context.afterPng, mediaType: "image/png" } },
        ...artifacts,
        {
          slot: "navigation-path",
          capture: {
            status: "available",
            format: "json",
            value: sanitiseEvidenceJson(asJson({ resetStrategy: "reload", exactResetRelativeSequence: sequence })),
          },
        },
        {
          slot: "replay",
          capture: plan === null
            ? { status: "unavailable", reason: sourceIssue.reproduction.status === "unavailable"
                ? sourceIssue.reproduction.reason
                : "The issue reproduction did not compile into a portable replay." }
            : { status: "available", format: "text", text: replayText(plan.replay), mediaType: "text/yaml" },
        },
        { slot: "trace", capture: { status: "unavailable", reason: "The bounded CLI audit did not enable heavyweight browser tracing." } },
      ],
    });
    const primaryEvidencePath = sourceIssue.rule === "crash.console-error"
      ? availablePath(written.pathsBySlot, "console-log")
      : sourceIssue.transition === null
        ? availablePath(written.pathsBySlot, "ui-excerpt")
        : availablePath(written.pathsBySlot, "transition");
    const beforePath = availablePath(written.pathsBySlot, "before-screenshot");
    const afterPath = availablePath(written.pathsBySlot, "after-screenshot");
    const replayPath = availablePath(written.pathsBySlot, "replay");
    const issue: TVDoctorIssue = {
      ...sourceIssue,
      evidence: [
        ...sourceIssue.evidence.map((entry) => ({ ...entry, artifact: primaryEvidencePath })),
        ...(beforePath === null ? [] : [{
          kind: "verified-fact" as const,
          summary: "A fresh-reset screenshot records the state before the retained evidence action.",
          source: "PlaywrightWebDriver",
          artifact: beforePath,
        }]),
        ...(afterPath === null ? [] : [{
          kind: "verified-fact" as const,
          summary: "A fresh-reset screenshot records the state after the retained evidence action.",
          source: "PlaywrightWebDriver",
          artifact: afterPath,
        }]),
      ],
      reproduction: sourceIssue.reproduction.status === "available"
        ? { ...sourceIssue.reproduction, artifact: replayPath }
        : sourceIssue.reproduction,
    };
    return {
      issue,
      artifacts: written.descriptors,
      replay: plan?.replay ?? null,
      failed: written.descriptors.some((descriptor) => descriptor.status === "failed"),
    };
  } catch (error) {
    // Filesystem failures after an evidence write begins cannot be repaired by
    // writing a second set into the same immutable store. Surface the failure
    // to the command rather than publishing a mixed bundle.
    throw new Error(
      `Evidence artifacts could not be retained for ${sourceIssue.id}: ${sanitiseUntrustedText(error instanceof Error ? error.message : String(error), 400)}`,
      { cause: error },
    );
  }
}

function skippedEvidenceIssue(sourceIssue: TVDoctorIssue, reason: string): CapturedIssue {
  return {
    issue: evidenceUnavailableIssue(sourceIssue, reason),
    artifacts: [],
    replay: null,
    failed: true,
  };
}

type IssueCapturer = typeof captureIssue;

export async function captureIssuesWithinBudget(
  store: ArtifactStore,
  target: string,
  products: AuditRunProducts,
  issues: readonly TVDoctorIssue[],
  createDriver: () => PlaywrightWebDriver,
  capture: IssueCapturer = captureIssue,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<readonly CapturedIssue[]> {
  const startedAtMs = now();
  const captured: CapturedIssue[] = [];
  for (const [index, issue] of issues.entries()) {
    if (signal?.aborted === true) {
      captured.push(skippedEvidenceIssue(
        issue,
        "Fresh evidence was not recaptured because the scan was interrupted.",
      ));
      continue;
    }
    if (index >= MAX_ISSUES_WITH_FRESH_EVIDENCE) {
      captured.push(skippedEvidenceIssue(
        issue,
        `Fresh evidence was not recaptured because the per-run limit of ${String(MAX_ISSUES_WITH_FRESH_EVIDENCE)} issues was reached.`,
      ));
      continue;
    }
    if (now() - startedAtMs >= MAX_EVIDENCE_CAPTURE_DURATION_MS) {
      captured.push(skippedEvidenceIssue(
        issue,
        `Fresh evidence was not recaptured because the ${String(MAX_EVIDENCE_CAPTURE_DURATION_MS)} ms run budget was reached.`,
      ));
      continue;
    }
    captured.push(await capture(store, target, products, issue, createDriver));
  }
  return captured;
}
