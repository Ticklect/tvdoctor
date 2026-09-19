# Northstar seeded-defect restoration benchmark

Date: 2026-09-19

## Result

Under the controlled equal-budget comparison, restoration increased scoped seeded-defect recall from **0/5 (0%)** to **1/5 (20%)** in both counterbalanced pairs. The one repeatable restoration-only true positive was `fixture-details-back-wrong-screen`. The finding-producing `BACK` action was immediately preceded by a successful treatment-specific root replay to the exact `details-play` source state in both trials.

The result is real but narrow. Restoration reached far more of Northstar and found one seeded defect that the baseline could not reach and test, while also producing six scoped false-positive reports per restoration run and consuming the full 120-second exploration budget. The evidence supports the verdict: **restoration improves defect discovery only for deeper/specific defect classes**.

## Experimental boundary

Northstar is the web fixture at `fixtures/broken-streaming-web`. This experiment intentionally enables the platform-neutral core `verified-local` restoration engine on the web fixture to isolate restoration's effect on traversal and generic navigation diagnostics. `verified-local` is not the current public web default.

The product under test was frozen at Git commit `f90c006c127d206921ef26c961a34328339836ef`. Final runs were executed from an isolated detached worktree at that commit so unrelated changes in the main working tree could not affect traversal or detectors.

Both arms used:

- target: `http://127.0.0.1:4182/`
- profile: `deep`
- action policy: `production-safe-web-navigation`
- equal exploration budget: **120,000 ms per arm**
- Chromium: `153.0.8010.12`
- Node: `v24.18.0`
- platform: `win32/x64`
- fixture source SHA-256: `93ed6dfcd4cbd60eb10a61e5c6a02cc0197b3ccbfad634af31ae0bda9e15582c`
- served document SHA-256: `d17eb165b464db3dfc572a8ecf267e29463a04b76e8993896714c45cf134da1e`
- served resource bundle SHA-256: `8b20675f63b053ea4771bd3229d6b46dd15955cc683facf6241524a00f001f0d`
- ground-truth Git-blob SHA-256: `a189bd7e4f2686cddb1b2c53d1dca161e6344dd81b4a6911531640291971804e`
- final config SHA-256 recorded by runs: `59395f226a47a91c937c4edf952d29c7fc057349cc0a6205e8cb47da3aaac032`

The baseline used `verified-live-only`: exact verified live-state continuation remains available, while verified local-path reconstruction and root replay are disabled. The treatment used `verified-local` with bounded root replay fallback. The known defect manifest was used only by the analyzer after traversal; it was not supplied to detector or traversal logic.

Equal wall-clock means both arms received the same 120-second cap. Baseline naturally terminated after about 0.5 seconds because its next queued branch required restoration that the baseline deliberately forbids. It was not kept artificially busy for the remaining budget.

## Ground truth

`fixtures/broken-streaming-web/seeded-defects.json` is Northstar's authoritative manifest and contains **13 intentional defects**. The fixture contract tests independently assert all 13 IDs. This benchmark's generic `diagnoseNavigation` detector set reasonably covers five of them; the other eight belong to specialized streaming, accessibility, search, layout, performance, or crash detectors and are excluded from the recall denominator.

| Defect | Rule/category | Screen | Approx. minimum witness depth | D-pad relevant | Restoration relevance | Recall scope |
| --- | --- | --- | ---: | --- | --- | --- |
| `fixture-home-more-info-unreachable` | `remote.reachability` | Home | 2 | Yes | Low/medium; needs locally complete Home coverage | In |
| `fixture-profile-focus-trap` | `remote.focus-trap` | Home > profile picker | 4 | Yes | High; branch recovery helps finish the modal | In |
| `fixture-carousel-right-jump` | `remote.unexpected-jump` | Home | 5 | Yes | Medium; detector needs reached adjacent alternatives | In |
| `fixture-details-back-wrong-screen` | `remote.back-behaviour` | Details | 3 | Yes | High; must return to Details and test Back | In |
| `fixture-card-focus-indicator-weak` | `focus.visibility` | Home | ~3 | Yes | Low | Out: accessibility detector |
| `fixture-player-settings-clipped` | `layout.viewport-clipping` | Player > settings | ~7 | Indirect | Medium/high | Out: layout detector |
| `fixture-player-rewind-inverted` | `streaming.player-control` | Player | ~6 | Yes | Medium | Out: streaming detector |
| `fixture-caption-track-toggle-ignored` | `streaming.captions` | Player > settings > captions | ~8 | Yes | High | Out: streaming detector |
| `fixture-caption-text-colour-remote-unreachable` | `remote.reachability` | Player > settings > captions > appearance | 11 | Yes | High | In |
| `fixture-player-volume-pointer-only` | `accessibility.pointer-only-control` | Player | ~3 surface | Yes | Medium | Out: streaming/accessibility detector |
| `fixture-search-submit-pointer-only` | `search.remote-flow` | Search | ~2 surface / ~4 populated | Yes | Low | Out: search detector |
| `fixture-player-settings-slow-open` | `performance.menu-response` | Player | ~7 plus timing | Yes | Medium | Out: performance detector |
| `fixture-startup-console-error` | `crash.console-error` | Home | 0 | No | None | Out: crash detector |

