# Fixtures and benchmark controls

`fixtures/broken-streaming-web` contains Northstar, an original ten-foot web UI
with deliberately seeded defects. It supports integration tests, demonstrations,
exploration benchmarks, and baseline regressions. It is not an example of a
correct TV application.

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
