import { ARTIFACT_KINDS } from "./artifact.js";
import { CAPABILITIES } from "./capability.js";
import {
  EVIDENCE_KINDS,
  ISSUE_CONFIDENCES,
  ISSUE_SEVERITIES,
  REPRODUCTION_CONFIDENCES,
} from "./issue.js";
import { REMOTE_KEYS } from "./remote-key.js";
import { REPLAY_SCHEMA_VERSION } from "./replay.js";
import {
  COVERAGE_BUDGETS,
  PACK_COVERAGE_STATUSES,
  REPORT_SCHEMA_VERSION_V1,
  RUN_MODES,
  RUN_STATUSES,
} from "./report.js";

const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;

const nullableStringSchema = {
  type: ["string", "null"],
  maxLength: 65_536,
} as const;

/**
 * Deliberately conservative portable path grammar: generated evidence paths do
 * not need percent encoding, so rejecting it keeps URI and filesystem
 * interpretation identical on Windows and POSIX hosts.
 */
const portableArtifactPathPattern = String.raw`^(?!/)(?![A-Za-z]:)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!.*[<>:"\\|?*%])(?!.*//)(?!.*(?:^|/)(?:\.\.?|[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/]*)?(?:/|$))(?!.*(?:^|/)[^/]*[. ](?:/|$))[^/]+(?:/[^/]+)*$`;

const portableArtifactPathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1_024,
  pattern: portableArtifactPathPattern,
} as const;

const remoteStepSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "repeat"],
  properties: {
    key: { enum: REMOTE_KEYS },
    repeat: { type: "integer", minimum: 1, maximum: 10_000 },
  },
} as const;

const transitionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fromElement", "action", "expectedElement", "observedElement"],
  properties: {
    fromElement: nullableStringSchema,
    action: { enum: REMOTE_KEYS },
    expectedElement: nullableStringSchema,
    observedElement: nullableStringSchema,
  },
} as const;

export const TVDOCTOR_ARTIFACT_DESCRIPTOR_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://tvdoctor.dev/schemas/artifact/v1.json",
  title: "TVDoctor artifact descriptor",
  $comment: "Runtime parsing is authoritative for semantic and cross-record validation.",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "status", "path", "mediaType", "byteLength", "sha256"],
      properties: {
        id: identifierSchema,
        kind: { enum: ARTIFACT_KINDS },
        status: { const: "available" },
        path: portableArtifactPathSchema,
        mediaType: {
          type: "string",
          maxLength: 127,
          pattern: "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
        },
        byteLength: { type: "integer", minimum: 0 },
        sha256: {
          oneOf: [
            { type: "null" },
            { type: "string", pattern: "^[0-9a-f]{64}$" },
          ],
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "status", "reason"],
      properties: {
        id: identifierSchema,
        kind: { enum: ARTIFACT_KINDS },
        status: { enum: ["unavailable", "failed"] },
        reason: { type: "string", minLength: 1, maxLength: 65_536 },
      },
    },
  ],
} as const;

export const TVDOCTOR_REPLAY_V1_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://tvdoctor.dev/schemas/replay/v1.json",
  title: "TVDoctor portable replay v1",
  $comment: "Runtime parsing additionally verifies that the assertion action matches the final replay step.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "issueId", "reset", "steps", "assertion"],
  properties: {
    schemaVersion: { const: REPLAY_SCHEMA_VERSION },
    id: identifierSchema,
    issueId: identifierSchema,
    reset: {
      type: "object",
      additionalProperties: false,
      required: ["strategy"],
      properties: {
        strategy: { enum: ["relaunch", "reload", "clear-data"] },
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 10_000,
      items: remoteStepSchema,
    },
    assertion: {
      type: "object",
      additionalProperties: false,
      required: ["type", "fromElement", "action", "expectedElement", "observedElement"],
      properties: {
        type: { const: "transition" },
        fromElement: nullableStringSchema,
        action: { enum: REMOTE_KEYS },
        expectedElement: nullableStringSchema,
        observedElement: nullableStringSchema,
      },
    },
  },
} as const;

const issueSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "rule",
    "title",
    "description",
    "severity",
    "confidence",
    "pack",
    "screen",
    "expected",
    "observed",
    "transition",
    "evidence",
    "reproduction",
  ],
  properties: {
    id: identifierSchema,
    rule: identifierSchema,
    title: { type: "string", minLength: 1, maxLength: 65_536 },
    description: { type: "string", minLength: 1, maxLength: 65_536 },
    severity: { enum: ISSUE_SEVERITIES },
    confidence: { enum: ISSUE_CONFIDENCES },
    pack: identifierSchema,
    screen: nullableStringSchema,
    expected: { type: "string", minLength: 1, maxLength: 65_536 },
    observed: { type: "string", minLength: 1, maxLength: 65_536 },
    transition: {
      oneOf: [{ type: "null" }, transitionSchema],
    },
    evidence: {
      type: "array",
      maxItems: 10_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "summary", "source", "artifact"],
        properties: {
          kind: { enum: EVIDENCE_KINDS },
          summary: { type: "string", minLength: 1, maxLength: 65_536 },
          source: nullableStringSchema,
          artifact: {
            ...portableArtifactPathSchema,
            type: ["string", "null"],
          },
        },
      },
    },
    reproduction: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "resetStrategy",
            "originalSequence",
            "minimizedSequence",
            "confidence",
            "artifact",
          ],
          properties: {
            status: { const: "available" },
            resetStrategy: { enum: ["relaunch", "reload", "clear-data"] },
            originalSequence: { type: "array", maxItems: 10_000, items: remoteStepSchema },
            minimizedSequence: {
              oneOf: [
                { type: "null" },
                { type: "array", maxItems: 10_000, items: remoteStepSchema },
              ],
            },
            confidence: { enum: REPRODUCTION_CONFIDENCES },
            artifact: { ...portableArtifactPathSchema, type: ["string", "null"] },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "reason"],
          properties: {
            status: { const: "unavailable" },
            reason: { type: "string", minLength: 1, maxLength: 65_536 },
          },
        },
      ],
    },
  },
} as const;

export const TVDOCTOR_REPORT_V1_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://tvdoctor.dev/schemas/report/v1.json",
  title: "TVDoctor canonical report v1",
  $comment: "Runtime parsing is required to enforce replay-to-issue integrity, uniqueness, timestamps, and other semantic invariants.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "run", "target", "coverage", "issues", "artifacts", "replays"],
  properties: {
    schemaVersion: { const: REPORT_SCHEMA_VERSION_V1 },
    run: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "tvdoctorVersion",
        "mode",
        "status",
        "startedAt",
        "completedAt",
        "durationMs",
      ],
      properties: {
        id: identifierSchema,
        tvdoctorVersion: { type: "string", minLength: 1, maxLength: 128 },
        mode: { enum: RUN_MODES },
        status: { enum: RUN_STATUSES },
        startedAt: { type: "string", format: "date-time", maxLength: 64 },
        completedAt: { type: "string", format: "date-time", maxLength: 64 },
        durationMs: { type: "integer", minimum: 0 },
      },
    },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["name", "platform", "location", "environment"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 65_536 },
        platform: identifierSchema,
        location: { type: "string", minLength: 1, maxLength: 65_536 },
        environment: {
          type: "object",
          maxProperties: 512,
          additionalProperties: { type: "string", maxLength: 4_096 },
        },
      },
    },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: [
        "screenStatesDiscovered",
        "focusStatesDiscovered",
        "transitionsTested",
        "actionsSent",
        "capabilitiesObserved",
        "packs",
        "budget",
      ],
      properties: {
        screenStatesDiscovered: { type: "integer", minimum: 0 },
        focusStatesDiscovered: { type: "integer", minimum: 0 },
        transitionsTested: { type: "integer", minimum: 0 },
        actionsSent: { type: "integer", minimum: 0 },
        capabilitiesObserved: {
          type: "array",
          uniqueItems: true,
          maxItems: CAPABILITIES.length,
          items: { enum: CAPABILITIES },
        },
        packs: {
          type: "array",
          maxItems: 10_000,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pack", "status"],
            properties: {
              pack: identifierSchema,
              status: { enum: PACK_COVERAGE_STATUSES },
            },
          },
        },
        budget: {
          type: "object",
          additionalProperties: false,
          required: [
            "maxActions",
            "maxStates",
            "maxDepth",
            "maxDurationMs",
            "maxRepetitiveItems",
            "exhausted",
          ],
          properties: {
            maxActions: { type: ["integer", "null"], minimum: 0 },
            maxStates: { type: ["integer", "null"], minimum: 0 },
            maxDepth: { type: ["integer", "null"], minimum: 0 },
            maxDurationMs: { type: ["integer", "null"], minimum: 0 },
            maxRepetitiveItems: { type: ["integer", "null"], minimum: 0 },
            exhausted: {
              type: "array",
              uniqueItems: true,
              maxItems: COVERAGE_BUDGETS.length,
              items: { enum: COVERAGE_BUDGETS },
            },
          },
        },
      },
    },
    issues: { type: "array", maxItems: 10_000, items: issueSchema },
    artifacts: {
      type: "array",
      maxItems: 10_000,
      items: { $ref: TVDOCTOR_ARTIFACT_DESCRIPTOR_JSON_SCHEMA.$id },
    },
    replays: {
      type: "array",
      maxItems: 10_000,
      items: { $ref: TVDOCTOR_REPLAY_V1_JSON_SCHEMA.$id },
    },
  },
} as const;
