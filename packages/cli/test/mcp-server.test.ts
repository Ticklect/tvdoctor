import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  REPORT_SCHEMA_VERSION_V1,
  type TVDoctorReportV1,
} from "@tvdoctor/protocol";

import type { CliOperations, ReplayCommandRequest, TestCommandRequest, TestCommandResult } from "../src/cli.js";
import { serveMcpStdio, TvDoctorMcpServer, type JsonRpcResponse } from "../src/mcp-server.js";
import { createNodeCliOperations } from "../src/node-replay.js";
import { parseJourney } from "../src/journey.js";

const ISSUE_ID = "TVDOCTOR-NAV-TEST-A";
const ARTIFACT_ID = "screenshot-1";
const target = "http://127.0.0.1:5050/modal";
const bytes = Buffer.from("private demo screenshot");
const reliabilityLabV2ServerUrl = new URL("../../../fixtures/reliability-lab-v2/server.mjs", import.meta.url).href;

function report(status: "completed" | "partial" = "completed"): TVDoctorReportV1 {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION_V1,
    run: {
      id: "mcp-test-run",
      tvdoctorVersion: "0.1.0",
      mode: "quick",
      status,
      startedAt: "2026-10-11T21:00:00.000Z",
      completedAt: "2026-10-11T21:00:01.000Z",
      durationMs: 1_000,
    },
    target: {
      name: "Local test",
      platform: "web",
      location: "http://127.0.0.1:5050/",
      environment: { browser: "chromium", inputMode: "keyboard" },
    },
    coverage: {
      screenStatesDiscovered: 3,
      focusStatesDiscovered: 5,
      transitionsTested: 4,
      actionsSent: 6,
      capabilitiesObserved: ["remote-input", "ui-tree"],
      packs: [{ pack: "navigation", status }],
      budget: {
        maxActions: 200,
        maxStates: 50,
        maxDepth: 5,
        maxDurationMs: 30_000,
        maxRepetitiveItems: null,
        exhausted: status === "partial" ? ["duration"] : [],
      },
    },
    issues: [{
      id: ISSUE_ID,
      rule: "keyboard.modal-focus-escape",
      title: "SECRET: focus escaped",
      description: "SECRET: text from private page",
      severity: "high",
      confidence: "deterministic",
      pack: "navigation",
      screen: "SECRET: modal",
      expected: "SECRET expected",
      observed: "SECRET observed",
      transition: { fromElement: "from", action: "TAB", expectedElement: "inside", observedElement: "outside" },
      evidence: [{ kind: "verified-fact", summary: "SECRET evidence", source: "scanner", artifact: "screenshots/test.png" }],
      reproduction: { status: "unavailable", reason: "No valid replay recorded." },
    }],
    artifacts: [{
      id: ARTIFACT_ID,
      kind: "screenshot",
      status: "available",
      path: "screenshots/test.png",
      mediaType: "image/png",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
    replays: [],
  };
}

function resultFor(path: string, status: "completed" | "partial" = "completed"): TestCommandResult {
  return {
    status,
    reportPath: path,
    issueCount: 1,
    highestSeverity: "high",
    details: ["SECRET: raw detail must remain private"],
  };
}

async function deterministicScan(request: TestCommandRequest): Promise<TestCommandResult> {
  await mkdir(request.outputPath, { recursive: true });
  const source = report();
  const sequence = [{ key: "SHIFT_TAB" as const, repeat: 1 }, { key: "TAB" as const, repeat: 1 }];
  const transition = source.issues[0]?.transition;
  if (transition === undefined) throw new Error("Test issue missing");
  const good = {
    ...source,
    issues: source.issues.map((issue) => ({ ...issue,
      evidence: [...issue.evidence, { kind: "deterministic-failure" as const,
        summary: "The same visible modal retained its identity while focus moved outside after Tab.",
        source: "scanner", artifact: null }],
      reproduction: {
      status: "available" as const, resetStrategy: "reload" as const,
      originalSequence: sequence, minimizedSequence: null,
      confidence: "deterministic" as const, artifact: null,
    } })),
    replays: [{ schemaVersion: "tvdoctor.replay/v1" as const, id: "replay-issue-1",
      issueId: ISSUE_ID, reset: { strategy: "reload" as const }, steps: sequence,
      assertion: { type: "transition" as const, ...transition } }],
  };
  await writeFile(join(request.outputPath, "report.json"), JSON.stringify(good));
  return resultFor(join(request.outputPath, "report.json"));
}

/** Source-shaped fixture only: the live scanner has not yet emitted this rule. */
async function modalTabFocusLossScan(request: TestCommandRequest, evidence = true): Promise<TestCommandResult> {
  const result = await deterministicScan(request);
  const reportPath = result.reportPath;
  if (reportPath === null) throw new Error("Mock scan report missing.");
  const saved = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
  const original = saved.issues[0];
  const replay = saved.replays[0];
  if (original === undefined || replay === undefined) throw new Error("Mock replay evidence missing.");
  const transition = { fromElement: "inside", action: "TAB" as const,
    expectedElement: "dialog", observedElement: null };
  await writeFile(reportPath, JSON.stringify({ ...saved,
    issues: [{ ...original, rule: "keyboard.modal-tab-focus-loss", transition,
      expected: "Focus remains in the dialog", observed: "No focused element after Tab",
      evidence: evidence ? [{ kind: "deterministic-failure", source: "scanner",
        summary: "Complete UI tree and focusedElement both show null focus", artifact: null }] : [],
    }],
    replays: [{ ...replay, assertion: { type: "transition", ...transition } }],
  }));
  return result;
}

const modalOpenWitness = {
  modal: { stableId: "preferences-modal", role: "dialog", name: "Preferences" },
  opener: { stableId: "open-preferences", role: "button", name: "Open preferences" },
} as const;

/** A source-shaped compiler fixture, not a claim that this mocked test ran Chromium. */
async function modalOpenFocusNotTransferredScan(request: TestCommandRequest): Promise<TestCommandResult> {
  const result = await deterministicScan(request);
  const reportPath = result.reportPath;
  if (reportPath === null) throw new Error("Missing synthetic report.");
  const saved = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
  const issue = saved.issues[0];
  const replay = saved.replays[0];
  if (issue === undefined || replay === undefined) throw new Error("Missing source issue and replay.");
  const transition = { fromElement: "open-preferences", action: "SELECT" as const,
    expectedElement: "preferences-modal", observedElement: "open-preferences" };
  const steps = [{ key: "SELECT" as const, repeat: 1 }];
  await writeFile(reportPath, JSON.stringify({ ...saved,
    issues: [{ ...issue, rule: "keyboard.modal-open-focus-not-transferred", transition,
      evidence: [
        { kind: "deterministic-failure", summary: "Safe SELECT left focus on the opener outside the modal.",
          source: "scanner", artifact: null },
        { kind: "verified-fact", summary: JSON.stringify(modalOpenWitness),
          source: "tvdoctor.keyboard.modal-open/v1", artifact: null },
      ],
      reproduction: { ...issue.reproduction, originalSequence: steps },
    }],
    replays: [{ ...replay, steps, assertion: { type: "transition", ...transition } }],
  }));
  return result;
}

async function makeServer(
  run?: (request: TestCommandRequest) => Promise<TestCommandResult>,
  replay?: CliOperations["replayIssue"],
  journeys?: Readonly<Record<string, { readonly path: string; readonly target: string; readonly sha256: string }>>,
): Promise<{ readonly server: TvDoctorMcpServer; readonly calls: TestCommandRequest[];
  readonly replayCalls: ReplayCommandRequest[] }> {
  const calls: TestCommandRequest[] = [];
  const replayCalls: ReplayCommandRequest[] = [];
  const operations: CliOperations = {
    async replayIssue(request) {
      replayCalls.push(request);
      return replay === undefined ? { status: "fixed", details: [] } : await replay(request);
    },
    async testTarget(request) {
      calls.push(request);
      if (run !== undefined) return await run(request);
      await mkdir(join(request.outputPath, "screenshots"), { recursive: true });
      await writeFile(join(request.outputPath, "screenshots", "test.png"), bytes);
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify(report()));
      return resultFor(join(request.outputPath, "report.json"));
    },
  };
  const server = new TvDoctorMcpServer({
    outputRoot: join(tmpdir(), `tvdoctor-mcp-unit-${randomUUID()}`),
    operations,
    ...(journeys === undefined ? {} : { journeys }),
  });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  return { server, calls, replayCalls };
}

function comparisonIssue(
  id: string,
  severity: TVDoctorReportV1["issues"][number]["severity"] = "high",
  confidence: TVDoctorReportV1["issues"][number]["confidence"] = "deterministic",
): TVDoctorReportV1["issues"][number] {
  const source = report().issues[0];
  if (source === undefined) throw new Error("Comparison fixture issue missing.");
  return { ...source, id, rule: "fixture.regression", severity, confidence, pack: "navigation" };
}

function comparisonInventory(changed = false): Record<string, unknown> {
  const finalFocus = changed ? "focus-f" : "focus-e";
  return {
    status: "complete",
    screens: [
      { key: "screen-1", label: "Home" },
      { key: "screen-2", label: "Details" },
      { key: "screen-3", label: "Settings" },
    ],
    focusTargets: [
      { key: "focus-a", screenKey: "screen-1", role: "button", name: "Open" },
      { key: "focus-b", screenKey: "screen-1", role: "button", name: "Continue" },
      { key: "focus-c", screenKey: "screen-2", role: "button", name: "Back" },
      { key: "focus-d", screenKey: "screen-3", role: "button", name: "General" },
      { key: finalFocus, screenKey: "screen-3", role: "button", name: changed ? "Privacy" : "Playback" },
    ],
    transitions: [
      { key: "edge-1", fromScreenKey: "screen-1", fromFocusKey: "focus-a", action: "TAB", toScreenKey: "screen-1", toFocusKey: "focus-b" },
      { key: "edge-2", fromScreenKey: "screen-1", fromFocusKey: "focus-b", action: "SELECT", toScreenKey: "screen-2", toFocusKey: "focus-c" },
      { key: "edge-3", fromScreenKey: "screen-2", fromFocusKey: "focus-c", action: "BACK", toScreenKey: "screen-1", toFocusKey: "focus-a" },
      { key: "edge-4", fromScreenKey: "screen-3", fromFocusKey: "focus-d", action: "DOWN", toScreenKey: "screen-3", toFocusKey: finalFocus },
    ],
    latencies: [{ key: "launch", operation: "Launch to stable Home", measuredMs: 500 }],
  };
}

async function makeComparisonServer(options: {
  readonly issuesForRun?: (index: number) => TVDoctorReportV1["issues"];
  readonly inventoryForRun?: (index: number) => Record<string, unknown>;
  readonly omitInventory?: boolean;
  readonly corruptInventoryHash?: boolean;
  readonly inventoryKind?: "report" | "screenshot";
  readonly inventoryMediaType?: string;
  readonly runStatus?: "completed" | "partial";
  readonly reportForRun?: (report: TVDoctorReportV1, index: number) => TVDoctorReportV1;
  readonly onCreateBaseline?: (firstOutputPath: string) => Promise<void>;
  readonly failCompare?: boolean;
} = {}): Promise<{ readonly server: TvDoctorMcpServer; readonly outputPaths: string[] }> {
  const nodeOperations = createNodeCliOperations();
  const outputPaths: string[] = [];
  let runIndex = 0;
  const operations: CliOperations = {
    ...nodeOperations,
    async testTarget(request) {
      const index = runIndex++;
      outputPaths.push(request.outputPath);
      await mkdir(request.outputPath, { recursive: true });
      const inventoryValue = options.inventoryForRun?.(index) ?? comparisonInventory(index > 0);
      const inventoryBytes = Buffer.from(JSON.stringify(inventoryValue));
      if (!options.omitInventory) await writeFile(join(request.outputPath, "inventory.json"), inventoryBytes);
      const source = report(options.runStatus ?? "completed");
      const inventoryArtifact = {
        id: "run:inventory",
        kind: options.inventoryKind ?? "report",
        status: "available" as const,
        path: "inventory.json",
        mediaType: options.inventoryMediaType ?? "application/json",
        byteLength: inventoryBytes.length,
        sha256: options.corruptInventoryHash ? "0".repeat(64) : createHash("sha256").update(inventoryBytes).digest("hex"),
      };
      const scanReport: TVDoctorReportV1 = {
        ...source,
        run: { ...source.run, id: `mcp-compare-run-${String(index + 1)}`, status: options.runStatus ?? "completed" },
        target: {
          ...source.target,
          environment: {
            browser: "chromium",
            ...(request.inputMode === "keyboard" ? { inputMode: "keyboard" } : {}),
          },
        },
        coverage: {
          ...source.coverage,
          screenStatesDiscovered: 3,
          focusStatesDiscovered: 5,
          transitionsTested: 4,
          actionsSent: 6,
          packs: [{ pack: "navigation", status: options.runStatus ?? "completed" }],
          budget: {
            maxActions: request.navigationBudgets?.maxActions ?? 500,
            maxStates: 50,
            maxDepth: 5,
            maxDurationMs: request.maxDurationMs ?? 30000,
            maxRepetitiveItems: null,
            exhausted: options.runStatus === "partial" ? ["duration"] : [],
          },
        },
        issues: options.issuesForRun?.(index) ?? [],
        artifacts: options.omitInventory ? [] : [inventoryArtifact],
      };
      const reportPath = join(request.outputPath, "report.json");
      await writeFile(reportPath, JSON.stringify(options.reportForRun?.(scanReport, index) ?? scanReport));
      return resultFor(reportPath, options.runStatus ?? "completed");
    },
    ...(options.onCreateBaseline === undefined ? {} : {
      async createBaseline(request) {
        const firstOutputPath = outputPaths[0];
        if (firstOutputPath === undefined) throw new Error("Baseline source path missing.");
        await options.onCreateBaseline?.(firstOutputPath);
        const create = nodeOperations.createBaseline;
        if (create === undefined) throw new Error("Baseline engine unavailable.");
        return await create(request);
      },
    }),
    ...(options.failCompare === true ? {
      async compareBaseline() { throw new Error("Injected baseline comparison failure."); },
    } : {}),
  };
  const server = new TvDoctorMcpServer({
    outputRoot: join(tmpdir(), `tvdoctor-mcp-compare-${randomUUID()}`),
    operations,
  });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  return { server, outputPaths };
}

async function call(
  server: TvDoctorMcpServer, name: string, args: Record<string, unknown>, id = 1,
): Promise<{ readonly data: Record<string, unknown>; readonly response: JsonRpcResponse }> {
  const response = await server.handle({
    jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
  });
  if (response === null) throw new Error("tools/call unexpectedly returned no response.");
  const result = response.result as {
    content: { type: string; text: string }[];
    isError: boolean;
  };
  const first = result.content[0];
  if (first === undefined) throw new Error("Tool response did not include content.");
  return { data: JSON.parse(first.text) as Record<string, unknown>, response };
}

async function start(server: TvDoctorMcpServer, overrides: Record<string, unknown> = {}): Promise<string> {
  const { data } = await call(server, "tvdoctor_scan", {
    url: target, authorized: true, ...overrides,
  });
  expect(data["status"]).toBe("pending");
  const id = data["scan_id"];
  if (typeof id !== "string") throw new Error("scan_id missing");
  return id;
}

async function settle(server: TvDoctorMcpServer, id: string, timeout = 5_000): Promise<Record<string, unknown>> {
  let final: Record<string, unknown> = {};
  await vi.waitFor(async () => {
    const { data } = await call(server, "tvdoctor_status", { scan_id: id });
    final = data;
    expect(data["status"]).not.toBe("pending");
  }, { timeout, interval: 100 });
  return final;
}

