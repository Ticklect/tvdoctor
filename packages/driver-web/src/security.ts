const MAX_OBSERVATION_TEXT_LENGTH = 2_000;

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
