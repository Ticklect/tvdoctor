import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runPublicRouteHealthRegression, type PublicRouteHealthRegressionResult } from "./public-route-health-regression.js";
import { verifySpaRouteHealth, type SpaRouteHealthConfig } from "./spa-route-health.js";

const SHA = /^[0-9a-f]{64}$/u;
const CAVEAT = "ROUTE_CONTENT_RESTORED means an independently SHA-pinned blank SPA original was followed by two separate fresh Chromium observations of the exact authored visible destination content, with complete fresh non-interactive source-page QA between them and zero VERIFIED findings. REVIEW, intentional empty states, unvisited actions, authentication, and unrelated flows remain unverified. An HTTP 200 or a missing heuristic finding never establishes a repair.";

interface Verification { readonly status: "ROUTE_CONTENT_RESTORED" | "REPRODUCED" | "INCONCLUSIVE" | "NOT_RUN";
  readonly artifact: "verification/verification.json" | "post-regression-verification/verification.json" | null }
interface Regression { readonly status: "COMPLETED" | "INCOMPLETE" | "FAILED" | "NOT_RUN";
  readonly verified: number; readonly review: number; readonly untested: number;
  readonly reportSha256: string | null; readonly artifact: "regression/qa-summary.json" | null }

export interface SpaRouteHealthAcceptResult {
  readonly schemaVersion: "tvdoctor.spa-route-health-accept/v1";
  readonly status: "ROUTE_CONTENT_RESTORED" | "REPRODUCED" | "NEW_VERIFIED" | "INCONCLUSIVE" | "ERROR";
  readonly exitCode: 0 | 1 | 2 | 3 | 4;
  readonly shouldFail: boolean;
  readonly originalSha256: string | null;
  readonly reason: string | null;
  readonly verification: Verification;
  readonly regression: Regression;
  readonly postRegressionVerification: Verification;
  readonly caveat: string;
}

export interface SpaRouteHealthAcceptOptions {
  readonly authorized: boolean;
  readonly route: SpaRouteHealthConfig;
  readonly originalPath: string;
  readonly expectedOriginalSha256: string;
  readonly outputRoot: string;
  readonly executeQa: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  readonly checkAuthoredConfig?: () => Promise<boolean>;
  /** Test-only injection seam. Production uses real independent Chromium. */
  readonly executeVerify?: typeof verifySpaRouteHealth;
  readonly executeRegression?: typeof runPublicRouteHealthRegression;
}

function inside(parent: string, path: string): boolean {
  const relativePath = relative(parent, path);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}
function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function safeFile(path: string, max: number): Promise<Buffer | null> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > max
      || await realpath(path) !== path) return null;
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || bytes.length !== before.size || await realpath(path) !== path) return null;
    return bytes;
  } catch { return null; }
}
async function originalUnchanged(path: string, digest: string): Promise<boolean> {
  try {
    if (!isAbsolute(path) || basename(path) !== "original.json" || !SHA.test(digest)) return false;
    const directory = dirname(path);
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(directory) !== directory) return false;
    const bytes = await safeFile(path, 8_192);
    return bytes !== null && sha(bytes) === digest;
  } catch { return false; }
}
async function verifyArtifact(root: string, stage: "verification" | "post-regression-verification",
  expected: Awaited<ReturnType<typeof verifySpaRouteHealth>>): Promise<boolean> {
  try {
    const directory = join(root, stage);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) return false;
    const data = await safeFile(join(directory, "verification.json"), 8_192);
    return data !== null && JSON.stringify(JSON.parse(data.toString("utf8"))) === JSON.stringify(expected);
  } catch { return false; }
}
async function regressionArtifact(root: string, expected: PublicRouteHealthRegressionResult): Promise<boolean> {
  try {
    if (expected.reportSha256 === null || !SHA.test(expected.reportSha256)) return false;
    for (const directory of [join(root, "regression"), join(root, "regression", "original")]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) return false;
    }
    const bytes = await safeFile(join(root, "regression", "original", "report.json"), 16 * 1024 * 1024);
    const summary = await safeFile(join(root, "regression", "qa-summary.json"), 128 * 1024);
    if (bytes === null || summary === null || sha(bytes) !== expected.reportSha256) return false;
    const parsed: unknown = JSON.parse(summary.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("summary" in parsed)) return false;
    const counts = parsed.summary;
    return counts !== null && typeof counts === "object" && !Array.isArray(counts)
      && "verified" in counts && counts.verified === expected.verified
      && "review" in counts && counts.review === expected.review
      && "untested" in counts && counts.untested === expected.untested;
  } catch { return false; }
}
function response(code: SpaRouteHealthAcceptResult["exitCode"], reason: string | null, pin: string | null,
  verification: Verification, regression: Regression, final: Verification): SpaRouteHealthAcceptResult {
  const status = code === 0 ? "ROUTE_CONTENT_RESTORED" : code === 1
    ? verification.status === "REPRODUCED" || final.status === "REPRODUCED" ? "REPRODUCED" : "NEW_VERIFIED"
    : code === 4 ? "ERROR" : "INCONCLUSIVE";
  return { schemaVersion: "tvdoctor.spa-route-health-accept/v1", status, exitCode: code,
    shouldFail: code !== 0, originalSha256: pin, reason, verification,
    regression, postRegressionVerification: final, caveat: CAVEAT };
}

/**
 * Exact original blank SPA witness + two independent positive checks, with a
 * complete fresh source-page QA in between. Not a general site-safety verdict.
 */
