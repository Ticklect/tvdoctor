# TVDoctor 0.1.0 Release and Repository Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a distinctive, honest, private TVDoctor `0.1.0` release candidate and prove its exact commit locally and in GitHub Actions without publishing or tagging it.

**Architecture:** Keep presentation assets under `docs/assets`, make `README.md` the polished product entry point, and add a dependency-free Node validation utility that prevents broken local links or malformed SVG assets from entering the release gate. Preserve the existing release, security, compatibility, and evidence boundaries, then promote one immutable commit through the local and hosted gates.

**Tech Stack:** Markdown, SVG 1.1-compatible markup, Node.js 24 ESM, Node's built-in test runner, npm 11 workspaces, Git, GitHub Actions, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-09-05-release-repository-polish-design.md`

## Global Constraints

- The GitHub repository remains private until the owner explicitly says otherwise.
- No package is published and no release tag is created during this work.
- The intended package version remains `0.1.0`.
- Existing Beta, Experimental, and Planned boundaries remain explicit.
- Release evidence is tied to one immutable commit SHA.
- Artwork is code-native SVG; no generated report, target screenshot, trace, or transient evidence is tracked.
- No npm badge or copy may imply registry publication before publication is verified.

## File map

- Create `scripts/lib/repository-presentation.mjs`: pure Markdown-reference and SVG validation functions.
- Create `scripts/check-repository-presentation.mjs`: CLI entry point that validates repository presentation files.
- Create `scripts/repository-presentation.test.mjs`: dependency-free unit tests for the validator.
- Modify `package.json`: expose `test:presentation` and include it in `check`.
- Create `docs/assets/tvdoctor-hero.svg`: wide, theme-aware README hero.
- Create `docs/assets/tvdoctor-social-preview.svg`: fixed 1280×640 social preview source.
- Modify `README.md`: branded product opening and improved information hierarchy while preserving technical reference material.
- Modify `.github/PULL_REQUEST_TEMPLATE.md`: tighten presentation/link and release-candidate checks.
- Modify `.github/ISSUE_TEMPLATE/config.yml`: add private security-reporting contact guidance when the repository supports it.
- Review `.github/ISSUE_TEMPLATE/*.yml`, `CHANGELOG.md`, `SECURITY.md`, and `RELEASE.md`; change only inaccurate or inconsistent wording discovered during implementation.

---

### Task 1: Automated repository-presentation validation

**Files:**
- Create: `scripts/lib/repository-presentation.mjs`
- Create: `scripts/check-repository-presentation.mjs`
- Create: `scripts/repository-presentation.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `extractLocalReferences(markdown: string): string[]`
- Produces: `validateLocalReferences(markdownPath: string, markdown: string, exists: (path: string) => boolean): string[]`
- Produces: `validateSvg(svgPath: string, svg: string): string[]`
- Produces: CLI command `npm run test:presentation`

- [ ] **Step 1: Write unit tests for local Markdown references and SVG requirements**

Create `scripts/repository-presentation.test.mjs` with Node's `node:test` and
`node:assert/strict`. Cover these exact cases:

```js
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
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `node --test scripts/repository-presentation.test.mjs`

Expected: FAIL because `scripts/lib/repository-presentation.mjs` does not exist.

- [ ] **Step 3: Implement the pure validator functions**

Create `scripts/lib/repository-presentation.mjs`. Use one Markdown image/link regex,
discard `http:`, `https:`, `mailto:`, and `#` targets, remove query/fragment suffixes,
decode percent escapes, and resolve paths relative to the Markdown file. Return errors
instead of throwing so the CLI can print every problem in one run. `validateSvg` must
check `<svg`, `viewBox`, `<title>`, `<desc>`, and absence of `<script` case-insensitively.

```js
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
    const target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
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
```

- [ ] **Step 4: Run the unit test and correct only implementation defects**

Run: `node --test scripts/repository-presentation.test.mjs`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Implement the repository CLI validator**

Create `scripts/check-repository-presentation.mjs`. Read `README.md`, validate every
local reference with `existsSync`, discover and validate every `docs/assets/**/*.svg`
file with Node 24's `globSync`, print one error per line to stderr, and set
`process.exitCode = 1` when errors exist. On success print:

```text
repository presentation: PASS
```

Use this discovery shape so Task 1 can pass before Task 2 adds the first assets:

```js
const svgPaths = globSync('docs/assets/**/*.svg');
```

- [ ] **Step 6: Add the npm command without weakening existing checks**

Add to `package.json`:

```json
"test:presentation": "node --test scripts/repository-presentation.test.mjs && node scripts/check-repository-presentation.mjs"
```

