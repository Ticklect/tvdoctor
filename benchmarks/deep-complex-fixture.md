# Deep complex-fixture restoration A/B

This benchmark drives the local Northstar TV fixture in **real Playwright
Chromium**. It is fixture/synthetic stress evidence, not a production-app
benchmark or physical-TV validation.

From the repository root, with Node 22.13+ or Node 24 and the matched Playwright
Chromium installed:

```powershell
npm run test:integration --workspace tvdoctor -- deep-complex-ab.integration.spec.ts --workers=1 --retries=0
```

The Playwright web server starts Northstar locally. The suite runs four variants:

1. `/?routeVariant=semantic-alternate` — multiple navigation routes, dialogs,
   profile picker and the fixture's normal seeded defects.
2. `/?routeVariant=semantic-alternate&carouselSize=240` — those paths plus 240
   individually identifiable carousel controls.
3. `/deep-profile-route.html` — a separate deterministic fixture that launches
   directly in the inert two-profile dialog, then opens browse, search, settings
   and title details. It checks that Deep actually activates both profile
   choices and enters Home, using DOWN/SELECT/BACK and separate 125-action,
   35-state, depth-8, 85-second matched budgets.
4. `/deep-profile-route.html?stressCards=8` — a **completable** finite variant
   with eight distinct catalogue items, inert profile picker, two-modal/routes
   and individually fingerprintable title-specific details (structural heading
   ID plus unique details-control IDs). It requires root-only and verified-local
   to exhaust the exploration queue, with **identical** screen/focus/action/
   transition/finding ID multisets and zero remaining frontier. Every carousel
   item must receive an applied SELECT leading to *its own* details focus ID.
   This variant uses 1,800 physical keys, 100 states, max depth 35, 220-second
   exploration deadline per mode, and DOWN/SELECT/BACK.

Each case starts a new browser session for `root-only` and `verified-local`,
using the **same budgets within its case**. The first two use the Deep profile,
six action keys, 140-physical-input cap,
85-state cap, depth 18 and 120-second monotonic exploration limit. Repetition
compression is disabled and safe root fallback remains available. The test-only
Northstar profile selector exception is on for both runs.

The test writes a `deep-complex-ab.json` file under its Playwright
`packages/cli/test-results/<test-name>/` directory. It includes exact screen
fingerprints, focus fingerprints, all observed action/transition identities,
finding IDs, added/missing identity sets, wall times, reset/replay counts,
unsupported actions, termination reasons and outstanding frontier. Its
`DEEP_COMPLEX_AB` console line gives a compact summary.
The full-frontier test instead writes `deep-complex-complete-8.json` under its
own test-results folder; preserved run evidence is named
`benchmarks/deep-complete-8-run*.json`. To run only the full-frontier case:

```powershell
npm run test:integration --workspace tvdoctor -- deep-complex-ab.integration.spec.ts --grep "finite multi-route carousel" --workers=1 --retries=0
```

**Interpretation:** Both approaches must count every physical input and retain
their partial frontier. If a run ends on an action/time/depth/state ceiling,
different numbers of explored branches are possible even with identical limits:
compare exact identities and explicitly name missing edges. Full graph parity is
asserted only if *both* runs really complete. A shorter run that discovers fewer
states or misses findings cannot be counted as a coverage improvement. The
240-item query supplies a large DOM, but the action budget does **not** imply
every carousel item was visited; use `stressFocusCount` in the JSON to see how
many were actually reached.

The smaller full-frontier case **does not** imply traversal of the separate
240-item Northstar fixture. A `queue-exhausted` result is scoped to the
selected finite fixture, supported action order and captured reachable states,
not every possible user journey or inaccessible app function. The title ID is
also present in stable control identifiers: relying only on heading text or
the labels of fixed-ID controls would let distinct detail pages collapse under
the current structural fingerprint, invalidating a stress coverage claim.

This local benchmark requires no external sites, accounts or purchase actions.
