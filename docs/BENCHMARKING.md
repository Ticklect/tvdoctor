# Benchmarking TVDoctor

TVDoctor has three different kinds of validation evidence. Keep them separate:
seeded fixture validation, synthetic stress validation, and real-app validation.
They answer different questions and must not be collapsed into one "accuracy"
number.

## 1. Seeded fixture validation

**Question:** does TVDoctor reliably discover and diagnose known remote-navigation
failures in a controlled app without reading the answers?

Northstar and the Android fixture contain deliberate defects with machine-readable
expected outcomes. Product code must not read those manifests, hidden defect IDs,
or stored navigation routes. A valid fixture result records at least:

- TVDoctor version/commit;
- fixture version or commit;
- selected mode and effective budgets;
- discovered screen/focus/action counts;
- complete/partial run status;
- expected seeded defects in scope for the exercised product surface;
- observed deterministic findings and unexpected findings; and
- runtime/environment information needed to reproduce the gate.

Fixture recall is useful for regression testing. It is **not** an estimate of
accuracy on arbitrary production applications.

## 2. Synthetic stress validation

**Question:** do bounded algorithms and failure modes behave correctly under
controlled scale or variation?

Examples include generated carousels, alternate semantic routes, baseline
clean/regressed variants, fake-driver graphs, malformed protocol input, forced
budget exhaustion, and deliberately missing evidence.

Synthetic validation should report the property being tested: action/state
growth, termination reason, replay/restoration behavior, comparison outcome,
memory/time bound, or fail-closed classification. It must not be presented as a
real-app compatibility result.

## 3. Real-app validation

**Question:** what happens when the current TVDoctor build scans an actual app it
was not designed around?

A useful real-app run is an observation, not a certification. Record enough
context to make the result auditable:

1. **Target identity:** app/site name, public version/build when known, package or
   authorised URL identity, and a hash for any locally preserved APK used in the
   run.
2. **Environment:** TVDoctor version/commit, OS, browser or Android API level,
   emulator/device model, viewport/display facts that materially affect focus,
   and driver version.
3. **Initial state:** signed-in/signed-out state, profile, consent/setup state,
   and any explicit preparation action. Never publish credentials.
4. **Run policy:** quick/deep mode, effective budgets, selected packs, and any
   operator-authorised action gates.
5. **Coverage:** complete/partial/failed status, discovered screens/focus states,
   physical actions, remaining frontier, unavailable evidence, and any coverage
   ledger blockers.
6. **Findings:** deterministic versus heuristic, reproduction availability, and
   whether a replay reproduced the issue.
7. **Repeatability:** rerun the same version/environment before making a strong
   stability claim. Record divergence instead of discarding it.

Do not call an app "clean" when the run is partial. Do not turn a single app run
into a platform-wide compatibility claim. Do not use a successful emulator run as
proof of physical-device/vendor behavior.

## Current real-app evidence

The repository currently documents bounded VLC for Android 3.7.1 emulator
evidence. One recorded Quick run on the API 36 Android TV emulator reached the
300-physical-action ceiling after 27 focus states, 12 screens, and 87
deterministic resets with no replay divergence or observer timeout. Eleven
frontier entries remained.

That result is intentionally classified as **partial**. It demonstrates that the
observer/explorer operated for a substantial bounded real-app run; it does not
show that VLC is defect-free, that every reachable state was explored, or that
other Android TV devices behave the same way.

## Per-run measurement record

Use one row per app/build/environment. Keep fixture, synthetic, and real-app rows
in separate result sets rather than combining them into one accuracy figure.

| App/build | Device/firmware | Known defects in scope | Detected | Missed | False positives after manual review | Nondeterministic findings | Replayable findings / replay successes | Exploration duration | Run status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `<name + version/build>` | `<model/API/firmware or browser/OS>` | `<count or n/a>` | `<count or n/a>` | `<count or n/a>` | `<count or n/a>` | `<count>` | `<replayable> / <successful>` | `<duration>` | `complete` / `partial` / `failed` |

Only calculate rates when the denominator is explicit and the required review or
ground truth exists:

- **Recall** = detected known in-scope defects / known defects in scope.
- **False-positive rate** = manually reviewed false-positive findings / all
  manually reviewed reported findings.
