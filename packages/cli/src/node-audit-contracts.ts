import type {
  ExplorationProfile,
  ExplorationResult,
  NavigationDiagnosticFinding,
  StartupPreparationResult,
} from "@tvdoctor/core";
import type {
  PlaywrightWebDriver,
} from "@tvdoctor/driver-web";
import type { BrowserContext } from "playwright";
import type {
  StreamingPackBudgets,
  StreamingPackResult,
} from "@tvdoctor/pack-streaming";
import type {
  WebPackBudgets,
  WebPackResult,
  WebStageName,
} from "@tvdoctor/pack-web";
import type {
  ArtifactDescriptor,
  RemoteKey,
  TVDoctorIssue,
  TVDoctorReplayV1,
} from "@tvdoctor/protocol";
import type { TestCommandRequest } from "./cli.js";

export const REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY = "replayTargetOverride";
export const REPLAY_TARGET_OVERRIDE_REQUIRED = "required";
export const MAX_ISSUES_WITH_FRESH_EVIDENCE = 32;
export const MAX_EVIDENCE_CAPTURE_DURATION_MS = 120_000;
export const EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS = 20_000;

export const WEB_STAGE_BY_PACK: Readonly<Partial<Record<TestCommandRequest["packs"][number], WebStageName>>> = {
  search: "search",
  settings: "settings",
  accessibility: "accessibility",
  layout: "layout",
  performance: "performance",
  crashes: "crash",
};

export const STREAMING_BUDGETS: Readonly<Record<ExplorationProfile, StreamingPackBudgets>> = {
  quick: {
    maxActions: 450,
    maxStates: 100,
    maxLocalDepth: 8,
    maxLocalStates: 28,
    maxDurationMs: 90_000,
  },
  standard: {
    maxActions: 900,
    maxStates: 180,
    maxLocalDepth: 12,
    maxLocalStates: 48,
    maxDurationMs: 180_000,
  },
  deep: {
    maxActions: 1_800,
    maxStates: 360,
    maxLocalDepth: 18,
    maxLocalStates: 96,
    maxDurationMs: 360_000,
  },
};

export const WEB_BUDGETS: Readonly<Record<ExplorationProfile, WebPackBudgets>> = {
  quick: {
    maxActions: 320,
    maxStates: 90,
    maxLocalDepth: 8,
    maxLocalStates: 28,
    maxDurationMs: 90_000,
    maxFocusProbes: 12,
    maxSettingsSurfaces: 6,
    maxLogs: 256,
  },
  standard: {
    maxActions: 1_280,
    maxStates: 320,
    maxLocalDepth: 12,
    maxLocalStates: 48,
    maxDurationMs: 600_000,
    maxFocusProbes: 24,
    maxSettingsSurfaces: 12,
    maxLogs: 512,
  },
  deep: {
    maxActions: 1_280,
    maxStates: 320,
    maxLocalDepth: 18,
    maxLocalStates: 96,
    maxDurationMs: 360_000,
    maxFocusProbes: 48,
    maxSettingsSurfaces: 24,
    maxLogs: 1_024,
  },
};

export interface AuditRunProducts {
  readonly navigation: ExplorationResult | null;
  readonly navigationStartup?: StartupPreparationResult | null | undefined;
  readonly navigationFindings: readonly NavigationDiagnosticFinding[];
  readonly streaming: StreamingPackResult | null;
  readonly web: WebPackResult | null;
}

export interface CapturedIssue {
  readonly issue: TVDoctorIssue;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly replay: TVDoctorReplayV1 | null;
  readonly failed: boolean;
}

export interface NavigationInventory {
  readonly status: "complete" | "partial";
  readonly screens: readonly {
    readonly key: string;
    readonly label: string | null;
  }[];
  readonly focusTargets: readonly {
    readonly key: string;
    readonly screenKey: string;
    readonly role: string | null;
    readonly name: string | null;
  }[];
  readonly transitions: readonly {
    readonly key: string;
    readonly fromScreenKey: string;
    readonly fromFocusKey: string | null;
    readonly action: RemoteKey;
    readonly toScreenKey: string;
    readonly toFocusKey: string | null;
  }[];
  readonly latencies: readonly {
    readonly key: string;
    readonly operation: string;
    readonly measuredMs: number;
  }[];
}

export type WebStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface NodeAuditDependencies {
  readonly createDriver?: () => PlaywrightWebDriver;
  readonly createSessionDriver?: (storageState: WebStorageState) => PlaywrightWebDriver;
}
