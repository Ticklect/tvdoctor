# Android TV restoration follow-up — 2026-09-19

This follow-up continues the Android traversal/restoration investigation against the current dirty `main` tree. It focuses on state reconstruction across relaunch, process/window replacement, and slow lifecycle transitions. Generated real-app bundles remain under sibling `android/` directories as evidence.

## Executive result

Android restoration is materially more robust, but it is not treated as solved. Across the strongest current VLC, Moonlight, FLauncher, and Nova scans, **88 of 92 restoration cycles succeed (95.65%)**. Strategy attempts are lower at **88 of 126 (69.84%)** because a failed verified-local attempt often falls through to a successful root replay in the same cycle.

A further TVDoctor defect was found here: a key can be physically delivered while the Android observer's first settle window expires, producing protocol outcome `inconclusive`. Core `stable-snapshot` settling rejected that result before using its configured canonical-snapshot readiness proof. Moonlight exposed this on the Help transition. Core now performs the existing bounded stable-snapshot proof after a delivered `inconclusive` result and promotes it to `applied` only after the required equivalent snapshots converge. If they do not converge, it still fails closed. **No timeout was increased and no identity rule was relaxed.**

The remaining terminal failures are a mixture of real application/lifecycle reconstruction divergence and timing/nondeterminism on a heavy dynamic surface. Current evidence does not justify more identity normalization.

## Implementation changes

### Android root restoration and replay

Android DEEP traversal previously selected verified-local restoration while disabling root fallback, and its root hook returned a snapshot without restoring the root. The Android product path now reuses the verified prepared root once, then uses `driver.reset("relaunch")`, reacquires and package-verifies a fresh snapshot, enables bounded root fallback, and allows only host-approved replay actions (`UP/DOWN/LEFT/RIGHT` and policy-approved `SELECT`). Every replay checkpoint remains strict.

The verified post-setup snapshot is promoted to the prepared root so restoration does not compare against stale onboarding/permission state.

### Structured restoration diagnostics

New `packages/core/src/explorer-restoration-diagnostics.ts` plus core/CLI changes retain bounded deterministic evidence for:
- scan/package, depth, attempt, retry and restoration-cycle number;
- prior successes in the traversal and bounded replay history;
- expected/before/restored state identity;
- process ID/generation, activity, root/window identity/generation where observable;
- current focus stable ID and ancestry/path;
- visible/actionable/navigation fingerprints and counts;
- exact identity/structural/lifecycle dimensions that differ;
- subtype, rejection reason, taxonomy, observed-surface equivalence, behavioral equivalence and material traversal impact.

Two diagnostic correctness gaps were fixed during this continuation: `root-fallback-disabled` now emits a failed root-replay diagnostic, and retry/strategy-attempt ordinal summaries now use the per-destination/per-strategy retry number instead of global diagnostic position.

Generic accessibility snapshots still cannot observe same-class Activity instance generation. Process generation comes from the most recent launch/reset metadata, so an unexpected process replacement between explicit metadata refreshes can remain temporarily unobserved. That limitation is reported rather than normalized away.

The strongest real-app bundles below were captured before the final cached-process-identity reporting refinement. That refinement does not change traversal/replay/settling behavior or root-replay recovery counts; it only changes unverifiable verified-local continuity from an asserted value to `null` and marks aggregate process-identity evidence as partial when appropriate. The app scans were therefore not repeated solely to regenerate that conservative metadata field.

### Stable-snapshot recovery after delivered but inconclusive input

The protocol explicitly defines `inconclusive` as input that **was delivered** while settling evidence stayed unavailable. Before this fix, `pressAndObserve()` rejected/returned before stable-snapshot polling could run.

The core now keeps immediate failure for `failed`, keeps conservative `driver`-strategy behavior, and for `stable-snapshot` continues the already-configured bounded canonical polling. It changes the outcome to `applied` only if the required consecutive equivalent snapshots are observed. No arbitrary sleep or larger bound was added.

A new explorer-hardening regression returns `inconclusive`, then one transient and two equivalent stable snapshots; recovery succeeds only after convergence.

### Controlled same-process Activity recreation

`fixtures/broken-android-tv` now exposes `Recreate Activity`, which directly calls `Activity.recreate()` in `org.tvdoctor.fixture`. The fixture records Activity instance sequence/PID/package, carries a saved recreation marker, restores Focus Probe, and exposes a completion marker. Its runtime verifier requires instance 1 destruction, restored instance 2 creation, the same PID/package, Focus Probe focus, and working RIGHT/LEFT replay after recreation. This is direct same-package Activity recreation, not an inference from labels.

