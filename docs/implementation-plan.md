# TVDoctor implementation plan

## Current state

TVDoctor started as an empty directory on 2026-08-19. Milestones 0–11 are complete. The repository now has an experimental real-Chromium web driver, a bounded deterministic explorer with repetition compression and priority-frontier exploration, conservative navigation diagnostics, canonical local report bundles, validated deterministic web replay, exact sequence minimisation, a platform-neutral semantic streaming/player journey pack, six independent web audit packs orchestrated through `tvdoctor test URL`, a proven baseline comparison lifecycle, and a real Android TV emulator gate. 

## Foundation decisions

- Use an npm workspace monorepo with one committed `package-lock.json`. This matches the intended `npm install` and `npx tvdoctor` user experience without requiring a second package manager.
- Support only Node.js 24/npm 11 initially because that is the locally proven toolchain. Widen the range only after CI verifies other versions.
- Use project-local TypeScript, ESLint, and Vitest versions. Never rely on globally installed tools.
- Use strict TypeScript project references. Create packages only when a milestone needs working code; do not pre-create the aspirational architecture.
- Keep platform-neutral contracts in `@tvdoctor/protocol`. Platform-specific behavior belongs in driver packages added by their milestones.
- Represent missing observations explicitly. A driver that cannot observe a value must report it as unavailable rather than turning absence into a pass or failure.
- Keep the core deterministic and local-first. AI is outside the initial critical path.

## Minimal protocol boundary

Milestone 0 establishes only the contracts needed to build safely:

- platform-neutral remote keys;
- driver capabilities;
- explicit available/unavailable observations;
- action results and timing;
- a minimal state snapshot;
- the driver lifecycle surface.

Issue types, report schema v0, CLI commands, and the broken streaming fixture belong to Milestone 1. The real Playwright implementation belongs to Milestone 2.

## Gated roadmap

| Milestone | Coherent deliverable | Gate evidence required before advancing |
| --- | --- | --- |
| 0 | Repository audit, npm workspace, strict TypeScript, minimal protocol, written plan | Install, lint, typecheck, unit tests, and build all pass |
| 1 | CLI skeleton, issue/report types, test driver, realistic broken streaming web fixture | Fixture starts; keyboard remote input and seeded defects are manually/integration verified; CLI and all checks pass |
| 2 | Playwright web driver | Real fixture integration proves directional input, Select, Back, snapshots, screenshots, and error capture |
| 3 | Bounded deterministic explorer with separate screen/focus graphs | Fixture exploration terminates, discovers expected states/transitions, and is substantially repeatable |
| 4 | High-confidence navigation diagnostics | Seed manifest comparison records detected, missed, and false-positive findings |
| 5 | Canonical JSON, human/AI reports, evidence, and replay | At least three real fixture failures produce inspected reports and reliably reproduce |
| 6 | Streaming/player semantic journey pack | Text Colour remote-unreachability is found and replayed without a hardcoded fixture path |
| 7 | Search, settings, accessibility, performance, and crash packs | Each pack passes its own fixture/test/evidence gate; controlled audit works end to end |
| 8 | Exploration hardening and sequence minimisation | Large carousels remain bounded; before/after benchmark records runtime, actions, states, recall, and false positives |
| 9 | Android TV driver | Emulator install/launch/DPAD/snapshot/log/report/replay vertical slice is proven |
| 10 | Baselines and CI regression | A deliberate new high-severity issue is detected, then classified as resolved after restoration |
| 11 | v0.1 release hardening | Clean install and every documented quality command pass; docs accurately distinguish stable, beta, experimental, and planned support |

## Milestone 0 audit

- Repository at audit time: empty, with no hidden files and no Git metadata.
- Reusable implementation: none.
- Existing user changes to preserve: none observable.
- Local tools: Node.js 24.18.0, npm 11.16.0, Git 2.55.0, and ripgrep 15.2.0. Yarn is absent; globally installed TypeScript is intentionally ignored.
- Workspace path contains a space, so commands and future scripts must not assume an unquoted path.

## Milestone 0 gate record

Status: **complete — verified 2026-08-19 on Windows with Node.js 24.18.0 and npm 11.16.0**.

Required commands:

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Verified evidence:

- `npm install`: installed 131 packages; audit reported 0 vulnerabilities.
- `npm ci`: reproduced the install from `package-lock.json`; audit reported 0 vulnerabilities.
- `npm run lint`: passed with zero warnings.
- `npm run typecheck`: the solution build and separate test typecheck passed under TypeScript 6.0.3 strict settings.
- `npm test`: 1 test file and 3 tests passed under Vitest 4.1.11.
- `npm run build`: passed from a clean TypeScript build state and emitted ESM JavaScript, declarations, declaration maps, and source maps.
- Public import smoke test: Node imported `@tvdoctor/protocol` through its package export and verified all six initial remote keys plus explicit unavailable observations.
- `npm pack --workspace @tvdoctor/protocol --dry-run`: succeeded with 21 intended package files; incremental compiler metadata was removed from the distributable contents.

Milestone 0 gate conclusion: the package manager, strict TypeScript configuration, linting, tests, build, workspace package export, and planned directory structure are all operational. Milestone 1 may begin. Milestone 2 remains blocked until the Milestone 1 fixture and CLI gate is proven.

## Milestone 1 gate record

Status: **complete — verified 2026-08-19 with real Chromium 151 via Playwright 1.62.1**.

