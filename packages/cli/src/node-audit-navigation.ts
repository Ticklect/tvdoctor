import type {
  ExplorationResult,
  NavigationDiagnosticFinding,
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
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { NavigationInventory } from "./node-audit-contracts.js";

export function createSafeExplorationDriver(driver: PlaywrightWebDriver): TVDoctorDriver {
  return {
    capabilities: async () => driver.capabilities(),
    snapshot: async () => driver.snapshot(),
    reset: async (strategy) => driver.reset(strategy),
    press: async (key): Promise<ActionResult> => {
      if (key !== "SELECT") return driver.press(key);
      const snapshot = await driver.snapshot();
      const focused = focusedWebEntry(snapshot);
      const own = focused === null
        ? ""
        : normaliseWebSemanticText(focused.node.name ?? focused.node.text);
      const context = focused === null ? "" : webSemanticContext(focused);
      const safeProfileNavigation = focused !== null
        && (own === "profile" || own === "profiles")
        && /\b(nav|navigation|primary|rail)\b/u.test(context)
        && !context.includes("dialog");
      if (focused === null || (!isSafeWebControl(focused.node, context) && !safeProfileNavigation)) {
        return {
          key,
          outcome: "unsupported",
          timing: { inputSentAtMs: Date.now() },
          message: "SELECT was withheld because the focused semantic target was absent, ambiguous, or unsafe.",
        };
      }
      return driver.press(key);
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
    status: navigation.termination.complete ? "complete" : "partial",
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

export function specialisedReachabilityScreen(finding: NavigationDiagnosticFinding, navigation: ExplorationResult): boolean {
  if (finding.issue.rule !== "remote.reachability") return false;
  const screen = navigation.graph.screens.states.find((candidate) => candidate.id === finding.source.screenStateId);
  if (screen === undefined) return false;
  const semanticText = flattenNodes(screen.representativeSnapshot)
    .flatMap((node) => [node.name, node.text])
    .filter((value): value is string => value !== null)
    .join(" ")
    .normalize("NFKC")
    .toLowerCase();
  return /\b(player|captions?|search results?|player settings)\b/u.test(semanticText);
}

export function preferredStartupControl(
  decision: "reject" | "accept",
  blockerKind: string,
  controls: readonly StartupControlCandidate[],
): StartupControlCandidate | null {
  const normalise = (value: string | null | undefined): string =>
    value?.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ?? "";
  const rejectWords = decision === "reject"
    ? /\b(?:reject|deny|decline|essential|necessary|manage|options|preferences)\b/u
    : /\b(?:accept(?: all)?|agree|allow|continue|got it|ok(?:ay)?)\b/u;
  const candidates = [...controls].sort((left, right) => {
    const leftFocused = left.focused === true ? 0 : 1;
    const rightFocused = right.focused === true ? 0 : 1;
    return leftFocused - rightFocused;
  });
  return candidates.find((control) => rejectWords.test(normalise(control.name))) ?? null;
}

export function startupActivationSequence(
  controls: readonly StartupControlCandidate[],
  target: StartupControlCandidate,
): readonly RemoteKey[] {
  const focusedIndex = controls.findIndex((control) => control.focused === true);
  const targetIndex = controls.indexOf(target);
  if (targetIndex < 0) return [];
  if (focusedIndex < 0 || focusedIndex === targetIndex) return ["SELECT"];
  const distance = (targetIndex - focusedIndex + controls.length) % controls.length;
  return [...Array.from({ length: distance }, () => "TAB" as RemoteKey), "SELECT"];
}
