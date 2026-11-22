import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { CliContext } from "./cli.js";
import type { BootHealthConfig } from "./boot-health.js";
import { runBootHealthCapture, runBootHealthVerify } from "./boot-health.js";
import { runBootHealthAccept } from "./boot-health-accept.js";

const SHA = /^[0-9a-f]{64}$/u;
const REASON = /^[a-z][a-z0-9-]{0,159}$/u;
const PATH = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;
const DANGEROUS_ROUTE = /(?:^|\/)(?:api|auth|login|logout|signin|signout|checkout|cart|buy|purchase|pay|payment|subscribe|delete|remove|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order)(?:\/|$)/iu;
const UNSAFE_HEADING = /[<>\\@\p{Cc}\p{Cf}]|(?:https?:\/\/|www\.|javascript:|data:|\b(?:password|secret|token|credential|apikey|api.key|private.key)\b)/iu;
const MAX_CONFIG_BYTES = 4_096;
const MAX_PUBLIC_BYTES = 32 * 1024;
const CAVEAT = "Only one explicitly authorised HTTP 200 document is checked. An original blank MAIN is negative evidence, not proof that an application is defective. Standalone verification checks independently authored visible main content but does NOT establish regression safety. Only acceptance can report PAGE_CONTENT_RESTORED after positive fresh browser checks both before and after separately verified, non-interactive QA. REVIEW and unvisited states remain unresolved. A GET may still cause side effects; use only disposable development/test targets.";

export const BOOT_HEALTH_HELP = `Usage:
  tvdoctor boot-health capture --config BOOT.json --authorized --output NEW_DIR [--json]
  tvdoctor boot-health verify --config BOOT.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIR [--json]
  tvdoctor boot-health accept --config BOOT.json --original ORIGINAL.json --sha256 HEX --authorized --output NEW_DIR [--json]

BOOT.json must be a small, private, independently authored JSON object:
  {"schemaVersion":"tvdoctor.boot-health-config/v1",
   "baseUrl":"http://127.0.0.1:3000/","path":"/dashboard",
   "heading":"Dashboard","expectedMainTextSha256":"64_lowercase_hex_digits"}

Capture requires one exact, unredirected HTTP 200 HTML GET and independently
observed persistently blank visible MAIN after bounded hydration checks.
The original witness SHA-256 and original.json must be kept unchanged.
An uncaught startup exception alone is not proof that the UI crashed.
Verify separately checks a unique visible heading and the SHA-256 of complete,
independently authored healthy MAIN text in a fresh browser. Its standalone
positive PAGE_CONTENT_RESTORED result does not check for new regressions.
Accept independently verifies repaired content, performs a fresh non-interactive
public QA scan, then rechecks the repaired content AFTER QA. Only complete
evidence permits PAGE_CONTENT_RESTORED. Never infer repair from HTTP 200,
the absence of a console exception, or a missing REVIEW finding.
Do not submit credentials, sensitive content or production mutation routes.
Exit: 0 standalone healthy verification or complete independent acceptance;
      1 negative original captured or original failure reproduced/new VERIFIED;
      2 invalid usage/config; 3 inconclusive; 4 unexpected execution error.`;

type Action = "capture" | "verify" | "accept";
interface ParsedArgs {
  readonly action: Action;
  readonly configPath: string;
  readonly outputRoot: string;
  readonly originalPath: string | null;
  readonly originalSha256: string | null;
  readonly json: boolean;
}
interface SavedConfig {
  readonly route: BootHealthConfig;
  readonly sha256: string;
}
type ExecuteQa = (args: readonly string[]) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
}>;

function parseArguments(args: readonly string[]): ParsedArgs | null {
  const action = args[0];
  if (action !== "capture" && action !== "verify" && action !== "accept") return null;
  const values = new Map<string, string>();
  let authorized = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--authorized" && !authorized) { authorized = true; continue; }
    if (flag === "--json" && !json) { json = true; continue; }
    if (!["--config", "--output", "--original", "--sha256"].includes(flag ?? "")
      || values.has(flag ?? "")) return null;
    const value = args[index + 1];
    if (typeof value !== "string" || value.length < 1 || value.length > 4_096
      || value.startsWith("--") || value.trim() !== value || value.includes("\0")
      || [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)) return null;
    values.set(flag as string, value);
    index++;
  }
  const config = values.get("--config");
  const output = values.get("--output");
  const original = values.get("--original") ?? null;
  const sha = values.get("--sha256") ?? null;
  if (!authorized || config === undefined || output === undefined
    || (action === "capture" && (original !== null || sha !== null))
    || (action !== "capture" && (original === null || sha === null || !SHA.test(sha)))) {
    return null;
  }
  return { action, configPath: resolve(config), outputRoot: resolve(output),
    originalPath: original === null ? null : resolve(original), originalSha256: sha, json };
}

