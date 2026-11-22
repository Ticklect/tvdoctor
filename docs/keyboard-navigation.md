# Browser keyboard navigation (unreleased source work)

**Status: implemented in the current source checkout, unreleased.** The public `v0.1.0` Windows
ZIP does not accept `--input keyboard`, and no published release or npm package
currently promises this behavior. Confirm your checkout lists the option in
`scan --help` before trying it.

The initial scope is **sequential browser keyboard focus navigation**. Run:

```sh
npm run tvdoctor -- scan http://127.0.0.1:3000 --input keyboard --mode quick
```

This is a working source-checkout interface, **not a command in the published
v0.1.0 ZIP**. In an older checkout without `--input`, the command is unavailable.
The existing `tvdoctor scan URL` path continues to
explore TV remote/D-pad navigation.

## Initial behavior

- Run in the local Playwright Chromium web driver against an authorised web
  page; use real `Tab` and `Shift+Tab` key presses to observe forward and reverse
  sequential focus movement.
- Build the observed screen, focus, and transition graph from browser snapshots.
  Each reported transition must have evidence; a guessed tab order is not
  evidence of reachability.
- Apply bounded exploration and report when time, actions, states, depth,
  restoration, or observability prevent coverage from completing. A partial
  scan is not a clean result.
- Keep TV remote exploration as the default. Keyboard mode should not apply
  D-pad-specific assumptions such as spatial direction, expected arrow-key
  neighbours, or a mandatory wrap from the final element to the first.
- Diagnose only defects supported by observed transitions. One initial
  keyboard-specific diagnostic targets focus leaving a still-open modal dialog
  for an outside visible control after `Tab` or `Shift+Tab`, with the same modal
  observed before and after. A dialog that closes before focus moves is a
  different situation and must not be labelled an escape.

These are the **implemented scope and evidence requirements** for the initial
browser mode, not a claim that arbitrary websites have passed validation.
A controlled Chromium run has demonstrated graph creation, an observed modal
focus escape, a generated report, and a standalone `REPRODUCED` replay. This
does not establish compatibility with other applications.

## Evaluate the source checkout

From the repository root, install and build the source checkout and prepare
the matching Chromium runtime:

```sh
npm ci
npm run build
npm run tvdoctor -- setup
npm run tvdoctor -- scan --help
```

Point it at an application you are authorised to test,
preferably a local disposable build. Review the generated HTML report and its
observed focus graph, action counts, remaining frontier, and any replay
evidence. Treat unexpected focus movement as a finding only when its recorded
observations support it.

## Limits and proof

This mode is **not an accessibility certification, WCAG conformance audit, or
proof that every interactive element can be reached**. A Tab path alone cannot
validate keyboard activation, screen-reader output, focus indicator visibility,
all dialog behavior, pointer equivalence, native browser chrome, or other
assistive-technology support. Native tab order depends on the page and browser;
controls in closed shadow roots, cross-origin frames, canvas-only interfaces,
or inaccessible DOM structures can be outside the driver's evidence. The driver
uses DOM-derived observations, not the browser accessibility tree.

The [Northstar sample report](sample-report.md) covers a seeded TV D-pad defect.
Keyboard-mode claims need separate fixture tests and repeatable Chromium runs
with measured complete or partial coverage. Production-website compatibility
requires authorised real-app evidence. See [Benchmarking](BENCHMARKING.md),
[current limitations](limitations.md), and the [web driver contract](drivers/web.md).
