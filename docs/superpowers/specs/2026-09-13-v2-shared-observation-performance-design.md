# V2 Shared Observation Performance Architecture

## Purpose

TVDoctor should become materially faster without reducing APK, Android TV, or web test quality. The optimization target is redundant physical work: repeated settling, repeated snapshots, repeated traversal, repeated state reconstruction, and repeated evidence setup. A faster implementation that discovers fewer expected states, screens, or findings is a regression.

This design builds on the existing deterministic traversal and verified-local restoration work. It introduces five connected capabilities:

1. one authoritative settled observation that can serve multiple compatible checks;
2. Android Observer Protocol V3 with incremental state deltas and bounded canonical revalidation;
3. verified reversible navigation edges for exact local restoration;
4. adaptive Deep ordering that prioritizes novel work without reducing declared coverage;
5. a performance-and-coverage regression gate that rejects speedups that weaken results.

The design preserves APK inspection, compatibility checks, Android installation and launch behavior, observer verification, ADB control, API 36 integration coverage, screenshots/logs/evidence, replay integrity, Quick and Deep profiles, package boundaries, operator gates, and fail-closed behavior.

## Goals

- Reduce end-to-end wall time by eliminating duplicated observation and navigation work.
- Preserve or improve verified graph coverage and expected findings.
- Keep APK testing and Android observer flows compatible with existing supported devices and CI fixtures.
- Make one settled physical action produce one reusable authoritative observation whenever the driver can prove that observation is current.
- Let multiple analysis consumers reuse the same canonical observation instead of independently recollecting equivalent state.
- Reduce Android accessibility-tree reconstruction and host-side full-tree copying when only focus or bounded node state changes.
- Reuse exact reversible navigation only after both directions have been observed and verified.
- Prioritize novel screens and structures in Deep mode while retaining the same declared safe frontier and budget semantics.
- Add benchmark fixtures and hard regression checks that compare both performance and coverage.
- Retain conservative fallback paths for every optimization.

## Non-goals

- Lowering Quick or Deep action, state, depth, or duration budgets merely to produce smaller runtimes.
- Treating a driver assertion as proof when the platform driver cannot provide a verified settled observation.
- Trusting unvalidated Android deltas indefinitely.
- Assuming directional actions are reversible before exact reverse behavior is observed.
- Skipping full canonical observations after risky boundaries such as launch, reset, package/window change, observer reconnect, or structural invalidation.
- Parallelizing physical Android remote actions.
- Weakening package-boundary, destructive-action, authentication, payment, or other operator gates.
- Replacing the existing report schema as part of this change.

## Core invariant

A performance optimization is accepted only when it preserves the expected semantic result.

For benchmark fixtures, the optimized run must satisfy all of the following unless the fixture explicitly documents an intentional behavior change:

- expected reachable screen identities are preserved;
- expected canonical states are preserved or a stricter equivalence relation proves them redundant;
- expected findings are preserved;
- expected declared exclusions remain unchanged;
- no new replay divergence or restoration failure is introduced;
- Android target/package boundaries remain unchanged;
- operator-gated actions remain gated;
- APK compatibility and observer verification remain intact.

The benchmark gate reports speed improvements only after these coverage conditions pass.

## Architecture

The execution model becomes:

```text
physical action / launch / reset
        |
        v
platform driver + observer
        |
        v
verified settled observation
        |
        v
canonical observation store
        |
        +------------------------------+
        |              |               |
        v              v               v
navigation        accessibility      layout/settings/
state graph          checks          streaming/perf
        |              |               |
        +--------------+---------------+
                       |
                       v
              deterministic findings
                       |
                       v
             evidence + final report
```

The canonical observation store is the coordination point. It does not invent semantics and it does not permit mutable consumers to change canonical state. Consumers receive immutable or defensively isolated observation views.

## 1. Shared authoritative observations

### Driver result contract

A platform action may return an optional post-action observation together with an explicit proof classification.

Conceptually:

```ts
interface SettledObservationProof {
  readonly kind: "driver-verified" | "unverified";
  readonly source: string;
  readonly observationVersion: string;
}

interface ActionResult {
  readonly timing?: ActionTiming;
  readonly postActionSnapshot?: ProtocolSnapshot;
  readonly settlingProof?: SettledObservationProof;
}
```

The exact public type names may follow existing protocol conventions, but the semantic rule is fixed:

- `driver-verified` means the driver itself completed its platform-specific settling boundary and the attached canonical observation was captured after that boundary;
- `unverified` or absence means core must use the existing conservative settling policy.

Core must never infer proof merely because `postActionSnapshot` exists.

### Android fast path

The Android observer already owns the platform event/quiet-window boundary for an action. Observer V3 may return a final canonical state from that settle operation. The Android driver can mark that state `driver-verified` only when:

- action sequence identity matches;
- observer connection remains valid;
- target-window/package observation remains valid;
- the settle operation completes without timeout or ambiguity;
- canonical-state construction succeeds.

If any condition fails, the driver returns no verified proof and core falls back to the existing multi-snapshot stable-settling path.

### Web fast path

The web driver already waits for its page-settle boundary after key input. It should capture one navigation observation after that boundary and return it as the post-action snapshot with driver verification when its settle contract succeeds. If page settlement is incomplete or the observation capture fails, core falls back to current stable-snapshot behavior.

### Observation reuse

A single canonical observation can be consumed by multiple checks only when the required data is present and semantically compatible.

Each consumer declares the observation capabilities it requires, for example:

```text
navigation-identity
focus-semantics
accessibility-tree
viewport-layout
media-state
network-summary
performance-summary
```

A consumer that requires data not present in the shared observation requests an enrichment. Enrichment augments the observation record for that state rather than forcing independent re-navigation when the current exact state is still verified.

The store keys observations by exact canonical state identity plus preparation/session identity. Data from one APK hash, browser preparation, package, device session, or observer epoch must not leak into another.

## 2. Android Observer Protocol V3

### Motivation

The existing observer can reconstruct the entire accessibility hierarchy for a state capture, and the host can rebuild focus state across the cached tree. This is correct but expensive for repeated D-pad navigation where structure often remains stable and only focus moves.

V3 adds bounded incremental state while preserving canonical full-state checkpoints.

### Observer state

The observer maintains, per active target window/epoch:

- canonical structure cache;
- structure fingerprint;
- stable node identifiers;
- focused stable identifier;
- window/package identity;
- structural generation number;
- event generation number;
- `structureDirty` state;
- last full-validation timestamp/action count.

### Delta classes

V3 may emit these bounded update classes:

- `focusChanged`: focus identity changed with no structural invalidation;
- `nodeChanged`: bounded known nodes changed properties while structure identity remained valid;
- `windowChanged`: active window/package identity changed;
- `treeInvalidated`: structure can no longer be trusted incrementally;
- `fullState`: canonical full tree and focus state.

Deltas include observer epoch, prior generation, next generation, and enough identity data for the host to reject out-of-order or mismatched updates.

### Fail-closed delta application

The host applies a delta only when all sequence and fingerprint preconditions match its cached canonical state. Any mismatch discards the incremental fast path and requests a full state.

A delta is never accepted across:

- observer reconnect;
- app relaunch;
- device reset;
- package/window boundary change;
- unknown accessibility event class;
- missed generation;
- stale sequence/action identifier;
- failed hash/fingerprint precondition.

### Mandatory full checkpoints

A canonical full observation is required after:

- launch or relaunch;
- reset/root restoration;
- observer reconnect;
- target package/window change;
- SELECT and BACK when they produce a structural or window invalidation;
- any `treeInvalidated` event;
- any rejected or ambiguous delta;
- periodic deterministic validation thresholds.

Periodic validation must be action-count based rather than wall-clock based so benchmark behavior is deterministic. The implementation plan will choose and test a conservative default threshold.

