# Architecture

TVDoctor separates platform control, deterministic exploration, semantic
diagnosis, evidence production, and regression comparison. That separation is
the main compatibility boundary for new drivers and packs.

```text
                         platform-owned probes
                         (DOM / ADB / pointer)
                                  │
                                  ▼
CLI or library caller ───────► TVDoctorDriver
                                  │ actions + snapshots
                                  ▼
                         deterministic core
                         screen graph / focus graph
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
        semantic diagnostic packs          exact replay engine
                 │                                 │
                 └────────────────┬────────────────┘
                                  ▼
                           canonical report
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
        HTML / Markdown / evidence          baseline comparison
```

## Package ownership

| Package | Responsibility | Must not own |
| --- | --- | --- |
| `@tvdoctor/protocol` | JSON-safe driver, issue, report, and replay contracts; strict validation | Browser, Android, fixture, or filesystem behaviour |
| `@tvdoctor/driver-web` | Chromium launch/input, DOM-derived snapshots, screenshots, logs, network/performance/media observations | Diagnostic verdicts or fixture routes |
| `@tvdoctor/driver-android` | Structured ADB operations, DPAD input, UIAutomator hierarchy, screenshots, logs, device/app metadata | Emulator lifecycle or unsupported capability claims |
| `@tvdoctor/core` | Fingerprints, bounded exploration, state graphs, navigation diagnostics, sequence minimisation, replay | DOM selectors, resource IDs, shell commands, report files |
| `@tvdoctor/pack-streaming` | Semantic details/player/settings/captions journey and streaming verdicts | Platform-specific pointer implementation or stored fixture path |
| `@tvdoctor/pack-web` | Independent search, settings, accessibility, layout, performance, and crash stages | Browser-only facts unless supplied through explicit hooks |
| `@tvdoctor/reporters` | Confined artifact storage, canonical report construction, renderers, redaction | Launching targets or sending input |
| `@tvdoctor/baseline` | Versioned current-vs-baseline comparison with fail-closed observability checks | Running an audit or inventing missing inventory |
| `tvdoctor` | User-facing argument validation, environment diagnostics, audit/replay orchestration | Weakening library invariants for CLI convenience |

## Driver contract

Every platform adapter implements the small `TVDoctorDriver` surface:

- required `capabilities()`, `press()`, and `snapshot()` methods;
- optional screenshot, reset, install, launch, and log operations;
- explicit available/unavailable observations instead of guessed values;
- normalised remote keys: Up, Down, Left, Right, Select, and Back;
- JSON-serialisable UI hierarchy, focus, names, roles, bounds, and state.

Capabilities describe what a driver can observe or perform, not what the target
application supports. A driver must not advertise `accessibility-tree`, for
example, when it only has a DOM-shaped semantic tree.

## Exploration model

The core keeps two identities separate:

- a `ScreenState` describes structural UI identity without focus;
- a `FocusState` describes the focused target inside a screen.

Every retained state has a reset-relative key sequence. Before expanding a
state, the explorer restores the same root and replays that sequence, preventing
sibling actions from inheriting hidden side effects. Actions, retained states,
depth, duration, and driver calls are bounded. Quick, standard, and deep profiles
are explicit resource envelopes rather than accuracy labels.

Repeated carousel cells are compressed only when their sibling structure,
generated identifier pattern, role, interaction state, and layout provide a
conservative equivalence signal. Compression, exact repeats, and deferred
expansion remain visible in run statistics.

## Semantic packs and observability

Packs consume driver snapshots and remote outcomes. They do not learn private
fixture routes. Browser-only facts—computed focus styling, viewport clipping,
isolated pointer activation, or exact text entry—arrive through narrow hooks
owned by the web host. Android or future platforms can decline those hooks and
receive an honest unobservable/partial result.

Deterministic findings require deterministic evidence. Heuristics are labelled
as such. Missing labels, logs, bounds, focus, or timing cannot become a pass.
Safe settings stages do not activate account, purchase, payment, subscription,
destructive, or ambiguous controls.

## Reports and replay

`report.json` is the canonical model. HTML, human Markdown, and AI-coder
Markdown are derived views. Evidence artifacts use generated relative paths
under one explicit output root and carry size/hash metadata.

Replay V1 correlates a report issue, a portable replay, reset strategy, original
sequence, focus checkpoint, and final transition assertion. A replay can report
reproduced, fixed, inconclusive, or error. Only a trusted deterministic replay
that matches an explicit corrected state can report fixed.

Visual styling, geometry, numeric playback, latency, and console-log assertions
are outside Replay V1. Those issues remain review-only until a future schema can
express and verify their semantics.

## Baseline comparison

Baselines preserve semantic issue and UI inventory rather than report prose or
traversal IDs. A comparison can identify new/resolved issues, added/removed
screens and focus targets, transition changes, and latency regressions. It fails
closed if target identity, schema, pack coverage, capabilities, run status, or
required observations are incompatible.

## Trust boundaries

Target URLs, names, hierarchy text, logs, and network metadata are untrusted.
Drivers and reporters bound and sanitise them, but operators must still review
artifacts before sharing. Filesystem paths, APKs, output roots, device serials,
and CI credentials are trusted operator inputs and must never be derived from a
target page.

TVDoctor is local-first. AI-coder output is plain derived Markdown; no AI service
or network account is required by the core workflow.
