# `@tvdoctor/baseline`

Versioned, semantic current-vs-baseline comparison for TVDoctor report runs.

The comparator reports new and resolved issues, added/removed screens and focus targets,
changed navigation transitions, and latency regressions. It deliberately fails closed when
the baseline is incompatible, the current run is partial, a required pack or capability is
missing, or a baseline latency observation disappears.

```ts
import { compareBaseline, createBaseline } from "@tvdoctor/baseline";

const baseline = createBaseline(cleanReport, cleanInventory);
const comparison = compareBaseline(baseline, currentReport, currentInventory);
if (comparison.shouldFail) process.exitCode = 1;
```

Target identity for web reports ignores query strings and fragments by default, allowing a
controlled regression switch without treating it as a different application. Callers can
provide an explicit stable `targetId` when platform packaging supplies a better identity.