Change `check` to:

```json
"check": "npm run lint && npm run typecheck && npm run test:presentation && npm run test && npm run build"
```

- [ ] **Step 7: Run the complete presentation command**

Run: `npm run test:presentation`

Expected: 3 unit tests pass and the CLI prints `repository presentation: PASS`. Task 2
adds the first discovered assets without changing the validator.

- [ ] **Step 8: Commit the validator**

```bash
git add package.json scripts/check-repository-presentation.mjs scripts/lib/repository-presentation.mjs scripts/repository-presentation.test.mjs
git commit -m "test: validate repository presentation"
```

### Task 2: TVDoctor visual identity assets

**Files:**
- Create: `docs/assets/tvdoctor-hero.svg`
- Create: `docs/assets/tvdoctor-social-preview.svg`

**Interfaces:**
- Consumes: SVG validation from Task 1.
- Produces: repository-relative hero path `docs/assets/tvdoctor-hero.svg`.
- Produces: GitHub-upload-ready social preview source `docs/assets/tvdoctor-social-preview.svg` at 1280×640.

- [ ] **Step 1: Create the README hero SVG**

Build a `1200 360` viewBox with `<title>` and `<desc>`. Use a restrained palette:
deep navy `#07111F`, blue `#36A3FF`, cyan `#42E8E0`, warm diagnostic amber `#FFBE55`,
and near-white `#F5FAFF`. The left mark combines a rounded TV outline, four corner
focus brackets, and a pulse line. The right side contains `TVDOCTOR`, the subtitle
`Remote-first QA for TV apps`, and the line `Explore · Diagnose · Replay`.

Add a `prefers-color-scheme: light` style block that switches the background to
`#F4F8FC`, primary text to `#07111F`, and secondary text to `#38536B`. Avoid external
fonts, raster images, filters that blur at small sizes, scripts, and animation.

- [ ] **Step 2: Create the social preview SVG**

Build a fixed dark `1280 640` viewBox using the same mark, palette, wordmark, subtitle,
and a small `0.1 preview` pill. Keep all critical content inside a 96-pixel safe area.
Include `<title>` and `<desc>` and no theme-dependent styling because GitHub social
previews render to a fixed image.

- [ ] **Step 3: Run automated asset validation**

Run: `npm run test:presentation`

Expected: `repository presentation: PASS`, with 3 unit tests passing.

- [ ] **Step 4: Render both SVGs for visual inspection**

Use Playwright Chromium to render each SVG at its native viewport and capture temporary
PNGs outside the tracked tree. Inspect the hero once with light color scheme and once
with dark color scheme; inspect the social preview at 1280×640. Verify no clipping,
tiny text, illegible contrast, or unbalanced empty space. Delete or leave the temporary
PNGs outside the repository; do not add them to Git.

- [ ] **Step 5: Commit the brand assets**

```bash
git add docs/assets/tvdoctor-hero.svg docs/assets/tvdoctor-social-preview.svg
git commit -m "docs: add TVDoctor visual identity"
```

### Task 3: README product-page restructure

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `docs/assets/tvdoctor-hero.svg` from Task 2.
- Produces: the canonical product and source-install entry point.

- [ ] **Step 1: Rewrite the README opening**

Place the hero first, followed by centered badges for the `TVDoctor CI` workflow,
MIT licence, Node 24, npm 11, and `0.1.0 release candidate`. Use repository links that
work while private and after an eventual visibility change. Do not add an npm-version,
downloads, coverage, or stability badge.

Follow with this concise positioning structure:

```markdown
TVDoctor explores TV interfaces with the same small remote vocabulary people use—
Up, Down, Left, Right, Select, and Back—then produces evidence-linked findings and
deterministic replays that developers can act on.

> **Release candidate:** ...
```

The callout must state that source and packages are versioned `0.1.0`, npm publication
has not happened, and exact-SHA local plus hosted proof is required.

- [ ] **Step 2: Improve the top-level evaluation flow**

Before the long CLI reference, present these sections in order:

1. `Why TVDoctor` — three compact columns expressed as a Markdown table: remote-realistic
   exploration, fail-closed results, evidence and replay.
2. `What it catches` — short grouped bullets for navigation, streaming/UI semantics,
   diagnostics, and regression baselines.
3. `See it work` — retain the Northstar route diagram and four seeded-finding claim,
   with a prominent link to `docs/demo.md`.
4. `Try the source candidate` — numbered clean-checkout setup and a first local fixture
   audit, clearly separating terminals.
