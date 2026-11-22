import { basename, dirname, join } from "node:path";

import {
  diagnoseEnvironment,
  doctorSucceeded,
  renderDoctorReport,
  type DiagnosticCheck,
  type RuntimeEnvironment,
} from "./diagnostics.js";

import {
  isSafeTerminalArgument,
  safeDisplayUrl,
  sanitizeTerminalText,
} from "./terminal.js";
import { defaultOutputDirectory } from "./product-output.js";
import { reconcileCiBaselineExports } from "./ci-baseline-exports.js";
import { exportPlaywrightTest } from "./playwright-test-export.js";
import { runSiteCommand, SITE_HELP_TEXT } from "./site-scan.js";
import { runProjectCheck } from "./project-check.js";
import { runProjectVerify } from "./project-verify.js";
import { runProjectAccept } from "./project-accept.js";
import { runFirstRunHandoffCli } from "./first-run-handoff.js";
import { renderAgentRepairBrief } from "./agent-repair-brief.js";
import { runQaWorkflow } from "./qa-workflow.js";
import { runQaVerify } from "./qa-verify.js";
import { runQaAccept } from "./qa-accept.js";
import { runResponsiveCommand, RESPONSIVE_HELP_TEXT } from "./responsive-command.js";
import type { StartTerminal } from "./interactive.js";
import type { VerifyWorkflowRequest, VerifyWorkflowResult } from "./node-verify-workflow.js";
import type { ReportTriage } from "./node-triage.js";
import { runGuidedStart } from "./start.js";
import type {
  AndroidBuildToolsPreflightResult,
  AndroidObserverPreflightResult,
  AndroidPreflightResult,
  AndroidScanResult,
  AndroidScanOptions,
  ApkMetadata,
} from "./android-product.js";
import { CLI_VERSION } from "./version.js";
import { PRIVACY_TEXT } from "./privacy.js";
import { REMOTE_KEYS, type RemoteKey } from "@tvdoctor/protocol";
import {
  MAX_EXPLORATION_BUDGETS,
  type ExplorationBudgets,
  type ExplorationTerminationReason,
} from "@tvdoctor/core";
import {
  CI_FAILURE_THRESHOLDS,
  issueViolatesPolicy,
  type CiFailureThreshold,
} from "@tvdoctor/reporters";

export const EXIT_CODES = {
  success: 0,
  environmentFailure: 1,
  usageError: 2,
  inconclusive: 3,
  executionError: 4,
  /** Compatibility aliases retained for callers built against M5. */
  replayInconclusive: 3,
  replayError: 4,
} as const;

export const TEST_PACK_NAMES = [
  "all",
  "navigation",
  "streaming",
  "search",
  "settings",
  "accessibility",
  "layout",
  "performance",
  "crashes",
] as const;

export type TestPackName = (typeof TEST_PACK_NAMES)[number];

export type TestRunMode = "quick" | "standard" | "deep";

export interface TestCommandRequest {
  readonly target: string;
  /** Explicit web scan keyboard traversal; absent means the existing remote navigation. */
  readonly inputMode?: "keyboard";
  /** Opt-in safe keyboard activation/escape exploration, gated by the web action policy. */
  readonly keyboardInteractions?: boolean;
  /** Opt-in restricted same-origin document-link navigation; never default. */
  readonly safeLinkNavigation?: boolean;
  /** Human-readable report label for trusted first-party flows such as the packaged demo. */
  readonly targetName?: string;
  /** Marks the trusted packaged Northstar activation target so saved replay can relaunch it locally. */
  readonly packagedDemo?: boolean;
  readonly packs: readonly TestPackName[];
  readonly mode: TestRunMode;
  readonly outputPath: string;
  readonly searchQuery: string;
  readonly startupActions?: readonly RemoteKey[];
  readonly startupDecision?: "reject" | "accept";
  readonly maxDurationMs?: number;
  /** Explicit navigation traversal ceilings; unrelated diagnostic packs keep their budgets. */
  readonly navigationBudgets?: Partial<ExplorationBudgets>;
  /** Preserve individually reachable carousel/list cells during navigation. */
  readonly disableRepetitionCompression?: boolean;
  /** Local Northstar fixture only: permit selecting its two harmless profile buttons. */
  readonly fixtureProfileSelection?: boolean;
  readonly ciFailOn?: CiFailureThreshold;
  /** Optional reviewed semantic baseline for scan/CI orchestration only. */
  readonly baselinePath?: string;
  readonly screenshots?: boolean;
  /** Opt-in local browser-context recording for web audits only. */
  readonly recordVideo?: boolean;
  readonly targetRedaction?: "origin";
  readonly journeyPath?: string;
  /** Internal project-check contract: never attribute evidence to a redirected route. */
  readonly requireTargetRoute?: boolean;
  /** Private, developer-authored positive protected-content assertion. Never print its name. */
  readonly authReady?: { readonly role: "heading" | "region" | "button"; readonly name: string };
  /** Trusted local source tree used only for exact, bounded source correlation exports. */
  readonly sourceRoot?: string;
  readonly signal?: AbortSignal;
}

export interface TestCommandResult {
  readonly status: "completed" | "partial" | "failed";
  readonly issueCount: number;
  readonly highestSeverity: "critical" | "high" | "medium" | "low" | "info" | null;
  /** Highest VERIFIED severity. An explicit null means no VERIFIED findings were found. */
  readonly highestVerifiedSeverity?: "critical" | "high" | "medium" | "low" | "info" | null;
  readonly reportPath: string | null;
  readonly details: readonly string[];
  /** Navigation coverage from the explorer, limited to reason codes and counts. */
  readonly navigationCoverage?: {
    readonly reason: ExplorationTerminationReason;
    readonly complete: boolean;
    readonly pendingStates: number;
    readonly remainingFrontierEntries: number | null;
    readonly remainingCandidateActions: number | null;
    readonly deferredStates: number;
  };
}

export interface ReplayCommandRequest {
  readonly issueId: string;
  readonly reportPath: string;
  /** MCP's independent fix verification requires repeated post-action observation. */
  readonly confirmStableFix?: boolean;
  readonly targetOverride?: string;
  readonly apkPath?: string;
  readonly deviceSerial?: string;
  readonly adbPath?: string;
  readonly journeyPath?: string;
  /** Original report-SHA-bound protected content assertion. Never render the name in diagnostics. */
  readonly authReady?: { readonly role: "heading" | "region" | "button"; readonly name: string };
  readonly signal?: AbortSignal;
}

export type ReplayCommandStatus =
  | "reproduced"
  | "fixed"
  | "inconclusive"
  | "error";

export interface ReplayCommandResult {
  readonly status: ReplayCommandStatus;
  readonly details: readonly string[];
}

export interface BaselineCreateRequest {
  readonly reportPath: string;
  readonly inventoryPath: string;
  readonly outputPath: string;
}

export interface BaselineCompareRequest extends BaselineCreateRequest {
  readonly baselinePath: string;
}

export interface BaselineCreateResult {
  readonly issueCount: number;
  readonly outputPath: string;
}

export interface BaselineCompareResult {
  readonly status: "identical" | "changed" | "regressed" | "failed-closed";
  readonly shouldFail: boolean;
  readonly newIssues: number;
  readonly resolvedIssues: number;
  readonly unchangedIssues: number;
  readonly issueMetadataChanges?: number;
  readonly severityEscalations?: number;
  readonly confidenceDowngrades?: number;
  readonly structuralRegressions: number;
  readonly addedFocusTargets: number;
  readonly removedFocusTargets: number;
  readonly directionalTransitionChanges: number;
  readonly latencyRegressions: number;
  readonly blockers: readonly string[];
  readonly outputPath: string;
  readonly markdownPath?: string;
}

export interface DemoCommandRequest {
  readonly outputPath: string;
  readonly signal?: AbortSignal;
}

export interface DemoCommandResult {
  readonly status: "verified" | "inconclusive" | "failed";
  readonly issueId: string | null;
  readonly reportPath: string | null;
  readonly replayStatus: ReplayCommandStatus | null;
  readonly details: readonly string[];
}

export interface CliOperations {
  replayIssue(request: ReplayCommandRequest): Promise<ReplayCommandResult>;
  verifyOriginalFinding?(request: VerifyWorkflowRequest): Promise<VerifyWorkflowResult>;
  inspectReport?(reportPath: string): Promise<ReportTriage>;
  runDemo?(request: DemoCommandRequest): Promise<DemoCommandResult>;
  testTarget?(request: TestCommandRequest): Promise<TestCommandResult>;
  detectWebsiteStartup?(target: string): Promise<WebsiteStartupDetection>;
  androidPreflight?(adbPath?: string): Promise<AndroidPreflightResult>;
  androidBuildToolsPreflight?(): Promise<AndroidBuildToolsPreflightResult>;
  androidObserverPreflight?(adbPath: string, serial: string): Promise<AndroidObserverPreflightResult>;
  inspectApk?(path: string): Promise<ApkMetadata>;
  scanAndroidApk?(request: AndroidScanOptions): Promise<AndroidScanResult>;
  createBaseline?(request: BaselineCreateRequest): Promise<BaselineCreateResult>;
  compareBaseline?(request: BaselineCompareRequest): Promise<BaselineCompareResult>;
}

export interface WebsiteStartupDetection {
  readonly status: "ready" | "blocked" | "unavailable";
  readonly blockerKind?: string;
  readonly textSample?: string;
  readonly detail: string;
}

