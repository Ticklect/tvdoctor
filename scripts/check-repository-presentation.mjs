import { existsSync, readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { validateLocalReferences, validateSvg } from './lib/repository-presentation.mjs';

const errors = [];
const readmePath = 'README.md';
const readme = readFileSync(readmePath, 'utf8');
errors.push(...validateLocalReferences(readmePath, readme, existsSync));

const expectedLicense = 'AGPL-3.0-only';
const rootLicense = readFileSync('LICENSE', 'utf8');
const manifestPaths = [
  'package.json',
  ...globSync('fixtures/*/package.json'),
  ...globSync('packages/*/package.json'),
];
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.license !== expectedLicense) {
    errors.push(`${manifestPath}: expected licence ${expectedLicense}`);
  }
}

for (const packageLicensePath of globSync('packages/*/LICENSE')) {
  if (readFileSync(packageLicensePath, 'utf8') !== rootLicense) {
    errors.push(`${packageLicensePath}: package licence differs from root LICENSE`);
  }
}

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
