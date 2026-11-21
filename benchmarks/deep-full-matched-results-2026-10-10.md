# Full Deep replay comparison — 2026-10-10

Source artifacts (retained without modification):

- `artifacts/deep-root-matched-20261010`
- `artifacts/deep-verified-local-20261010`

Run the strict saved-artifact comparison using:

```powershell
node scripts/compare-replay-performance.mjs artifacts/deep-root-matched-20261010 artifacts/deep-verified-local-20261010
```

Both runs are local Northstar **synthetic fixture** scans, not scans of an external production TV app or a physical device. Both use the explicit local-only `fixtureProfileSelectionEnabled` permission, so these figures must not be used to justify real account/profile changes. The strict comparator reports no change in selected fixture, pack status, scan budget, or scan action policy.

## Full-frontier observations

| Metric | Root-only | Verified-local | Difference |
| --- | ---: | ---: | ---: |
| Navigation elapsed (ms) | 838,598.4555 | 743,463.1894 | -95,135.2661 (-11.34%) |
| Reset count | 541 | 440 | -101 (-18.67%) |
| Replay key presses | 3,162 | 2,757 | -405 (-12.81%) |
| Exploration key presses | 540 | 540 | 0 |
| Total physical keys | 3,702 | 3,297 | -405 (-10.94%) |
| Screens | 18 | 18 | 0 |
| Focus states | 90 | 90 | 0 |
| V2 transitions | 540 | 540 | 0 |
| Issues | 52 | 52 | 0 |
| Verified-state reuses | 0 | 217 | +217 |
| Verified-path restorations | 0 | 118 | +118 |
| Root fallbacks | 0 | 205 | +205 |

Both runs terminated with `queue-exhausted`, reported `complete: true` and the v2 graph's `coverage: complete`, with no unverified profile SELECT under the local-fixture policy. The original user-facing Deep run **without** fixture-only profile permission had six unsupported SELECT actions and correctly reported partial coverage; these are not contradictory.

## Exact evidence qualification

The stricter saved-artifact comparator reports the same **identity sets** for all screens, focus targets, transitions, graph problems and issues; matching issue identities, classification and report status; and the same exploration count. **It does not report full evidence equivalence** (`Navigation problems changed.`), because three problems contain different absolute Y coordinates of source/expected UI elements:

- `TVDOCTOR-NAV-129F24A71F33E623FE4255919245F037` (source geometry)
- `TVDOCTOR-NAV-78FF7644E56799C01DF33CC6E031A2F4` (expected target geometry)
- `TVDOCTOR-NAV-98CA963061842ACCF60455826E1A6E60` (expected target geometry)

The observed target identity/name/role and issue IDs match. Different scroll positions during replay plausibly explain these geometry differences, but this is a hypothesis, not verified causation. Geometry can be material to focus-direction diagnostics; the comparator must not silently suppress it to make evidence appear equivalent.

This is **one** full A/B matched pair, not repeated A/B/A trials or evidence of a statistically established production speedup. `elapsedMs` comes from the navigation statistics, not an independently measured end-to-end wall clock. The optional verified-local strategy should therefore remain opt-in until broader repeatability and evidence checks pass. Full physical-device and production-app validation remain outstanding.

## CLI process result

The root-only run emitted `COMPLETED` and an observed process exit code `1`. Inspection of `packages/cli/src/cli.ts` and its tests confirms exit code `1` is intentional for a completed non-CI scan with audit findings and no baseline; it does **not** imply the navigation traversal crashed.
