import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";

import type { CliContext, ReportActionHandlers } from "./cli.js";
import type { StartTerminal } from "./interactive.js";
import { sanitizeTerminalText } from "./terminal.js";

export interface ScanCompletionLike {
  readonly status: "completed" | "partial" | "failed" | "setup-blocker";
  readonly issueCount: number;
  readonly highestSeverity: "critical" | "high" | "medium" | "low" | "info" | null;
  readonly reportPath: string | null;
  readonly details: readonly string[];
}

function write(context: CliContext, text: string): void {
  context.io.writeStdout(`${sanitizeTerminalText(text, { maximumLength: 4_096 })}\n`);
}

async function launchDetached(command: string, arguments_: readonly string[]): Promise<boolean> {
  return await new Promise((resolveLaunch) => {
    const child = spawn(command, [...arguments_], { detached: true, stdio: "ignore" });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolveLaunch(result);
    };
    child.once("error", () => finish(false));
    child.once("spawn", () => {
      child.unref();
      finish(true);
    });
  });
}

async function openWithSystem(path: string): Promise<boolean> {
  const command = process.platform === "win32"
    ? "cmd.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const arguments_ = process.platform === "win32"
    ? ["/c", "start", "", path]
    : [path];
  return await launchDetached(command, arguments_);
}

async function showInFolder(path: string): Promise<boolean> {
  const command = process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const arguments_ = process.platform === "win32"
    ? ["/select,", path]
    : process.platform === "darwin" ? ["-R", path] : [dirname(path)];
  return await launchDetached(command, arguments_);
}

async function copyToClipboard(value: string): Promise<boolean> {
  const command = process.platform === "win32"
    ? "clip.exe"
    : process.platform === "darwin" ? "pbcopy" : "wl-copy";
  const child = spawn(command, [], { stdio: ["pipe", "ignore", "ignore"] });
  const completed = new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(value, "utf8");
  return await completed;
}

export const systemReportActions: ReportActionHandlers = {
  openReport: openWithSystem,
  showFolder: showInFolder,
  copyPath: copyToClipboard,
};

function elapsedLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

function findingLabel(count: number): string {
  return `${String(count)} finding${count === 1 ? "" : "s"}`;
}

function completionLine(result: ScanCompletionLike, elapsedMs: number): string {
  const severity = result.highestSeverity === null ? "none" : result.highestSeverity.toUpperCase();
  if (result.status === "completed") {
    return `✓ Scan complete · ${findingLabel(result.issueCount)} · highest: ${severity} · ${elapsedLabel(elapsedMs)}`;
  }
  if (result.status === "setup-blocker") {
    return `◐ Scan incomplete · ${findingLabel(result.issueCount)} retained · setup blocked · ${elapsedLabel(elapsedMs)}`;
  }
  if (result.status === "partial") {
    return `◐ Scan incomplete · ${findingLabel(result.issueCount)} retained · highest: ${severity} · ${elapsedLabel(elapsedMs)}`;
  }
  return `✗ Scan failed · ${findingLabel(result.issueCount)} retained · ${elapsedLabel(elapsedMs)}`;
}

async function offerReportFallbacks(
  context: CliContext,
  terminal: StartTerminal,
  actions: ReportActionHandlers,
  reportPath: string,
): Promise<void> {
  const choice = await terminal.select("TVDoctor could not open the report. What next?", [
    { label: "Show folder" },
    { label: "Copy path" },
    { label: "Exit" },
  ]);
  if (choice === 0) {
    if (!(await actions.showFolder(reportPath))) {
      write(context, `Open the report folder manually: ${dirname(reportPath)}`);
    }
  } else if (choice === 1) {
    if (await actions.copyPath(reportPath)) write(context, "Report path copied to the clipboard.");
    else write(context, `Copy this path manually: ${reportPath}`);
  }
}

export async function finishInteractiveScan(
  context: CliContext,
  terminal: StartTerminal,
  result: ScanCompletionLike,
  startedAtMs: number,
): Promise<void> {
  write(context, completionLine(result, Date.now() - startedAtMs));
  for (const detail of result.details) write(context, detail);

  if (result.reportPath === null) return;
  const reportPath = join(dirname(result.reportPath), "report.html");
  write(context, `Report: ${reportPath}`);
  write(context, "Opening report…");
  const actions = context.reportActions ?? systemReportActions;
  if (!(await actions.openReport(reportPath))) {
    await offerReportFallbacks(context, terminal, actions, reportPath);
  }
}
