import { isRemoteKey, type RemoteKey } from "@tvdoctor/protocol";
import type { AndroidUiNodeSnapshot } from "./types.js";

export const ANDROID_OBSERVER_PROTOCOL_VERSION = 2 as const;
export const ANDROID_OBSERVER_DEVICE_PORT = 38_337 as const;
export const ANDROID_OBSERVER_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface ObserverFocusedElement {
  readonly stableId: string | null;
  readonly role: string | null;
  readonly name: string | null;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}

export interface ObserverState {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly packageName: string | null;
  readonly windowClassName: string | null;
  readonly windowId: number | null;
  readonly focused: ObserverFocusedElement | null;
  readonly structureFingerprint: string;
  readonly stateFingerprint: string;
  readonly treeChanged: boolean;
  readonly nodes?: readonly AndroidUiNodeSnapshot[];
  readonly nodeCount: number;
  readonly maxDepth: number;
}

export interface ObserverSettleTiming {
  readonly eventLatencyMs: number | null;
  readonly snapshotGenerationMs: number;
  readonly settlingMs: number;
  readonly eventsObserved: number;
  readonly noOpConfirmed: boolean;
}

export type ObserverRequest =
  | { readonly version: 2; readonly id: number; readonly type: "hello"; readonly token: string; readonly hostVersion: string }
  | { readonly version: 2; readonly id: number; readonly type: "ping" }
  | { readonly version: 2; readonly id: number; readonly type: "device_info" }
  | { readonly version: 2; readonly id: number; readonly type: "current_state"; readonly forceFull: boolean }
  | { readonly version: 2; readonly id: number; readonly type: "begin_action"; readonly key: RemoteKey }
  | { readonly version: 2; readonly id: number; readonly type: "settle_action"; readonly actionId: number; readonly timeoutMs: number; readonly quietWindowMs: number; readonly noResponseGraceMs: number }
  | { readonly version: 2; readonly id: number; readonly type: "resync" }
  | { readonly version: 2; readonly id: number; readonly type: "cancel"; readonly targetId: number }
  | { readonly version: 2; readonly id: number; readonly type: "shutdown" };

export type ObserverRequestPayload = ObserverRequest extends infer Request
  ? Request extends ObserverRequest
    ? Omit<Request, "id" | "version">
    : never
  : never;

