import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import {
  availableObservation,
  type ActionResult,
  type AppReference,
  type StateSnapshot,
  type TVDoctorIssue,
} from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  createArtifactStore,
  renderReportHtml,
  writeReportBundle,
} from "@tvdoctor/reporters";
import {
  MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE,
  MAX_EVIDENCE_CAPTURE_DURATION_MS,
  MAX_ISSUES_WITH_FRESH_EVIDENCE,
  captureIssue,
  captureIssuesWithinBudget,
  createNodeAuditOperation,
  exhaustedBudgets,
  freshEvidenceDriftReason,
  partialRunDetails,
  packCoverage,
  targetRequiresReplayOverride,
  writeAuditAuxiliaryArtifacts,
  type AuditRunProducts,
} from "../src/node-audit.js";
import {
  preferredStartupControl,
  resolveStartupDecisionThroughFocus,
  startupActivationSequence,
} from "../src/node-audit-navigation.js";

const PRODUCTS: AuditRunProducts = {
  navigation: null,
  navigationFindings: [],
  streaming: null,
  web: null,
};

it("retains every selected web pack as partial when interruption skips its stage", () => {
  expect(packCoverage(PRODUCTS, new Set(["layout", "performance", "crashes"]))).toEqual([
    { pack: "layout", status: "partial" },
    { pack: "performance", status: "partial" },
    { pack: "crashes", status: "partial" },
  ]);
});

function issue(id = "TVDOCTOR-NAV-HARDENING000000000000000001"): TVDoctorIssue {
  return {
    id,
    rule: "remote.self-loop",
    title: "DOWN remains on the source",
    description: "The witnessed transition does not reach the expected target.",
    severity: "high",
    confidence: "deterministic",
    pack: "navigation",
    screen: "Test",
    expected: "Focus reaches expected-target.",
    observed: "Focus reaches observed-target.",
    transition: {
      fromElement: "source-target",
      action: "DOWN",
      expectedElement: "expected-target",
      observedElement: "observed-target",
    },
    evidence: [],
    reproduction: {
      status: "available",
      resetStrategy: "reload",
      originalSequence: [{ key: "DOWN", repeat: 1 }],
      minimizedSequence: null,
      confidence: "deterministic",
      artifact: null,
    },
  };
}

function snapshot(focus: string): StateSnapshot {
  return {
    capturedAt: "2026-08-24T10:00:00.000Z",
    location: availableObservation("https://example.test/app"),
    focusedElement: availableObservation({ stableId: focus, role: "button", name: focus }),
    uiTree: availableObservation([]),
  };
}

async function allFiles(root: string, relative = ""): Promise<readonly string[]> {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) paths.push(...await allFiles(root, child));
    else if (entry.isFile()) paths.push(child);
  }
  return paths;
}