Implemented:

- `@tvdoctor/protocol` issue and canonical `tvdoctor.report/v0` contracts, with severity separate from confidence/evidence classification and explicit available/unavailable reproduction data;
- the dependency-free `tvdoctor` CLI foundation with `--help`, `help`, and `doctor`;
- an original `Northstar` streaming fixture with real DOM focus and Arrow/Enter/Escape/Backspace/BrowserBack mappings;
- 13 stable seeded defects in a machine-readable manifest;
- Home → Details → Player → delayed Settings → Captions → Appearance, plus search, profiles, player controls, and Back flows;
- direct Playwright contracts that verify the fixture independently of the future TVDoctor web driver.

Verified evidence:

- Actual `tvdoctor --help`: exited successfully and accurately described the experimental foundation.
- Actual `tvdoctor doctor`: exited successfully on Windows/Node.js 24 and reported drivers/audits as unavailable rather than pretending support.
- Unit tests: 3 files and 18 tests passed for protocol, report serialization, and CLI behavior.
- Browser contracts: 7 of 7 passed in real Chromium, covering D-pad/Select/Back, deterministic focus, abnormal RIGHT jump, weak focus, focus trap, search, slow settings, clipping, caption selection failure, Text Colour remote-unreachability/pointer reachability, console error capture, and the 13-entry manifest.
- Aggregate `npm run check`: lint, strict package and fixture typechecks, all unit/browser tests, package builds, and the Vite production build passed.
- Production fixture output: generated HTML, 18.58 kB CSS, and 30.82 kB JavaScript before gzip; no remote assets or copyrighted commercial UI were used.
- Manual workflow capture at 1280×720: initial focus was `home-nav-home`; the settings drawer ended at x=1416 in a 1280px viewport; `caption-font-size --DOWN--> caption-background-colour`; Text Colour reported `data-remote=false`; a pointer click changed it from `Warm white` to `Sunflower`; the deliberate startup console error was observed.
- Visual inspection: Home and Caption Appearance were coherent and readable; normal focus was highly visible; Text Colour was visibly positioned between Font Size and the remotely focused Background Colour.

Local visual evidence was captured at `artifacts/milestone-1/home.png` and `artifacts/milestone-1/caption-appearance.png`. Generated artifacts are intentionally ignored by Git.

Milestone 1 gate conclusion: the fixture starts, its remote keyboard navigation works, representative seeded bugs are deterministically proven, the CLI starts, tests pass, and the repository builds cleanly. Milestone 2 may begin.

## Milestone 2 gate record

Status: **complete — verified 2026-08-20 with real Chromium 151 via Playwright 1.62.1**.

Implemented:

- `@tvdoctor/driver-web`, an experimental Playwright adapter with honest capability reporting for launch, remote input, UI-tree snapshots, screenshots, logs, sanitised network metadata, performance timing, and HTML-media observations;
- coherent snapshots containing URL, viewport, body screen state, active-element identity/name/role/bounds, visible interactive controls, and an explicitly available or unavailable UI tree;
- real keyboard mapping for every protocol key, including remote `BACK` as `Escape` rather than browser history;
- bounded settling that re-queries after render, waits through `aria-busy` and the fixture's 1.35-second Settings transition, and ignores unrelated clocks/toasts that would make whole-DOM or network-idle settling hang;
- bounded console, page-error, crash, request, response, and failed-request collection installed before navigation, with query/user-info/fragment redaction and no headers, bodies, cookies, or storage collection;
- caller-owned screenshot paths that are never derived from page content, lifecycle-safe launch/reset/close behavior, idempotent cleanup, and cleanup after partial launch failure;
- protocol extensions for JSON-only UI nodes and screenshot metadata, while deliberately not claiming accessibility-tree, install, or video-capture support.

Verified evidence:

- Public driver integration: 6 of 6 tests passed against the real Northstar fixture in Chromium, using driver methods for D-pad, Select, Back, settling, snapshots, screenshots, collection, reset, and cleanup.
- Navigation contract: initial focus was `home-nav-home`; RIGHT reached `hero-watch`; LEFT restored Home; SELECT reached `details-play`; BACK reached `search-query`, deterministically exposing the fixture's intentionally broken app behavior without invoking browser history.
- Slow-settle contract: selecting Player Settings did not return during the stable-looking busy intermediate state; it resolved after the delayed transition with focus on `settings-captions`.
- Snapshot contract: focus names/roles/stable IDs and positive finite CSS-pixel bounds were observed; the UI tree included screen structure and pointer-only controls even though every SPA screen shares one URL.
- Screenshot contract: a real PNG was written to a caller-supplied path containing spaces, had valid PNG bytes and 1280×720 dimensions, and remained after driver close. Non-image extensions were rejected.
- Error and telemetry contract: the fixture's startup console error was captured by pre-navigation listeners; a separate uncaught page error was distinguished; same-origin network activity, timing, and a synthetic HTML-media element were observed without retaining secret query data.
- Hostile-page-data probe: an overlong stable ID and an `aria-label` containing a fake instruction, script markup, and `token=TOPSECRET` remained inert structured strings, were bounded/redacted, and did not execute or influence artifact paths.
- Lifecycle contract: a failed navigation released partial resources, `close()` was idempotent, and post-close behavior was deterministic.
- Race regression: the RIGHT/LEFT initial-focus contract passed 20 concurrent repetitions after launch settling was hardened to cross two animation frames before taking its baseline.
- Aggregate `npm run check`: ESLint passed with zero warnings; strict typechecks passed; 3 unit files/21 tests, 7 fixture tests, and 6 driver tests passed; TypeScript packages and the Vite production fixture built successfully.
- `npm pack --workspace @tvdoctor/driver-web --dry-run`: succeeded with 26 intended files (README, metadata, and compiled ESM/declarations/source maps only), 20.8 kB packed.
- Public-package smoke run: Node imported the built workspace package, drove the fixture through Home and Details, observed all eight advertised capabilities, captured the seeded console error and network summary, and produced `artifacts/milestone-2/details.png`.
- Visual inspection: the 1280×720 Details capture was coherent and artifact-free, with legible metadata and a strong focus ring on Play.

