import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  verifyPublicRouteHealth,
  type PublicRouteHealthRoute,
  type PublicRouteHealthVerifyResult,
  type PublicRouteHealthBrowserFactory,
} from "./public-route-health.js";
import {
  runPublicRouteHealthRegression,
  type PublicRouteHealthRegressionResult,
} from "./public-route-health-regression.js";

const SHA = /^[0-9a-f]{64}$/u;
const MAX_WITNESS = 4_096;
const MAX_VERIFICATION = 4_096;
const CAVEAT = "ROUTE_RESTORED means the original exact public HTTP404/410 was independently checked against authored healthy content, a separate bounded non-interactive QA scan found zero VERIFIED issues, and the route was reverified after that scan. REVIEW and UNTESTED observations remain unresolved. This is not an authentication proof, whole-site guarantee, or verification of unrelated business actions.";

export interface PublicRouteHealthAcceptOptions {
  readonly authorized: boolean;
  readonly route: PublicRouteHealthRoute;
  readonly originalPath: string;
  readonly expectedOriginalSha256: string;
  readonly outputRoot: string;
  readonly executeQa: (args: readonly string[]) => Promise<{
    readonly exitCode: number; readonly stdout: string;
  }>;
  /** Trusted CLI-supplied current-config SHA check, re-evaluated before PASS. */
  readonly checkAuthoredConfig?: () => Promise<boolean>;
  /** Isolation seam for unit tests; production always uses independent Chromium. */
  readonly createBrowser?: PublicRouteHealthBrowserFactory;
  /** Internal composition seam; does not replace the production default. */
  readonly executeVerify?: typeof verifyPublicRouteHealth;
  readonly executeRegression?: typeof runPublicRouteHealthRegression;
}

export interface PublicRouteHealthAcceptResult {
  readonly schemaVersion: "tvdoctor.public-route-health-accept/v1";
  readonly status: "ROUTE_RESTORED" | "REPRODUCED" | "NEW_VERIFIED" | "INCONCLUSIVE" | "ERROR";
  readonly exitCode: 0 | 1 | 2 | 3 | 4;
  readonly shouldFail: boolean;
  readonly reason: string | null;
  readonly originalSha256: string | null;
  readonly verification: {
    readonly status: "FIXED" | "REPRODUCED" | "INCONCLUSIVE" | "NOT_RUN";
    readonly artifact: "verification/verification.json" | null;
  };
  /** An independent final browser check after the regression scan. */
  readonly postRegressionVerification: {
    readonly status: "FIXED" | "REPRODUCED" | "INCONCLUSIVE" | "NOT_RUN";
    readonly artifact: "post-regression-verification/verification.json" | null;
  };
  readonly regression: {
    readonly status: "COMPLETED" | "INCOMPLETE" | "FAILED" | "NOT_RUN";
    readonly verified: number;
    readonly review: number;
    readonly untested: number;
    readonly reportSha256: string | null;
    readonly artifact: "regression/qa-summary.json" | null;
  };
  readonly acceptancePath: "route-health-accept.json" | null;
  readonly caveat: string;
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function inside(parent: string, path: string): boolean {
  const diff = relative(parent, path);
  return diff === "" || (diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff));
}
async function pinnedOriginal(path: string, expectedSha256: string): Promise<boolean> {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4_096
      || basename(path) !== "original.json" || !SHA.test(expectedSha256)) return false;
    const absolute = resolve(path);
    const directory = dirname(absolute);
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(directory) !== directory) return false;
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1
      || before.size > MAX_WITNESS || await realpath(absolute) !== absolute) return false;
    const bytes = await readFile(absolute);
    const after = await lstat(absolute);
    return before.ino === after.ino && before.mtimeMs === after.mtimeMs
      && before.size === after.size && before.size === bytes.length
      && sha(bytes) === expectedSha256;
  } catch { return false; }
}

type Verdict = PublicRouteHealthAcceptResult;
function response(code: Verdict["exitCode"], reason: string | null, originalSha256: string | null,
  verification: Verdict["verification"], regression: Verdict["regression"],
  postRegressionVerification: Verdict["postRegressionVerification"],
  acceptancePath: Verdict["acceptancePath"] = null): Verdict {
  const status = code === 0 ? "ROUTE_RESTORED" : code === 1
    ? verification.status === "REPRODUCED" || postRegressionVerification.status === "REPRODUCED"
      ? "REPRODUCED" : "NEW_VERIFIED"
      : code === 4 ? "ERROR" : "INCONCLUSIVE";
  return { schemaVersion: "tvdoctor.public-route-health-accept/v1", status, exitCode: code,
    shouldFail: code !== 0, reason, originalSha256, verification, regression,
    postRegressionVerification,
    acceptancePath, caveat: CAVEAT };
}
const emptyVerify = (): Verdict["verification"] => ({ status: "NOT_RUN", artifact: null });
const emptyFinal = (): Verdict["postRegressionVerification"] => ({ status: "NOT_RUN", artifact: null });
const emptyRegression = (): Verdict["regression"] => ({
  status: "NOT_RUN", verified: 0, review: 0, untested: 0,
  reportSha256: null, artifact: null,
});

