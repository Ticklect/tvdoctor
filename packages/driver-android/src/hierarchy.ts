import type { FocusTarget } from "@tvdoctor/protocol";
import type {
  AndroidHierarchyMetadata,
  AndroidUiNodeSnapshot,
} from "./types.js";

export interface AndroidHierarchyLimits {
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxStringLength: number;
}

export interface ParsedAndroidHierarchy {
  readonly roots: readonly AndroidUiNodeSnapshot[];
  readonly focusedTarget: FocusTarget | null;
  readonly focusedNodeCount: number;
  readonly metadata: AndroidHierarchyMetadata;
  readonly settleSignature: string;
}

interface MutableAndroidNode extends AndroidUiNodeSnapshot {
  children: MutableAndroidNode[];
}

const DEFAULT_LIMITS: AndroidHierarchyLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxNodes: 4_096,
  maxDepth: 128,
  maxStringLength: 1_024,
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function normaliseLimits(overrides: Partial<AndroidHierarchyLimits>): AndroidHierarchyLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  return {
    maxBytes: positiveInteger(limits.maxBytes, "maxBytes"),
    maxNodes: positiveInteger(limits.maxNodes, "maxNodes"),
    maxDepth: positiveInteger(limits.maxDepth, "maxDepth"),
    maxStringLength: positiveInteger(limits.maxStringLength, "maxStringLength"),
  };
}

function xmlTags(source: string): readonly string[] {
  const tags: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) break;
    let quote: "\"" | "'" | null = null;
    let end = start + 1;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if ((character === "\"" || character === "'") && quote === null) {
        quote = character;
      } else if (character === quote) {
        quote = null;
      } else if (character === ">" && quote === null) {
        break;
      }
    }
    if (end >= source.length) throw new TypeError("UIAutomator hierarchy contains an unterminated XML tag.");
    tags.push(source.slice(start, end + 1));
    cursor = end + 1;
  }
  return tags;
}

function decodeXml(value: string, maximumLength: number): string {
  const decoded = value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/giu, (entity, body: string) => {
    switch (body.toLowerCase()) {
      case "amp": return "&";
      case "apos": return "'";
      case "gt": return ">";
      case "lt": return "<";
      case "quot": return "\"";
      default: {
        const codePoint = body.toLowerCase().startsWith("#x")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
          throw new TypeError("UIAutomator hierarchy contains an invalid numeric XML entity.");
        }
        return String.fromCodePoint(codePoint);
      }
    }
  });
  if (decoded.includes("&") && /&[^;\s]{1,64};/u.test(decoded)) {
    throw new TypeError("UIAutomator hierarchy contains an unsupported XML entity.");
  }
  return decoded.normalize("NFKC").slice(0, maximumLength);
}

function attributes(tag: string, maximumLength: number): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of tag.matchAll(pattern)) {
    const key = match[1];
    const rawValue = match[2] ?? match[3];
    if (key === undefined || rawValue === undefined) continue;
    if (result.has(key)) throw new TypeError(`UIAutomator node repeats attribute ${key}.`);
    result.set(key, decodeXml(rawValue, maximumLength));
  }
  return result;
}

function nullableText(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length === 0 ? null : text;
}

function nullableBoolean(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function bounds(value: string | undefined): AndroidUiNodeSnapshot["bounds"] {
  if (value === undefined) return null;
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(value.trim());
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  const width = right - x;
  const height = bottom - y;
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height }
    : null;
}

function roleFor(className: string | null, clickable: boolean | null): string | null {
  const shortName = className?.split(".").at(-1)?.toLowerCase() ?? "";
  switch (shortName) {
    case "button":
    case "imagebutton": return "button";
    case "checkbox": return "checkbox";
    case "radiobutton": return "radio";
    case "switch":
    case "switchcompat":
    case "togglebutton": return "switch";
    case "seekbar": return "slider";
    case "edittext": return "textbox";
    case "imageview": return "img";
    case "listview":
    case "recyclerview": return "list";
    case "textview": return clickable === true ? "button" : "text";
    default: return clickable === true ? "button" : null;
  }
}

