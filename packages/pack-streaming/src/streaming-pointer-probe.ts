import { semanticStateIdentity } from "./semantics.js";
import type {
  StreamingPackOptions,
  StreamingPointerProbeRequest,
  StreamingPointerProbeRecord,
  StreamingPointerProbeResult,
} from "./types.js";
import {
  PackStop,
  safeErrorMessage,
  type StreamingSession,
} from "./streaming-runtime.js";

const MAX_POINTER_PROPERTY_LENGTH = 120;
const MAX_POINTER_VALUE_LENGTH = 500;
const MAX_POINTER_DETAIL_LENGTH = 1_000;

function boundedPointerText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  let sanitised = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitised += codePoint !== undefined && (
      codePoint <= 0x08
      || codePoint === 0x0b
      || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || codePoint === 0x7f
    ) ? " " : character;
  }
  const bounded = sanitised.trim();
  return bounded.length > 0 && bounded.length <= maximum ? bounded : null;
}

function normalisePointerProbeResult(value: unknown): StreamingPointerProbeResult {
  if (typeof value !== "object" || value === null) {
    return { status: "error", detail: "The pointer hook returned a malformed result." };
  }
  const candidate = value as Record<string, unknown>;
  const detail = boundedPointerText(candidate["detail"], MAX_POINTER_DETAIL_LENGTH);
  if (detail === null) {
    return { status: "error", detail: "The pointer hook returned an invalid or oversized detail." };
  }
  if (
    candidate["status"] === "unreachable"
    || candidate["status"] === "unobservable"
    || candidate["status"] === "error"
  ) {
    return { status: candidate["status"], detail };
  }
  if (candidate["status"] !== "reachable") {
    return { status: "error", detail: "The pointer hook returned an unknown status." };
  }
  const observed = candidate["observedChange"];
  if (typeof observed !== "object" || observed === null) {
    return { status: "error", detail: "Pointer reachability lacked structured observed-change evidence." };
  }
  const change = observed as Record<string, unknown>;
  const property = boundedPointerText(change["property"], MAX_POINTER_PROPERTY_LENGTH);
  const rawBefore = change["before"];
  const before = rawBefore === null
    ? null
    : boundedPointerText(rawBefore, MAX_POINTER_VALUE_LENGTH);
  const after = boundedPointerText(change["after"], MAX_POINTER_VALUE_LENGTH);
  if (property === null || (rawBefore !== null && before === null) || after === null || before === after) {
    return {
      status: "error",
      detail: "Pointer reachability did not contain a bounded, observable before/after change.",
    };
  }
  return {
    status: "reachable",
    detail,
    observedChange: { property, before, after },
  };
}

export async function runIsolatedPointerProbe(
  session: StreamingSession,
  probe: NonNullable<StreamingPackOptions["pointerProbe"]>,
  request: StreamingPointerProbeRequest,
  records: StreamingPointerProbeRecord[],
): Promise<StreamingPointerProbeResult> {
  const beforeIdentity = semanticStateIdentity(request.snapshot);
  let result: StreamingPointerProbeResult;
  session.recordPointerProbe();
  try {
    result = normalisePointerProbeResult(await session.operation(
      (signal) => probe.probe({ ...request, signal }),
    ));
  } catch (error) {
    result = {
      status: "error",
      detail: boundedPointerText(safeErrorMessage(error), MAX_POINTER_DETAIL_LENGTH)
        ?? "The isolated pointer hook failed.",
    };
  }

  const restored = await session.restoreAndReplay(request.surfaceSequence, "probe");
  const afterIdentity = semanticStateIdentity(restored);
  const mainSessionRestored = beforeIdentity !== null && beforeIdentity === afterIdentity;
  const restorationDetail = mainSessionRestored
    ? "The main remote session restored to the same semantic surface and uniquely correlated focus after the isolated hook."
    : "The main remote session did not restore to the pre-hook semantic surface and focus.";
  records.push({
    kind: request.kind,
    element: request.element,
    result,
    mainSessionRestored,
    restorationDetail,
  });
  if (!mainSessionRestored) {
    throw new PackStop("restoration-failed", restorationDetail);
  }
  return result;
}
