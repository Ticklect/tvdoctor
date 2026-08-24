# `@tvdoctor/protocol`

Platform-neutral TypeScript contracts shared by TVDoctor drivers, diagnostics,
reporters, and replay consumers.

The package exports:

- the six remote keys and driver action/result contracts;
- explicit capability and observation types;
- UI, focus, screenshot, log, and application snapshot contracts;
- versioned issue, report, artifact, and portable replay models;
- strict validation and JSON Schema helpers for integration boundaries.

```ts
import type {
  ActionResult,
  StateSnapshot,
  TVDoctorDriver,
} from "@tvdoctor/protocol";

export class ExampleDriver implements TVDoctorDriver {
  // Implement capabilities(), press(), and snapshot(). Optional platform
  // operations are represented explicitly by the interface.
}
```

Protocol values are JSON-serializable and preserve unavailable observations
instead of guessing. Consumers should validate external report or replay data
before using it; TypeScript types alone do not validate untrusted runtime input.

This package provides contracts only. Use `tvdoctor` for the CLI,
`@tvdoctor/core` for exploration and replay execution, and a platform driver for
real input and observation.

