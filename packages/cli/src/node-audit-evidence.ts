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
  MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE,
  MAX_EVIDENCE_CAPTURE_DURATION_MS,
  MAX_ISSUES_WITH_FRESH_EVIDENCE,
  type AuditRunProducts,
  type CapturedIssue,
} from "./node-audit-contracts.js";
import { createSafeExplorationDriver } from "./node-audit-navigation.js";
import { sequenceForIssue } from "./node-audit-selection.js";

function asJson(value: unknown): import("@tvdoctor/reporters").JsonValue {
  return JSON.parse(JSON.stringify(value)) as import("@tvdoctor/reporters").JsonValue;
}

/**
 * Console messages and pageerror stacks are arbitrary application-authored
 * bytes: they can include passwords, tokens and customer records with no
 * recognisable key or URL prefix. Generic text sanitisation is insufficient.
 * Keep only the non-content metadata needed to correlate a log with an issue.
 * Rule-specific runtime exception class witnesses are separately bounded and
 * never derive a FIXED verdict from these logs.
 */
export function redactedConsoleEvidence(logs: readonly WebLogEntry[]): import("@tvdoctor/reporters").JsonValue {
  return sanitiseEvidenceJson(asJson(logs.slice(-512).map((entry) => ({
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    message: "[REDACTED: application-authored console content]",
    location: null,
    stack: null,
  }))));
}

export const EVIDENCE_EXCERPT_MAX_NODES = 150;
const EVIDENCE_CAPTURE_FAILED_REASON = "Evidence capture was inconclusive because the bounded evidence journey failed.";
const MODAL_FOCUS_READY_TIMEOUT_MS = 2_500;
const MODAL_FOCUS_POLL_MS = 80;

/** Only source-proven modal Tab defects benefit from waiting for hydration. */
function modalFocusSource(issue: TVDoctorIssue, sequence: readonly RemoteKey[]): string | null {
  const transition = issue.transition;
  const final = sequence.at(-1);
  return (issue.rule === "keyboard.modal-focus-escape"
      || issue.rule === "keyboard.modal-tab-focus-loss")
    && issue.confidence === "deterministic"
    && issue.evidence.some((entry) => entry.kind === "deterministic-failure")
    && issue.reproduction.status === "available"
    && issue.reproduction.confidence === "deterministic"
    && (transition?.action === "TAB" || transition?.action === "SHIFT_TAB")
    && final === transition.action
    && typeof transition.fromElement === "string"
    && transition.fromElement.trim().length > 0
    ? transition.fromElement : null;
}

/** One exact, visible and unique live focus witness; never infer a target from
 * the requested issue alone. Snapshot routes are intentionally redacted, so
 * compare the raw page URL only in memory and require the snapshot's origin. */
function modalFocusReady(snapshot: StateSnapshot, target: string, liveUrl: string,
  originalFocus: string): string | null {
  if (snapshot.location.status !== "available"
    || snapshot.focusedElement.status !== "available"
    || snapshot.uiTree.status !== "available") return null;
  try {
    const intended = new URL(target);
    if (new URL(liveUrl).href !== intended.href
      || new URL(snapshot.location.value).origin !== intended.origin) return null;
  } catch { return null; }
  const focused = snapshot.focusedElement.value;
  if (focused === null || focusedIdentity(snapshot) !== originalFocus
    || !(focused.stableId?.trim() || focused.name?.trim())) return null;
  const matches: UiNodeSnapshot[] = [];
  const pending = [...snapshot.uiTree.value];
  let scanned = 0;
  while (pending.length > 0 && scanned < 4_096) {
    const node = pending.shift();
    if (node === undefined) break;
    scanned++;
    const identity = node.stableId?.trim() || node.name?.trim();
    if (identity === originalFocus) matches.push(node);
    pending.push(...node.children);
  }
  if (pending.length > 0 || matches.length !== 1) return null;
  const match = matches[0];
  if (match?.focused !== true || match.visible !== true || match.enabled !== true
    || match.focusable !== true || (match.role ?? null) !== (focused.role ?? null)
    || (match.name ?? null) !== (focused.name ?? null)
    // UI-tree snapshots represent absent IDs as null; focused-element records
    // omit absent IDs. Both mean no authored DOM identity, not a state change.
    || (match.stableId ?? null) !== (focused.stableId ?? null)) return null;
  // Keep semantic identity stable even if the DOM id is reused by a new shell.
  return JSON.stringify([match.stableId, match.role, match.name]);
}

