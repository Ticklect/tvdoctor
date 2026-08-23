# Writing a TVDoctor driver

A driver translates one platform into the platform-neutral
`@tvdoctor/protocol` contract. It does not diagnose the app itself.

## Minimum contract

Implement:

```ts
interface TVDoctorDriver {
  capabilities(): Promise<ReadonlySet<Capability>>;
  press(key: RemoteKey): Promise<ActionResult>;
  snapshot(): Promise<StateSnapshot>;
  captureScreenshot?(artifactPath: string): Promise<ScreenshotArtifact>;
  reset?(strategy: ResetStrategy): Promise<void>;
  install?(artifactPath: string): Promise<void>;
  launch?(app: AppReference): Promise<void>;
  getLogs?(): Promise<readonly LogEntry[]>;
}
```

Only the first three methods are required. If deterministic root restoration is
unavailable, the generic explorer reports that limitation rather than pretending
to explore sibling actions independently.

## Normalisation rules

- Map platform inputs to exactly `UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, and
  `BACK`.
- Preserve the requested key and an explicit applied/unsupported/failed outcome
  in every `ActionResult`.
- Use a monotonic timing source for durations; do not mix it with display
  timestamps.
- Return JSON-safe snapshots. Cyclic or platform-native objects do not cross the
  protocol boundary.
- Use available/unavailable observations. Inside an available UI tree, use
  `null` for a property the platform cannot establish.
- Keep stable IDs stable across snapshots when the platform provides a semantic
  identity. Do not invent fixture-specific IDs in a general adapter.
- Preserve hierarchy and bounds without inferring focusability, visibility, or
  selection from a role alone.

## Capability honesty

Advertise a capability only when its public operation and evidence are usable.
Examples:

- a DOM semantic tree is `ui-tree`, not necessarily `accessibility-tree`;
- screenshot capability requires a validated on-disk image artifact;
- logs require bounded timestamp/level/message records, not console printing;
- performance requires attributable bounded observations;
- player-state requires semantic media state, not the presence of a Play label.

Packs use capabilities to decide whether a rule is observable. Inflating them
creates false passes and false deterministic findings.

## Settling and bounds

A resolved `press()` promise is the adapter's default settling boundary. Define
what changed, what quiet/stable means, and a strict timeout. The core can apply
additional bounded canonical-snapshot polling, but it cannot repair an adapter
that returns inconsistent input outcomes.

Bound at least:

- command/browser navigation time;
- UI nodes and hierarchy depth/bytes;
- logs and network entries;
- screenshot/video bytes;
- captured text and error messages;
- subprocess output;
- cleanup time.

Never leave a target operation waiting without a deadline.

## Security requirements

- Prefer structured library or subprocess arguments; never assemble a shell
  command with app, device, URL, or page data.
- Validate package names, components, serials, URLs, and artifact extensions at
  their trust boundary.
- Confine outputs to caller-approved paths and never derive filenames from
  target text.
- Redact common credential forms in logs and errors.
- Make install, clear-data, force-stop, purchase, and account actions explicit;
  do not hide them in observation calls.
- Close browser contexts, processes, files, and temporary resources even after a
  failed action.

## Contribution gate

1. Unit-test mapping, validation, bounds, malformed observations, timeout,
   unsupported operations, and cleanup with a fake platform executor.
2. Run shared protocol/core behaviour against the adapter without special cases.
3. Add a small redistributable fixture containing one deliberate issue.
4. Run a disposable real-platform gate from install/launch through report and
   supported replay.
5. Repeat the run to establish deterministic ordering and cleanup.
6. Document unavailable properties, privilege requirements, operating systems,
   and unsupported surfaces.

An adapter starts Experimental. Maintainers raise its status only from recorded
real-platform evidence, not code completeness or contributor confidence.

## Future package names

Independent adapters should use names such as `@tvdoctor/driver-roku` or
`@tvdoctor/driver-tizen`. Those examples are naming guidance, not evidence that
the drivers exist or are planned for a specific release.
