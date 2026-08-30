# Android Comprehensive Traversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Android Quick or Deep scan an Adaptive deterministic or Brute-force traversal strategy that exhausts all safe, observable, target-owned work, exercises media and HOME safely, gates risky actions, accounts for inaccessible work, and removes VLC Quick's replay-driven action ceiling.

**Architecture:** Keep `tvdoctor.report/v1` unchanged. Add Android-specific strategy and action-policy modules in the CLI, exact verified-state restoration primitives in core, bounded media/screenshot observation in the Android driver, and a supplementary `tvdoctor.android-coverage/v1` ledger artifact. The explorer remains fail-closed: target-package boundaries, exact semantic fingerprints, and root replay are authoritative whenever local reuse cannot be proved.

**Tech Stack:** TypeScript 6, Node.js ESM, Vitest, Playwright integration suites, ADB/Android API 36, Java Android fixture, Bash and Node.js release verifiers.

**Spec:** `docs/superpowers/specs/2026-08-30-android-comprehensive-traversal-design.md`

## Global Constraints

- Follow red-green-refactor for every behavior change: add one focused failing test, run it and confirm the expected failure, implement the minimum behavior, then rerun the focused suite.
- Do not alter the strict `tvdoctor.report/v1` protocol schema. Strategy metadata belongs in `target.environment`; detailed accounting belongs in the supplementary ledger artifact.
- Never automatically authorize authentication, payment, purchase, subscription, account deletion, data deletion, factory reset, or another destructive activation. Brute-force changes traversal breadth, not this safety boundary.
- Never expand launcher, permission-controller, settings, or unrelated-package states. Record the boundary transition and restore the prepared target.
- Never bypass `FLAG_SECURE` or claim semantics from a screenshot fingerprint. Sparse visual evidence may prove only change/stability.
- Preserve exact semantic checkpoint validation. A local path is usable only from the exact current identity to the exact requested identity through already verified edges.
- Keep all new persisted strings bounded, sanitized, deterministic, and free of credentials or raw hostile application data.
- Keep generated APKs, VLC APKs, emulator output, and `Tests/` campaign output untracked.
- Commit after every task. Before each commit, inspect `git diff --check` and the task's focused tests.

---

## Task 1: Define traversal strategies and expose them in both Android entry points

**Files:**

- Create: `packages/cli/src/android-traversal.ts`
- Create: `packages/cli/test/android-traversal.test.ts`
- Modify: `packages/cli/src/android-product.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/cli.test.ts`
- Test: `packages/cli/test/product-flow.test.ts`

- [ ] **Step 1: Add failing contract tests for the strategy parser**

```ts
import { describe, expect, it } from "vitest";
import {
  ANDROID_TRAVERSAL_STRATEGIES,
  isAndroidTraversalStrategy,
  parseAndroidTraversalStrategy,
} from "../src/android-traversal.js";

describe("Android traversal strategies", () => {
  it("keeps a stable public order and defaults omission to adaptive", () => {
    expect(ANDROID_TRAVERSAL_STRATEGIES).toEqual(["adaptive", "brute-force"]);
    expect(parseAndroidTraversalStrategy(undefined)).toBe("adaptive");
  });

  it("accepts only the two declared values", () => {
    expect(isAndroidTraversalStrategy("brute-force")).toBe(true);
    expect(() => parseAndroidTraversalStrategy("wide")).toThrow(/--strategy/);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the module does not exist**

Run: `npx vitest run packages/cli/test/android-traversal.test.ts`

Expected: FAIL with an import/module-not-found error for `android-traversal.js`.

- [ ] **Step 3: Implement the narrow strategy contract**

```ts
export const ANDROID_TRAVERSAL_STRATEGIES = ["adaptive", "brute-force"] as const;
export type AndroidTraversalStrategy = (typeof ANDROID_TRAVERSAL_STRATEGIES)[number];

export function isAndroidTraversalStrategy(value: unknown): value is AndroidTraversalStrategy {
  return typeof value === "string"
    && (ANDROID_TRAVERSAL_STRATEGIES as readonly string[]).includes(value);
}

