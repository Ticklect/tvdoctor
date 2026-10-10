import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import {
  extractLocalReferences,
  validateLocalReferences,
  validateSvg,
} from './lib/repository-presentation.mjs';

function extractActionCommentScript(action) {
  const startMarker = "        node <<'NODE'\n";
  const endMarker = '\n        NODE';
  const start = action.indexOf(startMarker);
  const end = action.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, 'action comment script should have a Node heredoc');
  assert.notEqual(end, -1, 'action comment script should close its Node heredoc');
  return action.slice(start + startMarker.length, end).replace(/^ {8}/gmu, '');
}

function extractJobSummaryGraphScript(action) {
  const startMarker = "        node <<'NODE' >> \"$GITHUB_STEP_SUMMARY\"\n";
  const endMarker = '\n        NODE';
  const start = action.indexOf(startMarker);
  const end = action.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, 'job summary should have a navigation graph Node heredoc');
  assert.notEqual(end, -1, 'job summary navigation graph heredoc should close');
  return action.slice(start + startMarker.length, end).replace(/^ {8}/gmu, '');
}

function extractRunTvDoctorStep(action) {
  const match = action.match(/ {4}- name: Run TVDoctor\r?\n[\s\S]*?(?=\r?\n {4}- name: Add job summary)/u);
  assert.ok(match, 'action should contain a Run TVDoctor step');
  return match[0];
}

function runActionCommentExecution({
  summary,
  comparisonJson,
  comparisonMarkdown,
  report,
  sourceCorrelation,
  navigationGraph,
  baselineSource = 'none',
  artifact = 'tvdoctor-report-123-2',
  commentPages = [[]],
  lookupFailurePage = null,
  writeFailure = false,
  githubAppSlug = '',
  identity = { status: 403 },
  eventName = 'pull_request',
  token = 'test-token',
  event = {
    pull_request: {
      number: 42,
      head: { repo: { full_name: 'tvdoctor/example' } },
    },
  },
  actionPath,
}) {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const action = readFileSync(path.join(repositoryRoot, 'action.yml'), 'utf8');
  const workspace = mkdtempSync(path.join(tmpdir(), 'tvdoctor-action-comment-'));
  try {
    const reportDirectory = path.join(workspace, 'tvdoctor-report');
    mkdirSync(path.join(reportDirectory, 'exports'), { recursive: true });
    if (summary !== undefined) {
      writeFileSync(path.join(reportDirectory, 'exports', 'ci-summary.md'), summary);
    }
    if (comparisonJson !== undefined) {
      writeFileSync(
        path.join(reportDirectory, 'baseline-comparison.json'),
        typeof comparisonJson === 'string' ? comparisonJson : JSON.stringify(comparisonJson),
      );
    }
    if (comparisonMarkdown !== undefined) {
      writeFileSync(path.join(reportDirectory, 'baseline-comparison.md'), comparisonMarkdown);
    }
    if (report !== undefined) {
      writeFileSync(
        path.join(reportDirectory, 'report.json'),
        typeof report === 'string' ? report : JSON.stringify(report),
      );
    }
    if (sourceCorrelation !== undefined) {
      writeFileSync(
        path.join(reportDirectory, 'exports', 'source-correlation.json'),
        typeof sourceCorrelation === 'string' ? sourceCorrelation : JSON.stringify(sourceCorrelation),
      );
    }
    if (navigationGraph !== undefined) {
      writeFileSync(
        path.join(reportDirectory, 'navigation-graph.json'),
        typeof navigationGraph === 'string' ? navigationGraph : JSON.stringify(navigationGraph),
      );
    }

    const eventPath = path.join(workspace, 'event.json');
    writeFileSync(eventPath, JSON.stringify(event));
    const scriptPath = path.join(workspace, 'comment-script.cjs');
    const mock = JSON.stringify({ commentPages, lookupFailurePage, writeFailure, identity });
    const fetchStub = `
const mock = ${mock};
globalThis.fetch = async (url, options) => {
  const payload = options.body === undefined ? null : JSON.parse(options.body);
  process.stdout.write('__TVDOCTOR_REQUEST__' + JSON.stringify({ url, method: options.method, payload }) + '\\n');
  if (url === 'https://api.github.test/user' && options.method === 'GET') {
    return { ok: mock.identity.status === 200, status: mock.identity.status, json: async () => mock.identity.body };
  }
  if (options.method === 'GET') {
    const page = Number(new URL(url).searchParams.get('page'));
    if (mock.lookupFailurePage === page) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => mock.commentPages[page - 1] ?? [] };
  }
  if (options.method === 'POST' || options.method === 'PATCH') {
    process.stdout.write('__TVDOCTOR_COMMENT__' + JSON.stringify(payload.body) + '\\n');
    return { ok: !mock.writeFailure, status: mock.writeFailure ? 403 : 201 };
  }
  throw new Error('Unexpected mock request: ' + options.method);
};
`;
    writeFileSync(scriptPath, `${fetchStub}${extractActionCommentScript(action)}`);

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: actionPath === 'workspace' ? workspace : actionPath ?? repositoryRoot,
        GITHUB_API_URL: 'https://api.github.test',
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: 'tvdoctor/example',
        GITHUB_WORKSPACE: workspace,
        TVDOCTOR_ARTIFACT_NAME: artifact,
        TVDOCTOR_BASELINE_SOURCE: baselineSource,
        TVDOCTOR_GITHUB_TOKEN: token,
        TVDOCTOR_GITHUB_APP_SLUG: githubAppSlug,
      },
    });
    const lines = result.stdout.split(/\r?\n/u);
    const marker = lines.find((line) => line.startsWith('__TVDOCTOR_COMMENT__'));
    const allRequests = lines.filter((line) => line.startsWith('__TVDOCTOR_REQUEST__'))
      .map((line) => JSON.parse(line.slice('__TVDOCTOR_REQUEST__'.length)));
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      body: marker === undefined ? null : JSON.parse(marker.slice('__TVDOCTOR_COMMENT__'.length)),
      requests: allRequests.filter(({ url }) => !url.endsWith('/user')),
      identityRequests: allRequests.filter(({ url }) => url.endsWith('/user')),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runActionCommentScenario(options) {
  const result = runActionCommentExecution(options);
  assert.equal(result.status, 0, `comment script failed:\n${result.stderr}\n${result.stdout}`);
  assert.ok(result.body !== null, `comment script did not emit a captured body:\n${result.stdout}`);
  return result.body;
}