5. `Choose a surface` — compact support/maturity table linking web, Android, reports,
   replay, baselines, and limitations.

- [ ] **Step 3: Preserve and tighten the technical reference**

Retain all existing CLI options, exit codes, complete/partial/failed semantics, report
bundle fields, replay limits, CI commands, troubleshooting guidance, compatibility
boundaries, documentation links, contribution guidance, security warnings, and licence.
Remove duplicated prose only when the retained section carries the same meaning. Keep
every maturity label no stronger than the existing README.

- [ ] **Step 4: Validate links and presentation policy**

Run: `npm run test:presentation`

Expected: all unit tests pass and `repository presentation: PASS`.

Run: `rg -n "npmjs|npm version|downloads|Stable" README.md`

Expected: no npm badge or publication claim; `Stable` appears only in explicit maturity
explanations saying nothing is Stable.

- [ ] **Step 5: Review README rendering**

Open the README preview and inspect desktop and narrow widths. Confirm the hero scales,
tables remain readable, the first screenful explains status honestly, and all important
sections have stable headings suitable for anchor links.

- [ ] **Step 6: Commit the README**

```bash
git add README.md
git commit -m "docs: polish repository landing page"
```

### Task 4: Contribution and repository metadata polish

**Files:**
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `.github/ISSUE_TEMPLATE/config.yml`
- Review and conditionally modify: `.github/ISSUE_TEMPLATE/bug-report.yml`
- Review and conditionally modify: `.github/ISSUE_TEMPLATE/feature-request.yml`
- Review and conditionally modify: `.github/ISSUE_TEMPLATE/driver-proposal.yml`
- Review and conditionally modify: `CHANGELOG.md`
- Review and conditionally modify: `SECURITY.md`
- Review and conditionally modify: `RELEASE.md`

**Interfaces:**
- Consumes: release and presentation rules from the design spec.
- Produces: consistent contributor-facing validation and safety prompts.

- [ ] **Step 1: Add presentation checks to the pull-request template**

Add checklist items requiring `npm run test:presentation` when Markdown or SVG changes,
light/dark review for visual assets, and an explicit statement that npm availability,
repository visibility, and support maturity are not overstated.

- [ ] **Step 2: Add safe contact links to the issue-template configuration**

Keep `blank_issues_enabled: false`. Add `contact_links` entries for documentation and
security guidance using repository URLs. The security link description must explicitly
say not to disclose vulnerabilities or sensitive report evidence in a public issue.

- [ ] **Step 3: Audit remaining top-level repository copy**

Search with:

```bash
rg -n "TV Doctor|TvDoctor|published|public repository|Stable|0\.1\.0" README.md CHANGELOG.md SECURITY.md RELEASE.md .github
```

Correct only factual inconsistencies, naming drift, broken references, or wording that
conflicts with the private/unpublished release posture. Do not rewrite already-clear
issue forms for cosmetic uniformity.

- [ ] **Step 4: Validate YAML, JSON, Markdown links, and whitespace**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package json: PASS')"
npm run test:presentation
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit repository metadata changes**

```bash
git add .github README.md CHANGELOG.md SECURITY.md RELEASE.md
git commit -m "docs: align repository contribution guidance"
```

If only `.github` files changed, stage only `.github` and use the same commit message.

### Task 5: Final candidate review and local release gate

**Files:**
- Review: all files changed since `84a9bc6`
- Do not track: generated reports, screenshots, traces, package tarballs, caches, or npm logs

**Interfaces:**
- Produces: one clean, immutable local candidate SHA.

- [ ] **Step 1: Review the complete candidate diff**

Run:

```bash
git diff --stat 84a9bc6..HEAD
git diff 84a9bc6..HEAD
git diff --check 84a9bc6..HEAD
```

Confirm the diff contains only the validator, brand assets, README, and intentional
repository guidance changes. Search for credential-shaped text and absolute local paths
without printing environment variables or npm configuration.

- [ ] **Step 2: Confirm version and registry posture**

Run `rg -n '"version": "0.1.0"' packages -g package.json` and confirm all nine publishable
packages are `0.1.0`. Run `git tag --points-at HEAD` and confirm no tag exists. Run
`gh repo view Ticklect/tvdoctor --json visibility` and confirm `PRIVATE`.

- [ ] **Step 3: Run the complete clean local gate**

Run these commands in order and stop on the first non-zero exit:

```bash
npm ci
npx playwright install chromium
npm run check
npm run test:package-smoke
node examples/baseline-ci-example.mjs
npm audit
git status --short
```

