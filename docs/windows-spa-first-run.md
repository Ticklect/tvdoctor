# Observe browser Back on a local SPA

Build the TVDoctor source checkout and install its matched Chromium runtime.

```powershell
npm ci
npm run build:packages
npm run tvdoctor -- setup
```

Run the [controlled loopback fixture](../fixtures/reliability-lab-v2/README.md)
in a separate terminal.

```powershell
node fixtures/reliability-lab-v2/server.mjs
```

Run a quick site scan with experimental SPA exploration and a fresh output directory.

```powershell
npm run tvdoctor -- site http://127.0.0.1:4191/explorer/back-state --input keyboard --mode quick --max-pages 1 --spa --output .\Tests\spa-back-broken
```

Use `/explorer-fixed/back-state` with another output directory for the repaired
fixture. Add `--no-spa-screenshots` to omit optional SPA Back images while retaining
the probes. The separately run page audits have their own screenshot setting.

Read the run status and deferred frontier before interpreting the findings.
Stale-view findings are heuristic review leads from observed Back probes.
For MCP usage, opt in with `tvdoctor_site` and `explore_spa: true`, then inspect
the index and findings in the same session. [Browser audit guide](browser-audit.md) ·
[MCP tool guide](mcp-server.md)