describe("TVDoctor MCP JSON-RPC 2.0", () => {
  it.each([["explorer/nested-history", true], ["explorer-fixed/nested-history", false]])(
    "preserves genuine two-Back REVIEW evidence through MCP and rejects false repaired issues %s",
    async (scenario, broken) => {
      const fixture = await import(reliabilityLabV2ServerUrl) as {
        startLabV2: () => Promise<{ origin: string; close: () => Promise<void>;
          metrics: () => { nonGetRequests: number; dangerousGetRequests: number } }>;
      };
      const lab = await fixture.startLabV2();
      const server = new TvDoctorMcpServer({ outputRoot: join(tmpdir(), `tvdoctor-mcp-two-back-${randomUUID()}`) });
      try {
        await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26" } });
        const { data: created } = await call(server, "tvdoctor_site", {
          authorized: true, url: `${lab.origin}/${scenario}`, max_pages: 1, explore_spa: true,
        });
        const scanId = created["scan_id"];
        if (typeof scanId !== "string") throw new Error("MCP nested two-Back job not started");
        expect(["completed", "partial"]).toContain((await settle(server, scanId, 90_000))["status"]);
        const { data: list } = await call(server, "tvdoctor_findings", { scan_id: scanId });
        const leads = (list["findings"] as { id: string; rule: string }[]).filter((item) =>
          item.rule === "spa.history-back-interrupted-stale-view");
        expect(leads.length).toBe(broken ? 1 : 0);
        for (const lead of leads) {
          expect(lead.id).toMatch(/^SPA-[a-f0-9]{12}-\d+-TWO-BACK$/u);
          const { data: detail } = await call(server, "tvdoctor_issue_details", {
            scan_id: scanId, issue_id: lead.id,
          });
          expect(detail).toMatchObject({ classification: "heuristic-review-only",
            verified_transition: false, replay_steps: [], forward_setup_steps: expect.any(Array),
            history_back: { observed_history_steps: 2, settled_samples: 2,
              independent_replay_verified: false, route_returned: true, heading_restored: false,
              screenshot_artifact_id: expect.stringMatching(/^spa:back-interrupted-edge-\d{3}$/u) },
          });
          expect(JSON.stringify(detail)).not.toContain(lab.origin);
          const { data: verification } = await call(server, "tvdoctor_verify_fix", {
            scan_id: scanId, issue_id: lead.id, authorized: true,
          });
          expect(verification).toMatchObject({ status: "INCONCLUSIVE", reason: "replay-unavailable", fixed: null });
          expect((detail["manual_review_steps"] as string[]).some((line) =>
            line.includes("twice in rapid succession"))).toBe(true);
          const { data: disallowed } = await call(server, "tvdoctor_evidence", {
            scan_id: scanId, artifact_id: (detail["history_back"] as { screenshot_artifact_id: string }).screenshot_artifact_id,
            include_content: true,
          });
          expect(disallowed).toMatchObject({ code: "acknowledgment-required" });
          const imageId = (detail["history_back"] as { screenshot_artifact_id: string }).screenshot_artifact_id;
          const { response: accepted } = await call(server, "tvdoctor_evidence", {
            scan_id: scanId, artifact_id: imageId, include_content: true, acknowledge_sensitive: true,
          });
          expect((accepted.result as { content: { type: string; mimeType?: string }[] }).content).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]));
          const report = JSON.parse(await readFile(join(server.outputRoot, scanId, "spa", "spa-journey.json"), "utf8")) as {
            issues: { rule: string; historyBack?: { screenshot?: { path: string } } }[];
          };
          const photoPath = report.issues.find((item) => item.rule === "spa.history-back-interrupted-stale-view")
            ?.historyBack?.screenshot?.path;
          if (photoPath === undefined) throw new Error("Two-Back screenshot path absent");
          const fullImage = join(server.outputRoot, scanId, "spa", photoPath);
          const originalBytes = await readFile(fullImage);
          await writeFile(fullImage, Buffer.from("forged two-Back PNG"));
          const { data: rejected } = await call(server, "tvdoctor_issue_details", {
            scan_id: scanId, issue_id: lead.id,
          });
          expect(rejected).toMatchObject({ code: "report-unavailable" });
          await writeFile(fullImage, originalBytes);
          const reportPath = join(server.outputRoot, scanId, "spa", "spa-journey.json");
          const savedBytes = await readFile(reportPath, "utf8");
          interface SavedSpa {
            targetIdentity: string;
            states: { id: string; routeIdentity: string; depth: number; replay: { index: number; kind: string;
              targetFingerprint: string; checkpoint: string }[] }[];
            edges: { from: string; to: string | null; kind: string; targetIndex: number;
              targetFingerprint: string; status: string; replay: { index: number; kind: string;
                targetFingerprint: string; checkpoint: string }[] }[];
            issues: { rule: string; edgeIndex: number; historyBack?: {
              expectedStateId: string; expectedRouteIdentity: string; observedRouteIdentity: string;
              interruptedBack?: { intermediateStateId: string };
            } }[];
          }
          const saved = JSON.parse(savedBytes) as SavedSpa;
          const nested = saved.issues.find((item) => item.rule === "spa.history-back-interrupted-stale-view");
          if (nested?.historyBack?.interruptedBack === undefined) throw new Error("Two-Back parent witness missing");
          const target = saved.edges[nested.edgeIndex];
          const parent = saved.edges.find((edge) => edge.to === nested.historyBack?.interruptedBack?.intermediateStateId
            && edge.from === nested.historyBack.expectedStateId && edge.status === "observed");
          const middle = saved.states.find((state) => state.id === nested.historyBack?.interruptedBack?.intermediateStateId);
          if (target === undefined || parent === undefined || middle === undefined) {
            throw new Error("Expected the saved two-Back parent and intermediate state");
          }
          // Mutate only temporary, already-scanned reports. Every tamper must
          // invalidate both MCP issue details and the findings index; none may
          // promote a forward setup into independently witnessed browser Back.
          const tampering: { label: string; change: (copy: SavedSpa) => void }[] = [
            { label: "target identity changed independently of the authorised URL", change(copy) {
              copy.targetIdentity = "f".repeat(20);
            } },
            { label: "target and root/back route identities forged together", change(copy) {
              // Keeping the saved report internally consistent is insufficient:
              // targetIdentity must be derived from the trusted MCP job target.
              copy.targetIdentity = "f".repeat(20);
              const root = copy.states[0];
              if (root === undefined) throw new Error("Missing root state");
              root.routeIdentity = copy.targetIdentity;
              for (const item of copy.issues) {
                if (item.historyBack === undefined) continue;
                item.historyBack.expectedRouteIdentity = copy.targetIdentity;
                item.historyBack.observedRouteIdentity = copy.targetIdentity;
              }
            } },
            { label: "intermediate replay missing", change(copy) {
              const item = copy.states.find((state) => state.id === middle.id);
              if (item === undefined) throw new Error("Missing intermediate state");
              item.replay = [];
            } },
            { label: "intermediate checkpoint not backed by observed edge", change(copy) {
              const item = copy.states.find((state) => state.id === middle.id);
              if (item?.replay[0] === undefined) throw new Error("Missing intermediate checkpoint");
              item.replay[0].targetFingerprint = "a".repeat(20);
            } },
            { label: "final anchor contradicts replay kind", change(copy) {
              const item = copy.edges[nested.edgeIndex];
              const last = item?.replay.at(-1);
              if (last === undefined) throw new Error("Missing final edge replay");
              last.kind = "menu-toggle";
            } },
            { label: "final anchor contradicts replay index", change(copy) {
              const item = copy.edges[nested.edgeIndex];
              const last = item?.replay.at(-1);
              if (last === undefined) throw new Error("Missing final edge replay");
              last.index += 1;
            } },
            { label: "final anchor contradicts replay fingerprint", change(copy) {
              const item = copy.edges[nested.edgeIndex];
              const last = item?.replay.at(-1);
              if (last === undefined) throw new Error("Missing final edge replay");
              last.targetFingerprint = "a".repeat(20);
            } },
            { label: "parent edge source ancestry forged", change(copy) {
              const item = copy.edges.find((edge) => edge.to === middle.id && edge.from === parent.from);
              if (item === undefined) throw new Error("Missing parent edge");
              if (target.to === null) throw new Error("Missing final target state");
              item.from = target.to;
            } },
            { label: "intermediate state association forged", change(copy) {
              const item = copy.issues.find((issue) => issue.rule === nested.rule);
              if (item?.historyBack?.interruptedBack === undefined) throw new Error("Missing two-Back witness");
              item.historyBack.interruptedBack.intermediateStateId = "a".repeat(20);
            } },
          ];
          for (const { label, change } of tampering) {
            const copy = structuredClone(saved);
            change(copy);
            try {
              await writeFile(reportPath, JSON.stringify(copy));
              const { data: forgedDetails } = await call(server, "tvdoctor_issue_details", {
                scan_id: scanId, issue_id: lead.id,
              });
              expect(forgedDetails, label).toMatchObject({ code: "report-unavailable" });
              const { data: forgedFindings } = await call(server, "tvdoctor_findings", { scan_id: scanId });
              expect(forgedFindings, label).toMatchObject({ code: "report-unavailable" });
            } finally {
              await writeFile(reportPath, savedBytes);
            }
          }
          // The scanner hashes the requested launch URL, but may observe a
          // different root route after a safe same-document startup replaceState
          // or hash-router rewrite. Do not require root.routeIdentity to equal
          // the launch hash: that would reject legitimate SPA state reports.
          const startupRewrite = structuredClone(saved);
          const root = startupRewrite.states[0];
          if (root === undefined) throw new Error("Missing root for startup route check");
          root.routeIdentity = "f".repeat(20);
          for (const item of startupRewrite.issues) {
            if (item.historyBack === undefined) continue;
            item.historyBack.expectedRouteIdentity = root.routeIdentity;
            item.historyBack.observedRouteIdentity = root.routeIdentity;
          }
          try {
            await writeFile(reportPath, JSON.stringify(startupRewrite));
            const { data: movedRoot } = await call(server, "tvdoctor_issue_details", {
              scan_id: scanId, issue_id: lead.id,
            });
            expect(movedRoot).toMatchObject({ classification: "heuristic-review-only",
              verified_transition: false, history_back: { observed_history_steps: 2 } });
          } finally {
            await writeFile(reportPath, savedBytes);
          }
          const { data: restored } = await call(server, "tvdoctor_issue_details", {
            scan_id: scanId, issue_id: lead.id,
          });
          expect(restored).toMatchObject({ classification: "heuristic-review-only",
            verified_transition: false, history_back: { observed_history_steps: 2 } });
        }
        expect(lab.metrics().nonGetRequests).toBe(0);
        expect(lab.metrics().dangerousGetRequests).toBe(0);
      } finally { server.close(); await lab.close(); }
    }, 110_000,
  );
  it("handles initialization, notifications, tools/list and unknown methods", async () => {
    const server = new TvDoctorMcpServer();
    expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
      .toMatchObject({ id: 1, error: { code: -32000 } });
    const initialized = await server.handle({
      jsonrpc: "2.0", id: 2, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(initialized).toMatchObject({
      id: 2, result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tvdoctor" },
        instructions: expect.stringContaining("tvdoctor_verify_fix"),
      },
    });
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const listed = await server.handle({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
    const result = listed?.result as { tools: { name: string; inputSchema: unknown }[] };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "tvdoctor_scan", "tvdoctor_site", "tvdoctor_responsive",
      "tvdoctor_site_index", "tvdoctor_responsive_index",
      "tvdoctor_status", "tvdoctor_findings", "tvdoctor_triage", "tvdoctor_evidence", "tvdoctor_issue_details", "tvdoctor_replay", "tvdoctor_verify_fix", "tvdoctor_compare", "tvdoctor_cancel",
    ]);
    expect(result.tools.every((tool) => tool.inputSchema !== undefined)).toBe(true);
    expect(await server.handle({ jsonrpc: "2.0", id: 3, method: "unknown" }))
      .toMatchObject({ error: { code: -32601 } });
    expect(await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x", arguments: [] } }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await server.handle([{ jsonrpc: "2.0" }]))
      .toMatchObject({ error: { code: -32600 } });
    server.close();
  });

  it("discovers the static MCP repair prompt and returns a complete agent workflow", async () => {
    const server = new TvDoctorMcpServer();
    const name = "tvdoctor_repair_workflow";
    try {
      expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "prompts/list" }))
        .toMatchObject({ id: 1, error: { code: -32000 } });
      const initialized = await server.handle({
        jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" },
      });
      expect(initialized).toMatchObject({
        id: 2, result: { capabilities: { prompts: { listChanged: false }, tools: { listChanged: false } } },
      });
      const listed = await server.handle({ jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} });
      expect(listed?.result).toEqual({ prompts: [{
        name, title: "Scan, fix, and verify UI bugs", description: expect.any(String),
      }] });
      const response = await server.handle({ jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name } });
      expect(response).toMatchObject({
        id: 4, result: { description: expect.any(String), messages: [{
          role: "user", content: { type: "text", text: expect.any(String) },
        }] },
      });
      const result = response?.result as { messages: { content: { text: string } }[] };
      const workflow = result.messages[0]?.content.text;
      expect(workflow).toMatch(/tvdoctor_scan[\s\S]+tvdoctor_status[\s\S]+tvdoctor_findings[\s\S]+tvdoctor_triage[\s\S]+tvdoctor_issue_details[\s\S]+edit the application code[\s\S]+tvdoctor_verify_fix[\s\S]+tvdoctor_compare/u);
      expect(workflow).toContain("untested");
      expect(initialized).toMatchObject({ result: { instructions: workflow } });
      expect(await server.handle({
        jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name, arguments: { target: "http://example.test" } },
      })).toMatchObject({ id: 5, error: { code: -32602 } });
      expect(await server.handle({ jsonrpc: "2.0", id: 6, method: "prompts/get", params: { name: "unknown" } }))
        .toMatchObject({ id: 6, error: { code: -32602 } });
    } finally {
      server.close();
    }
  });

  it("accepts standard MCP tool-call metadata while keeping tool arguments strict", async () => {
    const server = new TvDoctorMcpServer();
    try {
      await server.handle({
        jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" },
      });
      const request = {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {
          name: "tvdoctor_status",
          arguments: { scan_id: "unknown" },
          _meta: { progressToken: 0, "client.example/trace": "trace-1" },
        },
      };
      expect(await server.handle(request)).toMatchObject({
        id: 2, result: { isError: true, content: [{ text: expect.stringContaining('"unknown-scan"') }] },
      });
      expect(await server.handle({ ...request, params: { ...request.params, _meta: [] } }))
        .toMatchObject({ id: 2, error: { code: -32602 } });
      expect(await server.handle({
        ...request, params: { ...request.params, arguments: { ...request.params.arguments, _meta: {} } },
      })).toMatchObject({
        id: 2, result: { isError: true, content: [{ text: expect.stringContaining('"invalid-arguments"') }] },
      });
    } finally {
      server.close();
    }
  });

  it("launches the existing runCli scan with bounded defaults and private report location", async () => {
    const { server, calls } = await makeServer();
    const id = await start(server);
    expect(await settle(server, id)).toMatchObject({ status: "completed", issue_count: 1, report_available: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target, inputMode: "keyboard", mode: "quick", targetRedaction: "origin",
      maxDurationMs: 30000, navigationBudgets: { maxActions: 500 },
      disableRepetitionCompression: true,
    });
    expect(calls[0]?.outputPath).toContain(server.outputRoot);
    const { data: finding } = await call(server, "tvdoctor_findings", { scan_id: id });
    expect(finding).toMatchObject({
      status: "completed", total_issues: 1,
      coverage: { screens: 3, focus_states: 5, transitions: 4, actions: 6 },
      findings: [{ id: ISSUE_ID, rule: "keyboard.modal-focus-escape", confidence: "deterministic" }],
    });
    expect(JSON.stringify(finding)).not.toContain("SECRET");
    expect(JSON.stringify(finding)).not.toContain("screenshots/test.png");
    expect(JSON.stringify(finding)).not.toContain(server.outputRoot);
    server.close();
  });

  it("passes explicit keyboard_interactions opt-in to the real scan parser and rejects unsafe inputs", async () => {
    const { server, calls } = await makeServer();
    try {
      for (const invalid of [false, "true", 1, null]) {
        const { data, response } = await call(server, "tvdoctor_scan", {
          url: target, authorized: true, keyboard_interactions: invalid,
        });
        expect(data).toMatchObject({ status: "error", code: "invalid-arguments" });
        expect((response.result as { isError: boolean }).isError).toBe(true);
      }
      const { data: remoteRejected } = await call(server, "tvdoctor_scan", {
        url: target, authorized: true, input: "remote", keyboard_interactions: true,
      });
      expect(remoteRejected).toMatchObject({ status: "error", code: "invalid-arguments" });
      expect(calls).toHaveLength(0);

      const defaultScan = await start(server);
      expect(await settle(server, defaultScan)).toMatchObject({ status: "completed" });
      const optedInScan = await start(server, { keyboard_interactions: true });
      expect(await settle(server, optedInScan)).toMatchObject({ status: "completed" });
      const remoteScan = await start(server, { input: "remote" });
      expect(await settle(server, remoteScan)).toMatchObject({ status: "completed" });

      expect(calls).toHaveLength(3);
      expect(calls[0]).toMatchObject({ inputMode: "keyboard", mode: "quick" });
      expect(calls[0]).not.toHaveProperty("keyboardInteractions");
      expect(calls[1]).toMatchObject({ inputMode: "keyboard", mode: "quick", keyboardInteractions: true });
      expect(calls[2]).toMatchObject({ mode: "quick" });
      expect(calls[2]).not.toHaveProperty("keyboardInteractions");
    } finally { server.close(); }
  });

  it("uses only trusted target-bound journey IDs and sealed session copies for scan, replay and verification", async () => {
    const local = join(tmpdir(), `tvdoctor-mcp-journey-fixture-${randomUUID()}`);
    await mkdir(local, { recursive: true });
    const path = join(local, "login.json");
    const journey = { schemaVersion: "tvdoctor.journey/v1", name: "Trusted setup", maxDurationMs: 30000,
      steps: [{ action: "press", key: "TAB", repeat: 1 }] };
    const fingerprint = parseJourney(journey).sha256;
    const journeyBytes = Buffer.from(JSON.stringify(journey));
    const rawDigest = createHash("sha256").update(journeyBytes).digest("hex");
    await writeFile(path, journeyBytes);
    const { server, calls, replayCalls } = await makeServer(async (request) => {
      const result = await deterministicScan(request);
      const reportPath = result.reportPath;
      if (reportPath === null) throw new Error("Mock scan report is missing.");
      const saved = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
      await writeFile(reportPath, JSON.stringify({ ...saved,
        target: { ...saved.target, environment: { ...saved.target.environment, journeyConfigSha256: fingerprint } },
      }));
      return result;
    }, async (request) => {
      expect(request.journeyPath).toBeDefined();
      expect(request.journeyPath).not.toBe(path);
      if (request.journeyPath === undefined) throw new Error("Replay did not receive its sealed journey.");
      expect(JSON.parse(await readFile(request.journeyPath, "utf8"))).toEqual(journey);
      return { status: "inconclusive", details: [] };
    }, { login: { path, target, sha256: rawDigest } });
    try {
      for (const invalid of ["../login.json", path, "missing"]) {
        const { data, response } = await call(server, "tvdoctor_scan", { url: target, authorized: true, journey: invalid });
        expect(data["status"]).toBe("error");
        expect((response.result as { isError: boolean }).isError).toBe(true);
      }
      const wrongTarget = await call(server, "tvdoctor_scan", {
        url: `${new URL(target).origin}/elsewhere`, authorized: true, journey: "login",
      });
      expect(wrongTarget.data).toMatchObject({ code: "journey-target-mismatch" });
      expect(calls).toHaveLength(0);

      const id = await start(server, { journey: "login" });
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.journeyPath).toBe(join(server.outputRoot, id, "journey.json"));
      expect(JSON.parse(await readFile(calls[0]?.journeyPath ?? "", "utf8"))).toEqual(journey);
      // A source file changed by the coding agent must never replace what the
      // trusted host explicitly authorized, even if its JSON is still valid.
      await writeFile(path, JSON.stringify({ ...journey, name: "Unapproved changed setup" }));
      const unapproved = await call(server, "tvdoctor_scan", { url: target, authorized: true, journey: "login" });
      expect(unapproved.data).toMatchObject({ code: "invalid-journey", status: "error" });
      expect(calls).toHaveLength(1);

      expect((await call(server, "tvdoctor_replay", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true,
      })).data).toMatchObject({ code: "journey-mismatch" });
      expect((await call(server, "tvdoctor_replay", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "other",
      })).data).toMatchObject({ code: "journey-mismatch" });
      expect(replayCalls).toHaveLength(0);

      const replay = await call(server, "tvdoctor_replay", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "login",
      });
      expect(replay.data).toMatchObject({ scan_id: id, replay_status: "inconclusive", fixed: null });
      expect(replayCalls).toHaveLength(1);
      expect(replayCalls[0]?.journeyPath).toContain("replay-");
      const verification = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "login",
      });
      expect(verification.data).toMatchObject({ status: "INCONCLUSIVE", fixed: null });
      expect(replayCalls).toHaveLength(2);
      expect(replayCalls[1]?.confirmStableFix).toBe(true);

      await writeFile(join(server.outputRoot, id, "journey.json"), '{"tampered":true}');
      const stale = await call(server, "tvdoctor_replay", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "login",
      });
      expect(stale.data).toMatchObject({ code: "stale-journey" });
      expect(replayCalls).toHaveLength(2);
      const uncertain = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "login",
      });
      expect(uncertain.data).toMatchObject({ status: "INCONCLUSIVE", reason: "stale-journey", fixed: null });
    } finally { server.close(); }
  });

  it("rejects journey scans whose original report lacks the authorized canonical journey fingerprint", async () => {
    const local = join(tmpdir(), `tvdoctor-mcp-journey-fingerprint-${randomUUID()}`);
    await mkdir(local, { recursive: true });
    const path = join(local, "journey.json");
    const data = JSON.stringify({ schemaVersion: "tvdoctor.journey/v1", name: "Original setup",
      maxDurationMs: 30000, steps: [{ action: "press", key: "TAB" }] });
    await writeFile(path, data);
    const { server, calls } = await makeServer(deterministicScan, undefined, { setup: {
      path, target, sha256: createHash("sha256").update(data).digest("hex"),
    } });
    try {
      const id = await start(server, { journey: "setup" });
      // The mock omitted journeyConfigSha256, unlike the real audit engine.
      expect(await settle(server, id)).toMatchObject({ status: "failed", report_available: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.journeyPath).toContain(join(server.outputRoot, id));
      const refused = await call(server, "tvdoctor_replay", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "setup",
      });
      expect(refused.data).toMatchObject({ code: "incomplete-scan" });
    } finally { server.close(); }
  });

  it("triages only owned completed scan evidence and fails closed on evidence or report tampering", async () => {
    const artifactPath = `evidence/${ISSUE_ID}/before-screenshot.png`;
    const { server, calls, replayCalls } = await makeServer(async (request) => {
      await deterministicScan(request);
      const reportPath = join(request.outputPath, "report.json");
      const source = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
      const issue = source.issues[0];
      if (issue === undefined) throw new Error("Missing original deterministic finding.");
      await mkdir(join(request.outputPath, "evidence", ISSUE_ID), { recursive: true });
      await writeFile(join(request.outputPath, ...artifactPath.split("/")), bytes);
      const backed = {
        ...source,
        issues: [{ ...issue, title: "Modal focus leaves dialog", expected: "Keep Tab focus within modal",
          observed: "Tab focused background control",
          evidence: [{ kind: "deterministic-failure" as const,
            summary: "Same modal remained open when focus escaped", source: "scanner", artifact: artifactPath }] }],
        artifacts: [{ id: `${ISSUE_ID}:before-screenshot`, kind: "screenshot" as const,
          status: "available" as const, path: artifactPath, mediaType: "image/png",
          byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
      };
      await writeFile(reportPath, JSON.stringify(backed));
      return resultFor(reportPath);
    });
    try {
      const unknown = await call(server, "tvdoctor_triage", { scan_id: "foreign-scan" });
      expect(unknown.data).toMatchObject({ code: "unknown-scan" });
      const rejected = await call(server, "tvdoctor_triage", { scan_id: "foreign-scan", report_path: "secret.json" });
      expect(rejected.data).toMatchObject({ code: "invalid-arguments" });
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      const { data, response } = await call(server, "tvdoctor_triage", { scan_id: id });
      expect((response.result as { isError: boolean }).isError).toBe(false);
      expect(data).toMatchObject({
        scan_id: id, schema_version: "tvdoctor.triage/v1", status: "completed",
        original_evidence_only: true, independently_fixed: null,
        summary: { total: 1, VERIFIED: 1, returned: 1, omitted: 0 },
        integrity: { report: "sealed-and-revalidated", evidence: "verified", artifacts_checked: 1 },
        findings: [{ id: ISSUE_ID, classification: "VERIFIED", independently_fixed: null,
          title: "Modal focus leaves dialog", expected: "Keep Tab focus within modal",
          observed: "Tab focused background control",
          artifacts: [{ id: `${ISSUE_ID}:before-screenshot`, kind: "screenshot", status: "verified" }],
          reproduction: { status: "deterministic", freshlyVerified: false },
        }],
      });
      expect(JSON.stringify(data)).toContain("tvdoctor_verify_fix");
      expect(JSON.stringify(data)).not.toContain(artifactPath);
      expect(JSON.stringify(data)).not.toContain(server.outputRoot);
      expect(JSON.stringify(data)).not.toContain(bytes.toString("base64"));
      expect((response.result as { content: { type: string }[] }).content).toHaveLength(1);

      await writeFile(join(server.outputRoot, id, ...artifactPath.split("/")), "tampered screenshot bytes");
      const tamperedEvidence = await call(server, "tvdoctor_triage", { scan_id: id });
      expect(tamperedEvidence.data).toMatchObject({ code: "invalid-evidence", status: "error" });
      expect((tamperedEvidence.response.result as { isError: boolean }).isError).toBe(true);

      await writeFile(join(server.outputRoot, id, ...artifactPath.split("/")), bytes);
      const originalPath = join(server.outputRoot, id, "report.json");
      const original = await readFile(originalPath, "utf8");
      await writeFile(originalPath, original.replace("Modal focus leaves dialog", "Tampered focus leaves dialog"));
      const stale = await call(server, "tvdoctor_triage", { scan_id: id });
      expect(stale.data).toMatchObject({ code: "stale-evidence", status: "error" });
      expect(calls).toHaveLength(1);
      expect(replayCalls).toHaveLength(0);
    } finally { server.close(); }
  });

  it("refuses triage from a partial single-page scan", async () => {
    const { server } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      const path = join(request.outputPath, "report.json");
      await writeFile(path, JSON.stringify(report("partial")));
      return resultFor(path, "partial");
    });
    try {
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "partial" });
      const { data, response } = await call(server, "tvdoctor_triage", { scan_id: id });
      expect(data).toMatchObject({ status: "error", code: "incomplete-scan" });
      expect((response.result as { isError: boolean }).isError).toBe(true);
    } finally { server.close(); }
  });

  it("retrieves issue-specific privacy-safe deterministic keypress replay and refuses uncertain exports", async () => {
    const { server } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      const source = report();
      const sequence = [{ key: "SHIFT_TAB" as const, repeat: 1 }, { key: "TAB" as const, repeat: 1 }];
      const transition = source.issues[0]?.transition;
      if (transition === undefined) throw new Error("Test issue missing");
      const good = {
        ...source,
        issues: source.issues.map((issue) => ({ ...issue,
          evidence: [...issue.evidence, { kind: "deterministic-failure" as const,
            summary: "Same modal retained visibility while Tab moved focus outside.",
            source: "scanner", artifact: null }],
          reproduction: {
          status: "available" as const, resetStrategy: "reload" as const,
          originalSequence: sequence, minimizedSequence: null,
          confidence: "deterministic" as const, artifact: null,
        } })),
        replays: [{ schemaVersion: "tvdoctor.replay/v1" as const, id: "replay-issue-1",
          issueId: ISSUE_ID, reset: { strategy: "reload" as const }, steps: sequence,
          assertion: { type: "transition" as const, ...transition },
        }],
      };
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify(good));
      return resultFor(join(request.outputPath, "report.json"));
    });
    const id = await start(server);
    await settle(server, id);
    const { data } = await call(server, "tvdoctor_issue_details", { scan_id: id, issue_id: ISSUE_ID });
    expect(data).toMatchObject({
      classification: "deterministic-replay-available", playwright_assertion_supported: true,
      independent_fix_verification_supported: true,
      export_requires_unredacted_local_report: true,
      reset: "reload", total_keypresses: 2,
      replay_steps: [{ key: "SHIFT_TAB", repeat: 1 }, { key: "TAB", repeat: 1 }],
      assertion_action: "TAB",
    });
    for (const secret of ["SECRET", "SECRET expected", "SECRET observed", "page-link",
      "screenshots/test.png", server.outputRoot, target]) {
      expect(JSON.stringify(data)).not.toContain(secret);
    }
    const { data: wrong } = await call(server, "tvdoctor_issue_details", { scan_id: id, issue_id: "not-found" });
    expect(wrong).toMatchObject({ code: "unknown-issue" });
    const { data: invalid } = await call(server, "tvdoctor_issue_details", {
      scan_id: id, issue_id: ISSUE_ID, route_number: 2,
    });
    expect(invalid).toMatchObject({ code: "invalid-arguments" });
    server.close();
  });

  it("returns only review classification when no deterministic evidence exists", async () => {
    const { server } = await makeServer();
    const id = await start(server);
    await settle(server, id);
    const { data } = await call(server, "tvdoctor_issue_details", { scan_id: id, issue_id: ISSUE_ID });
    expect(data).toMatchObject({ classification: "review-or-incomplete" });
    expect(JSON.stringify(data)).not.toContain("SECRET");
    expect(JSON.stringify(data)).not.toContain("replay_steps");
    server.close();
  });

  it("independently replays an explicitly authorised deterministic finding and returns privacy-safe fix status", async () => {
    const { server, replayCalls } = await makeServer(deterministicScan, async () => ({ status: "fixed", details: [
      "Launch PASS", "Setup 2/2 remote action(s) PASS", "Checkpoint PASS",
      "TAB assertion dispatch PASS", "Replay classification FIXED", "Reason [checkpoint/drift]: SECRET private page text",
    ] }));

    const id = await start(server);
    await settle(server, id);
    const { data: refused, response: refusedResponse } = await call(server, "tvdoctor_replay", {
      scan_id: id, issue_id: ISSUE_ID,
    });
    expect(refused).toMatchObject({ code: "authorization-required" });
    expect((refusedResponse.result as { isError: boolean }).isError).toBe(true);
    expect(replayCalls).toHaveLength(0);

    const { data, response } = await call(server, "tvdoctor_replay", {
      scan_id: id, issue_id: ISSUE_ID, authorized: true,
    });
    expect(data).toMatchObject({
      scan_id: id, issue_id: ISSUE_ID, replay_status: "fixed", fixed: true,
      details: ["Launch PASS", "Setup 2/2 remote action(s) PASS", "Checkpoint PASS",
        "TAB assertion dispatch PASS", "Replay classification FIXED"],
    });
    expect((response.result as { isError: boolean }).isError).toBe(false);
    expect(replayCalls).toHaveLength(1);
    expect(replayCalls[0]).toMatchObject({ issueId: ISSUE_ID, targetOverride: target });
    expect(replayCalls[0]?.reportPath).toContain(server.outputRoot);
    expect(JSON.stringify(data)).not.toContain("SECRET");
    expect(JSON.stringify(data)).not.toContain(target);
    server.close();
  });

  it.each([
    ["fixed", "FIXED", true],
    ["reproduced", "REPRODUCED", false],
    ["inconclusive", "INCONCLUSIVE", null],
    ["error", "INCONCLUSIVE", null],
  ] as const)("tvdoctor_verify_fix maps original deterministic replay %s to %s", async (replayStatus, expected, fixed) => {
    const { server, replayCalls } = await makeServer(deterministicScan, async () => ({
      status: replayStatus, details: ["Launch PASS", "Setup 2/2 remote action(s) PASS",
        "Checkpoint PASS", "TAB assertion dispatch PASS", `Replay classification ${replayStatus.toUpperCase()}`],
    }));
    const id = await start(server);
    await settle(server, id);

    const { data: unauthorized } = await call(server, "tvdoctor_verify_fix", {
      scan_id: id, issue_id: ISSUE_ID,
    });
    expect(unauthorized).toMatchObject({ status: "INCONCLUSIVE", reason: "authorization-required", fixed: null });
    expect(replayCalls).toHaveLength(0);

    const { data } = await call(server, "tvdoctor_verify_fix", {
      scan_id: id, issue_id: ISSUE_ID, authorized: true,
    });
    expect(data).toMatchObject({
      status: expected, verification_status: expected, classification: expected, fixed,
      scan_id: id, issue_id: ISSUE_ID,
      test_conditions: {
        input_mode: "keyboard", max_duration_ms: 30000, max_actions: 500,
        screenshots: true, original_report_sealed_and_verified: true,
        original_navigation_sequence_reused: expected !== "INCONCLUSIVE",
      },
    });
    expect(replayCalls).toHaveLength(1);
    expect(replayCalls[0]).toMatchObject({ issueId: ISSUE_ID, targetOverride: target });
    expect(replayCalls[0]?.reportPath).toContain(server.outputRoot);
    expect(JSON.stringify(data)).not.toContain("SECRET");
    expect(JSON.stringify(data)).not.toContain(target);
    server.close();
  });

  it.each([
    "missing-failure-evidence",
    "verified-fact-is-not-failure",
    "null-observed-focus",
    "missing-checkpoint-source",
    "select-instead-of-tab",
  ] as const)("refuses false FIXED for source-unproven modal-focus-escape: %s", async (mutation) => {
    const { server, replayCalls } = await makeServer(async (request) => {
      const result = await deterministicScan(request);
      const reportPath = result.reportPath;
      if (reportPath === null) throw new Error("Missing deterministic fixture report.");
      const saved = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
      const issue = saved.issues[0];
      const replay = saved.replays[0];
      if (issue === undefined || replay === undefined || issue.transition === null) {
        throw new Error("Missing original modal source/replay.");
      }
      const evidence = mutation === "missing-failure-evidence"
        ? []
        : mutation === "verified-fact-is-not-failure"
          ? issue.evidence.map((item) => item.kind === "deterministic-failure"
            ? { ...item, kind: "verified-fact" as const } : item)
          : issue.evidence;
      const transition = mutation === "null-observed-focus"
        ? { ...issue.transition, observedElement: null }
        : mutation === "missing-checkpoint-source"
          ? { ...issue.transition, fromElement: null }
          : mutation === "select-instead-of-tab"
            ? { ...issue.transition, action: "SELECT" as const }
            : issue.transition;
      const steps = mutation === "select-instead-of-tab"
        ? [{ key: "SELECT" as const, repeat: 1 }] : replay.steps;
      await writeFile(reportPath, JSON.stringify({ ...saved,
        issues: [{ ...issue, evidence, transition, reproduction: { ...issue.reproduction,
          originalSequence: steps } }],
        replays: [{ ...replay, steps, assertion: { type: "transition", ...transition } }],
      }));
      return result;
    }, async () => ({ status: "fixed", details: ["Replay classification FIXED"] }));
    try {
      const scanId = await start(server);
      expect(await settle(server, scanId)).toMatchObject({ status: "completed" });
      const details = await call(server, "tvdoctor_issue_details", { scan_id: scanId, issue_id: ISSUE_ID });
      expect(details.data).toMatchObject({
        classification: "deterministic-replay-available",
        independent_fix_verification_supported: false,
        playwright_assertion_supported: false,
      });
      const verification = await call(server, "tvdoctor_verify_fix", {
        scan_id: scanId, issue_id: ISSUE_ID, authorized: true,
      });
      expect(verification.data).toMatchObject({
        status: "INCONCLUSIVE", verification_status: "INCONCLUSIVE",
        reason: "unsupported-rule-assertion", fixed: null,
      });
      expect(replayCalls).toHaveLength(0);
    } finally { server.close(); }
  });

  it("refuses modal-focus-escape verification when original deterministic failure evidence was changed after sealing", async () => {
    const { server, replayCalls } = await makeServer(deterministicScan,
      async () => ({ status: "fixed", details: [] }));
    try {
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      const reportPath = join(server.outputRoot, id, "report.json");
      const saved = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
      const issue = saved.issues[0];
      if (issue === undefined) throw new Error("Original finding missing.");
      await writeFile(reportPath, JSON.stringify({ ...saved,
        issues: [{ ...issue, evidence: issue.evidence.filter((entry) => entry.kind !== "deterministic-failure") }],
      }));
      const verification = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true,
      });
      expect(verification.data).toMatchObject({
        status: "INCONCLUSIVE", reason: "report-unavailable", fixed: null,
      });
      expect(replayCalls).toHaveLength(0);
    } finally { server.close(); }
  });

  it.each([
    ["fixed", "FIXED", true],
    ["reproduced", "REPRODUCED", false],
    ["inconclusive", "INCONCLUSIVE", null],
  ] as const)("permits source-proven modal Tab-focus-loss oracle and maps mocked replay %s to %s", async (replayStatus, expected, fixed) => {
    const { server, replayCalls } = await makeServer(modalTabFocusLossScan, async () => ({
      status: replayStatus, details: ["Launch PASS", "Checkpoint PASS", "TAB assertion dispatch PASS"],
    }));
    try {
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      const details = await call(server, "tvdoctor_issue_details", { scan_id: id, issue_id: ISSUE_ID });
      expect(details.data).toMatchObject({
        classification: "deterministic-replay-available",
        rule: "keyboard.modal-tab-focus-loss",
        independent_fix_verification_supported: true,
        playwright_assertion_supported: false,
      });
      const refused = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID,
      });
      expect(refused.data).toMatchObject({ status: "INCONCLUSIVE", reason: "authorization-required" });
      expect(replayCalls).toHaveLength(0);
      const { data } = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true,
      });
      expect(data).toMatchObject({ status: expected, classification: expected, fixed,
        test_conditions: { original_report_sealed_and_verified: true },
      });
      expect(replayCalls).toHaveLength(1);
      expect(replayCalls[0]).toMatchObject({ issueId: ISSUE_ID, targetOverride: target,
        confirmStableFix: true });
      expect(JSON.stringify(data)).not.toContain("SECRET");
    } finally { server.close(); }
  });

  it("never upgrades a modal Tab-focus-loss label into FIXED without compiler-backed source evidence", async () => {
    const { server, replayCalls } = await makeServer((request) => modalTabFocusLossScan(request, false),
      async () => ({ status: "fixed", details: ["Replay classification FIXED"] }));
    try {
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      const details = await call(server, "tvdoctor_issue_details", { scan_id: id, issue_id: ISSUE_ID });
      expect(details.data).toMatchObject({ independent_fix_verification_supported: false,
        playwright_assertion_supported: false });
      const { data } = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true,
      });
      expect(data).toMatchObject({ status: "INCONCLUSIVE", reason: "unsupported-rule-assertion", fixed: null });
      expect(replayCalls).toHaveLength(0);
    } finally { server.close(); }
  });

  it("rejects modal Tab-focus-loss when the original transition has a non-null after-focus witness", async () => {
    const { server, replayCalls } = await makeServer(async (request) => {
      const result = await modalTabFocusLossScan(request);
      const reportPath = result.reportPath;
      if (reportPath === null) throw new Error("No synthetic report was saved.");
      const source = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
      const issue = source.issues[0];
      const replay = source.replays[0];
      if (issue?.transition === null || issue === undefined || replay === undefined) throw new Error("Synthetic evidence invalid.");
      const transition = { ...issue.transition, observedElement: "outside" };
      await writeFile(reportPath, JSON.stringify({ ...source,
        issues: [{ ...issue, transition }],
        replays: [{ ...replay, assertion: { type: "transition", ...transition } }],
      }));
      return result;
    }, async () => ({ status: "fixed", details: [] }));
    try {
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      const details = await call(server, "tvdoctor_issue_details", { scan_id: id, issue_id: ISSUE_ID });
      expect(details.data).toMatchObject({ independent_fix_verification_supported: false });
      const { data } = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true,
      });
      expect(data).toMatchObject({ status: "INCONCLUSIVE", reason: "unsupported-rule-assertion", fixed: null });
      expect(replayCalls).toHaveLength(0);
    } finally { server.close(); }
  });

  it("retains exact authorized journey ID and sealed bytes when verifying the new modal Tab-loss rule", async () => {
    const dir = join(tmpdir(), `tvdoctor-mcp-tab-loss-journey-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "login.json");
    const config = { schemaVersion: "tvdoctor.journey/v1", name: "Verified login",
      maxDurationMs: 30000, steps: [{ action: "press", key: "TAB" }] };
    const contents = JSON.stringify(config);
    const fingerprint = parseJourney(config).sha256;
    await writeFile(path, contents);
    const { server, replayCalls } = await makeServer(async (request) => {
      const result = await modalTabFocusLossScan(request);
      const reportPath = result.reportPath;
      if (reportPath === null) throw new Error("Missing synthetic report.");
      const saved = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
      await writeFile(reportPath, JSON.stringify({ ...saved,
        target: { ...saved.target, environment: { ...saved.target.environment, journeyConfigSha256: fingerprint } },
      }));
      return result;
    }, async (request) => {
      if (request.journeyPath === undefined) throw new Error("Replay lost the original journey.");
      expect(JSON.parse(await readFile(request.journeyPath, "utf8"))).toEqual(config);
      return { status: "fixed", details: ["Replay classification FIXED"] };
    }, { login: { path, target, sha256: createHash("sha256").update(contents).digest("hex") } });
    try {
      const id = await start(server, { journey: "login" });
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      for (const supplied of [undefined, "another"] as const) {
        const { data } = await call(server, "tvdoctor_verify_fix", {
          scan_id: id, issue_id: ISSUE_ID, authorized: true,
          ...(supplied === undefined ? {} : { journey: supplied }),
        });
        expect(data).toMatchObject({ status: "INCONCLUSIVE", reason: "journey-mismatch", fixed: null });
      }
      expect(replayCalls).toHaveLength(0);
      const valid = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "login",
      });
      expect(valid.data).toMatchObject({ status: "FIXED", fixed: true });
      expect(replayCalls).toHaveLength(1);
      expect(replayCalls[0]?.confirmStableFix).toBe(true);
      await writeFile(join(server.outputRoot, id, "journey.json"), '{"tampered":true}');
      const stale = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "login",
      });
      expect(stale.data).toMatchObject({ status: "INCONCLUSIVE", reason: "stale-journey", fixed: null });
      expect(replayCalls).toHaveLength(1);
    } finally { server.close(); }
  });

  it.each([
    ["fixed", "FIXED", true],
    ["reproduced", "REPRODUCED", false],
    ["inconclusive", "INCONCLUSIVE", null],
  ] as const)("permits exact compiler-proven modal-open SELECT witness and maps mocked replay %s to %s", async (status, verdict, fixed) => {
    const { server, replayCalls } = await makeServer(modalOpenFocusNotTransferredScan,
      async () => ({ status, details: ["Launch PASS", "SELECT assertion dispatch PASS"] }));
    try {
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      const details = await call(server, "tvdoctor_issue_details", { scan_id: id, issue_id: ISSUE_ID });
      expect(details.data).toMatchObject({ classification: "deterministic-replay-available",
        rule: "keyboard.modal-open-focus-not-transferred", assertion_action: "SELECT",
        independent_fix_verification_supported: true, playwright_assertion_supported: false });
      const unauthorized = await call(server, "tvdoctor_verify_fix", { scan_id: id, issue_id: ISSUE_ID });
      expect(unauthorized.data).toMatchObject({ status: "INCONCLUSIVE", reason: "authorization-required", fixed: null });
      expect(replayCalls).toHaveLength(0);
      const valid = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true,
      });
      expect(valid.data).toMatchObject({ status: verdict, classification: verdict, fixed,
        test_conditions: { original_report_sealed_and_verified: true } });
      expect(replayCalls).toHaveLength(1);
      expect(replayCalls[0]).toMatchObject({ issueId: ISSUE_ID, targetOverride: target, confirmStableFix: true });
      expect(JSON.stringify(valid.data)).not.toContain("preferences-modal");
      expect(JSON.stringify(valid.data)).not.toContain("Open preferences");
    } finally { server.close(); }
  });

  it.each([
    ["missing-witness", "missing-witness"],
    ["changed-modal-id", "changed-modal-id"],
    ["changed-modal-role", "changed-modal-role"],
    ["invalid-opener-name", "invalid-opener-name"],
    ["missing-failure", "missing-failure"],
    ["different-rule", "different-rule"],
    ["not-select", "not-select"],
    ["different-observed", "different-observed"],
  ] as const)("refuses unproven modal-open SELECT fix: %s", async (_label, mutation) => {
    const { server, replayCalls } = await makeServer(async (request) => {
      const result = await modalOpenFocusNotTransferredScan(request);
      const path = result.reportPath;
      if (path === null) throw new Error("Fixture report missing.");
      const saved = JSON.parse(await readFile(path, "utf8")) as TVDoctorReportV1;
      const issue = saved.issues[0];
      const replay = saved.replays[0];
      if (issue === undefined || replay === undefined || issue.transition === null) throw new Error("Fixture issue missing.");
      const forged: {
        modal: { stableId: string; role: string; name: string };
        opener: { stableId: string; role: string; name: string };
      } = { ...modalOpenWitness,
        modal: { ...modalOpenWitness.modal }, opener: { ...modalOpenWitness.opener } };
      if (mutation === "changed-modal-id") forged.modal.stableId = "unrelated-modal";
      if (mutation === "changed-modal-role") forged.modal.role = "button";
      if (mutation === "invalid-opener-name") forged.opener.name = "";
      const evidence = issue.evidence.filter((entry) => mutation === "missing-failure"
        ? entry.kind !== "deterministic-failure" : mutation !== "missing-witness" || entry.kind !== "verified-fact")
        .map((entry) => entry.kind === "verified-fact" ? { ...entry, summary: JSON.stringify(forged) } : entry);
      const transition = mutation === "not-select"
        ? { ...issue.transition, action: "TAB" as const }
        : mutation === "different-observed"
          ? { ...issue.transition, observedElement: "other-control" } : issue.transition;
      const steps = mutation === "not-select" ? [{ key: "TAB" as const, repeat: 1 }] : replay.steps;
      await writeFile(path, JSON.stringify({ ...saved,
        issues: [{ ...issue, rule: mutation === "different-rule" ? "keyboard.unvisited-control" : issue.rule,
          transition, evidence, reproduction: { ...issue.reproduction, originalSequence: steps } }],
        replays: [{ ...replay, steps, assertion: { type: "transition", ...transition } }],
      }));
      return result;
    }, async () => ({ status: "fixed", details: ["Replay classification FIXED"] }));
    try {
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      const details = await call(server, "tvdoctor_issue_details", { scan_id: id, issue_id: ISSUE_ID });
      expect(details.data).toMatchObject({ independent_fix_verification_supported: false });
      const result = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true,
      });
      expect(result.data).toMatchObject({ status: "INCONCLUSIVE", reason: "unsupported-rule-assertion", fixed: null });
      expect(replayCalls).toHaveLength(0);
    } finally { server.close(); }
  });

  it("keeps source-proven modal-open SELECT verification bound to its sealed report and registered journey", async () => {
    const folder = join(tmpdir(), `tvdoctor-mcp-modal-open-journey-${randomUUID()}`);
    await mkdir(folder, { recursive: true });
    const journeyPath = join(folder, "setup.json");
    const setup = { schemaVersion: "tvdoctor.journey/v1", name: "Authorized workspace",
      maxDurationMs: 30000, steps: [{ action: "press", key: "TAB" }] };
    const contents = JSON.stringify(setup);
    await writeFile(journeyPath, contents);
    const { server, replayCalls } = await makeServer(async (request) => {
      const result = await modalOpenFocusNotTransferredScan(request);
      if (result.reportPath === null) throw new Error("Missing synthetic report.");
      const saved = JSON.parse(await readFile(result.reportPath, "utf8")) as TVDoctorReportV1;
      await writeFile(result.reportPath, JSON.stringify({ ...saved,
        target: { ...saved.target, environment: { ...saved.target.environment,
          journeyConfigSha256: parseJourney(setup).sha256 } },
      }));
      return result;
    }, async (request) => {
      if (request.journeyPath === undefined) throw new Error("Replay omitted its owned journey copy.");
      expect(JSON.parse(await readFile(request.journeyPath, "utf8"))).toEqual(setup);
      return { status: "reproduced", details: ["Replay classification REPRODUCED"] };
    }, { workspace: { path: journeyPath, target,
      sha256: createHash("sha256").update(contents).digest("hex") } });
    try {
      const id = await start(server, { journey: "workspace" });
      expect(await settle(server, id)).toMatchObject({ status: "completed" });
      for (const supplied of [undefined, "other"] as const) {
        const rejected = await call(server, "tvdoctor_verify_fix", {
          scan_id: id, issue_id: ISSUE_ID, authorized: true,
          ...(supplied === undefined ? {} : { journey: supplied }),
        });
        expect(rejected.data).toMatchObject({ status: "INCONCLUSIVE", reason: "journey-mismatch", fixed: null });
      }
      expect(replayCalls).toHaveLength(0);
      const allowed = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "workspace",
      });
      expect(allowed.data).toMatchObject({ status: "REPRODUCED", fixed: false });
      expect(replayCalls).toHaveLength(1);
      expect(replayCalls[0]?.confirmStableFix).toBe(true);
      const reportPath = join(server.outputRoot, id, "report.json");
      const original = await readFile(reportPath, "utf8");
      await writeFile(reportPath, original.replace("preferences-modal", "tampered-modal"));
      const corruptedReport = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "workspace",
      });
      expect(corruptedReport.data).toMatchObject({ status: "INCONCLUSIVE", reason: "report-unavailable", fixed: null });
      expect(replayCalls).toHaveLength(1);
      await writeFile(reportPath, original);
      await writeFile(join(server.outputRoot, id, "journey.json"), "changed owned copy");
      const corruptedJourney = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true, journey: "workspace",
      });
      expect(corruptedJourney.data).toMatchObject({ status: "INCONCLUSIVE", reason: "stale-journey", fixed: null });
      expect(replayCalls).toHaveLength(1);
    } finally { server.close(); }
  });

  it("returns INCONCLUSIVE when the original report evidence changes after the scan", async () => {
    const { server, replayCalls } = await makeServer(deterministicScan);
    const id = await start(server);
    await settle(server, id);
    const reportPath = join(server.outputRoot, id, "report.json");
    const saved = JSON.parse(await readFile(reportPath, "utf8")) as {
      issues: { title: string }[];
    };
    const issue = saved.issues[0];
    if (issue === undefined) throw new Error("Original finding missing from report.");
    issue.title = "Tampered after original scan";
    await writeFile(reportPath, JSON.stringify(saved));

    const { data } = await call(server, "tvdoctor_verify_fix", {
      scan_id: id, issue_id: ISSUE_ID, authorized: true,
    });
    expect(data).toMatchObject({ status: "INCONCLUSIVE", verification_status: "INCONCLUSIVE",
      reason: "report-unavailable", fixed: null });
    expect(replayCalls).toHaveLength(0);
    server.close();
  });

  it("does not promote a deterministic label replay into a FIXED result without a rule-specific predicate", async () => {
    const { server, replayCalls } = await makeServer(async (request) => {
      const result = await deterministicScan(request);
      const reportPath = join(request.outputPath, "report.json");
      const saved = JSON.parse(await readFile(reportPath, "utf8")) as TVDoctorReportV1;
      const original = saved.issues[0];
      if (original === undefined) throw new Error("Original issue missing.");
      await writeFile(reportPath, JSON.stringify({
        ...saved,
        issues: [{ ...original, rule: "remote.focus-trap" }],
      }));
      return result;
    }, async () => ({ status: "fixed", details: ["Replay classification FIXED"] }));
    try {
      const id = await start(server);
      await settle(server, id);
      const { data } = await call(server, "tvdoctor_verify_fix", {
        scan_id: id, issue_id: ISSUE_ID, authorized: true,
      });
      expect(data).toMatchObject({ status: "INCONCLUSIVE", reason: "unsupported-rule-assertion", fixed: null });
      expect(replayCalls).toHaveLength(0);
    } finally { server.close(); }
  });

  it("compares real baseline files and returns finding, metadata, navigation and integrity evidence", async () => {
    const { server } = await makeComparisonServer({
      issuesForRun: (index) => index === 0
        ? [comparisonIssue("stable-finding", "medium", "deterministic"), comparisonIssue("resolved-finding", "low", "heuristic")]
        : [comparisonIssue("stable-finding", "critical", "heuristic"), comparisonIssue("new-finding", "high", "deterministic")],
    });
    try {
      const baselineId = await start(server);
      await settle(server, baselineId);
      const currentId = await start(server);
      await settle(server, currentId);
      const { data } = await call(server, "tvdoctor_compare", {
        baseline_scan_id: baselineId, current_scan_id: currentId,
      });
      expect(data).toMatchObject({
        status: "regressed", classification: "regressed", should_fail: true,
        baseline_scan_id: baselineId, current_scan_id: currentId, same_test_conditions: true,
        counts: {
          new_findings: 1, resolved_findings: 1, unchanged_findings: 1,
          issue_metadata_changes: 1, severity_escalations: 1, confidence_downgrades: 1,
          focus_targets_added: 1, focus_targets_removed: 1, transitions_changed: 1,
        },
        new_findings: [{ id: "new-finding", severity: "high" }],
        resolved_findings: [{ id: "resolved-finding", severity: "low",
          resolution_verified: false,
          interpretation: "no-longer-observed-not-independently-fixed",
          possible_identity_churn: true }],
        unchanged_findings: [{ id: "stable-finding", severity: "critical", confidence: "heuristic" }],
        navigation_changes: {
          focus_targets_added: [{ key: "focus-f", screen_key: "screen-3" }],
          focus_targets_removed: [{ key: "focus-e", screen_key: "screen-3" }],
          transitions_changed: [{ key: "edge-4" }],
        },
        issue_metadata_changes: [{ id: "stable-finding", severity_escalated: true, confidence_downgraded: true }],
        evidence_integrity: {
          baseline_report_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          current_report_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          baseline_inventory_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          current_inventory_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect((await readdir(server.outputRoot)).sort()).toEqual([baselineId, currentId].sort());
    } finally { server.close(); }
  });

  it.each([
    ["different requested action budgets", { currentMaxActions: 300 }, "test-conditions-differ"],
    ["partial runs", { runStatus: "partial" }, "incomplete-run"],
    ["missing inventory", { omitInventory: true }, "inventory-unavailable"],
    ["invalid inventory checksum", { corruptInventoryHash: true }, "inventory-unavailable"],
    ["wrong inventory artifact kind", { inventoryKind: "screenshot" }, "inventory-unavailable"],
    ["wrong inventory media type", { inventoryMediaType: "text/plain" }, "inventory-unavailable"],
  ] as const)("tvdoctor_compare fails closed for %s", async (_label, configuration, reason) => {
    const maxActions = "currentMaxActions" in configuration ? configuration.currentMaxActions : undefined;
    const serverOptions = maxActions === undefined ? configuration : {};
    const { server } = await makeComparisonServer(serverOptions);
    try {
      const baselineId = await start(server);
      await settle(server, baselineId);
      const currentId = await start(server, maxActions === undefined
        ? {} : { max_actions: maxActions });
      await settle(server, currentId);
      const { data } = await call(server, "tvdoctor_compare", {
        baseline_scan_id: baselineId, current_scan_id: currentId,
      });
      expect(data).toMatchObject({ status: "inconclusive", classification: "inconclusive", reason });
      expect(data["resolved_findings"]).toBeUndefined();
    } finally { server.close(); }
  });

  it("snapshots the exact validated report and inventory before the baseline adapter reads them", async () => {
    const { server } = await makeComparisonServer({
      inventoryForRun: () => comparisonInventory(false),
      onCreateBaseline: async (firstOutputPath) => {
        await writeFile(join(firstOutputPath, "report.json"), "tampered after MCP validation");
        await writeFile(join(firstOutputPath, "inventory.json"), "tampered after MCP validation");
      },
    });
    try {
      const baselineId = await start(server);
      await settle(server, baselineId);
      const currentId = await start(server);
      await settle(server, currentId);
      const { data } = await call(server, "tvdoctor_compare", {
        baseline_scan_id: baselineId, current_scan_id: currentId,
      });
      expect(data).toMatchObject({ status: "identical", classification: "no-regressions",
        same_test_conditions: true, counts: { new_findings: 0, resolved_findings: 0, unchanged_findings: 0 } });
    } finally { server.close(); }
  });

  it.each([
    ["recorded action budget differs from the submitted scan budget", "budget", "coverage-conditions-differ"],
    ["unknown recorded input mode", "mode", "coverage-conditions-differ"],
    ["report run identity reused", "run", "duplicate-run-identity"],
  ] as const)("refuses incomparable run provenance: %s", async (_label, variation, reason) => {
    const { server } = await makeComparisonServer({
      inventoryForRun: () => comparisonInventory(false),
      reportForRun: (scanReport, index) => index === 0 ? scanReport
        : variation === "budget" ? {
          ...scanReport,
          coverage: { ...scanReport.coverage, budget: { ...scanReport.coverage.budget, maxActions: 900 } },
        } : variation === "mode" ? {
          ...scanReport,
          target: { ...scanReport.target, environment: { ...scanReport.target.environment, inputMode: "keybaord" } },
        } : {
          ...scanReport, run: { ...scanReport.run, id: "mcp-compare-run-1" },
        },
    });
    try {
      const before = await start(server);
      await settle(server, before);
      const after = await start(server);
      await settle(server, after);
      const { data } = await call(server, "tvdoctor_compare", {
        baseline_scan_id: before, current_scan_id: after,
      });
      expect(data).toMatchObject({ status: "inconclusive", classification: "inconclusive", reason });
      expect(data["resolved_findings"]).toBeUndefined();
    } finally { server.close(); }
  });

  it("does not mistake insertion order of equivalent report environment metadata for changed conditions", async () => {
    const { server } = await makeComparisonServer({
      inventoryForRun: () => comparisonInventory(false),
      reportForRun: (scanReport, index) => index === 0 ? scanReport : {
        ...scanReport,
        target: { ...scanReport.target, environment: {
          inputMode: "keyboard", browser: "chromium",
        } },
      },
    });
    try {
      const before = await start(server);
      await settle(server, before);
      const after = await start(server);
      await settle(server, after);
      const { data } = await call(server, "tvdoctor_compare", {
        baseline_scan_id: before, current_scan_id: after,
      });
      expect(data).toMatchObject({ status: "identical", classification: "no-regressions" });
    } finally { server.close(); }
  });

  it("returns INCONCLUSIVE for stale reports, duplicate scan IDs and failed comparison operations", async () => {
    const stale = await makeComparisonServer({ inventoryForRun: () => comparisonInventory(false) });
    try {
      const baselineId = await start(stale.server);
      await settle(stale.server, baselineId);
      const currentId = await start(stale.server);
      await settle(stale.server, currentId);
      await writeFile(join(stale.server.outputRoot, baselineId, "report.json"), "stale report bytes");
      const { data: staleResult } = await call(stale.server, "tvdoctor_compare", {
        baseline_scan_id: baselineId, current_scan_id: currentId,
      });
      expect(staleResult).toMatchObject({ status: "inconclusive", reason: "report-unavailable" });
      const { data: same } = await call(stale.server, "tvdoctor_compare", {
        baseline_scan_id: currentId, current_scan_id: currentId,
      });
      expect(same).toMatchObject({ status: "inconclusive", reason: "same-scan" });
      const { data: foreign } = await call(stale.server, "tvdoctor_compare", {
        baseline_scan_id: "unknown-scan", current_scan_id: currentId,
      });
      expect(foreign).toMatchObject({ status: "inconclusive", reason: "unknown-scan" });
    } finally { stale.server.close(); }

    const failed = await makeComparisonServer({
      inventoryForRun: () => comparisonInventory(false), failCompare: true,
    });
    try {
      const baselineId = await start(failed.server);
      await settle(failed.server, baselineId);
      const currentId = await start(failed.server);
      await settle(failed.server, currentId);
      const { data } = await call(failed.server, "tvdoctor_compare", {
        baseline_scan_id: baselineId, current_scan_id: currentId,
      });
      expect(data).toMatchObject({ status: "inconclusive", reason: "comparison-failed" });
      expect((await readdir(failed.server.outputRoot)).sort()).toEqual([baselineId, currentId].sort());
    } finally { failed.server.close(); }
  });

  it("supports MCP cancellation and prevents overlapping replay or scan operations", async () => {
    const { server, replayCalls } = await makeServer(deterministicScan, async (request) =>
      await new Promise((resolve) => {
        if (request.signal?.aborted) {
          resolve({ status: "error", details: [] });
          return;
        }
        request.signal?.addEventListener("abort", () => resolve({ status: "error", details: [] }), { once: true });
      }));
    const id = await start(server);
    await settle(server, id);
    const pending = server.handle({
      jsonrpc: "2.0", id: "replay-request", method: "tools/call",
      params: { name: "tvdoctor_replay", arguments: { scan_id: id, issue_id: ISSUE_ID, authorized: true } },
    });
    await vi.waitFor(() => expect(replayCalls).toHaveLength(1));

    const { data: replayBusy } = await call(server, "tvdoctor_replay", {
      scan_id: id, issue_id: ISSUE_ID, authorized: true,
    }, 2);
    expect(replayBusy).toMatchObject({ code: "replay-busy" });
    const { data: scanBusy } = await call(server, "tvdoctor_scan", {
      url: target, authorized: true,
    }, 3);
    expect(scanBusy).toMatchObject({ code: "replay-busy" });

    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled",
      params: { requestId: "replay-request" } })).toBeNull();
    const response = await pending;
    const first = (response?.result as { content: { type: string; text: string }[] }).content[0];
    if (first === undefined) throw new Error("Cancelled replay did not return a result.");
    expect(JSON.parse(first.text)).toMatchObject({ replay_status: "cancelled", fixed: null });
    server.close();
  });

  it("refuses replay for partial scans and findings without deterministic reproduction", async () => {
    const { server, replayCalls } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify(report("partial")));
      return resultFor(join(request.outputPath, "report.json"), "partial");
    });
    const id = await start(server);
    await settle(server, id);
    const { data } = await call(server, "tvdoctor_replay", {
      scan_id: id, issue_id: ISSUE_ID, authorized: true,
    });
    expect(data).toMatchObject({ code: "incomplete-scan" });
    expect(replayCalls).toHaveLength(0);
    server.close();
  });

  it.each([
    ["reproduced", false],
    ["inconclusive", null],
    ["error", null],
  ] as const)("does not claim a finding is fixed when replay returns %s", async (replayStatus, fixed) => {
    const { server } = await makeServer(deterministicScan, async () => ({ status: replayStatus, details: [] }));
    const id = await start(server);
    await settle(server, id);
    const { data } = await call(server, "tvdoctor_replay", {
      scan_id: id, issue_id: ISSUE_ID, authorized: true,
    });
    expect(data).toMatchObject({ replay_status: replayStatus, fixed });
    server.close();
  });

  it("lists private evidence metadata and retrieves an explicitly acknowledged bounded screenshot", async () => {
    const { server } = await makeServer();
    const id = await start(server);
    await settle(server, id);
    const { data: listing } = await call(server, "tvdoctor_evidence", { scan_id: id });
    expect(listing).toMatchObject({
      total_artifacts: 1,
      artifacts: [{ id: ARTIFACT_ID, kind: "screenshot", status: "available" }],
    });
    expect(JSON.stringify(listing)).not.toContain("screenshots/test.png");
    const { data: descriptor } = await call(server, "tvdoctor_evidence", { scan_id: id, artifact_id: ARTIFACT_ID });
    expect(descriptor).toMatchObject({ artifact_id: ARTIFACT_ID, byte_length: bytes.length });
    const { data: refused } = await call(server, "tvdoctor_evidence", {
      scan_id: id, artifact_id: ARTIFACT_ID, include_content: true,
    });
    expect(refused).toMatchObject({ code: "acknowledgment-required" });
    const { response } = await call(server, "tvdoctor_evidence", {
      scan_id: id, artifact_id: ARTIFACT_ID,
      include_content: true, acknowledge_sensitive: true,
    });
    const parts = (response.result as { content: { type: string; data?: string; mimeType?: string }[] }).content;
    expect(parts[1]).toMatchObject({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
    server.close();
  });

  it("refuses secret URLs, unsupported arguments and arbitrary report reads", async () => {
    const { server, calls } = await makeServer();
    const scenarios = [
      { url: "https://example.test/?token=secret", authorized: true },
      { url: "https://example.test/#private", authorized: true },
      { url: "https://name:password@example.test/", authorized: true },
      { url: "file:///etc/passwd", authorized: true },
      { url: "https://example.test", authorized: false },
      { url: target, authorized: true, output: "C:/Windows/System32/" },
      { url: target, authorized: true, journey: "secret.json" },
      { url: target, authorized: true, max_actions: 2001 },
      { url: target, authorized: true, max_duration_ms: 999999999 },
    ];
    for (const input of scenarios) {
      const { data, response } = await call(server, "tvdoctor_scan", input);
      expect((response.result as { isError: boolean }).isError).toBe(true);
      expect(data["status"]).toBe("error");
      expect(JSON.stringify(data)).not.toContain("password");
      expect(JSON.stringify(data)).not.toContain("token=secret");
      expect(JSON.stringify(data)).not.toContain("name:password");
    }
    expect(calls).toHaveLength(0);
    const { data: unknown } = await call(server, "tvdoctor_evidence", {
      scan_id: "../secrets", artifact_id: "../../passwd", include_content: true, acknowledge_sensitive: true,
    });
    expect(unknown["code"]).toBe("unknown-scan");
    server.close();
  });

  it("distinguishes pending, partial and cancellation without claiming completed coverage", async () => {
    let release: ((value: TestCommandResult) => void) | undefined;
    const waiting = new Promise<TestCommandResult>((resolveWait) => { release = resolveWait; });
    const { server, calls } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify(report("partial")));
      return await waiting;
    });
    const id = await start(server);
    const { data: status } = await call(server, "tvdoctor_status", { scan_id: id });
    expect(status).toMatchObject({ status: "pending" });
    const { data: pendingFindings } = await call(server, "tvdoctor_findings", { scan_id: id });
    expect(pendingFindings).toMatchObject({ status: "pending", findings: [] });
    const { data: concurrent, response } = await call(server, "tvdoctor_scan", { authorized: true, url: target });
    expect(concurrent["code"]).toBe("scan-busy");
    expect((response.result as { isError: boolean }).isError).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.signal?.aborted).toBe(false);
    const { data: cancelled } = await call(server, "tvdoctor_cancel", { scan_id: id });
    expect(cancelled).toMatchObject({ cancellation_requested: true, status: "pending" });
    expect(calls[0]?.signal?.aborted).toBe(true);
    const first = calls[0];
    if (first === undefined) throw new Error("Expected a captured scan.");
    release?.(resultFor(join(first.outputPath, "report.json"), "partial"));
    expect(await settle(server, id)).toMatchObject({ status: "cancelled", report_available: true });
    const { data: findings } = await call(server, "tvdoctor_findings", { scan_id: id });
    expect(findings).toMatchObject({ status: "cancelled", report_status: "partial", termination: ["duration"] });
    server.close();
  });

  it("preserves partial reports even without cancellation", async () => {
    const { server } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify(report("partial")));
      return resultFor(join(request.outputPath, "report.json"), "partial");
    });
    const id = await start(server);
    expect(await settle(server, id)).toMatchObject({ status: "partial" });
    const { data } = await call(server, "tvdoctor_findings", { scan_id: id });
    expect(data["status"]).toBe("partial");
    expect(data["termination"]).toEqual(["duration"]);
    expect(data["coverage"]).toMatchObject({ navigation: null });
    server.close();
  });

  it("exposes the untested navigation frontier for a partial scan without budget exhaustion", async () => {
    const { server } = await makeServer(async (request) => {
      const path = join(request.outputPath, "report.json");
      const partial = report("partial");
      await mkdir(request.outputPath, { recursive: true });
      await writeFile(path, JSON.stringify({
        ...partial,
        coverage: { ...partial.coverage, budget: { ...partial.coverage.budget, exhausted: [] } },
      }));
      return {
        ...resultFor(path, "partial"),
        navigationCoverage: {
          reason: "restoration-failed",
          complete: false,
          pendingStates: 4,
          remainingFrontierEntries: null,
          remainingCandidateActions: null,
          deferredStates: 2,
        },
      };
    });
    try {
      const id = await start(server);
      expect(await settle(server, id)).toMatchObject({ status: "partial" });
      const { data } = await call(server, "tvdoctor_findings", { scan_id: id });
      expect(data).toMatchObject({
        status: "partial",
        termination: [],
        coverage: {
          navigation: {
            reason: "restoration-failed",
            complete: false,
            pending_states: 4,
            remaining_frontier_entries: null,
            remaining_candidate_actions: null,
            deferred_states: 2,
          },
        },
      });
      expect(JSON.stringify(data)).not.toContain("SECRET");
    } finally {
      server.close();
    }
  });

  it("honors standard MCP notifications/cancelled for a scan request ID", async () => {
    let release: ((value: TestCommandResult) => void) | undefined;
    const waiting = new Promise<TestCommandResult>((resolveWait) => { release = resolveWait; });
    const { server, calls } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify(report("partial")));
      return await waiting;
    });
    const { data } = await call(server, "tvdoctor_scan", { url: target, authorized: true }, 91);
    const scanId = data["scan_id"];
    if (typeof scanId !== "string") throw new Error("Expected scan_id.");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await server.handle({
      jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 91, reason: "User cancelled" },
    })).toBeNull();
    expect(calls[0]?.signal?.aborted).toBe(true);
    const first = calls[0];
    if (first === undefined) throw new Error("Expected captured request.");
    release?.(resultFor(join(first.outputPath, "report.json"), "partial"));
    expect(await settle(server, scanId)).toMatchObject({ status: "cancelled" });
    server.close();
  });

  it("rejects forged report paths and reports with a different recorded origin", async () => {
    const { server: forged } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      return resultFor(join(tmpdir(), "unrelated-report.json"));
    });
    const forgedId = await start(forged);
    expect(await settle(forged, forgedId)).toMatchObject({ status: "failed", report_available: false });
    forged.close();

    const { server: wrongOrigin } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      const changed = { ...report(), target: { ...report().target, location: "https://elsewhere.example" } };
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify(changed));
      return resultFor(join(request.outputPath, "report.json"));
    });
    const id = await start(wrongOrigin);
    expect(await settle(wrongOrigin, id)).toMatchObject({ status: "failed", report_available: false });
    wrongOrigin.close();
  });

  it("rejects invalid and oversized report content rather than fabricating findings", async () => {
    const { server } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      await writeFile(join(request.outputPath, "report.json"), "malformed");
      return resultFor(join(request.outputPath, "report.json"));
    });
    const id = await start(server);
    await settle(server, id);
    const { data, response } = await call(server, "tvdoctor_findings", { scan_id: id });
    expect((response.result as { isError: boolean }).isError).toBe(true);
    expect(data["code"]).toBe("report-unavailable");
    server.close();
  });
});

describe("MCP production site and responsive scanners", () => {
  it("runs actual site route discovery and responsive Chromium audits with owned index inspection", async () => {
    const requests: string[] = [];
    const fixture = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>@media(max-width:600px){.overflow{width:740px}
          .crop{width:80px;height:38px;overflow:hidden;margin:12px 0}
          .crop button{width:190px;height:38px}
          .stack{position:relative;height:65px}
          .stack button{position:absolute;top:0;left:0;width:140px;height:45px}
          .stack .above{top:4px;left:10px;z-index:2}
        }</style></head>
        <body><main class="overflow"><a href="/second">Second page</a>
        <button type="button">Focus target</button>
        <button type="button" id="menu-toggle" aria-expanded="false" aria-controls="lab-menu">Open menu</button>
        <nav id="lab-menu" hidden><a href="#details">Details</a></nav>
        <div class="crop"><button type="button">Clipped</button></div>
        <div class="stack"><button type="button">Covered</button><button class="above" type="button">Overlay</button></div>
        </main><script>document.querySelector('#menu-toggle').addEventListener('click',()=>{
          const menu=document.querySelector('#lab-menu');menu.hidden=!menu.hidden;
        });</script></body></html>`);
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("Fixture port unavailable.");
    const localUrl = `http://127.0.0.1:${String(address.port)}/`;
    const server = new TvDoctorMcpServer({
      outputRoot: join(tmpdir(), `tvdoctor-mcp-production-${randomUUID()}`),
    });
    try {
      await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
      const { data: site } = await call(server, "tvdoctor_site", { authorized: true, url: localUrl, max_pages: 1 });
      const siteId = site["scan_id"];
      if (typeof siteId !== "string") throw new Error("Site scan did not start.");
      const siteStatus = await settle(server, siteId, 90_000);
      expect(siteStatus["scan_type"]).toBe("site");
      expect(["completed", "partial"]).toContain(siteStatus["status"]);
      expect(siteStatus["report_available"]).toBe(true);
      const { data: siteIndex } = await call(server, "tvdoctor_site_index", { scan_id: siteId });
      expect(siteIndex).toMatchObject({ scope: "static-html-anchors", total_routes: 1, pages_scanned: 1 });
      expect(JSON.stringify(siteIndex)).not.toContain(localUrl);
      expect(JSON.stringify(siteIndex)).not.toContain("pages/001");
      expect(siteIndex["known_pending"]).toBeGreaterThanOrEqual(1);
      const { data: siteFindings } = await call(server, "tvdoctor_findings", { scan_id: siteId });
      expect(Array.isArray(siteFindings["findings"])).toBe(true);
      expect(siteFindings["report_status"]).toBe(siteIndex["index_status"]);
      const pageReport = join(server.outputRoot, siteId, "pages", "001", "report.json");
      const storedPage = JSON.parse(await readFile(pageReport, "utf8")) as Record<string, unknown>;
      const artifacts = storedPage["artifacts"];
      if (!Array.isArray(artifacts)) throw new Error("Expected saved first-route report artifacts.");
      artifacts.push({ id: "controlled-video", kind: "video", status: "available",
        path: "video/demo.webm", mediaType: "video/webm", byteLength: 128, sha256: null });
      await writeFile(pageReport, JSON.stringify(storedPage));
      const { data: mediaList } = await call(server, "tvdoctor_evidence", { scan_id: siteId });
      expect(mediaList["artifacts"]).toEqual(expect.arrayContaining([expect.objectContaining({
        id: "site:001:controlled-video", kind: "video", media_type: "video/webm",
      })]));
      const { data: deniedVideo } = await call(server, "tvdoctor_evidence", {
        scan_id: siteId, artifact_id: "site:001:controlled-video",
        include_content: true, acknowledge_sensitive: true,
      });
      expect(deniedVideo).toMatchObject({ code: "content-unavailable" });

      const { data: withSpa } = await call(server, "tvdoctor_site", {
        authorized: true, url: localUrl, max_pages: 1, explore_spa: true,
      });
      const spaId = withSpa["scan_id"];
      if (typeof spaId !== "string") throw new Error("SPA site scan did not start.");
      const spaStatus = await settle(server, spaId, 90_000);
      expect(["completed", "partial"]).toContain(spaStatus["status"]);
      expect(spaStatus["report_available"]).toBe(true);
      const { data: withSpaIndex } = await call(server, "tvdoctor_site_index", { scan_id: spaId });
      expect(withSpaIndex).toMatchObject({
        scope: "static-html-anchors+bounded-spa",
        spa: { evidence_available: true, status: expect.stringMatching(/^(completed|partial)$/u) },
      });
      expect((withSpaIndex["spa"] as { states_observed: number }).states_observed).toBeGreaterThan(0);
      expect((withSpaIndex["spa"] as { review_leads: number }).review_leads).toBeGreaterThan(0);
      const { data: spaFindings } = await call(server, "tvdoctor_findings", { scan_id: spaId });
      expect((spaFindings["findings"] as { rule: string; review_required?: boolean }[]))
        .toContainEqual(expect.objectContaining({ rule: "spa.expanded-panel-mismatch", review_required: true }));
      const spaLead = (spaFindings["findings"] as { id: string; rule: string }[])
        .find((finding) => finding.rule === "spa.expanded-panel-mismatch");
      if (spaLead === undefined) throw new Error("Expected observed SPA review lead.");
      const { data: spaDetail } = await call(server, "tvdoctor_issue_details", {
        scan_id: spaId, issue_id: spaLead.id,
      });
      expect(spaDetail).toMatchObject({
        classification: "heuristic-review-only", verified_transition: true,
        replay_steps: expect.arrayContaining([expect.objectContaining({
          kind: "menu-toggle", observed_checkpoint: expect.any(String),
        })]),
      });
      expect(JSON.stringify(spaDetail)).not.toContain(localUrl);
      // A forged review lead cannot be made "verified" by changing one saved
      // edge while keeping the index counters and issue list unchanged.
      const spaFile = join(server.outputRoot, spaId, "spa", "spa-journey.json");
      const originalSpa = await readFile(spaFile, "utf8");
      const saved = JSON.parse(originalSpa) as {
        edges: { status: string; kind: string; to: string | null }[];
        issues: { edgeIndex: number; rule: string; stateId: string }[];
      };
      const mismatched = saved.issues.find((item) => item.rule === "spa.expanded-panel-mismatch");
      const unrelatedAnchor = saved.edges.findIndex((item) => item.status === "observed" && item.kind === "anchor");
      const anchorState = saved.edges[unrelatedAnchor]?.to;
      if (mismatched === undefined || unrelatedAnchor < 0 || typeof anchorState !== "string") {
        throw new Error("Expected valid mismatch and separately observed anchor for forged provenance test.");
      }
      // An attacker may rewrite the issue's target to another real observed
      // edge; a real anchor must never become evidence of an ARIA toggle mismatch.
      mismatched.edgeIndex = unrelatedAnchor;
      mismatched.stateId = anchorState;
      await writeFile(spaFile, JSON.stringify(saved));
      const { data: rejectedCrossEdge } = await call(server, "tvdoctor_issue_details", {
        scan_id: spaId, issue_id: spaLead.id,
      });
      expect(rejectedCrossEdge).toMatchObject({ code: "report-unavailable" });
      await writeFile(spaFile, originalSpa);

      const intact = JSON.parse(originalSpa) as { edges: { status: string }[]; issues: { edgeIndex: number }[] };
      const forgedEdge = intact.edges[intact.issues[0]?.edgeIndex ?? -1];
      if (forgedEdge === undefined) throw new Error("Expected recorded SPA issue edge.");
      forgedEdge.status = "deferred";
      await writeFile(spaFile, JSON.stringify(intact));
      const { data: rejected } = await call(server, "tvdoctor_issue_details", {
        scan_id: spaId, issue_id: spaLead.id,
      });
      expect(rejected).toMatchObject({ code: "report-unavailable" });
      expect(JSON.stringify(withSpaIndex)).not.toContain(localUrl);
      expect(JSON.stringify(withSpaIndex)).not.toContain("/second");

      const { data: responsive } = await call(server, "tvdoctor_responsive", {
        authorized: true, url: localUrl, max_pages: 1,
      });
      const responsiveId = responsive["scan_id"];
      if (typeof responsiveId !== "string") throw new Error("Responsive scan did not start.");
      const responsiveStatus = await settle(server, responsiveId, 90_000);
      expect(responsiveStatus["scan_type"]).toBe("responsive");
      expect(["completed", "partial"]).toContain(responsiveStatus["status"]);
      expect(responsiveStatus["report_available"]).toBe(true);
      const { data: matrix } = await call(server, "tvdoctor_responsive_index", { scan_id: responsiveId });
      expect(matrix).toMatchObject({
        observations_total: 3, viewports: [
          { id: "mobile", width: 390, height: 844 },
          { id: "tablet", width: 768, height: 1024 },
          { id: "desktop", width: 1280, height: 720 },
        ],
      });
      expect(matrix["findings_total"]).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(matrix)).not.toContain(localUrl);
      const { data: findings } = await call(server, "tvdoctor_findings", { scan_id: responsiveId });
      expect(findings).toMatchObject({ report_status: matrix["index_status"], total_issues: matrix["findings_total"] });
      expect((findings["findings"] as { confidence: string }[]).every((finding) => finding.confidence === "heuristic")).toBe(true);
      const observedRules = new Set((findings["findings"] as { rule: string }[]).map((finding) => finding.rule));
      expect(observedRules).toContain("responsive.clipped-control");
      expect(observedRules).toContain("responsive.control-overlap");
      const responsiveFinding = (findings["findings"] as { id: string; rule: string }[])[0];
      if (responsiveFinding === undefined) throw new Error("Expected responsive finding.");
      const { data: responsiveDetails } = await call(server, "tvdoctor_issue_details", {
        scan_id: responsiveId, issue_id: responsiveFinding.id,
      });
      expect(responsiveDetails).toMatchObject({ classification: "heuristic-review-only",
        viewport: expect.any(String), screenshot_artifact_id: expect.any(String) });
      const { data: responsiveVerification } = await call(server, "tvdoctor_verify_fix", {
        scan_id: responsiveId, issue_id: responsiveFinding.id, authorized: true,
      });
      expect(responsiveVerification).toMatchObject({ status: "INCONCLUSIVE", reason: "replay-unavailable", fixed: null });
      expect(JSON.stringify(responsiveDetails)).not.toContain(localUrl);
      const { data: screenshotList } = await call(server, "tvdoctor_evidence", { scan_id: responsiveId });
      expect(screenshotList["total_artifacts"]).toBeGreaterThanOrEqual(1);
      // A nested-scroll screenshot uses its own reserved page-51..62 slot.
      // Its issue_details ID must resolve to an owned MCP evidence artifact,
      // not to an unlisted file or another route's baseline screenshot.
      const matrixFile = join(server.outputRoot, responsiveId, "responsive-result.json");
      const savedMatrix = JSON.parse(await readFile(matrixFile, "utf8")) as {
        pages: { viewport: string; routeIdentity: string; screenshot: string | null;
          findings: { id: string; screenshot: string | null }[] }[];
        findings: { id: string; screenshot: string | null }[];
      };
      const mobilePage = savedMatrix.pages.find((page) => page.viewport === "mobile"
        && page.screenshot !== null && page.findings.length > 0);
      if (mobilePage === undefined || mobilePage.screenshot === null) {
        throw new Error("Expected a mobile screenshot and review finding.");
      }
      const originalScreenshot = mobilePage.screenshot;
      const scrollScreenshot = originalScreenshot.replace(/page-01\.png$/u, "page-51.png");
      if (scrollScreenshot === originalScreenshot) throw new Error("Expected the first route's reserved screenshot slot.");
      const mobileFinding = mobilePage.findings[0];
      const matchingFinding = savedMatrix.findings.find((item) => item.id === mobileFinding?.id);
      if (mobileFinding === undefined || matchingFinding === undefined) throw new Error("Missing matched responsive finding.");
      const content = await readFile(join(server.outputRoot, responsiveId, ...originalScreenshot.split("/")));
      await writeFile(join(server.outputRoot, responsiveId, ...scrollScreenshot.split("/")), content);
      mobileFinding.screenshot = scrollScreenshot;
      matchingFinding.screenshot = scrollScreenshot;
      await writeFile(matrixFile, JSON.stringify(savedMatrix));
      const { data: scrollDetails } = await call(server, "tvdoctor_issue_details", {
        scan_id: responsiveId, issue_id: mobileFinding.id,
      });
      expect(scrollDetails).toMatchObject({ screenshot_artifact_id: "responsive:mobile:page-51" });
      const { data: scrollList } = await call(server, "tvdoctor_evidence", { scan_id: responsiveId });
      expect(scrollList["artifacts"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "responsive:mobile:page-51", media_type: "image/png" }),
      ]));
      const { data: scrollArtifact } = await call(server, "tvdoctor_evidence", {
        scan_id: responsiveId, artifact_id: "responsive:mobile:page-51",
      });
      expect(scrollArtifact).toMatchObject({ artifact_id: "responsive:mobile:page-51", kind: "screenshot" });
      mobileFinding.screenshot = "responsive/mobile/page-52.png";
      matchingFinding.screenshot = "responsive/mobile/page-52.png";
      await writeFile(matrixFile, JSON.stringify(savedMatrix));
      const { data: forgedDetails } = await call(server, "tvdoctor_issue_details", {
        scan_id: responsiveId, issue_id: mobileFinding.id,
      });
      expect(forgedDetails).toMatchObject({ screenshot_artifact_id: null });
      const { data: forgedList } = await call(server, "tvdoctor_evidence", { scan_id: responsiveId });
      expect(forgedList).toMatchObject({ code: "unsafe-artifact" });
      expect(requests).toContain("/");
      expect(requests).not.toContain("/checkout");
    } finally {
      server.close();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  }, 120_000);

  it("exposes HTTP200 SPA missing-content leads only as REVIEW and refuses forged source context", async () => {
    const requests: string[] = [];
    const fixture = createServer((request, response) => {
      requests.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
      if (request.url !== "/route-content") { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><body><main>
        <h1>Workspace overview</h1><p id="main-content">This full source workspace includes many
        records, descriptions and useful information, with a PRIVATE_ROUTE_CONTENT_MARKER
        that must not be present in the public MCP response.</p>
        <a href="/library" id="view-library">Open library</a></main>
        <script>document.querySelector('#view-library').addEventListener('click',(event)=>{
          event.preventDefault();history.pushState({},'',event.currentTarget.href);
          document.querySelector('#main-content').textContent='';
        });</script></body></html>`);
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("Route content fixture failed");
    const target = `http://127.0.0.1:${String(address.port)}/route-content`;
    const server = new TvDoctorMcpServer({ outputRoot: join(tmpdir(), `tvdoctor-mcp-route-content-${randomUUID()}`) });
    try {
      await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26" } });
      const { data: started } = await call(server, "tvdoctor_site", {
        authorized: true, url: target, max_pages: 1, explore_spa: true,
      });
      const scanId = started["scan_id"];
      if (typeof scanId !== "string") throw new Error("SPA route scan did not start");
      expect(["completed", "partial"]).toContain((await settle(server, scanId, 90_000))["status"]);
      const { data: index } = await call(server, "tvdoctor_site_index", { scan_id: scanId });
      expect(index["spa"]).toMatchObject({ possible_blank_client_routes_review: 1 });
      const { data: list } = await call(server, "tvdoctor_findings", { scan_id: scanId });
      const leads = (list["findings"] as { id: string; rule: string }[]).filter((entry) =>
        entry.rule === "spa.route-content-missing");
      expect(leads).toHaveLength(1);
      const lead = leads[0];
      if (lead === undefined) throw new Error("No route-content review result");
      expect(lead.id).toMatch(/^SPA-[a-f0-9]{12}-\d+-CONTENT$/u);
      const { data: details } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: lead.id,
      });
      expect(details).toMatchObject({ classification: "heuristic-review-only", review_required: true,
        verified_transition: true, forward_transition_observed: true,
        replay_steps: expect.arrayContaining([expect.objectContaining({ kind: "anchor" })]) });
      const { data: fix } = await call(server, "tvdoctor_verify_fix", {
        scan_id: scanId, issue_id: lead.id, authorized: true,
      });
      expect(fix).toMatchObject({ status: "INCONCLUSIVE", reason: "replay-unavailable", fixed: null });
      const exposed = JSON.stringify({ list, details, fix });
      expect(exposed).not.toContain(target);
      expect(exposed).not.toContain("/library");
      expect(exposed).not.toContain("PRIVATE_ROUTE_CONTENT_MARKER");
      expect(requests.every((request) => request === "GET /route-content")).toBe(true);
      const spaPath = join(server.outputRoot, scanId, "spa", "spa-journey.json");
      const saved = JSON.parse(await readFile(spaPath, "utf8")) as {
        states: { id: string; routeIdentity: string }[];
        issues: { rule: string; edgeIndex: number; evidence: string }[];
        edges: { from: string; to: string | null }[];
      };
      const contentIssue = saved.issues.find((issue) => issue.rule === "spa.route-content-missing");
      if (contentIssue === undefined) throw new Error("Missing source-linked content review");
      const edge = saved.edges[contentIssue.edgeIndex];
      const from = saved.states.find((state) => state.id === edge?.from);
      const dest = saved.states.find((state) => state.id === edge?.to);
      if (from === undefined || dest === undefined) throw new Error("Missing source/destination evidence");
      dest.routeIdentity = from.routeIdentity;
      await writeFile(spaPath, JSON.stringify(saved));
      const { data: denied } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: lead.id,
      });
      expect(denied).toMatchObject({ code: "report-unavailable" });
    } finally {
      server.close();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  }, 120_000);

  it("exposes only independently observed SPA browser Back review evidence and rejects forged return checkpoints", async () => {
    const requests: { url: string; method: string }[] = [];
    const fixture = createServer((request, response) => {
      requests.push({ url: request.url ?? "", method: request.method ?? "" });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>History review lab</title></head><body>
        <main><h1 id="route-heading">Records overview</h1>
        <a href="/history/back-state/reports" id="history-link">Review reports</a></main>
        <script>document.querySelector('#history-link').addEventListener('click', function(event) {
          event.preventDefault(); history.pushState({view:'reports'}, '', this.href);
          document.querySelector('#route-heading').textContent = 'Review reports';
        });</script></body></html>`);
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("History fixture port unavailable.");
    const localUrl = `http://127.0.0.1:${String(address.port)}/history/back-state`;
    const server = new TvDoctorMcpServer({ outputRoot: join(tmpdir(), `tvdoctor-mcp-history-${randomUUID()}`) });
    try {
      await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26" } });
      const { data: created } = await call(server, "tvdoctor_site", {
        authorized: true, url: localUrl, max_pages: 1, explore_spa: true,
      });
      const scanId = created["scan_id"];
      if (typeof scanId !== "string") throw new Error("SPA history scan did not start.");
      expect(["completed", "partial"]).toContain((await settle(server, scanId, 90_000))["status"]);
      const { data: index } = await call(server, "tvdoctor_site_index", { scan_id: scanId });
      expect(index["spa"]).toMatchObject({ evidence_available: true });
      const { data: result } = await call(server, "tvdoctor_findings", { scan_id: scanId });
      const historyLead = (result["findings"] as { id: string; rule: string }[])
        .find((finding) => finding.rule === "spa.history-back-stale-view");
      if (historyLead === undefined) throw new Error("Browser Back issue was not independently observed.");
      expect(historyLead.id).toMatch(/^SPA-[a-f0-9]{12}-\d+-BACK$/u);
      expect(historyLead).toMatchObject({ replay_steps: [], browser_back_observed: true,
        browser_back_replay_verified: false, forward_setup_steps: expect.any(Array) });
      const { data: detail } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: historyLead.id,
      });
      expect(detail).toMatchObject({ classification: "heuristic-review-only",
        verified_transition: false, forward_transition_observed: true,
        replay_steps: [], forward_setup_steps: expect.any(Array),
        history_back: { route_returned: true, heading_restored: false,
          observed_history_steps: 1, settled_samples: 2, independent_replay_verified: false } });
      const backDetail = detail["history_back"] as { screenshot_artifact_id: string | null };
      expect(backDetail.screenshot_artifact_id).toMatch(/^spa:back-edge-[0-9]{3}$/u);
      const { data: availableImages } = await call(server, "tvdoctor_evidence", { scan_id: scanId });
      expect((availableImages["artifacts"] as { id: string }[]).some((item) =>
        item.id === backDetail.screenshot_artifact_id)).toBe(true);
      const { data: privateImageDenied } = await call(server, "tvdoctor_evidence", {
        scan_id: scanId, artifact_id: backDetail.screenshot_artifact_id, include_content: true,
      });
      expect(privateImageDenied["code"]).toBe("acknowledgment-required");
      const { response: imageResponse } = await call(server, "tvdoctor_evidence", {
        scan_id: scanId, artifact_id: backDetail.screenshot_artifact_id,
        include_content: true, acknowledge_sensitive: true,
      });
      expect((imageResponse.result as { content: { type: string; mimeType?: string }[] }).content)
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]));
      expect(JSON.stringify(detail)).not.toContain(localUrl);
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      expect(requests.some((request) => /checkout|delete|logout/iu.test(request.url))).toBe(false);

      const reportPath = join(server.outputRoot, scanId, "spa", "spa-journey.json");
      const saved = JSON.parse(await readFile(reportPath, "utf8")) as {
        issues: { rule: string; historyBack?: {
          returnedHeadingFingerprint: string;
          screenshot?: { path: string; sha256: string; byteLength: number };
        } }[];
      };
      const recorded = saved.issues.find((item) => item.rule === "spa.history-back-stale-view");
      if (recorded?.historyBack === undefined) throw new Error("Expected actual Back observation metadata.");
      const photo = recorded.historyBack.screenshot;
      if (photo === undefined) throw new Error("Expected actual post-Back screenshot metadata.");
      const imagePath = join(server.outputRoot, scanId, "spa", photo.path);
      const actualBytes = await readFile(imagePath);
      expect(actualBytes.byteLength).toBe(photo.byteLength);
      expect(actualBytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(createHash("sha256").update(actualBytes).digest("hex")).toBe(photo.sha256);
      await writeFile(imagePath, Buffer.from("forged browser Back image"));
      const { data: tamperedImage } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: historyLead.id,
      });
      expect(tamperedImage).toMatchObject({ code: "report-unavailable" });
      await writeFile(imagePath, actualBytes);
      recorded.historyBack.returnedHeadingFingerprint = "f".repeat(20);
      await writeFile(reportPath, JSON.stringify(saved));
      const { data: rejected } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: historyLead.id,
      });
      expect(rejected).toMatchObject({ code: "report-unavailable" });
    } finally {
      server.close();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  }, 120_000);

  it("preserves partial SPA coverage when the bounded browser Back probe frontier is exhausted", async () => {
    const requests: { url: string; method: string }[] = [];
    const fixture = createServer((request, response) => {
      requests.push({ url: request.url ?? "", method: request.method ?? "" });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body><main><h1 id="heading">Overview</h1>
        <a href="/history/limit/one">One</a><a href="/history/limit/two">Two</a>
        <a href="/history/limit/three">Three</a></main><script>
        const heading=document.getElementById('heading');
        const render=()=>{heading.textContent=location.pathname==='/history/limit'
          ? 'Overview' : 'Page '+location.pathname.split('/').at(-1);};
        document.querySelectorAll('a').forEach(a=>a.addEventListener('click',event=>{
          event.preventDefault();history.pushState({},'',a.href);render();
        }));
        addEventListener('popstate',render);
        </script></body></html>`);
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("History budget fixture port unavailable.");
    const server = new TvDoctorMcpServer({ outputRoot: join(tmpdir(), `tvdoctor-mcp-back-budget-${randomUUID()}`) });
    try {
      await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26" } });
      const { data: created } = await call(server, "tvdoctor_site", {
        authorized: true, url: `http://127.0.0.1:${String(address.port)}/history/limit`,
        max_pages: 1, explore_spa: true,
      });
      const scanId = created["scan_id"];
      if (typeof scanId !== "string") throw new Error("SPA Back budget scan did not start.");
      expect(["partial", "completed"]).toContain((await settle(server, scanId, 90_000))["status"]);
      const saved = JSON.parse(await readFile(join(server.outputRoot, scanId, "spa", "spa-journey.json"), "utf8")) as {
        status: string; terminationReasons: string[]; deferred: { reason: string }[];
        issues: { rule: string }[];
      };
      expect(saved.status).toBe("partial");
      expect(saved.terminationReasons).toContain("history-back-limit");
      expect(saved.deferred.some((entry) => entry.reason === "history-back-limit")).toBe(true);
      expect(saved.issues.some((issue) => issue.rule === "spa.history-back-stale-view")).toBe(false);
      const { data: index } = await call(server, "tvdoctor_site_index", { scan_id: scanId });
      expect(index["spa"]).toMatchObject({ status: "partial", evidence_available: true });
      const { data: findings } = await call(server, "tvdoctor_findings", { scan_id: scanId });
      expect(findings["code"]).not.toBe("report-unavailable");
      expect(findings["findings"]).toEqual([]);
      expect(requests.every((request) => request.method === "GET"
        && request.url === "/history/limit")).toBe(true);
    } finally {
      server.close();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  }, 120_000);

  it("exposes source-bound HTTP link review leads without leaking routes or accepting forged associations", async () => {
    const methods: string[] = [];
    const fixture = createServer((request, response) => {
      methods.push(`${request.method ?? "?"} ${request.url ?? ""}`);
      if (request.url === "/missing") { response.writeHead(404).end("not found"); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html><body><a href="/missing">Read missing guide</a></body></html>');
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("HTTP fixture port unavailable");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const { server } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify({
        ...report(), target: { ...report().target, location: `${origin}/` },
      }));
      return resultFor(join(request.outputPath, "report.json"));
    });
    try {
      const { data: created } = await call(server, "tvdoctor_site", {
        authorized: true, url: `${origin}/`, max_pages: 2,
      });
      const scanId = created["scan_id"];
      if (typeof scanId !== "string") throw new Error("HTTP link scan did not start");
      await settle(server, scanId);
      const { data: index } = await call(server, "tvdoctor_site_index", { scan_id: scanId });
      expect(index["http_link_review_leads"]).toBe(1);
      const { data: findings } = await call(server, "tvdoctor_findings", { scan_id: scanId });
      const http = (findings["findings"] as { id: string; rule: string }[])
        .find((finding) => finding.rule === "site.link-http-response");
      expect(http).toMatchObject({ id: "HTTP-002-404", source_route_number: 1,
        destination_route_number: 2, http_status: 404, review_required: true });
      const { data: detail } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: "HTTP-002-404",
      });
      expect(detail).toMatchObject({ classification: "observed-response-review-required",
        source_route_number: 1, destination_route_number: 2, http_status: 404,
        replay_steps: [], verified_transition: false });
      expect(JSON.stringify([index, findings, detail])).not.toContain(origin);
      expect(methods).toEqual(["GET /", "GET /missing"]);

      const indexFile = join(server.outputRoot, scanId, "site-index.json");
      const original = await readFile(indexFile, "utf8");
      const fake = JSON.parse(original) as { linkResponseLeads: { from: string; to: string }[] };
      const first = fake.linkResponseLeads[0];
      if (first === undefined) throw new Error("Expected HTTP link witness");
      first.from = `${origin}/unobserved`;
      await writeFile(indexFile, JSON.stringify(fake));
      const { data: rejected } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: "HTTP-002-404",
      });
      expect(rejected).toMatchObject({ code: "report-unavailable" });
      await writeFile(indexFile, original);
    } finally {
      server.close();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  }, 45_000);

  it("binds Chromium runtime errors to SPA disclosure actions while blocking action-created assets and forged fingerprints", async () => {
    const fixture = createServer((request, response) => {
      if (request.url === "/runtime-error.js") {
        response.writeHead(503, { "content-type": "text/javascript" }).end("/* response failed */");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body><main><h1>Runtime lab</h1>
        <button id="open" type="button" aria-controls="panel" aria-expanded="false">Project notes</button>
        <section id="panel" role="region" hidden>Disclosure opened</section></main>
        <script>document.getElementById('open').addEventListener('click', () => {
          const panel=document.getElementById('panel');
          panel.hidden=!panel.hidden; document.getElementById('open').setAttribute('aria-expanded', String(!panel.hidden));
          console.error('PRIVATE_ERROR_CONTENT');
          const script=document.createElement('script');script.src='/runtime-error.js';document.head.append(script);
          throw Error('PRIVATE_ERROR_STACK');
        });</script></body></html>`);
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("Missing runtime fixture port");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const { server } = await makeServer(async (request) => {
      await mkdir(request.outputPath, { recursive: true });
      await writeFile(join(request.outputPath, "report.json"), JSON.stringify({
        ...report(), target: { ...report().target, location: `${origin}/` },
      }));
      return resultFor(join(request.outputPath, "report.json"));
    });
    try {
      const { data: created } = await call(server, "tvdoctor_site", {
        authorized: true, url: `${origin}/runtime`, max_pages: 1, explore_spa: true,
        verify_spa_issues: true,
      });
      const scanId = created["scan_id"];
      if (typeof scanId !== "string") throw new Error("Runtime site scan was not admitted");
      expect(["completed", "partial"]).toContain((await settle(server, scanId, 75_000))["status"]);
      const { data: findings } = await call(server, "tvdoctor_findings", { scan_id: scanId });
      const runtime = (findings["findings"] as { id: string; rule: string; http_status?: number }[]).filter((finding) =>
        finding.rule.startsWith("spa.runtime-") || finding.rule === "spa.http-response-error");
      if (runtime.length === 0) {
        const { data: index } = await call(server, "tvdoctor_site_index", { scan_id: scanId });
        const raw = await readFile(join(server.outputRoot, scanId, "spa", "spa-journey.json"), "utf8").catch(() => "missing");
        throw new Error(`Runtime findings unavailable: ${JSON.stringify({ index, findings, spa: raw.slice(0, 3500) })}`);
      }
      expect(runtime.map((entry) => entry.rule)).toEqual(expect.arrayContaining([
        "spa.runtime-page-error", "spa.runtime-console-error",
      ]));
      expect(runtime.find((entry) => entry.rule === "spa.http-response-error")).toBeUndefined();
      expect(runtime.some((entry) => (entry as Record<string, unknown>)["fresh_context_verification"] !== undefined)).toBe(true);
      const first = runtime[0];
      if (first === undefined) throw new Error("No runtime issue found");
      const { data: detail } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: first.id,
      });
      expect(detail).toMatchObject({ classification: "heuristic-review-only",
        review_required: true, verified_transition: true,
        fresh_context_verification: { status: "reobserved", independently_reobserved: true,
          deterministic_bug_proof: false } });
      for (const confidential of [origin, "PRIVATE_ERROR_CONTENT", "PRIVATE_ERROR_STACK", "/runtime-error.js"]) {
        expect(JSON.stringify([findings, detail])).not.toContain(confidential);
      }
      const jsonPath = join(server.outputRoot, scanId, "spa", "spa-journey.json");
      const original = await readFile(jsonPath, "utf8");
      const observedDisclosure = JSON.parse(original) as {
        status: string; unsafeRequestsBlocked: number; terminationReasons: string[];
        edges: { kind: string; status: string }[];
      };
      expect(observedDisclosure.edges.some((edge) => edge.kind === "disclosure-toggle" && edge.status === "observed")).toBe(true);
      expect(observedDisclosure.status).toBe("partial");
      expect(observedDisclosure.unsafeRequestsBlocked).toBeGreaterThan(0);
      expect(observedDisclosure.terminationReasons).toContain("unsafe-network-request-blocked");
      const forged = JSON.parse(original) as {
        issues: { runtimeEvent?: { eventFingerprint: string }; verification?: { fingerprint: string } }[];
      };
      const witness = forged.issues.find((issue) => issue.runtimeEvent !== undefined)?.runtimeEvent;
      if (witness === undefined) throw new Error("No saved event witness");
      witness.eventFingerprint = "f".repeat(20);
      await writeFile(jsonPath, JSON.stringify(forged));
      const { data: rejected } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: first.id,
      });
      expect(rejected).toMatchObject({ code: "report-unavailable" });
      await writeFile(jsonPath, original);
      const forgedVerification = JSON.parse(original) as {
        issues: { verification?: { fingerprint: string } }[];
      };
      const verification = forgedVerification.issues.find((issue) => issue.verification !== undefined)?.verification;
      if (verification === undefined) throw new Error("Expected fresh Chromium verification evidence");
      verification.fingerprint = "f".repeat(20);
      await writeFile(jsonPath, JSON.stringify(forgedVerification));
      const { data: rejectedVerification } = await call(server, "tvdoctor_issue_details", {
        scan_id: scanId, issue_id: first.id,
      });
      expect(rejectedVerification).toMatchObject({ code: "report-unavailable" });
      await writeFile(jsonPath, original);
    } finally {
      server.close();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  }, 120_000);

  it("rejects unsafe site and responsive arguments before launching any scan", async () => {
    const { server, calls } = await makeServer();
    for (const tool of ["tvdoctor_site", "tvdoctor_responsive"]) {
      for (const args of [
        { url: target, authorized: false },
        { url: `${target}?token=private`, authorized: true },
        { url: "https://user:password@example.test/", authorized: true },
        { url: "https://example.test/delete/account", authorized: true },
        { url: target, authorized: true, max_pages: 999 },
        { url: target, authorized: true, output: "../private" },
        { url: target, authorized: true, keyboard_interactions: true },
        ...(tool === "tvdoctor_site" ? [{ url: target, authorized: true, explore_spa: "yes" }] : [
          { url: target, authorized: true, explore_spa: true },
        ]),
        ...(tool === "tvdoctor_site" ? [
          { url: target, authorized: true, spa_screenshots: false },
          { url: target, authorized: true, explore_spa: true, spa_screenshots: "no" },
          { url: target, authorized: true, verify_spa_issues: true },
          { url: target, authorized: true, explore_spa: true, verify_spa_issues: "yes" },
          { url: target, authorized: true, allow_dynamic_resources: true },
          { url: target, authorized: true, explore_spa: true, allow_dynamic_resources: "yes" },
        ] : []),
      ]) {
        const { response, data } = await call(server, tool, args);
        expect((response.result as { isError: boolean }).isError).toBe(true);
        expect(data["status"]).toBe("error");
        expect(JSON.stringify(data)).not.toContain("token=private");
        expect(JSON.stringify(data)).not.toContain("user:password");
      }
    }
    expect(calls).toHaveLength(0);
    const { data: missing } = await call(server, "tvdoctor_site_index", { scan_id: "../../private" });
    expect(missing["code"]).toBe("unknown-scan");
    server.close();
  });
});

describe("MCP production single-page scan coverage", () => {
  it("reports the remaining frontier after one physical action in Chromium", async () => {
    const fixture = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Coverage fixture</title><main><h1>Controls</h1>"
        + "<button autofocus>One</button><button>Two</button><button>Three</button></main>");
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
    const server = new TvDoctorMcpServer();
    try {
      const address = fixture.address();
      if (address === null || typeof address === "string") throw new Error("Fixture address unavailable");
      await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
      const id = await start(server, {
        url: `http://127.0.0.1:${String(address.port)}/`, max_actions: 1, screenshots: false,
      });
      expect(await settle(server, id, 20_000)).toMatchObject({ status: "partial", report_available: true });
      const { data } = await call(server, "tvdoctor_findings", { scan_id: id });
      expect(data).toMatchObject({
        status: "partial", termination: ["actions"],
        coverage: {
          actions: 1,
          navigation: {
            reason: "max-actions", complete: false, deferred_states: 0,
          },
        },
      });
      const { navigation } = data["coverage"] as { navigation: Record<string, unknown> };
      expect(navigation["pending_states"]).toBeGreaterThan(0);
      expect(navigation["remaining_frontier_entries"]).toBeGreaterThan(0);
      expect(navigation["remaining_candidate_actions"]).toBeGreaterThan(0);
    } finally {
      server.close();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  }, 30_000);
});

