#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { TestCommandResult, CliContext } from "./cli.js";
import type { LocalUiReportEntry } from "./local-ui-page.js";
import type { QaWorkflowResult } from "./qa-workflow.js";
import type { QaAcceptResult } from "./qa-accept.js";
import type { ProjectCheckResult } from "./project-check.js";
import type { ProjectAcceptResult } from "./project-accept.js";
import type { PublicRouteHealthAcceptResult } from "./public-route-health-accept.js";
import type { SpaRouteHealthAcceptResult } from "./spa-route-health-accept.js";
import type { BootHealthAcceptResult } from "./boot-health-accept.js";
import type { LocalUiRouteHealthCommandResult } from "./local-ui.js";

const args = process.argv.slice(2);
const uiHelpText = "Usage: tvdoctor ui [--port PORT]\n\nRun the private navigation dashboard on 127.0.0.1. PORT defaults to an available local port.\n";
const uiHelp = args[0] === "ui"
  && args.length === 2
  && (args[1] === "--help" || args[1] === "-h");
const requiresRuntime = new Set([
  "demo", "ui", "start", "scan", "site", "responsive", "test",
  "accessibility", "ci", "baseline", "setup", "doctor", "replay", "export-test",
  "verify-fix", "check", "project", "project-verify", "project-accept", "qa", "qa-verify", "qa-accept", "route-health", "spa-route-health", "boot-health",
]);

if (uiHelp) {
  process.stdout.write(uiHelpText);
} else if (!requiresRuntime.has(args[0] ?? "")) {
  // Help, version, privacy and unknown commands still use the real CLI parser
  // and safety/usage validation, without eagerly loading drivers and audit packs.
  const [{ runCli }, { inspectReport }] = await Promise.all([
    import("./cli.js"), import("./node-triage.js"),
  ]);
  process.exitCode = await runCli(args, {
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    operations: {
      replayIssue: async () => ({ status: "inconclusive", details: ["Browser replay is not loaded for offline findings."] }),
      inspectReport,
    },
    io: {
      writeStdout: (text) => { process.stdout.write(text); },
      writeStderr: (text) => { process.stderr.write(text); },
    },
  });
} else {
const [
  { PlaywrightWebDriver },
  { renderLocalUiOverview },
  { serveLocalUi },
  { createNodeCliOperations },
  { runCli },
  { ProcessStartTerminal },
  { runResponsiveScan, RESPONSIVE_VIEWPORTS },
  { systemReportActions },
  { githubWorkspaceSourceRoot },
  { verifyOriginalFindingWorkflow },
  { inspectReport },
] = await Promise.all([
  import("@tvdoctor/driver-web"),
  import("./local-ui-page.js"),
  import("./local-ui.js"),
  import("./node-replay.js"),
  import("./index.js"),
  import("./interactive.js"),
  import("./responsive-scan.js"),
  import("./start.js"),
  import("./source-correlation.js"),
  import("./node-verify-workflow.js"),
  import("./node-triage.js"),
]);

const shutdownController = new AbortController();
const require = createRequire(import.meta.url);
const inferredSourceRoot = githubWorkspaceSourceRoot(process.env);

async function installChromium(signal?: AbortSignal): Promise<void> {
  const playwrightEntry = require.resolve("playwright");
  const playwrightCli = join(dirname(playwrightEntry), "cli.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, "install", "chromium"], {
      stdio: "inherit",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const handleAbort = (): void => {
      try {
        child.kill();
      } finally {
        finish(new Error("Chromium setup was interrupted."));
      }
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted === true) handleAbort();
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(
        signal === null
          ? `Playwright Chromium installer exited with code ${String(code)}.`
          : `Playwright Chromium installer stopped after signal ${signal}.`,
      ));
    });
  });
}

