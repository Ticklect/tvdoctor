import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTVDoctorReportJson, REPORT_SCHEMA_VERSION_V1 } from "@tvdoctor/protocol";
import { TvDoctorMcpServer, type JsonRpcResponse } from "../src/mcp-server.js";
import { runCli, type CliContext } from "../src/cli.js";
import { createNodeCliOperations } from "../src/node-replay.js";
import { verifyOriginalFindingWorkflow } from "../src/node-verify-workflow.js";

type ToolReply = Record<string, unknown>;

async function tool(
  server: TvDoctorMcpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly payload: ToolReply; readonly isError: boolean }> {
  const response: JsonRpcResponse | null = await server.handle({
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (response === null || response.error !== undefined) {
    throw new Error(`MCP ${name} failed to return a successful JSON-RPC envelope: ${JSON.stringify(response?.error)}`);
  }
  const result = response.result as { content: { type: string; text?: string }[]; isError: boolean };
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error(`MCP ${name} returned no JSON text payload.`);
  }
  return { payload: JSON.parse(first.text) as ToolReply, isError: result.isError };
}

async function completedScan(server: TvDoctorMcpServer, url: string): Promise<string> {
  const started = await tool(server, "tvdoctor_scan", {
    url,
    authorized: true,
    input: "keyboard",
    max_duration_ms: 45_000,
    max_actions: 400,
    screenshots: false,
  });
  expect(started.isError, JSON.stringify(started.payload)).toBe(false);
  expect(started.payload["status"]).toBe("pending");
  const scanId = started.payload["scan_id"];
  if (typeof scanId !== "string") throw new Error("MCP did not return an original scan ID.");

  const deadline = Date.now() + 90_000;
  for (;;) {
    const polled = await tool(server, "tvdoctor_status", { scan_id: scanId });
    const status = polled.payload;
    if (status["status"] !== "pending") {
      expect(status["status"], `MCP scanner returned incomplete coverage: ${JSON.stringify(status)}`).toBe("completed");
      return scanId;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Real Chromium scan never completed: ${JSON.stringify(status)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

async function createModalFixture(): Promise<{
  readonly url: string;
  readonly requests: string[];
  readonly events: string[];
  repair(): void;
  setBehavior(behavior: ModalBehavior): void;
  close(): Promise<void>;
}> {
  let behavior: ModalBehavior = "broken";
  const requests: string[] = [];
  const events: string[] = [];
  const httpServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push(path);
      if (path === "/telemetry") {
        const event = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("event");
        if (event !== null) events.push(event);
        response.writeHead(204).end();
        return;
      }
      if (path !== "/modal") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
        <title>Live keyboard modal verification</title></head>
        <body><main><div role="dialog" aria-modal="true" aria-label="Help dialog" id="modal">
          <button id="modal-button" type="button">Modal control</button></div>
          <button id="outside-button" type="button">Background control</button></main>
          <script>
            ${modalBehaviorScript(behavior)}
            document.getElementById("modal-button").focus();
          </script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Local Chromium test server did not bind.");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/modal`,
    requests,
    events,
    repair() { behavior = "repaired"; },
    setBehavior(next) { behavior = next; },
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

type ModalBehavior = "broken" | "repaired" | "delayed-escape" | "replaced-modal" | "same-id-replacement";

function modalBehaviorScript(behavior: ModalBehavior): string {
  if (behavior === "broken") return "";
  if (behavior === "repaired") {
    return `document.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        document.getElementById("modal-button").focus();
      }
    });`;
  }
  const afterTab = behavior === "delayed-escape"
    ? `setTimeout(() => {
        document.getElementById("outside-button").focus();
        mark("delayed-focus-escaped");
      }, 300);`
    : behavior === "replaced-modal"
      ? `setTimeout(() => {
          document.getElementById("modal").outerHTML =
            '<div role="dialog" aria-modal="true" aria-label="Different dialog" id="different-modal">' +
            '<button id="replacement-control">New dialog control</button></div>';
          document.getElementById("replacement-control").focus();
          mark("modal-replaced");
        }, 260);`
      : `setTimeout(() => {
          document.getElementById("modal").outerHTML =
            '<div role="dialog" aria-modal="true" aria-label="Different dialog" id="modal">' +
            '<button id="replacement-control">New dialog control</button></div>';
          document.getElementById("replacement-control").focus();
          mark("same-id-modal-replaced");
        }, 260);`;
  return `function mark(value) {
    const image = new Image();
    image.src = "/telemetry?event=" + encodeURIComponent(value) + "&nonce=" + Math.random();
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    document.getElementById("modal-button").focus();
    mark("immediate-focus-contained");
    ${afterTab}
  });`;
}

describe("live Chromium MCP deterministic fix verification", () => {
  it("reproduces the original keyboard modal escape, then verifies its repair using the original scan", async () => {
    const fixture = await createModalFixture();
    const { url, requests } = fixture;
    // Keep this private test's evidence available for inspection if a real scan fails.
    const outputRoot = join(tmpdir(), `tvdoctor-verify-fix-live-${randomUUID()}`);
    const mcp = new TvDoctorMcpServer({ outputRoot });
    try {
      const initialized = await mcp.handle({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      });
      expect(initialized?.error).toBeUndefined();

      const originalScanId = await completedScan(mcp, url);
      const report = parseTVDoctorReportJson(
        await readFile(join(outputRoot, originalScanId, "report.json"), "utf8"),
      );
      if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
        throw new Error("The real scan did not generate a v1 report.");
      }
      const issue = report.issues.find((candidate) =>
        candidate.rule === "keyboard.modal-focus-escape"
        && candidate.confidence === "deterministic");
      const replay = issue === undefined ? undefined
        : report.replays.find((candidate) => candidate.issueId === issue.id);
      const evidence = {
        status: report.run.status,
        exhausted: report.coverage.budget.exhausted,
        packs: report.coverage.packs,
        actions: report.coverage.actionsSent,
        screens: report.coverage.screenStatesDiscovered,
        focusStates: report.coverage.focusStatesDiscovered,
        transitions: report.coverage.transitionsTested,
        deterministicModalIssue: issue?.id ?? null,
        replaySteps: replay?.steps ?? null,
        originalScanId,
        outputRoot,
      };
      process.stdout.write(`LIVE_MCP_VERIFY_SCAN ${JSON.stringify(evidence)}\n`);
      expect(report.run.status, JSON.stringify(evidence)).toBe("completed");
      expect(report.coverage.budget.exhausted, JSON.stringify(evidence)).toEqual([]);
      expect(report.coverage.packs.some((pack) =>
        pack.pack === "navigation" && pack.status === "completed")).toBe(true);
      if (issue === undefined || replay === undefined) {
        throw new Error(`Real Chromium scan failed to discover a deterministic modal escape and original replay: ${JSON.stringify(evidence)}`);
      }
      expect(issue.reproduction).toMatchObject({
        status: "available", resetStrategy: "reload", confidence: "deterministic",
      });
      expect(replay.steps).toEqual([{ key: "TAB", repeat: 1 }]);

      const original = await tool(mcp, "tvdoctor_verify_fix", {
        scan_id: originalScanId, issue_id: issue.id, authorized: true,
      });
      process.stdout.write(`LIVE_MCP_VERIFY_ORIGINAL ${JSON.stringify(original.payload)}\n`);
      expect(original.isError, JSON.stringify(original.payload)).toBe(false);
      expect(original.payload).toMatchObject({
        status: "REPRODUCED", verification_status: "REPRODUCED",
        fixed: false, replay_status: "reproduced",
        scan_id: originalScanId, issue_id: issue.id,
      });

      // Exercise the publicly parsed non-MCP command against this same real
      // original scanner report, not a constructed replay or mocked operation.
      const baseOperations = createNodeCliOperations();
      const runInstalledShapeCli = async (extraArgs: readonly string[] = []) => {
        let stdout = "";
        let stderr = "";
        const context: CliContext = {
          environment: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
          io: { writeStdout: (value) => { stdout += value; }, writeStderr: (value) => { stderr += value; } },
          operations: { ...baseOperations, verifyOriginalFinding: (request) =>
            verifyOriginalFindingWorkflow(request, { operations: baseOperations }) },
        };
        const exit = await runCli([
          "verify-fix", issue.id, "--report", join(outputRoot, originalScanId, "report.json"), "--authorized",
          // MCP-owned source scans redact the URL and require the operator to
          // explicitly supply the exact authorised application URL at replay.
          "--target", url,
          ...extraArgs,
        ], context);
        return { exit, stderr, payload: JSON.parse(stdout) as Record<string, unknown> };
      };
      const originalCli = await runInstalledShapeCli();
      process.stdout.write(`LIVE_CLI_VERIFY_ORIGINAL ${JSON.stringify(originalCli)}\n`);
      expect(originalCli.exit, JSON.stringify(originalCli.payload)).toBe(1);
      expect(originalCli.payload).toMatchObject({
        schemaVersion: "tvdoctor.verify-workflow/v1", classification: "REPRODUCED", shouldFail: true,
      });

      // Repair the fixture response at the exact original URL, without a second scan.
      fixture.repair();
      const afterRepair = await tool(mcp, "tvdoctor_verify_fix", {
        scan_id: originalScanId, issue_id: issue.id, authorized: true,
      });
      process.stdout.write(`LIVE_MCP_VERIFY_REPAIRED ${JSON.stringify(afterRepair.payload)}\n`);
      expect(afterRepair.isError, JSON.stringify(afterRepair.payload)).toBe(false);
      expect(afterRepair.payload).toMatchObject({
        status: "FIXED", verification_status: "FIXED",
        fixed: true, replay_status: "fixed",
        scan_id: originalScanId, issue_id: issue.id,
        test_conditions: {
          input_mode: "keyboard",
          original_report_sealed_and_verified: true,
          original_navigation_sequence_reused: true,
        },
      });
      const repairedCli = await runInstalledShapeCli();
      expect(repairedCli.exit, JSON.stringify(repairedCli.payload)).toBe(0);
      expect(repairedCli.payload).toMatchObject({
        schemaVersion: "tvdoctor.verify-workflow/v1", classification: "FIXED", shouldFail: false,
        replay: { originalSequenceReused: true, stableFixConfirmationRequested: true },
      });
      // The original broken scan has a partial focus inventory. Even if the
      // independent corrected-state replay is FIXED, requesting a fresh scan
      // and historical comparison must refuse a broader clean-run verdict.
      const repeatOutput = join(outputRoot, `fresh-${randomUUID()}`);
      const comparedCli = await runInstalledShapeCli([
        "--scan-output", repeatOutput, "--compare", "--max-actions", "400", "--max-duration-ms", "45000",
      ]);
      expect(comparedCli.exit, JSON.stringify(comparedCli.payload)).toBe(3);
      expect(comparedCli.payload).toMatchObject({
        schemaVersion: "tvdoctor.verify-workflow/v1", classification: "INCONCLUSIVE", shouldFail: true,
        replay: { status: "fixed" },
        comparison: { status: "inconclusive", noLongerObservedMeansFixed: false },
      });
      expect(requests.filter((path) => path === "/modal").length).toBeGreaterThanOrEqual(3);
      expect(requests.every((path) => path === "/modal" || path === "/favicon.ico")).toBe(true);
    } finally {
      mcp.close();
      await fixture.close();
    }
  }, 180_000);

  it("refuses transient focus containment and replaced-modal evidence in real Chromium verification", async () => {
    const fixture = await createModalFixture();
    const outputRoot = join(tmpdir(), `tvdoctor-verify-fix-adversarial-${randomUUID()}`);
    const mcp = new TvDoctorMcpServer({ outputRoot });
    try {
      const initialized = await mcp.handle({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      });
      expect(initialized?.error).toBeUndefined();
      const scanId = await completedScan(mcp, fixture.url);
      const report = parseTVDoctorReportJson(
        await readFile(join(outputRoot, scanId, "report.json"), "utf8"),
      );
      if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
        throw new Error("The adversarial Chromium scan did not emit a v1 report.");
      }
      const issue = report.issues.find((candidate) =>
        candidate.rule === "keyboard.modal-focus-escape"
        && candidate.confidence === "deterministic");
      const originalReplay = report.replays.find((candidate) => candidate.issueId === issue?.id);
      if (issue === undefined || originalReplay === undefined) {
        throw new Error(`Real scan did not discover a deterministic modal escape and saved replay: ${JSON.stringify({
          scanId, status: report.run.status, exhausted: report.coverage.budget.exhausted,
          issues: report.issues.map((entry) => ({ rule: entry.rule, confidence: entry.confidence })),
        })}`);
      }
      expect(originalReplay.steps).toEqual([{ key: "TAB", repeat: 1 }]);

      const adversarial = [
        { behavior: "delayed-escape", event: "delayed-focus-escaped", acceptable: ["REPRODUCED", "INCONCLUSIVE"] },
        { behavior: "replaced-modal", event: "modal-replaced", acceptable: ["INCONCLUSIVE"] },
      ] as const;
      for (const scenario of adversarial) {
        fixture.setBehavior(scenario.behavior);
        const eventsBefore = fixture.events.length;
        const verified = await tool(mcp, "tvdoctor_verify_fix", {
          scan_id: scanId, issue_id: issue.id, authorized: true,
        });
        const observedEvents = fixture.events.slice(eventsBefore);
        process.stdout.write(`LIVE_MCP_VERIFY_ADVERSARIAL ${JSON.stringify({
          scenario: scenario.behavior,
          scanId,
          status: verified.payload["status"],
          replayStatus: verified.payload["replay_status"],
          reason: verified.payload["reason"],
          observedEvents,
        })}\n`);
        expect(verified.isError, JSON.stringify(verified.payload)).toBe(false);
        expect(observedEvents, "The real browser did not execute the delayed fixture mutation.")
          .toContain(scenario.event);
        expect(observedEvents).toContain("immediate-focus-contained");
        expect(scenario.acceptable, `A transient/replaced modal must not be verified FIXED: ${JSON.stringify(verified.payload)}`)
          .toContain(verified.payload["status"]);
        expect(verified.payload["fixed"]).not.toBe(true);
      }
      // The tests re-use the exact source report; no second scan or forged
      // inventory silently establishes a changed test condition.
      expect(report.run.status).toBe("completed");
      expect(report.coverage.budget.exhausted).toEqual([]);
    } finally {
      mcp.close();
      await fixture.close();
    }
  }, 180_000);

  it("does not verify FIXED when the original modal is replaced by another dialog reusing its stable ID", async () => {
    // This is a deliberate fail-closed regression gate. Reusing a DOM id is
    // insufficient proof of an unchanged modal when its semantic identity
    // (accessible name and contained focus target) has changed after Tab.
    const fixture = await createModalFixture();
    const outputRoot = join(tmpdir(), `tvdoctor-verify-fix-dialog-identity-${randomUUID()}`);
    const mcp = new TvDoctorMcpServer({ outputRoot });
    try {
      const initialized = await mcp.handle({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      });
      expect(initialized?.error).toBeUndefined();
      const scanId = await completedScan(mcp, fixture.url);
      const report = parseTVDoctorReportJson(
        await readFile(join(outputRoot, scanId, "report.json"), "utf8"),
      );
      if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
        throw new Error("The modal identity scan did not emit a v1 report.");
      }
      const issue = report.issues.find((candidate) =>
        candidate.rule === "keyboard.modal-focus-escape"
        && candidate.confidence === "deterministic"
        && report.replays.some((replay) => replay.issueId === candidate.id));
      if (issue === undefined) {
        throw new Error(`The real scan had no deterministic, replayable modal issue: ${JSON.stringify({
          status: report.run.status, issues: report.issues.map((candidate) => candidate.rule),
          exhausted: report.coverage.budget.exhausted,
        })}`);
      }
      fixture.setBehavior("same-id-replacement");
      const eventIndex = fixture.events.length;
      const verified = await tool(mcp, "tvdoctor_verify_fix", {
        scan_id: scanId, issue_id: issue.id, authorized: true,
      });
      const observedEvents = fixture.events.slice(eventIndex);
      process.stdout.write(`LIVE_MCP_VERIFY_SAME_ID_REPLACEMENT ${JSON.stringify({
        scanId, issueId: issue.id,
        status: verified.payload["status"],
        reason: verified.payload["reason"],
        events: observedEvents,
        outputRoot,
      })}\n`);
      expect(verified.isError, JSON.stringify(verified.payload)).toBe(false);
      expect(observedEvents).toContain("immediate-focus-contained");
      expect(observedEvents).toContain("same-id-modal-replaced");
      expect(verified.payload["status"],
        "An unrelated dialog reusing the original DOM ID is not proven fixed.").toBe("INCONCLUSIVE");
      expect(verified.payload["fixed"]).not.toBe(true);
    } finally {
      mcp.close();
      await fixture.close();
    }
  }, 180_000);

  it("compares independent Chromium keyboard scans, refusing resolution claims if real inventory evidence is partial", async () => {
    const fixture = await createModalFixture();
    const outputRoot = join(tmpdir(), `tvdoctor-compare-live-${randomUUID()}`);
    const mcp = new TvDoctorMcpServer({ outputRoot });
    try {
      const initialized = await mcp.handle({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      });
      expect(initialized?.error).toBeUndefined();

      const originalScanId = await completedScan(mcp, fixture.url);
      const brokenReport = parseTVDoctorReportJson(
        await readFile(join(outputRoot, originalScanId, "report.json"), "utf8"),
      );
      if (brokenReport.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
        throw new Error("The original Chromium scan did not produce a v1 report.");
      }
      const originalIssues = brokenReport.issues.filter((issue) =>
        issue.rule === "keyboard.modal-focus-escape" && issue.confidence === "deterministic");
      expect(originalIssues, "The original Chromium scan did not discover the real modal focus escape.").toHaveLength(1);
      const originalIssue = originalIssues[0];
      if (originalIssue === undefined) throw new Error("The original deterministic finding was absent.");

      fixture.repair();
      // A second production scan writes its own independent report and inventory.
      // The helper uses precisely the same authorized URL, keyboard and budget arguments.
      const repairedScanId = await completedScan(mcp, fixture.url);
      expect(repairedScanId).not.toBe(originalScanId);
      const repairedReport = parseTVDoctorReportJson(
        await readFile(join(outputRoot, repairedScanId, "report.json"), "utf8"),
      );
      if (repairedReport.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
        throw new Error("The repaired Chromium scan did not produce a v1 report.");
      }

      const [brokenInventory, repairedInventory] = await Promise.all([
        readFile(join(outputRoot, originalScanId, "inventory.json"), "utf8"),
        readFile(join(outputRoot, repairedScanId, "inventory.json"), "utf8"),
      ]);
      const [brokenLedger, repairedLedger] = await Promise.all([
        readFile(join(outputRoot, originalScanId, "stage-ledger.json"), "utf8"),
        readFile(join(outputRoot, repairedScanId, "stage-ledger.json"), "utf8"),
      ]);
      const [brokenGraph, repairedGraph] = await Promise.all([
        readFile(join(outputRoot, originalScanId, "navigation-graph.json"), "utf8"),
        readFile(join(outputRoot, repairedScanId, "navigation-graph.json"), "utf8"),
      ]);
      interface StoredInventory {
        readonly status?: string;
        readonly screens?: unknown[];
        readonly focusTargets?: unknown[];
        readonly transitions?: unknown[];
      }
      interface StoredGraph {
        readonly screens?: { readonly confidence?: string }[];
        readonly focusTargets?: { readonly confidence?: string }[];
        readonly transitions?: unknown[];
      }
      const before = JSON.parse(brokenInventory) as StoredInventory;
      const after = JSON.parse(repairedInventory) as StoredInventory;
      const beforeGraph = JSON.parse(brokenGraph) as StoredGraph;
      const afterGraph = JSON.parse(repairedGraph) as StoredGraph;
      const beforeLedger = JSON.parse(brokenLedger) as {
        readonly navigation?: { readonly termination?: unknown; readonly statistics?: unknown };
      };
      const afterLedger = JSON.parse(repairedLedger) as {
        readonly navigation?: { readonly termination?: unknown; readonly statistics?: unknown };
      };
      const observed = {
        originalScanId,
        repairedScanId,
        outputRoot,
        before: {
          run: brokenReport.run.status,
          inventory: before.status,
          screens: before.screens?.length,
          focus: before.focusTargets?.length,
          transitions: before.transitions?.length,
          graphTransitions: beforeGraph.transitions?.length,
          screenIdentityConfidence: beforeGraph.screens?.map((screen) => screen.confidence),
          focusIdentityConfidence: beforeGraph.focusTargets?.map((focus) => focus.confidence),
          issues: brokenReport.issues.map((issue) => ({ id: issue.id, rule: issue.rule })),
          exhausted: brokenReport.coverage.budget.exhausted,
          navigation: beforeLedger.navigation,
        },
        after: {
          run: repairedReport.run.status,
          inventory: after.status,
          screens: after.screens?.length,
          focus: after.focusTargets?.length,
          transitions: after.transitions?.length,
          graphTransitions: afterGraph.transitions?.length,
          screenIdentityConfidence: afterGraph.screens?.map((screen) => screen.confidence),
          focusIdentityConfidence: afterGraph.focusTargets?.map((focus) => focus.confidence),
          issues: repairedReport.issues.map((issue) => ({ id: issue.id, rule: issue.rule })),
          exhausted: repairedReport.coverage.budget.exhausted,
          navigation: afterLedger.navigation,
        },
      };
      process.stdout.write(`LIVE_MCP_COMPARE_SCANS ${JSON.stringify(observed)}\n`);
      expect(repairedReport.run.status, JSON.stringify(observed)).toBe("completed");
      expect(repairedReport.issues.some((issue) => issue.rule === "keyboard.modal-focus-escape"),
        `Repaired Chromium scan still reports a modal escape: ${JSON.stringify(observed)}`).toBe(false);

      const comparison = await tool(mcp, "tvdoctor_compare", {
        baseline_scan_id: originalScanId,
        current_scan_id: repairedScanId,
      });
      process.stdout.write(`LIVE_MCP_COMPARE_RESULT ${JSON.stringify(comparison.payload)}\n`);
      expect(comparison.isError, JSON.stringify(comparison.payload)).toBe(false);
      expect(comparison.payload).toMatchObject({
        baseline_scan_id: originalScanId,
        current_scan_id: repairedScanId,
      });
      if (before.status !== "complete" || after.status !== "complete") {
        // Real reports may say 'completed' even when conservative identity/
        // replay provenance marks the separate navigation inventory partial.
        // This is a successful safety check, NOT a successful issue comparison.
        expect(comparison.payload, JSON.stringify(observed)).toMatchObject({
          status: "inconclusive",
          classification: "inconclusive",
          reason: "inventory-unavailable",
        });
        expect(comparison.payload["resolved_findings"],
          "Partial real inventories must never establish resolved findings.").toBeUndefined();
        process.stdout.write(`LIVE_MCP_COMPARE_FAIL_CLOSED ${JSON.stringify({
          reason: comparison.payload["reason"],
          originalInventoryStatus: before.status,
          repairedInventoryStatus: after.status,
        })}\n`);
        return;
      }
      if (comparison.payload["status"] === "inconclusive") {
        expect(comparison.payload["resolved_findings"],
          "A failed-closed comparison must not present findings as resolved.").toBeUndefined();
        throw new Error(
          `Real production inventories/coverage could not be compared; no resolution claim is safe. ${JSON.stringify({
            reason: comparison.payload["reason"],
            blockers: comparison.payload["blockers"],
            observed,
          })}`,
        );
      }

      // A successful semantic comparison records issue disappearance, not a
      // replay-verified FIXED claim. The separate verification test proves FIXED.
      expect(comparison.payload["same_test_conditions"]).toBe(true);
      expect(["changed", "regressed"]).toContain(comparison.payload["status"]);
      const originalKeys = new Set(brokenReport.issues.map((issue) => `${issue.rule}\u0000${issue.id}`));
      const repairedKeys = new Set(repairedReport.issues.map((issue) => `${issue.rule}\u0000${issue.id}`));
      const observedResolved = brokenReport.issues
        .filter((issue) => !repairedKeys.has(`${issue.rule}\u0000${issue.id}`))
        .map((issue) => issue.id).sort();
      const observedNew = repairedReport.issues
        .filter((issue) => !originalKeys.has(`${issue.rule}\u0000${issue.id}`))
        .map((issue) => issue.id).sort();
      const resolved = comparison.payload["resolved_findings"];
      const newlyObserved = comparison.payload["new_findings"];
      expect(Array.isArray(resolved)).toBe(true);
      expect(Array.isArray(newlyObserved)).toBe(true);
      const resultResolvedIds = (resolved as { id: string }[]).map((issue) => issue.id).sort();
      const resultNewIds = (newlyObserved as { id: string }[]).map((issue) => issue.id).sort();
      expect(resultResolvedIds).toEqual(observedResolved);
      expect(resultNewIds).toEqual(observedNew);
      expect(resultResolvedIds).toContain(originalIssue.id);
      expect(comparison.payload["verification_status"]).toBeUndefined();
      expect(comparison.payload["fixed"]).toBeUndefined();
      expect(JSON.stringify(comparison.payload)).not.toContain(fixture.url);
    } finally {
      mcp.close();
      await fixture.close();
    }
  }, 180_000);

  it("compares two real, independently complete Chromium scans of a stable one-control keyboard page", async () => {
    // Deliberately minimal fixture: a named main landmark and one persistent,
    // uniquely identified focus control. The Tab handler keeps the graph
    // bounded without synthesizing graph state, scan reports or inventories.
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
      <title>Static keyboard focus fixture</title></head><body>
      <main aria-label="Static keyboard test"><h1>Static keyboard test</h1>
        <button id="primary-action" type="button">Primary action</button>
      </main>
      <script>
        const control = document.getElementById("primary-action");
        control.focus();
        document.addEventListener("keydown", (event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            control.focus();
          }
        });
      </script></body></html>`;
    const requests: string[] = [];
    const httpServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push(path);
      if (path !== "/static") {
        response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      }).end(html);
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Static keyboard fixture HTTP server did not bind.");
    }
    const url = `http://127.0.0.1:${String(address.port)}/static`;
    const outputRoot = join(tmpdir(), `tvdoctor-compare-static-live-${randomUUID()}`);
    const mcp = new TvDoctorMcpServer({ outputRoot });
    try {
      const initialized = await mcp.handle({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      });
      expect(initialized?.error).toBeUndefined();

      const originalScanId = await completedScan(mcp, url);
      const currentScanId = await completedScan(mcp, url);
      expect(currentScanId).not.toBe(originalScanId);
      const results = await Promise.all([originalScanId, currentScanId].map(async (scanId) => {
        const [reportJson, inventoryJson, graphJson] = await Promise.all([
          readFile(join(outputRoot, scanId, "report.json"), "utf8"),
          readFile(join(outputRoot, scanId, "inventory.json"), "utf8"),
          readFile(join(outputRoot, scanId, "navigation-graph.json"), "utf8"),
        ]);
        const report = parseTVDoctorReportJson(reportJson);
        const inventory = JSON.parse(inventoryJson) as {
          readonly status?: string;
          readonly screens?: unknown[];
          readonly focusTargets?: unknown[];
          readonly transitions?: unknown[];
        };
        const graph = JSON.parse(graphJson) as {
          readonly screens?: { readonly confidence?: string }[];
          readonly focusTargets?: { readonly confidence?: string }[];
        };
        return { scanId, report, inventory, graph };
      }));
      const evidence = results.map(({ scanId, report, inventory, graph }) => ({
        scanId,
        runStatus: report.run.status,
        budgetExhausted: report.coverage.budget.exhausted,
        packs: report.coverage.packs,
        inventoryStatus: inventory.status,
        screenCount: inventory.screens?.length,
        focusCount: inventory.focusTargets?.length,
        transitionCount: inventory.transitions?.length,
        screenConfidence: graph.screens?.map((screen) => screen.confidence),
        focusConfidence: graph.focusTargets?.map((focus) => focus.confidence),
        issues: report.issues.map((issue) => ({ id: issue.id, rule: issue.rule })),
      }));
      process.stdout.write(`LIVE_MCP_COMPARE_STATIC_SCANS ${JSON.stringify({ outputRoot, evidence })}\n`);
      for (const result of results) {
        expect(result.report.run.status, JSON.stringify(evidence)).toBe("completed");
        expect(result.report.coverage.budget.exhausted, JSON.stringify(evidence)).toEqual([]);
        expect(result.inventory.status, `Real inventory is incomplete: ${JSON.stringify(evidence)}`).toBe("complete");
        expect(result.graph.screens?.every((screen) => screen.confidence === "high")).toBe(true);
        expect(result.graph.focusTargets?.every((focus) => focus.confidence === "high")).toBe(true);
      }

      const comparison = await tool(mcp, "tvdoctor_compare", {
        baseline_scan_id: originalScanId, current_scan_id: currentScanId,
      });
      process.stdout.write(`LIVE_MCP_COMPARE_STATIC_RESULT ${JSON.stringify(comparison.payload)}\n`);
      expect(comparison.isError, JSON.stringify(comparison.payload)).toBe(false);
      expect(comparison.payload, JSON.stringify(evidence)).toMatchObject({
        status: "identical",
        classification: "no-regressions",
        should_fail: false,
        baseline_scan_id: originalScanId,
        current_scan_id: currentScanId,
        same_test_conditions: true,
        counts: {
          new_findings: 0,
          resolved_findings: 0,
          unchanged_findings: 0,
          screens_added: 0,
          screens_removed: 0,
          focus_targets_added: 0,
          focus_targets_removed: 0,
          transitions_added: 0,
          transitions_removed: 0,
          transitions_changed: 0,
        },
      });
      expect(comparison.payload["resolved_findings"]).toEqual([]);
      expect(comparison.payload["new_findings"]).toEqual([]);
      expect(comparison.payload["verification_status"]).toBeUndefined();
      expect(comparison.payload["fixed"]).toBeUndefined();
      expect(requests.filter((path) => path === "/static").length).toBeGreaterThanOrEqual(2);
    } finally {
      mcp.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  }, 180_000);
});
