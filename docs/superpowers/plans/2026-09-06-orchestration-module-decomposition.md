# Orchestration Module Decomposition Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for scoped extraction and review. Track completed tasks here.

**Goal:** Split the five orchestration modules without observable behavior changes.
**Architecture:** Preserve public facades, move existing responsibility blocks into private sibling modules, retain the existing bounded runtimes and lifecycle owners.
**Tech Stack:** TypeScript, Vitest, npm workspaces.
**Spec:** docs/superpowers/specs/2026-09-06-orchestration-module-decomposition-design.md

## Global Constraints

Preserve deterministic stage/action ordering; externally observable error types and messages; exactly-once owned-resource cleanup; private replay-plan correlation; deterministic sorting, semantic deduplication, issue IDs and result ordering; every runtime budget. Add characterization tests before changing the relevant implementation. No unrelated fixes, features, dependencies or public exports. Facades <=350 physical lines; new modules <=650. Delivery is one subsystem per commit after foundation, then full npm run check, declaration compatibility, private PR and exact-commit CI.

## Tasks

- [ ] Foundation: Add packages/core/test/orchestration-architecture.test.ts covering the five facades, required extracted module names, ceilings, unchanged facade exports in public indexes, and no own-barrel imports. Run node node_modules/vitest/vitest.mjs run packages/core/test/orchestration-architecture.test.ts and record expected current-size failure. Baseline existing unit tests before production changes.
- [ ] Streaming: Characterize exact option errors, action/stage ordering and budget stops in packages/pack-streaming/test/streaming-pack.test.ts. Extract runner.ts into streaming-runtime/options/search/issues/pointer-probe/replay/journey.ts per spec, preserving bounded session and exact issue construction. Run streaming unit tests, tsc build and eslint on changed files; commit.
- [ ] Explorer: Characterize frontier/repetition order, errors and exact action/state/depth/duration boundaries using explorer.test.ts and explorer-hardening.test.ts. Extract explorer-contracts/options/state/frontier/runtime.ts; if runtime exceeds ceiling extract existing nested responsibility blocks with explicit context. Run explorer suites, tsc build and scoped eslint; commit.
- [ ] Replay: Characterize plan cloning, tampering, cross-issue replay, evidence isolation, deadlines and error results in replay.test.ts. Extract replay-contracts/compilation/evaluation/deadline/execution.ts. Keep WeakMap and registration private to compilation, expose only a validation function to execution. Run replay suite, tsc build and scoped eslint; commit.
- [ ] Navigation: Characterize exact findings/IDs/order and semantic deduplication in navigation-diagnostics.test.ts. Extract navigation-diagnostic-contracts/context/findings.ts and navigation-focus/modal/history-rules.ts. Keep rule invocation, deduplication and sorting in facade. Run navigation suites, tsc build and scoped eslint; commit.
- [ ] Node audit: Characterize exactly-once cleanup for success, failure and interruptions plus stage order and evidence-count/time/artifact boundaries in node-audit-hardening.test.ts. Extract node-audit-contracts/selection/navigation/evidence/output/runner.ts, keeping lifecycle in runner and dependency-bound factory in facade. Run CLI suites, tsc build and scoped eslint; commit.
- [ ] Final: Review entire diff for behavioral changes and public declarations; run npm run check, architecture test, git diff --check; create private PR only after local gates pass and verify CI on its exact commit.

## Execution record

Existing approved branch is clean; use current checkout. No AGENTS.md found in repository. exec_command cannot initialize bundled PowerShell; use Node child_process with argument arrays for Git/test commands.
