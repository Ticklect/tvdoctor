import type { ActionResult, StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";

import type { ExplorationPhaseTimings } from "./explorer-contracts.js";
import {
  computeSnapshotFingerprint,
  type ComputedSnapshotFingerprint,
} from "./fingerprint.js";

export interface ExplorerPerformanceTracker {
  readonly phaseTimings: ExplorationPhaseTimings;
  readonly durationSince: (startedAt: number) => number;
  readonly measureSynchronous: <T>(
    phase: "semanticNormalizationMs" | "graphBookkeepingMs",
    operation: () => T,
  ) => T;
  readonly fingerprintSnapshot: (snapshot: StateSnapshot) => ComputedSnapshotFingerprint;
  readonly measuredDriver: TVDoctorDriver;
}

export function createExplorerPerformanceTracker(
  driver: TVDoctorDriver,
  monotonicNow: () => number,
): ExplorerPerformanceTracker {
  const phaseTimings = {
    resetMs: 0,
    pathReplayMs: 0,
    driverPressMs: 0,
    actionDispatchMs: 0,
    focusSettlingMs: 0,
    screenSettlingMs: 0,
    snapshotCaptureMs: 0,
    semanticNormalizationMs: 0,
    graphBookkeepingMs: 0,
  };
  const durationSince = (startedAt: number): number => Math.max(0, monotonicNow() - startedAt);
  const measureSynchronous = <T>(
    phase: "semanticNormalizationMs" | "graphBookkeepingMs",
    operation: () => T,
  ): T => {
    const operationStartedAt = monotonicNow();
    try {
      return operation();
    } finally {
      phaseTimings[phase] += durationSince(operationStartedAt);
    }
  };
  const fingerprintSnapshot = (snapshot: StateSnapshot): ComputedSnapshotFingerprint => (
    measureSynchronous("semanticNormalizationMs", () => computeSnapshotFingerprint(snapshot))
  );
  const recordActionTiming = (result: ActionResult): void => {
    const inputAt = result.timing.inputSentAtMs;
    const responseAt = Math.max(inputAt, result.timing.firstResponseAtMs ?? inputAt);
    const focusAt = Math.max(responseAt, result.timing.focusSettledAtMs ?? responseAt);
    const screenAt = Math.max(focusAt, result.timing.screenSettledAtMs ?? focusAt);
    phaseTimings.actionDispatchMs += responseAt - inputAt;
    phaseTimings.focusSettlingMs += focusAt - responseAt;
    phaseTimings.screenSettlingMs += screenAt - focusAt;
  };
  const measuredDriver: TVDoctorDriver = {
    capabilities: async (operationOptions) => driver.capabilities(operationOptions),
    press: async (key, operationOptions) => {
      const pressStartedAt = monotonicNow();
      try {
        const result = await driver.press(key, operationOptions);
        recordActionTiming(result);
        return result;
      } finally {
        phaseTimings.driverPressMs += durationSince(pressStartedAt);
      }
    },
    snapshot: async (operationOptions) => {
      const snapshotStartedAt = monotonicNow();
      try {
        return await driver.snapshot(operationOptions);
      } finally {
        phaseTimings.snapshotCaptureMs += durationSince(snapshotStartedAt);
      }
    },
  };
  return { phaseTimings, durationSince, measureSynchronous, fingerprintSnapshot, measuredDriver };
}