async function savedVerification(root: string, expected: PublicRouteHealthVerifyResult,
  stage: "verification" | "post-regression-verification" = "verification"): Promise<boolean> {
  try {
    const directory = join(root, stage);
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || await realpath(directory) !== directory) return false;
    const file = join(directory, "verification.json");
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1
      || before.size > MAX_VERIFICATION || await realpath(file) !== file) return false;
    const bytes = await readFile(file);
    const after = await lstat(file);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
      || before.size !== bytes.length || after.size !== bytes.length) return false;
    const parsed: unknown = JSON.parse(bytes.toString("utf8")) as unknown;
    return JSON.stringify(parsed) === JSON.stringify(expected);
  } catch { return false; }
}

async function savedRegression(root: string, expected: PublicRouteHealthRegressionResult): Promise<boolean> {
  try {
    if (expected.reportSha256 === null || !SHA.test(expected.reportSha256)) return false;
    const report = join(root, "regression", "original", "report.json");
    const summary = join(root, "regression", "qa-summary.json");
    for (const directory of [join(root, "regression"), join(root, "regression", "original")]) {
      const folder = await lstat(directory);
      if (!folder.isDirectory() || folder.isSymbolicLink()
        || await realpath(directory) !== directory) return false;
    }
    const before = await lstat(report);
    const saved = await lstat(summary);
    if (!before.isFile() || before.isSymbolicLink() || !saved.isFile()
      || saved.isSymbolicLink() || await realpath(report) !== report
      || await realpath(summary) !== summary
      || before.size < 1 || before.size > 16 * 1024 * 1024
      || saved.size < 1 || saved.size > 128 * 1024) return false;
    const bytes = await readFile(report);
    const summaryBytes = await readFile(summary);
    const policy = JSON.parse(summaryBytes.toString("utf8")) as unknown;
    const after = await lstat(report);
    return before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs
      && sha(bytes) === expected.reportSha256
      && policy !== null && typeof policy === "object" && !Array.isArray(policy)
      && "summary" in policy && typeof policy.summary === "object"
      && policy.summary !== null && !Array.isArray(policy.summary)
      && "verified" in policy.summary && policy.summary.verified === expected.verified
      && "review" in policy.summary && policy.summary.review === expected.review
      && "untested" in policy.summary && policy.summary.untested === expected.untested
      && "scanPolicy" in policy && typeof policy.scanPolicy === "object"
      && policy.scanPolicy !== null && "reportSha256" in policy.scanPolicy
      && policy.scanPolicy.reportSha256 === expected.reportSha256;
  } catch { return false; }
}

/**
 * TWO SEPARATE POSITIVE GATES: immutable 404/410 original->authored content,
 * and NEW real QA with an independently validated fresh source report.
 * Neither a vanished finding nor an unqualified HTTP200 is evidence of FIXED.
 */
