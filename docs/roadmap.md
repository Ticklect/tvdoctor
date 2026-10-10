# Roadmap

The roadmap describes evidence gates, not promised dates. A feature moves to a
higher support level only after its complete gate is repeatable.

The v1 product priority is automatic TV remote-navigation discovery: explore the
D-pad/focus graph, report evidence-backed navigation findings, preserve honest
coverage status, replay deterministic transitions where supported, and compare
reviewed semantic baselines. The broader diagnostic packs below are existing
secondary capabilities, not the primary product promise.

## v0.1 public preview

### Already evidenced

- platform-neutral protocol, bounded automatic exploration, fixture-independent
  navigation diagnostics, semantic issue IDs, `navigation-graph.json` /
  `navigation-graph.md`, report/replay V1, and local report renderers;
- real-Chromium web driver gates against the Northstar fixture;
- versioned fail-closed baseline creation/comparison and a locally validated CI
  workflow;
- complete M9 Android TV emulator gate: disposable API 36 emulator installs the
  native fixture, proves DPAD navigation and Select, triggers the seeded focus
  loss defect, captures screenshot/log evidence, and tears down cleanly;
- experimental persistent Android observer driver with bounded protocol,
  event-driven settling, real emulator performance/replay/cancellation evidence,
  and fake-transport tests;
- repeated-carousel compression, priority frontier, explicit exploration
  profiles, stronger settling, and exact sequence minimisation;

Secondary capabilities with controlled evidence also exist:

- 17-stage semantic streaming journey with four in-scope deterministic fixture
  findings and honest replay availability;
- search/settings/accessibility/layout/performance/crash pack libraries;
- complete M7 controlled web fixture audit with six independent stages,
  five deterministic seeds, and locked evidence/report expectations;
- complete M8 large-carousel benchmark: 240-card real-Chromium gate proves
  compression retains one representative instead of 240 states, hardened
  exploration completes where uncompressed BFS cannot, recall preserved,
  and structural output is deterministic across runs;
- complete M10 baseline lifecycle proof: real-Chromium targeted probe proves
  clean → regressed as exactly one new HIGH, regressed → restored as resolved,
  and clean → clean as identical;
- locally validated CI example script (`examples/baseline-ci-example.mjs`)
  exercises the consumer baseline workflow with exit-code semantics;
- hosted GitHub Actions run on ubuntu-latest passes the full aggregate quality
  gate including all browser integrations and baseline CI example;
- reopened production stress phase closed with component profiling, corrected
  classifications, deterministic regression fixtures, production reruns, and a
  passing aggregate gate; see
  [`m11-production-stress-status.md`](./m11-production-stress-status.md).

### Release-candidate closure still required

- run the clean aggregate, exact CLI M7, and package/consumer gates from a fresh
  install at the final candidate SHA;
- record a first-attempt hosted Linux run for that exact SHA and review uploaded
  failures if any;
- validate the installable GitHub Release bundle and source-checkout path at the
  exact candidate SHA. Public npm-registry publication is not the current
  distribution path and is not required for this release;
- optionally capture the documented 15–30 second public demo; absence of an
  edited marketing asset does not weaken the executable source gates.

## After v0.1

- expand real-app navigation evidence and repeatability measurements without
  turning fixture results into arbitrary-app accuracy claims;
- improve navigation graph/report usability, replay coverage, and baseline pull-
  request summaries without requiring cloud services;
- publish a shared driver conformance kit;
- extend replay schemas to safe numeric, selection, geometry, visual, latency,
  and log assertions;
- add safe opt-in configuration for authenticated synthetic test sessions;
- investigate Android/Google TV physical-device evidence after emulator support;
- collect concrete [platform requests](platform-priority.md), then evaluate the
  best-evidenced Fire TV, Roku, Tizen, webOS, or tvOS adapter;
- develop larger redistributable fixture suites and publish measured recall,
  false-positive, runtime, and replay-reliability results under the rules in
  [Benchmarking](BENCHMARKING.md);
- broaden web framework, browser-host, and operating-system evidence where it
  materially improves the navigation product.

## Status promotion criteria

| Promotion | Required evidence |
| --- | --- |
| Planned → Experimental | Implemented bounded surface, unit tests, documented limitations, no false support claim |
| Experimental → Beta | Repeatable real-platform gate, redistributable fixture, clean consumer install, deterministic artifacts |
| Beta → Stable | Published compatibility policy, multiple real applications/platform environments, upgrade tests, maintained security support |

No surface is Stable in the v0.1 preview.