export interface CliIO {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

/**
 * OS integrations used by the report actions displayed at the end of a guided
 * scan. They are injectable so a failed desktop integration is visible and the
 * flow can be exercised without launching external applications in tests.
 */
export interface ReportActionHandlers {
  openReport(path: string): Promise<boolean>;
  showFolder(path: string): Promise<boolean>;
  copyPath(path: string): Promise<boolean>;
}

export interface CliContext {
  readonly environment: RuntimeEnvironment;
  readonly io: CliIO;
  readonly operations?: CliOperations;
  readonly runtimeProbe?: () => Promise<RuntimeProbeResult>;
  readonly runtimeSetup?: (signal?: AbortSignal) => Promise<void>;
  readonly startTerminal?: StartTerminal;
  /** Trusted source root supplied by an embedding host or safely inferred CI environment. */
  readonly sourceRoot?: string;
  readonly signal?: AbortSignal;
  readonly terminalProgress?: {
    readonly isInteractive: boolean;
    update(text: string): void;
    finish(): void;
  };
  readonly reportActions?: ReportActionHandlers;
}

export interface RuntimeProbeResult {
  readonly capabilities: readonly string[];
}

export const HELP_TEXT = `TVDoctor — UI debugging for coding agents

Connect your agent to the local stdio server to scan, inspect evidence, and
independently verify supported fixes after it changes application code.

  Package binary   tvdoctor-mcp
  Source checkout  node packages/cli/dist/mcp-bin.js

Usage:
  tvdoctor demo [--output PATH]
  tvdoctor ui [--port PORT]
  tvdoctor start
  tvdoctor qa URL [--output NEW_DIRECTORY] [--json] [--mode quick|standard|deep] [--no-interactions]
  tvdoctor qa --config PATH --authorized [--output NEW_DIRECTORY] [--json]
  tvdoctor qa-verify --original QA_BUNDLE --target URL --authorized [--output NEW_DIRECTORY] [--json]
  tvdoctor qa-accept --original QA_BUNDLE --target URL --authorized [--output NEW_DIRECTORY] [--json]
  tvdoctor check URL [--interactions] [--journey PATH] [--json] [--fail-on LEVEL] [--output PATH]
  tvdoctor project --config PATH --authorized [--output NEW_DIRECTORY] [--json]
  tvdoctor project-verify --config PATH --original SUMMARY_PATH --authorized [--output NEW_DIRECTORY] [--json]
  tvdoctor project-accept --config PATH --original SUMMARY_PATH --authorized [--output NEW_DIRECTORY] [--json]
  tvdoctor route-health capture --config ROUTE.json --authorized --output NEW_DIRECTORY [--json]
  tvdoctor route-health verify --config ROUTE.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIRECTORY [--json]
  tvdoctor route-health accept --config ROUTE.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIRECTORY [--json]
  tvdoctor spa-route-health capture --config SPA.json --authorized --output NEW_DIRECTORY [--json]
  tvdoctor spa-route-health verify --config SPA.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIRECTORY [--json]
  tvdoctor spa-route-health accept --config SPA.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIRECTORY [--json]
  tvdoctor boot-health capture --config BOOT.json --authorized --output NEW_DIRECTORY [--json]
  tvdoctor boot-health verify --config BOOT.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIRECTORY [--json]
  tvdoctor boot-health accept --config BOOT.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIRECTORY [--json]
  tvdoctor findings --report PATH [--json]
  tvdoctor handoff (--report PATH | --project SUMMARY_PATH) [--json]
  tvdoctor scan URL [--input remote|keyboard] [--keyboard-interactions] [options] [--baseline PATH]
  tvdoctor site URL --input keyboard [--mode quick|standard|deep] [--max-pages N] [--output PATH]
  tvdoctor responsive URL [--mode quick|standard|deep] [--max-pages N] [--output PATH]
  tvdoctor test URL [--pack NAME] [--mode MODE] [--output PATH] [--query TEXT]
  tvdoctor test URL [--startup-actions KEY[,KEY...]] [--max-duration-ms N]
  tvdoctor test URL [--journey PATH]
  tvdoctor accessibility URL [--mode MODE] [--output PATH] [--journey PATH]
  tvdoctor test --apk PATH [--device SERIAL] [--mode quick|deep] [--output PATH]
  tvdoctor ci URL --fail-on LEVEL [test options]
  tvdoctor baseline create --report PATH [--inventory PATH] [--output PATH]
  tvdoctor baseline compare --baseline PATH --report PATH [--inventory PATH] [--output PATH]
  tvdoctor privacy
  tvdoctor setup
  tvdoctor doctor
  tvdoctor replay ISSUE_ID [--report PATH] [--target URL]
  tvdoctor verify-fix ISSUE_ID --report PATH --authorized [--target URL] [--sha256 HEX] [--journey PATH] [--scan-output PATH] [--compare]
  tvdoctor export-test ISSUE_ID --report PATH --output PATH
  tvdoctor version
  tvdoctor --version
  tvdoctor help
  tvdoctor --help

Source checkout: npm run tvdoctor -- <command> [...options]

Commands:
  qa        One-command safe web check, saved evidence, agent brief and CI verdict.
  qa-verify Independently verify every eligible original QA defect after a repair.
  qa-accept Verify original repairs AND separately scan the repaired app for new failures.
  demo      Run the deterministic Northstar first-success demo.
  ui        Serve the source-checkout localhost scan dashboard (no account).
  start     Open the guided product flow.
  check     Discover web keyboard UI failures and prioritize reproducible findings.
  project   Check same-origin routes from one reusable application QA manifest.
  project-verify
            Independently verify eligible original project findings after repairs.
  project-accept
            Independently verify original project fixes AND check every configured route again.
  route-health
            Independently check an authored public document route's 404/410 recovery.
  spa-route-health
            Independently check an authored client-side route's blank-content recovery and fresh QA.
  boot-health
            Independently check an authorised HTTP 200 page's persistent blank-first-render recovery.
  findings  Inspect an existing report for actionable evidence without opening a browser.
  handoff   Produce an offline ranked repair handoff from an original report or project.
  scan      Run the fast navigation-first audit.
  site      Scan bounded same-origin pages linked by static safe anchors.
  responsive
            Check layout at mobile, tablet and desktop widths with local evidence.
  test      Check remote/D-pad navigation and write a report bundle.
  accessibility
            Run the focused web accessibility and caption profile.
  ci        Run an audit with an explicit failure policy and CI exports.
  baseline  Create or compare a semantic regression baseline.
  privacy   Explain local capture, redaction, retention, and sharing controls.
  setup     Install the Chromium runtime matched to this TVDoctor version.
  doctor    Diagnose web and optional Android TV prerequisites.
  replay    Re-run one deterministic issue from a V1 report.
  verify-fix Independently prove supported original keyboard failures; optionally repeat scan and compare.
  export-test
            Export a verified web keyboard issue to a Playwright regression test.
  version   Print the installed TVDoctor version.
  help      Show this help.

Exit codes:
  0  Command completed successfully under the requested failure policy.
  1  Findings failed policy, a standalone replay reproduced the issue, a baseline regressed,
     or a required local environment/device is unavailable.
  2  Command usage is invalid.
  3  The result is partial or inconclusive.
  4  Execution failed before a trustworthy result was produced.`;

export const VERIFY_FIX_HELP_TEXT = `Usage:
  tvdoctor verify-fix ISSUE_ID --report PATH --authorized [--target URL] [--sha256 HEX]
    [--journey PATH] [--scan-output PATH] [--compare]
    [--screenshots] [--max-duration-ms N] [--max-actions N]
  tvdoctor verify-fix ISSUE_ID --report PATH --authorized --target URL --journey PATH
    --auth-ready-role heading|region|button --auth-ready-name "Original protected landmark"

Replays an original deterministic keyboard.modal-focus-escape,
keyboard.modal-tab-focus-loss or keyboard.modal-open-focus-not-transferred
finding with rule-specific positive post-fix assertions and repeated
confirmation. The modal-opening oracle checks the same named modal and opener
after the original safe Select action. Heuristic and unsupported issue types
return INCONCLUSIVE; disappearance on a repeat scan never proves a fix.
For an authenticated SPA, pass the exact original --journey PATH (credentials
remain in TVDOCTOR_JOURNEY_* environment variables). Protected original
reports also require the SHA-bound original role/name content assertion.
That uniquely visible landmark is checked after login and each replay reset;
missing, changed or unauthenticated content is INCONCLUSIVE, never FIXED.
Older authenticated evidence without the content proof cannot certify a fix:
recapture the original from an unchanged unrepaired application baseline.
--scan-output requests a fresh independent Chromium scan in a NEW output folder.
--compare additionally requires complete comparable original/current inventories;
missing or changed conditions are INCONCLUSIVE, never a verified resolution.
--sha256 pins the original report's lowercase SHA-256 against stale evidence.
Only HTTP(S) web targets without embedded credentials are supported.
--authorized explicitly permits browser navigation and testing.

Output: one JSON object (tvdoctor.verify-workflow/v1) on stdout.
Exit: 0 verified FIXED with no regression; 1 REPRODUCED or regressed;
      2 invalid invocation; 3 INCONCLUSIVE; 4 unexpected execution error.`;

export const CHECK_HELP_TEXT = `Usage:
  tvdoctor check URL [--interactions] [--mode quick|standard|deep]
    [--output NEW_DIRECTORY] [--json] [--fail-on LEVEL] [--baseline PATH]
    [--max-duration-ms N] [--max-actions N] [--journey PATH]
    [--source-root YOUR_REPOSITORY]
  tvdoctor check URL --journey PATH --require-target-route
    --auth-ready-role heading|region|button --auth-ready-name "Visible protected landmark"

An independent Chromium keyboard navigation audit for ordinary web projects.
Start your web app first. No framework plugin, test script or MCP client needed.
Explores Tab/Shift+Tab by default; --interactions explicitly enables restricted,
policy-checked Enter/Escape navigation of menus and dialogs. No autonomous
credential submission, destructive actions or arbitrary forms are promised.
With an explicitly approved private journey and exact target route, protected
scanning also requires the authored accessible role/name marker to be uniquely
visible after login AND after each restoration. Same-URL login/403 shells lacking
that marker produce INCONCLUSIVE, not a successful authenticated check.
Keep journey paths and private values outside shared logs and CI output.
Use --json for one machine-readable result on stdout; otherwise prints a small
prioritized finding list, evidence pointers and exact next commands.
--baseline PATH adds the existing semantic comparison against an approved baseline.
--source-root explicitly enables bounded local code-identifier matching and
adds source-correlation evidence to the report bundle (not source-code fixes).
--fail-on LEVEL: any (default), critical, high, medium, low, info, never;
applies to VERIFIED findings, not review-only heuristics.
--output must be a fresh directory; otherwise a unique run folder is created.

Exit: 0 no verified findings violating policy under completed coverage;
      1 verified findings failed policy or regression detected;
      2 invalid arguments; 3 partial/ambiguous comparison or unavailable evidence;
      4 execution failure. Exit 0 never certifies an entirely bug-free website.`;

export const QA_HELP_TEXT = `Usage:
  tvdoctor qa URL [--output NEW_DIRECTORY] [--json]
    [--mode quick|standard|deep] [--fail-on any|critical|high|medium|low|info|never]
    [--no-interactions] [--safe-links] [--source-root REPOSITORY] [--baseline PATH]
  tvdoctor qa --config PROJECT_MANIFEST --authorized [--output NEW_DIRECTORY] [--json]

First use: run your web app, then point tvdoctor qa at its local URL.
Defaults to the standard bounded scan profile, not the quick sampling profile;
use --mode quick explicitly when shorter scans are more important than recall.
The default explores bounded Tab/Shift+Tab plus restricted policy-checked safe
menu/dialog keyboard activation. --no-interactions disables safe activation.
--safe-links additionally opts into narrow same-origin GET document-link
navigation and REVIEW-only observations of actual HTTP 404/410/5xx responses.
Even harmless-looking GET links can have side effects in flawed apps: use only
on a development/test instance; risky paths/queries and actions are withheld.
It never freely clicks forms, logs in, submits orders or mutates server data.
Project manifests with private environment-named journeys require --authorized.

One owned fresh run directory contains original/report.json or summary.json,
HTML and replay evidence, handoff.json, AGENT_REPAIR_BRIEF.md and qa-summary.json.
The agent brief is saved original evidence, NOT a claim that any repair was
independently FIXED. Use the supported SHA-pinned verify-fix command after editing.
--json produces one tvdoctor.qa/v1 object with safe paths, counts and native
CI exit: 0 bounded no policy failure; 1 original policy failure/regression;
2 invalid arguments; 3 incomplete/untrustworthy evidence; 4 execution failure.
The current published Windows v0.1.0 TV preview does not contain this command.`;

export const QA_VERIFY_HELP_TEXT = `Usage:
  tvdoctor qa-verify --original ORIGINAL_QA_BUNDLE_OR_qa-summary.json
    --target REPAIRED_RUNNING_APP_URL --authorized
    [--output NEW_DIRECTORY] [--json]

The developer repairs the app first, then this checks ALL originally VERIFIED
modal issues in the immutable QA bundle. Uses saved original evidence and the
existing SHA-pinned independent Chromium verify-fix for each supported rule,
not disappearing issue counts in a fresh scan. An original REPRODUCED finding
means the attempted repair still fails. Missing, unsupported, changed,
incomparable or partial evidence is INCONCLUSIVE, never FIXED.

--authorized explicitly permits live browser replay. Target must be a safe
credential-free HTTP(S) URL on the original origin with no query or fragment.
The original QA directory is read-only and may have been copied from CI.
One new output directory stores qa-verification.json with bounded issue IDs,
rule-specific verdicts and status, with no browser app messages or secrets.
--json emits exactly one tvdoctor.qa-verification/v1 object on stdout.
Exit: 0 all originally verified issues independently FIXED;
      1 at least one independently REPRODUCED;
      2 invalid arguments;
      3 INCONCLUSIVE/unsupported/no verifiable original issue;
      4 execution failure.
Exit 0 only covers these supported original issues, not new regressions or
the entire web app. Re-run qa after repair for a separate regression audit.`;

export const QA_ACCEPT_HELP_TEXT = `Usage:
  tvdoctor qa-accept --original ORIGINAL_QA_BUNDLE_OR_qa-summary.json
    --target REPAIRED_RUNNING_APP_URL --authorized
    [--output NEW_DIRECTORY] [--json]

One independent post-repair acceptance command runs two distinct checks:
  1. SHA-pinned independent original-issue verification via qa-verify;
  2. A NEW bounded qa Chromium scan for regressions in the repaired app.

The original report is read-only, with its unchanged SHA checked; verification
and regression create distinct new evidence directories. An absent original
issue in the new scan does not count as FIXED: only the rule-specific verifier
can determine the original FIXED/REPRODUCED/INCONCLUSIVE outcome. REVIEW
observations are reported but never promoted to independently VERIFIED defects.
The new scan cannot establish whole-app regression freedom or WCAG compliance.

The authorized target must be same-origin as the original, credential-free,
HTTP(S), and without query or fragment. Use only a controlled development/test
app; safe browser interactions are bounded and non-destructive by policy.
Output may include private rendered UI in report artifacts: retain securely.

--json writes one bounded tvdoctor.qa-accept/v1 result for agents/CI.
Exit: 0 originals independently FIXED and fresh scan completed with no new
        VERIFIED failures in observed coverage;
      1 original REPRODUCED or new VERIFIED regression;
      2 invalid arguments; 3 incomplete, unsupported, unsafe or untrusted;
      4 execution failure. Published Windows v0.1.0 lacks this command.`;

async function runQaAcceptance(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, QA_ACCEPT_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const values = new Map<string, string>();
  let authorized = false;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    if (option === "--authorized" && !authorized) { authorized = true; continue; }
    if (option === "--json" && !json) { json = true; continue; }
    if (!["--original", "--target", "--output"].includes(option ?? "")) {
      return usageError(context, `unknown or repeated qa-accept option: ${option ?? "(missing)"}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0
      || value.length > 1024 || value.trim() !== value || value.includes("\0")
      || values.has(option ?? "")) {
      return usageError(context, `qa-accept requires one bounded ${option ?? "option"} value`);
    }
    values.set(option ?? "", value);
    i += 1;
  }
  const original = values.get("--original");
  const target = values.get("--target");
  if (!authorized || original === undefined || target === undefined) {
    return usageError(context, "qa-accept requires --original QA_BUNDLE --target URL --authorized");
  }
  try {
    const url = new URL(target);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== ""
      || url.password !== "" || url.search !== "" || url.hash !== ""
      || target.length > 2048) throw new Error("invalid-target");
  } catch {
    return usageError(context, "qa-accept target must be HTTP(S), without credentials, query or fragment");
  }
  if (context.operations?.verifyOriginalFinding === undefined
    || context.operations.testTarget === undefined || context.operations.inspectReport === undefined) {
    writeLine(context.io.writeStderr, "QA acceptance requires an independent verifier and the actual Chromium QA runner.");
    return EXIT_CODES.executionError;
  }
  const output = values.get("--output") ?? defaultOutputDirectory({
    target: "web-qa-acceptance", mode: "standard", platform: "web",
  });
  try {
    const invoke = async (childArgs: readonly string[]) => {
      let stdout = "";
      let truncated = false;
      const exitCode = await runCli(childArgs, {
        ...context,
        io: {
          writeStdout: (part) => {
            if (stdout.length + part.length <= 1024 * 1024) stdout += part;
            else truncated = true;
          },
          writeStderr: () => { /* Neither browser output nor secrets enter acceptance JSON. */ },
        },
      });
      return { exitCode, stdout: truncated ? "" : stdout };
    };
    const result = await runQaAccept({ originalQaPath: original, target, outputRoot: output,
      authorized, executeVerify: invoke, executeQa: invoke });
    if (json) context.io.writeStdout(`${JSON.stringify(result)}\n`);
    else {
      writeLine(context.io.writeStdout, `QA repair acceptance: ${result.status}.`);
      writeLine(context.io.writeStdout, `Verification and regression evidence: ${output}`, 1024);
      if (result.reason !== null) writeLine(context.io.writeStdout, `Reason: ${result.reason}`);
      writeLine(context.io.writeStdout, result.caveat);
    }
    return result.exitCode;
  } catch {
    writeLine(context.io.writeStderr, "QA acceptance failed to validate original or new browser evidence.");
    return EXIT_CODES.executionError;
  }
}

async function runQaVerification(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, QA_VERIFY_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const values = new Map<string, string>();
  let authorized = false;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    if (option === "--authorized" && !authorized) { authorized = true; continue; }
    if (option === "--json" && !json) { json = true; continue; }
    if (option !== "--original" && option !== "--target" && option !== "--output") {
      return usageError(context, `unknown or repeated qa-verify option: ${option ?? "(missing)"}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--") || value.trim() !== value
      || value.length === 0 || value.length > 1024 || value.includes("\0")
      || values.has(option)) {
      return usageError(context, `qa-verify requires one bounded ${option} value`);
    }
    values.set(option, value);
    i += 1;
  }
  const original = values.get("--original");
  const target = values.get("--target");
  if (original === undefined || target === undefined || !authorized) {
    return usageError(context, "qa-verify requires --original QA_BUNDLE --target URL --authorized");
  }
  try {
    const url = new URL(target);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== "" || url.password !== "" || url.search !== ""
      || url.hash !== "" || target.length > 2048) throw new Error("invalid-target");
  } catch {
    return usageError(context, "qa-verify target must be HTTP(S), without credentials, query or fragment");
  }
  if (context.operations?.verifyOriginalFinding === undefined) {
    writeLine(context.io.writeStderr, "Independent original verification is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  const output = values.get("--output") ?? defaultOutputDirectory({
    target: "web-qa-verification", mode: "standard", platform: "web",
  });
  try {
    const result = await runQaVerify({
      originalQaPath: original, target, outputRoot: output, authorized,
      executeVerify: async (verifyArgs) => {
        let stdout = "";
        let truncated = false;
        const exitCode = await runCli(verifyArgs, {
          ...context,
          io: {
            writeStdout: (part) => {
              if (stdout.length + part.length <= 1024 * 1024) stdout += part;
              else truncated = true;
            },
            writeStderr: () => { /* Raw app/browser messages are never aggregated. */ },
          },
        });
        return { exitCode, stdout: truncated ? "" : stdout };
      },
    });
    if (json) context.io.writeStdout(`${JSON.stringify(result)}\n`);
    else {
      writeLine(context.io.writeStdout, `QA independent verification ${result.status}: ${String(result.counts.fixed)} FIXED, ${String(result.counts.reproduced)} REPRODUCED, ${String(result.counts.inconclusive)} INCONCLUSIVE.`);
      for (const finding of result.perIssue.slice(0, 16)) {
        writeLine(context.io.writeStdout, `  [${finding.classification}] ${finding.issueId} ${finding.rule}`);
      }
      if (result.verificationPath !== null) writeLine(context.io.writeStdout, `Verification: ${join(output, result.verificationPath)}`, 1024);
      if (result.reason !== null) writeLine(context.io.writeStdout, `Reason: ${result.reason}`);
      writeLine(context.io.writeStdout, result.caveat);
    }
    return result.exitCode;
  } catch {
    writeLine(context.io.writeStderr, "QA independent verification could not create or validate its fresh result.");
    return EXIT_CODES.executionError;
  }
}

async function runQa(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, QA_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const values = new Map<string, string>();
  let authorized = false;
  let json = false;
  let noInteractions = false;
  let safeLinks = false;
  let url: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    if (option === "--authorized" && !authorized) { authorized = true; continue; }
    if (option === "--json" && !json) { json = true; continue; }
    if (option === "--no-interactions" && !noInteractions) { noInteractions = true; continue; }
    if (option === "--safe-links" && !safeLinks) { safeLinks = true; continue; }
    if (["--config", "--output", "--mode", "--fail-on", "--source-root", "--baseline"].includes(option ?? "")) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() !== value
        || value.length === 0 || value.length > 1024 || value.includes("\0")
        || values.has(option ?? "")) {
        return usageError(context, `qa requires a bounded, unrepeated ${option ?? "option"} value`);
      }
      values.set(option ?? "", value);
      i += 1;
      continue;
    }
    if (option !== undefined && !option.startsWith("-") && url === undefined) { url = option; continue; }
    return usageError(context, `unknown or repeated qa option: ${option ?? "(missing)"}`);
  }
  const config = values.get("--config");
  if ((config === undefined) === (url === undefined)) {
    return usageError(context, "qa requires exactly one URL or --config PROJECT_MANIFEST");
  }
  if (config !== undefined && (!authorized || noInteractions || values.has("--mode")
    || values.has("--fail-on") || values.has("--source-root") || values.has("--baseline") || safeLinks)) {
    return usageError(context, "project qa requires --authorized and allows only --config, --output and --json");
  }
  if (config === undefined && authorized) {
    return usageError(context, "--authorized is reserved for project manifests with explicit journeys");
  }
  if (safeLinks && noInteractions) return usageError(context, "qa --safe-links requires enabled restricted interactions");
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username !== ""
        || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || url.length > 2048) throw new Error("unsafe-url");
    } catch { return usageError(context, "qa requires an HTTP(S) URL without credentials, query parameters or fragment"); }
  }
  const mode = values.get("--mode") ?? "standard";
  if (!["quick", "standard", "deep"].includes(mode)) return usageError(context, "qa --mode must be quick, standard or deep");
  const failOn = values.get("--fail-on") ?? "any";
  if (!(CI_FAILURE_THRESHOLDS as readonly string[]).includes(failOn)) {
    return usageError(context, "qa --fail-on must be an existing CI severity threshold");
  }
  const output = values.get("--output") ?? defaultOutputDirectory({
    target: "web-qa", mode: mode as TestRunMode, platform: "web",
  });
  try {
    const result = await runQaWorkflow({
      source: config === undefined ? "url" : "project", target: config ?? url ?? "",
      outputRoot: output, mode: mode as TestRunMode, failOn,
      safeInteractions: !noInteractions, safeLinks, authorized,
      ...(values.get("--source-root") === undefined ? {} : { sourceRoot: values.get("--source-root") as string }),
      ...(values.get("--baseline") === undefined ? {} : { baselinePath: values.get("--baseline") as string }),
      renderBrief: renderAgentRepairBrief,
      execute: async (childArgs) => {
        let stdout = "";
        let truncated = false;
        const exitCode = await runCli(childArgs, {
          ...context, io: {
            writeStdout: (value) => {
              if (stdout.length + value.length <= 1024 * 1024) stdout += value;
              else truncated = true;
            },
            writeStderr: () => { /* No raw app/credential/browser prose in QA summaries. */ },
          },
        });
        return { exitCode, stdout: truncated ? "" : stdout };
      },
    });
    if (json) context.io.writeStdout(`${JSON.stringify(result)}\n`);
    else {
      writeLine(context.io.writeStdout, `QA ${result.status}: ${String(result.summary?.verified ?? 0)} verified original, ${String(result.summary?.review ?? 0)} review, ${String(result.summary?.incompleteRoutes ?? 0)} incomplete.`);
      if (result.originalPath !== null) writeLine(context.io.writeStdout, `Original evidence: ${result.originalPath}`, 1024);
      if (result.agentBriefPath !== null) writeLine(context.io.writeStdout, `Coding-agent task: ${result.agentBriefPath}`, 1024);
      if (result.summaryPath !== null) writeLine(context.io.writeStdout, `CI summary: ${result.summaryPath}`, 1024);
      writeLine(context.io.writeStdout, result.caveat);
    }
    return result.exitCode;
  } catch {
    writeLine(context.io.writeStderr, "QA could not create a fresh bounded output directory or audit evidence.");
    return EXIT_CODES.executionError;
  }
}

