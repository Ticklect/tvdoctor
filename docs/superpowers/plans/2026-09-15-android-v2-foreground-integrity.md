# Android V2 Foreground Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Android V2 fail closed whenever the tested package loses the foreground, while preserving redacted external-boundary evidence and requiring final target ownership before a scan can complete successfully.

**Architecture:** The Accessibility observer reports the real active-root package instead of relabeling foreign windows as the target. The host driver accepts only redacted cross-package boundary metadata, blocks target input and screenshots when `dumpsys window` proves another package is focused, and exposes a narrow setup-input path for known Android permission-controller packages. The CLI records external boundaries without expanding them, restores the target from a fresh verified snapshot, and downgrades completion when final target ownership cannot be re-established.

**Tech Stack:** TypeScript, Vitest, Node.js, Java Android AccessibilityService, ADB, GitHub Actions.

**Spec:** User-reported Android V2 foreground false-success audit from 2026-09-15.

## Global Constraints

- Preserve existing Android V2 observer transport and deterministic explorer semantics.
- Never expose foreign accessibility node contents to the host; cross-package snapshots contain package/class/window metadata only.
- Never send normal remote keys unless the tested package owns the focused Android window immediately before dispatch.
- Permit setup keys only for the exact known system packages `com.android.permissioncontroller`, `com.google.android.permissioncontroller`, `com.android.packageinstaller`, and `com.google.android.packageinstaller`.
- Never write a screenshot unless the tested package owns focus both before and after `screencap`.
- A scan may report complete only if final target ownership is verified; otherwise status is partial.
- Preserve unrelated existing repository behavior and API compatibility.

---

### Task 1: Observer ownership and redaction

**Files:**
- Modify: `packages/driver-android/observer/src/org/tvdoctor/observer/ObserverAccessibilityService.java`
- Modify: `scripts/test-android-observer-security.mjs`
- Generated: `packages/driver-android/observer/tvdoctor-observer.apk`
- Generated: `packages/driver-android/observer/observer-manifest.json`

**Interfaces:**
- Consumes: observer protocol v2 `current_state`, `settle_action`, and `resync` requests.
- Produces: honest `packageName`/`windowClassName`/`windowId`; target-only nodes/focus; owner-sensitive tree invalidation.

- [ ] **Step 1: Write the failing security regression**

Update the observer security test so launching `org.tvdoctor.observer/.SetupActivity` after provisioning a different target must return `packageName: "org.tvdoctor.observer"`, zero nodes, null focus, and a SetupActivity window class, rather than retaining the target identity.

- [ ] **Step 2: Run the observer security test and confirm RED**

Run: `node scripts/test-android-observer-security.mjs`
Expected before implementation: the outside-window assertion fails because the observer filters foreign events and/or substitutes target ownership.

- [ ] **Step 3: Implement real active-root ownership**

Change `onAccessibilityEvent` to observe events for every package after provisioning; retain only bounded package/class metadata for foreign windows. In `captureState`, set ownership from `getRootInActiveWindow().getPackageName()`, serialize nodes/focus only when that package exactly equals `targetPackageName`, never substitute stale event package data when the active root is null, and include package ownership in the full-tree invalidation key so target -> foreign -> target forces a fresh full tree.

- [ ] **Step 4: Rebuild and verify observer assets**

Run: `npm --workspace @tvdoctor/driver-android run build:observer`
Run: `npm run verify:observer`
Expected: signed observer asset and manifest are regenerated and verification passes.

---

### Task 2: Driver fail-closed foreground guards

**Files:**
- Modify: `packages/driver-android/src/android-driver.ts`
- Modify: `packages/driver-android/test/android-v2-driver.test.ts`

**Interfaces:**
- Consumes: honest observer ownership from Task 1 and `dumpsys window` focused package data.
- Produces: `pressSystemSetup`, redacted external snapshots, pre-input foreground checks, two-sided screenshot ownership checks, setup-aware launch settling.

- [ ] **Step 1: Add failing driver regressions**

Add tests that prove: a redacted foreign state is returned without foreign nodes; leaked foreign nodes are rejected; normal key dispatch is blocked before `input keyevent` when another package owns focus; a target action may resolve to a redacted external boundary after dispatch; explicit setup SELECT works only for the exact allowlist; lookalike package `com.evil.permissioncontroller.fake` is rejected; screenshot capture is blocked when focus is foreign before capture; screenshot output is not written when focus switches to foreign during `screencap`; and target -> foreign -> target requests a full tree after cache invalidation.

