# @tvdoctor/core

TVDoctor's platform-neutral deterministic exploration, navigation-diagnostics,
sequence-minimisation, and replay core.

The explorer maintains two separate graphs:

- `ScreenState` is structural UI identity and deliberately excludes focus.
- `FocusState` is the focused target within one `ScreenState`.

Legacy exploration is breadth-first. M8 also provides a deterministic priority
frontier that prefers newly discovered screens, then shallower paths, configured
action order, and stable insertion order. Every queued state retains its explicit
remote-key sequence. Before trying an outgoing edge, the explorer restores the
same root and replays that sequence, so sibling actions do not inherit one
another's side effects. A driver `reset()` implementation is used by default;
adapters can provide an equivalent `restoreInitialState` callback.

Explicit `quick`, `standard`, and `deep` profiles select published action, state,
depth, and duration envelopes. Profiles activate priority exploration and
conservative repeated-item compression; callers can override any budget without
weakening validation. Legacy calls without a profile keep their previous BFS and
uncompressed behaviour. Compression is evidence-based: a focused item must have
a generated numeric identifier and at least three immediate siblings with the
same identifier shape, role, interaction state, and layout dimensions. Unique
titles and text do not prevent equivalent carousel cells from sharing bounded
representatives. Unrelated same-role controls are not merged. Statistics expose
exact repeats, compressed states, states deferred from expansion, settling polls,
and settling exhaustion alongside physical/replay action counts.

All runs are bounded by actual driver inputs (`maxActions`, including replay),
unique combined states (`maxStates`), sequence depth (`maxDepth`), and monotonic
elapsed time (`maxDurationMs`). Driver calls are raced against the remaining
duration so the explorer can return a cutoff even if an adapter call never
settles. The caller should still close the adapter afterward because the generic
driver protocol cannot cancel an already-running operation. The result always
records the termination reason.

`press()` is the default platform settling boundary. Core awaits it and captures
the next snapshot without an implicit sleep. Callers with an early-resolving
driver can explicitly choose bounded `stable-snapshot` polling, configure the
number of consecutive canonical states, polling allowance, interval, and wait
primitive, or provide a platform-neutral equivalence predicate. Exhaustion is an
explicit incomplete termination, never a stable observation. Action attempts
retain the driver's exact `ActionResult`, before/after snapshots, and full
root-relative sequence.

Fingerprints combine available location and structural UI hierarchy signals while
normalising common volatile data. Screenshot hashes and DOM-only fields are not
required. Every screen and focus fingerprint exposes `high`, `medium`, or `low`
matching confidence; unavailable observations remain explicitly low-confidence.

`diagnoseNavigation()` evaluates a frozen exploration graph without driver I/O.
It currently covers observed lost focus, aligned self-loops, sufficiently proven
visible remote-unreachability, entered modal focus traps, focus behind a modal,
immediate Select/Back navigation to an unrelated screen, and abnormal geometric
jumps. Deterministic findings and heuristic findings are returned separately.

The absence-based rules are deliberately conservative. Remote-unreachability
requires complete local action coverage, available and unambiguous focus/UI
observations, an explicitly enabled non-focusable control, and a concrete
directional action from an aligned reached sibling that skips it. Focus traps
require an explicit modal, an observed entry, six-key local coverage, and proof
that every observed destination remains inside the same modal subtree.

Issue IDs are hashes of canonical semantic evidence rather than traversal IDs,
so reordering graph arrays or combining independent trace segments does not
renumber unrelated issues. Each finding preserves the exact observed action
sequence and separates deterministic evidence from heuristic or inferred
claims.

`compileIssueReplay()` and `compileReplay()` turn a correlated protocol replay
into a bounded executable plan. `executeReplay()` restores the root, runs the
setup sequence, verifies the pre-action focus checkpoint, dispatches the final
assertion action, and classifies the result as `reproduced`, `fixed`,
`inconclusive`, or `error`. A deterministic fixed result requires trusted source
issue provenance and an explicit expected-state match; missing observability or
precondition drift never becomes a pass. Compiled plans are process-local,
tamper-checked, and copied before asynchronous driver work so caller mutation
cannot alter the executed actions or classification.

`minimizeActionSequence()` uses deterministic delta debugging and removes a key
only after a caller-provided semantic oracle accepts the complete candidate. It
preserves the final diagnostic action by default and strictly bounds semantic
checks. `minimizeGraphSequence()` supplies an exact observed-graph oracle only
when the root and every used state/action edge are unambiguous; otherwise it
rejects the baseline instead of guessing. Every returned candidate reports
whether semantics were proved and whether the check budget was exhausted.

This package intentionally contains no fixture paths, filesystem/report logic,
AI integration, or platform-specific assumptions. It provides the replay
engine, but not a runnable audit or report bundle; the CLI and reporter packages
own those boundaries.

## Local verification

After the workspace lockfile has been refreshed by the repository owner:

```sh
npm run typecheck --workspace @tvdoctor/core
npm test --workspace @tvdoctor/core
npm run test:integration --workspace @tvdoctor/core
npm run lint --workspace @tvdoctor/core
npm run build --workspace @tvdoctor/core
```
