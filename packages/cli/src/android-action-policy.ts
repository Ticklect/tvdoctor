import { createHash } from "node:crypto";
import type { ExplorationBudgets } from "@tvdoctor/core";
import type {
  AndroidStateSnapshot,
  AndroidUiNodeSnapshot,
} from "@tvdoctor/driver-android";
import {
  NAVIGATION_KEYS,
  REMOTE_KEYS,
  type Observation,
  type RemoteKey,
} from "@tvdoctor/protocol";
import type { AndroidTraversalStrategy } from "./android-traversal.js";

const MEDIA_KEYS = [
  "PLAY_PAUSE",
  "PLAY",
  "PAUSE",
  "STOP",
  "NEXT",
  "PREVIOUS",
  "REWIND",
  "FAST_FORWARD",
] as const satisfies readonly RemoteKey[];

const ANDROID_REMOTE_KEYS = REMOTE_KEYS.filter((key) => key !== "TAB");

const RISKY_ACTIVATION = /\b(?:sign[ -]?in|log[ -]?in|login|subscribe|subscription|buy|purchase|pay(?:ment)?|delete(?:\s+(?:account|data))?|erase|wipe|factory\s+reset|uninstall|sign[ -]?out|logout)\b/iu;
const PERSISTENT_TOGGLE = /\b(?:display|show|view)\s+(?:in|as)\s+(?:a\s+)?(?:grid|list)\b/iu;
const PERSISTENT_MUTATION = /\b(?:add(?:\s+to)?|remove(?:\s+from)?)\s+(?:favorites?|favourites?|bookmarks?|watchlist|library)\b/iu;
const PLAYER_SEMANTICS = /\b(?:player|play|pause|stop|next|previous|rewind|fast[ -]?forward|media)\b/iu;

export interface AndroidMediaSessionPolicyMetadata {
  readonly packageName: string;
  readonly active: boolean;
  readonly playbackState: string | null;
}

export type AndroidActionDisposition =
  | "automatic"
  | "target-boundary"
  | "operator-gated"
  | "inaccessible";

export interface AndroidActionDecision {
  readonly actionId: string;
  readonly key: RemoteKey;
  readonly disposition: AndroidActionDisposition;
  readonly reasonCode: string;
  readonly detail: string;
}

export interface AndroidActionPolicyContext {
  readonly strategy: AndroidTraversalStrategy;
  readonly snapshot: AndroidStateSnapshot;
  readonly screenStateId: string;
  readonly targetPackage: string;
  readonly mediaSession: Observation<AndroidMediaSessionPolicyMetadata>;
  readonly authorisedActionIds: ReadonlySet<string>;
}

export const ANDROID_EXPLORATION_BUDGETS: Readonly<Record<
  AndroidTraversalStrategy,
  Readonly<Record<"quick" | "deep", ExplorationBudgets>>
>> = {
  adaptive: {
    quick: { maxActions: 300, maxStates: 75, maxDepth: 16, maxDurationMs: 720_000 },
    deep: { maxActions: 10_000, maxStates: 1_000, maxDepth: 32, maxDurationMs: 1_800_000 },
  },
  "brute-force": {
    quick: { maxActions: 1_500, maxStates: 250, maxDepth: 16, maxDurationMs: 1_800_000 },
    deep: { maxActions: 25_000, maxStates: 2_500, maxDepth: 64, maxDurationMs: 3_600_000 },
  },
};

function flattenNodes(nodes: readonly AndroidUiNodeSnapshot[]): readonly AndroidUiNodeSnapshot[] {
  const flattened: AndroidUiNodeSnapshot[] = [];
  const pending = [...nodes];
  while (pending.length > 0 && flattened.length < 2_048) {
    const current = pending.shift();
    if (current === undefined) break;
    flattened.push(current);
    pending.push(...current.children);
  }
  return flattened;
}

