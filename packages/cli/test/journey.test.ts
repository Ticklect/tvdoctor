import { describe, expect, it } from "vitest";
import type { ActionResult, RemoteKey, StateSnapshot } from "@tvdoctor/protocol";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import { executeJourney, parseJourney } from "../src/journey.js";

function snapshot(): StateSnapshot {
  return {
    capturedAt: "2026-09-08T12:00:00.000Z",
    location: { status: "available", value: "https://example.test/profile" },
    focusedElement: { status: "available", value: { stableId: "play", role: "button", name: "Play" } },
    uiTree: {
      status: "available",
      value: [{
        stableId: "play",
        role: "button",
        name: "Play",
        text: null,
        bounds: null,
        visible: true,
        enabled: true,
        focusable: true,
        focused: true,
        modal: false,
        selectionState: null,
        valueNow: null,
        children: [],
      }],
    },
  };
}

describe("safe custom journeys", () => {
  it("uses environment-only text, counts every input, and retains no secret", async () => {
    const typed: string[] = [];
    const pressed: RemoteKey[] = [];
    const driver = {
      async press(key: RemoteKey): Promise<ActionResult> {
        pressed.push(key);
        return { key, outcome: "applied", timing: { inputSentAtMs: 0 } };
      },
      async snapshot() { return snapshot(); },
      getPage() {
        return { keyboard: { async insertText(value: string) { typed.push(value); } } };
      },
    } as unknown as PlaywrightWebDriver;
    const journey = parseJourney({
      schemaVersion: "tvdoctor.journey/v1",
      name: "Sign in and open profile",
      maxDurationMs: 10_000,
      steps: [
        { action: "type-from-env", env: "TVDOCTOR_JOURNEY_USERNAME" },
        { action: "press", key: "SELECT", repeat: 2 },
        { action: "expect-focus", role: "button", name: "Play" },
      ],
    });
    const result = await executeJourney(driver, journey, {
      TVDOCTOR_JOURNEY_USERNAME: "private-user",
    });
    expect(typed).toEqual(["private-user"]);
    expect(pressed).toEqual(["SELECT", "SELECT"]);
    expect(result).toMatchObject({ actions: 3, maxActions: 256, snapshots: 1, maxDurationMs: 10_000 });
    expect(JSON.stringify({ journey, result })).not.toContain("private-user");
    expect(journey.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects inline values, unscoped environment names, and over-budget secrets", async () => {
    expect(() => parseJourney({
      schemaVersion: "tvdoctor.journey/v1",
      name: "Unsafe",
      steps: [{ action: "type-from-env", env: "PASSWORD", value: "secret" }],
    })).toThrow(/value is not supported/u);
    expect(() => parseJourney({
      schemaVersion: "tvdoctor.journey/v1",
      name: "Unsafe",
      steps: [{ action: "type-from-env", env: "PASSWORD" }],
    })).toThrow(/TVDOCTOR_JOURNEY_/u);
    const journey = parseJourney({
      schemaVersion: "tvdoctor.journey/v1",
      name: "Bounded",
      steps: [{ action: "type-from-env", env: "TVDOCTOR_JOURNEY_SECRET" }],
    });
    const driver = {} as PlaywrightWebDriver;
    await expect(executeJourney(driver, journey, {
      TVDOCTOR_JOURNEY_SECRET: "x".repeat(257),
    })).rejects.toThrow(/1 through 256/u);
  });
});
