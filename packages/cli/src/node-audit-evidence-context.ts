import type { PlaywrightWebDriver, WebLogEntry } from "@tvdoctor/driver-web";
import type { ActionResult, RemoteKey, StateSnapshot, TVDoctorIssue, UiNodeSnapshot } from "@tvdoctor/protocol";
import { EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS } from "./node-audit-contracts.js";
import { createSafeExplorationDriver } from "./node-audit-navigation.js";

export const EVIDENCE_EXCERPT_MAX_NODES = 150;
const MODAL_FOCUS_READY_TIMEOUT_MS = 2_500;
const MODAL_FOCUS_POLL_MS = 80;

/** Only source-proven modal Tab defects benefit from waiting for hydration. */
export function modalFocusSource(issue: TVDoctorIssue, sequence: readonly RemoteKey[]): string | null {
  const transition = issue.transition;
  const final = sequence.at(-1);
  return (issue.rule === "keyboard.modal-focus-escape"
      || issue.rule === "keyboard.modal-tab-focus-loss")
    && issue.confidence === "deterministic"
    && issue.evidence.some((entry) => entry.kind === "deterministic-failure")
    && issue.reproduction.status === "available"
    && issue.reproduction.confidence === "deterministic"
    && (transition?.action === "TAB" || transition?.action === "SHIFT_TAB")
    && final === transition.action
    && typeof transition.fromElement === "string"
    && transition.fromElement.trim().length > 0
    ? transition.fromElement : null;
}

/** One exact, visible and unique live focus witness; never infer a target from
 * the requested issue alone. Snapshot routes are intentionally redacted, so
 * compare the raw page URL only in memory and require the snapshot's origin. */
function modalFocusReady(snapshot: StateSnapshot, target: string, liveUrl: string,
  originalFocus: string): string | null {
  if (snapshot.location.status !== "available"
    || snapshot.focusedElement.status !== "available"
    || snapshot.uiTree.status !== "available") return null;
  try {
    const intended = new URL(target);
    if (new URL(liveUrl).href !== intended.href
      || new URL(snapshot.location.value).origin !== intended.origin) return null;
  } catch { return null; }
  const focused = snapshot.focusedElement.value;
  if (focused === null || focusedIdentity(snapshot) !== originalFocus
    || !(focused.stableId?.trim() || focused.name?.trim())) return null;
  const matches: UiNodeSnapshot[] = [];
  const pending = [...snapshot.uiTree.value];
  let scanned = 0;
  while (pending.length > 0 && scanned < 4_096) {
    const node = pending.shift();
    if (node === undefined) break;
    scanned++;
    const identity = node.stableId?.trim() || node.name?.trim();
    if (identity === originalFocus) matches.push(node);
    pending.push(...node.children);
  }
  if (pending.length > 0 || matches.length !== 1) return null;
  const match = matches[0];
  if (match?.focused !== true || match.visible !== true || match.enabled !== true
    || match.focusable !== true || (match.role ?? null) !== (focused.role ?? null)
    || (match.name ?? null) !== (focused.name ?? null)
    // UI-tree snapshots represent absent IDs as null; focused-element records
    // omit absent IDs. Both mean no authored DOM identity, not a state change.
    || (match.stableId ?? null) !== (focused.stableId ?? null)) return null;
  // Keep semantic identity stable even if the DOM id is reused by a new shell.
  return JSON.stringify([match.stableId, match.role, match.name]);
}

async function readyModalFocus(driver: PlaywrightWebDriver, target: string,
  originalFocus: string, evidenceDeadline: number): Promise<StateSnapshot> {
  const deadline = Math.min(evidenceDeadline, performance.now() + MODAL_FOCUS_READY_TIMEOUT_MS);
  let lastSignature: string | null = null;
  let stable = 0;
  while (performance.now() < deadline) {
    const snapshot = await withinDeadline(
      (signal) => driver.snapshot({ signal }), deadline, "Bounded modal focus readiness",
    );
    let liveUrl: string;
    try { liveUrl = driver.getPage().url(); }
    catch { throw new Error("Modal focus readiness was unavailable."); }
    // A changed protected route is not an async focus delay. Do not wait on or
    // navigate to a different route to try to reproduce the old issue.
    if (liveUrl !== target) throw new Error("Original evidence route changed before action.");
    const signature = modalFocusReady(snapshot, target, liveUrl, originalFocus);
    stable = signature !== null && signature === lastSignature ? stable + 1 : signature === null ? 0 : 1;
    lastSignature = signature;
    if (stable >= 2) return snapshot;
    const remaining = deadline - performance.now();
    if (remaining <= MODAL_FOCUS_POLL_MS) break;
    await withinDeadline(
      (signal) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, MODAL_FOCUS_POLL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }), deadline, "Bounded modal focus wait",
    );
  }
  throw new Error("Original modal focus was not stably restored before evidence action.");
}

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