export function parseAndroidTraversalStrategy(value: string | undefined): AndroidTraversalStrategy {
  if (value === undefined) return "adaptive";
  if (!isAndroidTraversalStrategy(value)) {
    throw new TypeError("--strategy must be adaptive or brute-force.");
  }
  return value;
}
```

Export the type/helpers from `packages/cli/src/index.ts`. Add required `strategy: AndroidTraversalStrategy` to `AndroidScanOptions`; only CLI/guided callers supply the default so lower-level programmatic calls stay explicit.

- [ ] **Step 4: Add failing CLI tests for default, explicit, invalid, and duplicate flags**

Extend the existing Android cases in `packages/cli/test/cli.test.ts` to assert:

```ts
expect(scanAndroid).toHaveBeenCalledWith(expect.objectContaining({ strategy: "adaptive" }));
```

Add an explicit `--strategy brute-force` case, an unknown-value usage-error case, and a duplicate `--strategy adaptive --strategy brute-force` usage-error case. Also assert Android help contains both values and that plan/progress output names the effective strategy.

- [ ] **Step 5: Run the CLI test and confirm the missing-option failures**

Run: `npx vitest run packages/cli/test/cli.test.ts`

Expected: FAIL because `--strategy` is not parsed or forwarded and help does not describe it.

- [ ] **Step 6: Parse and forward `--strategy` without weakening duplicate-option checks**

In the existing Android option parser in `packages/cli/src/cli.ts`, accept exactly one strategy value after `--strategy`, parse it with `parseAndroidTraversalStrategy`, default omission to `adaptive`, pass it to `scanAndroid`, and include it in the emitted plan/progress description.

- [ ] **Step 7: Add the guided second choice after Quick/Deep**

Extend `packages/cli/test/product-flow.test.ts` first. Assert the terminal receives a second selection with these user-facing choices in this order:

```ts
[
  {
    label: "Adaptive deterministic — Recommended",
    value: "adaptive",
    description: "Explore every safe target-owned action, include media controls, test HOME with restore, and reuse verified states.",
  },
  {
    label: "Brute-force expansion",
    value: "brute-force",
    description: "Try every supported remote key from every reachable target-owned state with larger budgets; safety gates still apply.",
  },
]
```

Test Adaptive as the default, Brute-force forwarding, and Escape cancellation before any scan starts. Then implement the prompt in `packages/cli/src/start.ts` immediately after Quick/Deep selection.

- [ ] **Step 8: Verify Task 1**

Run:

```powershell
npx vitest run packages/cli/test/android-traversal.test.ts packages/cli/test/cli.test.ts packages/cli/test/product-flow.test.ts
npm run typecheck
git diff --check
```

Expected: all tests PASS, typecheck exits 0, and `git diff --check` is silent.

- [ ] **Step 9: Commit Task 1**

```powershell
git add packages/cli/src packages/cli/test
git commit -m "feat(android): select comprehensive traversal strategy"
```

---

## Task 2: Implement deterministic action policy and explicit risk gates

**Files:**

- Create: `packages/cli/src/android-action-policy.ts`
- Create: `packages/cli/test/android-action-policy.test.ts`
- Modify: `packages/cli/src/android-product.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write failing tests for ordering, media, HOME, and risky controls**

Build minimal `AndroidStateSnapshot` fixtures with target-owned locations and focused nodes. Cover:

- Adaptive stable order: navigation first, eligible media actions next, HOME last.
- Adaptive omits media when neither a target media session nor exposed player semantics exists.
- Brute-force considers every `REMOTE_KEYS` value in protocol order.
- HOME is classified `target-boundary` in both strategies.
- SELECT on labels such as `Sign in`, `Subscribe`, `Buy`, `Delete account`, `Erase data`, and `Factory reset` is `operator-gated`.
- Sparse/ambiguous semantics never turn SELECT into `automatic`.
- An exact action/control authorization changes only that named decision to `automatic`.
- An authorization for one state/control does not authorize another state/control.

- [ ] **Step 2: Confirm the policy tests fail because the module is absent**

Run: `npx vitest run packages/cli/test/android-action-policy.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Add the policy types and stable decision function**

```ts
export type AndroidActionDisposition =
  | "automatic"
  | "target-boundary"
  | "operator-gated"
  | "inaccessible";

export interface AndroidActionDecision {
  readonly actionId: string;
  readonly key: RemoteKey;
  readonly disposition: AndroidActionDisposition;
  readonly reasonCode: string;
  readonly detail: string;
}

export interface AndroidActionPolicyContext {
  readonly strategy: AndroidTraversalStrategy;
  readonly snapshot: AndroidStateSnapshot;
  readonly screenStateId: string;
  readonly targetPackage: string;
  readonly mediaSession: Observation<AndroidMediaSessionMetadata>;
  readonly authorisedActionIds: ReadonlySet<string>;
}

export function decideAndroidActions(
  context: AndroidActionPolicyContext,
): readonly AndroidActionDecision[];
```

Derive `actionId` from bounded stable fields: source screen identity, focused-node stable path/label/role summary, and key. Do not include raw UI JSON or a credential value. Normalize exposed text to lower case and gate matches for authentication, payment, purchase, subscription, account/data deletion, erase/wipe, factory reset, uninstall, logout/sign-out where state could be lost, and ambiguous clickable activation.

- [ ] **Step 4: Define explicit budget matrix by mode and strategy**

Move the Android budget lookup into the policy/configuration module and test exact values:

| Strategy | Mode | maxActions | maxStates | maxDepth | maxDurationMs |
|---|---:|---:|---:|---:|---:|
| adaptive | quick | 300 | 75 | 8 | 720000 |
| adaptive | deep | 10000 | 1000 | 32 | 1800000 |
| brute-force | quick | 1500 | 250 | 16 | 1800000 |
| brute-force | deep | 25000 | 2500 | 64 | 3600000 |

All values are below `MAX_EXPLORATION_BUDGETS`. Keep these values in one exported read-only record and make `android-product.ts` consume it.

- [ ] **Step 5: Verify Task 2**

Run:

```powershell
npx vitest run packages/cli/test/android-action-policy.test.ts
npm run typecheck
git diff --check
```

Expected: PASS, typecheck exits 0, no whitespace errors.

- [ ] **Step 6: Commit Task 2**

```powershell
git add packages/cli/src packages/cli/test
git commit -m "feat(android): gate traversal actions by deterministic policy"
```

---

## Task 3: Let core choose actions per exact state and record restoration provenance

**Files:**

- Modify: `packages/core/src/explorer.ts`
- Modify: `packages/core/src/graph.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/explorer.test.ts`
- Test: `packages/core/test/explorer-hardening.test.ts`

- [ ] **Step 1: Add failing dynamic-action tests**

Add a deterministic fake-driver test where the root returns `["SELECT"]`, the second state returns `["BACK", "HOME"]`, and another state returns no actions. Assert only those source-specific attempts are present and that duplicate or unsupported runtime keys are rejected before pressing the driver.

Define the public callback shape in the test:

```ts
export interface ExplorationActionContext {
  readonly screenStateId: string;
  readonly focusStateId: string;
  readonly snapshot: StateSnapshot;
  readonly defaultActions: readonly RemoteKey[];
}