## Historical comparison

These are coverage anchors, not like-for-like benchmarks: later builds execute more actions, use different restoration layers, and may stop at deeper checkpoints.

| App | Earlier restoration evidence | Strongest final evidence | Comparison |
| --- | --- | --- | --- |
| VLC | 24 actions / 19 transitions; 19/26 strategies | 59 actions; 35/50 strategies; 35/36 cycles | Much deeper traversal; final failure is an explicit depth-3 permission/navigation-state change |
| Moonlight | 22 actions / 13 transitions; 13/19 strategies | final A/B: 16 actions / 11 transitions; 11/15 strategies; 11/12 cycles | Not apples-to-apples: final build captures HelpActivity and then fails on Help reconstruction/stabilization rather than failing to reach Help |
| FLauncher | 6 actions / 5 transitions; 5/7 strategies | 15 actions; 13/16 strategies; 13/14 cycles | Repeated restoration now continues until a deterministic structural replay divergence |
| Nova | 7 actions / 6 transitions; 6/11 strategies | 57 actions / 29 transitions; 29/45 strategies; 29/30 cycles | Much deeper traversal; terminal mismatch is a concrete grid/header Activity change |

## Strongest real-app evidence

Strategy attempts and restoration cycles are intentionally separate: a local-path miss can be followed by successful root replay inside one successful cycle.

| App / strongest run | Physical actions | Navigation transitions | Strategy success | Cycle success | Deepest restored checkpoint | Terminal class |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| VLC 3.7.1 — `vlc-3.7.1-restoration-artifactfix-5554` | 59 | 35 completion / 27 semantic graph | 35/50 (70.00%) | 35/36 (97.22%) | 2 | genuine navigation-state change |
| Moonlight 12.2 A — `moonlight-12.2-restoration-stable-recovery-5556-a` | 16 | 11 | 11/15 (73.33%) | 11/12 (91.67%) | 2 | structurally meaningful Help divergence |
| FLauncher 2025.07.001 — `flauncher-2025.07.001-restoration-postsettle-5556-a` | 15 | 13 completion / 5 semantic graph | 13/16 (81.25%) | 13/14 (92.86%) | 0 | structurally meaningful divergence |
| Nova 6.4.64 — `nova-6.4.64-restoration-artifactfix-5554` | 57 | 29 | 29/45 (64.44%) | 29/30 (96.67%) | 2 | genuine navigation-state change |

Moonlight A is used for aggregate taxonomy arithmetic below. Moonlight B has the same top-line actions/restoration metrics but replaces the terminal structural class with `asynchronous-ui-timing-or-timeout`.

### VLC

VLC uses 50 strategies across 36 cycles: live 15/15, local 6/20, root replay 14/15; cycle success 35/36. Depth is d0 13/13, d1 12/12, d2 10/10, d3 0/1.

The terminal depth-3 replay `[DOWN, RIGHT, SELECT]` expects `VerticalGridActivity` / `displayButton`; reconstruction reaches a permission `BottomSheetDialog` / `permission_title`. Location, focus, visible/actionable/navigation structure and lifecycle/root identity all differ. This is a concrete app/system navigation-state change, not transient identity noise.

The user-supplied anchor was 19/26 strategy successes. Current 35/50 is **not apples-to-apples**: the scan executes much more work and attempts a deeper checkpoint.

### Moonlight

Earlier post-settle A/B runs stopped before a settled Help checkpoint: 13 physical actions, 9 transitions, 10/12 successful strategies, 10/10 cycles, deepest restore 1, terminal `settling-exhausted`. The missing action was `SELECT` on `com.limelight:id/helpButton`; WebView initialization and multi-second main-thread/HWUI churn followed. That exposed the core settling defect above.

After the fix, final A/B runs both:
- execute 16 physical actions and record 11 semantic transitions;
- record Help-button `SELECT` into `com.limelight.HelpActivity` as applied;
- perform 15 strategy attempts: 11 success / 4 fail;
- perform 12 cycles: 11 success / 1 fail;
- restore d0 2/2, d1 8/8, d2 1/2, deepest 2;
- recover after process replacement twice and root/window replacement four times.

A/B share 9 of 13 union transition keys: **Jaccard 9/13 = 0.6923**. Each has two unique keys, both around Help `SELECT`/`UP`, localizing nondeterminism to the dynamic Help surface.