function sameOrNested(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function distinctOutput(args: ParsedArgs): boolean {
  // Never allow a new run to overwrite the config, an existing original, or
  // their parents. The engine independently enforces create-only artifacts.
  return !sameOrNested(args.outputRoot, args.configPath)
    && !sameOrNested(args.configPath, args.outputRoot)
    && (args.originalPath === null || (!sameOrNested(args.outputRoot, args.originalPath)
      && !sameOrNested(dirname(args.originalPath), args.outputRoot)));
}

function validatedRoute(value: unknown): BootHealthConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("invalid-object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join("|") !== [
    "schemaVersion", "baseUrl", "path", "heading", "expectedMainTextSha256",
  ].sort().join("|") || object["schemaVersion"] !== "tvdoctor.boot-health-config/v1") {
    throw Error("invalid-fields");
  }
  const { baseUrl, path, heading, expectedMainTextSha256 } = object;
  if (typeof baseUrl !== "string" || baseUrl.length < 1 || baseUrl.length > 2_048
    || typeof path !== "string" || path.length < 1 || path.length > 512
    || !PATH.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")
    || DANGEROUS_ROUTE.test(path)
    || typeof heading !== "string" || heading.length < 1 || heading.length > 128
    || heading.trim() !== heading || UNSAFE_HEADING.test(heading)
    || typeof expectedMainTextSha256 !== "string" || !SHA.test(expectedMainTextSha256)) {
    throw Error("invalid-route-fields");
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw Error("invalid-origin"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || url.pathname !== "/" || url.href !== `${url.origin}/`
    || (baseUrl !== url.origin && baseUrl !== url.href)
    || new URL(path, url).pathname !== path) throw Error("unsafe-origin-or-path");
  return { baseUrl, path, heading, expectedMainTextSha256 };
}

