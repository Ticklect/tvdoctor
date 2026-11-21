import { describe, expect, it } from "vitest";
import { webNavigationRestorationMode } from "../src/node-audit-runner.js";

describe("web navigation restoration opt-in", () => {
  it("keeps the deployed root-only behaviour unless explicitly opted in", () => {
    expect(webNavigationRestorationMode({})).toBe("root-only");
    expect(webNavigationRestorationMode({ TVDOCTOR_WEB_NAV_RESTORATION: "" })).toBe("root-only");
    expect(webNavigationRestorationMode({ TVDOCTOR_WEB_NAV_RESTORATION: "root-only" })).toBe("root-only");
  });

  it("supports exact verified-live and verified-local restoration opt-ins", () => {
    expect(webNavigationRestorationMode({ TVDOCTOR_WEB_NAV_RESTORATION: "verified-live-only" }))
      .toBe("verified-live-only");
    expect(webNavigationRestorationMode({ TVDOCTOR_WEB_NAV_RESTORATION: "verified-local" }))
      .toBe("verified-local");
  });

  it("rejects typos rather than silently changing restoration safety", () => {
    expect(() => webNavigationRestorationMode({ TVDOCTOR_WEB_NAV_RESTORATION: "local" }))
      .toThrow("TVDOCTOR_WEB_NAV_RESTORATION must be");
  });
});