export const FINDINGS_HELP_TEXT = `Usage:
  tvdoctor findings --report PATH [--json]

Read an existing V1 report locally without a browser. Prioritizes bounded
findings with exact issue IDs, confidence, deterministic reproduction status,
safe evidence pointers and the supported next replay/verify-fix commands.
Unknown or malformed evidence is inconclusive, never a clean bill of health.
--json prints structured evidence for coding agents and CI. No network access.`;

export const PROJECT_HELP_TEXT = `Usage:
  tvdoctor project --config PATH --authorized [--output NEW_DIRECTORY] [--json]

Run the existing independent Chromium check sequentially across up to eight
same-origin routes from a tvdoctor.project/v1 JSON manifest. A route can name
an environment variable holding the path of its authenticated journey; the
manifest never stores passwords, cookies or session material.
For every new protected route with a journeyEnv, provide an authReady object
with exact unique visible role (heading|region|button) and accessible name.
Configure that marker to distinguish protected content from a login/403 shell;
if absent, redirected, hidden or not restored, route coverage is INCONCLUSIVE.
Legacy protected manifests without authReady remain readable for historical
inspection but cannot produce a new clean authenticated project scan.
Each route creates an original report; the project creates summary.json.
Only verified failures can violate the selected severity policy. REVIEW leads
do not prove defects; incomplete coverage fails closed as INCONCLUSIVE (exit 3).
--authorized gives explicit consent to browse all configured routes.
--output must be a fresh directory. --json prints a bounded summary for CI.
Exit: 0 clean within policy, 1 verified findings, 2 invalid config or usage,
      3 incomplete/inconclusive, 4 execution error.`;

export const PROJECT_VERIFY_HELP_TEXT = `Usage:
  tvdoctor project-verify --config PATH --original SUMMARY_PATH --authorized
    [--output NEW_DIRECTORY] [--json]

Verify supported, originally VERIFIED keyboard modal issues across a completed
project-check bundle by individually running the existing original-evidence
verify-fix command, not by comparing disappearing findings in a fresh scan.
--config is the original tvdoctor.project/v1 manifest; --original is the
unchanged project's summary.json. Journey files are sourced by environment
variable names in the manifest and are kept out of the output bundle.
Original report hashes, route identity, complete evidence, and original journey
comparability are mandatory. Unsupported issues or missing evidence do not
count as FIXED. --authorized permits browser operation on configured routes.
--output must be a fresh directory; --json emits a bounded project verdict.
Exit: 0 all original eligible findings independently FIXED;
      1 any REPRODUCED; 2 invalid usage; 3 INCONCLUSIVE/no eligible findings;
      4 execution failure. No result certifies a whole app defect-free.`;

export const PROJECT_ACCEPT_HELP_TEXT = `Usage:
  tvdoctor project-accept --config PROJECT_MANIFEST --original ORIGINAL_PROJECT_SUMMARY.json
    --authorized [--output NEW_DIRECTORY] [--json]

For existing tvdoctor.project/v1 manifests (including authenticated same-origin
SPA routes with environment-named journeys), independently verify all original
eligible VERIFIED modal issues using their immutable saved replay evidence,
then run one NEW independent project scan of every configured route.

Original verification and fresh regression coverage are DIFFERENT gates.
A missing issue after the repair does not establish FIXED. A new VERIFIED issue
observed post-repair is not automatically proven introduced by the repair;
REVIEW hints do not become VERIFIED. Partial, altered, unsupported, changed
authentication/route, or incomplete evidence can never pass the acceptance.

--authorized is required because the verifier and fresh scan open real browsers
and replay only bounded policy-gated interactions. Environment-sourced journeys
remain private; never put passwords or cookies in your manifest. Use a disposable
authorised testing application. Reports/screenshots/visible DOM may expose
private application data: restrict artifact retention and sharing.

Original bundle and every new output directory are strictly separate and
create-only. --json emits bounded tvdoctor.project-accept/v1 evidence.
Exit: 0 all original supported findings independently FIXED and fresh routes
        fully observed with zero VERIFIED new findings in bounded coverage;
      1 REPRODUCED original or observed post-repair VERIFIED failure;
      2 invalid options; 3 inconclusive/unsupported/partial/altered evidence;
      4 execution failure. A pass is not whole-app/WCAG certification.
This is current unreleased source, not public Windows v0.1.0.`;

async function runProjectAcceptance(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, PROJECT_ACCEPT_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const values = new Map<string, string>();
  let authorized = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--authorized" && !authorized) { authorized = true; continue; }
    if (option === "--json" && !json) { json = true; continue; }
    if (option !== "--config" && option !== "--original" && option !== "--output") {
      return usageError(context, `unknown or repeated project-accept option: ${option ?? "(missing)"}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() !== value
      || value.length === 0 || value.length > 1024 || value.includes("\0")
      || values.has(option)) {
      return usageError(context, `${option} requires one bounded and unrepeated path`);
    }
    values.set(option, value);
    index += 1;
  }
  const manifestPath = values.get("--config");
  const originalSummaryPath = values.get("--original");
  if (!authorized || manifestPath === undefined || originalSummaryPath === undefined) {
    return usageError(context, "project-accept requires --config PATH --original SUMMARY.json --authorized");
  }
  if (context.operations?.verifyOriginalFinding === undefined || context.operations.testTarget === undefined
    || context.operations.inspectReport === undefined) {
    writeLine(context.io.writeStderr, "Project acceptance needs both independent verification and the live Chromium scanner.");
    return EXIT_CODES.executionError;
  }
  const outputRoot = values.get("--output") ?? defaultOutputDirectory({
    target: "web-project-acceptance", mode: "standard", platform: "web",
  });
  const execute = async (childArgs: readonly string[]) => {
    let stdout = "";
    let truncated = false;
    const exitCode = await runCli(childArgs, {
      ...context, io: {
        writeStdout: (text) => {
          if (stdout.length + text.length <= 1024 * 1024) stdout += text;
          else truncated = true;
        },
        writeStderr: () => { /* Never aggregate browser logs, secrets or app text. */ },
      },
    });
    return { exitCode, stdout: truncated ? "" : stdout };
  };
  try {
    const result = await runProjectAccept({ manifestPath, originalSummaryPath,
      outputRoot, authorized: true, executeVerify: execute, executeProject: execute });
    if (json) context.io.writeStdout(`${JSON.stringify(result)}\n`);
    else {
      writeLine(context.io.writeStdout, `Project repair acceptance ${result.status}.`);
      if (result.reason !== null) writeLine(context.io.writeStdout, `Reason: ${result.reason}`);
      writeLine(context.io.writeStdout, `Evidence: ${outputRoot}`, 1024);
      writeLine(context.io.writeStdout, result.caveat);
    }
    return result.exitCode;
  } catch {
    writeLine(context.io.writeStderr, "Project acceptance failed before it could validate independent evidence.");
    return EXIT_CODES.executionError;
  }
}

export const HANDOFF_HELP_TEXT = `Usage:
  tvdoctor handoff (--report REPORT_JSON_OR_DIR | --project SUMMARY_JSON_OR_DIR) [--json]

Offline original-evidence repair handoff. Prioritizes three actionable issues
from an existing check/project, with verified artifact references and supported
SHA-pinned fix-verification commands. Never claims that a fix was tested.
No browser, credentials, or authorization flag required.
Exit: 0 usable handoff; 2 invalid usage; 3 missing/inconclusive evidence.`;

async function runProject(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, PROJECT_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const values = new Map<string, string>();
  let authorized = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--authorized" && !authorized) { authorized = true; continue; }
    if (option === "--json" && !json) { json = true; continue; }
    if (option !== "--config" && option !== "--output") {
      return usageError(context, `unknown or repeated project option: ${option ?? "(missing)"}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === ""
      || value.length > 1_024 || values.has(option)) {
      return usageError(context, `${option} requires a bounded path and may not repeat`);
    }
    values.set(option, value);
    index += 1;
  }
  const manifestPath = values.get("--config");
  if (manifestPath === undefined) return usageError(context, "project requires --config PATH");
  if (!authorized) return usageError(context, "project requires --authorized for browser operations");
  const outputRoot = values.get("--output") ?? defaultOutputDirectory({
    target: "web-project", mode: "quick", platform: "web",
  });
  try {
    const result = await runProjectCheck({
      manifestPath, outputRoot,
      executeCheck: async (checkArgs) => {
        let stdout = "";
        const exitCode = await runCli(checkArgs, {
          ...context,
          io: {
            writeStdout: (text) => { stdout += text; },
            writeStderr: () => { /* Raw per-route app errors are not aggregated. */ },
          },
        });
        return { exitCode, stdout };
      },
    });
    if (json) context.io.writeStdout(`${JSON.stringify(result)}\n`);
    else {
      writeLine(context.io.writeStdout, `Project ${result.status}: ${result.summary.routes} route(s), ${result.summary.verified} verified, ${result.summary.review} review, ${result.summary.partial} partial.`);
      writeLine(context.io.writeStdout, `Summary: ${outputRoot}/summary.json`);
      for (const route of result.routes) {
        writeLine(context.io.writeStdout, `[${route.status}] ${route.id}: ${route.verified} verified, ${route.review} review`);
      }
    }
    return result.exitCode;
  } catch (error) {
    writeLine(context.io.writeStderr, `Project check failed: ${classifyCliError(error, "audit")}`);
    return EXIT_CODES.executionError;
  }
}

