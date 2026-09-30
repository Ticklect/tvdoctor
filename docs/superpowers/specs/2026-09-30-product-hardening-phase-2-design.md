# TVDoctor Product Hardening Phase 2 Design

## Goal

Turn the current locally proven TVDoctor CLI into a more complete developer
product without replacing its existing core architecture. The product should be
easy to understand on first run, produce reports that communicate navigation
failures quickly, support meaningful regression workflows in CI, make its
privacy and trust boundaries explicit, and be rehearsable as a Windows release
without claiming platform compatibility that has not been proven on real
hardware.

This phase builds on the product-overhaul work already present in the working
tree. It does not restart the codebase, replace the canonical report model, or
discard existing local changes.

## User and success criteria

The primary user remains a TV application developer or QA engineer testing a
web or Android TV application with a remote-control navigation model. A good
run should answer four questions quickly:

1. Did the requested scan complete enough coverage to be trusted?
2. What navigation behavior failed or changed?
3. How can the failure be reproduced or inspected?
4. Did this run regress relative to a reviewed baseline?

Success for this phase means:

- the existing deterministic demo and doctor flows remain correct and become
  easier to understand rather than being replaced;
- HTML reports expose verdict, coverage, evidence, navigation topology, and a
  concise reproduction timeline before low-level inventories;
- navigation diagnostics add only evidence-backed classifications and keep
  unobservable conditions explicitly untested or review-only;
- the navigation graph can expose shortest known remote paths and useful
  explored/unexplored coverage information without pretending an incomplete
  graph is exhaustive;
- baseline comparison becomes a practical scan-and-compare workflow with clear
  regression/resolution summaries;
- GitHub CI produces concise review output and complete artifacts, while any PR
  comment write requires explicit workflow permission and supplied credentials;
- browser video evidence is opt-in, bounded, local, and clearly marked as
  potentially sensitive;
- privacy/security behavior is documented and covered by adversarial tests;
- the Windows release bundle has stronger prerequisite, install, launcher,
  uninstall, and rehearsal coverage without requiring a new installer framework
  or a signing certificate that is not available;
- physical-device tooling records exact device/firmware evidence but does not
  manufacture compatibility claims when hardware is absent;
- the upstream `origin/main` cleanup commit is reconciled without discarding the
  current dirty-tree work, and all relevant validation is rerun afterward;
- no npm publish, GitHub release, push, or public compatibility claim occurs as
  part of this phase.

## Existing foundations to preserve

The current tree already contains substantial work that this design extends:

- deterministic `tvdoctor demo` with packaged Northstar fixture and portable
  saved replay;
- surface-aware `tvdoctor doctor` with Web and Android TV readiness;
- findings-first HTML reports with before/after screenshots, actionability
  classes, expected/observed transition evidence, and replay commands;
- a stable navigation/focus graph with problem annotations;
- existing navigation diagnostic rules for lost focus, self-loop, unreachable
  target, focus trap, overlay focus leak, broken Back behavior, and unexpected
  jumps;
- semantic baseline creation/comparison for issues, screens, focus targets,
  transitions, and latency;
- GitHub Action summary/JUnit/report artifact support;
- local-first report sanitisation and bounded artifact storage;
- guarded Windows install/uninstall scripts and package/release smoke tooling;
- physical-device proof tooling that intentionally refuses to treat emulator
  results as physical-hardware compatibility evidence.

These are compatibility boundaries, not temporary prototypes.

## Architecture

### 1. Git reconciliation and recovery boundary

Before feature implementation, preserve the exact current local state in a
recoverable form. The working tree is intentionally large and includes local
changes that must not be reset, including the tracked deletion of
`packaging/windows/app-package.json` and the unrelated
`brag-output-2026-09-19-145314/` directory.

The repository is one commit behind `origin/main` at `a4c5716 cleanup`. That
commit overlaps several locally modified documentation/release files and also
changes `packages/core/src/explorer-runtime.ts`.

The integration strategy is non-destructive:

- record the current `HEAD`, `origin/main`, status, and local diff metadata;
- create a recoverable repository-local patch/bundle or equivalent snapshot that
  does not delete or move user files;
- reconcile `a4c5716` carefully rather than using `reset --hard`, blind pull, or
  an automatic destructive rebase;
- resolve overlaps by preserving the currently validated product behavior while
  incorporating upstream maintenance changes that do not contradict it;
- rerun focused and broad gates before beginning product feature work;
- do not push the reconciliation.

### 2. Report and evidence experience

The canonical `tvdoctor.report/v1` model remains the source of truth. This phase
preferentially derives richer presentation from existing report, navigation
graph, baseline inventory, replay, and artifact data instead of adding protocol
fields.

The HTML report gains a stronger decision-first layout:

- verdict, run completeness, navigation coverage, and actionability counts;
- one clearly stated next action;
- navigation map/graph section sourced from the generated graph artifact;
- per-finding "Expected", "Observed", "Why this matters", and "Reproduce"
  presentation;
- a compact input/reproduction timeline using the stored remote sequence and
  transition assertion;
- existing before/after screenshots presented adjacent to the transition when
  available;
- links to replay, navigation graph, and supporting artifacts;
- low-level run/environment/artifact inventories kept behind expandable detail.

"Why this matters" is derived conservatively from the diagnostic rule and
severity. It must not invent product intent or make unsupported accessibility or
hardware claims.

The renderer must continue to escape/sanitise every target-controlled value and
must not introduce external scripts, active remote content, or network calls in
generated reports.

### 3. Navigation analysis expansion

New diagnostics must stay fixture-independent and operate on observed graph,
geometry, focus state, and platform evidence. They may be deterministic only
when the required local evidence is complete enough to prove the condition.

The target diagnostic additions are:

- **directional asymmetry**: a proven directional edge exists in one direction
  but the observed reverse relation is absent or inconsistent under locally
  complete evidence;
- **focus disappearance / escape refinement**: distinguish focus becoming
  missing from focus leaving the expected local surface where evidence supports
  the difference;
- **hidden or off-screen focused target**: only when bounds/viewport or platform
  visibility observations make the condition directly observable;
- **stale focus after screen/route change**: a structural screen transition
  occurs but focus remains correlated to an invalid or no-longer-present target;
- **cycle/path analysis**: expose repeated directional cycles and shortest known
  D-pad paths as graph analysis; issue creation occurs only when the cycle meets
  a clear defect rule rather than treating every loop as a bug.

The implementation should reuse existing navigation diagnostic contracts and
semantic issue IDs where possible. If a new diagnostic rule is added, it must be
version-stable, tested against both positive and negative graphs, and mapped into
the navigation focus graph problem vocabulary. Because
`tvdoctor.navigation-focus-graph/v1` currently exposes a closed problem-kind
union, any serialized expansion of that union or graph shape is emitted under a
new graph artifact version rather than silently widening v1. Canonical
`tvdoctor.report/v1` remains unchanged.

### 4. Shortest paths and coverage model

The navigation focus graph gains derived analysis helpers rather than changing
the explorer's core state model.

For each observed focus target, TVDoctor may expose the shortest known
root-relative remote sequence from the exploration graph. "Shortest" means
shortest among verified observed graph paths, not guaranteed globally optimal
over unobserved UI state.

Coverage presentation distinguishes:

- observed screens/focus targets/transitions;
- locally complete states where all configured eligible navigation actions were
  attempted;
- states or frontiers left unexpanded because of budget, safety, capability, or
  exploration termination;
- graph-wide completion/partial status.

An "unexplored" count or list must never imply that the tool knows all possible
application states. It means known queued/deferred or incompletely expanded
frontiers from this run.

### 5. Regression workflow

The existing `@tvdoctor/baseline` package remains the only semantic comparison
engine. No parallel regression format is introduced.

The CLI gains a higher-level workflow that can run a navigation audit and compare
it with a reviewed baseline in one invocation, while continuing to support the
existing explicit `baseline create` and `baseline compare` commands. The public
shape is `tvdoctor scan URL --baseline PATH`; source checkouts use the equivalent
`npm run tvdoctor -- scan URL --baseline PATH`. The flag is optional and does not
change ordinary `scan` behavior when absent.

The combined workflow should:

- run the normal bounded audit;
- fail closed if the current run/inventory is incomplete;
- compare only when target identity and observability remain compatible;
- print introduced/resolved findings, removed/added focus targets, directional
  transition changes, and latency regressions;
- write the normal report bundle plus comparison JSON/Markdown;
- preserve baseline files as immutable operator inputs unless the user
  explicitly runs baseline creation/replacement.

Comparison renderers should surface path/transition changes compactly enough to
use directly in CI review.

### 6. GitHub CI and PR review

The current composite action continues to run locally in the repository checkout
and upload the report artifact. It is extended to surface baseline comparison
output when a baseline is supplied.

Read-only/default behavior:

- write the GitHub job summary;
- expose report, JUnit, summary, and comparison artifact paths;
- upload the complete local report bundle;
- return the existing fail-closed exit result.

Optional PR comment behavior is explicitly opt-in. It requires a dedicated
action input plus GitHub token/permission supplied by the caller. Without that
input, TVDoctor performs no repository write. The comment is bounded and points
to workflow artifacts rather than embedding sensitive report content.

