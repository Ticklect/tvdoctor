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
const MAX_JOURNEY_WAIT_MS = 30_000;
const WAIT_STABILITY_INTERVAL_MS = 120;
const ENVIRONMENT_NAME = /^TVDOCTOR_JOURNEY_[A-Z0-9_]{1,64}$/u;
const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);
const UI_ROLES = new Set(["dialog", "alertdialog", "region", "tabpanel", "heading", "button"]);
const SAFE_ROUTE = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;

type UiRole = "dialog" | "alertdialog" | "region" | "tabpanel" | "heading" | "button";
type UiState = "visible" | "hidden";
interface UiStep { readonly role: UiRole; readonly name: string; readonly state: UiState }

export type JourneyStep =
  | { readonly action: "press"; readonly key: RemoteKey; readonly repeat: number }
  | { readonly action: "type-from-env"; readonly env: string }
  | { readonly action: "expect-focus"; readonly role?: string; readonly name?: string }
  | { readonly action: "expect-route"; readonly path: string }
  | { readonly action: "navigate-route"; readonly path: string }
  | ({ readonly action: "expect-ui" } & UiStep)
  | { readonly action: "wait-for-route"; readonly path: string; readonly timeoutMs: number }
  | ({ readonly action: "wait-for-ui"; readonly timeoutMs: number } & UiStep);

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

/**
 * A developer's exact, immutable journey may author a longer protected-content
 * wait than the default hydration window. Never infer a longer wait from a
 * successful login action, elapsed time, or a marker on an unrelated route.
 * The caller must still check route, unique visible marker and stability after
 * each restoration. This helper does not execute any application actions.
 */
export function authoredProtectedContentWaitMs(
  journey: JourneyV1,
  expected: { readonly path: string; readonly role: "heading" | "region" | "button"; readonly name: string },
): number | null {
  // Only terminal read-only assertions can author a post-login readiness
  // budget. A matching wait BEFORE a later press, secret input or route
  // navigation does not certify the page state produced by that later action.
  let lastInput = -1;
  for (const [index, step] of journey.steps.entries()) {
    if (step.action === "press" || step.action === "type-from-env"
      || step.action === "navigate-route") lastInput = index;
  }
  let route: string | null = null;
  let timeout: number | null = null;
  for (const step of journey.steps.slice(lastInput + 1)) {
    if (step.action === "expect-route" || step.action === "wait-for-route"
      || step.action === "navigate-route") {
      route = step.path;
      if (step.action === "navigate-route" || route !== expected.path) timeout = null;
    }
    if (step.action === "wait-for-ui" && route === expected.path
      && step.state === "visible" && step.role === expected.role
      && step.name === expected.name && Number.isSafeInteger(step.timeoutMs)
      && step.timeoutMs >= 2_000 && step.timeoutMs <= MAX_JOURNEY_WAIT_MS) {
      timeout = step.timeoutMs;
    }
  }
  return route === expected.path ? timeout : null;
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

function safeRoute(value: unknown, path: string): string {
  const route = boundedText(value, path, 200);
  if (!SAFE_ROUTE.test(route) || route.includes("//")
    || route.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new TypeError(`${path} must be a safe absolute pathname (no query, fragment, encoding, traversal or credentials).`);
  }
  return route;
}

function uiExpectation(step: Record<string, unknown>, path: string): UiStep {
  const role = boundedText(step["role"], `${path}.role`, 32);
  if (!UI_ROLES.has(role)) {
    throw new TypeError(`${path}.role must be dialog, alertdialog, region, tabpanel, heading or button.`);
  }
  const name = boundedText(step["name"], `${path}.name`, 128);
  const state = step["state"];
  if (state !== "visible" && state !== "hidden") {
    throw new TypeError(`${path}.state must be visible or hidden.`);
  }
  return { role: role as UiRole, name, state };
}

function waitTimeout(value: unknown, path: string): number {
  const timeout = value ?? 10_000;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < WAIT_STABILITY_INTERVAL_MS * 2 + 10
    || (timeout as number) > MAX_JOURNEY_WAIT_MS) {
    throw new TypeError(`${path} must be a bounded wait from ${String(WAIT_STABILITY_INTERVAL_MS)} through ${String(MAX_JOURNEY_WAIT_MS)} ms.`);
  }
  return timeout as number;
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
    if (action === "expect-route" || action === "navigate-route") {
      exact(step, path, ["action", "path"]);
      return { action, path: safeRoute(step["path"], `${path}.path`) };
    }
    if (action === "expect-ui") {
      exact(step, path, ["action", "role", "name", "state"]);
      return { action, ...uiExpectation(step, path) };
    }
    if (action === "wait-for-route") {
      exact(step, path, ["action", "path", "timeoutMs"]);
      return { action, path: safeRoute(step["path"], `${path}.path`),
        timeoutMs: waitTimeout(step["timeoutMs"], `${path}.timeoutMs`) };
    }
    if (action === "wait-for-ui") {
      exact(step, path, ["action", "role", "name", "state", "timeoutMs"]);
      return { action, ...uiExpectation(step, path),
        timeoutMs: waitTimeout(step["timeoutMs"], `${path}.timeoutMs`) };
    }
    throw new TypeError(`${path}.action is not a supported journey step.`);
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

type JourneyPage = ReturnType<PlaywrightWebDriver["getPage"]>;

/** Never include a browser URL in errors: it may contain session tokens. */
function sameOriginLocation(page: JourneyPage, origin: string): URL {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    throw new Error("The journey's browser location is unavailable.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== "" || url.origin !== origin) {
    throw new Error("The journey left its original HTTP(S) origin.");
  }
  return url;
}

function routeMatches(page: JourneyPage, origin: string, path: string): boolean {
  const url = sameOriginLocation(page, origin);
  // A matching pathname with an unreviewed query/fragment is NOT the same
  // state, and queries may contain credentials that must never be reported.
  return url.pathname === path && url.search === "" && url.hash === "";
}

async function uiMatches(page: JourneyPage, step: UiStep): Promise<boolean> {
  let count: number;
  let visible = false;
  try {
    const locator = page.getByRole(step.role, {
      name: step.name, exact: true, includeHidden: true,
    });
    count = await locator.count();
    if (count === 1) visible = await locator.isVisible();
  } catch {
    // Playwright locator errors can contain private page content.
    throw new Error("The journey UI state could not be inspected safely.");
  }
  if (count > 1) throw new Error("The journey UI state is ambiguous: multiple matching elements.");
  if (count === 0) return step.state === "hidden";
  return step.state === "visible" ? visible : !visible;
}

async function waitForStableCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  assertActive: () => void,
): Promise<void> {
  const end = performance.now() + timeoutMs;
  let consecutive = 0;
  while (performance.now() < end) {
    assertActive();
    if (await condition()) {
      consecutive += 1;
      if (consecutive >= 2) return;
    } else {
      consecutive = 0;
    }
    const remaining = end - performance.now();
    if (remaining <= WAIT_STABILITY_INTERVAL_MS) break;
    // Poll for an explicit observable condition, never claim readiness from
    // elapsed time alone. Two observations must agree.
    await new Promise<void>((done) => setTimeout(done, WAIT_STABILITY_INTERVAL_MS));
  }
  throw new Error("The journey did not reach a stable expected state within its wait budget.");
}

