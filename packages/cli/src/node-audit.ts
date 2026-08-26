import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createStartupBlockerFinding,
  compileIssueReplay,
  diagnoseNavigation,
  explore,
  type ExplorationProfile,
  type ExplorationResult,
  type NavigationDiagnosticFinding,
  prepareStartup,
  type StartupPreparationResult,
  type StartupControlCandidate,
} from "@tvdoctor/core";
import {
  PlaywrightWebDriver,
  type WebDriverPerformanceProfile,
  type WebLogEntry,
} from "@tvdoctor/driver-web";
import {
  runStreamingPack,
  type StreamingPackBudgets,
  type StreamingPackResult,
  type StreamingStageName,
} from "@tvdoctor/pack-streaming";
import {
  focusedWebEntry,
  isSafeWebControl,
  normaliseWebSemanticText,
  runWebPack,
  webSemanticContext,
  type WebPackBudgets,
  type WebPackResult,
  type WebStageName,
  type WebStageObservation,
} from "@tvdoctor/pack-web";
import type {
  ActionResult,
  ArtifactDescriptor,
  Capability,
  UiNodeSnapshot,
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
  TVDoctorIssue,
  TVDoctorReplayV1,
} from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  createArtifactStore,
  sanitiseEvidenceJson,
  sanitiseUntrustedText,
  stableJson,
  writeIssueEvidence,
  writeReportBundle,
  type ArtifactStore,
  type IssueEvidenceArtifactInput,
  type IssueEvidenceSlot,
  type JsonValue,
} from "@tvdoctor/reporters";
import type {
  TestCommandRequest,
  TestCommandResult,
} from "./cli.js";
import {
  createStreamingAuditPointerProbe,
  createWebAuditHooks,
} from "./web-audit-hooks.js";
import { CLI_VERSION } from "./version.js";

export const REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY = "replayTargetOverride";
export const REPLAY_TARGET_OVERRIDE_REQUIRED = "required";
export const MAX_ISSUES_WITH_FRESH_EVIDENCE = 32;
export const MAX_EVIDENCE_CAPTURE_DURATION_MS = 120_000;
export const EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS = 20_000;

const WEB_STAGE_BY_PACK: Readonly<Partial<Record<TestCommandRequest["packs"][number], WebStageName>>> = {
  search: "search",
  settings: "settings",
  accessibility: "accessibility",
  layout: "layout",
  performance: "performance",
  crashes: "crash",
};

const STREAMING_BUDGETS: Readonly<Record<ExplorationProfile, StreamingPackBudgets>> = {
  quick: {
    maxActions: 450,
    maxStates: 100,
    maxLocalDepth: 8,
    maxLocalStates: 28,
    maxDurationMs: 90_000,
  },
  standard: {
    maxActions: 900,
    maxStates: 180,
    maxLocalDepth: 12,
    maxLocalStates: 48,
    maxDurationMs: 180_000,
  },
  deep: {
    maxActions: 1_800,
    maxStates: 360,
    maxLocalDepth: 18,
    maxLocalStates: 96,
    maxDurationMs: 360_000,
  },
};

const WEB_BUDGETS: Readonly<Record<ExplorationProfile, WebPackBudgets>> = {
  quick: {
    maxActions: 320,
    maxStates: 90,
    maxLocalDepth: 8,
    maxLocalStates: 28,
    maxDurationMs: 90_000,
    maxFocusProbes: 12,
    maxSettingsSurfaces: 6,
    maxLogs: 256,
  },
  standard: {
    maxActions: 1_280,
    maxStates: 320,
    maxLocalDepth: 12,
    maxLocalStates: 48,
    maxDurationMs: 600_000,
    maxFocusProbes: 24,
    maxSettingsSurfaces: 12,
    maxLogs: 512,
  },
  deep: {
    maxActions: 1_280,
    maxStates: 320,
    maxLocalDepth: 18,
    maxLocalStates: 96,
    maxDurationMs: 360_000,
    maxFocusProbes: 48,
    maxSettingsSurfaces: 24,
    maxLogs: 1_024,
  },
};

export interface AuditRunProducts {
  readonly navigation: ExplorationResult | null;
  readonly navigationStartup?: StartupPreparationResult | null | undefined;
  readonly navigationFindings: readonly NavigationDiagnosticFinding[];
  readonly streaming: StreamingPackResult | null;
  readonly web: WebPackResult | null;
}

export interface CapturedIssue {
  readonly issue: TVDoctorIssue;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly replay: TVDoctorReplayV1 | null;
  readonly failed: boolean;
}

interface NavigationInventory {
  readonly status: "complete" | "partial";
  readonly screens: readonly {
    readonly key: string;
    readonly label: string | null;
  }[];
  readonly focusTargets: readonly {
    readonly key: string;
    readonly screenKey: string;
    readonly role: string | null;
    readonly name: string | null;
  }[];
  readonly transitions: readonly {
    readonly key: string;
    readonly fromScreenKey: string;
    readonly fromFocusKey: string | null;
    readonly action: RemoteKey;
    readonly toScreenKey: string;
    readonly toFocusKey: string | null;
  }[];
  readonly latencies: readonly {
    readonly key: string;
    readonly operation: string;
    readonly measuredMs: number;
  }[];
}

