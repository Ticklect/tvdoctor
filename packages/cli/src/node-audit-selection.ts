import type { StreamingPackResult, StreamingStageName } from "@tvdoctor/pack-streaming";
import type {
  WebPackResult,
  WebStageName,
  WebStageObservation,
} from "@tvdoctor/pack-web";
import type { RemoteKey, TVDoctorIssue } from "@tvdoctor/protocol";
import type { TestCommandRequest } from "./cli.js";
import {
  WEB_STAGE_BY_PACK,
  type AuditRunProducts,
} from "./node-audit-contracts.js";

export function selectedPacks(request: TestCommandRequest): ReadonlySet<string> {
  return request.packs.includes("all")
    ? new Set(["navigation", "streaming", ...Object.keys(WEB_STAGE_BY_PACK)])
    : new Set(request.packs);
}

export function selectedWebStages(packs: ReadonlySet<string>): readonly WebStageName[] {
  const stages: WebStageName[] = [];
  for (const pack of ["search", "settings", "accessibility", "layout", "performance", "crashes"] as const) {
    if (!packs.has(pack)) continue;
    const stage = WEB_STAGE_BY_PACK[pack];
    if (stage !== undefined) stages.push(stage);
  }
  return stages;
}

export function streamingSettingsSequence(result: StreamingPackResult | null): readonly RemoteKey[] | undefined {
  const settings = result?.stages.find((stage) => stage.stage === "settings");
  return settings !== undefined && settings.sequence.at(-1) === "SELECT"
    ? settings.sequence
    : undefined;
}

function expandSteps(steps: readonly { readonly key: RemoteKey; readonly repeat: number }[]): readonly RemoteKey[] {
  return steps.flatMap((step) => Array.from({ length: step.repeat }, () => step.key));
}

function streamingStageForRule(rule: string): StreamingStageName | null {
  switch (rule) {
    case "streaming.player-control": return "seek-backward";
    case "streaming.captions": return "caption-selection";
    case "remote.reachability": return "caption-text-colour";
    case "accessibility.pointer-only-control": return "player-volume";
    default: return null;
  }
}

function webObservationForIssue(result: WebPackResult | null, issue: TVDoctorIssue): WebStageObservation | null {
  const stage = result?.stages.find((candidate) => candidate.stage === issue.pack
    || (candidate.stage === "crash" && issue.pack === "crash"));
  if (stage === undefined) return null;
  const preferredKind = issue.rule === "search.remote-flow"
    ? "search-submit"
    : issue.rule === "focus.visibility"
      ? "focus-visibility-proof"
      : issue.rule === "layout.viewport-clipping"
        ? "viewport-geometry"
        : issue.rule === "performance.menu-response"
          ? "menu-response"
          : "driver-logs";
  const candidates = stage.observations.filter((entry) => entry.kind === preferredKind);
  if (issue.rule === "focus.visibility") {
    const ratio = /crop difference ratio: ([0-9.]+)/u.exec(issue.observed)?.[1];
    const exact = ratio === undefined ? undefined : candidates.find((entry) => entry.detail.includes(ratio));
    if (exact !== undefined) return exact;
  }
  return candidates.find((entry) => entry.target !== null) ?? candidates[0] ?? stage.observations[0] ?? null;
}

export function sequenceForIssue(products: AuditRunProducts, issue: TVDoctorIssue): readonly RemoteKey[] {
  if (issue.reproduction.status === "available") return expandSteps(issue.reproduction.originalSequence);
  const webObservation = webObservationForIssue(products.web, issue);
  if (webObservation !== null) return webObservation.sequence;
  const streamingStage = streamingStageForRule(issue.rule);
  if (streamingStage !== null) {
    return products.streaming?.stages.find((stage) => stage.stage === streamingStage)?.sequence ?? [];
  }
  const navigation = products.navigationFindings.find((finding) => finding.issue.id === issue.id);
  return navigation?.source.actionSequence ?? [];
}