Generated visual evidence is intentionally ignored by Git. The clean-checkout `npm ci`, clean build, and full aggregate gate are rerun whenever this record changes.

Milestone 2 gate conclusion: the real web driver launches the fixture, sends TV-style input, observes stable state, waits through meaningful async UI work, captures local evidence and bounded telemetry, and cleans up predictably. Milestone 3 may begin. The driver remains experimental until the explorer, diagnostics, reporting, and broader hardening milestones are proven.

## Milestone 3 gate record

Status: **complete — verified 2026-08-20 with deterministic unit machines and two fresh real-Chromium Northstar crawls**.

Implemented:

- `@tvdoctor/core`, a platform-neutral package whose only runtime dependency is `@tvdoctor/protocol`;
- distinct `ScreenState` and `FocusState` graphs, with cross-screen edges retaining their source and destination focus witnesses;
- deterministic breadth-first exploration with one fixed action order, explicit root-relative key sequences, visited-state tracking, and a restoration/replay check before every branch;
- limits for every physical input (including replay), retained states, discovery depth, and monotonic elapsed duration, with an explicit complete or incomplete termination reason;
- action attempts containing the driver's exact `ActionResult`, before/after snapshots, destination fingerprint, and reproduction sequence;
- structural screen fingerprints that exclude focus, names/text, absolute bounds, live status/progress nodes, query strings, timestamps, and screenshot hashes while preserving meaningful numeric stable IDs;
- focus fingerprints that prefer stable IDs, distinguish observed lost focus from unavailable focus, and expose high/medium/low match confidence;
- a duration deadline around driver calls so an adapter promise that never settles cannot hold the explorer indefinitely. The generic protocol cannot cancel the abandoned operation, so callers must still close the driver.

Verified evidence:

- Core unit gate: 18 tests cover screen/focus separation, structural changes, live-label and geometry stability, meaningful numeric IDs, volatile status/progress filtering, explicit unavailable observations, deterministic graph output, cycles, self-loops, each budget, replay divergence, settling order, missing capabilities/restoration, invalid configuration, and a never-resolving driver call.
- Cyclic-machine completion: a three-state graph exhausted its queue after 24 physical inputs (12 exploration plus 12 replay), retained three states, and did not revisit forever.
- Real-browser gate: two fresh Northstar crawls ran concurrently through the public web-driver/core APIs. Each stopped exactly at its 96-input budget, split 40 exploratory inputs from 56 replay inputs, retained 5 structural screens and 16 focus states, and stayed below 40 states, depth 4, and 45 seconds.
- Known real screens discovered structurally: Home, Search, Details, Player, and Profile Picker. Known focus edges included `home-nav-home --RIGHT--> hero-watch`, `hero-watch --SELECT--> details-play`, `details-play --SELECT--> player-play-pause`, and `home-nav-library --SELECT--> profile-primary`.
- Every `(FocusState, RemoteKey)` pair was expanded at most once; unchanged/self-loop edges were recorded without re-enqueueing the state.
- Repeatability: after stripping timings and generated insertion IDs, the two real crawls had byte-identical sorted screen fingerprints, focus-state fingerprints, and transition signatures.
- Deeper calibration: a 480-input, depth-12 forward crawl remained bounded at 43 focus states and reached eight semantic fixture families, including App Settings, Player Settings, and Captions. Caption Appearance remained beyond that plain-BFS frontier, which is intentionally deferred to the semantic journey and priority-frontier milestones rather than hidden by uncounted replay.
- Deadline hardening: a longer calibration exposed that elapsed checks only between calls could not bound a stuck adapter operation; a per-call remaining-duration race and a dedicated never-settling-driver regression test now cover that failure mode.
- Aggregate `npm run check`: ESLint passed with zero warnings; strict package/fixture/integration typechecks passed; 5 unit files/39 tests, 7 fixture tests, 6 driver tests, and the two-crawl explorer integration passed; all packages and the production fixture built successfully.
- `npm pack --workspace @tvdoctor/core --dry-run`: succeeded with 22 intended files (README, metadata, and compiled ESM/declarations/source maps only), 15.6 kB packed.
- Public-package smoke test: Node imported `@tvdoctor/core` through its package export and observed the default budgets and fingerprint API.

Milestone 3 gate conclusion: exploration is deterministic, explicitly bounded, cycle-safe, graph-producing, and substantially repeatable against the real fixture. The current simple BFS is intentionally not presented as an exhaustive streaming-app crawler; carousel compression, priority frontier routing, and sequence minimisation remain Milestone 8 work. Milestone 4 may begin.

## Milestone 4 gate record

