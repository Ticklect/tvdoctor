import { describe, expect, it, vi } from "vitest";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import { availableObservation, type StateSnapshot, type UiNodeSnapshot } from "@tvdoctor/protocol";
import { createSafeExplorationDriver } from "../src/node-audit-navigation.js";

function node(id: string, name: string): UiNodeSnapshot {
  return {
    stableId: id,
    role: "button",
    name,
    text: name,
    bounds: { x: 10, y: 10, width: 140, height: 70 },
    visible: true,
    enabled: true,
    focusable: true,
    focused: true,
    modal: false,
    selectionState: null,
    valueNow: null,
    children: [],
  };
}

function profileSnapshot({
  id = "profile-primary",
  location = "http://127.0.0.1:5173/",
  ancestor = true,
  label,
  enabled = true,
  dialogName = "Choose a profile",
}: {
  id?: string;
  location?: string;
  ancestor?: boolean;
  label?: string;
  enabled?: boolean;
  dialogName?: string;
} = {}): StateSnapshot {
  const name = label ?? (id === "profile-kids" ? "Little stars" : "Night owl");
  const control = {
    ...node(id, name),
    enabled,
  };
  const dialog: UiNodeSnapshot = {
    stableId: null,
    role: "dialog",
    name: dialogName,
    text: null,
    bounds: { x: 0, y: 0, width: 700, height: 500 },
    visible: true,
    enabled: true,
    focusable: false,
    focused: false,
    modal: true,
    selectionState: null,
    valueNow: null,
    children: [control],
  };
  return {
    capturedAt: "2026-10-09T00:00:00.000Z",
    location: availableObservation(location),
    focusedElement: availableObservation({ stableId: id, role: "button", name }),
    uiTree: availableObservation(ancestor ? [dialog] : [control]),
  };
}

async function select(snapshotValue: StateSnapshot, optIn: boolean) {
  const press = vi.fn(async () => ({
    key: "SELECT" as const,
    outcome: "applied" as const,
    timing: { inputSentAtMs: 1 },
  }));
  const snapshot = vi.fn(async () => snapshotValue);
  const driver = createSafeExplorationDriver(
    { press, snapshot } as unknown as PlaywrightWebDriver,
    { fixtureProfileSelection: optIn },
  );
  const result = await driver.press("SELECT");
  return { press, snapshot, result };
}

describe("Northstar test-only profile selection", () => {
  it.each(["profile-primary", "profile-kids"])(
    "allows the known fixture %s with explicit opt-in",
    async (id) => {
      const enabled = await select(profileSnapshot({ id }), true);
      expect(enabled.result.outcome).toBe("applied");
      expect(enabled.snapshot).toHaveBeenCalledOnce();
      expect(enabled.press).toHaveBeenCalledExactlyOnceWith("SELECT", undefined);

      const defaultPolicy = await select(profileSnapshot({ id }), false);
      expect(defaultPolicy.result.outcome).toBe("unsupported");
      expect(defaultPolicy.press).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["remote website", { location: "https://example.test/" }],
    ["different loopback application", { dialogName: "Select payment account" }],
    ["unrecognised profile", { id: "profile-admin" }],
    ["missing fixture modal", { ancestor: false, label: "Profile Night owl" }],
    ["different profile label", { label: "Delete account" }],
    ["disabled profile", { enabled: false }],
  ] as const)("never bypasses SELECT safety for %s", async (_label, configuration) => {
    const result = await select(profileSnapshot(configuration), true);
    expect(result.result.outcome).toBe("unsupported");
    expect(result.press).not.toHaveBeenCalled();
  });

  it("checks the current snapshot on every SELECT after a fixture navigation change", async () => {
    let current = profileSnapshot();
    const press = vi.fn(async () => ({ key: "SELECT" as const, outcome: "applied" as const, timing: { inputSentAtMs: 1 } }));
    const snapshot = vi.fn(async () => current);
    const driver = createSafeExplorationDriver({ press, snapshot } as unknown as PlaywrightWebDriver, {
      fixtureProfileSelection: true,
    });
    expect((await driver.press("SELECT")).outcome).toBe("applied");
    current = profileSnapshot({ location: "https://example.test/" });
    expect((await driver.press("SELECT")).outcome).toBe("unsupported");
    expect(press).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});
