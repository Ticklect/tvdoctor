import type {
  ExplorationResult,
  StartupControlCandidate,
} from "@tvdoctor/core";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import {
  focusedWebEntry,
  isSafeWebControl,
  normaliseWebSemanticText,
  webSemanticContext,
  type WebPackResult,
} from "@tvdoctor/pack-web";
import type {
  ActionResult,
  DriverOperationOptions,
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { NavigationInventory } from "./node-audit-contracts.js";

export interface SafeExplorationOptions {
  /** Permit harmless selection of the two known Northstar fixture profiles only. */
  readonly fixtureProfileSelection?: boolean;
}

function isNorthstarFixtureProfile(snapshot: StateSnapshot, focused: NonNullable<ReturnType<typeof focusedWebEntry>>): boolean {
  if (snapshot.location.status !== "available") return false;
  let hostname: string;
  try {
    hostname = new URL(snapshot.location.value).hostname;
  } catch {
    return false;
  }
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return false;

  const node = focused.node;
  const id = node.stableId;
  const label = normaliseWebSemanticText(node.name ?? node.text);
  if ((id !== "profile-primary" || !/(?:^| )night owl$/u.test(label))
    && (id !== "profile-kids" || !/(?:^| )little stars$/u.test(label))) return false;
  if (node.role !== "button" || node.visible !== true || node.enabled !== true || node.focusable !== true) return false;
  return focused.ancestors.some((ancestor) => (
    ancestor.role === "dialog"
    && ancestor.modal === true
    && normaliseWebSemanticText(ancestor.name) === "choose a profile"
  ));
}

export function createSafeExplorationDriver(
  driver: PlaywrightWebDriver,
  policy: SafeExplorationOptions = {},
): TVDoctorDriver {
  return {
    capabilities: async (options) => driver.capabilities(options),
    snapshot: async (options) => driver.snapshot(options),
    reset: async (strategy, options) => driver.reset(strategy, options),
    press: async (key, options): Promise<ActionResult> => {
      options?.signal?.throwIfAborted();
      if (key !== "SELECT") return driver.press(key, options);
      const snapshot = await driver.snapshot(options);
      options?.signal?.throwIfAborted();
      const focused = focusedWebEntry(snapshot);
      const own = focused === null
        ? ""
        : normaliseWebSemanticText(focused.node.name ?? focused.node.text);
      const context = focused === null ? "" : webSemanticContext(focused);
      const safeProfileNavigation = focused !== null
        && (own === "profile" || own === "profiles")
        && /\b(nav|navigation|primary|rail)\b/u.test(context)
        && !context.includes("dialog");
      const fixtureProfile = policy.fixtureProfileSelection === true
        && focused !== null
        && isNorthstarFixtureProfile(snapshot, focused);
      if (focused === null || (!isSafeWebControl(focused.node, context) && !safeProfileNavigation && !fixtureProfile)) {
        return {
          key,
          outcome: "unsupported",
          timing: { inputSentAtMs: Date.now() },
          message: "SELECT was withheld because the focused semantic target was absent, ambiguous, or unsafe.",
        };
      }
      return driver.press(key, options);
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

/** Queue exhaustion is not full coverage when compression deferred focus states. */
export function navigationCoverageComplete(navigation: ExplorationResult | null): boolean {
  return navigation?.termination.complete === true
    && (navigation.statistics?.deferredStates ?? 0) === 0;
}

export function navigationInventory(
  navigation: ExplorationResult | null,
  web: WebPackResult | null,
): NavigationInventory {
  if (navigation === null) {
    return { status: "partial", screens: [], focusTargets: [], transitions: [], latencies: performanceLatencies(web) };
  }
  const screenKeyById = new Map(navigation.graph.screens.states.map((screen) => [screen.id, screen.fingerprint.value]));
  const focusKeyById = new Map(navigation.graph.focus.states.map((focus) => [focus.id, focus.fingerprint.value]));
  return {
    status: navigationCoverageComplete(navigation) ? "complete" : "partial",
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

export function preferredStartupControl(
  decision: "reject" | "accept",
  blockerKind: string,
  controls: readonly StartupControlCandidate[],
): StartupControlCandidate | null {
  if (blockerKind !== "consent-wall") return null;
  const normalise = (value: string | null | undefined): string =>
    value?.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ?? "";
  const intent = decision === "reject"
    ? /\b(?:reject|deny|decline)\b/u
    : /\b(?:accept|agree|allow)\b/u;
  const matches = controls.filter((control) => (
    control.enabled !== false
    && intent.test(normalise(control.name))
  ));
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

export function startupActivationSequence(
  controls: readonly StartupControlCandidate[],
  target: StartupControlCandidate,
): readonly RemoteKey[] {
  const targetIndex = controls.indexOf(target);
  if (targetIndex < 0) return [];
  return target.focused === true ? ["SELECT"] : [];
}

const MAX_STARTUP_DECISION_ACTIONS = 64;

function focusedStartupIdentity(snapshot: StateSnapshot): string | null {
  if (snapshot.focusedElement.status !== "available") return null;
  const focused = snapshot.focusedElement.value;
  if (focused === null) return null;
  const normalise = (value: string | null | undefined): string =>
    value?.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ?? "";
  return JSON.stringify([
    focused.stableId ?? null,
    focused.role ?? null,
    normalise(focused.name),
    focused.bounds ?? null,
  ]);
}

function focusedMatchesStartupDecision(
  snapshot: StateSnapshot,
  decision: "reject" | "accept",
): boolean {
  if (snapshot.focusedElement.status !== "available") return false;
  const focused = snapshot.focusedElement.value;
  if (focused === null) return false;
  const name = focused.name?.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ?? "";
  return decision === "reject"
    ? /\b(?:reject|deny|decline)\b/u.test(name)
    : /\b(?:accept|agree|allow)\b/u.test(name);
}

export async function resolveStartupDecisionThroughFocus(
  driver: TVDoctorDriver,
  decision: "reject" | "accept",
  blockerKind: string,
  initialSnapshot?: StateSnapshot,
  operationOptions?: DriverOperationOptions,
): Promise<readonly RemoteKey[] | null> {
  operationOptions?.signal?.throwIfAborted();
  if (blockerKind !== "consent-wall") return null;
  let snapshot = initialSnapshot ?? await driver.snapshot(operationOptions);
  operationOptions?.signal?.throwIfAborted();
  if (focusedMatchesStartupDecision(snapshot, decision)) return ["SELECT"];

  const initialIdentity = focusedStartupIdentity(snapshot);
  if (initialIdentity === null) return null;
  const seen = new Set<string>([initialIdentity]);
  const actions: RemoteKey[] = [];

  while (actions.length < MAX_STARTUP_DECISION_ACTIONS - 1) {
    operationOptions?.signal?.throwIfAborted();
    const result = await driver.press("TAB", operationOptions);
    operationOptions?.signal?.throwIfAborted();
    if (result.key !== "TAB" || result.outcome !== "applied") return null;
    actions.push("TAB");
    snapshot = result.postActionSnapshot ?? await driver.snapshot(operationOptions);
    operationOptions?.signal?.throwIfAborted();
    if (focusedMatchesStartupDecision(snapshot, decision)) {
      return [...actions, "SELECT"];
    }
    const identity = focusedStartupIdentity(snapshot);
    if (identity === null || seen.has(identity)) return null;
    seen.add(identity);
  }
  return null;
}