async function runProjectVerification(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, PROJECT_VERIFY_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const values = new Map<string, string>();
  let authorized = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--authorized" && !authorized) { authorized = true; continue; }
    if (option === "--json" && !json) { json = true; continue; }
    if (option !== "--config" && option !== "--original" && option !== "--output") {
      return usageError(context, `unknown or repeated project-verify option: ${option ?? "(missing)"}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === ""
      || value.length > 1_024 || values.has(option)) {
      return usageError(context, `${option} requires a bounded path and may not repeat`);
    }
    values.set(option, value);
    index += 1;
  }
  if (!authorized) return usageError(context, "project-verify requires --authorized for browser operations");
  const manifestPath = values.get("--config");
  const originalSummaryPath = values.get("--original");
  if (manifestPath === undefined || originalSummaryPath === undefined) {
    return usageError(context, "project-verify requires --config PATH and --original SUMMARY_PATH");
  }
  if (context.operations?.verifyOriginalFinding === undefined) {
    writeLine(context.io.writeStderr, "Independent fix verification is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  const outputRoot = values.get("--output") ?? defaultOutputDirectory({
    target: "web-project-verification", mode: "quick", platform: "web",
  });
  try {
    const result = await runProjectVerify({
      manifestPath, originalSummaryPath, outputRoot, authorized: true,
      executeVerify: async (verifyArgs) => {
        let stdout = "";
        const exitCode = await runCli(verifyArgs, {
          ...context,
          io: {
            writeStdout: (part) => {
              if (stdout.length <= 1024 * 1024) stdout += part;
            },
            writeStderr: () => { /* Never aggregate raw browser or authentication errors. */ },
          },
        });
        return { exitCode, stdout };
      },
    });
    if (json) context.io.writeStdout(`${JSON.stringify(result)}\n`);
    else {
      writeLine(context.io.writeStdout, `Project verification ${result.status}: ${String(result.summary.fixed)} FIXED, ${String(result.summary.reproduced)} REPRODUCED, ${String(result.summary.inconclusive)} INCONCLUSIVE.`);
      if (result.summaryPath !== null) writeLine(context.io.writeStdout, `Verification summary: ${result.summaryPath}`, 1024);
      if (result.reason !== null) writeLine(context.io.writeStdout, `Reason: ${result.reason}`);
      writeLine(context.io.writeStdout, result.caveat);
    }
    return result.exitCode;
  } catch {
    writeLine(context.io.writeStderr, "Project verification failed before a trustworthy result was produced.");
    return EXIT_CODES.executionError;
  }
}

interface CheckArguments {
  readonly request: TestCommandRequest;
  readonly json: boolean;
  readonly failOn: CiFailureThreshold;
}

function parseCheckArguments(args: readonly string[]): CheckArguments | string {
  let json = false;
  let interactions = false;
  let safeLinks = false;
  let requireTargetRoute = false;
  let authReadyRole: "heading" | "region" | "button" | undefined;
  let authReadyName: string | undefined;
  let failOn: CiFailureThreshold = "any";
  let failOnProvided = false;
  let modeProvided = false;
  let sourceRoot: string | undefined;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json" || arg === "--interactions") {
      if (arg === "--json" ? json : interactions) return `duplicate check option: ${arg}`;
      if (arg === "--json") json = true;
      else interactions = true;
      continue;
    }
    if (arg === "--safe-links") {
      if (safeLinks) return "duplicate check --safe-links";
      safeLinks = true;
      continue;
    }
    if (arg === "--require-target-route") {
      if (requireTargetRoute) return "duplicate project route identity requirement";
      requireTargetRoute = true;
      continue;
    }
    if (arg === "--auth-ready-role") {
      const value = args[i + 1];
      if (authReadyRole !== undefined || (value !== "heading" && value !== "region" && value !== "button")) {
        return "--auth-ready-role requires a unique supported accessible role";
      }
      authReadyRole = value;
      i += 1;
      continue;
    }
    if (arg === "--auth-ready-name") {
      const value = args[i + 1];
      if (authReadyName !== undefined || typeof value !== "string" || value.length < 1 || value.length > 128
        || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) {
        return "--auth-ready-name requires one bounded printable accessible name";
      }
      authReadyName = value;
      i += 1;
      continue;
    }
    if (arg === "--fail-on") {
      if (failOnProvided) return "--fail-on may be supplied only once";
      const value = args[i + 1];
      if (value === undefined || !(CI_FAILURE_THRESHOLDS as readonly string[]).includes(value)) {
        return "--fail-on requires any, critical, high, medium, low, info, or never";
      }
      failOn = value as CiFailureThreshold;
      failOnProvided = true;
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      if (modeProvided) return "--mode may be supplied only once";
      modeProvided = true;
    }
    if (arg === "--source-root") {
      if (sourceRoot !== undefined) return "--source-root may be supplied only once";
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === ""
        || value.length > 1_024 || value.includes("\0")) {
        return "--source-root requires a bounded directory path";
      }
      sourceRoot = value;
      i += 1;
      continue;
    }
    if (["--pack", "--input", "--fixture-profile-select", "--startup-actions", "--query", "--record-video"].includes(arg ?? "")) {
      return `check intentionally uses navigation-only keyboard testing; ${arg} is unavailable`;
    }
    if (arg !== undefined) forwarded.push(arg);
  }
  const parsed = parseTestArguments(modeProvided ? forwarded : [...forwarded, "--mode", "quick"], false, true);
  if (typeof parsed === "string") return parsed;
  if ((authReadyRole === undefined) !== (authReadyName === undefined)
    || (authReadyRole !== undefined && (!requireTargetRoute || parsed.journeyPath === undefined))) {
    return "Authenticated content assertions require a paired role/name, a pinned journey and route identity";
  }
  if (safeLinks && !interactions) return "--safe-links requires --interactions";
  return {
    json, failOn,
    request: {
      ...parsed, packs: ["navigation"], inputMode: "keyboard",
      disableRepetitionCompression: true,
      ...(requireTargetRoute ? { requireTargetRoute: true } : {}),
      ...(authReadyRole === undefined || authReadyName === undefined
        ? {} : { authReady: { role: authReadyRole, name: authReadyName } }),
      ...(sourceRoot === undefined ? {} : { sourceRoot }),
      ...(interactions ? { keyboardInteractions: true } : {}),
      ...(safeLinks ? { safeLinkNavigation: true } : {}),
    },
  };
}

function triageNextSteps(path: string, triage: ReportTriage, target?: string): readonly string[] {
  const next: string[] = [];
  const first = triage.findings.find((finding) => finding.classification === "VERIFIED"
    && finding.reproduction.status === "deterministic");
  if (first !== undefined) {
    const targetOption = target === undefined ? "" : ` --target ${JSON.stringify(target)}`;
    next.push(`tvdoctor replay ${first.id} --report ${JSON.stringify(path)}${targetOption}`);
    if (first.rule === "keyboard.modal-focus-escape"
      || first.rule === "keyboard.modal-tab-focus-loss"
      || first.rule === "keyboard.modal-open-focus-not-transferred") {
      next.push(`After a code fix: tvdoctor verify-fix ${first.id} --report ${JSON.stringify(path)} --authorized${targetOption}`);
    } else {
      next.push("This rule has diagnostic replay only; do not interpret absence on a later scan as independently FIXED.");
    }
  }
  if (triage.coverage.incomplete) {
    next.push("Coverage is incomplete. Review the reasons, increase bounded budgets or repair setup and repeat the scan.");
  } else if (triage.summary.REVIEW > 0) {
    next.push("Review heuristic findings manually; automated observations alone do not prove those defects.");
  }
  return next.slice(0, 4);
}

async function runFindings(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, FINDINGS_HELP_TEXT);
    return EXIT_CODES.success;
  }
  let reportPath: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--json" && !json) { json = true; continue; }
    if (args[i] === "--report" && reportPath === null) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "" || value.length > 1_024) {
        return usageError(context, "--report requires a bounded file or report bundle directory");
      }
      reportPath = value;
      i += 1;
      continue;
    }
    return usageError(context, `unknown or repeated findings option: ${args[i] ?? "(missing)"}`);
  }
  if (reportPath === null) return usageError(context, "findings requires --report PATH");
  if (context.operations?.inspectReport === undefined) {
    writeLine(context.io.writeStderr, "Offline report triage is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  try {
    const triage = await context.operations.inspectReport(reportPath);
    // JSON.stringify escapes control characters itself. Do not apply terminal
    // prose truncation to structured output: it would produce invalid JSON.
    if (json) context.io.writeStdout(`${JSON.stringify(triage)}\n`);
    else {
      writeLine(context.io.writeStdout, `Original report ${triage.run.id}: ${String(triage.summary.VERIFIED)} verified failures, ${String(triage.summary.REVIEW)} review leads, ${String(triage.summary.UNTESTED)} untested.`);
      for (const finding of triage.findings.slice(0, 10)) {
        writeLine(context.io.writeStdout, `[${finding.classification}] ${finding.severity.toUpperCase()} ${finding.id} ${finding.title}`);
        writeLine(context.io.writeStdout, `  Observed: ${finding.observed}`, 600);
        writeLine(context.io.writeStdout, `  Replay: ${finding.reproduction.status}; evidence: ${finding.artifacts.filter((a) => a.status === "verified").length} verified file(s).`);
      }
      for (const next of triageNextSteps(reportPath, triage)) writeLine(context.io.writeStdout, `Next: ${next}`, 1_024);
      if (triage.summary.omitted > 0) writeLine(context.io.writeStdout, `${String(triage.summary.omitted)} findings omitted from terminal output; inspect JSON report.`);
    }
    return triage.coverage.incomplete || triage.integrity.evidence === "degraded"
      ? EXIT_CODES.inconclusive : EXIT_CODES.success;
  } catch (error) {
    writeLine(context.io.writeStderr, `Report triage is inconclusive: ${classifyCliError(error, "replay")}`);
    return EXIT_CODES.inconclusive;
  }
}

async function runCheck(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, CHECK_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const parsed = parseCheckArguments(args);
  if (typeof parsed === "string") return usageError(context, parsed);
  const checkFailed = (reason: string, code: number, reportPath: string | null = null): number => {
    if (parsed.json) {
      context.io.writeStdout(`${JSON.stringify({
        schemaVersion: "tvdoctor.developer-check/v1", status: "INCONCLUSIVE", shouldFail: true,
        reason, policy: { failOn: parsed.failOn, keyboardInteractions: parsed.request.keyboardInteractions === true },
        scan: { status: "unavailable", issueCount: null, reportPath, highestVerifiedSeverity: null },
        triage: null, comparison: null, nextActions: ["Review the error and repeat the local audit."],
        caveat: "No completed, validated evidence is available; this is not a clean result.",
      })}\n`);
    } else writeLine(context.io.writeStderr, `Developer check inconclusive: ${reason}`, 512);
    return code;
  };
  const operations = context.operations;
  if (operations?.testTarget === undefined || operations.inspectReport === undefined) {
    return checkFailed("Browser audit or local report inspector unavailable", EXIT_CODES.executionError);
  }
  // A JSON consumer must get exactly one JSON object on stdout, even when the
  // matched browser runtime is being installed for the first time.
  const runtimeContext = parsed.json ? {
    ...context, io: { ...context.io, writeStdout: context.io.writeStderr },
  } : context;
  if (!await ensureWebRuntime(runtimeContext)) return checkFailed("Chromium runtime unavailable", EXIT_CODES.environmentFailure);
  if (!parsed.json) writeLine(context.io.writeStdout, `Testing keyboard navigation: ${safeDisplayUrl(parsed.request.target)}`);
  let result: TestCommandResult;
  try {
    result = await operations.testTarget({
      ...parsed.request,
      ...(parsed.request.sourceRoot === undefined && context.sourceRoot !== undefined
        ? { sourceRoot: context.sourceRoot } : {}),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    return checkFailed(classifyCliError(error, "audit"), EXIT_CODES.executionError);
  }
  let triage: ReportTriage | null = null;
  if (result.reportPath !== null) {
    try { triage = await operations.inspectReport(result.reportPath); }
    catch (error) {
      return checkFailed(`Report inspection failed closed: ${classifyCliError(error, "replay")}`,
        EXIT_CODES.inconclusive, result.reportPath);
    }
  }
  let comparison: BaselineCompareResult | null = null;
  if (parsed.request.baselinePath !== undefined && result.reportPath !== null) {
    if (operations.compareBaseline === undefined) {
      return checkFailed("Semantic baseline comparison unavailable", EXIT_CODES.inconclusive, result.reportPath);
    }
    try {
      comparison = await operations.compareBaseline({
        baselinePath: parsed.request.baselinePath,
        reportPath: result.reportPath,
        inventoryPath: join(dirname(result.reportPath), "inventory.json"),
        outputPath: join(dirname(result.reportPath), "baseline-comparison.json"),
      });
    } catch (error) {
      return checkFailed(`Baseline comparison inconclusive: ${classifyCliError(error, "audit")}`,
        EXIT_CODES.inconclusive, result.reportPath);
    }
  }
  const inconsistent = triage !== null && (
    triage.summary.total !== result.issueCount
    || triage.highestVerifiedSeverity !== result.highestVerifiedSeverity
    || triage.integrity.evidence === "degraded"
    || triage.coverage.incomplete
  );
  const incomplete = result.status !== "completed" || triage === null
    || inconsistent || comparison?.status === "failed-closed";
  const regressed = comparison?.status === "regressed" || comparison?.shouldFail === true;
  const findingPolicyFailed = triage?.highestVerifiedSeverity !== null
    && triage?.highestVerifiedSeverity !== undefined
    && issueViolatesPolicy(triage.highestVerifiedSeverity, parsed.failOn);
  const exit = incomplete ? EXIT_CODES.inconclusive
    : regressed || findingPolicyFailed ? EXIT_CODES.environmentFailure : EXIT_CODES.success;
  const status = incomplete ? "INCONCLUSIVE" : regressed ? "REGRESSED"
    : findingPolicyFailed ? "FINDINGS"
      : (triage?.summary.REVIEW ?? 0) > 0 ? "REVIEW_REQUIRED" : "NO_VERIFIED_FAILURES_AT_THRESHOLD";
  const next = triage === null || result.reportPath === null ? ["Review the incomplete scan and retry."]
    : triageNextSteps(result.reportPath, triage, parsed.request.target);
  const output = {
    schemaVersion: "tvdoctor.developer-check/v1", status, shouldFail: exit !== EXIT_CODES.success,
    policy: { failOn: parsed.failOn, keyboardInteractions: parsed.request.keyboardInteractions === true },
    scan: { status: result.status, issueCount: result.issueCount, reportPath: result.reportPath,
      highestVerifiedSeverity: result.highestVerifiedSeverity ?? null },
    triage, comparison, nextActions: next,
    sourceCorrelation: result.details.find((detail) => detail.startsWith("Source correlation: "))?.slice("Source correlation: ".length) ?? null,
    caveat: "A completed bounded scan with no verified failures is not proof of an entirely bug-free or WCAG-conformant application.",
  };
  if (parsed.json) context.io.writeStdout(`${JSON.stringify(output)}\n`);
  else {
    writeLine(context.io.writeStdout, `Check ${status}: ${String(triage?.summary.VERIFIED ?? 0)} verified failures; ${String(triage?.summary.REVIEW ?? 0)} review leads; ${String(triage?.summary.UNTESTED ?? 0)} untested.`);
    if (result.reportPath !== null) writeLine(context.io.writeStdout, `Report: ${join(dirname(result.reportPath), "report.html")}`, 1_024);
    if (output.sourceCorrelation !== null) writeLine(context.io.writeStdout, `Source hints: ${output.sourceCorrelation}`, 1_024);
    else if (parsed.request.sourceRoot !== undefined) {
      writeLine(context.io.writeStdout, "Source hints unavailable; check the --source-root path and report details.");
    }
    for (const finding of triage?.findings.slice(0, 8) ?? []) {
      writeLine(context.io.writeStdout, `[${finding.classification}] ${finding.severity.toUpperCase()} ${finding.id}: ${finding.title}`);
      writeLine(context.io.writeStdout, `  Observed: ${finding.observed}`, 600);
    }
    for (const instruction of next) writeLine(context.io.writeStdout, `Next: ${instruction}`, 1_024);
    writeLine(context.io.writeStdout, `Coverage: ${triage?.coverage.incomplete === true ? "partial" : "bounded"}; ${output.caveat}`);
  }
  return exit;
}

export const TEST_HELP_TEXT = `Usage:
  tvdoctor test URL [options]
  tvdoctor test --apk PATH [--device SERIAL] [--mode quick|deep] [--output PATH]

Run a bounded remote-navigation audit against an absolute HTTP(S) URL.
The default checks D-pad/focus navigation. Extra packs remain opt-in.

Options:
  --pack NAME    navigation (default), streaming, search, settings, accessibility,
                 layout, performance, crashes, or all. Repeat to select packs.
                 Use all for the legacy full pack set.
  --mode MODE    quick, standard, or deep for web. Defaults to standard.
  --output PATH  Report bundle directory. Defaults under Tests with a readable name.
  --query TEXT   Non-sensitive search query. Defaults to N.
  --startup-actions KEY[,KEY...]
                 Explicit caller-selected remote keys used only to prepare a
                 detected startup setup screen. Defaults to observation-only.
  --max-duration-ms N
                 Navigation exploration ceiling only; setup, extra packs,
                 evidence capture and report generation take additional time.
  --max-actions N  Maximum physical remote inputs including replay (up to 1000000).
  --max-states N   Maximum distinct visited focus states (up to 100000).
  --max-depth N    Maximum path depth (0 to 4096).
  --no-compression
                 Explore every discovered distinct repeated focus target
                 within the selected action, state, depth and time limits.
  --fixture-profile-select
                 Fixture testing only: permit Northstar profile buttons on
                 localhost/loopback when their exact fixture markers match.
  --journey PATH  Safe custom web journey; secret values come only from
                 TVDOCTOR_JOURNEY_* environment variables.
  --no-screenshots
                 Do not persist PNG screenshot evidence.
  --record-video
                 Record one local WebM browser-session sidecar. Web only; off by default.
  --target-redaction origin
                 Store only the target origin as the public web target identity.

Android APK options:
  --apk PATH      Local APK to install and test without prompts.
  --device SERIAL Authorized emulator/device serial. Optional when exactly one
                  online device is available; required to disambiguate multiples.
  --adb PATH      Optional explicit adb executable path.
  --mode MODE     quick or deep. Defaults to quick.
  --output PATH   Report bundle directory.
  --no-screenshots
                 Do not persist before/after PNG evidence.`;

export const SCAN_HELP_TEXT = `Usage:
  tvdoctor scan URL [--input remote|keyboard] [--keyboard-interactions] [--mode quick|standard|deep] [--output PATH] [--journey PATH] [--baseline PATH] [--record-video]

Run the navigation-first web audit. Defaults to standard mode with uncompressed
navigation so all discovered controls can be explored within the safety limits.
Use --input keyboard to traverse browser focus with Tab and Shift+Tab; the
default --input remote uses TV remote/D-pad navigation. Keyboard scans only
check keyboard navigation and do not claim D-pad coverage.
--keyboard-interactions opts into policy-checked Enter and Escape on keyboard
scans. By default, keyboard scans use Tab and Shift+Tab only.
Use --mode quick for a 30-second navigation sample, or --mode deep for larger
coverage. The default navigation ceilings are 30 seconds (Quick), 120 seconds
(Standard), and 30 minutes (Deep). Browser setup, evidence capture and report
writing occur outside those navigation ceilings and extend total run time.
Override the limits with --max-actions N, --max-states N, --max-depth N and
--max-duration-ms N. --baseline compares against a reviewed semantic baseline.
Use tvdoctor test for diagnostic packs. --record-video is opt-in and may capture
sensitive visual content. --fixture-profile-select works only with the local
Northstar fixture. Even Deep scans can end partial when limits are hit.`;

export const DEMO_HELP_TEXT = `Usage:
  tvdoctor demo [--output PATH]

Run TVDoctor against its packaged Northstar demo fixture, verify the known D-pad
navigation failure, write a normal sanitized report, and reproduce the stored
deterministic replay. No application URL or authored navigation script is needed.`;

export const CI_HELP_TEXT = `Usage:
  tvdoctor ci URL --fail-on LEVEL [test options] [--baseline PATH]

Run the same bounded web audit as tvdoctor test and write exports/ci-summary.md
plus exports/junit.xml. LEVEL is any, critical, high, medium, low, info, or never.
A partial or failed audit remains non-successful regardless of the finding policy.
Remote navigation is the default; pass --pack all for the legacy full pack set.`;

export const BASELINE_HELP_TEXT = `Usage:
  tvdoctor baseline create --report PATH [--inventory PATH] [--output PATH]
  tvdoctor baseline compare --baseline PATH --report PATH [--inventory PATH] [--output PATH]

Create a reviewed semantic baseline from a complete report, or compare a current
complete report with it. Inventory defaults to inventory.json beside the report.
Compare writes JSON plus a sibling Markdown file for human review.`;

export const DOCTOR_HELP_TEXT = `Usage: tvdoctor doctor

Check the local Node.js runtime and both product surfaces. Web readiness includes
Playwright/Chromium launch and audit orchestration. Android TV readiness includes
ADB, Android SDK build-tools (aapt2/aapt), connected/authorized TV device state,
the packaged TVDoctor Observer, and Observer accessibility access. Android TV is
optional: an unconfigured Android surface does not make a ready web install fail.`;

export const SETUP_HELP_TEXT = `Usage: tvdoctor setup

Install the Chromium browser build matched to this TVDoctor version, then verify
that TVDoctor can launch it. The browser is stored in Playwright's user cache.`;

export const START_HELP_TEXT = `Usage: tvdoctor start

Open the guided interactive flow for first-run web or Android TV testing.
For scripted or non-interactive runs, use tvdoctor test instead.`;

export const REPLAY_HELP_TEXT = `Usage:
  tvdoctor replay ISSUE_ID [--report PATH] [--target URL] [--journey PATH]
  tvdoctor replay ISSUE_ID --report PATH --target URL --journey PATH
    --auth-ready-role heading|region|button --auth-ready-name "Original protected landmark"
  tvdoctor replay ISSUE_ID --report PATH --apk PATH --device SERIAL [--adb PATH]

Replay one deterministic issue stored in a tvdoctor.report/v1 report. PATH
defaults to tvdoctor-report/report.json. --target overrides the recorded web URL.
For Android reports, pass --apk PATH --device SERIAL and optionally --adb PATH.
For a journey-prepared web report, pass the same --journey PATH and the
original SHA-bound protected content role/name; these must match the saved
report and be proven after login and each replay restoration.

Standalone replay exit codes: FIXED exits 0; REPRODUCED exits 1;
INCONCLUSIVE exits 3; execution error exits 4.`;

export const EXPORT_TEST_HELP_TEXT = `Usage:
  tvdoctor export-test ISSUE_ID --report PATH --output PATH

Export a deterministic keyboard modal focus regression from a completed V1 web
report to a new .spec.js or .test.js Playwright file. Existing files are never
overwritten. Set TVDOCTOR_AUTHORIZED_TARGET_URL to the exact audited URL before
running the generated test. Partial, redacted, journey-based and unsupported
replays are rejected.`;

export const PRIVACY_HELP_TEXT = `Usage: tvdoctor privacy

Print TVDoctor's local-first capture, redaction, retention, and sharing policy.`;

export const ACCESSIBILITY_HELP_TEXT = `Usage:
  tvdoctor accessibility URL [--mode quick|deep] [--output PATH]
  tvdoctor accessibility URL [--journey PATH]

Run the bounded web accessibility profile. It selects the streaming and
accessibility packs to inspect remote focus, semantic labels, hidden focusable
controls, visible focus indication, and reachable caption controls.

Browser evidence does not prove TalkBack, text scaling, audio-description
preferences, autoplay behavior, or rendering on physical TV hardware.`;

const PORTABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const TEST_PACK_SET: ReadonlySet<string> = new Set(TEST_PACK_NAMES);
const TEST_RUN_MODES: ReadonlySet<string> = new Set(["quick", "standard", "deep"]);
const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);

function writeLine(
  write: (text: string) => void,
  text: string,
  maximumLength = 2_048,
): void {
  write(`${sanitizeTerminalText(text, { maximumLength })}\n`);
}

function writeBlock(write: (text: string) => void, text: string): void {
  write(`${sanitizeTerminalText(text, {
    maximumLength: 12_000,
    preserveNewlines: true,
  })}\n`);
}

function writeDetails(
  write: (text: string) => void,
  details: readonly string[],
): void {
  const displayedDetails = details.slice(0, 50);
  for (const detail of displayedDetails) writeLine(write, detail, 1_024);
  if (details.length > displayedDetails.length) {
    writeLine(
      write,
      `${String(details.length - displayedDetails.length)} additional details omitted; see the report bundle.`,
    );
  }
}

function usageError(context: CliContext, message: string): number {
  writeLine(context.io.writeStderr, `Error: ${message}`);
  writeLine(context.io.writeStderr, "Run \"tvdoctor --help\" for usage.");
  return EXIT_CODES.usageError;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function classifyCliError(error: unknown, activity: "audit" | "replay" | "doctor"): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  if (code === "ENOENT") {
    return activity === "replay"
      ? "The report file was not found. Check --report and try again."
      : "A required file was not found. Check the path and try again.";
  }
  if (code === "EEXIST") {
    return activity === "audit"
      ? "The report output already exists. Choose a new --output directory and try again."
      : "A destination already exists. Choose a new path and try again.";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "Access was denied. Check file and directory permissions, then try again.";
  }
  if (code === "ENOSPC") {
    return "The report could not be written because the disk is full. Free space and try again.";
  }
  if (/executable.*doesn.t exist|browser.*(?:not found|missing)|playwright.*install/iu.test(raw)) {
    return "Chromium is unavailable. Run \"tvdoctor setup\" and try again.";
  }
  if (/timeout|timed out|ERR_(?:CONNECTION|NAME|TIMED)|ECONNREFUSED|ENOTFOUND/iu.test(raw)) {
    return "The target did not become reachable in time. Check the URL and network, then try again.";
  }
  if (activity === "replay" && /json|schema|report|parse|unexpected token/iu.test(raw)) {
    return "The replay report is unreadable or incompatible. Check --report points to a valid TVDoctor V1 JSON report.";
  }
  const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
  return `${sanitizeTerminalText(firstLine, { maximumLength: 240 })} Check the command inputs and try again.`;
}

/**
 * Make the first web scan self-starting while keeping runtime setup injectable
 * for tests and alternate hosts. A successful probe is intentionally silent;
 * only the recovery path is surfaced to the user.
 */
export async function ensureWebRuntime(context: CliContext): Promise<boolean> {
  if (context.runtimeProbe === undefined) return true;
  try {
    await context.runtimeProbe();
    return true;
  } catch {
    if (context.runtimeSetup === undefined) {
      writeLine(
        context.io.writeStderr,
        "Chromium is required for web audits, but automatic setup is unavailable in this CLI host.",
      );
      return false;
    }
    writeLine(
      context.io.writeStdout,
      "Chromium runtime not found. Installing the matched runtime...",
    );
    try {
      await context.runtimeSetup(context.signal);
      await context.runtimeProbe();
    } catch (setupError) {
      const raw = setupError instanceof Error ? setupError.message : String(setupError);
      const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
      writeLine(
        context.io.writeStderr,
        `Chromium setup failed: ${sanitizeTerminalText(firstLine, { maximumLength: 240 })}`,
      );
      return false;
    }
    writeLine(context.io.writeStdout, "Chromium is installed and ready for TVDoctor.");
    return true;
  }
}

function summaryMetric(details: readonly string[], pattern: RegExp): string {
  for (const detail of details) {
    const match = pattern.exec(detail);
    if (match?.[1] !== undefined) return match[1];
  }
  return "unavailable";
}

function writeAuditSummary(
  write: (text: string) => void,
  result: Pick<TestCommandResult, "details" | "issueCount" | "reportPath">,
): void {
  const actions = summaryMetric(result.details, /^Actions\s+(\d+(?:\/\d+)?)/iu);
  const states = summaryMetric(result.details, /^States\s+(\d+(?:\/\d+)?)/iu);
  const transitions = summaryMetric(result.details, /^Transitions\s+(\d+(?:\/\d+)?)/iu);
  writeLine(
    write,
    `Summary: actions ${actions}; states ${states}; transitions ${transitions}; findings ${String(result.issueCount)}.`,
  );
  if (result.reportPath !== null) {
    writeLine(write, `Report: ${join(dirname(result.reportPath), "report.html")}`, 1_024);
  }
}

function writeComparisonSummary(
  write: (text: string) => void,
  result: BaselineCompareResult,
): void {
  writeLine(write, `Status: ${result.status.toUpperCase()}`);
  writeLine(
    write,
    `Comparison summary: findings +${String(result.newIssues)}/-${String(result.resolvedIssues)}; focus targets +${String(result.addedFocusTargets)}/-${String(result.removedFocusTargets)}; directional transitions ${String(result.directionalTransitionChanges)}; latency regressions ${String(result.latencyRegressions)}.`,
  );
  writeLine(write, `Next action: Review comparison: ${result.markdownPath ?? result.outputPath}`, 1_024);
}

function parseReplayArguments(
  argumentsAfterCommand: readonly string[],
): ReplayCommandRequest | string {
  let issueId: string | undefined;
  let reportPath = "tvdoctor-report/report.json";
  let targetOverride: string | undefined;
  let apkPath: string | undefined;
  let deviceSerial: string | undefined;
  let adbPath: string | undefined;
  let journeyPath: string | undefined;
  let authReadyRole: "heading" | "region" | "button" | undefined;
  let authReadyName: string | undefined;

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;

    if (["--report", "--target", "--apk", "--device", "--adb", "--journey",
      "--auth-ready-role", "--auth-ready-name"].includes(argument)) {
      const value = argumentsAfterCommand[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return `${argument} requires a value`;
      }
      if (argument === "--report") reportPath = value;
      else if (argument === "--apk") {
        if (!/\.apk$/iu.test(value)) return "--apk must reference an .apk file";
        apkPath = value;
      } else if (argument === "--device") {
        if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) return "--device must be a valid Android serial";
        deviceSerial = value;
      } else if (argument === "--adb") {
        adbPath = value;
      } else if (argument === "--journey") {
        journeyPath = value;
      } else if (argument === "--auth-ready-role") {
        if (authReadyRole !== undefined || (value !== "heading" && value !== "region" && value !== "button")) {
          return "--auth-ready-role requires an unambiguous supported role";
        }
        authReadyRole = value;
      } else if (argument === "--auth-ready-name") {
        if (authReadyName !== undefined || value.length === 0 || value.length > 128
          || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) {
          return "--auth-ready-name requires bounded printable accessible text";
        }
        authReadyName = value;
      } else {
        const override = safeTarget(value);
        if (override === null) return "--target must be an absolute HTTP(S) URL without credentials";
        targetOverride = override;
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) return `unknown replay option: ${argument}`;
    if (issueId !== undefined) return `replay accepts exactly one ISSUE_ID`;
    issueId = argument;
  }

  if (issueId === undefined || issueId.trim().length === 0) {
    return "replay requires an ISSUE_ID";
  }
  if (issueId.length > 256 || !PORTABLE_IDENTIFIER_PATTERN.test(issueId)) {
    return "ISSUE_ID must be a portable identifier";
  }
  if ((authReadyRole === undefined) !== (authReadyName === undefined)
    || (authReadyRole !== undefined && (journeyPath === undefined || targetOverride === undefined || apkPath !== undefined))) {
    return "Protected replay needs the original role/name, approved journey and exact target";
  }

  return {
    issueId,
    reportPath,
    ...(targetOverride === undefined ? {} : { targetOverride }),
    ...(apkPath === undefined ? {} : { apkPath }),
    ...(deviceSerial === undefined ? {} : { deviceSerial }),
    ...(adbPath === undefined ? {} : { adbPath }),
    ...(journeyPath === undefined ? {} : { journeyPath }),
    ...(authReadyRole === undefined || authReadyName === undefined
      ? {} : { authReady: { role: authReadyRole, name: authReadyName } }),
  };
}

export function safeTarget(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username.length > 0
    || parsed.password.length > 0) {
    return null;
  }
  // Return the URL parser's canonical form so ignored whitespace, backslash
  // path separators, Unicode host spelling, and equivalent default ports do
  // not create different audit/replay identities for the same destination.
  return parsed.href;
}

