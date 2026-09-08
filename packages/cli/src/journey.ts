import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { REMOTE_KEYS, type RemoteKey, type StateSnapshot } from "@tvdoctor/protocol";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";

export const JOURNEY_SCHEMA_VERSION_V1 = "tvdoctor.journey/v1" as const;
export const JOURNEY_HASH_ENVIRONMENT_KEY = "journeyConfigSha256";
export const JOURNEY_NAME_ENVIRONMENT_KEY = "journeyName";
export const MAX_JOURNEY_ACTIONS = 256;
const MAX_JOURNEY_SECRET_CHARACTERS = 1_024;
const MAX_JOURNEY_FILE_BYTES = 64 * 1024;
const MAX_JOURNEY_STEPS = 32;
const MAX_JOURNEY_DURATION_MS = 120_000;
const ENVIRONMENT_NAME = /^TVDOCTOR_JOURNEY_[A-Z0-9_]{1,64}$/u;
const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);

export type JourneyStep =
  | { readonly action: "press"; readonly key: RemoteKey; readonly repeat: number }
  | { readonly action: "type-from-env"; readonly env: string }
  | { readonly action: "expect-focus"; readonly role?: string; readonly name?: string };

export interface JourneyV1 {
  readonly schemaVersion: typeof JOURNEY_SCHEMA_VERSION_V1;
  readonly name: string;
  readonly maxDurationMs: number;
  readonly steps: readonly JourneyStep[];
  readonly sha256: string;
}

export interface JourneyExecutionResult {
  readonly actions: number;
  readonly maxActions: number;
  readonly durationMs: number;
  readonly maxDurationMs: number;
  readonly snapshots: number;
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw new TypeError(`${path}.${key} is not supported.`);
  }
}

function boundedText(value: unknown, path: string, maximum = 256): string {
  const hasUnsafeControl = typeof value === "string" && [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x061c
      || codePoint === 0x200e
      || codePoint === 0x200f
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum
    || hasUnsafeControl) {
    throw new TypeError(`${path} must be bounded printable text.`);
  }
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key])]));
}

export function parseJourney(value: unknown): JourneyV1 {
  const root = plainRecord(value, "$journey");
  exact(root, "$journey", ["schemaVersion", "name", "maxDurationMs", "steps"]);
  if (root["schemaVersion"] !== JOURNEY_SCHEMA_VERSION_V1) {
    throw new TypeError(`$journey.schemaVersion must be ${JOURNEY_SCHEMA_VERSION_V1}.`);
  }
  const name = boundedText(root["name"], "$journey.name", 128);
  const maxDurationMs = root["maxDurationMs"] ?? 30_000;
  if (!Number.isSafeInteger(maxDurationMs) || (maxDurationMs as number) <= 0
    || (maxDurationMs as number) > MAX_JOURNEY_DURATION_MS) {
    throw new TypeError(`$journey.maxDurationMs must be an integer from 1 through ${String(MAX_JOURNEY_DURATION_MS)}.`);
  }
  if (!Array.isArray(root["steps"]) || root["steps"].length === 0 || root["steps"].length > MAX_JOURNEY_STEPS) {
    throw new TypeError(`$journey.steps must contain 1 through ${String(MAX_JOURNEY_STEPS)} steps.`);
  }
  const steps = root["steps"].map((input, index): JourneyStep => {
    const path = `$journey.steps[${String(index)}]`;
    const step = plainRecord(input, path);
    const action = step["action"];
    if (action === "press") {
      exact(step, path, ["action", "key", "repeat"]);
      const key = boundedText(step["key"], `${path}.key`, 32);
      if (!REMOTE_KEY_SET.has(key)) throw new TypeError(`${path}.key must be a known remote key.`);
      const repeat = step["repeat"] ?? 1;
      if (!Number.isSafeInteger(repeat) || (repeat as number) < 1 || (repeat as number) > 10) {
        throw new TypeError(`${path}.repeat must be an integer from 1 through 10.`);
      }
      return { action, key: key as RemoteKey, repeat: repeat as number };
    }
    if (action === "type-from-env") {
      exact(step, path, ["action", "env"]);
      const env = boundedText(step["env"], `${path}.env`, 85);
      if (!ENVIRONMENT_NAME.test(env)) {
        throw new TypeError(`${path}.env must start with TVDOCTOR_JOURNEY_ and contain only A-Z, 0-9, or underscore.`);
      }
      return { action, env };
    }
    if (action === "expect-focus") {
      exact(step, path, ["action", "role", "name"]);
      const role = step["role"] === undefined ? undefined : boundedText(step["role"], `${path}.role`, 64);
      const expectedName = step["name"] === undefined ? undefined : boundedText(step["name"], `${path}.name`, 256);
      if (role === undefined && expectedName === undefined) {
        throw new TypeError(`${path} requires role or name.`);
      }
      return {
        action,
        ...(role === undefined ? {} : { role }),
        ...(expectedName === undefined ? {} : { name: expectedName }),
      };
    }
    throw new TypeError(`${path}.action must be press, type-from-env, or expect-focus.`);
  });
  const canonicalConfig = {
    schemaVersion: JOURNEY_SCHEMA_VERSION_V1,
    name,
    maxDurationMs: maxDurationMs as number,
    steps,
  };
  return {
    ...canonicalConfig,
    sha256: createHash("sha256").update(JSON.stringify(canonical(canonicalConfig))).digest("hex"),
  };
}