Run A reconstructs `HelpActivity` but the replayed Help DOM/root/focus checkpoint is materially different: `structurally-meaningful-divergence`. Run B reconstructs the exact expected Help semantic checkpoint but cannot finish bounded settling: `asynchronous-ui-timing-or-timeout`.

The user-supplied historical anchor was 13/19 strategy successes. Final 11/15 has a different stopping boundary and explores the newly captured Help surface, so the percentages are not directly comparable. The correctness improvement is that TVDoctor now reaches and records Help before failing closed on its dynamic reconstruction.

### FLauncher

Post-settle A/B have transition-key Jaccard **1.000** for the observed window. The canonical run uses 16 strategies (13 success) across 14 cycles (13 success), depth d0 13/13 and d1 0/1.

The final `DOWN` replay remains in `MainActivity` and retains the same focus fingerprint, but the focused stable ID changes and actionable/navigation structure changes from 12 to 11 actionable nodes. Actionable and navigation fingerprints differ. A/B reproduce the same semantic shape. This is strong evidence **against** identity relaxation.

### Nova

Nova uses 45 strategies across 30 cycles: live 7/7, local 6/21, root replay 16/17; cycle success 29/30. Depth is d0 5/5, d1 12/12, d2 12/13.

Final `[RIGHT, SELECT]` expects `MoviesByGenreActivity` / `browse_headers` but reconstructs `AllMoviesGridActivity` / `browse_grid`, with different visible/actionable/navigation structure. This is a genuine application navigation-state change.

## Aggregate restoration resilience

Using VLC artifactfix, Moonlight final A, FLauncher postsettle A, and Nova artifactfix:

- strategy attempts: **126 total, 88 successes, 38 failures (69.84%)**;
- restoration cycles: **92 total, 88 successes, 4 failures (95.65%)**;
- cycle ordinal: first **4/4**, second **4/4**, third-and-later **80/84**;
- depth 0: **33/33**;
- depth 1: **32/33**;
- depth 2: **23/25**;
- depth 3: **0/1**;
- deepest successful restored checkpoint: **2**;
- maximum successful restorations in one traversal: **35** (VLC);
- scans with multiple successful restorations: **4/4**;
- observed successful process-replacement recoveries: **34**;
- observed successful root/window-replacement recoveries: **77**.

Real-app Activity-instance recovery is not counted because same-class Activity instance generation is not observable in the generic snapshot. The controlled fixture directly proves same-process `Activity.recreate()` recovery and post-recreation RIGHT/LEFT replay.

### Failure taxonomy

For canonical-A arithmetic, the 38 failed **strategy attempts** classify as:

| Taxonomy | Count | Evidence |
| --- | ---: | --- |
| `state-not-found` | 33 | Mostly local-path misses that can fall through to another strategy |
| `genuine-navigation-state-change` | 2 | VLC permission surface; Nova grid/header Activity divergence |
| `structurally-meaningful-divergence` | 3 | FLauncher structural records plus Moonlight A final Help divergence |

Moonlight B substitutes its one final structural divergence with one `asynchronous-ui-timing-or-timeout`. All other top-line metrics are identical.

A failed strategy is not automatically a failed restoration cycle; 38 failed strategy records coexist with only four failed cycles.

## Identity normalization decision

**No identity normalization was added. No semantic fingerprint field was relaxed.**

Further relaxation is not justified:
- FLauncher changes actionable/navigation structure and node count.
- VLC reconstructs a different permission/navigation surface.
- Nova reconstructs a different Activity and grid/header navigation surface.
- Moonlight A reconstructs materially different Help structure; B shows a timing variant on the same dynamic surface.

An earlier Moonlight local-path mismatch with identical actionable/navigation fingerprints did not prove subsequent reachability or behavior equivalence, so it was not normalized.

## Repeatability

Transition-key Jaccard uses the semantic navigation key in `navigation-graph.json`.

| Pair | A keys | B keys | Intersection | Union | Jaccard | Interpretation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| FLauncher postsettle A/B | 5 | 5 | 5 | 5 | **1.000** | Deterministic for observed coverage |
| Moonlight final stable-recovery A/B | 11 | 11 | 9 | 13 | **0.6923** | Common graph plus Help-surface-specific keys |
| VLC prior finaldiag A/B | 27 | 27 | 27 | 27 | **1.000** | Stable semantic coverage before the artifact-persistence-only rerun |
| Kodi earlier quick restoration A/B | 4 | 4 | 4 | 4 | **1.000** | Control evidence retained from earlier follow-up |