export async function runPublicRouteHealthAcceptance(
  options: PublicRouteHealthAcceptOptions,
): Promise<PublicRouteHealthAcceptResult> {
  let verification = emptyVerify();
  let regression = emptyRegression();
  let postRegressionVerification = emptyFinal();
  if (options?.authorized !== true || typeof options.originalPath !== "string"
    || typeof options.outputRoot !== "string" || !isAbsolute(options.originalPath)
    || !isAbsolute(options.outputRoot) || !SHA.test(options.expectedOriginalSha256)
    || typeof options.executeQa !== "function") {
    return response(2, "invalid-or-unauthorized-options", null, verification, regression,
      postRegressionVerification);
  }
  const originalPath = resolve(options.originalPath);
  const root = resolve(options.outputRoot);
  if (inside(dirname(originalPath), root) || inside(root, dirname(originalPath))) {
    return response(2, "output-overlaps-original", null, verification, regression,
      postRegressionVerification);
  }
  if (!await pinnedOriginal(originalPath, options.expectedOriginalSha256)) {
    return response(3, "original-evidence-unavailable-or-changed", null, verification, regression,
      postRegressionVerification);
  }
  if (options.checkAuthoredConfig !== undefined && !await options.checkAuthoredConfig()) {
    return response(3, "authored-config-changed", null, verification, regression,
      postRegressionVerification);
  }
  try {
    const parent = dirname(root);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new Error("unsafe-output-parent");
    }
    await mkdir(root, { mode: 0o700 });
    const child = await lstat(root);
    if (!child.isDirectory() || child.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error("unsafe-output-root");
    }
  } catch { return response(4, "output-not-fresh-or-safe", options.expectedOriginalSha256,
    verification, regression, postRegressionVerification); }

  let code: Verdict["exitCode"] = 3;
  let reason: string | null = "inconclusive-verification";
  try {
    const runVerify = options.executeVerify ?? verifyPublicRouteHealth;
    const original = await runVerify({ authorized: true, route: options.route,
      originalPath, expectedOriginalSha256: options.expectedOriginalSha256,
      outputRoot: join(root, "verification"),
      ...(options.createBrowser === undefined ? {} : { createBrowser: options.createBrowser }),
    });
    if (!await pinnedOriginal(originalPath, options.expectedOriginalSha256)
      || original.schemaVersion !== "tvdoctor.public-route-health-verification/v1"
      || original.originalSha256 !== options.expectedOriginalSha256
      || original.regressionChecked !== false
      || !["FIXED", "REPRODUCED", "INCONCLUSIVE"].includes(original.classification)
      || !await savedVerification(root, original)) {
      reason = "original-or-verification-evidence-invalid";
    } else {
      verification = { status: original.classification,
        artifact: "verification/verification.json" };
      // A verified original failure is still assessed alongside the post-repair
      // regression scan; no single stale source scan yields a clean acceptance.
      if (original.classification === "INCONCLUSIVE") {
        reason = "independent-route-proof-inconclusive";
      } else {
        const runRegression = options.executeRegression ?? runPublicRouteHealthRegression;
        const fresh = await runRegression({
          target: new URL(options.route.path, options.route.baseUrl).href,
          outputRoot: join(root, "regression"), executeQa: options.executeQa,
        });
        if (!await pinnedOriginal(originalPath, options.expectedOriginalSha256)
          || !await savedVerification(root, original)) {
          reason = "original-or-verification-evidence-changed";
        } else {
          regression = { status: fresh.status, verified: fresh.verified,
            review: fresh.review, untested: fresh.untested,
            reportSha256: fresh.reportSha256,
            artifact: fresh.summaryPath === null ? null : "regression/qa-summary.json" };
          if (fresh.status === "FAILED" || fresh.status === "INCOMPLETE") {
            // A repeat 404/410 remains a confirmed original failure even when
            // the fresh QA cannot complete. Never demote it to apparent clean.
            if (original.classification === "REPRODUCED") {
              code = 1; reason = "original-public-route-still-broken";
            } else {
              reason = fresh.status === "FAILED" ? "fresh-regression-evidence-invalid"
                : "fresh-regression-coverage-incomplete";
            }
          } else if (!await savedRegression(root, fresh)) {
            reason = "fresh-regression-evidence-changed";
          } else if (original.classification === "REPRODUCED") {
            code = 1; reason = "original-public-route-still-broken";
          } else if (fresh.verified > 0) {
            code = 1; reason = "fresh-verified-defect-observed";
          } else if (fresh.verified === 0) {
            // A route can change while the independent regression scan runs.
            // That scan is not a page-health oracle: zero VERIFIED may include
            // a disappeared or newly 404 document. Revalidate the original
            // author's exact healthy content in ANOTHER fresh browser now.
            const final = await runVerify({ authorized: true, route: options.route,
              originalPath, expectedOriginalSha256: options.expectedOriginalSha256,
              outputRoot: join(root, "post-regression-verification"),
              ...(options.createBrowser === undefined ? {} : { createBrowser: options.createBrowser }),
            });
            if (!await pinnedOriginal(originalPath, options.expectedOriginalSha256)
              || !await savedVerification(root, original)
              || !await savedRegression(root, fresh)
              || final.schemaVersion !== "tvdoctor.public-route-health-verification/v1"
              || final.originalSha256 !== options.expectedOriginalSha256
              || final.regressionChecked !== false
              || !["FIXED", "REPRODUCED", "INCONCLUSIVE"].includes(final.classification)
              || !await savedVerification(root, final, "post-regression-verification")) {
              reason = "post-regression-route-evidence-invalid";
            } else {
              postRegressionVerification = { status: final.classification,
                artifact: "post-regression-verification/verification.json" };
              if (final.classification === "FIXED") {
                code = 0; reason = null;
              } else if (final.classification === "REPRODUCED") {
                code = 1; reason = "route-broken-again-after-regression";
              } else {
                reason = "post-regression-route-state-inconclusive";
              }
            }
          }
        }
      }
    }
  } catch { code = 4; reason = "acceptance-browser-or-evidence-failed"; }
  if (!await pinnedOriginal(originalPath, options.expectedOriginalSha256)) {
    code = 3; reason = "original-evidence-changed";
  }
  if (options.checkAuthoredConfig !== undefined && !await options.checkAuthoredConfig()) {
    code = 3; reason = "authored-config-changed";
  }
  if (code === 0 && (postRegressionVerification.status !== "FIXED"
    || postRegressionVerification.artifact === null)) {
    code = 3; reason = "post-regression-route-proof-missing";
  }
  const outcome = response(code, reason, options.expectedOriginalSha256, verification, regression,
    postRegressionVerification, "route-health-accept.json");
  try {
    await writeFile(join(root, "route-health-accept.json"), JSON.stringify(outcome, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    return outcome;
  } catch {
    return response(4, "acceptance-summary-write-failed", options.expectedOriginalSha256,
      verification, regression, postRegressionVerification);
  }
}
