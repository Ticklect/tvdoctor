import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLocalReferences,
  validateLocalReferences,
  validateSvg,
} from './lib/repository-presentation.mjs';

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

test('validateSvg requires a viewBox, title, description, and forbids scripts', () => {
  assert.deepEqual(validateSvg('hero.svg', '<svg viewBox="0 0 10 10"><title>x</title><desc>y</desc></svg>'), []);
  assert.deepEqual(validateSvg('bad.svg', '<svg><script>alert(1)</script></svg>'), [
    'bad.svg: missing viewBox',
    'bad.svg: missing title',
    'bad.svg: missing description',
    'bad.svg: script elements are forbidden',
  ]);
});