### Host focus update

The Android driver should avoid recursively allocating a complete new tree when only focus changes. The cached tree maintains a stable-id index or path map. A pure focus delta updates only the previously focused and newly focused paths/nodes necessary to expose an immutable canonical snapshot.

Implementation may use persistent/path-copy structures or a canonical node table plus immutable snapshot projection. The chosen representation must preserve existing protocol output semantics.

## 3. Verified reversible navigation

### Definition

A directional transition is reversible only after TVDoctor has directly verified both transitions with exact canonical identities.

Example:

```text
A --RIGHT--> B
B --LEFT --> A
```

Once both observations exist, the graph may record the pair as a verified reversible edge.

Candidate inverse pairs are limited initially to:

- LEFT / RIGHT;
- RIGHT / LEFT;
- UP / DOWN;
- DOWN / UP.

SELECT, BACK, HOME, media controls, and arbitrary actions are never inferred reversible by this feature.

### Use for restoration

When the engine needs to return to a source state for sibling exploration, it may prefer a currently verified reversible route over root reset plus replay if:

- current exact state identity is known;
- every edge in the route is currently verified;
- route ends at the exact requested source identity;
- target package/session identity remains unchanged.

After executing the route, TVDoctor requires exact canonical identity at the destination. A mismatch revokes the failed reversible edge or route proof and immediately falls back to canonical root restoration.

### Revocation

Reversible proof is scoped to the prepared session/graph epoch. It is revoked by:

- observed inverse mismatch;
- replay divergence;
- package/window change that invalidates state identity;
- preparation/session restart;
- graph identity/version incompatibility.

Revocation affects optimization only. The underlying observed directed transitions remain part of the graph evidence.

## 4. Adaptive Deep ordering

### Coverage rule

Adaptive ordering changes which safe frontier work is attempted first. It does not silently discard safe work.

Deep retains its declared budgets, action policy, package boundary, operator gates, and completion criteria. If budget expires with safe work remaining, the result remains partial exactly as before.

### Priority signals

Deep frontier priority may use deterministic semantic signals available before execution:

1. unseen screen identity or route class;
2. unseen dialog/window class;
3. player/media surface;
4. structurally novel focus graph/tree signature;
5. state adjacent to previously observed failure or anomaly;
6. low repetition-equivalence frequency;
7. ordinary repeated structure work.

Measured wall time must not participate in priority because timing noise would make traversal order nondeterministic.

### Repetition handling

Existing repetition compression remains conservative. Adaptive ordering can defer members of a proven repeated group while it explores novel work, but every deferred item retains explicit ledger/accounting state. Deep may only mark coverage complete when the declared safe frontier is exhausted under existing equivalence/compression semantics.

No new broad bisimulation/compression rule is introduced in the first implementation phase. That keeps adaptive ordering separate from any future change to equivalence semantics.

### Deterministic tie breaking

Tie breaks preserve stable values such as existing priority class, depth, sequence number, action order, and insertion order. Repeated runs against the same deterministic fixture must choose the same frontier order.

## 5. Performance and coverage regression gate

### Required metrics

Benchmark runs record at minimum:

- total wall time;
- physical actions;
- replay/restoration actions;
- resets/root restorations;
- observer bytes transferred;
- observer full-state captures;
- observer delta updates;
- total snapshots;
- settling polls;
- states discovered;
- distinct screen identities;
- findings by deterministic identity/severity;
- replay/restoration failures;
- remaining safe frontier at termination.

Web-specific and Android-specific timing breakdowns may be added when stable enough for automated comparison.

### Fixture classes

The benchmark suite must include deterministic fixtures representing at least:

- small/simple navigation;
- large carousel/grid navigation;
- settings/dialog-heavy navigation;
- player/media surface;
- deliberately broken accessibility/navigation behavior;
- complex web TV navigation;
- packaged Android observer/API 36 integration fixture where CI supports it.

