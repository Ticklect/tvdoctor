# Android Comprehensive Traversal Design

## Purpose

TVDoctor's Android scan must explore every reachable, safe, target-owned part
of an application rather than sampling a representative subset. Operators must
be able to choose between an efficient deterministic traversal and a deliberately
expansive brute-force traversal after choosing Quick or Deep scan depth.

The design addresses product-controlled limitations: replay overhead that makes
VLC Quick exhaust its physical-action budget, media and HOME action coverage,
and incomplete observability reporting. It does not claim to remove platform or
operational constraints that code cannot remove: comprehensive physical/vendor
device certification and protected release signing still require maintainer
hardware and credentials.

## Goals

- Present two traversal strategies for every interactive Android scan after the
  operator chooses Quick or Deep.
- Provide equivalent non-interactive CLI selection.
- Explore all safe, observable, target-owned work to exhaustion within the
  selected strategy's declared budgets.
- Include target-owned media behavior in automatic traversal.
- Exercise HOME as an explicit target-boundary probe, record its effect, and
  restore the target without exploring launcher or unrelated system UI.
- Keep authenticated, payment, purchase, account-deletion, and destructive
  actions operator-gated.
- Reduce VLC replay overhead without weakening exact state and replay checks.
- Produce a bounded ledger that accounts for every considered state/action and
  distinguishes exercised, restored, gated, inaccessible, and failed work.
- Remain fail-closed when Android or the tested app blocks observation.

## Non-goals

- Bypassing Android secure-surface protections.
- Claiming semantics that an application does not expose.
- Automatically supplying credentials, accepting payments, purchasing items,
  changing subscriptions, deleting accounts, or activating destructive controls.
- Expanding the Android launcher, permission controller, or unrelated system UI
  as though it belonged to the target application.
- Promoting physical/vendor compatibility without a maintained device matrix.
- Embedding or inventing release-signing secrets.
- Replacing the strict `tvdoctor.report/v1` schema in this change.

## User experience

The guided Android flow continues to ask for a scan depth:

1. Quick Scan
2. Deep Scan (experimental)

It then asks for a traversal strategy:

1. **Adaptive deterministic — Recommended**: explore every safe target-owned
   action, include media controls, test HOME with immediate restoration, reuse
   verified states, and report all blocked or inaccessible work.
2. **Brute-force expansion**: try every supported remote key from every
   reachable target-owned state with larger budgets. This is slower and noisier,
   but it retains the same operator gates and package boundary.

The first option is selected by default. Escape cancels without starting a scan.

Non-interactive Android runs accept:

```text
--strategy adaptive
--strategy brute-force
```

Omission defaults to `adaptive`. Unknown or duplicate strategy options are usage
errors. Help, plan output, progress summaries, report environment metadata, and
the coverage ledger all identify the effective strategy.

## Traversal model

### Shared action policy

A focused action-policy unit receives the current canonical state, target package,
active target media-session metadata, requested strategy, and operator
authorization. It returns deterministic action decisions in stable order.

Each decision has one of these classes:

- `automatic`: safe to exercise without further authorization;
- `target-boundary`: exercise, record, and immediately restore the target;
- `operator-gated`: discover and report, but do not exercise without an explicit
  operator-authored authorization;
- `inaccessible`: insufficient observation exists to exercise the action safely.

