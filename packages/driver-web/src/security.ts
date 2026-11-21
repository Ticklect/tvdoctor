import { createHash } from "node:crypto";

const MAX_OBSERVATION_TEXT_LENGTH = 2_000;
const MAX_ROUTE_SELECTORS = 12;
const OVERFLOW_HASH_MASK = (1n << 256n) - 1n;
const NAVIGATION_SELECTOR_KEYS = new Set([
  "route", "view", "screen", "tab", "panel", "section", "mode", "page", "step",
  "id", "item", "video", "title", "episode", "routevariant", "content",
]);

/** Fixed-size, opaque route token. The underscore avoids fingerprint normalisation of bare hex IDs. */
function routeToken(value: string): string {
  return `r_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function routeSelectors(query: URLSearchParams): string {
  // Streaming equivalent of sorting every allowlisted (name, hashed value)
  // pair and selecting the first twelve. The output and memory remain bounded
  // even when a URL contains thousands of route selectors.
  const selected: string[] = [];
  let overflowCount = 0;
  let overflowSum = 0n;
  const recordOverflow = (selector: string): void => {
    // A commutative digest of *all* displaced selectors, including duplicates,
    // avoids false route changes when query pairs are reordered. Hashing the
    // canonical selector preserves distinctions at the end of long values.
    const hash = createHash("sha256").update(selector).digest("hex");
    overflowSum = (overflowSum + BigInt(`0x${hash}`)) & OVERFLOW_HASH_MASK;
    overflowCount += 1;
  };
  for (const [rawName, value] of query) {
    const name = rawName.trim().toLowerCase();
    if (!NAVIGATION_SELECTOR_KEYS.has(name) || value.trim().length === 0) continue;
    const selector = `${name}=${routeToken(value)}`;
    let insertionIndex = 0;
    while (insertionIndex < selected.length) {
      const current = selected[insertionIndex];
      if (current === undefined || current > selector) break;
      insertionIndex += 1;
    }
    if (insertionIndex === MAX_ROUTE_SELECTORS) {
      recordOverflow(selector);
      continue;
    }
    selected.splice(insertionIndex, 0, selector);
    if (selected.length > MAX_ROUTE_SELECTORS) {
      const displaced = selected.pop();
      if (displaced !== undefined) recordOverflow(displaced);
    }
  }
  if (overflowCount > 0) {
    selected.push(`route=${routeToken(`overflow:${overflowCount}:${overflowSum.toString(16).padStart(64, "0")}`)}`);
  }
  return selected.join("&");
}

function redactUrlMatch(candidate: string): string {
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return candidate;
  }
}

/**
 * URLs are retained only as origin/path metadata. Credentials, query strings,
 * and fragments are deliberately excluded from driver observations.
 */
export function sanitiseUrl(candidate: string): string {
  return redactUrlMatch(candidate);
}

/**
 * Snapshot-only route identity. The URL remains parseable by the navigation
 * fingerprinter, but path, query *values*, fragment route and hash-query values
 * are represented only by stable hashes. Unknown/tracking keys and ordinary
 * #anchors are excluded; console/network URLs retain stricter sanitiseUrl().
 */
export function sanitiseSnapshotUrl(candidate: string): string {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "about:invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return url.protocol === "about:" && url.pathname === "blank" ? "about:blank" : "about:opaque";
  }

  const query = routeSelectors(url.searchParams);
  const fragment = url.hash.slice(1).replace(/^!/u, "");
  const hashQueryStart = fragment.indexOf("?");
  const hashPath = hashQueryStart < 0 ? fragment : fragment.slice(0, hashQueryStart);
  const hashSelectors = hashQueryStart < 0
    ? ""
    : routeSelectors(new URLSearchParams(fragment.slice(hashQueryStart + 1)));
  // Route fragments are path-shaped in SPA routers. A non-route #anchor is volatile.
  const hashRoute = hashPath.startsWith("/")
    ? `#/${routeToken(hashPath)}${hashSelectors === "" ? "" : `?${hashSelectors}`}`
    : (() => {
      const fragmentSelectors = routeSelectors(new URLSearchParams(fragment));
      return fragmentSelectors === "" ? "" : `#${fragmentSelectors}`;
    })();

  const origin = url.origin;
  const path = url.pathname === "/" ? "/" : `/__tvroute/${routeToken(url.pathname)}`;
  return `${origin}${path}${query === "" ? "" : `?${query}`}${hashRoute}`;
}

/** Keep untrusted page output bounded and remove common credential shapes. */
export function sanitiseObservedText(text: string): string {
  const withoutBearerTokens = text.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");
  const withoutNamedSecrets = withoutBearerTokens.replace(
    /\b(api[-_ ]?key|authorization|password|secret|token)\b\s*[:=]\s*[^\s,;]+/giu,
    "$1=[REDACTED]",
  );
  const withoutSensitiveUrls = withoutNamedSecrets.replace(
    /https?:\/\/[^\s<>"']+/giu,
    (match) => redactUrlMatch(match),
  );
  return withoutSensitiveUrls.slice(0, MAX_OBSERVATION_TEXT_LENGTH);
}
