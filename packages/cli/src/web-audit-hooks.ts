import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  PlaywrightWebDriver,
  type WebStateSnapshot,
} from "@tvdoctor/driver-web";
import {
  activeWebSurfaceEntries,
  distinctVisibleSurfaceChange,
  rankWebCandidates,
  webSemanticStateIdentity,
  type IsolatedPointerProbe,
  type SearchQueryEntryHook,
  type ViewportObservationHook,
  type WebFocusVisibilityProbe,
  type WebFocusVisualSample,
  type WebPackHooks,
} from "@tvdoctor/pack-web";
import type {
  StreamingPointerProbe,
  StreamingPointerProbeResult,
} from "@tvdoctor/pack-streaming";
import type { RemoteKey } from "@tvdoctor/protocol";

interface PngPixels {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly data: Uint8Array;
}

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

/** Minimal strict decoder for the 8-bit RGB/RGBA PNG crops emitted by Chromium. */
function decodeChromiumPng(data: Uint8Array): PngPixels {
  if (data.length < 33 || !PNG_SIGNATURE.every((value, index) => data[index] === value)) {
    throw new TypeError("Focus proof screenshot was not a PNG file.");
  }
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | null = null;
  const compressed: Uint8Array[] = [];
  let compressedLength = 0;
  while (offset + 12 <= data.length) {
    const length = uint32(data, offset);
    if (length > 64 * 1024 * 1024 || offset + 12 + length > data.length) {
      throw new RangeError("Focus proof PNG contained an invalid chunk length.");
    }
    const type = String.fromCharCode(
      data[offset + 4] ?? 0,
      data[offset + 5] ?? 0,
      data[offset + 6] ?? 0,
      data[offset + 7] ?? 0,
    );
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = uint32(body, 0);
      height = uint32(body, 4);
      const bitDepth = body[8];
      const colourType = body[9];
      if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)
        || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
        throw new TypeError("Focus proof PNG used an unsupported pixel format.");
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      compressed.push(body);
      compressedLength += body.length;
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  if (width <= 0 || height <= 0 || width > 4_096 || height > 4_096 || channels === null) {
    throw new RangeError("Focus proof PNG dimensions or header were invalid.");
  }
  const packed = new Uint8Array(compressedLength);
  let packedOffset = 0;
  for (const chunk of compressed) {
    packed.set(chunk, packedOffset);
    packedOffset += chunk.length;
  }
  const raw = inflateSync(packed, { maxOutputLength: (width * channels + 1) * height });
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) {
    throw new TypeError("Focus proof PNG scanline length was inconsistent.");
  }
  const pixels = new Uint8Array(stride * height);
  let rawOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    if (filter === undefined || filter > 4) throw new TypeError("Focus proof PNG used an invalid row filter.");
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
  return { width, height, channels, data: pixels };
}

function changedPixelRatio(beforePng: Uint8Array, afterPng: Uint8Array): number {
  const before = decodeChromiumPng(beforePng);
  const after = decodeChromiumPng(afterPng);
  if (before.width !== after.width || before.height !== after.height || before.channels !== after.channels) {
    throw new TypeError("Focus proof crops did not have equal dimensions and pixel formats.");
  }
  let changed = 0;
  for (let offset = 0; offset < before.data.length; offset += before.channels) {
    let pixelChanged = false;
    for (let channel = 0; channel < before.channels; channel += 1) {
      if (Math.abs((before.data[offset + channel] ?? 0) - (after.data[offset + channel] ?? 0)) > 4) {
        pixelChanged = true;
        break;
      }
    }
    if (pixelChanged) changed += 1;
  }
  return changed / (before.width * before.height);
}

async function pressSequence(driver: PlaywrightWebDriver, sequence: readonly RemoteKey[]): Promise<boolean> {
  for (const key of sequence) {
    const result = await driver.press(key);
    if (result.outcome !== "applied" || result.key !== key) return false;
  }
  return true;
}

function descriptorCorroborated(
  snapshot: { readonly uiTree: WebStateSnapshot["uiTree"] },
  stableId: string,
): boolean {
  if (snapshot.uiTree.status !== "available") return false;
  return activeWebSurfaceEntries(snapshot as WebStateSnapshot)
    .filter((entry) => entry.node.stableId === stableId).length === 1;
}

async function exactStableLocator(
  driver: PlaywrightWebDriver,
  stableId: string,
): Promise<ReturnType<ReturnType<PlaywrightWebDriver["getPage"]>["locator"]> | null> {
  const candidates = driver.getPage().locator("[data-tv-id], [id]");
  const matchingIndices = await candidates.evaluateAll((elements, requestedId) => elements
    .map((element, index) => ({
      id: element.getAttribute("data-tv-id") ?? element.id,
      index,
    }))
    .filter((entry) => entry.id === requestedId)
    .map((entry) => entry.index), stableId);
  const index = matchingIndices[0];
  return matchingIndices.length === 1 && index !== undefined ? candidates.nth(index) : null;
}

function cssNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function visualSample(
  locator: NonNullable<Awaited<ReturnType<typeof exactStableLocator>>>,
): Promise<WebFocusVisualSample> {
  return await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const number = (value: string): number | null => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      outlineWidthPx: number(style.outlineWidth),
      borderWidthPx: number(style.borderLeftWidth),
      opacity: number(style.opacity),
      transform: style.transform || null,
      backgroundColor: style.backgroundColor || null,
      boxShadow: style.boxShadow || null,
    };
  });
}

function createQueryHook(driver: PlaywrightWebDriver): SearchQueryEntryHook {
  return {
    async enter(request) {
      if (request.input.stableId === null
        || !descriptorCorroborated(request.snapshot as WebStateSnapshot, request.input.stableId)) {
        return { status: "unavailable", detail: "The requested search input was not uniquely corroborated." };
      }
      const input = await exactStableLocator(driver, request.input.stableId);
      if (input === null || !await input.isVisible()) {
        return { status: "unavailable", detail: "The uniquely requested search input was not visible in the active page." };
      }
      await input.focus();
      await driver.getPage().keyboard.type(request.query);
      const observedQuery = await input.evaluate((element) => (
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : ""
      ));
      const snapshot = await driver.snapshot();
      const resultsObserved = rankWebCandidates(snapshot, "search-result").length > 0;
      return observedQuery.normalize("NFKC").trim() === request.query
        ? {
            status: "entered",
            method: "system-keyboard",
            observedQuery,
            resultsObserved,
            detail: "The active browser keyboard entered the exact bounded query and the semantic tree was observed again.",
          }
        : {
            status: "unavailable",
            detail: "The browser input did not expose the exact configured query after system-keyboard entry.",
          };
    },
  };
}

