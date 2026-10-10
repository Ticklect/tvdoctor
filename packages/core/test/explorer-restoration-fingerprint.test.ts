import { performance } from "node:perf_hooks";
import {
  availableObservation,
  type Capability,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it, vi } from "vitest";

import { normaliseActionSettlingOptions } from "../src/action-settling.js";
import type { QueueEntry } from "../src/explorer-frontier.js";
import { createExplorerRestorer } from "../src/explorer-restoration.js";
import {
  MAX_RESTORATION_DIAGNOSTICS,
  RestorationDiagnosticRecorder,
  type PendingRestorationDiagnostic,
} from "../src/explorer-restoration-diagnostics.js";
import { computeSnapshotFingerprint } from "../src/fingerprint.js";

function snapshot(focus: string, treeSize = 0): StateSnapshot {
  const controls: UiNodeSnapshot[] = Array.from({ length: treeSize }, (_, index) => ({
    stableId: `element-${String(index)}`,
    role: index % 5 === 0 ? "button" : "text",
    name: `element ${String(index)}`,
    text: `value ${String(index)}`,
    bounds: { x: index % 12, y: Math.floor(index / 12), width: 90, height: 30 },
    visible: true,
    enabled: index % 5 === 0,
    focusable: index % 5 === 0,
    focused: false,
    modal: false,
    selectionState: null,
    valueNow: null,
    children: [],
  }));
  return {
    capturedAt: "2026-10-09T00:00:00.000Z",
    location: availableObservation("app://replay-test"),
    focusedElement: availableObservation({ stableId: focus, role: "button", name: focus }),
    uiTree: availableObservation(controls),
  };
}

function fixture(
  destination: "root" | "middle" | "end",
  checkpointsMatch = true,
  shouldCollectDiagnosticDetails?: () => boolean,
  treeSize = 0,
) {
  const states = {
    root: snapshot("root", treeSize),
    middle: snapshot("middle", treeSize),
    end: snapshot("end", treeSize),
  };
  const fingerprints = {
    root: computeSnapshotFingerprint(states.root),
    middle: computeSnapshotFingerprint(states.middle),
    end: computeSnapshotFingerprint(states.end),
  };
  let current: keyof typeof states = "root";
  const driver: TVDoctorDriver = {
    capabilities: async () => new Set<Capability>(["remote-input"]),
    snapshot: async () => states[current],
    press: async (key: RemoteKey) => {
      current = key === "DOWN" ? "middle" : "end";
      return {
        key,
        outcome: "applied" as const,
        timing: { inputSentAtMs: 0 },
        postActionSnapshot: states[current],
      };
    },
  };
  const sequence: readonly RemoteKey[] = destination === "root"
    ? [] : destination === "middle" ? ["DOWN"] : ["DOWN", "RIGHT"];
  const checkpoints = sequence.map((_, index) => (
    index === 0
      ? checkpointsMatch ? fingerprints.middle.stateIdentity : fingerprints.end.stateIdentity
      : fingerprints.end.stateIdentity
  ));
  const entry: QueueEntry = {
    state: {
      id: "focus-destination",
      screenStateId: "screen-root",
      firstSeenDepth: sequence.length,
      identity: fingerprints[destination].stateIdentity,
      fingerprint: fingerprints[destination],
      representativeSnapshot: states[destination],
      discoveredBy: sequence,
      repetitionGroup: null,
      frontierPriority: 0,
      scheduled: true,
    },
    sequence,
    checkpoints,
    insertionOrder: 0,
  };

  const fingerprintSnapshot = vi.fn(computeSnapshotFingerprint);
  const onDiagnostic = vi.fn<(diagnostic: PendingRestorationDiagnostic) => void>();
  const onReplayAction = vi.fn();
  const restorer = createExplorerRestorer({
    restoreAndCapture: async () => {
      current = "root";
      return states.root;
    },
    withinDurationBudget: async (operation) => operation(new AbortController().signal),
    signalAborted: () => false,
    monotonicNow: () => 0,
    durationSince: () => 0,
    fingerprintSnapshot,
    initialFingerprint: fingerprints.root,
    initialSnapshot: states.root,
    stateByIdentity: new Map([
      [fingerprints.root.stateIdentity, { fingerprint: fingerprints.root, representativeSnapshot: states.root }],
      [fingerprints.middle.stateIdentity, { fingerprint: fingerprints.middle, representativeSnapshot: states.middle }],
      [fingerprints.end.stateIdentity, { fingerprint: fingerprints.end, representativeSnapshot: states.end }],
    ]) as never,
    measuredDriver: driver,
    settling: normaliseActionSettlingOptions({ strategy: "driver" }),
    workBudgetTermination: () => null,
    onRestorationStart: vi.fn(),
    onResetDuration: vi.fn(),
    onReplayAction,
    onSettlingObservation: vi.fn(),
    onReplayDuration: vi.fn(),
    onDiagnostic,
    ...(shouldCollectDiagnosticDetails === undefined ? {} : { shouldCollectDiagnosticDetails }),
  });
  return { entry, restorer, fingerprintSnapshot, onDiagnostic, onReplayAction, sequence };
}

