# Scan, fix, and verify with TVDoctor MCP

Connect TVDoctor to your coding agent to investigate bugs in a running web app.
TVDoctor maps the UI, records observed failures, and independently retests supported
fixes. Your agent reads that evidence, edits your application, and runs its normal
tests. TVDoctor runs locally over stdio with no TVDoctor account, API key, or cloud storage.

If your client exposes MCP prompts, select `tvdoctor_repair_workflow`. It gives
the agent the scan, evidence, code repair, and independent verification steps.
The same workflow is in the server's initialization instructions for clients
that expose tools alone.

## Connect

For the current source checkout, install dependencies, build the packages, and
install the matching Chromium runtime once:

```sh
npm ci
npm run build
npm run tvdoctor -- setup
```

The server can then be started with `npm run mcp` from the repository root.
For an MCP host configuration, run the compiled `mcp-bin.js` through Node
22.13+ or 24. After `npm run build:packages`, a generic MCP client configuration
looks like:

```json
{
  "mcpServers": {
    "tvdoctor": {
      "command": "node",
      "args": ["C:/absolute/path/to/tv-docter/packages/cli/dist/mcp-bin.js"]
    }
  }
}
```

Change the argument to the actual absolute location of the compiled
`mcp-bin.js`. The main TVDoctor CLI and MCP server use the same local Chromium
runtime; install the supported Playwright browser first with `tvdoctor setup`
if Chromium is missing. The package declares a `tvdoctor-mcp` binary for a
future npm release, but **TVDoctor is not yet published on npm**. After
publication, the intended host command is
`npx --yes --package=tvdoctor tvdoctor-mcp`; until then, use the compiled local
path above.

### Coding-agent clients (source checkout)

These Windows examples assume a checkout at `C:/src/tvdoctor`. Substitute
your checkout's absolute path and keep the quotes if it contains spaces.

**Codex desktop, CLI, and IDE extension**

```powershell
codex mcp add tvdoctor -- node "C:/src/tvdoctor/packages/cli/dist/mcp-bin.js"
codex mcp get tvdoctor
```

These Codex clients share MCP settings on the same host. Open a new session
after registering the server so the client can discover its tools.
[Codex MCP documentation](https://developers.openai.com/codex/mcp)

**Claude Code:**

```powershell
claude mcp add --transport stdio tvdoctor -- node "C:/src/tvdoctor/packages/cli/dist/mcp-bin.js"
claude mcp get tvdoctor
```

Run the commands from the project you want to audit. To reuse this server
across projects on the same machine, add `--scope user` before `tvdoctor` in
the `claude mcp add` command. Open a Claude Code session and use `/mcp` to check
the connection.
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)

**Cursor:** put this in your project's `.cursor/mcp.json` (or your personal
`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tvdoctor": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/src/tvdoctor/packages/cli/dist/mcp-bin.js"]
    }
  }
}
```

**VS Code**

Use `.vscode/mcp.json` with a top-level `servers` object in place
of Cursor's `mcpServers`. The `tvdoctor` entry uses the same `type`, `command`
and `args` fields. Use **MCP: List Servers** to check the connection.
[VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)

For other MCP clients, use the `node` command and the same absolute
`packages/cli/dist/mcp-bin.js` argument. Check that your client lists
`tvdoctor_scan`, `tvdoctor_triage`, `tvdoctor_verify_fix` and `tvdoctor_compare`.

The server supports line-delimited UTF-8 JSON-RPC messages, the MCP stdio
transport, and Content-Length framed JSON-RPC for clients that require it.
There is no startup banner on stdout; diagnostics go to stderr. The server
responds to `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`,
and `prompts/get`. An MCP
client sends `notifications/initialized` after initialization. The initialize
response also supplies server instructions describing the recommended
scan/findings/fix/replay workflow, so compatible coding agents receive the
workflow when they connect.

To try the connection, start an authorized local app and give your agent its
URL using a prompt like this one.

> I authorize TVDoctor to scan my running app at `http://127.0.0.1:5173/`.
> Poll for the result and inspect the evidence. Fix a confirmed issue in the
> application code and run the relevant project tests. If TVDoctor supports
> independent verification for the issue, verify the fix against its original
> scan and issue IDs. Report the verification result, review leads, and untested
> coverage.

## Tools

