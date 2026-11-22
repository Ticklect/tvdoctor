/* global URL, process */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const allowed = /^\/(knowledge|inbox|events|explorer)(-fixed)?(?:\/(?:dialog|activity|reports|teams|overview|guide|schedule|drawer|scroll-end|scroll-clean|back-state(?:\/reports)?|nested-history(?:\/projects(?:\/report)?)?|journey(?:\/(?:team|mine|music|outdoor))?))?\/?$/u;
const dangerousPath = /(?:^|\/)(?:delete|remove|destroy|purchase|checkout|submit|logout|write|mutate)(?:\/|$)/iu;
const resources = new Map([
  ["/lab-v2.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/lab-v2.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export async function startLabV2({ port = 0 } = {}) {
  const requestCounts = new Map();
  const methodCounts = new Map();
  let nonGetRequests = 0;
  let dangerousGetRequests = 0;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const method = req.method ?? "UNKNOWN";
    requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
    const methodKey = method + " " + pathname;
    methodCounts.set(methodKey, (methodCounts.get(methodKey) ?? 0) + 1);
    if (method !== "GET") nonGetRequests += 1;
    if (method === "GET" && dangerousPath.test(pathname)) dangerousGetRequests += 1;
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Only GET or HEAD permitted");
      return;
    }
    if (pathname === "/health" || pathname === "/metrics") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pathname === "/health" ? { ready: true, scope: "local-synthetic-fixture-v2" }
        : { nonGetRequests, dangerousGetRequests, requestCounts: Object.fromEntries(requestCounts),
          methodCounts: Object.fromEntries(methodCounts) }));
      return;
    }
    const resource = pathname === "/" ? ["index.html", "text/html; charset=utf-8"]
      : allowed.test(pathname) ? ["index.html", "text/html; charset=utf-8"] : resources.get(pathname);
    if (!resource) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    try {
      const bytes = await readFile(join(here, resource[0]));
      res.writeHead(200, { "content-type": resource[1] });
      res.end(method === "HEAD" ? undefined : bytes);
    } catch {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Unavailable local fixture");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return {
    origin: "http://127.0.0.1:" + address.port,
    metrics: () => ({ nonGetRequests, dangerousGetRequests,
      requestCounts: Object.fromEntries(requestCounts), methodCounts: Object.fromEntries(methodCounts) }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const rawPort = process.env.TVDOCTOR_LAB_V2_PORT ?? "4191";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid TVDOCTOR_LAB_V2_PORT");
  const lab = await startLabV2({ port });
  process.stdout.write("TVDoctor lab v2: " + lab.origin + "/knowledge\n");
  const stop = () => { void lab.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
