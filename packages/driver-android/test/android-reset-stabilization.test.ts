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

function state() {
  return {
    sequence: 1,
    timestampMs: Date.now(),
    packageName: "org.example.tv",
    windowClassName: "org.example.tv.MainActivity",
    windowId: 1,
    focused: { stableId: NODE.stableId, role: NODE.role, name: NODE.name, bounds: NODE.bounds },
    structureFingerprint: "a".repeat(64),
    stateFingerprint: "b".repeat(64),
    treeChanged: true,
    nodes: [NODE],
    nodeCount: 1,
    maxDepth: 0,
  };
}

class StableExecutor implements AdbCommandExecutor {
  readonly calls: string[][] = [];

  async execute(arguments_: readonly string[]): Promise<AdbCommandResult> {
    const call = [...arguments_];
    this.calls.push(call);
    const joined = call.join(" ");
    let stdout: string | Uint8Array = "";
    if (joined.includes("shell pm path org.tvdoctor.observer")) {
      stdout = "package:/data/app/org.tvdoctor.observer/base.apk";
    } else if (joined.includes("exec-out cat /data/app/org.tvdoctor.observer/base.apk")) {
      stdout = OBSERVER_APK;
    } else if (joined.includes("content call") && joined.includes("org.tvdoctor.observer.provisioning")) {
      stdout = "Bundle[{result=provisioned}]";
    } else if (joined.includes("settings get secure accessibility_enabled")) {
      stdout = "1";
    } else if (joined.includes("settings get secure enabled_accessibility_services")) {
      stdout = "org.tvdoctor.observer/.ObserverAccessibilityService";
    } else if (joined.includes("forward tcp:0")) {
      stdout = "45678";
    } else if (joined.includes("shell date +%s.%3N")) {
      stdout = "1788537600.000";
    } else if (joined.includes("ro.product.manufacturer")) {
      stdout = "Google";
    } else if (joined.includes("ro.product.model")) {
      stdout = "sdk_google_atv64_x86_64";
    } else if (joined.includes("ro.build.version.sdk")) {
      stdout = "36";
    } else if (joined.includes("ro.build.version.release")) {
      stdout = "16";
    } else if (joined.includes("ro.build.fingerprint")) {
      stdout = "google/tv/atv";
    } else if (joined.includes("ro.build.characteristics")) {
      stdout = "tv";
    } else if (joined.includes("ro.product.cpu.abilist")) {
      stdout = "x86_64";
    } else if (joined.includes("wm size")) {
      stdout = "Physical size: 1920x1080";
    } else if (joined.includes("dumpsys window")) {
      stdout = "mCurrentFocus=Window{1234567 u0 org.example.tv/org.example.tv.MainActivity}";
    } else if (joined.includes("pidof -s org.example.tv")) {
      stdout = "321";
    } else if (joined.includes("dumpsys package org.example.tv")) {
      stdout = "versionName=1.2.3 versionCode=7";
    } else if (joined.includes("dumpsys package org.tvdoctor.observer")) {
      stdout = "versionName=0.1.0";
    }
    return {
      stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
      stderr: "",
      exitCode: 0,
    };
  }
}

class StableObserver implements AndroidObserverConnection {
  resyncCalls = 0;
  closed = false;

  async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    if (request.type === "resync") this.resyncCalls += 1;
    return { version: 2, id: 1, ok: true, type: request.type, state: state() };
  }

  close(): void {
    this.closed = true;
  }
}

describe("Android launch stabilization", () => {
  it("proves canonical state and focused-window ownership in one shared stable window", async () => {
    const executor = new StableExecutor();
    const observer = new StableObserver();
    const driver = new AndroidTvDriver({
      serial: "emulator-5554",
      executor,
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
      resetSettleTimeoutMs: 100,
    });

    try {
      await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
      const focusChecks = executor.calls.filter((call) => call.join(" ").includes("dumpsys window")).length;
      expect(observer.resyncCalls).toBeGreaterThanOrEqual(3);
      expect(focusChecks).toBeLessThanOrEqual(4);
    } finally {
      await driver.close();
      expect(observer.closed).toBe(true);
    }
  });
});
