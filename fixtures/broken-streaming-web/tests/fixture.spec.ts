import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

interface SeededDefect {
  readonly id: string;
}

interface SeededDefectManifest {
  readonly defects: readonly SeededDefect[];
  readonly fixture: string;
  readonly schemaVersion: number;
}

const DEFAULT_HOME_SELF_LOOPS = [
  "fresh-card-4:right",
  "hero-watch:right",
  "home-card-4:right",
] as const;

async function focusedTvId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-tv-id") ?? null);
}

async function expectFocus(page: Page, tvId: string): Promise<void> {
  await expect.poll(() => focusedTvId(page)).toBe(tvId);
}

async function focusPath(page: Page, keys: readonly string[]): Promise<readonly (string | null)[]> {
  await expect.poll(() => focusedTvId(page)).not.toBeNull();
  const path: (string | null)[] = [await focusedTvId(page)];
  for (const key of keys) {
    await page.keyboard.press(key);
    path.push(await focusedTvId(page));
  }
  return path;
}

async function remoteControlOrder(page: Page, selector: string): Promise<readonly (string | null)[]> {
  return await page.locator(selector).evaluateAll((elements) => (
    elements.map((element) => element.getAttribute("data-tv-id"))
  ));
}

async function selfLoopEdges(page: Page, screen: string): Promise<readonly string[]> {
  const edges = await page
    .locator(`[data-screen="${screen}"][data-remote="true"][data-tv-id]`)
    .evaluateAll((elements) => elements.flatMap((element) => {
      const id = element.getAttribute("data-tv-id");
      if (id === null) return [];
      return ["up", "right", "down", "left"].flatMap((direction) => (
        element.getAttribute(`data-nav-${direction}`) === id ? [`${id}:${direction}`] : []
      ));
    }));
  return edges.sort();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('body[data-screen="home"]')).toBeVisible();
  await expectFocus(page, "home-nav-home");
});

test("maps D-pad, Select, Escape and Backspace onto real DOM focus", async ({ page }) => {
  await page.keyboard.press("ArrowRight");
  await expectFocus(page, "hero-watch");

  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="details"]')).toBeVisible();
  await expectFocus(page, "details-play");

  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="player"]')).toBeVisible();
  await expectFocus(page, "player-play-pause");

  await page.keyboard.press("Escape");
  await expect(page.locator('main[data-screen="details"]')).toBeVisible();
  await expectFocus(page, "details-play");

  // This is deliberately incorrect Back behavior: Home-origin details opens Search.
  await page.keyboard.press("Backspace");
  await expect(page.locator('main[data-screen="search"]')).toBeVisible();
  await expectFocus(page, "search-query");
});

test("keeps the default M6 semantic journey edges stable", async ({ page }) => {
  const homeToContent = await focusPath(page, ["ArrowRight"]);
  expect(homeToContent).toEqual(["home-nav-home", "hero-watch"]);
  expect(await selfLoopEdges(page, "home")).toEqual(DEFAULT_HOME_SELF_LOOPS);
  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="details"]')).toBeVisible();
  await expectFocus(page, "details-play");

  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="player"]')).toBeVisible();
  await expectFocus(page, "player-play-pause");
  expect(await remoteControlOrder(page, '.transport__row > [data-remote="true"]')).toEqual([
    "player-rewind",
    "player-play-pause",
    "player-forward",
    "player-captions",
    "player-settings",
  ]);
  const playerToSettings = await focusPath(page, [
    "ArrowLeft",
    "ArrowRight",
    "ArrowRight",
    "ArrowRight",
    "ArrowRight",
  ]);
  expect(playerToSettings).toEqual([
    "player-play-pause",
    "player-rewind",
    "player-play-pause",
    "player-forward",
    "player-captions",
    "player-settings",
  ]);
  expect(await selfLoopEdges(page, "player")).toEqual(["player-settings:right"]);

  await page.keyboard.press("Enter");
  await expect(page.locator('[data-tv-id="settings-panel"]')).toBeVisible({ timeout: 3_000 });
  await expectFocus(page, "settings-captions");
  await page.keyboard.press("Enter");
  await expectFocus(page, "captions-off");
  expect(await remoteControlOrder(page, '.drawer--nested > [data-remote="true"]')).toEqual([
    "captions-off",
    "captions-english",
    "captions-spanish",
    "captions-appearance",
  ]);
  const captionsToAppearance = await focusPath(page, ["ArrowDown", "ArrowDown", "ArrowDown"]);
  expect(captionsToAppearance).toEqual([
    "captions-off",
    "captions-english",
    "captions-spanish",
    "captions-appearance",
  ]);
  expect(await selfLoopEdges(page, "captions")).toEqual([]);

  await page.keyboard.press("Enter");
  await expect(page.locator('[data-screen="caption-appearance"][role="dialog"]')).toBeVisible();
  await expectFocus(page, "caption-font-size");
});

