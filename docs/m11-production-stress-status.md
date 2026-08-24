# M11 production stress status

Status: **M6 RELIABILITY REVALIDATED LOCALLY; EXACT-CANDIDATE HOSTED PROOF
CONTROLS FINAL CLOSURE**. This is the controlling record for the reopened
real-world stress phase and the M6 first-attempt reliability closure. The
annotated `m11-m6-reliability-proof` tag must point at the exact release
candidate and record its successful hosted run. The older
`m11-production-stress-proof` tag is historical and is not final M6 proof.

## Required lifecycle

Every meaningful finding must retain all six links:

`DISCOVERY -> ROOT CAUSE -> FIX/LIMITATION -> REGRESSION TEST -> PRODUCTION RETEST -> FULL GATE`

Classifications are restricted to:

- `TVDOCTOR DEFECT`
- `WEBSITE BEHAVIOUR`
- `AUTOMATION/BOT RESTRICTION`
- `NETWORK/ENVIRONMENT`
- `KNOWN TVDOCTOR LIMITATION`
- `UNKNOWN`

A classification without a captured observation is invalid. Absence of actions,
absence of findings, or ability to load a page is never sufficient evidence for
bot restriction or a clean result.

## Current findings and lifecycle state

| ID | Finding | Root cause | Resolution | Regression | Production retest | Full gate |
| --- | --- | --- | --- | --- | --- | --- |
| M11-F001 | Explicit stable-snapshot settings were rejected by the CLI audit path | Options were passed to `pressAndObserve` in an order that made required snapshots appear as driver-strategy overrides | Corrected option construction in the CLI | Core explorer-hardening regression passes | Included in Movy rerun | Passed |
| M11-F002 | Large production evidence failed with `Evidence JSON exceeds the node limit` | A 200-node UI excerpt can expand beyond the reporters' global 10,000 JSON-node budget because each UI node has many nested fields | Bounded the retained excerpt to 150 nodes while preserving focused and visible context | Large-DOM evidence sanitation/write regression passes | Movy: failures changed from 1 to 0 | Passed |
| M11-F003 | Continuously mutating pages consumed the full settle timeout despite unchanged canonical structure | Settling had no distinction between pre-existing ambient churn and action-caused transitions | Added bounded ambient-churn escape; exact fingerprints/replay remain fail-closed correctness gates | Driver dynamic-rail and core exploration regressions pass | Production matrix completed | Passed |
| M11-F004 | Large-DOM throughput was previously attributed to snapshot analysis | Profiling showed browser semantic analysis was ~15 ms; Playwright transfer dominated at ~77-80 ms; settling/reset dominated action cycles | No speculative traversal rewrite. Added component profiling and deterministic fixture | Large-DOM driver test passes | Wikipedia 1 -> 26 actions; MDN 0 -> 12 actions | Passed |
| M11-F005 | Same-origin iframe descendants were invisible to observation and focus identity | Observation only visited the main-frame body and did not resolve nested active elements across accessible frame boundaries | Recursed into accessible same-origin frames, marked boundary metadata, and resolved nested active focus | Same-origin traversal, observation, report bundle, and replay integration passes | YouTube exposed a second frame-observation defect; rerun completed | Passed |
| M11-F006 | Consent walls could be encountered but were not explicitly diagnosed | Navigation rules had modal traps/focus leaks but no conservative root consent-wall rule | Added rule requiring a visible modal, exact focused descendant, and explicit consent/cookie semantics | Positive/negative unit plus local consent integration pass | YouTube reports `remote.consent-wall` deterministically | Passed |
| M11-F007 | A nonstandard production DOM shape could crash page observation | Frame recursion assumed every traversable child exposed normal element metadata | Added type/attribute guards before semantic extraction | Driver iframe/large-DOM gates pass; YouTube diagnostic succeeds | YouTube final audit completed validly | Passed |
| M11-F008 | An available but uncompilable empty reproduction aborted the whole report build | Root screen-analysis findings had no transition, but report validation requires an embedded replay for every available reproduction | Consent-wall findings now explicitly record reproduction unavailable with reason | Consent unit asserts unavailable reproduction | YouTube final audit produced a complete six-file bundle | Passed |

