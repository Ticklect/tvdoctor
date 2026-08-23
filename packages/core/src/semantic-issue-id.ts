/** JSON-compatible scalar accepted by the stable semantic identity builder. */
export type SemanticIdentityScalar = boolean | null | number | string;

/** Plain JSON-compatible object accepted by the stable semantic identity builder. */
export interface SemanticIdentityObject {
  readonly [key: string]: SemanticIdentityValue;
}

/** JSON-compatible value accepted by the stable semantic identity builder. */
export type SemanticIdentityValue =
  | SemanticIdentityScalar
  | SemanticIdentityObject
  | readonly SemanticIdentityValue[];

/** An explicitly ordered top-level semantic identity field. */
export type SemanticIdentityField = readonly [
  key: string,
  value: SemanticIdentityValue,
];

const ISSUE_ID_DOMAIN_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u;
const MAX_ISSUE_ID_DOMAIN_LENGTH = 32;
const HASH_SEEDS: readonly number[] = [
  0x811c9dc5,
  0x9e3779b9,
  0x85ebca6b,
  0xc2b2ae35,
];

function semanticHash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function serialiseIdentityValue(
  value: SemanticIdentityValue,
  ancestors: ReadonlySet<object>,
  path: string,
): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Semantic identity number at ${path} must be finite.`);
    }
    return JSON.stringify(value);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`Semantic identity value at ${path} must not be cyclic.`);
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new TypeError(`Semantic identity array at ${path} must not be sparse.`);
      }
      const item = value[index];
      if (item === undefined) {
        throw new TypeError(`Semantic identity value at ${path}[${String(index)}] is unsupported.`);
      }
      entries.push(serialiseIdentityValue(item, nextAncestors, `${path}[${String(index)}]`));
    }
    return `[${entries.join(",")}]`;
  }

  const objectValue = value as SemanticIdentityObject;
  const prototype = Object.getPrototypeOf(objectValue) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Semantic identity object at ${path} must be a plain object.`);
  }

  const entries = Object.keys(objectValue).map((key) => {
    const item = objectValue[key];
    if (item === undefined) {
      throw new TypeError(`Semantic identity value at ${path}.${key} is unsupported.`);
    }
    return `${JSON.stringify(key)}:${serialiseIdentityValue(item, nextAncestors, `${path}.${key}`)}`;
  });
  return `{${entries.join(",")}}`;
}

/**
 * Builds the canonical JSON string hashed by {@link createSemanticIssueId}.
 *
 * Field and array order are intentionally significant. Callers must keep the
 * ordered field contract stable when evolving an issue family. Values must be
 * finite, acyclic, plain JSON data; unsupported values are rejected instead of
 * being silently omitted or coerced by `JSON.stringify`.
 */
export function createCanonicalSemanticIdentity(
  fields: readonly SemanticIdentityField[],
): string {
  const keys = new Set<string>();
  const entries = fields.map(([key, value]) => {
    if (key.length === 0) {
      throw new TypeError("Semantic identity field names must not be empty.");
    }
    if (keys.has(key)) {
      throw new TypeError(`Semantic identity field '${key}' is duplicated.`);
    }
    keys.add(key);
    return `${JSON.stringify(key)}:${serialiseIdentityValue(value, new Set(), `$.${key}`)}`;
  });
  return `{${entries.join(",")}}`;
}

function assertCanonicalIdentity(canonicalIdentity: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalIdentity) as unknown;
  } catch {
    throw new TypeError("Semantic issue identity must be canonical JSON produced by createCanonicalSemanticIdentity.");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError("Semantic issue identity must be a canonical JSON object.");
  }
  const reserialised = serialiseIdentityValue(
    parsed as SemanticIdentityObject,
    new Set(),
    "$",
  );
  if (reserialised !== canonicalIdentity) {
    throw new TypeError("Semantic issue identity must be canonical JSON produced by createCanonicalSemanticIdentity.");
  }
}

/**
 * Creates a deterministic TVDoctor issue ID from a canonical semantic identity.
 *
 * The uppercase domain is the visible issue namespace and separates otherwise
 * identical identities (for example `NAV` and `STREAM`). The 128-bit uppercase
 * digest deliberately preserves the legacy navigation hash algorithm.
 */
export function createSemanticIssueId(
  domain: string,
  canonicalIdentity: string,
): string {
  if (domain.length > MAX_ISSUE_ID_DOMAIN_LENGTH || !ISSUE_ID_DOMAIN_PATTERN.test(domain)) {
    throw new TypeError(
      `Semantic issue ID domain must be 1-${String(MAX_ISSUE_ID_DOMAIN_LENGTH)} uppercase ASCII letters/digits with optional single hyphens.`,
    );
  }
  assertCanonicalIdentity(canonicalIdentity);
  const digest = HASH_SEEDS
    .map((seed) => semanticHash32(canonicalIdentity, seed))
    .join("")
    .toUpperCase();
  return `TVDOCTOR-${domain}-${digest}`;
}