test("uses different D-pad edges for the test-only semantic alternate route", async ({ page }) => {
  await page.goto("/?routeVariant=semantic-alternate");
  await expect(page.locator('body[data-screen="home"]')).toBeVisible();
  await expectFocus(page, "home-card-1");

  const homeNav = page.locator('[data-tv-id="home-nav-home"]');
  await expect(homeNav).toHaveAttribute("data-nav-right", "hero-watch");
  const homeJunction = await focusPath(page, ["ArrowUp", "ArrowLeft", "ArrowRight", "ArrowDown"]);
  expect(homeJunction).toEqual([
    "home-card-1",
    "hero-watch",
    "home-nav-home",
    "hero-watch",
    "home-card-1",
  ]);
  expect(homeJunction[0]).not.toBe("home-nav-home");
  expect(await selfLoopEdges(page, "home")).toEqual(DEFAULT_HOME_SELF_LOOPS);
  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="details"]')).toBeVisible();
  await expectFocus(page, "details-play");

  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="player"]')).toBeVisible();
  await expectFocus(page, "player-play-pause");
  expect(await remoteControlOrder(page, '.transport__row > [data-remote="true"]')).toEqual([
    "player-rewind",
    "player-play-pause",
    "player-settings",
    "player-forward",
    "player-captions",
  ]);
  const playerToSettings = await focusPath(page, ["ArrowLeft", "ArrowRight", "ArrowRight"]);
  expect(playerToSettings).toEqual([
    "player-play-pause",
    "player-rewind",
    "player-play-pause",
    "player-settings",
  ]);
  expect(playerToSettings).not.toEqual([
    "player-play-pause",
    "player-forward",
    "player-captions",
    "player-settings",
  ]);
  const remainingPlayerControls = await focusPath(page, ["ArrowRight", "ArrowRight"]);
  expect(remainingPlayerControls).toEqual([
    "player-settings",
    "player-forward",
    "player-captions",
  ]);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expectFocus(page, "player-settings");
  expect(await selfLoopEdges(page, "player")).toEqual([]);

  await page.keyboard.press("Enter");
  await expect(page.locator('[data-tv-id="settings-panel"]')).toBeVisible({ timeout: 3_000 });
  await expectFocus(page, "settings-captions");
  await page.keyboard.press("Enter");
  await expectFocus(page, "captions-off");
  expect(await remoteControlOrder(page, '.drawer--nested > [data-remote="true"]')).toEqual([
    "captions-off",
    "captions-appearance",
    "captions-english",
    "captions-spanish",
  ]);
  const captionsToAppearance = await focusPath(page, ["ArrowDown", "ArrowDown", "ArrowDown"]);
  expect(captionsToAppearance).toEqual([
    "captions-off",
    "captions-appearance",
    "captions-english",
    "captions-spanish",
  ]);
  expect(captionsToAppearance).not.toEqual([
    "captions-off",
    "captions-english",
    "captions-spanish",
    "captions-appearance",
  ]);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expectFocus(page, "captions-appearance");
  expect(await selfLoopEdges(page, "captions")).toEqual([]);

  await page.keyboard.press("Enter");
  await expect(page.locator('[data-screen="caption-appearance"][role="dialog"]')).toBeVisible();
  await expectFocus(page, "caption-font-size");
  await expect(page.locator('[data-tv-id="caption-text-colour"]'))
    .toHaveAttribute("data-defect-id", "fixture-caption-text-colour-remote-unreachable");
  await expect(page.locator('[data-tv-id="caption-text-colour"]')).toHaveAttribute("data-remote", "false");
});

