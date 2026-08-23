import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import {
  compileIssueReplay,
  diagnoseNavigation,
  executeReplay,
  explore,
  fingerprintSnapshot,
  type CompiledReplayPlan,
  type ExplorationActionAttempt,
  type ExplorationResult,
  type FocusState,
  type NavigationDiagnosticFinding,
  type ScreenState,
  type ScreenTransition,
  type FocusTransition,
} from "@tvdoctor/core";
import {
  PlaywrightWebDriver,
  WEB_DRIVER_CAPABILITIES,
  type WebLogEntry,
} from "@tvdoctor/driver-web";
import {
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportJson,
  type ActionResult,
  type ArtifactDescriptor,
  type ElementBounds,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  createArtifactStore,
  renderReportJson,
  writeIssueEvidence,
  writeReportBundle,
  type ArtifactStore,
  type IssueEvidenceSlot,
  type JsonObject,
  type JsonValue,
} from "../src/index.js";

interface TraceSource {
  readonly sequence: readonly RemoteKey[];
  readonly expectedFocus: string;
  readonly actions: readonly RemoteKey[];
}

interface MutableScreenState {
  readonly id: string;
  readonly fingerprint: ScreenState["fingerprint"];
  readonly firstSeenDepth: number;
  readonly discoveredBy: readonly RemoteKey[];
  readonly representativeSnapshot: StateSnapshot;
  readonly focusStateIds: string[];
}

interface EvidenceCaptureResult {
  readonly descriptors: readonly ArtifactDescriptor[];
  readonly issue: TVDoctorIssue;
}

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(packageDirectory, "../../..");
const artifactRoot = resolve(workspaceDirectory, "artifacts/milestone-5-gate");
const DIRECTIONS = ["UP", "RIGHT", "DOWN", "LEFT"] as const;
const HOME_BUDGETS = {
  maxActions: 260,
  maxStates: 40,
  maxDepth: 8,
  maxDurationMs: 120_000,
} as const;
const REQUIRED_ISSUE_ARTIFACT_SLOTS = [
  "before-screenshot",
  "after-screenshot",
  "ui-excerpt",
  "transition",
  "console-log",
  "navigation-path",
  "replay",
  "trace",
] as const satisfies readonly IssueEvidenceSlot[];

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The integration fixture URL is required.");
  return baseURL;
}

