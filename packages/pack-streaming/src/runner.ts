import type { TVDoctorDriver } from "@tvdoctor/protocol";
import type {
  StreamingPackOptions,
  StreamingPackResult,
} from "./types.js";
import { validateStreamingOptions } from "./streaming-options.js";
import { StreamingSession } from "./streaming-runtime.js";
import { runStreamingJourney } from "./streaming-journey.js";

/**
 * Runs a safe, semantic streaming journey without accepting a route or fixture
 * hints. All discovery is based on roles, names, tree context, and D-pad state.
 */
export async function runStreamingPack(
  driver: TVDoctorDriver,
  options: StreamingPackOptions = {},
): Promise<StreamingPackResult> {
  const budgets = validateStreamingOptions(options);
  const session = new StreamingSession(
    driver,
    budgets,
    options.resetStrategy ?? "reload",
    options.restoreInitialState,
    options.monotonicNow ?? (() => performance.now()),
  );
  return runStreamingJourney(session, options, budgets);
}
