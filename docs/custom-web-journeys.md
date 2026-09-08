# Custom web journeys

Some TV web apps require a test account, profile selection, or another known
path before their main remote-control interface appears. `--journey` runs that
preparation before the selected audit packs and preserves the resulting browser
storage in every isolated audit and evidence session.

Create a JSON file that contains only remote keys, environment-variable names,
and an optional final focus assertion:

```json
{
  "schemaVersion": "tvdoctor.journey/v1",
  "name": "Sign in and select the test profile",
  "maxDurationMs": 30000,
  "steps": [
    { "action": "type-from-env", "env": "TVDOCTOR_JOURNEY_EMAIL" },
    { "action": "press", "key": "SELECT" },
    { "action": "type-from-env", "env": "TVDOCTOR_JOURNEY_PASSWORD" },
    { "action": "press", "key": "SELECT" },
    { "action": "expect-focus", "role": "button", "name": "Play" }
  ]
}
```

Set the values outside the file and run the audit:

```sh
export TVDOCTOR_JOURNEY_EMAIL='tv-test@example.test'
export TVDOCTOR_JOURNEY_PASSWORD='use-a-secret-store-in-ci'
npx tvdoctor test https://example.test/tv --journey journey.json
```

On PowerShell, set the variables for the current process with
`$env:TVDOCTOR_JOURNEY_EMAIL = '...'` and
`$env:TVDOCTOR_JOURNEY_PASSWORD = '...'`.

The v1 format accepts three actions:

| Action | Purpose |
| --- | --- |
| `press` | Send a known TV remote key, with an optional `repeat` from 1 through 10. |
| `type-from-env` | Insert a value from a `TVDOCTOR_JOURNEY_*` variable into the currently focused field. |
| `expect-focus` | Require the focused element to have the exact supplied role, name, or both. |

A journey is limited to 32 steps, 256 input operations, 120 seconds, 256
characters per environment value, and 1,024 sensitive characters in total.
Those inputs and time are added to the report's effective runtime budgets. The
journey cannot be combined with `--startup-actions`.

TVDoctor never writes environment values or their lengths to its report or
stage ledger. The ledger records only that an environment-backed input occurred.
The report stores the journey name and a canonical SHA-256 fingerprint. Names,
expected focus labels, screenshots, UI snapshots, URLs, and page content are
ordinary report evidence, so do not put secrets in them and use a dedicated test
account whose visible identity is safe to capture.

Replay is bound to preparation state. When the original report contains a
journey fingerprint, `tvdoctor replay` requires `--journey` and rejects a
missing or different file before creating a browser driver:

```sh
npx tvdoctor replay ISSUE_ID --report Tests/run/report.json --journey journey.json
```
