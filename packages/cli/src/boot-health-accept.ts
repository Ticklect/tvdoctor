/**
 * Public acceptance import boundary for the boot-health CLI and local UI.
 * The acceptance implementation lives in boot-health.ts so its source-pinned
 * negative witness and positive browser oracle cannot silently diverge.
 */
export { runBootHealthAccept } from "./boot-health.js";
export type {
  BootHealthAcceptOptions,
  BootHealthAcceptResult,
} from "./boot-health.js";
