import type { ArtifactDescriptor } from "@tvdoctor/protocol";
import {
  type ArtifactStore,
  ISSUE_EVIDENCE_SLOTS,
  type IssueEvidenceSlot,
} from "./artifact-store.js";
import {
  isSensitiveEnvironmentKey,
  sanitiseUntrustedText,
} from "./security.js";
import { stableJson, type JsonValue } from "./stable-json.js";

export interface AvailableBinaryEvidence {
  readonly status: "available";
  readonly format: "binary";
  readonly data: Uint8Array;
  readonly mediaType?: string;
}

export interface AvailableTextEvidence {
  readonly status: "available";
  readonly format: "text";
  readonly text: string;
  readonly mediaType?: string;
}

export interface AvailableJsonEvidence {
  readonly status: "available";
  readonly format: "json";
  readonly value: JsonValue;
}

export interface UnavailableEvidence {
  readonly status: "unavailable";
  readonly reason: string;
  readonly mediaType?: string;
}

export interface FailedEvidence {
  readonly status: "failed";
  readonly reason: string;
  readonly mediaType?: string;
}

export type EvidenceCapture =
  | AvailableBinaryEvidence
  | AvailableTextEvidence
  | AvailableJsonEvidence
  | UnavailableEvidence
  | FailedEvidence;

export interface IssueEvidenceArtifactInput {
  readonly slot: IssueEvidenceSlot;
  readonly capture: EvidenceCapture;
}

export interface IssueEvidenceWriteInput {
  readonly issueId: string;
  readonly artifacts: readonly IssueEvidenceArtifactInput[];
}

export interface IssueEvidenceWriteResult {
  readonly descriptors: readonly ArtifactDescriptor[];
  readonly pathsBySlot: Readonly<Partial<Record<IssueEvidenceSlot, string>>>;
}

interface JsonSanitiseBudget {
  nodes: number;
}

const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function sanitiseJsonValue(
  value: JsonValue,
  budget: JsonSanitiseBudget,
  depth: number,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > 10_000) throw new TypeError("Evidence JSON exceeds the node limit.");
  if (depth > 40) throw new TypeError("Evidence JSON exceeds the nesting limit.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Evidence JSON numbers must be finite.");
    return value;
  }
  if (typeof value === "string") return sanitiseUntrustedText(value, 4_000);
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new TypeError("Evidence JSON array exceeds the item limit.");
    return value.map((item) => sanitiseJsonValue(item, budget, depth + 1));
  }

  const record = value as Readonly<Record<string, JsonValue>>;
  const prototype = Object.getPrototypeOf(record) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Evidence JSON objects must have a plain prototype.");
  }
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new TypeError("Evidence JSON cannot contain symbol properties.");
  }
  const keys = Object.keys(record);
  if (keys.length > 2_000) throw new TypeError("Evidence JSON object exceeds the property limit.");
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const rawKey of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(record, rawKey);
    if (descriptor === undefined || "get" in descriptor || "set" in descriptor) {
      throw new TypeError("Evidence JSON cannot contain accessor properties.");
    }
    const key = sanitiseUntrustedText(rawKey, 256);
    if (key.length === 0) throw new TypeError("Evidence JSON keys must not be empty.");
    if (PROTOTYPE_KEYS.has(key)) {
      throw new TypeError("Evidence JSON cannot contain prototype-sensitive keys.");
    }
    if (Object.hasOwn(result, key)) throw new TypeError("Evidence JSON keys collide after sanitisation.");
    const child = record[rawKey];
    if (child === undefined) throw new TypeError("Evidence JSON values must not be undefined.");
    result[key] = isSensitiveEnvironmentKey(rawKey)
      || isSensitiveEnvironmentKey(key.replace(/\s+/gu, " "))
      ? "[REDACTED]"
      : sanitiseJsonValue(child, budget, depth + 1);
  }
  return result;
}

export function sanitiseEvidenceJson(value: JsonValue): JsonValue {
  return sanitiseJsonValue(value, { nodes: 0 }, 0);
}

function assertFormatMatchesSlot(slot: IssueEvidenceSlot, capture: EvidenceCapture): void {
  if (capture.status !== "available") return;
  const binarySlot = slot === "before-screenshot" || slot === "after-screenshot" || slot === "trace";
  const textSlot = slot === "replay";
  if (binarySlot && capture.format !== "binary") {
    throw new TypeError(`${slot} evidence must use the binary format.`);
  }
  if (textSlot && capture.format !== "text") {
    throw new TypeError("Replay evidence must use the text format.");
  }
  if (!binarySlot && !textSlot && capture.format !== "json") {
    throw new TypeError(`${slot} evidence must use the JSON format.`);
  }
}

function captureMediaType(capture: EvidenceCapture): string | undefined {
  return "mediaType" in capture ? capture.mediaType : undefined;
}

export async function writeIssueEvidence(
  store: ArtifactStore,
  input: IssueEvidenceWriteInput,
): Promise<IssueEvidenceWriteResult> {
  const bySlot = new Map<IssueEvidenceSlot, EvidenceCapture>();
  for (const entry of input.artifacts) {
    if (bySlot.has(entry.slot)) throw new TypeError(`Duplicate evidence slot: ${entry.slot}`);
    assertFormatMatchesSlot(entry.slot, entry.capture);
    bySlot.set(entry.slot, entry.capture);
  }

  const descriptors: ArtifactDescriptor[] = [];
  const pathsBySlot: Partial<Record<IssueEvidenceSlot, string>> = {};
  for (const slot of ISSUE_EVIDENCE_SLOTS) {
    const capture = bySlot.get(slot);
    if (capture === undefined) continue;
    const mediaType = captureMediaType(capture);
    const location = store.issueArtifactLocation(input.issueId, slot, mediaType);
    if (capture.status === "unavailable" || capture.status === "failed") {
      const reason = sanitiseUntrustedText(capture.reason);
      if (reason.length === 0) throw new TypeError("Unavailable or failed evidence requires a reason.");
      descriptors.push({
        id: location.artifactId,
        kind: location.kind,
        status: capture.status,
        reason,
      });
      continue;
    }

    let data: Uint8Array | string;
    if (capture.format === "binary") {
      data = capture.data;
    } else if (capture.format === "text") {
      data = sanitiseUntrustedText(capture.text, 1_000_000);
    } else {
      data = stableJson(sanitiseEvidenceJson(capture.value));
    }
    const descriptor = await store.writeIssueArtifact({
      issueId: input.issueId,
      slot,
      data,
      ...(mediaType === undefined ? {} : { mediaType }),
    });
    descriptors.push(descriptor);
    pathsBySlot[slot] = descriptor.path;
  }
  return { descriptors, pathsBySlot };
}
