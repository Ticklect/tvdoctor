import {
  availableObservation,
  unavailableObservation,
  type ActionResult,
  type AppReference,
  type Capability,
  type DriverOperationOptions,
  type FocusTarget,
  type RemoteKey,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_UI_NODES = 4_000;
const MAX_UI_DEPTH = 96;
const MAX_TEXT_LENGTH = 2_048;

export const ROKU_DRIVER_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "remote-input",
  "ui-tree",
  "launch",
]);

export const ROKU_REMOTE_KEY_MAP: Readonly<Partial<Record<RemoteKey, string>>> = {
  UP: "up",
  DOWN: "down",
  LEFT: "left",
  RIGHT: "right",
  SELECT: "select",
  BACK: "back",
  HOME: "home",
  PLAY: "play",
  STOP: "stop",
  REWIND: "rev",
  FAST_FORWARD: "fwd",
};

export interface RokuTransportRequestOptions {
  readonly signal?: AbortSignal;
}

export interface RokuWebDriverTransport {
  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    options?: RokuTransportRequestOptions,
  ): Promise<unknown>;
}

export interface RokuTvDriverOptions {
  readonly deviceIp: string;
  readonly webDriverUrl?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly transport?: RokuWebDriverTransport;
}

interface RokuCommandResponse {
  readonly sessionId: string | null;
  readonly status: number;
  readonly value: unknown;
}

interface MutableUiNode {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly path: string;
  readonly children: MutableUiNode[];
  text: string;
}

function boundedText(value: unknown, maximum = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 9 || (code > 13 && code < 32) || code === 127 ? "" : character;
  }).join("").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, maximum);
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function parseCommandResponse(value: unknown): RokuCommandResponse {
  const record = objectRecord(value);
  if (record === null || !Number.isInteger(record["status"])) {
    throw new TypeError("Roku WebDriver returned an invalid command response.");
  }
  return {
    sessionId: boundedText(record["sessionId"], 256),
    status: Number(record["status"]),
    value: record["value"],
  };
}

function requireSuccess(value: unknown, operation: string): RokuCommandResponse {
  const response = parseCommandResponse(value);
  if (response.status !== 0) {
    throw new Error(`Roku WebDriver ${operation} failed with status ${String(response.status)}.`);
  }
  return response;
}

function loopbackWebDriverUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Roku WebDriver URL must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Roku WebDriver URL must not contain credentials, query, or fragment data.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
    throw new TypeError("Roku WebDriver URL must point to the local host service.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return selected;
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maximumBytes) throw new Error("Roku WebDriver response exceeded the configured byte limit.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("Roku WebDriver response exceeded the configured byte limit.");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export class FetchRokuWebDriverTransport implements RokuWebDriverTransport {
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(webDriverUrl: string, options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {}) {
    this.#baseUrl = loopbackWebDriverUrl(webDriverUrl);
    this.#timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
  }

  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    options: RokuTransportRequestOptions = {},
  ): Promise<unknown> {
    if (!/^\/v1\//u.test(path) && path !== "/status") throw new TypeError("Roku WebDriver request path is outside the supported API prefix.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal]);
    try {
      const init: RequestInit = {
        method,
        signal,
        ...(body === undefined ? {} : {
          headers: { "Content-Type": "application/json;charset=UTF-8" },
          body: JSON.stringify(body),
        }),
      };
      const response = await fetch(
        new URL(path.replace(/^\//u, ""), `${this.#baseUrl.href.replace(/\/?$/u, "/")}`),
        init,
      );
      const text = await boundedResponseText(response, this.#maxResponseBytes);
      if (!response.ok) throw new Error(`Roku WebDriver request failed with HTTP ${String(response.status)}.`);
      if (text.trim() === "") return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("Roku WebDriver returned malformed JSON.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function elementAttributes(value: unknown): Readonly<Record<string, string>> {
  const record = objectRecord(value);
  if (record === null || !Array.isArray(record["Attr"])) return {};
  const attributes: Record<string, string> = {};
  for (const raw of record["Attr"]) {
    const attribute = objectRecord(raw);
    const name = objectRecord(attribute?.["Name"]);
    const key = boundedText(name?.["Local"], 128);
    const content = boundedText(attribute?.["Value"]);
    if (key !== null && content !== null && Object.keys(attributes).length < 128) attributes[key] = content;
  }
  return attributes;
}

function elementTag(value: unknown): string | null {
  const record = objectRecord(value);
  const xmlName = objectRecord(record?.["XMLName"]);
  return boundedText(xmlName?.["Local"], 128);
}

function firstAttribute(attributes: Readonly<Record<string, string>>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = boundedText(attributes[name]);
    if (value !== null) return value;
  }
  return null;
}

function focusTargetFromElement(value: unknown): FocusTarget | null {
  const tag = elementTag(value);
  const attributes = elementAttributes(value);
  const stableId = firstAttribute(attributes, ["id", "name", "key", "uri"]);
  const name = firstAttribute(attributes, ["text", "title", "label", "name"]);
  if (tag === null && stableId === null && name === null) return null;
  return {
    ...(stableId === null ? {} : { stableId }),
    ...(tag === null ? {} : { role: tag }),
    ...(name === null ? {} : { name }),
  };
}

function booleanAttribute(attributes: Readonly<Record<string, string>>, name: string): boolean | null {
  const value = attributes[name]?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

function stableNodeId(node: MutableUiNode): string {
  return firstAttribute(node.attributes, ["id", "name", "key"]) ?? node.path;
}

function frozenNode(node: MutableUiNode): UiNodeSnapshot {
  const name = firstAttribute(node.attributes, ["text", "title", "label", "name"]);
  const text = boundedText(node.text) ?? firstAttribute(node.attributes, ["text"]);
  return {
    stableId: stableNodeId(node),
    role: node.tag,
    name,
    text,
    bounds: null,
    visible: booleanAttribute(node.attributes, "visible"),
    enabled: booleanAttribute(node.attributes, "enabled"),
    focusable: booleanAttribute(node.attributes, "focusable"),
    focused: booleanAttribute(node.attributes, "focused"),
    modal: null,
    selectionState: null,
    valueNow: null,
    children: node.children.map(frozenNode),
  };
}

export function parseRokuSource(sourceBase64: string): readonly UiNodeSnapshot[] {
  const decoded = Buffer.from(sourceBase64, "base64");
  if (decoded.length > DEFAULT_MAX_RESPONSE_BYTES) throw new Error("Roku screen source exceeded the supported decoded byte limit.");
  const xml = decoded.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error("Roku screen source contains unsupported XML declarations.");
  const roots: MutableUiNode[] = [];
  const stack: MutableUiNode[] = [];
  let nodes = 0;

  const decodeXmlText = (value: string): string => value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu,
    (entity) => {
      switch (entity.toLowerCase()) {
        case "&amp;": return "&";
        case "&lt;": return "<";
        case "&gt;": return ">";
        case "&quot;": return '"';
        case "&apos;": return "'";
        default: {
          const numeric = entity.startsWith("&#x") || entity.startsWith("&#X")
            ? Number.parseInt(entity.slice(3, -1), 16)
            : Number.parseInt(entity.slice(2, -1), 10);
          return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
            ? String.fromCodePoint(numeric)
            : "";
        }
      }
    },
  );

  const parseAttributes = (raw: string): Readonly<Record<string, string>> => {
    const attributes: Record<string, string> = {};
    let offset = 0;
    while (offset < raw.length) {
      const whitespace = /^[\t\r\n ]+/u.exec(raw.slice(offset));
      if (whitespace !== null) offset += whitespace[0].length;
      if (offset >= raw.length) break;
      const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(raw.slice(offset));
      if (match === null) throw new Error("Roku screen source contains malformed XML attributes.");
      if (Object.keys(attributes).length >= 128) throw new Error("Roku screen source exceeded the supported attribute limit.");
      const key = boundedText(match[1], 128);
      if (key !== null) attributes[key] = decodeXmlText(match[2] ?? match[3] ?? "").slice(0, MAX_TEXT_LENGTH);
      offset += match[0].length;
    }
    return attributes;
  };

  const openTag = (tagName: string, attributes: Readonly<Record<string, string>>): void => {
    nodes += 1;
    if (nodes > MAX_UI_NODES) throw new Error("Roku screen source exceeded the supported node limit.");
    if (stack.length >= MAX_UI_DEPTH) throw new Error("Roku screen source exceeded the supported depth limit.");
    const parent = stack.at(-1);
    const index = parent?.children.length ?? roots.length;
    const parentPath = parent?.path ?? "";
    const safeTag = boundedText(tagName, 128) ?? "node";
    const node: MutableUiNode = {
      tag: safeTag,
      attributes,
      path: `${parentPath}/${safeTag}[${String(index)}]`,
      children: [],
      text: "",
    };
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack.push(node);
  };

  let cursor = 0;
  while (cursor < xml.length) {
    const nextTag = xml.indexOf("<", cursor);
    if (nextTag < 0) {
      const current = stack.at(-1);
      if (current !== undefined && current.text.length < MAX_TEXT_LENGTH) {
        current.text += decodeXmlText(xml.slice(cursor)).slice(0, MAX_TEXT_LENGTH - current.text.length);
      }
      break;
    }
    if (nextTag > cursor) {
      const current = stack.at(-1);
      if (current !== undefined && current.text.length < MAX_TEXT_LENGTH) {
        current.text += decodeXmlText(xml.slice(cursor, nextTag)).slice(0, MAX_TEXT_LENGTH - current.text.length);
      }
    }
    if (xml.startsWith("<!--", nextTag)) {
      const end = xml.indexOf("-->", nextTag + 4);
      if (end < 0) throw new Error("Roku screen source contains an unterminated XML comment.");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", nextTag)) {
      const end = xml.indexOf("?>", nextTag + 2);
      if (end < 0) throw new Error("Roku screen source contains an unterminated XML processing instruction.");
      cursor = end + 2;
      continue;
    }
    const end = xml.indexOf(">", nextTag + 1);
    if (end < 0) throw new Error("Roku screen source contains an unterminated XML tag.");
    const inside = xml.slice(nextTag + 1, end).trim();
    if (inside.startsWith("/")) {
      const closingName = inside.slice(1).trim();
      const current = stack.pop();
      if (current === undefined || current.tag !== closingName) throw new Error("Roku screen source contains mismatched XML tags.");
    } else if (inside.startsWith("!")) {
      throw new Error("Roku screen source contains an unsupported XML construct.");
    } else {
      const selfClosing = inside.endsWith("/");
      const body = selfClosing ? inside.slice(0, -1).trimEnd() : inside;
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/u.exec(body);
      if (nameMatch === null) throw new Error("Roku screen source contains a malformed XML tag.");
      openTag(nameMatch[1] ?? "node", parseAttributes(nameMatch[2] ?? ""));
      if (selfClosing) stack.pop();
    }
    cursor = end + 1;
  }
  if (stack.length !== 0) throw new Error("Roku screen source contains unclosed XML tags.");
  return roots.map(frozenNode);
}

function currentAppLocation(value: unknown): string | null {
  const response = parseCommandResponse(value);
  if (response.status !== 0) return null;
  const first = Array.isArray(response.value) ? response.value[0] : response.value;
  const record = objectRecord(first);
  if (record === null) return null;
  const id = boundedText(record["ID"] ?? record["id"], 256);
  const title = boundedText(record["Title"] ?? record["title"], 256);
  if (id === null && title === null) return null;
  return [id, title].filter((part): part is string => part !== null).join(" · ");
}

export class RokuTvDriver implements TVDoctorDriver {
  readonly #deviceIp: string;
  readonly #transport: RokuWebDriverTransport;
  #sessionId: string | null = null;
  #lastApp: AppReference | null = null;

  constructor(options: RokuTvDriverOptions) {
    this.#deviceIp = options.deviceIp.trim();
    if (this.#deviceIp.length === 0 || this.#deviceIp.length > 256 || /\s/u.test(this.#deviceIp) || this.#deviceIp.includes("\u0000")) {
      throw new TypeError("deviceIp must be a bounded non-empty address string.");
    }
    this.#transport = options.transport ?? new FetchRokuWebDriverTransport(
      options.webDriverUrl ?? "http://127.0.0.1:8080",
      {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
      },
    );
  }

  async #session(options: DriverOperationOptions = {}): Promise<string> {
    if (this.#sessionId !== null) return this.#sessionId;
    const response = requireSuccess(
      await this.#transport.request("POST", "/v1/session", { ip: this.#deviceIp }, options),
      "session creation",
    );
    if (response.sessionId === null) throw new Error("Roku WebDriver did not return a session ID.");
    this.#sessionId = response.sessionId;
    return response.sessionId;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return ROKU_DRIVER_CAPABILITIES;
  }

  async launch(app: AppReference, options: DriverOperationOptions = {}): Promise<void> {
    const channelId = app.id.trim();
    if (channelId.length === 0 || channelId.length > 256 || /\s/u.test(channelId) || channelId.includes("\u0000")) {
      throw new TypeError("Roku app id must be a bounded non-empty channel identifier.");
    }
    const sessionId = await this.#session(options);
    requireSuccess(
      await this.#transport.request("POST", `/v1/session/${encodeURIComponent(sessionId)}/launch`, { channelId }, options),
      "launch",
    );
    this.#lastApp = { id: channelId };
  }

  async reset(strategy: ResetStrategy, options: DriverOperationOptions = {}): Promise<void> {
    if (strategy === "clear-data") throw new Error("Roku clear-data reset is not supported by this adapter.");
    if (this.#lastApp === null) throw new Error("Roku reset requires a previously launched app.");
    await this.launch(this.#lastApp, options);
  }

  async press(key: RemoteKey, options: DriverOperationOptions = {}): Promise<ActionResult> {
    const button = ROKU_REMOTE_KEY_MAP[key];
    const inputSentAtMs = performance.now();
    if (button === undefined) {
      return { key, outcome: "unsupported", timing: { inputSentAtMs }, message: `Roku WebDriver does not expose ${key} through this adapter.` };
    }
    try {
      const sessionId = await this.#session(options);
      requireSuccess(
        await this.#transport.request("POST", `/v1/session/${encodeURIComponent(sessionId)}/press`, { button }, options),
        `${key} press`,
      );
      const settledAtMs = performance.now();
      return {
        key,
        outcome: "applied",
        timing: {
          inputSentAtMs,
          firstResponseAtMs: settledAtMs,
          screenSettledAtMs: settledAtMs,
          profile: {
            baselineSource: "unavailable",
            captureCount: 0,
            inputDispatchMs: Math.max(0, settledAtMs - inputSentAtMs),
            totalMs: Math.max(0, settledAtMs - inputSentAtMs),
          },
        },
      };
    } catch (error) {
      return {
        key,
        outcome: "failed",
        timing: { inputSentAtMs },
        message: boundedText(error instanceof Error ? error.message : String(error), 1_024) ?? "Roku WebDriver input failed.",
      };
    }
  }

  async snapshot(options: DriverOperationOptions = {}): Promise<StateSnapshot> {
    const sessionId = await this.#session(options);
    const prefix = `/v1/session/${encodeURIComponent(sessionId)}`;
    const [locationResult, focusResult, sourceResult] = await Promise.allSettled([
      this.#transport.request("GET", `${prefix}/current_app`, undefined, options),
      this.#transport.request("GET", `${prefix}/element/active`, undefined, options),
      this.#transport.request("GET", `${prefix}/source`, undefined, options),
    ]);

    const location = locationResult.status === "fulfilled" ? currentAppLocation(locationResult.value) : null;
    let focusedElement;
    if (focusResult.status === "fulfilled") {
      try {
        const response = requireSuccess(focusResult.value, "active element");
        focusedElement = availableObservation(focusTargetFromElement(response.value));
      } catch (error) {
        focusedElement = unavailableObservation(boundedText(error instanceof Error ? error.message : String(error), 512) ?? "Active element unavailable.");
      }
    } else {
      focusedElement = unavailableObservation("Roku active element request failed.");
    }

    let uiTree;
    if (sourceResult.status === "fulfilled") {
      try {
        const response = requireSuccess(sourceResult.value, "screen source");
        const source = boundedText(response.value, DEFAULT_MAX_RESPONSE_BYTES * 2);
        if (source === null) throw new Error("Roku screen source was empty.");
        uiTree = availableObservation(parseRokuSource(source));
      } catch (error) {
        uiTree = unavailableObservation(boundedText(error instanceof Error ? error.message : String(error), 512) ?? "Roku screen source unavailable.");
      }
    } else {
      uiTree = unavailableObservation("Roku screen source request failed.");
    }

    return {
      capturedAt: new Date().toISOString(),
      location: location === null ? unavailableObservation("Roku current app information was unavailable.") : availableObservation(location),
      focusedElement,
      uiTree,
    };
  }

  async close(options: DriverOperationOptions = {}): Promise<void> {
    if (this.#sessionId === null) return;
    const sessionId = this.#sessionId;
    this.#sessionId = null;
    await this.#transport.request("DELETE", `/v1/session/${encodeURIComponent(sessionId)}`, undefined, options);
  }
}
