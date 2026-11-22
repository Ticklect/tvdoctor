export {
  ACCESSIBILITY_HELP_TEXT,
  BASELINE_HELP_TEXT,
  CI_HELP_TEXT,
  DOCTOR_HELP_TEXT,
  EXIT_CODES,
  HELP_TEXT,
  REPLAY_HELP_TEXT,
  VERIFY_FIX_HELP_TEXT,
  CHECK_HELP_TEXT,
  FINDINGS_HELP_TEXT,
  SETUP_HELP_TEXT,
  START_HELP_TEXT,
  TEST_HELP_TEXT,
  SCAN_HELP_TEXT,
  DEMO_HELP_TEXT,
  TEST_PACK_NAMES,
  safeTarget,
  runCli,
  type CliContext,
  type CliIO,
  type CliOperations,
  type BaselineCompareRequest,
  type BaselineCompareResult,
  type BaselineCreateRequest,
  type BaselineCreateResult,
  type DemoCommandRequest,
  type DemoCommandResult,
  type ReportActionHandlers,
  type RuntimeProbeResult,
  type ReplayCommandRequest,
  type ReplayCommandResult,
  type ReplayCommandStatus,
  type TestCommandRequest,
  type TestCommandResult,
  type TestPackName,
  type TestRunMode,
} from "./cli.js";
export {
  verifyOriginalFindingWorkflow,
  type VerifyWorkflowRequest,
  type VerifyWorkflowResult,
  type VerifyWorkflowVerdict,
  type VerifyWorkflowComparison,
  type VerifyFreshScanOptions,
  type VerifyWorkflowDependencies,
} from "./node-verify-workflow.js";
export { inspectReport, type ReportTriage, type ActionableTriageFinding, type InspectReportOptions } from "./node-triage.js";
export {
  SUPPORTED_NODE_RANGE,
  diagnoseEnvironment,
  doctorSucceeded,
  isSupportedNodeVersion,
  renderDoctorReport,
  type DiagnosticCheck,
  type DiagnosticStatus,
  type DoctorReport,
  type RuntimeEnvironment,
  type EnvironmentCapabilities,
} from "./diagnostics.js";
export {
  isSafeTerminalArgument,
  safeDisplayUrl,
  sanitizeTerminalText,
  type TerminalSanitizerOptions,
} from "./terminal.js";
export { CLI_VERSION } from "./version.js";
export {
  createNodeAuditOperation,
  type NodeAuditDependencies,
} from "./node-audit.js";
export {
  createNodeCliOperations,
  type NodeReplayDependencies,
} from "./node-replay.js";
export { defaultOutputDirectory } from "./product-output.js";
export {
  SITE_SCAN_LIMITS,
  parseSiteArguments,
  renderSiteReport,
  scanSite,
  type SiteScanIndex,
  type SiteScanOptions,
  type SiteSpaSummary,
} from "./site-scan.js";
export {
  SPA_JOURNEY_LIMITS,
  runSpaJourneyScan,
  type SpaJourneyRequest,
  type SpaJourneyResult,
  type SpaJourneyState,
  type SpaJourneyEdge,
} from "./spa-journey.js";
export { renderSpaJourneyGraph } from "./spa-graph.js";
export { compareResponsiveBundles, renderResponsiveComparison, type ResponsiveComparison } from "./responsive-compare.js";
export {
  RESPONSIVE_VIEWPORTS,
  runResponsiveScan,
  type ResponsiveScanRequest,
  type ResponsiveScanResult,
  type ResponsiveFinding,
} from "./responsive-scan.js";
export { compareBaselineFromFiles, createBaselineFromFiles } from "./node-baseline.js";
export {
  DEFAULT_SOURCE_CORRELATION_LIMITS,
  SOURCE_CORRELATION_JSON_PATH,
  SOURCE_CORRELATION_MARKDOWN_PATH,
  correlateSource,
  githubWorkspaceSourceRoot,
  renderSourceCorrelationMarkdown,
  writeSourceCorrelationArtifacts,
  type SourceCorrelationArtifacts,
  type SourceCorrelationFinding,
  type SourceCorrelationIdentifier,
  type SourceCorrelationLimits,
  type SourceCorrelationMatch,
  type SourceCorrelationResult,
  type WriteSourceCorrelationRequest,
} from "./source-correlation.js";
export {
  JOURNEY_HASH_ENVIRONMENT_KEY,
  JOURNEY_NAME_ENVIRONMENT_KEY,
  JOURNEY_SCHEMA_VERSION_V1,
  MAX_JOURNEY_ACTIONS,
  executeJourney,
  loadJourney,
  parseJourney,
  type JourneyExecutionResult,
  type JourneyStep,
  type JourneyV1,
} from "./journey.js";
export {
  androidBuildToolsPreflight,
  androidObserverPreflight,
  androidPreflight,
  androidPublicTargetLocation,
  checkApkCompatibility,
  inspectApk,
  scanAndroidApk,
  type AndroidPreflightDevice,
  type AndroidPreflightResult,
  type AndroidBuildToolsPreflightResult,
  type AndroidObserverPreflightResult,
  type ApkCompatibility,
  type ApkMetadata,
} from "./android-product.js";
