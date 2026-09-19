# Northstar traversal and detector improvement follow-up

Date: 2026-09-19

## Decision

Traversal remains the primary bottleneck.

The milestone target was reached without Northstar-specific production logic: restoration recall improved from **1/5 (20%)** to **3/5 (60%)**, deep-defect recall improved from **1/4 (25%)** to **3/4 (75%)**, and strict rule-matched precision improved from **1 TP / 7 scoped reports = 14.3%** to **3 TP / 4 scoped reports = 75%**. Both counterbalanced final treatment runs produced the same 3 true positives, one strict false positive, 41 states, 9 screens, depth 12, 439 physical actions, and 221 replay actions.

The remaining strict false positive is not a spurious bug target: `remote.reachability|player-volume-boost` points at the separate intentional seed `fixture-player-volume-pointer-only`, whose manifest rule is `accessibility.pointer-only-control`. Strict benchmark scoring therefore remains 75%, while all **4/4 emitted findings correspond to intentional seeded-defect targets**.

## Provenance and integrity

- Starting repository commit: `dbfd7b10b6f706b137e1a181cb9ebe5860a04763` (`bench(web): measure Northstar seeded defect recall`).
- Prior benchmark product-source commit locked by the original config: `f90c006c127d206921ef26c961a34328339836ef`.
- Traversal/detector implementation commit: `fabc17582f2cafc571492af1ee02a3bfd0720e9f`.
- Final modal-Back precision commit benchmarked here: `610144eeb5c77de13b0f8f1d127d667df2f3dac7`.
- Frozen ground-truth manifest SHA-256: `a189bd7e4f2686cddb1b2c53d1dca161e6344dd81b4a6911531640291971804e`.
- Frozen fixture runtime SHA-256: `93ed6dfcd4cbd60eb10a61e5c6a02cc0197b3ccbfad634af31ae0bda9e15582c` (unchanged from the prior benchmark).
- Target: `http://127.0.0.1:4182/`.
- Wall-clock cap: 120,000 ms per arm.
- Profile/action policy: `deep` / `production-safe-web-navigation`.
- Baseline restoration mode: `verified-live-only`.
- Treatment restoration mode: `verified-local`.
- Final analyzer pair integrity: **valid**.

The Vite dev server's transformed `/src/main.ts` and `/src/styles.css` bytes are checkout-path-sensitive, so the original h1/h2 served-resource/document hashes could not be reproduced from the surviving clean worktrees despite identical fixture source bytes. The follow-up config locks the follow-up served hashes (`1f6bf5...` resource, `7fd50e...` document) and retains the unchanged frozen fixture-source and manifest hashes. This is a reproducibility limitation of the old dev-resource fingerprint, not a fixture-source change.

## Profiling: where the original 120 seconds went

The two canonical prior treatment runs (`h1`, `h2`) averaged:

| Metric | Prior restoration |
| --- | ---: |
| Wall runtime | 120.016 s |
| Physical actions | 676.5 |
| Exploration actions | 229 |
| Replay actions | 447.5 |
| Reset count | 103.5 |
| Reset time | 20.761 s |
| Replay time | 70.084 s |
| Reset + replay | **90.846 s (75.7%)** |
| Residual non-restoration wall time | ~29.170 s |
| Novel-state-producing actions | 49.5 |
| Duplicate-state actions | 179.5 |
| Self-loop actions | 84.5 |
| Known non-self destinations | 95 |
| Novel-state rate | ~24.75/min |
| Novel-screen rate | ~4.00/min |
| Mean states/screens | 50.5 / 9 |
| Mean max depth | 6.5 |
| Unfinished frontier | 10.5 entries / 63 candidate actions |

Only about **21.6%** of prior exploration actions produced a newly registered focus state. Replay/reset dominated the budget while useful novelty continued late in both runs, so the problem was not an exhausted graph; it was reconstruction cost and expansion order.

The old run files report 43 restoration cycles because `restorationDiagnostics` is capped at 64 entries. That value is not the full-run cycle count. Runtime control-flow reconstruction gives approximately 231 cycles for h1 and 229 for h2 (about 230 mean). The follow-up runner records the exact cycle counter directly.

## Implementation changes

### Resumable live expansion

The explorer previously restored a source state before each sibling action. If `A -> RIGHT -> B` discovered a live, queued `B`, the loop still reconstructed `A` for the next sibling before allowing `B` to expand.

