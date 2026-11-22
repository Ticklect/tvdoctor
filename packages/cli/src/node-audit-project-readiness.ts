import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";

/**
 * A developer-authored, route-specific proof of visible protected content.
 *
 * The configured accessible name is a private input: neither it nor the
 * browser's location or application-authored errors enter the result.
 */
export interface ProjectAuthReadyAssertion {
  readonly expectedUrl: string;
  readonly role: "heading" | "region" | "button";
  readonly name: string;
  /** Only from a validated, exact-route, explicit authored journey wait. */
  readonly authoredWaitMs?: number;
}

/** Minimal Playwright surface so the guard can be tested without a browser. */
export type ProjectAuthReadyPage =
  Pick<ReturnType<PlaywrightWebDriver["getPage"]>, "url" | "getByRole">;

const ROLE_SET: ReadonlySet<string> = new Set(["heading", "region", "button"]);
const OBSERVATION_INTERVAL_MS = 150;
const MAX_HYDRATION_WAIT_MS = 2_000;
const MAX_AUTHORED_WAIT_MS = 30_000;

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128
    && value.trim() === value
    // Reject controls, bidi overrides, invisible direction/format marks and
    // line breaks in developer-authored assertions.
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function canonicalTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048
    || value.trim() !== value || value.includes("\0")) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username !== "" || parsed.password !== ""
      || parsed.search !== "" || parsed.hash !== ""
      || parsed.href !== value) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * A passing URL check is not sufficient to prove an authenticated page was
 * reached: SPAs and framework rewrites can render an access-denied/login shell
 * under the original path. Require an explicit, UNIQUE, VISIBLE accessible
 * landmark on that exact URL in two distinct observations. Frameworks often
 * render their protected route after an asynchronous fetch, so a marker that
 * is initially absent may appear within a bounded hydration window.
 *
 * Call this function after the journey, after startup preparation and again
 * after EVERY browser state restoration. A previous true result is never
 * reusable as proof of a later restored page.
 *
 * Missing or temporarily hidden markers can become ready within two seconds,
 * or within the exact matching authorised journey's bounded authored wait.
 * Ambiguous markers, a changed route, or a marker that disappears after an
 * initial positive observation fail immediately. A timeout is INCONCLUSIVE,
 * never evidence of authenticated success.
 * Returns only a boolean; app-authored exceptions and private values are
 * deliberately swallowed, without logging or exposing a diagnostic string.
 */
export async function validateProjectAuthReady(
  page: ProjectAuthReadyPage,
  assertion: ProjectAuthReadyAssertion,
): Promise<boolean> {
  try {
    if (assertion === null || typeof assertion !== "object"
      || !ROLE_SET.has(assertion.role) || !validName(assertion.name)) return false;
    if (assertion.authoredWaitMs !== undefined
      && (!Number.isSafeInteger(assertion.authoredWaitMs)
        || assertion.authoredWaitMs < MAX_HYDRATION_WAIT_MS
        || assertion.authoredWaitMs > MAX_AUTHORED_WAIT_MS)) return false;
    const expectedUrl = canonicalTarget(assertion.expectedUrl);
    if (expectedUrl === null || typeof page?.url !== "function"
      || typeof page?.getByRole !== "function") return false;

    const observe = async (): Promise<"ready" | "pending" | "invalid"> => {
      if (page.url() !== expectedUrl) return "invalid";
      const locator = page.getByRole(assertion.role, {
        name: assertion.name, exact: true, includeHidden: true,
      });
      const count = await locator.count();
      if (count > 1 || count < 0 || !Number.isSafeInteger(count)) return "invalid";
      const visible = count === 1 && await locator.isVisible();
      if (page.url() !== expectedUrl) return "invalid";
      return visible ? "ready" : "pending";
    };

    const deadline = Date.now() + (assertion.authoredWaitMs ?? MAX_HYDRATION_WAIT_MS);
    let previouslyReady = false;
    while (Date.now() <= deadline) {
      const result = await observe();
      if (result === "invalid") return false;
      if (result === "ready" && previouslyReady) return true;
      if (result === "pending" && previouslyReady) return false;
      previouslyReady = result === "ready";
      const remaining = deadline - Date.now();
      if (remaining < OBSERVATION_INTERVAL_MS) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, OBSERVATION_INTERVAL_MS));
    }
    return false;
  } catch {
    // Errors may carry session tokens, DOM text, paths or selectors. Even a
    // successful first observation must fail closed on any later exception.
    return false;
  }
}