async function readConfig(path: string): Promise<SavedConfig> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096) throw Error("unsafe-path");
  const first = await lstat(path);
  if (!first.isFile() || first.isSymbolicLink() || first.size < 2
    || first.size > MAX_CONFIG_BYTES || await realpath(path) !== path) throw Error("unsafe-config");
  const bytes = await readFile(path);
  const last = await lstat(path);
  if (!last.isFile() || last.isSymbolicLink() || bytes.length !== first.size
    || last.ino !== first.ino || last.size !== first.size || last.mtimeMs !== first.mtimeMs
    || await realpath(path) !== path) throw Error("changed-config");
  return { route: validatedRoute(JSON.parse(bytes.toString("utf8")) as unknown),
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function configUnchanged(path: string, pin: string): Promise<boolean> {
  try { return (await readConfig(path)).sha256 === pin; }
  catch { return false; }
}

function safeReason(value: unknown): string | null {
  return typeof value === "string" && REASON.test(value) ? value : null;
}

function result(context: CliContext, json: boolean, status: string, exitCode: 0 | 1 | 2 | 3 | 4,
  reason: string | null, originalSha256: string | null, regressionChecked = false): number {
  const report = { schemaVersion: "tvdoctor.boot-health-command/v1", status,
    exitCode, shouldFail: exitCode !== 0, reason, originalSha256, regressionChecked, caveat: CAVEAT };
  if (json) context.io.writeStdout(JSON.stringify(report) + "\n");
  else {
    context.io.writeStdout(`Boot health ${status}.\n`);
    if (originalSha256 !== null) context.io.writeStdout(`Original SHA-256: ${originalSha256}\n`);
    context.io.writeStdout(CAVEAT + "\n");
  }
  return exitCode;
}

function engineOutcome(classification: unknown, reason: unknown, originalSha256: unknown,
  action: "capture" | "verify", suppliedSha: string | null): {
    readonly status: string; readonly code: 0 | 1 | 3 | 4;
    readonly reason: string | null; readonly original: string | null;
  } {
  const original = typeof originalSha256 === "string" && SHA.test(originalSha256)
    ? originalSha256 : null;
  if (classification === "INCONCLUSIVE") return { status: "INCONCLUSIVE", code: 3,
    reason: safeReason(reason) ?? "source-evidence-incomplete", original };
  if (action === "capture" && classification === "VERIFIED_ORIGINAL"
    && original !== null && reason === null) {
    return { status: "VERIFIED_ORIGINAL", code: 1, reason: null, original };
  }
  if (action === "verify" && original === suppliedSha && reason === null
    && classification === "PAGE_CONTENT_RESTORED") {
    return { status: "PAGE_CONTENT_RESTORED", code: 0, reason: null, original };
  }
  if (action === "verify" && original === suppliedSha
    && classification === "REPRODUCED") {
    return { status: "REPRODUCED", code: 1,
      reason: safeReason(reason) ?? "original-blank-page-reproduced", original };
  }
  return { status: "INCONCLUSIVE", code: 3, reason: "invalid-boot-health-evidence", original: null };
}

function safeAcceptance(value: unknown, pin: string, input: SavedConfig,
  paths: ParsedArgs): { readonly exitCode: 0 | 1 | 2 | 3 | 4; readonly report: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const code = raw["exitCode"];
  const status = raw["status"];
  if (Object.keys(raw).sort().join("|") !== [
    "schemaVersion", "status", "exitCode", "shouldFail", "originalSha256",
    "reason", "verification", "regression", "postRegressionVerification", "caveat",
  ].sort().join("|")
    || raw["schemaVersion"] !== "tvdoctor.boot-health-accept/v1"
    || ![0, 1, 2, 3, 4].includes(code as number)
    || !["PAGE_CONTENT_RESTORED", "REPRODUCED", "NEW_VERIFIED", "INCONCLUSIVE", "ERROR"].includes(status as string)
    || raw["shouldFail"] !== (code !== 0)
    || (code === 0) !== (status === "PAGE_CONTENT_RESTORED")
    || (code === 1 && status !== "REPRODUCED" && status !== "NEW_VERIFIED")
    || (code === 3 && status !== "INCONCLUSIVE")
    || (code === 4 && status !== "ERROR")
    || (raw["originalSha256"] !== pin && raw["originalSha256"] !== null)
    || ((code === 0 || code === 1) && raw["originalSha256"] !== pin)
    || (raw["reason"] !== null && safeReason(raw["reason"]) === null)) return null;
  const verification = raw["verification"] as Record<string, unknown> | undefined;
  const regression = raw["regression"] as Record<string, unknown> | undefined;
  const final = raw["postRegressionVerification"] as Record<string, unknown> | undefined;
  const validStage = (stage: Record<string, unknown> | undefined, location: string) =>
    stage !== null && stage !== undefined
      && Object.keys(stage).sort().join("|") === "artifact|status"
      && ["PAGE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE", "NOT_RUN"].includes(stage["status"] as string)
      && (stage["artifact"] === null || stage["artifact"] === `${location}/verification.json`)
      && (stage["status"] === "NOT_RUN") === (stage["artifact"] === null);
  if (!validStage(verification, "verification")
    || !validStage(final, "post-regression-verification")
    || regression === null || regression === undefined
    || Object.keys(regression).sort().join("|") !== "artifact|reportSha256|review|status|untested|verified"
    || !["COMPLETED", "INCOMPLETE", "FAILED", "NOT_RUN"].includes(regression["status"] as string)
    || ![regression["verified"], regression["review"], regression["untested"]].every((count) =>
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000)
    || (regression["reportSha256"] !== null && (typeof regression["reportSha256"] !== "string"
      || !SHA.test(regression["reportSha256"])))
    || (regression["artifact"] !== null && regression["artifact"] !== "regression/qa-summary.json")
    || (regression["status"] === "NOT_RUN" && (regression["artifact"] !== null
      || regression["reportSha256"] !== null || regression["verified"] !== 0
      || regression["review"] !== 0 || regression["untested"] !== 0))
    || typeof raw["caveat"] !== "string" || raw["caveat"].length > 2_048) return null;
  if (code === 0) {
    if (verification?.["status"] !== "PAGE_CONTENT_RESTORED"
      || final?.["status"] !== "PAGE_CONTENT_RESTORED"
      || regression?.["status"] !== "COMPLETED" || regression["verified"] !== 0) return null;
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return null; }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PUBLIC_BYTES) return null;
  // The acceptance engine owns the source-checked summary. Never publish
  // user-authored URL/text/config or raw app/QA output even if a child returns it.
  const sensitive = [input.route.baseUrl, input.route.heading, paths.configPath,
    paths.outputRoot, paths.originalPath ?? "", new URL(input.route.path, input.route.baseUrl).href,
    ...(input.route.path === "/" ? [] : [input.route.path])];
  if (sensitive.some((needle) => needle !== "" && serialized.includes(needle))) return null;
  if (/(?:https?:\/\/|file:\/\/|[A-Za-z]:\\\\)/iu.test(serialized)) return null;
  const pathLiteral = JSON.stringify(input.route.path);
  if (serialized.includes(`"path":${pathLiteral}`)
    || serialized.includes(`"target":${pathLiteral}`)) return null;
  return { exitCode: code as 0 | 1 | 2 | 3 | 4, report: serialized };
}