function parseTestArguments(
  argumentsAfterCommand: readonly string[],
  ciMode = false,
  allowBaseline = false,
): TestCommandRequest | string {
  let target: string | undefined;
  const packs: TestPackName[] = [];
  let mode: TestRunMode = "standard";
  let explicitOutputPath: string | undefined;
  let searchQuery = "N";
  let startupActions: RemoteKey[] | undefined;
  let maxDurationMs: number | undefined;
  const navigationBudgets: Partial<Record<keyof ExplorationBudgets, number>> = {};
  let disableRepetitionCompression = false;
  let fixtureProfileSelection = false;
  let ciFailOn: CiFailureThreshold | undefined;
  let baselinePath: string | undefined;
  let screenshots = true;
  let recordVideo = false;
  let targetRedaction: "origin" | undefined;
  let journeyPath: string | undefined;

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;
    if (argument === "--no-screenshots") {
      screenshots = false;
      continue;
    }
    if (argument === "--record-video") {
      recordVideo = true;
      continue;
    }
    if (argument === "--no-compression") {
      disableRepetitionCompression = true;
      continue;
    }
    if (argument === "--fixture-profile-select") {
      fixtureProfileSelection = true;
      continue;
    }
    const options = ["--pack", "--mode", "--output", "--query", "--startup-actions", "--max-duration-ms", "--max-actions", "--max-states", "--max-depth", "--journey", "--target-redaction"];
    if (ciMode) options.push("--fail-on");
    if (allowBaseline) options.push("--baseline");
    if (options.includes(argument)) {
      const value = argumentsAfterCommand[index + 1];
      if (value === undefined || value.startsWith("--")) return `${argument} requires a value`;
      if (argument === "--pack") {
        if (!TEST_PACK_SET.has(value)) return `unknown test pack: ${value}`;
        packs.push(value as TestPackName);
      } else if (argument === "--mode") {
        if (!TEST_RUN_MODES.has(value)) return `unknown test mode: ${value}`;
        mode = value as TestRunMode;
      } else if (argument === "--output") {
        if (value.trim().length === 0 || value.length > 1_024) return "--output requires a bounded non-empty path";
        explicitOutputPath = value;
      } else if (argument === "--startup-actions") {
        const requested = value.split(",").map((key) => key.trim()).filter((key) => key.length > 0);
        if (requested.length === 0) return "--startup-actions requires at least one remote key";
        if (requested.length > 64) return "--startup-actions accepts no more than 64 remote keys";
        if (requested.some((key) => !REMOTE_KEY_SET.has(key))) return "--startup-actions accepts only known remote keys";
        startupActions = requested as RemoteKey[];
      } else if (argument === "--max-duration-ms") {
        if (!/^[0-9]+$/u.test(value)) {
          return "--max-duration-ms must be a positive safe integer no greater than 2147483647";
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
          return "--max-duration-ms must be a positive safe integer no greater than 2147483647";
        }
        maxDurationMs = parsed;
      } else if (argument === "--max-actions" || argument === "--max-states" || argument === "--max-depth") {
        const budgetKey = argument === "--max-actions" ? "maxActions"
          : argument === "--max-states" ? "maxStates" : "maxDepth";
        const maximum = MAX_EXPLORATION_BUDGETS[budgetKey];
        if (!/^[0-9]+$/u.test(value)) {
          return `${argument} must be a ${budgetKey === "maxDepth" ? "non-negative" : "positive"} safe integer no greater than ${String(maximum)}`;
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < (budgetKey === "maxDepth" ? 0 : 1) || parsed > maximum) {
          return `${argument} must be a ${budgetKey === "maxDepth" ? "non-negative" : "positive"} safe integer no greater than ${String(maximum)}`;
        }
        navigationBudgets[budgetKey] = parsed;
      } else if (argument === "--fail-on") {
        if (!(CI_FAILURE_THRESHOLDS as readonly string[]).includes(value)) {
          return "--fail-on must be any, critical, high, medium, low, info, or never";
        }
        ciFailOn = value as CiFailureThreshold;
      } else if (argument === "--journey") {
        journeyPath = value;
      } else if (argument === "--baseline") {
        if (value.trim().length === 0 || value.length > 1_024 || value.includes("\0")) {
          return "--baseline requires a bounded non-empty path";
        }
        baselinePath = value;
      } else if (argument === "--target-redaction") {
        if (value !== "origin") return "--target-redaction must be origin";
        targetRedaction = "origin";
      } else {
        const safe = sanitizeTerminalText(value, { maximumLength: 64 });
        if (safe.length === 0 || safe !== value.trim()) {
          return "--query must be printable, non-empty, and at most 64 characters";
        }
        searchQuery = safe;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) return `unknown test option: ${argument}`;
    if (target !== undefined) return "test accepts exactly one URL";
    target = argument;
  }

  if (target === undefined) return "test requires a URL";
  if (journeyPath !== undefined && startupActions !== undefined) {
    return "--journey cannot be combined with --startup-actions";
  }
  if (ciMode && ciFailOn === undefined) return "ci requires --fail-on LEVEL";
  const parsedTarget = safeTarget(target);
  if (parsedTarget === null) return "test target must be an absolute HTTP(S) URL without credentials";
  const selected = packs.length === 0 ? ["navigation" as const] : [...new Set(packs)];
  if (selected.includes("all") && selected.length > 1) return "--pack all cannot be combined with another pack";
  if (fixtureProfileSelection) {
    const host = new URL(parsedTarget).hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      return "--fixture-profile-select is restricted to localhost/loopback fixture URLs";
    }
    if (!selected.includes("navigation") && !selected.includes("all")) {
      return "--fixture-profile-select requires the navigation pack";
    }
  }
  return {
    target: parsedTarget,
    packs: selected,
    mode,
    outputPath: explicitOutputPath ?? defaultOutputDirectory({ target: parsedTarget, mode }),
    searchQuery,
    ...(startupActions === undefined ? {} : { startupActions }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(Object.keys(navigationBudgets).length === 0 ? {} : { navigationBudgets }),
    ...(disableRepetitionCompression ? { disableRepetitionCompression: true } : {}),
    ...(fixtureProfileSelection ? { fixtureProfileSelection: true } : {}),
    ...(ciFailOn === undefined ? {} : { ciFailOn }),
    ...(baselinePath === undefined ? {} : { baselinePath }),
    ...(screenshots ? {} : { screenshots: false }),
    ...(recordVideo ? { recordVideo: true } : {}),
    ...(targetRedaction === undefined ? {} : { targetRedaction }),
    ...(journeyPath === undefined ? {} : { journeyPath }),
  };
}