test("keeps playback paused while proving the seeded inverted Rewind delta", async ({ page }) => {
  await page.keyboard.press("ArrowRight");
  await expectFocus(page, "hero-watch");
  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="details"]')).toBeVisible();
  await expectFocus(page, "details-play");
  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="player"]')).toBeVisible();
  await expectFocus(page, "player-play-pause");

  await page.keyboard.press("Enter");
  await expect(page.locator('[data-tv-id="player-play-pause"]')).toHaveAttribute("aria-pressed", "false");
  const progressbar = page.locator('[role="progressbar"]');
  const before = Number(await progressbar.getAttribute("aria-valuenow"));
  await page.waitForTimeout(1_100);
  expect(Number(await progressbar.getAttribute("aria-valuenow"))).toBe(before);

  await page.keyboard.press("ArrowLeft");
  await expectFocus(page, "player-rewind");
  await page.keyboard.press("Enter");
  await expect.poll(async () => Number(await progressbar.getAttribute("aria-valuenow"))).toBe(before + 10);

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-tv-id="player-play-pause"]')).toHaveAttribute("aria-pressed", "true");
});

test("reproduces the distant RIGHT jump and weak focus seed", async ({ page }) => {
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expectFocus(page, "home-card-1");

  await page.keyboard.press("ArrowRight");
  await expectFocus(page, "home-card-2");

  const weakFocus = await page.locator('[data-tv-id="home-card-2"]').evaluate((element) => {
    const styles = getComputedStyle(element);
    return { boxShadow: styles.boxShadow, outlineWidth: styles.outlineWidth, transform: styles.transform };
  });
  expect(weakFocus.outlineWidth).toBe("1px");
  expect(weakFocus.boxShadow).toBe("none");
  expect(weakFocus.transform).toBe("none");

  await page.keyboard.press("ArrowRight");
  await expectFocus(page, "home-card-3");
  await page.keyboard.press("ArrowRight");
  await expectFocus(page, "footer-privacy");
});

test("keeps remote focus trapped until the pointer-only close control is clicked", async ({ page }) => {
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectFocus(page, "home-nav-library");
  await page.keyboard.press("Enter");
  await expectFocus(page, "profile-primary");

  await page.keyboard.press("ArrowRight");
  await expectFocus(page, "profile-kids");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await expectFocus(page, "profile-kids");
  await expect(page.locator('[role="dialog"][data-screen="profile-picker"]')).toBeVisible();

  const close = page.locator('[data-tv-id="profile-close-pointer"]');
  await expect(close).toHaveAttribute("data-remote", "false");
  await close.click();
  await expect(page.locator('[role="dialog"][data-screen="profile-picker"]')).toHaveCount(0);
  await expectFocus(page, "home-nav-library");
});

test("supports a remote search flow while leaving submit pointer-only", async ({ page }) => {
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="search"]')).toBeVisible();
  await expectFocus(page, "search-query");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#catalogue-query")).toHaveValue("N");
  await expect(page.locator('[data-tv-id="search-result-1"]')).toBeVisible();

  const submitId = "search-submit";
  const incomingRemoteEdges = await page.locator('[data-remote="true"]').evaluateAll((elements, targetId) => {
    return elements.flatMap((element) => ["up", "right", "down", "left"]
      .filter((direction) => element.getAttribute(`data-nav-${direction}`) === targetId));
  }, submitId);
  await expect(page.locator('[data-tv-id="search-submit"]')).toHaveAttribute("data-remote", "false");
  expect(incomingRemoteEdges).toEqual([]);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectFocus(page, "search-result-1");
  await page.keyboard.press("Enter");
  await expect(page.locator('main[data-screen="details"]')).toBeVisible();
});

