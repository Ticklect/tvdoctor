# TVDoctor Product Hardening Phase 2 Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-30-product-hardening-phase-2-design.md`

**Goal:** Strengthen the existing TVDoctor product without replacing its proven audit, report, replay, baseline, packaging, or fail-closed contracts. Preserve `tvdoctor.report/v1` and `tvdoctor.replay/v1`; version navigation-graph serialization only if its closed vocabulary or shape must expand.

**Global constraints:** Work on the existing dirty tree. Do not reset, clean, push, publish, tag, create a GitHub Release, claim signing, or claim physical-device compatibility without named physical proof. Keep browser video opt-in, reports local-first, CI writes opt-in, and raw subprocess diagnostics private. Every behavior change uses RED → GREEN TDD.

## Task 1 — Reconcile upstream without losing the validated turnaround

**Files:** upstream-touched repository/config/docs only, especially `README.md`, `RELEASE.md`, `action.yml`, `package.json`, `packaging/windows/INSTALL.md`, `packages/core/src/explorer-runtime.ts`.

1. Verify the recovery snapshot contains HEAD/origin refs, tracked binary patch, and all untracked paths.
2. Temporarily stash only the five dirty paths that overlap `a4c5716 cleanup`; leave unrelated dirty/untracked work in place.
3. Merge `origin/main` locally without pushing. Resolve only overlap conflicts, preserving the validated local product behavior while taking compatible cleanup.
4. Restore the overlap stash and inspect every conflict/diff manually.
5. Run `git diff --check`, `npm run typecheck`, `npm run lint`, focused explorer tests, presentation tests, and package smoke if package/release wiring changed.

**Expected:** branch contains both `81f58fb` and `a4c5716`; no user files disappear; known demo/replay/doctor/package behavior remains green.

## Task 2 — Navigation analysis, shortest-known paths, and evidence-backed diagnostics

**Tests first:** `packages/core/test/navigation-diagnostics.test.ts`, a focused graph-analysis test file if cleaner, and `packages/cli/test/navigation-graph-output.test.ts`.

**Production:** `packages/core/src/navigation-diagnostic-contracts.ts`, `navigation-diagnostics.ts`, `navigation-focus-rules.ts`, `navigation-history-rules.ts`, new small analysis helpers, `navigation-focus-graph.ts`, `packages/core/src/index.ts`, `packages/cli/src/navigation-graph-output.ts`.

1. RED: shortest-known root-relative sequence is selected from verified observed paths, not merely first discovery order.
2. RED: coverage summary distinguishes observed screens/targets/transitions, locally complete states, and known deferred/unexpanded frontiers with termination reason.
3. GREEN: add pure graph-analysis helpers and export them.
4. RED/GREEN: directional asymmetry only when paired observed directional evidence is sufficient; do not infer a defect from geometry alone.
5. RED/GREEN: hidden/off-screen focused target requires explicit visibility/viewport evidence; refined lost/escaped focus and stale focus after route/screen change require deterministic observed contradictions.
6. RED/GREEN: cycle/path analysis reports observed cycles as analysis, not automatically as issues.
7. If serialized graph shape/problem kinds must expand, introduce `tvdoctor.navigation-focus-graph/v2`; keep v1 parser/output closed and unchanged.
8. Render shortest-known paths, coverage/frontier status, and cycle analysis in graph Markdown.
9. Run focused core/graph suites and core typecheck.

**Expected:** no heuristic geometry is promoted to deterministic failure, and “unexplored” means only known deferred/queued work from this run.

## Task 3 — Findings-first report/evidence presentation

**Tests first:** `packages/reporters/test/reporters.test.ts` plus focused inert-HTML/adversarial fixtures.

**Production:** `packages/reporters/src/render-helpers.ts`, `render-html.ts`, `render-markdown.ts`, `render-ci.ts`; CLI artifact links only where needed.

1. RED: HTML/Markdown lead with verdict, run completeness, navigation coverage, actionability counts, and one concrete next action.
2. RED: each finding contains `Expected`, `Observed`, `Why this matters`, and `Reproduce`; impact text is conservative and derived from rule/evidence, never invented product intent.
3. RED: compact input timeline is derived from stored reproduction sequence/assertion.
4. RED: existing before/after screenshots render adjacent to the relevant finding transition; graph/replay/supporting artifacts are linked.
5. GREEN: implement presentation helpers without changing report v1.
6. RED/GREEN: HTML remains escaped, self-contained, script-free, remote-content-free, and network-inert under adversarial target text/artifact names.
7. Run reporter tests and reporter package typecheck.

