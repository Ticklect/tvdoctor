import { stripVTControlCharacters } from "node:util";

const DEFAULT_MAX_TEXT_LENGTH = 4_000;

const BIDI_FORMAT_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

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

function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/giu, (match) => {
    const trailing = match.match(/[),.;!?\]}]+$/u)?.[0] ?? "";
    const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
    return `${redactUrl(candidate)}${trailing}`;
  });
}

/** Bounded defence-in-depth redaction for all target-controlled report text. */
export function sanitiseUntrustedText(
  text: string,
  maxLength: number = DEFAULT_MAX_TEXT_LENGTH,
): string {
  // Remove complete terminal escape sequences before filtering individual
  // controls; removing ESC alone would leave visible CSI/OSC payload fragments.
  const withoutTerminalSequences = stripVTControlCharacters(text);
  const withoutControlCharacters = Array.from(withoutTerminalSequences)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || (code >= 32 && code !== 127 && !(code >= 128 && code <= 159));
    })
    .join("")
    .replace(BIDI_FORMAT_CONTROLS, "");
  const withoutSensitiveUrls = redactUrls(withoutControlCharacters);
  const withoutSensitiveHeaders = withoutSensitiveUrls.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)(\s*:\s*)[^\n]*/giu,
    (_match, header: string, separator: string) => `${header}${separator}[REDACTED]`,
  );
  const withoutBearerTokens = withoutSensitiveHeaders.replace(
    /\bBearer\s+[^\s,;]+/giu,
    "Bearer [REDACTED]",
  );
  const withoutBasicCredentials = withoutBearerTokens.replace(
    /\bBasic\s+[A-Za-z0-9+/_=.:-]+/giu,
    "Basic [REDACTED]",
  );
  const withoutNamedSecrets = withoutBasicCredentials.replace(
    /(["']?)([A-Za-z0-9_-]*(?:(?:api|access|refresh|auth)[-_ ]?(?:key|token)|authorization|cookie|password|passwd|secret|session(?:[-_ ]?(?:id|key|token))?|token)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/giu,
    (_match, quote: string, key: string, separator: string) => (
      `${quote}${key}${quote}${separator}${quote}[REDACTED]${quote}`
    ),
  );
  return Array.from(withoutNamedSecrets).slice(0, Math.max(0, maxLength)).join("");
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