| Tool | Purpose |
| --- | --- |
| `tvdoctor_scan` | Start a safe bounded website scan and return a `scan_id` immediately. Optional `keyboard_interactions: true` enables existing restricted Enter/Escape checks. A `journey` ID requires exact target-bound registration by the trusted host. |
| `tvdoctor_site` | Run the production static-anchor same-origin site scanner on up to three keyboard routes, optionally `explore_spa: true` for bounded, experimental SPA journey discovery. |
| `tvdoctor_responsive` | Run the production responsive browser audit at mobile, tablet and desktop widths on up to two routes. |
| `tvdoctor_site_index` | Inspect a site scan's saved route index without exposing route URLs or local paths. |
| `tvdoctor_responsive_index` | Inspect viewport observations, termination and heuristic layout findings. |
| `tvdoctor_status` | Poll `pending`, `completed`, `partial`, `failed` or `cancelled`. |
| `tvdoctor_findings` | Read issues, confidence and coverage counters from a validated report. |
| `tvdoctor_triage` | Prioritize up to 12 findings from one completed, session-owned single-page scan. Checks the sealed report before and after offline inspection and validates inspected evidence artifacts. Returns text summaries, confidence, coverage, integrity status and artifact IDs without screenshot bytes or local paths. |
| `tvdoctor_evidence` | List evidence metadata or explicitly retrieve a supported, small artifact. |
| `tvdoctor_issue_details` | Retrieve one validated issue's privacy-safe replay keypresses or checkpointed SPA journey, or responsive screenshot reference. Requires the exact `issue_id` from `tvdoctor_findings`; site page findings may also require `route_number`. |
| `tvdoctor_replay` | Low-level reproduction diagnostics for one original deterministic finding. The legacy focus-transition result is **not** always a rule-specific fix proof. Requires `authorized: true`. |
| `tvdoctor_verify_fix` | Independently retest one original supported finding, returning `FIXED`, `REPRODUCED`, or `INCONCLUSIVE`. Requires the original `scan_id`, exact `issue_id`, and `authorized: true`. |
| `tvdoctor_compare` | Compare two completed, checksum-verified, coverage-compatible web navigation scans from this MCP session. Reports new/no-longer-observed/unchanged findings, severity/confidence changes, focus and transition regressions; missing evidence fails closed. |
| `tvdoctor_cancel` | Request cancellation of the active scan by ID. |

## Coding-agent workflow

TVDoctor is designed to act as an independent QA tool for a coding agent. The
agent starts the application using the project's normal development command,
then uses the MCP tools to inspect the running application:

1. Call `tvdoctor_scan` with the local application URL and `authorized: true`.
   The default scan uses bounded Tab/Shift+Tab keyboard navigation. Set
   `keyboard_interactions: true` to additionally attempt policy-checked
   Enter/Escape interactions where the current focused control is safe.
   This opt-in requires keyboard input (`input: "keyboard"`, also the MCP
   default). Omit the option for Tab/Shift+Tab-only scanning; `false`, strings,
   and remote input with the opt-in are rejected. All existing action budgets,
   state checks, and restricted interaction policies remain in effect.
   A trusted host may provision an exact target-bound journey ID. The agent
   supplies `journey: "login"` with `authorized: true`; the `journey` value is
   **never a file path**. Repeat the same ID in `tvdoctor_replay` and
   `tvdoctor_verify_fix` for findings from that original scan.
2. Poll `tvdoctor_status` until the result is no longer `pending`.
3. Call `tvdoctor_findings` for observed issues and coverage. For a completed
   single-page scan, also call `tvdoctor_triage` using only the
   returned `scan_id`. It prioritizes `VERIFIED`, `REVIEW`, and `UNTESTED`
   original findings and reports when findings or evidence checks were bounded.
   For additional issues call `tvdoctor_findings`, then `tvdoctor_issue_details`
   for individual reproductions and `tvdoctor_evidence` for explicitly
   acknowledged screenshots. A `VERIFIED` triage finding means the **original
   scan** held deterministic failure evidence; its `independently_fixed` is
   always `null`, and its stored replay has `freshlyVerified: false`.
4. Use the issue details and reproduction to locate the relevant application code.
   Fix a confirmed problem and run the app's usual tests. Keep the same target
   URL and MCP session so TVDoctor can still access the original evidence.
