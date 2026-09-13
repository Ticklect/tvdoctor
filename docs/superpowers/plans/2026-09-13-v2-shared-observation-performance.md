# V2 Shared Observation Performance Implementation Plan

> Approved design: `docs/superpowers/specs/2026-09-13-v2-shared-observation-performance-design.md`

## Goal

Make TVDoctor materially faster without reducing APK, Android TV, or web coverage. Every optimization remains fail-closed and falls back to the existing conservative behavior when proof is unavailable or invalid.

## Execution rules

- Use TDD for every behavior change: failing test first, verify the expected failure, add minimal production code, then verify targeted and full gates.
- Keep `perf/tvdoctor-speed-pass` untouched; implement only on `perf/v2-shared-observation-architecture`.
- Do not lower Quick/Deep budgets, skip checks, weaken package/operator gates, or bypass observer/APK verification to obtain better timings.
- Preserve API 36 and packaged observer verification throughout.
- Treat the current signed protocol-v2 observer APK as an immutable compatibility artifact unless an exact matching protected build can be produced. Host-side incremental/V3-ready work must remain backward compatible with that artifact.

## Task 1 — Add the performance + coverage regression oracle first

**Files:**
- Create `packages/core/src/performance-regression.ts`
- Create `packages/core/test/performance-regression.test.ts`
- Modify `packages/core/src/index.ts`

**RED:** Add tests that compare deterministic exploration results by semantic screen/state fingerprints, findings, exclusions, completion status, remaining frontier, and restoration failures. Add a deterministic baseline-vs-optimized fixture assertion that rejects candidates which are faster only because coverage is lower.

**GREEN:** Implement a small coverage-signature builder and comparator plus performance metric extraction. Coverage is evaluated before performance. Do not use wall-clock thresholds in the hard gate; use deterministic operation counts and retain raw wall-time data for reports.

**Verify:** `npm run test:unit -- --run packages/core/test/performance-regression.test.ts`, then core unit suite, typecheck, lint.

## Task 2 — Driver-attested settled observations and shared observation contract

**Files:**
- Modify `packages/protocol/src/driver.ts`
- Modify protocol tests if needed
- Modify `packages/core/src/action-settling.ts`
- Modify `packages/core/test/explorer-hardening.test.ts`
- Create `packages/core/src/observation-store.ts`
- Create `packages/core/test/observation-store.test.ts`
- Modify `packages/core/src/index.ts`

**RED:** Prove that a post-action snapshot without explicit proof still uses conservative stable polling, while `driver-verified` proof returns the authoritative observation with zero extra snapshot polls. Prove observation-store isolation across preparation/session/version identity and capability mismatch.

**GREEN:** Add an additive `SettledObservationProof` to `ActionResult`; accept the fast path only when proof is explicit and a usable post-action snapshot is attached. Add a run-scoped shared observation store keyed by exact state + preparation/session + observation version. Missing capabilities cause a miss/enrichment request, never speculative reuse.

**Verify:** protocol/core targeted tests, then unit/typecheck/lint.

## Task 3 — Android and web drivers emit verified observations

**Files:**
- Modify `packages/driver-android/src/android-driver.ts`
- Modify `packages/driver-android/test/android-v2-driver.test.ts`
- Modify `packages/driver-web/src/web-driver.ts`
- Modify `packages/driver-web/test/driver.integration.spec.ts`

**RED:** Android test requires observer `settle_action` success to return `driver-verified` proof and confirms ambiguous/cross-package actions do not. Web integration test requires a settled key action to include one post-action snapshot/proof and a timed-out settle to omit proof.

**GREEN:** Android marks the observer's final settle snapshot as authoritative only on the existing successful observer path. Web captures one canonical navigation snapshot immediately after its existing settle boundary and attaches proof; it must avoid nested operation wrappers. The core fast path removes secondary polling while conservative fallback remains unchanged.

**Verify:** Android unit tests, real web driver integration, core hardening tests, then full unit/typecheck/lint.

## Task 4 — V3-ready incremental Android host projection with canonical checkpoints

