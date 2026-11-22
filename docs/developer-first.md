# TVDoctor for web development

[Connect TVDoctor to your coding agent](mcp-server.md) to scan a running
app, inspect the evidence, and verify a supported original failure after
the agent edits the code.

## Work from local evidence

From the source checkout, after building and running `npm run tvdoctor -- setup`,
start an app you are authorised to test. Open the dashboard or run the QA command.

```sh
npm run tvdoctor -- ui
npm run tvdoctor -- qa http://127.0.0.1:3000
```

The dashboard binds to loopback. The QA command retains the original report,
a coverage summary, and a repair brief. Use the exact finding and its saved
evidence when investigating the app code. Review any artifacts before sharing.

After the app reflects the change, use the
[CLI verification workflow](cli-workflow.md) to replay an eligible original
issue and, separately, run another bounded scan for regressions. A partial
scan leaves work untested. [Browser audit modes](browser-audit.md)