function runJobSummaryGraphScenario(navigationGraph) {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const action = readFileSync(path.join(repositoryRoot, 'action.yml'), 'utf8');
  const workspace = mkdtempSync(path.join(tmpdir(), 'tvdoctor-job-summary-'));
  try {
    const reportDirectory = path.join(workspace, 'tvdoctor-report');
    mkdirSync(reportDirectory, { recursive: true });
    if (navigationGraph !== undefined) {
      writeFileSync(
        path.join(reportDirectory, 'navigation-graph.json'),
        typeof navigationGraph === 'string' ? navigationGraph : JSON.stringify(navigationGraph),
      );
    }
    const scriptPath = path.join(workspace, 'job-summary-graph.cjs');
    writeFileSync(scriptPath, extractJobSummaryGraphScript(action));
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_WORKSPACE: workspace },
    });
    assert.equal(result.status, 0, `job-summary graph script failed:\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('root lint ignores nested generated workspace trees', async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const eslint = new ESLint({ cwd: repositoryRoot });
  assert.equal(
    await eslint.isPathIgnored(path.join(repositoryRoot, '.worktrees', 'example', 'src', 'bad.ts')),
    true,
  );
  assert.equal(
    await eslint.isPathIgnored(path.join(repositoryRoot, 'artifacts', 'fresh-clone', 'src', 'bad.ts')),
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

test('hosted runtime matrix builds a rehearsal bundle without requiring an unused release tag', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const releaseBuilder = readFileSync(path.join(root, 'scripts', 'build-github-release.ps1'), 'utf8');
  assert.match(workflow, /build-github-release\.ps1 -Rehearsal/u);
  assert.match(workflow, /test-github-release\.ps1 -Bundle [^\r\n]*-rehearsal\.zip/u);
  assert.match(releaseBuilder, /if \(-not \$Rehearsal\) \{/u);
  assert.match(releaseBuilder, /Release tag v\$Version already exists/u);
});

test('puts the navigation-first quick path before advanced diagnostics', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const cliReadme = readFileSync(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8');
  assert.match(readme, /tvdoctor scan https:\/\/your-tv-app\.example/u);
  assert.match(readme, /navigation-first/u);
  assert.match(readme, /VERIFIED.*REVIEW.*UNTESTED/su);
  assert.match(cliReadme, /npx tvdoctor scan/u);
  assert.match(readme, /npm run tvdoctor -- scan http:\/\/127\.0\.0\.1:5173/u);
  assert.match(cliReadme, /npm run tvdoctor -- scan http:\/\/127\.0\.0\.1:3000/u);
  assert.match(cliReadme, /default is\s+`navigation`/u);
  assert.doesNotMatch(cliReadme, /the default is `all`/iu);
});

test('root quick path does not give source users an installed-only tvdoctor command', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const cliReadme = readFileSync(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8');

  assert.doesNotMatch(
    readme,
    /After installing the Windows bundle or building from source,[\s\S]{0,240}`?tvdoctor scan/u,
  );
  assert.match(readme, /source checkout[\s\S]{0,240}npm run tvdoctor -- scan/iu);
  assert.match(readme, /source checkout[\s\S]{0,900}later CLI examples[\s\S]{0,120}`npm run tvdoctor --`/iu);
  assert.match(cliReadme, /source checkout[\s\S]{0,900}later CLI examples[\s\S]{0,120}`npm run tvdoctor --`/iu);
});

test('source-checkout advanced examples use the workspace script', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const cliReadme = readFileSync(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8');

  assert.match(
    cliReadme,
    /From a source checkout, prefix these with[\s\S]{0,220}npm run tvdoctor -- test http:\/\/127\.0\.0\.1:3000/iu,
  );
});

test('replay docs state the exact standalone reproduced exit code', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const cliReadme = readFileSync(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8');

  for (const [label, markdown] of [['README', readme], ['CLI README', cliReadme]]) {
    assert.match(
      markdown,
      /standalone replay[\s\S]{0,220}REPRODUCED[\s\S]{0,100}exit(?:s)? `?1`?/iu,
      `${label} should name exit 1 for a reproduced standalone replay`,
    );
  }
});