- **Replay success rate** = successful replays / replay attempts; state the replay
  attempt count even when every replayable finding was attempted.

Do not calculate these rates from unknown ground truth, unreviewed findings, or a
zero denominator. Do not aggregate fixture accuracy with real-app accuracy; they
measure different evidence populations.

## Reusable real-app benchmark workflow

### Experimental web navigation restoration A/B

The source-checkout web CLI has an **experimental** navigation restoration
selector. It is not a guarantee of reduced runtime on all sites and does not
change the default `root-only` policy. On Windows PowerShell, test both
settings against the *same authorised target*, browser/runtime, scan mode and
budgets, writing to fresh, separate output folders:

```powershell
$env:TVDOCTOR_WEB_NAV_RESTORATION = 'root-only'
tvdoctor scan 'https://example.test/app' --output 'artifacts/compare-root'
$env:TVDOCTOR_WEB_NAV_RESTORATION = 'verified-local'
tvdoctor scan 'https://example.test/app' --output 'artifacts/compare-local'
Remove-Item Env:TVDOCTOR_WEB_NAV_RESTORATION
```

The optional values are `verified-live-only` and `verified-local`. Both
retain verified identity checks, root fallback and self-loop refresh. The
effective mode is recorded in the scan's stage ledger. Compare elapsed wall
time, `resetCount`, `replayActions`, `verifiedPathRestorations`, graph
screen/focus/action identities, known-defect recall, reproduction results,
deferred frontier and termination status. A shorter run that misses defects or
turns partial coverage into an apparent success is **not** an improvement.
The synthetic four-focus A/B fixture includes deliberate reset latency; its
speedup must not be presented as real-app performance.

To compare actual root-only and verified-local navigation evidence from two
completed scans, rather than relying on counts or timing alone, run:

```sh
node scripts/compare-replay-performance.mjs artifacts/compare-root artifacts/compare-local
```

The comparison fails if either run changes observed screen, focus-target or
transition keys, problem/issue identities and confidences, verified focus
targets, navigation coverage, frontier, termination, policy or selected target.
It also checks that the exploration action counts match. If these invariants
hold, it prints physical action, replay action, reset and elapsed-time deltas.
Wall-time savings may vary across trials; run A/B/A under matched conditions.
This measures the observed graph, not unknowable app states or real-device
performance, and it will deliberately reject baseline/candidate runs made with
different fixture SELECT permissions.

Saved full-Deep Northstar fixture comparison: see
`benchmarks/deep-full-matched-results-2026-10-10.md`. Both modes exhausted the
locally authorised frontier at 18 screens/90 focus targets, with identical
observed graph and issue IDs. The opt-in verified-local run used 405 fewer
replay keys and 101 fewer resets in that one matched pair; three findings had
different element-position evidence, so the strict evidence comparison does
**not** pass and these measurements do not prove general production speedup.
For larger but budget-limited Chromium routes and 240-card rendering, also see
`benchmarks/deep-complex-results-2026-10-10.md`.

Verified restoration now keeps the standard priority-based branch order by
default. Internal callers can explicitly enable opportunisticFrontier to
favour a currently live branch, but this changes the order of coverage within
a finite budget. Web navigation relaunches to the starting URL in the same tab
to preserve sessionStorage when the app has changed its pathname.

Quick and Standard compress some repeated carousel positions and explicitly
report deferred coverage. Deep disables repetition compression by default
and has larger action, state and duration ceilings; it still reports partial
if any safety ceiling prevents complete exploration.
The source checkout's `scan` command now defaults to Standard with compression
disabled for more complete navigation. Pass `--mode quick` for the smaller sample
or `--mode deep` for the larger safety envelope. Use `--max-actions`,
`--max-states`, `--max-depth`, and `--max-duration-ms` to compare matched
limits; a duration override alone does not raise the other ceilings.

### Verifying fixture-only Deep coverage changes

The Northstar fixture permits opt-in testing of its two deliberately inert
profile-picker buttons with `--fixture-profile-select`. This flag is restricted
to the loopback fixture and is **not** a way to bypass account/profile safety
checks on real TV apps. The ordinary default still withholds unsafe SELECTs.

