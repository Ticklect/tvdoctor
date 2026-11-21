# Deep complex-fixture Chromium A/B — 2026-10-10

Environment: Windows, local Playwright Chromium, Northstar fixture, heavily
modified working tree. These are **synthetic fixture** observations, not
production TV-app results. The runnable harness and exact-identity JSON format
are in `packages/cli/integration/deep-complex-ab.integration.spec.ts`. See
`benchmarks/deep-complex-fixture.md` for the reproduction command.

All runs used Deep priority traversal, uncompressed focus identities,
`refreshVisibleSelfLoops`, verified root fallback, the same action/budget
settings within each A/B pair, and the explicit local-only fixture profile
permission. Times include browser launch plus traversal; timing gains from
single paired runs are indicative only, with no confidence interval.

| Variant | Mode | Wall ms | Screens | Focus | Physical | Explore | Replay | Resets | Deferred | Frontier entries | Termination |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Alternate routes | root-only | 38,403 | 5 | 21 | 140 | 58 | 82 | 60 | 0 | 12 | max-actions, partial |
| Alternate routes | verified-local | 35,620 | 5 | 20 | 140 | 56 | 84 | 52 | 0 | 11 | max-actions, partial |
| Alternate + 240 cards | root-only | 56,452 | 5 | 22 | 140 | 58 | 82 | 60 | 0 | 13 | max-actions, partial |
| Alternate + 240 cards | verified-local | 51,197 | 5 | 21 | 140 | 56 | 84 | 52 | 0 | 12 | max-actions, partial |
| Profile-on-launch overlays | root-only | 17,021 | 5 | 15 | 125 | 32 | 93 | 34 | 0 | 5 | max-actions, partial |
| Profile-on-launch overlays | verified-local | 16,904 | 5 | 15 | 125 | 32 | 93 | 33 | 0 | 5 | max-actions, partial |

Budgets for the first two pairs: 140 physical keys, 85 states, depth 18,
120,000 ms; six arrow/SELECT/BACK navigation keys. The third pair uses
125 physical keys, 35 states, depth 8, 85,000 ms and DOWN/SELECT/BACK.

## Exact observed identity differences

**Alternate routes:** identical screen and finding identity sets. Verified-local
omitted one root-only focus fingerprint `focus-a0a063286c49e40c-19` and the
following two applied root-only actions:

```
fresh-card-2|LEFT|applied|fresh-card-1
fresh-card-2|RIGHT|applied|fresh-card-3
```

**240-card variant:** identical screen identity set. Verified-local omitted
`focus-20787b37369de773-22` and two applied root-only actions:

```
stress-card-001|LEFT|applied|fresh-card-1
stress-card-001|RIGHT|applied|stress-card-002
```

It also omitted the one root-only heuristic finding
`TVDOCTOR-NAV-69A1FED421538CB838D22B0E67A1E4A4` of rule
`remote.directional-asymmetry`. Since both runs were bounded partial, this is
an observed difference in finite-budget coverage, not evidence of a logically
unreachable state or a confirmed production defect. The stress fixture rendered
240 cards; the 140-action scans only reached 2 distinct stress-card focus IDs
with root-only and 1 with verified-local. It does **not** test complete
traversal of all 240 cards.

**Profile-on-launch overlay fixture:** exact matching screen/focus/action/
transition/finding sets for both modes. Both reached `profile-primary`,
`profile-kids`, and `home-browse`, and applied SELECT from a profile control.
No SELECT was withheld. This confirms the dedicated fixture exercised the
profile selection and subsequent nested UI; it does not establish queue
exhaustion because 5 frontier entries remained in both runs.

## Restoration details and interpretation

- Alternate routes: local verified 16 state reuses, 10 local-path restorations,
  30 root fallbacks; root-only had none of these optimisations.
- 240-card stress: local verified 15 state reuses, 10 local-path restorations,
  31 root fallbacks and one budget-exhausted restoration attempt; root-only
  ended max-actions with no restoration failure.
- Profile-on-launch: local verified 2 state reuses, 3 local-path restorations,
  28 root fallbacks; root-only used one more reset.

