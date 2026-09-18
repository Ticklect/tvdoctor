import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fingerprintScreenshotPng, MAX_SCREENSHOT_PNG_BYTES } from "../src/screenshot-fingerprint.js";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function chunk(type: string, body: Uint8Array): Buffer {
  return Buffer.concat([uint32(body.byteLength), Buffer.from(type, "ascii"), Buffer.from(body), Buffer.alloc(4)]);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= diagonalDistance
    ? left
    : upDistance <= diagonalDistance ? up : upperLeft;
}

function png(
  width: number,
  height: number,
  channels: 3 | 4,
  pixels: readonly number[],
  filters: readonly number[] = [0],
): Buffer {
  const stride = width * channels;
  if (pixels.length !== stride * height) throw new Error("Invalid test pixel count.");
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const filter = filters[row % filters.length] ?? 0;
    const rawOffset = row * (stride + 1);
    const rowOffset = row * stride;
    raw[rawOffset] = filter;
    for (let column = 0; column < stride; column += 1) {
      const value = pixels[rowOffset + column] ?? 0;
      const left = column >= channels ? pixels[rowOffset + column - channels] ?? 0 : 0;
      const up = row > 0 ? pixels[rowOffset + column - stride] ?? 0 : 0;
      const upperLeft = row > 0 && column >= channels
        ? pixels[rowOffset + column - stride - channels] ?? 0
        : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : paeth(left, up, upperLeft);
      raw[rawOffset + 1 + column] = (value - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("fingerprintScreenshotPng", () => {
  it.each([3, 4] as const)("decodes stable valid %s-channel PNGs using every row filter", (channels) => {
    const width = 3;
    const height = 5;
    const pixels = Array.from({ length: width * height * channels }, (_, index) => (
      channels === 4 && index % channels === 3 ? 255 : (index * 37) % 256
    ));
    const image = png(width, height, channels, pixels, [0, 1, 2, 3, 4]);

    const first = fingerprintScreenshotPng(image);
    const second = fingerprintScreenshotPng(Buffer.from(image));
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      width,
      height,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      meanLuminance: expect.any(Number),
      luminanceVariance: expect.any(Number),
      visuallyBlank: false,
    });
    expect(first.luminanceGrid).toHaveLength(16 * 9);
    expect(first.luminanceGrid.every((value) => Number.isInteger(value) && value >= 0 && value <= 255))
      .toBe(true);
  });

  it("changes deterministically when one visible pixel changes", () => {
    const before = fingerprintScreenshotPng(png(2, 2, 3, [
      10, 20, 30, 40, 50, 60,
      70, 80, 90, 100, 110, 120,
    ]));
    const after = fingerprintScreenshotPng(png(2, 2, 3, [
      80, 20, 30, 40, 50, 60,
      70, 80, 90, 100, 110, 120,
    ]));
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.luminanceGrid).not.toEqual(before.luminanceGrid);
  });

  it("classifies fully black or fully transparent PNGs as visually blank", () => {
    expect(fingerprintScreenshotPng(png(2, 2, 3, Array(12).fill(0))).visuallyBlank).toBe(true);
    expect(fingerprintScreenshotPng(png(2, 2, 4, [
      255, 255, 255, 0, 200, 100, 50, 0,
      1, 2, 3, 0, 40, 50, 60, 0,
    ])).visuallyBlank).toBe(true);
    expect(fingerprintScreenshotPng(png(1, 1, 3, [0, 0, 2])).visuallyBlank).toBe(false);
  });

  it.each([
    ["signature", Buffer.from("not a png")],
    ["truncated chunks", Buffer.concat([SIGNATURE, uint32(200), Buffer.from("IHDR")])],
  ])("rejects malformed PNG %s", (_label, image) => {
    expect(() => fingerprintScreenshotPng(image)).toThrow(/PNG/u);
  });

  it.each([
    ["colour", 25, 3],
    ["interlace", 28, 1],
  ] as const)("rejects unsupported PNG %s modes", (_label, offset, value) => {
    const image = png(1, 1, 3, [1, 2, 3]);
    image[offset] = value;
    expect(() => fingerprintScreenshotPng(image)).toThrow(/unsupported/u);
  });

  it("enforces encoded byte and decoded dimension limits before allocation", () => {
    expect(() => fingerprintScreenshotPng(Buffer.alloc(MAX_SCREENSHOT_PNG_BYTES + 1))).toThrow(/size/u);
    const image = png(1, 1, 3, [1, 2, 3]);
    image.writeUInt32BE(20_000, 16);
    expect(() => fingerprintScreenshotPng(image)).toThrow(/dimensions/u);
  });
});