export function persistedSnapshot(snapshot: StateSnapshot, targetRedaction?: "origin"): StateSnapshot {
  const bounded = boundedSnapshot(snapshot);
  if (targetRedaction !== "origin" || bounded.location.status !== "available") return bounded;
  try {
    return {
      ...bounded,
      location: { status: "available", value: new URL(bounded.location.value).origin },
    };
  } catch {
    return {
      ...bounded,
      location: { status: "unavailable", reason: "Location omitted by strict target redaction." },
    };
  }
}

async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  const remainingMs = deadlineMs - performance.now();
  if (remainingMs <= 0) throw new Error(`${label} exceeded the bounded evidence-capture deadline.`);
  const controller = new AbortController();
  const deadlineError = new Error(`${label} exceeded the bounded evidence-capture deadline.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort(deadlineError);
            reject(deadlineError);
          },
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function captureContext(
  target: string,
  sequence: readonly RemoteKey[],
  driver: PlaywrightWebDriver,
  closeDriver: boolean,
  maximumDurationMs = EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS,
  captureScreenshots = true,
  fixtureProfileSelection = false,
  originalModalFocus: string | null = null,
): Promise<{
  readonly before: StateSnapshot;
  readonly after: StateSnapshot;
  readonly beforePng: Uint8Array | null;
  readonly afterPng: Uint8Array | null;
  readonly action: ActionResult | null;
  readonly logs: readonly WebLogEntry[];
}> {
  const deadlineMs = performance.now() + maximumDurationMs;
  // Use the same per-press semantic SELECT guard as exploration. It captures a
  // fresh focus snapshot and refuses an ambiguous or unsafe activation before
  // forwarding the key to the browser, including during setup replay.
  const safeDriver = createSafeExplorationDriver(driver, { fixtureProfileSelection });
  try {
    await withinDeadline(
      (signal) => driver.launch({ id: "cli-issue-evidence", launchUri: target }, { signal }),
      deadlineMs,
      "Evidence browser launch",
    );
    const setup = sequence.length === 0 ? [] : sequence.slice(0, -1);
    for (const key of setup) {
      const result = await withinDeadline(
        (signal) => safeDriver.press(key, { signal }), deadlineMs, `Evidence setup ${key}`,
      );
      if (result.outcome !== "applied") throw new Error(`Evidence setup ${key} was ${result.outcome}.`);
    }
    const before = originalModalFocus === null
      ? await withinDeadline((signal) => driver.snapshot({ signal }), deadlineMs, "Evidence before snapshot")
      : await readyModalFocus(driver, target, originalModalFocus, deadlineMs);
    const beforePng = captureScreenshots
      ? await withinDeadline(
        () => driver.getPage().screenshot({ type: "png", animations: "disabled" }),
        deadlineMs,
        "Evidence before screenshot",
      )
      : null;
    if (originalModalFocus !== null) {
      // A late hydration/ref-focus update after the screenshot invalidates the
      // checkpoint. Withhold Tab; never retry or replay an assertion action.
      const latest = await withinDeadline(
        (signal) => driver.snapshot({ signal }), deadlineMs, "Evidence final focus checkpoint",
      );
      const signature = modalFocusReady(latest, target, driver.getPage().url(), originalModalFocus);
      const original = modalFocusReady(before, target, driver.getPage().url(), originalModalFocus);
      if (signature === null || signature !== original) {
        throw new Error("Original modal focus changed before evidence action.");
      }
    }
    const assertion = sequence.at(-1);
    const action = assertion === undefined
      ? null
      : await withinDeadline(
        (signal) => safeDriver.press(assertion, { signal }), deadlineMs, `Evidence assertion ${assertion}`,
      );
    if (action !== null && action.outcome !== "applied") {
      throw new Error(`Evidence assertion ${assertion} was ${action.outcome}.`);
    }
    const after = await withinDeadline(
      (signal) => driver.snapshot({ signal }), deadlineMs, "Evidence after snapshot",
    );
    const afterPng = captureScreenshots
      ? await withinDeadline(
        () => driver.getPage().screenshot({ type: "png", animations: "disabled" }),
        deadlineMs,
        "Evidence after screenshot",
      )
      : null;
    const logs = await withinDeadline(() => driver.getLogs(), deadlineMs, "Evidence log capture");
    return { before, after, beforePng, afterPng, action, logs };
  } catch (error) {
    // A pooled session that fails mid-operation is retired before reuse. The
    // next launch may create a new browser process, while successful captures
    // keep the process alive and receive a fresh BrowserContext on launch().
    if (!closeDriver) {
      await withinDeadline(
        () => driver.close(),
        performance.now() + 5_000,
        "Evidence browser retirement",
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (closeDriver) {
      await withinDeadline(
        () => driver.close(),
        performance.now() + 5_000,
        "Evidence browser cleanup",
      ).catch(() => undefined);
    }
  }
}

export function focusedIdentity(snapshot: StateSnapshot): string | null {
  if (snapshot.focusedElement.status !== "available") return null;
  const target = snapshot.focusedElement.value;
  for (const value of [target?.stableId, target?.name, target?.role]) {
    const candidate = value?.trim();
    if (candidate !== undefined && candidate.length > 0) return candidate;
  }
  return null;
}
