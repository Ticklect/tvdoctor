import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { createNodeAuditOperation } from "../src/node-audit.js";

const SECRET = "journey-secret-canary";
let server: Server;
let target: string;
let temporaryRoot: string;

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><body><main id="app"></main><script>
      const app = document.querySelector('#app');
      function render() {
        if (localStorage.getItem('tvdoctor-authenticated') === 'yes') {
          app.innerHTML = '<button id="play" autofocus>Play</button>';
          document.querySelector('#play').focus();
        } else {
          app.innerHTML = '<form><label>Test password <input id="password" type="password" autofocus></label></form>';
          document.querySelector('#password').focus();
          document.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            localStorage.setItem('tvdoctor-authenticated', 'yes');
            render();
          });
        }
      }
      render();
    </script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Journey test server did not bind TCP.");
  target = `http://127.0.0.1:${String(address.port)}/`;
  temporaryRoot = await mkdtemp(join(tmpdir(), "tvdoctor-journey-integration-"));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("prepares a persistent secret-backed session without writing the secret", async () => {
  const journeyPath = join(temporaryRoot, "journey.json");
  const outputPath = join(temporaryRoot, "report");
  await writeFile(journeyPath, JSON.stringify({
    schemaVersion: "tvdoctor.journey/v1",
    name: "Fixture sign in",
    maxDurationMs: 10_000,
    steps: [
      { action: "type-from-env", env: "TVDOCTOR_JOURNEY_PASSWORD" },
      { action: "press", key: "SELECT" },
      { action: "expect-focus", role: "button", name: "Play" },
    ],
  }));
  const previous = process.env["TVDOCTOR_JOURNEY_PASSWORD"];
  process.env["TVDOCTOR_JOURNEY_PASSWORD"] = SECRET;
  try {
    const result = await createNodeAuditOperation()({
      target,
      packs: ["navigation"],
      mode: "quick",
      outputPath,
      searchQuery: "N",
      journeyPath,
    });
    expect(result.status).toBe("completed");
  } finally {
    if (previous === undefined) delete process.env["TVDOCTOR_JOURNEY_PASSWORD"];
    else process.env["TVDOCTOR_JOURNEY_PASSWORD"] = previous;
  }
  const reportText = await readFile(join(outputPath, "report.json"), "utf8");
  const ledgerText = await readFile(join(outputPath, "stage-ledger.json"), "utf8");
  expect(reportText).not.toContain(SECRET);
  expect(ledgerText).not.toContain(SECRET);
  const report = JSON.parse(reportText) as {
    target: { environment: Record<string, string> };
    coverage: { actionsSent: number; budget: { maxActions: number } };
  };
  expect(report.target.environment["journeyConfigSha256"]).toMatch(/^[0-9a-f]{64}$/u);
  expect(report.coverage.actionsSent).toBeGreaterThanOrEqual(2);
  expect(report.coverage.budget.maxActions).toBeGreaterThanOrEqual(2);
});