const baseOperations = createNodeCliOperations();
const context: CliContext = {
  environment: {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  io: {
    writeStdout(text): void {
      process.stdout.write(text);
    },
    writeStderr(text): void {
      process.stderr.write(text);
    },
  },
  operations: {
    ...baseOperations,
    inspectReport,
    verifyOriginalFinding: async (request) => await verifyOriginalFindingWorkflow(request, {
      operations: baseOperations,
    }),
  },
  reportActions: systemReportActions,
  runtimeSetup: installChromium,
  startTerminal: new ProcessStartTerminal(),
  ...(inferredSourceRoot === undefined ? {} : { sourceRoot: inferredSourceRoot }),
  signal: shutdownController.signal,
  terminalProgress: {
    isInteractive: Boolean(process.stdout.isTTY),
    update(text) {
      process.stdout.write(`\u001b[2K\r${text}`);
    },
    finish() {
      if (process.stdout.isTTY) process.stdout.write("\u001b[2K\r");
    },
  },
  async runtimeProbe() {
    const driver = new PlaywrightWebDriver({
      browserLaunchOptions: { timeout: 15_000 },
      navigationTimeoutMs: 10_000,
      settle: { timeoutMs: 2_000 },
    });
    try {
      await driver.launch({ id: "tvdoctor-doctor", launchUri: "about:blank" });
      return { capabilities: [...await driver.capabilities()].sort() };
    } finally {
      await driver.close();
    }
  },
};

interface SiteOverviewIndex {
  readonly status: "complete" | "partial" | "failed";
  readonly pagesScanned: number;
  readonly pagesDiscovered: number;
  readonly issueCount: number;
  readonly maxPages: number;
  readonly pendingCount: number;
  readonly spa?: {
    readonly status: string;
    readonly statesObserved: number;
    readonly transitionsTested: number;
    readonly deferredStates: number;
    readonly reviewLeads: number;
  };
  readonly rows: readonly LocalUiReportEntry[];
}

function scanInteger(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value : null;
}

/** Extract only bounded counters and per-page paths from site-index, never raw discovered URLs. */
async function readSiteOverview(outputPath: string): Promise<SiteOverviewIndex | null> {
  const filename = join(outputPath, "site-index.json");
  try {
    if ((await stat(filename)).size > 2_000_000) return null;
    const raw = JSON.parse(await readFile(filename, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const object = raw as Record<string, unknown>;
    if (object["schemaVersion"] !== "tvdoctor.site-index/v1") return null;
    const status = object["status"];
    const pagesScanned = scanInteger(object["pagesScanned"], 20);
    const pagesDiscovered = scanInteger(object["pagesDiscovered"], 128);
    const issueCount = scanInteger(object["issueCount"], 1_000_000);
    const maxPages = scanInteger(object["maxPages"], 20);
    const routes = object["routes"];
    if ((status !== "complete" && status !== "partial" && status !== "failed")
      || pagesScanned === null || pagesDiscovered === null || issueCount === null
      || maxPages === null || maxPages < 1 || !Array.isArray(routes) || routes.length > 128) return null;
    const rows: LocalUiReportEntry[] = [];
    for (const [index, item] of routes.entries()) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
      const route = item as Record<string, unknown>;
      const routeStatus = route["status"];
      const findings = scanInteger(route["issueCount"], 1_000_000);
      if (!["completed", "partial", "failed", "skipped"].includes(String(routeStatus))
        || findings === null) return null;
      const savedPath = route["reportPath"];
      const reportPath = typeof savedPath === "string" && /^pages\/[0-9]{3}\/report\.json$/u.test(savedPath)
        ? savedPath.replace(/\.json$/u, ".html") : undefined;
      rows.push({
        label: `Route ${String(index + 1).padStart(2, "0")}`,
        status: String(routeStatus),
        findings,
        ...(reportPath === undefined ? {} : { artifact: reportPath }),
      });
    }
    let spa: SiteOverviewIndex["spa"];
    const spaValue = object["spaJourney"];
    if (spaValue !== null && typeof spaValue === "object" && !Array.isArray(spaValue)) {
      const entry = spaValue as Record<string, unknown>;
      const spaStatus = entry["status"];
      const statesObserved = scanInteger(entry["statesObserved"], 10_000);
      const transitionsTested = scanInteger(entry["transitionsTested"], 100_000);
      const deferredStates = scanInteger(entry["deferredStates"], 10_000);
      const reviewLeads = scanInteger(entry["reviewLeads"], 100_000);
      if (["completed", "partial", "cancelled", "failed"].includes(String(spaStatus))
        && statesObserved !== null && transitionsTested !== null
        && deferredStates !== null && reviewLeads !== null) {
        spa = { status: String(spaStatus), statesObserved, transitionsTested, deferredStates, reviewLeads };
        rows.push({
          label: "Experimental SPA journey graph",
          status: String(spaStatus),
          findings: reviewLeads,
          ...(entry["graphPath"] === "spa/graph.html"
            ? { artifact: "spa/graph.html" }
            : entry["reportPath"] === "spa/spa-journey.json" ? { artifact: "spa/spa-journey.json" } : {}),
        });
      }
    }
    return {
      status, pagesScanned, pagesDiscovered, issueCount, maxPages,
      pendingCount: Array.isArray(object["pendingRoutes"]) ? object["pendingRoutes"].length : 0,
      ...(spa === undefined ? {} : { spa }),
      rows,
    };
  } catch {
    return null;
  }
}

async function runSiteFromUi(
  request: import("./local-ui.js").LocalUiScanRequest,
  scanContext: CliContext,
): Promise<import("./local-ui.js").LocalUiScanOutcome> {
  const maxPages = request.maxRoutes;
  if (maxPages === undefined) return { exitCode: 2, result: null };
  const exitCode = await runCli([
    "site", request.target, "--input", "keyboard", "--mode", request.mode,
    "--max-pages", String(maxPages), "--output", request.outputPath,
    ...(request.exploreSpa === true ? ["--spa"] : []),
  ], scanContext);
  const index = await readSiteOverview(request.outputPath);
  if (index === null) return { exitCode, result: null };
  const status = index.status === "complete" ? "completed" : index.status;
  await writeFile(join(request.outputPath, "report.html"), renderLocalUiOverview({
    title: "Website route scan",
    status,
    summary: [
      `Scan status: ${status}`,
      `Routes scanned: ${String(index.pagesScanned)} / ${String(index.maxPages)} allowed`,
      `Routes discovered: ${String(index.pagesDiscovered)}`,
      `Known routes still pending: ${String(index.pendingCount)}`,
      `Observed findings: ${String(index.issueCount)}`,
      ...(index.spa === undefined ? [] : [
        `Experimental SPA exploration: ${index.spa.status}`,
        `SPA states / transitions: ${String(index.spa.statesObserved)} / ${String(index.spa.transitionsTested)}`,
        `SPA deferred branches: ${String(index.spa.deferredStates)}; review leads: ${String(index.spa.reviewLeads)}`,
      ]),
    ],
    kind: "site",
    entries: index.rows,
  }), "utf8");
  return {
    exitCode,
    result: {
      status,
      issueCount: index.issueCount,
      highestSeverity: null,
      reportPath: join(request.outputPath, "site-index.json"),
      details: [],
    },
    metrics: {
      routesVisited: index.pagesScanned,
      routesDiscovered: index.pagesDiscovered,
      routesLimit: index.maxPages,
    },
    evidencePaths: index.rows.flatMap((entry) => entry.artifact === undefined ? [] : [entry.artifact]),
  };
}

async function runResponsiveFromUi(
  request: import("./local-ui.js").LocalUiScanRequest,
): Promise<import("./local-ui.js").LocalUiScanOutcome> {
  await mkdir(dirname(request.outputPath), { recursive: true });
  await mkdir(request.outputPath);
  const result = await runResponsiveScan({
    target: request.target,
    outputDirectory: request.outputPath,
    maxDurationMs: request.mode === "quick" ? 20_000 : request.mode === "standard" ? 45_000 : 120_000,
    captureScreenshots: true,
    signal: request.signal,
  });
  const tested = new Set(result.pages.filter((page) => page.documentWidth !== null).map((page) => page.viewport));
  const visited = new Set(result.pages.filter((page) => page.documentWidth !== null).map((page) => page.routeIdentity));
  const status = result.status === "completed" ? "completed" : "partial";
  const rows: LocalUiReportEntry[] = result.pages.map((page, index) => ({
    label: `${page.viewport} · page ${String(index + 1).padStart(2, "0")}`,
    status: `${page.status} · ${page.screenshotStatus} screenshot`,
    findings: page.findings.length,
    ...(page.screenshot !== null && /^responsive\/(?:mobile|tablet|desktop)\/page-[0-9]{2}\.png$/u.test(page.screenshot)
      ? { artifact: page.screenshot, preview: true } : {}),
  }));
  await writeFile(join(request.outputPath, "responsive-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(request.outputPath, "report.html"), renderLocalUiOverview({
    title: "Responsive layout review",
    status,
    summary: [
      `Scan status: ${result.status}`,
      `Viewport sizes with observations: ${String(tested.size)} / ${String(RESPONSIVE_VIEWPORTS.length)} selected`,
      `Routes visited with measurements: ${String(visited.size)}`,
      `Routes discovered: ${String(result.pagesDiscovered)}`,
      `Deferred routes: ${String(result.pagesDeferred)}`,
      `Layout observations requiring review: ${String(result.findings.length)}`,
      `Termination reasons: ${result.terminationReasons.length > 0 ? result.terminationReasons.join(", ") : "none"}`,
    ],
    kind: "responsive",
    entries: rows,
  }), "utf8");
  return {
    exitCode: status === "completed" ? 0 : 3,
    result: {
      status,
      issueCount: result.findings.length,
      highestSeverity: null,
      reportPath: join(request.outputPath, "responsive-result.json"),
      details: [],
    },
    metrics: {
      routesVisited: visited.size,
      routesDiscovered: result.pagesDiscovered,
      viewportsTested: tested.size,
      viewportsRequested: RESPONSIVE_VIEWPORTS.length,
    },
    evidencePaths: rows.flatMap((entry) => entry.artifact === undefined ? [] : [entry.artifact]),
  };
}

async function runLocalUi(args: readonly string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(uiHelpText);
    return 0;
  }
  let port = 0;
  if (args.length !== 0) {
    if (args.length !== 2 || args[0] !== "--port" || !/^[0-9]{1,5}$/u.test(args[1] ?? "")
      || Number(args[1]) > 65535) {
      process.stderr.write("Usage: tvdoctor ui [--port PORT] (0–65535)\n");
      return 2;
    }
    port = Number(args[1]);
  }
  const ui = await serveLocalUi({
    port,
    signal: shutdownController.signal,
    async runRouteHealth(request) {
      const args = ["route-health", request.action, "--config", request.configPath,
        "--authorized", "--output", request.outputPath,
        ...(request.action === "accept" && request.originalPath !== undefined
          && request.originalSha256 !== undefined
          ? ["--original", request.originalPath, "--sha256", request.originalSha256] : []),
        "--json"];
      let stdout = "";
      let truncated = false;
      const exitCode = await runCli(args, { ...context, signal: request.signal,
        io: {
          writeStdout(part) {
            if (stdout.length + part.length <= 1024 * 1024) stdout += part;
            else truncated = true;
          },
          writeStderr(part) { void part; /* Raw app/browser diagnostics are private. */ },
        },
      });
      if (truncated || stdout.trim() === "") throw new Error("Route evidence unavailable.");
      let parsed: PublicRouteHealthAcceptResult | LocalUiRouteHealthCommandResult;
      try { parsed = JSON.parse(stdout) as typeof parsed; }
      catch { throw new Error("Route evidence was malformed."); }
      if ((request.action === "capture"
        && parsed.schemaVersion !== "tvdoctor.public-route-health-command/v1")
        || (request.action === "accept"
          && parsed.schemaVersion !== "tvdoctor.public-route-health-accept/v1")
        || ![0, 1, 2, 3, 4].includes(exitCode)
        || parsed.exitCode !== exitCode || parsed.shouldFail !== (exitCode !== 0)) {
        throw new Error("Route evidence disagreed with the public CLI outcome.");
      }
      return parsed;
    },
    async runSpaRouteHealth(request) {
      const args = ["spa-route-health", request.action, "--config", request.configPath,
        "--authorized", "--output", request.outputPath,
        ...(request.action === "accept" && request.originalPath !== undefined
          && request.originalSha256 !== undefined
          ? ["--original", request.originalPath, "--sha256", request.originalSha256] : []),
        "--json"];
      let stdout = "";
      let truncated = false;
      const exitCode = await runCli(args, { ...context, signal: request.signal,
        io: {
          writeStdout(part) {
            if (stdout.length + part.length <= 1024 * 1024) stdout += part;
            else truncated = true;
          },
          writeStderr(part) { void part; /* Never print private SPA route data. */ },
        },
      });
      if (truncated || stdout.trim() === "") throw new Error("SPA route evidence unavailable.");
      let parsed: SpaRouteHealthAcceptResult | import("./local-ui.js").LocalUiSpaRouteHealthCommandResult;
      try { parsed = JSON.parse(stdout) as typeof parsed; }
      catch { throw new Error("SPA route evidence was malformed."); }
      if ((request.action === "capture"
        && parsed.schemaVersion !== "tvdoctor.spa-route-health-command/v1")
        || (request.action === "accept"
          && parsed.schemaVersion !== "tvdoctor.spa-route-health-accept/v1")
        || ![0, 1, 2, 3, 4].includes(exitCode)
        || parsed.exitCode !== exitCode || parsed.shouldFail !== (exitCode !== 0)) {
        throw new Error("SPA route evidence disagreed with its public CLI.");
      }
      return parsed;
    },
    async runBootHealth(request) {
      const args = ["boot-health", request.action, "--config", request.configPath,
        "--authorized", "--output", request.outputPath,
        ...(request.action === "accept" && request.originalPath !== undefined
          && request.originalSha256 !== undefined
          ? ["--original", request.originalPath, "--sha256", request.originalSha256] : []),
        "--json"];
      let stdout = "";
      let truncated = false;
      const exitCode = await runCli(args, { ...context, signal: request.signal,
        io: {
          writeStdout(part) {
            if (stdout.length + part.length <= 1024 * 1024) stdout += part;
            else truncated = true;
          },
          writeStderr(part) { void part; /* Do not stream private browser or authored page data. */ },
        },
      });
      if (truncated || stdout.trim() === "") throw new Error("Boot evidence unavailable.");
      let parsed: BootHealthAcceptResult | import("./local-ui.js").LocalUiBootHealthCommandResult;
      try { parsed = JSON.parse(stdout) as typeof parsed; }
      catch { throw new Error("Boot evidence was malformed."); }
      if ((request.action === "capture"
        && parsed.schemaVersion !== "tvdoctor.boot-health-command/v1")
        || (request.action === "accept"
          && parsed.schemaVersion !== "tvdoctor.boot-health-accept/v1")
        || ![0, 1, 2, 3, 4].includes(exitCode)
        || parsed.exitCode !== exitCode || parsed.shouldFail !== (exitCode !== 0)) {
        throw new Error("Boot evidence disagreed with the public CLI outcome.");
      }
      return parsed;
    },
    async runProject(request) {
      // Only the localhost host-created private manifest is passed to the
      // actual public multi-route scanner. The browser cannot supply paths.
      let stdout = "";
      let oversized = false;
      const exitCode = await runCli([
        "project", "--config", request.manifestPath,
        "--authorized", "--output", request.outputPath, "--json",
      ], {
        ...context, signal: request.signal,
        io: {
          writeStdout(part) {
            if (stdout.length + part.length <= 1024 * 1024) stdout += part;
            else oversized = true;
          },
          writeStderr(part) { void part; /* No private browser or journey diagnostics. */ },
        },
      });
      if (oversized || stdout.trim() === "") throw new Error("Project scan evidence was absent.");
      let result: ProjectCheckResult;
      try { result = JSON.parse(stdout) as ProjectCheckResult; }
      catch { throw new Error("Project scan evidence was malformed."); }
      if (result.schemaVersion !== "tvdoctor.project-check/v1"
        || ![0, 1, 2, 3, 4].includes(exitCode) || result.exitCode !== exitCode
        || result.shouldFail !== (exitCode !== 0)) {
        throw new Error("Project scan did not match its public CLI outcome.");
      }
      return result;
    },
    async runProjectAccept(request) {
      let stdout = "";
      let oversized = false;
      const exitCode = await runCli([
        "project-accept", "--config", request.manifestPath,
        "--original", request.originalSummaryPath, "--authorized",
        "--output", request.outputPath, "--json",
      ], {
        ...context, signal: request.signal,
        io: {
          writeStdout(part) {
            if (stdout.length + part.length <= 1024 * 1024) stdout += part;
            else oversized = true;
          },
          writeStderr(part) { void part; /* Keep credential-bearing app errors private. */ },
        },
      });
      if (oversized || stdout.trim() === "") throw new Error("Project acceptance evidence was absent.");
      let result: ProjectAcceptResult;
      try { result = JSON.parse(stdout) as ProjectAcceptResult; }
      catch { throw new Error("Project acceptance evidence was malformed."); }
      if (result.schemaVersion !== "tvdoctor.project-accept/v1"
        || ![0, 1, 2, 3, 4].includes(exitCode) || result.exitCode !== exitCode
        || result.shouldFail !== (exitCode !== 0)) {
        throw new Error("Project acceptance did not match its public CLI outcome.");
      }
      return result;
    },
    async runQaAccept(request) {
      // An explicit click on a previously captured, server-owned original is
      // required by the localhost UI before this callback is invoked. No
      // arbitrary browser file paths or application-authored input is trusted.
      let stdout = "";
      let truncated = false;
      const exitCode = await runCli([
        "qa-accept", "--original", request.originalQaPath,
        "--target", request.target, "--authorized",
        "--output", request.outputPath, "--json",
      ], {
        ...context,
        signal: request.signal,
        io: {
          writeStdout(part) {
            if (stdout.length + part.length <= 1024 * 1024) stdout += part;
            else truncated = true;
          },
          writeStderr(part) { void part; /* Browser/app messages are private. */ },
        },
      });
      if (truncated || stdout.trim() === "") {
        throw new Error("QA acceptance did not provide bounded evidence.");
      }
      let result: QaAcceptResult;
      try { result = JSON.parse(stdout) as QaAcceptResult; }
      catch { throw new Error("QA acceptance evidence was malformed."); }
      if (result.schemaVersion !== "tvdoctor.qa-accept/v1"
        || ![0, 1, 2, 3, 4].includes(exitCode) || result.exitCode !== exitCode
        || result.shouldFail !== (exitCode !== 0)) {
        throw new Error("QA acceptance outcome did not match the real verifier.");
      }
      return result;
    },
    async runQa(request) {
      // Drive the exact PUBLIC CLI first-run QA implementation, never a
      // dashboard-only approximation of VERIFIED vs REVIEW. The UI owns the
      // fresh report directory but must not create it before runQaWorkflow.
      let stdout = "";
      let oversized = false;
      const exitCode = await runCli([
        "qa", request.target, "--output", request.outputPath,
        "--mode", request.mode, "--json",
        ...(request.safeInteractions ? [] : ["--no-interactions"]),
        ...(request.safeLinks ? ["--safe-links"] : []),
      ], {
        ...context,
        signal: request.signal,
        io: {
          writeStdout(part) {
            if (stdout.length + part.length <= 1024 * 1024) stdout += part;
            else oversized = true;
          },
          writeStderr(part) { void part; /* No browser content in dashboard logs. */ },
        },
      });
      if (oversized || stdout.trim() === "") throw new Error("QA evidence was not available.");
      let parsed: QaWorkflowResult;
      try { parsed = JSON.parse(stdout) as QaWorkflowResult; }
      catch { throw new Error("QA evidence was not valid."); }
      if (parsed.schemaVersion !== "tvdoctor.qa/v1" || parsed.source !== "url"
        || ![0, 1, 3, 4].includes(exitCode) || parsed.exitCode !== exitCode
        || parsed.shouldFail !== (exitCode !== 0)) {
        throw new Error("QA evidence did not match the actual scanner result.");
      }
      return parsed;
    },
    async runScan(request) {
      let result: TestCommandResult | null = null;
      const operations = context.operations;
      const testTarget = operations?.testTarget;
      if (operations === undefined || testTarget === undefined) {
        return { exitCode: 4, result };
      }
      const scanContext: CliContext = {
        ...context,
        signal: request.signal,
        // Never stream private targets, discovery routes or browser failure text into local stdout.
        io: { writeStdout(text) { void text; }, writeStderr(text) { void text; } },
        operations: {
          ...operations,
          replayIssue: operations.replayIssue,
          async testTarget(scanRequest) {
            result = await testTarget(scanRequest);
            return result;
          },
        },
        terminalProgress: {
          isInteractive: true,
          update(text) { void text; },
          finish() { return; },
        },
      };
      if (request.type === "site") return await runSiteFromUi(request, scanContext);
      if (request.type === "responsive") return await runResponsiveFromUi(request);
      const exitCode = await runCli([
        "scan", request.target,
        "--input", request.input,
        "--mode", request.mode,
        "--output", request.outputPath,
        "--target-redaction", "origin",
        ...(request.recordVideo ? ["--record-video"] : []),
      ], scanContext);
      return { exitCode, result };
    },
  });
  process.stdout.write(`TVDoctor local dashboard: ${ui.url}/\nPress Ctrl+C to stop.\n`);
  if (!shutdownController.signal.aborted) {
    await new Promise<void>((resolveAbort) => {
      shutdownController.signal.addEventListener("abort", () => resolveAbort(), { once: true });
    });
  }
  await ui.close();
  return 0;
}

let interruptCount = 0;
function handleInterrupt(): void {
  interruptCount += 1;
  if (interruptCount > 1) {
    process.stderr.write("\nForced exit after second interrupt.\n");
    process.exit(130);
  }
  process.stderr.write("\nStopping after the current operation; completed coverage will be retained.\n");
  shutdownController.abort();
}

process.on("SIGINT", handleInterrupt);
try {
  process.exitCode = args[0] === "ui"
    ? await runLocalUi(args.slice(1))
    : await runCli(args, context);
} finally {
  process.removeListener("SIGINT", handleInterrupt);
}
}