function stateId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(4, "0")}`;
}

function focusedStableId(snapshot: StateSnapshot): string | null {
  return snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId ?? null
    : null;
}

function createFixtureDriver(artifactsDirectory?: string): PlaywrightWebDriver {
  return new PlaywrightWebDriver({
    ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }),
    settle: {
      noResponseGraceMs: 15,
      quietWindowMs: 20,
      timeoutMs: 5_000,
    },
  });
}

async function exploreHome(fixtureUrl: string): Promise<ExplorationResult> {
  const driver = createFixtureDriver();
  await driver.launch({ id: "northstar-m5-home", launchUri: fixtureUrl });
  try {
    return await explore(driver, { actions: DIRECTIONS, budgets: HOME_BUDGETS });
  } finally {
    await driver.close();
  }
}

async function captureTargetedProbe(
  fixtureUrl: string,
  sources: readonly TraceSource[],
  actionOrder: readonly RemoteKey[],
): Promise<ExplorationResult> {
  const driver = createFixtureDriver();
  const startedAt = performance.now();
  let physicalActions = 0;
  let explorationActions = 0;
  const screens: MutableScreenState[] = [];
  const focusStates: FocusState[] = [];
  const attempts: ExplorationActionAttempt[] = [];
  const focusTransitions: FocusTransition[] = [];
  const screenTransitions: ScreenTransition[] = [];
  const screenByFingerprint = new Map<string, MutableScreenState>();
  const focusByFingerprint = new Map<string, FocusState>();

  const register = (snapshot: StateSnapshot, sequence: readonly RemoteKey[]): FocusState => {
    const fingerprint = fingerprintSnapshot(snapshot);
    const known = focusByFingerprint.get(fingerprint.stateValue);
    if (known !== undefined) return known;

    let screen = screenByFingerprint.get(fingerprint.screen.value);
    if (screen === undefined) {
      screen = {
        id: stateId("screen", screens.length + 1),
        fingerprint: fingerprint.screen,
        firstSeenDepth: sequence.length,
        discoveredBy: [...sequence],
        representativeSnapshot: snapshot,
        focusStateIds: [],
      };
      screens.push(screen);
      screenByFingerprint.set(fingerprint.screen.value, screen);
    }

    const focus: FocusState = {
      id: stateId("focus", focusStates.length + 1),
      screenStateId: screen.id,
      fingerprint: fingerprint.focus,
      stateFingerprint: fingerprint.stateValue,
      confidence: fingerprint.confidence,
      firstSeenDepth: sequence.length,
      discoveredBy: [...sequence],
      representativeSnapshot: snapshot,
    };
    focusStates.push(focus);
    screen.focusStateIds.push(focus.id);
    focusByFingerprint.set(fingerprint.stateValue, focus);
    return focus;
  };

  const replay = async (sequence: readonly RemoteKey[]): Promise<void> => {
    await driver.reset("reload");
    for (const key of sequence) {
      const result = await driver.press(key);
      physicalActions += 1;
      expect(result).toMatchObject({ key, outcome: "applied" });
    }
  };

  await driver.launch({ id: "northstar-m5-probe", launchUri: fixtureUrl });
  try {
    for (const source of sources) {
      for (const key of source.actions) {
        await replay(source.sequence);
        const beforeSnapshot = await driver.snapshot();
        expect(focusedStableId(beforeSnapshot), source.sequence.join(" ")).toBe(source.expectedFocus);
        const from = register(beforeSnapshot, source.sequence);
        const actionResult = await driver.press(key);
        physicalActions += 1;
        explorationActions += 1;
        expect(actionResult).toMatchObject({ key, outcome: "applied" });
        const afterSnapshot = await driver.snapshot();
        const actionSequence = [...source.sequence, key];
        const to = register(afterSnapshot, actionSequence);
        const attemptId = stateId("action", attempts.length + 1);
        attempts.push({
          id: attemptId,
          fromScreenStateId: from.screenStateId,
          fromFocusStateId: from.id,
          toScreenStateId: to.screenStateId,
          toFocusStateId: to.id,
          key,
          actionSequence,
          actionResult,
          beforeSnapshot,
          afterSnapshot,
          observedFingerprint: fingerprintSnapshot(afterSnapshot),
        });
        if (from.screenStateId === to.screenStateId) {
          focusTransitions.push({
            id: stateId("focus-transition", focusTransitions.length + 1),
            screenStateId: from.screenStateId,
            fromFocusStateId: from.id,
            toFocusStateId: to.id,
            key,
            actionSequence,
            actionResult,
            attemptId,
          });
        } else {
          screenTransitions.push({
            id: stateId("screen-transition", screenTransitions.length + 1),
            fromScreenStateId: from.screenStateId,
            toScreenStateId: to.screenStateId,
            fromFocusStateId: from.id,
            toFocusStateId: to.id,
            key,
            actionSequence,
            actionResult,
            attemptId,
          });
        }
      }
    }
  } finally {
    await driver.close();
  }

  return {
    graph: {
      screens: {
        states: screens.map((screen) => ({ ...screen, focusStateIds: [...screen.focusStateIds] })),
        transitions: screenTransitions,
      },
      focus: { states: focusStates, transitions: focusTransitions },
      actions: attempts,
    },
    termination: { reason: "max-actions", complete: false },
    budgets: {
      maxActions: Math.max(physicalActions, 1),
      maxStates: Math.max(focusStates.length, 1),
      maxDepth: Math.max(...focusStates.map((state) => state.firstSeenDepth), 0),
      maxDurationMs: 150_000,
    },
    actionOrder,
    statistics: {
      physicalActions,
      explorationActions,
      replayActions: physicalActions - explorationActions,
      visitedStates: focusStates.length,
      screenStates: screens.length,
      focusStates: focusStates.length,
      maximumQueueSize: 0,
      elapsedMs: performance.now() - startedAt,
    },
  };
}

function exactlyOneFinding(
  findings: readonly NavigationDiagnosticFinding[],
  rule: string,
  stableId: string,
): NavigationDiagnosticFinding {
  const matches = findings.filter((finding) => (
    finding.issue.rule === rule
    && (finding.target.element?.stableId === stableId
      || finding.source.element?.stableId === stableId)
  ));
  expect(matches, `${rule}:${stableId}`).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) throw new Error(`Missing ${rule}:${stableId}.`);
  return match;
}

function compileFinding(issue: TVDoctorIssue): CompiledReplayPlan {
  const compiled = compileIssueReplay(issue);
  expect(compiled.status, issue.id).toBe("compiled");
  if (compiled.status !== "compiled") throw new Error(compiled.reason.message);
  return compiled.plan;
}

function flattenNodes(snapshot: StateSnapshot): readonly UiNodeSnapshot[] {
  if (snapshot.uiTree.status !== "available") return [];
  const result: UiNodeSnapshot[] = [];
  const pending = [...snapshot.uiTree.value].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return result;
}

function boundsJson(bounds: ElementBounds | undefined | null): JsonValue {
  return bounds === undefined || bounds === null
    ? null
    : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function snapshotExcerpt(snapshot: StateSnapshot, issue: TVDoctorIssue): JsonObject {
  const labels = new Set([
    issue.transition?.fromElement,
    issue.transition?.expectedElement,
    issue.transition?.observedElement,
  ].filter((value): value is string => value !== null && value !== undefined));
  const focus = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value
    : null;
  const relevantNodes = flattenNodes(snapshot)
    .filter((node) => (
      (node.stableId !== null && labels.has(node.stableId))
      || (node.name !== null && labels.has(node.name))
      || node.focused === true
    ))
    .map((node): JsonObject => ({
      stableId: node.stableId,
      role: node.role,
      name: node.name,
      bounds: boundsJson(node.bounds),
      visible: node.visible,
      enabled: node.enabled,
      focusable: node.focusable,
      focused: node.focused,
      modal: node.modal,
    }));
  return {
    capturedAt: snapshot.capturedAt,
    location: snapshot.location.status === "available" ? snapshot.location.value : null,
    focusedElement: focus === null
      ? null
      : {
          stableId: focus.stableId ?? null,
          role: focus.role ?? null,
          name: focus.name ?? null,
          bounds: boundsJson(focus.bounds),
        },
    relevantNodes,
  };
}

function actionResultJson(result: ActionResult | null): JsonValue {
  if (result === null) return null;
  return {
    key: result.key,
    outcome: result.outcome,
    message: result.message ?? null,
    timing: {
      inputSentAtMs: result.timing.inputSentAtMs,
      firstResponseAtMs: result.timing.firstResponseAtMs ?? null,
      focusSettledAtMs: result.timing.focusSettledAtMs ?? null,
      screenSettledAtMs: result.timing.screenSettledAtMs ?? null,
    },
  };
}

function logsJson(logs: readonly WebLogEntry[]): JsonValue {
  return logs.map((entry): JsonObject => ({
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    message: entry.message,
    location: entry.location,
    stack: entry.stack,
  }));
}

function replayYaml(replay: TVDoctorReplayV1): string {
  // JSON is an intentional portable subset of YAML 1.2. Keeping the replay
  // artifact in this form makes its exact semantics independently verifiable
  // without relying on a permissive or host-specific YAML parser.
  return `${JSON.stringify(replay, null, 2)}\n`;
}

async function captureIssueEvidence(
  store: ArtifactStore,
  fixtureUrl: string,
  issue: TVDoctorIssue,
  plan: CompiledReplayPlan,
): Promise<EvidenceCaptureResult> {
  const beforeLocation = await store.reserveIssueArtifact(issue.id, "before-screenshot");
  const afterLocation = await store.reserveIssueArtifact(issue.id, "after-screenshot");
  const driver = createFixtureDriver(store.outputRoot);
  await driver.launch({ id: `m5-evidence-${issue.id}`, launchUri: fixtureUrl });
  try {
    const result = await executeReplay(driver, plan, {
      evidence: {
        async captureBefore() {
          await driver.captureScreenshot(beforeLocation.absolutePath);
        },
        async captureAfter() {
          await driver.captureScreenshot(afterLocation.absolutePath);
        },
      },
    });
    const logs: readonly WebLogEntry[] = await driver.getLogs();
    expect(result.status, issue.id).toBe("reproduced");
    expect(result.evidence.beforeSnapshot).not.toBeNull();
    expect(result.evidence.afterSnapshot).not.toBeNull();
    const before = result.evidence.beforeSnapshot;
    const after = result.evidence.afterSnapshot;
    if (before === null || after === null) throw new Error("Replay evidence snapshots are required.");

    const written = await writeIssueEvidence(store, {
      issueId: issue.id,
      artifacts: [
        {
          slot: "ui-excerpt",
          capture: {
            status: "available",
            format: "json",
            value: {
              before: snapshotExcerpt(before, issue),
              after: snapshotExcerpt(after, issue),
            },
          },
        },
        {
          slot: "transition",
          capture: {
            status: "available",
            format: "json",
            value: {
              assertion: {
                type: plan.assertion.type,
                fromElement: plan.assertion.fromElement,
                action: plan.assertion.action,
                expectedElement: plan.assertion.expectedElement,
                observedElement: plan.assertion.observedElement,
              },
              result: result.status,
              beforeFocus: focusedStableId(before),
              afterFocus: focusedStableId(after),
              actionResult: actionResultJson(result.evidence.assertionActionResult),
            },
          },
        },
        {
          slot: "console-log",
          capture: { status: "available", format: "json", value: logsJson(logs) },
        },
        {
          slot: "navigation-path",
          capture: {
            status: "available",
            format: "json",
            value: {
              resetStrategy: plan.replay.reset.strategy,
              originalSequence: plan.sequence.originalSequence.map((step) => ({ ...step })),
              minimizedSequence: plan.sequence.minimizedSequence?.map((step) => ({ ...step })) ?? null,
              executedSequence: plan.sequence.executedSequence,
              minimization: { ...plan.sequence.minimization },
            },
          },
        },
        {
          slot: "replay",
          capture: {
            status: "available",
            format: "text",
            text: replayYaml(plan.replay),
            mediaType: "text/yaml",
          },
        },
        {
          slot: "trace",
          capture: {
            status: "unavailable",
            reason: "A standalone Playwright trace was not captured for this replay.",
          },
        },
      ],
    });
    const screenshotDescriptors = await Promise.all([
      store.describeExistingIssueArtifact({ issueId: issue.id, slot: "before-screenshot" }),
      store.describeExistingIssueArtifact({ issueId: issue.id, slot: "after-screenshot" }),
    ]);
    const paths: Partial<Record<IssueEvidenceSlot, string>> = {
      ...written.pathsBySlot,
      "before-screenshot": screenshotDescriptors[0].path,
      "after-screenshot": screenshotDescriptors[1].path,
    };
    const transitionPath = paths["transition"] ?? null;
    const uiPath = paths["ui-excerpt"] ?? null;
    const beforePath = paths["before-screenshot"] ?? null;
    const enhancedIssue: TVDoctorIssue = {
      ...issue,
      evidence: [
        ...issue.evidence.map((entry) => ({ ...entry, artifact: transitionPath })),
        {
          kind: "verified-fact",
          summary: "Before and after screenshots were captured around the exact assertion action.",
          source: "PlaywrightWebDriver.captureScreenshot",
          artifact: beforePath,
        },
        {
          kind: "verified-fact",
          summary: "A whitelisted UI-tree excerpt records the relevant controls before and after the action.",
          source: "PlaywrightWebDriver.snapshot",
          artifact: uiPath,
        },
      ],
      reproduction: issue.reproduction.status === "available"
        ? { ...issue.reproduction, artifact: paths["replay"] ?? null }
        : issue.reproduction,
    };
    return {
      descriptors: [...screenshotDescriptors, ...written.descriptors],
      issue: enhancedIssue,
    };
  } finally {
    await driver.close();
  }
}

async function runProcess(command: string, arguments_: readonly string[]): Promise<ProcessResult> {
  return await new Promise((resolveProcess, reject) => {
    const child = spawn(command, arguments_, {
      cwd: workspaceDirectory,
      env: { ...process.env, FORCE_COLOR: undefined },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Child process exceeded its 30 second gate timeout: ${command}`));
    }, 30_000);
    timeout.unref();
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveProcess({ code, stdout, stderr });
    });
  });
}

