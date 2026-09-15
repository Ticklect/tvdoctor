import { describe, expect, it } from "vitest";
import type { AndroidStateSnapshot } from "@tvdoctor/driver-android";
import {
  androidRunStatus,
  classifyAndroidStartup,
  restoreAndroidTargetForFinalEvidence,
} from "../src/android-product.js";

function snapshot(location: string): AndroidStateSnapshot {
  return {
    capturedAt: new Date(0).toISOString(),
    location: { status: "available", value: location },
    focusedElement: { status: "available", value: null },
    uiTree: { status: "available", value: [] },
    device: { status: "unavailable", reason: "test" },
    app: { status: "unavailable", reason: "test" },
    hierarchyMetadata: {
      status: "available",
      value: { capturedNodeCount: 0, maxNodeCount: 4096, maxDepth: 0, truncated: false },
    },
  };
}

describe("Android CLI foreground integrity regressions", () => {
  it("detects a redacted permission-controller boundary with no exposed nodes", () => {
    expect(classifyAndroidStartup(snapshot(
      "android://com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
    ))).toEqual({
      kind: "system permission",
      heading: "System permission",
      controls: [],
    });
  });

  it("relaunches and revalidates when final evidence starts outside the target", async () => {
    const states = [
      snapshot("android://com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity"),
      snapshot("android://org.example.tv/org.example.tv.MainActivity"),
    ];
    let resetCalls = 0;
    let foregroundChecks = 0;
    const restored = await restoreAndroidTargetForFinalEvidence({
      snapshot: async () => states.shift() ?? states.at(-1)!,
      reset: async () => { resetCalls += 1; },
      assertTargetForeground: async () => { foregroundChecks += 1; },
    }, "org.example.tv", async () => undefined);

    expect(restored.location).toMatchObject({
      status: "available",
      value: "android://org.example.tv/org.example.tv.MainActivity",
    });
    expect(resetCalls).toBe(1);
    expect(foregroundChecks).toBe(1);
  });

  it("rejects final evidence when relaunch cannot restore the target", async () => {
    const external = snapshot("android://com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity");
    let resetCalls = 0;
    await expect(restoreAndroidTargetForFinalEvidence({
      snapshot: async () => external,
      reset: async () => { resetCalls += 1; },
      assertTargetForeground: async () => undefined,
    }, "org.example.tv", async () => undefined)).rejects.toThrow(/ended outside org\.example\.tv/u);
    expect(resetCalls).toBe(1);
  });

  it("downgrades an otherwise complete exploration when final target validation fails", () => {
    expect(androidRunStatus(true, null)).toBe("completed");
    expect(androidRunStatus(true, "Android scan ended outside org.example.tv.")).toBe("partial");
    expect(androidRunStatus(false, null)).toBe("partial");
  });
});
