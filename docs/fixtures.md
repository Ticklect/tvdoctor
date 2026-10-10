# Controlled fixture validation

`fixtures/broken-streaming-web` contains Northstar, an original ten-foot web UI
with deliberately seeded defects. It validates that TVDoctor can discover remote
paths and identify known failures without reading a stored route or fixture
metadata. It also supports demonstrations, stress controls, and baseline
regressions. It is not an example of a correct TV application.

## Run Northstar

```sh
npm run fixture:dev
npm test --workspace @tvdoctor/broken-streaming-web
```

Open `http://127.0.0.1:5173`. Arrow keys map to directional input, Enter to
Select, and Escape or Backspace to Back.

The machine-readable source of truth is
`fixtures/broken-streaming-web/seeded-defects.json`. The default fixture currently
defines 13 deliberate defects across navigation, focus, Back, player controls,
captions, pointer-only controls, search, layout, performance, and console logs.
That count is fixture inventory—not a claim that every pack detects all 13 in a
single run.

## Controlled query variants

| Query | Purpose | Boundary |
| --- | --- | --- |
| `?routeVariant=semantic-alternate` | Changes initial focus and three journey junctions while preserving semantics and defects | Proves traversal is not a memorised route |
| `?carouselSize=240` | Adds 240 equivalent generated cards | Measures repeated-item compression; valid sizes are 3–500 |
| `?baselineVariant=clean` | Adds the clean M10 focus probe | Baseline/regression test only |
| `?baselineVariant=regressed` | Removes focus in the controlled probe after Select | Deliberate comparison regression only |

The stress carousel and baseline harness are mutually exclusive: requesting a
non-zero carousel suppresses the baseline surface. The default URL adds neither
surface and retains the 13-seed contract.

## Explicit profile-selection test mode

The Northstar fixture includes a deliberately trapped profile picker with two
harmless buttons (`profile-primary` and `profile-kids`). The normal web SELECT
policy withholds profile actions, so the default audit can report unverified
SELECT edges on that dialog. To exercise those edges in a local fixture scan:

```sh
npm run tvdoctor -- scan http://127.0.0.1:5173/ --mode deep --fixture-profile-select
```

Start the fixture first with `npm run fixture:dev`. The flag is accepted only
for loopback web targets with the navigation pack; immediately before each
SELECT, the browser must still show the fixture's `Choose a profile` dialog,
with one of the two exact control IDs and expected labels. It does not authorize
profile changes on ordinary TV applications,
does not permit consent or payment actions, and remains off by default. Reports
record whether the fixture exception was enabled. Even with this option, a
bounded Deep scan is complete only when no work or unsafe edges remain.

## Fixture invariants

- Every seed has a stable fixture ID and expected diagnostic rule.
- Production packages must not read `data-defect-id`, the manifest, or a stored
  remote route.
- Semantic alternate routes must retain equivalent screens, actions, and seeded
  outcomes.
- Benchmark metrics must report action/state/runtime and defect recall; do not
  publish invented accuracy percentages.
- Fixture assets and copy must be safe to redistribute.
- Test-only query parameters must not be presented as public product features.

## Adding a deliberate defect

1. Add the smallest observable broken behaviour.
2. Add one manifest entry with expected rule, severity, confidence, screen,
   target, and plain-language summary.
3. Assert the fixture contract directly.
4. Add a pack/core integration that discovers it without fixture metadata.
5. Prove nearby passing behaviour and false-positive bounds.
6. Update fixture and limitation documentation.

Never weaken a diagnostic merely to match the fixture. A controlled fixture
exists to test the product, not define product truth.

See [Benchmarking](BENCHMARKING.md) for the required separation between seeded
fixture validation, synthetic stress tests, and real-app evidence.
