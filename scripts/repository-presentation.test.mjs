import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import {
  extractLocalReferences,
  validateLocalReferences,
  validateSvg,
} from './lib/repository-presentation.mjs';

test('root lint ignores nested git worktrees', async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const eslint = new ESLint({ cwd: repositoryRoot });
  assert.equal(
    await eslint.isPathIgnored(path.join(repositoryRoot, '.worktrees', 'example', 'src', 'bad.ts')),
    true,
  );
});

test('extractLocalReferences keeps repository files and ignores remote and anchor links', () => {
  const markdown = '[docs](docs/demo.md) ![hero](docs/assets/hero.svg) [web](https://example.com) [section](#demo)';
  assert.deepEqual(extractLocalReferences(markdown), [
    'docs/demo.md',
    'docs/assets/hero.svg',
  ]);
});

test('validateLocalReferences reports decoded missing files without URL fragments', () => {
  const errors = validateLocalReferences(
    'README.md',
    '[ok](docs/demo.md#run) [missing](docs/My%20Guide.md)',
    (path) => path.replaceAll('\\', '/').endsWith('docs/demo.md'),
  );
  assert.deepEqual(errors, ['README.md: missing local reference docs/My Guide.md']);
});

test('validateLocalReferences reports an empty linked repository document', () => {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), 'tvdoctor-presentation-'));
  try {
    writeFileSync(path.join(repositoryRoot, 'empty.md'), '');
    assert.deepEqual(
      validateLocalReferences('README.md', '[empty](empty.md)', () => true, repositoryRoot),
      ['README.md: empty local reference empty.md'],
    );
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('validateSvg requires a viewBox, title, description, and forbids scripts', () => {
  assert.deepEqual(validateSvg('hero.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-labelledby="t d"><title id="t">x</title><desc id="d">y</desc></svg>'), []);
  const errors = validateSvg('bad.svg', '<svg><script>alert(1)</script></svg>').join('\n');
  assert.match(errors, /missing viewBox/u);
  assert.match(errors, /missing title/u);
  assert.match(errors, /missing description/u);
  assert.match(errors, /script elements are forbidden/u);
});

test('reads HTML badge links and image sources, including entities and unquoted targets', () => {
  assert.deepEqual(extractLocalReferences('<a href="LICENSE"><img src=docs/badge.svg></a> <img src="docs/a&amp;b.svg">'),
    ['LICENSE', 'docs/badge.svg', 'docs/a&b.svg']);
});

test('reads reference-style and angle-bracket Markdown destinations', () => {
  assert.deepEqual(extractLocalReferences('[guide][g] ![logo][] [angle](<docs/My Guide.md>)\n\n[g]: docs/guide.md\n[logo]: docs/logo.svg'),
    ['docs/guide.md', 'docs/logo.svg', 'docs/My%20Guide.md']);
});

test('ignores links inside code and HTML comments', () => {
  assert.deepEqual(extractLocalReferences('`[fake](missing.md)`\n\n```md\n[fake](missing.md)\n```\n<!-- <img src="missing.svg"> -->'), []);
});

for (const target of ['../outside.md', '%2e%2e/outside.md', '/outside.md', 'C:/outside.md', '..\\outside.md']) {
  test(`rejects repository escape ${target} even when the target exists`, () => {
    const errors = validateLocalReferences('README.md', `<a href="${target}">outside</a>`, () => true);
    assert.match(errors.join('\n'), /outside repository/u);
  });
}

const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-labelledby="t d"><title id="t">Title</title><desc id="d">Description</desc></svg>';
for (const [name, svg, error] of [
  ['malformed XML', validSvg.replace('</svg>', '</g>'), /malformed XML/u],
  ['comment-only SVG', `<!-- ${validSvg} -->`, /malformed XML|missing svg root/u],
  ['nested viewBox', validSvg.replace(' viewBox="0 0 10 10"', '').replace('</svg>', '<g viewBox="0 0 10 10"/></svg>'), /missing viewBox/u],
  ['invalid root dimensions', validSvg.replace('0 0 10 10', '0 0 -10 0'), /invalid viewBox/u],
  ['unlinked title', validSvg.replace('aria-labelledby="t d"', 'aria-labelledby="missing d"'), /title.*linked/u],
  ['unlinked description', validSvg.replace('aria-labelledby="t d"', 'aria-labelledby="t missing"'), /description.*linked/u],
  ['duplicate accessibility ID', validSvg.replace('id="d"', 'id="t"'), /duplicate id/u],
  ['comment-only title', validSvg.replace('<title id="t">Title</title>', '<!-- <title id="t">Title</title> -->'), /missing title/u],
]) {
  test(`rejects ${name}`, () => assert.match(validateSvg('hero.svg', svg).join('\n'), error));
}