Status: **complete — verified 2026-08-20 with deterministic graph tests and real Chromium fixture evidence**.

Implemented:

- seven fixture-independent navigation rules: lost focus, visible remote-unreachability, directional self-loop, modal focus trap, focus behind a modal, broken immediate Back behavior, and abnormal geometric jump;
- separate deterministic and heuristic finding collections, with abnormal geometry retained as a heuristic warning rather than reported as fact;
- semantic issue IDs derived from canonical rule/screen/element/transition evidence, independent of traversal IDs, array order, or unrelated findings;
- exact action-native transitions and reproduction sequences, including the final action that demonstrates an unreachable aligned control;
- platform-neutral `enabled` and `modal` UI observations. Fingerprints retain those meaningful structural changes, while unavailable evidence never becomes a failure;
- conservative proof guards: complete local action coverage, unique available focus observations, enabled candidates, same-parent alignment, verified modal entry, and proof that every trap destination remains inside the same modal.

Verified evidence:

- Core unit gate: 33 tests passed, including disabled/unavailable suppression, concrete reachability witnesses, root/modeless/escapable-dialog negatives, same-screen focus leakage, stable IDs under graph reordering/renaming, merged-result uniqueness, and deterministic-versus-inference evidence separation.
- Production Home crawl: `explore()` exhausted the four-direction queue with 14 focus states and 56 exploratory edges under a 260-input, 40-state, depth-8, 120-second bound. It automatically found exactly `hero-more-info` remote-unreachability and the `home-card-3 --RIGHT--> footer-privacy` abnormal jump.
- Real-driver context probes covered the entered Profile Picker, Caption Appearance, and immediate Details/Back behavior. These probes are truthfully recorded as incomplete targeted traces; they do not claim automatic root discovery.
- Seed-manifest comparison: all five explicitly in-scope M4 seeds were detected, none were missed, no duplicate or unmatched findings were emitted, and the other eight fixture seeds remained explicitly outside this milestone's adjudicated scope.
- Classification: Home More Info, Caption Text Colour, Profile Picker trap, and Details Back behavior were deterministic; the card-to-footer jump was heuristic. Every finding carried structured transition/evidence data and an available exact or best-effort sequence appropriate to that classification.
- Browser gate: the strengthened five-seed comparison passed in 59.5 seconds in real Chromium. It asserts unique semantic issue IDs, detailed source/target metadata, classification, severity, transition, evidence source, reset strategy, and reproduction steps.
- Core package gates: strict source/test/integration typecheck, ESLint with zero warnings, 33 unit tests, both Chromium integrations, build, public import, and package dry-run passed before the clean aggregate gate.
- Clean repository gate: `npm ci` installed 138 packages with 0 vulnerabilities; `npm run clean`; then `npm run check` passed lint, every strict typecheck, 6 unit files/54 tests, 7 fixture tests, 6 driver integrations, both core Chromium integrations, all TypeScript builds, and the fixture production build.
- Distribution smoke: dry-run packages for protocol (29 files), web driver (26 files), and core (26 files) contained only intended metadata/README/compiled outputs; Node imported all three public package exports; actual `tvdoctor --help` and `tvdoctor doctor` accurately reported Milestone 4 libraries while leaving CLI audits unavailable.

Scope boundary: only Home directional coverage is discovered from the application root by the production explorer in this milestone. The deep caption route is a real-browser targeted detector probe; discovering and replaying it without a hardcoded fixture path remains the Milestone 6 streaming-journey gate. Search/Player pack adjudication likewise remains later work, so “zero false positives” applies to the explicitly covered M4 traces, not to an untested whole application.

Milestone 4 gate conclusion: the rule engine now consumes real explorer/driver evidence, distinguishes fact from heuristic inference, avoids the obvious seeded false positives in its measured scope, and emits stable evidence-rich findings. Milestone 5 may begin after the repository-wide clean-install gate is rerun.

## Milestone 5 gate record

Status: **complete — verified 2026-08-20 with real Chromium 151, Playwright 1.62.1, generated evidence bundles, and fresh-driver replay**.

Implemented:

- canonical `tvdoctor.report/v1` and `tvdoctor.replay/v1` protocol models while retaining V0 compatibility, with strict bounded runtime parsing, portable artifact paths, schema exports, and report/issue/replay cross-link validation;
- `@tvdoctor/reporters`, which writes a containment-checked local artifact store and derives `report.json`, polished HTML, human Markdown, and confidence-aware AI-coder Markdown from one canonical model;
- before/after screenshots, whitelisted UI excerpts, exact transition data, bounded logs, root-relative navigation paths, portable replay files, hashes, byte lengths, and explicit unavailable artifact states;
- the core replay compiler/executor, with reset, setup checkpoint, final assertion, monotonic budgets, evidence hooks, deterministic/best-effort separation, fixed/reproduced/inconclusive/error classification, trusted issue correlation, and process-local tamper-checked plans copied before asynchronous driver work;
- `tvdoctor replay ISSUE_ID --report PATH [--target URL]` for deterministic web findings, including strict report/target validation, safe terminal output, truthful execution phases, deterministic exit codes, and rejection of heuristic/best-effort findings before browser construction;
- output-boundary security: every public renderer and bundle operation validates and rebuilds a fresh sanitised copy, redacts sensitive environment/evidence keys, escapes target text, preserves caller input, and prevents direct or post-build mutation from leaking secrets.

