# TVDoctor

Automated QA for TV apps and ten-foot interfaces.

Test the journeys users actually perform—with Up, Down, Left, Right, Select,
and Back—and keep the evidence needed to reproduce a failure.

> **Public-preview status:** TVDoctor is preparing its v0.1 release. Its web
> path has been verified against the controlled Northstar fixture in real
> Chromium. A bounded local `tvdoctor test URL` host is now wired and remains
> Experimental while its complete real-browser release gate runs. The packages
> are still private `0.0.0` workspaces, and Android has unit coverage but has not
> passed the required real-emulator gate. Do not read “implemented” as
> “production supported.”

## The short demo

The verified streaming gate discovers a complete remote-only journey instead
of consuming a fixture route:

```text
Home → Details → Play → Controls → Settings → Captions → Appearance
                                                           │
                                                           ▼
                                                   Text Colour visible
                                                   but no D-pad path

TVDoctor  HIGH  remote.reachability
           ├─ before/after screenshots
           ├─ UI and navigation evidence
           ├─ report.html / report.json / ai-report.md
           └─ portable focus-transition replay
```

On 22 August 2026 that controlled Chromium gate completed all 17 streaming
stages and reported four deliberately seeded deterministic defects: two high
and two medium. This is fixture evidence, not a general accuracy claim. See the
[demo and reproduction guide](docs/demo.md).

## What it provides

- deterministic, bounded remote exploration with separate screen and focus
  graphs;
- semantic streaming, search, settings, accessibility, layout, performance,
  and crash stages that fail closed when evidence is unavailable;
- local HTML, Markdown, JSON, AI-coder, screenshot, UI, transition, and replay
  evidence bundles;
- exact focus-transition replay with provenance and precondition checks;
- versioned semantic baseline comparison for issues, screens, focus targets,
  transitions, and latency;
- platform-neutral driver contracts, an experimental Playwright adapter, and
  an experimental ADB/UIAutomator adapter;
- no required AI service, API key, cloud account, or telemetry service.

## Try the verified source-checkout path

The verified development environment is Node.js 24 and npm 11. From a clean
checkout:

```sh
npm ci
npx playwright install chromium
npm run build
npm run test:streaming-integration
```

The integration gate starts the deliberately broken fixture, performs the real
Chromium journey, verifies the report and evidence, and writes local output to
`artifacts/milestone-6-gate/`. Generated artifacts are ignored by Git.

Run the fixture interactively:

```sh
npm run fixture:dev
```

Open `http://127.0.0.1:5173` and use Arrow keys, Enter, and Escape. Northstar is
intentionally broken; it is a fixture and benchmark, not a reference TV UI.

With the fixture running, a second terminal can invoke the new bounded local
audit host:

```sh
npm run tvdoctor -- test http://127.0.0.1:5173 --pack navigation --pack streaming --mode standard --output tvdoctor-report --query N
```

Supported pack names are `navigation`, `streaming`, `search`, `settings`,
`accessibility`, `layout`, `performance`, and `crashes`; omit `--pack` to select
`all`. This local command is Experimental until the complete controlled audit
gate passes. A partial run exits inconclusively and must not be treated as clean.

Check the CLI foundation and replay a generated deterministic issue:

```sh
npm run tvdoctor -- doctor
npm run tvdoctor -- replay ISSUE_ID --report artifacts/milestone-6-gate/report.json --target http://127.0.0.1:5173
```

Start `npm run fixture:dev` before the replay command. Replay V1 proves focus
transitions only; numeric playback, visual, latency, and log findings remain
review-only when that schema cannot express their corrected state.

### Registry installation after the v0.1 publish gate

These are the intended public commands, **not current installation claims**:

```sh
npm install --save-dev tvdoctor
npx playwright install chromium
npx tvdoctor test http://127.0.0.1:3000
```

They become supported only after the packages are versioned, made publishable,
installed in a clean consumer project, and the end-to-end CLI audit gate passes.
Until then, use the source-checkout commands above.

## Output

A complete report bundle can contain:

```text
tvdoctor-report/
├── report.html       interactive human report
├── report.md         portable human summary
├── report.json       canonical tvdoctor.report/v1 data
├── ai-report.md      evidence-linked coding tasks and review items
├── evidence/         screenshots, UI excerpts, transitions, and logs
└── replays/          available portable replay documents
```

Unavailable evidence is recorded as unavailable; it is not silently omitted or
turned into a pass. Report generation redacts common credential shapes and
escapes target-controlled text, but reports must still be reviewed before they
are shared publicly.

## Compatibility and support levels

Status words are deliberate:

- **Stable** — compatibility and production support are promised. Nothing is
  Stable in the v0.1 preview.
- **Beta** — substantially verified, but public APIs or formats may still change
  before 1.0.
- **Experimental** — useful for controlled evaluation; support and coverage are
  intentionally narrow.
- **Planned** — no current support claim.

| Surface | Status | Evidence and boundary |
| --- | --- | --- |
| Node.js 24 + npm 11 workspace | Beta | Verified local toolchain; other major versions are outside the declared engine range. |
| `tvdoctor.report/v1` and `tvdoctor.replay/v1` | Beta | Strict parsing, cross-link, redaction, rendering, and fresh-browser replay tests. |
| Deterministic core and streaming pack | Beta | Unit tests and controlled real-Chromium gates; no general-app accuracy claim. |
| Playwright Chromium web driver | Experimental | Real Chromium against Northstar; DOM semantic tree is not a browser accessibility tree. |
| General `tvdoctor test URL` CLI audit | Experimental | Bounded local host is wired; the complete controlled audit release gate is still pending. |
| Android TV ADB/UIAutomator driver | Experimental | Implementation and fake-ADB unit tests exist; real emulator/device gate is pending. |
| Baseline comparison library | Experimental | Versioned fail-closed library; CLI/hosted-CI release workflow is pending. |
| Linux and macOS release verification | Planned | No hosted matrix is claimed in this checkout. |
| Physical Android/Google TV devices | Planned verification | Never claim support from emulator or fake-ADB evidence alone. |
| Fire TV, Roku, Tizen, and webOS drivers | Planned | No adapters or support commitments yet. |

See [current limitations](docs/limitations.md) before using TVDoctor on an app
or in CI.

## Architecture

Drivers translate a platform into the small `TVDoctorDriver` contract. The core
builds bounded state graphs; independent packs interpret observable behaviour;
reporters write a canonical local bundle; the baseline library compares two
compatible runs. Platform-specific probes remain outside the neutral core.

The [architecture guide](docs/architecture.md) describes the trust boundaries,
package ownership, observability rules, and extension points.

## Documentation

- [Demo and exact reproduction](docs/demo.md)
- [Architecture](docs/architecture.md)
- [Examples](docs/examples.md)
- [Fixtures and benchmark controls](docs/fixtures.md)
- [Web driver](docs/drivers/web.md)
- [Android driver status](docs/drivers/android.md)
- [Writing a driver](docs/drivers/authoring.md)
- [Baselines and CI](docs/baselines-and-ci.md)
- [Limitations](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Contributing and security

Bug reports, fixture improvements, diagnostics, and carefully scoped driver work
are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first. Do not include secrets, proprietary
application data, or unredacted reports in an issue.

Report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Licence

TVDoctor is available under the [MIT Licence](LICENSE).
