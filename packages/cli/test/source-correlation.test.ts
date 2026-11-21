import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type { TVDoctorIssue } from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  createNodeAuditOperation,
  correlateSource,
  githubWorkspaceSourceRoot,
  runCli,
  SOURCE_CORRELATION_JSON_PATH,
  SOURCE_CORRELATION_MARKDOWN_PATH,
} from "../src/index.js";

function verifiedIssue(
  id: string,
  fromElement: string,
  expectedElement: string | null,
  observedElement: string | null,
): TVDoctorIssue {
  return {
    id,
    rule: "remote.self-loop",
    title: "Remote focus did not move",
    description: "The observed transition remained on the source target.",
    severity: "high",
    confidence: "deterministic",
    pack: "navigation",
    screen: "home",
    expected: "Focus should move.",
    observed: "Focus stayed put.",
    transition: {
      fromElement,
      action: "DOWN",
      expectedElement,
      observedElement,
    },
    evidence: [{
      kind: "deterministic-failure",
      summary: "The same deterministic transition was observed.",
      source: "driver",
      artifact: null,
    }],
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

function reviewIssue(id: string, identifier: string): TVDoctorIssue {
  return {
    ...verifiedIssue(id, identifier, null, identifier),
    confidence: "heuristic",
    evidence: [{
      kind: "heuristic-warning",
      summary: "This observation needs review.",
      source: "driver",
      artifact: null,
    }],
    reproduction: {
      status: "unavailable",
      reason: "No deterministic replay was established.",
    },
  };
}

describe("source correlation", () => {
  it("correlates only exact VERIFIED/REVIEW identifiers and skips generated/vendor content", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-source-correlation-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
      await mkdir(join(root, "generated"), { recursive: true });
      await writeFile(
        join(root, "src", "App.tsx"),
        [
          'const primary = "hero-watch";',
          'const longer = "hero-watch-extra";',
          'const review = "settings-toggle";',
          'const target = "details-panel";',
          "",
        ].join("\n"),
      );
      await writeFile(join(root, "node_modules", "fixture", "index.js"), 'const id = "hero-watch";\n');
      await writeFile(join(root, "generated", "ids.ts"), 'export const id = "settings-toggle";\n');
      await writeFile(join(root, "src", "fixture.png"), 'hero-watch');

      const result = await correlateSource(root, [
        verifiedIssue("TVDOCTOR-NAV-VERIFIED000000000000000001", "hero-watch", "details-panel", "hero-watch"),
        reviewIssue("TVDOCTOR-NAV-REVIEW00000000000000000001", "settings-toggle"),
      ]);

      expect(result.status).toBe("complete");
      expect(result.scanned.skippedGeneratedOrVendor).toBeGreaterThanOrEqual(2);
      expect(result.scanned.skippedBinary).toBe(1);
      expect(result.findings.map(({ actionability }) => actionability)).toEqual(["REVIEW", "VERIFIED"]);

      const verified = result.findings.find(({ actionability }) => actionability === "VERIFIED");
      expect(verified?.identifiers.find(({ value }) => value === "hero-watch")?.matches).toEqual([
        { path: "src/App.tsx", line: 1, column: 18 },
      ]);
      expect(verified?.identifiers.find(({ value }) => value === "details-panel")?.matches).toEqual([
        { path: "src/App.tsx", line: 4, column: 17 },
      ]);

      const review = result.findings.find(({ actionability }) => actionability === "REVIEW");
      expect(review?.identifiers[0]?.matches).toEqual([
        { path: "src/App.tsx", line: 3, column: 17 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never infers a source match from a filename when the identifier text is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-source-filename-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "settings-button.ts"), "export const enabled = true;\n");

      const result = await correlateSource(root, [
        verifiedIssue("TVDOCTOR-NAV-NOFILENAME0000000000000001", "settings-button", null, "settings-button"),
      ]);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.identifiers[0]?.matches).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops at the configured match bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-source-bounded-"));
    try {
      await writeFile(root + "/source.ts", 'const a = "hero-watch";\nconst b = "hero-watch";\n');
      const result = await correlateSource(
        root,
        [verifiedIssue("TVDOCTOR-NAV-BOUNDED00000000000000001", "hero-watch", null, "hero-watch")],
        { limits: { maxMatches: 1 } },
      );

      expect(result.status).toBe("bounded");
      expect(result.boundedBy).toContain("matches");
      expect(result.findings[0]?.identifiers[0]?.matches).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces file and byte scan bounds independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-source-resource-bounds-"));
    try {
      await writeFile(join(root, "a.ts"), 'const id = "hero-watch";\n');
      await writeFile(join(root, "b.ts"), 'const id = "hero-watch";\n');
      const issue = verifiedIssue("TVDOCTOR-NAV-RESOURCEBOUND000000000001", "hero-watch", null, "hero-watch");

      const fileBounded = await correlateSource(root, [issue], { limits: { maxFiles: 1 } });
      expect(fileBounded.status).toBe("bounded");
      expect(fileBounded.boundedBy).toContain("files");
      expect(fileBounded.scanned.files).toBe(1);

      const byteBounded = await correlateSource(root, [issue], { limits: { maxTotalBytes: 1 } });
      expect(byteBounded.status).toBe("bounded");
      expect(byteBounded.boundedBy).toContain("bytes");
      expect(byteBounded.scanned.bytes).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes sanitized sidecar exports only when a source root is supplied to a web audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-source-audit-"));
    try {
      const sourceRoot = join(root, "workspace");
      await mkdir(sourceRoot);
      await writeFile(
        join(sourceRoot, "app.ts"),
        'const id = "hero-watch"; const password = "SECRET_CANARY";\n',
      );
      const createDriver = (): PlaywrightWebDriver => ({
        launch: async () => undefined,
        capabilities: async () => new Set(),
        close: async () => undefined,
      } as unknown as PlaywrightWebDriver);
      const operation = createNodeAuditOperation({ createDriver });

      const correlatedOutput = join(root, "correlated");
      await operation({
        target: "https://example.test/",
        packs: [],
        mode: "quick",
        outputPath: correlatedOutput,
        searchQuery: "N",
        sourceRoot,
      });
      const json = await readFile(join(correlatedOutput, ...SOURCE_CORRELATION_JSON_PATH.split("/")), "utf8");
      const markdown = await readFile(join(correlatedOutput, ...SOURCE_CORRELATION_MARKDOWN_PATH.split("/")), "utf8");
      expect(json).not.toContain(sourceRoot);
      expect(markdown).not.toContain(sourceRoot);
      expect(json).not.toContain("SECRET_CANARY");
      expect(markdown).not.toContain("SECRET_CANARY");

      const plainOutput = join(root, "plain");
      await operation({
        target: "https://example.test/",
        packs: [],
        mode: "quick",
        outputPath: plainOutput,
        searchQuery: "N",
      });
      await expect(readFile(join(plainOutput, ...SOURCE_CORRELATION_JSON_PATH.split("/")), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("infers GitHub workspace only from an explicit GitHub Actions absolute workspace", () => {
    const absolute = isAbsolute(process.cwd()) ? process.cwd() : join(tmpdir(), "workspace");
    expect(githubWorkspaceSourceRoot({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKSPACE: absolute,
    })).toBe(absolute);
    expect(githubWorkspaceSourceRoot({
      GITHUB_ACTIONS: "false",
      GITHUB_WORKSPACE: absolute,
    })).toBeUndefined();
    expect(githubWorkspaceSourceRoot({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKSPACE: "relative/workspace",
    })).toBeUndefined();
  });

  it("passes a trusted embedding source root through the web CI request only", async () => {
    const sourceRoot = process.cwd();
    let receivedSourceRoot: string | undefined;
    let stdout = "";
    const code = await runCli(
      ["ci", "https://example.test/", "--fail-on", "never"],
      {
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          architecture: process.arch,
        },
        io: {
          writeStdout: (text) => { stdout += text; },
          writeStderr: () => undefined,
        },
        sourceRoot,
        runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
        operations: {
          replayIssue: async () => ({ status: "fixed", details: [] }),
          testTarget: async (request) => {
            receivedSourceRoot = request.sourceRoot;
            return {
              status: "completed",
              issueCount: 0,
              highestSeverity: null,
              reportPath: null,
              details: [],
            };
          },
        },
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(receivedSourceRoot).toBe(sourceRoot);
    expect(stdout).toContain("Status: COMPLETED");
  });
});