describe("Node audit release hardening", () => {
  it("closes the owned driver exactly once after a successful audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-success-close-"));
    try {
      const closed = vi.fn(async () => undefined);
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => new Set(["remote-input", "ui-tree"]),
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: [],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
      });

      expect(result.status).toBe("completed");
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates the same close rejection once after an otherwise successful audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-success-close-failure-"));
    try {
      const closeError = new Error("primary driver close failed");
      const closed = vi.fn(async () => {
        throw closeError;
      });
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => new Set(["remote-input", "ui-tree"]),
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      await expect(operation({
        target: "https://example.test/app",
        packs: [],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
      })).rejects.toBe(closeError);
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a failed-run bundle when launch fails and keeps technical detail out of user copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-launch-failure-"));
    try {
      const closed = vi.fn(async () => undefined);
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => {
            throw new Error("page.goto: SECRET_CANARY failed");
          },
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: ["all"],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
      });

      expect(result.status).toBe("failed");
      expect(result.reportPath).not.toBeNull();
      expect(result.details.join(" ")).toContain("The scan could not complete.");
      expect(JSON.stringify(result)).not.toContain("SECRET_CANARY");
      expect(await readFile(join(root, "bundle", "report.json"), "utf8")).not.toContain("SECRET_CANARY");
      const debug = await readFile(join(root, "bundle", "failure-debug.json"), "utf8");
      expect(debug).not.toContain("SECRET_CANARY");
      expect(JSON.parse(debug)).toMatchObject({
        schemaVersion: 1,
        code: "network-unreachable",
        summary: "The website could not be reached. Check the address and network connection.",
      });
      expect(await readFile(join(root, "bundle", "report.html"), "utf8")).toContain("Scan could not complete");
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes the owned driver exactly once when an audit stage throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-stage-failure-close-"));
    try {
      const closed = vi.fn(async () => undefined);
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => {
            throw new Error("stage initialization failed");
          },
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: ["streaming"],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
      });

      expect(result.status).toBe("failed");
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses close rejection after stage failure and retains failed-run copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-stage-and-close-failure-"));
    try {
      const closeError = new Error("secondary close failure");
      const closed = vi.fn(async () => {
        throw closeError;
      });
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => {
            throw new Error("stage initialization failed");
          },
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: ["streaming"],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
      });

      expect(result.status).toBe("failed");
      expect(result.details.slice(0, 3)).toEqual([
        "The scan could not complete.",
        "TVDoctor could not complete this scan because the browser session failed.",
        "A bounded failure classification was retained in failure-debug.json.",
      ]);
      expect(result.details[3]).toMatch(/^Report: /u);
      expect(JSON.parse(await readFile(join(root, "bundle", "failure-debug.json"), "utf8")))
        .toEqual({
          code: "browser-session-failed",
          schemaVersion: 1,
          summary: "TVDoctor could not complete this scan because the browser session failed.",
        });
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes the owned driver exactly once when a pre-aborted signal skips stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-interrupted-close-"));
    try {
      const controller = new AbortController();
      controller.abort();
      const closed = vi.fn(async () => undefined);
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => new Set(["remote-input", "ui-tree"]),
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: ["streaming"],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
        signal: controller.signal,
      });

      expect(result.status).toBe("partial");
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses close rejection after interruption during active exploration", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-active-interruption-close-"));
    try {
      const controller = new AbortController();
      const closeError = new Error("interrupted close failed");
      const closed = vi.fn(async () => {
        throw closeError;
      });
      let capabilityCalls = 0;
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => {
            capabilityCalls += 1;
            if (capabilityCalls === 2) controller.abort();
            return new Set(["remote-input", "ui-tree"]);
          },
          reset: async () => undefined,
          snapshot: async () => snapshot("home"),
          getPerformanceProfile: () => null,
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: ["navigation"],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
        signal: controller.signal,
      });

      expect(capabilityCalls).toBe(2);
      expect(result.status).toBe("partial");
      expect(result.details).toContain(
        "The scan was interrupted; completed navigation coverage was retained.",
      );
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes the owned driver exactly once when failed-report writing rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-failed-report-rejection-"));
    try {
      const closed = vi.fn(async () => undefined);
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => {
            throw new Error("stage failure before invalid report target");
          },
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      await expect(operation({
        target: "not a valid URL",
        packs: ["streaming"],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
      })).rejects.toMatchObject({
        name: "TypeError",
        message: "Invalid URL",
        code: "ERR_INVALID_URL",
      });
      expect(JSON.parse(await readFile(join(root, "bundle", "failure-debug.json"), "utf8")))
        .toEqual({
          code: "browser-session-failed",
          schemaVersion: 1,
          summary: "TVDoctor could not complete this scan because the browser session failed.",
        });
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never persists raw Windows or Unix paths, shell commands, or tokens in failed-run diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-private-failure-diagnostics-"));
    try {
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => {
            throw new Error(
              "spawn C:\\Users\\alice\\AppData\\Local\\secret-tool.exe --token TOP_SECRET ENOENT cwd=/home/alice/private",
            );
          },
          close: async () => undefined,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: [],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
      });

      expect(result.status).toBe("failed");
      const debug = await readFile(join(root, "bundle", "failure-debug.json"), "utf8");
      for (const privateFragment of [
        "C:\\Users\\alice",
        "/home/alice/private",
        "secret-tool.exe",
        "--token",
        "TOP_SECRET",
      ]) {
        expect(debug).not.toContain(privateFragment);
      }
      expect(JSON.parse(debug)).toEqual({
        code: "filesystem-access",
        schemaVersion: 1,
        summary: "TVDoctor could not access a required file or folder.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes the owned driver exactly once after a setup blocker stops the audit early", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-setup-blocker-close-"));
    try {
      const closed = vi.fn(async () => undefined);
      const consentButton = {
        stableId: "accept-consent",
        role: "button",
        name: "Accept",
        text: "Accept",
        bounds: { x: 10, y: 10, width: 100, height: 40 },
        visible: true,
        enabled: true,
        focusable: true,
        focused: true,
        modal: false,
        selectionState: null,
        valueNow: null,
        children: [],
      };
      const consentSnapshot: StateSnapshot = {
        capturedAt: "2026-08-25T12:00:00.000Z",
        location: availableObservation("https://example.test/app"),
        focusedElement: availableObservation({
          stableId: "accept-consent",
          role: "button",
          name: "Accept",
          bounds: { x: 10, y: 10, width: 100, height: 40 },
        }),
        uiTree: availableObservation([{
          ...consentButton,
          stableId: "consent-dialog",
          role: "dialog",
          name: "Privacy choice",
          text: "Privacy choice",
          focusable: false,
          focused: false,
          modal: true,
          children: [consentButton],
        }]),
      };
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => new Set(["remote-input", "ui-tree"]),
          reset: async () => undefined,
          snapshot: async () => consentSnapshot,
          close: closed,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: ["navigation"],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
      });

      expect(result.status).toBe("partial");
      expect(result.details[0]).toContain("scan was not started");
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not attribute an unrequested streaming dependency budget to selected web coverage", () => {
    const products: AuditRunProducts = {
      ...PRODUCTS,
      streaming: {
        status: "error",
        termination: {
          reason: "max-duration",
          complete: false,
          detail: "The hidden route-discovery journey reached its duration budget.",
        },
      } as AuditRunProducts["streaming"],
    };

    expect(exhaustedBudgets(products, new Set(["layout", "performance"]))).toEqual([]);
    expect(exhaustedBudgets(products, new Set(["streaming"]))).toEqual(["duration"]);
  });

  it("explains each selected partial result without exposing a hidden dependency", () => {
    const products: AuditRunProducts = {
      ...PRODUCTS,
      streaming: {
        status: "error",
        termination: {
          reason: "max-duration",
          complete: false,
          detail: "Hidden dependency stopped.",
        },
      } as AuditRunProducts["streaming"],
      web: {
        termination: {
          reason: "max-actions",
          complete: false,
          detail: "The selected web action budget was exhausted.",
        },
        stages: [{
          stage: "layout",
          status: "partial",
          detail: "Viewport proof remained incomplete.",
        }],
      } as unknown as AuditRunProducts["web"],
    };

    const details = partialRunDetails(products, new Set(["layout"]), 1);
    expect(details).toEqual([
      "Partial reason: web diagnostics stopped at max-actions: The selected web action budget was exhausted.",
      "Partial pack layout: partial: Viewport proof remained incomplete.",
      "Partial reason: fresh evidence was unavailable for 1 issue.",
    ]);
    expect(details.join(" ")).not.toContain("Hidden dependency");
  });

  it("marks only redacted query or fragment routes as requiring replay override", () => {
    expect(targetRequiresReplayOverride("https://example.test/app?route=player")).toBe(true);
    expect(targetRequiresReplayOverride("https://example.test/app#captions")).toBe(true);
    expect(targetRequiresReplayOverride("https://example.test/app")).toBe(false);
  });

  it("distinguishes a duration safety bound from an actionable interruption", () => {
    const products: AuditRunProducts = {
      ...PRODUCTS,
      navigation: {
        termination: {
          reason: "max-duration",
          complete: false,
          remainingFrontierEntries: 3,
          remainingCandidateActions: 18,
          detail: "Bounded-incomplete: 3 frontier entries remain after max-duration.",
        },
        budgets: { maxActions: 10_000, maxStates: 1_000, maxDepth: 32, maxDurationMs: 1_800_000 },
      } as AuditRunProducts["navigation"],
    };

    expect(partialRunDetails(products, new Set(["navigation"]), 0)).toEqual([
      "BOUNDED-INCOMPLETE: navigation reached its 1800-second safety ceiling with 3 frontier entries and about 18 candidate actions remaining.",
    ]);
  });

  it("reports an observed startup blocker without calling it replay divergence", () => {
    const products: AuditRunProducts = {
      ...PRODUCTS,
      navigationStartup: {
        status: "setup-blocker",
        blockers: [{ kind: "consent-wall" }],
      } as unknown as AuditRunProducts["navigationStartup"],
    };

    expect(partialRunDetails(products, new Set(["navigation"]), 0)).toEqual([
      "Startup setup blocker: consent-wall; caller preparation policy was observation-only.",
    ]);
  });

  it("detects injected fresh-evidence identity drift", () => {
    const action: ActionResult = {
      key: "DOWN",
      outcome: "applied",
      timing: { inputSentAtMs: 1 },
    };
    expect(freshEvidenceDriftReason(issue(), {
      before: snapshot("source-target"),
      after: snapshot("observed-target"),
      action,
    })).toBeNull();
    expect(freshEvidenceDriftReason(issue(), {
      before: snapshot("drifted-target"),
      after: snapshot("observed-target"),
      action,
    })).toMatch(/different pre-action focus identity/iu);
    expect(freshEvidenceDriftReason(issue(), {
      before: snapshot("source-target"),
      after: snapshot("drifted-target"),
      action,
    })).toMatch(/different post-action focus identity/iu);
  });

  it("downgrades a capture failure to truthful unavailable reproduction", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-capture-failure-"));
    try {
      const store = await createArtifactStore(root);
      const closed = vi.fn(async () => undefined);
      const launches: AppReference[] = [];
      const result = await captureIssue(
        store,
        "https://example.test/app?token=TARGET_CANARY#FRAGMENT_CANARY",
        PRODUCTS,
        issue(),
        () => ({
          async launch(app: AppReference) {
            launches.push(app);
            throw new Error(
              "spawn C:\\Users\\alice\\capture.exe cwd=/home/alice/private\nAuthorization: Bearer CAPTURE_SECRET",
            );
          },
          close: closed,
        } as unknown as PlaywrightWebDriver),
      );

      expect(result.failed).toBe(true);
      expect(result.replay).toBeNull();
      expect(result.issue.reproduction).toMatchObject({ status: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("CAPTURE_SECRET");
      expect(JSON.stringify(result)).not.toContain("C:\\Users\\alice");
      expect(JSON.stringify(result)).not.toContain("/home/alice/private");
      expect(JSON.stringify(result)).not.toContain("capture.exe");
      expect(result.artifacts).toHaveLength(8);
      expect(result.artifacts.find((entry) => entry.id.endsWith(":replay"))?.status)
        .toBe("unavailable");
      expect(launches[0]?.launchUri)
        .toBe("https://example.test/app?token=TARGET_CANARY#FRAGMENT_CANARY");
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds huge issue sets without approaching the 10k artifact limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-capture-budget-"));
    try {
      const store = await createArtifactStore(root);
      const issues = Array.from({ length: 2_000 }, (_, index) => issue(
        `TVDOCTOR-NAV-STRESS${String(index).padStart(24, "0")}`,
      ));
      const capturer = vi.fn(async (
        _store,
        _target,
        _products,
        sourceIssue: TVDoctorIssue,
      ) => ({ issue: sourceIssue, artifacts: [], replay: null, failed: false }));
      const results = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        issues,
        () => { throw new Error("driver should be supplied only to the capturer"); },
        capturer,
      );

      expect(results).toHaveLength(2_000);
      expect(capturer).toHaveBeenCalledTimes(MAX_ISSUES_WITH_FRESH_EVIDENCE);
      expect(results[MAX_ISSUES_WITH_FRESH_EVIDENCE]?.failed).toBe(true);
      expect(results[MAX_ISSUES_WITH_FRESH_EVIDENCE]?.issue.reproduction.status)
        .toBe("unavailable");
      expect(MAX_ISSUES_WITH_FRESH_EVIDENCE * 8 + 2).toBeLessThan(10_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures all 52 Deep issues when within the unchanged time limit, but keeps a hard issue cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-deep-evidence-budget-"));
    try {
      const store = await createArtifactStore(root);
      const allIssues = Array.from({ length: 140 }, (_, index) => issue(
        `TVDOCTOR-NAV-DEEP${String(index).padStart(24, "0")}`,
      ));
      const capturedIds: string[] = [];
      const capture = vi.fn(async (
        _store,
        _target,
        _products,
        sourceIssue: TVDoctorIssue,
      ) => {
        capturedIds.push(sourceIssue.id);
        return { issue: sourceIssue, artifacts: [], replay: null, failed: false };
      });
      const run = (issues: readonly TVDoctorIssue[], limit: number) => captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        issues,
        () => { throw new Error("Injected capturer should not open a driver."); },
        capture,
        () => 0,
        undefined,
        false,
        undefined,
        false,
        limit,
      );

      const normal = await run(allIssues.slice(0, 52), MAX_ISSUES_WITH_FRESH_EVIDENCE);
      expect(normal.filter((entry) => !entry.failed)).toHaveLength(MAX_ISSUES_WITH_FRESH_EVIDENCE);
      capture.mockClear();
      capturedIds.length = 0;

      const deep = await run(allIssues.slice(0, 52), MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE);
      expect(deep).toHaveLength(52);
      expect(deep.every((entry) => !entry.failed)).toBe(true);
      expect(capture).toHaveBeenCalledTimes(52);
      expect(capturedIds).toEqual(allIssues.slice(0, 52).map((entry) => entry.id));

      const capped = await run(allIssues, MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE);
      expect(capped.filter((entry) => !entry.failed)).toHaveLength(MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE);
      expect(capped.filter((entry) => entry.failed)).toHaveLength(allIssues.length - MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE);
      expect(capped[MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE]?.issue.reproduction).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("per-run limit of 128"),
      });
      await expect(run(allIssues, MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE + 1))
        .rejects.toThrow(/positive bounded integer/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not extend the shared evidence deadline when Deep raises the issue ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-deep-evidence-time-"));
    try {
      const store = await createArtifactStore(root);
      const issues = Array.from({ length: 52 }, (_, index) => issue(
        `TVDOCTOR-NAV-DEEPTIME${String(index).padStart(24, "0")}`,
      ));
      let elapsedMs = 0;
      const capture = vi.fn(async (_store, _target, _products, sourceIssue: TVDoctorIssue) => {
        elapsedMs = MAX_EVIDENCE_CAPTURE_DURATION_MS;
        return { issue: sourceIssue, artifacts: [], replay: null, failed: false };
      });
      const results = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        issues,
        () => { throw new Error("No real browser is needed for a deadline test."); },
        capture,
        () => elapsedMs,
        undefined,
        false,
        undefined,
        false,
        MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE,
      );
      expect(capture).toHaveBeenCalledOnce();
      expect(results.filter((result) => !result.failed)).toHaveLength(1);
      expect(results.filter((result) => result.failed)).toHaveLength(51);
      expect(results[1]?.issue.reproduction).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("120000 ms run budget"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes the remaining global budget into a real fresh capture near the deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-deep-near-deadline-"));
    try {
      const store = await createArtifactStore(root);
      const launch = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      const close = vi.fn(async () => undefined);
      const driver = { launch, close } as unknown as PlaywrightWebDriver;
      let calls = 0;
      const results = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        [issue("TVDOCTOR-NAV-NEAR-DEADLINE0000001")],
        () => driver,
        undefined,
        () => calls++ === 0 ? 0 : MAX_EVIDENCE_CAPTURE_DURATION_MS - 1,
        undefined,
        false,
        undefined,
        false,
        MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE,
      );
      expect(launch).toHaveBeenCalledOnce();
      expect(results).toHaveLength(1);
      expect(results[0]?.failed).toBe(true);
      expect(results[0]?.issue.reproduction).toMatchObject({ status: "unavailable" });
      expect(close).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures late critical replayable issues before low-value findings without reordering the report", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-triage-"));
    try {
      const store = await createArtifactStore(root);
      const low = Array.from({ length: MAX_ISSUES_WITH_FRESH_EVIDENCE + 8 }, (_, index) => ({
        ...issue(`TVDOCTOR-NAV-TRIAGE${String(index).padStart(24, "0")}`),
        severity: "info" as const,
        confidence: "heuristic" as const,
        reproduction: { status: "unavailable" as const, reason: "No deterministic reproduction." },
      }));
      const criticalReplay = { ...issue("TVDOCTOR-STREAMING-CRITICAL-REPLAY"), severity: "critical" as const, pack: "streaming" };
      const criticalHeuristic = {
        ...issue("TVDOCTOR-WEB-CRITICAL-HEURISTIC"),
        severity: "critical" as const,
        confidence: "heuristic" as const,
        pack: "accessibility",
        reproduction: { status: "unavailable" as const, reason: "Heuristic finding." },
      };
      const highReplay = { ...issue("TVDOCTOR-WEB-HIGH-REPLAY"), severity: "high" as const, pack: "crashes" };
      const issues: TVDoctorIssue[] = [...low, criticalHeuristic, highReplay, criticalReplay];
      const selected: string[] = [];
      const capturer = vi.fn(async (
        _store,
        _target,
        _products,
        sourceIssue: TVDoctorIssue,
      ) => {
        selected.push(sourceIssue.id);
        return { issue: sourceIssue, artifacts: [], replay: null, failed: false };
      });

      const results = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        issues,
        () => { throw new Error("An injected capturer must not construct a driver."); },
        capturer,
      );

      expect(selected.slice(0, 3)).toEqual([criticalReplay.id, criticalHeuristic.id, highReplay.id]);
      expect(selected).toHaveLength(MAX_ISSUES_WITH_FRESH_EVIDENCE);
      expect(results.map((entry) => entry.issue.id)).toEqual(issues.map((entry) => entry.id));
      expect(results[issues.indexOf(criticalReplay)]?.failed).toBe(false);
      expect(results[issues.indexOf(criticalHeuristic)]?.failed).toBe(false);
      expect(results[issues.indexOf(highReplay)]?.failed).toBe(false);
      expect(results[0]?.failed).toBe(false);
      expect(results[MAX_ISSUES_WITH_FRESH_EVIDENCE - 3]?.failed).toBe(true);
      expect(results[MAX_ISSUES_WITH_FRESH_EVIDENCE - 3]?.issue.reproduction).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("per-run limit"),
      });
      expect(results.filter((entry) => entry.failed)).toHaveLength(issues.length - MAX_ISSUES_WITH_FRESH_EVIDENCE);
      expect(low[MAX_ISSUES_WITH_FRESH_EVIDENCE - 3]?.reproduction.reason).toBe("No deterministic reproduction.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rotates equal-priority evidence captures across packs and keeps within-pack order", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-fair-packs-"));
    try {
      const store = await createArtifactStore(root);
      const navigation = Array.from({ length: MAX_ISSUES_WITH_FRESH_EVIDENCE + 3 }, (_, index) => ({
        ...issue(`TVDOCTOR-NAV-FAIR${String(index).padStart(24, "0")}`),
        severity: "critical" as const,
      }));
      const streaming = [
        { ...issue("TVDOCTOR-STREAMING-FAIR-0001"), severity: "critical" as const, pack: "streaming" },
        { ...issue("TVDOCTOR-STREAMING-FAIR-0002"), severity: "critical" as const, pack: "streaming" },
      ];
      const web = { ...issue("TVDOCTOR-WEB-FAIR-0001"), severity: "critical" as const, pack: "crashes" };
      const issues: TVDoctorIssue[] = [...navigation, ...streaming, web];
      const captureOrder: string[] = [];
      const results = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        issues,
        () => { throw new Error("Unexpected real driver construction."); },
        async (_store, _target, _products, sourceIssue) => {
          captureOrder.push(sourceIssue.id);
          return { issue: sourceIssue, artifacts: [], replay: null, failed: false };
        },
      );

      expect(captureOrder.slice(0, 6)).toEqual([
        navigation[0]?.id,
        streaming[0]?.id,
        web.id,
        navigation[1]?.id,
        streaming[1]?.id,
        navigation[2]?.id,
      ]);
      expect(results.map((entry) => entry.issue.id)).toEqual(issues.map((entry) => entry.id));
      expect(results.filter((entry) => !entry.failed)).toHaveLength(MAX_ISSUES_WITH_FRESH_EVIDENCE);
      expect(results.at(-1)?.failed).toBe(false);
      expect(results[31]?.failed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps deadline and interruption failures explicit after priority scheduling", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-priority-stop-"));
    try {
      const store = await createArtifactStore(root);
      const low = { ...issue("TVDOCTOR-NAV-STOP-LOW"), severity: "low" as const };
      const critical = { ...issue("TVDOCTOR-NAV-STOP-CRITICAL"), severity: "critical" as const };
      const issues = [low, critical];
      let elapsedMs = 0;
      const capturedBeforeDeadline: string[] = [];
      const deadlineResults = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        issues,
        () => { throw new Error("Unexpected driver construction."); },
        async (_store, _target, _products, sourceIssue) => {
          capturedBeforeDeadline.push(sourceIssue.id);
          elapsedMs = 120_000;
          return { issue: sourceIssue, artifacts: [], replay: null, failed: false };
        },
        () => elapsedMs,
      );

      expect(capturedBeforeDeadline).toEqual([critical.id]);
      expect(deadlineResults.map((entry) => entry.issue.id)).toEqual(issues.map((entry) => entry.id));
      expect(deadlineResults[0]).toMatchObject({ failed: true, replay: null });
      expect(deadlineResults[0]?.issue.reproduction).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("run budget was reached"),
      });
      expect(deadlineResults[1]?.failed).toBe(false);

      const controller = new AbortController();
      const interruptedResults = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        issues,
        () => { throw new Error("Unexpected driver construction."); },
        async (_store, _target, _products, sourceIssue) => {
          controller.abort();
          return { issue: sourceIssue, artifacts: [], replay: null, failed: false };
        },
        () => 0,
        controller.signal,
      );

      expect(interruptedResults.map((entry) => entry.issue.id)).toEqual(issues.map((entry) => entry.id));
      expect(interruptedResults[0]?.issue.reproduction).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("interrupted"),
      });
      expect(interruptedResults[0]?.failed).toBe(true);
      expect(interruptedResults[1]?.failed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps opt-in video outside report/v1 artifacts while linking the trusted sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-video-sidecar-"));
    try {
      let recordedPath: string | null = null;
      const operation = createNodeAuditOperation({
        createDriver: (options?: { readonly recordVideoDirectory?: string }) => {
          const recordingDirectory = options?.recordVideoDirectory;
          return ({
            launch: async () => undefined,
            capabilities: async () => new Set(["remote-input", "ui-tree"]),
            close: async () => {
              if (recordingDirectory === undefined) return;
              await mkdir(recordingDirectory, { recursive: true });
              recordedPath = join(recordingDirectory, "audit-session.webm");
              await writeFile(recordedPath, Uint8Array.from([1, 2, 3, 4]));
            },
            getRecordedVideoPath: () => recordedPath,
          } as unknown as PlaywrightWebDriver);
        },
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: [],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
        recordVideo: true,
      });

      expect(result.status).toBe("completed");
      expect(recordedPath).toBe(join(root, "bundle", "video", "audit-session.webm"));
      expect(result.details.join("\n")).toContain("Video evidence:");
      expect(result.details.join("\n")).toContain("may contain sensitive target content");

      const reportText = await readFile(join(root, "bundle", "report.json"), "utf8");
      const report = JSON.parse(reportText) as {
        artifacts: readonly { readonly kind: string; readonly path?: string }[];
      };
      expect(report.artifacts.some((artifact) => artifact.path?.endsWith(".webm") === true)).toBe(false);
      expect(report.artifacts.some((artifact) => artifact.kind === "video")).toBe(false);
      expect(reportText).not.toContain("audit-session.webm");

      const html = await readFile(join(root, "bundle", "report.html"), "utf8");
      expect(html).toContain("video/audit-session.webm");
      expect(html).toContain("may contain sensitive target content");

      const regenerated = renderReportHtml(JSON.parse(reportText));
      expect(regenerated).not.toContain("audit-session.webm");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps audit classification unchanged when requested video evidence is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-video-unavailable-"));
    try {
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => new Set(["remote-input", "ui-tree"]),
          close: async () => undefined,
        } as unknown as PlaywrightWebDriver),
      });

      const result = await operation({
        target: "https://example.test/app",
        packs: [],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
        recordVideo: true,
      });

      expect(result.status).toBe("completed");
      expect(result.issueCount).toBe(0);
      expect(result.details).toContain(
        "Video evidence unavailable; audit classification does not depend on video recording.",
      );
      expect(await readFile(join(root, "bundle", "report.html"), "utf8"))
        .not.toContain("Audit session video");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an explicit Reject choice through live focus when consent controls were truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-truncated-consent-"));
    try {
      const closed = vi.fn(async () => undefined);
      const auxiliaryClosed = vi.fn(async () => undefined);
      let driverCreations = 0;
      const focusNames = [
        "Before you continue to YouTube",
        "Language: English (United Kingdom)",
        "More options",
        "Reject all",
      ] as const;
      let focusIndex = 0;
      let consentResolved = false;
      const consentPresses: string[] = [];
      const consentSnapshot = (): StateSnapshot => {
        if (consentResolved) {
          return {
            capturedAt: "2026-09-14T20:00:00.000Z",
            location: availableObservation("https://www.youtube.com/"),
            focusedElement: availableObservation({
              stableId: "home",
              role: "button",
              name: "Home",
            }),
            uiTree: availableObservation([{
              stableId: "home",
              role: "button",
              name: "Home",
              text: "Home",
              bounds: { x: 10, y: 10, width: 100, height: 40 },
              visible: true,
              enabled: true,
              focusable: true,
              focused: true,
              modal: false,
              selectionState: null,
              valueNow: null,
              children: [],
            }]),
          };
        }
        const focusName = focusNames[focusIndex] ?? focusNames[0];
        const focusedDialog = focusIndex === 0;
        return {
          capturedAt: "2026-09-14T20:00:00.000Z",
          location: availableObservation("https://www.youtube.com/"),
          focusedElement: availableObservation({
            stableId: focusedDialog ? "consent-dialog" : `truncated-focus-${String(focusIndex)}`,
            role: focusedDialog ? "dialog" : "button",
            name: focusName,
          }),
          // This deliberately models the real YouTube failure: the modal itself
          // survived bounded semantic capture, while its later actionable
          // descendants were omitted by the global node limit.
          uiTree: availableObservation([{
            stableId: "consent-dialog",
            role: "dialog",
            name: "Before you continue to YouTube",
            text: "Cookies and privacy choices before you continue to YouTube",
            bounds: { x: 0, y: 0, width: 640, height: 480 },
            visible: true,
            enabled: true,
            focusable: true,
            focused: focusedDialog,
            modal: true,
            selectionState: null,
            valueNow: null,
            children: [],
          }]),
        };
      };
      const operation = createNodeAuditOperation({
        createDriver: () => {
          const close = driverCreations === 0 ? closed : auxiliaryClosed;
          driverCreations += 1;
          return ({
          launch: async () => undefined,
          capabilities: async () => new Set(["remote-input", "ui-tree"]),
          reset: async () => {
            focusIndex = consentResolved ? focusIndex : 0;
          },
          snapshot: async () => consentSnapshot(),
          press: async (key: ActionResult["key"]) => {
            if (consentResolved) {
              return {
                key,
                outcome: "unsupported" as const,
                timing: { inputSentAtMs: consentPresses.length + 1 },
                postActionSnapshot: consentSnapshot(),
              };
            }
            if (!consentResolved) consentPresses.push(String(key));
            if (!consentResolved && String(key) === "TAB") {
              focusIndex = (focusIndex + 1) % focusNames.length;
            } else if (!consentResolved && key === "SELECT" && focusIndex === 3) {
              consentResolved = true;
            }
            return {
              key,
              outcome: "applied" as const,
              timing: { inputSentAtMs: consentPresses.length + 1 },
              postActionSnapshot: consentSnapshot(),
            };
          },
          getPerformanceProfile: () => null,
          close,
          } as unknown as PlaywrightWebDriver);
        },
      });

      const result = await operation({
        target: "https://www.youtube.com/",
        packs: ["navigation"],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
        startupDecision: "reject",
      });

      expect(result.status).not.toBe("failed");
      expect(consentResolved).toBe(true);
      expect(consentPresses.filter((key) => key === "SELECT")).toHaveLength(1);
      expect(consentPresses.filter((key) => key === "TAB").length).toBeGreaterThanOrEqual(3);
      const reportText = await readFile(join(root, "bundle", "report.json"), "utf8");
      expect(reportText).not.toContain("startup policy.actions must contain at least one remote key");
      const report = JSON.parse(reportText) as { readonly artifacts: readonly { readonly id: string; readonly path?: string }[] };
      expect(report.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "run:navigation-graph-json", path: "navigation-graph.json" }),
        expect.objectContaining({ id: "run:navigation-graph-markdown", path: "navigation-graph.md" }),
      ]));
      expect(await readFile(join(root, "bundle", "navigation-graph.json"), "utf8"))
        .toContain("tvdoctor.navigation-focus-graph/v2");
      expect(await readFile(join(root, "bundle", "navigation-graph.md"), "utf8"))
        .toContain("# TVDoctor Navigation Graph");
      expect(result.details.join("\n")).toContain("navigation-graph.json");
      expect(result.details.join("\n")).toContain("navigation-graph.md");
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches only the caller-selected consent action and never infers SELECT from unknown focus", () => {
    const control = (name: string, focused = false) => ({
      stableId: name.toLowerCase().replace(/\s+/gu, "-"),
      role: "button",
      name,
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      enabled: true,
      focused,
    });

    expect(preferredStartupControl("reject", "consent-wall", [control("Manage preferences")])).toBeNull();
    expect(preferredStartupControl("accept", "consent-wall", [control("Continue")])).toBeNull();
    expect(preferredStartupControl("accept", "login", [control("Accept all")])).toBeNull();

    const reject = control("Reject all");
    expect(startupActivationSequence([reject], reject)).toEqual([]);
  });

  it("bounds live consent focus probing without ever selecting an unresolved control", async () => {
    let focusIndex = 0;
    const pressed: string[] = [];
    const liveSnapshot = (): StateSnapshot => ({
      capturedAt: "2026-09-14T20:00:00.000Z",
      location: availableObservation("https://www.youtube.com/"),
      focusedElement: availableObservation({
        stableId: `focus-${String(focusIndex)}`,
        role: "button",
        name: `Unrelated control ${String(focusIndex)}`,
      }),
      uiTree: availableObservation([]),
    });
    const driver = {
      snapshot: async () => liveSnapshot(),
      press: async (key: ActionResult["key"]): Promise<ActionResult> => {
        pressed.push(String(key));
        focusIndex += 1;
        return {
          key,
          outcome: "applied",
          timing: { inputSentAtMs: focusIndex },
          postActionSnapshot: liveSnapshot(),
        };
      },
      capabilities: async () => new Set(),
    } as unknown as PlaywrightWebDriver;

    const actions = await resolveStartupDecisionThroughFocus(
      driver,
      "reject",
      "consent-wall",
      liveSnapshot(),
    );

    expect(actions).toBeNull();
    expect(pressed).toHaveLength(63);
    expect(pressed.every((key) => key === "TAB")).toBe(true);
  });

  it("stops live consent focus probing when focus cycles", async () => {
    const names = ["Language", "More options"] as const;
    let focusIndex = 0;
    const pressed: string[] = [];
    const liveSnapshot = (): StateSnapshot => ({
      capturedAt: "2026-09-14T20:00:00.000Z",
      location: availableObservation("https://www.youtube.com/"),
      focusedElement: availableObservation({
        stableId: `focus-${String(focusIndex)}`,
        role: "button",
        name: names[focusIndex] ?? names[0],
      }),
      uiTree: availableObservation([]),
    });
    const driver = {
      snapshot: async () => liveSnapshot(),
      press: async (key: ActionResult["key"]): Promise<ActionResult> => {
        pressed.push(String(key));
        focusIndex = (focusIndex + 1) % names.length;
        return {
          key,
          outcome: "applied",
          timing: { inputSentAtMs: pressed.length },
          postActionSnapshot: liveSnapshot(),
        };
      },
      capabilities: async () => new Set(),
    } as unknown as PlaywrightWebDriver;

    const actions = await resolveStartupDecisionThroughFocus(
      driver,
      "accept",
      "consent-wall",
      liveSnapshot(),
    );

    expect(actions).toBeNull();
    expect(pressed).toEqual(["TAB", "TAB"]);
  });

  it("reuses one evidence browser process while launching a fresh context for each issue", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-pool-"));
    try {
      const store = await createArtifactStore(root);
      let phase = 0;
      const launch = vi.fn(async () => { phase = 0; });
      const close = vi.fn(async () => undefined);
      const driver = {
        launch,
        async press(key: ActionResult["key"]): Promise<ActionResult> {
          phase = 1;
          return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
        },
        async snapshot() {
          return snapshot(phase === 0 ? "source-target" : "observed-target");
        },
        getPage() {
          return { screenshot: async () => Uint8Array.from([1, 2, 3]) };
        },
        async getLogs() { return []; },
        close,
      } as unknown as PlaywrightWebDriver;
      const createDriver = vi.fn(() => driver);

      const results = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        [
          issue("TVDOCTOR-NAV-POOL00000000000000000001"),
          issue("TVDOCTOR-NAV-POOL00000000000000000002"),
        ],
        createDriver,
      );

      expect(results.every((entry) => !entry.failed)).toBe(true);
      expect(createDriver).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps semantic issue evidence but never calls or persists screenshots when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-no-screenshots-"));
    try {
      const store = await createArtifactStore(root);
      let phase = 0;
      const screenshot = vi.fn(async () => Uint8Array.from([1, 2, 3]));
      const driver = {
        launch: async () => { phase = 0; },
        async press(key: ActionResult["key"]): Promise<ActionResult> {
          phase = 1;
          return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
        },
        async snapshot() {
          return snapshot(phase === 0 ? "source-target" : "observed-target");
        },
        getPage() { return { screenshot }; },
        async getLogs() { return []; },
        async close() { return undefined; },
      } as unknown as PlaywrightWebDriver;

      const result = await captureIssue(
        store,
        "https://example.test/app",
        PRODUCTS,
        issue(),
        () => driver,
        undefined,
        false,
      );

      expect(result.failed).toBe(false);
      expect(screenshot).not.toHaveBeenCalled();
      expect(result.artifacts.find((entry) => entry.id.endsWith(":before-screenshot")))
        .toMatchObject({ status: "unavailable", reason: expect.stringContaining("--no-screenshots") });
      expect(result.artifacts.find((entry) => entry.id.endsWith(":after-screenshot")))
        .toMatchObject({ status: "unavailable", reason: expect.stringContaining("--no-screenshots") });
      expect((await allFiles(root)).some((path) => path.endsWith(".png"))).toBe(false);
      expect(result.artifacts.find((entry) => entry.id.endsWith(":transition"))?.status).toBe("available");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts snapshot route identity from issue evidence in strict origin mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-origin-evidence-"));
    try {
      const store = await createArtifactStore(root);
      let phase = 0;
      const privateTarget = "https://example.test/private/route?session=ROUTE_SECRET#fragment";
      const driver = {
        launch: async () => { phase = 0; },
        async press(key: ActionResult["key"]): Promise<ActionResult> {
          phase = 1;
          return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
        },
        async snapshot() {
          return {
            ...snapshot(phase === 0 ? "source-target" : "observed-target"),
            location: availableObservation(privateTarget),
          };
        },
        getPage() { return { screenshot: async () => Uint8Array.from([1, 2, 3]) }; },
        async getLogs() { return []; },
        async close() { return undefined; },
      } as unknown as PlaywrightWebDriver;

      const result = await captureIssue(
        store,
        privateTarget,
        PRODUCTS,
        issue(),
        () => driver,
        undefined,
        false,
        "origin",
      );

      expect(result.failed).toBe(false);
      const excerpt = await readFile(
        join(root, "evidence", issue().id, "ui-excerpt.json"),
        "utf8",
      );
      expect(excerpt).toContain("https://example.test");
      expect(excerpt).not.toContain("/private/route");
      expect(excerpt).not.toContain("ROUTE_SECRET");
      expect(excerpt).not.toContain("#fragment");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reused and non-directory output destinations before driver construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-output-preflight-"));
    try {
      const existingDirectory = join(root, "existing");
      const filePath = join(root, "file");
      await createArtifactStore(existingDirectory);
      await writeFile(filePath, "not a directory", "utf8");
      let constructions = 0;
      const operation = createNodeAuditOperation({
        createDriver() {
          constructions += 1;
          throw new Error("driver must not be constructed");
        },
      });
      const request = {
        target: "https://example.test/app",
        packs: ["navigation" as const],
        mode: "quick" as const,
        outputPath: existingDirectory,
        searchQuery: "N",
      };
      await expect(operation(request)).rejects.toMatchObject({ code: "EEXIST" });
      await expect(operation({ ...request, outputPath: join(filePath, "child") })).rejects.toBeTruthy();
      expect(constructions).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts secret sentinels from every text file in a complete bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-bundle-redaction-"));
    try {
      const store = await createArtifactStore(root);
      const globalArtifacts = await writeAuditAuxiliaryArtifacts(
        store,
        {
          target: "https://example.test/app?query=QUERY_CANARY#FRAGMENT_CANARY",
          authorization: "Bearer BEARER_CANARY",
          cookie: "session=COOKIE_CANARY",
          basic: "Basic BASIC_CANARY",
          sessionToken: "SESSION_CANARY",
        },
        {
          status: "complete",
          screens: [{ key: "screen", label: "token=DOM_TOKEN_CANARY" }],
          focusTargets: [{ key: "focus", screenKey: "screen", role: "button", name: "cookie: DOM_COOKIE_CANARY" }],
          transitions: [],
          latencies: [],
        },
      );
      const report = buildTVDoctorReportV1({
        run: {
          id: "run-bundle-redaction",
          tvdoctorVersion: "0.1.0",
          mode: "quick",
          status: "completed",
          startedAt: "2026-08-24T10:00:00.000Z",
          completedAt: "2026-08-24T10:00:01.000Z",
          durationMs: 1_000,
        },
        target: {
          name: "example.test",
          platform: "web",
          location: "https://example.test/app?query=QUERY_CANARY#FRAGMENT_CANARY",
          environment: {
            authorization: "Bearer BEARER_CANARY",
            cookie: "COOKIE_CANARY",
            sessionToken: "SESSION_CANARY",
          },
        },
        coverage: {
          screenStatesDiscovered: 0,
          focusStatesDiscovered: 0,
          transitionsTested: 0,
          actionsSent: 0,
          capabilitiesObserved: [],
          packs: [{ pack: "navigation", status: "completed" }],
          budget: {
            maxActions: 1,
            maxStates: 1,
            maxDepth: 1,
            maxDurationMs: 1_000,
            maxRepetitiveItems: 1,
            exhausted: [],
          },
        },
        issues: [],
        artifacts: globalArtifacts,
        replays: [],
      });
      await writeReportBundle(store, report);

      const content = (await Promise.all(
        (await allFiles(root)).map(async (path) => await readFile(join(root, path), "utf8")),
      )).join("\n");
      for (const sentinel of [
        "QUERY_CANARY",
        "FRAGMENT_CANARY",
        "BEARER_CANARY",
        "BASIC_CANARY",
        "COOKIE_CANARY",
        "SESSION_CANARY",
        "DOM_TOKEN_CANARY",
        "DOM_COOKIE_CANARY",
      ]) {
        expect(content).not.toContain(sentinel);
      }
      expect(content).not.toMatch(/Bearer\s+(?!\[REDACTED\])/iu);
      expect(content).not.toMatch(/Basic\s+(?!\[REDACTED\])/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores origin-only target identity consistently and requires an explicit replay target", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-origin-target-"));
    try {
      const operation = createNodeAuditOperation({
        createDriver: () => ({
          launch: async () => undefined,
          capabilities: async () => new Set(["remote-input", "ui-tree"]),
          close: async () => undefined,
        } as unknown as PlaywrightWebDriver),
      });
      const target = "https://example.test/private/route?session=ROUTE_SECRET#fragment";
      const result = await operation({
        target,
        packs: [],
        mode: "quick",
        outputPath: join(root, "bundle"),
        searchQuery: "N",
        targetRedaction: "origin",
      });

      expect(result.status).toBe("completed");
      const report = JSON.parse(await readFile(join(root, "bundle", "report.json"), "utf8")) as {
        target: { location: string; environment: Record<string, string> };
      };
      expect(report.target.location).toBe("https://example.test/");
      expect(report.target.environment["replayTargetOverride"]).toBe("required");
      for (const file of ["report.json", "exports/portable-summary.md", "report.html", "stage-ledger.json"]) {
        const text = await readFile(join(root, "bundle", file), "utf8");
        expect(text).not.toContain("/private/route");
        expect(text).not.toContain("ROUTE_SECRET");
        expect(text).not.toContain("#fragment");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