None of these three A/B pairs completed full exploration. At the same physical
budget, verified-local improved *measured* wall time and reset count for the
first two, but made fewer exploration actions and reached fewer states. It
cannot yet be described as a coverage-preserving performance optimisation on
large app graphs. The smaller profile fixture demonstrates exact identity
parity over its tested partial action set.

### Preflight-verification reruns

After adding explicit fixture assertions that all 240 stress controls are
actually rendered and that the profile fixture launches focused on
`profile-primary`, the two relevant A/B tests passed again:

| Variant (rerun) | Root-only wall ms | Verified-local wall ms | Identity outcome |
| --- | ---: | ---: | --- |
| Alternate + 240 cards | 54,024 | 52,712 | Same 5 screens; local still omits 1 focus, 2 transitions and 1 heuristic finding |
| Profile-on-launch overlays | 17,226 | 17,243 | Exact screen/focus/action/transition/finding parity |

This second observation illustrates that wall-time differences fluctuate.
The profile variant was marginally *slower* with verified-local on rerun;
neither variant justifies a blanket runtime-speedup claim. Both reruns also
remained partial at their respective physical-action caps.

## After the physical-key-aware local-path guard (2026-10-10 rerun)

The revised verified-local restorer no longer takes a longer verified local
path when the recorded root route is shorter and safe to replay. It still uses
the local path when root fallback is prohibited or unsafe. This corrects a
budget-wasting selection choice: each physical replay key counts toward the
same Deep `maxActions` cap as fresh exploration.

All three real-Chromium A/B tests passed again (3/3, 3.7 minutes). Their exact
observed **screens, focus fingerprints, actions, transitions, and finding
identities match** in every pair, without suppression of partial coverage:

| Fixture | Mode | Wall ms | Screens | Focus | Physical | Explore | Replay | Resets | Termination |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Alternate routes | root-only | 37,952 | 5 | 21 | 140 | 58 | 82 | 60 | max-actions, partial |
| Alternate routes | verified-local | 36,936 | 5 | 21 | 140 | 58 | 82 | 56 | max-actions, partial |
| Alternate + 240 cards | root-only | 55,240 | 5 | 22 | 140 | 58 | 82 | 60 | max-actions, partial |
| Alternate + 240 cards | verified-local | 53,614 | 5 | 22 | 140 | 58 | 82 | 56 | max-actions, partial |
| Profile-on-launch overlays | root-only | 16,846 | 5 | 15 | 125 | 32 | 93 | 34 | max-actions, partial |
| Profile-on-launch overlays | verified-local | 16,568 | 5 | 15 | 125 | 32 | 93 | 33 | max-actions, partial |

Each entry uses identical conditions within its pair. For the two complex
alternates, the improved route-choice recovers the previously omitted focus
state, its two action edges and (on 240-card variant) the heuristic finding.
The faster wall times (about 1–3% here) are single-run observations, not
reproducible hardware benchmarks or a production Deep speedup claim. Replay
action counts stay identical across modes in this capped Chromium test; only
some resets were avoided. Full known-frontier coverage still requires an
unbounded-enough scan: every row above remains strictly partial.

## Full safe-frontier, title-specific eight-card fixture (2026-10-10)

**Different experiment from the partial 240-card case.** The separate
`/deep-profile-route.html?stressCards=8` fixture has profile selection, browse,
search, settings overlay, and eight individually selectable carousel items.
Detail destinations expose **unique stable structural and focused control
IDs**, so the explorer cannot merge eight title routes into one nominally
identical details screen. The fixture does not include the original Northstar
240-card shelf. It is a deliberately finite complex UI for proving real-Chromium
frontier exhaustion and graph parity, not a real-world compatibility result.

With the same Deep priority order, stable-snapshot settling, root fallbacks,
compression disabled, and DOWN/SELECT/BACK keys in each A/B pair, these are the
exact limits: `maxActions=1800` including every physical replay press,
`maxStates=100`, `maxDepth=35`, `maxDurationMs=220000` per traversal.
Playwright's pair timeout is 540 seconds. The test asserts **both**
`reason=queue-exhausted` and `complete=true`, zero pending frontier and deferred
states, an applied SELECT from *each* of the eight card IDs to its own distinct
details-back stable ID, reachable profile/search/settings, and strict equality
of sorted screen/focus/action/transition/finding identities. It cannot pass
merely by hitting a key, time, state or depth limit.

