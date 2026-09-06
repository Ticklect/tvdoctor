# Orchestration Module Decomposition Design

## Objective

Split TVDoctor's five largest orchestration modules into focused, testable internal modules without changing public APIs, runtime behavior, deterministic ordering, issue identity, evidence content, budget accounting, or failure semantics.

The affected source files currently range from roughly 1,300 to 1,950 lines:

- `packages/pack-streaming/src/runner.ts`
- `packages/core/src/explorer.ts`
- `packages/core/src/replay.ts`
- `packages/core/src/navigation-diagnostics.ts`
- `packages/cli/src/node-audit.ts`

This is a maintainability refactor. It must not add product behavior or change serialized output.

## Design Principles

1. Keep every existing package-level export and function signature stable.
2. Split by responsibility and data ownership, not by arbitrary line count.
3. Keep orchestration entrypoints thin enough to read as workflows.
4. Use plain functions and explicit context objects; do not introduce a service container or framework.
5. Keep internal modules private to their package unless an existing public symbol must be re-exported.
6. Preserve exact ordering for actions, stages, findings, issues, artifacts, and report fields.
7. Preserve resource ceilings, timeout boundaries, interruption behavior, and error messages.
8. Avoid cross-package dependency changes and new runtime dependencies.

## Compatibility Contract

The following public entrypoints remain unchanged:

- `runStreamingPack(driver, options)` from `@tvdoctor/pack-streaming`
- `explore(driver, options)` and all explorer contracts from `@tvdoctor/core`
- `compileReplay`, `compileIssueReplay`, `executeReplay`, and all replay contracts from `@tvdoctor/core`
- `diagnoseNavigation(result, options)` and all navigation diagnostic contracts from `@tvdoctor/core`
- `createNodeAuditOperation(dependencies)` and the currently exported node-audit utilities from `@tvdoctor/cli`

Generated declaration surfaces must remain compatible. Existing direct source imports used by tests and sibling CLI modules must continue to resolve through facade re-exports.

## Architecture Guard

Add a repository architecture test that fails against the current files before extraction. It will enforce:

- each of the five named facade files is at most 350 physical lines;
- each newly created orchestration module covered by this design is at most 650 physical lines;
- package public index files continue exporting the same facade entrypoints;
- internal modules do not import from their package's public barrel, preventing circular dependencies.

The 650-line limit is a ceiling, not a target. Files should be smaller when a responsibility has a natural boundary. Generated files, tests, fixtures, and `dist` output are excluded.

## Streaming Pack

Keep `packages/pack-streaming/src/runner.ts` as the public facade and top-level workflow delegate.

Create:

- `streaming-runtime.ts`: `StreamingSession`, stop types, action/deadline accounting, reset/replay, and snapshot operations.
- `streaming-options.ts`: runtime option validation and budget normalization.
- `streaming-search.ts`: semantic target search, exact target search, surface expansion, and their private result types.
- `streaming-issues.ts`: deterministic issue IDs, evidence records, reproduction builders, and streaming issue constructors.
- `streaming-pointer-probe.ts`: pointer result normalization and isolated pointer-probe execution.
- `streaming-replay.ts`: issue replay compilation/execution and replay-result mapping.
- `streaming-journey.ts`: ordered stage workflow and mutable journey result assembly.

The facade validates through `streaming-options.ts`, constructs the runtime, and delegates to `runStreamingJourney`. The journey owns stage order and result assembly; lower-level modules return values rather than mutating journey collections, except where an explicit accumulator parameter already represents the contract.

## Explorer

Keep `packages/core/src/explorer.ts` as a compatibility facade.

Create:

- `explorer-contracts.ts`: public explorer options, budgets, profiles, progress, termination, statistics, timings, and result types/constants.
- `explorer-options.ts`: profile selection, budget validation, action normalization, settling normalization, and repetition-compression normalization.
- `explorer-state.ts`: focused-node location, snapshot comparison, repetition identity/grouping, and registered-state data structures.
- `explorer-frontier.ts`: queue entries, deterministic sequence comparison, priority/BFS selection, and frontier bookkeeping.
- `explorer-runtime.ts`: restoration, deadline enforcement, driver interaction, graph mutation, and the `explore` workflow.

`explorer-runtime.ts` may coordinate state and frontier helpers but must not redefine public contracts. `explorer.ts` re-exports contracts and the runtime function so existing imports remain valid.

## Replay

Keep `packages/core/src/replay.ts` as a compatibility facade.

Create:

- `replay-contracts.ts`: public replay budgets, selectors, assertions, compilation results, execution results, reason codes, phases, and hook contracts.
- `replay-compilation.ts`: replay parsing/correlation, plan registration, step validation, assertion validation, setup splitting, `compileReplay`, and `compileIssueReplay`.
- `replay-evaluation.ts`: focus and element-state predicate evaluation, selector matching, tree flattening, and predicate combination.
- `replay-deadline.ts`: deadline construction, bounded operation execution, and elapsed-time helpers.
- `replay-execution.ts`: plan validation, evidence isolation, execution result construction, and `executeReplay`.