async function assertArtifactFiles(
  root: string,
  artifacts: readonly ArtifactDescriptor[],
): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.status !== "available") continue;
    const artifactPath = resolve(root, ...artifact.path.split("/"));
    const [metadata, data] = await Promise.all([
      stat(artifactPath),
      readFile(artifactPath),
    ]);
    expect(metadata.isFile(), artifact.path).toBe(true);
    expect(metadata.size, artifact.path).toBe(artifact.byteLength);
    expect(metadata.size, artifact.path).toBeGreaterThan(0);
    expect(createHash("sha256").update(data).digest("hex"), artifact.path)
      .toBe(artifact.sha256);
  }
}

async function assertIssueArtifactCoverage(
  root: string,
  issues: readonly TVDoctorIssue[],
  artifacts: readonly ArtifactDescriptor[],
  replays: readonly TVDoctorReplayV1[],
): Promise<void> {
  const availablePaths = new Set(artifacts.flatMap((artifact) => (
    artifact.status === "available" ? [artifact.path] : []
  )));
  for (const issue of issues) {
    const issueArtifacts = artifacts.filter((artifact) => (
      artifact.id.startsWith(`${issue.id}:`)
    ));
    expect(issueArtifacts.map((artifact) => artifact.id).sort(), `${issue.id} artifact slots`)
      .toEqual(REQUIRED_ISSUE_ARTIFACT_SLOTS
        .map((slot) => `${issue.id}:${slot}`)
        .sort());
    for (const slot of REQUIRED_ISSUE_ARTIFACT_SLOTS) {
      const descriptor = issueArtifacts.find((artifact) => artifact.id === `${issue.id}:${slot}`);
      expect(descriptor, `${issue.id}:${slot}`).toBeDefined();
      expect(descriptor?.status, `${issue.id}:${slot}`).toBe(slot === "trace"
        ? "unavailable"
        : "available");
    }

    const references = [
      ...issue.evidence.map((evidence) => evidence.artifact),
      issue.reproduction.status === "available" ? issue.reproduction.artifact : null,
    ].filter((reference): reference is string => reference !== null);
    expect(references.length, `${issue.id} artifact references`).toBeGreaterThan(0);
    for (const reference of references) {
      expect(availablePaths.has(reference), `${issue.id} references ${reference}`).toBe(true);
    }

    const embedded = replays.filter((replay) => replay.issueId === issue.id);
    expect(embedded, `${issue.id} embedded replay`).toHaveLength(1);
    const replay = embedded[0];
    if (replay === undefined) throw new Error(`Missing embedded replay for ${issue.id}.`);
    const replayDescriptor = issueArtifacts.find((artifact) => (
      artifact.id === `${issue.id}:replay`
    ));
    if (replayDescriptor === undefined || replayDescriptor.status !== "available") {
      throw new Error(`Missing available replay artifact for ${issue.id}.`);
    }
    const replayText = await readFile(
      resolve(root, ...replayDescriptor.path.split("/")),
      "utf8",
    );
    expect(JSON.parse(replayText) as unknown, `${issue.id} replay artifact round trip`)
      .toEqual(replay);
  }
}