/**
 * Thin public CLI boundary. No app URL, source text, private config path,
 * exception string or child stderr is exposed. Browser and QA provenance
 * remain the boot-health engine's responsibility.
 */
export async function runBootHealthCommand(
  args: readonly string[], context: CliContext, executeQa?: ExecuteQa,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    context.io.writeStdout(BOOT_HEALTH_HELP + "\n");
    return 0;
  }
  const parsed = parseArguments(args);
  if (parsed === null) return result(context, args.includes("--json"), "INCONCLUSIVE", 2,
    "invalid-boot-health-options", null);
  if (!distinctOutput(parsed)) return result(context, parsed.json, "INCONCLUSIVE", 2,
    "overlapping-boot-health-files", null);
  let input: SavedConfig;
  try { input = await readConfig(parsed.configPath); }
  catch { return result(context, parsed.json, "INCONCLUSIVE", 2, "invalid-boot-health-config", null); }
  const unchanged = async () => await configUnchanged(parsed.configPath, input.sha256);
  try {
    if (parsed.action === "accept") {
      if (executeQa === undefined) return result(context, parsed.json, "INCONCLUSIVE", 4,
        "independent-qa-unavailable", null);
      const accepted = await runBootHealthAccept({ authorized: true, route: input.route,
        originalPath: parsed.originalPath as string, expectedOriginalSha256: parsed.originalSha256 as string,
        outputRoot: parsed.outputRoot, executeQa, checkAuthoredConfig: unchanged });
      if (!await unchanged()) return result(context, parsed.json, "INCONCLUSIVE", 3,
        "authored-config-changed", null);
      const checked = safeAcceptance(accepted, parsed.originalSha256 as string, input, parsed);
      if (checked === null) return result(context, parsed.json, "INCONCLUSIVE", 3,
        "invalid-boot-acceptance-evidence", null);
      if (parsed.json) context.io.writeStdout(checked.report + "\n");
      else {
        context.io.writeStdout(`Boot health acceptance ${String(accepted.status)}.\n`);
        context.io.writeStdout(CAVEAT + "\n");
      }
      return checked.exitCode;
    }
    if (parsed.action === "capture") {
      const captured = await runBootHealthCapture({
        authorized: true, route: input.route, outputRoot: parsed.outputRoot,
      });
      if (!await unchanged()) return result(context, parsed.json, "INCONCLUSIVE", 3,
        "authored-config-changed", null);
      if (captured.schemaVersion !== "tvdoctor.boot-health-capture/v1") {
        return result(context, parsed.json, "INCONCLUSIVE", 3, "invalid-boot-health-evidence", null);
      }
      const checked = engineOutcome(captured.classification, captured.reason,
        captured.originalSha256, "capture", null);
      return result(context, parsed.json, checked.status, checked.code, checked.reason, checked.original);
    }
    const verified = await runBootHealthVerify({ authorized: true, route: input.route,
      originalPath: parsed.originalPath as string, expectedOriginalSha256: parsed.originalSha256 as string,
      outputRoot: parsed.outputRoot });
    if (!await unchanged()) return result(context, parsed.json, "INCONCLUSIVE", 3,
      "authored-config-changed", null);
    if (verified.schemaVersion !== "tvdoctor.boot-health-verification/v1") {
      return result(context, parsed.json, "INCONCLUSIVE", 3, "invalid-boot-health-evidence", null);
    }
    const checked = engineOutcome(verified.classification, verified.reason,
      verified.originalSha256, "verify", parsed.originalSha256);
    return result(context, parsed.json, checked.status, checked.code, checked.reason, checked.original);
  } catch {
    return result(context, parsed.json, "INCONCLUSIVE", 4, "boot-health-execution-failed", null);
  }
}
