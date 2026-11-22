# Non-MCP fix verification and CI workflow

TVDoctor provides a framework-agnostic Node workflow in
`packages/cli/src/node-verify-workflow.ts`. It operates on the original
`tvdoctor.report/v1` artifact and a running, **explicitly authorized**
HTTP(S) application. It does not edit the application. The coding agent fixes
the app; TVDoctor independently retests the original finding.

Use the CLI for scripts, CI, and saved evidence outside an MCP session. To give
your coding agent the scan and verification tools directly, connect the local
server. [TVDoctor MCP setup](mcp-server.md)

## Run the complete CLI workflow

From a built source checkout, use PowerShell to capture the **original**
finding before any code change. Choose a target the user owns or has explicit
authorization to test:

```powershell
npm run build:packages
npm run tvdoctor -- setup

$url = "http://127.0.0.1:5173/modal"
$originalDir = Join-Path (Get-Location) "tvdoctor-runs/original-$(Get-Date -Format yyyyMMdd-HHmmss)"
npm run tvdoctor -- scan $url --input keyboard --mode quick --output $originalDir

# A scan may exit nonzero when it finds bugs; the report and coverage decide
# whether an independent verification is possible.
$originalReport = Join-Path $originalDir "report.json"
if (!(Test-Path -LiteralPath $originalReport)) { throw "Original report was not produced" }
$report = Get-Content -LiteralPath $originalReport -Raw | ConvertFrom-Json
if ($report.run.status -ne "completed") { throw "Original scan is incomplete" }
$matches = @($report.issues | Where-Object { $_.rule -eq "keyboard.modal-focus-escape" -and $_.confidence -eq "deterministic" })
if ($matches.Count -ne 1) { throw "Expected exactly one independently verifiable modal-focus issue" }
$originalIssueId = $matches[0].id
$originalSha = (Get-FileHash -LiteralPath $originalReport -Algorithm SHA256).Hash.ToLowerInvariant()
```

Have the **coding agent** repair the application and restart its development
server at the same URL. Do not replace or edit the original report. First
independently check the original failure:

```powershell
npm run tvdoctor -- verify-fix $originalIssueId --report $originalReport `
  --target $url --authorized --sha256 $originalSha

if ($LASTEXITCODE -ne 0) { throw "Verification failed or is inconclusive; review JSON stdout" }
```

Optionally require a second independent scan and an overall regression
comparison, reserving a new output directory:

```powershell
$freshDir = Join-Path (Get-Location) "tvdoctor-runs/recheck-$(Get-Date -Format yyyyMMdd-HHmmss)"
if (Test-Path -LiteralPath $freshDir) { throw "Choose a new scan output directory" }
npm run tvdoctor -- verify-fix $originalIssueId --report $originalReport `
  --target $url --authorized --sha256 $originalSha `
  --scan-output $freshDir --compare

if ($LASTEXITCODE -ne 0) { throw "Repeat-run comparison did not establish a clean comparable result" }
```

This optional gate is intentionally stricter: an original scan can discover
and reproducibly test a real modal escape yet retain a partial focus inventory.
Even if the corrected-state replay establishes `FIXED`, the broader comparison
must return `INCONCLUSIVE` rather than treat unobserved findings as resolved.

The actual `verify-fix` CLI uses positional `ISSUE_ID`, `--report`,
`--target`, `--authorized`, `--sha256`, `--scan-output` and `--compare`.
Additional options are `--journey` (when the original scan used one),
`--screenshots`, `--max-duration-ms` and `--max-actions`. The example
uses the same URL and run mode and no custom scan budgets to reduce the chance
of incomparable coverage. Always inspect the original report's completeness,
record the checksum before the application is changed, and ensure the new
scan directory does not already exist.

## Source API and integration

```ts
import { verifyOriginalFindingWorkflow } from "./node-verify-workflow.js";

const result = await verifyOriginalFindingWorkflow({
  authorized: true, // only after the user's explicit CLI authorization flag
  originalReportPath: "/path/to/original/report.json",
  issueId: "THE-EXACT-ORIGINAL-ISSUE-ID",
  targetOverride: "http://127.0.0.1:5173/route",
  // Recommended in CI: SHA-256 recorded when the original artifact was saved.
  expectedOriginalSha256: shaFromOriginalScan,
  // Optional: fresh audit is separate evidence, NEVER a fix oracle.
  freshScan: {
    outputPath: "/path/to/new/unique-scan-directory",
    compareToOriginal: true,
  },
});
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exitCode = result.classification === "INCONCLUSIVE" ? 3
  : result.shouldFail ? 1 : 0;