Cross-origin iframe internals remain inaccessible to browser code by design.
Current degradation is a boundary node marked cross-origin rather than an
exception; this will be tested explicitly before it is accepted as a limitation.

## Measured local pipeline evidence

Benchmark command:

```sh
node examples/profile-snapshot-pipeline.mjs <url> <output-directory>
```

### Deterministic mixed DOM fixture

Fixture: `large-dom.html`; 9,011 DOM elements, 604 retained semantic UI nodes.

| Measurement | Before observer cache | After observer cache |
| --- | ---: | ---: |
| Cold capture | 112.004 ms | 122.686 ms |
| Warm average capture | 94.013 ms | 96.829 ms |
| Browser evaluation average | 15.860 ms | 15.640 ms |
| Semantic-analysis average | 15.500 ms | 15.300 ms |
| Transport/sanitisation average | 1.324 ms | 1.247 ms |
| Playwright round-trip/queueing average | 76.813 ms | 79.924 ms |
| Driver snapshot average | 87.825 ms | 89.828 ms |
| Fingerprint average | 0.843 ms | 0.868 ms |
| Snapshot JSON serialisation | 0.555 ms | 0.549 ms |

Conclusion: the large-DOM snapshot itself was already sub-100 ms locally. The
observer layout-cache change did not materially improve total time because
Playwright transfer dominates. No further blind traversal optimisation is
justified from this evidence.

### Dynamic rail fixture

Fixture: continuously replaced navigation rail with stable IDs and remote
navigation.

| Measurement | Before ambient-churn handling | After |
| --- | ---: | ---: |
| Launch/settle | 4,261.572 ms | 214.757 ms |
| Reset/reload/settle | 4,042.941 ms | 54.123 ms |
| RIGHT press/settle | 4,014.757 ms | 262.851 ms |
| Driver snapshot average | 4.094 ms | 3.282 ms |
| Semantic-analysis average | 0.240 ms | 0.180 ms |

The escape is an explicit driver opt-in (`ambientChurnEscape: true`) and fires
only when at least four mutations already occurred within 250 ms before input.
Production audits enable it; conservative M8 benchmark exploration does not.
Canonical fingerprint stability and reset/replay still gate exploration
correctness.

## Direct zero-action probes

Captured with `examples/diagnose-web-target.mjs`. These are single-load,
evidence-gathering probes, not bot-evasion attempts and not authenticated runs.

| Target | Loaded | DOM elements | Visible focusable | Initial focus | Modal observed | Consent language | Errors/network | Evidence-backed classification |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| Pluto TV home | Yes | 950 | 84 | None | No | No | 4 React page errors; 184 requests, 0 failed | UNKNOWN - page errors and absent initial focus explain lack of safe discrete navigation, but do not prove bot restriction |
| Channel 4 home | Yes | 101 | 1 skip link | None | No | No | Analytics XHR certificate failure; 90 requests, 1 failed; one hidden same-origin iframe | UNKNOWN - sparse visible surface and network/environment failure are proven; bot restriction is not |
| Plex Watch | Yes | 7,418 | 52 | None; RIGHT reached vendors link | No | Text only | Google sign-in network error; 219 requests, 0 failed; settle timeout; tree truncated at 750 | UNKNOWN - consent language exists, but no modal boundary was observed; large/changing DOM and unstable settle are proven |

The prior blanket statements of bot restriction or known limitation are withdrawn.

## Final production comparison

The first "after" column is the post-fix rerun. ITVX has no report directory
because launch failed; its metric comes from the CLI navigation error.

