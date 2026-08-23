import {
  createCanonicalSemanticIdentity,
  createSemanticIssueId,
} from "@tvdoctor/core";
import type {
  ActionResult,
  LogEntry,
  RemoteKey,
  TVDoctorIssue,
} from "@tvdoctor/protocol";
import { normaliseWebSemanticText } from "./semantics.js";
import type {
  ViewportRectangle,
  WebElementDescriptor,
  WebFocusVisibilityProbeResult,
} from "./types.js";

function unavailableReproduction(reason: string): TVDoctorIssue["reproduction"] {
  return { status: "unavailable", reason };
}

function semanticTarget(element: WebElementDescriptor): {
  readonly stableId: string;
  readonly role: string;
  readonly name: string;
} {
  if (element.stableId === null) {
    throw new TypeError("Deterministic web-pack issues require a stable semantic target ID.");
  }
  return {
    stableId: element.stableId.normalize("NFKC"),
    role: normaliseWebSemanticText(element.role),
    name: normaliseWebSemanticText(element.name),
  };
}

function issueId(rule: string, fields: readonly (readonly [string, string | number])[]): string {
  return createSemanticIssueId("WEB", createCanonicalSemanticIdentity([
    ["rule", rule],
    ...fields,
  ]));
}

function safeScreen(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/\p{Cc}/gu, " ").slice(0, 240);
}

export function searchRemoteFlowIssue(
  element: WebElementDescriptor,
  screen: string | null,
  pointerEffect: string,
): TVDoctorIssue {
  const target = semanticTarget(element);
  return {
    id: issueId("search.remote-flow", [
      ["stableId", target.stableId],
      ["role", target.role],
      ["name", target.name],
      ["failure", "pointer-only-submit"],
    ]),
    rule: "search.remote-flow",
    title: "Search submit is pointer-only",
    description: "The visible search submit control was absent from complete bounded D-pad discovery but activated in an isolated pointer proof.",
    severity: "medium",
    confidence: "deterministic",
    pack: "search",
    screen: safeScreen(screen),
    expected: "The visible Search submit control should be reachable and activatable using only D-pad and Select.",
    observed: `Complete remote expansion never focused the submit control; isolated pointer activation observed: ${pointerEffect.slice(0, 240)}.`,
    transition: null,
    evidence: [
      {
        kind: "deterministic-failure",
        summary: `Complete bounded D-pad expansion did not focus ${target.name || target.stableId}.`,
        source: "ui-tree",
        artifact: null,
      },
      {
        kind: "verified-fact",
        summary: `An isolated pointer proof activated the same stable semantic target: ${pointerEffect.slice(0, 240)}.`,
        source: "isolated-pointer-hook",
        artifact: null,
      },
    ],
    reproduction: unavailableReproduction(
      "Remote keys alone cannot reproduce the isolated pointer half of this proof; the exact search route remains evidence, not a standalone replay claim.",
    ),
  };
}

export function focusVisibilityIssue(
  element: WebElementDescriptor,
  screen: string | null,
  result: Extract<WebFocusVisibilityProbeResult, { readonly status: "available" }>,
  changedProperties: readonly string[],
): TVDoctorIssue {
  const target = semanticTarget(element);
  const ratio = result.screenshotDifferenceRatio;
  return {
    id: issueId("focus.visibility", [
      ["stableId", target.stableId],
      ["role", target.role],
      ["name", target.name],
      ["failure", "weak-focus-delta"],
    ]),
    rule: "focus.visibility",
    title: "Focus indication may be visually weak",
    description: "Isolated web computed-style and crop evidence showed only a very small visible change. This is deliberately a heuristic warning.",
    severity: "medium",
    confidence: "heuristic",
    pack: "accessibility",
    screen: safeScreen(screen),
    expected: "Remote focus should create a clearly distinguishable visual state at TV viewing distance.",
    observed: `Changed style channels: ${changedProperties.join(", ") || "none"}; crop difference ratio: ${ratio === null ? "unavailable" : ratio.toFixed(6)}.`,
    transition: null,
    evidence: [
      {
        kind: "heuristic-warning",
        summary: `Isolated before/focused proof changed ${String(changedProperties.length)} bounded style channels with crop ratio ${ratio === null ? "unavailable" : ratio.toFixed(6)}.`,
        source: "web-focus-visibility-hook",
        artifact: null,
      },
    ],
    reproduction: unavailableReproduction(
      "The visual heuristic requires isolated computed-style and equal-crop proof in addition to remote focus replay.",
    ),
  };
}

function boundsText(element: WebElementDescriptor): string {
  const bounds = element.bounds;
  return bounds === null
    ? "unavailable"
    : `x=${String(bounds.x)}, y=${String(bounds.y)}, width=${String(bounds.width)}, height=${String(bounds.height)}`;
}

