import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

import {
  serveLocalUi,
  type LocalUiScanOutcome,
  type LocalUiScanRequest,
  type LocalUiQaRequest,
  type LocalUiQaAcceptRequest,
  type LocalUiServer,
} from "../src/local-ui.js";
import type { QaWorkflowResult } from "../src/qa-workflow.js";
import type { QaAcceptResult } from "../src/qa-accept.js";
import { renderLocalUiPage } from "../src/local-ui-page.js";
import { renderLocalUiOverview } from "../src/local-ui-page.js";
import { readLocalTriage } from "../src/local-ui-triage.js";
import { renderSpaJourneyGraph } from "../src/spa-graph.js";
import { runSpaJourneyScan, type SpaJourneyResult } from "../src/spa-journey.js";
import { renderPlaywrightTest } from "../src/playwright-test-export.js";
import { parseTVDoctorReportJson, type TVDoctorReportV1 } from "@tvdoctor/protocol";

const SCAN_RESULT: LocalUiScanOutcome = {
  exitCode: 1, // An audit with findings is still complete.
  result: {
    status: "completed",
    issueCount: 2,
    highestSeverity: "high",
    reportPath: null,
    details: ["Actions 22/250", "States 5; issues 2"],
  },
};

function exportableNavigationReport(): TVDoctorReportV1 {
  const id = "TVDOCTOR-NAV-MODAL42";
  const steps = [
    { key: "RIGHT" as const, repeat: 2 },
    { key: "SHIFT_TAB" as const, repeat: 1 },
    { key: "TAB" as const, repeat: 1 },
  ];
  const transition = { fromElement: "dialog-confirm", action: "TAB" as const,
    expectedElement: "dialog", observedElement: "page-link" };
  return {
    schemaVersion: "tvdoctor.report/v1",
    run: { id: "run-export", tvdoctorVersion: "0.1.0", mode: "deep",
      status: "completed", startedAt: "2026-10-11T12:00:00.000Z",
      completedAt: "2026-10-11T12:01:00.000Z", durationMs: 60_000 },
    target: { name: "private SECRET_LABEL", platform: "web",
      location: "https://example.test/keyboard/modal",
      environment: { browser: "chromium", inputMode: "keyboard" } },
    coverage: { screenStatesDiscovered: 3, focusStatesDiscovered: 6,
      transitionsTested: 5, actionsSent: 8, capabilitiesObserved: ["ui-tree", "remote-input"],
      packs: [{ pack: "navigation", status: "completed" }],
      budget: { maxActions: 100, maxStates: 100, maxDepth: 10, maxDurationMs: 60_000,
        maxRepetitiveItems: null, exhausted: [] } },
    issues: [{ id, rule: "keyboard.modal-focus-escape",
      title: "Private modal SECRET_LABEL", description: "private", severity: "high",
      confidence: "deterministic", pack: "navigation", screen: "private",
      expected: "Focus stays inside", observed: "Focus outside", transition,
      evidence: [], reproduction: { status: "available", resetStrategy: "reload",
        originalSequence: steps, minimizedSequence: null, confidence: "deterministic",
        artifact: null } }],
    artifacts: [],
    replays: [{ schemaVersion: "tvdoctor.replay/v1", id: `replay-${id}`, issueId: id,
      reset: { strategy: "reload" }, steps, assertion: { type: "transition", ...transition } }],
  };
}

/** Actual saved SPA V1 contract; only opaque IDs and checkpoint counts enter triage. */
function savedSpaFixture(): SpaJourneyResult {
  const root = "a".repeat(20);
  const others = ["b", "c", "d"].map((value) => value.repeat(20));
  const step = (to: string, index: number): SpaJourneyResult["states"][number]["replay"][number] => ({
    index, kind: "menu-toggle", targetFingerprint: "f".repeat(20), checkpoint: to,
  });
  const states: SpaJourneyResult["states"] = [
    { id: root, routeIdentity: "9".repeat(20), depth: 0, replay: [], candidatesObserved: 4 },
    ...others.map((id, index) => ({
      id, routeIdentity: "9".repeat(20), depth: 1, replay: [step(id, index)], candidatesObserved: 4,
    })),
  ];
  const edges: SpaJourneyResult["edges"] = [0, 1, 2, 0, 1, 2].map((index) => ({
    from: root, to: others[index] ?? null, kind: "menu-toggle", targetFingerprint: "f".repeat(20),
    targetIndex: index, status: "observed", reason: null,
    replay: others[index] === undefined ? [] : [step(others[index], index)],
  }));
  return {
    schemaVersion: "tvdoctor.spa-journey/v1", status: "partial", targetIdentity: "9".repeat(20),
    states, edges,
    deferred: [
      { from: root, targetFingerprint: null, reason: "max-states" },
      { from: root, targetFingerprint: null, reason: "max-actions" },
    ],
    issues: [
      { rule: "spa.expanded-panel-mismatch", stateId: others[0] ?? "", edgeIndex: 0,
        confidence: "heuristic", reviewRequired: true, evidence: "observed-dom-after-action" },
      { rule: "spa.expanded-panel-mismatch", stateId: others[1] ?? "", edgeIndex: 1,
        confidence: "heuristic", reviewRequired: true, evidence: "observed-dom-after-action" },
    ],
    terminationReasons: ["max-states", "max-actions"], actionsUsed: 14, replayActions: 6,
    driftCount: 0, unsafeRequestsBlocked: 0, unsafeCandidatesSkipped: 0,
    candidatesTruncated: false,
    budgets: { maxStates: 4, maxActions: 40, maxDepth: 4, maxDurationMs: 15_000 },
  };
}

let outputRoot: string;
let server: LocalUiServer | undefined;

beforeEach(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "tvdoctor-local-ui-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(outputRoot, { recursive: true, force: true });
});

async function createReport(request: LocalUiScanRequest): Promise<LocalUiScanOutcome> {
  await mkdir(join(request.outputPath, "video"), { recursive: true });
  await writeFile(join(request.outputPath, "report.html"), "<h1>Local report</h1>");
  await writeFile(join(request.outputPath, "navigation-graph.html"), "<script>document.title='Graph'</script>");
  await writeFile(join(request.outputPath, "video", "audit-session.webm"), "recording");
  await writeFile(join(request.outputPath, "report.json"), "{}");
  const result = SCAN_RESULT.result;
  if (result === null) throw new Error("Test result missing.");
  return {
    ...SCAN_RESULT,
    result: { ...result, reportPath: join(request.outputPath, "report.json") },
  };
}

async function newServer(
  runScan: (request: LocalUiScanRequest) => Promise<LocalUiScanOutcome> = createReport,
): Promise<{ csrf: string; url: string }> {
  server = await serveLocalUi({ outputRoot, runScan });
  const response = await fetch(server.url);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  const html = await response.text();
  expect(html).toContain('id="scan-form"');
  expect(html).toContain("Agent repair workflow");
  expect(html).toContain("Record session video");
  expect(html).not.toContain("https://private.example/secret");
  const csrf = /name="tvdoctor-csrf" content="([^"]+)"/u.exec(html)?.[1];
  if (csrf === undefined) throw new Error("Missing UI token.");
  return { csrf, url: server.url };
}

async function post(url: string, token: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${url}/api/scans`, {
    method: "POST",
    headers: {
      Origin: url,
      "X-TVDoctor-CSRF": token,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function rawGet(url: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return await new Promise<number>((resolveStatus, rejectStatus) => {
    const request = httpRequest(url, { method: "GET", path, headers }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.on("error", rejectStatus);
    request.end();
  });
}

async function waitForState(url: string, state: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${url}/api/status`);
    const job = await response.json() as Record<string, unknown>;
    if (job["state"] === state) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Scan never reached ${state}.`);
}

async function writeQaFixture(request: LocalUiQaRequest,
  status: QaWorkflowResult["status"] = "ACTION_REQUIRED", complete = false,
  cardsOnly = false): Promise<QaWorkflowResult> {
  const root = request.outputPath;
  await mkdir(join(root, "original"), { recursive: true });
  const originalPath = join(root, "original", "report.json");
  const handoffPath = join(root, "handoff.json");
  const agentBriefPath = join(root, "AGENT_REPAIR_BRIEF.md");
  const summaryPath = join(root, "qa-summary.json");
  const inconclusive = status === "INCONCLUSIVE";
  const sample = exportableNavigationReport();
  const defect = sample.issues[0];
  const replay = sample.replays[0];
  if (defect === undefined || replay === undefined) throw new Error("Missing report fixture issue or replay.");
  const confirmed = (id: string): typeof defect => ({
    ...defect, id, evidence: [{ kind: "deterministic-failure", summary: "Focus outside modal",
      source: null, artifact: null }],
  });
  const verified = status === "ACTION_REQUIRED" ? (cardsOnly ? 1 : 2) : 0;
  const review = status === "NO_VERIFIED_FAILURES_IN_COVERAGE" ? 0 : cardsOnly ? 0 : 1;
  const untested = complete || cardsOnly ? 0 : 3;
  const verifiedIssues = Array.from({ length: verified }, (_, index) =>
    confirmed(index === 0 ? defect.id : `${defect.id}-${String(index + 1)}`));
  const reviewIssues = Array.from({ length: review }, (_, index) => ({
    ...defect, id: `TVDOCTOR-REVIEW-${String(index)}`, confidence: "heuristic" as const,
    evidence: [{ kind: "heuristic-warning" as const, summary: "Review only",
      source: null, artifact: null }],
    reproduction: { status: "unavailable" as const, reason: "review-only" },
  }));
  const untestedIssues = Array.from({ length: untested }, (_, index) => ({
    ...defect, id: `TVDOCTOR-UNTESTED-${String(index)}`, severity: "info" as const,
    confidence: "unobservable" as const, evidence: [],
    reproduction: { status: "unavailable" as const, reason: "untested" },
  }));
  const source: TVDoctorReportV1 = {
    ...sample,
    run: { ...sample.run, mode: request.mode },
    target: { ...sample.target, location: request.target,
      environment: { browser: "chromium", inputMode: "keyboard",
        keyboardInteractions: request.safeInteractions ? "enabled" : "disabled",
        safeLinkNavigation: request.safeLinks ? "enabled" : "disabled" } },
    issues: [...verifiedIssues, ...reviewIssues, ...untestedIssues],
    replays: verifiedIssues.map((issue) => ({ ...replay,
      id: `replay-${issue.id}`, issueId: issue.id })),
  };
  const bytes = Buffer.from(JSON.stringify(source));
  const scanPolicy = { schemaVersion: "tvdoctor.qa-scan-policy/v1" as const,
    safeInteractions: request.safeInteractions, safeLinks: request.safeLinks,
    mode: request.mode, failOn: "any",
    reportSha256: createHash("sha256").update(bytes).digest("hex") };
  const result: QaWorkflowResult = {
    schemaVersion: "tvdoctor.qa/v1", source: "url", status,
    shouldFail: status === "ACTION_REQUIRED" || inconclusive,
    exitCode: status === "ACTION_REQUIRED" ? 1 : inconclusive ? 3 : 0,
    reason: inconclusive ? "source-evidence-missing-or-incomplete" : null,
    originalPath: inconclusive ? null : originalPath,
    handoffPath: inconclusive ? null : handoffPath,
    agentBriefPath: inconclusive ? null : agentBriefPath,
    summaryPath,
    summary: inconclusive ? null : {
      routes: 1, verified, review, untested, incompleteRoutes: 0,
      selected: Math.min(3, verified + review),
    },
    ...(!inconclusive ? { scanPolicy } : {}),
    caveat: "Partial exploration cannot guarantee coverage.",
  };
  if (!inconclusive) {
    await writeFile(originalPath, bytes);
    await writeFile(join(root, "original", "report.html"), "<p>PRIVATE PAGE CONTENT</p>");
    await writeFile(handoffPath, '{"private":"SECRET PRIVATE ORIGINAL"}');
    await writeFile(agentBriefPath, "# Repair instructions\nPRIVATE PAGE CONTENT stays in the local artifact.");
  }
  await writeFile(summaryPath, JSON.stringify(result));
  return result;
}

/** Retain a valid source-backed partial handoff, not a completed report relabelled as partial. */
async function writePartialQaFixture(request: LocalUiQaRequest): Promise<QaWorkflowResult> {
  const completed = await writeQaFixture(request);
  const original = join(request.outputPath, "original", "report.json");
  const source = parseTVDoctorReportJson(await readFile(original, "utf8"));
  if (source.schemaVersion !== "tvdoctor.report/v1") throw new Error("Expected report v1.");
  const partial: TVDoctorReportV1 = {
    ...source,
    run: { ...source.run, status: "partial" },
    coverage: { ...source.coverage,
      packs: source.coverage.packs.map((pack) => ({ ...pack, status: "partial" as const })) },
  };
  const bytes = Buffer.from(JSON.stringify(partial));
  await writeFile(original, bytes);
  const result: QaWorkflowResult = {
    ...completed, status: "INCONCLUSIVE", exitCode: 3, shouldFail: true,
    summary: completed.summary === null ? null : { ...completed.summary, incompleteRoutes: 1 },
    ...(completed.scanPolicy === undefined ? {} : { scanPolicy: { ...completed.scanPolicy,
      reportSha256: createHash("sha256").update(bytes).digest("hex") } }),
  };
  await writeFile(join(request.outputPath, "qa-summary.json"), JSON.stringify(result));
  return result;
}

async function qaServer(runQa: (request: LocalUiQaRequest) => Promise<QaWorkflowResult>,
  runQaAccept?: (request: LocalUiQaAcceptRequest) => Promise<QaAcceptResult>) {
  server = await serveLocalUi({ outputRoot, runScan: createReport, runQa,
    ...(runQaAccept === undefined ? {} : { runQaAccept }) });
  const html = await (await fetch(server.url)).text();
  const csrf = /name="tvdoctor-csrf" content="([^"]+)"/u.exec(html)?.[1];
  if (csrf === undefined) throw new Error("Missing QA form token.");
  return { url: server.url, csrf, html };
}

async function writeQaAcceptFixture(request: LocalUiQaAcceptRequest,
  status: "PASS" | "REPRODUCED" | "REGRESSION_FOUND" = "PASS"): Promise<QaAcceptResult> {
  const root = request.outputPath;
  await mkdir(join(root, "verification"), { recursive: true });
  await mkdir(join(root, "regression"), { recursive: true });
  await writeFile(join(root, "verification", "qa-verification.json"), '{"original":"independent"}');
  await writeFile(join(root, "regression", "qa-summary.json"), '{"fresh":"qa"}');
  const result: QaAcceptResult = {
    schemaVersion: "tvdoctor.qa-accept/v1", status,
    exitCode: status === "PASS" ? 0 : 1,
    shouldFail: status !== "PASS", reason: status === "PASS" ? null : "verified-defects-remain",
    original: { sha256: "b".repeat(64), verified: 2 },
    verification: { status: status === "REPRODUCED" ? "REPRODUCED" : "FIXED",
      fixed: status === "REPRODUCED" ? 1 : 2, reproduced: status === "REPRODUCED" ? 1 : 0,
      inconclusive: 0, summaryPath: "verification/qa-verification.json" },
    regression: { status: "COMPLETED", verified: status === "REGRESSION_FOUND" ? 1 : 0,
      review: 1, untested: 0, verifiedIssueIds: status === "REGRESSION_FOUND" ? ["TVDOCTOR-NEW"] : [],
      summaryPath: "regression/qa-summary.json" },
    acceptancePath: "qa-accept.json", caveat: "Only the independently checked supported issue(s) are FIXED.",
  };
  await writeFile(join(root, "qa-accept.json"), JSON.stringify(result));
  return result;
}

async function postQa(url: string, csrf: string, body: unknown,
  headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${url}/api/qa`, {
    method: "POST", headers: {
      Origin: url, "X-TVDoctor-CSRF": csrf, "Content-Type": "application/json", ...headers,
    }, body: JSON.stringify(body),
  });
}

