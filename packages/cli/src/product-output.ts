import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface OutputNameContext {
  readonly target: string;
  readonly mode: string;
  readonly platform?: string;
  readonly now?: () => Date;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function padMilliseconds(value: number): string {
  return value.toString().padStart(3, "0");
}

function safeSlug(value: string, maximumLength = 48): string {
  const slug = value.normalize("NFKC").toLowerCase()
    .replace(/^www\./u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return (slug.slice(0, maximumLength).replace(/-+$/gu, "")) || "target";
}

export function defaultOutputDirectory(context: OutputNameContext): string {
  const date = (context.now ?? (() => new Date()))();
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    padMilliseconds(date.getMilliseconds()),
  ].join("-");
  const target = context.platform === undefined
    ? safeSlug(new URL(context.target).hostname)
    : `${safeSlug(context.target)}-${safeSlug(context.platform)}`;
  const collisionToken = randomBytes(3).toString("hex");
  return join("Tests", `${target}-${context.mode}-${stamp}-${collisionToken}`);
}
