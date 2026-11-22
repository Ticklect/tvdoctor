import { createHash } from "node:crypto";

import {
  confirmWebSafeKeyboardPageError,
  type PlaywrightWebDriver,
  type WebActionRuntimeErrorSnapshot,
  type WebRuntimeErrorActionWitness,
} from "@tvdoctor/driver-web";
import type { ExplorationResult } from "@tvdoctor/core";
import type { RemoteKey, StateSnapshot, TVDoctorIssue, TVDoctorDriver } from "@tvdoctor/protocol";

import { safeKeyboardDriver } from "./keyboard-actions.js";
import { createSafeExplorationDriver } from "./node-audit-navigation.js";

const MAX_RECHECKS = 2;
const MAX_RECHECK_STEPS = 16;
const MAX_RECHECK_MS = 12_000;

/**
 * Snapshot identities are taken directly from the existing explorer's
 * onActionObserved callback. This avoids guessing which graph edge a runtime
 * event belongs to from wall-clock timestamps or reused focus names.
 */
export class WebKeyboardRuntimeWitnesses {
  readonly #byAfter = new WeakMap<StateSnapshot, WebActionRuntimeErrorSnapshot>();
  readonly #driver: Pick<PlaywrightWebDriver,
    "getLastActionRuntimeEvidence" | "consumeActionRuntimeErrors">;

  constructor(driver: Pick<PlaywrightWebDriver,
    "getLastActionRuntimeEvidence" | "consumeActionRuntimeErrors">) { this.#driver = driver; }

  observe(key: RemoteKey, afterSnapshot: StateSnapshot): void {
    const last = this.#driver.getLastActionRuntimeEvidence();
    const runtime = this.#driver.consumeActionRuntimeErrors();
    if (last === null || last.key !== key || last.outcome !== "applied"
      || runtime.droppedRecords !== 0 || runtime.events.length !== 1
      || runtime.events[0]?.token !== last.token
      || runtime.events[0]?.generation !== last.generation) return;
    this.#byAfter.set(afterSnapshot, runtime);
  }

  original(result: ExplorationResult): readonly {
    readonly witness: WebRuntimeErrorActionWitness;
  }[] {
    const candidates: { witness: WebRuntimeErrorActionWitness }[] = [];
    for (const attempt of result.graph.actions) {
      const runtime = this.#byAfter.get(attempt.afterSnapshot);
      if (runtime === undefined || attempt.actionResult.outcome !== "applied"
        || attempt.toScreenStateId === null || attempt.toFocusStateId === null
        || attempt.actionSequence.length === 0
        || attempt.actionSequence.length > MAX_RECHECK_STEPS) continue;
      candidates.push({ witness: {
        before: attempt.beforeSnapshot, after: attempt.afterSnapshot,
        sequence: attempt.actionSequence, runtime,
      } });
      if (candidates.length === MAX_RECHECKS) break;
    }
    return candidates;
  }
}

/**
 * Re-observation is review evidence, not a FIXED oracle. Deliberately do not
 * create a portable generic transition replay: missing errors after a later
 * scan never establish repair of a JavaScript exception.
 */
export async function independentlyReobserveWebKeyboardErrors(options: {
  readonly driver: PlaywrightWebDriver;
  readonly navigation: ExplorationResult;
  readonly witnesses: WebKeyboardRuntimeWitnesses;
  readonly restore: () => Promise<StateSnapshot>;
  readonly fixtureProfileSelection: boolean;
  readonly signal?: AbortSignal;
}): Promise<readonly TVDoctorIssue[]> {
  const issues: TVDoctorIssue[] = [];
  for (const { witness } of options.witnesses.original(options.navigation)) {
    if (options.signal?.aborted === true) break;
    const deadline = Date.now() + MAX_RECHECK_MS;
    try {
      await options.restore();
      if (Date.now() >= deadline || options.signal?.aborted) continue;
      const pressDriver: TVDoctorDriver = safeKeyboardDriver(createSafeExplorationDriver(options.driver, {
        fixtureProfileSelection: options.fixtureProfileSelection,
      }));
      // Restore/replay inputs are intentionally not credited as original
      // action evidence. An error during setup invalidates comparability.
      if (options.driver.consumeActionRuntimeErrors().droppedRecords !== 0) continue;
      let prepared = true;
      for (const key of witness.sequence.slice(0, -1)) {
        if (Date.now() >= deadline || options.signal?.aborted) { prepared = false; break; }
        const result = await pressDriver.press(key);
        if (result.outcome !== "applied" || options.driver.consumeActionRuntimeErrors().events.length > 0) {
          prepared = false;
          break;
        }
      }
      if (!prepared || Date.now() >= deadline || options.signal?.aborted) continue;
      const before = await options.driver.snapshot();
      const final = witness.sequence.at(-1);
      if (final === undefined) continue;
      const result = await pressDriver.press(final);
      const last = options.driver.getLastActionRuntimeEvidence();
      const runtime = options.driver.consumeActionRuntimeErrors();
      if (result.outcome !== "applied" || last?.key !== final
        || last.outcome !== "applied" || runtime.droppedRecords !== 0
        || runtime.events.length !== 1 || runtime.events[0]?.token !== last.token
        || runtime.events[0]?.generation !== last.generation) continue;
      const after = await options.driver.snapshot();
      const verified = confirmWebSafeKeyboardPageError(witness, {
        before, after, sequence: witness.sequence, runtime,
      });
      if (verified === null) continue;
      const id = `TVDOCTOR-WEB-${createHash("sha256")
        .update(JSON.stringify([verified.rule, verified.source.stableId,
          verified.action, verified.errorClass, witness.before.location]))
        .digest("hex").slice(0, 32).toUpperCase()}`;
      const issue: TVDoctorIssue = {
        id, rule: verified.rule, pack: "navigation", severity: "high",
        confidence: "deterministic", screen: null,
        title: `Uncaught ${verified.errorClass} reobserved during a safe keyboard action`,
        description: "An uncaught page exception was observed during the same safe keyboard action after an independent browser reset. Timing is correlated, but causation and an independently corrected state are not proven.",
        expected: "No uncaught page exception while this safe keyboard action settles.",
        observed: `The same ${verified.errorClass} recurred during ${verified.action} on the same identified control after a fresh restoration.`,
        transition: null,
        evidence: [{
          kind: "deterministic-failure",
          summary: "Two separate browser generations directly observed the same safe-input press-window exception class and stable source control; no exception text, stack or URL was retained.",
          source: "PlaywrightWebDriver:pageerror-press-window/v1", artifact: null,
        }],
        reproduction: { status: "unavailable",
          reason: "The source was independently reobserved, but no portable rule-specific fixed-state oracle exists. Review before claiming a fix." },
      };
      if (!issues.some((entry) => entry.id === issue.id)) issues.push(issue);
    } catch {
      // A changed route, auth state, failed restore, unobservable browser or
      // unsafe/unsettled action is insufficient original functional evidence.
      continue;
    }
  }
  return issues;
}
