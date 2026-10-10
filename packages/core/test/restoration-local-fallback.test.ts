import {
  availableObservation,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import { describe, expect, it, vi } from "vitest";

import { normaliseActionSettlingOptions } from "../src/action-settling.js";
import type { QueueEntry } from "../src/explorer-frontier.js";
import { createVerifiedLocalRestorer } from "../src/explorer-local-restoration.js";
import { RestorationDiagnosticRecorder } from "../src/explorer-restoration-diagnostics.js";
import { computeSnapshotFingerprint } from "../src/fingerprint.js";

function snapshot(name: string): StateSnapshot {
  return {
    capturedAt: "2026-10-08T12:00:00.000Z",
    location: availableObservation("app://test/home"),
    focusedElement: availableObservation({ stableId: name, name, role: "button" }),
    uiTree: availableObservation([]),
  };
}

function queued(snapshotValue: StateSnapshot, sequence: readonly RemoteKey[] = ["DOWN"]): QueueEntry {
  return {
    state: {
      id: `state-${snapshotValue.focusedElement.status === "available" ? snapshotValue.focusedElement.value?.stableId : "unknown"}`,
      firstSeenDepth: sequence.length,
      identity: computeSnapshotFingerprint(snapshotValue).stateIdentity,
      representativeSnapshot: snapshotValue,
    },
    sequence,
    checkpoints: [],
    insertionOrder: 0,
  } as unknown as QueueEntry;
}

function fixture(allowRootRestorationFallback = true) {
  const home = snapshot("home");
  const detail = snapshot("detail");
  const unexpected = snapshot("unexpected");
  let live = home;
  let pressDestination = detail;
  let snapshotError: Error | null = null;

  const driver: TVDoctorDriver = {
    capabilities: async () => new Set(["remote-input"] as const),
    snapshot: async () => {
      if (snapshotError !== null) throw snapshotError;
      return live;
    },
    press: async (key) => {
      live = pressDestination;
      return { key, outcome: "applied", timing: { inputSentAtMs: 0 } };
    },
  };
  const rootRestore = vi.fn(async (entry: QueueEntry) => ({
    status: "ok" as const,
    snapshot: entry.state.representativeSnapshot,
  }));
  const onFallback = vi.fn();
  const onReplayAction = vi.fn();
  const onPathRestoration = vi.fn();
  const onStateReuse = vi.fn();
  const recorder = new RestorationDiagnosticRecorder();
  const onDiagnostic = vi.fn((diagnostic: Parameters<RestorationDiagnosticRecorder["record"]>[0]) => {
    recorder.record(diagnostic);
  });
  const restorer = createVerifiedLocalRestorer({
    enabled: true,
    allowPathRestoration: true,
    allowRootRestorationFallback,
    refreshVisibleSelfLoops: false,
    actionOrder: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "BACK"],
    rootReplayActions: new Set<RemoteKey>(["UP", "DOWN", "LEFT", "RIGHT"]),
    initialSnapshot: home,
    initialIdentity: computeSnapshotFingerprint(home).stateIdentity,
    measuredDriver: driver,
    settling: normaliseActionSettlingOptions({ strategy: "driver" }),
    rootRestore,
    workBudgetTermination: () => null,
    withinDurationBudget: async (operation) => operation(new AbortController().signal),
    signalAborted: () => false,
    fingerprintSnapshot: computeSnapshotFingerprint,
    stateByIdentity: new Map([
      [computeSnapshotFingerprint(home).stateIdentity, { representativeSnapshot: home }],
      [computeSnapshotFingerprint(detail).stateIdentity, { representativeSnapshot: detail }],
    ]),
    monotonicNow: () => 1,
    durationSince: () => 0,
    onReplayAction,
    onSettlingObservation: vi.fn(),
    onReplayDuration: vi.fn(),
    onStateReuse,
    onPathRestoration,
    onFallback,
    onDiagnostic,
  });
  return {
    home, detail, unexpected, restorer, rootRestore, onFallback, onDiagnostic, recorder,
    onPathRestoration, onReplayAction, onStateReuse,
    setLive: (value: StateSnapshot) => { live = value; },
    setPressDestination: (value: StateSnapshot) => { pressDestination = value; },
    failSnapshot: () => { snapshotError = new Error("transient observer error"); },
  };
}