export async function runSpaRouteHealthAcceptance(options: SpaRouteHealthAcceptOptions): Promise<SpaRouteHealthAcceptResult> {
  let first: Verification = { status: "NOT_RUN", artifact: null };
  let final: Verification = { status: "NOT_RUN", artifact: null };
  let regression: Regression = { status: "NOT_RUN", verified: 0, review: 0, untested: 0,
    reportSha256: null, artifact: null };
  const reply = (code: SpaRouteHealthAcceptResult["exitCode"], reason: string | null) =>
    response(code, reason, SHA.test(options?.expectedOriginalSha256 ?? "") ? options.expectedOriginalSha256 : null,
      first, regression, final);
  if (options?.authorized !== true || typeof options.outputRoot !== "string"
    || !isAbsolute(options.outputRoot) || typeof options.originalPath !== "string"
    || !isAbsolute(options.originalPath) || !SHA.test(options.expectedOriginalSha256)
    || typeof options.executeQa !== "function") return reply(2, "invalid-or-unauthorized-options");
  const root = resolve(options.outputRoot);
  const source = resolve(options.originalPath);
  if (inside(dirname(source), root) || inside(root, dirname(source))) return reply(2, "output-overlaps-original");
  if (!await originalUnchanged(source, options.expectedOriginalSha256)) return reply(3, "original-evidence-unavailable-or-changed");
  if (options.checkAuthoredConfig !== undefined && !await options.checkAuthoredConfig()) return reply(3, "authored-config-changed");
  try {
    const parent = await lstat(dirname(root));
    if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(dirname(root)) !== dirname(root)) {
      return reply(4, "unsafe-output-parent");
    }
    await mkdir(root, { mode: 0o700 });
  } catch { return reply(4, "output-not-fresh-or-safe"); }
  let code: SpaRouteHealthAcceptResult["exitCode"] = 3;
  let reason: string | null;
  try {
    const runVerify = options.executeVerify ?? verifySpaRouteHealth;
    const original = await runVerify({ authorized: true, route: options.route,
      originalPath: source, expectedOriginalSha256: options.expectedOriginalSha256,
      outputRoot: join(root, "verification") });
    if (!await originalUnchanged(source, options.expectedOriginalSha256)
      || original.schemaVersion !== "tvdoctor.spa-route-health-verification/v1"
      || original.originalSha256 !== options.expectedOriginalSha256
      || original.regressionChecked !== false
      || !["ROUTE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE"].includes(original.classification)
      || !await verifyArtifact(root, "verification", original)) reason = "original-or-verification-evidence-invalid";
    else {
      first = { status: original.classification, artifact: "verification/verification.json" };
      if (original.classification === "INCONCLUSIVE") reason = "independent-spa-proof-inconclusive";
      else {
        const fresh = await (options.executeRegression ?? runPublicRouteHealthRegression)({
          target: new URL(options.route.sourcePath, options.route.baseUrl).href,
          outputRoot: join(root, "regression"), executeQa: options.executeQa,
        });
        regression = { status: fresh.status, verified: fresh.verified, review: fresh.review,
          untested: fresh.untested, reportSha256: fresh.reportSha256,
          artifact: fresh.summaryPath === null ? null : "regression/qa-summary.json" };
        if (!await originalUnchanged(source, options.expectedOriginalSha256)
          || !await verifyArtifact(root, "verification", original)) reason = "source-or-verification-changed";
        else if (original.classification === "REPRODUCED") {
          code = 1; reason = "blank-spa-route-still-reproduced";
        } else if (fresh.status !== "COMPLETED") reason = "fresh-qa-incomplete-or-invalid";
        else if (!await regressionArtifact(root, fresh)) reason = "fresh-qa-evidence-changed";
        else if (fresh.verified > 0) { code = 1; reason = "fresh-verified-defect-observed"; }
        else {
          const post = await runVerify({ authorized: true, route: options.route,
            originalPath: source, expectedOriginalSha256: options.expectedOriginalSha256,
            outputRoot: join(root, "post-regression-verification") });
          if (!await originalUnchanged(source, options.expectedOriginalSha256)
            || !await verifyArtifact(root, "verification", original)
            || !await regressionArtifact(root, fresh)
            || post.schemaVersion !== "tvdoctor.spa-route-health-verification/v1"
            || post.originalSha256 !== options.expectedOriginalSha256
            || post.regressionChecked !== false
            || !await verifyArtifact(root, "post-regression-verification", post)) {
            reason = "post-regression-spa-evidence-invalid";
          } else {
            final = { status: post.classification, artifact: "post-regression-verification/verification.json" };
            if (post.classification === "ROUTE_CONTENT_RESTORED") { code = 0; reason = null; }
            else if (post.classification === "REPRODUCED") { code = 1; reason = "spa-route-broken-again"; }
            else reason = "post-regression-spa-state-inconclusive";
          }
        }
      }
    }
  } catch { code = 4; reason = "spa-acceptance-execution-failed"; }
  if (!await originalUnchanged(source, options.expectedOriginalSha256)) { code = 3; reason = "original-evidence-changed"; }
  if (options.checkAuthoredConfig !== undefined && !await options.checkAuthoredConfig()) {
    code = 3; reason = "authored-config-changed";
  }
  if (code === 0 && (first.status !== "ROUTE_CONTENT_RESTORED" || final.status !== "ROUTE_CONTENT_RESTORED"
    || regression.status !== "COMPLETED" || regression.verified !== 0)) {
    code = 3; reason = "positive-or-regression-proof-missing";
  }
  const result = reply(code, reason);
  try {
    await writeFile(join(root, "spa-route-health-accept.json"), JSON.stringify(result, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    return result;
  } catch { return reply(4, "acceptance-summary-write-failed"); }
}