readonly actionsForState?: (
  context: ExplorationActionContext,
) => readonly RemoteKey[] | Promise<readonly RemoteKey[]>;
```

- [ ] **Step 2: Confirm the test fails because `actionsForState` is unknown**

Run: `npx vitest run packages/core/test/explorer.test.ts`

Expected: FAIL at compile/behavior assertion because explorer uses only global `actions`.

- [ ] **Step 3: Implement per-state action resolution**

Resolve actions once when a queued exact state is expanded. Normalize them through the same `isRemoteKey` validation as `actions`, reject duplicates, preserve callback order, and keep `actionOrder` as the union in first-seen order so diagnostics can still determine whether a required key was configured. A callback error terminates with `driver-error` and a bounded detail; it must not be silently converted into no actions.

- [ ] **Step 4: Add failing provenance assertions**

Extend fake-driver scenarios to expect every `ExplorationActionAttempt` to contain:

```ts
export type ExplorationRestorationMethod =
  | "live-state"
  | "verified-path"
  | "root-replay";

export interface ExplorationRestoration {
  readonly method: ExplorationRestorationMethod;
  readonly replayActions: number;
  readonly exactMatch: boolean;
  readonly fellBack: boolean;
}
```

Add `restoration` to `ExplorationActionAttempt`. Add these required statistics:

```ts
readonly verifiedStateReuses: number;
readonly verifiedPathRestorations: number;
readonly restorationFallbacks: number;
```

Existing root-replay behavior should initially report `root-replay`, replay count equal to the restored sequence length, exact match true, and `fellBack: false`.

- [ ] **Step 5: Implement provenance without changing restoration behavior yet**

Thread one restoration result through the existing `restore(entry)` call into the attempt object and increment the new counters. Keep all current failure/termination semantics unchanged in this task.

- [ ] **Step 6: Verify Task 3 and guard existing diagnostics**

Run:

```powershell
npx vitest run packages/core/test/explorer.test.ts packages/core/test/explorer-hardening.test.ts packages/core/test/navigation-diagnostics.test.ts
npm run test:core-integration
npm run typecheck
git diff --check
```

Expected: PASS and no change to existing graph/diagnostic findings.

- [ ] **Step 7: Commit Task 3**

```powershell
git add packages/core/src packages/core/test
git commit -m "feat(core): support state-aware exploration actions"
```

---

## Task 4: Add shortest verified paths and adaptive exact-state restoration

**Files:**

- Create: `packages/core/src/verified-path.ts`
- Create: `packages/core/test/verified-path.test.ts`
- Modify: `packages/core/src/explorer.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/explorer.test.ts`
- Test: `packages/core/test/explorer-hardening.test.ts`
- Test: `packages/core/integration/explorer.integration.spec.ts`

- [ ] **Step 1: Write failing unit tests for deterministic shortest-path selection**

```ts
export interface VerifiedStateEdge {
  readonly fromIdentity: string;
  readonly toIdentity: string;
  readonly key: RemoteKey;
  readonly expandable: boolean;
}

