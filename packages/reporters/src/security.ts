const DEFAULT_MAX_TEXT_LENGTH = 4_000;

function redactUrl(candidate: string): string {
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

/** Bounded defence-in-depth redaction for all target-controlled report text. */
export function sanitiseUntrustedText(
  text: string,
  maxLength: number = DEFAULT_MAX_TEXT_LENGTH,
): string {
  const withoutControlCharacters = Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
  const withoutBearerTokens = withoutControlCharacters.replace(
    /\bBearer\s+[^\s,;]+/giu,
    "Bearer [REDACTED]",
  );
  const withoutBasicCredentials = withoutBearerTokens.replace(
    /\bBasic\s+[A-Za-z0-9+/_=.:-]+/giu,
    "Basic [REDACTED]",
  );
  const withoutNamedSecrets = withoutBasicCredentials.replace(
    /(["']?)([A-Za-z0-9_-]*(?:api[-_ ]?key|authorization|cookie|password|secret|session|token)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/giu,
    (_match, quote: string, key: string, separator: string) => (
      `${quote}${key}${quote}${separator}${quote}[REDACTED]${quote}`
    ),
  );
  const withoutSensitiveUrls = withoutNamedSecrets.replace(
    /https?:\/\/[^\s<>"']+/giu,
    (match) => redactUrl(match),
  );
  return withoutSensitiveUrls.slice(0, Math.max(0, maxLength));
}

export function sanitiseTargetLocation(location: string): string {
  return sanitiseUntrustedText(redactUrl(location));
}

export function escapeHtml(text: string): string {
  return sanitiseUntrustedText(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Render target data as an inert indented Markdown code block. */
export function markdownDataBlock(text: string): string {
  const safe = sanitiseUntrustedText(text);
  const lines = safe.length === 0 ? ["(empty)"] : safe.split("\n");
  return lines.map((line) => `    ${line}`).join("\n");
}

export function isSensitiveEnvironmentKey(key: string): boolean {
  return /(?:api[-_ ]?key|authorization|cookie|password|secret|session|token)/iu.test(key);
}