function nodeFromTag(tag: string, maximumLength: number): MutableAndroidNode {
  const values = attributes(tag, maximumLength);
  const className = nullableText(values.get("class"));
  const clickable = nullableBoolean(values.get("clickable"));
  const nodeBounds = bounds(values.get("bounds"));
  const visibleAttribute = nullableBoolean(values.get("visible-to-user"))
    ?? nullableBoolean(values.get("displayed"));
  const checkable = nullableBoolean(values.get("checkable"));
  const checked = nullableBoolean(values.get("checked"));
  const selected = nullableBoolean(values.get("selected"));
  const contentDescription = nullableText(values.get("content-desc"));
  const text = nullableText(values.get("text"));
  return {
    stableId: nullableText(values.get("resource-id")),
    role: roleFor(className, clickable),
    name: contentDescription ?? text,
    text,
    bounds: nodeBounds,
    visible: visibleAttribute ?? (nodeBounds === null ? null : true),
    enabled: nullableBoolean(values.get("enabled")),
    focusable: nullableBoolean(values.get("focusable")),
    focused: nullableBoolean(values.get("focused")),
    modal: null,
    selectionState: checkable === true && checked !== null
      ? (checked ? "on" : "off")
      : selected === true
        ? "on"
        : null,
    valueNow: null,
    className,
    packageName: nullableText(values.get("package")),
    clickable,
    scrollable: nullableBoolean(values.get("scrollable")),
    selected,
    children: [],
  };
}

function focusTarget(node: AndroidUiNodeSnapshot): FocusTarget {
  return {
    ...(node.stableId === null ? {} : { stableId: node.stableId }),
    ...(node.role === null ? {} : { role: node.role }),
    ...(node.name === null ? {} : { name: node.name }),
    ...(node.bounds === null ? {} : { bounds: node.bounds }),
  };
}

function settleSignature(roots: readonly AndroidUiNodeSnapshot[]): string {
  const values: string[] = [];
  const pending = [...roots].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    values.push([
      node.stableId ?? "",
      node.role ?? "",
      node.stableId === null && node.focused === true ? node.name ?? "" : "",
      node.focused === null ? "?" : String(node.focused),
      node.enabled === null ? "?" : String(node.enabled),
      node.selectionState ?? "",
      node.bounds === null
        ? ""
        : `${String(node.bounds.x)},${String(node.bounds.y)},${String(node.bounds.width)},${String(node.bounds.height)}`,
      String(node.children.length),
    ].join("\u001f"));
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return values.join("\u001e");
}

export function parseUiAutomatorHierarchy(
  xml: string | Uint8Array,
  overrides: Partial<AndroidHierarchyLimits> = {},
): ParsedAndroidHierarchy {
  const limits = normaliseLimits(overrides);
  const bytes = typeof xml === "string" ? Buffer.byteLength(xml, "utf8") : xml.byteLength;
  if (bytes <= 0) throw new TypeError("UIAutomator hierarchy is empty.");
  if (bytes > limits.maxBytes) {
    throw new RangeError(`UIAutomator hierarchy exceeds ${String(limits.maxBytes)} bytes.`);
  }
  const source = typeof xml === "string" ? xml : Buffer.from(xml).toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) {
    throw new TypeError("UIAutomator hierarchy must not contain declarations or entities.");
  }

  const roots: MutableAndroidNode[] = [];
  const stack: MutableAndroidNode[] = [];
  let nodeCount = 0;
  let deepest = 0;
  for (const tag of xmlTags(source)) {
    const body = tag.slice(1, -1).trim();
    if (/^\/node\s*$/iu.test(body)) {
      if (stack.pop() === undefined) {
        throw new TypeError("UIAutomator hierarchy contains an unmatched node close tag.");
      }
      continue;
    }
    if (!/^node(?:\s|\/|$)/iu.test(body)) continue;
    nodeCount += 1;
    if (nodeCount > limits.maxNodes) {
      throw new RangeError(`UIAutomator hierarchy exceeds ${String(limits.maxNodes)} nodes.`);
    }
    const depth = stack.length;
    if (depth >= limits.maxDepth) {
      throw new RangeError(`UIAutomator hierarchy exceeds depth ${String(limits.maxDepth)}.`);
    }
    deepest = Math.max(deepest, depth);
    const node = nodeFromTag(tag, limits.maxStringLength);
    const parent = stack.at(-1);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    if (!/\/\s*>$/u.test(tag)) stack.push(node);
  }
  if (stack.length > 0) throw new TypeError("UIAutomator hierarchy contains unclosed nodes.");
  if (roots.length === 0 || nodeCount === 0) {
    throw new TypeError("UIAutomator hierarchy contains no UI nodes.");
  }

  const focused: AndroidUiNodeSnapshot[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.focused === true) focused.push(node);
    pending.push(...node.children);
  }
  return {
    roots,
    focusedTarget: focused.length === 1 && focused[0] !== undefined
      ? focusTarget(focused[0])
      : null,
    focusedNodeCount: focused.length,
    metadata: {
      capturedNodeCount: nodeCount,
      maxNodeCount: limits.maxNodes,
      maxDepth: deepest,
      truncated: false,
    },
    settleSignature: settleSignature(roots),
  };
}