export function findShortestVerifiedPath(
  edges: readonly VerifiedStateEdge[],
  fromIdentity: string,
  toIdentity: string,
  actionOrder: readonly RemoteKey[],
): readonly VerifiedStateEdge[] | null;
```

Test same-state returns `[]`, shortest hop count wins, equal paths use action-order rank then stable identity, cycles terminate, non-expandable boundary edges are excluded, and unreachable returns `null`.

- [ ] **Step 2: Confirm module-not-found, then implement bounded BFS**

Run: `npx vitest run packages/core/test/verified-path.test.ts`

Expected before implementation: FAIL with module-not-found. Implement queue-based BFS with visited identities and deterministic sorted outgoing edges; do not enumerate all paths.

- [ ] **Step 3: Add failing explorer tests for live self-loop reuse**

Construct a root with three no-op/self-loop keys. Assert full action coverage is unchanged but physical actions fall from root-restore-per-key behavior to exactly the exploratory presses plus the single initial restoration. Assert later attempts use `restoration.method === "live-state"`, exact match true, and `verifiedStateReuses` increments.

- [ ] **Step 4: Track exact current identity and implement live-state reuse**

After every settled observation, retain the current exact fingerprint identity. Before expanding an action, if it equals the required source state's identity, skip reset/replay. Clear the trusted live identity on cancellation, driver exceptions, unobserved input, restoration failure, or any operation that does not yield an exact snapshot.

- [ ] **Step 5: Add failing local-path and mismatch-fallback tests**

Create a graph where state B can return to A through a previously proven target-owned edge. Assert B-to-A restoration uses the shortest verified path and checks every observed checkpoint. Then mutate the fake driver's result to mismatch; assert exactly one root-replay fallback, `fellBack: true`, `restorationFallbacks: 1`, and no mismatched local state is accepted.

- [ ] **Step 6: Implement verified-path restoration with one root fallback**

Maintain verified edges only for settled attempts whose source/destination exact identities are known and whose destination passes `shouldExpand`. To restore:

1. Reuse live state on exact equality.
2. Otherwise find and execute the shortest verified path from the exact current state.
3. Validate each exact checkpoint and final source identity.
4. On any local mismatch, abandon local trust and call the existing root restoration once.
5. Preserve existing `replay-diverged`, `restoration-failed`, budget, and cancellation termination rules for the root attempt.

Never add HOME/cross-package edges to the reusable set.

- [ ] **Step 7: Add an integration assertion that reuse preserves graph coverage**

Run the same deterministic app graph with reuse disabled and enabled. Compare normalized screen identities, focus identities, transition tuples, and action keys; assert equality while enabled mode has fewer physical/replay actions. Add an internal option such as `restorationMode?: "root-only" | "verified-local"`, defaulting to `root-only` for existing non-Android callers; Android Adaptive and Brute-force will opt into `verified-local` in Task 8.

- [ ] **Step 8: Verify Task 4**

Run:

```powershell
npx vitest run packages/core/test/verified-path.test.ts packages/core/test/explorer.test.ts packages/core/test/explorer-hardening.test.ts
npm run test:core-integration
npm run typecheck
git diff --check
```

Expected: PASS; integration proves identical coverage and lower replay overhead.

- [ ] **Step 9: Commit Task 4**

```powershell
git add packages/core/src packages/core/test packages/core/integration
git commit -m "feat(core): restore exploration through verified states"
```

---

## Task 5: Observe target-owned Android media sessions

**Files:**

- Create: `packages/driver-android/src/media-session.ts`
- Create: `packages/driver-android/test/media-session.test.ts`
- Modify: `packages/driver-android/src/types.ts`
- Modify: `packages/driver-android/src/android-driver.ts`
- Modify: `packages/driver-android/src/index.ts`
- Test: `packages/driver-android/test/android-v2-driver.test.ts`

- [ ] **Step 1: Write failing parser tests with bounded `dumpsys media_session` fixtures**

Test an active target session, inactive target session, another package only, redacted/malformed output, and oversized output. The parser must match exact package ownership and return no raw dump text.

```ts
export interface AndroidMediaSessionMetadata {
  readonly packageName: string;
  readonly active: boolean;
  readonly playbackState: string | null;
}

export function parseMediaSessionDump(
  text: string,
  targetPackage: string,
): AndroidMediaSessionMetadata | null;
```

- [ ] **Step 2: Confirm the parser test fails, then implement it**

Run: `npx vitest run packages/driver-android/test/media-session.test.ts`

Expected before implementation: FAIL with module-not-found. Parse only bounded UTF-8 text supplied by the existing ADB executor; normalize playback state to a bounded allowlisted token or `null`.

- [ ] **Step 3: Add and test the driver observation API**

```ts
getActiveMediaSession(
  packageName: string,
): Promise<Observation<AndroidMediaSessionMetadata>>;
```

Use `adb shell dumpsys media_session`, the existing command timeout, a small output cap, and cooperative cancellation. Return:

- `available` when an exact target session is found;
- `unavailable` with a bounded reason when no target session exists or the Android service is unavailable;
- never another package's metadata.

Test executor arguments, timeout/output bounds, cancellation, and non-zero exit handling in `android-v2-driver.test.ts`.

- [ ] **Step 4: Verify and commit Task 5**

Run:

```powershell
npx vitest run packages/driver-android/test/media-session.test.ts packages/driver-android/test/android-v2-driver.test.ts
npm run typecheck
git diff --check
git add packages/driver-android/src packages/driver-android/test
git commit -m "feat(android): observe target media sessions"
```

Expected: PASS and a successful commit.

---

## Task 6: Add bounded in-memory screenshot fingerprints

**Files:**

- Create: `packages/driver-android/src/screenshot-fingerprint.ts`
- Create: `packages/driver-android/test/screenshot-fingerprint.test.ts`
- Modify: `packages/driver-android/src/types.ts`
- Modify: `packages/driver-android/src/android-driver.ts`
- Modify: `packages/driver-android/src/index.ts`
- Test: `packages/driver-android/test/android-v2-driver.test.ts`

- [ ] **Step 1: Write failing PNG fingerprint tests**

Use tiny generated binary fixtures kept in test memory. Cover Android-compatible 8-bit, non-interlaced RGB and RGBA PNGs, all PNG row filters, identical-image stability, one-pixel/different-frame change, all-black/all-transparent conservative blank classification, malformed data, unsupported color/interlace, and size limits.

```ts
export interface AndroidScreenshotFingerprint {
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly luminanceGrid: readonly number[]; // fixed 16 x 9
  readonly meanLuminance: number;
  readonly luminanceVariance: number;
  readonly visuallyBlank: boolean;
}
```

- [ ] **Step 2: Confirm failure, then implement the pure bounded decoder**

Run: `npx vitest run packages/driver-android/test/screenshot-fingerprint.test.ts`

Expected before implementation: FAIL with module-not-found. Use `node:crypto` SHA-256 and `node:zlib` inflate; validate PNG signature/chunks, dimensions, decompressed byte count, filter type, and color type before allocating. Do not add an image dependency and do not perform OCR.

- [ ] **Step 3: Expose the driver observation**

```ts
captureScreenshotFingerprint(): Promise<Observation<AndroidScreenshotFingerprint>>;
```

Call `adb exec-out screencap -p` with `maxScreenshotBytes`; hash/decode in memory and release the buffer after the call. A secure/blank frame returns a fingerprint whose `visuallyBlank` flag is true; capture or decode failure returns `unavailable` with a bounded reason. No per-action screenshot file is written.

- [ ] **Step 4: Verify and commit Task 6**

Run:

```powershell
npx vitest run packages/driver-android/test/screenshot-fingerprint.test.ts packages/driver-android/test/android-v2-driver.test.ts
npm run typecheck
git diff --check
git add packages/driver-android/src packages/driver-android/test
git commit -m "feat(android): fingerprint screenshots in memory"
```

Expected: PASS and a successful commit.

---

## Task 7: Build and validate the bounded Android coverage ledger

**Files:**

- Create: `packages/cli/src/android-coverage-ledger.ts`
- Create: `packages/cli/test/android-coverage-ledger.test.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Add failing ledger-builder tests**

