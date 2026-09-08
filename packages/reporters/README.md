# @tvdoctor/reporters

Deterministic, local-first report and evidence bundle generation for TVDoctor.

The package does not launch a browser or send remote input. Callers supply a
validated run model and already captured evidence. All files are generated under
an explicit output root, and every artifact reference stored in `report.json` is
a portable relative POSIX path.

```ts
import {
  buildTVDoctorReportV1,
  createArtifactStore,
  writeIssueEvidence,
  writeReportBundle,
} from "@tvdoctor/reporters";

const store = await createArtifactStore("./tvdoctor-report");
const evidence = await writeIssueEvidence(store, {
  issueId: issue.id,
  artifacts: [
    {
      slot: "transition",
      capture: { status: "available", format: "json", value: transition },
    },
    {
      slot: "replay",
      capture: { status: "available", format: "text", text: replayYaml },
    },
    {
      slot: "trace",
      capture: { status: "unavailable", reason: "Driver has no trace capability." },
    },
  ],
});

if (issue.reproduction.status !== "available") {
  throw new Error("A portable replay requires an available reproduction.");
}
const issueWithArtifacts = {
  ...issue,
  evidence: issue.evidence.map((entry) => ({
    ...entry,
    artifact: entry.kind === "deterministic-failure"
      ? evidence.pathsBySlot.transition ?? null
      : entry.artifact,
  })),
  reproduction: {
    ...issue.reproduction,
    artifact: evidence.pathsBySlot.replay ?? null,
  },
};

const report = buildTVDoctorReportV1({
  run,
  target,
  coverage,
  issues: [issueWithArtifacts],
  artifacts: evidence.descriptors,
  replays: [replay],
});

await writeReportBundle(store, report);
```

For driver-managed screenshots, reserve a generated path without using any page
text in the filename:

```ts
const location = await store.reserveIssueArtifact(issue.id, "before-screenshot", "image/png");
await driver.captureScreenshot?.(location.absolutePath);
const descriptor = await store.describeExistingIssueArtifact({
  issueId: issue.id,
  slot: "before-screenshot",
  mediaType: "image/png",
});
```

The resulting bundle contains the primary `report.html`, canonical `report.json`,
`exports/portable-summary.md`, `exports/agent-fix-tasks.md`, issue evidence, and
optional portable replay YAML files. Target
application strings are treated as untrusted data, redacted where practical,
HTML-escaped, and placed in inert Markdown data blocks.

`tvdoctor replay` executes the report's original sequence. A recorded minimized
sequence is rendered separately as a candidate and is never presented as the
executed M5 replay path. AI fix tasks are emitted only for deterministic issues
with deterministic reproduction confidence, deterministic-failure evidence,
and an embedded replay; all other findings remain explicitly review-only.
