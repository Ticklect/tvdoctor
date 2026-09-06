import { existsSync, readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { validateLocalReferences, validateSvg } from './lib/repository-presentation.mjs';

const errors = [];
const readmePath = 'README.md';
const readme = readFileSync(readmePath, 'utf8');
errors.push(...validateLocalReferences(readmePath, readme, existsSync));

const svgPaths = globSync('docs/assets/**/*.svg');
for (const svgPath of svgPaths) {
  errors.push(...validateSvg(svgPath, readFileSync(svgPath, 'utf8')));
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log('repository presentation: PASS');
}