Cover deterministic ordering, all dispositions, hostile strings, entry/detail length limits, aggregate counts, zero/nonzero remaining safe frontier, operator-gated completion semantics, inaccessible/failed partial semantics, and stable byte-for-byte JSON across input permutations.

Define the persisted contract:

```ts
export const ANDROID_COVERAGE_LEDGER_SCHEMA = "tvdoctor.android-coverage/v1" as const;

export type AndroidCoverageDisposition =
  | "exercised"
  | "verified-state-reuse"
  | "boundary-restored"
  | "operator-gated"
  | "inaccessible"
  | "failed";

export interface AndroidCoverageLedger {
  readonly schema: typeof ANDROID_COVERAGE_LEDGER_SCHEMA;
  readonly strategy: AndroidTraversalStrategy;
  readonly targetPackage: string;
  readonly budgets: ExplorationBudgets;
  readonly entries: readonly AndroidCoverageEntry[];
  readonly counts: Readonly<Record<AndroidCoverageDisposition, number>>;
  readonly truncatedEntries: number;
  readonly remainingSafeFrontier: number;
}
```

Each entry includes bounded IDs, action, disposition/reason/detail, source/destination packages, accessibility/screenshot/media evidence statuses, and optional restoration method/exact/fallback metadata.

- [ ] **Step 2: Confirm module-not-found, then implement sanitization and stable serialization**

Run: `npx vitest run packages/cli/test/android-coverage-ledger.test.ts`

Expected before implementation: FAIL. Implement a pure builder and `serialiseAndroidCoverageLedger()` using stable key ordering. Cap entries at 100,000, detail/reason at 512 characters, IDs/package names at 256 characters, strip control characters, reject non-finite numbers, and report omitted entries in `truncatedEntries`.

- [ ] **Step 3: Implement completion truth helper**

```ts
export function hasIncompleteSafeCoverage(ledger: AndroidCoverageLedger): boolean {
  return ledger.remainingSafeFrontier > 0
    || ledger.truncatedEntries > 0
    || ledger.counts.inaccessible > 0
    || ledger.counts.failed > 0;
}
```

`operator-gated` alone must return false because it is an explicit declared exclusion. Test that exact rule separately.

- [ ] **Step 4: Verify and commit Task 7**

Run:

```powershell
npx vitest run packages/cli/test/android-coverage-ledger.test.ts
npm run typecheck
git diff --check
git add packages/cli/src packages/cli/test
git commit -m "feat(android): account for traversal coverage"
```

Expected: PASS and a successful commit.

---

## Task 8: Integrate policy, observations, boundary restoration, and ledger into Android scans

**Files:**

- Modify: `packages/cli/src/android-product.ts`
- Modify: `packages/cli/test/product-flow.test.ts`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `packages/reporters/src/render-helpers.ts`
- Modify: `packages/reporters/src/render-markdown.ts`
- Modify: `packages/reporters/src/render-html.ts`
- Modify: `packages/reporters/src/render-ai.ts`
- Test: `packages/reporters/test/reporters.test.ts`

- [ ] **Step 1: Add an Android orchestration test for Adaptive policy**

Using injected driver/explorer dependencies, assert `scanAndroid`:

- reads target media metadata for action policy;
- supplies `actionsForState` and `restorationMode: "verified-local"`;
- explores only decisions classified `automatic` or `target-boundary`;
- retains `operator-gated` decisions for ledger output;
- sends HOME, records the cross-package result, immediately calls the prepared-root restoration, and never expands the launcher snapshot;
- uses screenshot change/stability only when accessibility semantics are sparse;
- never sends SELECT when sparse semantics make activation safety unknown.

- [ ] **Step 2: Run the focused test and confirm integration is absent**

Run: `npx vitest run packages/cli/test/product-flow.test.ts`

Expected: FAIL because scan orchestration still passes a static navigation action list and writes no ledger.

- [ ] **Step 3: Wire the state action provider and evidence collection**

In `android-product.ts`:

1. Resolve budgets from mode + strategy.
2. Keep the current target package `shouldExpand` predicate authoritative.
3. On each exact source state, query the bounded media-session observation and call `decideAndroidActions`.
4. Return only automatic/boundary keys to the core callback; retain all decisions keyed by source/action ID for accounting.
5. Enable `verified-local` restoration for both strategies. Brute-force still uses the wider action policy/budgets; it does not weaken restoration integrity.
6. Treat HOME and any observed cross-package transition as non-expandable, then invoke exact prepared-root restoration before more target work.
7. If accessibility is sparse, compare screenshot fingerprints to account for visual change/no-op, but do not synthesize labels, roles, focus, or SELECT safety.
8. If accessibility and screenshot evidence are both unavailable/blank for target-owned work, record `inaccessible` and keep the run partial.

- [ ] **Step 4: Add failing artifact/status tests**

Assert every run attempts `android-coverage-ledger.json` and registers:

```ts
{
  id: "run:android-coverage-ledger",
  kind: "report",
  status: "available",
  path: "android-coverage-ledger.json",
  mediaType: "application/json",
  // byteLength and sha256 asserted by shape
}
```

Also test:

- queue exhausted + only operator-gated entries => completed;
- inaccessible/failed entry => partial;
- budget termination or remaining safe frontier => partial;
- ledger write failure => a `failed` descriptor with bounded reason and partial report;
- cancellation still writes accumulated ledger, then closes observer/ADB resources;
- `target.environment.androidTraversalStrategy` equals the selected value.

- [ ] **Step 5: Write the ledger before the canonical report and derive status from both sources**

Build ledger entries from policy decisions, exploration attempts, and restoration provenance. Set `remainingSafeFrontier` from authoritative explorer termination/frontier values plus known safe automatic decisions not attempted. A pack/report is completed only when `result.termination.complete` is true and `hasIncompleteSafeCoverage(ledger)` is false.

If ledger writing throws, append a failed artifact and force partial status while still writing the canonical report. Preserve the existing screenshot, logcat, exploration, and performance artifacts.

- [ ] **Step 6: Add renderer tests and link the well-known ledger from coverage**

In reporter sample tests, add available and failed ledger descriptors. Markdown, HTML, and AI renderers should identify `run:android-coverage-ledger` in the coverage section with its status/path or bounded failure reason. Reuse artifact helpers; do not parse the supplementary ledger inside generic reporters.

- [ ] **Step 7: Verify Task 8**

Run:

```powershell
npx vitest run packages/cli/test/product-flow.test.ts packages/cli/test/cli.test.ts packages/reporters/test/reporters.test.ts
npm run test:report-integration
npm run test:cli-integration
npm run typecheck
git diff --check
```

Expected: PASS; report-v1 validation remains unchanged.

- [ ] **Step 8: Commit Task 8**

```powershell
git add packages/cli/src packages/cli/test packages/reporters/src packages/reporters/test
git commit -m "feat(android): integrate safe comprehensive traversal"
```

---

## Task 9: Extend the controlled Android fixture and hosted-emulator assertions

**Files:**

- Modify: `fixtures/broken-android-tv/src/org/tvdoctor/fixture/MainActivity.java`
- Create: `fixtures/broken-android-tv/src/org/tvdoctor/fixture/SecureActivity.java`
- Modify: `fixtures/broken-android-tv/AndroidManifest.xml`
- Modify: `fixtures/broken-android-tv/res/values/ids.xml`
- Modify: `fixtures/broken-android-tv/res/values/strings.xml`
- Modify: `fixtures/broken-android-tv/seeded-defects.json`
- Modify: `fixtures/broken-android-tv/tests/fixture.test.mjs`
- Modify: `scripts/run-android-emulator-ci.sh`
- Modify: `scripts/verify-android-ci-report.mjs`
- Create: `scripts/verify-android-secure-report.mjs`

- [ ] **Step 1: Expand fixture structure tests first**

Assert source/resources declare:

- a deterministic target-owned player screen with visible `Play`, `Pause`, `Next`, and `Previous` semantics;
- a deterministic media session owned by `org.tvdoctor.fixture` while that screen is active;
- a `Delete account` control that is discoverable but has no destructive implementation;
- a sparse-accessibility visual state reachable through a safe named control;
- a separate secure activity using `WindowManager.LayoutParams.FLAG_SECURE`;
- stable resource IDs so ledger assertions do not depend on layout ordering;
- the original single seeded focus-loss defect unchanged.