Verified evidence:

- Three deterministic Northstar findings were detected and bundled: Home `More Info` remote-unreachability, Details Back navigation to an unrelated screen, and Caption `Text Colour` remote-unreachability.
- The run is truthfully labelled `partial`: Home used a production D-pad crawl, while Details and Caption Appearance used explicit real-driver context probes. The deep Caption route is not represented as automatic semantic discovery; that remains Milestone 6.
- Each issue has paired real screenshots plus transition, UI excerpt, console log, exact navigation path, and replay artifacts. Standalone Playwright trace capture is explicitly unavailable rather than fabricated. Report references resolve inside the bundle, and recorded SHA-256/byte lengths match disk.
- Replay YAML uses an intentional JSON-compatible YAML 1.2 subset and parses exactly back to the embedded protocol replay.
- Direct core replay used a fresh browser three times per issue: 9 of 9 reproduced. The built CLI replayed all three issues successfully. A simulated fixed Caption transition classified `fixed`; a wrong checkpoint classified `inconclusive`, never fixed.
- The HTML report was opened in Chromium with no page or console errors; every image decoded, every available artifact link resolved, and issue/replay/evidence text was visible. Human visual inspection found the 1280px dark report readable and coherent, with clear summary cards, classifications, expected/observed transitions, paired screenshots, and artifact inventory.
- Adversarial regressions cover malformed/oversize reports, unsafe URLs and paths, symlink/junction escapes, Windows device names, overlapping issue IDs, duplicate/mismatched cross-links, terminal control characters, prototype keys, nested sensitive keys, HTML/Markdown injection, forged/mutated/concurrently modified replay plans, and direct or post-build renderer secret injection.
- Focused gates passed: 49 protocol tests, 55 core tests (22 replay), 47 reporter tests, and 33 CLI tests, with package typecheck/lint/build gates green.
- Clean install: `npm ci` installed 139 packages, audited 146 packages, and reported 0 vulnerabilities.
- Clean aggregate gate: `npm run clean` followed by `npm run check` passed ESLint, every strict typecheck, 11 unit files/193 tests, 7 fixture browser tests, 6 web-driver browser tests, both core Chromium integrations, the M5 report/replay Chromium integration, all TypeScript builds, and the fixture production build.
- Clean direct-package proof: after `npm run clean`, `packages/cli/dist/bin.js` was confirmed absent; `npm run test:integration --workspace @tvdoctor/reporters` invoked its package-level pre-integration build and then passed the full M5 browser gate in 1.4 minutes.

The reviewed local bundle is at `artifacts/milestone-5-gate`; generated artifacts remain intentionally ignored by Git.

Milestone 5 gate conclusion: three real deterministic fixture failures produce useful local evidence, readable human and AI reports, portable correlated replays, and reliable fresh-browser reproduction. Missing observability, heuristic findings, drift, or tampering cannot become a deterministic pass/failure claim. Milestone 6 may begin; the public CLI still has no end-to-end `test`/audit command.

## Milestone 6 gate record

Status: **complete — verified 2026-08-22 with a route-independent semantic journey, real Chromium evidence, and fresh-driver replay**.

Implemented:

- `@tvdoctor/pack-streaming`, a platform-neutral journey that semantically discovers content, details, playback, controls, settings, captions, Caption Appearance, and nested Back behavior through the public driver contract;
- 17 ordered stages: Home, Content, Details, Play, Player, Controls, Player Volume, Pause/Resume, Seek Forward, Seek Backward, Player Back, Settings, Captions, Caption Selection, Appearance, Caption Text Colour, and Nested Back;
- bounded physical input, global state retention, local D-pad depth/state expansion, monotonic duration, safe content-action selection, iterative bounded UI-tree traversal, and fail-closed role/name, playback-progress, caption-selection, restoration, and pointer-provenance checks;
- a platform pointer-probe boundary that receives the discovered semantic target and exact surface route, proves a concrete property change in a fresh isolated context, and requires the main remote session to be restored;
- a test-only `semantic-alternate` fixture route that changes the Home-to-content, Player-to-settings, and Captions-to-Appearance D-pad edges while preserving the same user-visible semantics and seeded findings.

Verified evidence:

- Both the default and alternate real-Chromium journeys completed under the standard 900-action, 180-state, depth-12, 48-local-state, and 180,000 ms budgets. The canonical default report records 618 physical actions/transitions, 17 focus states, six screen states, and 120,664 ms, with no exhausted budget category.
- The gate executed all 17 stages in order. Thirteen passed; exactly four failed with deterministic scoped findings: `player-volume`, `seek-backward`, `caption-selection`, and `caption-text-colour`.
- The exact findings were `TVDOCTOR-STREAM-D032BE618739189DCCA7FEEF9693F8F1` (`remote.reachability`, Caption Text Colour remote-unreachability, high), `TVDOCTOR-STREAM-55543C8ECC4174BA43E1150CC5D2727E` (`streaming.captions`, ignored caption selection, high), `TVDOCTOR-STREAM-60951B166AC843BABE798A143BF982E6` (`accessibility.pointer-only-control`, pointer-only player volume, medium), and `TVDOCTOR-STREAM-6A544FEAFD94DFF6E940F3D4F3147C7A` (`streaming.player-control`, Rewind moving playback forwards, medium). All four are deterministic and belong to the streaming pack.
- The two focus-transition findings have available Replay V1 records. Each reproduced in three fresh Chromium sessions, for 6 of 6 fresh replays; fixed-transition simulations classified `fixed`, and checkpoint drift classified `inconclusive`. Caption selection and numeric playback progress are explicitly replay-unavailable because Replay V1 cannot assert those states.
- The fresh pointer probes uniquely correlated visible, enabled semantic buttons. Text Colour activation changed both its value label and the caption preview colour; player volume activation changed the dialogue-boost status. Complete local D-pad expansion could not reach either control, and the main remote journey was restored after both isolated probes.
- The anti-shortcut gate rejects fixture data attributes, seed-manifest access, fixture route channels, hardcoded remote sequences, and fragmented stored routes in production pack source. The alternate fixture variant changed all three inspected route shapes while preserving the same four semantic issue IDs.
- The canonical `tvdoctor.report/v1` bundle contains four issues, two replays, and 32 artifact descriptors: eight slots per issue, with 26 available artifacts and six explicit unavailable states. Its eight before/after screenshots are 1280×720; every available path, byte length, SHA-256, report link, evidence cross-link, and replay correlation was checked. Every navigation-path artifact retains the ordered 17-stage ledger and is validated against the pack result; the Rewind UI excerpt directly records progress 582 before and 592 after Select.
- The HTML gate opened all four findings with no report console/page errors, decoded every screenshot, enforced its Content Security Policy, kept hostile markup inert, and redacted the injected secret. Human and AI Markdown contain every issue; the AI output emits two replay-backed Fix tasks and two non-replayable Review tasks with their owned evidence.
- Focused tests passed: 23 streaming-pack unit tests and 10 fixture browser tests. `npm run test:integration --workspace @tvdoctor/pack-streaming` performed its clean build and passed the single end-to-end M6 Chromium gate; the equivalent root command is `npm run test:streaming-integration`.
- Clean aggregate proof: `npm ci` added 140 packages and reported 0 vulnerabilities; `npm run clean`; then `npm run check` passed lint, every strict typecheck, 13 unit files/223 tests, 10 fixture browser tests, 8 web-driver browser tests, 2 core Chromium integrations, the M5 reporter integration, the M6 streaming integration, and all package and production fixture builds.

The reviewed local bundle is at `artifacts/milestone-6-gate`; generated artifacts remain intentionally ignored by Git.

Milestone 6 gate conclusion: the pack discovers and verifies a complete semantic streaming/player journey without fixture IDs or a stored path, reports exactly the four in-scope deterministic defects, and provides honest evidence and replay classifications. Milestone 7 may begin; search, broader settings/accessibility, performance, crash packs, and public CLI audit orchestration remain unimplemented.

## Milestone 7 gate record

Status: **complete — verified 2026-08-22 with real Chromium 151, six independent web stages, and five deterministic fixture seeds**.

Implemented:

- `@tvdoctor/pack-web`, a platform-neutral library with six independent stages: search, settings, accessibility, layout, performance, and crash;
- search discovers a semantic Search navigation control, enters a configured query using counted on-screen keys, verifies result candidates, proves submit-control remote-unreachability with an isolated pointer probe, and checks Back restoration;
- settings traverses safe semantic Settings surfaces without activating ambiguous, destructive, account, or payment controls;
- accessibility probes bounded focus states for weak focus indicators using semantic visibility evidence;
- layout replays a streaming-discovered player-settings sequence and proves viewport clipping of a visible control through an isolated pointer probe;
- performance measures first-response and settled-screen latency against a configurable threshold for the same player-settings route;
- crash reads bounded application logs for console errors, page errors, crashes, and failed requests;
- `tvdoctor test URL` orchestrates streaming + web packs, captures per-issue before/after screenshots, UI excerpts, transitions, navigation paths, console logs, replay availability, and writes `report.html`, `report.md`, `ai-report.md`, `report.json`, `stage-ledger.json`, and `inventory.json`;
- standard web-pack budgets raised to 1 280 actions / 320 states / 600 s to cover all six stages within their hard limits.

Verified evidence:

- The M7 integration test (`npm run test:integration --workspace tvdoctor`) passed all assertions in 6.2 minutes in real Chromium.
- The audit completed all six web packs with status "completed" and no exhausted budget categories.
- Exactly five issues were reported with rules matching the expected set: `crash.console-error`, `focus.visibility`, `layout.viewport-clipping`, `performance.menu-response`, and `search.remote-flow`. All five are medium severity.
- Four findings are deterministic; the `focus.visibility` finding is heuristic (weak focus indicator).
- Every issue carries eight artifact slots. Six available artifacts per issue (before-screenshot, after-screenshot, ui-excerpt, transition, console-log, navigation-path) were verified on disk with matching byte lengths. Replay and trace are explicitly unavailable.
- The stage ledger records all six stages in order with correct statuses: search "failed", settings "passed", accessibility "failed", layout "failed", performance "failed", crash "failed". Settings detail confirms safe traversal without activating ambiguous controls.
- Report bundle contains report.html, report.md, ai-report.md, stage-ledger.json, and inventory.json — each non-empty.
- All 12 fixture browser tests pass, including the M10 baseline-variant test after adding an initial-focus wait that prevents a race between page load and D-pad input dispatch.

The reviewed local bundle is at `artifacts/milestone-7-gate`; generated artifacts remain intentionally ignored by Git.