async function readyModalFocus(driver: PlaywrightWebDriver, target: string,
  originalFocus: string, evidenceDeadline: number): Promise<StateSnapshot> {
  const deadline = Math.min(evidenceDeadline, performance.now() + MODAL_FOCUS_READY_TIMEOUT_MS);
  let lastSignature: string | null = null;
  let stable = 0;
  while (performance.now() < deadline) {
    const snapshot = await withinDeadline(
      (signal) => driver.snapshot({ signal }), deadline, "Bounded modal focus readiness",
    );
    let liveUrl: string;
    try { liveUrl = driver.getPage().url(); }
    catch { throw new Error("Modal focus readiness was unavailable."); }
    // A changed protected route is not an async focus delay. Do not wait on or
    // navigate to a different route to try to reproduce the old issue.
    if (liveUrl !== target) throw new Error("Original evidence route changed before action.");
    const signature = modalFocusReady(snapshot, target, liveUrl, originalFocus);
    stable = signature !== null && signature === lastSignature ? stable + 1 : signature === null ? 0 : 1;
    lastSignature = signature;
    if (stable >= 2) return snapshot;
    const remaining = deadline - performance.now();
    if (remaining <= MODAL_FOCUS_POLL_MS) break;
    await withinDeadline(
      (signal) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, MODAL_FOCUS_POLL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }), deadline, "Bounded modal focus wait",
    );
  }
  throw new Error("Original modal focus was not stably restored before evidence action.");
}

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

function persistedSnapshot(snapshot: StateSnapshot, targetRedaction?: "origin"): StateSnapshot {
  const bounded = boundedSnapshot(snapshot);
  if (targetRedaction !== "origin" || bounded.location.status !== "available") return bounded;
  try {
    return {
      ...bounded,
      location: { status: "available", value: new URL(bounded.location.value).origin },
    };
  } catch {
    return {
      ...bounded,
      location: { status: "unavailable", reason: "Location omitted by strict target redaction." },
    };
  }
}