The suite should prefer repository-owned deterministic fixtures over public third-party apps for the hard gate. Physical third-party APKs such as VLC remain useful for manual/extended performance evidence but cannot be the only regression oracle.

### Coverage acceptance

For hard-gated fixtures, the optimized candidate must match the fixture's expected semantic baseline. Comparison includes state/screen identities, deterministic findings, declared exclusions, and completion/partial status.

A candidate fails if it is faster only because it:

- performs fewer required checks;
- leaves additional safe frontier unexplored;
- loses expected findings;
- changes a completed fixture to partial;
- increases replay divergence/restoration failures;
- bypasses observer or APK verification.

### Performance acceptance

Coverage correctness is evaluated first. Performance metrics are evaluated only after coverage passes.

Initial CI should gate against catastrophic regressions rather than enforce fragile microsecond thresholds. Stable repository fixtures can use bounded percentage thresholds after enough baseline data exists. Benchmark reports must retain raw metrics so maintainers can inspect improvement even before a strict speed threshold is enabled.

Repeated local or dedicated benchmark runs should report median and p95 where practical. Ordinary functional CI does not need repeated long-running benchmarks for every test case.

## Compatibility and fallbacks

All optimizations are optional fast paths layered over existing conservative behavior.

- Missing driver settling proof -> existing core stable-snapshot settling.
- Android V3 unsupported -> existing/full-state observer behavior.
- Delta mismatch -> request full canonical state.
- Reversible path unavailable -> verified-local or root restoration.
- Reversible route mismatch -> revoke and root restore.
- Shared observation missing a required capability -> enrich or recollect while exact state is verified.
- Benchmark fixture cannot prove semantic equivalence -> candidate is not accepted as a performance win.

Protocol negotiation must allow the host to detect observer capability/version. The host must not assume V3 merely because an observer package is present.

## APK and device-test preservation

APK testing remains a first-class gate. This architecture does not remove or bypass:

- APK extension/metadata inspection;
- package/version/launchable/leanback metadata extraction;
- minSdk and ABI compatibility checks;
- ADB device authorization/online checks;
- Android TV/device metadata checks;
- APK installation when required;
- target launch and target-package validation;
- observer package verification and forwarding;
- API 36 emulator/integration coverage;
- packaged observer fixture verification;
- screenshots, logs, replay evidence, cleanup, and force-stop behavior.

Any future APK-install or observer-install cache must use exact artifact identity and fail closed to normal installation; it is intentionally outside the first implementation scope of this five-part design.

## Data ownership and isolation

The canonical observation store and graph are run-scoped. They must not share mutable state across concurrent audits.

Keys include enough preparation identity to prevent accidental reuse across incompatible sessions. At minimum this includes platform, target identity, run/preparation epoch, and observer/driver observation-version identity. Android state must also remain scoped to the selected device serial and package.

Consumers may cache derived deterministic values keyed by canonical observation identity, but cache entries must be invalidated when observation-version or canonicalization semantics change.

## Error handling

- Driver claims verification but omits a usable observation: reject proof and use conservative settling.
- Driver-verified observation fails canonicalization: fail the action or use the existing fallback according to current action semantics; never accept an unknown state as verified.
- Observer delta generation mismatch: discard delta chain and request full state.
- Full-state revalidation disagrees with incremental cache: replace cache with full canonical state, record diagnostic counter, and continue only if target/session identity remains valid.
- Reversible restoration mismatch: revoke optimization proof and perform canonical restoration.
- Adaptive scheduler bug leaves safe work unaccounted: benchmark/coverage tests fail; production completion logic must remain based on authoritative frontier accounting.
- Benchmark metrics unavailable: functional tests may pass, but performance claim/gate for that fixture is unavailable rather than fabricated.

## Implementation boundaries

The work should be split into independently reviewable stages, each retaining full fallback behavior:

