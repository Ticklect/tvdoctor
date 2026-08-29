import { describe, expect, it } from "vitest";
import {
  ANDROID_OBSERVER_PROTOCOL_VERSION,
  ObserverFrameDecoder,
  encodeObserverFrame,
  parseObserverResponse,
  parseObserverState,
  resolveAndroidObserverAsset,
} from "../src/index.js";

function response(id: number) {
  return { version: 2 as const, id, ok: true, type: "pong" };
}

describe("Android observer framing", () => {
  it("validates the checksum and protocol metadata of the packaged observer APK", async () => {
    await expect(resolveAndroidObserverAsset()).resolves.toMatchObject({
      packageName: "org.tvdoctor.observer",
      protocolVersion: 2,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      certificateSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });
  it("decodes partial frames and multiple messages per read", () => {
    const first = encodeObserverFrame(response(1));
    const second = encodeObserverFrame(response(2));
    const decoder = new ObserverFrameDecoder();
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([Buffer.from(first.subarray(3)), Buffer.from(second)])))
      .toEqual([response(1), response(2)]);
    decoder.finish();
  });

  it("rejects malformed lengths, JSON, partial endings, and protocol versions", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(3 * 1024 * 1024);
    expect(() => new ObserverFrameDecoder().push(oversized)).toThrow(/length/u);

    const malformed = Buffer.alloc(5);
    malformed.writeUInt32BE(1);
    malformed[4] = 123;
    expect(() => new ObserverFrameDecoder().push(malformed)).toThrow(/malformed JSON/u);

    const partial = new ObserverFrameDecoder();
    partial.push(encodeObserverFrame(response(1)).subarray(0, 6));
    expect(() => partial.finish()).toThrow(/partial frame/u);
    expect(() => parseObserverResponse({ ...response(1), version: 99 })).toThrow(/protocol version/u);
  });
});

describe("Android observer canonical state validation", () => {
  it("accepts a bounded full tree and rejects inconsistent metadata", () => {
    const node = {
      stableId: "org.example:id/play",
      role: "button",
      name: "Play",
      text: "Play",
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      visible: true,
      enabled: true,
      focusable: true,
      focused: true,
      modal: null,
      selectionState: null,
      valueNow: null,
      className: "android.widget.Button",
      packageName: "org.example",
      clickable: true,
      scrollable: false,
      selected: false,
      children: [],
    };
    const state = {
      sequence: 3,
      timestampMs: Date.now(),
      packageName: "org.example",
      windowClassName: "org.example.MainActivity",
      windowId: 2,
      focused: { stableId: node.stableId, role: "button", name: "Play", bounds: node.bounds },
      structureFingerprint: "a".repeat(64),
      stateFingerprint: "b".repeat(64),
      treeChanged: true,
      nodes: [node],
      nodeCount: 1,
      maxDepth: 0,
    };
    expect(parseObserverState(state).nodes).toHaveLength(1);
    expect(() => parseObserverState({ ...state, nodeCount: 2 })).toThrow(/node count/u);
    expect(ANDROID_OBSERVER_PROTOCOL_VERSION).toBe(2);
  });
});