| Target | Mode | Before actions/states | After actions/states | After elapsed | After avg cycle | After snapshots (estimated) | Timeouts/budgets | Evidence failures | Valid bundle |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| BBC iPlayer | quick | 3/1 | 18/1 | 25.928 s | 1,440 ms | 49 | none exhausted | 0 | Yes |
| YouTube | quick | 6/1 | 16/1 | 44.346 s | 2,772 ms | 36 | none exhausted | 0 | Yes |
| Channel 4 | quick | 0/1 | 38/2 | 32.273 s | 849 ms | 59 | none exhausted | 0 | Yes |
| Pluto TV | quick | 0/1 | 68/1 | 101.754 s | 1,496 ms | 51 | duration | 0 | Yes |
| Plex Watch | quick | 0/1 | 112/1 | 96.953 s | 866 ms | 59 | duration | 0 | Yes |
| ITVX Watch | quick | launch failure/0 | launch failure/0 | not applicable | not applicable | 0 | launch failure | not applicable | No - launch failed |
| Movy | standard | 18/1 | 18/1 | 21.862 s | 1,215 ms | 49 | none exhausted | 0 | Yes |
| Wikipedia Main Page | quick | 1/1 | 26/1 | 23.114 s | 889 ms | 57 | none exhausted | 0 | Yes |
| MDN home | quick | 0/1 | 12/1 | 14.819 s | 1,235 ms | 31 | none exhausted | 0 | Yes |

Chromium leak check after all browser audits/probes:
`PlaywrightChromiumProcesses=0`.

## Evidence-backed final classifications

| Target | Classification | Evidence |
| --- | --- | --- |
| BBC iPlayer | `WEBSITE BEHAVIOUR` + `KNOWN TVDOCTOR LIMITATION` | Probe captured cookie controls (`bbccookies-accept-button`, reject) but no modal boundary and no initial focus; TVDoctor safely avoided ambiguous SELECT. Non-modal consent handling remains a limitation. |
| YouTube | `WEBSITE BEHAVIOUR` + `NETWORK/ENVIRONMENT` | Probe captured focused dialog `Before you continue to YouTube`, accept/reject controls, Google 401, media 403s, feedback 400. Audit reports four console-error issues plus deterministic `remote.consent-wall`. |
| Channel 4 | `UNKNOWN` | Probe found only one visible focusable skip link, no initial focus, no modal, one hidden same-origin iframe, and an analytics certificate failure. Sparse surface is proven; bot restriction is not. |
| Pluto TV | `WEBSITE BEHAVIOUR` + `NETWORK/ENVIRONMENT` | Probe found 84 visible focusables, no initial focus, no modal, and four React page errors. Audit sent 68 inputs without a new canonical state. Bot restriction is unsupported. |
| Plex Watch | `KNOWN TVDOCTOR LIMITATION` + `NETWORK/ENVIRONMENT` | Probe found 7,418 DOM nodes, 750-node truncation, consent text without modal boundary, Google sign-in error, and unstable settle. Audit hit duration after 112 inputs. |
| ITVX | `NETWORK/ENVIRONMENT` | Repeated Chromium launches fail before observation with `net::ERR_HTTP2_PROTOCOL_ERROR`. |
| Movy | `NETWORK/ENVIRONMENT` | Probe captured script failures `ERR_BLOCKED_BY_ORB` and `ERR_NAME_NOT_RESOLVED`; app surface otherwise loads. Evidence defect is fixed separately. |
| Wikipedia Main Page | `KNOWN TVDOCTOR LIMITATION` + `WEBSITE BEHAVIOUR` | Probe found 2,366 elements, 228 visible focusables, no initial focus, and truncation at the 750-node semantic bound. Snapshot profiling shows analysis itself is fast. |
| MDN home | `WEBSITE BEHAVIOUR` | Probe found 83 visible focusables but no initial focus and no discrete RIGHT response; no network/page errors or modal boundary. |

## Movy evidence-capture retest

Command used standard mode with search query `N`.

Before fix:

- run duration 38.0 seconds
- 18 actions
- 1 screen/focus state
- 1 issue
- 1 evidence failure (`Evidence JSON exceeds the node limit`)
- HTML report missing when opened directly

After fix:

- run duration 37.405 seconds
- 18 actions
- 1 screen/focus state
- 6 transitions
- 1 issue (`crash.console-error`, deterministic)
- 0 evidence failures
- all eight issue slots present in report metadata; screenshots, console log,
  transition, navigation path, and 150-node-bounded UI excerpt available
