# Reliability lab v2: heterogeneous local UI scenarios

This lab provides **four new** browser applications, independent of reliability-lab v1. Each is a realistic but entirely synthetic, self-contained client-side application with broken and repaired variants. The HTTP server binds only to 127.0.0.1 and accepts only GET/HEAD. No account sign-in, requests to external origins, purchases, server-side write endpoints or form submissions exist. These are controlled fixture measurements, not production coverage claims.

| Scenario | Broken target | Repaired target | Known browser-ground-truth defects |
| --- | --- | --- | --- |
| Knowledge workspace | /knowledge | /knowledge-fixed | Nested topic tree reports expanded after collapsing; /knowledge/dialog leaks keyboard modal focus and fails Escape focus restoration. Hash routes #guide/start, #guide/advanced, #policy support browser Back |
| Kanban/team inbox | /inbox | /inbox-fixed | Optimistic 180ms filter update destroys the focused control; /inbox/dialog loses focus on Escape and allows Tab escape |
| Event discovery | /events | /events-fixed | At 390px, the sticky filter drawer extends past the viewport, and its sticky action obscures the last label inside a nested scroll. The repaired drawer fits and contains overscroll |
| Admin data explorer | /explorer | /explorer-fixed | Nested menu keeps aria-expanded=true when collapsed; History API Back leaves a stale heading. /explorer/dialog tests modal focus. Explicit /explorer/delete is a *blocked* unsafe-navigation canary |

Use the queryless **-fixed** variants with SPA discovery. Nested paths such as /explorer/reports, /explorer/teams, /knowledge/dialog, /inbox/dialog and /events/drawer (also -fixed) resolve to the same entry document. All links intended for navigation use local History API or hash navigation. The unsafe canary has no server handler and must never be activated by scanners.

## Start and test

From the repository root with workspace dependencies installed:

~~~sh
node fixtures/reliability-lab-v2/server.mjs
~~~

The server defaults to http://127.0.0.1:4191. Override TVDOCTOR_LAB_V2_PORT if the port is busy. Available readiness/traffic endpoints: /health, /metrics. Metrics include local request path and method/path counts, total non-GET attempts, and GET requests to action-like or destructive route names. No server-side write endpoints exist.

The TVDoctor MCP tests use this fixture to check the recorded browser observations and deferred coverage.
