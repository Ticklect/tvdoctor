import { expect, test } from "@playwright/test";
import type { Observation } from "@tvdoctor/protocol";

import { sanitiseObservedText, sanitiseSnapshotUrl, sanitiseUrl } from "../src/security.js";
import { PlaywrightWebDriver } from "../src/web-driver.js";

function observedLocation(observation: Observation<string>): string {
  expect(observation.status).toBe("available");
  if (observation.status !== "available") throw new Error("A web snapshot must expose its location.");
  return observation.value;
}

test("snapshot routes distinguish allowlisted selectors while discarding tracking and credentials", () => {
  const base = "https://user:password@example.test/watch";
  const search = sanitiseSnapshotUrl(`${base}?view=search&token=super-secret&clock=12&utm_source=ad`);
  const searchChangedTracking = sanitiseSnapshotUrl(
    `${base}?utm_source=elsewhere&clock=99&view=search&token=another-secret`,
  );
  const settings = sanitiseSnapshotUrl(`${base}?view=settings&token=super-secret`);
  const queryNames = ["route", "view", "screen", "tab", "panel", "section", "mode", "page",
    "step", "id", "item", "video", "title", "episode", "routevariant", "content"];

  expect(search).toBe(searchChangedTracking);
  expect(search).not.toBe(settings);
  expect(search).toMatch(/^https:\/\/example\.test\/__tvroute\/r_[a-f0-9]{24}\?view=r_[a-f0-9]{24}$/u);
  for (const raw of ["user", "password", "/watch", "search", "super-secret", "clock", "utm_", "token="]) {
    expect(search).not.toContain(raw);
  }
  for (const name of queryNames) {
    const left = sanitiseSnapshotUrl(`https://example.test/?${name}=left`);
    const right = sanitiseSnapshotUrl(`https://example.test/?${name}=right`);
    expect(left).not.toBe(right);
    expect(left).toContain(`?${name}=r_`);
  }
  expect(sanitiseSnapshotUrl("https://example.test/?token=first&ts=1"))
    .toBe(sanitiseSnapshotUrl("https://example.test/?token=second&ts=2"));
});