## Task 4 — Combined regression workflow and safe GitHub CI review output

**Tests first:** `packages/cli/test/cli.test.ts`, `packages/cli/test/node-baseline.test.ts`, `packages/baseline/test/baseline.test.ts`, presentation/action contract tests.

**Production:** `packages/cli/src/cli.ts`, `node-audit*.ts`, `node-baseline.ts`, `packages/baseline/*`, `action.yml`, `.github/workflows/ci.yml`, docs.

1. RED: `tvdoctor test URL --baseline PATH` and `tvdoctor ci URL --baseline PATH --fail-on LEVEL` run the normal bounded audit then compare using `@tvdoctor/baseline` only.
2. RED: comparison is fail-closed on partial run/inventory, incompatible target, or missing observability; baseline file is never mutated.
3. GREEN: write `baseline-comparison.json` and Markdown beside the normal report bundle and summarize introduced/resolved findings, focus changes, directional transition changes, latency regressions.
4. RED/GREEN: Action exposes report/JUnit/summary/comparison paths and emits a bounded GitHub job summary while preserving exit semantics.
5. RED/GREEN: PR commenting is explicit opt-in (`comment-on-pr`) with supplied token/permission; default path has no repository write. Validate any machine output before rendering a comment and cap content.
6. Ensure workflows never execute untrusted PR checkout with a write-capable token and do not use `pull_request_target` for it.
7. Run baseline, CLI, presentation/action tests and typecheck.

## Task 5 — Privacy command, screenshot suppression, strict share mode, and stronger redaction

**Tests first:** reporter security tests, CLI argument/product-flow tests, Android product tests, node audit hardening tests.

**Production:** `docs/privacy.md`, `packages/cli/src/cli.ts`, `node-audit-contracts.ts`, `node-audit-evidence.ts`, `node-audit-output.ts`, `node-audit-runner.ts`, Android report assembly, `packages/reporters/src/security.ts`, `report-builder.ts`, driver sanitizers where required.

1. RED/GREEN: `tvdoctor privacy` prints static version-controlled policy text covering local-first capture, artifact review, Android mutations, temp/output/uninstall retention, screenshots/logs/network/device/env/video sensitivity, and redaction limits.
2. RED/GREEN: `--no-screenshots` suppresses persisted PNG evidence while retaining only required in-memory state observations; report artifacts accurately say screenshots are unavailable rather than failed.
3. RED/GREEN: Android serial is not persisted in canonical public report target fields; local device selection remains explicit CLI input.
4. RED/GREEN: `--share-mode origin-only` rewrites public target identity consistently in JSON/Markdown/HTML; replay requires explicit `--target` when route reconstruction is no longer possible.
5. RED/GREEN: redact access/private-key forms, database URLs, PAT/credential-style names, and userinfo in non-HTTP credential URIs in addition to existing headers/tokens.
6. RED/GREEN adversarial coverage: Windows/Unix paths, shell/ADB diagnostics, HTML inertness, artifact confinement, and comparison rendering cannot leak raw private diagnostics through public surfaces.
7. Run focused security/CLI/Android suites, typecheck, and reporter tests.

## Task 6 — Opt-in browser video evidence

**Tests first:** CLI option tests, web-driver integration tests, node-audit hardening tests.

**Production:** `packages/cli/src/cli.ts`, node-audit driver creation/contracts, `packages/driver-web/src/types.ts`, `web-driver.ts` only as needed, report-bundle sidecar handling.

1. RED: default audit creates no video and retains current behavior.
2. RED: `--record-video` is accepted only for web audit surfaces, uses Playwright context recording, and confines output under the trusted report root.
3. GREEN: record one bounded audit-session video and expose it as an optional sibling evidence/link without widening report v1 artifact-kind enum.
4. RED/GREEN: unsupported Android video request is rejected/marked unavailable, never simulated; classification never depends on video.
5. RED/GREEN: regenerated HTML from canonical JSON alone remains valid when the optional sidecar link is absent.
6. Run web-driver integration, CLI focused tests, and typecheck.

