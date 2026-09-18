import type { ActionResult, TVDoctorDriver } from "@tvdoctor/protocol";

import type { ExplorationPhaseTimings } from "./explorer-contracts.js";

type MutablePhaseTimings = { -readonly [Key in keyof ExplorationPhaseTimings]: ExplorationPhaseTimings[Key] };

export function createExplorerPerformance(
  driver: TVDoctorDriver,
  monotonicNow: () => number,
): {
  readonly phaseTimings: MutablePhaseTimings;
  readonly durationSince: (startedAt: number) => number;
  readonly measureSynchronous: <T>(
    phase: "semanticNormalizationMs" | "graphBookkeepingMs",
    operation: () => T,
  ) => T;
  readonly measuredDriver: TVDoctorDriver;
} {
  const phaseTimings: MutablePhaseTimings = {
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
    const startedAt = monotonicNow();
    try {
      return operation();
    } finally {
      phaseTimings[phase] += durationSince(startedAt);
    }
  };
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
    capabilities: async (options) => driver.capabilities(options),
    press: async (key, options) => {
      const startedAt = monotonicNow();
      try {
        const result = await driver.press(key, options);
        recordActionTiming(result);
        return result;
      } finally {
        phaseTimings.driverPressMs += durationSince(startedAt);
      }
    },
    snapshot: async (options) => {
      const startedAt = monotonicNow();
      try {
        return await driver.snapshot(options);
      } finally {
        phaseTimings.snapshotCaptureMs += durationSince(startedAt);
      }
    },
  };
  return { phaseTimings, durationSince, measureSynchronous, measuredDriver };
}
