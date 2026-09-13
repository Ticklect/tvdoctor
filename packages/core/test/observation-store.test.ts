import { availableObservation, type StateSnapshot } from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import {
  CanonicalObservationStore,
  type ObservationCapability,
  type ObservationStoreKey,
} from "../src/observation-store.js";

function snapshot(id: string): StateSnapshot {
  return {
    capturedAt: "2026-09-13T18:00:00.000Z",
    location: availableObservation(`app://${id}`),
    focusedElement: availableObservation(null),
    uiTree: availableObservation([]),
  };
}

function key(overrides: Partial<ObservationStoreKey> = {}): ObservationStoreKey {
  return {
    sessionId: "session-a",
    preparationId: "prep-a",
    stateIdentity: "state-a",
    observationVersion: "v1",
    ...overrides,
  };
}

describe("CanonicalObservationStore", () => {
  it("reuses an exact observation only when required capabilities are present", () => {
    const store = new CanonicalObservationStore();
    const value = snapshot("home");
    const capabilities: readonly ObservationCapability[] = ["navigation-identity", "focus-semantics"];
    store.put(key(), value, capabilities);

    expect(store.get(key(), ["navigation-identity"])).toBe(value);
    expect(store.get(key(), ["accessibility-tree"])).toBeNull();
  });

  it("isolates entries by session, preparation, state, and observation version", () => {
    const store = new CanonicalObservationStore();
    const value = snapshot("home");
    store.put(key(), value, ["navigation-identity"]);

    expect(store.get(key({ sessionId: "session-b" }), ["navigation-identity"])).toBeNull();
    expect(store.get(key({ preparationId: "prep-b" }), ["navigation-identity"])).toBeNull();
    expect(store.get(key({ stateIdentity: "state-b" }), ["navigation-identity"])).toBeNull();
    expect(store.get(key({ observationVersion: "v2" }), ["navigation-identity"])).toBeNull();
  });

  it("can enrich capabilities for the same exact state without cross-state leakage", () => {
    const store = new CanonicalObservationStore();
    const first = snapshot("home-basic");
    const enriched = snapshot("home-enriched");
    store.put(key(), first, ["navigation-identity"]);
    store.put(key(), enriched, ["navigation-identity", "accessibility-tree"]);

    expect(store.get(key(), ["navigation-identity", "accessibility-tree"])).toBe(enriched);
    expect(store.get(key({ stateIdentity: "other" }), ["navigation-identity"])).toBeNull();
  });
});
