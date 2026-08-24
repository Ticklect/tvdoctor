# Roadmap

The roadmap describes evidence gates, not promised dates. A feature moves to a
higher support level only after its complete gate is repeatable.

## v0.1 public preview

### Already evidenced

- platform-neutral protocol, bounded core exploration, navigation diagnostics,
  semantic issue IDs, report/replay V1, and local report renderers;
- real-Chromium web driver gates against the Northstar fixture;
- 17-stage semantic streaming journey with four in-scope deterministic fixture
  findings and honest replay availability;
- search/settings/accessibility/layout/performance/crash pack libraries;
- complete M7 controlled web fixture audit with six independent stages,
  five deterministic seeds, and locked evidence/report expectations;
- repeated-carousel compression, priority frontier, explicit exploration
  profiles, stronger settling, and exact sequence minimisation;
- complete M8 large-carousel benchmark: 240-card real-Chromium gate proves
  compression retains one representative instead of 240 states, hardened
  exploration completes where uncompressed BFS cannot, recall preserved,
  and structural output is deterministic across runs;
- versioned fail-closed baseline comparison library;
- complete M10 baseline lifecycle proof: real-Chromium targeted probe proves
  clean → regressed as exactly one new HIGH, regressed → restored as resolved,
  and clean → clean as identical;
- locally validated CI example script (`examples/baseline-ci-example.mjs`)
  exercises the consumer baseline workflow with exit-code semantics;
- hosted GitHub Actions run on ubuntu-latest passes the full aggregate quality
  gate including all browser integrations and baseline CI example;
- complete M9 Android TV emulator gate: disposable API 36 emulator installs the
  native fixture, proves DPAD navigation and Select, triggers the seeded focus
  loss defect, captures screenshot/log evidence, and tears down cleanly;
- experimental structured ADB/UIAutomator driver with fake-executor tests.
- reopened production stress phase closed with component profiling, corrected
  classifications, deterministic regression fixtures, production reruns, and a
  passing aggregate gate; see
  [`m11-production-stress-status.md`](./m11-production-stress-status.md).

### Release-candidate closure still required

- run the clean aggregate, exact CLI M7, and package/consumer gates from a fresh
  install at the final candidate SHA;
- record a first-attempt hosted Linux run for that exact SHA and review uploaded
  failures if any;
- decide repository visibility and npm publication explicitly—neither is implied
  by passing source tests;
- optionally capture the documented 15–30 second public demo; absence of an
  edited marketing asset does not weaken the executable source gates.

## After v0.1

- broaden web framework, browser-host, and operating-system evidence;
- publish a shared driver conformance kit;
- extend replay schemas to safe numeric, selection, geometry, visual, latency,
  and log assertions;
- improve baseline storage and pull-request summaries without requiring cloud
  services;
- add safe opt-in configuration for authenticated synthetic test sessions;
- investigate Android/Google TV physical-device evidence after emulator support;
- evaluate community-maintained Fire TV, Roku, Tizen, and webOS adapters;
- develop larger redistributable fixture suites and publish measured recall,
  false-positive, runtime, and replay-reliability results.

## Status promotion criteria

| Promotion | Required evidence |
| --- | --- |
| Planned → Experimental | Implemented bounded surface, unit tests, documented limitations, no false support claim |
| Experimental → Beta | Repeatable real-platform gate, redistributable fixture, clean consumer install, deterministic artifacts |
| Beta → Stable | Published compatibility policy, multiple real applications/platform environments, upgrade tests, maintained security support |

No surface is Stable in the v0.1 preview.