To check that an opt-in Deep run preserves the conservative run's complete
screen/focus/previously-applied-edge identities while verifying its previously
excluded actions, run:

```sh
node scripts/compare-deep-coverage.mjs artifacts/deep-full-20261008-retry-aggregate artifacts/deep-fixture-profile-20261009
```

This command fails on lost stable identities, omitted previously verified
edges, remaining unapplied actions, or unexhausted candidate coverage. It
compares observed navigation evidence, **not** undiscovered paths or complete
coverage of arbitrary apps. It cannot turn a partial scan into a passing one.

Deep scans can independently recapture fresh evidence for up to 128 distinct
findings (Quick and Standard remain capped at 32), with the same global
120-second evidence deadline and 20-second per-issue deadline. Exceeding those
bounds still marks the audit partial; simply exhausting the navigation queue
never guarantees full issue evidence or a completed overall report.

The repository includes a structured manifest and runner for repeating the same
bounded observation across real web and Android TV targets:

```sh
npm run benchmark:real-app -- run \
  --manifest benchmarks/real-app.template.json \
  --output artifacts/real-app-benchmark
```

Copy the template first and replace its example targets. The runner invokes only
the TVDoctor CLI with structured arguments; the manifest cannot supply an
arbitrary shell command. Web runs store the report target at origin scope by
default, while replay receives the authorised URL directly from the local
manifest.

Each raw case records audit wall runtime, the full report status and coverage,
finding counts, deterministic replay candidates/attempts/results, and replay wall
runtime. The runner replays only stored deterministic replays and respects the
per-case `maxAttempts` cap. A partial report stays partial in the benchmark data.

Manual false-positive review is separate because it requires a person. Copy
`benchmarks/manual-review.template.json`, replace the example issue ID with IDs
from that case's report, set `caseId` to the matching manifest case, classify each
as `confirmed`, `false-positive`, or `uncertain`, then add `manualReviewFile` to
that manifest case. Analyze the recorded run after review:

```sh
npm run benchmark:real-app -- analyze \
  --manifest benchmarks/my-real-apps.json \
  --run artifacts/real-app-benchmark/benchmark-run.json \
  --output artifacts/real-app-benchmark/analysis.json
```

The analysis records runtime, coverage, findings, replay attempts and successful
reproductions, plus the number of manually reviewed false positives. A
false-positive rate is emitted only when at least one finding was reviewed and no
reviewed finding remains `uncertain`. Missing review stays `null`; it is never
treated as zero false positives. Aggregate output is limited to counts and time;
it deliberately does not manufacture a cross-app accuracy or certification rate.

The analyzer also verifies that the manifest name and SHA-256 match the exact
manifest recorded by the run. It refuses a changed manifest instead of silently
joining new case metadata to old measurements. `analysis.json` records the raw
run SHA-256 plus the recorded TVDoctor/runtime/timestamp provenance without
embedding a machine-local absolute run path.

For a public benchmark, start with a **public-safe manifest**: do not put
credentials, private application URLs, sensitive device identifiers, or local
paths you cannot disclose into the manifest you intend to publish. Then run from
a clean reviewed commit and archive the exact manifest, `benchmark-run.json`, any
manual-review JSON, and `analysis.json` together. The raw run records the TVDoctor
package version, commit, and dirty-tree state. Treat `dirty: true`, a missing
commit, or missing/manual-review evidence as an evidence limitation rather than
editing generated benchmark files after the run. Review the bundle under the
[privacy guidance](privacy.md) before publishing it.

The harness self-tests are available as a stable repository command:

```sh
npm run test:benchmark
```

## Reporting rules

When publishing benchmark numbers:

- name the evidence category (`fixture`, `synthetic`, or `real-app`);
- include the exact target and environment scope;
- include complete/partial/failed status beside the metric;
- distinguish deterministic findings from heuristics;
- publish remaining frontier or unavailable-evidence counts when non-zero;
- avoid unsupported "accuracy", false-positive-rate, or compatibility percentages;
- do not compare runtime across unlike hardware/environments as if it were a
  product regression; and
- link to the reproducible command/artifact when it is safe to share.

The strongest public claim is the narrowest one supported by the recorded
evidence.
