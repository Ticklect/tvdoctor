# Stateful web journeys

TVDoctor supports repeatable setup of authenticated or stateful Chromium apps
before an audit or deterministic replay. A journey is a local JSON file passed
to the existing `--journey PATH` option. It uses the existing
`tvdoctor.journey/v1` schema and stores a SHA-256 of the canonical *configuration*
in the audit report. The schema version, hash algorithm, and hashing of existing
v1 steps have **not** changed. A replay must be given the exact same journey
configuration, including the same step order, and satisfy the saved hash.

## Example: authenticate, navigate, prove state

```json
{
  "schemaVersion": "tvdoctor.journey/v1",
  "name": "Sign in and verify dashboard dialog",
  "maxDurationMs": 30000,
  "steps": [
    { "action": "expect-route", "path": "/login" },
    { "action": "type-from-env", "env": "TVDOCTOR_JOURNEY_EMAIL" },
    { "action": "press", "key": "TAB" },
    { "action": "type-from-env", "env": "TVDOCTOR_JOURNEY_PASSWORD" },
    { "action": "press", "key": "SELECT" },
    { "action": "wait-for-route", "path": "/dashboard", "timeoutMs": 10000 },
    { "action": "wait-for-ui", "role": "region", "name": "Dashboard", "state": "visible", "timeoutMs": 10000 },
    { "action": "expect-ui", "role": "dialog", "name": "Welcome", "state": "hidden" }
  ]
}
```

Provide secret values in the **calling process environment**, not the JSON.
For PowerShell:

```powershell
$env:TVDOCTOR_JOURNEY_EMAIL = "<your-test-account-email>"
$env:TVDOCTOR_JOURNEY_PASSWORD = "<your-test-account-password>"
npm run tvdoctor -- scan http://127.0.0.1:5173/login --input keyboard --journey .\my-journey.json --output .\Tests\my-new-audit
```

Use a dedicated test account and isolated test environment: login and the
application's keyboard actions may intentionally modify server-side state.
Never place passwords, tokens, session-bearing query strings, or raw secrets
in JSON fields, names, route paths or report metadata. The journey engine
receives sensitive values from `TVDOCTOR_JOURNEY_*` variables and does not
put those values in its return object, report's journey metadata or error
messages. Some applications may separately render private data into the
browser UI; normal screenshot/report privacy controls still apply.

## Steps

| Action | Fields | Guarantee |
| --- | --- | --- |
| `expect-route` | `path` | Current browser pathname must match exactly, with no query or fragment |
| `navigate-route` | `path` | Navigate by HTTP(S) GET on the same origin; guarded against non-GET requests and cross-origin document redirects during navigation |
| `expect-ui` | `role`, `name`, `state` | Exactly zero or one named dialog/region/tabpanel; visible/hidden asserted immediately |
| `wait-for-route` | `path`, optional `timeoutMs` | Poll until two consecutive observations match the exact same-origin route |
| `wait-for-ui` | `role`, `name`, `state`, optional `timeoutMs` | Poll until two consecutive observations match; ambiguous matches are rejected |

Allowed roles are `dialog`, `alertdialog`, `region` and `tabpanel`.
`state` is `visible` or `hidden`. A hidden state succeeds for a missing
element or one uniquely matched nonvisible element. Named selectors use
Playwright's accessible role and exact accessible name rather than CSS
injection or JavaScript evaluation. If more than one element matches, the
journey aborts instead of selecting the first.

Routes are absolute **pathnames** beginning with `/`, with only letters,
numbers, `_`, `-`, `.`, `~` and `/`. No `..` or `.` segment,
encoded segment, query, fragment, protocol-relative URL, credential or
different origin is permitted. `navigate-route` performs a full-page GET
using the existing browser context, preserving cookies; the app must support
direct routing to that path. Use keyboard activation plus `wait-for-route`
when app-specific client-side routing or in-memory auth is required.

Each `wait-for-*` uses an observable state transition, **not a fixed sleep
considered proof of readiness**. Polling happens at bounded intervals and
requires two matching observations. The per-step wait defaults to 10 seconds,
can be 250–30,000 ms, and is also capped by the total journey deadline.
Existing limits remain 32 steps, 256 inputs (including one counted per route
navigation) and 120 seconds total. The wait and browser-navigation guard
fail closed when target or evidence is ambiguous or missing.

## Important limits

- All route and UI assertions are scoped to the original HTTP(S) origin. An
  OAuth redirect to another origin is deliberately unsupported.
- `navigate-route` blocks non-GET network requests during that
  navigation. It does **not** promise every application action is read-only:
  badly designed servers can mutate state even on GET requests; `press` can
  submit an authentication form and some apps mutate state on keyboard input.
  Use an authorized, isolated test account/environment.
- Service-worker-controlled requests may bypass Playwright page routing, so
  `navigate-route` refuses a context with registered service workers.
  Navigation is not a universal sandbox or transactional rollback mechanism.
- Route/assertion errors deliberately omit URL, DOM and secret contents. The
  config hash matches the JSON configuration only, **not** the dynamic
  environment secret values or application deployment.
- Existing `expect-focus`, `press` and `type-from-env` continue to work
  unchanged. An old journey with no new steps retains its original normalized
  shape and hash.

## Development checks

```powershell
npx vitest run packages/cli/test/journey.test.ts
npm run typecheck --workspace tvdoctor
npx eslint packages/cli/src/journey.ts packages/cli/test/journey.test.ts --max-warnings=0
```
