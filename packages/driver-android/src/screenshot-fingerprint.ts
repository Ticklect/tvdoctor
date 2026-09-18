import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { AndroidScreenshotFingerprint } from "./types.js";

export const MAX_SCREENSHOT_PNG_BYTES = 25 * 1024 * 1024;
const MAX_DIMENSION = 8_192;
const MAX_PIXELS = 16_777_216;
const GRID_WIDTH = 16;
const GRID_HEIGHT = 9;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function uint32(data: Uint8Array, offset: number): number {
  return (((data[offset] ?? 0) << 24) >>> 0)
    + ((data[offset + 1] ?? 0) << 16)
    + ((data[offset + 2] ?? 0) << 8)
    + (data[offset + 3] ?? 0);
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

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly pixels: Uint8Array;
}

function decodePng(data: Uint8Array): DecodedPng {
  if (data.byteLength > MAX_SCREENSHOT_PNG_BYTES) {
    throw new RangeError("Android screenshot PNG size exceeded the bounded input limit.");
  }
  if (data.byteLength < 33 || !PNG_SIGNATURE.every((value, index) => data[index] === value)) {
    throw new TypeError("Android screenshot was not a valid PNG file.");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | null = null;
  let sawHeader = false;
  let sawEnd = false;
  const compressedChunks: Uint8Array[] = [];
  let compressedLength = 0;
  while (offset + 12 <= data.byteLength) {
    const length = uint32(data, offset);
    const chunkEnd = offset + 12 + length;
    if (length > MAX_SCREENSHOT_PNG_BYTES || chunkEnd > data.byteLength) {
      throw new RangeError("Android screenshot PNG contained an invalid chunk length.");
    }
    const type = String.fromCharCode(
      data[offset + 4] ?? 0,
      data[offset + 5] ?? 0,
      data[offset + 6] ?? 0,
      data[offset + 7] ?? 0,
    );
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (sawHeader || offset !== PNG_SIGNATURE.length || length !== 13) {
        throw new TypeError("Android screenshot PNG header was invalid.");
      }
      sawHeader = true;
      width = uint32(body, 0);
      height = uint32(body, 4);
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6)
        || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
        throw new TypeError("Android screenshot PNG used an unsupported pixel format.");
      }
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) throw new TypeError("Android screenshot PNG chunk order was invalid.");
      compressedLength += body.byteLength;
      if (compressedLength > MAX_SCREENSHOT_PNG_BYTES) {
        throw new RangeError("Android screenshot PNG compressed data exceeded the size limit.");
      }
      compressedChunks.push(body);
    } else if (type === "IEND") {
      if (length !== 0) throw new TypeError("Android screenshot PNG end chunk was invalid.");
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawEnd || channels === null || compressedChunks.length === 0) {
    throw new TypeError("Android screenshot PNG was incomplete.");
  }
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION
    || width * height > MAX_PIXELS) {
    throw new RangeError("Android screenshot PNG dimensions exceeded the bounded limits.");
  }

  const stride = width * channels;
  const expectedRawLength = (stride + 1) * height;
  const packed = new Uint8Array(compressedLength);
  let packedOffset = 0;
  for (const compressed of compressedChunks) {
    packed.set(compressed, packedOffset);
    packedOffset += compressed.byteLength;
  }
  let raw: Uint8Array;
  try {
    raw = inflateSync(packed, { maxOutputLength: expectedRawLength });
  } catch {
    throw new TypeError("Android screenshot PNG compressed pixels were invalid.");
  }
  if (raw.byteLength !== expectedRawLength) {
    throw new TypeError("Android screenshot PNG scanline length was inconsistent.");
  }

  const pixels = new Uint8Array(stride * height);
  let rawOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    if (filter === undefined || filter > 4) {
      throw new TypeError("Android screenshot PNG used an invalid row filter.");
    }
    const rowOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const encoded = raw[rawOffset + column] ?? 0;
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
      pixels[rowOffset + column] = (encoded + predictor) & 0xff;
    }
    rawOffset += stride;
  }
  return { width, height, channels, pixels };
}

function pixelLuminance(decoded: DecodedPng, x: number, y: number): number {
  const offset = (y * decoded.width + x) * decoded.channels;
  const red = decoded.pixels[offset] ?? 0;
  const green = decoded.pixels[offset + 1] ?? 0;
  const blue = decoded.pixels[offset + 2] ?? 0;
  const alpha = decoded.channels === 4 ? decoded.pixels[offset + 3] ?? 0 : 255;
  return Math.round((0.2126 * red + 0.7152 * green + 0.0722 * blue) * alpha / 255);
}

export function fingerprintScreenshotPng(data: Uint8Array): AndroidScreenshotFingerprint {
  const decoded = decodePng(data);
  const luminanceGrid: number[] = [];
  for (let gridY = 0; gridY < GRID_HEIGHT; gridY += 1) {
    const y = Math.min(decoded.height - 1, Math.floor((gridY + 0.5) * decoded.height / GRID_HEIGHT));
    for (let gridX = 0; gridX < GRID_WIDTH; gridX += 1) {
      const x = Math.min(decoded.width - 1, Math.floor((gridX + 0.5) * decoded.width / GRID_WIDTH));
      luminanceGrid.push(pixelLuminance(decoded, x, y));
    }
  }
  const meanLuminance = luminanceGrid.reduce((total, value) => total + value, 0)
    / luminanceGrid.length;
  const luminanceVariance = luminanceGrid.reduce(
    (total, value) => total + (value - meanLuminance) ** 2,
    0,
  ) / luminanceGrid.length;
  let visibleColour = false;
  for (let offset = 0; offset < decoded.pixels.length; offset += decoded.channels) {
    const alpha = decoded.channels === 4 ? decoded.pixels[offset + 3] ?? 0 : 255;
    if (alpha > 0 && ((decoded.pixels[offset] ?? 0) > 0
      || (decoded.pixels[offset + 1] ?? 0) > 0
      || (decoded.pixels[offset + 2] ?? 0) > 0)) {
      visibleColour = true;
      break;
    }
  }
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    width: decoded.width,
    height: decoded.height,
    luminanceGrid,
    meanLuminance,
    luminanceVariance,
    visuallyBlank: !visibleColour,
  };
}