5. Call `tvdoctor_verify_fix` with the **original** `scan_id`, exact `issue_id`,
   and `authorized: true`. TVDoctor independently reloads the same target and
   runs the stored sequence against its original finding and corrected-state
   predicate. It never substitutes a fresh generic scan.
6. Treat `verification_status: "FIXED"` as verified only for that supported
   finding and its bounded conditions. `REPRODUCED` means the original defect
   persists. `INCONCLUSIVE` means no fix claim is justified.
7. Run another `tvdoctor_scan` with the **same target, input, duration, action
   budget and screenshot settings**, then call `tvdoctor_compare` with
   `baseline_scan_id` and `current_scan_id`. A finding absent from the second
   scan is a **no-longer-observed** finding, not independently proven fixed;
   use `tvdoctor_verify_fix` for that proof.

For single-page scans, `tvdoctor_findings` reports exhausted budgets in
`termination`. `coverage.navigation` gives the explorer's `reason`, `complete`,
`pending_states`, `deferred_states`, `remaining_frontier_entries`, and
`remaining_candidate_actions` when that summary is available. A `null` summary
or remaining-work count means the engine did not supply it. Navigation may
finish while the overall report remains partial, so check `report_status` and
all relevant pack statuses before describing coverage.

`tvdoctor_triage` accepts exactly `{ "scan_id": "<session scan ID>" }`. It
does not accept report paths, scan settings, or arbitrary filesystem locations.
It returns an error for pending, partial, failed, site or responsive scans,
unsealed or modified reports, invalid report links or corrupted inspected
artifacts. Its integrity scope is the *returned findings*: omitted findings or
artifacts not checked by the bounded offline inspector remain unverified. The
tool does not run a browser, execute a saved replay, or independently confirm
that a fix works. Its short text summaries can contain details from the
authorized application; avoid forwarding them outside the trusted MCP client.