test("M5 detects, reports, inspects, and reliably replays three deterministic fixture failures", async ({
  baseURL,
  page,
}, testInfo) => {
  const fixtureUrl = requireBaseURL(baseURL);
  const startedAt = new Date();
  const startedAtMs = performance.now();
  const captionRoot = [
    "RIGHT",
    "SELECT",
    "SELECT",
    "RIGHT",
    "RIGHT",
    "SELECT",
    "DOWN",
    "DOWN",
    "DOWN",
    "SELECT",
  ] as const;
  const [home, captions, details] = await Promise.all([
    exploreHome(fixtureUrl),
    captureTargetedProbe(fixtureUrl, [
      { sequence: captionRoot, expectedFocus: "caption-font-size", actions: DIRECTIONS },
      { sequence: [...captionRoot, "DOWN"], expectedFocus: "caption-background-colour", actions: DIRECTIONS },
      { sequence: [...captionRoot, "DOWN", "DOWN"], expectedFocus: "caption-edge-style", actions: DIRECTIONS },
    ], DIRECTIONS),
    captureTargetedProbe(fixtureUrl, [
      { sequence: ["RIGHT"], expectedFocus: "hero-watch", actions: ["SELECT"] },
      { sequence: ["RIGHT", "SELECT"], expectedFocus: "details-play", actions: ["BACK"] },
    ], ["SELECT", "BACK"]),
  ]);
  const explorations = [home, captions, details] as const;

  const homeFindings = diagnoseNavigation(home).findings;
  const captionFindings = diagnoseNavigation(captions).findings;
  const detailFindings = diagnoseNavigation(details).findings;
  const rawIssues = [
    {
      ...exactlyOneFinding(homeFindings, "remote.reachability", "hero-more-info").issue,
      screen: "Home",
    },
    {
      ...exactlyOneFinding(detailFindings, "remote.back-behaviour", "details-play").issue,
      screen: "Details",
    },
    {
      ...exactlyOneFinding(captionFindings, "remote.reachability", "caption-text-colour").issue,
      screen: "Player > Settings > Captions > Appearance",
    },
  ] satisfies readonly TVDoctorIssue[];
  for (const issue of rawIssues) {
    expect(issue.confidence, issue.id).toBe("deterministic");
    expect(issue.reproduction.status, issue.id).toBe("available");
    expect(issue.transition?.expectedElement, issue.id).not.toBeNull();
  }
  const plans = rawIssues.map((issue) => compileFinding(issue));
  const store = await createArtifactStore(artifactRoot, { overwrite: true });
  const captured = [] as EvidenceCaptureResult[];
  for (const [index, issue] of rawIssues.entries()) {
    const plan = plans[index];
    if (plan === undefined) throw new Error("Missing compiled replay plan.");
    captured.push(await captureIssueEvidence(store, fixtureUrl, issue, plan));
  }

  const completedAt = new Date();
  const report = buildTVDoctorReportV1({
    run: {
      id: `m5-northstar-${String(startedAt.getTime())}`,
      tvdoctorVersion: "0.0.0",
      mode: "standard",
      status: "partial",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
    },
    target: {
      name: "Northstar broken streaming fixture",
      platform: "web",
      location: fixtureUrl,
      environment: {
        browser: "chromium",
        viewport: "1280x720",
        exploration: "Home D-pad crawl plus targeted Caption Appearance and Details probes",
      },
    },
    coverage: {
      screenStatesDiscovered: new Set(explorations.flatMap((result) => (
        result.graph.screens.states.map((state) => state.fingerprint.value)
      ))).size,
      focusStatesDiscovered: new Set(explorations.flatMap((result) => (
        result.graph.focus.states.map((state) => state.stateFingerprint)
      ))).size,
      transitionsTested: explorations.reduce((total, result) => (
        total + result.graph.actions.length
      ), 0),
      actionsSent: explorations.reduce((total, result) => (
        total + result.statistics.physicalActions
      ), 0),
      capabilitiesObserved: [...WEB_DRIVER_CAPABILITIES],
      packs: [{ pack: "navigation", status: "partial" }],
      budget: {
        // This composite gate combines independently budgeted exploration and
        // targeted probes, so claiming one global limit would be misleading.
        maxActions: null,
        maxStates: null,
        maxDepth: null,
        maxDurationMs: null,
        maxRepetitiveItems: null,
        exhausted: [],
      },
    },
    issues: captured.map((entry) => entry.issue),
    artifacts: captured.flatMap((entry) => entry.descriptors),
    replays: plans.map((plan) => plan.replay),
  });
  const bundle = await writeReportBundle(store, report);

  const reportText = await readFile(bundle.reportJson.absolutePath, "utf8");
  const parsed = parseTVDoctorReportJson(reportText);
  expect(parsed.schemaVersion).toBe(REPORT_SCHEMA_VERSION_V1);
  if (parsed.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
    throw new Error("The generated report was not V1.");
  }
  expect(parsed.issues).toHaveLength(3);
  expect(parsed.replays).toHaveLength(3);
  expect(parsed.artifacts).toHaveLength(24);
  expect(parsed.run.status).toBe("partial");
  expect(parsed.coverage.packs).toEqual([{ pack: "navigation", status: "partial" }]);
  expect(parsed.coverage.budget.exhausted).toEqual([]);
  expect(renderReportJson(parsed)).toBe(reportText);
  await assertArtifactFiles(store.outputRoot, parsed.artifacts);
  await assertIssueArtifactCoverage(
    store.outputRoot,
    parsed.issues,
    parsed.artifacts,
    parsed.replays,
  );

  for (const [index, plan] of plans.entries()) {
    for (let run = 0; run < 3; run += 1) {
      const driver = createFixtureDriver();
      await driver.launch({ id: `m5-reliability-${String(index)}-${String(run)}`, launchUri: fixtureUrl });
      try {
        const result = await executeReplay(driver, plan);
        expect(result.status, `${plan.replay.issueId} run ${String(run + 1)}`).toBe("reproduced");
      } finally {
        await driver.close();
      }
    }
  }

  const captionPlan = plans.find((plan) => (
    plan.assertion.expectedElement === "caption-text-colour"
  ));
  if (captionPlan === undefined) throw new Error("Missing caption replay plan.");
  const fixedDriver = createFixtureDriver();
  await fixedDriver.launch({ id: "m5-fixed-simulation", launchUri: fixtureUrl });
  try {
    await fixedDriver.getPage().addInitScript(() => {
      window.addEventListener("keydown", (event) => {
        const active = document.activeElement as HTMLElement | null;
        if (event.key !== "ArrowDown" || active?.dataset["tvId"] !== "caption-font-size") return;
        const expected = document.querySelector<HTMLElement>("[data-tv-id='caption-text-colour']");
        if (expected === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        expected.tabIndex = 0;
        active.tabIndex = -1;
        expected.focus();
      }, true);
    });
    const fixed = await executeReplay(fixedDriver, captionPlan);
    expect(fixed.status).toBe("fixed");
  } finally {
    await fixedDriver.close();
  }

  const detailsPlan = plans.find((plan) => (
    plan.assertion.fromElement === "details-play"
  ));
  if (detailsPlan === undefined) throw new Error("Missing Details replay plan.");
  const driftDriver = createFixtureDriver();
  const unrelatedTarget = `data:text/html,${encodeURIComponent([
    "<!doctype html>",
    "<html><body>",
    "<button autofocus data-tv-id='unrelated-control'>Unrelated application</button>",
    "</body></html>",
  ].join(""))}`;
  await driftDriver.launch({ id: "m5-wrong-target", launchUri: unrelatedTarget });
  try {
    const drift = await executeReplay(driftDriver, detailsPlan);
    expect(drift.status).toBe("inconclusive");
    expect(drift.reason?.code).toBe("checkpoint-drift");
  } finally {
    await driftDriver.close();
  }

  const cliPath = resolve(workspaceDirectory, "packages/cli/dist/bin.js");
  for (const issue of rawIssues) {
    const cli = await runProcess(process.execPath, [
      cliPath,
      "replay",
      issue.id,
      "--report",
      bundle.reportJson.absolutePath,
      "--target",
      fixtureUrl,
    ]);
    expect(cli.code, issue.id).toBe(1);
    expect(cli.stderr, issue.id).toBe("");
    expect(cli.stdout, issue.id).toContain("Issue reproduced.");
    expect(cli.stdout, issue.id).toContain("Checkpoint PASS");
    expect(cli.stdout, issue.id).toContain("dispatch PASS");
  }

  const reportConsoleErrors: string[] = [];
  const reportPageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") reportConsoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => { reportPageErrors.push(error.message); });
  await page.goto(pathToFileURL(bundle.reportHtml.absolutePath).href);
  await expect(page.locator("h1")).toHaveText("TVDoctor");
  await expect(page.locator("details.issue")).toHaveCount(3);
  await page.locator("details.issue").evaluateAll((elements) => {
    for (const element of elements) (element as HTMLDetailsElement).open = true;
  });
  for (const issue of parsed.issues) {
    const issuePanel = page.locator("details.issue", { hasText: issue.id });
    await expect(issuePanel, issue.id).toHaveCount(1);
    await expect(issuePanel, issue.id).toContainText(issue.title);
    await expect(issuePanel, issue.id).toContainText(issue.expected);
    await expect(issuePanel, issue.id).toContainText(issue.observed);
    await expect(issuePanel, issue.id).toContainText(`tvdoctor replay ${issue.id}`);
    await expect(issuePanel.locator("img"), `${issue.id} screenshot pair`).toHaveCount(2);
  }
  await expect(page.locator("img")).toHaveCount(6);
  await expect.poll(async () => await page.locator("img").evaluateAll((images) => (
    images.every((image) => (image as HTMLImageElement).naturalWidth === 1280
      && (image as HTMLImageElement).naturalHeight === 720)
  ))).toBe(true);
  const artifactLinks = await page.locator("a[href]").evaluateAll((anchors) => (
    anchors.map((anchor) => ({
      raw: (anchor as HTMLAnchorElement).getAttribute("href"),
      resolved: (anchor as HTMLAnchorElement).href,
    }))
  ));
  for (const artifact of parsed.artifacts) {
    if (artifact.status !== "available") continue;
    const link = artifactLinks.find((candidate) => candidate.raw === artifact.path);
    expect(link, `HTML link for ${artifact.id}`).toBeDefined();
    if (link === undefined) throw new Error(`Missing HTML artifact link for ${artifact.id}.`);
    expect(fileURLToPath(link.resolved), `resolved HTML link for ${artifact.id}`).toBe(
      resolve(store.outputRoot, ...artifact.path.split("/")),
    );
  }
  expect(reportConsoleErrors).toEqual([]);
  expect(reportPageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("m5-report-inspection.png"), fullPage: true });

  const markdown = await readFile(bundle.reportMarkdown.absolutePath, "utf8");
  const aiMarkdown = await readFile(bundle.aiReportMarkdown.absolutePath, "utf8");
  for (const issue of parsed.issues) {
    expect(markdown).toContain(issue.id);
    expect(aiMarkdown).toContain(issue.id);
    expect(aiMarkdown).toContain(`# TVDoctor Fix Task — ${issue.id}`);
    expect(aiMarkdown).toContain(`tvdoctor replay ${issue.id}`);
    if (issue.transition === null
      || issue.transition.expectedElement === null
      || issue.transition.observedElement === null) {
      throw new Error(`Deterministic gate issue ${issue.id} needs a complete transition.`);
    }
    expect(aiMarkdown).toContain(issue.transition.expectedElement);
    expect(aiMarkdown).toContain(issue.transition.observedElement);
  }
  for (const heading of [
    "Objective",
    "Verified Failure",
    "Current Behaviour",
    "Required Behaviour",
    "Exact Reproduction",
    "Runtime Evidence",
    "Element Information",
    "Navigation Transition",
    "Likely Source Area",
    "Likely Cause — Inference Only",
    "Files, Selectors, or Resource IDs That May Be Relevant",
    "Constraints",
    "Validation Command",
    "Success Condition",
  ]) {
    expect(aiMarkdown, heading).toContain(`## ${heading}`);
  }
});
