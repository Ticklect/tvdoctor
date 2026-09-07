import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  writeReportBundle,
} from "@tvdoctor/reporters";
import {
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
            throw new Error("Authorization: Bearer CAPTURE_SECRET");
          },
          close: closed,
        } as unknown as PlaywrightWebDriver),
      );

      expect(result.failed).toBe(true);
      expect(result.replay).toBeNull();
      expect(result.issue.reproduction).toMatchObject({ status: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("CAPTURE_SECRET");
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
});
