# Security policy

TVDoctor launches applications, sends input, reads UI/log observations, and
writes local evidence. Treat it as a developer tool with access to the target
and the current user's filesystem—not as a security sandbox.

## Reporting a vulnerability

If this repository exposes GitHub's **Security → Report a vulnerability** flow,
use it. Include the affected commit or version, impact, minimal reproduction,
and any proposed mitigation. Confirm that the conversation is private before
attaching a report bundle or exploit details.

If private vulnerability reporting is unavailable, contact the repository owner
through the private contact method on their GitHub profile and ask for a secure
channel. If no private contact method is listed, a public issue may ask the
maintainer to enable a channel, but it must contain no vulnerability details.
Do not publish exploit details, credentials, private targets, or sensitive report
artifacts in a public issue. General hardening suggestions without exploit detail
may use the normal bug-report form.

No response-time or bounty programme is promised during the pre-1.0 preview.
Maintainers will validate scope, coordinate a fix and disclosure where possible,
and credit reporters who want attribution.

## Supported versions

There is no published supported release yet.

| Version | Security fixes |
| --- | --- |
| Current `main` source candidate | Best effort while v0.1 is prepared |
| `0.1.0` package candidate | Not supported until registry publication is verified |
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
- The TVDoctor Android observer requires explicit accessibility access. It binds
  only to device loopback, accepts a bounded operation allowlist over a framed
  protocol, and authenticates each host run with a random token. The host exposes
  it only through an ephemeral local ADB forward and validates the packaged APK
  checksum before deployment.
- Do not enable the observer on a device containing sensitive application state
  unless that device is explicitly dedicated to authorized testing. Remove it
  with `adb -s SERIAL uninstall org.tvdoctor.observer` when no longer needed.
- Never run privileged physical-device or emulator jobs against untrusted pull
  request code.
- Report redaction is defence in depth, not a guarantee. Inspect artifacts before
  uploading or sharing them.
- Artifact output paths and APK paths must come from trusted operator input, not
  target-controlled text.

## In-scope examples

- path traversal or output-directory escape;
- command or argument injection in a platform driver;
- observer authentication, framing, request-correlation, or operation-allowlist
  bypass;
- secrets surviving documented report redaction;
- target-controlled active content executing from a generated report;
- report/replay validation bypass that creates a false deterministic result;
- unsafe cross-target baseline or replay correlation.

Expected diagnostic false positives, missing test coverage, and ordinary target
application bugs are quality issues rather than security vulnerabilities unless
they cross one of the boundaries above.