export async function loadJourney(path: string): Promise<JourneyV1> {
  const absolutePath = resolve(path);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new TypeError("The journey path is not a regular file.");
  if (metadata.size > MAX_JOURNEY_FILE_BYTES) throw new TypeError("The journey file exceeds 64 KiB.");
  return parseJourney(JSON.parse(await readFile(absolutePath, "utf8")) as unknown);
}

function focusedMatches(snapshot: StateSnapshot, step: Extract<JourneyStep, { action: "expect-focus" }>): boolean {
  if (snapshot.uiTree.status !== "available") return false;
  const pending = [...snapshot.uiTree.value];
  let inspected = 0;
  while (pending.length > 0 && inspected < 4_096) {
    const node = pending.shift();
    if (node === undefined) break;
    inspected += 1;
    if (node.focused === true
      && (step.role === undefined || node.role === step.role)
      && (step.name === undefined || node.name === step.name)) return true;
    pending.push(...node.children);
  }
  return false;
}

export async function executeJourney(
  driver: PlaywrightWebDriver,
  journey: JourneyV1,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<JourneyExecutionResult> {
  const secrets = new Map<string, string>();
  const maxActions = journey.steps.reduce(
    (total, step) => total + (step.action === "press" ? step.repeat : step.action === "type-from-env" ? 1 : 0),
    0,
  );
  let secretCharacters = 0;
  for (const step of journey.steps) {
    if (step.action !== "type-from-env") continue;
    const value = environment[step.env];
    if (value === undefined || value.length === 0 || value.length > 256) {
      throw new TypeError(`${step.env} must contain 1 through 256 characters.`);
    }
    secrets.set(step.env, value);
    secretCharacters += value.length;
  }
  if (secretCharacters > MAX_JOURNEY_SECRET_CHARACTERS) {
    throw new RangeError("The journey's secret input exceeds its total character budget.");
  }
  if (maxActions > MAX_JOURNEY_ACTIONS) {
    throw new RangeError(`The journey requires ${String(maxActions)} actions; the maximum is ${String(MAX_JOURNEY_ACTIONS)}.`);
  }
  const startedAt = performance.now();
  const deadline = startedAt + journey.maxDurationMs;
  let actions = 0;
  let snapshots = 0;
  const assertActive = (): void => {
    if (signal?.aborted === true) throw new Error("The custom journey was interrupted.");
    if (performance.now() >= deadline) throw new Error("The custom journey exceeded its duration budget.");
  };
  for (const step of journey.steps) {
    assertActive();
    if (step.action === "press") {
      for (let repeat = 0; repeat < step.repeat; repeat += 1) {
        assertActive();
        const result = await driver.press(step.key);
        actions += 1;
        if (result.outcome !== "applied") {
          throw new Error(`Journey remote key ${step.key} was ${result.outcome}.`);
        }
      }
    } else if (step.action === "type-from-env") {
      const secret = secrets.get(step.env);
      if (secret === undefined) throw new TypeError(`${step.env} was unavailable.`);
      await driver.getPage().keyboard.insertText(secret);
      actions += 1;
    } else {
      const snapshot = await driver.snapshot();
      snapshots += 1;
      if (!focusedMatches(snapshot, step)) {
        throw new Error("The custom journey did not reach its expected focus target.");
      }
    }
  }
  assertActive();
  return {
    actions,
    maxActions: MAX_JOURNEY_ACTIONS,
    durationMs: Math.max(0, performance.now() - startedAt),
    maxDurationMs: journey.maxDurationMs,
    snapshots,
  };
}