async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  const remainingMs = deadlineMs - performance.now();
  if (remainingMs <= 0) throw new Error(`${label} exceeded the bounded evidence-capture deadline.`);
  const controller = new AbortController();
  const deadlineError = new Error(`${label} exceeded the bounded evidence-capture deadline.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort(deadlineError);
            reject(deadlineError);
          },
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
  driver: PlaywrightWebDriver,
  closeDriver: boolean,
  maximumDurationMs = EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS,
  captureScreenshots = true,
  fixtureProfileSelection = false,
  originalModalFocus: string | null = null,
): Promise<{
  readonly before: StateSnapshot;
  readonly after: StateSnapshot;
  readonly beforePng: Uint8Array | null;
  readonly afterPng: Uint8Array | null;
  readonly action: ActionResult | null;
  readonly logs: readonly WebLogEntry[];
}> {
  const deadlineMs = performance.now() + maximumDurationMs;
  // Use the same per-press semantic SELECT guard as exploration. It captures a
  // fresh focus snapshot and refuses an ambiguous or unsafe activation before
  // forwarding the key to the browser, including during setup replay.
  const safeDriver = createSafeExplorationDriver(driver, { fixtureProfileSelection });
  try {
    await withinDeadline(
      (signal) => driver.launch({ id: "cli-issue-evidence", launchUri: target }, { signal }),
      deadlineMs,
      "Evidence browser launch",
    );
    const setup = sequence.length === 0 ? [] : sequence.slice(0, -1);
    for (const key of setup) {
      const result = await withinDeadline(
        (signal) => safeDriver.press(key, { signal }), deadlineMs, `Evidence setup ${key}`,
      );
      if (result.outcome !== "applied") throw new Error(`Evidence setup ${key} was ${result.outcome}.`);
    }
    const before = originalModalFocus === null
      ? await withinDeadline((signal) => driver.snapshot({ signal }), deadlineMs, "Evidence before snapshot")
      : await readyModalFocus(driver, target, originalModalFocus, deadlineMs);
    const beforePng = captureScreenshots
      ? await withinDeadline(
        () => driver.getPage().screenshot({ type: "png", animations: "disabled" }),
        deadlineMs,
        "Evidence before screenshot",
      )
      : null;
    if (originalModalFocus !== null) {
      // A late hydration/ref-focus update after the screenshot invalidates the
      // checkpoint. Withhold Tab; never retry or replay an assertion action.
      const latest = await withinDeadline(
        (signal) => driver.snapshot({ signal }), deadlineMs, "Evidence final focus checkpoint",
      );
      const signature = modalFocusReady(latest, target, driver.getPage().url(), originalModalFocus);
      const original = modalFocusReady(before, target, driver.getPage().url(), originalModalFocus);
      if (signature === null || signature !== original) {
        throw new Error("Original modal focus changed before evidence action.");
      }
    }
    const assertion = sequence.at(-1);
    const action = assertion === undefined
      ? null
      : await withinDeadline(
        (signal) => safeDriver.press(assertion, { signal }), deadlineMs, `Evidence assertion ${assertion}`,
      );
    if (action !== null && action.outcome !== "applied") {
      throw new Error(`Evidence assertion ${assertion} was ${action.outcome}.`);
    }
    const after = await withinDeadline(
      (signal) => driver.snapshot({ signal }), deadlineMs, "Evidence after snapshot",
    );
    const afterPng = captureScreenshots
      ? await withinDeadline(
        () => driver.getPage().screenshot({ type: "png", animations: "disabled" }),
        deadlineMs,
        "Evidence after screenshot",
      )
      : null;
    const logs = await withinDeadline(() => driver.getLogs(), deadlineMs, "Evidence log capture");
    return { before, after, beforePng, afterPng, action, logs };
  } catch (error) {
    // A pooled session that fails mid-operation is retired before reuse. The
    // next launch may create a new browser process, while successful captures
    // keep the process alive and receive a fresh BrowserContext on launch().
    if (!closeDriver) {
      await withinDeadline(
        () => driver.close(),
        performance.now() + 5_000,
        "Evidence browser retirement",
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (closeDriver) {
      await withinDeadline(
        () => driver.close(),
        performance.now() + 5_000,
        "Evidence browser cleanup",
      ).catch(() => undefined);
    }
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
  captureScreenshots = true,
): Promise<CapturedIssue> {
  const reason = sanitiseUntrustedText(rawReason, 600)
    || "Fresh issue evidence was unavailable.";
  const written = await writeIssueEvidence(store, {
    issueId: sourceIssue.id,
    artifacts: [
      { slot: "before-screenshot", capture: captureScreenshots
        ? { status: "failed", reason }
        : { status: "unavailable", reason: "Screenshot persistence was disabled by --no-screenshots." } },
      { slot: "after-screenshot", capture: captureScreenshots
        ? { status: "failed", reason: "The bounded evidence journey did not complete." }
        : { status: "unavailable", reason: "Screenshot persistence was disabled by --no-screenshots." } },
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
  reuseDriver?: PlaywrightWebDriver,
  captureScreenshots = true,
  targetRedaction?: "origin",
  fixtureProfileSelection = false,
  maximumDurationMs = EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS,
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
    const driver = reuseDriver ?? createDriver();
    context = await captureContext(
      target,
      sequence,
      driver,
      reuseDriver === undefined,
      maximumDurationMs,
      captureScreenshots,
      fixtureProfileSelection,
      modalFocusSource(sourceIssue, sequence),
    );
    const driftReason = freshEvidenceDriftReason(sourceIssue, context);
    if (driftReason !== null) throw new Error(driftReason);
  } catch {
    return await writeFailedCaptureEvidence(
      store,
      sourceIssue,
      sequence,
      EVIDENCE_CAPTURE_FAILED_REASON,
      captureScreenshots,
    );
  }

  try {
    const safeArtifact = (
      slot: IssueEvidenceSlot,
      build: () => IssueEvidenceArtifactInput,
    ): IssueEvidenceArtifactInput => {
      try {
        return build();
      } catch {
        return failedSlot(slot, `The ${slot} evidence could not be safely retained.`);
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
            before: persistedSnapshot(context.before, targetRedaction),
            after: persistedSnapshot(context.after, targetRedaction),
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
          const value = redactedConsoleEvidence(context.logs);
          return { status: "available" as const, format: "json" as const, value };
        })(),
      })),
    ];
    const written = await writeIssueEvidence(store, {
      issueId: sourceIssue.id,
      artifacts: [
        { slot: "before-screenshot", capture: context.beforePng === null
          ? { status: "unavailable", reason: "Screenshot persistence was disabled by --no-screenshots." }
          : { status: "available", format: "binary", data: context.beforePng, mediaType: "image/png" } },
        { slot: "after-screenshot", capture: context.afterPng === null
          ? { status: "unavailable", reason: "Screenshot persistence was disabled by --no-screenshots." }
          : { status: "available", format: "binary", data: context.afterPng, mediaType: "image/png" } },
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
      `Evidence artifacts could not be safely retained for ${sourceIssue.id}.`,
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

const EVIDENCE_SEVERITIES: readonly TVDoctorIssue["severity"][] = [
  "critical", "high", "medium", "low", "info",
];

function evidenceActionability(issue: TVDoctorIssue): number {
  if (issue.confidence === "deterministic") {
    return issue.reproduction.status === "available" && issue.reproduction.confidence === "deterministic"
      ? 0
      : 1;
  }
  if (issue.confidence === "heuristic") return 2;
  if (issue.confidence === "inference") return 3;
  return 4;
}

/** Schedule globally by severity and actionability, then fairly across packs.
 * Indices retain the original order within each pack/tier and allow report
 * results to be restored to their exact source positions after capture.
 */
function evidenceCaptureOrder(issues: readonly TVDoctorIssue[]): readonly number[] {
  const tiers = new Map<number, Map<string, number[]>>();
  for (const [index, issue] of issues.entries()) {
    const priority = EVIDENCE_SEVERITIES.indexOf(issue.severity) * 5 + evidenceActionability(issue);
    let packGroups = tiers.get(priority);
    if (packGroups === undefined) {
      packGroups = new Map();
      tiers.set(priority, packGroups);
    }
    const indices = packGroups.get(issue.pack) ?? [];
    indices.push(index);
    packGroups.set(issue.pack, indices);
  }

  const order: number[] = [];
  for (const priority of [...tiers.keys()].sort((left, right) => left - right)) {
    const groups = tiers.get(priority);
    if (groups === undefined) continue;
    let active = [...groups.values()].map((indices) => ({ indices, offset: 0 }));
    while (active.length > 0) {
      const remaining: typeof active = [];
      for (const group of active) {
        const index = group.indices[group.offset];
        if (index === undefined) continue;
        order.push(index);
        group.offset += 1;
        if (group.offset < group.indices.length) remaining.push(group);
      }
      active = remaining;
    }
  }
  return order;
}

type IssueCapturer = typeof captureIssue;

export async function captureIssuesWithinBudget(
  store: ArtifactStore,
  target: string,
  products: AuditRunProducts,
  issues: readonly TVDoctorIssue[],
  createDriver: () => PlaywrightWebDriver,
  capture: IssueCapturer = captureIssue,
  now: () => number = () => performance.now(),
  signal?: AbortSignal,
  captureScreenshots = true,
  targetRedaction?: "origin",
  fixtureProfileSelection = false,
  maxIssuesWithFreshEvidence = MAX_ISSUES_WITH_FRESH_EVIDENCE,
): Promise<readonly CapturedIssue[]> {
  if (!Number.isSafeInteger(maxIssuesWithFreshEvidence)
    || maxIssuesWithFreshEvidence < 1
    || maxIssuesWithFreshEvidence > MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE) {
    throw new TypeError("Fresh evidence issue limit must be a positive bounded integer.");
  }
  const startedAtMs = now();
  const captured: (CapturedIssue | undefined)[] = Array.from({ length: issues.length }, () => undefined);
  let attemptedCaptures = 0;
  let sharedDriver: PlaywrightWebDriver | null = null;
  try {
    for (const index of evidenceCaptureOrder(issues)) {
      const issue = issues[index];
      if (issue === undefined) throw new Error("Evidence capture order referenced a missing issue.");
      if (signal?.aborted === true) {
        captured[index] = skippedEvidenceIssue(
          issue,
          "Fresh evidence was not recaptured because the scan was interrupted.",
        );
        continue;
      }
      if (attemptedCaptures >= maxIssuesWithFreshEvidence) {
        captured[index] = skippedEvidenceIssue(
          issue,
          `Fresh evidence was not recaptured because the per-run limit of ${String(maxIssuesWithFreshEvidence)} issues was reached.`,
        );
        continue;
      }
      const elapsedMs = Math.max(0, now() - startedAtMs);
      if (elapsedMs >= MAX_EVIDENCE_CAPTURE_DURATION_MS) {
        captured[index] = skippedEvidenceIssue(
          issue,
          `Fresh evidence was not recaptured because the ${String(MAX_EVIDENCE_CAPTURE_DURATION_MS)} ms run budget was reached.`,
        );
        continue;
      }
      attemptedCaptures += 1;
      if (capture === captureIssue) {
        sharedDriver ??= createDriver();
        captured[index] = await capture(
          store,
          target,
          products,
          issue,
          createDriver,
          sharedDriver,
          captureScreenshots,
          targetRedaction,
          fixtureProfileSelection,
          Math.min(EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS, MAX_EVIDENCE_CAPTURE_DURATION_MS - elapsedMs),
        );
      } else {
        captured[index] = await capture(store, target, products, issue, createDriver);
      }
    }
  } finally {
    await sharedDriver?.close().catch(() => undefined);
  }
  return captured.map((result) => {
    if (result === undefined) throw new Error("Evidence capture omitted a source issue.");
    return result;
  });
}