A lower Jaccard on partial scans is not by itself a correctness failure. Moonlight's differing keys match the structural-vs-timing evidence on the Help surface.

## Controlled regression coverage

The controlled suite covers:
- same-process direct `Activity.recreate()`;
- different root/window and lifecycle generations;
- focus changes while actionable structure is equivalent;
- transient lifecycle identity differences without broad semantic normalization;
- genuinely different navigation states remaining distinct;
- repeated restorations and third-plus cycles;
- deeper checkpoints;
- fresh accessibility/root acquisition after recreation/reset;
- replay after lifecycle/process/window generation changes;
- bounded recovery after delivered-but-inconclusive input when canonical snapshots later converge.

Both directions remain enforced: justified reconstruction can recover; materially different navigation remains distinct.

## Verification

Final work-affected validation on the frozen source tree:

- `npm test --workspace @tvdoctor/core` — **198/198 passed**.
- `npm test --workspace tvdoctor` — **192/192 passed**.
- `npm test --workspace @tvdoctor/driver-android` — **77/77 passed**.
- `npm test --workspace @tvdoctor/broken-android-tv` — **6/6 passed**.
- `npm run typecheck` — **passed**.
- `npm run lint` — **passed**.
- `npm run build:packages` — **passed**.
- `git diff --check` — **passed**; only Windows LF→CRLF warnings were emitted.
- `npm run verify:recreation --workspace @tvdoctor/broken-android-tv -- --device emulator-5556` — **passed**; PID **21939** remained constant, Activity instance 1 was destroyed, restored instance 2 was created, focus returned, and RIGHT/LEFT replay succeeded.
- Real-app final evidence was collected for VLC, Moonlight, FLauncher and Nova from the paths below.

Core Playwright integration is kept as a separate gate because it includes the long 240-card benchmark.

The earlier repository-wide `npm run test` chain passed its unit, broken-web fixture, web-driver, and core Playwright stages, then failed only in the already-dirty reporter integration at `packages/reporters/integration/milestone5.integration.spec.ts:960`. That test expects `## Required Behaviour`, while the current renderer emits the newer heading structure (`Objective`, `Verified Failure`, `Current Behaviour`, `Reference behavior`, and others). The failure reproduced on retry. This Android restoration work does not change that assertion or renderer.

Final evidence paths:
- `Tests/real-apps-2026-09-19/android/vlc-3.7.1-restoration-artifactfix-5554`
- `Tests/real-apps-2026-09-19/android/moonlight-12.2-restoration-stable-recovery-5556-a`
- `Tests/real-apps-2026-09-19/android/moonlight-12.2-restoration-stable-recovery-5556-b`
- `Tests/real-apps-2026-09-19/android/flauncher-2025.07.001-restoration-postsettle-5556-a`
- `Tests/real-apps-2026-09-19/android/flauncher-2025.07.001-restoration-postsettle-5556-b`
- `Tests/real-apps-2026-09-19/android/nova-6.4.64-restoration-artifactfix-5554`

## Focused commit scope

The intended commit contains only restoration/replay/lifecycle work:
- core settling, restoration contracts/options/runtime/local/root replay and diagnostics;
- focused restoration/hardening tests;
- Android product root-restoration/evidence hunks and focused CLI tests;
- Android driver lifecycle restoration-context hunks and their focused tests;
- broken Android TV Activity-recreation fixture/verifier;
- this evidence report.

The shared working tree contains unrelated documentation, navigation-graph, baseline, reporter, CLI and driver work. Those changes are intentionally excluded.

## Remaining risk and next step

The highest-priority remaining risk is **asynchronous lifecycle reconstruction on dynamic surfaces**. Moonlight Help can reconstruct to a materially different DOM/focus state or reach the expected checkpoint but remain unsettled within the existing bound. This is application/lifecycle timing evidence, not a reason to accept states as equivalent.

A secondary observability limitation is that generic accessibility snapshots cannot identify same-class Activity instance generation, and cached process metadata can miss an unexpected process replacement until explicit refresh.

Restoration is stable enough to begin measuring whether recovered depth produces product value while retaining these cases as hard/partial boundaries. The next measurement should quantify unique reachable states/issues gained from repeated restoration rather than chase a nominal 100% restoration percentage.
