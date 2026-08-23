# Broken streaming web fixture

`Northstar` is a small, original ten-foot streaming UI with deliberately seeded defects. It is a benchmark and integration fixture, not a reference implementation.

The fixture uses native DOM focus and explicit navigation edges. The supported remote mapping is:

| Remote action | Keyboard key |
| --- | --- |
| Up / Down / Left / Right | Arrow keys |
| Select | Enter |
| Back | Escape, Backspace, BrowserBack |

Every remotely addressable control has a stable `data-tv-id`, `data-screen`, and `data-nav` attribute. Directional edges are exposed as `data-nav-up`, `data-nav-down`, `data-nav-left`, and `data-nav-right` so tests and future drivers can inspect the same graph the fixture uses.

## Run

From the repository root after installing workspace dependencies:

```sh
npm run dev --workspace @tvdoctor/broken-streaming-web
```

Then open `http://127.0.0.1:5173`. Run its direct fixture contract tests with:

```sh
npm test --workspace @tvdoctor/broken-streaming-web
```

Fixture tests may add `?routeVariant=semantic-alternate` to perturb three
semantic-journey junctions while preserving the same screens, actions, and
seeded failures. The alternate starts on a safe Home content card, places
Settings immediately after Play/Pause in the Player control row, and orders the
Captions menu as Off, Appearance, English, and Español. Its directional edges
match those visual arrangements without adding route-only self-loops. This
query is test support for proving that a traversal is semantic rather than a
memorized action sequence; the default URL retains the fixture's original
focus and navigation graph.

The intentionally seeded issues are the source of truth in [`seeded-defects.json`](./seeded-defects.json). Tests assert the contract and representative failures; they intentionally do not implement or substitute for the TVDoctor web driver.