function viewportText(viewport: ViewportRectangle): string {
  return `x=${String(viewport.x)}, y=${String(viewport.y)}, width=${String(viewport.width)}, height=${String(viewport.height)}`;
}

export function viewportClippingIssue(
  element: WebElementDescriptor,
  screen: string | null,
  viewport: ViewportRectangle,
  source: string,
): TVDoctorIssue {
  const target = semanticTarget(element);
  return {
    id: issueId("layout.viewport-clipping", [
      ["stableId", target.stableId],
      ["role", target.role],
      ["name", target.name],
      ["failure", "outside-viewport"],
    ]),
    rule: "layout.viewport-clipping",
    title: "Player settings extend outside the viewport",
    description: "A visible semantic node on the opened player-settings surface had finite geometry outside the observed viewport.",
    severity: "medium",
    confidence: "deterministic",
    pack: "layout",
    screen: safeScreen(screen),
    expected: "Visible player-settings menus and controls should remain within the observed TV viewport.",
    observed: `Target bounds ${boundsText(element)}; viewport ${viewportText(viewport)}.`,
    transition: null,
    evidence: [
      {
        kind: "deterministic-failure",
        summary: `Finite UI-tree bounds cross the viewport supplied by ${source.slice(0, 120)}.`,
        source: "ui-tree+viewport-hook",
        artifact: null,
      },
    ],
    reproduction: unavailableReproduction(
      "The reset-relative route was observed, but this stage did not run an independent second geometry replay.",
    ),
  };
}

function responseLatency(result: ActionResult): number | null {
  const end = result.timing.screenSettledAtMs;
  return end === undefined ? null : end - result.timing.inputSentAtMs;
}

export function menuResponseIssue(
  element: WebElementDescriptor,
  screen: string | null,
  action: ActionResult,
  thresholdMs: number,
): TVDoctorIssue {
  const target = semanticTarget(element);
  const latency = responseLatency(action);
  if (latency === null) throw new TypeError("A menu-response issue requires observable ActionResult timing.");
  return {
    id: issueId("performance.menu-response", [
      ["stableId", target.stableId],
      ["role", target.role],
      ["name", target.name],
      ["metric", "screen-settled-latency"],
    ]),
    rule: "performance.menu-response",
    title: "Player settings response exceeds the project threshold",
    description: "The measured Settings Select action exceeded the explicitly configured project menu-response threshold.",
    severity: "medium",
    confidence: "deterministic",
    pack: "performance",
    screen: safeScreen(screen),
    expected: `Player settings should settle within the configured ${String(thresholdMs)} ms threshold.`,
    observed: `ActionResult reported a ${String(latency)} ms response for the Settings Select action.`,
    transition: null,
    evidence: [
      {
        kind: "deterministic-failure",
        summary: `inputSentAtMs=${String(action.timing.inputSentAtMs)}; settledAtMs=${String(action.timing.screenSettledAtMs ?? action.timing.firstResponseAtMs)}; latency=${String(latency)} ms; configured threshold=${String(thresholdMs)} ms.`,
        source: "driver-action-result",
        artifact: null,
      },
    ],
    reproduction: unavailableReproduction(
      "A single latency observation is evidence, but performance replay availability requires repeated isolated measurements.",
    ),
  };
}

export function logSemanticSignature(entry: LogEntry): string {
  return entry.message
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/gu, "[url]")
    .replace(/\b\d{6,}\b/gu, "[number]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}

export function consoleErrorIssue(entry: LogEntry, occurrence: number): TVDoctorIssue {
  const signature = logSemanticSignature(entry);
  return {
    id: issueId("crash.console-error", [
      ["level", entry.level],
      ["signature", signature],
    ]),
    rule: "crash.console-error",
    title: "Application emitted an error log",
    description: "The driver captured a bounded application error entry. Console errors are classified separately from browser crashes and blank screens.",
    severity: "medium",
    confidence: "deterministic",
    pack: "crash",
    screen: null,
    expected: "The tested application should not emit uncaught or console-level errors during the bounded run.",
    observed: `${signature} (${String(occurrence)} occurrence${occurrence === 1 ? "" : "s"} in this bounded run).`,
    transition: null,
    evidence: [
      {
        kind: "deterministic-failure",
        summary: `Driver log ${entry.timestamp.slice(0, 128)} [${entry.level}]: ${signature}`,
        source: "driver-logs",
        artifact: null,
      },
    ],
    reproduction: unavailableReproduction(
      "No remote sequence was proven to cause this log entry; it may have occurred during startup.",
    ),
  };
}

export function exactRemoteObservation(
  sequence: readonly RemoteKey[],
): readonly RemoteKey[] {
  return [...sequence];
}