- [ ] **Step 2: Confirm the fixture test fails, then implement the fixture surfaces**

Run: `npm run test:fixture`

Expected before implementation: FAIL on missing player/gated/sparse/secure structures. Implement with Android platform APIs already available to the fixture build; do not add network dependencies or real account/payment behavior.

- [ ] **Step 3: Split hosted-emulator verification into safe complete and secure partial scans**

Update `run-android-emulator-ci.sh` to:

1. Build/install the fixture and observer as today.
2. Run the normal prepared root with `--mode quick --strategy adaptive` and verify exit code 1 for the seeded issue.
3. Verify normal report/ledger is completed, includes media exercises, HOME boundary restoration, the operator-gated delete action, zero inaccessible/failed entries, and still exactly one deterministic HIGH focus-loss issue/replay.
4. Launch the fixture directly into `SecureActivity` using an explicit fixture-only setup argument or component, run a second bounded scan output, and verify it is partial with an `inaccessible` secure-surface ledger entry.
5. Preserve diagnostics from both outputs on failure.

This separation keeps the normal safe-scope gate complete while proving secure surfaces fail closed; the secure activity is never silently counted as clean.

- [ ] **Step 4: Harden the Node verifiers**

Extend `verify-android-ci-report.mjs` to locate `run:android-coverage-ledger`, resolve its relative path beneath the report bundle without traversal, parse it, validate `schema === "tvdoctor.android-coverage/v1"`, strategy, counts, boundary/media/gated reason codes, and remaining frontier 0.

Implement `verify-android-secure-report.mjs` to assert partial status, an available valid ledger, at least one target-owned `inaccessible` entry, no attempted destructive action, and no claim of completed pack coverage.

- [ ] **Step 5: Verify Task 9 locally where possible**

Run:

```powershell
npm run test:fixture
npx vitest run packages/cli/test/product-flow.test.ts packages/driver-android/test/android-ci-display-ready.test.ts
npm run typecheck
git diff --check
```

Expected: PASS. The full API 36 gate is run in Task 11 or by the hosted workflow because it requires an emulator.

- [ ] **Step 6: Commit Task 9**

```powershell
git add fixtures/broken-android-tv scripts/run-android-emulator-ci.sh scripts/verify-android-ci-report.mjs scripts/verify-android-secure-report.mjs
git commit -m "test(android): gate media boundaries and secure surfaces"
```

---

## Task 10: Add a deterministic three-run VLC acceptance verifier

**Files:**