test('first-run docs lead with audience, current scope, and the packaged seeded demo', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const cliReadme = readFileSync(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8');
  const demo = readFileSync(path.join(repositoryRoot, 'docs/demo.md'), 'utf8');
  const examples = readFileSync(path.join(repositoryRoot, 'docs/examples.md'), 'utf8');

  const firstScreen = readme.slice(0, 5_000);
  assert.match(firstScreen, /## Who TVDoctor is for/u);
  assert.match(firstScreen, /## Current scope/u);
  assert.match(firstScreen, /## Try the packaged demo/u);
  assert.match(firstScreen, /\[Sample report\]\(docs\/sample-report\.md\)/u);
  assert.match(demo, /\[sample report\]\(sample-report\.md\)/iu);
  assert.ok(
    readme.indexOf('## Try the packaged demo') < readme.indexOf('## Experimental boundaries'),
    'the concrete demo should appear before detailed caveats',
  );

  for (const [label, markdown] of [
    ['README', readme],
    ['CLI README', cliReadme],
    ['demo guide', demo],
    ['examples', examples],
  ]) {
    assert.match(markdown, /tvdoctor demo/u, `${label} should show the first-success demo command`);
    assert.match(markdown, /6 actions/u, `${label} should preserve the proven action count`);
    assert.match(markdown, /1 state/u, `${label} should preserve the proven state count`);
    assert.match(markdown, /1 issue/u, `${label} should preserve the proven issue count`);
    assert.match(markdown, /Home.*More info|More info.*Home/su, `${label} should name the seeded Home More info failure`);
    assert.match(markdown, /remote\.reachability/u, `${label} should name the verified rule`);
    assert.match(markdown, /REPRODUCED/u, `${label} should show the replay result`);
    assert.match(markdown, /controlled seeded evidence/iu, `${label} should label the evidence honestly`);
    assert.match(markdown, /not (?:a measure|evidence|proof) of production accuracy/iu, `${label} should reject a production-accuracy interpretation`);
  }
});

test('distribution, setup, experimental boundaries, and exit codes stay consistent', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const cliReadme = readFileSync(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8');

  for (const [label, markdown] of [['README', readme], ['CLI README', cliReadme]]) {
    assert.match(markdown, /not published to npm yet/iu, `${label} must not imply npm availability`);
    assert.match(markdown, /tvdoctor setup/u, `${label} should explain explicit Chromium setup`);
    assert.match(markdown, /web[^\n]*Experimental/iu, `${label} should mark web support Experimental`);
    assert.match(markdown, /Android TV[^\n]*Experimental/iu, `${label} should mark Android TV support Experimental`);
    assert.match(markdown, /\| `?0`? \|[^\n]*requested (?:failure )?policy[^\n]*seeded[^\n]*demo/iu, `${label} should document demo success under code 0`);
    assert.match(markdown, /\| `?1`? \|[^\n]*Findings failed policy[^\n]*standalone replay[^\n]*reproduced/iu, `${label} should document code 1 consistently`);
    assert.match(markdown, /\| `?2`? \|[^\n]*usage[^\n]*invalid/iu, `${label} should document code 2 consistently`);
    assert.match(markdown, /\| `?3`? \|[^\n]*partial[^\n]*inconclusive/iu, `${label} should document code 3 consistently`);
    assert.match(markdown, /\| `?4`? \|[^\n]*trustworthy result/iu, `${label} should document code 4 consistently`);
  }

  assert.match(readme, /### Windows release bundle/u);
  assert.match(readme, /### Source checkout/u);
  assert.match(cliReadme, /Windows release bundle/u);
  assert.match(cliReadme, /Source checkout/u);
});

test('user-facing docs expose the local privacy controls and their limits', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const cliReadme = readFileSync(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8');

  for (const [label, markdown] of [['README', readme], ['CLI README', cliReadme]]) {
    assert.match(markdown, /tvdoctor privacy/u, `${label} should expose the privacy command`);
    assert.match(markdown, /--no-screenshots/u, `${label} should document screenshot suppression`);
    assert.match(markdown, /--target-redaction origin/u, `${label} should document strict target minimisation`);
    assert.match(markdown, /--record-video/u, `${label} should document opt-in video`);
    assert.match(markdown, /review[\s\S]{0,160}(?:artifact|bundle)[\s\S]{0,120}sharing/iu, `${label} should warn that redaction is not a sharing guarantee`);
  }
});

test('package smoke explicitly proves npx cannot install a missing package', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const packageSmoke = readFileSync(path.join(repositoryRoot, 'scripts/package-smoke.mjs'), 'utf8');

  assert.match(packageSmoke, /runNpx\(\["--no-install", "-c", "tvdoctor --version"\]/u);
  assert.match(packageSmoke, /runNpx\(\["--no-install", "-c", "tvdoctor --help"\]/u);
});

test('composite action keeps baseline review read-only by default and gates PR writes', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const action = readFileSync(path.join(repositoryRoot, 'action.yml'), 'utf8');
  const workflow = readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.match(action, /\n {2}baseline:\n[\s\S]{0,180}default:\s*["']{0,1}["']{0,1}\s*$/mu);
  assert.match(action, /\n {2}fail-on:\n[\s\S]{0,220}required:\s*false[\s\S]{0,80}default:\s*high/mu);
  assert.match(action, /\n {2}comment-on-pr:\n[\s\S]{0,180}default:\s*["']false["']/mu);
  assert.match(action, /\n {2}github-token:\n[\s\S]{0,180}required:\s*false/mu);
  assert.match(action, /\n {2}comparison:\n[\s\S]{0,160}baseline-comparison\.json/mu);
  assert.match(action, /--baseline/u);
  assert.match(action, /GITHUB_STEP_SUMMARY/u);
  assert.match(action, /baseline-comparison\.md/u);
  assert.match(action, /comment-on-pr must be true or false/iu);
  assert.match(action, /GITHUB_ACTION_PATH[\s\S]{0,600}GITHUB_WORKSPACE/u);
  assert.match(action, /Refusing a write-capable token[\s\S]{0,500}target repository checkout/iu);
  assert.match(action, /pull_request_target/iu);
  assert.match(action, /same-repository pull requests/iu);
  assert.match(action, /TVDoctor regression check/iu);
  assert.match(action, /MAX_COMMENT_CHARS\s*=\s*2_400/u);
  assert.match(action, /COMMENT_MARKER\s*=\s*"<!-- tvdoctor:pr-regression-check:v1 -->"/u);
  assert.match(action, /\n {2}github-app-slug:\n[\s\S]{0,250}actions\/create-github-app-token/u);
  assert.match(action, /TVDOCTOR_GITHUB_APP_SLUG: \$\{\{ inputs\.github-app-slug \}\}/u);
  assert.match(action, /MAX_COMMENT_PAGES\s*=\s*5/u);
  assert.match(action, /baseline-comparison\.json/u);

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/mu);
  assert.doesNotMatch(workflow, /pull_request_target\s*:/u);
  assert.doesNotMatch(workflow, /pull-requests:\s*write/u);
});

test('PR comment creates a marked bounded comment only after a complete GitHub lookup', () => {
  const result = runActionCommentExecution({
    summary: '# TVDoctor CI: PASSED\nRun: **completed** · Findings: **0**\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests.map(({ method }) => method), ['GET', 'POST']);
  assert.equal(result.requests[0].url, 'https://api.github.test/repos/tvdoctor/example/issues/42/comments?per_page=100&page=1');
  assert.equal(result.requests[1].url, 'https://api.github.test/repos/tvdoctor/example/issues/42/comments');
  assert.match(result.body, /^### TVDoctor regression check — PASSED/mu);
  assert.ok(result.body.endsWith('<!-- tvdoctor:pr-regression-check:v1 -->'));
  assert.ok(result.body.length <= 2_400);
});

test('PR comment updates the latest matching bot comment across bounded pages', () => {
  const marker = '<!-- tvdoctor:pr-regression-check:v1 -->';
  const older = { id: 100, user: { type: 'Bot', login: 'github-actions[bot]' }, body: `### TVDoctor regression check — PASSED\n\n${marker}` };
  const latest = { id: 213, user: { type: 'Bot', login: 'github-actions[bot]' }, body: `### TVDoctor regression check — FAILED\n\n${marker}` };
  const commentPages = [
    [...Array.from({ length: 99 }, (_, index) => ({
      id: index + 1,
      user: { type: 'User', login: 'other-user' },
      body: `### TVDoctor regression check — FAILED\n\n${marker}`,
    })), older],
    [latest, { id: 450, user: { type: 'Bot', login: 'random[bot]' }, body: 'unrelated bot comment' }],
  ];
  const result = runActionCommentExecution({
    summary: '# TVDoctor CI: FAILED\nRun: **completed** · Findings: **3**\n',
    commentPages,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests.map(({ method }) => method), ['GET', 'GET', 'PATCH']);
  assert.equal(result.requests[2].url, 'https://api.github.test/repos/tvdoctor/example/issues/comments/213');
  assert.match(result.requests[2].payload.body, /TVDoctor regression check — FAILED/u);
  assert.ok(result.requests[2].payload.body.endsWith(marker));
  assert.equal(result.identityRequests.length, 1);
  assert.equal(result.identityRequests[0].url, 'https://api.github.test/user');
});

test('PR comment ignores a spoofed different bot with an otherwise exact TVDoctor marker', () => {
  const marker = '<!-- tvdoctor:pr-regression-check:v1 -->';
  const body = `### TVDoctor regression check — PASSED\n\n${marker}`;
  const spoofed = { id: 456, user: { type: 'Bot', login: 'unrelated[bot]' }, body };
  const own = { id: 123, user: { type: 'Bot', login: 'github-actions[bot]' }, body };
  const update = runActionCommentExecution({ commentPages: [[spoofed, own]] });
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(update.requests.map(({ method }) => method), ['GET', 'PATCH']);
  assert.match(update.requests[1].url, /\/issues\/comments\/123$/u);

  const create = runActionCommentExecution({ commentPages: [[spoofed]] });
  assert.equal(create.status, 0, create.stderr);
  assert.deepEqual(create.requests.map(({ method }) => method), ['GET', 'POST']);
});

test('custom GitHub App installation token updates only its configured app bot', () => {
  const body = '### TVDoctor regression check — PASSED\n\n<!-- tvdoctor:pr-regression-check:v1 -->';
  const result = runActionCommentExecution({
    githubAppSlug: 'tvdoctor-ci',
    commentPages: [[
      { id: 29, user: { type: 'Bot', login: 'github-actions[bot]' }, body },
      { id: 31, user: { type: 'Bot', login: 'other[bot]' }, body },
      { id: 30, user: { type: 'Bot', login: 'tvdoctor-ci[bot]' }, body },
    ]],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests.map(({ method }) => method), ['GET', 'PATCH']);
  assert.match(result.requests[1].url, /\/issues\/comments\/30$/u);
});

test('bot identity from GET /user overrides the default and rejects a mismatched configured GitHub App', () => {
  const body = '### TVDoctor regression check — PASSED\n\n<!-- tvdoctor:pr-regression-check:v1 -->';
  const identity = { status: 200, body: { type: 'Bot', login: 'authenticated-app[bot]' } };
  const verified = runActionCommentExecution({
    identity,
    commentPages: [[
      { id: 14, user: { type: 'Bot', login: 'github-actions[bot]' }, body },
      { id: 15, user: { type: 'Bot', login: 'authenticated-app[bot]' }, body },
    ]],
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.requests[1].url, /\/issues\/comments\/15$/u);

  const mismatch = runActionCommentExecution({ identity, githubAppSlug: 'another-app' });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match github-app-slug/u);
  assert.deepEqual(mismatch.requests, []);
});

test('identity lookup fails closed for unknown errors and human accounts', () => {
  for (const [scenario, expected, identityRequests] of [
    [{ identity: { status: 401 } }, /identity lookup failed with HTTP 401/u, 1],
    [{ identity: { status: 500 } }, /identity lookup failed with HTTP 500/u, 1],
    [{ identity: { status: 200, body: { type: 'User', login: 'octocat' } } }, /require a bot token/u, 1],
    [{ githubAppSlug: '../untrusted' }, /github-app-slug must be a valid/u, 0],
  ]) {
    const result = runActionCommentExecution(scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.deepEqual(result.requests, []);
    assert.equal(result.identityRequests.length, identityRequests);
  }
});

test('PR comment never edits users or bot comments without its exact marker', () => {
  const marker = '<!-- tvdoctor:pr-regression-check:v1 -->';
  const result = runActionCommentExecution({
    commentPages: [[
      { id: 11, user: { type: 'User', login: 'person' }, body: `### TVDoctor regression check — PASSED\n\n${marker}` },
      { id: 12, user: { type: 'Bot', login: 'other[bot]' }, body: 'Different tool\n\n' + marker },
      { id: 13, user: { type: 'Bot', login: 'other[bot]' }, body: '### TVDoctor regression check — PASSED' },
      { id: 14, user: { type: 'User', login: 'person' }, body: 'Comment quoting the marker: ' + marker },
    ]],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests.map(({ method }) => method), ['GET', 'POST']);
});

test('PR comment does not create a duplicate if GitHub refuses to update a matching bot comment', () => {
  const result = runActionCommentExecution({
    commentPages: [[{
      id: 19,
      user: { type: 'Bot', login: 'github-actions[bot]' },
      body: '### TVDoctor regression check — PASSED\n\n<!-- tvdoctor:pr-regression-check:v1 -->',
    }]],
    writeFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /comment update failed with HTTP 403/u);
  assert.deepEqual(result.requests.map(({ method }) => method), ['GET', 'PATCH']);
});

test('PR comment fails closed when pagination or GitHub APIs cannot verify prior comments', () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1, user: { type: 'User', login: 'person' }, body: 'No TVDoctor marker',
  }));
  for (const [scenario, expected, requests] of [
    [{ commentPages: Array.from({ length: 5 }, () => fullPage) }, /lookup exceeded 500 comments/u, 5],
    [{ lookupFailurePage: 1 }, /lookup failed with HTTP 503/u, 1],
    [{ commentPages: [{ invalid: true }] }, /lookup returned an invalid page/u, 1],
    [{ writeFailure: true }, /comment creation failed with HTTP 403/u, 2],
  ]) {
    const result = runActionCommentExecution(scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(result.requests.length, requests);
    if (!scenario.writeFailure) assert.ok(result.requests.every(({ method }) => method === 'GET'));
  }
});

test('PR comment security preflight blocks unsafe events and tokens before network calls', () => {
  for (const [scenario, expected] of [
    [{ token: '' }, /requires github-token/u],
    [{ eventName: 'pull_request_target' }, /pull_request_target is not supported/u],
    [{ event: { pull_request: { number: 42, head: { repo: { full_name: 'fork/project' } } } } }, /same-repository pull requests only/u],
    [{ actionPath: 'workspace' }, /Refusing a write-capable token/u],
  ]) {
    const result = runActionCommentExecution(scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.deepEqual(result.requests, []);
  }
});

test('composite action prefers an explicit baseline and safely discovers the reviewed committed baseline', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const action = readFileSync(path.join(repositoryRoot, 'action.yml'), 'utf8');
  const runStep = extractRunTvDoctorStep(action);

  const explicitAssignment = runStep.indexOf('baseline_path="$TVDOCTOR_BASELINE"');
  const explicitGuard = runStep.indexOf('if [[ -n "$baseline_path" ]]');
  const discoveryPath = runStep.indexOf('reviewed_baseline="${GITHUB_WORKSPACE}/.tvdoctor/baseline.json"');
  assert.ok(explicitAssignment >= 0, 'Run TVDoctor should start baseline selection from the explicit input');
  assert.ok(explicitGuard > explicitAssignment, 'Run TVDoctor should test the explicit input after assigning it');
  assert.ok(discoveryPath > explicitGuard, 'automatic discovery should run only after checking the explicit input');
  assert.match(runStep, /reviewed_baseline="\$\{GITHUB_WORKSPACE\}\/\.tvdoctor\/baseline\.json"/u);
  assert.match(runStep, /if \[\[ -f "\$reviewed_baseline" && ! -L "\$reviewed_baseline" \]\]; then\s*\r?\n\s*baseline_path="\$reviewed_baseline"/u);
  assert.match(runStep, /if \[\[ -n "\$baseline_path" \]\]; then\s*\r?\n\s*args\+=\(--baseline "\$baseline_path"\)/u);
  assert.match(runStep, /baseline_source="none"/u);
  assert.match(runStep, /baseline_source="input"/u);
  assert.match(runStep, /baseline_source="committed"/u);
  assert.match(runStep, /echo "baseline_source=\$\{baseline_source\}" >> "\$GITHUB_OUTPUT"/u);
  assert.match(action, /\n {2}baseline-source:\n[\s\S]{0,180}steps\.audit\.outputs\.baseline_source/mu);
  assert.match(action, /\n {2}navigation-graph:\n[\s\S]{0,180}navigation_graph/mu);
  assert.match(action, /## Regression baseline/u);
  assert.match(action, /## Navigation graph/u);
  assert.match(action, /navigation-graph\.md/u);
  assert.doesNotMatch(action, /baseline\s+(?:create|save|update)|--(?:create|save|write|update)-baseline/iu);
  assert.match(action, /When empty, \.tvdoctor\/baseline\.json is used if present as a regular file\./u);
});

test('baseline CI guide documents the reviewed committed path and defers unsafe changed-file pruning', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const guide = readFileSync(path.join(repositoryRoot, 'docs', 'baselines-and-ci.md'), 'utf8');

  assert.match(guide, /--output \.tvdoctor\/baseline\.json/u);
  assert.match(guide, /baseline-source[\s\S]{0,160}`committed`[\s\S]{0,80}`input`[\s\S]{0,80}`none`/u);
  assert.match(guide, /navigation-graph\.md/u);
  assert.match(guide, /does not prune the navigation scan to changed files/iu);
  assert.match(guide, /not a complete[\s\S]{0,120}dependency map/iu);
  assert.match(guide, /partial scan[\s\S]{0,320}affected state was never[\s\S]{0,40}visited/iu);
  assert.match(guide, /does[\s\S]{0,20}not add a changed-files shortcut/iu);
});

test('job summary renders a bounded navigation graph overview and degrades cleanly', () => {
  const summary = runJobSummaryGraphScenario({
    schemaVersion: 'tvdoctor.navigation-focus-graph/v2',
    coverage: 'complete',
    screens: [{ key: '@screen' }],
    focusTargets: [{ key: 'a' }, { key: 'b' }],
    transitions: [{ key: 'a:RIGHT' }],
    problems: [{ issueId: '@problem' }],
    coverageSummary: {
      locallyCompleteFocusTargetKeys: ['a', 'b'],
      frontier: {
        status: 'complete',
        remainingFrontierEntries: 0,
        remainingCandidateActions: 0,
        reason: '@reason',
      },
    },
  });
  assert.match(summary, /## Navigation graph/u);
  assert.match(summary, /Coverage: \*\*COMPLETE\*\*/u);
  assert.match(summary, /1 screens \/ 2 focus targets \/ 1 transitions/u);
  assert.match(summary, /Problem annotations: \*\*1\*\*/u);
  assert.match(summary, /Locally complete focus targets: \*\*2 \/ 2\*\*/u);
  assert.match(summary, /Frontier: \*\*COMPLETE\*\* · \*\*0 queued entries \/ 0 candidate actions\*\*/u);
  assert.match(summary, /`navigation-graph\.md`/u);
  assert.doesNotMatch(summary, /@screen|@problem|@reason/u);

  const malformed = runJobSummaryGraphScenario('{');
  assert.match(malformed, /Overview unavailable/u);
});

test('PR comment shows reviewed baseline selection and bounded navigation graph coverage', () => {
  const body = runActionCommentScenario({
    summary: '# TVDoctor CI: PASSED\n\nRun: **completed** · Policy: fail on **high** · Findings: **0**\n',
    baselineSource: 'committed',
    navigationGraph: {
      schemaVersion: 'tvdoctor.navigation-focus-graph/v2',
      coverage: 'partial',
      screens: [{ key: 'home', label: '@screen-canary' }, { key: 'player' }],
      focusTargets: [{ key: 'play' }, { key: 'settings' }, { key: 'captions' }],
      transitions: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }],
      problems: [{ issueId: '@problem-canary' }],
      coverageSummary: {
        locallyCompleteFocusTargetKeys: ['play', 'settings'],
        frontier: {
          status: 'deferred',
          remainingFrontierEntries: 3,
          remainingCandidateActions: 7,
          reason: '@frontier-canary',
        },
      },
    },
  });

  assert.match(body, /Baseline: reviewed committed `\.tvdoctor\/baseline\.json`/u);
  assert.match(body, /Navigation graph: \*\*PARTIAL\*\* · \*\*2 screens \/ 3 focus targets \/ 4 transitions\*\* · \*\*1 problem annotations\*\* · \*\*2\/3 locally complete\*\* · frontier \*\*DEFERRED\*\* \(3 queued \/ 7 actions\)/u);
  assert.doesNotMatch(body, /screen-canary|problem-canary|frontier-canary|@/u);
  assert.ok(body.length <= 2_400, `comment should stay within bound, got ${body.length}`);
});

test('PR comment ignores malformed navigation graph overview without affecting baseline regression output', () => {
  const body = runActionCommentScenario({
    summary: '# TVDoctor CI: FAILED\n\nRun: **completed** · Policy: fail on **high** · Findings: **1**\n',
    baselineSource: 'input',
    comparisonJson: {
      schemaVersion: 'tvdoctor.comparison/v1',
      status: 'regressed',
      changes: {
        newIssues: [{ id: 'NAV-1', rule: 'remote.reachability', severity: 'high' }],
        resolvedIssues: [],
        transitionsChanged: [],
        latencyRegressions: [],
      },
    },
    navigationGraph: {
      schemaVersion: 'tvdoctor.navigation-focus-graph/v2',
      screens: {},
      focusTargets: [],
      transitions: [],
      problems: [],
    },
  });

  assert.match(body, /Baseline: explicit reviewed baseline input/u);
  assert.match(body, /Baseline comparison: \*\*REGRESSED\*\* · \*\*1 introduced\*\*/u);
  assert.doesNotMatch(body, /Navigation graph:/u);
});

test('PR comment reports bounded regression deltas and sanitises structured detail', () => {
  const body = runActionCommentScenario({
    summary: [
      '# TVDoctor CI: FAILED',
      '',
      'Run: **completed** · Policy: fail on **high** · Findings: **3**',
      '',
      '- raw summary payload @summary-team <script>SUMMARY_CANARY</script>',
    ].join('\n'),
    comparisonJson: {
      schemaVersion: 'tvdoctor.comparison/v1',
      status: 'regressed',
      changes: {
        newIssues: [
          { id: 'nav-new', rule: 'remote.dead-end', severity: 'high' },
          { id: 'evil`@team\n### injected', rule: '<img src=x onerror=alert(1)>', severity: 'medium' },
        ],
        resolvedIssues: [
          { id: 'nav-old', rule: 'remote.wrap', severity: 'low' },
        ],
        transitionsChanged: [{
          key: 'home/play:RIGHT',
          before: {
            action: 'RIGHT',
            fromScreenKey: 'home',
            fromFocusKey: 'play',
            toScreenKey: 'home',
            toFocusKey: 'settings',
          },
          after: {
            action: 'RIGHT',
            fromScreenKey: 'home',
            fromFocusKey: 'play',
            toScreenKey: 'home',
            toFocusKey: 'profile',
          },
        }],
        latencyRegressions: [{ key: 'launch' }],
      },
    },
    artifact: 'tvdoctor-report-123-2',
  });

  assert.match(body, /^### TVDoctor regression check — FAILED/mu);
  assert.match(body, /Current findings: \*\*3\*\*/u);
  assert.match(body, /\*\*2 introduced\*\* · \*\*1 resolved\*\* · \*\*1 directional changes\*\*/u);
  assert.match(body, /\*\*1 latency regressions\*\*/u);
  assert.match(body, /Artifact: `tvdoctor-report-123-2`/u);
  assert.match(body, /\*\*Introduced findings\*\*[\s\S]*`nav-new` · `remote\.dead-end` · \*\*HIGH\*\*/u);
  assert.match(body, /\*\*Resolved findings\*\*[\s\S]*`nav-old` · `remote\.wrap` · \*\*LOW\*\*/u);
  assert.match(body, /\*\*Directional changes\*\*[\s\S]*`home\/play:RIGHT`/u);
  assert.match(body, /\*\*Next action:\*\* Review the introduced findings and navigation changes/u);
  assert.doesNotMatch(body, /SUMMARY_CANARY/u);
  assert.doesNotMatch(body, /@team|@summary-team/u);
  assert.doesNotMatch(body, /\n### injected/u);
  assert.ok(body.length <= 2_400, `comment should stay within bound, got ${body.length}`);
});

test('PR comment enriches introduced findings with exact replay and source correlation safely', () => {
  const sequence = [
    { key: 'RIGHT', repeat: 2 },
    { key: 'SELECT', repeat: 1 },
    { key: 'DOWN', repeat: 1 },
  ];
  const body = runActionCommentScenario({
    summary: '# TVDoctor CI: FAILED\n\nRun: **completed** · Policy: fail on **high** · Findings: **2**\n',
    comparisonJson: {
      schemaVersion: 'tvdoctor.comparison/v1',
      status: 'regressed',
      changes: {
        newIssues: [
          { id: 'NAV-1', rule: 'remote.reachability', severity: 'high' },
          { id: 'NAV-2', rule: 'remote.self-loop', severity: 'medium' },
        ],
        resolvedIssues: [],
        transitionsChanged: [],
        latencyRegressions: [],
      },
    },
    report: {
      schemaVersion: 'tvdoctor.report/v1',
      issues: [
        {
          id: 'NAV-1',
          confidence: 'deterministic',
          title: '<script>REPORT_TITLE_CANARY</script>',
          reproduction: {
            status: 'available',
            confidence: 'deterministic',
            originalSequence: sequence,
          },
        },
        {
          id: 'NAV-2',
          confidence: 'deterministic',
          reproduction: {
            status: 'available',
            confidence: 'deterministic',
            originalSequence: [{ key: 'LEFT', repeat: 1 }],
          },
        },
      ],
      artifacts: [],
      replays: [
        {
          schemaVersion: 'tvdoctor.replay/v1',
          issueId: 'NAV-1',
          steps: sequence,
        },
        {
          schemaVersion: 'tvdoctor.replay/v1',
          issueId: 'NAV-2',
          steps: [{ key: 'RIGHT', repeat: 1 }],
        },
      ],
    },
    sourceCorrelation: {
      schemaVersion: 'tvdoctor.source-correlation/v1',
      findings: [{
        issueId: 'NAV-1',
        identifiers: [{
          value: 'hero-watch',
          matches: [
            { path: 'src/@team/App.tsx', line: 12, column: 9, snippet: 'SOURCE_SNIPPET_CANARY' },
            { path: 'src/@team/App.tsx', line: 12, column: 99 },
            { path: 'C:\\private\\secret.ts', line: 1, column: 1 },
            { path: '/private/secret.ts', line: 2, column: 1 },
            { path: '../outside.ts', line: 3, column: 1 },
            { path: 'src/player.ts', line: 44, column: 7 },
            { path: 'src/third.ts', line: 55, column: 2 },
          ],
        }],
      }],
    },
  });

  assert.match(body, /`NAV-1` · `remote\.reachability` · \*\*HIGH\*\*[\s\S]*Sequence: `RIGHT × 2 → SELECT → DOWN`/u);
  assert.match(body, /Replay: `tvdoctor replay NAV-1 --report tvdoctor-report\/report\.json`/u);
  assert.match(body, /Source: `src\/＠team\/App\.tsx:12`, `src\/player\.ts:44`/u);
  assert.match(body, /`NAV-2` · `remote\.self-loop` · \*\*MEDIUM\*\*[\s\S]*Sequence: `LEFT`/u);
  assert.doesNotMatch(body, /tvdoctor replay NAV-2/u);
  assert.doesNotMatch(body, /src\/third\.ts|private\/secret|outside\.ts|REPORT_TITLE_CANARY|SOURCE_SNIPPET_CANARY|@team/u);
  assert.ok(body.length <= 2_400, `comment should stay within bound, got ${body.length}`);
});

test('PR comment ignores malformed and oversized enrichment artifacts without losing regression detail', () => {
  const comparisonJson = {
    schemaVersion: 'tvdoctor.comparison/v1',
    status: 'regressed',
    changes: {
      newIssues: [{ id: 'NAV-1', rule: 'remote.reachability', severity: 'high' }],
      resolvedIssues: [],
      transitionsChanged: [],
      latencyRegressions: [],
    },
  };
  const malformedBody = runActionCommentScenario({
    summary: '# TVDoctor CI: FAILED\n\nRun: **completed** · Policy: fail on **high** · Findings: **1**\n',
    comparisonJson,
    report: '{',
    sourceCorrelation: {
      schemaVersion: 'tvdoctor.source-correlation/v1',
      findings: {},
    },
  });
  const oversizedBody = runActionCommentScenario({
    summary: '# TVDoctor CI: FAILED\n\nRun: **completed** · Policy: fail on **high** · Findings: **1**\n',
    comparisonJson,
    report: 'x'.repeat((2 * 1024 * 1024) + 1),
    sourceCorrelation: 'y'.repeat((512 * 1024) + 1),
  });

  for (const body of [malformedBody, oversizedBody]) {
    assert.match(body, /`NAV-1` · `remote\.reachability` · \*\*HIGH\*\*/u);
    assert.doesNotMatch(body, /Sequence:|Replay:|Source:/u);
    assert.ok(body.length <= 2_400, `comment should stay within bound, got ${body.length}`);
  }
});

test('PR comment falls back to bounded comparison Markdown counts without copying raw bullets', () => {
  const body = runActionCommentScenario({
    summary: '# TVDoctor CI: PASSED\n\nRun: **completed** · Policy: fail on **high** · Findings: **0**\n',
    comparisonMarkdown: [
      '# TVDoctor Baseline Comparison',
      '',
      '- Status: **CHANGED**',
      '',
      '| Category | Count |',
      '| --- | ---: |',
      '| Introduced | 2 |',
      '| Resolved | 1 |',
      '| Unchanged | 4 |',
      '',
      '### Changed directional transitions',
      '',
      '- RAW_DIRECTION_CANARY @ops',
      '- <script>SECOND_DIRECTION_CANARY</script>',
      '',
      '### Changed other transitions',
      '',
      'None.',
    ].join('\n'),
  });

  assert.match(body, /^### TVDoctor regression check — PASSED/mu);
  assert.match(body, /Baseline comparison: \*\*CHANGED\*\* · \*\*2 introduced\*\* · \*\*1 resolved\*\* · \*\*2 directional changes\*\*/u);
  assert.match(body, /Artifact: `tvdoctor-report-123-2`/u);
  assert.doesNotMatch(body, /RAW_DIRECTION_CANARY|SECOND_DIRECTION_CANARY|@ops/u);
  assert.ok(body.length <= 2_400, `comment should stay within bound, got ${body.length}`);
});

test('PR comment drops oversized detail sections instead of failing the bounded comment', () => {
  const longIssue = (prefix) => ({
    id: `${prefix}-${'I'.repeat(1_000)}`,
    rule: `${prefix}.${'R'.repeat(1_000)}`,
    severity: 'high',
  });
  const longTransition = (index) => ({
    key: `transition-${index}-${'K'.repeat(1_000)}`,
    before: {
      action: 'LEFT',
      fromScreenKey: `before-from-${'A'.repeat(500)}`,
      fromFocusKey: `focus-${'B'.repeat(500)}`,
      toScreenKey: `before-to-${'C'.repeat(500)}`,
      toFocusKey: `focus-${'D'.repeat(500)}`,
    },
    after: {
      action: 'LEFT',
      fromScreenKey: `after-from-${'E'.repeat(500)}`,
      fromFocusKey: `focus-${'F'.repeat(500)}`,
      toScreenKey: `after-to-${'G'.repeat(500)}`,
      toFocusKey: `focus-${'H'.repeat(500)}`,
    },
  });
  const body = runActionCommentScenario({
    summary: '# TVDoctor CI: FAILED\n\nRun: **completed** · Policy: fail on **high** · Findings: **6**\n',
    comparisonJson: {
      schemaVersion: 'tvdoctor.comparison/v1',
      status: 'regressed',
      changes: {
        newIssues: [longIssue('new-1'), longIssue('new-2'), longIssue('new-3')],
        resolvedIssues: [longIssue('old-1'), longIssue('old-2'), longIssue('old-3')],
        transitionsChanged: [longTransition(1), longTransition(2)],
        latencyRegressions: [],
      },
    },
  });

  assert.match(body, /\*\*3 introduced\*\* · \*\*3 resolved\*\* · \*\*2 directional changes\*\*/u);
  assert.match(body, /Artifact: `tvdoctor-report-123-2`/u);
  assert.doesNotMatch(body, /\*\*Introduced findings\*\*/u);
  assert.ok(body.length <= 2_400, `comment should stay within bound, got ${body.length}`);
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