The audit workflow must never execute untrusted pull-request code with a
write-capable token. Same-repository comments may use narrowly scoped
`pull-requests: write` after the read-only audit. If fork-PR commenting is added,
use a separate trusted `workflow_run`-style commenter that downloads and strictly
validates bounded machine data, then re-renders the comment from trusted base
code. Do not use `pull_request_target` to run the PR checkout.

No external SaaS, telemetry backend, or hosted TVDoctor service is introduced.

### 7. First-run and doctor polish

The existing CLI commands remain the contract. Improvements focus on concise,
stable output rather than animated dependencies:

- phase/status lines for setup, demo, scan, replay, and baseline comparison;
- final summaries with actions, states, transitions, finding counts, report
  location, and replay/comparison next action;
- doctor output presented as a compact Web / Android TV readiness matrix with
  the exact remediation below blockers;
- output remains usable without color and in non-interactive CI logs;
- target-controlled URLs/query/fragment data remain sanitised.

No spinner/progress dependency is required; simple deterministic terminal output
is preferred.

### 8. Privacy and security surface

Add a user-facing `tvdoctor privacy` command backed by static, version-controlled
product policy text. It explains:

- the product is local-first and does not upload reports by default;
- what can be captured: target URL origin/path, UI text, screenshots, logs,
  network metadata, device metadata, environment diagnostics, and optional video;
- what redaction attempts to remove;
- that redaction is defense in depth and artifacts must be reviewed before
  sharing;
- Android operations that can mutate a selected test device during an audit;
- where temporary/output data is written and what uninstall does not remove.

The implementation also closes concrete current privacy gaps:

- add a text-only / `--no-screenshots` mode so users can suppress persisted raw
  PNG evidence while retaining the minimum in-memory observations needed for a
  safe audit;
- stop writing the selected Android ADB serial into canonical public report
  target fields; replay/device selection remains an explicit local CLI input;
- document that ordinary redaction may retain URL path segments, and add
  `--target-redaction origin` for web scans. That mode stores origin-only target
  identity in public report outputs and forces an explicit replay target when the
  route cannot be reconstructed. It is a data-minimisation option, not a promise
  that the resulting bundle is automatically safe to share;
- expand sensitive-key and credential-URI detection to cover access/private-key,
  database URL, PAT/credential-style names, and non-HTTP URI userinfo;
- ensure privacy modes affect derived HTML/Markdown/JSON consistently rather
  than hiding a value in one renderer while retaining it in another artifact.

Security tests expand around URLs, credentials, headers, tokens, environment
keys, Windows/Unix paths, shell/ADB diagnostic strings, report HTML inertness,
artifact path confinement, and comparison rendering.

Raw subprocess diagnostics remain server/CLI-private unless explicitly converted
into a bounded safe user-facing error.

### 9. Opt-in browser video evidence

Video is useful but carries a higher privacy cost. It is therefore opt-in.

For web scans only, the CLI may expose a `--record-video` option using the
existing Playwright browser context recording support. The recording:

- stays under the trusted report output root;
- is bounded to the audit session;
- is exposed as safe sibling evidence and linked from the generated HTML/CLI
  output through renderer/orchestrator metadata rather than widening the closed
  `tvdoctor.report/v1` artifact-kind enum;
- is clearly marked as potentially containing sensitive target content;
- does not become required evidence for deterministic classification.

Regenerating HTML from canonical JSON alone may omit the optional video link;
the video remains a local sibling artifact. This is preferable to smuggling a
new video kind into report/v1 or mislabelling it as another artifact type.

Android video is out of scope unless a safe existing platform primitive can be
integrated without new device privileges. Unsupported platforms report video as
unavailable rather than simulating it.

### 10. Windows distribution hardening

Continue the existing ZIP-based Windows release bundle for this phase. Do not
introduce MSI/MSIX/NSIS solely for visual polish.

Improvements should include where safe:

- clearer Node/npm prerequisite diagnostics using the proven supported ranges;
- deterministic launcher placement and PATH/command discovery checks;
- refusal to overwrite a pre-existing `tvdoctor.cmd` that is not owned by the
  installation being updated;
- optional Start-menu shortcuts for TVDoctor documentation or uninstall, but
  only when the installer can create/remove exactly its own entries;
- recording the actual launcher/command directory in the install sentinel so
  uninstall does not depend on a later `npm prefix -g` value or on npm still
  being installed;
- install sentinel/ownership protection retained for every delete/replace path;
- post-install `--version`, `doctor`, and optional setup verification;
- uninstall of files/shortcuts created by the installer while leaving unrelated
  browser caches or user report bundles intact;
- smoke tests using isolated temp install roots and command directories.

Code signing remains a release prerequisite that needs an actual certificate and
cannot be fabricated locally. The release documentation should state this
clearly.