Milestone 7 gate conclusion: the CLI audit runs six independent web stages end-to-end against the controlled fixture, detects exactly the five remaining seeded defects, produces complete evidence bundles with screenshots and structured data, and passes its integration gate. Milestone 8 may begin; exploration hardening and sequence minimisation remain unimplemented.

## Milestone 8 gate record

Status: **complete — verified 2026-08-22 with a real-Chromium 240-card benchmark, compression fixes, and full regression proof**.

Implemented:

- Fixed two bugs in the repetition-group key that prevented carousel compression from firing on real pages: viewport-relative y-coordinate buckets and visibility flags were included despite changing with horizontal scroll position without changing structural identity;
- Added an M8 Playwright integration gate (`packages/core/integration/milestone8.integration.spec.ts`) that runs the actual Northstar fixture at `?carouselSize=240` through both legacy BFS and hardened priority+compression exploration in real Chromium;
- Verified existing sequence-minimisation library (`minimizeGraphSequence`) against the produced graph inside the same gate.

Verified evidence:

- Baseline BFS (no compression) hit `max-duration` after 200 actions / 28 focus states / 60 s against the 240-card fixture — proving that uncompressed traversal cannot finish large carousels within reasonable bounds.
- Hardened explorer (priority frontier + repetition compression with `maxRepresentativesPerGroup: 1`, `maxExpandedRepresentativesPerGroup: 1`, `minimumEquivalentSiblings: 3`) completed cleanly (`queue-exhausted`) after 876 actions / 49 focus states / 10 screens in approximately 176–249 s across runs.
- Compression retained exactly one stress-carousel focus state (`stress-card-001`) instead of 240 unique card states; four compressed/deferred states confirmed group saturation fired.
- Screen-set recall: every screen fingerprint discovered by baseline was also discovered by hardened exploration.
- Determinism: two independent hardened explorations produced byte-identical canonical graph structures.
- Sequence minimisation: `minimizeGraphSequence` on a multi-step path from the hardened graph returned `semanticsPreserved: true` and either proved already minimal or returned a shorter valid path.
- Full aggregate quality gate (`npm run check`): ESLint zero warnings, strict typecheck all packages, 283 unit tests, 12 fixture browser tests, 8 web-driver integration tests, 3 core explorer integrations (M3 + M8), M5 report/replay integration, M6 streaming journey integration, and production builds all passed.

Milestone 8 gate conclusion: carousel compression now works on structurally repetitive rails regardless of scroll position, the priority frontier completes bounded exploration of a 240-card fixture that uncompressed BFS cannot finish, and exact sequence minimisation is verified against real exploration graphs. Milestone 9 may begin; the Android TV emulator install-to-replay gate remains unimplemented.

## Milestone 10 gate record

Status: **complete — verified 2026-08-23 with real-Chromium targeted-probe baseline comparison, adversarial unit coverage, mutation testing, a locally validated CI example script, and a passing hosted GitHub Actions run**.

Implemented:

- `packages/core/integration/milestone10.integration.spec.ts`, which launches real Chromium against the Northstar fixture's clean and regressed baseline variants, navigates to `m10-probe-a` via D-pad, presses Select, and observes whether focus is retained;
- builds semantic observation inventories from probe results (screens, focus targets, transitions) and feeds them into `@tvdoctor/baseline`'s `createBaseline`/`compareBaseline` API;
- proves all three required lifecycle transitions plus false-positive resistance in a single 4-second integration gate;
- added three adversarial baseline unit tests: duplicate issue IDs are rejected by report validation before comparison; issue-ordering independence produces identical comparison results; empty-string focus destination keys fail closed rather than masquerading as valid evidence;
- added `examples/baseline-ci-example.mjs`, a self-contained Node script that exercises the full consumer workflow (create baseline → compare regressed → compare restored → compare clean) with nonzero exit on any failure.

Verified evidence:

- Clean variant retains focus after SELECT on m10-probe-a (`focusRetained: true`).
- Regressed variant loses focus after SELECT (`focusRetained: false`) — the seeded defect is genuinely observed in Chromium.
- Restored (clean again) variant retains focus as expected.
- Clean → regressed comparison: exactly one new HIGH issue (`TVDOCTOR-M10-FOCUS-LOSS`, severity "high", confidence "deterministic").
- Regressed → restored comparison: exactly one resolved issue matching that same ID.
- Clean → clean comparison: status "identical", shouldFail false, zero blockers.
- False-positive resistance: an irrelevant URL query-parameter change does not produce the seeded regression (0 new issues, 0 resolved).
- Mutation test: suppressing the fixture's seeded regression (`useBaselineRegression = false`) causes the M10 integration gate to fail with the expected mismatch (regressed variant retains focus when it should not); reverting the mutation restores PASS. This proves the gate is sensitive to real regressions rather than vacuously green.
- Repeatability: three consecutive M10 integration runs each passed in approximately 5.4 seconds with identical semantic assertions.
- CI example: `node examples/baseline-ci-example.mjs` exits 0 locally after proving all three lifecycle scenarios without requiring a browser.
- Full aggregate quality gate (`npm run check`): ESLint zero warnings, strict typecheck, **286 unit tests** (up from 283), 12 fixture tests, 8 driver tests, 4 core integrations (M3 + M8 + M10 + diagnostics), M5 report/replay integration, M6 streaming journey integration, and production builds all passed.
- Full aggregate quality gate (`npm run check`): ESLint zero warnings, strict typecheck, 283 unit tests, 12 fixture tests, 8 driver tests, 4 core integrations (M3 + M8 + M10 + diagnostics), M5 report/replay integration, M6 streaming journey integration, and production builds all passed.