function nodeSemantics(node: AndroidUiNodeSnapshot | undefined): string {
  if (node === undefined) return "";
  return [node.name, node.text, node.role]
    .filter((value): value is string => value !== null && value.trim().length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}

function actionId(
  context: AndroidActionPolicyContext,
  focused: AndroidUiNodeSnapshot | undefined,
  key: RemoteKey,
): string {
  const stableFields = JSON.stringify([
    context.screenStateId.slice(0, 256),
    focused?.stableId?.slice(0, 256) ?? "",
    nodeSemantics(focused),
    key,
  ]);
  return "android-action-" + createHash("sha256").update(stableFields).digest("hex").slice(0, 32);
}

function targetOwned(context: AndroidActionPolicyContext): boolean {
  if (context.snapshot.location.status !== "available") return false;
  if (context.snapshot.hierarchyMetadata.status === "available"
    && !context.snapshot.hierarchyMetadata.value.targetWindowActive) {
    return false;
  }
  const encodedPackage = encodeURIComponent(context.targetPackage);
  const location = context.snapshot.location.value;
  return location.startsWith("android://" + context.targetPackage + "/")
    || location.startsWith("android://" + encodedPackage + "/")
    || location.startsWith("android-app://" + context.targetPackage + "/")
    || location.startsWith("android-app://" + encodedPackage + "/");
}

function hasPlayerSemantics(nodes: readonly AndroidUiNodeSnapshot[]): boolean {
  return nodes.some((node) => PLAYER_SEMANTICS.test(nodeSemantics(node)));
}

function containsPersistentToggle(node: AndroidUiNodeSnapshot | undefined): boolean {
  if (node === undefined) return false;
  const pending = [node];
  let visited = 0;
  while (pending.length > 0 && visited < 2_048) {
    const candidate = pending.shift();
    if (candidate === undefined) break;
    visited += 1;
    if (candidate.role === "checkbox"
      || candidate.role === "switch"
      || /(?:CheckBox|Switch)$/u.test(candidate.className ?? "")) return true;
    pending.push(...candidate.children);
  }
  return false;
}

function isPersistentMutation(node: AndroidUiNodeSnapshot | undefined, semantics: string): boolean {
  if (node === undefined || node.role === "tab") return false;
  return PERSISTENT_MUTATION.test(semantics)
    || /(?:favorite|favourite|bookmark|watchlist)(?:button)?(?:#|$)/iu.test(node.stableId ?? "");
}

export function decideAndroidActions(
  context: AndroidActionPolicyContext,
): readonly AndroidActionDecision[] {
  const nodes = context.snapshot.uiTree.status === "available"
    ? flattenNodes(context.snapshot.uiTree.value)
    : [];
  const focused = nodes.find((node) => node.focused === true)
    ?? nodes.find((node) => node.stableId !== null
      && context.snapshot.focusedElement.status === "available"
      && context.snapshot.focusedElement.value?.stableId === node.stableId);
  const mediaEligible = (
    context.mediaSession.status === "available"
    && context.mediaSession.value.active
    && context.mediaSession.value.packageName === context.targetPackage
  ) || hasPlayerSemantics(nodes);
  const keys = context.strategy === "brute-force"
    ? ANDROID_REMOTE_KEYS
    : [...NAVIGATION_KEYS, ...(mediaEligible ? MEDIA_KEYS : []), "HOME"] as readonly RemoteKey[];
  const owned = targetOwned(context);
  const semantics = nodeSemantics(focused);

  return keys.map((key) => {
    const id = actionId(context, focused, key);
    if (!owned) {
      return {
        actionId: id,
        key,
        disposition: "inaccessible",
        reasonCode: "target-state-unavailable",
        detail: "The exact target-owned state could not be established.",
      };
    }
    if (key === "HOME") {
      return {
        actionId: id,
        key,
        disposition: "target-boundary",
        reasonCode: "home-boundary-probe",
        detail: "Exercise HOME once, record the package boundary, and restore the exact target state.",
      };
    }
    if (key === "SELECT") {
      const gatedReason = RISKY_ACTIVATION.test(semantics)
        ? "risky-activation"
        : isPersistentMutation(focused, semantics)
          ? "persistent-mutation"
          : PERSISTENT_TOGGLE.test(semantics) || containsPersistentToggle(focused)
            ? "persistent-toggle"
            : semantics.length === 0 ? "ambiguous-activation" : null;
      if (gatedReason !== null) {
        if (context.authorisedActionIds.has(id)) {
          return {
            actionId: id,
            key,
            disposition: "automatic",
            reasonCode: "explicitly-authorised",
            detail: "The operator explicitly authorised this exact state, control, and action.",
          };
        }
        return {
          actionId: id,
          key,
          disposition: "operator-gated",
          reasonCode: gatedReason,
          detail: gatedReason === "ambiguous-activation"
            ? "The focused activation target does not expose enough semantics for safe automatic selection."
            : gatedReason === "persistent-mutation"
              ? "The focused control changes persistent target data that relaunch cannot restore."
              : gatedReason === "persistent-toggle"
                ? "The focused control changes a persistent display preference that cannot be restored by relaunching."
                : "The focused control may authenticate, purchase, subscribe, or change persistent data.",
        };
      }
    }
    return {
      actionId: id,
      key,
      disposition: "automatic",
      reasonCode: "safe-target-action",
      detail: "The action is safe to exercise from this exact target-owned state.",
    };
  });
}