function parseExportTestArguments(
  argumentsAfterCommand: readonly string[],
): { readonly issueId: string; readonly reportPath: string; readonly outputPath: string } | string {
  let issueId: string | undefined;
  let reportPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === "--report" || argument === "--output") {
      if ((argument === "--report" && reportPath !== undefined)
        || (argument === "--output" && outputPath !== undefined)) {
        return `duplicate export-test option: ${argument}`;
      }
      const value = argumentsAfterCommand[index + 1];
      if (value === undefined || value.startsWith("--") || value.trim().length === 0
        || value.length > 1_024) {
        return `${argument} requires a bounded non-empty path`;
      }
      if (argument === "--report") reportPath = value;
      else outputPath = value;
      index += 1;
    } else if (argument?.startsWith("--")) {
      return `unknown export-test option: ${argument}`;
    } else if (argument !== undefined) {
      if (issueId !== undefined) return "export-test accepts exactly one ISSUE_ID";
      issueId = argument;
    }
  }
  if (issueId === undefined || !PORTABLE_IDENTIFIER_PATTERN.test(issueId) || issueId.length > 256) {
    return "export-test requires a portable ISSUE_ID";
  }
  if (reportPath === undefined) return "export-test requires --report PATH";
  if (outputPath === undefined) return "export-test requires --output PATH";
  if (!/\.(?:spec|test)\.js$/u.test(outputPath)) {
    return "--output must end in .spec.js or .test.js";
  }
  return { issueId, reportPath, outputPath };
}

type ParsedBaselineCommand =
  | ({ readonly action: "create" } & BaselineCreateRequest)
  | ({ readonly action: "compare" } & BaselineCompareRequest);

function parseBaselineArguments(argumentsAfterCommand: readonly string[]): ParsedBaselineCommand | string {
  const [action, ...options] = argumentsAfterCommand;
  if (action !== "create" && action !== "compare") {
    return "baseline requires create or compare";
  }
  let reportPath: string | undefined;
  let inventoryPath: string | undefined;
  let outputPath: string | undefined;
  let baselinePath: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === undefined) continue;
    if (!["--report", "--inventory", "--output", "--baseline"].includes(option)) {
      return `unknown baseline option: ${option}`;
    }
    if (action === "create" && option === "--baseline") {
      return "baseline create does not accept --baseline";
    }
    const value = options[index + 1];
    if (value === undefined || value.startsWith("--")) return `${option} requires a value`;
    if (value.trim().length === 0 || value.length > 1_024) return `${option} requires a bounded non-empty path`;
    if (option === "--report") reportPath = value;
    else if (option === "--inventory") inventoryPath = value;
    else if (option === "--output") outputPath = value;
    else baselinePath = value;
    index += 1;
  }
  if (reportPath === undefined) return "baseline requires --report PATH";
  const resolvedInventory = inventoryPath ?? join(dirname(reportPath), "inventory.json");
  if (action === "create") {
    return {
      action,
      reportPath,
      inventoryPath: resolvedInventory,
      outputPath: outputPath ?? "tvdoctor-baseline.json",
    };
  }
  if (baselinePath === undefined) return "baseline compare requires --baseline PATH";
  return {
    action,
    baselinePath,
    reportPath,
    inventoryPath: resolvedInventory,
    outputPath: outputPath ?? join(dirname(reportPath), "baseline-comparison.json"),
  };
}

interface AndroidTestCommandRequest {
  readonly apkPath: string;
  readonly serial?: string;
  readonly adbPath?: string;
  readonly mode: "quick" | "deep";
  readonly outputPath: string;
  readonly screenshots?: boolean;
}

function parseAndroidTestArguments(argumentsAfterCommand: readonly string[]): AndroidTestCommandRequest | string {
  let apkPath: string | undefined;
  let serial: string | undefined;
  let adbPath: string | undefined;
  let mode: "quick" | "deep" = "quick";
  let outputPath: string | undefined;
  let screenshots = true;
  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;
    if (argument === "--no-screenshots") {
      screenshots = false;
      continue;
    }
    if (argument === "--record-video") {
      return "--record-video is available only for web audits";
    }
    if (!["--apk", "--device", "--adb", "--mode", "--output"].includes(argument)) {
      return argument.startsWith("--") ? `unknown Android test option: ${argument}` : "Android test does not accept a positional URL";
    }
    const value = argumentsAfterCommand[index + 1];
    if (value === undefined || value.startsWith("--")) return `${argument} requires a value`;
    if (value.trim().length === 0 || value.length > 1_024 || value.includes("\0")) return `${argument} requires a bounded non-empty value`;
    if (argument === "--apk") apkPath = value;
    else if (argument === "--device") serial = value;
    else if (argument === "--adb") adbPath = value;
    else if (argument === "--output") outputPath = value;
    else if (value === "quick" || value === "deep") mode = value;
    else return "Android --mode must be quick or deep";
    index += 1;
  }
  if (apkPath === undefined) return "Android test requires --apk PATH";
  if (!/\.apk$/iu.test(apkPath)) return "--apk must reference an .apk file";
  if (serial !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/u.test(serial)) return "--device must be a valid Android serial";
  return {
    apkPath,
    ...(serial === undefined ? {} : { serial }),
    mode,
    outputPath: outputPath ?? defaultOutputDirectory({
      target: basename(apkPath, ".apk"),
      mode,
      platform: "android-tv",
    }),
    ...(adbPath === undefined ? {} : { adbPath }),
    ...(screenshots ? {} : { screenshots: false }),
  };
}

async function runAndroidTest(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  const request = parseAndroidTestArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  if (context.operations?.scanAndroidApk === undefined) {
    writeLine(context.io.writeStderr, "Android audit is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  let serial = request.serial;
  if (serial === undefined) {
    if (context.operations.androidPreflight === undefined) {
      return usageError(context, "Android test requires --device SERIAL when device auto-selection is unavailable");
    }
    let preflight: AndroidPreflightResult;
    try {
      preflight = await context.operations.androidPreflight(request.adbPath);
    } catch (error) {
      writeLine(
        context.io.writeStderr,
        `Android device discovery failed: ${classifyCliError(error, "audit")}`,
      );
      return EXIT_CODES.executionError;
    }
    if (!preflight.available) {
      writeLine(
        context.io.writeStderr,
        `Android environment unavailable: ${sanitizeTerminalText(preflight.message, { maximumLength: 512 })}`,
      );
      return EXIT_CODES.environmentFailure;
    }
    const readyDevices = preflight.devices.filter((device) => device.online);
    if (readyDevices.length === 0) {
      writeLine(
        context.io.writeStderr,
        "No online authorized Android device was found. Start or connect a device, accept ADB authorization, and retry.",
      );
      return EXIT_CODES.environmentFailure;
    }
    if (readyDevices.length > 1) {
      return usageError(
        context,
        `Android test could not auto-select a device: ${String(readyDevices.length)} online devices were found; pass --device SERIAL`,
      );
    }
    serial = readyDevices[0]?.serial;
    if (serial === undefined) {
      return usageError(context, "Android test could not auto-select a device; pass --device SERIAL");
    }
    writeLine(context.io.writeStdout, `Using the only online Android device: ${serial}`);
  }
  writeLine(context.io.writeStdout, `Auditing Android APK ${basename(request.apkPath)} on ${serial}...`);
  writeLine(context.io.writeStdout, `Plan: ${request.mode} remote-navigation scan; observer setup must already be authorized.`);
  let result: AndroidScanResult;
  try {
    result = await context.operations.scanAndroidApk({
      apkPath: request.apkPath,
      serial,
      mode: request.mode,
      outputPath: request.outputPath,
      ...(request.adbPath === undefined ? {} : { adbPath: request.adbPath }),
      ...(request.screenshots === false ? { screenshots: false } : {}),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.terminalProgress?.isInteractive === true
        ? {
            onProgress: (progress) => context.terminalProgress?.update(
              `${serial} | ${request.mode} remote-navigation scan | ${String(progress.actions)} actions | ${String(progress.elapsedSeconds)}s`,
            ),
          }
        : {}),
    });
  } catch (error) {
    writeLine(context.io.writeStderr, `Android audit failed: ${classifyCliError(error, "audit")}`);
    return EXIT_CODES.executionError;
  } finally {
    context.terminalProgress?.finish();
  }
  const statusLabel = result.status === "completed" ? "COMPLETED"
    : result.status === "partial" ? "PARTIAL-INCONCLUSIVE"
      : result.status === "setup-blocker" ? "SETUP-BLOCKED" : "FAILED";
  writeLine(context.io.writeStdout, `Result: ${statusLabel}`);
  writeDetails(context.io.writeStdout, result.details);
  const issueNoun = result.issueCount === 1 ? "issue" : "issues";
  writeLine(
    context.io.writeStdout,
    `Issues: ${String(result.issueCount)} ${issueNoun}; highest severity: ${result.highestSeverity ?? "none"}`,
  );
  if (result.reportPath !== null) {
    const bundleDirectory = dirname(result.reportPath);
    writeLine(context.io.writeStdout, `Open report: ${join(bundleDirectory, "report.html")}`, 1_024);
  }
  if (result.status === "failed") return EXIT_CODES.executionError;
  if (result.status === "partial" || result.status === "setup-blocker") return EXIT_CODES.inconclusive;
  return result.issueCount > 0 ? EXIT_CODES.environmentFailure : EXIT_CODES.success;
}

async function runTest(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, TEST_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.includes("--apk")) {
    return await runAndroidTest(argumentsAfterCommand, context);
  }
  const request = parseTestArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  return await runWebTestRequest(request, context);
}

async function runScan(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, SCAN_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.includes("--pack")) {
    return usageError(context, "scan is navigation-only; use tvdoctor test --pack NAME for diagnostic packs");
  }
  if (argumentsAfterCommand.includes("--apk")) {
    return usageError(context, "scan accepts web URLs; use tvdoctor test --apk PATH for Android TV");
  }
  let inputMode: "remote" | "keyboard" = "remote";
  let inputSpecified = false;
  let keyboardInteractions = false;
  const inputFilteredArguments: string[] = [];
  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === "--keyboard-interactions") {
      if (keyboardInteractions) return usageError(context, "--keyboard-interactions may be specified only once");
      keyboardInteractions = true;
      continue;
    }
    if (argument !== "--input") {
      if (argument !== undefined) inputFilteredArguments.push(argument);
      continue;
    }
    if (inputSpecified) return usageError(context, "--input may be specified only once");
    const value = argumentsAfterCommand[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return usageError(context, "--input requires remote or keyboard");
    }
    if (value !== "remote" && value !== "keyboard") {
      return usageError(context, "--input must be remote or keyboard");
    }
    inputSpecified = true;
    inputMode = value;
    index += 1;
  }
  const modeIndex = inputFilteredArguments.indexOf("--mode");
  const scanArguments = modeIndex >= 0
    ? inputFilteredArguments
    : [...inputFilteredArguments, "--mode", "standard"];
  const request = parseTestArguments(scanArguments, false, true);
  if (typeof request === "string") return usageError(context, request);
  if (keyboardInteractions && inputMode !== "keyboard") {
    return usageError(context, "--keyboard-interactions requires --input keyboard");
  }
  writeLine(context.io.writeStdout, "Phase: SCAN");
  return await runWebTestRequest({
    ...request,
    disableRepetitionCompression: true,
    ...(inputMode === "keyboard" ? { inputMode } : {}),
    ...(keyboardInteractions ? { keyboardInteractions: true } : {}),
  }, context);
}

async function runAccessibility(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, ACCESSIBILITY_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.includes("--pack")) {
    return usageError(context, "accessibility selects its packs automatically; remove --pack");
  }
  if (argumentsAfterCommand.includes("--apk")) {
    return usageError(context, "accessibility currently accepts web URLs; Android hardware proof is not yet available");
  }
  const request = parseTestArguments([
    ...argumentsAfterCommand,
    "--pack",
    "streaming",
    "--pack",
    "accessibility",
  ]);
  if (typeof request === "string") return usageError(context, request);
  return await runWebTestRequest(request, context);
}

async function runCi(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, CI_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.includes("--apk")) {
    return usageError(context, "ci currently accepts web URLs; use tvdoctor test for Android APKs");
  }
  const request = parseTestArguments(argumentsAfterCommand, true, true);
  if (typeof request === "string") return usageError(context, request);
  return await runWebTestRequest(request, context);
}