Navigation actions remain `UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, and `BACK`.
Media actions are `PLAY_PAUSE`, `PLAY`, `PAUSE`, `STOP`, `NEXT`, `PREVIOUS`,
`REWIND`, and `FAST_FORWARD`. HOME is a target-boundary action.

Semantic risk classification prevents automatic SELECT on controls whose exposed
text, role, or state identifies authentication, payment, purchase, subscription,
account deletion, data deletion, factory reset, or another destructive effect.
Ambiguous controls remain gated rather than assumed safe. An authorization must
name the intended action/control; a blanket implicit authorization is not
introduced by choosing brute force.

### Adaptive deterministic strategy

Adaptive traversal preserves exact canonical-state validation while avoiding
unnecessary root restoration and path replay.

1. A settled action that returns the exact source-state identity is a proven
   self-loop. The next action may start from that still-verified state without a
   reset.
2. A shortest previously recorded graph path may restore a source state locally
   only when the path begins at the engine's exact current state, ends at the
   required source state, every action and checkpoint was already proven, and the
   final exact canonical state identity matches the required source.
3. A failed or mismatched local restoration is not accepted. The engine falls
   back once to the existing root restoration plus checkpointed replay.
4. A failed root restoration or replay ends the run as partial with the existing
   authoritative termination reason.
5. New-screen work remains prioritized, but safe work is not silently discarded.
   Compression may defer structurally equivalent work only when its accounting is
   explicit in the ledger and the existing conservative equivalence rules prove
   the group.

Media actions enter the adaptive frontier when the target owns an active media
session or the current target-owned state exposes a player/media surface. HOME is
tested at the prepared target root and once for each distinct target-owned screen
class where behavior differs; it is not multiplied across equivalent focus states.

### Brute-force expansion strategy

Brute force sends every supported remote key from every reachable target-owned
state. It disables adaptive action pruning and uses a larger explicit budget
profile. It may still use exact verified state restoration because restoration is
an integrity mechanism, not a coverage shortcut.

Leaving the target package never adds launcher or system states to the expandable
frontier. HOME and any other cross-package action are retained as observed
transitions, followed by immediate target restoration. Operator-gated controls
remain gated unless specifically authorized.

## Target boundary and restoration

The existing `shouldExpand` package guard remains authoritative. A transition is
target-owned only when its observed location starts with the selected Android
package URI. Cross-package transitions are recorded but never expanded.

After HOME or another cross-package transition, TVDoctor relaunches the prepared
target state, waits for the target-owned focused window, and requires the exact
prepared canonical fingerprint. Restoration failure stops expansion, forces
bounded cleanup, and makes the run partial.

## Observation model

Accessibility remains the primary semantic source. TVDoctor adds bounded
secondary observations without treating them as equivalent semantics:

- an in-memory screenshot fingerprint to detect visible state changes when the
  accessibility tree is sparse;
- target window/package identity;
- target-owned active media-session metadata;
- bounded target log evidence.

Screenshot fingerprints are computed without retaining every screenshot. They
may prove visual change or stability, but they do not invent labels, roles, focus,
or action safety. When semantic observation is insufficient, directional actions
may be observed visually, but SELECT and other activation actions remain gated.

If both accessibility and screenshot evidence are blocked, the state is
`inaccessible`. TVDoctor does not attempt to bypass Android secure surfaces and
does not report the state as clean or fully explored.

## Coverage ledger

Every Android run writes a bounded `android-coverage-ledger.json` run artifact
with schema identifier `tvdoctor.android-coverage/v1`. The artifact contains:

- schema/version identifier and selected strategy;
- target package and effective budgets;
- one bounded entry per considered state/action;
- source screen/focus identity and action;
- disposition: `exercised`, `verified-state-reuse`, `boundary-restored`,
  `operator-gated`, `inaccessible`, or `failed`;
- deterministic reason code and bounded human-readable detail;
- source and destination package identities;
- evidence-channel availability;
- restoration method and exact-match result when restoration occurred;
- aggregate counts and remaining safe frontier.

The ledger is sanitised and bounded with the same hostile-data rules as other
report evidence. It is registered as the well-known run-level `report` artifact
`run:android-coverage-ledger` so `tvdoctor.report/v1` remains compatible. Report
renderers identify and link that artifact from the coverage section. The report's
target environment records the strategy, pack coverage is `completed` only when
safe observable work is exhausted, and a partial run points to the ledger as the
detailed reason source.

Operator-gated work is an explicit declared exclusion and does not by itself make
safe-scope coverage partial. Inaccessible work, failed work, an exhausted budget,
or remaining safe frontier always makes the run partial.

## Failure handling

- Exact fingerprint mismatch during local reuse: reject reuse and fall back to
  root restoration.
- Exact fingerprint mismatch during root replay: terminate as replay-diverged.
- HOME/cross-package restoration failure: terminate as restoration-failed.
- Missing target-owned media session after a media action: retain the observation
  as a deterministic no-op or target behavior; do not invent progress.
- Sparse accessibility with usable screenshot: permit only actions whose safety
  does not require missing semantics and record visual-only evidence.
- Accessibility and screenshot both unavailable: mark inaccessible and retain a
  partial result.
- Coverage-ledger write failure: retain the canonical report, mark the ledger
  artifact failed, and keep the run partial because accounting proof is missing.
- Cancellation: stop between bounded operations, write available ledger state,
  force-stop the target, close observer resources, and remove ADB forwarding.

## Verification and acceptance

Implementation follows test-driven development.

Unit and deterministic integration coverage must prove:

- interactive strategy selection and `--strategy` parsing/defaults;
- distinct adaptive and brute-force configuration;
- stable action-policy ordering;
- media-action inclusion;
- HOME recording, package-boundary exclusion, and exact restoration;
- semantic risk gating and explicit authorization;
- self-loop reuse with fewer reset/replay actions;
- verified local return and exact-mismatch fallback;
- no reduction in deterministic graph coverage from adaptive reuse;
- screenshot-fingerprint fallback without semantic overclaiming;
- inaccessible secure-surface accounting;
- bounded, sanitised, deterministic coverage-ledger output;
- report completion/partial status derived from ledger and frontier truth.

The Android fixture gate adds a deterministic player/media surface, a target exit
boundary, operator-gated destructive controls, sparse accessibility, and a secure
surface. The gate verifies behavior rather than bypassing platform protection.

VLC for Android 3.7.1 acceptance requires three consecutive Adaptive Quick runs
on the existing API 36 emulator and preserved APK. Each run must:

- terminate complete with zero remaining safe frontier;
- remain below 300 physical actions;
- discover at least 12 screen states and 27 focus states;
- test at least 85 transitions;
- report no replay divergence, restoration failure, observer timeout, or
  inaccessible target-owned work;
- produce a valid coverage ledger and report bundle.

The full release verification then runs lint, typecheck, all unit and integration
tests, package smoke, and the hosted Android emulator gate. The VLC action-ceiling
limitation is removed only after the three-run evidence exists. Documentation
replaces the old HOME/media limitation with the two-strategy behavior and explains
fail-closed inaccessible-surface accounting.

Physical/vendor certification and protected release signing remain separate
external follow-up work until maintainers provide the required device matrix and
environment-scoped signing secrets.
