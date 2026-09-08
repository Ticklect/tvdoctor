import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { TVDoctorReportV1 } from "@tvdoctor/protocol";
import type { ArtifactStore } from "./artifact-store.js";
import { renderAiCoderReport } from "./render-ai.js";
import { renderReportHtml } from "./render-html.js";
import { renderReportMarkdown } from "./render-markdown.js";
import { renderReportJson, sanitiseReportForOutput } from "./report-builder.js";

export interface ReportBundleOutput {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ReportBundle {
  readonly reportJson: ReportBundleOutput;
  readonly reportHtml: ReportBundleOutput;
  readonly reportMarkdown: ReportBundleOutput;
  readonly aiReportMarkdown: ReportBundleOutput;
}

interface PendingBundleFile {
  readonly relativePath: string;
  readonly mediaType: string;
  readonly content: string;
}

async function writeOutput(store: ArtifactStore, file: PendingBundleFile): Promise<ReportBundleOutput> {
  const absolutePath = await store.writeBundleFile(file.relativePath, file.content);
  const bytes = Buffer.from(file.content, "utf8");
  return {
    absolutePath,
    relativePath: file.relativePath,
    mediaType: file.mediaType,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Write all derivative formats from the exact same canonical report model.
 * report.json is committed last so its presence signals a complete bundle.
 */
export async function writeReportBundle(
  store: ArtifactStore,
  report: TVDoctorReportV1,
): Promise<ReportBundle> {
  const safe = sanitiseReportForOutput(report);
  // Do not publish a report which advertises missing, redirected, or mutated
  // evidence. This check intentionally happens before the first derivative is
  // written so report.json can never bless an unverifiable artifact inventory.
  for (const artifact of safe.artifacts) {
    if (artifact.status === "available") await store.verifyAvailableArtifact(artifact);
  }
  await store.prepareReportBundleWrite();
  const html = await writeOutput(store, {
    relativePath: "report.html",
    mediaType: "text/html",
    content: renderReportHtml(safe),
  });
  const markdown = await writeOutput(store, {
    relativePath: "exports/portable-summary.md",
    mediaType: "text/markdown",
    content: renderReportMarkdown(safe, "../"),
  });
  const aiMarkdown = await writeOutput(store, {
    relativePath: "exports/agent-fix-tasks.md",
    mediaType: "text/markdown",
    content: renderAiCoderReport(safe),
  });
  const json = await writeOutput(store, {
    relativePath: "report.json",
    mediaType: "application/json",
    content: renderReportJson(safe),
  });
  return {
    reportJson: json,
    reportHtml: html,
    reportMarkdown: markdown,
    aiReportMarkdown: aiMarkdown,
  };
}