The five in-scope seeds and their configured minimum depths were frozen before final interpretation: Home More info 2, profile trap 4, carousel jump 5, Details Back 3, and caption Text Colour 11.

## Paired equal-budget trials

Two final pairs were counterbalanced. Earlier `t1`, `t2`, `f1`, `g1`, and `g2` artifacts are retained as excluded pilots because pre-final integrity review found incomplete provenance/config binding or causal linkage. They are not included in the figures below.

| Trial | Order | Mode | Runtime | Actions | States | Screens | Max depth | Completed branches | Scoped true positives | Scoped false-positive reports |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| h1 | baseline → restoration | Baseline | 0.496 s | 2 | 2 | 1 | 1 | 0 | 0 | 0 |
| h1 | baseline → restoration | Restoration | 120.014 s | 680 | 51 | 9 | 7 | 38 | 1 | 6 |
| h2 | restoration → baseline | Restoration | 120.018 s | 673 | 50 | 9 | 6 | 38 | 1 | 6 |
| h2 | restoration → baseline | Baseline | 0.502 s | 2 | 2 | 1 | 1 | 0 | 0 | 0 |

Both baseline runs terminated `restoration-unavailable` with root fallback disabled. Both restoration runs terminated at `max-duration`; h1 still had 11 frontier entries / 66 candidate actions and h2 had 10 / 60. There were **zero system-surface escapes** in every final arm.

## Recall and depth

| Metric | Baseline | Restoration |
| --- | ---: | ---: |
| In-scope seeded defects found | 0/5 | 1/5 |
| Recall | 0% | 20% |
| Medium-depth recall (depth 2) | 0/1 = 0% | 0/1 = 0% |
| Deep recall (depth 3+) | 0/4 = 0% | 1/4 = 25% |
| Mean true seeded defects/minute | 0 | 0.500 |
| Mean actions per true defect | n/a | 676.5 |
| Mean runtime per true defect | n/a | 120.016 s |

The same classification occurred in both pairs:

| Defect | h1 | h2 | Final classification |
| --- | --- | --- | --- |
| `fixture-home-more-info-unreachable` | missed both | missed both | Missed both |
| `fixture-profile-focus-trap` | missed both | missed both | Missed both |
| `fixture-carousel-right-jump` | missed both | missed both | Missed both |
| `fixture-details-back-wrong-screen` | restoration only | restoration only | **Restoration only** |
| `fixture-caption-text-colour-remote-unreachable` | missed both | missed both | Missed both |

No in-scope seed was baseline-only, found by both, or inconclusive.

## Direct restoration causality

The restoration-only `fixture-details-back-wrong-screen` result has an action-level causal chain in both trials:

`Home/home-nav-home → RIGHT → hero-watch → SELECT → Details/details-play → branch later revisited → root replay [RIGHT, SELECT] → verified Details/details-play → BACK → Search/search-query → remote.back-behaviour finding`

For h1 and h2 the finding is `action-0030` from `focus-0009`. Immediately before that exact finding-producing `BACK`, restoration cycle 30 successfully used `root-replay` to destination `focus-0009` with action history `[RIGHT, SELECT]`. The analyzer therefore marks the association as `finding-action-immediately-preceded-by-treatment-restoration` with `causalClaim: true`.

The restoration itself took 606.6 ms in h1 and 586.7 ms in h2. The baseline cannot perform this recovery and terminates before it can test the Details Back branch.

## Miss analysis

The four misses are not all the same product problem.

| Missed seed | What the run did | Reason for miss | Product implication |
| --- | --- | --- | --- |
| `fixture-home-more-info-unreachable` | Reached 12 Home focus states, but `fresh-card-3` was discovered at depth 5 and never expanded before deadline. | **Traversal/completeness**. The conservative reachability rule requires locally complete coverage of the screen before declaring a visible non-focusable control unreachable. | More/better-prioritized coverage could unlock this existing detector. |
| `fixture-profile-focus-trap` | Reached both `profile-primary` and `profile-kids`; all six configured actions were exercised from both states and Back remained inside. | **Detector gap**. The full seeded trap witness existed in the graph, but `remote.focus-trap` was not emitted. | General navigation diagnostic follow-up is justified; no Northstar-specific detector patch was made here. |
| `fixture-carousel-right-jump` | Reached `home-card-3` and executed the seeded `RIGHT → footer-privacy` jump. | **Traversal-dependent detector evidence**. The conservative unexpected-jump rule requires a reached, aligned adjacent alternative; `home-card-4` was not reached in the bounded run, so the detector would not assert the jump. | More complete Home coverage should make the generic detector eligible without hard-coding Northstar. |
| `fixture-caption-text-colour-remote-unreachable` | Never reached player settings/captions/appearance; restoration max depth was 7 in h1 and 6 in h2 versus an ~11-action witness. | **Traversal/time budget**. | The 120 s treatment still spends too much time restoring/replaying to reliably reach the deepest branch. |

