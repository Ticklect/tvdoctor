import { stripVTControlCharacters } from "node:util";

const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const BIDI_CONTROL_TEST_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const DISPLAY_URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

function stripUrlSuffix(value: string): { readonly suffix: string; readonly url: string } {
  const match = /[),.;:!?]+$/u.exec(value);
  if (match === null) return { suffix: "", url: value };
  return { suffix: match[0], url: value.slice(0, -match[0].length) };
}

export function safeDisplayUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "[URL]";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "[invalid URL]";
  }
}

function redactDisplayUrls(value: string): string {
  return value.replace(DISPLAY_URL_PATTERN, (candidate) => {
    const { suffix, url } = stripUrlSuffix(candidate);
    return `${safeDisplayUrl(url)}${suffix}`;
  });
}

export interface TerminalSanitizerOptions {
  readonly maximumLength?: number;
  readonly preserveNewlines?: boolean;
}

/** Sanitise all untrusted text before it crosses the terminal boundary. */
export function sanitizeTerminalText(
  value: string,
  options: TerminalSanitizerOptions = {},
): string {
  const maximumLength = options.maximumLength ?? 2_048;
  const preserveNewlines = options.preserveNewlines ?? false;
  const withoutSequences = stripVTControlCharacters(value).replace(BIDI_CONTROL_PATTERN, "");
  let printable = "";

  for (const character of withoutSequences) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (preserveNewlines && codePoint === 10) {
      printable += "\n";
      continue;
    }
    if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
      || codePoint === 0x2028 || codePoint === 0x2029) {
      printable += " ";
      continue;
    }
    printable += character;
  }

  const redacted = redactDisplayUrls(printable);
  const normalised = preserveNewlines
    ? redacted
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim()
    : redacted.replace(/\s+/gu, " ").trim();
  return [...normalised].slice(0, maximumLength).join("");
}

export function isSafeTerminalArgument(value: string, maximumLength = 4_096): boolean {
  if ([...value].length > maximumLength) return false;
  return stripVTControlCharacters(value) === value
    && !BIDI_CONTROL_TEST_PATTERN.test(value)
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
        || codePoint === 0x2028 || codePoint === 0x2029;
    });
}
