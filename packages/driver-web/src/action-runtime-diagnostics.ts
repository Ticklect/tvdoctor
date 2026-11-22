import type { RemoteKey, StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";
import type {
  WebActionRuntimeErrorEvidence,
  WebActionRuntimeErrorSnapshot,
} from "./types.js";

/**
 * This rule is confined to an uncaught JavaScript exception directly observed
 * during a real applied keyboard press, then independently re-observed from
 * the same semantic source in a new browser reset/launch generation.
 *
 * The evidence proves repeatable timing and type. It does not assert that
 * every exception was *caused* by that key, or that absence on a later replay
 * independently proves a functional fix.
 */
export const WEB_SAFE_KEYBOARD_PAGE_ERROR_RULE = "web.safe-keyboard-page-error" as const;

const ACTION_KEYS = new Set<RemoteKey>(["TAB", "SHIFT_TAB", "BACK", "SELECT"]);
const PORTABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u;
const MAX_SEQUENCE = 64;

export interface WebRuntimeErrorActionWitness {
  readonly before: StateSnapshot;
  readonly after: StateSnapshot;
  readonly sequence: readonly RemoteKey[];
  /** Obtained by immediately draining consumeActionRuntimeErrors(). */
  readonly runtime: WebActionRuntimeErrorSnapshot;
}

export interface VerifiedWebRuntimeErrorFinding {
  readonly rule: typeof WEB_SAFE_KEYBOARD_PAGE_ERROR_RULE;
  readonly confidence: "deterministic";
  readonly severity: "high";
  readonly action: RemoteKey;
  readonly source: {
    readonly stableId: string;
    readonly role: string;
    readonly name: string;
  };
  readonly errorClass: string;
  readonly originalSequence: readonly RemoteKey[];
  readonly evidence: "pageerror-after-input-reobserved-on-distinct-restoration";
}

function completeTree(snapshot: StateSnapshot): readonly UiNodeSnapshot[] | null {
  const metadata = (snapshot as StateSnapshot & {
    readonly uiTreeMetadata?: {
      readonly status?: unknown;
      readonly value?: { readonly truncated?: unknown };
    };
  }).uiTreeMetadata;
  if (snapshot.uiTree.status !== "available" || metadata?.status !== "available"
    || metadata.value?.truncated !== false) return null;
  const result: UiNodeSnapshot[] = [];
  const pending = [...snapshot.uiTree.value];
  while (pending.length > 0 && result.length <= 4_096) {
    const node = pending.pop();
    if (node === undefined) continue;
    result.push(node);
    pending.push(...node.children);
  }
  return pending.length > 0 || result.length > 4_096 ? null : result;
}

function sourceFor(snapshot: StateSnapshot): VerifiedWebRuntimeErrorFinding["source"] | null {
  const nodes = completeTree(snapshot);
  const focused = snapshot.focusedElement.status === "available" ? snapshot.focusedElement.value : null;
  if (nodes === null || focused === null || !PORTABLE_ID.test(focused.stableId ?? "")) return null;
  const matching = nodes.filter((node) => node.stableId === focused.stableId);
  const current = matching[0];
  if (matching.length !== 1 || current === undefined || current.focused !== true
    || current.enabled !== true || current.visible !== true || current.focusable !== true
    || nodes.filter((node) => node.focused === true).length !== 1
    || current.role === null || current.name === null || current.name.trim().length === 0
    || current.role.length > 80 || current.name.length > 160
    || focused.role !== current.role || focused.name !== current.name) return null;
  return { stableId: current.stableId ?? "", role: current.role, name: current.name };
}

function eventFor(witness: WebRuntimeErrorActionWitness): WebActionRuntimeErrorEvidence | null {
  if (witness.sequence.length === 0 || witness.sequence.length > MAX_SEQUENCE
    || witness.runtime.droppedRecords !== 0 || witness.runtime.events.length !== 1
    || witness.before.location.status !== "available"
    || witness.after.location.status !== "available"
    || witness.before.location.value !== witness.after.location.value
    || completeTree(witness.after) === null) return null;
  const event = witness.runtime.events[0];
  const last = witness.sequence.at(-1);
  if (event === undefined || last === undefined || !ACTION_KEYS.has(last)
    || event.key !== last || event.outcome !== "applied"
    || event.correlation !== "press-window" || event.pageErrorCount !== 1
    || event.errorNames.length !== 1 || event.truncated
    || !Number.isSafeInteger(event.token) || event.token < 1
    || !Number.isSafeInteger(event.generation) || event.generation < 1) return null;
  return event;
}

/** Return null if the original and independent replay lack exact corroboration. */
export function confirmWebSafeKeyboardPageError(
  original: WebRuntimeErrorActionWitness,
  repeated: WebRuntimeErrorActionWitness,
): VerifiedWebRuntimeErrorFinding | null {
  const source = sourceFor(original.before);
  const secondSource = sourceFor(repeated.before);
  const firstEvent = eventFor(original);
  const secondEvent = eventFor(repeated);
  if (source === null || secondSource === null || firstEvent === null || secondEvent === null
    || firstEvent.generation === secondEvent.generation
    || firstEvent.token === secondEvent.token
    || firstEvent.key !== secondEvent.key
    || firstEvent.errorNames[0] !== secondEvent.errorNames[0]
    || source.stableId !== secondSource.stableId || source.role !== secondSource.role
    || source.name !== secondSource.name
    || original.before.location.status !== "available" || repeated.before.location.status !== "available"
    || original.before.location.value !== repeated.before.location.value
    || original.sequence.length !== repeated.sequence.length
    || original.sequence.some((key, index) => key !== repeated.sequence[index])) return null;
  return {
    rule: WEB_SAFE_KEYBOARD_PAGE_ERROR_RULE,
    confidence: "deterministic",
    severity: "high",
    action: firstEvent.key,
    source,
    errorClass: firstEvent.errorNames[0] ?? "Error",
    originalSequence: [...original.sequence],
    evidence: "pageerror-after-input-reobserved-on-distinct-restoration",
  };
}
