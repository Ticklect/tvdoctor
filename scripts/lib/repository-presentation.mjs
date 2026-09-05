import path from 'node:path';

const MARKDOWN_REFERENCE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export function extractLocalReferences(markdown) {
  return [...markdown.matchAll(MARKDOWN_REFERENCE)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:|#)/i.test(target));
}

export function validateLocalReferences(markdownPath, markdown, exists) {
  const base = path.dirname(markdownPath);
  const errors = [];
  for (const rawTarget of extractLocalReferences(markdown)) {
    let target;
    try {
      target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
    } catch {
      target = rawTarget.split(/[?#]/, 1)[0];
    }
    const resolved = path.normalize(path.join(base, target));
    if (!exists(resolved)) {
      errors.push(`${markdownPath}: missing local reference ${target}`);
    }
  }
  return errors;
}

export function validateSvg(svgPath, svg) {
  const errors = [];
  if (!/<svg\b/i.test(svg)) errors.push(`${svgPath}: missing svg root`);
  if (!/\bviewBox=["'][^"']+["']/i.test(svg)) errors.push(`${svgPath}: missing viewBox`);
  if (!/<title\b[^>]*>[^<]+<\/title>/i.test(svg)) errors.push(`${svgPath}: missing title`);
  if (!/<desc\b[^>]*>[^<]+<\/desc>/i.test(svg)) errors.push(`${svgPath}: missing description`);
  if (/<script\b/i.test(svg)) errors.push(`${svgPath}: script elements are forbidden`);
  return errors;
}
