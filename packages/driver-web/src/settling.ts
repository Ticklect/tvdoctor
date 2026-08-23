import type { Page } from "playwright";

interface SettleBaseline {
  readonly capturedAtEpochMs: number;
  readonly focusKey: string;
  readonly focusVersion: number;
  readonly location: string;
  readonly mutationVersion: number;
  readonly screen: string;
}

export interface SettleConfiguration {
  readonly noResponseGraceMs: number;
  readonly quietWindowMs: number;
  readonly timeoutMs: number;
}

export interface SettleResult {
  readonly firstResponseAtMs: number | null;
  readonly focusChanged: boolean;
  readonly focusSettledAtMs: number | null;
  readonly screenSettledAtMs: number;
  readonly timedOut: boolean;
  /** True when an already-continuous animation/mutation source ended the wait early. */
  readonly boundedByAmbientChurn: boolean;
}

export async function installSettleTracker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type EventKind = "focus" | "mutation";

    interface TrackerEvent {
      readonly atEpochMs: number;
      readonly kind: EventKind;
    }

    interface Tracker {
      events: TrackerEvent[];
      focusVersion: number;
      lastFocusAtEpochMs: number;
      lastMutationAtEpochMs: number;
      mutationVersion: number;
    }

    interface TrackerWindow extends Window {
      __tvdoctorSettleTracker?: Tracker;
    }

    const trackerWindow = window as TrackerWindow;
    if (trackerWindow.__tvdoctorSettleTracker !== undefined) {
      return;
    }

    const startedAt = Date.now();
    const tracker: Tracker = {
      events: [],
      focusVersion: 0,
      lastFocusAtEpochMs: startedAt,
      lastMutationAtEpochMs: startedAt,
      mutationVersion: 0,
    };
    trackerWindow.__tvdoctorSettleTracker = tracker;

    const record = (kind: EventKind): void => {
      const atEpochMs = Date.now();
      if (kind === "focus") {
        tracker.focusVersion += 1;
        tracker.lastFocusAtEpochMs = atEpochMs;
      } else {
        tracker.mutationVersion += 1;
        tracker.lastMutationAtEpochMs = atEpochMs;
      }
      tracker.events.push({ atEpochMs, kind });
      if (tracker.events.length > 64) {
        tracker.events.splice(0, tracker.events.length - 64);
      }
    };

    const isVolatileMutation = (mutation: MutationRecord): boolean => {
      const element = mutation.target instanceof Element
        ? mutation.target
        : mutation.target.parentElement;
      if (element === null) {
        return false;
      }
      return element.closest(
        "[aria-live], [role='status'], progress, [role='progressbar'], time, [data-player-time], [data-tv-volatile='true'], audio, video",
      ) !== null;
    };

    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => !isVolatileMutation(mutation))) {
        record("mutation");
      }
    });
    observer.observe(document, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener("focusin", () => record("focus"), true);
    for (const eventName of [
      "abort",
      "emptied",
      "ended",
      "error",
      "loadedmetadata",
      "pause",
      "play",
      "playing",
      "ratechange",
      "seeked",
      "seeking",
      "stalled",
      "volumechange",
      "waiting",
    ]) {
      document.addEventListener(eventName, (event) => {
        if (event.target instanceof HTMLMediaElement) {
          record("mutation");
        }
      }, true);
    }
  });
}

export async function readSettleBaseline(page: Page): Promise<SettleBaseline> {
  return page.evaluate(() => {
    interface TrackerWindow extends Window {
      __tvdoctorSettleTracker?: {
        focusVersion: number;
        mutationVersion: number;
      };
    }

    const tracker = (window as TrackerWindow).__tvdoctorSettleTracker;
    const active = document.activeElement;
    const focusKey = active instanceof Element
      ? active.getAttribute("data-tv-id")
        || (active instanceof HTMLElement ? active.id : "")
        || `${active.tagName}:${active.getAttribute("aria-label") ?? active.textContent?.slice(0, 80) ?? ""}`
      : "";
    return {
      capturedAtEpochMs: Date.now(),
      focusKey,
      focusVersion: tracker?.focusVersion ?? 0,
      location: window.location.href,
      mutationVersion: tracker?.mutationVersion ?? 0,
      screen: document.body?.getAttribute("data-screen") ?? "",
    };
  });
}

