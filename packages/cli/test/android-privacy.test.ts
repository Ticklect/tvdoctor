import { describe, expect, it } from "vitest";

import { androidPublicTargetLocation } from "../src/android-product.js";

describe("Android privacy boundaries", () => {
  it("uses app identity rather than the selected ADB serial for public report targets", () => {
    const publicLocation = androidPublicTargetLocation("org.example.tv");

    expect(publicLocation).toBe("android-app://org.example.tv");
    expect(publicLocation).not.toContain("emulator-5554");
    expect(publicLocation).not.toContain("192.168.1.20:5555");
  });
});
