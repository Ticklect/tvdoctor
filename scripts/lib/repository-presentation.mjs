import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { parseFragment } from 'parse5';
import { SaxesParser } from 'saxes';

const markdownParser = new MarkdownIt({ html: true });

export function extractLocalReferences(markdown) {
  // Render CommonMark first, so reference links, escaped/angle destinations,
  // and HTML badges share one tree. Code and comments have no link nodes.
  const document = parseFragment(markdownParser.render(markdown));
  const targets = [];
  const visit = (node) => {
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === 'href' || attribute.name === 'src') targets.push(attribute.value);
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  return targets.filter((target) => !/^(?:https?:|mailto:|tel:|data:|#|\/\/)/iu.test(target));
}

export function validateLocalReferences(markdownPath, markdown, exists, repositoryRoot = process.cwd()) {
  const root = path.resolve(repositoryRoot);
  const base = path.dirname(path.resolve(root, markdownPath));
  const contained = (candidate) => {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const errors = [];
  for (const rawTarget of extractLocalReferences(markdown)) {
    let target;
    try {
      target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
    } catch {
      errors.push(`${markdownPath}: invalid local reference ${rawTarget}`);
      continue;
    }
    target = target.replaceAll('\\', '/');
    const resolved = path.resolve(base, target);
    if (/^(?:\/|[a-z]:|file:)/iu.test(target) || !contained(resolved)
      || (existsSync(resolved) && !contained(realpathSync(resolved)))) {
      errors.push(`${markdownPath}: local reference outside repository ${target}`);
      continue;
    }
    if (!exists(resolved)) {
      errors.push(`${markdownPath}: missing local reference ${target}`);
    }
  }
  return errors;
}

export function validateSvg(svgPath, svg) {
  const errors = [];
  const parser = new SaxesParser({ xmlns: true });
  const elements = [];
  const stack = [];
  const ids = new Set();
  const attribute = (element, name) => element?.attributes[name]?.value;
  parser.on('opentag', (node) => {
    const element = { ...node, depth: stack.length, text: '' };
    const id = attribute(element, 'id');
    if (id && ids.has(id)) errors.push(`${svgPath}: duplicate id ${id}`);
    if (id) ids.add(id);
    elements.push(element); stack.push(element);
    if (node.local.toLowerCase() === 'script') errors.push(`${svgPath}: script elements are forbidden`);
  });
  const text = (value) => { for (const element of stack) element.text += value; };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  parser.on('doctype', () => { errors.push(`${svgPath}: doctypes are forbidden`); });
  try { parser.write(svg).close(); }
  catch { return [...errors, `${svgPath}: malformed XML`]; }
  const root = elements[0];
  if (root?.local !== 'svg' || root.uri !== 'http://www.w3.org/2000/svg') errors.push(`${svgPath}: missing svg root`);
  const viewBox = attribute(root, 'viewBox');
  if (!viewBox) errors.push(`${svgPath}: missing viewBox`);
  else {
    const dimensions = viewBox.trim().split(/[\s,]+/u).map(Number);
    if (dimensions.length !== 4 || !dimensions.every(Number.isFinite) || dimensions[2] <= 0 || dimensions[3] <= 0) {
      errors.push(`${svgPath}: invalid viewBox`);
    }
  }
  const labelIds = (attribute(root, 'aria-labelledby') ?? '').trim().split(/\s+/u);
  const descriptionIds = [...labelIds, ...(attribute(root, 'aria-describedby') ?? '').trim().split(/\s+/u)];
  for (const [tag, label, linkedIds] of [['title', 'title', labelIds], ['desc', 'description', descriptionIds]]) {
    const element = elements.find((node) => node.depth === 1 && node.local === tag && node.uri === root?.uri && node.text.trim());
    if (!element) errors.push(`${svgPath}: missing ${label}`);
    else if (!attribute(element, 'id') || !linkedIds.includes(attribute(element, 'id'))) {
      errors.push(`${svgPath}: ${label} must be linked from the svg root by accessibility ID`);
    }
  }
  for (const id of descriptionIds.filter(Boolean)) {
    if (!ids.has(id)) errors.push(`${svgPath}: unresolved accessibility ID ${id}`);
  }
  return errors;
}
