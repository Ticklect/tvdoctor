import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTVDoctorReportJson } from "@tvdoctor/protocol";

import type {
  DemoCommandRequest,
  DemoCommandResult,
  ReplayCommandRequest,
  ReplayCommandResult,
  TestCommandRequest,
  TestCommandResult,
} from "./cli.js";

interface DemoIssueLike {
  readonly id: string;
  readonly rule: string;
  readonly transition?: {
    readonly fromElement?: string | null;
    readonly action?: string | null;
    readonly expectedElement?: string | null;
    readonly observedElement?: string | null;
  } | null;
  readonly reproduction: { readonly status: string };
}

interface DemoReportLike {
  readonly issues: readonly DemoIssueLike[];
  readonly replays: readonly { readonly issueId: string }[];
}

export interface NodeDemoDependencies {
  readonly testTarget: (request: TestCommandRequest) => Promise<TestCommandResult>;
  readonly replayIssue: (request: ReplayCommandRequest) => Promise<ReplayCommandResult>;
  readonly loadReport?: (reportPath: string) => Promise<DemoReportLike>;
  readonly withFixtureServer?: <T>(run: (target: string) => Promise<T>) => Promise<T>;
  readonly fixtureRoot?: string;
}

function demoContractIssue(report: DemoReportLike): DemoIssueLike | null {
  const matches = report.issues.filter((issue) => (
    issue.rule === "remote.reachability"
      && issue.transition?.action === "RIGHT"
      && issue.transition.fromElement === "hero-watch"
      && issue.transition.expectedElement === "hero-more-info"
      && issue.transition.observedElement === "hero-watch"
      && issue.reproduction.status === "available"
      && report.replays.some((replay) => replay.issueId === issue.id)
  ));
  return matches.length === 1 ? matches[0] ?? null : null;
}

async function loadDemoReport(reportPath: string): Promise<DemoReportLike> {
  const report = parseTVDoctorReportJson(await readFile(reportPath, "utf8"));
  if (report.schemaVersion !== "tvdoctor.report/v1") {
    throw new TypeError("The demo requires a tvdoctor.report/v1 report.");
  }
  return report;
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function send(response: ServerResponse, statusCode: number, body = ""): void {
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

function safeAssetPath(root: string, requestUrl: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const relativePath = segments.length === 0 ? "index.html" : segments.join("/");
  const candidate = resolve(root, relativePath);
  const fromRoot = relative(root, candidate);
  return fromRoot.startsWith("..") || isAbsolute(fromRoot) ? null : candidate;
}

export async function withPackagedDemoFixture<T>(
  run: (target: string) => Promise<T>,
  fixtureRoot = fileURLToPath(new URL("./demo-fixture/", import.meta.url)),
): Promise<T> {
  const root = resolve(fixtureRoot);
  const indexPath = resolve(root, "index.html");
  const indexMetadata = await stat(indexPath);
  if (!indexMetadata.isFile() || indexMetadata.size === 0) {
    throw new Error(`Packaged demo fixture is unavailable at ${indexPath}.`);
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        send(response, 405, "Method not allowed");
        return;
      }
      const assetPath = safeAssetPath(root, request.url ?? "/");
      if (assetPath === null) {
        send(response, 400, "Invalid path");
        return;
      }
      try {
        const metadata = await stat(assetPath);
        if (!metadata.isFile()) {
          send(response, 404, "Not found");
          return;
        }
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Type", mimeType(assetPath));
        response.setHeader("Content-Length", String(metadata.size));
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        response.end(await readFile(assetPath));
      } catch {
        send(response, 404, "Not found");
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const handleError = (error: Error): void => rejectListen(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", handleError);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("TVDoctor could not determine the packaged demo server address.");
  }
  const target = `http://127.0.0.1:${String(address.port)}/`;
  try {
    return await run(target);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

export function createNodeDemoOperation(
  dependencies: NodeDemoDependencies,
): (request: DemoCommandRequest) => Promise<DemoCommandResult> {
  const loadReport = dependencies.loadReport ?? loadDemoReport;
  const withFixtureServer = dependencies.withFixtureServer
    ?? (<T>(run: (target: string) => Promise<T>) => withPackagedDemoFixture(
      run,
      dependencies.fixtureRoot,
    ));

  return async (request) => await withFixtureServer(async (target) => {
    const demoTarget = new URL(target);
    demoTarget.searchParams.set("tvdoctorDemo", "navigation");
    const targetUrl = demoTarget.href;
    const audit = await dependencies.testTarget({
      target: targetUrl,
      targetName: "Northstar controlled demo",
      packagedDemo: true,
      packs: ["navigation"],
      mode: "quick",
      outputPath: request.outputPath,
      searchQuery: "N",
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (audit.status === "partial") {
      return {
        status: "inconclusive",
        issueId: null,
        reportPath: audit.reportPath,
        replayStatus: null,
        details: audit.details,
      };
    }
    if (audit.status !== "completed" || audit.reportPath === null) {
      return {
        status: "failed",
        issueId: null,
        reportPath: audit.reportPath,
        replayStatus: null,
        details: audit.details.length === 0 ? ["The demo audit did not complete."] : audit.details,
      };
    }

    let report: DemoReportLike;
    try {
      report = await loadReport(audit.reportPath);
    } catch {
      return {
        status: "failed",
        issueId: null,
        reportPath: audit.reportPath,
        replayStatus: null,
        details: [...audit.details, "Demo report verification failed after the report was written."],
      };
    }
    const issue = demoContractIssue(report);
    if (issue === null) {
      return {
        status: "failed",
        issueId: null,
        reportPath: audit.reportPath,
        replayStatus: null,
        details: [...audit.details, "Expected seeded Home More info reachability failure was missing or ambiguous."],
      };
    }

    let replay: ReplayCommandResult;
    try {
      replay = await dependencies.replayIssue({
        issueId: issue.id,
        reportPath: audit.reportPath,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      return {
        status: "failed",
        issueId: issue.id,
        reportPath: audit.reportPath,
        replayStatus: "error",
        details: [...audit.details, "Replay failed after the demo report was written."],
      };
    }
    const status = replay.status === "reproduced"
      ? "verified"
      : replay.status === "inconclusive"
        ? "inconclusive"
        : "failed";
    return {
      status,
      issueId: issue.id,
      reportPath: audit.reportPath,
      replayStatus: replay.status,
      details: [
        ...audit.details,
        ...(replay.status === "reproduced" ? ["Seeded More info D-pad failure VERIFIED"] : []),
        ...replay.details,
      ],
    };
  });
}
