# TVDoctor Product Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first TVDoctor experience navigation-first, deterministic to try, accurately diagnosed, installable from normal package artifacts, and consistent about what is verified versus merely observed.

**Architecture:** Keep the canonical protocol model stable. Add one shared derived actionability vocabulary in reporter helpers, make CLI/start flows consume navigation-first defaults, package a local Northstar activation fixture behind `tvdoctor demo`, make doctor surface-aware, and make clean tarball consumers exercise the same CLI users will receive. Keep all human/machine renderers on the same derived classification and coverage wording.

**Tech Stack:** TypeScript, Node.js, Vitest, existing CLI/reporters/protocol packages, Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-09-29-product-overhaul-design.md`

## Global Constraints

- `tvdoctor start` defaults to the navigation pack and never silently runs `all`.
- Missing or zero navigation coverage is never rendered as a clean navigation result.
- `VERIFIED` requires deterministic failure evidence plus a portable replay; otherwise use `REVIEW` or `UNTESTED`.
- Keep fail-closed exit semantics, redaction, existing report schema, Android behavior, and baseline behavior intact.
- No new runtime dependency or cloud service.
- `tvdoctor demo` must use packaged local assets plus the real web audit/replay
  path and fail if its expected seeded finding/replay proof disappears.
- `doctor` must report web and Android surface readiness independently; missing
  optional Android setup does not invalidate an otherwise ready web install.
- Package tarballs must be usable without monorepo/workspace resolution.
- Runtime support is widened only after compatibility tests prove the chosen
  Node/npm range.
- Every production behavior change gets a failing test before implementation.

## Review Focus

- A completed scan with zero navigation transitions must say coverage was unavailable, not “no navigation findings.” Test reporter wording.
- An issue with deterministic evidence but no portable replay must remain review-only. Test all renderers.
- Guided start must not select `all` even when the user chooses deep mode. Test the operation request.
- Non-interactive CLI progress must not leak credentials or full query/fragment data. Reuse existing URL sanitisation and test output.
- Existing partial/failed status must continue to control exit codes. Run CLI command tests.

### Task 1: Shared actionability and coverage language

**Files:**
- Modify: `packages/reporters/src/render-helpers.ts`
- Modify: `packages/reporters/src/render-html.ts`
- Modify: `packages/reporters/src/render-markdown.ts`
- Modify: `packages/reporters/src/render-ai.ts`
- Modify: `packages/reporters/src/render-ci.ts`
- Test: `packages/reporters/test/reporters.test.ts`

**Interfaces:**
- Add a shared derived classification type/function used by every renderer.
- Keep the canonical report object and wire format unchanged.

- [ ] **Step 1: Write failing tests** for: deterministic replay + failure evidence => `VERIFIED`; missing replay => `REVIEW`; unavailable/zero navigation transition coverage => explicit unavailable wording; HTML/Markdown/AI/CI use the same labels.
- [ ] **Step 2: Run the focused reporter tests and verify they fail for the missing behavior.**
- [ ] **Step 3: Implement the shared classification and coverage wording with no renderer-specific “fix now” exception.**
- [ ] **Step 4: Run the focused reporter tests and verify they pass.**
- [ ] **Step 5: Run the reporter package unit tests.**

### Task 2: Navigation-first CLI and guided start

**Files:**
- Modify: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/interactive.ts`
- Test: `packages/cli/test/product-flow.test.ts`
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Existing `TestCommandRequest`, `TestCommandResult`, and `ProgressRenderer` interfaces remain source-compatible.

- [ ] **Step 1: Write failing tests** asserting guided web scans request `packs: ["navigation"]`, quick/deep labels explain navigation, and progress/status output includes phase/coverage/next action without exposing query or fragment data.
- [ ] **Step 2: Run the focused CLI tests and verify the expected failures.**
- [ ] **Step 3: Implement navigation-first start behavior and clearer progress/status copy. Preserve all existing exit codes and cancellation behavior.**
- [ ] **Step 4: Run focused CLI tests and verify they pass.**
- [ ] **Step 5: Run the full CLI unit test set.**

