# TVDoctor contributor instructions

TVDoctor is a local-first TV remote-navigation auditor. The central promise is
to discover screens and focus paths, report what was actually observed, and
replay deterministic failures. Fast scans must never imply full coverage when
their action, state, depth, time, or evidence limits were reached.

## Development

- Work from the repository root. Supported runtimes are Node 22.13+ or Node 24;
  npm workspaces are defined in the root package.json.
- Before editing, inspect the current callers and tests, then check `git status`.
  This checkout frequently contains unfinished changes; preserve them and do
  not reset, clean or bulk-format unrelated files.
- Core traversal lives in `packages/core/src/explorer-*.ts` and
  `fingerprint.ts`. Web browser behavior is in `packages/driver-web`.
  CLI requests and audit artifacts are in `packages/cli`.
- Prefer small, explainable fixes and regression tests with a reachable state
  graph, rather than tuning heuristics until a particular screenshot passes.

## Navigation correctness

- Count physical key presses including replay toward the action budget.
- Preserve every distinct reachable screen, focus state, and transition unless
  explicit bounded compression marks the omitted work as deferred.
- Full/deep navigation keeps repetition compression disabled by default.
  Any partial scan must preserve its termination reason and remaining work.
- A reused live state needs fresh observation. A local restoration path must
  match its checkpoints; on divergence restore a verified root or report the
  branch incomplete. Never invent success or suppress uncertain findings.
- Browser root restoration must return to the launch route in the same tab,
  retain session-scoped state, and fail closed on unsettled or failed resets.
- Do not count a failed local-path search as an unexplored screen when verified
  root fallback successfully reconstructs the state. Keep diagnostic attempts
  separately visible from lost exploration coverage.
- Keep issue IDs, finding confidence and evidence provenance stable; heuristic
  geometry findings are for review until directly reproduced.

## Verification

- Run targeted Vitest tests for changed code, then `npm run test:unit`,
  `npm run lint`, `npm run typecheck`, and `npm run build:packages`.
- For web driver or traversal changes, run
  `npm test --workspace @tvdoctor/driver-web` and the relevant
  `npm run test:integration --workspace @tvdoctor/core` gates.
- For scan behavior or speed claims, compare root-only and verified-local on
  the same build and budgets. Check exact screen, focus, transition and issue
  identities, not merely counts. Report termination and untested frontier.
- Fixture, synthetic stress, real-browser, and physical-TV results are distinct
  kinds of evidence. Consult `docs/BENCHMARKING.md`; never present synthetic
  gains as production speedups or partial scans as complete coverage.

## Safety and scope

- Test only authorized targets. Do not automate account approvals, purchases,
  destructive app actions or credentials to get past setup walls.
- Do not commit, push, publish, or modify release artifacts unless the task
  explicitly calls for those actions.
- Keep private local artifacts, logs and session information out of public
  reports and commit history.
