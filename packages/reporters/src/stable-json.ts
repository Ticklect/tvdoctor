export type JsonPrimitive = boolean | number | string | null;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

function canonicalise(value: JsonValue): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalise(item));

  const object = value as JsonObject;
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(object).sort()) {
    const child = object[key];
    if (child === undefined) throw new TypeError(`JSON value at ${key} is undefined.`);
    result[key] = canonicalise(child);
  }
  return result;
}

export function stableJson(value: JsonValue): string {
  return `${JSON.stringify(canonicalise(value), null, 2)}\n`;
}