Expected: every command exits 0, audit reports zero known vulnerabilities, package smoke
reports PASS for all nine packages, and `git status --short` prints nothing.

- [ ] **Step 4: Record the immutable candidate SHA**

Run: `git rev-parse HEAD`

Use the returned 40-character SHA for every hosted-run and release statement. Do not
amend or add commits after this point; any change creates a new candidate and requires
the complete local gate again.

### Task 6: Push and exact-SHA hosted verification

**Files:**
- No file changes.

**Interfaces:**
- Consumes: immutable candidate SHA from Task 5.
- Produces: remote branch containing that SHA and first-attempt hosted gate evidence.

- [ ] **Step 1: Confirm the branch and pull request target**

Run:

```bash
git status --short --branch
gh pr view --json number,url,headRefName,baseRefName,state
```

Expected: branch `codex/android-v2-observer`, clean worktree, base `main`, and an open PR.

- [ ] **Step 2: Push the reviewed branch**

Run: `git push origin codex/android-v2-observer`

Expected: the remote advances to the immutable candidate SHA. Do not force-push.

- [ ] **Step 3: Identify the new workflow run without rerunning it**

Capture and query the exact commit:

```bash
CANDIDATE_SHA="$(git rev-parse HEAD)"
gh run list --commit "$CANDIDATE_SHA" --limit 5
```

Repeat the read-only list command until the push-triggered pull-request run appears.
Record its run ID and URL. If no run appears, inspect the PR state and workflow trigger
rather than dispatching a manual substitute.

- [ ] **Step 4: Wait for the hosted jobs to finish**

Capture the run ID from the exact candidate and wait for it:

```bash
RUN_ID="$(gh run list --commit "$CANDIDATE_SHA" --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status
```

Expected: exit 0 on attempt 1. Then run:

```bash
gh run view "$RUN_ID" --json headSha,attempt,conclusion,url,jobs
```

Confirm `headSha` equals the candidate SHA, `attempt` is `1`, and both `Aggregate
release-candidate gate` and `Android TV observer integration (API 36)` succeeded.
Do not rerun a failure and describe it as first-attempt evidence.

- [ ] **Step 5: Reconfirm repository privacy and branch integrity**

Run:

```bash
gh repo view Ticklect/tvdoctor --json visibility
git status --short --branch
git rev-parse HEAD
```

Expected: `PRIVATE`, clean/synchronized branch, and the unchanged candidate SHA.

### Task 7: Package publication dry-runs and release handoff

**Files:**
- No tracked file changes.

**Interfaces:**
- Consumes: package inventories proven by `test:package-smoke`.
- Produces: dry-run evidence and a concise operator-only blocker list.

- [ ] **Step 1: Run a dry-run for every package in dependency-first order**

Run these commands without removing `--dry-run`:

```bash
npm publish --dry-run --workspace @tvdoctor/protocol
npm publish --dry-run --workspace @tvdoctor/baseline
npm publish --dry-run --workspace @tvdoctor/core
npm publish --dry-run --workspace @tvdoctor/driver-web
npm publish --dry-run --workspace @tvdoctor/driver-android
npm publish --dry-run --workspace @tvdoctor/pack-web
npm publish --dry-run --workspace @tvdoctor/pack-streaming
npm publish --dry-run --workspace @tvdoctor/reporters
npm publish --dry-run --workspace tvdoctor
```

Expected: each command reports package `0.1.0`, public access intent where applicable,
and a file inventory consistent with package smoke. Stop if any command attempts a real
publish or reports an unexpected local path, test fixture, credential, or missing entry
point.

- [ ] **Step 2: Check authentication separately**

Run: `npm whoami`

If it returns `ENEEDAUTH`, record npm authentication and account/organisation policy
verification as an operator blocker. Do not run `npm adduser`, request credentials, or
change npm configuration during this task.

- [ ] **Step 3: Produce the release-candidate handoff**

Report:

- candidate SHA and branch;
- local gate commands and exit status;
- hosted workflow URL, run ID, attempt, and both job conclusions;
- all nine dry-run outcomes;
- repository visibility (`PRIVATE`);
- npm authentication/account-policy status;
- confirmation that nothing was published or tagged; and
- the prepared social-preview asset path if GitHub UI upload remains owner-side.

- [ ] **Step 4: Final no-mutation verification**

Run:

```bash
git status --short --branch
git tag --points-at HEAD
npm view tvdoctor@0.1.0 version
```

Expected: clean/synchronized branch, no tag, and registry `E404` until the owner separately
authorizes publication. Do not turn an unexpected published version into a success claim;
stop and report it.
