# Android restoration product-value benchmark

## Verdict

Restoration materially increases Android TV traversal coverage, but this benchmark does not show a corresponding increase in useful defect discovery. Across the four primary matched app pairs, app-owned semantic states increased from 8 to 30 and app-owned screens from 5 to 22. The same runs increased wall time from 94.9 seconds to 606.2 seconds and physical actions from 5 to 148, while both modes produced zero findings.

The evidence supports restoration as a specialized coverage mechanism. It does not support treating restoration as a general defect-finding multiplier yet.

## Method

The benchmark compares two otherwise matched deep Android traversals:

- **Baseline:** exact verified-live-state continuation is allowed, but verified local-path reconstruction and root replay are disabled.
- **Restoration:** exact verified-live-state continuation, verified local-path reconstruction, and bounded root replay fallback are enabled.

APK, device, launch component, traversal policy, action budget, settling policy, detector set, and reporting configuration are matched within each pair. The primary set contains VLC 3.7.1, Moonlight 12.2, FLauncher 2025.07.001, and Nova 6.4.64. Moonlight was repeated with reversed run order to test order sensitivity.

The benchmark base was `f60c280ed7696339f6ac6d0df068230694a13313`. Its Android runtime packages are equivalent to restoration commit `8b24c1585e4130bfa69e51d0bac55d2db0ec2a78`; the later commit only adjusted Android CI/fixture verification.

Devices were Android API 36 Google TV emulators. VLC/Nova used emulator-5554 at 1920x1080, density 320. Moonlight/FLauncher used emulator-5556 at 1280x720, density 213. All runs reported build fingerprint `google/sdk_google_atv64_x86_64/emu64xa:16/BT2A.260319.001/15058170:user/dev-keys`.

## Primary results

| App | Raw states | App-owned states | Raw screens | App-owned screens | Max depth | Completed branches | Actions | Runtime | Findings |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| VLC 3.7.1 | 2 → 11 | 2 → 10 | 1 → 7 | 1 → 6 | 1 → 3 | 0 → 5 | 1 → 59 | 26.9 → 223.0 s | 0 → 0 |
| Moonlight 12.2 | 2 → 6 | 2 → 6 | 1 → 4 | 1 → 4 | 1 → 3 | 0 → 3 | 1 → 16 | 20.6 → 70.6 s | 0 → 0 |
| FLauncher 2025.07.001 | 2 → 3 | 2 → 2 | 2 → 3 | 2 → 2 | 1 → 1 | 0 → 1 | 2 → 15 | 23.1 → 60.8 s | 0 → 0 |
| Nova 6.4.64 | 2 → 13 | 2 → 12 | 1 → 11 | 1 → 10 | 1 → 3 | 0 → 5 | 1 → 58 | 24.3 → 251.8 s | 0 → 0 |

Primary aggregate:

| Metric | Baseline | Restoration | Delta |
|---|---:|---:|---:|
| Raw semantic states | 8 | 33 | +25 (+312.5%) |
| App-owned semantic states | 8 | 30 | +22 (+275%) |
| Raw screens | 5 | 25 | +20 (+400%) |
| App-owned screens | 5 | 22 | +17 (+340%) |
| Raw actionable-control tuples | 54 | 277 | +223 (+413%) |
| Completed branch expansions | 0 | 14 | +14 |
| Physical actions | 5 | 148 | +143 (29.6× total) |
| Wall runtime | 94.9 s | 606.2 s | +511.4 s; 6.39× total |
| Findings | 0 | 0 | 0 |
| Target-external transitions | 0 | 4 | +4 |

Three restoration-only state paths and three restoration-only screen paths are Play Store surfaces, not app-owned product coverage. Removing those surfaces changes the state result from 8→33 to 8→30 and the screen result from 5→25 to 5→22.

## Incremental useful findings

**Exact count: 0.**

No primary baseline run produced a finding and no restoration-enabled run produced a finding. There are therefore no restoration-exclusive findings to classify as actionable, duplicate, low-value, detector noise, or environment artifacts, and there is no valid `checkpoint → disruption → restoration → recovered branch → unique finding` chain to report.

