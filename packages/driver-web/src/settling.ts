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
  readonly ambientChurnEscape: boolean;
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

interface SettleWaitOptions {
  /** Initial page work has no input-caused branch, so new continuous churn is ambient. */
  readonly includePostBaselineAmbientChurn?: boolean;
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
  options: SettleWaitOptions = {},
): Promise<SettleResult> {
  const readResult = async (timedOut: boolean): Promise<SettleResult> => page.evaluate(
    ({ actionBaseline, didTimeOut, settleConfiguration, waitOptions }) => {
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
      const postBaselineMutations = responseEvents.filter((event) => event.kind === "mutation");
      const lastPostBaselineMutationAtMs = postBaselineMutations.at(-1)?.atEpochMs
        ?? Number.NEGATIVE_INFINITY;
      const postBaselineAmbientChurn = waitOptions.includePostBaselineAmbientChurn === true
        && postBaselineMutations.length >= 4
        && Date.now() - actionBaseline.capturedAtEpochMs >= settleConfiguration.noResponseGraceMs
        && Date.now() - lastPostBaselineMutationAtMs <= 250;
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
          ? (focusEvent?.atEpochMs ?? tracker?.lastFocusAtEpochMs ?? Date.now())
            + settleConfiguration.quietWindowMs
          : null,
        screenSettledAtMs: Date.now(),
        timedOut: didTimeOut,
        boundedByAmbientChurn: settleConfiguration.ambientChurnEscape
          && (ambientChurn || postBaselineAmbientChurn),
      };
    },
    {
      actionBaseline: baseline,
      didTimeOut: timedOut,
      settleConfiguration: configuration,
      waitOptions: options,
    },
  );

  try {
    await page.waitForFunction(
      ({ actionBaseline, settleConfiguration, waitOptions }) => {
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
        const postBaselineMutations = (tracker?.events ?? []).filter((event) => (
          event.kind === "mutation" && event.atEpochMs >= actionBaseline.capturedAtEpochMs
        ));
        const lastPostBaselineMutationAtMs = postBaselineMutations.at(-1)?.atEpochMs
          ?? Number.NEGATIVE_INFINITY;
        const postBaselineAmbientChurn = waitOptions.includePostBaselineAmbientChurn === true
          && postBaselineMutations.length >= 4
          && now - lastPostBaselineMutationAtMs <= 250;
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
            || ((ambientChurn || postBaselineAmbientChurn)
              && settleConfiguration.ambientChurnEscape
              && ambientChurnBoundReached));
      },
      {
        actionBaseline: baseline,
        settleConfiguration: configuration,
        waitOptions: options,
      },
      {
        polling: 25,
        timeout: configuration.timeoutMs,
      },
    );
    return readResult(false);
  } catch {
    return readResult(true);
  }
}

export async function waitForInitialPageSettle(
  page: Page,
  configuration: SettleConfiguration,
): Promise<SettleResult> {
  // Capture the event baseline before animation-frame boot work. The regular
  // quiet-window logic can then observe and settle that work without imposing
  // an unconditional sleep on every deterministic reset.
  const baseline = await readSettleBaseline(page);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  return waitForPageSettle(page, baseline, configuration, {
    includePostBaselineAmbientChurn: true,
  });
}