describe("MCP stdio framing", () => {
  function connect() {
    const input = new PassThrough();
    const output = new PassThrough();
    let recorded = Buffer.alloc(0);
    output.on("data", (chunk: Buffer) => { recorded = Buffer.concat([recorded, chunk]); });
    const server = serveMcpStdio({ input, output });
    return { input, output, server, read: () => recorded };
  }

  it("accepts newline-delimited JSON-RPC and writes JSON only to stdout", async () => {
    const io = connect();
    io.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}\n');
    io.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    io.input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await vi.waitFor(() => expect(io.read().toString("utf8").trim().split("\n")).toHaveLength(2));
    const messages = io.read().toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as JsonRpcResponse);
    expect(messages[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "tvdoctor" } } });
    expect(messages[1]).toMatchObject({ id: 2, result: { tools: expect.any(Array) } });
    io.input.end();
    io.output.end();
  });

  it("accepts fragmented Content-Length framing and replies using Content-Length", async () => {
    const io = connect();
    const message = Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-03-26" },
    }), "utf8");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${String(message.byteLength)}\r\n\r\n`), message]);
    io.input.write(frame.subarray(0, 5));
    io.input.write(frame.subarray(5, 27));
    io.input.write(frame.subarray(27));
    await vi.waitFor(() => expect(io.read().toString("utf8")).toContain('"serverInfo"'));
    const output = io.read().toString("utf8");
    const header = /^Content-Length: (\d+)\r\n\r\n/u.exec(output);
    expect(header).not.toBeNull();
    expect(Buffer.byteLength(output.slice(header?.[0].length ?? 0))).toBe(Number(header?.[1]));
    expect(JSON.parse(output.slice(header?.[0].length ?? 0))).toMatchObject({ id: "init" });
    io.input.end();
    io.output.end();
  });

  it("returns a JSON-RPC parse error for malformed newline messages", async () => {
    const io = connect();
    io.input.write("{this is not JSON}\n");
    await vi.waitFor(() => expect(io.read().toString("utf8")).toContain("-32700"));
    expect(JSON.parse(io.read().toString("utf8"))).toMatchObject({ id: null, error: { code: -32700 } });
    io.input.end();
    io.output.end();
  });

  it("rejects oversized Content-Length and newline frames without allocating their advertised size", async () => {
    const framed = connect();
    framed.input.write("Content-Length: 999999999\r\n\r\n");
    await vi.waitFor(() => expect(framed.read().toString("utf8")).toContain('"code":-32600'));
    expect(framed.read().toString("utf8")).toContain("Content-Length:");
    framed.input.end();
    framed.output.end();

    const newline = connect();
    newline.input.write(Buffer.alloc(256 * 1024 + 200, 65));
    await vi.waitFor(() => expect(newline.read().toString("utf8")).toContain('"code":-32600'));
    const response = JSON.parse(newline.read().toString("utf8")) as JsonRpcResponse;
    expect(response).toMatchObject({ id: null, error: { code: -32600 } });
    newline.input.end();
    newline.output.end();
  });
});