### Task 3: First-run documentation and command surface

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/demo.md`
- Modify: `docs/limitations.md`
- Test: `scripts/repository-presentation.test.mjs`

**Interfaces:**
- Documentation must describe only commands and distribution paths that exist in the current repository.

- [ ] **Step 1: Add failing presentation assertions** for the one-command navigation-first path, explicit `all` wording, and the verified/review/untested result vocabulary.
- [ ] **Step 2: Run the presentation test and verify it fails before the copy changes.**
- [ ] **Step 3: Rewrite the first-run sections around the shortest supported path; keep advanced details below it.**
- [ ] **Step 4: Run presentation and package-smoke checks.**

### Task 4: Integrated verification and review

**Files:**
- No new production files; inspect all task diffs and generated outputs.

- [ ] **Step 1: Run lint, typecheck, reporter tests, CLI tests, presentation tests, package smoke, and the full project check.**
- [ ] **Step 2: Run a controlled fixture scan or existing integration gate and inspect the generated report's top-fold wording and coverage state.**
- [ ] **Step 3: Re-read the spec and review the whole diff for contradictions, stale copy, and regressions in fail-closed behavior.**
- [ ] **Step 4: Record any deferred minor issues explicitly; do not claim completion without fresh verification evidence.**

### Task 5: Deterministic installed-product demo

**Files:**
- Add/Modify: `packages/cli/src/demo.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json`
- Add/Modify: demo packaging preparation under `scripts/`
- Test: `packages/cli/test/cli.test.ts`
- Test: package/integration smoke scripts

- [ ] **Step 1: Write failing CLI tests** for `demo` help, deterministic expected-finding verification, replay reproduction, report/open behavior, and honest failure when the fixture/finding/replay is unavailable.
- [ ] **Step 2: Run focused tests and capture the expected red failures.**
- [ ] **Step 3: Package Northstar assets and implement the loopback demo runner using the normal web audit and replay operations.**
- [ ] **Step 4: Run focused tests, then execute the real demo from a clean packed consumer and inspect its HTML/JSON/replay artifacts.**

### Task 6: Surface-aware environment diagnosis

**Files:**
- Modify: `packages/cli/src/diagnostics.ts`
- Modify: `packages/cli/src/android-product.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: `packages/cli/test/cli.test.ts`
- Test: `packages/cli/test/product-flow.test.ts`

- [ ] **Step 1: Write failing doctor tests** for web-ready/Android-unconfigured, missing ADB, missing build-tools, unauthorized/offline/no device, non-TV device, and Observer/accessibility not-ready/ready states.
- [ ] **Step 2: Run focused tests and verify the missing diagnostics fail.**
- [ ] **Step 3: Implement reusable read-only Android prerequisite probes and render separate Web and Android TV readiness with exact remediation.**
- [ ] **Step 4: Run doctor tests and verify exit semantics do not punish web-only users for an optional Android setup.**

### Task 7: Npm-ready packaging and proven runtime range

**Files:**
- Modify: root and `packages/*/package.json`
- Modify: `packaging/windows/install.ps1`
- Modify: `packaging/windows/INSTALL.md`
- Modify: `scripts/package-smoke.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: release/package documentation as required

- [ ] **Step 1: Add failing package/presentation tests** for tarball demo assets, truthful package-smoke output, clean `npx --no-install`, global-prefix install, and the intended Node/npm range.
- [ ] **Step 2: Prove the oldest intended Node line locally where possible and add a hosted compatibility matrix so future changes cannot silently narrow support.**
- [ ] **Step 3: Update package engines/installer gates and package preparation so every public dependency resolves from registry-style tarballs, with no workspace-only assumptions.**
- [ ] **Step 4: Run `npm publish --dry-run` for every public workspace, package smoke, and clean tarball consumer checks without publishing anything.**

### Task 8: Contract reconciliation and final first-run pass

**Files:**
- Modify: CLI help and README/docs/release files implicated by the final behavior
- Test: CLI contract tests and `scripts/repository-presentation.test.mjs`

- [ ] **Step 1: Add failing assertions for `scan` quick defaults, `help scan`, `tvdoctor setup` remediation, exit-code wording, demo placement, current platform scope, and sample-report evidence.**
- [ ] **Step 2: Reconcile the command/help/docs contracts and add a sanitized sample report derived from the controlled fixture.**
- [ ] **Step 3: Run the complete verification set, then perform a new-developer review from clean package install through demo/report/replay.**
- [ ] **Step 4: Obtain an independent read-only review of the final diff and resolve Critical/Important findings before reporting completion.**