- replay correctly unavailable because startup log reproduction was not proven

Classification: `NETWORK/ENVIRONMENT` or website behaviour for the unresolved
resource remains to be chosen from the captured URL/request evidence. The
TVDoctor evidence-capture fault itself is fixed and verified.

## Regression coverage added so far

- explicit stable-snapshot bounds no longer conflict with driver defaults;
- root consent-wall positive and generic-modal negative diagnostics;
- deterministic consent wall integration;
- continuously replaced rail remains bounded/compressible;
- 9,011-element mixed DOM retains expected semantic count and focus;
- ambient mutation churn does not wait a full settle timeout;
- clocks, rotating banners, autoplay UI, raw DOM noise, and lazy-load
  fail-closed behavior are covered by deterministic fixtures;
- same-origin iframe boundary, nested controls, and nested focus observation;
- same-origin traversal out of the frame, report bundle evidence, and replay;
- cross-origin boundary degradation without an exception;
- existing full suite and aggregate release gate must pass before closure.

## M6 first-attempt reliability closure

### Root cause

The remaining M6 retry was a **test/evidence-association invariant defect**, not
a streaming-pack product race and not unexplained environment variance.

Three completed retry-disabled reproductions all failed at the same assertion.
Discovery generated progress evidence `582 -> 592`, while a separate fresh
Chromium evidence capture generated `583 -> 593`. Both observations proved the
same seeded defect: selecting `player-rewind` with `SELECT` advanced playback by
exactly ten seconds. The independently launched player can advance one second
before the test establishes its paused precondition, so its absolute clock base
is intentionally volatile. The fixture contract and pack classification require
the action, target, expected direction, observed direction, and delta; neither
requires independent launches to share an absolute player-clock base.

The player-control issue remains unavailable to portable Replay V1 because that
format cannot assert numeric media state. The second observation here is the
fresh evidence-capture launch used to build the report bundle, not a claim that
Replay V1 gained a new capability.

### Fix and evidence ownership

The M6 acceptance layer now normalises both observations as structured progress
evidence containing:

- operation (`seek-backward`);
- dispatched action (`SELECT`);
- semantic target (`player-rewind`);
- expected direction (`decrease`);
- observed direction (`increase`);
- before, after, and exact delta (`+10`).

Semantic comparison excludes only the independent absolute clock bases. It
still requires identical operation, action, target, expected direction,
observed direction, and magnitude. It rejects non-finite values, unknown seek
operations, missing or duplicate progress nodes/evidence, a changed progress
node identity, malformed transition evidence, and any non-applied action.

Discovery-time progress prose now links to `navigation-path.json`, whose pack
proof contains the discovery stage and values. Fresh-capture progress links to
`ui-excerpt.json`, which contains the raw snapshots plus the normalised semantic
payload. Report evidence therefore no longer attributes discovery clock values
to an independent capture with a different base. The configured Playwright
retry remains unchanged as infrastructure protection.

### Deterministic regression coverage

`progress-evidence.spec.ts` proves that discovery `583 -> 593` and fresh capture
`582 -> 592` are equivalent inverted-rewind evidence. Negative cases reject:

- `+10` versus `-10` (different observed direction);
- `+10` versus `+3` (different contractual magnitude);
- `SELECT` versus another action;
- `player-rewind` versus another target;
- non-finite values, blank action/target, inconsistent expected direction, and
  an unknown seek operation.

The full M6 integration additionally validates the exact transition artifact,
correlated progress-node identity, structured payload, human-readable summary,
artifact ownership, hashes, report schema, and report/replay cross-links.

### Retry-disabled reliability campaign

Command shape for every run:

```sh
npm run test:integration --workspace @tvdoctor/pack-streaming -- --retries=0 --output=artifacts/m6-semantic-final/run-NN/test-results
```

