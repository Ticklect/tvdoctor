import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  compileIssueReplay,
  diagnoseNavigation,
  explore,
  type ExplorationProfile,
  type ExplorationResult,
  type NavigationDiagnosticFinding,
} from "@tvdoctor/core";
import {
  PlaywrightWebDriver,
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

interface AuditRunProducts {
  readonly navigation: ExplorationResult | null;
  readonly navigationFindings: readonly NavigationDiagnosticFinding[];
  readonly streaming: StreamingPackResult | null;
  readonly web: WebPackResult | null;
}

interface CapturedIssue {
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

async function captureContext(
  target: string,
  sequence: readonly RemoteKey[],
  createDriver: () => PlaywrightWebDriver,
): Promise<{
  readonly before: StateSnapshot;
  readonly after: StateSnapshot;
  readonly beforePng: Uint8Array;
  readonly afterPng: Uint8Array;
  readonly action: ActionResult | null;
  readonly logs: readonly WebLogEntry[];
}> {
  const driver = createDriver();
  await driver.launch({ id: "cli-issue-evidence", launchUri: target });
  try {
    const setup = sequence.length === 0 ? [] : sequence.slice(0, -1);
    for (const key of setup) {
      const result = await driver.press(key);
      if (result.outcome !== "applied") throw new Error(`Evidence setup ${key} was ${result.outcome}.`);
    }
    const before = await driver.snapshot();
    const beforePng = await driver.getPage().screenshot({ type: "png", animations: "disabled" });
    const assertion = sequence.at(-1);
    const action = assertion === undefined ? null : await driver.press(assertion);
    if (action !== null && action.outcome !== "applied") {
      throw new Error(`Evidence assertion ${assertion} was ${action.outcome}.`);
    }
    const after = await driver.snapshot();
    const afterPng = await driver.getPage().screenshot({ type: "png", animations: "disabled" });
    return { before, after, beforePng, afterPng, action, logs: await driver.getLogs() };
  } finally {
    await driver.close();
  }
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

async function captureIssue(
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
  try {
    const context = await captureContext(target, sequence, createDriver);
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
          const value = asJson({ before: boundedSnapshot(context.before), after: boundedSnapshot(context.after) });
          sanitiseEvidenceJson(value);
          return { status: "available" as const, format: "json" as const, value };
        })(),
      })),
      safeArtifact("transition", () => ({
        slot: "transition" as const,
        capture: (() => {
          const value = asJson({ transition: sourceIssue.transition, action: context.action });
          sanitiseEvidenceJson(value);
          return { status: "available" as const, format: "json" as const, value };
        })(),
      })),
      safeArtifact("console-log", () => ({
        slot: "console-log" as const,
        capture: (() => {
          const value = asJson(context.logs);
          sanitiseEvidenceJson(value);
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
        { slot: "navigation-path", capture: { status: "available", format: "json", value: asJson({ resetStrategy: "reload", exactResetRelativeSequence: sequence }) } },
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
    return { issue, artifacts: written.descriptors, replay: plan?.replay ?? null, failed: false };
  } catch (error) {
    const written = await writeIssueEvidence(store, {
      issueId: sourceIssue.id,
      artifacts: [
        { slot: "before-screenshot", capture: { status: "failed", reason: `Evidence capture failed: ${error instanceof Error ? error.message : String(error)}` } },
        { slot: "after-screenshot", capture: { status: "failed", reason: "The evidence journey did not complete." } },
        { slot: "ui-excerpt", capture: { status: "failed", reason: "The evidence journey did not complete." } },
        { slot: "transition", capture: { status: "failed", reason: "The evidence journey did not complete." } },
        { slot: "console-log", capture: { status: "failed", reason: "The evidence journey did not complete." } },
        { slot: "navigation-path", capture: { status: "available", format: "json", value: asJson({ exactResetRelativeSequence: sequence }) } },
        { slot: "replay", capture: { status: "unavailable", reason: "Evidence capture failed before a replay artifact could be retained." } },
        { slot: "trace", capture: { status: "unavailable", reason: "Browser tracing was disabled." } },
      ],
    });
    return { issue: sourceIssue, artifacts: written.descriptors, replay: null, failed: true };
  }
}

function packCoverage(products: AuditRunProducts, packs: ReadonlySet<string>): readonly {
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
  for (const stage of products.web?.stages ?? []) {
    result.push({
      pack: stage.stage === "crash" ? "crashes" : stage.stage,
      status: stage.status === "passed" || stage.status === "failed" ? "completed" : "partial",
    });
  }
  return result;
}

function exhaustedBudgets(products: AuditRunProducts): ("actions" | "states" | "depth" | "duration" | "repetitive-items")[] {
  const exhausted = new Set<"actions" | "states" | "depth" | "duration" | "repetitive-items">();
  const reasons = [
    products.navigation?.termination.reason,
    products.streaming?.termination.reason,
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

function highestSeverity(issues: readonly TVDoctorIssue[]): TestCommandResult["highestSeverity"] {
  const order = ["critical", "high", "medium", "low", "info"] as const;
  return order.find((severity) => issues.some((issue) => issue.severity === severity)) ?? null;
}

async function runAudit(
  request: TestCommandRequest,
  createDriver: () => PlaywrightWebDriver,
): Promise<TestCommandResult> {
  const startedAt = new Date();
  const packs = selectedPacks(request);
  const webStages = selectedWebStages(packs);
  const needStreamingJourney = packs.has("streaming") || webStages.includes("layout") || webStages.includes("performance");
  const driver = createDriver();
  let capabilities: ReadonlySet<Capability>;
  let navigation: ExplorationResult | null = null;
  let navigationFindings: readonly NavigationDiagnosticFinding[] = [];
  let streaming: StreamingPackResult | null = null;
  let web: WebPackResult | null = null;
  try {
    await driver.launch({ id: "cli-web-audit", launchUri: request.target });
    capabilities = await driver.capabilities();
    if (packs.has("navigation")) {
      navigation = await explore(createSafeExplorationDriver(driver), {
        profile: request.mode,
        resetStrategy: "reload",
      settling: {
        strategy: "stable-snapshot",
        maxSnapshots: 3,
        pollIntervalMs: 20,
        requiredStableSnapshots: 2,
        },
      });
      navigationFindings = diagnoseNavigation(navigation).findings
        .filter((finding) => !specialisedReachabilityScreen(finding, navigation as ExplorationResult));
    }
    if (needStreamingJourney) {
      streaming = await runStreamingPack(driver, {
        budgets: STREAMING_BUDGETS[request.mode],
        resetStrategy: "reload",
        pointerProbe: createStreamingAuditPointerProbe(request.target, createDriver),
      });
    }
    if (webStages.length > 0) {
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
  } finally {
    await driver.close();
  }

  const products: AuditRunProducts = { navigation, navigationFindings, streaming, web };
  const rawIssues = [
    ...navigationFindings.map((finding) => finding.issue),
    ...(packs.has("streaming") ? streaming?.issues ?? [] : []),
    ...(web?.issues ?? []),
  ];
  const uniqueIds = new Set(rawIssues.map((issue) => issue.id));
  if (uniqueIds.size !== rawIssues.length) throw new TypeError("Audit packs produced duplicate semantic issue IDs.");

  const store = await createArtifactStore(request.outputPath);
  const captured: CapturedIssue[] = [];
  for (const issue of rawIssues) {
    captured.push(await captureIssue(store, request.target, products, issue, createDriver));
  }
  const inventory = navigationInventory(navigation, web);
  const ledgerValue = asJson({
    schemaVersion: 1,
    target: request.target,
    mode: request.mode,
    selectedPacks: [...packs],
    navigation: navigation === null ? null : { termination: navigation.termination, statistics: navigation.statistics },
    navigationFindings: navigationFindings.map((finding) => ({ id: finding.issue.id, rule: finding.issue.rule, classification: finding.classification })),
    streaming: streaming === null ? null : { status: streaming.status, termination: streaming.termination, statistics: streaming.statistics, stages: streaming.stages },
    web: web === null ? null : { status: web.status, termination: web.termination, statistics: web.statistics, stages: web.stages },
  });
  const ledgerText = stableJson(ledgerValue);
  await store.writeBundleFile("stage-ledger.json", ledgerText);
  const inventoryText = stableJson(asJson(inventory));
  await store.writeBundleFile("inventory.json", inventoryText);
  const globalArtifacts: ArtifactDescriptor[] = [
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
  const evidenceFailed = captured.some((entry) => entry.failed);
  const coverage = packCoverage(products, packs);
  const runPartial = evidenceFailed || coverage.some((entry) => entry.status !== "completed");
  const completedAt = new Date();
  const report = buildTVDoctorReportV1({
    run: {
      id: `audit-${startedAt.getTime().toString(36)}`,
      tvdoctorVersion: "0.0.0",
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
        exhausted: exhaustedBudgets(products),
      },
    },
    issues: captured.map((entry) => entry.issue),
    artifacts: [...globalArtifacts, ...captured.flatMap((entry) => entry.artifacts)],
    replays: captured.flatMap((entry) => entry.replay === null ? [] : [entry.replay]),
  });
  const bundle = await writeReportBundle(store, report);
  return {
    status: report.run.status,
    issueCount: report.issues.length,
    highestSeverity: highestSeverity(report.issues),
    reportPath: bundle.reportJson.absolutePath,
    details: [
      `Packs ${String(coverage.filter((entry) => entry.status === "completed").length)}/${String(coverage.length)} completed`,
      `Actions ${String(report.coverage.actionsSent)}/${String(report.coverage.budget.maxActions ?? 0)}`,
      `States ${String(report.coverage.focusStatesDiscovered)}; issues ${String(report.issues.length)}; evidence failures ${String(captured.filter((entry) => entry.failed).length)}`,
    ],
  };
}

export function createNodeAuditOperation(
  dependencies: NodeAuditDependencies = {},
): (request: TestCommandRequest) => Promise<TestCommandResult> {
  const createDriver = dependencies.createDriver ?? (() => new PlaywrightWebDriver({
    settle: { ambientChurnEscape: true },
  }));
  return async (request) => runAudit(request, createDriver);
}
