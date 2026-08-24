# Release procedure

This checklist separates source quality, hosted proof, repository visibility, and
npm publication. None implies another. Record commands, exact commit SHA, run URL,
attempt number, exit code, and relevant artifact paths in the release issue.

## 1. Prepare the candidate

- [ ] Select the intended version and update package metadata, lockfile,
  `CHANGELOG.md`, compatibility statements, and supported-version policy.
- [ ] Confirm every publishable tarball contains its compiled entry points,
  declarations, `README.md` where applicable, `LICENSE`, and correct dependency
  ranges—without source-only tests, fixtures, credentials, or local paths.
- [ ] Confirm no generated report, screenshot, trace, package tarball, temporary
  consumer, or production-target evidence is tracked.
- [ ] Review `npm audit` and every accepted exception. A clean audit is useful
  evidence, not proof that application logic is secure.
- [ ] Decide whether repository visibility will change. Making a repository
  public is a separate, irreversible disclosure decision requiring an explicit
  owner review of the complete history and files.

## 2. Run the local clean gate

Start from a fresh clone or a verified clean worktree at the proposed commit:

```sh
npm ci
npx playwright install chromium
npm run check
npm run test:package-smoke
node examples/baseline-ci-example.mjs
npm audit
git status --short
```

- [ ] All commands pass on their first release-gate attempt.
- [ ] Playwright reports no focused or flaky tests.
- [ ] The exact CLI M7 integration produces a complete controlled run and checks
  the expected seeded findings, bundle formats, evidence, and replay behaviour.
- [ ] Package smoke builds all tarballs, installs them in a clean consumer, and
  exercises every public import plus `tvdoctor --help`, `--version`, and doctor.
- [ ] Report HTML is reviewed at desktop and narrow viewports; Markdown and JSON
  agree with the canonical findings and partial-run semantics.
- [ ] Browser/driver processes are gone and the working tree is clean.

## 3. Prove the exact hosted candidate

```sh
git rev-parse HEAD
git status --short
git rev-list --left-right --count origin/main...HEAD
```

- [ ] Push the reviewed commit without amending it afterward.
- [ ] The GitHub Actions **Aggregate release-candidate gate** passes at that exact
  SHA and attempt 1. A rerun must be investigated and cannot be called
  first-attempt reliability evidence.
- [ ] Record the workflow URL, run ID, attempt, runner OS, Node version, duration,
  and conclusion. Inspect uploaded artifacts on every failure.
- [ ] Confirm branch protection and repository visibility match the owner's
  intended release posture.

## 4. Publish only with explicit owner approval

- [ ] Verify npm account, organisation scope, 2FA/provenance policy, package names,
  access level, dist-tag, and release notes before any state-changing command.
- [ ] Run `npm publish --dry-run` for every package and compare its file list with
  the package-smoke inventory.
- [ ] Publish dependency packages before dependants, and publish the `tvdoctor`
  CLI last. Do not use an unreviewed blanket workspace publish command.
- [ ] Never print, store in the repository, or upload npm/GitHub tokens.
- [ ] Do not overwrite an existing version. If a published release is defective,
  stop, assess impact, and prefer a corrected patch plus deprecation notice over
  destructive registry actions.

This repository has no automatic publish job. Exact publish commands and access
flags are intentionally chosen by the authorised operator at release time.

## 5. Verify from the registry and close

In a new directory with an empty npm cache where practical:

```sh
npm init -y
npm install --save-dev tvdoctor@0.1.0
npx playwright install chromium
npx tvdoctor --version
npx tvdoctor --help
npx tvdoctor doctor
```

- [ ] Verify the installed version, dependency tree, executable, public imports,
  licence/readme links, and a bounded local-fixture audit/replay.
- [ ] Confirm npm package pages and repository links resolve without exposing a
  repository that was intended to remain private.
- [ ] Date the changelog, create an annotated `v0.1.0` tag at the proven SHA, and
  publish release notes that state Experimental/Beta boundaries plainly.
- [ ] Update `SECURITY.md` supported versions and record the private vulnerability
  reporting channel.
- [ ] Retain the final audit record and checksums, but do not publish sensitive
  target evidence.
