import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import {
  availableObservation,
  type ActionResult,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorIssue,
} from "@tvdoctor/protocol";
import { createArtifactStore } from "@tvdoctor/reporters";
import {
  EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS,
  type AuditRunProducts,
} from "../src/node-audit-contracts.js";
import { captureIssue, captureIssuesWithinBudget } from "../src/node-audit-evidence.js";

const PRODUCTS: AuditRunProducts = {
  navigation: null,
  navigationFindings: [],
  streaming: null,
  web: null,
};

const ISSUE_ID = "TVDOCTOR-NAV-SAFEREPLAY00000000000000001";

function issue(sequence: readonly RemoteKey[]): TVDoctorIssue {
  return {
    id: ISSUE_ID,
    rule: "remote.self-loop",
    title: "SELECT focus transition",
    description: "Fresh evidence must repeat the observed focus transition safely.",
    severity: "high",
    confidence: "deterministic",
    pack: "navigation",
    screen: "TV",
    expected: "The expected screen opens.",
    observed: "The observed screen opens.",
    transition: {
      fromElement: "current-control",
      action: "SELECT",
      expectedElement: "expected-target",
      observedElement: "opened-target",
    },
    evidence: [],
    reproduction: {
      status: "available",
      resetStrategy: "reload",
      originalSequence: sequence.map((key) => ({ key, repeat: 1 })),
      minimizedSequence: null,
      confidence: "deterministic",
      artifact: null,
    },
  };
}

function focusedSnapshot(name: string, stableId = "current-control"): StateSnapshot {
  return {
    capturedAt: "2026-10-08T00:00:00.000Z",
    location: availableObservation("https://example.test/"),
    focusedElement: availableObservation({ stableId, role: "button", name }),
    uiTree: availableObservation([{
      stableId,
      role: "button",
      name,
      text: name,
      bounds: { x: 0, y: 0, width: 150, height: 48 },
      visible: true,
      enabled: true,
      focusable: true,
      focused: true,
      modal: false,
      selectionState: null,
      valueNow: null,
      children: [],
    }]),
  };
}

function mockDriver(options: {
  initial?: string;
  afterRight?: string;
  afterScreenshot?: string;
}) {
  let focus = options.initial ?? "Browse";
  const press = vi.fn(async (key: RemoteKey): Promise<ActionResult> => {
    if (key === "RIGHT") focus = options.afterRight ?? focus;
    if (key === "SELECT") focus = "Opened";
    return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
  });
  const snapshot = vi.fn(async () => focusedSnapshot(
    focus,
    focus === "Opened" ? "opened-target" : "current-control",
  ));
  const screenshot = vi.fn(async () => {
    if (options.afterScreenshot !== undefined) focus = options.afterScreenshot;
    return Uint8Array.from([1, 2, 3]);
  });
  const close = vi.fn(async () => undefined);
  const driver = {
    launch: vi.fn(async () => { focus = options.initial ?? "Browse"; }),
    press,
    snapshot,
    getPage: () => ({ screenshot }),
    getLogs: async () => [],
    close,
  } as unknown as PlaywrightWebDriver;
  return { driver, press, snapshot, screenshot, close };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fresh evidence replay safety", () => {
  it.each(["Buy now", "Delete account"])(
    "withholds setup replay SELECT after focus drifts to %s",
    async (unsafe) => {
      const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-safe-setup-"));
      try {
        const store = await createArtifactStore(root);
        const { driver, press, snapshot, close } = mockDriver({ afterRight: unsafe });
        const original = issue(["RIGHT", "SELECT"]);
        const result = await captureIssue(store, "https://example.test/", PRODUCTS, original, () => driver);

        expect(press.mock.calls.map(([key]) => key)).toEqual(["RIGHT"]);
        // One observation to capture the pre-assertion state and another to
        // recheck SELECT safety immediately before attempting activation.
        expect(snapshot).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledOnce();
        expect(result.failed).toBe(true);
        expect(result.issue.id).toBe(original.id);
        expect(result.issue.rule).toBe(original.rule);
        expect(result.issue.reproduction).toMatchObject({ status: "unavailable" });
        expect(result.replay).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("takes a fresh safety snapshot after the before-screenshot changes focus to Delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-safe-assertion-"));
    try {
      const store = await createArtifactStore(root);
      const { driver, press, snapshot, screenshot } = mockDriver({ afterScreenshot: "Delete account" });
      const result = await captureIssue(store, "https://example.test/", PRODUCTS, issue(["SELECT"]), () => driver);

      expect(screenshot).toHaveBeenCalledOnce();
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(press).not.toHaveBeenCalled();
      expect(result.failed).toBe(true);
      expect(result.issue.reproduction.status).toBe("unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still replays a safe SELECT and preserves freshly verified evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-safe-pass-"));
    try {
      const store = await createArtifactStore(root);
      const { driver, press, snapshot } = mockDriver({});
      const result = await captureIssue(store, "https://example.test/", PRODUCTS, issue(["SELECT"]), () => driver);

      expect(snapshot).toHaveBeenCalledTimes(3);
      expect(press.mock.calls.map(([key]) => key)).toEqual(["SELECT"]);
      expect(result.failed).toBe(false);
      expect(result.issue.reproduction.status).toBe("available");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never sends SELECT if the safety snapshot resolves after the evidence deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-select-timeout-"));
    try {
      const store = await createArtifactStore(root);
      let releaseSnapshot: ((snapshot: StateSnapshot) => void) | undefined;
      let announceGuard: (() => void) | undefined;
      const guardReached = new Promise<void>((resolve) => { announceGuard = resolve; });
      const delayedSnapshot = new Promise<StateSnapshot>((resolve) => { releaseSnapshot = resolve; });
      let count = 0;
      const press = vi.fn(async (key: RemoteKey): Promise<ActionResult> => ({
        key, outcome: "applied", timing: { inputSentAtMs: 1 },
      }));
      const driver = {
        launch: async () => undefined,
        snapshot: async () => {
          count += 1;
          if (count === 2) {
            announceGuard?.();
            return await delayedSnapshot;
          }
          return focusedSnapshot("Browse");
        },
        press,
        getPage: () => ({ screenshot: async () => Uint8Array.from([1]) }),
        getLogs: async () => [],
        close: async () => undefined,
      } as unknown as PlaywrightWebDriver;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const capture = captureIssue(store, "https://example.test/", PRODUCTS, issue(["SELECT"]), () => driver);
      await guardReached;
      await vi.advanceTimersByTimeAsync(EVIDENCE_CAPTURE_PER_ISSUE_TIMEOUT_MS + 1);
      const result = await capture;
      releaseSnapshot?.(focusedSnapshot("Browse"));
      await Promise.resolve();

      expect(press).not.toHaveBeenCalled();
      expect(result.failed).toBe(true);
      expect(result.issue.reproduction.status).toBe("unavailable");
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a monotonic evidence run budget even when the wall clock jumps", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-monotonic-"));
    try {
      const store = await createArtifactStore(root);
      const dateNow = vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValue(5_000_000);
      const captures: string[] = [];
      const results = await captureIssuesWithinBudget(
        store, "https://example.test/", PRODUCTS,
        [issue(["RIGHT"]), { ...issue(["RIGHT"]), id: `${ISSUE_ID}-2` }],
        () => { throw new Error("No browser should be constructed by injected capture."); },
        async (_store, _target, _products, selected) => {
          captures.push(selected.id);
          return { issue: selected, artifacts: [], replay: null, failed: false };
        },
      );
      expect(captures).toHaveLength(2);
      expect(results.every((entry) => !entry.failed)).toBe(true);
      expect(dateNow).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