This is the main product-value result. Restoration proved extra reach, but not extra defect yield in this sample.

## Coverage quality

VLC and Nova account for most app-owned expansion. Both move from shallow roots to multiple additional app-owned states and screens at depth three.

Moonlight also gains app-owned coverage and reproduces that coverage under reversed run order, but its raw control count is misleading as a product-value headline. In the first treatment run, 178 of 189 observed control tuples occur on HelpActivity. Excluding that Help surface leaves 11 treatment controls versus 3 baseline controls. Applying only that sensitivity adjustment to the aggregate changes the control headline from roughly 54→277 (+413%) to roughly 54→99 (+83%). Control identity also includes stable ID base, role, name, and text, so label variants can count separately.

FLauncher is the clearest weak-value case: its only additional raw state/screen is a Play Store surface. Restoration exercises more transitions, but does not expand app-owned state/screen coverage in this run.

## Reproducibility and nondeterminism

Moonlight was run twice with reversed order:

| Trial | Order | Treatment states | Screens | Tested transitions | Controls | Treatment runtime | Terminal failure |
|---|---|---:|---:|---:|---:|---:|---|
| T1 | restoration → baseline | 6 | 4 | 11 | 189 | 70.6 s | replay-diverged |
| T2 | baseline → restoration | 6 | 4 | 11 | 188 | 76.6 s | settling-exhausted |

The two treatment runs have state-path Jaccard 1.000, transition-path Jaccard 1.000, and control-set Jaccard 0.9842. Treatment wall time differs by 8.4%. Coverage shape is reproducible across order reversal; the final dynamic failure mode is not.

The other three apps have one matched pair each, so order/carry-over effects are not estimated for those apps.

## Restoration cost and instability

Treatment reset time totals 313.5 seconds and replay time totals 81.1 seconds. Together they represent 394.6 seconds, or 65.1% of treatment wall runtime. Restoration also adds 60 replay actions in the primary set.

All primary treatment runs end partial rather than fully exhausted: VLC, FLauncher, and Nova end on replay divergence; Moonlight T1 ends on replay divergence and Moonlight T2 ends on settling exhaustion. This limits claims about eventual full-graph coverage.

The treatment recorded four target-external transitions. Three unique restoration-only state/screen paths were Play Store surfaces. These are coverage side effects and are not counted as product defects.

Crash count was not collected by these runs (`appCrashCountStatus: not-collected`), so the benchmark cannot compare crash incidence.

## Causal attribution

The treatment clearly enables the traversal to continue after the baseline can no longer reconstruct queued branches. However, individual successful restoration cycles cannot be claimed as the direct cause of each later unique state.

The revised analyzer therefore reports unique successful restored destinations that are **associated** with later new coverage, rather than a per-cycle causal contribution rate. In the current primary data, 15 unique restored destinations are associated with later new coverage. That association is useful navigation evidence, but it is not equivalent to proving that each individual restoration operation caused a distinct new state.

Of the 88 successful continuation cycles in the earlier cycle-level accounting, 40 are verified-live-state reuse and 48 use local reconstruction or root replay. The report does not describe all 88 as restoration operations that created new coverage.

## Experimental integrity and provenance

The analyzer validates target package, mode, device, SDK, emulator fingerprint, display geometry, APK path, launch component, Git HEAD, exact root state fingerprint, exact root focus fingerprint, root location, and configured pair order.

The existing real-app runs predate the new source/APK/build hashing fields, so each pair carries explicit integrity warnings for missing APK SHA-256 and runtime source/build hashes. The matched runs still agree on the recorded commit, APK path, environment, launch component, and exact root state. Future reruns rebuild the CLI runtime before execution and record APK SHA-256, runtime-source SHA-256, built-runtime SHA-256, and scoped Git dirty state.

## Benchmark instrumentation

The benchmark adds:

- a narrow `verified-live-only` explorer mode that preserves exact live-state continuation while disabling path reconstruction and root replay;
- an internal Android benchmark scan entry point, intentionally omitted from the package root API;
- structured per-run Android restoration product-value evidence;
- a reproducible runner for the four canonical APKs;
- an analyzer with matched-pair integrity checks and machine-readable output.

