import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPortableRelativePath,
  buildTVDoctorReportV1,
  createArtifactStore,
  writeIssueEvidence,
  writeReportBundle,
  type ArtifactStore,
  type JsonValue,
} from "../src/index.js";
import { ISSUE_ID, sampleReportInput } from "./sample.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `tvdoctor-reporters-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function materialiseSampleReport(store: ArtifactStore): Promise<ReturnType<typeof buildTVDoctorReportV1>> {
  const input = sampleReportInput();
  const transition = await store.writeIssueArtifact({
    issueId: ISSUE_ID,
    slot: "transition",
    data: "{}\n",
  });
  const replay = await store.writeIssueArtifact({
    issueId: ISSUE_ID,
    slot: "replay",
    data: "version: 1\nsteps: []\n",
  });
  return buildTVDoctorReportV1({
    ...input,
    artifacts: (input.artifacts ?? []).map((artifact) => {
      if (artifact.id === transition.id) return transition;
      if (artifact.id === replay.id) return replay;
      return artifact;
    }),
  });
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("secure artifact storage", () => {
  it("writes hashed evidence, sanitises JSON, and represents missing evidence explicitly", async () => {
    const root = await temporaryDirectory("evidence");
    const store = await createArtifactStore(root);
    const result = await writeIssueEvidence(store, {
      issueId: ISSUE_ID,
      artifacts: [
        {
          slot: "transition",
          capture: {
            status: "available",
            format: "json",
            value: {
              z: "token=TOPSECRET",
              a: "caption-font-size --DOWN--> caption-background-colour",
            },
          },
        },
        {
          slot: "before-screenshot",
          capture: { status: "unavailable", reason: "Screenshot capability unavailable." },
        },
        {
          slot: "console-log",
          capture: { status: "failed", reason: "Browser log collection failed." },
        },
        {
          slot: "replay",
          capture: {
            status: "available",
            format: "text",
            text: "version: 1\nsteps:\n  - press: DOWN\n",
          },
        },
      ],
    });

    expect(result.descriptors.map((descriptor) => descriptor.status)).toEqual([
      "unavailable",
      "available",
      "failed",
      "available",
    ]);
    const transition = result.descriptors.find((descriptor) => descriptor.kind === "transition");
    expect(transition).toMatchObject({
      status: "available",
      path: `evidence/${ISSUE_ID}/transition.json`,
      mediaType: "application/json",
    });
    if (transition?.status !== "available") throw new Error("Expected transition artifact.");
    expect(transition.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const transitionText = await readFile(join(root, ...transition.path.split("/")), "utf8");
    expect(transitionText.indexOf('"a"')).toBeLessThan(transitionText.indexOf('"z"'));
    expect(transitionText).toContain("token=[REDACTED]");
    expect(transitionText).not.toContain("TOPSECRET");
    expect(result.pathsBySlot["replay"]).toBe(`replays/${ISSUE_ID}.yaml`);
  });

  it("supports a safe driver screenshot reservation and describes the resulting file", async () => {
    const root = await temporaryDirectory("screenshot");
    const store = await createArtifactStore(root);
    const location = await store.reserveIssueArtifact(ISSUE_ID, "before-screenshot", "image/png");
    await writeFile(location.absolutePath, new Uint8Array([137, 80, 78, 71]));
    const descriptor = await store.describeExistingIssueArtifact({
      issueId: ISSUE_ID,
      slot: "before-screenshot",
      mediaType: "image/png",
    });

    expect(descriptor).toMatchObject({
      id: `${ISSUE_ID}:before-screenshot`,
      kind: "screenshot",
      status: "available",
      path: `evidence/${ISSUE_ID}/before-screenshot.png`,
      mediaType: "image/png",
      byteLength: 4,
    });
  });

  it.each([
    "../outside.json",
    "evidence/../../outside.json",
    "evidence\\outside.json",
    "/absolute/report.json",
    "C:/absolute/report.json",
    "file:report.json",
    "evidence/%2e%2e/outside.json",
    "evidence/%252e%252e/outside.json",
    "evidence/%25252e%25252e/outside.json",
    "file%3Areport.json",
    "evidence//outside.json",
    "evidence/file:stream",
    "evidence/bad*.json",
    "evidence/bad?.json",
    "evidence/bad<name>.json",
    "evidence/bad|name.json",
    "evidence/bad\"name.json",
    "evidence/NUL.json",
    "evidence/con.txt",
    "evidence/COM1/output.json",
    "evidence/trailing.",
    "evidence/trailing ",
    "evidence/%254e%2555%254c.json",
  ])("rejects unsafe portable reference %s", (reference) => {
    expect(() => assertPortableRelativePath(reference)).toThrow();
  });

  it.each([
    "unsafe:id",
    "CON",
    "nul.txt",
    "COM1",
    "LPT9.log",
    "trailing.",
  ])("rejects a non-portable generated issue segment %s", async (issueId) => {
    const root = await temporaryDirectory("identifier");
    const store = await createArtifactStore(root);
    expect(() => store.issueArtifactLocation(issueId, "transition")).toThrow("portable identifier");
  });

  it("rejects prototype-sensitive evidence keys without mutating object prototypes", async () => {
    const root = await temporaryDirectory("prototype");
    const store = await createArtifactStore(root);
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}') as JsonValue;
    await expect(writeIssueEvidence(store, {
      issueId: ISSUE_ID,
      artifacts: [{
        slot: "transition",
        capture: { status: "available", format: "json", value: hostile },
      }],
    })).rejects.toThrow("prototype-sensitive");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("redacts sensitive values by key at every evidence depth", async () => {
    const root = await temporaryDirectory("secret-redaction");
    const store = await createArtifactStore(root);
    await writeIssueEvidence(store, {
      issueId: ISSUE_ID,
      artifacts: [{
        slot: "transition",
        capture: {
          status: "available",
          format: "json",
          value: {
            authorization: "abc123",
            cookie: "sessionid=TOPSECRET",
            password: "hunter2",
            api_key: "sk-TOPSECRET",
            safe: "retained",
            nested: { sessionToken: "TOPSECRET", result: "applied" },
          },
        },
      }],
    });
    const content = await readFile(
      join(root, "evidence", ISSUE_ID, "transition.json"),
      "utf8",
    );
    expect(content).not.toMatch(/abc123|TOPSECRET|hunter2|sk-/u);
    expect(content).toContain('"authorization": "[REDACTED]"');
    expect(content).toContain('"sessionToken": "[REDACTED]"');
    expect(content).toContain('"safe": "retained"');
    expect(content).toContain('"result": "applied"');
  });

  it("rejects caller paths, page-derived identifiers, symlink escapes, and duplicate writes", async () => {
    const root = await temporaryDirectory("containment");
    const outside = await temporaryDirectory("outside");
    const store = await createArtifactStore(root);
    await expect(store.writeBundleFile("../outside.txt", "nope")).rejects.toThrow();
    expect(() => store.issueArtifactLocation("../../page-title", "transition")).toThrow();

    await symlink(outside, join(root, "evidence"), process.platform === "win32" ? "junction" : "dir");
    await expect(store.writeIssueArtifact({
      issueId: ISSUE_ID,
      slot: "transition",
      data: "{}\n",
    })).rejects.toThrow("symbolic link or junction");
    await expect(lstat(join(outside, ISSUE_ID))).rejects.toMatchObject({ code: "ENOENT" });

    await rm(join(root, "evidence"), { force: true });
    const cleanStore = await createArtifactStore(root);
    await cleanStore.writeIssueArtifact({ issueId: ISSUE_ID, slot: "transition", data: "first" });
    await expect(cleanStore.writeIssueArtifact({
      issueId: ISSUE_ID,
      slot: "transition",
      data: "second",
    })).rejects.toThrow("already exists");
    expect(await readFile(join(root, "evidence", ISSUE_ID, "transition.json"), "utf8")).toBe("first");
  });

  it("rejects a symbolic-link or junction output root", async () => {
    const parent = await temporaryDirectory("root-link-parent");
    const outside = await temporaryDirectory("root-link-target");
    const linkedRoot = join(parent, "linked-root");
    await symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(createArtifactStore(linkedRoot)).rejects.toThrow("not a symbolic link or junction");
  });

  it("writes all four report formats and leaves no temporary files", async () => {
    const root = await temporaryDirectory("bundle");
    const store = await createArtifactStore(root);
    const report = await materialiseSampleReport(store);
    const bundle = await writeReportBundle(store, report);

    expect(bundle.reportJson.relativePath).toBe("report.json");
    expect(bundle.reportHtml.relativePath).toBe("report.html");
    expect(bundle.reportMarkdown.relativePath).toBe("exports/portable-summary.md");
    expect(bundle.aiReportMarkdown.relativePath).toBe("exports/agent-fix-tasks.md");
    for (const output of Object.values(bundle)) {
      expect(output.byteLength).toBeGreaterThan(0);
      expect(output.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(await readFile(output.absolutePath, "utf8")).not.toHaveLength(0);
    }
    expect(await readFile(bundle.reportMarkdown.absolutePath, "utf8")).toContain("](../evidence/");
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    const parsed = JSON.parse(await readFile(bundle.reportJson.absolutePath, "utf8")) as { schemaVersion: string };
    expect(parsed.schemaVersion).toBe("tvdoctor.report/v1");
  });

  it("publishes non-overwrite files with atomic no-clobber semantics", async () => {
    const root = await temporaryDirectory("concurrent-no-clobber");
    const first = await createArtifactStore(root);
    const second = await createArtifactStore(root);
    const outcomes = await Promise.allSettled([
      first.writeBundleFile("race.txt", "first"),
      second.writeBundleFile("race.txt", "second"),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(["first", "second"]).toContain(await readFile(join(root, "race.txt"), "utf8"));
  });

  it("removes a stale completeness marker before an overwrite can fail", async () => {
    const root = await temporaryDirectory("bundle-overwrite-failure");
    const store = await createArtifactStore(root, { overwrite: true });
    const report = await materialiseSampleReport(store);
    await writeReportBundle(store, report);

    await rm(join(root, "report.html"));
    await mkdir(join(root, "report.html"));
    await expect(writeReportBundle(store, report)).rejects.toThrow("not a regular file");
    await expect(lstat(join(root, "report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts direct and post-build report inputs at the bundle boundary without mutating them", async () => {
    const reports = [
      {
        label: "mutated",
        sentinel: "MUTATED_BUNDLE_SENTINEL",
      },
      {
        label: "direct",
        sentinel: "DIRECT_BUNDLE_SENTINEL",
      },
    ];

    for (const candidate of reports) {
      const root = await temporaryDirectory(`bundle-${candidate.label}`);
      const store = await createArtifactStore(root);
      const base = await materialiseSampleReport(store);
      const report = candidate.label === "mutated"
        ? base
        : {
            ...base,
            target: {
              ...base.target,
              environment: { ...base.target.environment, AUTHORIZATION: candidate.sentinel },
            },
            issues: base.issues.map((issue, issueIndex) => ({
              ...issue,
              evidence: issue.evidence.map((evidence, evidenceIndex) => ({
                ...evidence,
                source: issueIndex === 0 && evidenceIndex === 0
                  ? JSON.stringify({ outer: { sessionToken: candidate.sentinel } })
                  : evidence.source,
              })),
            })),
          };
      if (candidate.label === "mutated") {
        (report.target.environment as Record<string, string>)["SESSION_TOKEN"] = candidate.sentinel;
        const evidence = report.issues[0]?.evidence[0] as { summary: string } | undefined;
        if (evidence === undefined) throw new Error("Expected sample evidence.");
        evidence.summary = JSON.stringify({ nested: { apiKey: candidate.sentinel } });
      }
      const bundle = await writeReportBundle(store, report);
      for (const output of Object.values(bundle)) {
        const content = await readFile(output.absolutePath, "utf8");
        expect(content).not.toContain(candidate.sentinel);
        expect(content).toContain("[REDACTED]");
      }
      expect(JSON.stringify(report)).toContain(candidate.sentinel);
    }
  });

  it("rejects missing and mutated available artifacts before writing report files", async () => {
    const missingRoot = await temporaryDirectory("bundle-missing");
    const missingStore = await createArtifactStore(missingRoot);
    const missingReport = buildTVDoctorReportV1(sampleReportInput());
    await expect(writeReportBundle(missingStore, missingReport)).rejects.toThrow("is missing");
    expect(await readdir(missingRoot)).toEqual([]);

    const mutatedRoot = await temporaryDirectory("bundle-mutated-artifact");
    const mutatedStore = await createArtifactStore(mutatedRoot);
    const mutatedReport = await materialiseSampleReport(mutatedStore);
    await writeFile(join(mutatedRoot, "evidence", ISSUE_ID, "transition.json"), "[]\n");
    await expect(writeReportBundle(mutatedStore, mutatedReport)).rejects.toThrow(/byte length|SHA-256/u);
    expect((await readdir(mutatedRoot)).some((name) => name.startsWith("report."))).toBe(false);
  });
});
