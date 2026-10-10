# Roku driver qualification

TVDoctor contains an **unvalidated** `@tvdoctor/driver-roku` contributor adapter
for Roku's first-party WebDriver. It is not exposed as a supported CLI surface and
does not establish Roku compatibility by itself.

The adapter intentionally uses Roku's documented WebDriver primitives rather than
inventing a private device protocol: session creation, app launch, remote
keypresses, the active/focused element, current-app metadata, and the current
screen source. The first-party WebDriver service runs separately on the host and
forwards commands to the selected Roku device.

## What is implemented

- `UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, `BACK`, `HOME`, `PLAY`, `STOP`,
  `REWIND`, and `FAST_FORWARD` mapping where Roku WebDriver documents an
  equivalent key;
- app launch by Roku channel ID;
- active focus observation;
- bounded screen-source parsing into TVDoctor's platform-neutral UI tree;
- current-app identity;
- relaunch reset; and
- bounded local HTTP transport with explicit command failures.

Unsupported remote keys stay `unsupported`. Clear-data reset is rejected. The
adapter does not sideload packages, handle developer credentials, capture
screenshots, or claim logs/performance/player observations.

## Required proof before Experimental support

1. Run the package unit tests and shared `runDriverConformance()` helper against a
   redistributable safe SceneGraph fixture.
2. Run the same conformance contract through Roku's actual WebDriver on a named
   Roku device and OS version.
3. Prove bounded automatic exploration produces stable focus identities and an
   honest frontier on that fixture.
4. Seed at least one deterministic navigation defect and prove report evidence
   plus replay classification across repeated fresh sessions.
5. Record cleanup, timeout, malformed-source, app-exit, and WebDriver-restart
   behavior.
6. Only then expose a Roku CLI path and label the adapter Experimental.

Until those gates are recorded, Roku remains unsupported in the public product
scope even though the contributor adapter exists.