describe("verified-local restoration fallback accounting", () => {
  it("treats an absent verified path as a root fallback, not a failed restoration", async () => {
    const f = fixture();
    const result = await f.restorer.restore(queued(f.detail));
    expect(result).toEqual({ status: "ok", snapshot: f.detail });
    expect(f.rootRestore).toHaveBeenCalledOnce();
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(f.onDiagnostic).not.toHaveBeenCalled();
    expect(f.recorder.failures).toBe(0);
    expect(f.recorder.attempts).toBe(0);
    expect(f.restorer.liveIdentity()).toBe(computeSnapshotFingerprint(f.detail).stateIdentity);
  });

  it("fails closed when root fallback is disabled after a path miss", async () => {
    const f = fixture(false);
    const result = await f.restorer.restore(queued(f.detail));
    expect(result).toMatchObject({
      status: "skip",
      termination: { reason: "restoration-unavailable", restorationRejectionReason: "root-fallback-disabled" },
    });
    expect(f.rootRestore).not.toHaveBeenCalled();
    expect(f.onFallback).not.toHaveBeenCalled();
    expect(f.onDiagnostic).toHaveBeenCalledOnce();
    expect(f.onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      strategy: "root-replay", status: "failed", rejectionReason: "root-fallback-disabled",
    });
  });

  it("does not count an unsafe root replay as an executed fallback", async () => {
    const f = fixture();
    const result = await f.restorer.restore(queued(f.detail, ["SELECT"]));
    expect(result).toMatchObject({
      status: "skip",
      termination: { restorationRejectionReason: "unsafe-root-replay" },
    });
    expect(f.rootRestore).not.toHaveBeenCalled();
    expect(f.onFallback).not.toHaveBeenCalled();
    expect(f.onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      strategy: "root-replay", status: "failed", rejectionReason: "unsafe-root-replay",
    });
  });

  it("detects a changed live state and records genuine divergence before fallback", async () => {
    const f = fixture();
    f.setLive(f.unexpected);
    const result = await f.restorer.restore(queued(f.home, []));
    expect(result.status).toBe("ok");
    expect(f.onStateReuse).not.toHaveBeenCalled();
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(f.rootRestore).toHaveBeenCalledOnce();
    expect(f.onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      strategy: "verified-live-state", status: "failed",
      subtype: "navigation-diverged", rejectionReason: "local-path-edge-diverged",
    });
  });

  it("does not bypass disabled fallback on a live-state mismatch or observer failure", async () => {
    const mismatched = fixture(false);
    mismatched.setLive(mismatched.unexpected);
    const result = await mismatched.restorer.restore(queued(mismatched.home, []));
    expect(result).toMatchObject({
      status: "skip", termination: { restorationRejectionReason: "root-fallback-disabled" },
    });
    expect(mismatched.onDiagnostic.mock.calls.map((call) => call[0].rejectionReason)).toEqual([
      "local-path-edge-diverged", "root-fallback-disabled",
    ]);
    expect(mismatched.onFallback).not.toHaveBeenCalled();
    expect(mismatched.rootRestore).not.toHaveBeenCalled();

    const failed = fixture(false);
    failed.failSnapshot();
    const failure = await failed.restorer.restore(queued(failed.home, []));
    expect(failure).toMatchObject({
      status: "skip", termination: { restorationRejectionReason: "root-fallback-disabled" },
    });
    expect(failed.onDiagnostic.mock.calls.map((call) => call[0].rejectionReason)).toEqual([
      "local-path-action-error", "root-fallback-disabled",
    ]);
    expect(failed.onFallback).not.toHaveBeenCalled();
    expect(failed.rootRestore).not.toHaveBeenCalled();
  });

  it("keeps a real local edge divergence as failure evidence and falls back once", async () => {
    const f = fixture();
    f.restorer.recordEdge({
      fromIdentity: computeSnapshotFingerprint(f.home).stateIdentity,
      toIdentity: computeSnapshotFingerprint(f.detail).stateIdentity,
      key: "DOWN",
      expandable: true,
    });
    f.setPressDestination(f.unexpected);
    const result = await f.restorer.restore(queued(f.detail));
    expect(result.status).toBe("ok");
    expect(f.onReplayAction).toHaveBeenCalledOnce();
    expect(f.onPathRestoration).not.toHaveBeenCalled();
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(f.rootRestore).toHaveBeenCalledOnce();
    expect(f.onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      strategy: "verified-local-path", status: "failed",
      subtype: "navigation-diverged", rejectionReason: "local-path-edge-diverged",
    });
    expect(f.recorder.failures).toBe(1);
  });

  it("successfully uses a verified local path without counting fallback", async () => {
    const f = fixture();
    f.restorer.recordEdge({
      fromIdentity: computeSnapshotFingerprint(f.home).stateIdentity,
      toIdentity: computeSnapshotFingerprint(f.detail).stateIdentity,
      key: "DOWN",
      expandable: true,
    });
    const result = await f.restorer.restore(queued(f.detail));
    expect(result.status).toBe("ok");
    expect(f.onPathRestoration).toHaveBeenCalledOnce();
    expect(f.onFallback).not.toHaveBeenCalled();
    expect(f.rootRestore).not.toHaveBeenCalled();
    expect(f.onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      strategy: "verified-local-path", status: "success",
    });
  });

  it("avoids a longer local replay when a shorter safe root path preserves physical-action budget", async () => {
    const f = fixture();
    const middle = snapshot("middle");
    f.restorer.recordEdge({
      fromIdentity: computeSnapshotFingerprint(f.home).stateIdentity,
      toIdentity: computeSnapshotFingerprint(middle).stateIdentity,
      key: "RIGHT", expandable: true,
    });
    f.restorer.recordEdge({
      fromIdentity: computeSnapshotFingerprint(middle).stateIdentity,
      toIdentity: computeSnapshotFingerprint(f.detail).stateIdentity,
      key: "DOWN", expandable: true,
    });
    const result = await f.restorer.restore(queued(f.detail, ["DOWN"]));
    expect(result).toEqual({ status: "ok", snapshot: f.detail });
    expect(f.onReplayAction).not.toHaveBeenCalled();
    expect(f.rootRestore).toHaveBeenCalledOnce();
    expect(f.onPathRestoration).not.toHaveBeenCalled();
  });

  it("keeps a longer verified local route available if root fallback is prohibited", async () => {
    const f = fixture(false);
    const middle = snapshot("middle");
    f.restorer.recordEdge({
      fromIdentity: computeSnapshotFingerprint(f.home).stateIdentity,
      toIdentity: computeSnapshotFingerprint(middle).stateIdentity,
      key: "RIGHT", expandable: true,
    });
    f.restorer.recordEdge({
      fromIdentity: computeSnapshotFingerprint(middle).stateIdentity,
      toIdentity: computeSnapshotFingerprint(f.detail).stateIdentity,
      key: "DOWN", expandable: true,
    });
    f.setPressDestination(middle);
    const result = await f.restorer.restore(queued(f.detail, ["DOWN"]));
    expect(result.status).toBe("skip"); // the deliberately mocked second edge diverges
    expect(f.onReplayAction).toHaveBeenCalledTimes(2);
    expect(f.rootRestore).not.toHaveBeenCalled();
    expect(f.onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      strategy: "verified-local-path", rejectionReason: "local-path-edge-diverged",
    });
  });
});