The frontier now stores a continuation containing the source state's already-selected remaining actions. When an applied replayable action reaches a different exact state that already has frontier work, the source continuation is requeued and the exact-live destination is expanded first. Same-state actions remain inline, `actionsForState` is not rerun for continuations, and all existing exact identity/restoration checks remain in force.

This lets the graph learn local return edges before older sibling work needs reconstruction and avoids resetting/replaying through paths that are already live.

### Accurate profiling

The runner/analyzer now records or aggregates:

- exact restoration cycle count;
- novel state/screen producing actions;
- duplicate, self-loop, and known non-self actions;
- replay/reset/exploration residual time;
- replay length;
- unfinished frontier/candidate actions;
- novel states/screens per minute;
- strict precision.

### Focus-trap evidence gap

The existing deterministic focus-trap rule still requires applied SELECT evidence. The production-safe web action policy intentionally withholds SELECT on semantically unsafe profile controls, so the Northstar profile modal could not satisfy that deterministic requirement.

A separate **heuristic** path now requires all of the following:

- an entered modal/dialog;
- complete applied UP/DOWN/LEFT/RIGHT/BACK coverage for every reached modal focus state;
- every one of those actions remains inside the modal region;
- SELECT is explicitly `unsupported` for every reached modal focus state, not failed or unobserved;
- strong visible pointer-only close/dismiss affordance evidence.

This detects the profile trap without pretending withheld activation was tested. Fully applied SELECT coverage continues to produce the existing deterministic finding.

### Directional jump precision

The prior geometry rule penalized cross-axis center distance. That misclassified legitimate diagonal keypad edges and a wide episode row because center distance was a poor proxy for spatial adjacency.

Directional candidate scoring now uses rectangle cross-gap/overlap. The existing conservative requirement for a reached, aligned alternative remains. This removed the prior Search keypad and Details episode false positives while preserving independent true off-axis jump tests.

### Back precision

The prior Back rule treated structural screen-fingerprint churn after SELECT as a new screen. It now requires a semantic screen transition based on normalized location and stable screen landmarks.

The deeper follow-up run then exposed another general false positive: a captions dialog legitimately returned to its parent settings surface. The simple Select->Back history rule is now withheld for dialog/alertdialog entry, where parent-stack behavior cannot be inferred from the immediate entry surface alone. The Home->Details->wrong Search positive remains deterministic.

## Before vs after

| Metric | Prior baseline | Prior restoration | Final baseline | Final restoration |
| --- | ---: | ---: | ---: | ---: |
| Scoped true positives | 0/5 | 1/5 | 0/5 | **3/5** |
| Scoped recall | 0% | 20% | 0% | **60%** |
| Deep-defect recall | 0/4 (0%) | 1/4 (25%) | 0/4 (0%) | **3/4 (75%)** |
| False-positive reports | 0 | 6 | 0 | **1** |
| Strict precision | n/a | 14.3% | n/a | **75%** |
| Mean runtime | ~0.499 s | 120.016 s | 2.000 s | **67.924 s** |
| Physical actions | 2 | 676.5 | 11 | **439** |
| Replay actions | 0 | 447.5 | 0 | **221** |
| Reset time | — | 20.761 s | ~0.19 s | **8.035 s** |
| Replay time | 0 | 70.084 s | 0 | **34.206 s** |
| Exploration residual time | — | ~29.170 s | ~1.8 s | **25.684 s** |
| States | 2 | 50.5 | 4 | **41** |
| Screens | 1 | 9 | 1 | **9** |
| Max depth | 1 | 6.5 | 2 | **12** |
| Novel states/min | — | ~24.75 | ~90.0* | **35.33** |
| Novel screens/min | — | ~4.00 | 0 | **7.07** |
| Actions / true positive | n/a | 676.5 | n/a | **146.33** |
| True seeded defects/min | 0 | ~0.50 | 0 | **2.65** |
| Unfinished frontier at termination | — | 10.5 | 0 | **0** |

`*` The final baseline is only ~2 seconds and stops at its intentional restoration boundary, so its per-minute novelty rate is not directly comparable to the treatment.

Relative to the prior treatment, the final treatment used **35.1% fewer physical actions**, **50.6% fewer replay actions**, **61.3% less reset time**, **51.2% less replay time**, and **78.4% fewer actions per true positive**. Novel-state throughput improved about **42.8%**, novel-screen throughput about **76.7%**, and max depth increased from 6.5 to 12.

## Final pair results