test("SPA hash paths remain distinct without exposing route segments, selectors or non-route anchors", () => {
  const settings = sanitiseSnapshotUrl(
    "https://example.test/#/settings?tab=general&access_token=secret-value",
  );
  const search = sanitiseSnapshotUrl(
    "https://example.test/#/search?tab=general&access_token=different-value",
  );
  const settingsWithTracking = sanitiseSnapshotUrl(
    "https://example.test/#!/settings?tab=general&access_token=another&timestamp=123",
  );
  expect(settings).not.toBe(search);
  expect(settings).toBe(settingsWithTracking);
  expect(settings).toMatch(/^https:\/\/example\.test\/#\/r_[a-f0-9]{24}\?tab=r_[a-f0-9]{24}$/u);
  expect(settings).not.toContain("settings");
  expect(settings).not.toContain("general");
  expect(settings).not.toContain("secret-value");
  expect(settings).not.toContain("access_token");
  expect(sanitiseSnapshotUrl("https://example.test/#notice")).toBe("https://example.test/");
  expect(sanitiseSnapshotUrl("https://example.test/#notice"))
    .toBe(sanitiseSnapshotUrl("https://example.test/#other-anchor"));
  const fragmentSelectorSearch = sanitiseSnapshotUrl("https://example.test/#view=search&token=secret-value");
  const fragmentSelectorSettings = sanitiseSnapshotUrl("https://example.test/#view=settings&token=another-secret");
  expect(fragmentSelectorSearch).not.toBe(fragmentSelectorSettings);
  expect(fragmentSelectorSearch).toMatch(/^https:\/\/example\.test\/#view=r_[a-f0-9]{24}$/u);
  expect(fragmentSelectorSearch).not.toContain("secret-value");
  for (const selector of ["routevariant", "content"]) {
    const searchValue = `${selector}-private-search`;
    const settingsValue = `${selector}-private-settings`;
    for (const prefix of ["https://example.test/?", "https://example.test/#/settings?",
      "https://example.test/#"]) {
      const searchIdentity = sanitiseSnapshotUrl(`${prefix}${selector}=${searchValue}`);
      const settingsIdentity = sanitiseSnapshotUrl(`${prefix}${selector}=${settingsValue}`);
      expect(searchIdentity).not.toBe(settingsIdentity);
      expect(searchIdentity).toContain(`${selector}=r_`);
      expect(searchIdentity).not.toContain(searchValue);
      expect(settingsIdentity).not.toContain(settingsValue);
    }
  }
});

test("URL identity is bounded, preserves overflowing route selectors and never leaks secret paths", () => {
  const selectors = Array.from({ length: 150 }, (_, index) => `tab=value-${index}`).join("&");
  const original = `https://example.test/private/token/opaque-credential?${selectors}`;
  const changed = original.replace("tab=value-149", "tab=different");
  const left = sanitiseSnapshotUrl(original);
  const right = sanitiseSnapshotUrl(changed);

  expect(left.length).toBeLessThan(700);
  expect(left).not.toBe(right);
  expect(left).not.toContain("private");
  expect(left).not.toContain("credential");
  expect(left).not.toContain("value-");
  expect(sanitiseSnapshotUrl("not a URL")).toBe("about:invalid");
  expect(sanitiseSnapshotUrl("data:text/html,<p>credential</p>")).toBe("about:opaque");
});

test("14+ allowlisted selectors are permutation-invariant, including overflow and SPA hash queries", () => {
  const names = ["route", "view", "screen", "tab", "panel", "section", "mode", "page",
    "step", "id", "item", "video", "title", "episode"];
  const entries = names.map((name, index) => `${name}=private-${index}`);
  const forward = entries.join("&");
  const reversed = [...entries].reverse().join("&");
  const rotated = [...entries.slice(6), ...entries.slice(0, 6)].join("&");

  for (const prefix of ["https://example.test/?", "https://example.test/#/settings?",
    "https://example.test/#"]) {
    const first = sanitiseSnapshotUrl(`${prefix}${forward}&utm_source=first&token=secret-1`);
    expect(sanitiseSnapshotUrl(`${prefix}${reversed}&utm_source=second&token=secret-2`)).toBe(first);
    expect(sanitiseSnapshotUrl(`${prefix}${rotated}&timestamp=123`)).toBe(first);
    expect(first.length).toBeLessThan(700);
    expect(first).not.toContain("private-");
    expect(first).not.toContain("secret-");
    // Changing a pair that sorts into the overflow must remain distinguishable.
    expect(sanitiseSnapshotUrl(`${prefix}${forward.replace("video=private-11", "video=changed")}`))
      .not.toBe(first);
  }
});

test("duplicate and 10,000-character selector values keep canonical identity and suffix distinctions", () => {
  const longValue = `private-${"a".repeat(10_000)}-first`;
  const modifiedSuffix = `${longValue.slice(0, -5)}other`;
  const fixed = Array.from({ length: 15 }, (_, index) => `tab=other-${index}`);
  const entries = ["tab=duplicate", "tab=duplicate", `tab=${longValue}`, ...fixed];
  const base = `https://example.test/?${entries.join("&")}`;
  const reversed = `https://example.test/?${[...entries].reverse().join("&")}`;
  const changed = `https://example.test/?${[...entries.slice(0, 2), `tab=${modifiedSuffix}`, ...fixed].join("&")}`;

  const identity = sanitiseSnapshotUrl(base);
  expect(sanitiseSnapshotUrl(reversed)).toBe(identity);
  expect(sanitiseSnapshotUrl(changed)).not.toBe(identity);
  expect(identity.length).toBeLessThan(700);
  expect(identity).not.toContain("private-");
  expect(identity).not.toContain("first");
  expect(identity).not.toContain("duplicate");
  expect(sanitiseSnapshotUrl(`${base}&tab=duplicate`)).not.toBe(identity);
});

test("network and console sanitisation keep strict URL redaction", () => {
  const raw = "https://user:pass@example.test/?view=settings&token=secret#/search";
  expect(sanitiseUrl(raw)).toBe("https://example.test/");
  const text = sanitiseObservedText(`Request to ${raw} failed`);
  expect(text).not.toContain("settings");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("pass@");
});

test("browser snapshots separate same-DOM history routes without saving URL secrets", async ({ baseURL }) => {
  if (baseURL === undefined) throw new Error("The web fixture server URL is required.");
  const driver = new PlaywrightWebDriver();
  await driver.launch({ id: "route-identity-test", launchUri: baseURL });
  try {
    const page = driver.getPage();
    if (page === null) throw new Error("The driver did not retain the fixture tab.");
    const snapshotAt = async (route: string): Promise<string> => {
      await page.evaluate((nextRoute) => {
        history.replaceState({ route: nextRoute }, "", nextRoute);
      }, route);
      return observedLocation((await driver.snapshot()).location);
    };

    const baseLocation = await snapshotAt("/?view=search&token=secret-a&clock=12");
    const unchanged = await snapshotAt("/?clock=99&view=search&token=secret-b");
    const switched = await snapshotAt("/?view=settings&token=secret-c");
    const hashSettings = await snapshotAt("/#/settings?tab=general&token=secret-d");
    const hashSearch = await snapshotAt("/#/search?tab=general&token=secret-e");
    const sameHashWithTracking = await snapshotAt("/#/settings?tab=general&token=secret-f&ts=345");
    const opaquePath = await snapshotAt("/account/reset/secret-credential?tab=general");

    expect(unchanged).toBe(baseLocation);
    expect(switched).not.toBe(baseLocation);
    expect(hashSettings).not.toBe(hashSearch);
    expect(hashSettings).toBe(sameHashWithTracking);
    expect(opaquePath).not.toBe(hashSettings);
    for (const location of [
      baseLocation, unchanged, switched, hashSettings, hashSearch, sameHashWithTracking, opaquePath,
    ]) {
      expect(location.length).toBeLessThan(700);
      for (const forbidden of ["secret-", "credential", "token=", "settings", "search", "general"]) {
        expect(location).not.toContain(forbidden);
      }
    }
  } finally {
    await driver.close();
  }
});
