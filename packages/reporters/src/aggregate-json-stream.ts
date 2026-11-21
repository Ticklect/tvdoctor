import { Buffer } from "node:buffer";
import { isSensitiveEnvironmentKey, sanitiseUntrustedText } from "./security.js";

/** Hard ceilings for report sidecars. The optional overrides may only lower them. */
export const AGGREGATE_JSON_STREAM_LIMITS = {
  maxNodes: 4_000_000,
  maxArrayEntries: 500_000,
  maxObjectEntries: 20_000,
  maxDepth: 40,
  maxBytes: 256 * 1024 * 1024,
} as const;

export type AggregateJsonStreamLimits = Readonly<Record<keyof typeof AGGREGATE_JSON_STREAM_LIMITS, number>>;

const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CHUNK_CHARACTERS = 32 * 1024;

function configuredLimits(overrides: Partial<AggregateJsonStreamLimits>): AggregateJsonStreamLimits {
  const result = { ...AGGREGATE_JSON_STREAM_LIMITS, ...overrides };
  for (const key of Object.keys(AGGREGATE_JSON_STREAM_LIMITS) as (keyof AggregateJsonStreamLimits)[]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > AGGREGATE_JSON_STREAM_LIMITS[key]) {
      throw new TypeError(`Aggregate JSON ${key} must be a positive integer no greater than the hard limit.`);
    }
  }
  return result;
}

/**
 * Serialize the same stable, redacted JSON shape as sanitiseAggregateReportJson
 * followed by stableJson, without copying the entire graph into memory.
 * Large arrays are traversed incrementally; a limit or validation failure
 * stops the temporary file before ArtifactStore makes it visible.
 */
export function* aggregateReportJsonChunks(
  value: unknown,
  overrides: Partial<AggregateJsonStreamLimits> = {},
): Iterable<string> {
  const limits = configuredLimits(overrides);
  let nodes = 0;
  let writtenBytes = 0;

  function* parts(input: unknown, depth: number): Generator<string> {
    nodes += 1;
    if (nodes > limits.maxNodes) throw new TypeError("Aggregate JSON exceeds the node limit.");
    if (depth > limits.maxDepth) throw new TypeError("Aggregate JSON exceeds the nesting limit.");
    if (input === null || typeof input === "boolean") {
      yield JSON.stringify(input);
      return;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError("Aggregate JSON numbers must be finite.");
      yield JSON.stringify(input);
      return;
    }
    if (typeof input === "string") {
      yield JSON.stringify(sanitiseUntrustedText(input, 4_000));
      return;
    }
    if (typeof input !== "object") throw new TypeError("Aggregate JSON contains a non-JSON value.");

    const indent = "  ".repeat(depth);
    const nextIndent = `${indent}  `;
    if (Array.isArray(input)) {
      if (input.length > limits.maxArrayEntries) {
        throw new TypeError("Aggregate JSON array exceeds the item limit.");
      }
      if (Object.getOwnPropertySymbols(input).length > 0) {
        throw new TypeError("Aggregate JSON cannot contain symbol properties.");
      }
      yield "[";
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor !== undefined && !("value" in descriptor)) {
          throw new TypeError("Aggregate JSON cannot contain accessor properties.");
        }
        yield index === 0 ? `\n${nextIndent}` : `,\n${nextIndent}`;
        // JSON.stringify maps missing/undefined array slots to null.
        yield* parts(descriptor?.value === undefined ? null : descriptor.value, depth + 1);
      }
      yield input.length === 0 ? "]" : `\n${indent}]`;
      return;
    }

    const record = input as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Aggregate JSON objects must have a plain prototype.");
    }
    if (Object.getOwnPropertySymbols(record).length > 0) {
      throw new TypeError("Aggregate JSON cannot contain symbol properties.");
    }
    const rawKeys = Object.keys(record);
    if (rawKeys.length > limits.maxObjectEntries) {
      throw new TypeError("Aggregate JSON object exceeds the property limit.");
    }
    const seen = new Set<string>();
    const entries: { key: string; value: unknown }[] = [];
    for (const rawKey of rawKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, rawKey);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("Aggregate JSON cannot contain accessor properties.");
      }
      const key = sanitiseUntrustedText(rawKey, 256);
      if (key.length === 0 || PROTOTYPE_KEYS.has(key)) {
        throw new TypeError("Aggregate JSON contains an unsafe property name.");
      }
      if (seen.has(key)) throw new TypeError("Aggregate JSON keys collide after sanitisation.");
      seen.add(key);
      // Match the existing CLI's JSON.clone step for optional object properties.
      if (descriptor.value === undefined) continue;
      entries.push({
        key,
        value: isSensitiveEnvironmentKey(rawKey) || isSensitiveEnvironmentKey(key.replace(/\s+/gu, " "))
          ? "[REDACTED]"
          : descriptor.value,
      });
    }
    entries.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    yield "{";
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) throw new Error("Aggregate JSON property vanished during serialization.");
      yield index === 0 ? `\n${nextIndent}` : `,\n${nextIndent}`;
      yield `${JSON.stringify(entry.key)}: `;
      yield* parts(entry.value, depth + 1);
    }
    yield entries.length === 0 ? "}" : `\n${indent}}`;
  }

  let pending = "";
  for (const part of parts(value, 0)) {
    writtenBytes += Buffer.byteLength(part, "utf8");
    if (writtenBytes > limits.maxBytes) throw new TypeError("Aggregate JSON exceeds the byte limit.");
    pending += part;
    if (pending.length >= CHUNK_CHARACTERS) {
      yield pending;
      pending = "";
    }
  }
  writtenBytes += 1;
  if (writtenBytes > limits.maxBytes) throw new TypeError("Aggregate JSON exceeds the byte limit.");
  yield `${pending}\n`;
}