describe("root replay checkpoint normalization", () => {
  it.each(["root", "middle", "end"] as const)(
    "normalizes every observed snapshot exactly once for %s restoration",
    async (destination) => {
      const f = fixture(destination);
      expect(await f.restorer(f.entry, undefined, 1)).toMatchObject({ status: "ok" });
      expect(f.fingerprintSnapshot).toHaveBeenCalledTimes(1 + f.sequence.length);
      expect(f.onDiagnostic).toHaveBeenCalledOnce();
      expect(f.onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
        strategy: "root-replay",
        status: "success",
        history: expect.arrayContaining([expect.objectContaining({ focusIdentity: "root|button" })]),
      });
    },
  );

  it("still stops at a diverged intermediate checkpoint", async () => {
    const f = fixture("end", false);
    const result = await f.restorer(f.entry, undefined, 1);
    expect(result).toMatchObject({ status: "stop", termination: {
      reason: "replay-diverged", restorationRejectionReason: "replay-checkpoint-diverged",
    } });
    expect(f.fingerprintSnapshot).toHaveBeenCalledTimes(2);
    expect(f.onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      rejectionReason: "replay-checkpoint-diverged",
    });
  });

  it("preserves the first 64 diagnostic records and all replay checks after the ledger fills", async () => {
    const completeLedger = new RestorationDiagnosticRecorder();
    const boundedLedger = new RestorationDiagnosticRecorder();
    const complete = fixture("end");
    const bounded = fixture(
      "end", true,
      () => boundedLedger.attempts < MAX_RESTORATION_DIAGNOSTICS,
    );
    complete.onDiagnostic.mockImplementation((item) => completeLedger.record(item));
    bounded.onDiagnostic.mockImplementation((item) => boundedLedger.record(item));

    for (let index = 1; index <= 80; index += 1) {
      const original = await complete.restorer(complete.entry, undefined, index);
      const optimized = await bounded.restorer(bounded.entry, undefined, index);
      expect(optimized).toEqual(original);
    }

    expect(boundedLedger.snapshot()).toEqual(completeLedger.snapshot());
    expect(boundedLedger.snapshot()).toHaveLength(MAX_RESTORATION_DIAGNOSTICS);
    expect(boundedLedger.attempts).toBe(80);
    expect(boundedLedger.successes).toBe(80);
    expect(boundedLedger.failures).toBe(0);
    expect(bounded.onReplayAction).toHaveBeenCalledTimes(160);
    expect(bounded.fingerprintSnapshot).toHaveBeenCalledTimes(240);
    expect(bounded.onReplayAction).toHaveBeenCalledTimes(complete.onReplayAction.mock.calls.length);
    expect(bounded.fingerprintSnapshot).toHaveBeenCalledTimes(complete.fingerprintSnapshot.mock.calls.length);
    expect(bounded.onDiagnostic.mock.calls[63]?.[0]).toHaveProperty("history");
    expect(bounded.onDiagnostic.mock.calls[64]?.[0]).not.toHaveProperty("history");
    expect(bounded.onDiagnostic.mock.calls[64]?.[0]).not.toHaveProperty("expected");
  });

  it("measures bounded-ledger replay CPU work on complex UI snapshots", async () => {
    const detailed = fixture("end", true, () => true, 256);
    const bounded = fixture("end", true, () => false, 256);
    const rounds = 90;
    const measurements: { detailed: number; bounded: number }[] = [];
    for (let iteration = 0; iteration < 3; iteration += 1) {
      // Alternate ordering to reduce JIT and runtime noise in the fixture.
      const pair = iteration % 2 === 0 ? [detailed, bounded] : [bounded, detailed];
      const elapsed = new Map<typeof detailed, number>();
      for (const f of pair) {
        const started = performance.now();
        for (let cycle = 1; cycle <= rounds; cycle += 1) {
          const result = await f.restorer(f.entry, undefined, cycle);
          expect(result.status).toBe("ok");
        }
        elapsed.set(f, performance.now() - started);
      }
      measurements.push({ detailed: elapsed.get(detailed) ?? 0, bounded: elapsed.get(bounded) ?? 0 });
    }
    expect(detailed.onReplayAction).toHaveBeenCalledTimes(rounds * 3 * 2);
    expect(bounded.onReplayAction).toHaveBeenCalledTimes(rounds * 3 * 2);
    expect(bounded.fingerprintSnapshot.mock.calls.length).toBe(detailed.fingerprintSnapshot.mock.calls.length);
    const median = (values: number[]) => values.sort((a, b) => a - b)[1] ?? 0;
    console.info(JSON.stringify({
      fixture: "256-node-root-replay-diagnostic-cap",
      iterationsPerMode: rounds * 3,
      replayActionsPerMode: detailed.onReplayAction.mock.calls.length,
      medianDetailedMs: +median(measurements.map((item) => item.detailed)).toFixed(1),
      medianBoundedMs: +median(measurements.map((item) => item.bounded)).toFixed(1),
    }));
  });
});