describe("local developer QA dashboard", () => {
  const request = { url: "http://127.0.0.1:3000/", mode: "standard", safeInteractions: true,
    safeLinks: false };

  it("leads post-repair results with reproduced failures, new verified findings, fixes, or inconclusive checks", () => {
    // Execute the actual inline dashboard script without opening Chromium.
    const html = renderLocalUiPage("qaTestToken", true);
    const source = /<script nonce="qaTestToken">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    if (source === undefined) throw new Error("Missing dashboard script.");
    const createNode = () => ({
      textContent: "", hidden: false, checked: false, disabled: false, value: "",
      dataset: {} as Record<string, string>,
      options: [{ textContent: "" }, { textContent: "" }, { textContent: "" }],
      addEventListener: () => undefined,
      replaceChildren: () => undefined,
      appendChild: () => undefined,
      removeAttribute: () => undefined,
      pause: () => undefined,
      querySelector: () => createNode(),
      querySelectorAll: () => [],
    });
    const nodes = new Map<string, ReturnType<typeof createNode>>();
    const getNode = (id: string) => {
      let node = nodes.get(id);
      if (node === undefined) {
        node = createNode();
        nodes.set(id, node);
      }
      return node;
    };
    getNode("workflow-qa").checked = true;
    getNode("scan-type").value = "navigation";
    const scriptContext: {
      document: object;
      fetch: () => Promise<object>;
      setInterval: () => number;
      renderForTest?: (job: unknown) => void;
    } = {
      document: {
        getElementById: getNode,
        querySelector: () => ({ content: "qaTestToken" }),
        createElement: createNode,
      },
      fetch: async () => ({ ok: false }),
      setInterval: () => 0,
    };
    new Script(source.replace("void refresh();", "globalThis.renderForTest = render;"))
      .runInNewContext(scriptContext);
    const render = scriptContext.renderForTest;
    if (render === undefined) throw new Error("Dashboard render handler missing.");

    for (const [status, label, value] of [
      ["REPRODUCED", "Original failures still reproduced", "1"],
      ["REGRESSION_FOUND", "Fresh QA verified failures", "4"],
      ["PASS", "Original issues independently fixed", "3"],
      ["INCONCLUSIVE", "Original checks inconclusive", "2"],
    ] as const) {
      render({ id: "00000000-0000-0000-0000-000000000001", type: "qa-accept",
        state: status === "INCONCLUSIVE" ? "partial" : "completed",
        acceptance: {
          status, links: {}, originalLinks: {},
          verification: { status: "FIXED", fixed: 3, reproduced: 1, inconclusive: 2 },
          regression: { status: "COMPLETED", verified: 4, review: 5, untested: 6 },
        },
      });
      expect(getNode("scan-status").textContent).toBe(status.replaceAll("_", " "));
      expect(getNode("metric-name").textContent).toBe(label);
      expect(getNode("findings").textContent).toBe(value);
      // Keep the complete breakdown even when its most urgent count is the headline.
      expect(getNode("accept-fixed").textContent).toBe("3");
      expect(getNode("accept-reproduced").textContent).toBe("1");
      expect(getNode("accept-inconclusive").textContent).toBe("2");
      expect(getNode("accept-regression").textContent).toBe("4");
      expect(getNode("accept-review").textContent).toBe("5");
      expect(getNode("accept-untested").textContent).toBe("6");
    }

    render({ type: "qa-accept", state: "partial",
      acceptance: {
        status: "INCONCLUSIVE", links: {}, originalLinks: {},
        verification: { status: "NOT_RUN", fixed: 0, reproduced: 0, inconclusive: 0 },
        regression: { status: "NOT_RUN", verified: 0, review: 0, untested: 0 },
      },
    });
    expect(getNode("findings").textContent).toBe("—");
    expect(getNode("accept-inconclusive").textContent).toBe("—");
  });

  it("runs the injected production QA host and exposes only validated classification, counts and local artifact URLs", async () => {
    const requests: LocalUiQaRequest[] = [];
    const { url, csrf, html } = await qaServer(async (input) => {
      requests.push(input);
      return await writeQaFixture(input);
    });
    expect(html).toContain("Website QA · recommended");
    expect(html).toContain('id="workflow-qa" type="radio" name="workflow" value="qa" checked');
    expect(html).toContain("Run website QA");
    expect(html).toContain("VERIFIED originals");
    expect(html).toContain("REVIEW leads");
    expect(html).toContain("UNTESTED coverage");
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const job = await waitForState(url, "completed");
    expect(requests).toMatchObject([{ target: request.url, mode: request.mode,
      safeInteractions: true, safeLinks: false }]);
    expect(requests[0]?.outputPath).toMatch(/tvdoctor-local-ui-[^\\/]+[\\/][a-f0-9-]{36}$/u);
    expect(job).toMatchObject({ type: "qa", state: "completed", qa: {
      status: "ACTION_REQUIRED", summary: { verified: 2, review: 1, untested: 3, incompleteRoutes: 0 },
    } });
    const output = JSON.stringify(job);
    expect(output).not.toContain(request.url);
    expect(output).not.toContain("SECRET");
    expect(output).not.toContain("PRIVATE PAGE CONTENT");
    expect(output).not.toContain(outputRoot);
    const links = (job["qa"] as { links: Record<string, string> }).links;
    expect(links["brief"]).toMatch(/^\/reports\/[a-f0-9-]{36}\/AGENT_REPAIR_BRIEF\.md$/u);
    expect(links["report"]).toMatch(/\/original\/report\.html$/u);
    expect((await fetch(url + links["brief"])).status).toBe(200);
    expect((await fetch(url + links["report"])).status).toBe(200);
    expect((await fetch(url + links["summary"])).status).toBe(200);
    expect((await rawGet(url, `/reports/${String(job["id"])}/../private.txt`))).toBe(404);
  });

  it("shows privacy-safe per-issue QA cards only when the saved original report independently matches the QA summary", async () => {
    const { url, csrf } = await qaServer(async (input) => {
      return await writeQaFixture(input, "ACTION_REQUIRED", true, true);
    });
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const job = await waitForState(url, "completed");
    expect(job).toMatchObject({ qa: { status: "ACTION_REQUIRED", summary: { verified: 1 } } });
    const triage = job["triage"] as { total?: number; findings?: {
      title: string; rule: string; reportUrl?: string;
    }[] } | undefined;
    expect(triage?.total).toBe(1);
    expect(triage?.findings?.[0]).toMatchObject({
      rule: "keyboard.modal-focus-escape",
      title: "keyboard.modal-focus-escape · finding 1",
      reportUrl: `/reports/${String(job["id"])}/original/report.html#TVDOCTOR-NAV-MODAL42`,
      guidance: {
        impact: "Keyboard focus escaped a visible modal. Users may reach controls behind an unfinished dialog.",
        investigate: expect.stringContaining("focus trapping"),
        verification: expect.stringContaining("verify-fix"),
      },
    });
    expect(JSON.stringify(job)).not.toContain("SECRET_LABEL");
    expect(JSON.stringify(job)).not.toContain(request.url);
    expect(JSON.stringify(job)).not.toContain("private SECRET");
  });

  it("rejects unsafe QA requests and cross-origin/CSRF attempts without starting browsers", async () => {
    let starts = 0;
    const { url, csrf } = await qaServer(async (input) => {
      starts += 1;
      return await writeQaFixture(input, "NO_VERIFIED_FAILURES_IN_COVERAGE");
    });
    for (const invalid of [
      { ...request, url: "file:///tmp/x" },
      { ...request, url: "http://name:password@localhost/" },
      { ...request, url: "https://example.test/?session=PRIVATE" },
      { ...request, url: "https://example.test/#fragment" },
      { ...request, mode: "everything" },
      { ...request, safeInteractions: false, safeLinks: true },
      { ...request, safeLinks: "true" },
      { ...request, special: "injected" },
    ]) expect((await postQa(url, csrf, invalid)).status).toBe(400);
    expect((await postQa(url, "invalid", request)).status).toBe(403);
    expect((await postQa(url, csrf, request, { Origin: "http://attacker.invalid" })).status).toBe(403);
    expect(starts).toBe(0);
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const job = await waitForState(url, "completed");
    expect(job).toMatchObject({ qa: { status: "NO_VERIFIED_FAILURES_IN_COVERAGE",
      summary: { verified: 0, review: 0, untested: 3 } } });
    expect(starts).toBe(1);
  });

  it("fails closed on forged or incomplete success and preserves unknown counts on inconclusive runs", async () => {
    const { url, csrf } = await qaServer(async (input) => {
      const result = await writeQaFixture(input);
      await writeFile(join(input.outputPath, "qa-summary.json"), '{"status":"ACTION_REQUIRED"}');
      return result;
    });
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const invalid = await waitForState(url, "failed");
    expect(invalid["qa"]).toBeUndefined();
    expect(invalid["reportUrl"]).toBeUndefined();
    expect(invalid["message"]).toContain("incomplete");
    await server?.close();
    server = undefined;
    const next = await qaServer(async (input) => await writeQaFixture(input, "INCONCLUSIVE"));
    expect((await postQa(next.url, next.csrf, request)).status).toBe(202);
    const partial = await waitForState(next.url, "partial");
    expect(partial).toMatchObject({ qa: { status: "INCONCLUSIVE", summary: null } });
    expect(JSON.stringify(partial)).not.toContain("PRIVATE");
  });

  it.each([
    "same-count-changed-issue",
    "different-source-target-with-recomputed-pin",
    "different-source-mode-with-recomputed-pin",
    "forged-saved-policy",
    "forged-saved-counts",
    "source-symlink",
  ] as const)("refuses green dashboard QA for %s", async (attack) => {
    const { url, csrf } = await qaServer(async (input) => {
      let result = await writeQaFixture(input, "ACTION_REQUIRED", true);
      const sourcePath = join(input.outputPath, "original", "report.json");
      const summaryPath = join(input.outputPath, "qa-summary.json");
      if (attack === "same-count-changed-issue") {
        const report = parseTVDoctorReportJson(await readFile(sourcePath, "utf8"));
        if (report.schemaVersion !== "tvdoctor.report/v1") throw new Error("Expected source report.");
        await writeFile(sourcePath, JSON.stringify({ ...report,
          issues: report.issues.map((issue, index) => index === 0
            ? { ...issue, title: "CHANGED PRIVATE ISSUE WITH SAME COUNT" } : issue) }));
      } else if (attack === "different-source-target-with-recomputed-pin"
        || attack === "different-source-mode-with-recomputed-pin") {
        const report = parseTVDoctorReportJson(await readFile(sourcePath, "utf8"));
        if (report.schemaVersion !== "tvdoctor.report/v1" || result.scanPolicy === undefined) {
          throw new Error("Expected source report and SHA policy.");
        }
        const shifted = attack === "different-source-target-with-recomputed-pin"
          ? { ...report, target: { ...report.target, location: "https://private.other.test/" } }
          : { ...report, run: { ...report.run, mode: "deep" as const } };
        const bytes = Buffer.from(JSON.stringify(shifted));
        await writeFile(sourcePath, bytes);
        result = { ...result, scanPolicy: { ...result.scanPolicy,
          reportSha256: createHash("sha256").update(bytes).digest("hex") } };
        await writeFile(summaryPath, JSON.stringify(result));
      } else if (attack === "forged-saved-policy") {
        await writeFile(summaryPath, JSON.stringify({ ...result,
          scanPolicy: { ...result.scanPolicy, safeLinks: true } }));
      } else if (attack === "forged-saved-counts") {
        await writeFile(summaryPath, JSON.stringify({ ...result,
          summary: { ...result.summary, verified: 0 } }));
      } else {
        const copy = join(input.outputPath, "original", "report-copy.json");
        await writeFile(copy, await readFile(sourcePath));
        await rm(sourcePath);
        await symlink(copy, sourcePath, "file");
      }
      return result;
    }, async (input) => await writeQaAcceptFixture(input));
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const invalid = await waitForState(url, "failed");
    expect(invalid["qa"]).toBeUndefined();
    expect(invalid["acceptReady"]).toBeUndefined();
    expect(invalid["triage"]).toBeUndefined();
    expect(JSON.stringify(invalid)).not.toContain("CHANGED PRIVATE ISSUE");
    expect(JSON.stringify(invalid)).not.toContain("private.other.test");
  });

  it("denies QA acceptance without launching a browser after the source report changes", async () => {
    let acceptanceCalls = 0;
    const { url, csrf } = await qaServer(async (input) =>
      await writeQaFixture(input, "ACTION_REQUIRED", true), async (input) => {
      acceptanceCalls += 1;
      return await writeQaAcceptFixture(input);
    });
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const original = await waitForState(url, "completed");
    expect(original["acceptReady"]).toBe(true);
    const reportPath = join(outputRoot, String(original["id"]), "original", "report.json");
    const bytes = await readFile(reportPath, "utf8");
    await writeFile(reportPath, bytes.replace("Private modal", "Changed modal"));
    expect((await fetch(`${url}/api/qa/${String(original["id"])}/accept`, {
      method: "POST", headers: { Origin: url, "X-TVDoctor-CSRF": csrf },
    })).status).toBe(409);
    expect(acceptanceCalls).toBe(0);
  });

  it("blocks acceptance before a browser when the saved QA summary changes after completion", async () => {
    let acceptanceCalls = 0;
    const { url, csrf } = await qaServer(async (input) =>
      await writeQaFixture(input, "ACTION_REQUIRED", true), async (input) => {
      acceptanceCalls += 1;
      return await writeQaAcceptFixture(input);
    });
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const original = await waitForState(url, "completed");
    expect(original["acceptReady"]).toBe(true);
    const summaryPath = join(outputRoot, String(original["id"]), "qa-summary.json");
    const bytes = await readFile(summaryPath, "utf8");
    await writeFile(summaryPath, bytes.replace("Partial exploration", "Changed exploration"));
    expect((await fetch(`${url}/api/qa/${String(original["id"])}/accept`, {
      method: "POST", headers: { Origin: url, "X-TVDoctor-CSRF": csrf },
    })).status).toBe(409);
    expect(acceptanceCalls).toBe(0);
  });

  it("keeps observed counts and evidence from an INCONCLUSIVE partial QA handoff", async () => {
    const { url, csrf } = await qaServer(writePartialQaFixture);
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const job = await waitForState(url, "partial");
    expect(job).toMatchObject({ qa: { status: "INCONCLUSIVE",
      summary: { verified: 2, review: 1, untested: 3, incompleteRoutes: 1 } } });
    const links = (job["qa"] as { links: Record<string, string> }).links;
    expect(links["brief"]).toMatch(/^\/reports\/[a-f0-9-]{36}\/AGENT_REPAIR_BRIEF\.md$/u);
    expect((await fetch(url + links["brief"])).status).toBe(200);
    expect(job["acceptReady"]).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("PRIVATE PAGE CONTENT");
  });

  it("uses the same cancellation gate and single-active-browser guard as navigation scans", async () => {
    let finish: ((result: QaWorkflowResult) => void) | undefined;
    let signal: AbortSignal | undefined;
    const { url, csrf } = await qaServer(async (input) => {
      signal = input.signal;
      return await new Promise<QaWorkflowResult>((resolveResult) => { finish = resolveResult; });
    });
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const active = await (await fetch(`${url}/api/status`)).json() as { id: string };
    expect((await postQa(url, csrf, request)).status).toBe(409);
    expect((await post(url, csrf, { url: request.url, mode: "quick", input: "keyboard" })).status).toBe(409);
    expect((await fetch(`${url}/api/scans/${active.id}/cancel`, { method: "POST",
      headers: { Origin: url, "X-TVDoctor-CSRF": csrf },
    })).status).toBe(202);
    expect(signal?.aborted).toBe(true);
    expect((await postQa(url, csrf, request)).status).toBe(409);
    finish?.({ schemaVersion: "tvdoctor.qa/v1", source: "url", status: "INCONCLUSIVE",
      shouldFail: true, exitCode: 3, reason: "cancelled", originalPath: null,
      handoffPath: null, agentBriefPath: null, summaryPath: null, summary: null,
      caveat: "Cancelled" });
    const cancelled = await waitForState(url, "cancelled");
    expect(cancelled["qa"]).toBeUndefined();
  });

  it("only replays after an explicit CSRF-protected accept click on a complete owned QA result", async () => {
    const observed: LocalUiQaAcceptRequest[] = [];
    let originalPath = "";
    let originalSummary = "";
    const { url, csrf } = await qaServer(async (input) => {
      originalPath = input.outputPath;
      const outcome = await writeQaFixture(input, "ACTION_REQUIRED", true);
      originalSummary = await readFile(join(originalPath, "qa-summary.json"), "utf8");
      return outcome;
    }, async (input) => {
      observed.push(input);
      return await writeQaAcceptFixture(input);
    });
    expect((await postQa(url, csrf, request)).status).toBe(202);
    const source = await waitForState(url, "completed");
    expect(source["acceptReady"]).toBe(true);
    expect(observed).toHaveLength(0);
    const endpoint = `${url}/api/qa/${String(source["id"])}/accept`;
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(403);
    expect((await fetch(endpoint, { method: "POST", headers: {
      Origin: "http://evil.invalid", "X-TVDoctor-CSRF": csrf,
    } })).status).toBe(403);
    expect((await fetch(endpoint, { method: "POST", headers: {
      Origin: url, "X-TVDoctor-CSRF": csrf, "Content-Type": "application/json",
    }, body: '{"original":"D:/forged/qa"}' })).status).toBe(413);
    expect(observed).toHaveLength(0);
    expect((await fetch(endpoint, { method: "POST", headers: {
      Origin: url, "X-TVDoctor-CSRF": csrf,
    } })).status).toBe(202);
    const accepted = await waitForState(url, "completed");
    expect(accepted).toMatchObject({ type: "qa-accept", acceptance: {
      status: "PASS", verification: { fixed: 2, reproduced: 0, inconclusive: 0 },
      regression: { status: "COMPLETED", verified: 0, review: 1, untested: 0 },
    } });
    expect(observed).toMatchObject([{ originalQaPath: originalPath, target: request.url }]);
    expect(observed[0]?.outputPath).not.toBe(originalPath);
    expect(await readFile(join(originalPath, "qa-summary.json"), "utf8")).toBe(originalSummary);
    const serialized = JSON.stringify(accepted);
    expect(serialized).not.toContain(request.url);
    expect(serialized).not.toContain(originalPath);
    expect(serialized).not.toContain("SECRET");
    const links = (accepted["acceptance"] as { links: Record<string, string> }).links;
    for (const link of Object.values(links)) {
      expect(link).toMatch(/^\/reports\/[a-f0-9-]{36}\//u);
      expect((await fetch(url + link)).status).toBe(200);
    }
  });

  it("refuses acceptance for incomplete original coverage and fails closed on forged success", async () => {
    let calls = 0;
    const start = await qaServer(writePartialQaFixture, async (input) => {
      calls += 1;
      return await writeQaAcceptFixture(input);
    });
    expect((await postQa(start.url, start.csrf, request)).status).toBe(202);
    const original = await waitForState(start.url, "partial");
    expect(original["acceptReady"]).toBeUndefined();
    expect((await fetch(`${start.url}/api/qa/${String(original["id"])}/accept`, {
      method: "POST", headers: { Origin: start.url, "X-TVDoctor-CSRF": start.csrf },
    })).status).toBe(409);
    expect(calls).toBe(0);
    await server?.close(); server = undefined;
    const ready = await qaServer(async (input) => await writeQaFixture(input, "ACTION_REQUIRED", true),
      async (input) => {
        const output = await writeQaAcceptFixture(input);
        await writeFile(join(input.outputPath, "qa-accept.json"), '{"status":"PASS"}');
        return output;
      });
    expect((await postQa(ready.url, ready.csrf, request)).status).toBe(202);
    const source = await waitForState(ready.url, "completed");
    expect((await fetch(`${ready.url}/api/qa/${String(source["id"])}/accept`, {
      method: "POST", headers: { Origin: ready.url, "X-TVDoctor-CSRF": ready.csrf },
    })).status).toBe(202);
    const invalid = await waitForState(ready.url, "failed");
    expect(invalid["acceptance"]).toBeUndefined();
    expect(invalid["reportUrl"]).toBeUndefined();
  });
});

describe("TVDoctor local UI", () => {
  it("publishes only digest-matched per-issue media and exact safe Playwright test exports", async () => {
    const reportData = exportableNavigationReport();
    let validatorError = "";
    const issueId = reportData.issues[0]?.id;
    if (issueId === undefined) throw new Error("Missing issue fixture.");
    const { csrf, url } = await newServer(async (request) => {
      const outcome = await createReport(request);
      const folder = join(request.outputPath, "evidence", issueId);
      await mkdir(folder, { recursive: true });
      const image = Buffer.from("valid-owned-image");
      const video = Buffer.from("valid-owned-video-recording");
      await writeFile(join(folder, "before-screenshot.png"), image);
      await writeFile(join(folder, "issue-video.webm"), video);
      const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
      const report: TVDoctorReportV1 = {
        ...reportData,
        artifacts: [
          { id: `${issueId}:before-screenshot`, kind: "screenshot", status: "available",
            path: `evidence/${issueId}/before-screenshot.png`,
            mediaType: "image/png", byteLength: image.length, sha256: digest(image) },
          { id: `${issueId}:issue-video`, kind: "video", status: "available",
            path: `evidence/${issueId}/issue-video.webm`,
            mediaType: "video/webm", byteLength: video.length, sha256: digest(video) },
        ],
      };
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify(report));
      try { renderPlaywrightTest(parseTVDoctorReportJson(JSON.stringify(report)), issueId); }
      catch (error) { validatorError = String(error); }
      await mkdir(join(request.outputPath, "exports"));
      await writeFile(join(request.outputPath, "exports", `${issueId}.spec.js`),
        renderPlaywrightTest(report, issueId));
      return outcome;
    });
    expect((await post(url, csrf, {
      url: "https://example.test/", mode: "standard", input: "keyboard",
    })).status).toBe(202);
    const done = await waitForState(url, "completed");
    expect(validatorError).toBe("");
    const triage = done["triage"] as Record<string, unknown>;
    expect(triage["total"]).toBe(1);
    const item = (triage["findings"] as Record<string, unknown>[])[0];
    expect(item).toMatchObject({
      confidence: "deterministic", recordedReplayActions: 4,
      imageUrl: `/reports/${String(done["id"])}/evidence/${issueId}/before-screenshot.png`,
      videoUrl: `/reports/${String(done["id"])}/evidence/${issueId}/issue-video.webm`,
      testExportUrl: `/reports/${String(done["id"])}/exports/${issueId}.spec.js`,
    });
    expect(JSON.stringify(triage)).not.toContain("SECRET_LABEL");
    expect(JSON.stringify(triage)).not.toContain("example.test");
    expect((await fetch(url + String(item?.["videoUrl"]))).status).toBe(200);
    const fragment = await fetch(url + String(item?.["videoUrl"]), { headers: { Range: "bytes=0-4" } });
    expect(fragment.status).toBe(206);
    expect(await fragment.text()).toBe("valid");
    const script = await fetch(url + String(item?.["testExportUrl"]));
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("TVDOCTOR_AUTHORIZED_TARGET_URL");
  });

  it("rejects forged/tampered per-issue attachments, mismatched export and stale navigation status", async () => {
    const root = join(outputRoot, "forged-evidence");
    const report = exportableNavigationReport();
    const issueId = report.issues[0]?.id;
    if (issueId === undefined) throw new Error("No issue.");
    await mkdir(join(root, "evidence", issueId), { recursive: true });
    await mkdir(join(root, "exports"));
    await writeFile(join(root, "report.html"), "<h1>Report</h1>");
    await writeFile(join(root, "evidence", issueId, "before-screenshot.png"), "fake screenshot");
    await writeFile(join(root, "evidence", issueId, "issue-video.webm"), "fake recording");
    await writeFile(join(root, "exports", `${issueId}.spec.js`),
      "// Issue: " + issueId + "\n// Forged Playwright test");
    await writeFile(join(root, "report.json"), JSON.stringify({
      ...report, artifacts: [
        { id: `${issueId}:before-screenshot`, kind: "screenshot", status: "available",
          path: `evidence/${issueId}/before-screenshot.png`,
          mediaType: "image/png", byteLength: 15, sha256: "f".repeat(64) },
        { id: `TVDOCTOR-OTHER:issue-video`, kind: "video", status: "available",
          path: `evidence/${issueId}/issue-video.webm`,
          mediaType: "video/webm", byteLength: 14, sha256: "f".repeat(64) },
      ],
    }));
    const id = "00000000-0000-0000-0000-000000000000";
    const triage = await readLocalTriage(root, id, "navigation", "completed");
    expect(triage.total).toBe(1);
    expect(triage.findings[0]?.imageUrl).toBeUndefined();
    expect(triage.findings[0]?.videoUrl).toBeUndefined();
    expect(triage.findings[0]?.testExportUrl).toBeUndefined();
    expect(JSON.stringify(triage)).not.toContain("SECRET_LABEL");
    const stale = await readLocalTriage(root, id, "navigation", "partial");
    expect(stale.total).toBe(0);
    expect(stale.limits).toContain("navigation-report-stale");
  });

  it("drills into navigation findings by actual severity/confidence and validates screenshot provenance", async () => {
    const report = await newServer(async (request) => {
      const outcome = await createReport(request);
      await mkdir(join(request.outputPath, "evidence", "TVDOCTOR-NAV-HIGH"), { recursive: true });
      await writeFile(join(request.outputPath, "evidence", "TVDOCTOR-NAV-HIGH", "before-screenshot.png"), "proof");
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify({
        schemaVersion: "tvdoctor.report/v1",
        run: { status: "partial" },
        coverage: { actionsSent: 31, focusStatesDiscovered: 8, transitionsTested: 12,
          budget: { exhausted: ["actions"] }, packs: [{ status: "partial" }] },
        issues: [
          { id: "TVDOCTOR-NAV-HIGH", rule: "focus.trap", title: "Focus traps controls on https://private.test/?token=secret",
            severity: "high", confidence: "deterministic" },
          { id: "TVDOCTOR-NAV-REVIEW", rule: "focus.offscreen", title: "Check apparent offscreen control",
            severity: "low", confidence: "heuristic" },
        ],
        artifacts: [
          { id: "TVDOCTOR-NAV-HIGH:before-screenshot", status: "available", kind: "screenshot",
            mediaType: "image/png", path: "evidence/TVDOCTOR-NAV-HIGH/before-screenshot.png",
            byteLength: 5, sha256: createHash("sha256").update("proof").digest("hex") },
          { id: "TVDOCTOR-NAV-REVIEW:before-screenshot", status: "available", kind: "screenshot",
            mediaType: "image/png", path: "evidence/../../secret.png" },
        ],
      }));
      const base = outcome.result;
      if (base === null) throw new Error("No fixture outcome.");
      return { ...outcome, result: { ...base, status: "partial" } };
    });
    expect((await post(report.url, report.csrf, {
      url: "https://private.test/?token=secret", mode: "quick", input: "keyboard",
    })).status).toBe(202);
    const finished = await waitForState(report.url, "partial");
    const triage = finished["triage"] as Record<string, unknown>;
    expect(triage["total"]).toBe(2);
    expect(triage["groups"]).toEqual([
      { severity: "high", confidence: "deterministic", count: 1 },
      { severity: "low", confidence: "heuristic", count: 1 },
    ]);
    const findings = triage["findings"] as Record<string, unknown>[];
    expect(findings[0]).toMatchObject({
      id: "TVDOCTOR-NAV-HIGH", severity: "high", confidence: "deterministic",
      source: "Navigation",
      imageUrl: `/reports/${String(finished["id"])}/evidence/TVDOCTOR-NAV-HIGH/before-screenshot.png`,
    });
    expect(findings[0]?.["reportUrl"]).toMatch(/report\.html#TVDOCTOR-NAV-HIGH$/u);
    expect(findings[1]?.["imageUrl"]).toBeUndefined();
    expect(JSON.stringify(triage)).not.toContain("private.test");
    expect(JSON.stringify(triage)).not.toContain("token=secret");
    expect((triage["coverage"] as string[])).toContain("Actions: 31 observed");
    expect(triage["limits"]).toEqual(expect.arrayContaining(["budget-actions", "pack-partial", "navigation-partial"]));
    const image = await fetch(report.url + String(findings[0]?.["imageUrl"]));
    expect(image.status).toBe(200);
    expect(await image.text()).toBe("proof");
  });

  it("reads site route reports without leaking URLs and preserves deferred route evidence", async () => {
    const { csrf, url } = await newServer(async (request) => {
      const outcome = await createReport(request);
      await mkdir(join(request.outputPath, "pages", "001"), { recursive: true });
      await writeFile(join(request.outputPath, "pages", "001", "report.html"), "<h1>Route 1</h1>");
      await writeFile(join(request.outputPath, "pages", "001", "report.json"), JSON.stringify({
        schemaVersion: "tvdoctor.report/v1", run: { status: "completed" },
        coverage: { budget: { exhausted: [] }, packs: [] },
        issues: [{ id: "TVDOCTOR-ISSUE-SITE", rule: "nav.wrong", title: "Broken route link",
          severity: "critical", confidence: "deterministic" }], artifacts: [],
      }));
      await writeFile(join(request.outputPath, "site-index.json"), JSON.stringify({
        schemaVersion: "tvdoctor.site-index/v1", status: "partial",
        pagesScanned: 1, pagesDiscovered: 3, maxPages: 1,
        pendingRoutes: ["https://private.test/user/secret", "https://private.test/settings"],
        termination: ["max-pages", "page-partial"],
        routes: [{ reportPath: "pages/001/report.json", status: "completed" },
          { reportPath: "../../outside/report.json", status: "failed" }],
        spaJourney: { status: "partial", statesObserved: 4, transitionsTested: 6,
          reviewLeads: 2, deferredStates: 2,
          graphPath: "spa/graph.html", reportPath: "spa/spa-journey.json" },
      }));
      await mkdir(join(request.outputPath, "spa"), { recursive: true });
      // A dashboard job must bind a saved SPA report to its authorised input
      // route, even when the first observed DOM route changes on startup.
      const spa = { ...savedSpaFixture(), targetIdentity: createHash("sha256")
        .update(["route", "/", ""].join("\u001f")).digest("hex").slice(0, 20) };
      await writeFile(join(request.outputPath, "spa", "graph.html"), renderSpaJourneyGraph(spa));
      await writeFile(join(request.outputPath, "spa", "spa-journey.json"), JSON.stringify(spa));
      const base = outcome.result;
      if (base === null) throw new Error("Fixture result missing.");
      return { ...outcome, result: {
        ...base, status: "partial",
        reportPath: join(request.outputPath, "site-index.json"),
      } };
    });
    expect((await post(url, csrf, {
      type: "site", url: "https://private.test/", mode: "quick", input: "keyboard", maxRoutes: 1,
      exploreSpa: true,
    })).status).toBe(202);
    const finished = await waitForState(url, "partial");
    const triage = finished["triage"] as Record<string, unknown>;
    expect(triage["total"]).toBe(3);
    expect((triage["findings"] as Record<string, unknown>[])[0]).toMatchObject({
      severity: "critical", confidence: "deterministic", source: "Route 01",
      reportUrl: `/reports/${String(finished["id"])}/pages/001/report.html#TVDOCTOR-ISSUE-SITE`,
    });
    expect(triage["coverage"]).toEqual(expect.arrayContaining([
      "Routes scanned: 1 / 1 cap", "Routes discovered: 3", "Routes deferred: 2",
      "Experimental SPA states observed: 4", "Experimental SPA states deferred: 2",
    ]));
    expect(triage["limits"]).toEqual(expect.arrayContaining([
      "routes-deferred", "spa-incomplete", "spa-states-deferred", "max-pages",
    ]));
    expect(triage["groups"]).toEqual(expect.arrayContaining([
      { severity: "unrated", confidence: "heuristic", count: 2 },
    ]));
    const spaLeads = (triage["findings"] as Record<string, unknown>[])
      .filter((finding) => finding["rule"] === "spa.expanded-panel-mismatch");
    expect(spaLeads).toHaveLength(2);
    expect(spaLeads[0]).toMatchObject({
      title: "Possible expanded-panel mismatch · review lead 1",
      severity: "unrated", confidence: "heuristic", source: "Experimental SPA · REVIEW",
      reportUrl: `/reports/${String(finished["id"])}/spa/graph.html#issues`,
      spaReview: {
        reviewRequired: true, stateNumber: 2, edgeNumber: 1, stateDepth: 1,
        stateReplaySteps: 1, edgeReplaySteps: 1, verifiedCheckpoints: 1,
      },
    });
    expect(triage["extraLinks"]).toEqual([
      { label: "Experimental SPA state graph",
        url: `/reports/${String(finished["id"])}/spa/graph.html#issues` },
      { label: "SPA journey details (may contain private page data)",
        url: `/reports/${String(finished["id"])}/spa/spa-journey.json` },
    ]);
    const graph = await fetch(url + `/reports/${String(finished["id"])}/spa/graph.html`);
    expect(graph.status).toBe(200);
    expect(graph.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(JSON.stringify(triage)).not.toContain("private.test");
  });

  it("fails closed on malformed, stale, or mismatched SPA reports without exposing review links", async () => {
    const root = join(outputRoot, "stale-spa");
    const spaFolder = join(root, "spa");
    await mkdir(spaFolder, { recursive: true });
    const sample = savedSpaFixture();
    const id = "00000000-0000-0000-0000-000000000000";
    const index = {
      schemaVersion: "tvdoctor.site-index/v1", status: "partial",
      pagesScanned: 0, pagesDiscovered: 0, maxPages: 1, routes: [], pendingRoutes: [],
      spaJourney: {
        status: "partial", statesObserved: sample.states.length,
        transitionsTested: sample.edges.filter((edge) => edge.status === "observed").length,
        deferredStates: sample.deferred.length, reviewLeads: sample.issues.length,
        graphPath: "spa/graph.html", reportPath: "spa/spa-journey.json",
      },
    };
    const evaluate = async (indexValue: object, reportValue: unknown): Promise<Record<string, unknown>> => {
      await writeFile(join(root, "site-index.json"), JSON.stringify(indexValue));
      await writeFile(join(spaFolder, "spa-journey.json"), JSON.stringify(reportValue));
      return await readLocalTriage(root, id, "site", "partial") as unknown as Record<string, unknown>;
    };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(sample));
    let result = await evaluate(index, sample);
    expect(result["total"]).toBe(2);

    // With an authenticated job launch identity, otherwise consistent SPA
    // evidence from another route must fail closed. Root state identity can
    // legitimately differ following a same-origin startup route rewrite.
    const acceptedBound = await readLocalTriage(root, id, "site", "partial", sample.targetIdentity);
    expect(acceptedBound.total).toBe(2);
    const wrongTargetBound = await readLocalTriage(root, id, "site", "partial", "f".repeat(20));
    expect(wrongTargetBound.total).toBe(0);
    expect(wrongTargetBound.limits).toContain("spa-review-unavailable");
    expect(wrongTargetBound.extraLinks).toBeUndefined();

    // Real scanner/MCP observations may contain a semantic ARIA disclosure.
    // The local dashboard must not lose the entire review when the valid
    // action kind differs from an ordinary menu toggle.
    const disclosureSample: SpaJourneyResult = {
      ...sample,
      states: sample.states.map((state) => ({ ...state, replay: state.replay.map((step) =>
        ({ ...step, kind: "disclosure-toggle" as const })) })),
      edges: sample.edges.map((edge) => ({ ...edge, kind: "disclosure-toggle" as const,
        replay: edge.replay.map((step) => ({ ...step, kind: "disclosure-toggle" as const })) })),
    };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(disclosureSample));
    result = await evaluate(index, disclosureSample);
    expect(result["total"]).toBe(2);
    expect(result["limits"]).not.toContain("spa-review-unavailable");
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(sample));

    // A same-document route-content loss remains a bounded REVIEW, never a
    // verified defect or a fixed-state claim. The report's actual source and
    // destination state/edge identities must agree, not just its issue title.
    const contentSample: SpaJourneyResult = {
      ...sample,
      states: sample.states.map((state, position) => position === 1 ? {
        ...state, routeIdentity: "8".repeat(20), replay: state.replay.map((step) =>
          ({ ...step, kind: "anchor" as const })),
      } : state),
      edges: sample.edges.map((edge, position) => position === 0 ? {
        ...edge, kind: "anchor" as const, replay: edge.replay.map((step) =>
          ({ ...step, kind: "anchor" as const })),
      } : edge),
      issues: sample.issues.map((issue, position) => position === 0
        ? { ...issue, rule: "spa.route-content-missing" as const } : issue),
    };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(contentSample));
    result = await evaluate(index, contentSample);
    expect(result["total"]).toBe(2);
    expect(result["findings"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "spa.route-content-missing", confidence: "heuristic",
        source: "Experimental SPA · REVIEW", title: expect.stringContaining("Possible missing main content"),
        guidance: expect.objectContaining({ investigate: expect.stringContaining("client-router"),
          verification: expect.stringContaining("cannot certify FIXED") }) }),
    ]));
    expect(JSON.stringify(result)).not.toContain("https://private.example");
    const boundContentIndex = { ...index, spaJourney: {
      ...index.spaJourney, routeContentReviewLeads: 1,
    } };
    result = await evaluate(boundContentIndex, contentSample);
    expect(result["total"]).toBe(2);
    expect(result["coverage"]).toContain("Possible blank client-side routes (REVIEW only): 1");
    result = await evaluate({ ...index, spaJourney: {
      ...index.spaJourney, routeContentReviewLeads: 2,
    } }, contentSample);
    expect(result["total"]).toBe(0);
    expect(result["limits"]).toContain("spa-review-unavailable");
    const originalRouteIdentity = sample.states[0]?.routeIdentity;
    if (originalRouteIdentity === undefined) throw new Error("Missing original root route identity");
    const forgedSameRoute: SpaJourneyResult = {
      ...contentSample,
      states: contentSample.states.map((state, position) => position === 1
        ? { ...state, routeIdentity: originalRouteIdentity } : state),
    };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(forgedSameRoute));
    result = await evaluate(index, forgedSameRoute);
    expect(result["total"]).toBe(0);
    expect(result["limits"]).toContain("spa-review-unavailable");
    const forgedContentEdge: SpaJourneyResult = {
      ...contentSample,
      edges: contentSample.edges.map((edge, position) => position === 0
        ? { ...edge, kind: "menu-toggle" as const, replay: edge.replay.map((step) =>
          ({ ...step, kind: "menu-toggle" as const })) } : edge),
      states: contentSample.states.map((state, position) => position === 1
        ? { ...state, replay: state.replay.map((step) => ({ ...step, kind: "menu-toggle" as const })) }
        : state),
    };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(forgedContentEdge));
    result = await evaluate(index, forgedContentEdge);
    expect(result["total"]).toBe(0);
    expect(result["limits"]).toContain("spa-review-unavailable");
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(sample));

    const firstIssue = sample.issues[0];
    const firstEdge = sample.edges[0];
    if (firstIssue === undefined || firstEdge === undefined || firstEdge.to === null) {
      throw new Error("Expected real observed source edge for runtime report fixture.");
    }
    const runtimeKind = "page-error";
    const runtimeRule = "spa.runtime-page-error";
    const eventFingerprint = createHash("sha256").update([
      "runtime-event", runtimeRule, firstEdge.from, firstEdge.to, "0", runtimeKind, "", "",
    ].join("\u001f")).digest("hex").slice(0, 20);
    const runtimeSample: SpaJourneyResult = {
      ...sample, issues: [{ ...firstIssue, rule: runtimeRule,
        evidence: "observed-runtime-event-after-action",
        runtimeEvent: { kind: runtimeKind, sourceStateId: firstEdge.from,
          observedStateId: firstEdge.to, eventFingerprint } }, ...sample.issues.slice(1)],
    };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(runtimeSample));
    result = await evaluate(index, runtimeSample);
    expect(result["total"]).toBe(2);
    expect(result["limits"]).not.toContain("spa-review-unavailable");
    expect(result["findings"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: runtimeRule, confidence: "heuristic" }),
    ]));
    const freshFingerprint = createHash("sha256").update([
      "fresh-verification", sample.targetIdentity, runtimeRule,
      firstEdge.from, firstEdge.to, "0", "reobserved", "matched-observation",
      String(firstEdge.replay.length),
    ].join("\u001f")).digest("hex").slice(0, 20);
    const firstRuntimeIssue = runtimeSample.issues[0];
    if (firstRuntimeIssue === undefined) throw new Error("Missing local runtime issue");
    const withVerification: SpaJourneyResult = { ...runtimeSample, issues: [{ ...firstRuntimeIssue,
      verification: { status: "reobserved", reason: "matched-observation",
        fingerprint: freshFingerprint, replayStepsVerified: firstEdge.replay.length,
        actions: 1, durationMs: 900 } }, ...runtimeSample.issues.slice(1)] };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(withVerification));
    result = await evaluate(index, withVerification);
    expect(result["total"]).toBe(2);
    expect(result["limits"]).not.toContain("spa-review-unavailable");
    expect(result["findings"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ freshContextVerification:
        expect.objectContaining({ status: "reobserved", actions: 1 }) }),
    ]));
    const forgedVerification: SpaJourneyResult = { ...withVerification,
      issues: withVerification.issues.map((issue, position) => position === 0 && issue.verification !== undefined
        ? { ...issue, verification: { ...issue.verification, fingerprint: "e".repeat(20) } } : issue) };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(forgedVerification));
    result = await evaluate(index, forgedVerification);
    expect(result["total"]).toBe(0);
    expect(result["limits"]).toContain("spa-review-unavailable");
    const recordedRuntime = runtimeSample.issues[0]?.runtimeEvent;
    const recordedIssue = runtimeSample.issues[0];
    if (recordedRuntime === undefined || recordedIssue === undefined) throw new Error("Missing saved runtime evidence");
    const forgedRuntime: SpaJourneyResult = {
      ...runtimeSample, issues: [{ ...recordedIssue,
        runtimeEvent: { ...recordedRuntime, eventFingerprint: "f".repeat(20) } },
      ...runtimeSample.issues.slice(1)],
    };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(forgedRuntime));
    result = await evaluate(index, forgedRuntime);
    expect(result["total"]).toBe(0);
    expect(result["limits"]).toContain("spa-review-unavailable");
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(sample));

    const forgedAnchor: SpaJourneyResult = {
      ...sample,
      states: sample.states.map((state) => ({ ...state, replay: state.replay.map((step) =>
        ({ ...step, kind: "anchor" as const })) })),
      edges: sample.edges.map((edge) => ({ ...edge, kind: "anchor" as const,
        replay: edge.replay.map((step) => ({ ...step, kind: "anchor" as const })) })),
    };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(forgedAnchor));
    result = await evaluate(index, forgedAnchor);
    expect(result["total"]).toBe(0);
    expect(result["limits"]).toContain("spa-review-unavailable");
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(sample));

    result = await evaluate({
      ...index, spaJourney: { ...index.spaJourney, reviewLeads: 3 },
    }, sample);
    expect(result["total"]).toBe(0);
    expect(result["limits"]).toContain("spa-review-unavailable");
    expect(result["extraLinks"]).toBeUndefined();

    result = await evaluate(index, { ...sample, issues: [
      { ...sample.issues[0], edgeIndex: 40 }, sample.issues[1],
    ] });
    expect(result["total"]).toBe(0);
    expect(result["extraLinks"]).toBeUndefined();

    result = await evaluate(index, { ...sample, issues: [
      { ...sample.issues[0], confidence: "deterministic", reviewRequired: false }, sample.issues[1],
    ] });
    expect(result["total"]).toBe(0);
    expect(result["groups"]).toEqual([]);

    result = await evaluate(index, { ...sample, edges: [
      { ...sample.edges[0], status: "deferred" }, ...sample.edges.slice(1),
    ] });
    expect(result["total"]).toBe(0);

    result = await evaluate(index, { schemaVersion: "tvdoctor.spa-journey/v1", issues: [] });
    expect(result["total"]).toBe(0);
    expect(result["limits"]).toContain("spa-review-unavailable");

    await writeFile(join(spaFolder, "graph.html"), "<h1>Unrelated stale HTML</h1>");
    result = await evaluate(index, sample);
    expect(result["total"]).toBe(0);
    expect(result["extraLinks"]).toBeUndefined();
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph({
      ...sample, issues: sample.issues.slice(0, 1),
    }));
    result = await evaluate(index, sample);
    expect(result["total"]).toBe(0);
    expect(result["extraLinks"]).toBeUndefined();

    const excessive = { ...sample, issues: Array.from({ length: 41 }, (_, index) => {
      const issue = sample.issues[index % sample.issues.length];
      if (issue === undefined) throw new Error("SPA sample issue missing.");
      return issue;
    }) };
    await writeFile(join(spaFolder, "graph.html"), renderSpaJourneyGraph(excessive));
    result = await evaluate({
      ...index, spaJourney: { ...index.spaJourney, reviewLeads: 41 },
    }, excessive);
    expect(result["total"]).toBe(40);
    expect(result["limits"]).toContain("spa-review-list-truncated");
    expect((result["findings"] as unknown[])).toHaveLength(40);

    result = await evaluate({
      ...index, spaJourney: { ...index.spaJourney, reviewLeads: 41 },
    }, { ...excessive, issues: [
      ...excessive.issues.slice(0, 40), { ...sample.issues[0], edgeIndex: 999 },
    ] });
    expect(result["total"]).toBe(0);
    expect(result["extraLinks"]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("http://");
  });

  it("labels browser-Back issues only with explicitly observed history evidence, never forward replay checkpoints", async () => {
    const root = join(outputRoot, "back-triage");
    const folder = join(root, "spa");
    await mkdir(folder, { recursive: true });
    const base = savedSpaFixture();
    const start = base.states[0];
    const forward = base.states[1];
    const existing = base.issues[1];
    if (start === undefined || forward === undefined || existing === undefined) throw new Error("SPA test graph missing state.");
    const issue: SpaJourneyResult["issues"][number] = {
      rule: "spa.history-back-stale-view", stateId: forward.id,
      edgeIndex: 0, confidence: "heuristic", reviewRequired: true,
      evidence: "observed-dom-after-history-back",
      historyBack: {
        expectedStateId: start.id,
        observedStateId: "e".repeat(20),
        expectedRouteIdentity: start.routeIdentity,
        observedRouteIdentity: start.routeIdentity,
        beforeHeadingFingerprint: "1".repeat(20),
        forwardHeadingFingerprint: "2".repeat(20),
        returnedHeadingFingerprint: "2".repeat(20),
        historyDelta: 1, settledSamples: 2,
      },
    };
    const sample: SpaJourneyResult = {
      ...base, states: base.states.map((state, index) => index === 1
        ? { ...state, routeIdentity: "8".repeat(20),
          replay: state.replay.map((step) => ({ ...step, kind: "anchor" as const })) } : state),
      edges: base.edges.map((edge, index) => index === 0
        ? { ...edge, kind: "anchor" as const,
          replay: edge.replay.map((step) => ({ ...step, kind: "anchor" as const })) } : edge),
      issues: [issue, existing],
    };
    const index = {
      schemaVersion: "tvdoctor.site-index/v1", status: "partial",
      routes: [], pendingRoutes: ["https://private.test/?secret=TOPSECRET"],
      spaJourney: {
        status: "partial", reportPath: "spa/spa-journey.json",
        graphPath: "spa/graph.html",
        statesObserved: sample.states.length,
        transitionsTested: sample.edges.length,
        deferredStates: sample.deferred.length,
        reviewLeads: sample.issues.length,
      },
    };
    const run = async (report: SpaJourneyResult): Promise<Awaited<ReturnType<typeof readLocalTriage>>> => {
      await writeFile(join(root, "site-index.json"), JSON.stringify(index));
      await writeFile(join(folder, "spa-journey.json"), JSON.stringify(report));
      await writeFile(join(folder, "graph.html"), renderSpaJourneyGraph(report));
      return await readLocalTriage(root, "00000000-0000-0000-0000-000000000000", "site", "partial");
    };
    const triage = await run(sample);
    expect(triage.total).toBe(2);
    const lead = triage.findings.find((value) => value.rule === "spa.history-back-stale-view");
    expect(lead).toMatchObject({
      confidence: "heuristic", severity: "unrated",
      source: "Experimental SPA · REVIEW",
      reportUrl: "/reports/00000000-0000-0000-0000-000000000000/spa/graph.html#issues",
      spaBackReview: {
        expectedStateNumber: 1, forwardStateNumber: 2, forwardEdgeNumber: 1,
        recordedForwardSetupSteps: 1, observedBackTransitions: 1,
        settledSamples: 2, reviewRequired: true,
      },
    });
    expect(lead?.spaReview).toBeUndefined();
    expect(JSON.stringify(triage)).not.toContain("TOPSECRET");
    expect(JSON.stringify(triage)).not.toContain("private.test");
    expect(triage.status).toBe("partial");
    expect(triage.limits).toEqual(expect.arrayContaining(["spa-incomplete", "spa-states-deferred", "routes-deferred"]));
    expect(triage.coverage).toContain("Experimental SPA states deferred: 2");
    const backProof = issue.historyBack;
    if (backProof === undefined) throw new Error("Expected Back evidence fixture.");
    const imageDirectory = join(folder, "evidence");
    await mkdir(imageDirectory);
    // A valid PNG at the exact observed edge slot; no screenshot is inferred
    // from a forward replay or attached to a different SPA issue.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(imageDirectory, "back-edge-001.png"), png);
    const descriptor = { path: "evidence/back-edge-001.png",
      sha256: createHash("sha256").update(png).digest("hex"), byteLength: png.length };
    const withBackImage = (image: unknown): SpaJourneyResult => ({
      ...sample,
      issues: [{ ...issue, historyBack: { ...backProof, screenshot: image } }, existing],
    }) as SpaJourneyResult;
    const imageLead = (await run(withBackImage(descriptor))).findings.find(
      (entry) => entry.rule === "spa.history-back-stale-view");
    expect(imageLead?.imageUrl).toBe("/reports/00000000-0000-0000-0000-000000000000/spa/evidence/back-edge-001.png");
    expect(imageLead?.videoUrl).toBeUndefined();
    expect(imageLead?.testExportUrl).toBeUndefined();
    for (const altered of [
      { ...descriptor, path: "evidence/back-edge-002.png" },
      { ...descriptor, path: "../outside.png" },
      { ...descriptor, sha256: "0".repeat(64) },
      { ...descriptor, byteLength: descriptor.byteLength + 1 },
      { ...descriptor, byteLength: 10_000_000 },
      { ...descriptor, sha256: "f".repeat(64), byteLength: 0 },
    ]) {
      const unavailable = await run(withBackImage(altered));
      const backLead = unavailable.findings.find((entry) => entry.rule === "spa.history-back-stale-view");
      expect(backLead?.imageUrl, JSON.stringify(altered)).toBeUndefined();
      expect(backLead?.spaBackReview).toBeDefined();
      expect(unavailable.limits).toContain("spa-back-image-unavailable");
    }
    await writeFile(join(imageDirectory, "back-edge-001.png"), Buffer.from("not really an image"));
    const replaced = await run(withBackImage({ ...descriptor,
      byteLength: "not really an image".length,
      sha256: createHash("sha256").update("not really an image").digest("hex") }));
    expect(replaced.findings.find((entry) => entry.rule === "spa.history-back-stale-view")?.imageUrl).toBeUndefined();
    expect(replaced.limits).toContain("spa-back-image-unavailable");
    await writeFile(join(imageDirectory, "back-edge-001.png"), png);
    const staleBytes = Buffer.from(png);
    staleBytes[staleBytes.length - 2] = 1;
    await writeFile(join(imageDirectory, "back-edge-001.png"), staleBytes);
    const stale = await run(withBackImage(descriptor));
    expect(stale.findings.find((entry) => entry.rule === "spa.history-back-stale-view")?.imageUrl).toBeUndefined();
    expect(stale.limits).toContain("spa-back-image-unavailable");
    await writeFile(join(imageDirectory, "back-edge-001.png"), png);
    const limited = await run({ ...sample, deferred: [
      { from: forward.id, targetFingerprint: "f".repeat(20), reason: "history-back-limit" },
      sample.deferred[1] as SpaJourneyResult["deferred"][number],
    ] });
    expect(limited.total).toBe(2);
    expect(limited.coverage).toContain("Browser Back checks deferred by probe limit: 1");
    expect(limited.limits).toContain("spa-back-limit");
    expect(limited.limits).toContain("spa-incomplete");
    expect(JSON.stringify(limited)).not.toContain("private.test");
    for (const patch of [
      { historyDelta: 0 },
      { historyDelta: 2 },
      { settledSamples: 1 },
      { expectedStateId: forward.id },
      { observedStateId: start.id },
      { observedStateId: forward.id },
      { expectedRouteIdentity: "8".repeat(20) },
      { observedRouteIdentity: "f".repeat(20) },
      { beforeHeadingFingerprint: "2".repeat(20) },
      { returnedHeadingFingerprint: "1".repeat(20) },
    ]) {
      const malformed: SpaJourneyResult = { ...sample,
        issues: [{ ...issue, historyBack: { ...backProof, ...patch } }, existing] };
      const rejected = await run(malformed);
      expect(rejected.total, JSON.stringify(patch)).toBe(0);
      expect(rejected.extraLinks).toBeUndefined();
      expect(rejected.limits).toContain("spa-review-unavailable");
    }
    for (const forged of [
      { ...issue, evidence: "observed-dom-after-action" as const },
      { ...issue, edgeIndex: 8 },
      { ...issue, stateId: start.id },
      { ...issue, historyBack: undefined },
    ]) {
      const rejected = await run({ ...sample, issues: [forged, existing] } as SpaJourneyResult);
      expect(rejected.total).toBe(0);
      expect(rejected.limits).toContain("spa-review-unavailable");
    }
    // The terminal checkpoint alone is not enough. A state can have a
    // syntactically valid path that was never observed from its parent.
    const child = sample.states[1];
    if (child === undefined) throw new Error("Expected first forward state.");
    const wrongReplay = { ...sample,
      states: sample.states.map((state, index) => index === 1
        ? { ...state, replay: state.replay.map((step) => ({
          ...step, targetFingerprint: "0".repeat(20),
        })) } : state),
    };
    const wrongPath = await run(wrongReplay);
    expect(wrongPath.total).toBe(0);
    expect(wrongPath.limits).toContain("spa-review-unavailable");
    expect(wrongPath.extraLinks).toBeUndefined();

    // A stale graph may preserve the Back headline, count, state cards and
    // #issues anchor while referring to a different return-state witness.
    await run(sample);
    const currentGraph = renderSpaJourneyGraph(sample);
    const oldWitnessGraph = currentGraph.replace(
      `The returned view fingerprint was\n      ${"e".repeat(16)}`,
      `The returned view fingerprint was\n      ${"0".repeat(16)}`,
    );
    expect(oldWitnessGraph).not.toBe(currentGraph);
    await writeFile(join(folder, "graph.html"), oldWitnessGraph);
    const wrongWitness = await readLocalTriage(root,
      "00000000-0000-0000-0000-000000000000", "site", "partial");
    expect(wrongWitness.total).toBe(0);
    expect(wrongWitness.limits).toContain("spa-review-unavailable");
    expect(wrongWitness.extraLinks).toBeUndefined();

    // An old site index is not evidence of this completed/partial run.
    await run(sample);
    await writeFile(join(root, "site-index.json"), JSON.stringify({ ...index, status: "complete" }));
    const oldIndex = await readLocalTriage(root,
      "00000000-0000-0000-0000-000000000000", "site", "partial");
    expect(oldIndex.total).toBe(0);
    expect(oldIndex.limits).toContain("site-index-stale");
    expect(oldIndex.extraLinks).toBeUndefined();
    await run(sample);
    await writeFile(join(folder, "graph.html"),
      renderSpaJourneyGraph(sample).replace("possible stale view after browser Back", "possible expanded-panel mismatch"));
    const staleGraph = await readLocalTriage(root,
      "00000000-0000-0000-0000-000000000000", "site", "partial");
    expect(staleGraph.total).toBe(0);
    expect(staleGraph.extraLinks).toBeUndefined();
    expect(staleGraph.limits).toContain("spa-review-unavailable");
  });

  it("links a nested Back observation only when both forward checkpoints have matching witnessed edges", async () => {
    const root = join(outputRoot, "nested-back-proof");
    await mkdir(join(root, "spa"), { recursive: true });
    const first = "a".repeat(20);
    const middle = "b".repeat(20);
    const last = "c".repeat(20);
    const firstStep = { kind: "anchor" as const, index: 0, targetFingerprint: "f".repeat(20), checkpoint: middle };
    const secondStep = { kind: "anchor" as const, index: 1, targetFingerprint: "e".repeat(20), checkpoint: last };
    const base: SpaJourneyResult = {
      schemaVersion: "tvdoctor.spa-journey/v1", status: "partial",
      targetIdentity: "9".repeat(20),
      states: [
        { id: first, routeIdentity: "1".repeat(20), depth: 0, replay: [], candidatesObserved: 1 },
        { id: middle, routeIdentity: "2".repeat(20), depth: 1, replay: [firstStep], candidatesObserved: 1 },
        { id: last, routeIdentity: "3".repeat(20), depth: 2, replay: [firstStep, secondStep], candidatesObserved: 1 },
      ],
      edges: [
        { from: first, to: middle, kind: "anchor", status: "observed", reason: null,
          targetIndex: 0, targetFingerprint: firstStep.targetFingerprint, replay: [firstStep] },
        { from: middle, to: last, kind: "anchor", status: "observed", reason: null,
          targetIndex: 1, targetFingerprint: secondStep.targetFingerprint, replay: [firstStep, secondStep] },
      ],
      deferred: [{ from: last, targetFingerprint: null, reason: "max-actions" }],
      issues: [{ rule: "spa.history-back-stale-view", stateId: last, edgeIndex: 1,
        confidence: "heuristic", reviewRequired: true, evidence: "observed-dom-after-history-back",
        historyBack: { expectedStateId: middle, observedStateId: "d".repeat(20),
          expectedRouteIdentity: "2".repeat(20), observedRouteIdentity: "2".repeat(20),
          beforeHeadingFingerprint: "4".repeat(20), forwardHeadingFingerprint: "5".repeat(20),
          returnedHeadingFingerprint: "5".repeat(20), historyDelta: 1, settledSamples: 2 } }],
      terminationReasons: ["max-actions"], actionsUsed: 11, replayActions: 4, driftCount: 0,
      unsafeRequestsBlocked: 0, unsafeCandidatesSkipped: 0, candidatesTruncated: false,
      budgets: { maxStates: 5, maxActions: 20, maxDepth: 3, maxDurationMs: 15_000 },
    };
    const id = "00000000-0000-0000-0000-000000000000";
    const index = {
      schemaVersion: "tvdoctor.site-index/v1", status: "partial", pagesScanned: 0,
      pagesDiscovered: 0, maxPages: 1, routes: [], pendingRoutes: ["https://private.test/SECRET"],
      spaJourney: { status: "partial", graphPath: "spa/graph.html",
        reportPath: "spa/spa-journey.json", statesObserved: 3, transitionsTested: 2,
        deferredStates: 1, reviewLeads: 1 },
    };
    await writeFile(join(root, "site-index.json"), JSON.stringify(index));
    const check = async (value: SpaJourneyResult): Promise<Awaited<ReturnType<typeof readLocalTriage>>> => {
      await writeFile(join(root, "spa", "spa-journey.json"), JSON.stringify(value));
      await writeFile(join(root, "spa", "graph.html"), renderSpaJourneyGraph(value));
      return await readLocalTriage(root, id, "site", "partial");
    };
    const valid = await check(base);
    expect(valid.total).toBe(1);
    expect(valid.status).toBe("partial");
    expect(valid.limits).toEqual(expect.arrayContaining(["routes-deferred", "spa-states-deferred", "spa-incomplete"]));
    expect(valid.findings[0]?.spaBackReview).toMatchObject({
      expectedStateNumber: 2, forwardStateNumber: 3, forwardEdgeNumber: 2,
      recordedForwardSetupSteps: 2, observedBackTransitions: 1,
      settledSamples: 2, reviewRequired: true,
    });
    expect(valid.findings[0]?.spaReview).toBeUndefined();
    expect(JSON.stringify(valid)).not.toContain("SECRET");
    for (const broken of [
      { ...base, states: base.states.map((state, i) => i === 2
        ? { ...state, replay: [{ ...firstStep, targetFingerprint: "0".repeat(20) }, secondStep] } : state) },
      { ...base, edges: base.edges.map((edge, i) => i === 0
        ? { ...edge, from: last } : edge) },
      { ...base, edges: base.edges.map((edge, i) => i === 1
        ? { ...edge, replay: [{ ...firstStep, index: 2 }, secondStep] } : edge) },
      { ...base, edges: base.edges.map((edge, i) => i === 1
        ? { ...edge, reason: "https://private.test/SECRET" } : edge) },
      { ...base, actionsUsed: "https://private.test/SECRET" },
    ]) {
      const rejected = await check(broken as SpaJourneyResult);
      expect(rejected.total).toBe(0);
      expect(rejected.extraLinks).toBeUndefined();
      expect(rejected.limits).toContain("spa-review-unavailable");
      expect(JSON.stringify(rejected)).not.toContain("SECRET");
    }
  });

  it("validates saved two-Back ancestry and signed image evidence, rejecting forged associations", async () => {
    {
      const root = join(outputRoot, "chromium-two-back");
      const folder = join(root, "spa");
      await mkdir(folder, { recursive: true });
      // This is a saved-report integrity fixture for the two observed forward
      // anchors and separate two-Back witness contract. Actual Chromium Back
      // transitions are exercised in spa-journey.test.ts against v2 lab.
      const ancestorId = "a".repeat(20);
      const intermediateId = "b".repeat(20);
      const finalId = "c".repeat(20);
      const firstStep = { index: 0, kind: "anchor" as const,
        targetFingerprint: "f".repeat(20), checkpoint: intermediateId };
      const finalStep = { index: 1, kind: "anchor" as const,
        targetFingerprint: "e".repeat(20), checkpoint: finalId };
      const witnessPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
        "base64",
      );
      const screenshot = { path: "evidence/back-interrupted-edge-002.png", byteLength: witnessPng.byteLength,
        sha256: createHash("sha256").update(witnessPng).digest("hex") };
      await mkdir(join(folder, "evidence"));
      await writeFile(join(folder, screenshot.path), witnessPng);
      const actual: SpaJourneyResult = {
        schemaVersion: "tvdoctor.spa-journey/v1", status: "partial", targetIdentity: "9".repeat(20),
        states: [
          { id: ancestorId, routeIdentity: "1".repeat(20), depth: 0, replay: [], candidatesObserved: 1 },
          { id: intermediateId, routeIdentity: "2".repeat(20), depth: 1,
            replay: [firstStep], candidatesObserved: 1 },
          { id: finalId, routeIdentity: "3".repeat(20), depth: 2,
            replay: [firstStep, finalStep], candidatesObserved: 1 },
        ],
        edges: [
          { from: ancestorId, to: intermediateId, kind: "anchor", targetIndex: 0,
            targetFingerprint: firstStep.targetFingerprint, status: "observed", reason: null,
            replay: [firstStep] },
          { from: intermediateId, to: finalId, kind: "anchor", targetIndex: 1,
            targetFingerprint: finalStep.targetFingerprint, status: "observed", reason: null,
            replay: [firstStep, finalStep] },
        ],
        deferred: [{ from: finalId, targetFingerprint: null, reason: "max-actions" }],
        issues: [{
          rule: "spa.history-back-interrupted-stale-view", stateId: finalId,
          edgeIndex: 1, confidence: "heuristic", reviewRequired: true,
          evidence: "observed-dom-after-interrupted-history-back",
          historyBack: {
            expectedStateId: ancestorId, observedStateId: "d".repeat(20),
            expectedRouteIdentity: "1".repeat(20), observedRouteIdentity: "1".repeat(20),
            beforeHeadingFingerprint: "4".repeat(20), forwardHeadingFingerprint: "5".repeat(20),
            returnedHeadingFingerprint: "5".repeat(20), historyDelta: 2, settledSamples: 2,
            interruptedBack: { intermediateStateId: intermediateId,
              intermediateRouteIdentity: "2".repeat(20), finalForwardStateId: finalId },
            screenshot,
          },
        }],
        terminationReasons: ["max-actions"], actionsUsed: 14, replayActions: 4, driftCount: 0,
        unsafeRequestsBlocked: 0, unsafeCandidatesSkipped: 0, candidatesTruncated: false,
        budgets: { maxStates: 5, maxActions: 20, maxDepth: 3, maxDurationMs: 15_000 },
      };
      const issue = actual.issues.find((item) => item.rule === "spa.history-back-interrupted-stale-view");
      expect(issue, JSON.stringify({ status: actual.status, deferred: actual.deferred, issues: actual.issues })).toBeDefined();
      if (issue?.historyBack?.interruptedBack === undefined) throw new Error("Invalid saved two-Back sample");
      const back = issue.historyBack;
      if (back.interruptedBack === undefined) throw new Error("Missing intermediate Back witness");
      const middleWitness = back.interruptedBack;
      const finalEdge = actual.edges[issue.edgeIndex];
      const ancestor = actual.states.find((state) => state.id === back.expectedStateId);
      const intermediate = actual.states.find((state) => state.id === middleWitness.intermediateStateId);
      const final = actual.states.find((state) => state.id === issue.stateId);
      if (ancestor === undefined || intermediate === undefined || final === undefined) {
        throw new Error("Two-Back forward checkpoint states missing");
      }
      expect(finalEdge?.from).toBe(middleWitness.intermediateStateId);
      expect(finalEdge?.to).toBe(issue.stateId);
      expect(ancestor?.routeIdentity).toBe(back.expectedRouteIdentity);
      expect(intermediate?.routeIdentity).toBe(middleWitness.intermediateRouteIdentity);
      expect(final?.routeIdentity).not.toBe(back.expectedRouteIdentity);
      const id = "00000000-0000-0000-0000-000000000000";
      const site = { schemaVersion: "tvdoctor.site-index/v1", status: actual.status,
        routes: [], pendingRoutes: [], spaJourney: {
          status: actual.status, reportPath: "spa/spa-journey.json", graphPath: "spa/graph.html",
          statesObserved: actual.states.length,
          transitionsTested: actual.edges.filter((edge) => edge.status === "observed").length,
          deferredStates: actual.deferred.length, reviewLeads: actual.issues.length,
        } };
      await writeFile(join(root, "site-index.json"), JSON.stringify(site));
      const check = async (saved: SpaJourneyResult): Promise<Awaited<ReturnType<typeof readLocalTriage>>> => {
        await writeFile(join(folder, "spa-journey.json"), JSON.stringify(saved));
        await writeFile(join(folder, "graph.html"), renderSpaJourneyGraph(saved));
        return await readLocalTriage(root, id, "site", actual.status);
      };
      const valid = await check(actual);
      const finding = valid.findings.find((entry) => entry.rule === issue.rule);
      expect(finding, JSON.stringify(valid.limits)).toMatchObject({
        confidence: "heuristic", severity: "unrated", source: "Experimental SPA · REVIEW",
        reportUrl: "/reports/" + id + "/spa/graph.html#issues",
        spaBackReview: {
          expectedStateNumber: actual.states.indexOf(ancestor) + 1,
          intermediateStateNumber: actual.states.indexOf(intermediate) + 1,
          forwardStateNumber: actual.states.indexOf(final) + 1,
          forwardEdgeNumber: issue.edgeIndex + 1,
          recordedForwardSetupSteps: finalEdge?.replay.length,
          observedBackTransitions: 2, settledSamples: 2, reviewRequired: true,
        },
      });
      expect(finding?.spaReview).toBeUndefined();
      expect(finding?.videoUrl).toBeUndefined();
      expect(finding?.testExportUrl).toBeUndefined();
      expect(valid.limits).not.toContain("spa-review-unavailable");
      const shot = back.screenshot;
      if (shot === undefined) throw new Error("Genuine two-Back screenshot missing");
      expect(shot.path).toBe("evidence/back-interrupted-edge-" + String(issue.edgeIndex + 1).padStart(3, "0") + ".png");
      const png = await readFile(join(folder, shot.path));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.byteLength).toBe(shot.byteLength);
      expect(createHash("sha256").update(png).digest("hex")).toBe(shot.sha256);
      expect(finding?.imageUrl).toBe("/reports/" + id + "/spa/" + shot.path);
      expect(JSON.stringify(valid)).not.toContain("private.test");

      const swapped = (value: SpaJourneyResult["issues"][number]): SpaJourneyResult => ({
        ...actual, issues: actual.issues.map((entry) => entry === issue ? value : entry),
      });
      for (const altered of [
        { historyDelta: 1 }, { settledSamples: 1 },
        { expectedStateId: middleWitness.intermediateStateId },
        { observedStateId: back.expectedStateId },
        { observedStateId: middleWitness.intermediateStateId },
        { expectedRouteIdentity: middleWitness.intermediateRouteIdentity },
        { observedRouteIdentity: middleWitness.intermediateRouteIdentity },
        { beforeHeadingFingerprint: back.forwardHeadingFingerprint },
        { returnedHeadingFingerprint: back.beforeHeadingFingerprint },
        { interruptedBack: { ...middleWitness, intermediateStateId: back.expectedStateId } },
        { interruptedBack: { ...middleWitness, finalForwardStateId: back.expectedStateId } },
        { interruptedBack: { ...middleWitness, intermediateRouteIdentity: back.expectedRouteIdentity } },
        { interruptedBack: undefined },
      ]) {
        const malformedBack = { ...back, ...altered } as unknown as NonNullable<typeof issue.historyBack>;
        const rejected = await check(swapped({ ...issue, historyBack: malformedBack }));
        expect(rejected.findings.some((entry) => entry.rule === issue.rule), JSON.stringify(altered)).toBe(false);
        expect(rejected.limits).toContain("spa-review-unavailable");
      }
      for (const changed of [
        swapped({ ...issue, evidence: "observed-dom-after-history-back" }),
        swapped({ ...issue, rule: "spa.history-back-stale-view" }),
        { ...actual, edges: actual.edges.map((edge, index) => index === issue.edgeIndex
          ? { ...edge, from: back.expectedStateId } : edge) },
        { ...actual, edges: actual.edges.map((edge) => edge.to === middleWitness.intermediateStateId
          ? { ...edge, from: middleWitness.intermediateStateId } : edge) },
        { ...actual, edges: actual.edges.map((edge) => edge.to === middleWitness.intermediateStateId
          ? { ...edge, replay: edge.replay.map((step, index) => index === 0
            ? { ...step, index: 47 } : step) } : edge) },
      ]) {
        const rejected = await check(changed);
        expect(rejected.findings.some((entry) => entry.rule === issue.rule)).toBe(false);
        expect(rejected.limits).toContain("spa-review-unavailable");
      }
      for (const screenshot of [
        { ...shot, path: "evidence/back-edge-" + String(issue.edgeIndex + 1).padStart(3, "0") + ".png" },
        { ...shot, path: "evidence/back-interrupted-edge-999.png" },
        { ...shot, path: "../outside.png" },
        { ...shot, byteLength: shot.byteLength + 1 },
        { ...shot, sha256: "0".repeat(64) },
      ]) {
        const changed = await check(swapped({ ...issue, historyBack: { ...back, screenshot } }));
        expect(changed.findings.find((entry) => entry.rule === issue.rule)?.imageUrl).toBeUndefined();
        expect(changed.limits).toContain("spa-back-image-unavailable");
      }
      await writeFile(join(folder, shot.path), Buffer.from("not a PNG"));
      const fakePng = await check(swapped({ ...issue, historyBack: { ...back, screenshot: {
        ...shot, byteLength: 9, sha256: createHash("sha256").update("not a PNG").digest("hex"),
      } } }));
      expect(fakePng.findings.find((entry) => entry.rule === issue.rule)?.imageUrl).toBeUndefined();
      expect(fakePng.limits).toContain("spa-back-image-unavailable");
      const unchecked = { ...actual, deferred: [...actual.deferred, {
        from: issue.stateId, targetFingerprint: null, reason: "history-back-interruption-unchecked" as const,
      }] };
      await writeFile(join(root, "site-index.json"), JSON.stringify({
        ...site, spaJourney: { ...site.spaJourney, deferredStates: unchecked.deferred.length },
      }));
      const partial = await check(unchecked);
      expect(partial.coverage, JSON.stringify({ status: actual.status,
        limits: partial.limits, coverage: partial.coverage })).toContain("Rapid two-Back checks deferred or incomplete: 1");
      expect(partial.limits).toContain("spa-back-interruption-unchecked");
    }
  });

  it("triages a browser-observed Back-stale-heading finding from a real Chromium run without replay promotion", async () => {
    const requests: string[] = [];
    const fixture = createServer((request, response) => {
      requests.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
      if (request.url !== "/browser-back") {
        response.writeHead(404).end("No fixture");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><body><main>
      <h1 id="heading">SECRET-PRIVATE-HEADING original page</h1>
      <a href="/next" id="go">Next safe view</a>
      </main><script>
      document.getElementById("go").addEventListener("click", event => {
        event.preventDefault();history.pushState({}, "", "/next");
        document.getElementById("heading").textContent = "SECRET-PRIVATE-HEADING forward page";
      });
      </script></body></html>`);
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    try {
      const address = fixture.address();
      if (address === null || typeof address === "string") throw new Error("Fixture address unavailable.");
      const root = join(outputRoot, "browser-back-real");
      await mkdir(root);
      const run = await runSpaJourneyScan({
        target: `http://127.0.0.1:${String(address.port)}/browser-back`,
        outputDirectory: join(root, "spa"),
        maxStates: 5, maxActions: 20, maxDepth: 3, maxDurationMs: 20_000,
      });
      expect(run.issues.some((item) => item.rule === "spa.history-back-stale-view"),
        JSON.stringify({ status: run.status, reasons: run.terminationReasons, edges: run.edges.length })).toBe(true);
      await writeFile(join(root, "spa", "graph.html"), renderSpaJourneyGraph(run));
      await writeFile(join(root, "site-index.json"), JSON.stringify({
        schemaVersion: "tvdoctor.site-index/v1", status: "partial",
        routes: [], pendingRoutes: [],
        spaJourney: { status: run.status,
          statesObserved: run.states.length,
          transitionsTested: run.edges.filter((edge) => edge.status === "observed").length,
          deferredStates: run.deferred.length, reviewLeads: run.issues.length,
          graphPath: "spa/graph.html", reportPath: "spa/spa-journey.json" },
      }));
      const triage = await readLocalTriage(root, "00000000-0000-0000-0000-000000000000", "site", "partial");
      const issue = triage.findings.find((item) => item.rule === "spa.history-back-stale-view");
      expect(issue, JSON.stringify({ limits: triage.limits, total: triage.total })).toBeDefined();
      const observedBack = run.issues.find((item) => item.rule === "spa.history-back-stale-view");
      const image = observedBack?.historyBack?.screenshot;
      expect(image).toMatchObject({
        path: `evidence/back-edge-${String((observedBack?.edgeIndex ?? -2) + 1).padStart(3, "0")}.png`,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        byteLength: expect.any(Number),
      });
      if (image === undefined) throw new Error("Genuine browser Back screenshot not captured.");
      const bytes = await readFile(join(root, "spa", image.path));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.length).toBe(image.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.sha256);
      expect(issue?.imageUrl).toBe(`/reports/00000000-0000-0000-0000-000000000000/spa/${image.path}`);
      expect(issue?.videoUrl).toBeUndefined();
      expect(issue?.spaBackReview).toMatchObject({
        observedBackTransitions: 1, settledSamples: 2, reviewRequired: true,
      });
      expect(issue?.spaReview).toBeUndefined();
      expect(issue?.confidence).toBe("heuristic");
      expect(issue?.severity).toBe("unrated");
      expect(issue?.reportUrl).toMatch(/\/spa\/graph\.html#issues$/u);
      expect(JSON.stringify(triage)).not.toContain("SECRET-PRIVATE-HEADING");
      expect(JSON.stringify(triage)).not.toContain(String(address.port));
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((entry) => entry === "GET /browser-back")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => fixture.close((error) =>
        error === undefined ? resolve() : reject(error)));
    }
  }, 40_000);

  it("refuses a SPA graph symlink that resolves outside its owned report root", async () => {
    const root = join(outputRoot, "symlink-spa");
    const folder = join(root, "spa");
    await mkdir(folder, { recursive: true });
    const sample = savedSpaFixture();
    const external = join(outputRoot, "other-graph.html");
    await writeFile(external, renderSpaJourneyGraph(sample));
    await writeFile(join(folder, "spa-journey.json"), JSON.stringify(sample));
    await writeFile(join(root, "site-index.json"), JSON.stringify({
      schemaVersion: "tvdoctor.site-index/v1", status: "partial",
      routes: [], pendingRoutes: [],
      spaJourney: {
        status: sample.status, reportPath: "spa/spa-journey.json",
        graphPath: "spa/graph.html", statesObserved: sample.states.length,
        transitionsTested: sample.edges.length, deferredStates: sample.deferred.length,
        reviewLeads: sample.issues.length,
      },
    }));
    try {
      await symlink(external, join(folder, "graph.html"), "file");
    } catch (error) {
      // Windows hosts without symlink permissions cannot construct this case.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const triage = await readLocalTriage(root, "00000000-0000-0000-0000-000000000000", "site", "partial");
    expect(triage.total).toBe(0);
    expect(triage.limits).toContain("spa-review-unavailable");
    expect(triage.extraLinks).toBeUndefined();
  });

  it("triages a real saved Chromium SPA journey without promoting heuristic leads", async () => {
    const fixture = createServer((_req, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><body>
        <main><h1>Local UI</h1>
        <button id="menu" type="button" aria-haspopup="menu" aria-controls="items" aria-expanded="false">Open menu</button>
        <nav id="items" role="menu" hidden><span>Menu options</span></nav>
        </main><script>const button=document.getElementById("menu");
        button.addEventListener("click",()=>{const panel=document.getElementById("items"); panel.hidden=!panel.hidden;});
        </script></body></html>`);
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    try {
      const address = fixture.address();
      if (address === null || typeof address === "string") throw new Error("Missing local fixture address.");
      const root = join(outputRoot, "real-spa");
      await mkdir(root);
      const journey = await runSpaJourneyScan({
        target: `http://127.0.0.1:${String(address.port)}/`,
        outputDirectory: join(root, "spa"),
        maxStates: 4, maxActions: 24, maxDepth: 2, maxDurationMs: 18_000,
      });
      expect(journey.issues.length, JSON.stringify({
        status: journey.status, reasons: journey.terminationReasons,
        states: journey.states.length, edges: journey.edges.length,
      })).toBeGreaterThan(0);
      await writeFile(join(root, "spa", "graph.html"), renderSpaJourneyGraph(journey));
      await writeFile(join(root, "site-index.json"), JSON.stringify({
        schemaVersion: "tvdoctor.site-index/v1", status: "partial", routes: [], pendingRoutes: [],
        spaJourney: {
          status: journey.status, reportPath: "spa/spa-journey.json", graphPath: "spa/graph.html",
          statesObserved: journey.states.length,
          transitionsTested: journey.edges.filter((edge) => edge.status === "observed").length,
          deferredStates: journey.deferred.length, reviewLeads: journey.issues.length,
        },
      }));
      const triage = await readLocalTriage(root, "00000000-0000-0000-0000-000000000000", "site", "partial");
      expect(triage.total).toBe(journey.issues.length);
      expect(triage.findings).toHaveLength(journey.issues.length);
      expect(triage.findings.every((issue) => issue.rule === "spa.expanded-panel-mismatch"
        && issue.confidence === "heuristic" && issue.severity === "unrated"
        && issue.spaReview?.reviewRequired === true
        && issue.reportUrl?.endsWith("/spa/graph.html#issues") === true)).toBe(true);
      for (const finding of triage.findings) {
        expect(finding.spaReview?.verifiedCheckpoints).toBeGreaterThan(0);
        expect(finding.spaReview?.stateReplaySteps).toBeGreaterThan(0);
      }
      expect(triage.limits).not.toContain("spa-review-unavailable");
      expect(JSON.stringify(triage)).not.toContain(String(address.port));
      expect(JSON.stringify(triage)).not.toContain("Menu options");
    } finally {
      await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    }
  }, 40_000);

  it("triages responsive heuristics as unrated and rejects malicious screenshot paths", async () => {
    const { csrf, url } = await newServer(async (request) => {
      const outcome = await createReport(request);
      await mkdir(join(request.outputPath, "responsive", "mobile"), { recursive: true });
      await writeFile(join(request.outputPath, "responsive", "mobile", "page-01.png"), "actual image");
      const valid = {
        id: "responsive-example-1", rule: "responsive.document-overflow",
        viewport: "mobile", routeIdentity: "opaque-route", confidence: "heuristic",
        reviewRequired: true, screenshot: "responsive/mobile/page-01.png",
      };
      await writeFile(join(request.outputPath, "responsive-result.json"), JSON.stringify({
        status: "partial", pagesDiscovered: 4, pagesDeferred: 3,
        terminationReasons: ["page-limit"],
        pages: [
          { status: "completed", viewport: "mobile", routeIdentity: "opaque-route",
            screenshotStatus: "available", screenshot: "responsive/mobile/page-01.png",
            findings: [valid] },
          { status: "failed" },
        ],
        findings: [
          valid,
          { ...valid, id: "forged-2", rule: "responsive.offscreen-control", screenshot: "../../outside.png" },
          { ...valid, id: "forged-3", rule: "responsive.offscreen-control", screenshot: "https://evil.test/file.png" },
        ],
      }));
      const base = outcome.result;
      if (base === null) throw new Error("Fixture result missing.");
      return { ...outcome, result: {
        ...base, status: "partial",
        reportPath: join(request.outputPath, "responsive-result.json"),
      } };
    });
    expect((await post(url, csrf, {
      type: "responsive", url: "https://example.test/", mode: "quick", input: "keyboard", viewportProfile: "all",
    })).status).toBe(202);
    const finished = await waitForState(url, "partial");
    const triage = finished["triage"] as Record<string, unknown>;
    expect(triage["groups"]).toEqual([{ severity: "unrated", confidence: "heuristic", count: 1 }]);
    expect(triage["total"]).toBe(1);
    const findings = triage["findings"] as Record<string, unknown>[];
    expect(findings[0]?.["imageUrl"]).toBe(`/reports/${String(finished["id"])}/responsive/mobile/page-01.png`);
    expect(findings[1]?.["imageUrl"]).toBeUndefined();
    expect(findings[2]?.["imageUrl"]).toBeUndefined();
    expect(triage["limits"]).toEqual(expect.arrayContaining([
      "routes-deferred", "page-limit", "responsive-incomplete", "responsive-pages-failed",
      "responsive-finding-evidence-unmatched",
    ]));
  });

  it("links only the route-owned scrolled viewport evidence, never a different route slot", async () => {
    const root = join(outputRoot, "scrolled-responsive");
    const folder = join(root, "responsive", "mobile");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "page-01.png"), "unscrolled state");
    await writeFile(join(folder, "page-51.png"), "nested-scroll state");
    const id = "00000000-0000-0000-0000-000000000000";
    const lead = {
      id: "responsive-scroll-1", rule: "responsive.obscured-control",
      viewport: "mobile", routeIdentity: "opaque-route", confidence: "heuristic",
      reviewRequired: true, screenshot: "responsive/mobile/page-51.png",
    };
    const page = {
      status: "completed", viewport: "mobile", routeIdentity: "opaque-route",
      screenshotStatus: "available", screenshot: "responsive/mobile/page-01.png",
      findings: [lead],
    };
    const saved = { status: "partial", pagesDiscovered: 2, pagesDeferred: 1,
      terminationReasons: ["page-limit"], pages: [page], findings: [lead] };
    await writeFile(join(root, "responsive-result.json"), JSON.stringify(saved));
    const reviewed = await readLocalTriage(root, id, "responsive", "partial");
    expect(reviewed.total).toBe(1);
    expect(reviewed.findings[0]?.imageUrl).toBe(`/reports/${id}/responsive/mobile/page-51.png`);
    expect(reviewed.findings[0]?.confidence).toBe("heuristic");

    // page-52 is syntactically safe but belongs to the second route, not this
    // finding's page-01 baseline. The forged report must not get a link.
    const forged = { ...lead, screenshot: "responsive/mobile/page-52.png" };
    await writeFile(join(root, "responsive-result.json"), JSON.stringify({
      ...saved, pages: [{ ...page, findings: [forged] }], findings: [forged],
    }));
    const rejected = await readLocalTriage(root, id, "responsive", "partial");
    expect(rejected.total).toBe(0);
    expect(rejected.limits).toContain("responsive-finding-evidence-unmatched");
  });

  it("bounds report extraction and does not trust oversized or symlinked report files", async () => {
    const directory = join(outputRoot, "triage");
    await mkdir(directory);
    await writeFile(join(directory, "report.json"), "x".repeat(6 * 1024 * 1024 + 1));
    let triage = await readLocalTriage(directory, "00000000-0000-0000-0000-000000000000", "navigation", "partial");
    expect(triage.total).toBe(0);
    expect(triage.limits).toContain("navigation-report-unavailable");
    await writeFile(join(directory, "report.json"), JSON.stringify({
      schemaVersion: "tvdoctor.report/v1", run: { status: "completed" },
      issues: Array.from({ length: 110 }, (_, i) => ({
        id: "TVDOCTOR-TEST-" + i, rule: "test.rule", title: "An issue", severity: "low", confidence: "heuristic",
      })),
    }));
    triage = await readLocalTriage(directory, "00000000-0000-0000-0000-000000000000", "navigation", "completed");
    expect(triage.total).toBe(110);
    expect(triage.findings).toHaveLength(80);
    expect(triage.omitted).toBe(30);
    expect(triage.groups).toEqual([{ severity: "low", confidence: "heuristic", count: 110 }]);
  });

  it("only permits opt-in experimental discovery on site scans", async () => {
    const captures: LocalUiScanRequest[] = [];
    const { csrf, url } = await newServer(async (request) => {
      captures.push(request);
      return await createReport(request);
    });
    const base = { url: "https://example.test/", mode: "quick", input: "keyboard" };
    expect((await post(url, csrf, { ...base, type: "navigation", exploreSpa: true })).status).toBe(400);
    expect((await post(url, csrf, { ...base, type: "site", maxRoutes: 5, exploreSpa: "true" })).status).toBe(400);
    expect((await post(url, csrf, { ...base, type: "site", maxRoutes: 5, exploreSpa: true })).status).toBe(202);
    await waitForState(url, "completed");
    expect(captures[0]?.exploreSpa).toBe(true);
  });
  it("embeds a syntactically valid browser script without external script or style dependencies", () => {
    const html = renderLocalUiPage("tokenForUnitTest");
    const source = /<script nonce="tokenForUnitTest">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(source).toBeDefined();
    expect(() => new Script(source ?? "")).not.toThrow();
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("<link rel=\"stylesheet\"");
    expect(html).toContain("Load local Back screenshot");
    expect(html).toContain("back-edge-[0-9]{3}");
    expect(html).toContain("back-interrupted-edge-[0-9]{3}");
    expect(html).toContain("pair of rapid, genuine Chromium browser Back actions");
  });

  it("keeps generated report HTML inert and strips malformed evidence destinations", () => {
    const page = renderLocalUiOverview({
      title: "Responsive <private>",
      status: "partial",
      kind: "responsive",
      summary: ["Routes <script>alert('private')</script>"],
      entries: [
        { label: "<img src=x onerror=alert(1)>", status: "failed", findings: 1,
          artifact: "../../leak.png", preview: true },
        { label: "Viewport 01", status: "completed", findings: 0,
          artifact: "responsive/mobile/page-01.png", preview: true },
      ],
    });
    expect(page).toContain("&lt;private&gt;");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("href=\"./../../leak.png\"");
    expect(page).not.toContain("src=\"./../../leak.png\"");
    expect(page).toContain('src="./responsive/mobile/page-01.png"');
  });

  it("runs the requested scanner with bounded mode and input, and serves only that job's reports", async () => {
    const requests: LocalUiScanRequest[] = [];
    const { csrf, url } = await newServer(async (request) => {
      requests.push(request);
      return await createReport(request);
    });
    const started = await post(url, csrf, {
      url: "https://private.example/path?apiKey=secret",
      mode: "standard", input: "keyboard", recordVideo: true,
    });
    expect(started.status).toBe(202);
    const job = await waitForState(url, "completed");
    expect(requests).toMatchObject([{
      target: "https://private.example/path?apiKey=secret",
      mode: "standard", input: "keyboard", recordVideo: true,
    }]);
    expect(job).toMatchObject({ state: "completed", issueCount: 2, highestSeverity: "high" });
    expect(JSON.stringify(job)).not.toContain("private.example");
    expect(JSON.stringify(job)).not.toContain("secret");
    expect(await (await fetch(url)).text()).not.toContain("private.example");
    const reportUrl = job["reportUrl"] as string;
    expect(await (await fetch(url + reportUrl)).text()).toContain("Local report");
    expect(job["graphUrl"]).toMatch(/navigation-graph\.html$/u);
    const graph = await fetch(url + String(job["graphUrl"]));
    expect(graph.status).toBe(200);
    expect(graph.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(job["videoUrl"]).toMatch(/video\/audit-session\.webm$/u);
    expect(await (await fetch(url + String(job["videoUrl"]))).text()).toBe("recording");
    const slice = await fetch(url + String(job["videoUrl"]), { headers: { Range: "bytes=2-4" } });
    expect(slice.status).toBe(206);
    expect(slice.headers.get("content-range")).toBe("bytes 2-4/9");
    expect(slice.headers.get("accept-ranges")).toBe("bytes");
    expect(await slice.text()).toBe("cor");
    const tail = await fetch(url + String(job["videoUrl"]), { headers: { Range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(await tail.text()).toBe("ing");
    const invalid = await fetch(url + String(job["videoUrl"]), { headers: { Range: "bytes=9-12" } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */9");
    const firstRequest = requests[0];
    if (firstRequest === undefined) throw new Error("Expected first request.");
    expect(await readFile(join(firstRequest.outputPath, "report.json"), "utf8")).toBe("{}");
  });

  it("rejects hostile Host, Origin, CSRF tokens, content types and oversized bodies", async () => {
    const { csrf, url } = await newServer();
    expect(await rawGet(url, "/", { Host: "attacker.example" })).toBe(403);
    expect((await fetch(url, { headers: { Origin: "https://attacker.example" } })).status).toBe(403);
    expect((await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    const body = { url: "https://example.test/", mode: "quick", input: "remote" };
    expect((await post(url, csrf, body, { Origin: "https://attacker.example" })).status).toBe(403);
    expect((await post(url, "incorrect", body)).status).toBe(403);
    expect((await post(url, csrf, body, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post(url, csrf, { ...body, extra: "x".repeat(5000) })).status).toBe(413);
    expect(await (await fetch(`${url}/api/status`)).json()).toEqual({ state: "idle" });
  });

  it("rejects invalid scan fields and concurrent starts without invoking a second scan", async () => {
    let accept: ((outcome: LocalUiScanOutcome) => void) | undefined;
    const requests: LocalUiScanRequest[] = [];
    const { csrf, url } = await newServer(async (request) => {
      requests.push(request);
      return await new Promise<LocalUiScanOutcome>((resolve) => { accept = resolve; });
    });
    const body = { url: "https://example.test/", mode: "quick", input: "remote" };
    for (const bad of [
      { ...body, url: "file:///etc/passwd" },
      { ...body, url: "https://user:pass@example.test/" },
      { ...body, url: "https://example.test/\nInjected" },
      { ...body, mode: "everything" },
      { ...body, input: "shell" },
      { ...body, recordVideo: "true" },
      { ...body, extra: "unknown" },
    ]) {
      expect((await post(url, csrf, bad)).status).toBe(400);
    }
    expect((await post(url, csrf, body)).status).toBe(202);
    expect((await post(url, csrf, body)).status).toBe(409);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.recordVideo).toBe(false);
    accept?.(SCAN_RESULT);
    const finished = await waitForState(url, "completed");
    expect(finished["reportUrl"]).toBeUndefined();
  });

  it("blocks traversal, arbitrary files, and report links outside the scan's output folder", async () => {
    const { csrf, url } = await newServer();
    expect((await post(url, csrf, { url: "https://example.test/", input: "remote", mode: "quick" })).status).toBe(202);
    const job = await waitForState(url, "completed");
    const base = `${url}/reports/${String(job["id"])}/`;
    for (const path of [
      "../report.html", "%2e%2e/report.html", "%252e%252e/report.html",
      "video/%2e%2e/report.html", "%2Fetc%2Fpasswd", "report.json.bak", ".env",
    ]) {
      expect(await rawGet(url, new URL(base).pathname + path), path).toBe(404);
    }
    expect((await fetch(`${url}/reports/00000000-0000-0000-0000-000000000000/report.html`)).status).toBe(404);
    expect((await fetch(`${url}/api/no-such-route`)).status).toBe(404);
  });

  it("does not disclose arbitrary result paths returned by a scanner", async () => {
    const { csrf, url } = await newServer(async (request) => ({
      exitCode: 3,
      result: {
        status: "partial", issueCount: 0, highestSeverity: null,
        reportPath: join(dirname(request.outputPath), "private-sibling", "report.json"),
        details: ["Private token https://secret.example/private"],
      },
    }));
    expect((await post(url, csrf, { url: "https://example.test/", input: "keyboard", mode: "deep" })).status).toBe(202);
    const job = await waitForState(url, "partial");
    expect(job["reportUrl"]).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("secret.example");
    expect(job["message"]).toContain("Partial");
  });

  it("accepts bounded site and responsive options and publishes only observed coverage numbers", async () => {
    const requests: LocalUiScanRequest[] = [];
    const { csrf, url } = await newServer(async (request) => {
      requests.push(request);
      return {
        ...await createReport(request),
        metrics: request.type === "site"
          ? { routesVisited: 3, routesLimit: 8, routesDiscovered: 5 }
          : { viewportsTested: 2, viewportsRequested: 3 },
      };
    });
    const body = { url: "https://example.test/", input: "keyboard", mode: "quick", recordVideo: false };
    expect((await post(url, csrf, { ...body, type: "site", maxRoutes: 8 })).status).toBe(202);
    const site = await waitForState(url, "completed");
    expect(site).toMatchObject({
      type: "site", maxRoutes: 8,
      metrics: { routesVisited: 3, routesLimit: 8, routesDiscovered: 5 },
    });
    expect(site["metrics"]).not.toHaveProperty("viewportsTested");
    expect((await post(url, csrf, {
      ...body, type: "responsive", viewportProfile: "all",
    })).status).toBe(202);
    const responsive = await waitForState(url, "completed");
    expect(responsive).toMatchObject({
      type: "responsive", viewportProfile: "all",
      metrics: { viewportsTested: 2, viewportsRequested: 3 },
    });
    expect(requests).toMatchObject([
      { type: "site", maxRoutes: 8, recordVideo: false },
      { type: "responsive", viewportProfile: "all", recordVideo: false },
    ]);
  });

  it("serves optional evidence links only after validating their paths and existence", async () => {
    const { csrf, url } = await newServer(async (request) => {
      const report = await createReport(request);
      await mkdir(join(request.outputPath, "responsive", "mobile"), { recursive: true });
      await writeFile(join(request.outputPath, "responsive", "mobile", "page-01.png"), "PNG");
      return {
        ...report,
        evidencePaths: [
          "../secret.png", "responsive/%2e%2e/secret.png", "responsive/mobile/absent.png",
          "responsive/mobile/page-01.png", "video/audit-session.webm",
        ],
      };
    });
    expect((await post(url, csrf, { url: "https://example.test/", input: "keyboard", mode: "quick" })).status).toBe(202);
    const job = await waitForState(url, "completed");
    expect(job["evidenceUrls"]).toEqual([
      `/reports/${String(job["id"])}/responsive/mobile/page-01.png`,
    ]);
    expect(await (await fetch(url + String((job["evidenceUrls"] as string[])[0]))).text()).toBe("PNG");
  });

  it("rejects fabricated scan types, unbounded route caps and viewport options before launch", async () => {
    let scans = 0;
    const { csrf, url } = await newServer(async (request) => {
      scans += 1;
      return await createReport(request);
    });
    const base = { url: "https://example.test/", input: "keyboard", mode: "standard" };
    for (const invalid of [
      { ...base, type: "future" },
      { ...base, type: "site" },
      { ...base, type: "site", maxRoutes: 0 },
      { ...base, type: "site", maxRoutes: 41 },
      { ...base, type: "site", maxRoutes: 21 },
      { ...base, type: "site", maxRoutes: 1.5 },
      { ...base, type: "site", maxRoutes: "4" },
      { ...base, type: "navigation", maxRoutes: 4 },
      { ...base, type: "responsive" },
      { ...base, type: "responsive", viewportProfile: "4k" },
      { ...base, type: "responsive", viewportProfile: "mobile" },
      { ...base, type: "responsive", viewportProfile: "all", recordVideo: true },
      { ...base, type: "site", maxRoutes: 5, recordVideo: true },
      { ...base, type: "site", maxRoutes: 5, input: "remote" },
      { ...base, type: "navigation", viewportProfile: "all" },
    ]) {
      expect((await post(url, csrf, invalid)).status, JSON.stringify(invalid)).toBe(400);
    }
    expect(scans).toBe(0);
  });

  it("cancels via AbortSignal and blocks fresh starts until the original scanner settles", async () => {
    let accept: ((outcome: LocalUiScanOutcome) => void) | undefined;
    let cancelled = false;
    const { csrf, url } = await newServer(async (request) => {
      request.signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
      return await new Promise<LocalUiScanOutcome>((resolve) => { accept = resolve; });
    });
    const body = { url: "https://example.test/", input: "remote", mode: "deep" };
    expect((await post(url, csrf, body)).status).toBe(202);
    const running = await (await fetch(`${url}/api/status`)).json() as Record<string, unknown>;
    const id = running["id"];
    expect(typeof id).toBe("string");
    const cancelPath = `${url}/api/scans/${String(id)}/cancel`;
    expect((await fetch(cancelPath, { method: "POST" })).status).toBe(403);
    expect((await fetch(cancelPath, {
      method: "POST", headers: { Origin: url, "X-TVDoctor-CSRF": "incorrect" },
    })).status).toBe(403);
    const cancelledResponse = await fetch(cancelPath, {
      method: "POST", headers: { Origin: url, "X-TVDoctor-CSRF": csrf },
    });
    expect(cancelledResponse.status).toBe(202);
    expect(cancelled).toBe(true);
    expect(await cancelledResponse.json()).toMatchObject({ state: "cancelling" });
    expect((await post(url, csrf, body)).status).toBe(409);
    expect((await fetch(cancelPath, {
      method: "POST", headers: { Origin: url, "X-TVDoctor-CSRF": csrf },
    })).status).toBe(409);
    accept?.({ exitCode: 3, result: null });
    const completed = await waitForState(url, "cancelled");
    expect(completed).toMatchObject({ state: "cancelled", finishedAt: expect.any(String) });
    expect((await post(url, csrf, body)).status).toBe(202);
  });

  it("preserves a scanner-provided partial report after cancellation", async () => {
    const { csrf, url } = await newServer(async (request) => {
      return await new Promise<LocalUiScanOutcome>((resolve) => {
        request.signal.addEventListener("abort", () => {
          void createReport(request).then((outcome) => {
            resolve({
              ...outcome,
              exitCode: 3,
              result: outcome.result === null ? null : { ...outcome.result, status: "partial" },
            });
          });
        }, { once: true });
      });
    });
    expect((await post(url, csrf, {
      url: "https://example.test/", input: "keyboard", mode: "deep", type: "site", maxRoutes: 4,
    })).status).toBe(202);
    const running = await (await fetch(`${url}/api/status`)).json() as Record<string, unknown>;
    expect((await fetch(`${url}/api/scans/${String(running["id"])}/cancel`, {
      method: "POST", headers: { Origin: url, "X-TVDoctor-CSRF": csrf },
    })).status).toBe(202);
    const finished = await waitForState(url, "partial");
    expect(finished["message"]).toContain("Partial scan");
    expect(finished["reportUrl"]).toMatch(/report\.html$/u);
  });

  it("does not allow concurrent streaming requests to start two scans", async () => {
    let calls = 0;
    const { csrf, url } = await newServer(async () => {
      calls += 1;
      return await new Promise<LocalUiScanOutcome>((resolve) => { void resolve; });
    });
    const body = { url: "https://example.test/", input: "keyboard", mode: "quick" };
    const statuses = await Promise.all([
      post(url, csrf, body),
      post(url, csrf, body),
      post(url, csrf, body),
    ]);
    expect(statuses.map((response) => response.status).sort()).toEqual([202, 409, 409]);
    expect(calls).toBe(1);
  });
});