export interface NodeAuditDependencies {
  readonly createDriver?: () => PlaywrightWebDriver;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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

function selectedPacks(request: TestCommandRequest): ReadonlySet<string> {
  return request.packs.includes("all")
    ? new Set(["navigation", "streaming", ...Object.keys(WEB_STAGE_BY_PACK)])
    : new Set(request.packs);
}

function selectedWebStages(packs: ReadonlySet<string>): readonly WebStageName[] {
  const stages: WebStageName[] = [];
  for (const pack of ["search", "settings", "accessibility", "layout", "performance", "crashes"] as const) {
    if (!packs.has(pack)) continue;
    const stage = WEB_STAGE_BY_PACK[pack];
    if (stage !== undefined) stages.push(stage);
  }
  return stages;
}

function createSafeExplorationDriver(driver: PlaywrightWebDriver): TVDoctorDriver {
  return {
    capabilities: async () => driver.capabilities(),
    snapshot: async () => driver.snapshot(),
    reset: async (strategy) => driver.reset(strategy),
    press: async (key): Promise<ActionResult> => {
      if (key !== "SELECT") return driver.press(key);
      const snapshot = await driver.snapshot();
      const focused = focusedWebEntry(snapshot);
      const own = focused === null
        ? ""
        : normaliseWebSemanticText(focused.node.name ?? focused.node.text);
      const context = focused === null ? "" : webSemanticContext(focused);
      const safeProfileNavigation = focused !== null
        && (own === "profile" || own === "profiles")
        && /\b(nav|navigation|primary|rail)\b/u.test(context)
        && !context.includes("dialog");
      if (focused === null || (!isSafeWebControl(focused.node, context) && !safeProfileNavigation)) {
        return {
          key,
          outcome: "unsupported",
          timing: { inputSentAtMs: Date.now() },
          message: "SELECT was withheld because the focused semantic target was absent, ambiguous, or unsafe.",
        };
      }
      return driver.press(key);
    },
  };
}

function flattenNodes(snapshot: StateSnapshot): readonly UiNodeSnapshot[] {
  if (snapshot.uiTree.status !== "available") return [];
  const result: UiNodeSnapshot[] = [];
  const pending = [...snapshot.uiTree.value];
  while (pending.length > 0 && result.length < 4_096) {
    const node = pending.shift();
    if (node === undefined) break;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

function screenLabel(snapshot: StateSnapshot): string | null {
  const heading = flattenNodes(snapshot).find((node) => node.visible === true && node.role === "heading");
  return heading?.name ?? heading?.text ?? null;
}

function navigationInventory(
  navigation: ExplorationResult | null,
  web: WebPackResult | null,
): NavigationInventory {
  if (navigation === null) {
    return { status: "partial", screens: [], focusTargets: [], transitions: [], latencies: performanceLatencies(web) };
  }
  const screenKeyById = new Map(navigation.graph.screens.states.map((screen) => [screen.id, screen.fingerprint.value]));
  const focusKeyById = new Map(navigation.graph.focus.states.map((focus) => [focus.id, focus.fingerprint.value]));
  return {
    status: navigation.termination.complete ? "complete" : "partial",
    screens: navigation.graph.screens.states.map((screen) => ({
      key: screen.fingerprint.value,
      label: screenLabel(screen.representativeSnapshot),
    })),
    focusTargets: navigation.graph.focus.states.map((focus) => {
      const target = focus.representativeSnapshot.focusedElement.status === "available"
        ? focus.representativeSnapshot.focusedElement.value
        : null;
      return {
        key: focus.fingerprint.value,
        screenKey: screenKeyById.get(focus.screenStateId) ?? focus.screenStateId,
        role: target?.role ?? null,
        name: target?.name ?? null,
      };
    }),
    transitions: navigation.graph.actions.flatMap((action) => {
      if (action.toScreenStateId === null || action.toFocusStateId === null) return [];
      const fromScreenKey = screenKeyById.get(action.fromScreenStateId);
      const toScreenKey = screenKeyById.get(action.toScreenStateId);
      const fromFocusKey = focusKeyById.get(action.fromFocusStateId);
      const toFocusKey = focusKeyById.get(action.toFocusStateId);
      if (fromScreenKey === undefined || toScreenKey === undefined
        || fromFocusKey === undefined || toFocusKey === undefined) return [];
      return [{
        key: `${fromScreenKey}/${fromFocusKey}:${action.key}`,
        fromScreenKey,
        fromFocusKey,
        action: action.key,
        toScreenKey,
        toFocusKey,
      }];
    }),
    latencies: performanceLatencies(web),
  };
}

function performanceLatencies(web: WebPackResult | null): NavigationInventory["latencies"] {
  const observation = web?.stages.find((stage) => stage.stage === "performance")
    ?.observations.find((entry) => entry.kind === "menu-response" && entry.actionResult !== null);
  const action = observation?.actionResult;
  if (action === null || action === undefined) return [];
  const end = action.timing.screenSettledAtMs ?? action.timing.firstResponseAtMs;
  if (end === undefined) return [];
  return [{
    key: "player-settings/menu-response",
    operation: "Player Settings Select to stable surface",
    measuredMs: Math.max(0, end - action.timing.inputSentAtMs),
  }];
}

function specialisedReachabilityScreen(finding: NavigationDiagnosticFinding, navigation: ExplorationResult): boolean {
  if (finding.issue.rule !== "remote.reachability") return false;
  const screen = navigation.graph.screens.states.find((candidate) => candidate.id === finding.source.screenStateId);
  if (screen === undefined) return false;
  const semanticText = flattenNodes(screen.representativeSnapshot)
    .flatMap((node) => [node.name, node.text])
    .filter((value): value is string => value !== null)
    .join(" ")
    .normalize("NFKC")
    .toLowerCase();
  return /\b(player|captions?|search results?|player settings)\b/u.test(semanticText);
}

function streamingSettingsSequence(result: StreamingPackResult | null): readonly RemoteKey[] | undefined {
  const settings = result?.stages.find((stage) => stage.stage === "settings");
  return settings !== undefined && settings.sequence.at(-1) === "SELECT"
    ? settings.sequence
    : undefined;
}

function expandSteps(steps: readonly { readonly key: RemoteKey; readonly repeat: number }[]): readonly RemoteKey[] {
  return steps.flatMap((step) => Array.from({ length: step.repeat }, () => step.key));
}

function streamingStageForRule(rule: string): StreamingStageName | null {
  switch (rule) {
    case "streaming.player-control": return "seek-backward";
    case "streaming.captions": return "caption-selection";
    case "remote.reachability": return "caption-text-colour";
    case "accessibility.pointer-only-control": return "player-volume";
    default: return null;
  }
}

function webObservationForIssue(result: WebPackResult | null, issue: TVDoctorIssue): WebStageObservation | null {
  const stage = result?.stages.find((candidate) => candidate.stage === issue.pack
    || (candidate.stage === "crash" && issue.pack === "crash"));
  if (stage === undefined) return null;
  const preferredKind = issue.rule === "search.remote-flow"
    ? "search-submit"
    : issue.rule === "focus.visibility"
      ? "focus-visibility-proof"
      : issue.rule === "layout.viewport-clipping"
        ? "viewport-geometry"
        : issue.rule === "performance.menu-response"
          ? "menu-response"
          : "driver-logs";
  const candidates = stage.observations.filter((entry) => entry.kind === preferredKind);
  if (issue.rule === "focus.visibility") {
    const ratio = /crop difference ratio: ([0-9.]+)/u.exec(issue.observed)?.[1];
    const exact = ratio === undefined ? undefined : candidates.find((entry) => entry.detail.includes(ratio));
    if (exact !== undefined) return exact;
  }
  return candidates.find((entry) => entry.target !== null) ?? candidates[0] ?? stage.observations[0] ?? null;
}

function sequenceForIssue(products: AuditRunProducts, issue: TVDoctorIssue): readonly RemoteKey[] {
  if (issue.reproduction.status === "available") return expandSteps(issue.reproduction.originalSequence);
  const webObservation = webObservationForIssue(products.web, issue);
  if (webObservation !== null) return webObservation.sequence;
  const streamingStage = streamingStageForRule(issue.rule);
  if (streamingStage !== null) {
    return products.streaming?.stages.find((stage) => stage.stage === streamingStage)?.sequence ?? [];
  }
  const navigation = products.navigationFindings.find((finding) => finding.issue.id === issue.id);
  return navigation?.source.actionSequence ?? [];
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

export function packCoverage(products: AuditRunProducts, packs: ReadonlySet<string>): readonly {
  readonly pack: string;
  readonly status: "completed" | "partial" | "skipped";
}[] {
  const result: { pack: string; status: "completed" | "partial" | "skipped" }[] = [];
  if (packs.has("navigation")) {
    result.push({ pack: "navigation", status: products.navigation?.termination.complete === true ? "completed" : "partial" });
  }
  if (packs.has("streaming")) {
    result.push({ pack: "streaming", status: products.streaming?.status === "complete" ? "completed" : "partial" });
  }
  for (const pack of ["search", "settings", "accessibility", "layout", "performance", "crashes"] as const) {
    if (!packs.has(pack)) continue;
    const expectedStage = WEB_STAGE_BY_PACK[pack];
    const stage = products.web?.stages.find((candidate) => candidate.stage === expectedStage);
    result.push({
      pack,
      status: stage !== undefined && (stage.status === "passed" || stage.status === "failed")
        ? "completed"
        : "partial",
    });
  }
  return result;
}

export function exhaustedBudgets(
  products: AuditRunProducts,
  selectedPacks: ReadonlySet<string>,
): ("actions" | "states" | "depth" | "duration" | "repetitive-items")[] {
  const exhausted = new Set<"actions" | "states" | "depth" | "duration" | "repetitive-items">();
  // A streaming journey may be used internally to establish the player route
  // required by selected web layout/performance stages. Its full-pack budget
  // is not selected coverage and must not make a successfully proven web run
  // contradict itself by reporting an exhausted unrequested pack.
  const reasons = [
    selectedPacks.has("navigation") ? products.navigation?.termination.reason : undefined,
    selectedPacks.has("streaming") ? products.streaming?.termination.reason : undefined,
    products.web?.termination.reason,
  ];
  for (const reason of reasons) {
    if (reason === "max-actions") exhausted.add("actions");
    if (reason === "max-states" || reason === "max-local-states") exhausted.add("states");
    if (reason === "max-depth" || reason === "max-local-depth") exhausted.add("depth");
    if (reason === "max-duration") exhausted.add("duration");
  }
  return [...exhausted];
}

export function partialRunDetails(
  products: AuditRunProducts,
  selectedPacks: ReadonlySet<string>,
  evidenceFailureCount: number,
): readonly string[] {
  const details: string[] = [];
  const startup = products.navigationStartup;
  if (startup !== undefined && startup !== null && startup.status !== "ready") {
    if (startup.status === "setup-blocker") {
      const blocker = startup.blockers[0];
      details.push(`Startup setup blocker: ${blocker?.kind ?? "unknown"}; caller preparation policy was observation-only.`);
    } else {
      details.push(`Startup preparation did not reach a reproducible state (${startup.status}).`);
    }
  }
  if (selectedPacks.has("navigation") && products.navigation?.termination.complete === false) {
    if (products.navigation.termination.reason === "max-duration") {
      details.push(`BOUNDED-INCOMPLETE: navigation reached its ${String(products.navigation.budgets.maxDurationMs / 1_000)}-second safety ceiling with ${String(products.navigation.termination.remainingFrontierEntries ?? 0)} frontier entries and about ${String(products.navigation.termination.remainingCandidateActions ?? 0)} candidate actions remaining.`);
    } else if (products.navigation.termination.reason === "prepared-state-diverged") {
      details.push("Startup preparation state could not be reproduced during replay reconstruction.");
    } else if (products.navigation.termination.reason === "interrupted") {
      details.push("The scan was interrupted; completed navigation coverage was retained.");
    } else {
      details.push(`Partial reason: navigation stopped at ${products.navigation.termination.reason}.`);
    }
  }
  if (selectedPacks.has("streaming") && products.streaming?.status !== "complete") {
    details.push(`Partial reason: streaming stopped at ${products.streaming?.termination.reason ?? "unavailable"}: ${products.streaming?.termination.detail ?? "No streaming result was produced."}`);
  }
  if (products.web?.termination.complete === false) {
    details.push(`Partial reason: web diagnostics stopped at ${products.web.termination.reason}: ${products.web.termination.detail}`);
  }
  for (const stage of products.web?.stages ?? []) {
    if (stage.status === "partial" || stage.status === "unobservable" || stage.status === "skipped") {
      details.push(`Partial pack ${stage.stage === "crash" ? "crashes" : stage.stage}: ${stage.status}: ${stage.detail}`);
    }
  }
  if (evidenceFailureCount > 0) {
    details.push(`Partial reason: fresh evidence was unavailable for ${String(evidenceFailureCount)} issue${evidenceFailureCount === 1 ? "" : "s"}.`);
  }
  return details.slice(0, 12);
}

function highestSeverity(issues: readonly TVDoctorIssue[]): TestCommandResult["highestSeverity"] {
  const order = ["critical", "high", "medium", "low", "info"] as const;
  return order.find((severity) => issues.some((issue) => issue.severity === severity)) ?? null;
}

export function targetRequiresReplayOverride(target: string): boolean {
  const parsed = new URL(target);
  return parsed.search.length > 0 || parsed.hash.length > 0;
}

/** Exclusively reserve a new output leaf before constructing a browser. */
export async function reserveAuditOutput(outputPath: string): Promise<ArtifactStore> {
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await mkdir(absoluteOutput);
  return await createArtifactStore(absoluteOutput);
}

async function writeFailedRunReport(
  store: ArtifactStore,
  request: TestCommandRequest,
  startedAt: Date,
  error: unknown,
): Promise<TestCommandResult> {
  const reason = sanitiseUntrustedText(error instanceof Error ? error.message : String(error), 1_000);
  const summary = /page\.goto|net::|ERR_(?:CONNECTION|NAME|TIMED)|ECONNREFUSED|ENOTFOUND/iu.test(reason)
    ? "The website could not be reached. Check the address and network connection."
    : /executable.*doesn.t exist|browser.*(?:not found|missing)|playwright.*install/iu.test(reason)
      ? "Chromium is unavailable for web testing."
      : /EACCES|EPERM|ENOENT/iu.test(reason)
        ? "TVDoctor could not access a required file or folder."
        : "TVDoctor could not complete this scan because the browser session failed.";
  await store.writeBundleFile(
    "failure-debug.json",
    `${stableJson({ schemaVersion: 1, reason })}\n`,
  );
  const completedAt = new Date();
  const report = buildTVDoctorReportV1({
    run: {
      id: `failed-${startedAt.getTime().toString(36)}`,
      tvdoctorVersion: CLI_VERSION,
      mode: request.mode,
      status: "failed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    },
    target: {
      name: new URL(request.target).hostname,
      platform: "web",
      location: request.target,
      environment: { browser: "chromium", failure: summary },
    },
    coverage: {
      screenStatesDiscovered: 0,
      focusStatesDiscovered: 0,
      transitionsTested: 0,
      actionsSent: 0,
      capabilitiesObserved: [],
      packs: [...selectedPacks(request)].map((pack) => ({ pack, status: "skipped" as const })),
      budget: {
        maxActions: null,
        maxStates: null,
        maxDepth: null,
        maxDurationMs: null,
        maxRepetitiveItems: null,
        exhausted: [],
      },
    },
    issues: [],
    artifacts: [],
    replays: [],
  });
  const bundle = await writeReportBundle(store, report);
  return {
    status: "failed",
    issueCount: 0,
    highestSeverity: null,
    reportPath: bundle.reportJson.absolutePath,
    details: [
      "The scan could not complete.",
      summary,
      "Technical detail was retained in failure-debug.json.",
      `Report: ${bundle.reportHtml.absolutePath}`,
    ],
  };
}

async function writeSetupNotStartedReport(
  store: ArtifactStore,
  request: TestCommandRequest,
  startedAt: Date,
  startup: StartupPreparationResult,
  findings: readonly NavigationDiagnosticFinding[],
): Promise<TestCommandResult> {
  const blocker = startup.blockers[0];
  const labels: Readonly<Record<string, string>> = {
    "consent-wall": "cookie consent screen",
    onboarding: "onboarding screen",
    login: "login screen",
    "region-selection": "region selection screen",
    "age-gate": "age gate",
    "system-setup": "setup screen",
  };
  const label = blocker === undefined ? "startup setup screen" : labels[blocker.kind] ?? blocker.kind;
  const completedAt = new Date();
  const issues = findings.map((finding) => finding.issue);
  const report = buildTVDoctorReportV1({
    run: {
      id: `setup-${startedAt.getTime().toString(36)}`,
      tvdoctorVersion: CLI_VERSION,
      mode: request.mode,
      status: startup.status === "setup-blocker" ? "partial" : "failed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    },
    target: {
      name: new URL(request.target).hostname,
      platform: "web",
      location: request.target,
      environment: { browser: "chromium", outcome: "scan-not-started" },
    },
    coverage: {
      screenStatesDiscovered: 0,
      focusStatesDiscovered: 0,
      transitionsTested: 0,
      actionsSent: 0,
      capabilitiesObserved: [],
      packs: [...selectedPacks(request)].map((pack) => ({
        pack,
        status: pack === "navigation" ? "partial" as const : "skipped" as const,
      })),
      budget: {
        maxActions: null,
        maxStates: null,
        maxDepth: null,
        maxDurationMs: null,
        maxRepetitiveItems: null,
        exhausted: [],
      },
    },
    issues,
    artifacts: [],
    replays: [],
  });
  const bundle = await writeReportBundle(store, report);
  const changedNothing = startup.status === "setup-blocker";
  return {
    status: startup.status === "setup-blocker" ? "partial" : "failed",
    issueCount: issues.length,
    highestSeverity: highestSeverity(issues),
    reportPath: bundle.reportJson.absolutePath,
    details: [
      `The scan was not started because TVDoctor found a ${label}.`,
      changedNothing
        ? "No consent or persistent state was changed."
        : "TVDoctor could not safely complete the selected setup choice.",
      `Report: ${bundle.reportHtml.absolutePath}`,
    ],
  };
}

export async function writeAuditAuxiliaryArtifacts(
  store: ArtifactStore,
  ledgerValue: JsonValue,
  inventoryValue: JsonValue,
): Promise<readonly ArtifactDescriptor[]> {
  const ledgerText = stableJson(sanitiseEvidenceJson(ledgerValue));
  await store.writeBundleFile("stage-ledger.json", ledgerText);
  const inventoryText = stableJson(sanitiseEvidenceJson(inventoryValue));
  await store.writeBundleFile("inventory.json", inventoryText);
  return [
    {
      id: "run:stage-ledger",
      kind: "report",
      status: "available",
      path: "stage-ledger.json",
      mediaType: "application/json",
      byteLength: Buffer.byteLength(ledgerText),
      sha256: createHash("sha256").update(ledgerText).digest("hex"),
    },
    {
      id: "run:inventory",
      kind: "report",
      status: "available",
      path: "inventory.json",
      mediaType: "application/json",
      byteLength: Buffer.byteLength(inventoryText),
      sha256: createHash("sha256").update(inventoryText).digest("hex"),
    },
  ];
}

function preferredStartupControl(
  decision: "reject" | "accept",
  blockerKind: string,
  controls: readonly StartupControlCandidate[],
): StartupControlCandidate | null {
  const normalise = (value: string | null | undefined): string =>
    value?.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ?? "";
  const rejectWords = decision === "reject"
    ? /\b(?:reject|deny|decline|essential|necessary|manage|options|preferences)\b/u
    : /\b(?:accept(?: all)?|agree|allow|continue|got it|ok(?:ay)?)\b/u;
  const candidates = [...controls].sort((left, right) => {
    const leftFocused = left.focused === true ? 0 : 1;
    const rightFocused = right.focused === true ? 0 : 1;
    return leftFocused - rightFocused;
  });
  return candidates.find((control) => rejectWords.test(normalise(control.name))) ?? null;
}

function startupActivationSequence(
  controls: readonly StartupControlCandidate[],
  target: StartupControlCandidate,
): readonly RemoteKey[] {
  const focusedIndex = controls.findIndex((control) => control.focused === true);
  const targetIndex = controls.indexOf(target);
  if (targetIndex < 0) return [];
  if (focusedIndex < 0 || focusedIndex === targetIndex) return ["SELECT"];
  const distance = (targetIndex - focusedIndex + controls.length) % controls.length;
  return [...Array.from({ length: distance }, () => "TAB" as RemoteKey), "SELECT"];
}

async function runAudit(
  request: TestCommandRequest,
  createDriver: () => PlaywrightWebDriver,
): Promise<TestCommandResult> {
  const store = await reserveAuditOutput(request.outputPath);
  const startedAt = new Date();
  const packs = selectedPacks(request);
  const webStages = selectedWebStages(packs);
  const needStreamingJourney = packs.has("streaming") || webStages.includes("layout") || webStages.includes("performance");
  const driver = createDriver();
  let capabilities: ReadonlySet<Capability>;
  let navigation: ExplorationResult | null = null;
  let navigationFindings: readonly NavigationDiagnosticFinding[] = [];
  let navigationStartup: StartupPreparationResult | null = null;
  let startupFindings: readonly NavigationDiagnosticFinding[] = [];
  let startupPreparationMs = 0;
  let navigationDriverPerformance: WebDriverPerformanceProfile | null = null;
  let navigationExplorationMs = 0;
  let navigationDiagnosticsMs = 0;
  let streaming: StreamingPackResult | null = null;
  let web: WebPackResult | null = null;
  let failureCloseHandled = false;
  try {
    await driver.launch({ id: "cli-web-audit", launchUri: request.target });
    capabilities = await driver.capabilities();
    if (packs.has("navigation")) {
      const preparationStartedAt = performance.now();
      navigationStartup = await prepareStartup(driver, {
        policy: request.startupActions === undefined
          ? { kind: "observe" }
          : { kind: "remote-sequence", actions: request.startupActions as RemoteKey[] },
        resetStrategy: "reload",
        stability: request.mode === "quick"
          ? { maxSnapshots: 4, requiredStableSnapshots: 2, pollIntervalMs: 100, timeoutMs: 8_000 }
          : { maxSnapshots: 8, requiredStableSnapshots: 2, pollIntervalMs: 200, timeoutMs: 20_000 },
      });
      startupPreparationMs = Math.max(0, performance.now() - preparationStartedAt);
      if (
        request.startupDecision !== undefined
        && navigationStartup.status === "setup-blocker"
        && navigationStartup.blockers[0] !== undefined
      ) {
        const blocker = navigationStartup.blockers[0];
        if (blocker === undefined) throw new TypeError("Startup blocker disappeared before preparation.");
        const control = preferredStartupControl(
          request.startupDecision,
          blocker.kind,
          navigationStartup.controls,
        );
        const actions = control === null ? [] : startupActivationSequence(
          navigationStartup.controls,
          control,
        );
        navigationStartup = await prepareStartup(driver, {
          policy: { kind: "remote-sequence", actions },
          resetStrategy: "reload",
          stability: request.mode === "quick"
            ? { maxSnapshots: 4, requiredStableSnapshots: 2, pollIntervalMs: 100, timeoutMs: 8_000 }
            : { maxSnapshots: 8, requiredStableSnapshots: 2, pollIntervalMs: 200, timeoutMs: 20_000 },
        });
      }
    }
    if (packs.has("navigation")
      && navigationStartup !== null
      && navigationStartup.representativeSnapshot !== undefined
      && navigationStartup.blockers.length > 0) {
      const startupBlocker = navigationStartup.blockers[0];
      if (startupBlocker === undefined) throw new TypeError("Startup blocker evidence disappeared.");
      startupFindings = [{
        classification: "deterministic",
        issue: createStartupBlockerFinding(
          startupBlocker,
          navigationStartup.representativeSnapshot,
          navigationStartup.resetStrategy,
          navigationStartup.status === "ready",
          navigationStartup.policy.kind === "remote-sequence"
            ? navigationStartup.policy.actions
            : [],
        ).issue,
        source: {
          kind: "screen-analysis",
          screenStateId: "startup-blocker",
          focusStateId: null,
          element: startupBlocker.element,
          actionAttemptId: null,
          relatedActionAttemptId: null,
          actionSequence: [],
          locallyComplete: null,
        },
        target: {
          screenStateId: "startup-blocker",
          focusStateId: null,
          element: startupBlocker.element,
          expectedElement: null,
          observedElement: startupBlocker.focusedElement,
        },
      }];
    }
    if (packs.has("navigation") && navigationStartup?.status === "ready" && navigationStartup.restoreToPreparedState !== undefined) {
      const explorationStartedAt = performance.now();
      navigation = await explore(createSafeExplorationDriver(driver), {
        profile: request.mode,
        resetStrategy: "reload",
        restoreInitialSnapshot: navigationStartup.restoreToPreparedState,
        ...(request.maxDurationMs === undefined ? {} : { budgets: { maxDurationMs: request.maxDurationMs } }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        settling: {
        strategy: "stable-snapshot",
        maxSnapshots: 3,
        pollIntervalMs: 20,
        requiredStableSnapshots: 2,
        },
      });
      navigationExplorationMs = Math.max(0, performance.now() - explorationStartedAt);
      navigationDriverPerformance = driver.getPerformanceProfile();
      const diagnosticsStartedAt = performance.now();
      navigationFindings = [
        ...startupFindings,
        ...diagnoseNavigation(navigation).findings.filter((finding) => (
          !specialisedReachabilityScreen(finding, navigation as ExplorationResult)
        )),
      ];
      navigationDiagnosticsMs = Math.max(0, performance.now() - diagnosticsStartedAt);
    }
    if (packs.has("navigation") && navigationStartup?.status !== "ready") {
      navigationFindings = startupFindings;
      if (navigationStartup !== null) {
        return await writeSetupNotStartedReport(
          store,
          request,
          startedAt,
          navigationStartup,
          navigationFindings,
        );
      }
    }
    if (request.signal?.aborted !== true && needStreamingJourney) {
      streaming = await runStreamingPack(driver, {
        budgets: STREAMING_BUDGETS[request.mode],
        resetStrategy: "reload",
        pointerProbe: createStreamingAuditPointerProbe(request.target, createDriver),
      });
    }
    if (request.signal?.aborted !== true && webStages.length > 0) {
      const playerSettingsSequence = streamingSettingsSequence(streaming);
      web = await runWebPack(driver, {
        stages: webStages,
        budgets: WEB_BUDGETS[request.mode],
        resetStrategy: "reload",
        searchQuery: request.searchQuery,
        ...(playerSettingsSequence === undefined
          ? {}
          : { playerSettingsSequence }),
        ...(webStages.includes("performance") ? { menuResponseThresholdMs: 1_000 } : {}),
        hooks: createWebAuditHooks({ target: request.target, driver, createDriver }),
      });
    }
  } catch (error) {
    await driver.close().catch(() => undefined);
    failureCloseHandled = true;
    return await writeFailedRunReport(store, request, startedAt, error);
  } finally {
    if (!failureCloseHandled) {
      await driver.close().catch((error: unknown) => {
        if (request.signal?.aborted !== true) throw error;
      });
    }
  }

  const products: AuditRunProducts = {
    navigation,
    navigationStartup,
    navigationFindings,
    streaming,
    web,
  };
  const rawIssues = [
    ...navigationFindings.map((finding) => finding.issue),
    ...(packs.has("streaming") ? streaming?.issues ?? [] : []),
    ...(web?.issues ?? []),
  ];
  const uniqueIssues = rawIssues.filter((issue, index) =>
    rawIssues.findIndex((candidate) => candidate.id === issue.id) === index
  );
  const evidenceStartedAt = performance.now();
  const captured = await captureIssuesWithinBudget(
    store,
    request.target,
    products,
    uniqueIssues,
    createDriver,
    captureIssue,
    Date.now,
    request.signal,
  );
  const evidenceGenerationMs = Math.max(0, performance.now() - evidenceStartedAt);
  const inventory = navigationInventory(navigation, web);
  const ledgerValue = asJson({
    schemaVersion: 1,
    target: request.target,
    mode: request.mode,
    selectedPacks: [...packs],
    startupPreparation: navigationStartup === null ? null : {
      status: navigationStartup.status,
      policy: navigationStartup.policy.kind,
      actions: navigationStartup.policy.kind === "remote-sequence" ? [...navigationStartup.policy.actions] : [],
      identityHash: navigationStartup.identityHash,
      blockers: navigationStartup.blockers,
      controls: navigationStartup.controls,
      steps: navigationStartup.steps,
    },
    timings: {
      navigationExplorationMs,
      startupPreparationMs,
      navigationDiagnosticsMs,
      evidenceGenerationMs,
    },
    navigationDriverPerformance,
    navigation: navigation === null ? null : { termination: navigation.termination, statistics: navigation.statistics },
    navigationFindings: navigationFindings.map((finding) => ({ id: finding.issue.id, rule: finding.issue.rule, classification: finding.classification })),
    streaming: streaming === null ? null : { status: streaming.status, termination: streaming.termination, statistics: streaming.statistics, stages: streaming.stages },
    web: web === null ? null : { status: web.status, termination: web.termination, statistics: web.statistics, stages: web.stages },
  });
  const globalArtifacts = await writeAuditAuxiliaryArtifacts(store, ledgerValue, asJson(inventory));
  const evidenceFailed = captured.some((entry) => entry.failed);
  const coverage = packCoverage(products, packs);
  const runPartial = request.signal?.aborted === true
    || evidenceFailed
    || coverage.some((entry) => entry.status !== "completed");
  const completedAt = new Date();
  const report = buildTVDoctorReportV1({
    run: {
      id: `audit-${startedAt.getTime().toString(36)}`,
      tvdoctorVersion: CLI_VERSION,
      mode: request.mode,
      status: runPartial ? "partial" : "completed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    },
    target: {
      name: new URL(request.target).hostname,
      platform: "web",
      location: request.target,
      environment: {
        browser: "chromium",
        viewport: "1280x720",
        orchestration: "bounded semantic local audit",
        ...(targetRequiresReplayOverride(request.target)
          ? { [REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]: REPLAY_TARGET_OVERRIDE_REQUIRED }
          : {}),
      },
    },
    coverage: {
      screenStatesDiscovered: navigation?.statistics.screenStates ?? 0,
      focusStatesDiscovered: navigation?.statistics.focusStates
        ?? (streaming?.statistics.uniqueStates ?? 0) + (web?.statistics.uniqueStates ?? 0),
      transitionsTested: navigation?.graph.actions.length ?? 0,
      actionsSent: (navigation?.statistics.physicalActions ?? 0)
        + (streaming?.statistics.physicalActions ?? 0)
        + (web?.statistics.physicalActions ?? 0),
      capabilitiesObserved: [...capabilities],
      packs: coverage,
      budget: {
        maxActions: (navigation?.budgets.maxActions ?? 0)
          + (streaming?.budgets.maxActions ?? 0)
          + (web?.budgets.maxActions ?? 0),
        maxStates: (navigation?.budgets.maxStates ?? 0)
          + (streaming?.budgets.maxStates ?? 0)
          + (web?.budgets.maxStates ?? 0),
        maxDepth: Math.max(
          navigation?.budgets.maxDepth ?? 0,
          streaming?.budgets.maxLocalDepth ?? 0,
          web?.budgets.maxLocalDepth ?? 0,
        ),
        maxDurationMs: (navigation?.budgets.maxDurationMs ?? 0)
          + (streaming?.budgets.maxDurationMs ?? 0)
          + (web?.budgets.maxDurationMs ?? 0),
        maxRepetitiveItems: request.mode === "quick" ? 1 : request.mode === "standard" ? 2 : 4,
        exhausted: exhaustedBudgets(products, packs),
      },
    },
    issues: captured.map((entry) => entry.issue),
    artifacts: [...globalArtifacts, ...captured.flatMap((entry) => entry.artifacts)],
    replays: captured.flatMap((entry) => entry.replay === null ? [] : [entry.replay]),
  });
  const bundle = await writeReportBundle(store, report);
  const evidenceFailureCount = captured.filter((entry) => entry.failed).length;
  return {
    status: report.run.status,
    issueCount: report.issues.length,
    highestSeverity: highestSeverity(report.issues),
    reportPath: bundle.reportJson.absolutePath,
    details: [
      `Packs ${String(coverage.filter((entry) => entry.status === "completed").length)}/${String(coverage.length)} completed`,
      `Actions ${String(report.coverage.actionsSent)}/${String(report.coverage.budget.maxActions ?? 0)}`,
      `States ${String(report.coverage.focusStatesDiscovered)}; issues ${String(report.issues.length)}; evidence failures ${String(evidenceFailureCount)}`,
      ...(runPartial ? partialRunDetails(products, packs, evidenceFailureCount) : []),
    ],
  };
}

export function createNodeAuditOperation(
  dependencies: NodeAuditDependencies = {},
): (request: TestCommandRequest) => Promise<TestCommandResult> {
  const createDriver = dependencies.createDriver ?? (() => new PlaywrightWebDriver({
    browserLaunchOptions: { handleSIGINT: false },
    settle: { ambientChurnEscape: true },
  }));
  return async (request) => runAudit(request, createDriver);
}
