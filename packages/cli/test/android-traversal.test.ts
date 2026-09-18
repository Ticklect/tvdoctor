import { describe, expect, it } from "vitest";
import {
  ANDROID_TRAVERSAL_STRATEGIES,
  isAndroidTraversalStrategy,
  parseAndroidTraversalStrategy,
} from "../src/android-traversal.js";

describe("Android traversal strategies", () => {
  it("defaults to adaptive and accepts the two declared values", () => {
    expect(ANDROID_TRAVERSAL_STRATEGIES).toEqual(["adaptive", "brute-force"]);
    expect(parseAndroidTraversalStrategy(undefined)).toBe("adaptive");
    expect(isAndroidTraversalStrategy("adaptive")).toBe(true);
    expect(isAndroidTraversalStrategy("brute-force")).toBe(true);
  });

  it("rejects unknown strategies", () => {
    expect(isAndroidTraversalStrategy("wide")).toBe(false);
    expect(() => parseAndroidTraversalStrategy("wide")).toThrow(/--strategy/u);
  });
});
