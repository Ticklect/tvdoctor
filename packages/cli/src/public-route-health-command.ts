import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CliContext } from "./cli.js";
import {
  capturePublicRouteHealthOriginal,
  verifyPublicRouteHealth,
  type PublicRouteHealthRoute,
} from "./public-route-health.js";
import { runPublicRouteHealthAcceptance } from "./public-route-health-accept.js";

const SHA = /^[0-9a-f]{64}$/u;
const MAX_CONFIG = 4_096;
const CAVEAT = "A fixed route means one exact previously absent public document now returns an unredirected HTTP 200 with the independently authored visible main content. It does not prove authentication, the correctness of business behaviour, or whole-site health.";

export const PUBLIC_ROUTE_HEALTH_HELP = `Usage:
  tvdoctor route-health capture --config ROUTE.json --authorized --output NEW_DIR [--json]
  tvdoctor route-health verify --config ROUTE.json --original ORIGINAL.json --sha256 ORIGINAL_SHA256 --authorized --output NEW_DIR [--json]
  tvdoctor route-health accept --config ROUTE.json --original ORIGINAL.json --sha256 ORIGINAL_SHA256 --authorized --output NEW_DIR [--json]

ROUTE.json is a small user-owned tvdoctor.public-route-health-config/v1 object:
  {"schemaVersion":"tvdoctor.public-route-health-config/v1",
   "baseUrl":"http://127.0.0.1:3000/", "path":"/invoices",
   "heading":"Invoices", "expectedMainTextSha256":"64_lowercase_hex_digits"}

Capture requires an actual Chromium main-document GET with HTTP 404/410, no
redirect, exact public route and explicit authorization. Only then is the
original witness written to the new directory. Keep that original.json and
the returned SHA-256 unchanged; verification requires both, independently
opens a fresh Chromium context, and fails closed on changed route or content.
The expected MAIN text fingerprint must be computed from the expected healthy
page source, never guessed from a missing page or observed after a repair:
SHA256(NFKC(text).replace(/\\s+/g, " ").trim()).

Standalone FIXED verifies just the authored document-route assertion: it does
NOT run fresh regression QA and cannot be described as project acceptance.
Acceptance separately invokes public non-interactive QA in a new, source-checked
directory with the same exact target, and can report ROUTE_RESTORED only when
the original is independently FIXED and the fresh QA completes with zero
VERIFIED findings. REVIEW leads do not become FIXED and are reported as counts.
Only authorized disposable development/test targets; even GET may have side effects.
Exit: capture 1 original captured; verify 0 FIXED, 1 REPRODUCED;
      accept 0 ROUTE_RESTORED, 1 REPRODUCED/NEW_VERIFIED;
      2 usage, 3 inconclusive, 4 unexpected execution failure.`;

interface ConfigFile extends PublicRouteHealthRoute {
  readonly schemaVersion: "tvdoctor.public-route-health-config/v1";
}
interface Arguments {
  readonly action: "capture" | "verify" | "accept";
  readonly config: string;
  readonly output: string;
  readonly original: string | null;
  readonly originalSha: string | null;
  readonly json: boolean;
}

function parseArguments(args: readonly string[]): Arguments | null {
  const action = args[0];
  if (action !== "capture" && action !== "verify" && action !== "accept") return null;
  const values = new Map<string, string>();
  let json = false;
  let authorized = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--json" && !json) { json = true; continue; }
    if (flag === "--authorized" && !authorized) { authorized = true; continue; }
    if (!["--config", "--original", "--sha256", "--output"].includes(flag ?? "")
      || values.has(flag ?? "")) return null;
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.length > 4096
      || value.startsWith("--") || value.trim() !== value || value.includes("\0")) return null;
    values.set(flag as string, value);
    index += 1;
  }
  const config = values.get("--config");
  const output = values.get("--output");
  const original = values.get("--original") ?? null;
  const originalSha = values.get("--sha256") ?? null;
  if (!authorized || config === undefined || output === undefined
    || (action === "capture" && (original !== null || originalSha !== null))
    || ((action === "verify" || action === "accept") && (original === null || originalSha === null
      || !SHA.test(originalSha)))) return null;
  return { action, config: resolve(config), output: resolve(output),
    original: original === null ? null : resolve(original), originalSha, json };
}

