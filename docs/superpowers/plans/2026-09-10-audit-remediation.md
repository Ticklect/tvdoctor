# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all five repository audit findings with regression coverage and preserve existing caller compatibility.

**Architecture:** Startup and lint receive narrow guard/config fixes. Deadline safety is implemented as a shared cooperative-abort primitive plus optional per-operation driver signals, with runtimes becoming terminal after a timeout. Android exposes one FIFO queue for all stateful public methods, and the physical security script gains a non-sensitive ADB preflight module.

**Tech Stack:** TypeScript 6, Node.js 24 ESM, Vitest 4, Playwright 1.62, ESLint 10, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-audit-remediation-design.md`

## Global Constraints

- Do not modify `packages/cli/src/android-product.ts` or `packages/cli/test/product-flow.test.ts` from the user's main checkout.
- Existing driver calls without operation options must remain source-compatible.
- Token-bearing ADB failures must remain opaque.
- Write each regression first and observe its expected failure before production changes.
- Do not start later runtime work after an operation deadline wins.

---

### Task 1: Guard startup policy actions

**Files:**
- Modify: `packages/core/test/explorer-hardening.test.ts`
- Modify: `packages/core/src/startup.ts`

**Interfaces:**
- Consumes: `prepareStartup(driver, options): Promise<StartupPreparationResult>`
- Produces: unchanged interface; remote-sequence actions execute only for detected blockers.

- [ ] **Step 1: Write the failing clean-screen test**

Add a test using a resettable fake driver whose stable snapshot has no modal and whose `press()` records keys:

```ts
it("ignores startup policy actions when the stable screen has no blocker", async () => {
  const driver = new CleanStartupDriver();
  const result = await prepareStartup(driver, {
    policy: { kind: "remote-sequence", actions: ["SELECT"] },
    stability,
    monotonicNow: () => 0,
    wait: async () => undefined,
  });
  expect(result.status).toBe("ready");
  expect(driver.pressed).toEqual([]);
  expect(result.steps.some((step) => step.operation === "policy-action")).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run packages/core/test/explorer-hardening.test.ts -t "ignores startup policy actions"`

Expected: FAIL because `SELECT` is present in `driver.pressed`.

- [ ] **Step 3: Implement the minimal blocker guard**

Change the branch in `prepareStartup()` to:

```ts
if (blockers.length > 0 && policy.kind === "remote-sequence") {
```

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run packages/core/test/explorer-hardening.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/startup.ts packages/core/test/explorer-hardening.test.ts
git commit -m "fix(core): guard startup actions behind blockers"
```

### Task 2: Exclude worktrees from root lint

**Files:**
- Modify: `scripts/repository-presentation.test.mjs`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: ESLint flat configuration.
- Produces: nested `.worktrees` paths are globally ignored.

- [ ] **Step 1: Write the failing effective-config test**

Use ESLint's public API rather than source matching:

```js
test('root lint ignores nested git worktrees', async () => {
  const eslint = new ESLint({ cwd: repositoryRoot });
  assert.equal(
    await eslint.isPathIgnored(path.join(repositoryRoot, '.worktrees', 'example', 'src', 'bad.ts')),
    true,
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/repository-presentation.test.mjs --test-name-pattern="root lint ignores"`

Expected: FAIL with `false !== true`.

- [ ] **Step 3: Add the global ignore**

Add `"**/.worktrees/**"` beside the other generated-directory ignores in `eslint.config.mjs`.

- [ ] **Step 4: Verify GREEN and reproduce the real command**

Run: `node --test scripts/repository-presentation.test.mjs --test-name-pattern="root lint ignores"`

Run from the main checkout: `npm run lint`

Expected: both PASS, including with existing worktrees.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs scripts/repository-presentation.test.mjs
git commit -m "fix(tooling): ignore local worktrees in eslint"
```

### Task 3: Add the operation cancellation contract and deadline primitive

**Files:**
- Modify: `packages/protocol/src/driver.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/core/src/operation-deadline.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/operation-deadline.test.ts`

**Interfaces:**
- Produces: `DriverOperationOptions { readonly signal?: AbortSignal }`.
- Produces: driver methods with optional operation options.
- Produces: `runWithOperationDeadline<T>(options, operation): Promise<T>` and `OperationDeadlineExceeded`.

- [ ] **Step 1: Write deadline tests**

Cover successful settlement, deadline abort, caller abort, and timer cleanup. The deadline test operation must listen to the supplied signal and reject on abort; assert the signal is aborted before the wrapper rejects.

```ts
const observed: AbortSignal[] = [];
await expect(runWithOperationDeadline({ timeoutMs: 20 }, async (signal) => {
  observed.push(signal);
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
})).rejects.toBeInstanceOf(OperationDeadlineExceeded);
expect(observed[0]?.aborted).toBe(true);
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run packages/core/test/operation-deadline.test.ts`

Expected: FAIL because the module/exports do not exist.

- [ ] **Step 3: Implement protocol options and the deadline helper**

Add optional operation options to all asynchronous `TVDoctorDriver` methods. Implement a deadline-owned controller, compose it with a parent signal using `AbortSignal.any`, clear the timer in `finally`, and translate only the deadline-owned abort to `OperationDeadlineExceeded`.

- [ ] **Step 4: Verify GREEN and type compatibility**

Run: `npx vitest run packages/core/test/operation-deadline.test.ts`

Run: `npm run typecheck --workspace @tvdoctor/protocol && npm run typecheck --workspace @tvdoctor/core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/core/src/operation-deadline.ts packages/core/src/index.ts packages/core/test/operation-deadline.test.ts
git commit -m "feat(protocol): add cancellable driver operations"
```

### Task 4: Abort explorer operations at the duration deadline

**Files:**
- Modify: `packages/core/src/explorer-contracts.ts`
- Modify: `packages/core/src/explorer-runtime.ts`
- Modify: `packages/core/src/action-settling.ts`
- Modify: `packages/core/src/explorer-restoration.ts`
- Modify: `packages/core/test/explorer.test.ts`

**Interfaces:**
- Restore callbacks accept optional `DriverOperationOptions`.
- `pressAndObserve()` accepts and forwards an operation signal.

- [ ] **Step 1: Strengthen the existing never-settling test**

Make the fake `press` accept operation options, wait for its signal, set `abortedBeforeReturn = true`, and reject. Assert the exploration result is `max-duration`, the signal was aborted, and no later reset/snapshot started.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run packages/core/test/explorer.test.ts -t "returns at the duration deadline"`

Expected: FAIL because no signal reaches the driver.

- [ ] **Step 3: Route all explorer operations through the shared deadline helper**

Change `withinDurationBudget` to accept `(signal) => Promise<T>`, pass the signal to capabilities, reset/restore, press, and snapshot, and forward it through settling/restoration. Map `OperationDeadlineExceeded` to the existing `max-duration` termination.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run packages/core/test/explorer.test.ts packages/core/test/explorer-hardening.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test/explorer.test.ts
git commit -m "fix(core): abort operations at exploration deadline"
```

### Task 5: Abort streaming and web pack operations and hooks

**Files:**
- Modify: `packages/pack-streaming/src/streaming-runtime.ts`
- Modify: `packages/pack-streaming/src/streaming-pointer-probe.ts`
- Modify: `packages/pack-streaming/src/types.ts`
- Modify: `packages/pack-streaming/test/streaming-pack.test.ts`
- Modify: `packages/pack-web/src/internal.ts`
- Modify: `packages/pack-web/src/runner.ts`
- Modify: `packages/pack-web/src/types.ts`
- Modify: `packages/pack-web/test/web-pack.test.ts`

**Interfaces:**
- Streaming/web restore callbacks accept optional `DriverOperationOptions`.
- Hook request objects expose `readonly signal: AbortSignal`.
- Runtime sessions reject all calls after their deadline has won.

- [ ] **Step 1: Write streaming and web abort regressions**

For each pack, use a never-settling cooperative hook/driver that records the supplied signal. Assert the result remains the existing partial/error `max-duration` shape, the signal is aborted, and counters prove no restoration or later stage began.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run packages/pack-streaming/test/streaming-pack.test.ts packages/pack-web/test/web-pack.test.ts -t "abort"`

Expected: FAIL because request signals are absent/unaborted.

- [ ] **Step 3: Implement shared-deadline routing**

Replace local `Promise.race`/timer wrappers with `runWithOperationDeadline`. Make `operation`/`withinDuration` accept an operation callback with a signal, pass it to driver methods and hooks, and set a terminal flag when the deadline wins.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run packages/pack-streaming/test/streaming-pack.test.ts packages/pack-web/test/web-pack.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pack-streaming packages/pack-web
git commit -m "fix(packs): abort timed-out driver and hook work"
```

### Task 6: Honor per-operation cancellation in production drivers

**Files:**
- Modify: `packages/driver-android/src/android-driver.ts`
- Modify: `packages/driver-android/test/android-v2-driver.test.ts`
- Modify: `packages/driver-web/src/web-driver.ts`
- Modify: `packages/driver-web/test/driver.integration.spec.ts`

**Interfaces:**
- Android combines constructor and operation signals and forwards them to ADB, observer, and waits.
- Web retires its page/browser resources when an in-flight operation aborts.

- [ ] **Step 1: Write driver abort tests**

Android: gate an executor call, abort the operation signal, assert the executor observes abort and no later ADB command starts. Web: start a cancellable operation against the fixture, abort, assert rejection and that a later operation reports the driver is closed/unusable.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run packages/driver-android/test/android-v2-driver.test.ts -t "operation signal"`

Run: `npm test --workspace @tvdoctor/driver-web -- --grep "operation signal"`

Expected: FAIL because operation signals are ignored.

- [ ] **Step 3: Implement signal composition and retirement**

Add a helper that combines the constructor and call signals, calls `throwIfAborted()` before queued work, and passes the signal through private operations. Wrap Playwright operations with abort listeners that mark the driver unusable and close owned resources.

- [ ] **Step 4: Verify GREEN**

Run both driver test suites.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/driver-android packages/driver-web
git commit -m "fix(drivers): honor operation cancellation"
```

### Task 7: Serialize every stateful Android public method

**Files:**
- Modify: `packages/driver-android/src/android-driver.ts`
- Modify: `packages/driver-android/test/android-v2-driver.test.ts`
- Modify: `packages/driver-android/README.md`

**Interfaces:**
- Public stateful methods use `#enqueueOperation`; private counterparts permit calls inside an existing queued operation.
- `capabilities()` and `getObserverMetrics()` remain local reads.

- [ ] **Step 1: Add gated FIFO tests**

Add separate tests that hold a press/snapshot observer request open, call `forceStop()`/`captureScreenshot()`, and assert the corresponding ADB command is absent until the gate releases. Add install and refreshed metadata ordering tests.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run packages/driver-android/test/android-v2-driver.test.ts -t "serializes"`

Expected: new force-stop and screenshot tests FAIL because those commands start early.

- [ ] **Step 3: Split public queue wrappers from private implementations**

Use the established form:

```ts
async captureScreenshot(path: string, options?: DriverOperationOptions) {
  return await this.#enqueueOperation(
    () => this.#captureScreenshot(path, options),
    options?.signal,
  );
}
```

Apply it to install, force-stop, screenshot, list/readiness, and metadata methods. Update internal launch/reset/serial calls to private counterparts.

- [ ] **Step 4: Verify GREEN and document semantics**

Run: `npx vitest run packages/driver-android/test/android-v2-driver.test.ts`

Expected: PASS with all ordering tests.

- [ ] **Step 5: Commit**

```bash
git add packages/driver-android
git commit -m "fix(android): serialize stateful driver operations"
```

### Task 8: Add actionable non-sensitive Android preflight failures

**Files:**
- Create: `scripts/lib/android-security-preflight.mjs`
- Create: `scripts/android-security-preflight.test.mjs`
- Modify: `scripts/test-android-observer-security.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `preflightAndroidSecurityTarget({ adb, serial, execute }): void`.
- The main script calls preflight before install/provisioning.

- [ ] **Step 1: Write preflight behavior tests**

Inject an executor returning literal `adb devices -l` outputs. Assert actionable bounded messages for `ENOENT`, no matching serial, `unauthorized`, and `offline`, and no throw for `<serial> device product:...`.

- [ ] **Step 2: Run and verify RED**

Run: `node --test scripts/android-security-preflight.test.mjs`

Expected: FAIL because the helper is missing.

- [ ] **Step 3: Implement and integrate preflight**

Parse only the device-list columns needed for serial/state, sanitize control characters, cap displayed values, and avoid accepting caller-provided text as a shell command. Keep the existing opaque `command()` catch for all later operations.

- [ ] **Step 4: Verify GREEN and root check inclusion**

Run: `node --test scripts/android-security-preflight.test.mjs`

Update `test:device-proof` to include this test file, then run `npm run test:device-proof`.

Expected: PASS without a connected Android device.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/android-security-preflight.mjs scripts/android-security-preflight.test.mjs scripts/test-android-observer-security.mjs package.json
git commit -m "fix(android): explain security-test device preflight failures"
```

### Task 9: Full verification and completion audit

**Files:**
- Modify only files needed to correct regressions revealed by verification.

**Interfaces:**
- Produces: evidence that F1-F5 and repository-wide gates pass.

- [ ] **Step 1: Run static gates**

Run: `npm run lint`

Run: `npm run typecheck`

Run: `git diff --check origin/main...HEAD`

Expected: PASS.

- [ ] **Step 2: Run unit, presentation, device-proof, and package gates**

Run: `npm run test:unit`

Run: `npm run test:presentation`

Run: `npm run test:device-proof`

Run: `npm run test:package-smoke`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Run full integration suite**

Run: `npm test`

Expected: PASS, including the long core, streaming, reporting, and CLI integrations.

- [ ] **Step 4: Re-run main-checkout lint with local worktrees present**

Run from `D:\Tv Docter`: `npm run lint`

Expected: PASS and no parser errors from `.worktrees`.

- [ ] **Step 5: Audit each finding against authoritative evidence**

Confirm F1 has a no-press clean-screen test; F2 passes real main-checkout lint; F3 abort tests cover all three runtimes and production drivers; F4 FIFO tests cover force-stop/screenshot/install/metadata; F5 preflight tests cover no-device usability while sensitive failures stay opaque.

- [ ] **Step 6: Record the final clean state**

Run: `git status --short`

Expected: no uncommitted files. If verification required a correction, return to that finding's task, repeat its red-green cycle, and commit the named production and regression-test files there before repeating Task 9.