async function navigateSameOrigin(
  page: JourneyPage,
  origin: string,
  path: string,
  timeoutMs: number,
  assertActive: () => void,
): Promise<void> {
  const url = new URL(path, origin);
  // Playwright's network routing does not intercept requests already handled
  // by service workers. Refuse to claim mutation-safe navigation in such a
  // context rather than relying on a bypassable request guard.
  const serviceWorkerFree = (): boolean => {
    try { return page.context().serviceWorkers().length === 0; }
    catch { return false; }
  };
  let blocked = false;
  const guard: Parameters<JourneyPage["route"]>[1] = async (route) => {
    const request = route.request();
    let permitted: boolean;
    try {
      const requestedUrl = new URL(request.url());
      permitted = request.method() === "GET"
        && (requestedUrl.protocol === "http:" || requestedUrl.protocol === "https:")
        && (!request.isNavigationRequest() || requestedUrl.origin === origin);
    } catch {
      permitted = false;
    }
    if (!permitted) {
      blocked = true;
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  };
  let installed = false;
  let cleanupFailed = false;
  let navigationFailed = false;
  try {
    if (!serviceWorkerFree()) {
      throw new Error("Service-worker-controlled navigation cannot be guarded safely.");
    }
    await page.route("**/*", guard);
    installed = true;
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    assertActive();
    if (blocked) throw new Error("The journey route attempted a mutating or cross-origin request.");
    await waitForStableCondition(() => Promise.resolve(routeMatches(page, origin, path)),
      Math.min(timeoutMs, 2_000), assertActive);
    if (blocked || !serviceWorkerFree()) {
      throw new Error("The journey route attempted an unguarded or mutating request.");
    }
  } catch {
    // Playwright exceptions can contain a URL, a request body or credentials.
    navigationFailed = true;
  } finally {
    if (installed) {
      try { await page.unroute("**/*", guard); }
      catch { cleanupFailed = true; }
    }
  }
  if (cleanupFailed) {
    // The listener must not be left intercepting unrelated app requests.
    throw new Error("The journey could not safely remove its route guard.");
  }
  if (navigationFailed) {
    throw new Error("The journey's safe same-origin route navigation did not complete.");
  }
}

export async function executeJourney(
  driver: PlaywrightWebDriver,
  journey: JourneyV1,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<JourneyExecutionResult> {
  const secrets = new Map<string, string>();
  const maxActions = journey.steps.reduce(
    (total, step) => total + (step.action === "press" ? step.repeat
      : step.action === "type-from-env" || step.action === "navigate-route" ? 1 : 0),
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
  const stateful = journey.steps.some((step) => step.action === "expect-route"
    || step.action === "navigate-route" || step.action === "expect-ui"
    || step.action === "wait-for-route" || step.action === "wait-for-ui");
  const page = stateful ? driver.getPage() : null;
  let origin: string | null = null;
  let assertedRoute: string | null = null;
  if (page !== null) {
    let location: URL;
    try { location = new URL(page.url()); }
    catch { throw new Error("The journey cannot establish its original browser origin."); }
    if ((location.protocol !== "http:" && location.protocol !== "https:")
      || location.username !== "" || location.password !== "") {
      throw new Error("The journey must begin at an HTTP(S) URL without embedded credentials.");
    }
    origin = location.origin;
  }
  const assertActive = (): void => {
    if (signal?.aborted === true) throw new Error("The custom journey was interrupted.");
    if (performance.now() >= deadline) throw new Error("The custom journey exceeded its duration budget.");
  };
  for (const step of journey.steps) {
    assertActive();
    if (page !== null && origin !== null) sameOriginLocation(page, origin);
    if (step.action === "press") {
      for (let repeat = 0; repeat < step.repeat; repeat += 1) {
        assertActive();
        let result: Awaited<ReturnType<PlaywrightWebDriver["press"]>>;
        try { result = await driver.press(step.key); }
        catch { throw new Error("The journey could not dispatch a remote key."); }
        actions += 1;
        if (result.outcome !== "applied") {
          throw new Error(`Journey remote key ${step.key} was ${result.outcome}.`);
        }
      }
    } else if (step.action === "type-from-env") {
      const secret = secrets.get(step.env);
      if (secret === undefined) throw new TypeError(`${step.env} was unavailable.`);
      try { await driver.getPage().keyboard.insertText(secret); }
      catch { throw new Error("The journey could not input its private environment value."); }
      actions += 1;
    } else if (step.action === "expect-focus") {
      let snapshot: StateSnapshot;
      try { snapshot = await driver.snapshot(); }
      catch { throw new Error("The journey could not inspect its focus target."); }
      snapshots += 1;
      if (!focusedMatches(snapshot, step)) {
        throw new Error("The custom journey did not reach its expected focus target.");
      }
    } else if (page !== null && origin !== null) {
      if (step.action === "expect-route") {
        if (!routeMatches(page, origin, step.path)) {
          throw new Error("The journey's current route does not match its declared pathname.");
        }
        assertedRoute = step.path;
      } else if (step.action === "navigate-route") {
        await navigateSameOrigin(page, origin, step.path,
          Math.max(1, Math.min(MAX_JOURNEY_WAIT_MS, deadline - performance.now())), assertActive);
        actions += 1;
        assertedRoute = step.path;
      } else if (step.action === "wait-for-route") {
        await waitForStableCondition(() => Promise.resolve(routeMatches(page, origin, step.path)),
          Math.min(step.timeoutMs, Math.max(1, deadline - performance.now())), assertActive);
        assertedRoute = step.path;
      } else {
        if (assertedRoute !== null && !routeMatches(page, origin, assertedRoute)) {
          throw new Error("The journey's UI assertion is on an unexpected route.");
        }
        if (step.action === "expect-ui") {
          if (!await uiMatches(page, step)) {
            throw new Error("The journey UI state does not match its declared condition.");
          }
        } else {
          await waitForStableCondition(async () => {
            if (assertedRoute !== null && !routeMatches(page, origin, assertedRoute)) {
              throw new Error("The journey changed routes while waiting for UI state.");
            }
            return await uiMatches(page, step);
          }, Math.min(step.timeoutMs, Math.max(1, deadline - performance.now())), assertActive);
        }
      }
    }
    if (page !== null && origin !== null) sameOriginLocation(page, origin);
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