The baseline is intentionally not handicapped beyond removing the reconstruction capability being evaluated.

## Evidence artifacts

- `Tests/real-apps-2026-09-19/android-restoration-product-value.config.json`
- `Tests/real-apps-2026-09-19/android-restoration-product-value.results.json`
- `Tests/real-apps-2026-09-19/android/restoration-value-benchmark/`
- `scripts/run-android-restoration-product-value.mjs`
- `scripts/analyze-restoration-product-value-benchmark.mjs`

Each run directory contains the normal TVDoctor report, Android exploration data, coverage ledger, screenshots, logcat, benchmark evidence, and run metadata.

## Limitations

- Four primary apps is a small sample.
- Only Moonlight is counterbalanced and repeated.
- All treatment traversals are partial.
- Existing run bundles lack the provenance hashes added after the runs.
- Crash incidence was not collected.
- The sample produced zero detector findings, so it cannot estimate recall, false-positive rate, or useful findings per restoration cycle.
- Raw control counts are sensitive to dense/help content and control identity details.
- System-surface transitions can inflate raw coverage unless app ownership is separated.

## Decision

**Narrow restoration to specific app/surface classes.**

The current data shows clear coverage value on VLC, Nova, and Moonlight, little app-owned value on FLauncher, high runtime/action cost, and zero demonstrated finding yield. Continuing broad reliability investment before proving defect-yield benefit would be poorly justified.

## Confidence

**Moderate overall.** Confidence is high that restoration expands reachable coverage in this four-app sample, moderate that the matched treatment is the run-level cause of that expansion, and low that the extra coverage improves defect discovery because no run produced a finding.

## Single next highest-value experiment

Run one counterbalanced, equal-wall-clock benchmark over 8–12 Android TV apps with pre-validated deep defects or deliberately seeded detector-visible defects located behind at least two navigation steps. Reset app state between runs, reverse pair order across apps, and use **incremental app-owned human-reviewed useful findings per minute** as the primary endpoint. App-owned state/screen gain should remain a secondary coverage metric.

That experiment directly tests the missing question: whether restoration converts extra reach into useful defect recall at an acceptable cost.

## Verification

Final verification on the isolated benchmark worktree:

- `npm test --workspace @tvdoctor/core` — **198/198 passed**
- `npm test --workspace tvdoctor` — **181/181 passed**
- `npm test --workspace @tvdoctor/driver-android` — **76/76 passed**
- `npm test --workspace @tvdoctor/broken-android-tv` — **7/7 passed**
- `npm run typecheck` — passed
- `npm run lint` — passed after replacing one benchmark-script control-character regex rejected by ESLint; no product/runtime defect was involved
- `npm run build:packages` — passed
- `git diff --check` — passed
- `npm run test:core-integration` — **11/11 passed**, including the 240-card carousel benchmark
- `npm run test:integration --workspace @tvdoctor/reporters` — **1/1 passed**; the previously known milestone5 reporter mismatch did not reproduce on this snapshot and its assertion was not modified
- `npm run build --workspace @tvdoctor/broken-android-tv` — passed; APK 21,106 bytes, SHA-256 `e35bc2dcc3bd83be5350fd38b50874813e868924003fa5783b3fcff07bfdec97`
- `npm run verify:recreation --workspace @tvdoctor/broken-android-tv -- --device emulator-5556` — passed; same PID `26469`, Activity instance 1 destroyed, instance 2 created/restored, focus restored, RIGHT/LEFT replay succeeded
- `node --check scripts/run-android-restoration-product-value.mjs` — passed
- `node --check scripts/analyze-restoration-product-value-benchmark.mjs` — passed
- analyzer rerun over all five paired trials — passed; **0 incremental useful findings**, +25 raw semantic states, +223 raw actionable-control tuples

The first recreation-verifier attempt failed before execution because the isolated worktree did not yet contain the built fixture APK. Building the fixture and rerunning produced the passing result above.

The previously reported reporter integration mismatch at `packages/reporters/integration/milestone5.integration.spec.ts:960` is unrelated to this benchmark. It was not modified, and the reporter integration passed on this final snapshot.
