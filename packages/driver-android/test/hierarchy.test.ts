import { describe, expect, it } from "vitest";
import { parseUiAutomatorHierarchy } from "../src/index.js";

const HIERARCHY = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="org.tvdoctor.fixture" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" selected="false" bounds="[0,0][1920,1080]">
    <node index="0" text="" resource-id="org.tvdoctor.fixture:id/row" class="android.widget.LinearLayout" package="org.tvdoctor.fixture" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" selected="false" bounds="[100,200][1000,500]">
      <node index="0" text="Watch" resource-id="org.tvdoctor.fixture:id/watch" class="android.widget.Button" package="org.tvdoctor.fixture" content-desc="Play &amp; pause" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" selected="false" bounds="[100,200][350,320]" />
      <node index="1" text="Captions" resource-id="org.tvdoctor.fixture:id/captions" class="android.widget.CheckBox" package="org.tvdoctor.fixture" content-desc="" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" selected="false" bounds="[380,200][630,320]" />
    </node>
  </node>
</hierarchy>`;

describe("UIAutomator hierarchy parsing", () => {
  it("maps bounded accessibility semantics, focus, selection, and geometry", () => {
    const parsed = parseUiAutomatorHierarchy(HIERARCHY);

    expect(parsed.metadata).toEqual({
      capturedNodeCount: 4,
      maxNodeCount: 4_096,
      maxDepth: 2,
      truncated: false,
    });
    expect(parsed.focusedNodeCount).toBe(1);
    expect(parsed.focusedTarget).toEqual({
      stableId: "org.tvdoctor.fixture:id/watch",
      role: "button",
      name: "Play & pause",
      bounds: { x: 100, y: 200, width: 250, height: 120 },
    });
    const row = parsed.roots[0]?.children[0];
    expect(row?.children[0]).toMatchObject({
      stableId: "org.tvdoctor.fixture:id/watch",
      role: "button",
      name: "Play & pause",
      text: "Watch",
      visible: true,
      enabled: true,
      focusable: true,
      focused: true,
      clickable: true,
      modal: null,
    });
    expect(row?.children[1]).toMatchObject({
      role: "checkbox",
      selectionState: "on",
      focused: false,
    });
    expect(parsed.settleSignature.length).toBeGreaterThan(20);
  });

  it("reports duplicate focus without selecting an arbitrary node", () => {
    const duplicate = HIERARCHY.replace(
      'resource-id="org.tvdoctor.fixture:id/captions" class="android.widget.CheckBox"',
      'resource-id="org.tvdoctor.fixture:id/captions" class="android.widget.CheckBox"',
    ).replace(
      'checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false"',
      'checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="true"',
    );
    const parsed = parseUiAutomatorHierarchy(duplicate);
    expect(parsed.focusedNodeCount).toBe(2);
    expect(parsed.focusedTarget).toBeNull();
  });

  it("fails closed on hostile, malformed, oversized, deep, and over-populated input", () => {
    expect(() => parseUiAutomatorHierarchy("<!DOCTYPE x [<!ENTITY boom 'x'>]><hierarchy/>"))
      .toThrow("declarations or entities");
    expect(() => parseUiAutomatorHierarchy("<hierarchy><node></hierarchy>"))
      .toThrow("unclosed nodes");
    expect(() => parseUiAutomatorHierarchy(HIERARCHY, { maxBytes: 20 }))
      .toThrow("exceeds 20 bytes");
    expect(() => parseUiAutomatorHierarchy(HIERARCHY, { maxNodes: 2 }))
      .toThrow("exceeds 2 nodes");
    expect(() => parseUiAutomatorHierarchy(HIERARCHY, { maxDepth: 2 }))
      .toThrow("exceeds depth 2");
  });
});
