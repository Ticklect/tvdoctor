import { createHash } from "node:crypto";
import { readFile, lstat, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { renderPlaywrightTest } from "./playwright-test-export.js";
import { renderSpaJourneyGraph } from "./spa-graph.js";
import type { SpaJourneyResult } from "./spa-journey.js";

export type TriageSeverity = "critical" | "high" | "medium" | "low" | "info" | "unrated";
export type TriageConfidence = "deterministic" | "heuristic" | "inference" | "unobservable" | "unspecified";

export interface TriageFinding {
  readonly id: string;
  readonly title: string;
  readonly rule: string;
  readonly severity: TriageSeverity;
  readonly confidence: TriageConfidence;
  readonly source: string;
  /** Source-independent, static investigation guidance; never application copy. */
  readonly guidance?: {
    readonly impact: string;
    readonly investigate: string;
    readonly verification: string;
  };
  /** Local report URL, optionally with a fragment generated from a validated issue ID. */
  readonly reportUrl?: string;
  readonly imageUrl?: string;
  readonly videoUrl?: string;
  readonly testExportUrl?: string;
  /** A recorded replay is not evidence of successful fresh reproduction. */
  readonly recordedReplayActions?: number;
  readonly freshContextVerification?: {
    readonly status: "reobserved" | "not-reobserved" | "deferred";
    readonly reason: string;
    readonly replayStepsVerified: number;
    readonly actions: number;
    readonly durationMs: number;
  };
  /** Counts are derived from validated, observed SPA edges and checkpoint paths only. */
  readonly spaReview?: {
    readonly stateNumber: number;
    readonly edgeNumber: number;
    readonly stateDepth: number;
    readonly stateReplaySteps: number;
    readonly edgeReplaySteps: number;
    readonly verifiedCheckpoints: number;
    readonly reviewRequired: true;
  };
  /** Browser Back is a separate observation, NEVER a completed forward replay. */
  readonly spaBackReview?: {
    readonly expectedStateNumber: number;
    readonly intermediateStateNumber?: number;
    readonly forwardStateNumber: number;
    readonly forwardEdgeNumber: number;
    readonly recordedForwardSetupSteps: number;
    readonly observedBackTransitions: 1 | 2;
    readonly settledSamples: number;
    readonly reviewRequired: true;
  };
}

export interface TriageGroup {
  readonly severity: TriageSeverity;
  readonly confidence: TriageConfidence;
  readonly count: number;
}

export interface TriageSummary {
  readonly status: "completed" | "partial" | "failed" | "cancelled";
  readonly findings: readonly TriageFinding[];
  readonly total: number;
  readonly groups: readonly TriageGroup[];
  readonly omitted: number;
  readonly coverage: readonly string[];
  /** A bounded reason list, using trusted reason tokens rather than page-derived free text. */
  readonly limits: readonly string[];
  /** Explicitly whitelisted optional local evidence for experimental SPA exploration. */
  readonly extraLinks?: readonly { readonly label: string; readonly url: string }[];
}

const FILE_LIMIT = 6 * 1024 * 1024;
const SPA_BACK_IMAGE_LIMIT = 8 * 1024 * 1024;
const FINDINGS_LIMIT = 80;
const SEVERITIES: readonly TriageSeverity[] = ["critical", "high", "medium", "low", "info", "unrated"];
const CONFIDENCES: readonly TriageConfidence[] = ["deterministic", "heuristic", "inference", "unobservable", "unspecified"];
const RULE_GUIDANCE: Readonly<Record<string, NonNullable<TriageFinding["guidance"]>>> = {
  "web.safe-link-document-failure": {
    impact: "An opted-in keyboard navigation reached an HTTP error page. Users following the link may not reach the intended content.",
    investigate: "Confirm this is an intended destination on a disposable test instance. Check the source anchor, application route, hosting response, access restrictions and any redirected login or soft-404 content.",
    verification: "REVIEW only. Recheck the intended page and content manually. A changed HTTP status or missing finding cannot certify FIXED.",
  },
  "web.safe-keyboard-page-error": {
    impact: "The browser observed a page exception during a bounded keyboard action. The affected workflow might not complete.",
    investigate: "Inspect the original local action context and actual application code; reproduce in the same authorised state before attributing the exception to the input.",
    verification: "REVIEW only. Absence of a later exception is not independent proof of a corrected workflow.",
  },
  "keyboard.modal-focus-escape": {
    impact: "Keyboard focus escaped a visible modal. Users may reach controls behind an unfinished dialog.",
    investigate: "Inspect dialog focus trapping, initial focus, TAB ordering and restoration after closing. Preserve the original route and semantic control identity.",
    verification: "Use the original source-bound verify-fix command only if its exact replay and positive modal-focus oracle are supported, followed by a separate fresh regression scan.",
  },
  "keyboard.modal-tab-wrap-failure": {
    impact: "Keyboard focus may fail to wrap within a modal at its edge, potentially preventing predictable dialog navigation.",
    investigate: "Reproduce the original keyboard edge transition and check the modal's focusable-element order and dialog lifecycle.",
    verification: "An independent FIXED result requires the exact supported original modal oracle and restored semantic context; otherwise keep the outcome INCONCLUSIVE.",
  },
};
const IMAGE_PATH = /^evidence\/[A-Za-z0-9][A-Za-z0-9._:-]{0,150}\/(?:before|after)-screenshot\.(?:png|jpg|jpeg)$/u;
const VIDEO_PATH = /^evidence\/[A-Za-z0-9][A-Za-z0-9._:-]{0,150}\/issue-video\.webm$/u;
const RESPONSIVE_IMAGE = /^responsive\/(?:mobile|tablet|desktop)\/page-[0-9]{2}\.png$/u;

/** An issue's scrolled evidence belongs only to its own baseline route slot. */
function responsiveImageBelongsToPage(page: Record<string, unknown>, image: unknown): boolean {
  if (image === null) return true;
  if (typeof image !== "string" || !RESPONSIVE_IMAGE.test(image)
    || page["screenshotStatus"] !== "available") return false;
  const original = page["screenshot"];
  if (typeof original !== "string") return false;
  const slot = /^responsive\/(mobile|tablet|desktop)\/page-(0[1-9]|1[0-2])\.png$/u.exec(original);
  if (slot === null || slot[1] !== page["viewport"]) return false;
  const scrolled = `responsive/${slot[1]}/page-${String(Number(slot[2]) + 50).padStart(2, "0")}.png`;
  return image === original || image === scrolled;
}
const RESPONSIVE_RULES = new Map([
  ["responsive.document-overflow", "Horizontal overflow"],
  ["responsive.offscreen-control", "Control outside viewport"],
  ["responsive.clipped-control", "Clipped control"],
  ["responsive.control-overlap", "Overlapping controls"],
  ["responsive.obscured-control", "Obscured control"],
]);
const PAGE_JSON = /^pages\/[0-9]{3}\/report\.json$/u;
const ALLOWED_REASON = /^[a-z][a-z0-9-]{0,63}$/u;
const SPA_ID = /^[a-f0-9]{20}$/u;
// Keep local dashboard review aligned with the scanner and MCP report schema.
// An observed semantic disclosure remains review-only, never auto-verified.
const SPA_STEP_KINDS = new Set(["anchor", "menu-toggle", "dialog-toggle", "disclosure-toggle"]);
const SPA_RUNTIME_RULE_KINDS: Record<string, string> = {
  "spa.runtime-page-error": "page-error", "spa.runtime-console-error": "console-error",
  "spa.http-response-error": "http-response", "spa.network-request-failed": "request-failed",
};
const SPA_RUNTIME_RESOURCES = new Set(["stylesheet", "script", "image", "font", "media", "other"]);
const SPA_EDGE_STATUSES = new Set(["observed", "deferred", "blocked", "drift"]);
const SPA_STATES_LIMIT = 40;
const SPA_EDGES_LIMIT = 240;
const SPA_LEADS_LIMIT = 240;
const SPA_BACK_PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function obj(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : null;
}
function num(input: unknown): number | null {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= 1_000_000
    ? input : null;
}
function within(root: string, file: string): boolean {
  const remainder = relative(root, file);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`)
    && !remainder.startsWith("/") && !remainder.startsWith("\\")
    && !/^[a-z]:/iu.test(remainder));
}
function reasonTokens(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((token): token is string => (
    typeof token === "string" && ALLOWED_REASON.test(token)
  )))].slice(0, 16);
}
async function safeFile(root: string, path: string, maximum = FILE_LIMIT): Promise<string | null> {
  const location = resolve(root, path);
  if (!within(root, location)) return null;
  try {
    const actual = await realpath(location);
    if (!within(root, actual)) return null;
    // A symlink inside the report root is still not an owned output.
    const segments = relative(root, location).split(sep);
    let part = root;
    for (const segment of segments) {
      part = join(part, segment);
      if ((await lstat(part)).isSymbolicLink()) return null;
    }
    const details = await stat(actual);
    return details.isFile() && details.size <= maximum ? actual : null;
  } catch {
    return null;
  }
}
async function ownedDescriptor(
  root: string, base: string, id: string, value: unknown,
  slot: "before-screenshot" | "after-screenshot" | "issue-video",
): Promise<string | null> {
  const artifact = obj(value);
  const kind = slot === "issue-video" ? "video" : "screenshot";
  const expectedMedia = slot === "issue-video" ? ["video/webm"] : ["image/png", "image/jpeg"];
  const pattern = slot === "issue-video" ? VIDEO_PATH : IMAGE_PATH;
  const candidate = artifact?.["path"];
  const size = artifact?.["byteLength"];
  const checksum = artifact?.["sha256"];
  if (artifact?.["status"] !== "available" || artifact["kind"] !== kind
    || artifact["id"] !== `${id}:${slot}`
    || !expectedMedia.includes(String(artifact["mediaType"]))
    || typeof candidate !== "string" || !pattern.test(candidate)
    || !candidate.startsWith(`evidence/${id}/${slot}.`)
    || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0
    || size > (slot === "issue-video" ? 64 * 1024 * 1024 : FILE_LIMIT)
    || typeof checksum !== "string" || !/^[a-f0-9]{64}$/u.test(checksum)
    || (slot === "issue-video" && artifact["mediaType"] !== "video/webm")
    || (slot !== "issue-video"
      && (candidate.endsWith(".png") ? artifact["mediaType"] !== "image/png"
        : artifact["mediaType"] !== "image/jpeg"))) return null;
  const absolute = await safeFile(root, join(base, candidate),
    slot === "issue-video" ? 64 * 1024 * 1024 : FILE_LIMIT);
  if (absolute === null || (await stat(absolute)).size !== size) return null;
  const bytes = await readFile(absolute);
  return createHash("sha256").update(bytes).digest("hex") === checksum ? candidate : null;
}
async function load(root: string, path: string): Promise<Record<string, unknown> | null> {
  const actual = await safeFile(root, path);
  if (actual === null) return null;
  try {
    return obj(JSON.parse(await readFile(actual, "utf8")) as unknown);
  } catch {
    return null;
  }
}
function issueId(value: unknown): string | null {
  // TVDoctor's produced IDs are opaque, prefixed identities. Page text is not.
  return typeof value === "string" && /^TVDOCTOR-[A-Za-z0-9-]{1,150}$/u.test(value) ? value : null;
}

/** Only local, verified screenshot images are accepted; other report artifacts stay in full reports. */
async function issueImage(
  root: string, base: string, id: string, artifacts: readonly unknown[], jobId: string,
): Promise<string | undefined> {
  for (const slot of ["before-screenshot", "after-screenshot"] as const) {
    for (const entry of artifacts) {
      const path = await ownedDescriptor(root, base, id, entry, slot);
      if (path !== null) return `/reports/${jobId}/${base}${path}`;
    }
  }
  return undefined;
}

async function issueVideo(
  root: string, base: string, id: string, artifacts: readonly unknown[], jobId: string,
): Promise<string | undefined> {
  for (const entry of artifacts) {
    const path = await ownedDescriptor(root, base, id, entry, "issue-video");
    if (path !== null) return `/reports/${jobId}/${base}${path}`;
  }
  return undefined;
}

async function issueTestExport(
  root: string, base: string, id: string, reportContent: string, jobId: string,
): Promise<string | undefined> {
  // There is no canonical export manifest yet. Only accept the exact output
  // of TVDoctor's deterministic, completed-report exporter.
  if (!/^TVDOCTOR-[A-Za-z0-9-]{1,180}$/u.test(id)) return undefined;
  const path = `exports/${id}.spec.js`;
  const file = await safeFile(root, join(base, path));
  if (file === null) return undefined;
  try {
    const expected = renderPlaywrightTest(parseTVDoctorReportJson(reportContent), id);
    if (expected.length > 180_000 || (await stat(file)).size !== Buffer.byteLength(expected, "utf8")) return undefined;
    const current = await readFile(file, "utf8");
    return current === expected ? `/reports/${jobId}/${base}${path}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A screenshot from a browser Back observation is not a forward replay or a
 * generic navigation issue attachment. Link only bytes matching the observed
 * Back edge's canonical path and the scanner's optional SHA-256 descriptor.
 */
async function observedBackImage(
  root: string, jobId: string, edgeIndex: number, descriptor: unknown, interrupted: boolean,
): Promise<string | undefined> {
  const entry = obj(descriptor);
  const name = `evidence/${interrupted ? "back-interrupted-edge" : "back-edge"}-${String(edgeIndex + 1).padStart(3, "0")}.png`;
  const size = entry?.["byteLength"];
  const checksum = entry?.["sha256"];
  if (entry?.["path"] !== name || typeof size !== "number" || !Number.isSafeInteger(size)
    || size < 33 || size > SPA_BACK_IMAGE_LIMIT
    || typeof checksum !== "string" || !/^[a-f0-9]{64}$/u.test(checksum)) return undefined;
  const absolute = await safeFile(root, `spa/${name}`, SPA_BACK_IMAGE_LIMIT);
  if (absolute === null) return undefined;
  try {
    if ((await stat(absolute)).size !== size) return undefined;
    const bytes = await readFile(absolute);
    // Chromium's PNG output has an 8-byte signature followed by IHDR.
    // Do not serve a claimed image which is actually HTML or other content.
    if (bytes.length !== size || !bytes.subarray(0, 8).equals(SPA_BACK_PNG_HEADER)
      || bytes.toString("ascii", 12, 16) !== "IHDR"
      || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 32_768
      || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 32_768
      || createHash("sha256").update(bytes).digest("hex") !== checksum) return undefined;
    return `/reports/${jobId}/spa/${name}`;
  } catch {
    return undefined;
  }
}

interface Collector {
  readonly all: TriageFinding[];
  readonly coverage: string[];
  readonly limits: string[];
  readonly links: { label: string; url: string }[];
}

/** Do not trust a saved SPA lead unless its index, state and observed replay agree. */
async function collectSpaReview(
  root: string, jobId: string, summary: Record<string, unknown>, collector: Collector,
  expectedTargetIdentity?: string,
): Promise<void> {
  if (summary["reportPath"] !== "spa/spa-journey.json") return;
  const report = await load(root, "spa/spa-journey.json");
  const fail = (): void => { collector.limits.push("spa-review-unavailable"); };
  if (report?.["schemaVersion"] !== "tvdoctor.spa-journey/v1"
    || !["completed", "partial", "cancelled", "failed"].includes(String(report["status"]))
    || report["status"] !== summary["status"]) { fail(); return; }
  const states = report["states"];
  const edges = report["edges"];
  const deferred = report["deferred"];
  const issues = report["issues"];
  if (!Array.isArray(states) || states.length > SPA_STATES_LIMIT
    || !Array.isArray(edges) || edges.length > SPA_EDGES_LIMIT
    || !Array.isArray(deferred) || deferred.length > SPA_EDGES_LIMIT
    || !Array.isArray(issues) || issues.length > SPA_LEADS_LIMIT) { fail(); return; }
  const budgets = obj(report["budgets"]);
  if (typeof report["targetIdentity"] !== "string" || !SPA_ID.test(report["targetIdentity"])
    || (expectedTargetIdentity !== undefined && report["targetIdentity"] !== expectedTargetIdentity)
    || typeof report["candidatesTruncated"] !== "boolean"
    || ["actionsUsed", "replayActions", "driftCount", "unsafeRequestsBlocked", "unsafeCandidatesSkipped"]
      .some((field) => num(report[field]) === null)
    || budgets === null
    || num(budgets["maxStates"]) === null || (budgets["maxStates"] as number) < 1
    || (budgets["maxStates"] as number) > SPA_STATES_LIMIT
    || num(budgets["maxActions"]) === null || (budgets["maxActions"] as number) < 1
    || (budgets["maxActions"] as number) > 240
    || num(budgets["maxDepth"]) === null || (budgets["maxDepth"] as number) < 1
    || (budgets["maxDepth"] as number) > 8
    || num(budgets["maxDurationMs"]) === null || (budgets["maxDurationMs"] as number) < 1
    || (budgets["maxDurationMs"] as number) > 120_000) { fail(); return; }
  const observedEdges = edges.filter((edge) => obj(edge)?.["status"] === "observed").length;
  if (num(summary["statesObserved"]) !== states.length
    || num(summary["transitionsTested"]) !== observedEdges
    || num(summary["deferredStates"]) !== deferred.length
    || num(summary["reviewLeads"]) !== issues.length
    || (summary["routeContentReviewLeads"] !== undefined && num(summary["routeContentReviewLeads"])
      !== issues.filter((issue) => obj(issue)?.["rule"] === "spa.route-content-missing").length)) {
    fail(); return;
  }
  const terminationReasons = report["terminationReasons"];
  if (!Array.isArray(terminationReasons)
    || terminationReasons.length > 24
    || terminationReasons.some((reason) => typeof reason !== "string" || !ALLOWED_REASON.test(reason))
    || (states.length === 0 && report["status"] !== "failed")
    || (report["status"] === "failed" && (states.length !== 0 || issues.length !== 0))
    || (report["status"] === "completed"
      && (terminationReasons.length > 0 || deferred.length > 0))
    || (report["status"] === "partial"
      && terminationReasons.length === 0)) { fail(); return; }

  const stateById = new Map<string, {
    ordinal: number; depth: number; replayLength: number; routeIdentity: string;
    replay: readonly unknown[];
  }>();
  for (const [ordinal, value] of states.entries()) {
    const state = obj(value);
    if (state === null || typeof state["id"] !== "string" || !SPA_ID.test(state["id"])
      || stateById.has(state["id"]) || num(state["depth"]) === null
      || typeof state["routeIdentity"] !== "string" || !SPA_ID.test(state["routeIdentity"])
      || num(state["candidatesObserved"]) === null || (state["candidatesObserved"] as number) > 48
      || !Array.isArray(state["replay"]) || state["replay"].length > 8
      || state["depth"] !== state["replay"].length) { fail(); return; }
    stateById.set(state["id"], {
      ordinal: ordinal + 1,
      depth: state["depth"] as number,
      replayLength: state["replay"].length,
      routeIdentity: state["routeIdentity"] as string,
      replay: state["replay"],
    });
  }
  const validStep = (value: unknown): boolean => {
    const step = obj(value);
    return step !== null && SPA_STEP_KINDS.has(String(step["kind"]))
      && typeof step["targetFingerprint"] === "string" && SPA_ID.test(step["targetFingerprint"])
      && typeof step["checkpoint"] === "string" && stateById.has(step["checkpoint"])
      && num(step["index"]) !== null && (step["index"] as number) < 48;
  };
  for (const value of states) {
    const state = obj(value);
    if (state === null || !Array.isArray(state["replay"])
      || !state["replay"].every(validStep)
      || (state["replay"].length > 0
        && obj(state["replay"][state["replay"].length - 1])?.["checkpoint"] !== state["id"])) {
      fail(); return;
    }
  }
  for (const value of edges) {
    const edge = obj(value);
    if (edge === null || !SPA_EDGE_STATUSES.has(String(edge["status"]))
      || typeof edge["from"] !== "string" || !stateById.has(edge["from"])
      || !SPA_STEP_KINDS.has(String(edge["kind"]))
      || typeof edge["targetFingerprint"] !== "string" || !SPA_ID.test(edge["targetFingerprint"])
      || num(edge["targetIndex"]) === null || (edge["targetIndex"] as number) >= 48
      || (edge["reason"] !== null
        && (typeof edge["reason"] !== "string" || !ALLOWED_REASON.test(edge["reason"])))
      || (edge["status"] === "observed" && edge["reason"] !== null)
      || !Array.isArray(edge["replay"]) || edge["replay"].length > 9
      || !edge["replay"].every(validStep)
      || (edge["status"] === "observed"
        && (typeof edge["to"] !== "string" || !stateById.has(edge["to"])
          || edge["replay"].length === 0
          || obj(edge["replay"][edge["replay"].length - 1])?.["checkpoint"] !== edge["to"]))) {
      fail(); return;
    }
    // A claimed observed edge must begin with the recorded, checked path to
    // its source state. Otherwise a different forward path could be attached
    // to an unrelated Back observation.
    const sourceState = stateById.get(edge["from"] as string);
    if (sourceState === undefined) { fail(); return; }
    if (edge["status"] === "observed") {
      const steps = edge["replay"] as unknown[];
      const matchesPrefix = sourceState.replay.every((step, index) => {
        const expected = obj(step);
        const actual = obj(steps[index]);
        return expected !== null && actual !== null
          && expected["index"] === actual["index"]
          && expected["kind"] === actual["kind"]
          && expected["targetFingerprint"] === actual["targetFingerprint"]
          && expected["checkpoint"] === actual["checkpoint"];
      });
      if (steps.length !== sourceState.replayLength + 1 || !matchesPrefix) { fail(); return; }
    }
  }
  const matchingStep = (left: unknown, right: unknown): boolean => {
    const a = obj(left);
    const b = obj(right);
    return a !== null && b !== null && a["index"] === b["index"]
      && a["kind"] === b["kind"] && a["targetFingerprint"] === b["targetFingerprint"]
      && a["checkpoint"] === b["checkpoint"];
  };
  // Every checkpoint in a saved state replay must be backed by a real,
  // ordered observed edge from the preceding checkpoint. Matching only the
  // final checkpoint permits an unrelated forward route to masquerade as a
  // legitimate Back setup path.
  const rootState = obj(states[0]);
  if (rootState !== null && (rootState["depth"] !== 0
    || !Array.isArray(rootState["replay"]) || rootState["replay"].length !== 0)) { fail(); return; }
  for (const stateValue of states.slice(1)) {
    const state = obj(stateValue);
    if (state === null || !Array.isArray(state["replay"])) { fail(); return; }
    let previous = rootState?.["id"];
    for (let stepIndex = 0; stepIndex < state["replay"].length; stepIndex += 1) {
      const path = state["replay"].slice(0, stepIndex + 1);
      const current = obj(path[stepIndex])?.["checkpoint"];
      if (typeof previous !== "string" || typeof current !== "string"
        || !edges.some((value) => {
          const edge = obj(value);
          return edge?.["status"] === "observed" && edge["from"] === previous
            && edge["to"] === current && Array.isArray(edge["replay"])
            && edge["replay"].length === path.length
            && edge["replay"].every((step, index) => matchingStep(step, path[index]));
        })) { fail(); return; }
      previous = current;
    }
  }
  for (const value of deferred) {
    const entry = obj(value);
    if (entry === null || typeof entry["from"] !== "string" || !stateById.has(entry["from"])
      || (entry["targetFingerprint"] !== null
        && (typeof entry["targetFingerprint"] !== "string" || !SPA_ID.test(entry["targetFingerprint"])))
      || typeof entry["reason"] !== "string" || !ALLOWED_REASON.test(entry["reason"])) {
      fail(); return;
    }
  }

  // Only the graph written for this run has the stable #issues anchor. If missing,
  // do not generate links that misleadingly imply a reproducible, inspected lead.
  if (summary["graphPath"] !== "spa/graph.html") { fail(); return; }
  const graphPath = await safeFile(root, "spa/graph.html");
  if (graphPath === null) { fail(); return; }
  const graph = await readFile(graphPath, "utf8").catch(() => "");
  if (!graph.includes("<title>TVDoctor SPA journey graph</title>")
    || !graph.includes('id="issues"')
    || !graph.includes(`<strong>${String(issues.length)}</strong><span>Heuristic review leads</span>`)
    || (graph.match(/<article class="issue">/gu) ?? []).length !== Math.min(40, issues.length)
    || [...stateById.keys()].some((id) => !graph.includes(`<strong>${id.slice(0, 16)}</strong>`))
    || issues.slice(0, 40).some((value, index) => {
      const item = obj(value);
      const runtimeKind = SPA_RUNTIME_RULE_KINDS[String(item?.["rule"])];
      const title = item?.["rule"] === "spa.history-back-stale-view"
        ? "possible stale view after browser Back"
        : item?.["rule"] === "spa.history-back-interrupted-stale-view"
          ? "possible stale view after two interrupted browser Backs"
        : item?.["rule"] === "spa.route-content-missing"
          ? "possible missing content after client-side route change"
        : item?.["rule"] === "spa.expanded-panel-mismatch"
          ? "possible expanded-panel mismatch"
          : runtimeKind === "http-response" ? "observed HTTP response error during SPA action"
            : runtimeKind === "request-failed" ? "observed network failure during SPA action"
              : runtimeKind !== undefined ? "observed browser runtime error during SPA action" : null;
      return title === null || !graph.includes(`<h3>Review lead ${String(index + 1)}: ${title}</h3>`);
    })
    || (issues.some((value) => obj(value)?.["rule"] === "spa.history-back-stale-view")
      && !graph.includes("Then browser Back was independently observed during this scan"))
    || (issues.some((value) => obj(value)?.["rule"] === "spa.history-back-interrupted-stale-view")
      && !graph.includes("Then two rapid Chromium browser Backs were independently observed during this scan"))) {
    fail(); return;
  }
  const verifiedLeads: TriageFinding[] = [];
  // The generated graph itself publishes at most 40 review entries.
  // Never link a dashboard entry to a graph item the user cannot inspect.
  for (const [ordinal, value] of issues.entries()) {
    const issue = obj(value);
    const runtimeKind = SPA_RUNTIME_RULE_KINDS[String(issue?.["rule"])];
    const edgeIndex = num(issue?.["edgeIndex"]);
    const stateId = issue?.["stateId"];
    const state = typeof stateId === "string" ? stateById.get(stateId) : undefined;
    const edge = edgeIndex === null ? null : obj(edges[edgeIndex]);
    if (issue === null || ((issue["rule"] !== "spa.expanded-panel-mismatch"
      && issue["rule"] !== "spa.history-back-stale-view"
      && issue["rule"] !== "spa.history-back-interrupted-stale-view"
      && issue["rule"] !== "spa.route-content-missing") && runtimeKind === undefined)
      || issue["confidence"] !== "heuristic" || issue["reviewRequired"] !== true
      || state === undefined || edge === null || edgeIndex === null
      || edge["status"] !== "observed" || edge["to"] !== stateId
      || !Array.isArray(edge["replay"])
      || edge["replay"].length === 0 || edge["replay"].length > 9
      || edge["kind"] !== obj(edge["replay"][edge["replay"].length - 1])?.["kind"]
      || edge["targetIndex"] !== obj(edge["replay"][edge["replay"].length - 1])?.["index"]
      || edge["targetFingerprint"] !== obj(edge["replay"][edge["replay"].length - 1])?.["targetFingerprint"]) {
      fail(); return;
    }
    let freshContextVerification: TriageFinding["freshContextVerification"];
    if (issue["verification"] !== undefined) {
      const proof = obj(issue["verification"]);
      const status = proof?.["status"];
      const reason = proof?.["reason"];
      const steps = num(proof?.["replayStepsVerified"]);
      const actions = num(proof?.["actions"]);
      const duration = num(proof?.["durationMs"]);
      if (proof === null || !["reobserved", "not-reobserved", "deferred"].includes(String(status))
        || !["matched-observation", "observation-differed", "source-checkpoint-drift",
          "action-blocked", "post-action-unsettled", "budget-exhausted", "unsupported-rule"].includes(String(reason))
        || steps === null || steps > edge["replay"].length
        || actions === null || actions > 240 || duration === null || duration > 120_000
        || typeof proof["fingerprint"] !== "string" || !SPA_ID.test(proof["fingerprint"])
        || (status === "reobserved" && (reason !== "matched-observation"
          || steps !== edge["replay"].length
          || !["spa.expanded-panel-mismatch", "spa.runtime-page-error",
            "spa.runtime-console-error"].includes(String(issue["rule"]))))
        || (status === "not-reobserved" && reason !== "observation-differed")
        || (status === "deferred" && ["matched-observation", "observation-differed"].includes(String(reason)))) {
        fail(); return;
      }
      const expectedFingerprint = createHash("sha256").update([
        "fresh-verification", String(report["targetIdentity"]), String(issue["rule"]),
        String(edge["from"]), String(edge["to"]), String(edgeIndex), String(status),
        String(reason), String(steps),
      ].join("\u001f")).digest("hex").slice(0, 20);
      if (proof["fingerprint"] !== expectedFingerprint) { fail(); return; }
      freshContextVerification = { status: status as "reobserved" | "not-reobserved" | "deferred",
        reason: String(reason), replayStepsVerified: steps, actions, durationMs: duration };
    }
    const replay = edge["replay"];
    if (issue["rule"] === "spa.route-content-missing") {
      const source = typeof edge["from"] === "string" ? stateById.get(edge["from"]) : undefined;
      if (issue["evidence"] !== "observed-dom-after-action"
        || issue["historyBack"] !== undefined || issue["runtimeEvent"] !== undefined
        || edge["kind"] !== "anchor" || source === undefined
        || source.routeIdentity === state.routeIdentity) { fail(); return; }
      if (ordinal >= 40) continue;
      verifiedLeads.push({
        id: `spa-review-${String(ordinal + 1)}`, rule: "spa.route-content-missing",
        title: `Possible missing main content after client-side navigation · review lead ${String(ordinal + 1)}`,
        severity: "unrated", confidence: "heuristic", source: "Experimental SPA · REVIEW",
        reportUrl: `/reports/${jobId}/spa/graph.html#issues`,
        guidance: {
          impact: "An SPA route changed while its main content remained empty. A user may reach a blank workspace, but a deliberately empty screen can be valid.",
          investigate: "Open the recorded private route checkpoints on an authorised test instance. Inspect client-router matching, component render guards, data fetches, Suspense/loading boundaries, hydration timing and empty-state design. Do not infer cause from HTTP 200.",
          verification: "REVIEW only. Define the intended destination content independently, reproduce the exact client-side journey and assert visible main content in fresh Chromium after hydration, then run separate regression QA. A disappeared finding or HTTP 200 cannot certify FIXED.",
        },
        ...(freshContextVerification === undefined ? {} : { freshContextVerification }),
        spaReview: { stateNumber: state.ordinal, edgeNumber: edgeIndex + 1,
          stateDepth: state.depth, stateReplaySteps: state.replayLength,
          edgeReplaySteps: replay.length, verifiedCheckpoints: replay.length, reviewRequired: true },
      });
      continue;
    }
    if (issue["rule"] === "spa.history-back-stale-view"
      || issue["rule"] === "spa.history-back-interrupted-stale-view") {
      const interrupted = issue["rule"] === "spa.history-back-interrupted-stale-view";
      const back = obj(issue["historyBack"]);
      const expected = typeof back?.["expectedStateId"] === "string"
        ? stateById.get(back["expectedStateId"]) : undefined;
      const middle = typeof edge["from"] === "string" ? stateById.get(edge["from"]) : undefined;
      const interruptedData = obj(back?.["interruptedBack"]);
      const beforeHeading = back?.["beforeHeadingFingerprint"];
      const forwardHeading = back?.["forwardHeadingFingerprint"];
      const returnedHeading = back?.["returnedHeadingFingerprint"];
      const samples = num(back?.["settledSamples"]);
      if (issue["evidence"] !== (interrupted
        ? "observed-dom-after-interrupted-history-back" : "observed-dom-after-history-back") || back === null
        || !SPA_ID.test(String(back["expectedStateId"]))
        || !SPA_ID.test(String(back["observedStateId"]))
        || !SPA_ID.test(String(back["expectedRouteIdentity"]))
        || !SPA_ID.test(String(back["observedRouteIdentity"]))
        || !SPA_ID.test(String(beforeHeading)) || !SPA_ID.test(String(forwardHeading))
        || !SPA_ID.test(String(returnedHeading))
        || expected === undefined || middle === undefined
        || back["observedStateId"] === back["expectedStateId"]
        || back["observedStateId"] === stateId
        || (interrupted && back["observedStateId"] === edge["from"])
        || back["expectedRouteIdentity"] !== expected.routeIdentity
        || back["observedRouteIdentity"] !== expected.routeIdentity
        || expected.routeIdentity === state.routeIdentity
        || beforeHeading === forwardHeading || returnedHeading !== forwardHeading
        || back["historyDelta"] !== (interrupted ? 2 : 1)
        || samples === null || samples < 2 || samples > 8
        || edge["kind"] !== "anchor"
        || replay.length !== expected.replayLength + (interrupted ? 2 : 1)) { fail(); return; }
      if (interrupted) {
        // Both genuine Back transitions must correspond to a *separately*
        // witnessed ancestor -> middle -> final forward history setup.
        // A final-edge replay alone is not enough to attribute two Backs.
        const parentReplay = replay.slice(0, -1);
        const ancestorReplay = replay.slice(0, -2);
        if (interruptedData === null
          || !SPA_ID.test(String(interruptedData["intermediateStateId"]))
          || !SPA_ID.test(String(interruptedData["intermediateRouteIdentity"]))
          || interruptedData["intermediateStateId"] !== edge["from"]
          || interruptedData["finalForwardStateId"] !== stateId
          || interruptedData["intermediateRouteIdentity"] !== middle.routeIdentity
          || expected.routeIdentity === middle.routeIdentity
          || middle.routeIdentity === state.routeIdentity
          || middle.replayLength !== replay.length - 1
          || !middle.replay.every((step, index) => matchingStep(step, parentReplay[index]))
          || !expected.replay.every((step, index) => matchingStep(step, ancestorReplay[index]))
          || !edges.some((value) => {
            const parent = obj(value);
            return parent?.["status"] === "observed" && parent["kind"] === "anchor"
              && parent["from"] === back["expectedStateId"] && parent["to"] === edge["from"]
              && Array.isArray(parent["replay"]) && parent["replay"].length === parentReplay.length
              && parent["replay"].every((step, index) => matchingStep(step, parentReplay[index]));
          })) { fail(); return; }
      } else if (back["expectedStateId"] !== edge["from"]
        || back["interruptedBack"] !== undefined) { fail(); return; }
      if (ordinal >= 40) continue;
      const hasScreenshot = back["screenshot"] !== undefined;
      const imageUrl = hasScreenshot
        ? await observedBackImage(root, jobId, edgeIndex, back["screenshot"], interrupted) : undefined;
      if (hasScreenshot && imageUrl === undefined) collector.limits.push("spa-back-image-unavailable");
      verifiedLeads.push({
        id: `spa-review-${String(ordinal + 1)}`,
        rule: interrupted ? "spa.history-back-interrupted-stale-view" : "spa.history-back-stale-view",
        title: `Possible stale heading after ${interrupted ? "two rapid browser Backs" : "browser Back"} · review lead ${String(ordinal + 1)}`,
        severity: "unrated",
        confidence: "heuristic",
        source: "Experimental SPA · REVIEW",
        reportUrl: `/reports/${jobId}/spa/graph.html#issues`,
        ...(imageUrl === undefined ? {} : { imageUrl }),
        spaBackReview: {
          expectedStateNumber: expected.ordinal,
          ...(interrupted ? { intermediateStateNumber: middle.ordinal } : {}),
          forwardStateNumber: state.ordinal,
          forwardEdgeNumber: edgeIndex + 1,
          recordedForwardSetupSteps: replay.length,
          observedBackTransitions: interrupted ? 2 : 1,
          settledSamples: samples,
          reviewRequired: true,
        },
      });
      continue;
    }
    if (runtimeKind !== undefined) {
      const runtime = obj(issue["runtimeEvent"]);
      const resource = runtime?.["resourceType"];
      const status = runtime?.["httpStatus"];
      const isNetwork = runtimeKind === "http-response" || runtimeKind === "request-failed";
      const statusValid = status === 404 || status === 410
        || (num(status) !== null && (status as number) >= 500 && (status as number) <= 599);
      if (runtime === null || issue["evidence"] !== "observed-runtime-event-after-action"
        || issue["historyBack"] !== undefined || runtime["kind"] !== runtimeKind
        || runtime["sourceStateId"] !== edge["from"] || runtime["observedStateId"] !== edge["to"]
        || !SPA_ID.test(String(runtime["eventFingerprint"]))
        || (isNetwork && !SPA_RUNTIME_RESOURCES.has(String(resource)))
        || (!isNetwork && resource !== undefined)
        || (runtimeKind === "http-response" && !statusValid)
        || (runtimeKind !== "http-response" && status !== undefined)) { fail(); return; }
      const expected = createHash("sha256").update([
        "runtime-event", String(issue["rule"]), String(edge["from"]), String(edge["to"]),
        String(edgeIndex), runtimeKind, status === undefined ? "" : String(status),
        resource === undefined ? "" : String(resource),
      ].join("\u001f")).digest("hex").slice(0, 20);
      if (runtime["eventFingerprint"] !== expected) { fail(); return; }
      if (ordinal >= 40) continue;
      verifiedLeads.push({
        id: `spa-review-${String(ordinal + 1)}`,
        rule: String(issue["rule"]),
        title: `${runtimeKind === "http-response" ? "Observed HTTP response error"
          : runtimeKind === "request-failed" ? "Observed network failure"
            : "Observed browser runtime error"} · review lead ${String(ordinal + 1)}`,
        severity: "unrated", confidence: "heuristic", source: "Experimental SPA · REVIEW",
        reportUrl: `/reports/${jobId}/spa/graph.html#issues`,
        ...(freshContextVerification === undefined ? {} : { freshContextVerification }),
        spaReview: { stateNumber: state.ordinal, edgeNumber: edgeIndex + 1,
          stateDepth: state.depth, stateReplaySteps: state.replayLength,
          edgeReplaySteps: replay.length, verifiedCheckpoints: replay.length, reviewRequired: true },
      });
      continue;
    }
    if (issue["evidence"] !== "observed-dom-after-action"
      || issue["historyBack"] !== undefined || issue["runtimeEvent"] !== undefined
      || !["menu-toggle", "dialog-toggle", "disclosure-toggle"].includes(String(edge["kind"]))) {
      // A genuine anchor can never witness aria-expanded/panel visibility.
      // Reject saved reports that rebind a review lead to another edge kind.
      fail(); return;
    }
    if (ordinal >= 40) continue;
    verifiedLeads.push({
      id: `spa-review-${String(ordinal + 1)}`,
      rule: "spa.expanded-panel-mismatch",
      title: `Possible expanded-panel mismatch · review lead ${String(ordinal + 1)}`,
      severity: "unrated",
      confidence: "heuristic",
      source: "Experimental SPA · REVIEW",
      reportUrl: `/reports/${jobId}/spa/graph.html#issues`,
      ...(freshContextVerification === undefined ? {} : { freshContextVerification }),
      spaReview: {
        stateNumber: state.ordinal,
        edgeNumber: edgeIndex + 1,
        stateDepth: state.depth,
        stateReplaySteps: state.replayLength,
        edgeReplaySteps: replay.length,
        verifiedCheckpoints: replay.length,
        reviewRequired: true,
      },
    });
  }
  // A count/title-only graph check can accept an old graph with the same
  // issue count but different Back witnesses or state-to-edge associations.
  // Compare the owned graph byte-for-byte with the deterministic renderer of
  // this validated saved report before issuing ANY issue-level graph link.
  try {
    if (graph !== renderSpaJourneyGraph(report as unknown as SpaJourneyResult)) { fail(); return; }
  } catch {
    fail(); return;
  }
  const backChecksDeferred = deferred.filter((value) =>
    obj(value)?.["reason"] === "history-back-limit").length;
  if (backChecksDeferred > 0) {
    collector.coverage.unshift(`Browser Back checks deferred by probe limit: ${String(backChecksDeferred)}`);
    collector.limits.push("spa-back-limit");
  }
  const interruptedChecksDeferred = deferred.filter((value) =>
    obj(value)?.["reason"] === "history-back-interruption-unchecked").length;
  if (interruptedChecksDeferred > 0) {
    collector.coverage.unshift(`Rapid two-Back checks deferred or incomplete: ${String(interruptedChecksDeferred)}`);
    collector.limits.push("spa-back-interruption-unchecked");
  }
  collector.all.push(...verifiedLeads);
  collector.coverage.push(`Experimental SPA validated review leads: ${String(verifiedLeads.length)} (heuristic only)`);
  if (issues.length > verifiedLeads.length) collector.limits.push("spa-review-list-truncated");
  collector.links.push({
    label: "Experimental SPA state graph",
    url: `/reports/${jobId}/spa/graph.html#issues`,
  });
  collector.links.push({
    label: "SPA journey details (may contain private page data)",
    url: `/reports/${jobId}/spa/spa-journey.json`,
  });
}

async function collectNavigation(
  root: string, jobId: string, file: string, source: string, collector: Collector,
  expectedStatus?: string,
): Promise<void> {
  const report = await load(root, file);
  if (report?.["schemaVersion"] !== "tvdoctor.report/v1"
    && report?.["schemaVersion"] !== "tvdoctor.report/v0") {
    collector.limits.push("navigation-report-unavailable");
    return;
  }
  const run = obj(report["run"]);
  const status = run?.["status"];
  if (!["completed", "partial", "failed"].includes(String(status))
    || (expectedStatus !== undefined && status !== expectedStatus)) {
    collector.limits.push("navigation-report-stale");
    return;
  }
  if (status === "partial" || status === "failed") collector.limits.push(`navigation-${status}`);
  const coverage = obj(report["coverage"]);
  const budgets = obj(coverage?.["budget"]);
  collector.limits.push(...reasonTokens(budgets?.["exhausted"]).map((reason) => `budget-${reason}`));
  const packs = coverage?.["packs"];
  if (Array.isArray(packs)) {
    for (const item of packs.slice(0, 24)) {
      const pack = obj(item);
      if (pack?.["status"] === "partial" || pack?.["status"] === "skipped") {
        collector.limits.push(`pack-${String(pack["status"])}`);
      }
    }
  }
  if (source === "Navigation") {
    for (const [field, label] of [
      ["actionsSent", "Actions"], ["focusStatesDiscovered", "Focus states"],
      ["transitionsTested", "Transitions"],
    ] as const) {
      const count = num(coverage?.[field]);
      if (count !== null) collector.coverage.push(`${label}: ${String(count)} observed`);
    }
  }
  const issues = report["issues"];
  if (!Array.isArray(issues)) {
    collector.limits.push("navigation-issues-unavailable");
    return;
  }
  const artifacts = Array.isArray(report["artifacts"]) ? report["artifacts"] : [];
  const base = file.slice(0, -"report.json".length);
  const reportHtml = await safeFile(root, `${base}report.html`);
  const replays = Array.isArray(report["replays"]) ? report["replays"] : [];
  for (const [ordinal, candidate] of issues.slice(0, 2_000).entries()) {
    const issue = obj(candidate);
    if (issue === null) continue;
    const id = issueId(issue["id"]);
    if (id === null) continue;
    const severity: TriageSeverity = SEVERITIES.includes(issue["severity"] as TriageSeverity)
      ? issue["severity"] as TriageSeverity : "unrated";
    const confidence: TriageConfidence = CONFIDENCES.includes(issue["confidence"] as TriageConfidence)
      ? issue["confidence"] as TriageConfidence : "unspecified";
    const rule = typeof issue["rule"] === "string" && /^[a-z][a-z0-9.-]{0,95}$/u.test(issue["rule"])
      ? issue["rule"] : "navigation.finding";
    // A report title/description may include private application copy, DOM labels or URLs.
    const title = `${rule} · finding ${String(ordinal + 1)}`;
    const path = `/reports/${jobId}/${base}report.html`;
    const imageUrl = collector.all.length < FINDINGS_LIMIT
      ? await issueImage(root, base, id, artifacts, jobId) : undefined;
    const videoUrl = collector.all.length < FINDINGS_LIMIT
      ? await issueVideo(root, base, id, artifacts, jobId) : undefined;
    const testExportUrl = collector.all.length < FINDINGS_LIMIT && report["schemaVersion"] === "tvdoctor.report/v1"
      ? await issueTestExport(root, base, id, JSON.stringify(report), jobId) : undefined;
    const matches = replays.filter((entry) => obj(entry)?.["issueId"] === id);
    const replay = matches.length === 1 ? obj(matches[0]) : null;
    const steps = replay?.["steps"];
    const recordedActions = Array.isArray(steps) && steps.length > 0 && steps.length <= 250
      && steps.every((step) => {
        const part = obj(step);
        return typeof part?.["key"] === "string" && /^[A-Z_]{2,25}$/u.test(part["key"])
          && num(part["repeat"]) !== null && (part["repeat"] as number) > 0
          && (part["repeat"] as number) <= 250;
      })
      ? steps.reduce<number>((total, step) => total + (obj(step)?.["repeat"] as number), 0)
      : null;
    collector.all.push({
      id, rule, title, severity, confidence, source,
      ...(RULE_GUIDANCE[rule] === undefined ? {} : { guidance: RULE_GUIDANCE[rule] }),
      ...(reportHtml === null ? {} : { reportUrl: `${path}#${encodeURIComponent(id)}` }),
      ...(imageUrl === undefined ? {} : { imageUrl }),
      ...(videoUrl === undefined ? {} : { videoUrl }),
      ...(testExportUrl === undefined ? {} : { testExportUrl }),
      ...(recordedActions === null || recordedActions > 250 ? {} : { recordedReplayActions: recordedActions }),
    });
  }
  if (issues.length > 2_000) collector.limits.push("finding-extraction-limit");
}

async function collectSite(
  root: string, jobId: string, collector: Collector, expectedStatus: TriageSummary["status"],
  expectedSpaTargetIdentity?: string,
): Promise<void> {
  const index = await load(root, "site-index.json");
  if (index?.["schemaVersion"] !== "tvdoctor.site-index/v1") {
    collector.limits.push("site-index-unavailable");
    return;
  }
  const savedStatus = index["status"];
  if ((expectedStatus === "completed" && savedStatus !== "complete")
    || (expectedStatus !== "completed" && expectedStatus !== savedStatus)) {
    collector.limits.push("site-index-stale");
    return;
  }
  const scanned = num(index["pagesScanned"]);
  const discovered = num(index["pagesDiscovered"]);
  const maximum = num(index["maxPages"]);
  if (scanned !== null) collector.coverage.push(`Routes scanned: ${String(scanned)}${maximum === null ? "" : ` / ${String(maximum)} cap`}`);
  if (discovered !== null) collector.coverage.push(`Routes discovered: ${String(discovered)}`);
  const pending = Array.isArray(index["pendingRoutes"]) ? index["pendingRoutes"].length : null;
  if (pending !== null) {
    collector.coverage.push(`Routes deferred: ${String(pending)}`);
    if (pending > 0) collector.limits.push("routes-deferred");
  }
  collector.limits.push(...reasonTokens(index["termination"]));
  if (index["status"] === "failed") collector.limits.push("site-failed");
  else if (index["status"] === "partial") collector.limits.push("site-incomplete");
  else if (index["status"] !== "complete") collector.limits.push("site-index-stale");
  const routes = index["routes"];
  if (Array.isArray(routes)) {
    const failed = routes.filter((route) => obj(route)?.["status"] === "failed").length;
    const skipped = routes.filter((route) => obj(route)?.["status"] === "skipped").length;
    if (failed > 0) collector.coverage.push(`Route audits failed: ${String(failed)}`);
    if (skipped > 0) collector.coverage.push(`Route audits skipped: ${String(skipped)}`);
    for (const [i, value] of routes.slice(0, 20).entries()) {
      const route = obj(value);
      const file = route?.["reportPath"];
      if (typeof file === "string" && PAGE_JSON.test(file)) {
        await collectNavigation(root, jobId, file, `Route ${String(i + 1).padStart(2, "0")}`,
          collector, String(route?.["status"]));
      } else if (route?.["status"] === "skipped" || route?.["status"] === "failed") {
        collector.limits.push("route-unscanned");
      }
    }
    if (routes.length > 20) collector.limits.push("route-index-limit");
  }
  const spa = obj(index["spaJourney"]);
  if (spa !== null) {
    const states = num(spa["statesObserved"]);
    const deferred = num(spa["deferredStates"]);
    if (states !== null) collector.coverage.push(`Experimental SPA states observed: ${String(states)}`);
    if (deferred !== null) collector.coverage.push(`Experimental SPA states deferred: ${String(deferred)}`);
    const transitions = num(spa["transitionsTested"]);
    if (transitions !== null) collector.coverage.push(`Experimental SPA transitions: ${String(transitions)}`);
    const leads = num(spa["reviewLeads"]);
    if (leads !== null) collector.coverage.push(`Experimental SPA review leads: ${String(leads)}`);
    const missingContent = num(spa["routeContentReviewLeads"]);
    if (missingContent !== null) collector.coverage.push(`Possible blank client-side routes (REVIEW only): ${String(missingContent)}`);
    if (spa["status"] !== "completed") collector.limits.push("spa-incomplete");
    if (deferred !== null && deferred > 0) collector.limits.push("spa-states-deferred");
    await collectSpaReview(root, jobId, spa, collector, expectedSpaTargetIdentity);
  }
}

async function collectResponsive(root: string, jobId: string, collector: Collector): Promise<void> {
  const report = await load(root, "responsive-result.json");
  if (report === null || !["completed", "partial", "cancelled"].includes(String(report["status"]))
    || !Array.isArray(report["findings"]) || report["findings"].length > 5_000
    || !Array.isArray(report["pages"]) || report["pages"].length > 36) {
    collector.limits.push("responsive-index-unavailable");
    return;
  }
  const pages = report["pages"];
  const visited = pages.filter((item) => obj(item)?.["status"] === "completed").length;
  const partial = pages.filter((item) => obj(item)?.["status"] === "partial").length;
  const failed = pages.filter((item) => obj(item)?.["status"] === "failed").length;
  collector.coverage.push(`Completed page/viewport checks: ${String(visited)}`);
  if (partial > 0) collector.coverage.push(`Partial page/viewport checks: ${String(partial)}`);
  if (failed > 0) collector.coverage.push(`Failed page/viewport checks: ${String(failed)}`);
  for (const [field, label] of [
    ["pagesDiscovered", "Routes discovered"], ["pagesDeferred", "Routes deferred"],
  ] as const) {
    const count = num(report[field]);
    if (count !== null) collector.coverage.push(`${label}: ${String(count)}`);
    if (field === "pagesDeferred" && count !== null && count > 0) collector.limits.push("routes-deferred");
  }
  collector.limits.push(...reasonTokens(report["terminationReasons"]));
  if (report["status"] === "cancelled") collector.limits.push("responsive-cancelled");
  else if (report["status"] === "partial") collector.limits.push("responsive-incomplete");
  if (failed > 0) collector.limits.push("responsive-pages-failed");
  for (const [index, candidate] of (report["findings"] as unknown[]).slice(0, 2_000).entries()) {
    const finding = obj(candidate);
    if (finding === null) continue;
    const rule = finding["rule"];
    if (typeof rule !== "string" || !RESPONSIVE_RULES.has(rule)
      || finding["confidence"] !== "heuristic" || finding["reviewRequired"] !== true) continue;
    const viewport = ["mobile", "tablet", "desktop"].includes(String(finding["viewport"]))
      ? String(finding["viewport"]) : "unknown viewport";
    const title = `${String(RESPONSIVE_RULES.get(rule))} · ${viewport}`;
    const image = finding["screenshot"];
    const matching = pages.filter((value) => {
      const page = obj(value);
      return page !== null && page["viewport"] === finding["viewport"]
        && page["routeIdentity"] === finding["routeIdentity"]
        && responsiveImageBelongsToPage(page, image)
        && Array.isArray(page["findings"])
        && page["findings"].some((value) => obj(value)?.["id"] === finding["id"]
          && obj(value)?.["screenshot"] === image);
    });
    const imageUrl = typeof image === "string" && RESPONSIVE_IMAGE.test(image)
      && matching.length === 1
      && collector.all.length < FINDINGS_LIMIT && await safeFile(root, image) !== null
      ? `/reports/${jobId}/${image}` : undefined;
    if (matching.length !== 1) {
      collector.limits.push("responsive-finding-evidence-unmatched");
      continue;
    }
    collector.all.push({
      id: `responsive-${String(index + 1)}`, title, rule,
      severity: "unrated", confidence: "heuristic", source: viewport,
      reportUrl: `/reports/${jobId}/report.html`,
      ...(imageUrl === undefined ? {} : { imageUrl }),
    });
  }
  if ((report["findings"] as unknown[]).length > 2_000) collector.limits.push("finding-extraction-limit");
}

/** Reads only bounded local report data, never page URLs, report HTML, or arbitrary attachment paths. */
export async function readLocalTriage(
  directory: string, jobId: string, type: "navigation" | "site" | "responsive" | "qa",
  status: TriageSummary["status"],
  expectedSpaTargetIdentity?: string,
): Promise<TriageSummary> {
  const root = await realpath(directory);
  const collector: Collector = { all: [], coverage: [], limits: [], links: [] };
  if (type === "navigation") await collectNavigation(root, jobId, "report.json", "Navigation", collector, status);
  if (type === "qa") await collectNavigation(root, jobId, "original/report.json", "QA original", collector, status);
  if (type === "site") await collectSite(root, jobId, collector, status, expectedSpaTargetIdentity);
  if (type === "responsive") await collectResponsive(root, jobId, collector);
  const rank = (item: TriageFinding): number => SEVERITIES.indexOf(item.severity) * 10
    + CONFIDENCES.indexOf(item.confidence);
  collector.all.sort((a, b) => rank(a) - rank(b));
  const groups = new Map<string, TriageGroup>();
  for (const entry of collector.all) {
    const key = `${entry.severity}:${entry.confidence}`;
    const group = groups.get(key);
    groups.set(key, { severity: entry.severity, confidence: entry.confidence, count: (group?.count ?? 0) + 1 });
  }
  return {
    status,
    findings: collector.all.slice(0, FINDINGS_LIMIT),
    total: collector.all.length,
    groups: [...groups.values()],
    omitted: Math.max(0, collector.all.length - FINDINGS_LIMIT),
    coverage: collector.coverage.slice(0, 12),
    limits: [...new Set(collector.limits)].slice(0, 18),
    ...(collector.links.length > 0 ? { extraLinks: collector.links.slice(0, 2) } : {}),
  };
}