async function runWebTestRequest(
  request: TestCommandRequest,
  context: CliContext,
): Promise<number> {
  if (context.operations?.testTarget === undefined) {
    writeLine(context.io.writeStderr, "Web audit is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  if (!await ensureWebRuntime(context)) return EXIT_CODES.environmentFailure;
  writeLine(context.io.writeStdout, `Target: ${safeDisplayUrl(request.target)}`);
  writeLine(context.io.writeStdout, "Status: RUNNING");
  writeLine(context.io.writeStdout, `Auditing ${safeDisplayUrl(request.target)}...`);
  writeLine(
    context.io.writeStdout,
    `Plan: ${request.mode} mode; ${
      request.inputMode === "keyboard"
        ? "keyboard navigation (Tab / Shift+Tab)"
        : request.packs.length === 1 && request.packs[0] === "navigation"
        ? "remote navigation"
        : `packs ${request.packs.join(", ")}`
    }; startup preparation ${
      request.startupActions === undefined ? "observation-only" : "explicit remote sequence"
    }; bounded resets and replays can take several minutes.`,
  );
  let result: TestCommandResult;
  const { baselinePath, ...auditRequest } = request;
  const progressStartedAt = Date.now();
  const interactive = context.terminalProgress?.isInteractive === true;
  const progressTimer = setInterval(() => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1_000));
    const message = `${safeDisplayUrl(request.target)} | ${request.mode} ${request.inputMode === "keyboard" ? "keyboard " : ""}scan | elapsed ${elapsedSeconds}s`;
    if (interactive) context.terminalProgress?.update(message);
    else writeLine(context.io.writeStdout, `Progress: ${message}; budgets remain enforced.`);
  }, interactive ? 1_000 : 30_000);
  progressTimer.unref();
  try {
    const sourceRoot = auditRequest.sourceRoot ?? context.sourceRoot;
    result = await context.operations.testTarget({
      ...auditRequest,
      ...(sourceRoot === undefined ? {} : { sourceRoot }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    writeLine(context.io.writeStdout, "Status: FAILED");
    writeLine(context.io.writeStderr, `Audit failed: ${classifyCliError(error, "audit")}`);
    return EXIT_CODES.executionError;
  } finally {
    clearInterval(progressTimer);
    if (interactive) context.terminalProgress?.finish();
  }
  const statusLabel = result.status === "completed"
    ? "COMPLETED"
    : result.status === "partial"
      ? "PARTIAL-INCONCLUSIVE"
      : "FAILED";
  writeLine(context.io.writeStdout, `Status: ${statusLabel}`);
  writeLine(context.io.writeStdout, `Result: ${statusLabel}`);
  writeDetails(context.io.writeStdout, result.details);
  const issueNoun = result.issueCount === 1 ? "issue" : "issues";
  writeLine(
    context.io.writeStdout,
    `Issues: ${String(result.issueCount)} ${issueNoun}; highest severity: ${result.highestSeverity ?? "none"}`,
  );
  writeAuditSummary(context.io.writeStdout, result);
  if (result.reportPath !== null) {
    const bundleDirectory = dirname(result.reportPath);
    writeLine(context.io.writeStdout, `Open report: ${join(bundleDirectory, "report.html")}`, 1_024);
    if (request.ciFailOn !== undefined) {
      writeLine(context.io.writeStdout, `CI summary: ${join(bundleDirectory, "exports", "ci-summary.md")}`, 1_024);
      writeLine(context.io.writeStdout, `JUnit: ${join(bundleDirectory, "exports", "junit.xml")}`, 1_024);
    }
  }
  let comparisonResult: BaselineCompareResult | null = null;
  if (baselinePath !== undefined) {
    writeLine(context.io.writeStdout, "Phase: BASELINE COMPARISON");
    writeLine(context.io.writeStdout, "Status: RUNNING");
    if (result.reportPath === null) {
      writeLine(context.io.writeStderr, "Baseline comparison unavailable: the audit did not produce a report.");
      return result.status === "partial" ? EXIT_CODES.inconclusive : EXIT_CODES.executionError;
    }
    if (context.operations?.compareBaseline === undefined) {
      writeLine(context.io.writeStderr, "Baseline comparison is unavailable in this CLI host.");
      return EXIT_CODES.executionError;
    }
    const bundleDirectory = dirname(result.reportPath);
    try {
      comparisonResult = await context.operations.compareBaseline({
        baselinePath,
        reportPath: result.reportPath,
        inventoryPath: join(bundleDirectory, "inventory.json"),
        outputPath: join(bundleDirectory, "baseline-comparison.json"),
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
      writeLine(
        context.io.writeStderr,
        `Baseline comparison failed: ${sanitizeTerminalText(firstLine, { maximumLength: 500 })}`,
      );
      if (request.ciFailOn !== undefined) {
        try {
          await reconcileCiBaselineExports(request.outputPath, result.reportPath, {
            status: "failed-closed", shouldFail: true,
          });
        } catch (exportError) {
          writeLine(context.io.writeStderr, `CI baseline export update failed: ${classifyCliError(exportError, "audit")}`);
        }
      }
      return EXIT_CODES.executionError;
    }
    if (request.ciFailOn !== undefined) {
      try {
        await reconcileCiBaselineExports(request.outputPath, result.reportPath, comparisonResult);
      } catch (exportError) {
        writeLine(context.io.writeStderr, `CI baseline export update failed: ${classifyCliError(exportError, "audit")}`);
        return EXIT_CODES.executionError;
      }
    }
    writeLine(context.io.writeStdout, `Baseline result: ${comparisonResult.status.toUpperCase()}`);
    writeComparisonSummary(context.io.writeStdout, comparisonResult);
    writeLine(
      context.io.writeStdout,
      `${String(comparisonResult.newIssues)} introduced, ${String(comparisonResult.resolvedIssues)} resolved findings.`,
    );
    writeLine(
      context.io.writeStdout,
      `Focus targets: ${String(comparisonResult.addedFocusTargets)} added, ${String(comparisonResult.removedFocusTargets)} removed.`,
    );
    writeLine(
      context.io.writeStdout,
      `Directional transition changes: ${String(comparisonResult.directionalTransitionChanges)}; latency regressions: ${String(comparisonResult.latencyRegressions)}.`,
    );
    for (const blocker of comparisonResult.blockers) {
      writeLine(context.io.writeStdout, `Blocked: ${blocker}`, 1_024);
    }
    writeLine(context.io.writeStdout, `Comparison: ${comparisonResult.outputPath}`, 1_024);
    if (comparisonResult.markdownPath !== undefined) {
      writeLine(context.io.writeStdout, `Readable comparison: ${comparisonResult.markdownPath}`, 1_024);
    }
  }
  if (result.status === "failed") return EXIT_CODES.executionError;
  if (result.status === "partial") {
    writeLine(
      context.io.writeStdout,
      "Next action: Review the partial report, resolve the recorded interruption, and rerun the audit.",
    );
    return EXIT_CODES.inconclusive;
  }
  if (comparisonResult?.shouldFail === true
    || comparisonResult?.status === "regressed"
    || comparisonResult?.status === "failed-closed") return EXIT_CODES.environmentFailure;
  const gatedSeverity = result.highestVerifiedSeverity === undefined
    ? result.highestSeverity
    : result.highestVerifiedSeverity;
  const violatesPolicy = request.ciFailOn === undefined
    ? baselinePath === undefined && result.issueCount > 0
    : gatedSeverity !== null && issueViolatesPolicy(gatedSeverity, request.ciFailOn);
  if (violatesPolicy) {
    if (result.reportPath !== null) {
      writeLine(
        context.io.writeStdout,
        "Next action: Open the report and replay a VERIFIED finding before accepting the run.",
      );
    }
    return EXIT_CODES.environmentFailure;
  }
  if (result.issueCount > 0 && result.reportPath !== null) {
    writeLine(
      context.io.writeStdout,
      "Next action: Open the report and replay a VERIFIED finding before accepting the run.",
    );
  }
  return EXIT_CODES.success;
}

async function runReplay(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (
    argumentsAfterCommand.length === 1 &&
    (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")
  ) {
    writeBlock(context.io.writeStdout, REPLAY_HELP_TEXT);
    return EXIT_CODES.success;
  }

  const request = parseReplayArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  if (context.operations === undefined) {
    writeLine(context.io.writeStderr, "Replay is unavailable in this CLI host.");
    return EXIT_CODES.replayError;
  }

  writeLine(context.io.writeStdout, "Phase: REPLAY");
  writeLine(context.io.writeStdout, "Status: RUNNING");
  writeLine(context.io.writeStdout, `Replaying ${request.issueId}...`);
  let result: ReplayCommandResult;
  try {
    result = await context.operations.replayIssue({
      ...request,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    writeLine(context.io.writeStdout, "Status: ERROR");
    writeLine(context.io.writeStderr, `Replay failed: ${classifyCliError(error, "replay")}`);
    return EXIT_CODES.replayError;
  }

  writeDetails(context.io.writeStdout, result.details);
  writeLine(context.io.writeStdout, `Status: ${result.status.toUpperCase()}`);
  writeLine(context.io.writeStdout, `Report: ${request.reportPath}`, 1_024);
  switch (result.status) {
    case "fixed":
      writeLine(context.io.writeStdout, `${request.issueId} FIXED`);
      writeLine(context.io.writeStdout, "Next action: Review the report evidence before closing the finding.");
      return EXIT_CODES.success;
    case "reproduced":
      writeLine(context.io.writeStdout, "Issue reproduced.");
      writeLine(context.io.writeStdout, "Next action: Open the report and fix the reproduced finding, then rerun replay.");
      return EXIT_CODES.environmentFailure;
    case "inconclusive":
      writeLine(context.io.writeStdout, "Replay inconclusive.");
      writeLine(context.io.writeStdout, "Next action: Review the report and replay details, resolve the blocker, then retry.");
      return EXIT_CODES.replayInconclusive;
    case "error":
      writeLine(context.io.writeStdout, "Next action: Review the report and replay details before retrying.");
      writeLine(context.io.writeStderr, "Replay failed.");
      return EXIT_CODES.replayError;
  }
}

function parseVerifyFixArguments(args: readonly string[]): VerifyWorkflowRequest | string {
  const [issueId, ...options] = args;
  if (issueId === undefined || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(issueId)) {
    return "verify-fix requires one bounded ISSUE_ID before its options";
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--authorized" || option === "--compare" || option === "--screenshots") {
      if (flags.has(option)) return `duplicate verify-fix option: ${option}`;
      flags.add(option);
      continue;
    }
    if (!["--report", "--target", "--sha256", "--journey", "--auth-ready-role", "--auth-ready-name", "--scan-output", "--max-duration-ms", "--max-actions"].includes(option ?? "")) {
      return `unknown verify-fix option: ${option ?? "(missing)"}`;
    }
    const value = options[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0
      || value.length > 1_024 || values.has(option ?? "")) {
      return `${option} requires one bounded non-empty value and may not repeat`;
    }
    values.set(option ?? "", value);
    index += 1;
  }
  if (!flags.has("--authorized")) return "verify-fix requires explicit --authorized consent for browser operations";
  const reportPath = values.get("--report");
  if (reportPath === undefined) return "verify-fix requires --report PATH";
  const target = values.get("--target");
  if (target !== undefined && safeTarget(target) === null) {
    return "--target must be an absolute credential-free HTTP(S) URL";
  }
  const digest = values.get("--sha256");
  if (digest !== undefined && !/^[0-9a-f]{64}$/u.test(digest)) {
    return "--sha256 must be a lowercase 64-character SHA-256 hex digest";
  }
  const scanOutput = values.get("--scan-output");
  if (scanOutput === undefined && (flags.has("--compare") || flags.has("--screenshots")
    || values.has("--max-duration-ms") || values.has("--max-actions"))) {
    return "--compare, --screenshots, --max-duration-ms and --max-actions require --scan-output PATH";
  }
  const durationString = values.get("--max-duration-ms");
  const duration = durationString === undefined ? undefined : Number(durationString);
  if (durationString !== undefined && (!/^[0-9]+$/u.test(durationString)
    || !Number.isSafeInteger(duration) || (duration ?? 0) < 1 || (duration ?? 0) > 600_000)) {
    return "--max-duration-ms must be a positive integer no greater than 600000";
  }
  const actionsString = values.get("--max-actions");
  const actions = actionsString === undefined ? undefined : Number(actionsString);
  if (actionsString !== undefined && (!/^[0-9]+$/u.test(actionsString)
    || !Number.isSafeInteger(actions) || (actions ?? 0) < 1 || (actions ?? 0) > MAX_EXPLORATION_BUDGETS.maxActions)) {
    return `--max-actions must be a positive integer no greater than ${String(MAX_EXPLORATION_BUDGETS.maxActions)}`;
  }
  const journeyPath = values.get("--journey");
  const authReadyRole = values.get("--auth-ready-role");
  const authReadyName = values.get("--auth-ready-name");
  if ((authReadyRole === undefined) !== (authReadyName === undefined)
    || (authReadyRole !== undefined && (journeyPath === undefined || target === undefined
      || (authReadyRole !== "heading" && authReadyRole !== "region" && authReadyRole !== "button")
      || authReadyName === undefined || authReadyName.length > 128
      || authReadyName.trim() !== authReadyName || /[\p{Cc}\p{Cf}]/u.test(authReadyName)))) {
    return "Protected verification requires a paired valid accessible role/name, pinned journey and target";
  }
  return {
    issueId, originalReportPath: reportPath, authorized: true,
    ...(target === undefined ? {} : { targetOverride: target }),
    ...(digest === undefined ? {} : { expectedOriginalSha256: digest }),
    ...(journeyPath === undefined ? {} : { journeyPath }),
    ...(authReadyRole === undefined || authReadyName === undefined
      ? {} : { authReady: { role: authReadyRole as "heading" | "region" | "button", name: authReadyName } }),
    ...(scanOutput === undefined ? {} : { freshScan: {
      outputPath: scanOutput,
      ...(flags.has("--compare") ? { compareToOriginal: true } : {}),
      ...(flags.has("--screenshots") ? { screenshots: true } : {}),
      ...(duration === undefined ? {} : { maxDurationMs: duration }),
      ...(actions === undefined ? {} : { maxActions: actions }),
    } }),
  };
}

async function runVerifyFix(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeBlock(context.io.writeStdout, VERIFY_FIX_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const parsed = parseVerifyFixArguments(args);
  if (typeof parsed === "string") return usageError(context, parsed);
  if (context.operations?.verifyOriginalFinding === undefined) {
    writeLine(context.io.writeStderr, "Independent verification is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  let result: VerifyWorkflowResult;
  try {
    result = await context.operations.verifyOriginalFinding({
      ...parsed,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    writeLine(context.io.writeStderr, `Independent verification failed: ${classifyCliError(error, "replay")}`);
    return EXIT_CODES.executionError;
  }
  // Structured CI output must never pass through terminal prose truncation:
  // long legitimate comparison blockers would otherwise become invalid JSON.
  context.io.writeStdout(`${JSON.stringify(result)}\n`);
  if (result.classification === "INCONCLUSIVE") return EXIT_CODES.inconclusive;
  return result.shouldFail ? EXIT_CODES.environmentFailure : EXIT_CODES.success;
}

async function runExportTest(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, EXPORT_TEST_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const request = parseExportTestArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  try {
    const result = await exportPlaywrightTest(request);
    writeLine(context.io.writeStdout, `Exported ${result.issueId} to ${result.outputPath}`, 1_024);
    writeLine(context.io.writeStdout, `Replay: ${String(result.steps)} recorded keyboard actions`);
    writeLine(context.io.writeStdout, "Set TVDOCTOR_AUTHORIZED_TARGET_URL to the approved target before running the generated Playwright test.");
    return EXIT_CODES.success;
  } catch (error) {
    writeLine(context.io.writeStderr, `Export failed: ${classifyCliError(error, "audit")}`);
    return EXIT_CODES.executionError;
  }
}

async function runDemo(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, DEMO_HELP_TEXT);
    return EXIT_CODES.success;
  }
  let outputPath = defaultOutputDirectory({
    target: "northstar-demo",
    mode: "quick",
    platform: "web",
  });
  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument !== "--output") {
      return usageError(context, `unknown demo option: ${argument ?? ""}`);
    }
    const value = argumentsAfterCommand[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0 || value.length > 1_024) {
      return usageError(context, "--output requires a bounded non-empty path");
    }
    outputPath = value;
    index += 1;
  }
  if (context.operations?.runDemo === undefined) {
    writeLine(context.io.writeStderr, "The deterministic demo is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Phase: DEMO");
  if (!await ensureWebRuntime(context)) return EXIT_CODES.environmentFailure;
  writeLine(context.io.writeStdout, "Status: RUNNING");
  writeLine(context.io.writeStdout, "Running the packaged Northstar D-pad demo...");
  writeLine(
    context.io.writeStdout,
    "This is a controlled seeded fixture: it proves the installed audit/report/replay path, not production-app accuracy.",
  );
  let result: DemoCommandResult;
  try {
    result = await context.operations.runDemo({
      outputPath,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    writeLine(context.io.writeStdout, "Status: FAILED");
    writeLine(context.io.writeStderr, `Demo failed: ${classifyCliError(error, "audit")}`);
    return EXIT_CODES.executionError;
  }
  writeDetails(context.io.writeStdout, result.details);
  if (result.status === "inconclusive") {
    writeLine(context.io.writeStdout, "Status: INCONCLUSIVE");
    if (result.reportPath !== null) {
      writeLine(context.io.writeStdout, `Review partial report: ${join(dirname(result.reportPath), "report.html")}`, 1_024);
    }
    writeLine(context.io.writeStdout, "Demo INCONCLUSIVE: the controlled audit or replay did not complete.");
    return EXIT_CODES.inconclusive;
  }
  if (result.status !== "verified"
    || result.issueId === null
    || result.reportPath === null
    || result.replayStatus !== "reproduced") {
    writeLine(context.io.writeStdout, "Status: FAILED");
    if (result.reportPath !== null) {
      writeLine(context.io.writeStdout, `Review report: ${join(dirname(result.reportPath), "report.html")}`, 1_024);
    }
    writeLine(context.io.writeStderr, "Demo could not verify its seeded navigation failure and replay proof.");
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Status: VERIFIED");
  writeAuditSummary(context.io.writeStdout, {
    details: result.details,
    issueCount: 1,
    reportPath: result.reportPath,
  });
  writeLine(context.io.writeStdout, "Demo VERIFIED: the seeded D-pad failure was found with deterministic evidence.");
  writeLine(context.io.writeStdout, `Issue: ${result.issueId}`);
  writeLine(context.io.writeStdout, "Replay: REPRODUCED");
  writeLine(
    context.io.writeStdout,
    `Replay command: tvdoctor replay ${result.issueId} --report "${result.reportPath}"`,
    2_048,
  );
  writeLine(
    context.io.writeStdout,
    `Next action: tvdoctor replay ${result.issueId} --report "${result.reportPath}"`,
    2_048,
  );
  const htmlReport = join(dirname(result.reportPath), "report.html");
  writeLine(context.io.writeStdout, `Open report: ${htmlReport}`, 1_024);
  if (context.terminalProgress?.isInteractive === true && context.reportActions !== undefined) {
    let opened: boolean;
    try {
      opened = await context.reportActions.openReport(htmlReport);
    } catch {
      opened = false;
    }
    writeLine(
      context.io.writeStdout,
      opened ? `Opened report: ${htmlReport}` : `Could not open the report automatically: ${htmlReport}`,
      1_024,
    );
  }
  return EXIT_CODES.success;
}

async function runDoctor(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (
    argumentsAfterCommand.length === 1 &&
    (argumentsAfterCommand[0] === "--help" ||
      argumentsAfterCommand[0] === "-h")
  ) {
    writeBlock(context.io.writeStdout, DOCTOR_HELP_TEXT);
    return EXIT_CODES.success;
  }

  if (argumentsAfterCommand.length > 0) {
    return usageError(
      context,
      `doctor does not accept arguments: ${argumentsAfterCommand.join(" ")}`,
    );
  }

  let browser: DiagnosticCheck = {
    status: "unavailable",
    detail: "Browser runtime probe is unavailable in this host",
  };
  if (context.runtimeProbe !== undefined) {
    try {
      const probe = await context.runtimeProbe();
      browser = {
        status: "ok",
        detail: `Chromium launched (${probe.capabilities.length === 0 ? "no capabilities reported" : probe.capabilities.join(", ")})`,
      };
    } catch (error) {
      browser = {
        status: "unavailable",
        detail: classifyCliError(error, "doctor"),
      };
    }
  }
  let adb: DiagnosticCheck = {
    status: "unavailable",
    detail: "Android platform-tools (ADB) were not probed.",
  };
  let buildTools: DiagnosticCheck = {
    status: "unavailable",
    detail: "Android SDK build-tools (aapt2/aapt) were not probed.",
  };
  let device: DiagnosticCheck = {
    status: "unavailable",
    detail: "No authorized Android TV device was found.",
  };
  let observer: DiagnosticCheck = {
    status: "unavailable",
    detail: "No authorized Android TV device is available to inspect Observer accessibility readiness.",
  };
  let androidAdbPath: string | null = null;
  let compatibleAndroidDevices: AndroidPreflightResult["devices"] = [];

  if (context.operations?.androidBuildToolsPreflight !== undefined) {
    try {
      const result = await context.operations.androidBuildToolsPreflight();
      buildTools = result.available
        ? { status: "ok", detail: result.detail }
        : {
            status: "unavailable",
            detail: `${result.detail} Install Android SDK build-tools (aapt2/aapt) to inspect APKs.`,
          };
    } catch (error) {
      buildTools = { status: "unavailable", detail: classifyCliError(error, "doctor") };
    }
  }

  if (context.operations?.androidPreflight !== undefined) {
    try {
      const result = await context.operations.androidPreflight();
      if (!result.available || result.adbPath === null) {
        adb = {
          status: "unavailable",
          detail: `${result.message} Install Android SDK platform-tools and add adb to PATH or set ANDROID_SDK_ROOT.`,
        };
      } else {
        adb = { status: "ok", detail: `ADB is available at ${result.adbPath}.` };
        androidAdbPath = result.adbPath;
        const online = result.devices.filter((candidate) => candidate.online);
        const tvDevices = online.filter((candidate) => candidate.isTelevision === true);
        const compatible = tvDevices.filter((candidate) => candidate.apiLevel !== null && candidate.apiLevel >= 23);
        compatibleAndroidDevices = compatible;
        const chosen = compatible[0];
        if (chosen !== undefined) {
          const manufacturer = chosen.manufacturer ?? "Android";
          const model = chosen.model ?? "TV device";
          device = {
            status: "ok",
            detail: `${manufacturer} ${model}; API ${String(chosen.apiLevel)}; ${chosen.serial}`,
          };
        } else if (online.length === 0) {
          const blocked = result.devices.find((candidate) => candidate.detail !== null);
          device = {
            status: "unavailable",
            detail: blocked?.detail
              ?? "No authorized Android TV device is online. Connect or start one and accept ADB authorization.",
          };
        } else if (tvDevices.length === 0) {
          device = {
            status: "unsupported",
            detail: "Connected authorized Android devices are not identified as television devices.",
          };
        } else {
          const api = tvDevices.map((candidate) => candidate.apiLevel).filter((value): value is number => value !== null)[0];
          device = {
            status: "unsupported",
            detail: `Android TV API ${api === undefined ? "unknown" : String(api)} is unsupported; TVDoctor Observer requires API 23 or newer.`,
          };
        }
      }
    } catch (error) {
      adb = { status: "unavailable", detail: classifyCliError(error, "doctor") };
    }
  }

  if (androidAdbPath !== null
    && compatibleAndroidDevices.length > 0
    && context.operations?.androidObserverPreflight !== undefined) {
    let firstObserverResult: DiagnosticCheck | null = null;
    for (const candidate of compatibleAndroidDevices) {
      let candidateObserver: DiagnosticCheck;
      try {
        candidateObserver = await context.operations.androidObserverPreflight(androidAdbPath, candidate.serial);
      } catch (error) {
        candidateObserver = { status: "unavailable", detail: classifyCliError(error, "doctor") };
      }
      firstObserverResult ??= candidateObserver;
      if (candidateObserver.status !== "ok") continue;

      const manufacturer = candidate.manufacturer ?? "Android";
      const model = candidate.model ?? "TV device";
      device = {
        status: "ok",
        detail: `${manufacturer} ${model}; API ${String(candidate.apiLevel)}; ${candidate.serial}`,
      };
      observer = candidateObserver;
      break;
    }
    if (observer.status !== "ok" && firstObserverResult !== null) observer = firstObserverResult;
  }

  const report = diagnoseEnvironment(context.environment, {
    auditOrchestrationAvailable: context.operations?.testTarget !== undefined,
    androidAuditOrchestrationAvailable: context.operations?.scanAndroidApk !== undefined,
    browser,
    android: { adb, buildTools, device, observer },
  });
  writeBlock(context.io.writeStdout, renderDoctorReport(report));

  return doctorSucceeded(report)
    ? EXIT_CODES.success
    : EXIT_CODES.environmentFailure;
}

async function runBaseline(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, BASELINE_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const request = parseBaselineArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  try {
    if (request.action === "create") {
      if (context.operations?.createBaseline === undefined) {
        writeLine(context.io.writeStderr, "Baseline creation is unavailable in this CLI host.");
        return EXIT_CODES.executionError;
      }
      const result = await context.operations.createBaseline({
        reportPath: request.reportPath,
        inventoryPath: request.inventoryPath,
        outputPath: request.outputPath,
      });
      writeLine(context.io.writeStdout, `Baseline created from ${String(result.issueCount)} findings.`);
      writeLine(context.io.writeStdout, `Baseline: ${result.outputPath}`, 1_024);
      return EXIT_CODES.success;
    }
    if (context.operations?.compareBaseline === undefined) {
      writeLine(context.io.writeStderr, "Baseline comparison is unavailable in this CLI host.");
      return EXIT_CODES.executionError;
    }
    writeLine(context.io.writeStdout, "Phase: BASELINE COMPARISON");
    writeLine(context.io.writeStdout, "Status: RUNNING");
    const result = await context.operations.compareBaseline({
      baselinePath: request.baselinePath,
      reportPath: request.reportPath,
      inventoryPath: request.inventoryPath,
      outputPath: request.outputPath,
    });
    writeLine(context.io.writeStdout, `Baseline result: ${result.status.toUpperCase()}`);
    writeComparisonSummary(context.io.writeStdout, result);
    writeLine(
      context.io.writeStdout,
      `${String(result.newIssues)} new, ${String(result.resolvedIssues)} resolved, ${String(result.unchangedIssues)} unchanged findings.`,
    );
    if (result.structuralRegressions > 0) {
      writeLine(context.io.writeStdout, `${String(result.structuralRegressions)} structural or latency regressions.`);
    }
    for (const blocker of result.blockers) writeLine(context.io.writeStdout, `Blocked: ${blocker}`, 1_024);
    writeLine(context.io.writeStdout, `Comparison: ${result.outputPath}`, 1_024);
    if (result.markdownPath !== undefined) {
      writeLine(context.io.writeStdout, `Readable comparison: ${result.markdownPath}`, 1_024);
    }
    return result.shouldFail ? EXIT_CODES.environmentFailure : EXIT_CODES.success;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
    writeLine(
      context.io.writeStderr,
      `Baseline failed: ${sanitizeTerminalText(firstLine, { maximumLength: 500 })}`,
    );
    return EXIT_CODES.executionError;
  }
}

async function runSetup(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (
    argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")
  ) {
    writeBlock(context.io.writeStdout, SETUP_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.length > 0) {
    return usageError(context, `setup does not accept arguments: ${argumentsAfterCommand.join(" ")}`);
  }
  if (context.runtimeSetup === undefined || context.runtimeProbe === undefined) {
    writeLine(context.io.writeStderr, "Chromium setup is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Phase: SETUP");
  writeLine(context.io.writeStdout, "Status: INSTALLING");
  writeLine(context.io.writeStdout, "Installing TVDoctor's Chromium runtime...");
  try {
    await context.runtimeSetup(context.signal);
    await context.runtimeProbe();
  } catch (error) {
    writeLine(context.io.writeStdout, "Status: FAILED");
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
    writeLine(
      context.io.writeStderr,
      `Chromium setup failed: ${sanitizeTerminalText(firstLine, { maximumLength: 240 })}`,
    );
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Status: READY");
  writeLine(context.io.writeStdout, "Chromium is installed and ready for TVDoctor.");
  return EXIT_CODES.success;
}

async function runStart(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, START_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.length > 0) {
    return usageError(context, "start does not accept arguments; use tvdoctor test for scripted runs.");
  }
  return await runGuidedStart(context);
}

export async function runCli(
  arguments_: readonly string[],
  context: CliContext,
): Promise<number> {
  const [command, ...argumentsAfterCommand] = arguments_;

  if (arguments_.length > 128
    || arguments_.some((argument) => !isSafeTerminalArgument(argument))) {
    return usageError(
      context,
      "arguments must be bounded and must not contain terminal control or bidirectional formatting characters",
    );
  }

  if (
    command === undefined ||
    command === "--help" ||
    command === "-h"
  ) {
    writeBlock(context.io.writeStdout, HELP_TEXT);
    return EXIT_CODES.success;
  }

  if (command === "help") {
    if (argumentsAfterCommand.length === 0) {
      writeBlock(context.io.writeStdout, HELP_TEXT);
      return EXIT_CODES.success;
    }

    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "project") {
      writeBlock(context.io.writeStdout, PROJECT_HELP_TEXT);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "qa") {
      writeBlock(context.io.writeStdout, QA_HELP_TEXT);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "qa-verify") {
      writeBlock(context.io.writeStdout, QA_VERIFY_HELP_TEXT);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "qa-accept") {
      writeBlock(context.io.writeStdout, QA_ACCEPT_HELP_TEXT);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "project-verify") {
      writeBlock(context.io.writeStdout, PROJECT_VERIFY_HELP_TEXT);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "project-accept") {
      writeBlock(context.io.writeStdout, PROJECT_ACCEPT_HELP_TEXT);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "handoff") {
      writeBlock(context.io.writeStdout, HANDOFF_HELP_TEXT);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "route-health") {
      const { PUBLIC_ROUTE_HEALTH_HELP } = await import("./public-route-health-command.js");
      writeBlock(context.io.writeStdout, PUBLIC_ROUTE_HEALTH_HELP);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "spa-route-health") {
      const { SPA_ROUTE_HEALTH_HELP } = await import("./spa-route-health-command.js");
      writeBlock(context.io.writeStdout, SPA_ROUTE_HEALTH_HELP);
      return EXIT_CODES.success;
    }
    if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === "boot-health") {
      const { BOOT_HEALTH_HELP } = await import("./boot-health-command.js");
      writeBlock(context.io.writeStdout, BOOT_HEALTH_HELP);
      return EXIT_CODES.success;
    }

    if (
      argumentsAfterCommand.length === 1 &&
      (argumentsAfterCommand[0] === "demo" ||
        argumentsAfterCommand[0] === "check" ||
        argumentsAfterCommand[0] === "findings" ||
        argumentsAfterCommand[0] === "test" ||
        argumentsAfterCommand[0] === "scan" ||
        argumentsAfterCommand[0] === "site" ||
        argumentsAfterCommand[0] === "responsive" ||
        argumentsAfterCommand[0] === "start" ||
        argumentsAfterCommand[0] === "accessibility" ||
        argumentsAfterCommand[0] === "doctor" ||
        argumentsAfterCommand[0] === "ci" ||
        argumentsAfterCommand[0] === "baseline" ||
        argumentsAfterCommand[0] === "privacy" ||
        argumentsAfterCommand[0] === "setup" ||
        argumentsAfterCommand[0] === "export-test" ||
        argumentsAfterCommand[0] === "verify-fix" ||
        argumentsAfterCommand[0] === "replay")
    ) {
      writeBlock(
        context.io.writeStdout,
        argumentsAfterCommand[0] === "demo"
          ? DEMO_HELP_TEXT
          : argumentsAfterCommand[0] === "check"
            ? CHECK_HELP_TEXT
            : argumentsAfterCommand[0] === "findings"
              ? FINDINGS_HELP_TEXT
          : argumentsAfterCommand[0] === "scan"
            ? SCAN_HELP_TEXT
            : argumentsAfterCommand[0] === "site"
              ? SITE_HELP_TEXT
              : argumentsAfterCommand[0] === "responsive"
                ? RESPONSIVE_HELP_TEXT
            : argumentsAfterCommand[0] === "test"
          ? TEST_HELP_TEXT
          : argumentsAfterCommand[0] === "start"
            ? START_HELP_TEXT
          : argumentsAfterCommand[0] === "accessibility"
            ? ACCESSIBILITY_HELP_TEXT
          : argumentsAfterCommand[0] === "ci"
            ? CI_HELP_TEXT
          : argumentsAfterCommand[0] === "baseline"
              ? BASELINE_HELP_TEXT
          : argumentsAfterCommand[0] === "privacy"
            ? PRIVACY_HELP_TEXT
          : argumentsAfterCommand[0] === "doctor"
            ? DOCTOR_HELP_TEXT
            : argumentsAfterCommand[0] === "setup"
              ? SETUP_HELP_TEXT
            : argumentsAfterCommand[0] === "export-test"
              ? EXPORT_TEST_HELP_TEXT
              : argumentsAfterCommand[0] === "verify-fix"
                ? VERIFY_FIX_HELP_TEXT
              : REPLAY_HELP_TEXT,
      );
      return EXIT_CODES.success;
    }

    return usageError(
      context,
      `no help is available for: ${argumentsAfterCommand.join(" ")}`,
    );
  }

  if (command === "doctor") {
    return await runDoctor(argumentsAfterCommand, context);
  }

  if (command === "setup") {
    return await runSetup(argumentsAfterCommand, context);
  }

  if (command === "start") {
    return await runStart(argumentsAfterCommand, context);
  }

  if (command === "test") {
    return await runTest(argumentsAfterCommand, context);
  }

  if (command === "demo") {
    return await runDemo(argumentsAfterCommand, context);
  }

  if (command === "scan") {
    return await runScan(argumentsAfterCommand, context);
  }
  if (command === "check") {
    return await runCheck(argumentsAfterCommand, context);
  }
  if (command === "qa") {
    return await runQa(argumentsAfterCommand, context);
  }
  if (command === "qa-verify") {
    return await runQaVerification(argumentsAfterCommand, context);
  }
  if (command === "qa-accept") {
    return await runQaAcceptance(argumentsAfterCommand, context);
  }
  if (command === "route-health") {
    const { runPublicRouteHealthCommand } = await import("./public-route-health-command.js");
    return await runPublicRouteHealthCommand(argumentsAfterCommand, context,
      async (childArgs) => {
        let stdout = "";
        let truncated = false;
        const exitCode = await runCli(childArgs, { ...context,
          io: {
            writeStdout: (part) => {
              if (stdout.length + part.length <= 1024 * 1024) stdout += part;
              else truncated = true;
            },
            writeStderr: () => { /* Never promote raw app/browser content to public CLI. */ },
          },
        });
        return { exitCode, stdout: truncated ? "" : stdout };
      });
  }
  if (command === "spa-route-health") {
    const { runSpaRouteHealthCommand } = await import("./spa-route-health-command.js");
    return await runSpaRouteHealthCommand(argumentsAfterCommand, context,
      async (childArgs) => {
        let stdout = "";
        let truncated = false;
        const exitCode = await runCli(childArgs, { ...context,
          io: {
            writeStdout: (part) => {
              if (stdout.length + part.length <= 1024 * 1024) stdout += part;
              else truncated = true;
            },
            writeStderr: () => { /* No browser/application content in public CLI JSON. */ },
          },
        });
        return { exitCode, stdout: truncated ? "" : stdout };
      });
  }
  if (command === "boot-health") {
    const { runBootHealthCommand } = await import("./boot-health-command.js");
    return await runBootHealthCommand(argumentsAfterCommand, context,
      async (childArgs) => {
        if (childArgs[0] !== "qa") return { exitCode: 4, stdout: "" };
        let stdout = "";
        let truncated = false;
        const exitCode = await runCli(childArgs, { ...context,
          io: {
            writeStdout: (part) => {
              if (stdout.length + part.length <= 1024 * 1024) stdout += part;
              else truncated = true;
            },
            writeStderr: () => { /* Never expose raw application, journey or exception data. */ },
          },
        });
        return { exitCode, stdout: truncated ? "" : stdout };
      });
  }
  if (command === "project") {
    return await runProject(argumentsAfterCommand, context);
  }
  if (command === "project-verify") {
    return await runProjectVerification(argumentsAfterCommand, context);
  }
  if (command === "project-accept") {
    return await runProjectAcceptance(argumentsAfterCommand, context);
  }
  if (command === "findings") {
    return await runFindings(argumentsAfterCommand, context);
  }
  if (command === "handoff") {
    return await runFirstRunHandoffCli(argumentsAfterCommand, context.io);
  }

  if (command === "site") {
    return await runSiteCommand(argumentsAfterCommand, context);
  }

  if (command === "responsive") {
    return await runResponsiveCommand(argumentsAfterCommand, context);
  }

  if (command === "accessibility") {
    return await runAccessibility(argumentsAfterCommand, context);
  }

  if (command === "ci") {
    return await runCi(argumentsAfterCommand, context);
  }

  if (command === "replay") {
    return await runReplay(argumentsAfterCommand, context);
  }

  if (command === "verify-fix") {
    return await runVerifyFix(argumentsAfterCommand, context);
  }

  if (command === "export-test") {
    return await runExportTest(argumentsAfterCommand, context);
  }

  if (command === "baseline") {
    return await runBaseline(argumentsAfterCommand, context);
  }

  if (command === "privacy") {
    if (argumentsAfterCommand.length > 0) {
      return usageError(context, "privacy does not accept arguments");
    }
    writeBlock(context.io.writeStdout, PRIVACY_TEXT.trimEnd());
    return EXIT_CODES.success;
  }

  if ((command === "version" || command === "--version" || command === "-V")
    && argumentsAfterCommand.length === 0) {
    writeLine(context.io.writeStdout, `tvdoctor ${CLI_VERSION}`);
    return EXIT_CODES.success;
  }

  return usageError(context, `unknown command: ${command}`);
}