async function boundedConfig(path: string): Promise<{ route: PublicRouteHealthRoute; digest: string }> {
  if (!isAbsolute(path)) throw new Error("invalid-config-path");
  const first = await lstat(path);
  if (!first.isFile() || first.isSymbolicLink() || first.size < 1
    || first.size > MAX_CONFIG || await realpath(path) !== path) {
    throw new Error("unsafe-config-file");
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (bytes.length !== first.size || after.size !== first.size
    || after.ino !== first.ino || after.mtimeMs !== first.mtimeMs) {
    throw new Error("changed-config-file");
  }
  const input: unknown = JSON.parse(bytes.toString("utf8")) as unknown;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid-config");
  }
  const value = input as Record<string, unknown>;
  const keys = ["schemaVersion", "baseUrl", "path", "heading", "expectedMainTextSha256"];
  if (Object.keys(value).sort().join("|") !== keys.sort().join("|")
    || value["schemaVersion"] !== "tvdoctor.public-route-health-config/v1"
    || typeof value["baseUrl"] !== "string" || typeof value["path"] !== "string"
    || typeof value["heading"] !== "string"
    || typeof value["expectedMainTextSha256"] !== "string"
    || !SHA.test(value["expectedMainTextSha256"])) throw new Error("invalid-config-fields");
  const config = value as unknown as ConfigFile;
  return { route: { baseUrl: config.baseUrl, path: config.path, heading: config.heading,
    expectedMainTextSha256: config.expectedMainTextSha256 },
  digest: createHash("sha256").update(bytes).digest("hex") };
}

async function configUnchanged(path: string, digest: string): Promise<boolean> {
  try { return (await boundedConfig(path)).digest === digest; }
  catch { return false; }
}

function publish(context: CliContext, json: boolean, status: string,
  exitCode: number, reason: string | null, originalSha256: string | null,
  regressionChecked = false): number {
  const publicResult = { schemaVersion: "tvdoctor.public-route-health-command/v1", status,
    exitCode, shouldFail: exitCode !== 0, reason, originalSha256,
    regressionChecked, caveat: CAVEAT };
  if (json) context.io.writeStdout(JSON.stringify(publicResult) + "\n");
  else {
    context.io.writeStdout(`Route-health ${status}.\n`);
    if (originalSha256 !== null) context.io.writeStdout(`Original witness SHA-256: ${originalSha256}\n`);
    context.io.writeStdout(`${CAVEAT}\n`);
  }
  return exitCode;
}

/** CLI boundary: no untrusted app text, route URLs or local paths in public output. */
export async function runPublicRouteHealthCommand(
  args: readonly string[], context: CliContext,
  executeQa?: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>,
): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) {
    context.io.writeStdout(PUBLIC_ROUTE_HEALTH_HELP + "\n");
    return 0;
  }
  const parsed = parseArguments(args);
  if (parsed === null) {
    if (args.includes("--json")) {
      return publish(context, true, "INCONCLUSIVE", 2, "invalid-route-health-options", null);
    }
    context.io.writeStderr("Invalid route-health usage. See tvdoctor route-health --help.\n");
    return 2;
  }
  let input: Awaited<ReturnType<typeof boundedConfig>>;
  try { input = await boundedConfig(parsed.config); }
  catch { return publish(context, parsed.json, "INCONCLUSIVE", 2, "invalid-public-route-config", null); }
  try {
    if (parsed.action === "accept") {
      if (executeQa === undefined) {
        return publish(context, parsed.json, "INCONCLUSIVE", 4, "independent-regression-runner-unavailable", null);
      }
      const result = await runPublicRouteHealthAcceptance({
        authorized: true, route: input.route, outputRoot: parsed.output,
        originalPath: parsed.original as string,
        expectedOriginalSha256: parsed.originalSha as string,
        executeQa, checkAuthoredConfig: async () => await configUnchanged(parsed.config, input.digest),
      });
      if (parsed.json) context.io.writeStdout(JSON.stringify(result) + "\n");
      else {
        context.io.writeStdout(`Route-health acceptance ${result.status}.\n`);
        context.io.writeStdout(`Original ${result.verification.status}; fresh regression ${result.regression.status}: ${String(result.regression.verified)} VERIFIED, ${String(result.regression.review)} REVIEW, ${String(result.regression.untested)} UNTESTED.\n`);
        context.io.writeStdout(result.caveat + "\n");
      }
      return result.exitCode;
    }
    if (parsed.action === "capture") {
      const result = await capturePublicRouteHealthOriginal({
        route: input.route, outputRoot: parsed.output, authorized: true,
      });
      if (!await configUnchanged(parsed.config, input.digest)) {
        return publish(context, parsed.json, "INCONCLUSIVE", 3, "config-changed-during-capture", null);
      }
      return publish(context, parsed.json, result.classification,
        result.classification === "VERIFIED_ORIGINAL" ? 1 : 3,
        result.reason, result.originalSha256);
    }
    const result = await verifyPublicRouteHealth({
      route: input.route, outputRoot: parsed.output, authorized: true,
      originalPath: parsed.original as string, expectedOriginalSha256: parsed.originalSha as string,
    });
    if (!await configUnchanged(parsed.config, input.digest)) {
      return publish(context, parsed.json, "INCONCLUSIVE", 3, "config-changed-during-verification", null);
    }
    return publish(context, parsed.json, result.classification,
      result.classification === "FIXED" ? 0 : result.classification === "REPRODUCED" ? 1 : 3,
      result.reason, result.originalSha256);
  } catch {
    return publish(context, parsed.json, "INCONCLUSIVE", 4, "route-health-execution-failed", null);
  }
}
