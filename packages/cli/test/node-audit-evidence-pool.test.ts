import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import {
  availableObservation,
  type ActionResult,
  type AppReference,
  type StateSnapshot,
  type TVDoctorIssue,
} from "@tvdoctor/protocol";
import { createArtifactStore } from "@tvdoctor/reporters";
import {
  captureIssuesWithinBudget,
  type AuditRunProducts,
} from "../src/node-audit.js";

const PRODUCTS: AuditRunProducts = {
  navigation: null,
  navigationFindings: [],
  streaming: null,
  web: null,
};

function issue(id: string): TVDoctorIssue {
  return {
    id,
    rule: "remote.self-loop",
    title: "DOWN remains on the source",
    description: "The witnessed transition does not reach the expected target.",
    severity: "high",
    confidence: "deterministic",
    pack: "navigation",
    screen: "Test",
    expected: "Focus reaches expected-target.",
    observed: "Focus reaches observed-target.",
    transition: {
      fromElement: "source-target",
      action: "DOWN",
      expectedElement: "expected-target",
      observedElement: "observed-target",
    },
    evidence: [],
    reproduction: {
      status: "available",
      resetStrategy: "reload",
      originalSequence: [{ key: "DOWN", repeat: 1 }],
      minimizedSequence: null,
      confidence: "deterministic",
      artifact: null,
    },
  };
}

function snapshot(focus: string): StateSnapshot {
  return {
    capturedAt: "2026-09-13T00:00:00.000Z",
    location: availableObservation("https://example.test/app"),
    focusedElement: availableObservation({ stableId: focus, role: "button", name: focus }),
    uiTree: availableObservation([]),
  };
}

function fakeDriver(options: {
  readonly launch: (app: AppReference) => Promise<void>;
  readonly close: () => Promise<void>;
}): PlaywrightWebDriver {
  let focus = "source-target";
  return {
    async launch(app: AppReference) {
      focus = "source-target";
      await options.launch(app);
    },
    async press(key): Promise<ActionResult> {
      if (key === "DOWN") focus = "observed-target";
      return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
    },
    async snapshot() {
      return snapshot(focus);
    },
    getPage() {
      return {
        screenshot: async () => Uint8Array.from([137, 80, 78, 71]),
      } as ReturnType<PlaywrightWebDriver["getPage"]>;
    },
    async getLogs() {
      return [];
    },
    close: options.close,
  } as unknown as PlaywrightWebDriver;
}

describe("fresh evidence browser pooling", () => {
  it("reuses one browser driver while launch creates a fresh issue context", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-pool-"));
    try {
      const store = await createArtifactStore(root);
      const launch = vi.fn(async () => undefined);
      const close = vi.fn(async () => undefined);
      const createDriver = vi.fn(() => fakeDriver({ launch, close }));

      const result = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        [issue("TVDOCTOR-NAV-POOL000000000000000000000001"), issue("TVDOCTOR-NAV-POOL000000000000000000000002")],
        createDriver,
      );

      expect(result.every((entry) => !entry.failed)).toBe(true);
      expect(createDriver).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retires the pooled driver after an inconclusive capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-retire-"));
    try {
      const store = await createArtifactStore(root);
      let construction = 0;
      const closes: ReturnType<typeof vi.fn>[] = [];
      const createDriver = vi.fn(() => {
        construction += 1;
        const close = vi.fn(async () => undefined);
        closes.push(close);
        return fakeDriver({
          launch: async () => {
            if (construction === 1) throw new Error("first evidence context failed");
          },
          close,
        });
      });

      const result = await captureIssuesWithinBudget(
        store,
        "https://example.test/app",
        PRODUCTS,
        [issue("TVDOCTOR-NAV-RETIRE0000000000000000000001"), issue("TVDOCTOR-NAV-RETIRE0000000000000000000002")],
        createDriver,
      );

      expect(result[0]?.failed).toBe(true);
      expect(result[1]?.failed).toBe(false);
      expect(createDriver).toHaveBeenCalledTimes(2);
      expect(closes).toHaveLength(2);
      expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