## Task 7 — Windows installer ownership, uninstall stability, and release rehearsal

**Tests first:** `scripts/windows-installer-safety.test.ps1`, `scripts/test-github-release.ps1`, package-smoke/rehearsal tests.

**Production:** `packaging/windows/install.ps1`, `uninstall.ps1`, `INSTALL.md`, release scripts, package scripts/CI as needed.

1. RED/GREEN: installer refuses to overwrite an unrelated existing `tvdoctor.cmd`.
2. RED/GREEN: sentinel records actual command/launcher ownership and install metadata; update/reinstall is allowed only for installer-owned assets.
3. RED/GREEN: uninstall uses recorded launcher path and works when npm global prefix changes or npm is absent; unrelated launchers/caches/reports remain untouched.
4. RED/GREEN: prerequisite errors match Node/npm support ranges and PATH/command discovery is validated; post-install runs `--version` and `doctor`, with optional setup verification.
5. Add isolated-temp-root release rehearsal that builds/uses actual package artifacts and exercises offline `npx --no-install`, global shim, help/version/setup help/doctor/demo/saved replay/baseline create+compare, Windows install/reinstall/uninstall.
6. Add runtime-matrix wiring for Node 22.13/npm10, 22.13/npm11, 24/npm10, 24/npm11. Mark real website/physical Android `SKIPPED` when not configured.
7. Never publish, tag, sign, or create a release during rehearsal.
8. Run installer safety, release smoke/rehearsal, package smoke, and presentation tests.

## Task 8 — Physical-device proof aggregation and truthful compatibility evidence

**Tests first:** `scripts/physical-device-proof.test.mjs`.

**Production:** `scripts/run-physical-device-proof.mjs`, proof docs.

1. RED: proof output carries stable manufacturer, device/model, firmware, Android API, detected Android TV vs Fire TV, TVDoctor commit/version, APK hash, proof date/run status, report/proof hashes, and issue/action/screen/focus/transition counts.
2. RED: emulator evidence can never populate physical compatibility proof.
3. GREEN: aggregate bounded fields without depending on public report target location containing ADB serial.
4. RED/GREEN: when no real configured device exists, release rehearsal says physical proof was not run rather than fabricating compatibility.
5. Run device-proof tests and relevant Android focused tests.

## Task 9 — First-run/doctor polish and documentation reconciliation

**Tests first:** CLI/product-flow/diagnostics tests and repository-presentation tests.

**Production:** `packages/cli/src/cli.ts`, `diagnostics.ts`, `start.ts`, docs/README/RELEASE/action docs.

1. RED/GREEN: setup, demo, scan, replay, and baseline comparison expose deterministic phase/status lines and final summaries with actions/states/transitions/findings/report + replay/comparison next action.
2. RED/GREEN: doctor renders a compact Web / Android TV readiness matrix and exact remediation under blockers, readable without color and in CI logs.
3. Keep target URL/query/fragment/device data sanitized in terminal output.
4. Reconcile README/release/privacy/baseline/driver/limitations docs with final implemented behavior and explicit external-proof limits.
5. Run CLI focused tests and presentation suite.

## Task 10 — Full validation and final review

1. Run lint, typecheck, unit tests, reporter/CLI focused suites, web-driver integration, presentation, device-proof, package smoke, Windows installer/release rehearsal, build, deterministic demo/saved replay, controlled baseline compare, and `git diff --check`.
2. Exercise the four runtime matrix cells where local tooling can do so; record any genuinely unavailable matrix cell explicitly rather than implying proof.
3. Confirm external web/physical Android remain `SKIPPED` if their explicit inputs are absent.
4. Review the complete Phase 2 diff against the spec for Critical/Important security, fail-closed, schema-compatibility, privacy, installer ownership, and release-truthfulness regressions. Fix any Critical/Important finding RED → GREEN, then rerun affected + broad gates.
5. Report remaining external-only requirements honestly: hosted CI, physical named hardware, signing identity, publication.

**Completion contract:** no Critical/Important known regression, all locally applicable gates green, no publication/push/tag/release side effects, and unresolved external proof is explicitly named rather than claimed.
