# Security policy

TVDoctor launches applications, sends input, reads UI/log observations, and
writes local evidence. Treat it as a developer tool with access to the target
and the current user's filesystem—not as a security sandbox.

## Reporting a vulnerability

Use the repository host's private security-advisory feature when it is available
(on GitHub: **Security → Report a vulnerability**). Include the affected commit
or version, impact, minimal reproduction, and any proposed mitigation.

If private advisories are not enabled, contact a maintainer privately through
their repository profile and ask for a secure reporting channel. Do not publish
exploit details, credentials, private targets, or sensitive report artifacts in
a public issue. General hardening suggestions without exploit details may use
the security issue category.

No response-time or bounty programme is promised during the pre-1.0 preview.
Maintainers will validate scope, coordinate a fix and disclosure where possible,
and credit reporters who want attribution.

## Supported versions

There is no published supported release yet.

| Version | Security fixes |
| --- | --- |
| Current development branch | Best effort while v0.1 is prepared |
| Private `0.0.0` workspaces | Not a released support line |
| Older snapshots and forks | Not supported by this project |

This table will be replaced with explicit release lines when v0.1 is published.

## Security boundaries

- Audit only targets you own or are authorised to test.
- Prefer local, disposable, non-production targets with synthetic accounts and
  data.
- Do not place passwords, tokens, personal data, or payment details in search
  queries, target URLs, fixture state, logs, or environment metadata.
- The CLI rejects credential-bearing HTTP(S) target URLs, but that does not make
  an arbitrary page safe.
- Web targets execute inside a real browser. A hostile page can consume CPU,
  initiate requests, show deceptive UI, or attempt browser exploits.
- Android install, clear-data, force-stop, and input operations affect the
  selected device. Use a disposable emulator and an explicit serial.
- Never run privileged physical-device or emulator jobs against untrusted pull
  request code.
- Report redaction is defence in depth, not a guarantee. Inspect artifacts before
  uploading or sharing them.
- Artifact output paths and APK paths must come from trusted operator input, not
  target-controlled text.

## In-scope examples

- path traversal or output-directory escape;
- command or argument injection in a platform driver;
- secrets surviving documented report redaction;
- target-controlled active content executing from a generated report;
- report/replay validation bypass that creates a false deterministic result;
- unsafe cross-target baseline or replay correlation.

Expected diagnostic false positives, missing test coverage, and ordinary target
application bugs are quality issues rather than security vulnerabilities unless
they cross one of the boundaries above.
