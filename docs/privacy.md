# TVDoctor privacy

TVDoctor is local-first and does not upload reports by default. Audit artifacts stay in the output directory you choose unless you explicitly copy, upload, or share them.

Depending on the surface and enabled evidence, TVDoctor may capture the target URL origin/path, visible UI text, screenshots, console or device logs, network metadata, device metadata, environment diagnostics, and optional video. `--no-screenshots` disables persisted PNG evidence. `--target-redaction origin` stores only the web target origin as the public target identity and requires an explicit replay target when the route can no longer be reconstructed.

Redaction is defense-in-depth, not a guarantee. TVDoctor removes common credentials, query strings, fragments, sensitive headers, and secret-like environment values, but users must review report artifacts before sharing them.

Android audits operate only on the selected test device. They can install the supplied APK, launch it, send remote-control input, and, only when explicitly approved for a detected setup action, interact with that selected device state. Replay/device selection remains explicit local CLI input; the selected ADB serial is not a public report target identifier.

Temporary browser/device working data and report output remain local. Uninstall removes TVDoctor-owned installation files only; unrelated Playwright/browser caches and user report directories are retained. Optional video evidence is disabled by default and can contain sensitive visual content when enabled.