function createPointerProbe(
  target: string,
  createDriver: () => PlaywrightWebDriver,
): IsolatedPointerProbe {
  return {
    async probe(request) {
      if (request.element.stableId === null
        || !descriptorCorroborated(request.snapshot as WebStateSnapshot, request.element.stableId)) {
        return { status: "unavailable", detail: "The pointer target was not uniquely corroborated by the supplied snapshot." };
      }
      const isolated = createDriver();
      try {
        await isolated.launch({ id: "cli-isolated-search-pointer", launchUri: target });
        if (!await pressSequence(isolated, request.surfaceSequence)) {
          return { status: "unavailable", detail: "The isolated remote route did not replay completely." };
        }
        const beforeSnapshot = await isolated.snapshot();
        const locator = await exactStableLocator(isolated, request.element.stableId);
        if (locator === null || !await locator.isVisible() || !await locator.isEnabled()) {
          return { status: "unavailable", detail: "The isolated stable pointer target was not uniquely visible and enabled." };
        }
        const before = webSemanticStateIdentity(beforeSnapshot);
        await locator.click();
        const afterSnapshot = await isolated.snapshot();
        const after = webSemanticStateIdentity(afterSnapshot);
        if (before === null || after === null) {
          return { status: "not-activated", detail: "Pointer dispatch produced no distinct observable semantic state." };
        }
        const surfaceChange = before === after
          ? distinctVisibleSurfaceChange(beforeSnapshot, afterSnapshot)
          : null;
        if (surfaceChange !== null) {
          return {
            status: "activated",
            observedEffect: `Pointer activation introduced new visible semantic content: ${surfaceChange.slice(0, 200)}`,
            detail: "A fresh Chromium context replayed the remote surface route and activated the uniquely corroborated stable target.",
          };
        }
        if (before === after) {
          return { status: "not-activated", detail: "Pointer dispatch produced no distinct observable semantic state." };
        }
        return {
          status: "activated",
          observedEffect: "The isolated pointer dispatch produced a distinct semantic UI state.",
          detail: "A fresh Chromium context replayed the remote surface route and activated the uniquely corroborated stable target.",
        };
      } catch (error) {
        return { status: "error", detail: `Isolated pointer proof failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        await isolated.close();
      }
    },
  };
}

function createFocusProbe(
  target: string,
  createDriver: () => PlaywrightWebDriver,
): WebFocusVisibilityProbe {
  return {
    async probe(request) {
      if (request.element.stableId === null) {
        return { status: "unavailable", detail: "The focus target had no stable semantic ID." };
      }
      const isolated = createDriver();
      try {
        await isolated.launch({ id: "cli-isolated-focus-proof", launchUri: target });
        if (!await pressSequence(isolated, request.focusSequence)) {
          return { status: "unavailable", detail: "The isolated focus route did not replay completely." };
        }
        const snapshot = await isolated.snapshot();
        const focusedId = snapshot.focusedElement.status === "available"
          ? snapshot.focusedElement.value?.stableId ?? null
          : null;
        if (focusedId !== request.element.stableId
          || !descriptorCorroborated(snapshot, request.element.stableId)) {
          return { status: "unavailable", detail: "The isolated route did not restore the exact unique focus target." };
        }
        const locator = await exactStableLocator(isolated, request.element.stableId);
        if (locator === null || !await locator.isVisible()) {
          return { status: "unavailable", detail: "The isolated focus target was not uniquely visible." };
        }
        const box = await locator.boundingBox();
        if (box === null || box.width <= 0 || box.height <= 0) {
          return { status: "unavailable", detail: "The focus target had no finite crop geometry." };
        }
        const viewport = isolated.getPage().viewportSize();
        if (viewport === null) return { status: "unavailable", detail: "The isolated page viewport was unavailable." };
        const padding = 8;
        const clip = {
          x: Math.max(0, Math.floor(box.x - padding)),
          y: Math.max(0, Math.floor(box.y - padding)),
          width: Math.max(1, Math.min(viewport.width, Math.ceil(box.x + box.width + padding)) - Math.max(0, Math.floor(box.x - padding))),
          height: Math.max(1, Math.min(viewport.height, Math.ceil(box.y + box.height + padding)) - Math.max(0, Math.floor(box.y - padding))),
        };
        const focused = await visualSample(locator);
        const focusedPng = await isolated.getPage().screenshot({ type: "png", animations: "disabled", clip });
        await locator.evaluate((element) => {
          if (element instanceof HTMLElement) element.blur();
        });
        await isolated.getPage().evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const unfocused = await visualSample(locator);
        const unfocusedPng = await isolated.getPage().screenshot({ type: "png", animations: "disabled", clip });
        return {
          status: "available",
          unfocused,
          focused,
          screenshotDifferenceRatio: changedPixelRatio(unfocusedPng, focusedPng),
          detail: "A fresh Chromium context captured equal target crops and computed styles before and after exact remote focus.",
        };
      } catch (error) {
        return { status: "error", detail: `Isolated focus proof failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        await isolated.close();
      }
    },
  };
}

const viewportHook: ViewportObservationHook = {
  async observe(snapshot) {
    const viewport = (snapshot as Partial<WebStateSnapshot>).viewport;
    if (viewport?.status !== "available") {
      return { status: "unavailable", detail: viewport?.reason ?? "The web snapshot had no viewport observation." };
    }
    return {
      status: "available",
      viewport: { x: 0, y: 0, width: viewport.value.width, height: viewport.value.height },
      source: "PlaywrightWebDriver WebStateSnapshot.viewport",
    };
  },
};

export interface CreateWebAuditHooksOptions {
  readonly target: string;
  readonly driver: PlaywrightWebDriver;
  readonly createDriver?: () => PlaywrightWebDriver;
}

export function createWebAuditHooks(options: CreateWebAuditHooksOptions): WebPackHooks {
  const createDriver = options.createDriver ?? (() => new PlaywrightWebDriver());
  return {
    searchQueryEntry: createQueryHook(options.driver),
    pointerProbe: createPointerProbe(options.target, createDriver),
    webFocusVisibility: createFocusProbe(options.target, createDriver),
    viewport: viewportHook,
  };
}

function semanticDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function createStreamingAuditPointerProbe(
  target: string,
  createDriver: () => PlaywrightWebDriver = () => new PlaywrightWebDriver(),
): StreamingPointerProbe {
  return {
    async probe(request): Promise<StreamingPointerProbeResult> {
      const stableId = request.element.stableId;
      if (stableId === null || !descriptorCorroborated(request.snapshot as WebStateSnapshot, stableId)) {
        return { status: "unobservable", detail: "The streaming pointer target was not uniquely corroborated by its semantic snapshot." };
      }
      const isolated = createDriver();
      try {
        await isolated.launch({ id: `cli-isolated-${request.kind}`, launchUri: target });
        if (!await pressSequence(isolated, request.surfaceSequence)) {
          return { status: "unobservable", detail: "The isolated streaming surface route did not replay completely." };
        }
        const locator = await exactStableLocator(isolated, stableId);
        if (locator === null || !await locator.isVisible() || !await locator.isEnabled()) {
          return { status: "unobservable", detail: "The isolated stable streaming target was not uniquely visible and enabled." };
        }
        const beforeSnapshot = await isolated.snapshot();
        const before = webSemanticStateIdentity(beforeSnapshot);
        await locator.click();
        const afterSnapshot = await isolated.snapshot();
        const after = webSemanticStateIdentity(afterSnapshot);
        if (before === null || after === null || before === after) {
          return { status: "unobservable", detail: "Pointer dispatch produced no distinct semantic before/after state." };
        }
        return {
          status: "reachable",
          detail: "A fresh Chromium context replayed the remote surface and pointer activation produced a distinct semantic UI state.",
          observedChange: {
            property: request.kind === "caption-text-colour" ? "caption appearance state" : "player status state",
            before: semanticDigest(before),
            after: semanticDigest(after),
          },
        };
      } catch (error) {
        return { status: "error", detail: `Isolated streaming pointer proof failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        await isolated.close();
      }
    },
  };
}

export const __test = {
  changedPixelRatio,
  cssNumber,
  decodeChromiumPng,
};