export function packCoverage(products: AuditRunProducts, packs: ReadonlySet<string>): readonly {
  readonly pack: string;
  readonly status: "completed" | "partial" | "skipped";
}[] {
  const result: { pack: string; status: "completed" | "partial" | "skipped" }[] = [];
  if (packs.has("navigation")) {
    result.push({ pack: "navigation", status: products.navigation?.termination.complete === true ? "completed" : "partial" });
  }
  if (packs.has("streaming")) {
    result.push({ pack: "streaming", status: products.streaming?.status === "complete" ? "completed" : "partial" });
  }
  for (const pack of ["search", "settings", "accessibility", "layout", "performance", "crashes"] as const) {
    if (!packs.has(pack)) continue;
    const expectedStage = WEB_STAGE_BY_PACK[pack];
    const stage = products.web?.stages.find((candidate) => candidate.stage === expectedStage);
    result.push({
      pack,
      status: stage !== undefined && (stage.status === "passed" || stage.status === "failed")
        ? "completed"
        : "partial",
    });
  }
  return result;
}

export function exhaustedBudgets(
  products: AuditRunProducts,
  selectedPacks: ReadonlySet<string>,
): ("actions" | "states" | "depth" | "duration" | "repetitive-items")[] {
  const exhausted = new Set<"actions" | "states" | "depth" | "duration" | "repetitive-items">();
  // A streaming journey may be used internally to establish the player route
  // required by selected web layout/performance stages. Its full-pack budget
  // is not selected coverage and must not make a successfully proven web run
  // contradict itself by reporting an exhausted unrequested pack.
  const reasons = [
    selectedPacks.has("navigation") ? products.navigation?.termination.reason : undefined,
    selectedPacks.has("streaming") ? products.streaming?.termination.reason : undefined,
    products.web?.termination.reason,
  ];
  for (const reason of reasons) {
    if (reason === "max-actions") exhausted.add("actions");
    if (reason === "max-states" || reason === "max-local-states") exhausted.add("states");
    if (reason === "max-depth" || reason === "max-local-depth") exhausted.add("depth");
    if (reason === "max-duration") exhausted.add("duration");
  }
  return [...exhausted];
}

export function partialRunDetails(
  products: AuditRunProducts,
  selectedPacks: ReadonlySet<string>,
  evidenceFailureCount: number,
): readonly string[] {
  const details: string[] = [];
  const startup = products.navigationStartup;
  if (startup !== undefined && startup !== null && startup.status !== "ready") {
    if (startup.status === "setup-blocker") {
      const blocker = startup.blockers[0];
      details.push(`Startup setup blocker: ${blocker?.kind ?? "unknown"}; caller preparation policy was observation-only.`);
    } else {
      details.push(`Startup preparation did not reach a reproducible state (${startup.status}).`);
    }
  }
  if (selectedPacks.has("navigation") && products.navigation?.termination.complete === false) {
    if (products.navigation.termination.reason === "max-duration") {
      details.push(`BOUNDED-INCOMPLETE: navigation reached its ${String(products.navigation.budgets.maxDurationMs / 1_000)}-second safety ceiling with ${String(products.navigation.termination.remainingFrontierEntries ?? 0)} frontier entries and about ${String(products.navigation.termination.remainingCandidateActions ?? 0)} candidate actions remaining.`);
    } else if (products.navigation.termination.reason === "prepared-state-diverged") {
      details.push("Startup preparation state could not be reproduced during replay reconstruction.");
    } else if (products.navigation.termination.reason === "interrupted") {
      details.push("The scan was interrupted; completed navigation coverage was retained.");
    } else {
      details.push(`Partial reason: navigation stopped at ${products.navigation.termination.reason}.`);
    }
  }
  if (selectedPacks.has("streaming") && products.streaming?.status !== "complete") {
    details.push(`Partial reason: streaming stopped at ${products.streaming?.termination.reason ?? "unavailable"}: ${products.streaming?.termination.detail ?? "No streaming result was produced."}`);
  }
  if (products.web?.termination.complete === false) {
    details.push(`Partial reason: web diagnostics stopped at ${products.web.termination.reason}: ${products.web.termination.detail}`);
  }
  for (const stage of products.web?.stages ?? []) {
    if (stage.status === "partial" || stage.status === "unobservable" || stage.status === "skipped") {
      details.push(`Partial pack ${stage.stage === "crash" ? "crashes" : stage.stage}: ${stage.status}: ${stage.detail}`);
    }
  }
  if (evidenceFailureCount > 0) {
    details.push(`Partial reason: fresh evidence was unavailable for ${String(evidenceFailureCount)} issue${evidenceFailureCount === 1 ? "" : "s"}.`);
  }
  return details.slice(0, 12);
}