- Create: `scripts/verify-vlc-adaptive-run.mjs`
- Create: `scripts/run-vlc-adaptive-campaign.mjs`
- Create: `scripts/test/verify-vlc-adaptive-run.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Extract verifier rules into a testable module and write failing tests**

Use in-memory report/exploration/ledger objects. Assert acceptance only when every run has:

- report status completed and all packs completed;
- strategy `adaptive` and ledger schema `tvdoctor.android-coverage/v1`;
- termination `queue-exhausted`, `complete: true`, and zero remaining safe frontier;
- physical actions `< 300`;
- screen states `>= 12`, focus states `>= 27`, and transitions/action attempts `>= 85`;
- no `replay-diverged`, `restoration-failed`, observer timeout/failure, inaccessible target-owned entry, failed ledger entry, or ledger truncation.

Add one negative test per threshold/failure so an accidentally permissive verifier cannot approve a run.

- [ ] **Step 2: Run the verifier test and confirm failure**

Run: `node --test scripts/test/verify-vlc-adaptive-run.test.mjs`

Expected before implementation: FAIL with module-not-found.

- [ ] **Step 3: Implement safe artifact resolution and validation**

`verify-vlc-adaptive-run.mjs` accepts one scan output directory, reads `report.json`, finds the well-known ledger descriptor, resolves only relative paths that stay within the scan directory, reads `android-exploration.json`, and returns a bounded result or throws one precise acceptance error. It must not mutate campaign output.

- [ ] **Step 4: Implement the three-run campaign runner**

`run-vlc-adaptive-campaign.mjs` accepts the named `--apk`, `--device`, and `--output` options. Its help example is the repository's preserved acceptance setup:

```text
--apk Tests/vlc/VLC-Android-3.7.1-x86_64.apk
--device emulator-5554
--output Tests/android-vlc-adaptive-campaign-final
```

For run numbers 1 through 3, create a fresh `run-1`/`run-2`/`run-3` directory and invoke the built CLI with:

```text
test --apk Tests/vlc/VLC-Android-3.7.1-x86_64.apk --device emulator-5554 --mode quick --strategy adaptive --output Tests/android-vlc-adaptive-campaign-final/run-1
```

Abort on cancellation or any rejected run, print the exact failed criterion, and never delete an existing nonempty output directory. After all three pass, write a small `campaign-summary.json` containing only run paths, hashes, counts, and pass status—not the APK.

- [ ] **Step 5: Add scripts and verify Task 10**

Add:

```json
"test:vlc-verifier": "node --test scripts/test/verify-vlc-adaptive-run.test.mjs",
"test:vlc-campaign": "node scripts/run-vlc-adaptive-campaign.mjs"
```

Run:

```powershell
npm run test:vlc-verifier
npm run lint
npm run typecheck
git diff --check
```

Expected: PASS. Do not run the real campaign until the API 36 emulator and preserved VLC 3.7.1 APK are confirmed available.

- [ ] **Step 6: Commit Task 10**

```powershell
git add scripts/verify-vlc-adaptive-run.mjs scripts/run-vlc-adaptive-campaign.mjs scripts/test/verify-vlc-adaptive-run.test.mjs package.json
git commit -m "test(android): verify three adaptive VLC scans"
```

---

## Task 11: Run full release evidence and update only proven limitations

**Files:**

- Modify after evidence: `README.md`
- Modify after evidence: `packages/cli/README.md`
- Modify after evidence: `packages/driver-android/README.md`
- Modify after evidence: `docs/drivers/android.md`
- Modify after evidence: `docs/limitations.md`
- Modify after evidence: `CHANGELOG.md`
- Evidence only, do not commit: `Tests/android-vlc-adaptive-campaign-*`

- [ ] **Step 1: Run the complete local verification matrix**

```powershell
npm run lint
npm run typecheck
npm run test:unit
npm run test:fixture
npm run test:driver
npm test --workspace @tvdoctor/broken-android-tv
npm test --workspace @tvdoctor/driver-android
npm run test:core-integration
npm run test:report-integration
npm run test:streaming-integration
npm run test:cli-integration
npm run test:package-smoke
```

Expected: every command exits 0. If any command fails, use `superpowers:systematic-debugging`, fix the root cause in a separate focused commit, and rerun both the failed command and this full matrix.

- [ ] **Step 2: Run the API 36 controlled-fixture gate**

On the same API 36 emulator image used by hosted Android CI, run:

```bash
bash scripts/run-android-emulator-ci.sh
```

Expected: the normal adaptive scan passes complete behavior assertions; the secure scan passes fail-closed partial assertions; the script exits 0.

- [ ] **Step 3: Run the preserved VLC 3.7.1 campaign three consecutive times**

Use the preserved APK already under the ignored `Tests/` area and the API 36 emulator. Choose a new ignored output directory and run:

```powershell
npm run test:vlc-campaign -- --apk "Tests/vlc/VLC-Android-3.7.1-x86_64.apk" --device emulator-5554 --output "Tests/android-vlc-adaptive-campaign-final"
```

Expected: three runs accepted, each complete with zero safe frontier, fewer than 300 physical actions, at least 12 screens, 27 focus states, and 85 transitions; `campaign-summary.json` says PASS. Record the exact command, commit SHA, emulator/API, APK SHA-256, and summary path in the final implementation handoff. Do not commit the APK or output bundle.

- [ ] **Step 4: Update documentation only after Steps 1–3 pass**

Document:

- Quick/Deep then Adaptive/Brute-force selection and `--strategy` syntax;
- Adaptive as recommended and Brute-force as slower/noisier;
- automatic safe target-owned navigation/media coverage;
- HOME boundary probe with immediate exact restoration;
- operator gating for auth/payment/purchase/subscription/account deletion/destructive flows unless explicitly authorized;
- ledger dispositions and partial semantics for inaccessible secure surfaces;
- physical/vendor Android TV support remains experimental pending a maintained device matrix;
- release signing still requires maintainer-provisioned environment secrets.

Remove the old HOME/media automatic-exploration limitation and VLC Quick action-ceiling limitation only because the fixture and three-run VLC evidence now exist. Reword accessibility/secure-surface text as explicit fail-closed accounting, not as a solved platform capability.

- [ ] **Step 5: Verify documentation statements against evidence**

Run:

```powershell
rg -n "VLC Quick|HOME|media controls|secure surfaces|accessibility|release-signing|vendor" README.md CHANGELOG.md docs packages/cli/README.md packages/driver-android/README.md
npm run lint
npm run typecheck
npm run test:unit
npm run test:package-smoke
git diff --check
git status --short
```

Expected: no stale claim that HOME/media are excluded or VLC Quick still reaches its ceiling; external physical/signing boundaries remain; all verification commands pass; ignored evidence is not staged.

- [ ] **Step 6: Commit documentation and final local evidence state**

```powershell
git add README.md packages/cli/README.md packages/driver-android/README.md docs/drivers/android.md docs/limitations.md CHANGELOG.md
git commit -m "docs(android): document comprehensive traversal boundaries"
```

- [ ] **Step 7: Obtain hosted-gate evidence without assuming push authority**

Record `git rev-parse HEAD`. A maintainer with repository push authority pushes that exact commit and waits for the hosted Android workflow. Acceptance requires the hosted workflow to run `scripts/run-android-emulator-ci.sh` successfully against that SHA. Do not claim the hosted gate passed from local emulator evidence alone, and do not push automatically unless the operator explicitly authorizes it.

- [ ] **Step 8: Perform final branch review**

Invoke `superpowers:requesting-code-review`, address any findings with test-first focused commits, then invoke `superpowers:verification-before-completion` and rerun the commands required by that skill before declaring the implementation complete.