### 11. Release rehearsal

Add or strengthen a non-publishing rehearsal that exercises the same artifacts a
real release would use:

- package tarballs and Windows bundle build where a clean-tree requirement can be
  satisfied in an isolated/rehearsal context;
- clean consumer install;
- offline `npx --no-install`;
- global install/shim;
- `--help`, `--version`, `setup` help, `doctor`, `demo`, saved replay;
- baseline create/compare on the controlled fixture;
- Windows install, reinstall/upgrade-safe behavior where supported, uninstall;
- the full supported runtime matrix: Node 22.13+ with npm 10 and npm 11, plus
  Node 24 with npm 10 and npm 11;
- explicit `SKIPPED` status for real website or physical Android probes when no
  authorized target/hardware is configured.

The rehearsal never publishes packages or creates a GitHub Release.

### 12. Physical-device evidence

The current proof runner remains the trust boundary. Improvements focus on
making results easier to aggregate into a compatibility matrix:

- stable device/manufacturer/model/firmware/API fields;
- exact TVDoctor commit/version and tested app hash;
- proof date and run status;
- report/proof hashes;
- issue/action/screen/focus/transition counts;
- clear Android TV vs Fire TV classification.

If a real device is available and explicitly selected by the operator, the proof
runner may be exercised. If not, the final result must say physical proof was not
run. Emulator success cannot populate the physical compatibility matrix.

## Error handling and trust model

- Partial or failed scans remain non-clean.
- Missing graph evidence cannot become a deterministic navigation defect.
- Missing baseline comparability fails closed.
- Missing video support does not fail an otherwise valid scan unless video was
  explicitly requested and the recording setup itself cannot be honored.
- Generated HTML remains self-contained and inert under a restrictive CSP.
- Reports and comparison output never execute target-controlled markup.
- Installer/uninstaller operations must prove ownership before recursive removal.
- Optional GitHub write operations require explicit caller authorization.
- Signing, physical-hardware compatibility, and hosted-CI success are reported
  only when actually observed.

## Testing strategy

Every behavior change follows test-first development.

Focused tests cover:

- report rendering and escaping of new timeline/map/impact content;
- each new navigation rule with positive, negative, partial-coverage, and
  unobservable cases;
- shortest-known-path and exploration-frontier summaries;
- combined audit/baseline CLI orchestration and fail-closed comparison;
- CI summary/comparison rendering and opt-in PR-comment input validation;
- privacy command content and adversarial redaction cases;
- screenshot suppression, Android serial non-disclosure, strict origin-only
  sharing mode, and credential-URI redaction;
- video option validation, path confinement, artifact linkage, and no-video
  default behavior;
- Windows installer ownership, shortcut/launcher handling, reinstall/uninstall,
  changed npm-prefix/npm-absent uninstall, PATH resolution, launcher collision,
  and unsupported prerequisite failures;
- release rehearsal truthfulness, especially explicit skipped external probes;
- physical proof schema/matrix aggregation without emulator-to-physical
  promotion.

Broad verification after integration includes:

- lint;
- typecheck;
- unit tests;
- reporter and CLI focused suites;
- web-driver integration;
- presentation tests;
- device-proof tests;
- package smoke;
- Windows installer safety/release smoke;
- production build;
- controlled demo/replay and baseline comparison;
- `git diff --check`;
- independent read-only review for Critical/Important regressions.

## Constraints and non-goals

- Do not replace `tvdoctor.report/v1` or `tvdoctor.replay/v1` merely for richer
  presentation.
- Do not add a cloud service, telemetry, hosted AI dependency, or account system.
- Do not weaken fail-closed semantics to improve demo/CI appearance.
- Do not classify heuristic geometry as deterministic evidence.
- Do not make video recording default-on.
- Do not introduce a new Windows installer framework unless the existing guarded
  bundle demonstrably cannot meet a required behavior.
- Do not claim Windows code signing without a real signing identity.
- Do not claim physical Android/Google TV/Fire TV compatibility without recorded
  proof on named hardware/firmware.
- Do not publish npm packages, push Git commits, create a GitHub Release, or tag a
  release in this phase.
- Do not delete unrelated local files or reset the current working tree.

## Delivery order

Implementation is intentionally staged so high-risk foundations settle before
UI polish depends on them:

1. preserve/reconcile Git state and rerun existing gates;
2. expand navigation graph analysis and diagnostics;
3. upgrade report/evidence presentation;
4. extend baseline/regression CLI and GitHub CI surfaces;
5. add privacy/security surface and tests;
6. add opt-in browser video evidence;
7. harden Windows distribution and release rehearsal;
8. improve physical-device proof aggregation;
9. polish first-run/doctor output across the final behavior;
10. run complete validation and independent final review.
