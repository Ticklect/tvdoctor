import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AndroidTvDriver,
  type AdbCommandExecutor,
  type AdbCommandResult,
  type AndroidObserverConnection,
  type ObserverRequestPayload,
  type ObserverResponse,
} from "../src/index.js";

const TOKEN = "a".repeat(64);
const OBSERVER_APK = Buffer.from("packaged-tvdoctor-observer");
const OBSERVER_SHA256 = createHash("sha256").update(OBSERVER_APK).digest("hex");
const NODE = {
  stableId: "org.example.tv:id/play",
  role: "button",
  name: "Play",
  text: "Play",
  bounds: { x: 10, y: 20, width: 200, height: 80 },
  visible: true,
  enabled: true,
  focusable: true,
  focused: true,
  modal: null,
  selectionState: null,
  valueNow: null,
  className: "android.widget.Button",
  packageName: "org.example.tv",
  clickable: true,
  scrollable: false,
  selected: false,
  children: [],
} as const;

function state(full: boolean, sequence: number, packageName = "org.example.tv") {
  return {
    sequence,
    timestampMs: Date.now(),
    packageName,
    windowClassName: `${packageName}.MainActivity`,
    windowId: 1,
    focused: { stableId: NODE.stableId, role: NODE.role, name: NODE.name, bounds: NODE.bounds },
    structureFingerprint: "a".repeat(64),
    stateFingerprint: "b".repeat(64),
    treeChanged: full,
    ...(full ? { nodes: [NODE] } : {}),
    nodeCount: 1,
    maxDepth: 0,
  };
}

class FakeExecutor implements AdbCommandExecutor {
  async execute(arguments_: readonly string[]): Promise<AdbCommandResult> {
    const joined = arguments_.join(" ");
    let stdout: string | Uint8Array = "";
    if (joined.includes("install -r D:/packaged/tvdoctor-observer.apk")) stdout = "Success";
    else if (joined.includes("shell pm path org.tvdoctor.observer")) stdout = "package:/data/app/org.tvdoctor.observer/base.apk";
    else if (joined.includes("exec-out cat /data/app/org.tvdoctor.observer/base.apk")) stdout = OBSERVER_APK;
    else if (joined.includes("content call") && joined.includes("org.tvdoctor.observer.provisioning")) stdout = "Bundle[{result=provisioned}]";
    else if (joined.endsWith(" get-state")) stdout = "device";
    else if (joined.includes("shell date +%s.%3N")) stdout = "1788537600.000";
    else if (joined.includes("getprop sys.boot_completed")) stdout = "1";
    else if (joined.includes("dumpsys package org.tvdoctor.observer")) stdout = "versionName=0.1.0";
    else if (joined.includes("settings get secure accessibility_enabled")) stdout = "1";
    else if (joined.includes("settings get secure enabled_accessibility_services")) stdout = "org.tvdoctor.observer/.ObserverAccessibilityService";
    else if (joined.includes("forward tcp:0")) stdout = "45678";
    else if (joined.includes("dumpsys window")) stdout = "mCurrentFocus=Window{1234567 u0 org.example.tv/org.example.tv.MainActivity}";
    else if (joined.includes("pidof -s org.example.tv")) stdout = "321";
    else if (joined.includes("dumpsys package org.example.tv")) stdout = "versionName=1.2.3 versionCode=7";
    return { stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout, stderr: "", exitCode: 0 };
  }
}

class FakeObserver implements AndroidObserverConnection {
  sequence = 1;
  escapeOnSettle = false;

  async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    if (request.type === "begin_action") {
      return { version: 2, id: 1, ok: true, type: "begin_action", actionId: 91, baselineSequence: this.sequence };
    }
    if (request.type === "settle_action") {
      this.sequence += 1;
      return {
        version: 2,
        id: 2,
        ok: true,
        type: "settle_action",
        state: state(false, this.sequence, this.escapeOnSettle ? "org.other.private" : "org.example.tv"),
        timing: { eventLatencyMs: 18, snapshotGenerationMs: 4, settlingMs: 105, eventsObserved: 2, noOpConfirmed: false },
      };
    }
    return { version: 2, id: 3, ok: true, type: request.type, state: state(true, this.sequence) };
  }

  close(): void {}
}

function createDriver(observer: FakeObserver): AndroidTvDriver {
  return new AndroidTvDriver({
    serial: "emulator-5554",
    executor: new FakeExecutor(),
    tokenFactory: () => TOKEN,
    observerAsset: {
      apkPath: "D:/packaged/tvdoctor-observer.apk",
      packageName: "org.tvdoctor.observer",
      versionName: "0.1.0",
      protocolVersion: 2,
      sha256: OBSERVER_SHA256,
      certificateSha256: "d".repeat(64),
    },
    createObserverClient: async () => observer,
    settleTimeoutMs: 50,
    quietWindowMs: 5,
    noResponseGraceMs: 10,
    resetStableWindowMs: 10,
    resetSettleTimeoutMs: 50,
  });
}

describe("Android settled observation proof", () => {
  it("attests the observer settle_action snapshot as driver-verified", async () => {
    const driver = createDriver(new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    try {
      const result = await driver.press("RIGHT");
      expect(result.outcome).toBe("applied");
      expect(result.postActionSnapshot).toBeDefined();
      expect(result.settlingProof).toEqual({
        kind: "driver-verified",
        source: "android-observer-settle",
        observationVersion: "android-observer/v2",
      });
    } finally {
      await driver.close();
    }
  });

  it("does not attest an action whose settled observation crosses the target package boundary", async () => {
    const observer = new FakeObserver();
    const driver = createDriver(observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.escapeOnSettle = true;

    try {
      const result = await driver.press("RIGHT");
      expect(result.outcome).toBe("inconclusive");
      expect(result.postActionSnapshot).toBeUndefined();
      expect(result.settlingProof).toBeUndefined();
    } finally {
      await driver.close();
    }
  });
});