```

The source function is already connected to the `cli.ts`/`bin.ts` entrypoints.
Its source API also supports embedding the same checks in a framework-agnostic
Node CI runner. The implemented CLI command surface is:

```text
tvdoctor verify-fix EXACT_ID --report ORIGINAL/report.json \
  --target http://127.0.0.1:5173/route --authorized \
  [--sha256 SHA256] [--journey PATH] \
  [--scan-output NEW_DIRECTORY --compare]
```

The CLI emits one JSON object on stdout. Exit codes are **0** for independently
verified `FIXED` without detected new regression, **1** for `REPRODUCED`
or a regression, **2** for invalid invocation, **3** for `INCONCLUSIVE`,
and **4** for unexpected execution failure. Shell-based CI must treat every
nonzero code as failure and archive the JSON and report artifacts for review.
Do not reinterpret the result by counting issues or a clean new scan.

## Result semantics

| Classification | Meaning | CI default |
| --- | --- | --- |
| `FIXED` | Original rule-specific failure was independently replayed; corrected modal containment remained stable across repeat observations | Pass if optional scan/comparison also passed |
| `REPRODUCED` | Original deterministic modal-focus escape still reproduces | Fail |
| `INCONCLUSIVE` | Missing/inconsistent evidence, unsupported rule, unstable replay, or incomplete coverage | Fail |

The independent keyboard oracles currently implemented cover
**`keyboard.modal-focus-escape`**, **`keyboard.modal-tab-focus-loss`**, and
**`keyboard.modal-open-focus-not-transferred`**.
The first requires the original visible modal to retain focus after a
Tab/Shift+Tab action; the second requires a previously observed loss of
meaningful browser focus to be corrected by retaining focus in that modal.
Both require the same original modal, route, source control, complete tree
observations and stable confirmation. The third requires the original
safe Select action to open the exact same identified dialog from the exact
same button and to transfer focus into an enabled visible dialog descendant;
its original report must preserve a strict semantic witness for both button
and dialog. A deterministic *transition* replay
without an independently proven rule-specific corrected state is not proof of
a fix. SPA history heuristics, responsive geometry findings, inferred issues,
incomplete scans and unsupported desktop/mobile platforms cannot establish
`FIXED`.

The original report is parsed and checked for complete navigation coverage,
valid deterministic reproduction, one correlated original sequence, reload
reset, keyboard input and a compiled rule-specific modal assertion. Its byte
length and SHA-256 are checked before and after replay. The independent replay
uses a private temporary **byte-for-byte snapshot** of the initially validated
report, not the mutable original pathname, to close the check/open race. That
copy is removed after replay; failure to clean up fails closed. An optional
external checksum pin detects changes *before* this invocation, which a local
hash alone cannot detect. A replacement target must be credential-free HTTP(S)
and preserve the recorded route/query/fragment unless that route was redacted in the
original report. An override is an **operator assertion** that it is the same
application; URL checks alone cannot prove application identity.

For an authenticated application, pass the same `--journey PATH` to `check`
and `verify-fix`. The original canonical journey SHA-256 must match the report;
verification additionally captures private, byte-identical journey setup for
replay and fails closed if the original local journey changes before or during
verification. Only environment variables named `TVDOCTOR_JOURNEY_*` carry
private input values. Browser cookies/session storage are not written to the
verification result. See [stateful SPA journey syntax and limitations](stateful-journeys.md).

An optional fresh Chromium navigation scan is a *separate* evidence source.
The comparison requires complete original and new reports, equal engine/run
mode/target/environment/coverage budgets/capabilities/packs, distinct run IDs
and checksum-verified `run:inventory` artifacts containing non-empty screen
and focus observations. The semantic baseline library performs the actual
comparison. Different origins (including changed local ports), redacted
target identities, different scanning settings, missing inventories and
partial reports produce `INCONCLUSIVE` comparisons rather than artificial
resolution claims. A previously reported finding disappearing from a new
scan is **not** independently verified fixed. If the new scan still finds a
deterministic instance of the same modal-focus rule while replay claims
`FIXED`, the combined verification is `INCONCLUSIVE`.

The machine-readable result uses
`schemaVersion: "tvdoctor.verify-workflow/v1"`. It has
`classification`, `fixed`, `shouldFail`, `reason`, `original` report
integrity/provenance, `replay` status, optional `freshScan` and optional
`comparison` metrics. `comparison.noLongerObservedMeansFixed` is always
`false`.

## Validation

```powershell
npx vitest run packages/cli/test/node-verify-workflow.test.ts
npm run typecheck --workspace tvdoctor
```

Unit tests inject the existing `CliOperations` replay and scan interfaces
and exercise fail-closed behavior without editing an application. Real Chromium
end-to-end verification remains a separate integration gate; neither unit
tests nor a newly clean scan independently proves a fix.
