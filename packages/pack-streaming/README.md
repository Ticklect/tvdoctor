# `@tvdoctor/pack-streaming`

Platform-neutral semantic streaming and player journey pack for TVDoctor.

The pack drives a `TVDoctorDriver` with remote-style input and discovers a bounded journey through content details, playback, player controls, settings, captions, and Caption Appearance. It reports deterministic player, caption-selection, remote-reachability, and pointer-only findings only when the required observations are available.

## Usage

```ts
import { runStreamingPack } from "@tvdoctor/pack-streaming";

const result = await runStreamingPack(driver);
```

Pointer reachability is deliberately platform-owned. A caller may provide a `pointerProbe` that receives the semantically discovered target, the containing snapshot, and the exact remote-only surface route. The hook must use a fresh isolated platform context and return a bounded structured property change; the pack restores and verifies the main remote session after the hook.

```ts
const result = await runStreamingPack(driver, {
  pointerProbe: {
    async probe(request) {
      // Correlate request.element with request.snapshot, reproduce
      // request.surfaceSequence in an isolated context, then activate the
      // same target through the platform's pointer mechanism.
      return {
        status: "reachable",
        detail: "Pointer activation changed the observed value.",
        observedChange: {
          property: "accessible value",
          before: "off",
          after: "on",
        },
      };
    },
  },
});
```

Never fabricate a pointer result or a focus replay. Numeric player outcomes and caption-selection outcomes remain replay-unavailable when Replay V1 cannot assert the relevant state.

## Development

```sh
npm test --workspace @tvdoctor/pack-streaming
npm run typecheck --workspace @tvdoctor/pack-streaming
npm run test:integration --workspace @tvdoctor/pack-streaming
```

The integration command performs a clean package and fixture build before starting the real-Chromium Milestone 6 gate. Generated reports and evidence are written under `artifacts/milestone-6-gate`.

The web driver and streaming pack remain experimental. This package does not claim Android, physical-device, viewport, performance, or crash-pack coverage.