### Initial progression / why structural identity matters

An early 21-focus/5-screen full-queue run matched identically but shared one
details focus ID for all titles, masking meaningful route identity. Merely
adding origin/title text to headings and button labels also left the structural
fingerprints at 5 screens and 21 focuses. Those initial runs are **not** the
final per-title coverage proof. The corrected fixture uses stable identifiers
for each title details destination and returns BACK to the card or search
result actually selected. This expanded the graph to 14 screens/39 focus
states and prevented hidden route-history aliasing.

### Corrected full-frontier run 1 (real Chromium)

| Measurement | Root-only | Verified-local |
| --- | ---: | ---: |
| Wall time, includes browser launch (ms) | 117,181 | 102,311 |
| Termination | queue-exhausted (complete) | queue-exhausted (complete) |
| Discovered screens / focus states | 14 / 39 | 14 / 39 |
| Exploration actions | 117 | 117 |
| Physical keys total | 969 | 841 |
| Replay keys | 852 | 724 |
| Browser resets | 118 | 100 |
| Verified live reuses / local paths | 0 / 0 | 13 / 20 |
| Root fallback attempts | 0 | 84 |
| Pending frontier / deferred | 0 / 0 | 0 / 0 |
| Unsupported SELECT actions | 0 | 0 |

Exact **screen, focus, observed-action, transition and finding ID multisets
matched**, with zero missing or added identities in the comparison JSON. Both
modes visited every `stress-card-01` to `stress-card-08` and each corresponding
`details-back-stress-card-XX` state by applying SELECT. The verified-local run
used 128 fewer physical actions and 18 fewer resets; wall time was shorter by
14.87 seconds (12.7%) in this one run. That figure is not a claim of general
performance uplift across arbitrary TV apps, and the synthetic fixture does
not estimate accuracy on the original 240-card app.

Full exact-identity evidence for this run is preserved as
`benchmarks/deep-complete-8-run1.json`; the instructions and one-case command
are in `benchmarks/deep-complex-fixture.md`.

### Corrected full-frontier run 2 (identical configuration)

The fixture, branch/worktree, browser, selected actions and budgets were held
constant. The exact-identity JSON is preserved separately as
`benchmarks/deep-complete-8-run2.json`.

| Measurement | Root-only | Verified-local |
| --- | ---: | ---: |
| Wall time, includes browser launch (ms) | 115,400 | 101,763 |
| Termination | queue-exhausted (complete) | queue-exhausted (complete) |
| Screens / focus states / explored actions | 14 / 39 / 117 | 14 / 39 / 117 |
| Physical keys / replay keys | 969 / 852 | 841 / 724 |
| Resets / local path restorations | 118 / 0 | 100 / 20 |
| Pending frontier / deferred / unsupported SELECT | 0 / 0 / 0 | 0 / 0 / 0 |

Both runs reached all eight individually identified details states. Exact
screen/focus/action/transition/finding ID arrays matched **within** each
root-vs-local pair, and a separate PowerShell JSON comparison of `screens`,
`focus`, `actions`, `transitions`, `findings` and `focusStableIds` matched
**across** run 1 and run 2 for each restoration mode. The graph identities and
physical-key counts were stable across repetitions: 969 vs 841 keys and 118
vs 100 resets in both A/B runs. No restoration failure occurred in either
verified-local run.

Two-sample mean wall times were approximately **116.29 seconds root-only**
and **102.04 seconds verified-local**. Verified-local saved ~14.25 seconds,
or **12.3%** of root-only wall time on this controlled fixture. With only two
sequential local A/B runs, there is no confidence interval or isolation from
browser warm-up, system load or order effects; the 128-key reduction, exact
coverage and queue-exhaustion results are stronger claims than the measured
wall-time difference. Neither this controlled eight-item result nor the partial
240-item test establishes an exhaustive result or speedup on production apps.
