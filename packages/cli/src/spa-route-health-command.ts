import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { CliContext } from "./cli.js";
import { captureSpaRouteHealthOriginal, verifySpaRouteHealth,
  type SpaRouteHealthConfig } from "./spa-route-health.js";
import { runSpaRouteHealthAcceptance } from "./spa-route-health-accept.js";

const SHA = /^[0-9a-f]{64}$/u;
const CAVEAT = "This check covers one authorised, exact public document GET followed by a client-side History route. Capture establishes a source-pinned blank destination, not a proven bug. Standalone verification checks separately authored healthy content but NOT fresh regression QA. Only `accept` combines independent corrected-state proof, fresh bounded QA and a final browser recheck. Intentional empty views, other routes, credentials, and untested behaviour remain outside scope. Clicking a safe-looking link can still have side effects.";

export const SPA_ROUTE_HEALTH_HELP = `Usage:
  tvdoctor spa-route-health capture --config SPA.json --authorized --output NEW_DIR [--json]
  tvdoctor spa-route-health verify --config SPA.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIR [--json]
  tvdoctor spa-route-health accept --config SPA.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIR [--json]

SPA.json is a private, independently authored configuration:
  {"schemaVersion":"tvdoctor.spa-route-health-config/v1",
   "baseUrl":"http://127.0.0.1:3000/","sourcePath":"/workspace",
   "destinationPath":"/library","linkName":"Open library",
   "heading":"Library","expectedMainTextSha256":"64_lowercase_hex_digits"}

Source must be an explicitly authorised unauthenticated HTML document GET.
Capture requires an actual stable, visible, substantive source MAIN and exactly
one same-document History link transition to a persistently blank destination.
The source's correct healthy content must be authored independently of capture.
Keep the saved original.json and returned SHA-256 unchanged. The server may be
localhost or a private development instance; it need not be on the public internet.
Standalone verify does NOT prove regression safety. Accept separately runs public
read-only QA against the same source, validates its saved artifacts and repeats
positive SPA verification AFTER QA. Only then can ROUTE_CONTENT_RESTORED be claimed.
HTTP 200 alone, no longer seeing a REVIEW lead, or a newly visible heading
cannot certify FIXED or a complete regression PASS.
Do not use on production stateful flows: apparently safe GET/link clicks may mutate.
Exit: capture 1 negative original found; verify 0 positive route restored;
      accept 0 independently restored+regression complete; 1 failure observed;
      2 invalid options, 3 inconclusive, 4 execution error.`;

interface Parsed { readonly action: "capture" | "verify" | "accept";
  readonly config: string; readonly output: string; readonly original: string | null;
  readonly sha256: string | null; readonly json: boolean }

function argumentsFor(args: readonly string[]): Parsed | null {
  const action = args[0];
  if (action !== "capture" && action !== "verify" && action !== "accept") return null;
  const fields = new Map<string, string>();
  let authorized = false;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--authorized" && !authorized) { authorized = true; continue; }
    if (flag === "--json" && !json) { json = true; continue; }
    if (!["--config", "--output", "--original", "--sha256"].includes(flag ?? "")
      || fields.has(flag ?? "")) return null;
    const value = args[i + 1];
    if (value === undefined || value.length < 1 || value.length > 4096
      || value.startsWith("--") || value.trim() !== value || value.includes("\0")) return null;
    fields.set(flag as string, value);
    i++;
  }
  const config = fields.get("--config");
  const output = fields.get("--output");
  const original = fields.get("--original") ?? null;
  const sha256 = fields.get("--sha256") ?? null;
  if (!authorized || config === undefined || output === undefined
    || (action === "capture" && (original !== null || sha256 !== null))
    || (action !== "capture" && (original === null || sha256 === null || !SHA.test(sha256)))) return null;
  return { action, config: resolve(config), output: resolve(output),
    original: original === null ? null : resolve(original), sha256, json };
}