export interface ObserverResponse {
  readonly version: 2;
  readonly id: number;
  readonly ok: boolean;
  readonly type: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly protocolVersion?: number;
  readonly observerVersion?: string;
  readonly serviceEnabled?: boolean;
  readonly device?: Readonly<Record<string, string | number | boolean | null>>;
  readonly actionId?: number;
  readonly baselineSequence?: number;
  readonly state?: ObserverState;
  readonly timing?: ObserverSettleTiming;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || value.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function nullableBoundedString(value: unknown, label: string, maximumLength = 1_024): string | null {
  if (value === null) return null;
  return boundedString(value, label, maximumLength);
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean or null.`);
  return value;
}

function parseBounds(value: unknown): ObserverFocusedElement["bounds"] {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Observer bounds must be an object or null.");
  }
  const record = value as Record<string, unknown>;
  const numbers = [record["x"], record["y"], record["width"], record["height"]];
  if (!numbers.every((number) => Number.isSafeInteger(number))
    || (record["width"] as number) <= 0
    || (record["height"] as number) <= 0) {
    throw new TypeError("Observer bounds are invalid.");
  }
  return {
    x: record["x"] as number,
    y: record["y"] as number,
    width: record["width"] as number,
    height: record["height"] as number,
  };
}

function parseNode(value: unknown, counter: { value: number }, depth: number): AndroidUiNodeSnapshot {
  if (depth >= 64 || counter.value >= 4_096) throw new RangeError("Observer UI tree exceeds its bound.");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Observer UI node must be an object.");
  }
  counter.value += 1;
  const record = value as Record<string, unknown>;
  const children = record["children"];
  if (!Array.isArray(children)) throw new TypeError("Observer UI node children must be an array.");
  const selection = record["selectionState"];
  if (selection !== null && selection !== "on" && selection !== "off" && selection !== "mixed") {
    throw new TypeError("Observer UI selection state is invalid.");
  }
  if (record["valueNow"] !== null && (typeof record["valueNow"] !== "number" || !Number.isFinite(record["valueNow"]))) {
    throw new TypeError("Observer UI numeric value is invalid.");
  }
  return {
    stableId: nullableBoundedString(record["stableId"], "Observer stable id"),
    role: nullableBoundedString(record["role"], "Observer role", 128),
    name: nullableBoundedString(record["name"], "Observer node name"),
    text: nullableBoundedString(record["text"], "Observer node text"),
    bounds: parseBounds(record["bounds"]),
    visible: nullableBoolean(record["visible"], "Observer node visibility"),
    enabled: nullableBoolean(record["enabled"], "Observer node enabled state"),
    focusable: nullableBoolean(record["focusable"], "Observer node focusability"),
    focused: nullableBoolean(record["focused"], "Observer node focus state"),
    modal: nullableBoolean(record["modal"], "Observer node modal state"),
    selectionState: selection as AndroidUiNodeSnapshot["selectionState"],
    valueNow: record["valueNow"] as number | null,
    className: nullableBoundedString(record["className"], "Observer class name"),
    packageName: nullableBoundedString(record["packageName"], "Observer package name"),
    clickable: nullableBoolean(record["clickable"], "Observer node clickability"),
    scrollable: nullableBoolean(record["scrollable"], "Observer node scrollability"),
    selected: nullableBoolean(record["selected"], "Observer node selected state"),
    children: children.map((child) => parseNode(child, counter, depth + 1)),
  };
}

export function parseObserverState(value: unknown): ObserverState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Observer state must be an object.");
  }
  const record = value as Record<string, unknown>;
  const sequence = safeInteger(record["sequence"], "Observer state sequence");
  const timestampMs = safeInteger(record["timestampMs"], "Observer state timestamp");
  const windowId = record["windowId"] === null
    ? null
    : safeInteger(record["windowId"], "Observer window id");
  const focusedValue = record["focused"];
  let focused: ObserverFocusedElement | null = null;
  if (focusedValue !== null) {
    if (typeof focusedValue !== "object" || Array.isArray(focusedValue)) {
      throw new TypeError("Observer focused element must be an object or null.");
    }
    const focusRecord = focusedValue as Record<string, unknown>;
    focused = {
      stableId: nullableBoundedString(focusRecord["stableId"], "Observer focused stable id"),
      role: nullableBoundedString(focusRecord["role"], "Observer focused role", 128),
      name: nullableBoundedString(focusRecord["name"], "Observer focused name"),
      bounds: parseBounds(focusRecord["bounds"]),
    };
  }
  if (typeof record["treeChanged"] !== "boolean") throw new TypeError("Observer treeChanged must be boolean.");
  const nodeCount = safeInteger(record["nodeCount"], "Observer node count");
  const maxDepth = safeInteger(record["maxDepth"], "Observer maximum depth");
  if (nodeCount > 4_096 || maxDepth > 64) throw new RangeError("Observer state metadata exceeds its bound.");
  let nodes: readonly AndroidUiNodeSnapshot[] | undefined;
  if (record["nodes"] !== undefined) {
    if (!Array.isArray(record["nodes"])) throw new TypeError("Observer state nodes must be an array.");
    const counter = { value: 0 };
    nodes = record["nodes"].map((node) => parseNode(node, counter, 0));
    if (counter.value !== nodeCount) throw new TypeError("Observer state node count does not match its tree.");
  }
  return {
    sequence,
    timestampMs,
    packageName: nullableBoundedString(record["packageName"], "Observer package name"),
    windowClassName: nullableBoundedString(record["windowClassName"], "Observer window class"),
    windowId,
    focused,
    structureFingerprint: boundedString(record["structureFingerprint"], "Observer structure fingerprint", 128),
    stateFingerprint: boundedString(record["stateFingerprint"], "Observer state fingerprint", 128),
    treeChanged: record["treeChanged"],
    ...(nodes === undefined ? {} : { nodes }),
    nodeCount,
    maxDepth,
  };
}

export function parseObserverResponse(value: unknown): ObserverResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Observer response must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== ANDROID_OBSERVER_PROTOCOL_VERSION) {
    throw new TypeError("Observer response uses an incompatible protocol version.");
  }
  const id = safeInteger(record["id"], "Observer response id");
  if (typeof record["ok"] !== "boolean") throw new TypeError("Observer response ok must be boolean.");
  const type = boundedString(record["type"], "Observer response type", 64);
  if (record["error"] !== undefined) {
    const error = record["error"];
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
      throw new TypeError("Observer error must be an object.");
    }
    const errorRecord = error as Record<string, unknown>;
    boundedString(errorRecord["code"], "Observer error code", 64);
    boundedString(errorRecord["message"], "Observer error message", 1_024);
  }
  return { ...(record as unknown as ObserverResponse), id, type };
}

export function validateObserverRequest(request: ObserverRequest): ObserverRequest {
  safeInteger(request.id, "Observer request id");
  if (request.version !== ANDROID_OBSERVER_PROTOCOL_VERSION) {
    throw new TypeError("Observer request uses an incompatible protocol version.");
  }
  switch (request.type) {
    case "hello":
      boundedString(request.token, "Observer token", 256);
      boundedString(request.hostVersion, "Host version", 64);
      break;
    case "begin_action":
      if (!isRemoteKey(request.key)) throw new TypeError("Observer action key is invalid.");
      break;
    case "settle_action":
      safeInteger(request.actionId, "Observer action id");
      for (const [label, duration] of [
        ["timeoutMs", request.timeoutMs],
        ["quietWindowMs", request.quietWindowMs],
        ["noResponseGraceMs", request.noResponseGraceMs],
      ] as const) {
        if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 60_000) {
          throw new TypeError(`${label} must be between 1 and 60000 ms.`);
        }
      }
      break;
    case "cancel":
      safeInteger(request.targetId, "Observer cancellation target id");
      break;
    default:
      break;
  }
  return request;
}

export function encodeObserverFrame(value: ObserverRequest | ObserverResponse): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength <= 0 || payload.byteLength > ANDROID_OBSERVER_MAX_FRAME_BYTES) {
    throw new RangeError("Observer frame payload is outside the permitted size.");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class ObserverFrameDecoder {
  #buffer = Buffer.alloc(0);
  readonly #maxFrameBytes: number;

  constructor(maxFrameBytes = ANDROID_OBSERVER_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new TypeError("maxFrameBytes must be a positive safe integer.");
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): readonly unknown[] {
    if (chunk.byteLength === 0) return [];
    if (this.#buffer.byteLength + chunk.byteLength > this.#maxFrameBytes + 4) {
      throw new RangeError("Observer receive buffer exceeded its bound.");
    }
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const messages: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length <= 0 || length > this.#maxFrameBytes) {
        throw new RangeError("Observer frame length is invalid.");
      }
      if (this.#buffer.byteLength < length + 4) break;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        throw new TypeError("Observer frame contains malformed JSON.", { cause: error });
      }
      messages.push(parsed);
    }
    return messages;
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) throw new TypeError("Observer connection ended with a partial frame.");
  }
}