`tvdoctor_verify_fix` has independent corrected-state oracles for
**source-proven** `keyboard.modal-focus-escape`, **source-proven**
`keyboard.modal-tab-focus-loss`, and **source-proven**
`keyboard.modal-open-focus-not-transferred`, strictly in a completed single-page
**keyboard** scan with a unique deterministic reload-based replay of at most
250 actions. The modal must remain uniquely identifiable and visible, and
the complete UI tree must show focus inside it at the original checkpoint.
For modal focus escape, an outside focus reproduces the defect; for modal Tab
focus loss, a stable absence of focus reproduces it. Both require positive
post-Tab focus containment in the same modal to prove a fix. Modal-focus-escape
is eligible only when the original issue contains a `deterministic-failure`
source record and its *correlated compiled plan* has exactly
`keyboardOracle: "modal-focus-escape"`, an original `TAB`/`SHIFT_TAB`
transition with observable checkpoint and escaped-focus targets, and explicit
modal predicates: visible/active/contained focus at checkpoint, focus outside
the **same** retained modal at reproduction, and positive contained focus in
that same modal at correction. Both reproduced and fixed predicates require
same original modal identity and location. Merely labeling an issue
`keyboard.modal-focus-escape` and attaching a generic focus replay cannot
justify `FIXED`. `tvdoctor_issue_details` also refuses to advertise independent
verification or supported Playwright assertion without this source proof.
The Tab-loss rule
is permitted only with original deterministic failure evidence, a null
observed focus, and the compiler's exact `keyboardOracle:
"modal-tab-focus-loss"` plus distinct reproduced/fixed predicates and retained
modal identity/location. Changed/replaced modal, ambiguous or incomplete tree,
transient focus, invalid source evidence, unsupported rule, or stale report
produces `INCONCLUSIVE`. **The new rule is implemented and core-tested, but a
live scanner finding for it has not yet been demonstrated**; these MCP tests
use intentionally constructed source-shaped reports and do not establish live
discovery. The earlier modal-focus-escape browser fixture remains real evidence
for that rule alone.

For `keyboard.modal-open-focus-not-transferred` the original action must be
`SELECT`, not an arbitrary new agent-selected action. The original report must
contain a deterministic failure and exactly one trusted `verified-fact` witness
from `tvdoctor.keyboard.modal-open/v1`, identifying the original button opener
and newly opened `dialog`/`alertdialog` by matching stable IDs, semantic roles
and accessible names. The transition must record opener → modal while focus
actually stayed on that same opener. TVDoctor recompiles the original replay
with its original issue and demands
`keyboardOracle: "modal-open-focus-not-transferred"` plus the exact compiled
`keyboardModalOpenIdentity` matching both sides of that transition. The core
oracle checks the pre-action opener/modal state and independent reproduced vs.
fixed focus transfer while retaining source semantic identity, rather than a
focus label alone. A fabricated, duplicated or changed witness, changed modal
identity, unsafe action, missing observation or ambiguous UI is not proof and
must yield `INCONCLUSIVE`. The production explorer has independently been
observed detecting this rule in Chromium; that observation alone is **not** a
complete end-to-end repaired/failing fix-verification demonstration. The MCP
tests for this gate use source-shaped fixture reports and injected replay status.

`tvdoctor_replay` remains available for broader deterministic **transition
diagnostics** but its legacy `fixed` status may only mean the saved target
focus label matched. Do not promote that result into rule-specific fix proof.
Both tools require a completed single-page web scan with a unique deterministic
reload-based replay of at most 250 actions.
It does not replay SPA journey leads, responsive geometry findings or partial
scans. A scan with a secret-bearing custom journey requires that journey's
original trusted host registration, matching ID and sealed report fingerprint.
The tool repeats
only the sequence stored in the validated report; it does not accept arbitrary
keypresses, selectors, scripts, target URLs or filesystem paths. It requires a
separate `authorized: true` confirmation because replay reloads the application
and sends browser input. Private target paths and dynamic page text stay out of
the MCP response.

### Trusted stateful journey registration

The default stdio server registers **no** journeys. MCP callers cannot supply
`--journey`, arbitrary filenames, JSON documents, or filesystem paths. A
trusted programmatic MCP host can explicitly configure an ID-to-file mapping:

```ts
new TvDoctorMcpServer({
  journeys: {
    login: {
      path: "C:/private/setup/login.json",
      target: "http://127.0.0.1:5173/",
      sha256: "<SHA-256 of the exact raw JSON file bytes>",
    },
  },
});
```

The same `journeys` option is accepted by `serveMcpStdio`. Host-configured
paths must be absolute, regular, symlink-free files and each entry is bound
to the **exact** credential-free launch URL and a real lowercase 64-character
SHA-256 digest of the original file bytes. This host-approved digest must
match before any journey actions run; the journey parser's separate canonical
`journeyConfigSha256` must match the original scan report. The host, not the agent, picks
the file and provides any `TVDOCTOR_JOURNEY_*` environment secrets. Configured
journeys may press controls, navigate routes and type environment secrets;
review and authorize both the target and journey content before enabling them.

A scan selecting a journey validates the existing bounded journey schema,
copies the file bytes to its private session directory, pins digest and size,
and requires the completed report's `journeyConfigSha256` to match. Replay
and supported fix verification require the same ID, revalidate the original
copy, and give the engine an additional private replay copy. Changes or
fingerprint mismatches fail closed. Stateful journeys do **not** add new
independent `FIXED` oracles: only the three explicitly supported,
compiler-backed modal keyboard rules are eligible for independent verdicts;
other rules and heuristic findings remain unproved, and
no live Tab-loss detection claim is made. The default CLI/MCP stdio launch is
unchanged, with journeys disabled until a trusted host registers them.

An agent instruction can make this workflow part of normal development:

> For UI-related changes, run the relevant local application and use TVDoctor
> to explore its navigation. Inspect every finding and its evidence. Fix
> deterministic findings when appropriate, then call `tvdoctor_verify_fix`
> for rule-supported original findings. Run a matching second scan and call
> `tvdoctor_compare` to check regressions. Never treat disappearance from a
> repeat scan, partial coverage, review-only leads or inconclusive verification
> as an independently proven fix. Report what was explored and what
> remains unverified.

Example agent call to `tvdoctor_scan`:

```json
{
  "url": "http://127.0.0.1:5173/",
  "authorized": true,
  "input": "keyboard",
  "max_duration_ms": 30000,
  "max_actions": 500
}
```

Wait for `tvdoctor_status` to stop reporting `pending`, then call
`tvdoctor_findings` and `tvdoctor_evidence` with the returned `scan_id`.
Call `tvdoctor_issue_details` with `{"scan_id":"SCAN_ID","issue_id":"ISSUE_ID"}`
to inspect one finding's reproduction path. For deterministic keyboard issues,
it supplies the validated reload-based keypresses including the final assertion
action, provided the saved report is complete and replay validates. It never
returns source selectors, private DOM text or the target's route. A coding agent
must not infer that a redacted MCP report can be exported to a standalone test:
`export-test` requires the original locally saved *unredacted* report and
explicitly authorized target URL. For SPA issues, the tool returns bounded
observed edge checkpoints and a **heuristic/review-only** classification;
responsive findings provide review geometry and an owned screenshot artifact ID.
For `spa.history-back-stale-view` and
`spa.history-back-interrupted-stale-view`, issue details contain `history_back`
with `route_returned`, `heading_restored`, `observed_history_steps`,
`settled_samples` and `independent_replay_verified: false`. The
separate `forward_setup_steps` explain how the scanner reached the
forward state; `replay_steps` is empty. These are real observed browser Back
metadata but **not** a deterministic regression replay or Playwright export.
The first rule is a **single** browser Back observation with
`observed_history_steps: 1`. The new experimental, unreleased interrupted
rule requires a separately witnessed **rapid pair of actual Chromium Backs**,
`observed_history_steps: 2`, and contains `intermediate_state_id` and
`intermediate_route_identity` under `history_back`. The local SPA JSON
also records `historyBack.interruptedBack` with
`intermediateStateId`, `finalForwardStateId`, and
`intermediateRouteIdentity`, and evidence type
`observed-dom-after-interrupted-history-back`.
Only **one eligible nested two-Back path** can be physically probed per
run. Other eligible or incomplete challenges are deferred as
`history-back-interruption-unchecked` or an applicable budget/cancellation
reason, keeping coverage partial rather than silently declaring a clean
scan. This is independent of the
two-single-Back ceiling: excess single-Back paths become
`history-back-limit`. For manual Chromium
reproduction, see [Windows SPA first run](windows-spa-first-run.md).
When a post-Back PNG was actually captured, `history_back` may additionally
include `screenshot_artifact_id: "spa:back-edge-NNN"` for a single Back
or `"spa:back-interrupted-edge-NNN"` for the rapid two-Back rule; a
null ID means capture is unavailable. The artifact is bound to the exact observed edge,
relative file path, recorded byte length and SHA-256. Request its metadata
through `tvdoctor_evidence` and opt into its content with
`include_content: true` and `acknowledge_sensitive: true`. Only PNGs at
most 1 MiB can be transferred; larger images remain local. An image is a
post-Back witness, **never** an independently verified replay.
Only `tvdoctor_evidence` can return screenshot contents after the explicit
sensitive-content acknowledgment.
When a finding is visible only after nested scrolling, its owned screenshot may
use the reserved `responsive:mobile:page-51`-style artifact ID instead of the
unscrolled route screenshot. The ID is validated against the finding's exact
route/viewport slot; an unrelated page's screenshot is not an acceptable match.
If a scan is partial, its issue list covers only the explored states. Do not
interpret a lack of issues as proof of complete coverage. The finding entries
include stable issue ID, rule, severity, confidence and reproducibility;
potentially private page copy is omitted.

For a bounded multi-route scan, call `tvdoctor_site` with
`{"url":"http://127.0.0.1:5173/","authorized":true,"max_pages":2}`.
This runs the existing `tvdoctor site` command with quick keyboard
navigation and the production static HTML anchor policy. It does not submit
forms or follow unsafe mutation-looking links. The maximum is three pages.
Use `tvdoctor_status`, then `tvdoctor_site_index` to view the route
count, numbered route statuses, pending frontier and termination reasons.
The index deliberately hides route URLs and server file paths. Site findings
can be listed using `tvdoctor_findings`.

For an authorized disposable SPA test, also pass `"explore_spa":true` to
`tvdoctor_site`. This is an opt-in, separately bounded Chromium pass with
reversible menu/dialog and same-document route exploration. `tvdoctor_site_index`
then includes observed states, transitions, deferred candidates and heuristic
review leads; `tvdoctor_findings` includes only **validated**, opaque SPA
review leads with checkpoint descriptions if a saved graph is available.
These are not deterministic accessibility bugs or executable arbitrary clicks.

Optional SPA browser Back PNG capture is enabled by default when
`explore_spa: true`. To prevent saving these private images, call
`tvdoctor_site` with:

```json
{
  "url": "http://127.0.0.1:5173/",
  "authorized": true,
  "max_pages": 2,
  "explore_spa": true,
  "spa_screenshots": false
}
```

The `spa_screenshots` parameter may only be supplied alongside
`explore_spa: true`; otherwise the tool rejects the call. This maps to
the CLI's `site --spa --no-spa-screenshots`. It disables both optional
post-Back `spa/evidence/back-edge-NNN.png` and
`spa/evidence/back-interrupted-edge-NNN.png` captures, not the scanner's
actual one- or two-Back actions, heading/state observations, findings or deferred
coverage. It does not change screenshot capture by the separate per-page
keyboard audits.
No video recording or Playwright export is provided for SPA Back leads.

For browser layout checks, call `tvdoctor_responsive` with
`{"url":"http://127.0.0.1:5173/","authorized":true,"max_pages":1}`.
This runs the existing `tvdoctor responsive` command in quick mode,
inspecting mobile (390×844), tablet (768×1024) and desktop (1280×720).
The maximum is two routes. Use `tvdoctor_responsive_index` to inspect
the viewport matrix, coverage limits and bounded findings, and
`tvdoctor_findings` for a findings-only view. All responsive findings
have heuristic confidence and **require visual review**, including severe
clipping, overlapping controls, blocked click targets and layout instability.
A scan showing
no findings proves only the tested viewport and route frontier.
The `completed` result means the bounded scan completed, not that the
website is free of layout bugs.

By default `tvdoctor_evidence` returns metadata. Retrieve an individual
available screenshot or small text artifact with:

```json
{
  "scan_id": "SCAN_ID",
  "artifact_id": "ARTIFACT_ID",
  "include_content": true,
  "acknowledge_sensitive": true
}
```

Screenshots may contain private application content even though report target
URLs are redacted. Treat returned evidence as sensitive. There is no arbitrary
file read tool; artifact IDs must belong to a validated report created in this
MCP session. Available PNGs must be 1 MiB or smaller; supported text evidence
must be 48 KiB or smaller. Larger artifacts can still be listed.
For site scans, screenshot IDs are scoped to their validated page reports;
for responsive scans they are derived from the fixed viewport screenshot
manifest. No tool returns arbitrary filesystem paths. Retrieving a screenshot
requires `include_content: true` and `acknowledge_sensitive: true`.
Owned issue-specific WebM video evidence may be listed as metadata only;
the tool never transfers video bytes. Inspect those recordings directly
in the private local report/dashboard before sharing them.

## Limits and safety

Only explicitly authorized HTTP(S) targets are permitted. URL credentials,
query strings and fragments are rejected, to prevent accidental token
retention. Reports always redact the recorded target to its origin. The server
accepts no file paths, journey files, secrets, credentials, startup actions,
browser storage state or destructive action sequences from tool callers.

Scans default to quick keyboard mode, 30 seconds of navigation exploration,
500 actions, and screenshots enabled. The caller may select remote input, a
navigation duration between 1 and 120 seconds, 1–2,000 actions, and disable
screenshots. Exploration time does not include browser setup, replay, capture
and report generation. A 5-minute overall timeout requests cancellation.
One scan runs at a time, with at most 24 scans per server session.
Site and responsive tools use the same session-wide single-scan limit and
five-minute overall cancellation request. Their per-route/viewport limits
come from the production CLI in quick mode. Site and responsive result
indexes can be inspected only for scan IDs generated within the current MCP
session. A pending or cancelled scan must not be interpreted as fully covered.

Reports are stored in a private session directory under the system temporary
directory. Report paths and private URL details are omitted from tool
responses. Reports stay on disk after the MCP connection exits so a developer
can inspect evidence locally; clean up private temporary folders using normal
system cleanup practices. The server checks that requested artifacts resolve
within their scan bundle, reject symlink escapes, validate file sizes and
verify reported checksums when available.

Cancellation is cooperative: the running scanner receives an `AbortSignal`
and may take time to finish its current browser operation and save partial
coverage. Poll `tvdoctor_status`; a cancellation request is not proof that
the browser has stopped. The MCP server intentionally does not claim full
cross-route coverage or fixed/reproduced issues on the basis of a partial scan.