async function readConfig(path: string): Promise<{ route: SpaRouteHealthConfig; sha256: string }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > 4096
    || await realpath(path) !== path) throw new Error("unsafe-config");
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (bytes.length !== before.size || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("changed-config");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-config");
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).sort().join("|") !== ["schemaVersion", "baseUrl", "sourcePath", "destinationPath",
    "linkName", "heading", "expectedMainTextSha256"].sort().join("|")
    || obj["schemaVersion"] !== "tvdoctor.spa-route-health-config/v1"
    || ["baseUrl", "sourcePath", "destinationPath", "linkName", "heading"].some((key) =>
      typeof obj[key] !== "string" || (obj[key] as string).length < 1 || (obj[key] as string).length > 512)
    || typeof obj["expectedMainTextSha256"] !== "string"
    || !SHA.test(obj["expectedMainTextSha256"])) throw new Error("invalid-config-fields");
  return { route: { baseUrl: obj["baseUrl"] as string,
    sourcePath: obj["sourcePath"] as string, destinationPath: obj["destinationPath"] as string,
    linkName: obj["linkName"] as string, heading: obj["heading"] as string,
    expectedMainTextSha256: obj["expectedMainTextSha256"] as string },
  sha256: createHash("sha256").update(bytes).digest("hex") };
}

function output(context: CliContext, json: boolean, status: string, code: number,
  reason: string | null, originalSha256: string | null, regressionChecked = false): number {
  const result = { schemaVersion: "tvdoctor.spa-route-health-command/v1", status,
    exitCode: code, shouldFail: code !== 0, reason, originalSha256, regressionChecked, caveat: CAVEAT };
  if (json) context.io.writeStdout(JSON.stringify(result) + "\n");
  else {
    context.io.writeStdout(`SPA route health ${status}.\n`);
    if (originalSha256 !== null) context.io.writeStdout(`Original SHA-256: ${originalSha256}\n`);
    context.io.writeStdout(CAVEAT + "\n");
  }
  return code;
}

export async function runSpaRouteHealthCommand(args: readonly string[], context: CliContext,
  executeQa?: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    context.io.writeStdout(SPA_ROUTE_HEALTH_HELP + "\n");
    return 0;
  }
  const parsed = argumentsFor(args);
  if (parsed === null) return output(context, args.includes("--json"), "INCONCLUSIVE", 2,
    "invalid-spa-route-health-options", null);
  let input: Awaited<ReturnType<typeof readConfig>>;
  try { input = await readConfig(parsed.config); }
  catch { return output(context, parsed.json, "INCONCLUSIVE", 2, "invalid-spa-route-health-config", null); }
  const unchanged = async (): Promise<boolean> => {
    try { return (await readConfig(parsed.config)).sha256 === input.sha256; }
    catch { return false; }
  };
  try {
    if (parsed.action === "accept") {
      if (executeQa === undefined) return output(context, parsed.json, "INCONCLUSIVE", 4,
        "independent-regression-runner-unavailable", null);
      const outcome = await runSpaRouteHealthAcceptance({ authorized: true, route: input.route,
        originalPath: parsed.original as string, expectedOriginalSha256: parsed.sha256 as string,
        outputRoot: parsed.output, executeQa, checkAuthoredConfig: unchanged });
      if (parsed.json) context.io.writeStdout(JSON.stringify(outcome) + "\n");
      else {
        context.io.writeStdout(`SPA route acceptance ${outcome.status}.\n`);
        context.io.writeStdout(`Original ${outcome.verification.status}; QA ${outcome.regression.status}: ${String(outcome.regression.verified)} VERIFIED, ${String(outcome.regression.review)} REVIEW, ${String(outcome.regression.untested)} UNTESTED.\n`);
        context.io.writeStdout(outcome.caveat + "\n");
      }
      return outcome.exitCode;
    }
    if (parsed.action === "capture") {
      const witness = await captureSpaRouteHealthOriginal({ authorized: true, route: input.route, outputRoot: parsed.output });
      if (!await unchanged()) return output(context, parsed.json, "INCONCLUSIVE", 3,
        "authored-config-changed", null);
      return output(context, parsed.json, witness.classification,
        witness.classification === "VERIFIED_ORIGINAL" ? 1 : 3, witness.reason, witness.originalSha256);
    }
    const witness = await verifySpaRouteHealth({ authorized: true, route: input.route,
      originalPath: parsed.original as string, expectedOriginalSha256: parsed.sha256 as string,
      outputRoot: parsed.output });
    if (!await unchanged()) return output(context, parsed.json, "INCONCLUSIVE", 3,
      "authored-config-changed", null);
    return output(context, parsed.json, witness.classification,
      witness.classification === "ROUTE_CONTENT_RESTORED" ? 0
        : witness.classification === "REPRODUCED" ? 1 : 3,
      witness.reason, witness.originalSha256);
  } catch { return output(context, parsed.json, "INCONCLUSIVE", 4,
    "spa-route-health-execution-failed", null); }
}