The existing correlation protection between compiled plans and source issues must remain private and effective across the split. Compilation owns registration; execution consumes its narrow validation interface.

## Navigation Diagnostics

Keep `packages/core/src/navigation-diagnostics.ts` as the public facade and deterministic aggregator.

Create:

- `navigation-diagnostic-contracts.ts`: public rules, classifications, source/target/finding/result/options contracts.
- `navigation-diagnostic-context.ts`: bounded snapshot indexing, active-dialog selection, semantic identities, metadata conversion, local coverage, and shared geometry helpers.
- `navigation-diagnostic-findings.ts`: canonical issue, source, target, reproduction, and finding-candidate builders.
- `navigation-focus-rules.ts`: lost focus, self-loop, unreachable, and unexpected-jump analysis.
- `navigation-modal-rules.ts`: focus-trap, overlay-focus-leak, and consent-wall analysis.
- `navigation-history-rules.ts`: Back-behavior analysis.

Rule modules append candidates through a narrow shared context. The facade invokes them in the existing order, performs the existing semantic deduplication and sorting, and returns the same deterministic and heuristic partitions.

## Node Audit

Keep `packages/cli/src/node-audit.ts` as the compatibility facade and dependency-bound operation factory.

Create:

- `node-audit-contracts.ts`: exported constants and `AuditRunProducts`, `CapturedIssue`, and `NodeAuditDependencies` contracts.
- `node-audit-selection.ts`: selected-pack/stage mapping, coverage, exhausted budgets, partial-run details, and streaming sequence lookup.
- `node-audit-navigation.ts`: safe exploration-driver projection, navigation inventory, startup-control selection, and specialized reachability filtering.
- `node-audit-evidence.ts`: bounded snapshots, capture deadlines, drift detection, replay/evidence capture, and bounded issue capture.
- `node-audit-output.ts`: output reservation, failed/setup-blocked reports, auxiliary artifacts, report input assembly, and severity summary.
- `node-audit-runner.ts`: driver lifecycle and ordered startup, navigation, streaming, web, evidence, and final-report workflow.

The facade constructs the operation with the same dependency injection surface. Driver closing remains owned by the runner and must occur exactly once across success, failure, and interruption paths.

## Data and Dependency Flow

Dependencies flow inward from public facades to contracts and focused implementation modules. Focused modules import concrete sibling files, never package barrel exports.

Runtime flow remains:

1. Validate external options or CLI request.
2. Construct the bounded runtime/session.
3. Execute stages in their current deterministic order.
4. Capture raw findings and evidence.
5. Assemble existing public result/report structures.
6. Close owned resources under the existing lifecycle rules.

No new global mutable state is introduced. Existing replay-plan correlation state remains module-private.

## Error Handling and Security

- Preserve all externally observable error types and messages unless a test proves the message is private.
- Preserve fail-closed behavior for unavailable focus, UI trees, capabilities, replay checkpoints, and evidence drift.
- Preserve bounded traversal of untrusted UI trees and text.
- Preserve secret redaction and evidence sanitation at their current trust boundaries.
- Never allow helper extraction to bypass action, state, depth, duration, artifact, or evidence-count budgets.
- Keep driver and artifact-store lifecycle cleanup in `finally` paths.

## Testing Strategy

This refactor uses characterization-first TDD:

1. Add the architecture test and run it against the current tree to observe the expected size failures.
2. Extract one subsystem at a time without modifying behavior.
3. After each extraction, run that subsystem's existing unit tests, typecheck, and lint checks.
4. Add focused tests only when extraction reveals an untested boundary; each such test must fail for the intended reason before implementation.
5. Run declaration/build checks to prove facade exports remain compatible.
6. Run the complete `npm run check` release gate after all five subsystems are split.
7. Run `git diff --check` and the repository-presentation test before completion.

The existing integration suites remain the behavioral oracle for deterministic routes, issue IDs, replay classification, evidence, output structure, and exact budget boundaries.

## Delivery

Deliver the work on `codex/split-orchestration-modules` as reviewable commits, one subsystem per commit after the architecture-test foundation. Push a private GitHub pull request only after the complete local gate passes. Do not change repository visibility, create a GitHub Release, create a release tag, or publish an npm package.

## Success Criteria

- All five facade files satisfy the 350-line ceiling.
- All new orchestration modules satisfy the 650-line ceiling.
- Existing package exports and generated declarations remain compatible.
- Existing tests and integrations pass without snapshot or expectation weakening.
- `npm run check` and hosted CI pass on the exact pull-request commit.
- The private repository remains release-ready and easier for outside maintainers to understand once it is eventually made public.