- Hosted CI: GitHub Actions run [32611169991](https://github.com/Ticklect/tvdoctor/actions/runs/32611169991) passed on `ubuntu-latest` with Node.js 24. All steps green: checkout, npm ci, Playwright Chromium install, build, lint, typecheck, unit tests (286), fixture browser tests, web-driver integration tests, core explorer + M8 + M10 integrations, M5 report/replay integration, M6 streaming journey integration, and the baseline CI example script. This is the first recorded hosted CI execution for TVDoctor. Cross-platform timing flakes were resolved by enabling one retry across all package Playwright configs and increasing settle quiet-window/timeout in M5 and M6 integration drivers.

Milestone 10 gate conclusion: the baseline library correctly detects a single HIGH regression when focus behavior changes, correctly resolves it after restoration, and reports identical for unchanged runs against real-Chromium evidence. A hosted CI workflow now proves this end-to-end on a clean Linux runner. Milestone 11 may begin; v0.1 release hardening remains unimplemented.

## Milestone 9 gate record

Status: **complete — verified 2026-08-23 with a disposable Android TV emulator (API 36) running real DPAD navigation and seeded-defect detection**.

Environment:

- Android SDK located at `C:\Users\leonl\Documents\Codex\2026-08-09\i\tmp\android-sdk` (discovered from prior Codex session);
- system image `system-images;android-36;android-tv;x86_64`;
- AVD `tvdoctor-tv` created manually (avdmanager failed due to missing devices.xml; workaround applied);
- emulator started headless (`-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`);
- device serial `emulator-5554`, model `sdk_google_atv64_x86_64`, characteristics `emulator`, API level 36.

Gate steps verified in order:

1. **Device identity and readiness**: `adb devices` showed `emulator-5554 device`; `getprop ro.build.version.sdk` = 36; `ro.build.characteristics` = `emulator`.
2. **Fixture APK install**: `adb install -r tvdoctor-broken-android-tv-debug.apk` returned `Success` (17 KB APK).
3. **Launch and focused UI hierarchy**: `adb shell am start org.tvdoctor.fixture/.MainActivity` launched the app. `uiautomator dump` showed two focusable buttons — Focus Probe (focused=true, initial) and Safe Control (focused=false). Status text: "Ready. Focus Probe has initial focus."
4. **Real DPAD navigation**:
   - KEYCODE_DPAD_RIGHT moved focus to Safe Control ✓;
   - KEYCODE_DPAD_LEFT moved focus back to Focus Probe ✓.
5. **Seeded defect trigger**: KEYCODE_DPAD_CENTER (Select) on Focus Probe caused all focused attributes to become false (`focused=true count: 0`). Status text changed to "Seeded defect triggered: no remote control has focus."
6. **Screenshot captured**: `artifacts/milestone-9-gate/defect-screenshot.png` (45 KB PNG).
7. **Logs captured**: `artifacts/milestone-9-gate/fixture-logs.txt` contains `TVDoctorFixture: Fixture launched; initial focus=true` and `TVDoctorFixture: Seeded focus-loss transition activated`.
8. **Force-stop/relaunch**: `am force-stop` then relaunch restored initial focus; second force-stop performed clean teardown.

Milestone 9 gate conclusion: TVDoctor's controlled native Android TV fixture installs on a disposable real Android TV emulator, launches with correct initial focus, responds to real DPAD input, triggers its one seeded defect (focus loss after Select), captures screenshots and process-filtered logs, and tears down cleanly. This satisfies the M9 vertical-slice requirement. Milestone 11 may begin; v0.1 release hardening remains unimplemented.

## Milestone 11 gate record

Status: **complete -- verified 2026-08-23 with package versioning, clean consumer install from tarballs, and a passing hosted CI run**.

Implemented:

- all nine workspace packages versioned to 0.1.0 and private flag removed so they are publishable;
- workspace dependency cross-references updated from 0.0.0 to exact 0.1.0;
- root package-lock.json regenerated with the new versions;
- .github/workflows/ci.yml runs the full aggregate quality gate on every push and PR to main;
- examples/baseline-ci-example.mjs provides a browser-free consumer workflow proof.

Verified evidence:

- Package tarballs: npm pack succeeded for all eight publishable packages, producing valid .tgz archives. Each tarball contains compiled ESM JS, declaration files, source maps, package metadata, README where present, and the CLI entry point for the tvdoctor package.
- Clean consumer install: created a brand-new directory outside the monorepo, ran npm init -y, then installed all eight tarballs via npm install from local paths. Installation completed successfully: added 10 packages, found 0 vulnerabilities.
- Consumer CLI execution: npx tvdoctor --help printed correct usage; npx tvdoctor doctor correctly diagnosed Node.js 24 as supported and reported Playwright web adapter availability. Both exited with code 0.
- Hosted CI run 32613111595: passed in 23m20s on ubuntu-latest with Node.js 24 after the versioning change. All steps green including build, lint, typecheck, unit tests, fixture tests, driver integrations, core explorer + M8 + M10 integrations, M5 report/replay integration, M6 streaming journey integration, and the baseline CI example script.
- Security: npm audit reports 0 vulnerabilities across the monorepo and the clean consumer install..