test("reaches caption appearance and proves Text Colour has no D-pad path", async ({ page }) => {
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expectFocus(page, "player-play-pause");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expectFocus(page, "player-settings");

  const startedAt = Date.now();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-tv-id="settings-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-tv-id="player-settings"]')).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-tv-id="settings-panel"]')).toBeVisible({ timeout: 3_000 });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
  await expectFocus(page, "settings-captions");

  const bounds = await page.locator('[data-tv-id="settings-panel"]').boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeGreaterThan(1_280);

  await page.keyboard.press("Enter");
  await expectFocus(page, "captions-off");
  await page.keyboard.press("ArrowDown");
  await expectFocus(page, "captions-english");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-tv-id="captions-off"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-tv-id="captions-english"]')).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectFocus(page, "captions-appearance");
  await page.keyboard.press("Enter");
  await expectFocus(page, "caption-font-size");

  const textColour = page.locator('[data-tv-id="caption-text-colour"]');
  await expect(textColour).toBeVisible();
  await expect(textColour).toHaveAttribute("data-remote", "false");
  await page.keyboard.press("ArrowDown");
  await expectFocus(page, "caption-background-colour");

  const incomingRemoteEdges = await page.locator('[data-remote="true"]').evaluateAll((elements) => elements
    .flatMap((element) => ["up", "right", "down", "left"]
      .map((direction) => element.getAttribute(`data-nav-${direction}`)))
    .filter((target) => target === "caption-text-colour"));
  expect(incomingRemoteEdges).toEqual([]);

  const before = await textColour.locator("small").textContent();
  await textColour.click();
  await expect(page.locator('[data-tv-id="caption-text-colour"] small')).not.toHaveText(before ?? "");
});

test("emits the deliberate startup console error", async ({ browser }) => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.goto("/");
  await expect.poll(() => errors).toContainEqual(expect.stringContaining("Seeded startup console error"));
  await page.close();
});

test("provides an opt-in 240-card repeated carousel for the M8 benchmark", async ({ page }) => {
  await page.goto("/?carouselSize=240");
  const row = page.locator(".stress-poster-row");
  await expect(row.locator(":scope > .stress-poster")).toHaveCount(240);
  await expect(row.locator('[data-tv-id="stress-card-001"]')).toHaveAttribute(
    "aria-label",
    "Open repeated carousel item 001 details",
  );
  await expect(row.locator('[data-tv-id="stress-card-240"]')).toHaveAttribute(
    "data-nav-right",
    "stress-card-240",
  );

  await focusPath(page, ["ArrowRight", "ArrowDown", "ArrowDown", "ArrowDown"]);
  await expectFocus(page, "stress-card-001");
  await page.keyboard.press("ArrowRight");
  await expectFocus(page, "stress-card-002");

  await page.goto("/?carouselSize=501");
  await expect(page.locator(".stress-shelf")).toHaveCount(0);
});

test("provides clean and exactly localized M10 focus-regression variants", async ({ page }) => {
  await page.goto("/?baselineVariant=clean");
  await focusPath(page, ["ArrowRight", "ArrowDown", "ArrowDown", "ArrowDown"]);
  await expectFocus(page, "m10-probe-a");
  await page.keyboard.press("Enter");
  await expectFocus(page, "m10-probe-a");

  await page.goto("/?baselineVariant=regressed");
  await focusPath(page, ["ArrowRight", "ArrowDown", "ArrowDown", "ArrowDown"]);
  await expectFocus(page, "m10-probe-a");
  await page.keyboard.press("Enter");
  await expect.poll(() => focusedTvId(page)).toBeNull();
  await expect(page.locator('[data-tv-id="m10-probe-b"]')).toBeVisible();

  await page.goto("/?baselineVariant=unknown");
  await expect(page.locator(".baseline-harness")).toHaveCount(0);
});

test("publishes a stable machine-readable manifest for every required seed", () => {
  const manifestUrl = new URL("../seeded-defects.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as SeededDefectManifest;
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.fixture).toBe("broken-streaming-web");
  expect(manifest.defects).toHaveLength(13);
  expect(new Set(manifest.defects.map((defect) => defect.id))).toEqual(new Set([
    "fixture-home-more-info-unreachable",
    "fixture-profile-focus-trap",
    "fixture-carousel-right-jump",
    "fixture-details-back-wrong-screen",
    "fixture-card-focus-indicator-weak",
    "fixture-player-settings-clipped",
    "fixture-player-rewind-inverted",
    "fixture-caption-track-toggle-ignored",
    "fixture-caption-text-colour-remote-unreachable",
    "fixture-player-volume-pointer-only",
    "fixture-search-submit-pointer-only",
    "fixture-player-settings-slow-open",
    "fixture-startup-console-error",
  ]));
});