Twenty consecutive normal runs passed. Each run rebuilt the packages/fixture,
started fresh browser processes through the full M6 test, used no retry, and had
its log plus complete report/evidence tree preserved under the ignored local
`artifacts/m6-semantic-final` campaign directory.

| Run | Log span (s) | Result |
| ---: | ---: | --- |
| 01 | 397.198 | pass |
| 02 | 398.457 | pass |
| 03 | 399.286 | pass |
| 04 | 398.954 | pass |
| 05 | 399.207 | pass |
| 06 | 400.308 | pass |
| 07 | 398.949 | pass |
| 08 | 398.892 | pass |
| 09 | 398.107 | pass |
| 10 | 399.086 | pass |
| 11 | 398.780 | pass |
| 12 | 397.662 | pass |
| 13 | 397.568 | pass |
| 14 | 398.454 | pass |
| 15 | 397.758 | pass |
| 16 | 397.554 | pass |
| 17 | 397.474 | pass |
| 18 | 397.889 | pass |
| 19 | 397.981 | pass |
| 20 | 398.067 | pass |

Normal-run summary:

- runs: 20;
- first-attempt passes: 20;
- failures: 0;
- pass rate: 100%;
- retries: 0;
- flaky markers: 0;
- duration range: 397.198-400.308 seconds;
- mean duration: 398.382 seconds;
- anomalies: none.

One additional full run under controlled two-worker CPU contention passed in a
401.712-second log span, again with retries disabled and no anomaly. Combined
local M6 evidence is therefore 21/21 first-attempt passes. The normal campaign
happened to observe `582 -> 592` in both launches; real shifted-base behaviour
is independently established by the three preserved pre-fix traces and the
deterministic `583 -> 593` versus `582 -> 592` regression.

## Hosted closure proof attempts

The first hosted candidate (`c56fddc737e3fb0c1648edd9df9414f92219a31e`, run
`32651986082`) failed the web-driver gate because a live player timer advanced
the fixture progress from 582 to 583 before an exact assertion. Both configured
attempts failed identically. The assertion was made deterministic by pausing
playback first and bounding the accepted timer value.

The second hosted candidate (`0f861ab7f7f4f1fa2f05d24fc6d1e31734c0d38d`, run
`32652469483`) exposed a real ambient-churn defect: its default early return
could skip a meaningful finite transition and cause M8 noncompletion/divergence.
The escape is therefore now an explicit driver opt-in. Production audits enable
it; conservative M8 exploration does not. Local M8 passed after the fix.

The first attempt of the next hosted run (`32654344513`) was externally
cancelled while M6 was still running with no test failure. Its retry reached
M6 and was cancelled again at exactly the workflow's configured 30-minute job
ceiling. The aggregate gate now allows 60 minutes.

The next candidate (`31f96fbdfa89657050c79e00b6ebd08a979600b6`, run
`32657831262`) reached M6 on its first attempt, used the configured Playwright
retry, and both attempts exhausted the streaming pack's inherited 180-second
duration budget on the slower hosted runner. The M6 integration now retains the
same discovery envelope but explicitly allows 300 seconds for two real-browser
journeys; local M6 passes in about seven minutes.

## Historical aggregate M11 release gate

The first full-gate attempt failed only the long M6 streaming showcase twice
during sustained local load (`A semantic SELECT checkpoint drifted`). The same
M6 gate passed in isolation after those attempts. An immediate unchanged rerun
of the complete aggregate gate then passed end to end:

- lint: zero warnings;
- strict typecheck: all workspace projects;
- unit tests: 21 files / 290 tests;
- fixture browser tests: 12 tests;
- web-driver integration tests: 12 tests;
- core integrations: 10 tests, including M3/M8/M10 and all new stress gates;
- reporter integration: one long-form report/replay showcase;
- streaming integration: one semantic journey/report/replay showcase;
- package and fixture builds: passed.

This closed the earlier production-stress phase at that commit, but it does not
serve as final proof for the later M6 first-attempt reliability closure. The
final clean aggregate gate and hosted run must use the exact candidate recorded
by `m11-m6-reliability-proof`. No result promotes any surface beyond its current
support level.