export async function waitForPageSettle(
  page: Page,
  baseline: SettleBaseline,
  configuration: SettleConfiguration,
): Promise<SettleResult> {
  const readResult = async (timedOut: boolean): Promise<SettleResult> => page.evaluate(
    ({ actionBaseline, didTimeOut, quietWindowMs }) => {
      interface TrackerEvent {
        readonly atEpochMs: number;
        readonly kind: "focus" | "mutation";
      }
      interface TrackerWindow extends Window {
        __tvdoctorSettleTracker?: {
          events: TrackerEvent[];
          focusVersion: number;
          lastFocusAtEpochMs: number;
          mutationVersion: number;
        };
      }
      const tracker = (window as TrackerWindow).__tvdoctorSettleTracker;
      const active = document.activeElement;
      const focusKey = active instanceof Element
        ? active.getAttribute("data-tv-id")
          || (active instanceof HTMLElement ? active.id : "")
          || `${active.tagName}:${active.getAttribute("aria-label") ?? active.textContent?.slice(0, 80) ?? ""}`
        : "";
      const focusChanged = focusKey !== actionBaseline.focusKey
        || (tracker?.focusVersion ?? 0) > actionBaseline.focusVersion;
      const preActionMutations = (tracker?.events ?? []).filter((event) => (
        event.kind === "mutation" && event.atEpochMs < actionBaseline.capturedAtEpochMs
      ));
      const lastPreActionMutationAtMs = preActionMutations.at(-1)?.atEpochMs
        ?? Number.NEGATIVE_INFINITY;
      const ambientChurn = preActionMutations.length >= 4
        && actionBaseline.capturedAtEpochMs - lastPreActionMutationAtMs <= 250;
      const responseEvents = tracker?.events.filter(
        (event) => event.atEpochMs >= actionBaseline.capturedAtEpochMs,
      ) ?? [];
      const firstResponse = responseEvents[0]?.atEpochMs
        ?? (focusKey !== actionBaseline.focusKey
          || window.location.href !== actionBaseline.location
          || (document.body?.getAttribute("data-screen") ?? "") !== actionBaseline.screen
          ? Date.now()
          : null);
      const focusEvent = responseEvents.findLast((event) => event.kind === "focus");
      return {
        firstResponseAtMs: firstResponse,
        focusChanged,
        focusSettledAtMs: focusChanged
          ? (focusEvent?.atEpochMs ?? tracker?.lastFocusAtEpochMs ?? Date.now()) + quietWindowMs
          : null,
        screenSettledAtMs: Date.now(),
        timedOut: didTimeOut,
        boundedByAmbientChurn: ambientChurn,
      };
    },
    {
      actionBaseline: baseline,
      didTimeOut: timedOut,
      quietWindowMs: configuration.quietWindowMs,
    },
  );

  try {
    await page.waitForFunction(
      ({ actionBaseline, settleConfiguration }) => {
        interface TrackerWindow extends Window {
          __tvdoctorSettleTracker?: {
            events: {
              readonly atEpochMs: number;
              readonly kind: "focus" | "mutation";
            }[];
            focusVersion: number;
            lastFocusAtEpochMs: number;
            lastMutationAtEpochMs: number;
            mutationVersion: number;
          };
        }

        const tracker = (window as TrackerWindow).__tvdoctorSettleTracker;
        const now = Date.now();
        const active = document.activeElement;
        const focusKey = active instanceof Element
          ? active.getAttribute("data-tv-id")
            || (active instanceof HTMLElement ? active.id : "")
            || `${active.tagName}:${active.getAttribute("aria-label") ?? active.textContent?.slice(0, 80) ?? ""}`
          : "";
        const screen = document.body?.getAttribute("data-screen") ?? "";
        const responded = focusKey !== actionBaseline.focusKey
          || screen !== actionBaseline.screen
          || window.location.href !== actionBaseline.location
          || (tracker?.focusVersion ?? 0) > actionBaseline.focusVersion
          || (tracker?.mutationVersion ?? 0) > actionBaseline.mutationVersion;
        const preActionMutations = (tracker?.events ?? []).filter((event) => (
          event.kind === "mutation" && event.atEpochMs < actionBaseline.capturedAtEpochMs
        ));
        const lastPreActionMutationAtMs = preActionMutations.at(-1)?.atEpochMs
          ?? Number.NEGATIVE_INFINITY;
        // A source already mutating continuously before input is ambient churn.
        // Canonical snapshots and replay remain the correctness gate.
        const ambientChurn = preActionMutations.length >= 4
          && actionBaseline.capturedAtEpochMs - lastPreActionMutationAtMs <= 250;
        const ambientChurnBoundReached = now - actionBaseline.capturedAtEpochMs
          >= settleConfiguration.noResponseGraceMs;
        const lastMeaningfulChange = Math.max(
          actionBaseline.capturedAtEpochMs,
          tracker?.lastFocusAtEpochMs ?? 0,
          tracker?.lastMutationAtEpochMs ?? 0,
        );
        const quiet = now - lastMeaningfulChange >= settleConfiguration.quietWindowMs;
        const noResponseIsStable = now - actionBaseline.capturedAtEpochMs
          >= settleConfiguration.noResponseGraceMs;
        const busy = Array.from(document.querySelectorAll<HTMLElement>("[aria-busy='true']"))
          .some((element) => {
            const styles = getComputedStyle(element);
            return styles.display !== "none" && styles.visibility !== "hidden";
          });
        const finiteAnimationRunning = document.getAnimations().some((animation) => {
          if (animation.playState !== "running") {
            return false;
          }
          const iterations = animation.effect?.getComputedTiming().iterations;
          return iterations !== Infinity;
        });

        return document.readyState !== "loading"
          && !busy
          && ((quiet && !finiteAnimationRunning && (responded || noResponseIsStable))
            || (ambientChurn && ambientChurnBoundReached));
      },
      {
        actionBaseline: baseline,
        settleConfiguration: configuration,
      },
      {
        polling: 25,
        timeout: configuration.timeoutMs,
      },
    );
    return {
      ...await readResult(false),
      boundedByAmbientChurn: true,
    };
  } catch {
    return readResult(true);
  }
}

export async function waitForInitialPageSettle(
  page: Page,
  configuration: SettleConfiguration,
): Promise<SettleResult> {
  // App boot code commonly schedules initial focus in requestAnimationFrame.
  // Observe two frames before taking the baseline so an otherwise quiet page
  // cannot be declared settled between DOMContentLoaded and that focus work.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  // Sample long-lived churn before taking the initial baseline so launch/reset
  // can distinguish an already-continuous source from one caused by input.
  await page.waitForTimeout(250);
  const baseline = await readSettleBaseline(page);
  return waitForPageSettle(page, baseline, {
    ...configuration,
    noResponseGraceMs: 0,
  });
}
