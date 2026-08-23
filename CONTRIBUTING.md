# Contributing to TVDoctor

Thank you for helping make remote-first application testing more rigorous.
TVDoctor values small, evidence-backed changes over broad capability claims.

## Before opening work

- Search existing issues first.
- For a new platform driver or protocol change, open a design issue before a
  large implementation.
- Keep one pull request focused on one problem.
- Never include credentials, customer data, private APKs, proprietary media, or
  unredacted reports.
- A fixture defect is not a product fix. Deliberately broken behaviour must stay
  isolated, documented in the fixture manifest, and asserted by tests.

## Development setup

The declared environment is Node.js 24 and npm 11.

```sh
npm ci
npx playwright install chromium
npm run check
```

`npm run check` is the repository's aggregate foundation gate. While the v0.1
workspace wiring is being completed, contributors touching newer packages must
also run their package gates explicitly:

```sh
npm run typecheck --workspace @tvdoctor/pack-web
npm test --workspace @tvdoctor/pack-web
npm run lint --workspace @tvdoctor/pack-web

npm run typecheck --workspace @tvdoctor/baseline
npm test --workspace @tvdoctor/baseline
npm run lint --workspace @tvdoctor/baseline

npm run typecheck --workspace @tvdoctor/driver-android
npm test --workspace @tvdoctor/driver-android
npm run lint --workspace @tvdoctor/driver-android
```

Run the real-browser gates relevant to web exploration, reporting, or semantic
packs:

```sh
npm run test:core-integration
npm run test:report-integration
npm run test:streaming-integration
```

These gates take longer and write ignored files under `artifacts/`.

## Change requirements

### Core and diagnostics

- Preserve platform neutrality: no DOM selectors, Android resource IDs, fixture
  routes, or operating-system commands in core logic.
- Bound actions, states, depth, duration, tree size, logs, and generated output.
- Make ordering deterministic and prove repeated runs match.
- Treat missing or ambiguous observability as unavailable, partial, or
  inconclusive—never as a pass.
- Require exact semantic evidence before labelling a finding deterministic.

### Drivers

- Implement the public `TVDoctorDriver` contract rather than adding
  platform-specific branches to core.
- Advertise only capabilities the adapter actually provides.
- Keep subprocess arguments structured; never interpolate target data into a
  shell command.
- Return `null` or unavailable observations for properties the platform cannot
  establish.
- Add fake-adapter unit tests and a disposable real-platform gate before asking
  to raise a driver's support status.

See [the driver authoring guide](docs/drivers/authoring.md).

### Fixtures

- Use original assets and content that can be redistributed.
- Add every deliberate defect to the machine-readable manifest with its expected
  rule, severity, confidence, screen, target, and summary.
- Preserve a clean default contract unless a test-only query parameter is
  documented.
- Never make production logic depend on fixture IDs or stored fixture routes.

### Reports and baselines

- Treat target text, logs, URLs, and hierarchy data as untrusted.
- Keep artifact paths relative and confined to the chosen output directory.
- Add parser and renderer tests for malformed, hostile, oversized, and partial
  inputs.
- Baseline comparisons must fail closed when observability is lower or
  incompatible.

## Pull request checklist

Include:

- a concise problem statement and scope;
- tests that fail without the change and pass with it;
- exact commands run and their results;
- real-browser or real-emulator evidence when the claim requires it;
- documentation for any public behaviour, limitation, or compatibility change;
- confirmation that generated artifacts and secrets are not committed.

Do not claim a platform is Stable, Beta, or supported merely because a fake
driver test passes. Status changes require the documented release gate and
maintainer review.

## Commit and review notes

Use clear, imperative commit subjects. Reviewers may request a smaller change if
protocol, driver, fixture, diagnostic, and release concerns are mixed together.
Contributions are licensed under the repository's MIT Licence.