| Metric | j1 restoration | j2 restoration | Mean |
| --- | ---: | ---: | ---: |
| Recall | 60% | 60% | **60%** |
| Strict precision | 75% | 75% | **75%** |
| True positives / strict false positives | 3 / 1 | 3 / 1 | **3 / 1** |
| Runtime | 67.937 s | 67.912 s | **67.924 s** |
| Physical / exploration / replay actions | 439 / 218 / 221 | 439 / 218 / 221 | **439 / 218 / 221** |
| States / screens | 41 / 9 | 41 / 9 | **41 / 9** |
| Max depth | 12 | 12 | **12** |
| Restoration cycles | 224 | 224 | **224** |
| Restoration attempts / successes / failures | 264 / 218 / 46 | 264 / 218 / 46 | **264 / 218 / 46** |
| Resets | 41 | 41 | **41** |
| Reset time | 8.003 s | 8.067 s | **8.035 s** |
| Replay time | 34.181 s | 34.230 s | **34.206 s** |
| Exploration residual | 25.753 s | 25.614 s | **25.684 s** |
| Novel state / screen actions | 40 / 8 | 40 / 8 | **40 / 8** |
| Duplicate / self-loop / known non-self actions | 178 / 106 / 72 | 178 / 106 / 72 | **178 / 106 / 72** |
| Novel states/min | 35.33 | 35.34 | **35.33** |
| Novel screens/min | 7.06 | 7.07 | **7.07** |

Both treatment runs ended fail-closed with `restoration-unavailable / unsafe-root-replay`, not with the 120-second timeout. The explorer reached useful depth 12 in about 68 seconds and refused to reconstruct a branch whose root path required unsafe BACK replay. `remainingFrontierEntries` was 0 at that boundary; this does not imply exhaustive app coverage because the rejected branch itself remained a legitimate traversal boundary.

## Per-defect outcome

| Scoped seed | Final status | Evidence |
| --- | --- | --- |
| `fixture-details-back-wrong-screen` | **Detected** | Deterministic `remote.back-behaviour` in both j1/j2. The true positive survived the semantic-screen and dialog-entry precision tightening. |
| `fixture-profile-focus-trap` | **Detected** | Heuristic `remote.focus-trap` in both j1/j2. Directions+Back were completely applied inside the entered modal, SELECT was explicitly unsupported, and a pointer-only close control was visible. |
| `fixture-caption-text-colour-remote-unreachable` | **Detected** | Deterministic `remote.reachability` in both j1/j2. Reaching depth 12 finally exercised the depth-11 Caption Appearance branch. |
| `fixture-home-more-info-unreachable` | **Missed because traversal coverage remained incomplete** | Home reached and expanded all retained local states except repetition-deferred `fresh-card-3`, which had 0 attempted actions. `localCoverage()` therefore correctly withheld the deterministic unreachable claim. |
| `fixture-carousel-right-jump` | **Inconclusive** | The seeded `home-card-3 -> RIGHT -> footer-privacy` transition was executed, but `home-card-4` was never reached. The conservative jump detector therefore lacked a reached aligned expected neighbor and correctly withheld a finding. |

## False-positive analysis

The prior treatment produced six strict false-positive reports per run (five unique semantic keys):

1. Search `BACK` false positive after query mutation: SELECT changed a structural screen fingerprint while remaining on Search. Fixed by semantic screen identity.
2. Search keypad `O -> DOWN -> Delete` (duplicated after query rerender): legitimate diagonal edge. Fixed by rectangle cross-gap/overlap geometry.
3. Search keypad `Delete -> UP -> O`: legitimate diagonal edge. Fixed by rectangle geometry.
4. Search keypad `V -> DOWN -> Clear`: legitimate diagonal edge. Fixed by rectangle geometry.
5. Details `Episodes -> UP -> Play`: legitimate navigation from a very wide source control. Fixed by rectangle geometry.

The first deeper follow-up exposed one additional `captions-off` Back false positive from nested dialog parent navigation. The final modal-entry evidence boundary removed it while retaining the Details true positive.

The sole final strict false positive is `remote.reachability|player-volume-boost`. Northstar intentionally seeds the same target as `fixture-player-volume-pointer-only` with expected rule `accessibility.pointer-only-control`. The generic navigation finding is behaviorally valid, but the strict rule/target scorer does not give cross-rule credit. No final emitted finding points at an unseeded benign behavior.

## Regression coverage

New focused tests cover:

- exact-live child expansion before source continuation;
- no action-policy recomputation when a source continuation resumes;
- deeper progress under an expensive-reset bounded clock;
- restoration-cycle accounting;
- semantic Back transition positive and structural-churn negative;
- dialog-entry Back negative;
- legitimate diagonal keypad navigation negative;
- wide-source directional navigation negative;
- true off-axis jump positive;
- heuristic trap positive with SELECT unsupported + pointer-only dismiss evidence;
- deterministic trap retained with applied SELECT;
- trap negatives for focusable close, Back exit, and failed SELECT.

## Verification

Final clean checkout: `610144eeb5c77de13b0f8f1d127d667df2f3dac7`.

- `npm test --workspace @tvdoctor/core` — **13 files, 211/211 passed**.
- `npm test --workspace @tvdoctor/broken-streaming-web` — **12/12 passed**.
- `npm test --workspace tvdoctor` — **11 files, 181/181 passed**.
- `npm test --workspace @tvdoctor/driver-android` — **7 files, 76/76 passed**.
- `npm run typecheck` — **passed**.
- `npm run lint` — **passed**.
- `npm run build:packages` — **passed**.
- `npm exec --workspace @tvdoctor/core playwright test integration/navigation-diagnostics.integration.spec.ts` — **1/1 passed** (~1.1 min).
- `git diff --check` — **passed**.
- Earlier after the scheduler implementation and before the final detector-only modal refinement: `npm run test:core-integration` — **11/11 passed**, including the 240-card M8 carousel benchmark (~7.6 min).
- Final controlled analyzer: `node scripts/analyze-northstar-restoration-recall.mjs --config Tests/real-apps-2026-09-19/northstar-traversal-detector-improvement.config.json --output Tests/real-apps-2026-09-19/northstar-traversal-detector-improvement.results.json` — **integrity valid; baseline 0%; restoration 60%**.

No Android restoration implementation changed in this milestone; Android driver unit coverage was rerun, but no emulator lifecycle rerun was required.

## Evidence paths

- `Tests/real-apps-2026-09-19/northstar-traversal-detector-improvement.config.json`
- `Tests/real-apps-2026-09-19/northstar-traversal-detector-improvement.results.json`
- `Tests/real-apps-2026-09-19/northstar-traversal-detector-benchmark/j1-baseline/`
- `Tests/real-apps-2026-09-19/northstar-traversal-detector-benchmark/j1-restoration/`
- `Tests/real-apps-2026-09-19/northstar-traversal-detector-benchmark/j2-restoration/`
- `Tests/real-apps-2026-09-19/northstar-traversal-detector-benchmark/j2-baseline/`
- Prior comparison: `Tests/real-apps-2026-09-19/northstar-seeded-defect-benchmark.md`
- Prior machine-readable comparison: `Tests/real-apps-2026-09-19/northstar-seeded-defect-benchmark.results.json`

## Limitations

- This is one deterministic synthetic fixture with two counterbalanced trials, not broad external-app evidence.
- The treatment now stops at a safe `unsafe-root-replay` boundary after ~68 seconds rather than using the entire 120-second cap. That is correct fail-closed behavior but leaves unreachable branches unexplored.
- Repetition compression currently retains an unexpanded third `fresh-card` representative, which blocks screen-wide deterministic local coverage even though equivalent repeated representatives were expanded. This is now the clearest Home coverage bottleneck.
- The carousel jump remains intentionally unreported until traversal establishes enough neighbor evidence.
- The old Vite served-resource hash is checkout-path-sensitive, so exact transformed dev bytes were not portable across surviving worktrees; frozen fixture source/manifest hashes were unchanged.

## Confidence

**High (about 0.9)** for the conclusion that the milestone materially improved traversal efficiency, deep recall, and finding precision. The two final treatment runs were effectively identical and all clean-checkout verification passed. Confidence is lower that 60% recall generalizes to arbitrary real TV apps because Northstar is a synthetic seeded fixture.

## Highest-value next experiment

Make repetition compression **coverage-aware** without weakening identity: explicitly mark deferred repetition-equivalent focus states (or otherwise expose their representative relationship) so deterministic local-coverage rules can distinguish "unexpanded because equivalent representative coverage is sufficient" from genuinely unfinished unique UI. Then rerun the same 120-second Northstar pair and the 240-card carousel benchmark.

That experiment directly targets `fixture-home-more-info-unreachable` without loosening the reachability detector, and it will show whether better compression/coverage accounting also makes the `home-card-4` neighbor evidence reachable enough to diagnose the remaining carousel jump.
