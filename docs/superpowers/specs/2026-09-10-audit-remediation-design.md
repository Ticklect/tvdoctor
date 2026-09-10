# Audit Remediation Design

## Goal

Remediate the five audit findings without changing unrelated product behaviour or incorporating the uncommitted Android traversal work in the main checkout.

## Scope and invariants

- Startup actions are caller-selected but may execute only when startup blocker detection found at least one focused setup wall.
- Repository linting must exclude every nested `.worktrees` directory.
- Runtime deadlines must cooperatively abort active driver and hook work, stop all later work in that runtime, and leave production driver sessions unable to perform a delayed operation across reset or close boundaries.
- Every stateful Android public operation must share one FIFO operation queue. Internal calls must use private, non-queueing implementations to avoid re-entrant queue deadlocks.
- Android security-test diagnostics may expose only non-sensitive ADB preflight information. Token-bearing command failures remain opaque.
- Existing public calls without operation options remain source-compatible.

## Startup safety

`prepareStartup()` will enter the remote-sequence branch only when `blockers.length > 0`. A clean stable screen follows the existing reset-verification path without dispatching any key. A regression test will use a clean fake driver and assert both the ready result and an empty press log.

This preserves the documented meaning of `--startup-actions`: the keys are a policy for a detected setup wall, not an unconditional pre-audit macro.

## ESLint discovery scope

The root flat configuration will add `**/.worktrees/**` to its global ignore list. A repository-level test will ask ESLint whether a nested worktree TypeScript path is ignored, exercising effective configuration rather than matching source text. The main checkout's real `npm run lint` command will be rerun with its existing worktrees present.

## Deadline cancellation contract

The protocol will define `DriverOperationOptions` with an optional `AbortSignal`, and each asynchronous `TVDoctorDriver` operation will accept operation options in a backward-compatible optional parameter. Existing driver implementations with fewer parameters remain valid TypeScript implementations, while production drivers will honor the new signal.

Core will provide one internal deadline primitive that:

1. composes the caller signal with a deadline-owned `AbortController`;
2. supplies the composed signal to the operation;
3. aborts the operation when the deadline expires;
4. clears its timer on every settlement path; and
5. reports whether the deadline or caller cancellation won.

Explorer, streaming-pack, and web-pack runtime boundaries will pass the operation signal into driver methods, restore callbacks, and host hooks. Once a deadline wins, the runtime is terminal and starts no reset, replay, stage, or follow-up operation. Hooks receive the signal in their existing request object. Restore callbacks accept optional operation options.

The Android driver will combine each operation signal with its constructor-level signal and forward the result through ADB subprocesses, observer requests, and waits. A queued operation checks the signal before it starts, preventing an already-aborted key or lifecycle request from crossing the queue boundary. The Playwright driver will check cancellation at operation boundaries and retire its page/browser resources when an in-flight operation is aborted, because Playwright does not offer per-command `AbortSignal` support.

Custom drivers or hooks that ignore the signal cannot be forcibly interrupted by JavaScript. The runtime nevertheless becomes terminal and never reuses them. The documented driver contract will state that honoring the operation signal is required for safe timeout behaviour.

## Android operation ordering

Public `install`, `forceStop`, `captureScreenshot`, `listDevices`, `waitForDeviceReady`, `getDeviceMetadata`, and `getAppMetadata` calls will join the existing operation queue. Each gets a private implementation for use by already-queued launch/reset/press/snapshot flows. `capabilities()` remains an immutable local read, and `getObserverMetrics()` remains a synchronous metrics snapshot.

Gated concurrency tests will prove that:

- a concurrent `forceStop()` does not issue ADB force-stop until a press has settled;
- a concurrent screenshot does not issue `screencap` until a snapshot observation completes; and
- metadata refresh and install operations cannot interleave with lifecycle work.

Queue continuation after rejection remains unchanged.

## Android security-test preflight

A small script helper will run `adb devices -l` before installation or provisioning. It will distinguish:

- missing or non-runnable ADB, with guidance to install platform-tools or set `ADB`;
- the requested serial being absent, with guidance to start a device or set `ANDROID_SERIAL`;
- offline and unauthorized states, with state-specific guidance; and
- a ready online target.

Only bounded, control-character-sanitised preflight text can appear in these messages. The existing command wrapper continues replacing later failures with an opaque error so provisioning tokens cannot leak. Node tests will exercise missing ADB, absent serial, unauthorized/offline, and ready-device cases through an injected process runner.

## Testing strategy

Every production behaviour change follows red-green-refactor:

- startup clean-screen regression;
- effective ESLint-ignore regression;
- cancellation tests in core, streaming, web, Android, and Playwright driver boundaries as applicable;
- Android FIFO tests for the bypassing methods; and
- script preflight tests based on observable errors and results.

After targeted tests pass, run root lint, typecheck, unit tests, package builds, presentation/device-proof checks, package smoke tests, and the relevant integration suites. The long full integration command is retained as final evidence because the clean baseline passed it in the isolated worktree.

## Files expected to change

- `eslint.config.mjs`
- `packages/protocol/src/driver.ts`
- `packages/core/src/operation-deadline.ts` and exports
- `packages/core/src/explorer-runtime.ts`, settling/restoration contracts, and tests
- `packages/pack-streaming/src/*runtime*`, hook types/call sites, and tests
- `packages/pack-web/src/internal.ts`, hook types/call sites, and tests
- `packages/driver-android/src/android-driver.ts`, public types/docs, and tests
- `packages/driver-web/src/web-driver.ts` and tests
- `scripts/test-android-observer-security.mjs`
- `scripts/lib/android-security-preflight.mjs` and its Node test
- root test scripts only where needed to ensure the new script regression runs in `npm run check`

No change is planned for `packages/cli/src/android-product.ts` or `packages/cli/test/product-flow.test.ts`; the user's main-checkout edits remain outside this worktree.