Three of the four consistent misses are therefore primarily coverage/budget limitations under the detector's conservative proof requirements; one is a confirmed detector gap after adequate traversal evidence was present.

## Efficiency and noise

Restoration averaged:

- 50.5 states versus 2 baseline states (**+48.5**)
- 9 screens versus 1 (**+8**)
- depth 6.5 versus 1
- 38 completed branches versus 0
- 676.5 actions versus 2 (**+674.5**)
- 447.5 replay actions
- 43 restoration cycles
- 70.084 s of replay time
- 20.761 s of reset time
- 120.016 s exploration runtime versus 0.499 s baseline
- 1 useful restoration-only seeded defect per 8 additional screens = **0.125 useful defects/additional screen**

The treatment found one true in-scope seed per run, but also emitted six scoped false-positive reports per run: five unique false-positive identities plus one duplicate. There were no ambiguous findings. Representative noise included Back-behaviour on `search-key-n` and unexpected-jump reports on search keyboard controls and `details-episodes`.

This is a poor precision/cost ratio today: roughly one true seeded defect for six false-positive reports, about 676 actions, and the full two-minute cap. The increase in recall is still meaningful because the true positive is repeatable and directly tied to restoration, but the cost should not be hidden.

## Integrity controls

The final harness hard-fails before traversal if:

- the runtime config does not bind to the canonical ground-truth Git blob;
- Git HEAD differs from the configured base commit;
- core/web-driver/pack/protocol/fixture source under test is dirty;
- the served Northstar document differs from its frozen hash;
- the served `/src/main.ts` + `/src/styles.css` resource bundle differs from its frozen hash.

The analyzer also hard-fails invalid pair identity/order/overlap, mismatched budget/profile/action policy/runtime/fixture/build/runner provenance, mismatched initial state, or mismatched served fixture hashes. It counts false positives only within the four detector rules used for the five-seed denominator. Zero-true-positive efficiency values are reported as null rather than infinite or misleading zeros.

Run metadata contains a warning that the provenance status included the untracked benchmark runner. The product/fixture paths under test were separately enforced clean before each final run; the warning therefore describes the benchmark harness file, not product-source contamination.

## Evidence

- Config: `Tests/real-apps-2026-09-19/northstar-seeded-defect-benchmark.config.json`
- Machine-readable analysis: `Tests/real-apps-2026-09-19/northstar-seeded-defect-benchmark.results.json`
- h1 baseline: `Tests/real-apps-2026-09-19/northstar-restoration-benchmark/h1-baseline/run.json`
- h1 restoration: `Tests/real-apps-2026-09-19/northstar-restoration-benchmark/h1-restoration/run.json`
- h2 restoration: `Tests/real-apps-2026-09-19/northstar-restoration-benchmark/h2-restoration/run.json`
- h2 baseline: `Tests/real-apps-2026-09-19/northstar-restoration-benchmark/h2-baseline/run.json`
- Each final run directory also contains `initial.png` and `final.png` supplementary screenshots.

## Limitations

- Two counterbalanced final pairs are enough to rule out a one-run ordering accident here, but they are still a small sample from one deterministic fixture.
- The treatment exhausted its 120-second budget in both trials and did not complete the graph, so the 20% recall result is a bounded-budget product measurement rather than Northstar's theoretical maximum recall.
- The benchmark evaluates only the five seeds reasonably detectable by generic navigation diagnostics. It does not measure the eight specialized streaming/accessibility/search/layout/performance/crash detectors.
- No unconstrained secondary run was used to support the product verdict. Giving restoration additional time would answer a different engineering question and would not be an equal-budget comparison.

## Verdict

**Restoration improves defect discovery only for deeper/specific defect classes.**

The evidence is stronger than a coverage-only result: restoration repeatedly found a real seeded defect the baseline missed, and the exact finding action depended on a successful root replay to the deeper Details state. It is not broad defect-recall success: four of five in-scope seeds remained missed, treatment precision was noisy, and restoration consumed substantial replay/reset time. Confidence is high in the measured 0% → 20% scoped recall change and its causal attribution, and moderate in generalizing the size of that improvement beyond Northstar and this two-pair experiment.