**Files:**
- Create `packages/driver-android/src/incremental-tree.ts`
- Create `packages/driver-android/test/incremental-tree.test.ts`
- Modify `packages/driver-android/src/android-driver.ts`
- Modify `packages/driver-android/src/types.ts` metrics if needed
- Keep `packages/driver-android/src/observer-protocol.ts` protocol-v2 compatible unless the protected observer artifact is also updated and byte-verified.

**RED:** Tests require full-tree state to build a stable-id path index, lightweight unchanged-tree states to path-copy only affected focus branches, missing/stale focus identities to fail closed to full projection/resync, and reset/relaunch/observer reconnect to clear incremental state.

**GREEN:** Replace unconditional full recursive `withFocus` allocation for lightweight observer states with indexed path-copy projection. Retain full canonical rebuilding on tree change, launch/reset, observer reconnect, package/window change, ambiguity, and deterministic periodic revalidation. Expose counters for full vs lightweight projections.

**Verify:** Android driver tests, packaged observer/API36 tests, device-proof tests, unit/typecheck/lint.

## Task 5 — Verified reversible navigation

**Files:**
- Modify `packages/core/src/verified-path.ts`
- Modify `packages/core/test/verified-path.test.ts`
- Modify `packages/core/src/explorer-local-restoration.ts`
- Modify `packages/core/test/explorer-restoration-mode.test.ts`
- Modify exploration statistics if needed

**RED:** Tests require `A --RIGHT--> B` plus `B --LEFT--> A` before a pair is considered reversible; SELECT/BACK/HOME/media actions never qualify. Reversible restoration must be preferred where available, exact-match checked after execution, and revoked/fallen back on mismatch.

**GREEN:** Maintain session-scoped reversible proof for LEFT/RIGHT and UP/DOWN exact inverse pairs. Try a shortest reversible route before the generic verified path. On any mismatch revoke the optimization proof and use canonical root restoration while keeping the underlying observed directed graph intact.

**Verify:** verified-path/restoration tests, core suite, typecheck/lint.

## Task 6 — Adaptive Deep deterministic ordering

**Files:**
- Modify `packages/core/src/explorer-contracts.ts`
- Modify `packages/core/src/explorer-options.ts`
- Modify `packages/core/src/explorer-state.ts`
- Modify `packages/core/src/explorer-runtime.ts`
- Modify/add frontier/explorer tests

**RED:** Tests require Deep to prioritize new screens, modal/dialog states, media/player surfaces, non-repeated structures, then proven repetition work, with deterministic ties. Quick/legacy ordering must remain unchanged. With sufficient budget, baseline and adaptive Deep must yield equivalent coverage signatures.

**GREEN:** Add deterministic Deep-only semantic priority scoring from already-observed state. Do not use measured time. Do not introduce broader compression semantics in this task. Completion remains authoritative safe-frontier exhaustion; budget exhaustion with work remaining remains partial.

**Verify:** core unit/integration tests, performance/coverage gate, typecheck/lint.

## Task 7 — Integrated benchmark and APK/API36 release gate

**Files:**
- Add/update deterministic benchmark fixture tests/scripts using repository-owned fixtures
- Update CI only where needed so the regression oracle is part of normal PR checks
- Add a benchmark report under `docs/` with raw before/after metrics

**Coverage metrics:** wall time, physical actions, replay/restoration actions, root resets, settling polls, snapshots, states, screens, findings, remaining frontier, observer bytes/full states/lightweight updates, replay/restoration failures.

**Acceptance:**
- Same expected semantic coverage/findings on hard-gated fixtures.
- No new completion→partial regressions.
- No weakened APK/observer/package/security checks.
- API36 packaged observer gate green.
- Quick and Deep end-to-end fixture gates green.
- Full `npm run check` green.
- Only after coverage passes may the benchmark report claim measured performance improvements.

## Final verification

Run/obtain fresh evidence for build, lint, typecheck, repository presentation, device-proof, full unit suite, web driver integration, core integrations, report/replay integrations, streaming journey integration, exact CLI M7 integration, package-smoke/clean-consumer, and Android API36 packaged observer validation. Review the complete branch diff before considering merge or retargeting.