- [ ] **Step 2: Run driver tests and confirm RED**

Run: `npm test --workspace @tvdoctor/driver-android -- android-v2-driver.test.ts`
Expected before implementation: new foreground/redaction regressions fail.

- [ ] **Step 3: Implement foreground ownership checks**

Add the exact system-setup package allowlist. Before normal key dispatch, query `dumpsys window` and require exact target package focus. Add `pressSystemSetup("SELECT" | "BACK")` using the same action transport but require exact allowlisted system focus before sending input. Redact every non-target observer state to empty tree/null focus and reject any foreign state that carries nodes or focus. Clear cached target tree on every external/unknown state. Guard screenshots with target focus before capture and again after PNG validation but before filesystem writes. Let launch settling surface an exact allowlisted setup boundary rather than misclassifying it as a target failure.

- [ ] **Step 4: Run driver verification**

Run: `npm test --workspace @tvdoctor/driver-android`
Run: `npx tsc -p packages/driver-android/tsconfig.json --pretty false`
Expected: all driver tests and typecheck pass.

---

### Task 3: CLI traversal, setup, progress, and final validation

**Files:**
- Modify: `packages/cli/src/android-product.ts`
- Modify: `packages/cli/test/product-flow.test.ts`

**Interfaces:**
- Consumes: `AndroidTvDriver.pressSystemSetup`, redacted external locations, verified target reset behavior.
- Produces: non-expandable package boundaries, setup handling, fresh restoration snapshots, final ownership verdict, partial report on final validation failure.

- [ ] **Step 1: Add failing CLI regressions**

Add tests for permission-controller startup classification from location metadata even with an empty tree; exact canonical settling so tree changes are not considered stable merely because activity/focus are unchanged; restoration that resets when the current snapshot is external and rejects a persistent external result; and completion verdict that is false whenever final target validation fails.

- [ ] **Step 2: Run CLI tests and confirm RED**

Run: `npm test --workspace @tvdoctor/cli -- product-flow.test.ts`
Expected before implementation: the new boundary/final-validation assertions fail.

- [ ] **Step 3: Implement CLI boundary and final-target behavior**

Use exact canonical snapshot equivalence for Android action settling. Classify known permission/package-installer locations as setup even when the tree is empty. Route guided setup SELECT/BACK through `pressSystemSetup` when the current setup snapshot is outside the target package. Replace restoration-only callbacks with `restoreInitialSnapshot` so the live activity label is cleared during reset and then updated from the freshly restored snapshot. Before final evidence and again after supplementary evidence collection, require a target-owned snapshot; reset/relaunch once when needed, and mark report/run/pack partial if target ownership remains unverified.

- [ ] **Step 4: Run CLI and core verification**

Run: `npm test --workspace @tvdoctor/cli`
Run: `npm test --workspace @tvdoctor/core`
Run: `npx tsc -p packages/cli/tsconfig.json --pretty false`
Run: `npx tsc -p packages/core/tsconfig.json --pretty false`
Expected: all CLI/core tests and typechecks pass.

---

### Task 4: Release verification and GitHub integration

**Files:**
- Review all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: complete implementation from Tasks 1-3.
- Produces: verified branch, clean diff, green CI, merge to `main`.

- [ ] **Step 1: Static validation**

Run: `git diff --check`
Run: `npx eslint packages/driver-android/src/android-driver.ts packages/driver-android/test/android-v2-driver.test.ts packages/cli/src/android-product.ts packages/cli/test/product-flow.test.ts`
Expected: no errors.

- [ ] **Step 2: Full relevant test matrix**

Run: `npm test --workspace @tvdoctor/driver-android`
Run: `npm test --workspace @tvdoctor/core`
Run: `npm test --workspace @tvdoctor/cli`
Run: `npm run verify:observer`
Expected: all pass.

- [ ] **Step 3: Push and inspect CI**

Push the branch, open a pull request against `main`, and inspect every workflow job. Fix any real regression before merging.

- [ ] **Step 4: Merge only after green verification**

Squash-merge the verified pull request into `main`, then confirm the merged commit status and report the final commit SHA.