1. benchmark/coverage instrumentation and deterministic fixture gate;
2. shared observation contract/store plus Android/web driver-attested settling;
3. Android Observer V3 deltas and host cache with canonical checkpoints;
4. verified reversible graph edges/restoration;
5. Adaptive Deep deterministic priority ordering;
6. final integrated Quick/Deep and APK/API36 verification plus before/after benchmark report.

The benchmark gate is implemented before aggressive optimization so later stages have an objective safety oracle.

## Testing strategy

Implementation follows test-driven development.

### Unit tests

Cover:

- settling proof accepted only when explicitly verified;
- absence/invalid proof falls back to existing settling;
- observation capability matching and enrichment;
- observation store isolation by session/preparation identity;
- Android V3 generation ordering and stale-delta rejection;
- full checkpoint replacement after delta mismatch;
- pure focus delta does not require full structural rebuild;
- inverse directional pair becomes reversible only after both exact transitions exist;
- failed inverse exact match revokes reversible proof;
- adaptive priority orders novel screens/dialogs/player structures before repeated work;
- deterministic tie-breaking remains stable;
- benchmark semantic comparator rejects lost states/screens/findings.

### Integration tests

Cover:

- browser navigation uses one verified post-action observation when web settle succeeds;
- browser falls back to stable snapshots when proof is unavailable;
- Android observer V3 settle produces a verified post-action observation;
- Android full-state fallback still works when V3 delta is disabled or rejected;
- verified reversible restoration returns exact source state;
- reversible mismatch triggers root restoration;
- Deep fixture reaches the same expected coverage with changed ordering;
- existing CLI/replay/report flows remain compatible.

### Android/API verification

Retain and run the existing Android TV observer/API 36 gates, including the packaged observer integration fixture. Add V3 negotiation and delta/full-state coverage without deleting V2/full-state compatibility tests until migration is proven.

### Full-suite acceptance

Before completion:

- build passes;
- lint passes;
- typecheck passes;
- unit suite passes;
- browser fixture and driver integrations pass;
- core explorer/carousel/baseline integrations pass;
- report/replay integrations pass;
- streaming journey integration passes;
- exact CLI M7 integration passes;
- baseline consumer example passes;
- package tarball/clean-consumer smoke passes;
- Android API 36 observer/integration passes;
- performance-and-coverage fixture gate passes.

## Rollout and observability

New fast paths should expose bounded counters in benchmark/debug telemetry so regressions are diagnosable, including:

- driverVerifiedObservations;
- settlingFallbacks;
- observerFullStates;
- observerDeltasApplied;
- observerDeltaFallbacks;
- reversibleRestorations;
- reversibleRestorationFallbacks;
- sharedObservationHits;
- observationEnrichments.

These metrics do not need to become permanent user-facing report fields unless product requirements later demand them.

A temporary development kill switch may disable each major fast path for A/B verification. Kill switches are for validation and rollback, not for masking failing tests. The conservative path remains executable throughout rollout.

## Acceptance criteria

The architecture is complete when all five capabilities are implemented and the following are true:

1. APK testing and existing Android device/API36 gates still pass.
2. A verified platform action can produce one authoritative observation reused by compatible checks.
3. Android V3 applies bounded deltas for eligible state changes and deterministically falls back to full canonical state on uncertainty.
4. Directional reversible routes are used only after exact bidirectional proof and are revoked/fallback safely on mismatch.
5. Deep prioritizes deterministic novel work without changing declared coverage semantics or silently removing safe frontier work.
6. Repository benchmark fixtures compare both semantic coverage and performance metrics.
7. No performance result is reported as a win when expected states, screens, findings, completion status, replay integrity, or APK/observer verification regress.
8. A final before/after benchmark report records end-to-end results separately from mechanism microbenchmarks.

## Implementation order

The approved order is:

1. performance + coverage regression gate;
2. shared observations and driver-attested settling;
3. Android Observer Protocol V3;
4. verified reversible navigation;
5. Adaptive Deep ordering;
6. integrated benchmark and APK/API36 validation.

This ordering deliberately puts the semantic regression oracle ahead of the more aggressive optimizations.