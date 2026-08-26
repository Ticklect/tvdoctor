import {
  REPLAY_SCHEMA_VERSION,
  availableObservation,
  parseTVDoctorReplayV1,
  unavailableObservation,
  type ActionResult,
  type Capability,
  type RemoteKey,
  type RemotePressStep,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
  type TVDoctorIssue,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import {
  REPLAY_MINIMIZATION_NOT_ATTEMPTED_REASON,
  compileIssueReplay,
  compileReplay,
  executeReplay,
  type CompiledReplayPlan,
  type ReplayCompilationOptions,
} from "../src/index.js";

function uiNode(
  stableId: string,
  options: {
    readonly children?: readonly UiNodeSnapshot[];
    readonly focused?: boolean;
    readonly modal?: boolean;
    readonly role?: string;
  } = {},
): UiNodeSnapshot {
  return {
    stableId,
    role: options.role ?? "button",
    name: stableId,
    text: null,
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    visible: true,
    enabled: true,
    focusable: true,
    focused: options.focused ?? false,
    modal: options.modal ?? false,
    selectionState: null,
    valueNow: null,
    children: options.children ?? [],
  };
}

function snapshot(
  focus: string | null,
  tree: readonly UiNodeSnapshot[] | null = null,
): StateSnapshot {
  return {
    capturedAt: "2026-08-20T12:00:00.000Z",
    location: availableObservation("app://fixture"),
    focusedElement: availableObservation(focus === null ? null : {
      stableId: focus,
      role: "button",
      name: focus,
    }),
    uiTree: availableObservation(tree ?? (focus === null
      ? []
      : [uiNode(focus, { focused: true })])),
  };
}

interface IssueOptions {
  readonly action?: RemoteKey;
  readonly confidence?: TVDoctorIssue["confidence"];
  readonly expected?: string | null;
  readonly from?: string | null;
  readonly minimized?: readonly RemotePressStep[] | null;
  readonly observed?: string | null;
  readonly reproductionConfidence?: "deterministic" | "best-effort";
  readonly rule?: string;
  readonly sequence?: readonly RemotePressStep[];
}

function issue(options: IssueOptions = {}): TVDoctorIssue {
  const action = options.action ?? "RIGHT";
  return {
    id: "TVDOCTOR-NAV-0123456789ABCDEF0123456789ABCDEF",
    rule: options.rule ?? "remote.reachability",
    title: "Fixture navigation failure",
    description: "A controlled replay fixture issue.",
    severity: "high",
    confidence: options.confidence ?? "deterministic",
    pack: "streaming",
    screen: "fixture",
    expected: "Expected navigation state.",
    observed: "Observed navigation state.",
    transition: {
      fromElement: options.from === undefined ? "hero-watch" : options.from,
      action,
      expectedElement: options.expected === undefined ? "hero-more-info" : options.expected,
      observedElement: options.observed === undefined ? "hero-watch" : options.observed,
    },
    evidence: [],
    reproduction: {
      status: "available",
      resetStrategy: "reload",
      originalSequence: options.sequence ?? [{ key: action, repeat: 1 }],
      minimizedSequence: options.minimized ?? null,
      confidence: options.reproductionConfidence ?? "deterministic",
      artifact: null,
    },
  };
}

function compiled(
  testIssue: TVDoctorIssue,
  options: ReplayCompilationOptions = {},
): CompiledReplayPlan {
  const result = compileIssueReplay(testIssue, options);
  if (result.status !== "compiled") {
    throw new Error(`Expected a compiled replay, received ${result.status}: ${result.reason.message}`);
  }
  return result.plan;
}

interface FakeDriverConfiguration {
  readonly capabilities?: () => Promise<ReadonlySet<Capability>>;
  readonly press?: (
    key: RemoteKey,
    index: number,
  ) => ActionResult | Promise<ActionResult>;
  readonly reset?: false | ((strategy: ResetStrategy) => void | Promise<void>);
  readonly snapshot: () => StateSnapshot | Promise<StateSnapshot>;
}

interface FakeDriverHarness {
  readonly driver: TVDoctorDriver;
  readonly pressed: RemoteKey[];
  readonly resets: ResetStrategy[];
}

function actionResult(
  key: RemoteKey,
  outcome: ActionResult["outcome"] = "applied",
  message?: string,
): ActionResult {
  return {
    key,
    outcome,
    timing: { inputSentAtMs: 1 },
    ...(message === undefined ? {} : { message }),
  };
}

function fakeDriver(configuration: FakeDriverConfiguration): FakeDriverHarness {
  const pressed: RemoteKey[] = [];
  const resets: ResetStrategy[] = [];
  const reset = configuration.reset;
  const driver: TVDoctorDriver = {
    capabilities: configuration.capabilities
      ?? (async () => new Set<Capability>(["remote-input", "ui-tree"])),
    press: async (key) => {
      pressed.push(key);
      return await (configuration.press?.(key, pressed.length - 1) ?? actionResult(key));
    },
    snapshot: async () => await configuration.snapshot(),
    ...(reset === false
      ? {}
      : {
        reset: async (strategy: ResetStrategy) => {
          resets.push(strategy);
          await reset?.(strategy);
        },
      }),
  };
  return { driver, pressed, resets };
}

describe("deterministic replay", () => {
  it("stops before touching the driver when replay is already interrupted", async () => {
    const controller = new AbortController();
    let capabilityCalls = 0;
    const harness = fakeDriver({
      capabilities: async () => {
        capabilityCalls += 1;
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      snapshot: () => snapshot("hero-watch"),
    });
    controller.abort();

    const result = await executeReplay(harness.driver, compiled(issue()), {
      signal: controller.signal,
    });

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toMatchObject({ code: "interrupted", phase: "preflight" });
    expect(capabilityCalls).toBe(0);
    expect(harness.pressed).toHaveLength(0);
  });

  it("compiles the original exact path into setup and assertion phases and captures evidence", async () => {
    const original = [
      { key: "DOWN", repeat: 2 },
      { key: "RIGHT", repeat: 2 },
    ] as const;
    const minimized = [
      { key: "DOWN", repeat: 1 },
      { key: "RIGHT", repeat: 1 },
    ] as const;
    const plan = compiled(issue({ sequence: original, minimized }));

    expect(plan.replay).toMatchObject({
      schemaVersion: REPLAY_SCHEMA_VERSION,
      id: "replay-TVDOCTOR-NAV-0123456789ABCDEF0123456789ABCDEF",
      steps: original,
    });
    expect(parseTVDoctorReplayV1(plan.replay)).toBe(plan.replay);
    expect(plan.setup.steps).toEqual([
      { key: "DOWN", repeat: 2 },
      { key: "RIGHT", repeat: 1 },
    ]);
    expect(plan.assertion.action).toBe("RIGHT");
    expect(plan.totalActions).toBe(4);
    expect(plan.sequence).toEqual({
      originalSequence: original,
      minimizedSequence: minimized,
      executedSequence: "original",
      minimization: {
        status: "not-attempted",
        reason: REPLAY_MINIMIZATION_NOT_ATTEMPTED_REASON,
      },
    });

    let currentFocus = "root";
    const harness = fakeDriver({
      snapshot: () => snapshot(currentFocus),
      press: (key, index) => {
        currentFocus = index < 2 ? "root" : "hero-watch";
        return actionResult(key);
      },
    });
    const captures: string[] = [];
    const result = await executeReplay(harness.driver, plan, {
      evidence: {
        captureBefore: ({ snapshot: before }) => {
          captures.push(`before:${before.focusedElement.status === "available"
            ? before.focusedElement.value?.stableId
            : "unavailable"}`);
        },
        captureAfter: ({ afterSnapshot }) => {
          captures.push(`after:${afterSnapshot.focusedElement.status === "available"
            ? afterSnapshot.focusedElement.value?.stableId
            : "unavailable"}`);
        },
      },
    });

    expect(result.status).toBe("reproduced");
    expect(result.reason).toBeNull();
    expect(result.actionsPressed).toBe(4);
    expect(harness.pressed).toEqual(["DOWN", "DOWN", "RIGHT", "RIGHT"]);
    expect(harness.resets).toEqual(["reload"]);
    expect(captures).toEqual(["before:hero-watch", "after:hero-watch"]);
    expect(result.evidence.setupActionResults).toHaveLength(3);
    expect(result.evidence.assertionActionResult?.key).toBe("RIGHT");
  });

  it("returns fixed only when a deterministic replay matches the explicit expected transition", async () => {
    let focus = "details-play";
    const plan = compiled(issue({
      action: "BACK",
      from: "details-play",
      expected: "hero-watch",
      observed: "search-query",
      sequence: [{ key: "BACK", repeat: 1 }],
    }));
    const harness = fakeDriver({
      snapshot: () => snapshot(focus),
      press: (key) => {
        focus = "hero-watch";
        return actionResult(key);
      },
    });

    const result = await executeReplay(harness.driver, plan);

    expect(result.status).toBe("fixed");
    expect(result.reason).toBeNull();
  });

  it("uses element-state assertions to replay and prove correction of a modal focus trap", async () => {
    const trapIssue = issue({
      action: "BACK",
      from: "profile-primary",
      expected: null,
      observed: "profile-primary",
      rule: "remote.focus-trap",
      sequence: [{ key: "BACK", repeat: 1 }],
    });
    let dialogOpen = true;
    let focus = "profile-primary";
    const tree = (): readonly UiNodeSnapshot[] => dialogOpen
      ? [uiNode("profile-dialog", {
        modal: true,
        role: "dialog",
        children: [uiNode("profile-primary", { focused: true })],
      })]
      : [uiNode("home", { focused: true })];
    const trapPlan = compiled(trapIssue);
    expect(trapPlan.elementStateAssertions).toEqual([{
      selector: { roles: ["dialog", "alertdialog"] },
      checkpoint: { present: true, visible: true, modal: true },
      reproduced: { present: true, visible: true, modal: true },
      fixed: { present: false },
    }]);
    const reproducedHarness = fakeDriver({
      snapshot: () => snapshot(focus, tree()),
    });
    const reproduced = await executeReplay(
      reproducedHarness.driver,
      trapPlan,
    );
    expect(reproduced.status).toBe("reproduced");

    dialogOpen = true;
    focus = "profile-primary";
    const fixedHarness = fakeDriver({
      snapshot: () => snapshot(focus, tree()),
      press: (key) => {
        dialogOpen = false;
        focus = "home";
        return actionResult(key);
      },
    });
    const fixed = await executeReplay(
      fixedHarness.driver,
      trapPlan,
    );
    expect(fixed.status).toBe("fixed");
  });

  it("returns inconclusive for a post-assertion state that matches neither outcome", async () => {
    let focus = "hero-watch";
    const harness = fakeDriver({
      snapshot: () => snapshot(focus),
      press: (key) => {
        focus = "unrelated-footer";
        return actionResult(key);
      },
    });

    const result = await executeReplay(harness.driver, compiled(issue()));

    expect(result).toMatchObject({
      status: "inconclusive",
      reason: { code: "assertion-drift", phase: "evaluation" },
    });
  });

  it("prioritises stable focus identity over a conflicting accessible name", async () => {
    let afterAssertion = false;
    const harness = fakeDriver({
      snapshot: () => afterAssertion
        ? {
          ...snapshot("hero-watch"),
          focusedElement: availableObservation({
            stableId: "hero-watch",
            name: "hero-more-info",
            role: "button",
          }),
        }
        : snapshot("hero-watch"),
      press: (key) => {
        afterAssertion = true;
        return actionResult(key);
      },
    });

    const result = await executeReplay(harness.driver, compiled(issue()));

    expect(result.status).toBe("reproduced");
  });

  it("isolates replay classification from mutations inside evidence hooks", async () => {
    const harness = fakeDriver({ snapshot: () => snapshot("hero-watch") });
    const plan = compiled(issue());

    const result = await executeReplay(harness.driver, plan, {
      evidence: {
        captureBefore: (context) => {
          const mutable = context as unknown as {
            plan: { assertion: { action: RemoteKey } };
            snapshot: { focusedElement: { value: { stableId: string } } };
          };
          mutable.plan.assertion.action = "LEFT";
          mutable.snapshot.focusedElement.value.stableId = "hero-more-info";
        },
        captureAfter: (context) => {
          const mutable = context as unknown as {
            afterSnapshot: { focusedElement: { value: { stableId: string } } };
          };
          mutable.afterSnapshot.focusedElement.value.stableId = "hero-more-info";
        },
      },
    });

    expect(result.status).toBe("reproduced");
    expect(harness.pressed).toEqual(["RIGHT"]);
    expect(plan.assertion.action).toBe("RIGHT");
    expect(result.evidence.afterSnapshot?.focusedElement).toMatchObject({
      status: "available",
      value: { stableId: "hero-watch" },
    });
  });

  it("returns error when a driver operation throws", async () => {
    const harness = fakeDriver({
      capabilities: async () => {
        throw new Error("driver disconnected");
      },
      snapshot: () => snapshot("hero-watch"),
    });

    const result = await executeReplay(harness.driver, compiled(issue()));

    expect(result).toMatchObject({
      status: "error",
      reason: {
        code: "driver-error",
        phase: "capabilities",
        message: "driver disconnected",
      },
    });
  });

  it("returns error instead of throwing when a malformed snapshot cannot be evaluated", async () => {
    const malformed = {
      ...snapshot("hero-watch"),
      focusedElement: null,
    } as unknown as StateSnapshot;
    const harness = fakeDriver({ snapshot: () => malformed });

    const result = await executeReplay(harness.driver, compiled(issue()));

    expect(result).toMatchObject({
      status: "error",
      reason: { code: "evaluation-error", phase: "checkpoint" },
    });
  });

  it("keeps unavailable reset and remote input explicitly inconclusive", async () => {
    const noReset = fakeDriver({
      reset: false,
      snapshot: () => snapshot("hero-watch"),
    });
    await expect(executeReplay(noReset.driver, compiled(issue()))).resolves.toMatchObject({
      status: "inconclusive",
      reason: { code: "reset-unavailable", phase: "reset" },
    });

    const noRemoteInput = fakeDriver({
      capabilities: async () => new Set<Capability>(["ui-tree"]),
      snapshot: () => snapshot("hero-watch"),
    });
    await expect(executeReplay(noRemoteInput.driver, compiled(issue()))).resolves.toMatchObject({
      status: "inconclusive",
      reason: { code: "remote-input-unavailable", phase: "capabilities" },
    });
  });

  it("can restore through a host hook when the driver has no reset method", async () => {
    const noReset = fakeDriver({
      reset: false,
      snapshot: () => snapshot("hero-watch"),
    });
    const restored: ResetStrategy[] = [];

    const result = await executeReplay(noReset.driver, compiled(issue()), {
      restore: (context) => {
        const { strategy } = context;
        restored.push(strategy);
        const mutable = context as unknown as {
          plan: { assertion: { action: RemoteKey } };
        };
        mutable.plan.assertion.action = "LEFT";
      },
    });

    expect(result.status).toBe("reproduced");
    expect(restored).toEqual(["reload"]);
    expect(noReset.resets).toEqual([]);
    expect(noReset.pressed).toEqual(["RIGHT"]);
  });

  it("returns inconclusive when an advertised input is unsupported", async () => {
    const harness = fakeDriver({
      snapshot: () => snapshot("hero-watch"),
      press: (key) => actionResult(key, "unsupported", "RIGHT is unavailable"),
    });

    const result = await executeReplay(harness.driver, compiled(issue()));

    expect(result).toMatchObject({
      status: "inconclusive",
      actionsPressed: 1,
      reason: {
        code: "input-unavailable",
        phase: "assertion",
        message: "RIGHT is unavailable",
      },
    });
  });

  it("returns error for a failed input without evaluating it as a finding", async () => {
    const harness = fakeDriver({
      snapshot: () => snapshot("hero-watch"),
      press: (key) => actionResult(key, "failed", "dispatch rejected"),
    });

    const result = await executeReplay(harness.driver, compiled(issue()));

    expect(result).toMatchObject({
      status: "error",
      actionsPressed: 1,
      reason: { code: "input-failed", phase: "assertion", message: "dispatch rejected" },
    });
    expect(result.evidence.afterSnapshot).toBeNull();
  });

  it("stops at checkpoint drift before sending the assertion action", async () => {
    const harness = fakeDriver({ snapshot: () => snapshot("somewhere-else") });

    const result = await executeReplay(harness.driver, compiled(issue()));

    expect(result).toMatchObject({
      status: "inconclusive",
      actionsPressed: 0,
      reason: { code: "checkpoint-drift", phase: "checkpoint" },
    });
    expect(harness.pressed).toEqual([]);
  });

  it("enforces action and duration budgets across the workflow", async () => {
    const twoActionPlan = compiled(issue({
      sequence: [{ key: "RIGHT", repeat: 2 }],
    }));
    const actionHarness = fakeDriver({ snapshot: () => snapshot("hero-watch") });
    const actionLimited = await executeReplay(actionHarness.driver, twoActionPlan, {
      budgets: { maxActions: 1 },
    });
    expect(actionLimited).toMatchObject({
      status: "inconclusive",
      actionsPressed: 0,
      reason: { code: "action-budget-exhausted", phase: "preflight" },
    });
    expect(actionHarness.resets).toEqual([]);
    expect(actionHarness.pressed).toEqual([]);

    const unsafeTimer = await executeReplay(actionHarness.driver, twoActionPlan, {
      budgets: { maxDurationMs: 2_147_483_648 },
    });
    expect(unsafeTimer).toMatchObject({
      status: "error",
      reason: { code: "invalid-options", phase: "preflight" },
    });

    const never = new Promise<ReadonlySet<Capability>>(() => undefined);
    const timeoutHarness = fakeDriver({
      capabilities: async () => await never,
      snapshot: () => snapshot("hero-watch"),
    });
    const timedOut = await executeReplay(timeoutHarness.driver, compiled(issue()), {
      budgets: { maxDurationMs: 10 },
    });
    expect(timedOut).toMatchObject({
      status: "inconclusive",
      actionsPressed: 0,
      reason: { code: "duration-budget-exhausted", phase: "capabilities" },
    });
  });

  it("never calls an expected match fixed for a heuristic best-effort replay", async () => {
    let focus = "hero-watch";
    const plan = compiled(issue({ confidence: "heuristic" }));
    expect(plan.confidence).toBe("best-effort");
    const harness = fakeDriver({
      snapshot: () => snapshot(focus),
      press: (key) => {
        focus = "hero-more-info";
        return actionResult(key);
      },
    });

    const result = await executeReplay(harness.driver, plan);

    expect(result).toMatchObject({
      status: "inconclusive",
      confidence: "best-effort",
      reason: { code: "best-effort-cannot-prove-fixed", phase: "evaluation" },
    });
  });

  it("rejects a best-effort plan forged to deterministic before it can report fixed", async () => {
    let focus = "hero-watch";
    const plan = compiled(issue({ confidence: "heuristic" }));
    const mutable = plan as unknown as { confidence: string };
    mutable.confidence = "deterministic";
    const harness = fakeDriver({
      snapshot: () => snapshot(focus),
      press: (key) => {
        focus = "hero-more-info";
        return actionResult(key);
      },
    });

    const result = await executeReplay(harness.driver, plan);

    expect(result).toMatchObject({
      status: "error",
      actionsPressed: 0,
      reason: { code: "invalid-plan", phase: "preflight" },
    });
    expect(harness.resets).toEqual([]);
    expect(harness.pressed).toEqual([]);
  });

  it("rejects coordinated assertion and checkpoint mutation after compilation", async () => {
    const plan = compiled(issue());
    const mutable = plan as unknown as {
      assertion: { fromElement: string | null };
      setup: { checkpointFocusElement: string | null };
    };
    mutable.assertion.fromElement = "forged-source";
    mutable.setup.checkpointFocusElement = "forged-source";
    const harness = fakeDriver({ snapshot: () => snapshot("forged-source") });

    const result = await executeReplay(harness.driver, plan);

    expect(result).toMatchObject({
      status: "error",
      actionsPressed: 0,
      reason: { code: "invalid-plan", phase: "preflight" },
    });
    expect(harness.resets).toEqual([]);
    expect(harness.pressed).toEqual([]);
  });

  it("executes an isolated plan snapshot when the caller mutates later during driver work", async () => {
    let releaseCapabilities: ((capabilities: ReadonlySet<Capability>) => void) | undefined;
    const capabilities = new Promise<ReadonlySet<Capability>>((resolve) => {
      releaseCapabilities = resolve;
    });
    const plan = compiled(issue());
    const harness = fakeDriver({
      capabilities: async () => await capabilities,
      snapshot: () => snapshot("hero-watch"),
    });

    const executing = executeReplay(harness.driver, plan);
    const mutable = plan as unknown as {
      assertion: { action: RemoteKey };
      confidence: string;
    };
    mutable.assertion.action = "LEFT";
    mutable.confidence = "best-effort";
    releaseCapabilities?.(new Set<Capability>(["remote-input", "ui-tree"]));
    const result = await executing;

    expect(result.status).toBe("reproduced");
    expect(result.confidence).toBe("deterministic");
    expect(harness.pressed).toEqual(["RIGHT"]);
  });

  it("defaults a standalone portable replay to best-effort and rejects a mismatched final action", () => {
    const portable = {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      id: "replay-portable",
      issueId: "issue-portable",
      reset: { strategy: "reload" },
      steps: [{ key: "RIGHT", repeat: 1 }],
      assertion: {
        type: "transition",
        fromElement: "source",
        action: "RIGHT",
        expectedElement: "expected",
        observedElement: "observed",
      },
    } as const;
    const standalone = compileReplay(portable);
    expect(standalone.status).toBe("compiled");
    if (standalone.status === "compiled") {
      expect(standalone.plan.confidence).toBe("best-effort");
    }

    expect(compileReplay({
      ...portable,
      assertion: { ...portable.assertion, action: "LEFT" },
    })).toMatchObject({
      status: "invalid",
      reason: { code: "invalid-replay" },
    });

    expect(compileReplay(portable, {
      sequenceMetadata: {
        originalSequence: [{ key: "LEFT", repeat: 1 }],
        minimizedSequence: null,
      },
    })).toMatchObject({
      status: "invalid",
      reason: {
        code: "invalid-replay",
        message: "Original sequence metadata must exactly match the executable replay steps.",
      },
    });

    expect(compileReplay(portable, { confidence: "deterministic" })).toMatchObject({
      status: "invalid",
      reason: {
        message: "Deterministic replay confidence requires correlated sourceIssue provenance.",
      },
    });
  });

  it("correlates loaded replay fields with their source issue before trusting confidence", () => {
    const sourceIssue = issue();
    const sourcePlan = compiled(sourceIssue);
    const correlated = compileReplay(sourcePlan.replay, {
      confidence: "deterministic",
      sourceIssue,
    });
    expect(correlated.status).toBe("compiled");
    if (correlated.status === "compiled") {
      expect(correlated.plan.confidence).toBe("deterministic");
    }

    expect(compileReplay({
      ...sourcePlan.replay,
      reset: { strategy: "relaunch" },
    }, {
      confidence: "deterministic",
      sourceIssue,
    })).toMatchObject({
      status: "invalid",
      reason: { message: "Replay reset strategy does not match its source issue." },
    });

    expect(compileReplay({
      ...sourcePlan.replay,
      assertion: {
        ...sourcePlan.replay.assertion,
        observedElement: "unrelated",
      },
    }, {
      confidence: "deterministic",
      sourceIssue,
    })).toMatchObject({
      status: "invalid",
      reason: { message: "Replay transition assertion does not match its source issue." },
    });
  });

  it("returns inconclusive when reproduced and corrected predicates overlap", async () => {
    let focus = "source";
    const ambiguousIssue = issue({
      from: "source",
      expected: "same-target",
      observed: "same-target",
    });
    const harness = fakeDriver({
      snapshot: () => snapshot(focus),
      press: (key) => {
        focus = "same-target";
        return actionResult(key);
      },
    });

    const result = await executeReplay(harness.driver, compiled(ambiguousIssue));

    expect(result).toMatchObject({
      status: "inconclusive",
      reason: { code: "assertion-ambiguous", phase: "evaluation" },
    });
  });

  it("does not turn unavailable checkpoint observations into a pass", async () => {
    const unavailableSnapshot: StateSnapshot = {
      ...snapshot("hero-watch"),
      focusedElement: unavailableObservation("focus API unavailable"),
    };
    const harness = fakeDriver({ snapshot: () => unavailableSnapshot });

    const result = await executeReplay(harness.driver, compiled(issue()));

    expect(result).toMatchObject({
      status: "inconclusive",
      reason: { code: "observation-unavailable", phase: "checkpoint" },
    });
  });
});
