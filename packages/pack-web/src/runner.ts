import type {
  ActionResult,
  Capability,
  LogEntry,
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
  TVDoctorIssue,
} from "@tvdoctor/protocol";
import {
  activeWebSurfaceEntries,
  describeWebElement,
  focusedWebCandidate,
  focusedWebEntry,
  isSafeSettingsSubmenu,
  isSafeWebControl,
  isWebInteractiveNode,
  normaliseWebSemanticText,
  rankOnScreenKeyboardKeys,
  rankWebCandidates,
  webDescriptorMatches,
  webSemanticContext,
  webSemanticStateIdentity,
  type RankedWebCandidate,
  type WebSemanticTarget,
} from "./semantics.js";
import {
  consoleErrorIssue,
  focusVisibilityIssue,
  hiddenFocusableIssue,
  logSemanticSignature,
  menuResponseIssue,
  missingAccessibleNameIssue,
  searchRemoteFlowIssue,
  viewportClippingIssue,
} from "./issues.js";
import {
  WebPackSession,
  WebPackStop,
  expandWebSurface,
  resolveWebPackConfiguration,
  safeErrorMessage,
  type ExpandedWebState,
  type ResolvedWebPackConfiguration,
  type WebSurfaceExpansion,
} from "./internal.js";
import {
  DEFAULT_WEB_PACK_BUDGETS,
  type SearchQueryEntryResult,
  type ViewportRectangle,
  type WebElementDescriptor,
  type WebFocusVisualSample,
  type WebPackOptions,
  type WebPackResult,
  type WebPackStatistics,
  type WebStageName,
  type WebStageObservation,
  type WebStageResult,
} from "./types.js";

interface StageContext {
  readonly session: WebPackSession;
  readonly options: WebPackOptions;
  readonly config: ResolvedWebPackConfiguration;
  readonly capabilities: ReadonlySet<Capability>;
}

interface FoundTarget {
  readonly candidate: RankedWebCandidate;
  readonly state: ExpandedWebState;
  readonly expansion: WebSurfaceExpansion;
}

const MAX_HOOK_TEXT = 1_024;
// A one-pixel perimeter on a typical card can change roughly 1-3% of an
// equal-size crop. The crop ratio is only accepted alongside <=1 changed style
// channel (or strictly subtle outline/border/shadow channels), so this remains
// a conservative warning rather than a visual-certification threshold.
const WEAK_FOCUS_CROP_RATIO = 0.05;

function rethrowPackStop(error: unknown): void {
  if (error instanceof WebPackStop) throw error;
}

function observation(
  kind: string,
  status: WebStageObservation["status"],
  detail: string,
  sequence: readonly RemoteKey[] = [],
  target: WebElementDescriptor | null = null,
  actionResult: ActionResult | null = null,
): WebStageObservation {
  return {
    kind,
    status,
    detail: detail.slice(0, MAX_HOOK_TEXT),
    sequence: [...sequence],
    target,
    actionResult,
  };
}

function stage(
  name: WebStageName,
  status: WebStageResult["status"],
  detail: string,
  issues: readonly TVDoctorIssue[],
  observations: readonly WebStageObservation[],
): WebStageResult {
  return { stage: name, status, detail, issues, observations };
}

function snapshotLocation(snapshot: StateSnapshot): string | null {
  if (snapshot.location.status !== "available") return null;
  return snapshot.location.value.slice(0, 240);
}

function requireRemoteTree(context: StageContext, stageName: WebStageName): WebStageResult | null {
  if (!context.capabilities.has("remote-input")) {
    return stage(stageName, "unobservable", "The driver did not expose remote-input capability.", [], [
      observation("capability", "unavailable", "remote-input capability unavailable."),
    ]);
  }
  if (!context.capabilities.has("ui-tree")) {
    return stage(stageName, "unobservable", "The driver did not expose UI-tree capability.", [], [
      observation("capability", "unavailable", "ui-tree capability unavailable."),
    ]);
  }
  return null;
}

async function defaultRestoreBase(
  session: WebPackSession,
  baseSequence: readonly RemoteKey[],
): Promise<StateSnapshot> {
  return session.restoreAndReplay(baseSequence, "discovery");
}

async function findFocusedTarget(
  session: WebPackSession,
  baseSequence: readonly RemoteKey[],
  restoreBase: () => Promise<StateSnapshot>,
  target: WebSemanticTarget,
): Promise<FoundTarget | null> {
  const expansion = await expandWebSurface(
    session,
    baseSequence,
    restoreBase,
    (item) => focusedWebCandidate(item.snapshot, target) !== null,
  );
  const state = expansion.states.find((item) => focusedWebCandidate(item.snapshot, target) !== null);
  if (state === undefined) return null;
  const candidate = focusedWebCandidate(state.snapshot, target);
  return candidate === null ? null : { candidate, state, expansion };
}

async function activateFoundTarget(
  session: WebPackSession,
  found: FoundTarget,
  category: "discovery" | "probe",
): Promise<{ readonly action: ActionResult; readonly snapshot: StateSnapshot; readonly sequence: readonly RemoteKey[] }> {
  const restored = await session.restoreAndReplay(found.state.exactPath, category);
  const focused = focusedWebEntry(restored);
  if (focused === null || !webDescriptorMatches(describeWebElement(focused.node), found.candidate.descriptor)) {
    throw new WebPackStop("restoration-failed", "A retained semantic target route diverged before activation.");
  }
  const action = await session.press("SELECT", category);
  if (action.outcome !== "applied") {
    throw new WebPackStop("restoration-failed", `SELECT on the retained target was ${action.outcome}.`);
  }
  return {
    action,
    snapshot: await session.snapshot(),
    sequence: [...found.state.exactPath, "SELECT"],
  };
}

function uniqueStableCandidate(
  snapshot: StateSnapshot,
  candidate: RankedWebCandidate | undefined,
): RankedWebCandidate | null {
  if (candidate === undefined || candidate.descriptor.stableId === null) return null;
  const matches = activeWebSurfaceEntries(snapshot).filter((entry) => (
    entry.node.stableId === candidate.descriptor.stableId
  ));
  return matches.length === 1 ? candidate : null;
}

function expansionDetail(expansion: WebSurfaceExpansion): string {
  if (expansion.reason === "target-found") {
    return `The semantic target was retained after ${String(expansion.states.length)} bounded focus states.`;
  }
  return expansion.complete
    ? `Complete bounded expansion retained ${String(expansion.states.length)} semantic focus states.`
    : `Expansion stopped at ${expansion.reason} after ${String(expansion.states.length)} semantic focus states.`;
}

async function enterQueryWithRemote(
  context: StageContext,
  searchSequence: readonly RemoteKey[],
  input: WebElementDescriptor,
): Promise<{
  readonly status: "entered" | "unavailable";
  readonly detail: string;
  readonly sequence: readonly RemoteKey[];
  readonly snapshot: StateSnapshot;
  readonly remoteOwned: boolean;
  readonly restoreQuery: () => Promise<StateSnapshot>;
}> {
  const { session, config, options } = context;
  let sequence: readonly RemoteKey[] = [...searchSequence];
  let latest = await session.restoreAndReplay(sequence, "probe");
  let remoteUnavailableReason: string | null = null;

  for (const character of [...config.searchQuery]) {
    const expansion = await expandWebSurface(
      session,
      sequence,
      async () => session.restoreAndReplay(sequence, "discovery"),
      (item) => {
        const focused = focusedWebEntry(item.snapshot);
        return focused !== null
          && rankOnScreenKeyboardKeys(item.snapshot, character).some((candidate) => candidate.node === focused.node);
      },
    );
    const keyState = expansion.states.find((item) => {
      const focused = focusedWebEntry(item.snapshot);
      if (focused === null) return false;
      return rankOnScreenKeyboardKeys(item.snapshot, character).some((candidate) => candidate.node === focused.node);
    });
    if (keyState === undefined) {
      remoteUnavailableReason = expansion.complete
        ? `No remote-reachable on-screen key represented '${character}'.`
        : `On-screen key discovery stopped at ${expansion.reason} before '${character}' was found.`;
      break;
    }
    latest = await session.restoreAndReplay(keyState.exactPath, "probe");
    const expected = rankOnScreenKeyboardKeys(latest, character);
    const focused = focusedWebEntry(latest);
    if (focused === null || !expected.some((candidate) => candidate.node === focused.node)) {
      throw new WebPackStop("restoration-failed", "An on-screen keyboard route diverged before character selection.");
    }
    const select = await session.press("SELECT", "probe");
    if (select.outcome !== "applied") {
      remoteUnavailableReason = `The '${character}' on-screen key returned ${select.outcome}.`;
      break;
    }
    sequence = [...keyState.exactPath, "SELECT"];
    latest = await session.snapshot();
  }

  if (remoteUnavailableReason === null) {
    const results = rankWebCandidates(latest, "search-result");
    const restoreQuery = async (): Promise<StateSnapshot> => session.restoreAndReplay(sequence, "discovery");
    return {
      status: results.length > 0 ? "entered" : "unavailable",
      detail: results.length > 0
        ? `The pack entered the configured query using only counted semantic on-screen keys; ${String(results.length)} result candidates were observed.`
        : "The remote query sequence completed, but no semantic result was observable.",
      sequence,
      snapshot: latest,
      remoteOwned: true,
      restoreQuery,
    };
  }

  const hook = options.hooks?.searchQueryEntry;
  if (hook === undefined) {
    return {
      status: "unavailable",
      detail: `${remoteUnavailableReason} No explicit system/driver text hook was supplied.`,
      sequence: searchSequence,
      snapshot: latest,
      remoteOwned: true,
      restoreQuery: async () => session.restoreAndReplay(searchSequence, "discovery"),
    };
  }

  const runHook = async (): Promise<{ readonly result: SearchQueryEntryResult; readonly snapshot: StateSnapshot }> => {
    const base = await session.restoreAndReplay(searchSequence, "probe");
    const result = await session.withinDuration(() => hook.enter({
      query: config.searchQuery,
      input,
      snapshot: base,
      inputSequence: searchSequence,
    }));
    validateQueryHookResult(result, config.searchQuery);
    return { result, snapshot: await session.snapshot() };
  };
  let first: Awaited<ReturnType<typeof runHook>>;
  try {
    first = await runHook();
  } catch (error) {
    rethrowPackStop(error);
    return {
      status: "unavailable",
      detail: `${remoteUnavailableReason} The explicit query hook failed safely: ${safeErrorMessage(error)}`,
      sequence: searchSequence,
      snapshot: latest,
      remoteOwned: false,
      restoreQuery: async () => session.restoreAndReplay(searchSequence, "discovery"),
    };
  }
  if (first.result.status !== "entered" || !first.result.resultsObserved) {
    return {
      status: "unavailable",
      detail: `${remoteUnavailableReason} Fallback hook: ${first.result.detail}`,
      sequence: searchSequence,
      snapshot: first.snapshot,
      remoteOwned: false,
      restoreQuery: async () => (await runHook()).snapshot,
    };
  }
  return {
    status: "entered",
    detail: `${remoteUnavailableReason} The explicit ${first.result.method} fallback entered the bounded query and observed results.`,
    sequence: searchSequence,
    snapshot: first.snapshot,
    remoteOwned: false,
    restoreQuery: async () => {
      const restored = await runHook();
      if (restored.result.status !== "entered" || !restored.result.resultsObserved) {
        throw new WebPackStop("restoration-failed", "The query-entry hook did not reproduce observable search results.");
      }
      return restored.snapshot;
    },
  };
}

function validateHookText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HOOK_TEXT) {
    throw new TypeError(`${label} must be a non-empty string no longer than ${String(MAX_HOOK_TEXT)} characters.`);
  }
}

function validateQueryHookResult(result: SearchQueryEntryResult, query: string): void {
  validateHookText(result.detail, "Query hook detail");
  if (result.status !== "entered") return;
  if (result.method !== "system-keyboard" && result.method !== "driver-text-input") {
    throw new TypeError("Query entry hook returned an unsupported method; remote keyboard input belongs to the pack.");
  }
  if (result.observedQuery.normalize("NFKC").trim() !== query) {
    throw new TypeError("Query entry hook did not observe the exact configured query.");
  }
}

async function runSearchInternal(context: StageContext): Promise<WebStageResult> {
  const capabilityFailure = requireRemoteTree(context, "search");
  if (capabilityFailure !== null) return capabilityFailure;
  const { session, options } = context;
  const observations: WebStageObservation[] = [];
  const issues: TVDoctorIssue[] = [];

  const search = await findFocusedTarget(
    session,
    [],
    async () => defaultRestoreBase(session, []),
    "search-navigation",
  );
  if (search === null) {
    return stage("search", "unobservable", "No semantic Search navigation control was remote reachable.", [], [
      observation("search-navigation", "unavailable", "Search navigation was not retained during bounded discovery."),
    ]);
  }
  const opened = await activateFoundTarget(session, search, "discovery");
  const input = uniqueStableCandidate(opened.snapshot, rankWebCandidates(opened.snapshot, "search-input")[0]);
  if (input === null) {
    return stage("search", "partial", "Search activated, but a unique stable semantic search input was not observable.", [], [
      observation("search-navigation", "available", expansionDetail(search.expansion), opened.sequence, search.candidate.descriptor, opened.action),
      observation("search-input", "unavailable", "No unique stable search input was observable.", opened.sequence),
    ]);
  }
  observations.push(observation(
    "search-navigation",
    search.expansion.complete || search.expansion.reason === "target-found" ? "available" : "partial",
    expansionDetail(search.expansion),
    opened.sequence,
    input.descriptor,
    opened.action,
  ));

  const submit = uniqueStableCandidate(opened.snapshot, rankWebCandidates(opened.snapshot, "search-submit")[0]);
  const searchExpansion = await expandWebSurface(
    session,
    opened.sequence,
    async () => session.restoreAndReplay(opened.sequence, "discovery"),
  );
  if (submit === null) {
    observations.push(observation("search-submit", "unavailable", "No unique stable visible search submit control was observable.", opened.sequence));
  } else {
    const remoteReached = searchExpansion.states.some((state) => (
      state.focused !== null && webDescriptorMatches(state.focused, submit.descriptor)
    ));
    if (remoteReached) {
      observations.push(observation("search-submit", "available", "The visible submit control was reached during bounded D-pad expansion.", opened.sequence, submit.descriptor));
    } else if (!searchExpansion.complete) {
      observations.push(observation("search-submit", "partial", `Submit was not reached, but expansion stopped at ${searchExpansion.reason}; unreachability was not claimed.`, opened.sequence, submit.descriptor));
    } else if (options.hooks?.pointerProbe === undefined) {
      observations.push(observation("search-submit", "unavailable", "Complete remote expansion did not reach submit, but no isolated pointer proof was supplied.", opened.sequence, submit.descriptor));
    } else {
      session.recordPointerProbe();
      try {
        const pointer = await session.withinDuration(() => options.hooks?.pointerProbe?.probe({
          kind: "search-submit",
          element: submit.descriptor,
          snapshot: opened.snapshot,
          surfaceSequence: opened.sequence,
        }));
        if (pointer === undefined) throw new TypeError("Pointer hook became unavailable during the stage.");
        validateHookText(pointer.detail, "Pointer hook detail");
        if (pointer.status === "activated") {
          validateHookText(pointer.observedEffect, "Pointer hook observedEffect");
          issues.push(searchRemoteFlowIssue(
            submit.descriptor,
            snapshotLocation(opened.snapshot),
            pointer.observedEffect,
          ));
          observations.push(observation("search-submit", "available", "Complete remote unreachability and isolated pointer activation were both established.", opened.sequence, submit.descriptor));
        } else {
          observations.push(observation("search-submit", "unavailable", `Pointer proof was ${pointer.status}: ${pointer.detail}`, opened.sequence, submit.descriptor));
        }
      } catch (error) {
        rethrowPackStop(error);
        observations.push(observation("search-submit", "unavailable", `Pointer proof failed safely: ${safeErrorMessage(error)}`, opened.sequence, submit.descriptor));
      }
    }
  }

  const query = await enterQueryWithRemote(context, opened.sequence, input.descriptor);
  observations.push(observation(
    "search-query",
    query.status === "entered" ? "available" : "unavailable",
    query.detail,
    query.sequence,
    input.descriptor,
  ));
  if (query.status !== "entered") {
    return stage(
      "search",
      issues.length > 0 ? "failed" : "partial",
      "Search reachability ran, but the configured non-sensitive query/results journey was incomplete.",
      issues,
      observations,
    );
  }

  const result = await findFocusedTarget(
    session,
    query.sequence,
    query.restoreQuery,
    "search-result",
  );
  if (result === null) {
    observations.push(observation("search-result", "unavailable", "Results were visible, but no semantic result was remote reachable.", query.sequence));
    return stage("search", issues.length > 0 ? "failed" : "partial", "The search result journey was incomplete.", issues, observations);
  }

  await query.restoreQuery();
  for (const key of result.state.relativePath) {
    const replay = await session.press(key, "probe");
    if (replay.outcome !== "applied") throw new WebPackStop("restoration-failed", "The search-result route could not be restored.");
  }
  const beforeResult = await session.snapshot();
  const focusedResult = focusedWebCandidate(beforeResult, "search-result");
  if (focusedResult === null) throw new WebPackStop("restoration-failed", "The retained result route diverged.");
  const selectResult = await session.press("SELECT", "probe");
  const details = await session.snapshot();
  const resultSequence: readonly RemoteKey[] = [...query.sequence, ...result.state.relativePath, "SELECT"];
  const detailsObserved = rankWebCandidates(details, "details-marker").length > 0;
  observations.push(observation(
    "search-result-details",
    detailsObserved ? "available" : "partial",
    detailsObserved ? "A remote-selected semantic result opened a details surface." : "Result activation did not expose a semantic details marker.",
    resultSequence,
    focusedResult.descriptor,
    selectResult,
  ));

  let backRestored = false;
  if (detailsObserved) {
    const back = await session.press("BACK", "probe");
    const afterBack = await session.snapshot();
    const restoredFocus = focusedWebCandidate(afterBack, "search-result");
    backRestored = restoredFocus !== null && webDescriptorMatches(restoredFocus.descriptor, focusedResult.descriptor);
    observations.push(observation(
      "search-back-restoration",
      backRestored ? "available" : "partial",
      backRestored
        ? "BACK returned to the exact semantic result focus target."
        : "BACK returned from Details, but did not restore the exact result focus target.",
      [...resultSequence, "BACK"],
      restoredFocus?.descriptor ?? null,
      back,
    ));
  }

  const complete = query.remoteOwned
    && (result.expansion.complete || result.expansion.reason === "target-found")
    && detailsObserved
    && backRestored
    && searchExpansion.complete;
  return stage(
    "search",
    issues.length > 0 ? "failed" : complete ? "passed" : "partial",
    issues.length > 0
      ? "The bounded search journey found an in-scope remote-flow defect."
      : complete
        ? "The configured non-sensitive remote search journey, result, Details, and Back restoration completed."
        : "Search ran without a classified defect, but at least one proof remained partial.",
    issues,
    observations,
  );
}

function isSettingsSurface(snapshot: StateSnapshot): boolean {
  return activeWebSurfaceEntries(snapshot).some((entry) => (
    entry.node.visible === true
    && /\bsettings\b/u.test(webSemanticContext(entry))
    && (entry.node.modal === true || normaliseWebSemanticText(entry.node.role) === "heading")
  ));
}

async function runSettingsInternal(context: StageContext): Promise<WebStageResult> {
  const capabilityFailure = requireRemoteTree(context, "settings");
  if (capabilityFailure !== null) return capabilityFailure;
  const { session } = context;
  const observations: WebStageObservation[] = [];

  const settingsTarget = await findFocusedTarget(
    session,
    [],
    async () => defaultRestoreBase(session, []),
    "settings-navigation",
  );
  if (settingsTarget === null) {
    return stage("settings", "unobservable", "No safe semantic Settings navigation control was remote reachable.", [], [
      observation("settings-navigation", "unavailable", "Settings navigation was not retained during bounded discovery."),
    ]);
  }
  const opened = await activateFoundTarget(session, settingsTarget, "discovery");
  if (!isSettingsSurface(opened.snapshot)) {
    return stage("settings", "partial", "Settings activated, but no distinct settings surface was confirmed.", [], [
      observation("settings-navigation", "partial", "Activation did not expose a settings modal/heading.", opened.sequence, settingsTarget.candidate.descriptor, opened.action),
    ]);
  }
  observations.push(observation("settings-navigation", "available", "A semantic Settings surface was opened safely.", opened.sequence, settingsTarget.candidate.descriptor, opened.action));

  interface PendingSurface {
    readonly sequence: readonly RemoteKey[];
    readonly label: string;
  }
  const pending: PendingSurface[] = [{ sequence: opened.sequence, label: "settings-root" }];
  const seenSurfaces = new Set<string>();
  let traversalComplete = true;
  let backComplete = true;

  while (pending.length > 0 && seenSurfaces.size < session.budgets.maxSettingsSurfaces) {
    const surface = pending.shift();
    if (surface === undefined) break;
    const expansion = await expandWebSurface(
      session,
      surface.sequence,
      async () => session.restoreAndReplay(surface.sequence, "discovery"),
    );
    traversalComplete &&= expansion.complete;
    const initial = expansion.states[0]?.snapshot;
    if (initial === undefined) {
      traversalComplete = false;
      continue;
    }
    const identity = webSemanticStateIdentity(initial);
    if (identity === null || seenSurfaces.has(identity)) continue;
    seenSurfaces.add(identity);

    const inventory = activeWebSurfaceEntries(initial).filter((entry) => (
      entry.node.visible === true && isWebInteractiveNode(entry.node)
    ));
    const unsafe = inventory.filter((entry) => !isSafeWebControl(entry.node, webSemanticContext(entry)));
    observations.push(observation(
      "settings-surface",
      expansion.complete ? "available" : "partial",
      `${surface.label}: inventoried ${String(inventory.length)} interactive controls; ${String(unsafe.length)} unsafe controls were excluded; ${expansionDetail(expansion)}`,
      surface.sequence,
    ));

    const submenuStates = expansion.states.filter((item) => {
      const focused = focusedWebEntry(item.snapshot);
      return focused !== null && isSafeSettingsSubmenu(focused);
    });
    for (const candidateState of submenuStates) {
      if (seenSurfaces.size + pending.length >= session.budgets.maxSettingsSurfaces) {
        traversalComplete = false;
        break;
      }
      const parent = await session.restoreAndReplay(candidateState.exactPath, "probe");
      const parentIdentity = webSemanticStateIdentity(parent);
      const focused = focusedWebEntry(parent);
      if (parentIdentity === null || focused === null || !isSafeSettingsSubmenu(focused)) continue;
      const select = await session.press("SELECT", "probe");
      if (select.outcome !== "applied") continue;
      const nested = await session.snapshot();
      const nestedIdentity = webSemanticStateIdentity(nested);
      if (nestedIdentity === null || nestedIdentity === parentIdentity || !isSettingsSurface(nested)) {
        observations.push(observation(
          "settings-submenu",
          "partial",
          "An unambiguous safe submenu label activated without exposing a distinct observable settings surface; no mutation was inferred.",
          [...candidateState.exactPath, "SELECT"],
          describeWebElement(focused.node),
          select,
        ));
        continue;
      }
      const nestedSequence: readonly RemoteKey[] = [...candidateState.exactPath, "SELECT"];
      const back = await session.press("BACK", "probe");
      const restored = await session.snapshot();
      const restoredIdentity = webSemanticStateIdentity(restored);
      const restoredParent = restoredIdentity === parentIdentity;
      backComplete &&= restoredParent;
      observations.push(observation(
        "settings-submenu",
        restoredParent ? "available" : "partial",
        restoredParent
          ? "A safe nested settings surface opened and BACK restored its exact semantic parent state."
          : "A safe nested surface opened, but BACK did not restore its exact semantic parent state.",
        [...nestedSequence, "BACK"],
        describeWebElement(focused.node),
        back,
      ));
      if (restoredParent) pending.push({ sequence: nestedSequence, label: `settings-nested-${String(seenSurfaces.size + pending.length)}` });
    }
  }
  if (pending.length > 0) traversalComplete = false;

  await session.restoreAndReplay(opened.sequence, "probe");
  const rootBack = await session.press("BACK", "probe");
  const rootRestored = await session.snapshot();
  const rootFocus = focusedWebCandidate(rootRestored, "settings-navigation");
  const rootBackRestored = rootFocus !== null
    && webDescriptorMatches(rootFocus.descriptor, settingsTarget.candidate.descriptor);
  backComplete &&= rootBackRestored;
  observations.push(observation(
    "settings-root-back",
    rootBackRestored ? "available" : "partial",
    rootBackRestored
      ? "BACK closed Settings one level and restored the semantic Settings navigation control."
      : "BACK closed or changed Settings without restoring the exact semantic navigation control.",
    [...opened.sequence, "BACK"],
    rootFocus?.descriptor ?? null,
    rootBack,
  ));

  const complete = traversalComplete && backComplete;
  return stage(
    "settings",
    complete ? "passed" : "partial",
    complete
      ? `Safe settings traversal completed across ${String(seenSurfaces.size)} surfaces without activating ambiguous, destructive, account, or payment controls.`
      : "Safe settings traversal ran, but bounded expansion or Back restoration was incomplete.",
    [],
    observations,
  );
}

function validateVisualSample(sample: WebFocusVisualSample, label: string): void {
  for (const [name, value] of Object.entries(sample)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`${label}.${name} must be finite or null.`);
    }
    if (typeof value === "string" && value.length > MAX_HOOK_TEXT) {
      throw new RangeError(`${label}.${name} exceeded the focus-proof text limit.`);
    }
  }
  if (sample.opacity !== null && (sample.opacity < 0 || sample.opacity > 1)) {
    throw new RangeError(`${label}.opacity must be between zero and one.`);
  }
  if ((sample.outlineWidthPx !== null && sample.outlineWidthPx < 0)
    || (sample.borderWidthPx !== null && sample.borderWidthPx < 0)) {
    throw new RangeError(`${label} widths must not be negative.`);
  }
}

function focusChanges(before: WebFocusVisualSample, after: WebFocusVisualSample): readonly string[] {
  return (Object.keys(before) as (keyof WebFocusVisualSample)[]).filter((key) => before[key] !== after[key]);
}

function isWeakFocusProof(
  before: WebFocusVisualSample,
  after: WebFocusVisualSample,
  ratio: number | null,
  changes: readonly string[],
): boolean {
  if (ratio === null || ratio > WEAK_FOCUS_CROP_RATIO) return false;
  if (changes.length <= 1) return true;
  const subtleChannels = new Set(["boxShadow", "borderWidthPx", "outlineWidthPx"]);
  if (!changes.every((change) => subtleChannels.has(change))) return false;
  const outlineDelta = before.outlineWidthPx === null || after.outlineWidthPx === null
    ? 0
    : Math.abs(after.outlineWidthPx - before.outlineWidthPx);
  const borderDelta = before.borderWidthPx === null || after.borderWidthPx === null
    ? 0
    : Math.abs(after.borderWidthPx - before.borderWidthPx);
  return outlineDelta <= 1 && borderDelta <= 1;
}

async function runAccessibilityInternal(context: StageContext): Promise<WebStageResult> {
  const capabilityFailure = requireRemoteTree(context, "accessibility");
  if (capabilityFailure !== null) return capabilityFailure;
  const { session, options, capabilities } = context;
  const observations: WebStageObservation[] = [];
  const issues: TVDoctorIssue[] = [];
  const expansion = await expandWebSurface(session, [], async () => defaultRestoreBase(session, []));
  const initial = expansion.states[0]?.snapshot;
  if (initial === undefined) {
    return stage("accessibility", "unobservable", "No observable semantic focus state was available.", [], [
      observation("accessibility-tree", "unavailable", "Initial UI/focus observations were unavailable."),
    ]);
  }
  const interactive = activeWebSurfaceEntries(initial).filter((entry) => (
    entry.node.visible === true && isWebInteractiveNode(entry.node)
  ));
  const missingNames = interactive.filter((entry) => normaliseWebSemanticText(entry.node.name ?? entry.node.text).length === 0);
  const hiddenFocusable = activeWebSurfaceEntries(initial).filter((entry) => (
    entry.node.focusable === true && entry.node.visible === false
  ));
  const accessibilityTreeObserved = capabilities.has("accessibility-tree");
  issues.push(...missingNames
    .filter((entry) => entry.node.stableId !== null)
    .map((entry) => missingAccessibleNameIssue(
      describeWebElement(entry.node),
      snapshotLocation(initial),
      accessibilityTreeObserved,
    )));
  issues.push(...hiddenFocusable
    .filter((entry) => entry.node.stableId !== null)
    .map((entry) => hiddenFocusableIssue(
      describeWebElement(entry.node),
      snapshotLocation(initial),
      accessibilityTreeObserved,
    )));
  observations.push(observation(
    "accessibility-tree",
    capabilities.has("accessibility-tree") ? "available" : "partial",
    `Observed ${String(interactive.length)} visible interactive nodes, ${String(missingNames.length)} without useful names, and ${String(hiddenFocusable.length)} hidden focusable nodes.${capabilities.has("accessibility-tree") ? "" : " The driver did not identify this as an accessibility-tree capability."}`,
  ));

  const hook = options.hooks?.webFocusVisibility;
  if (hook === undefined) {
    observations.push(observation("focus-visibility", "unavailable", "No explicit web computed-style/crop focus proof hook was supplied."));
    return stage(
      "accessibility",
      issues.length > 0 ? "failed" : "partial",
      issues.length > 0
        ? `Semantic accessibility inspection produced ${String(issues.length)} finding(s); visual focus visibility was unobservable.`
        : "Semantic accessibility inventory completed, but visual focus visibility was unobservable.",
      issues,
      observations,
    );
  }

  const probeStates = expansion.states.filter((state) => state.focused?.stableId !== null);
  const boundedStates = probeStates.slice(0, session.budgets.maxFocusProbes);
  let availableFocusProofs = 0;
  let incompleteFocusProofs = 0;
  for (const probeState of boundedStates) {
    const restored = await session.restoreAndReplay(probeState.exactPath, "probe");
    const focused = focusedWebEntry(restored);
    if (focused === null) continue;
    const element = describeWebElement(focused.node);
    session.recordFocusProbe();
    try {
      const result = await session.withinDuration(() => hook.probe({
        element,
        snapshot: restored,
        focusSequence: probeState.exactPath,
      }));
      validateHookText(result.detail, "Focus hook detail");
      if (result.status !== "available") {
        incompleteFocusProofs += 1;
        observations.push(observation("focus-visibility-proof", "unavailable", `${element.name ?? element.stableId ?? "control"}: ${result.detail}`, probeState.exactPath, element));
        continue;
      }
      validateVisualSample(result.unfocused, "unfocused");
      validateVisualSample(result.focused, "focused");
      if (result.screenshotDifferenceRatio !== null
        && (!Number.isFinite(result.screenshotDifferenceRatio)
          || result.screenshotDifferenceRatio < 0
          || result.screenshotDifferenceRatio > 1)) {
        throw new RangeError("Focus screenshotDifferenceRatio must be between zero and one.");
      }
      const changes = focusChanges(result.unfocused, result.focused);
      if (result.screenshotDifferenceRatio === null) incompleteFocusProofs += 1;
      else availableFocusProofs += 1;
      const weak = isWeakFocusProof(
        result.unfocused,
        result.focused,
        result.screenshotDifferenceRatio,
        changes,
      );
      observations.push(observation(
        "focus-visibility-proof",
        result.screenshotDifferenceRatio === null ? "partial" : "available",
        `${element.name ?? element.stableId ?? "control"}: ${String(changes.length)} style channels changed; crop ratio ${result.screenshotDifferenceRatio === null ? "unavailable" : result.screenshotDifferenceRatio.toFixed(6)}.`,
        probeState.exactPath,
        element,
      ));
      if (weak && element.stableId !== null) {
        issues.push(focusVisibilityIssue(
          element,
          snapshotLocation(restored),
          result,
          changes,
        ));
      }
    } catch (error) {
      rethrowPackStop(error);
      incompleteFocusProofs += 1;
      observations.push(observation(
        "focus-visibility-proof",
        "unavailable",
        `The isolated focus proof failed safely: ${safeErrorMessage(error)}`,
        probeState.exactPath,
        element,
      ));
    }
  }
  const probeTruncated = probeStates.length > boundedStates.length;
  if (probeTruncated) {
    observations.push(observation("focus-visibility", "partial", "The explicit focus-probe cap was reached; unprobed controls were not classified."));
  }
  const accessibilityTreeObservable = accessibilityTreeObserved;
  const focusProofsComplete = availableFocusProofs === boundedStates.length
    && incompleteFocusProofs === 0;
  return stage(
    "accessibility",
    issues.length > 0
      ? "failed"
      : expansion.complete && !probeTruncated && accessibilityTreeObservable && focusProofsComplete
        ? "passed"
        : "partial",
    issues.length > 0
      ? `Accessibility inspection produced ${String(issues.length)} heuristic focus-visibility warning(s).`
      : expansion.complete && !probeTruncated && accessibilityTreeObservable && focusProofsComplete
        ? "Semantic accessibility inventory and bounded focus-visibility proofs completed."
        : "Accessibility inspection completed only partially; unavailable accessibility-tree capability was not converted into a pass.",
    issues,
    observations,
  );
}

function validateViewport(viewport: ViewportRectangle): void {
  const values = [viewport.x, viewport.y, viewport.width, viewport.height];
  if (values.some((value) => !Number.isFinite(value))) throw new TypeError("Viewport values must be finite.");
  if (viewport.width <= 0 || viewport.height <= 0 || viewport.width > 32_768 || viewport.height > 32_768) {
    throw new RangeError("Viewport dimensions must be positive and no greater than 32768 pixels.");
  }
  if (Math.abs(viewport.x) > 1_000_000 || Math.abs(viewport.y) > 1_000_000) {
    throw new RangeError("Viewport origin exceeded the web-pack coordinate limit.");
  }
}

function clippedByViewport(element: WebElementDescriptor, viewport: ViewportRectangle): boolean {
  const bounds = element.bounds;
  if (bounds === null || bounds.width <= 0 || bounds.height <= 0) return false;
  const tolerance = 0.5;
  return bounds.x < viewport.x - tolerance
    || bounds.y < viewport.y - tolerance
    || bounds.x + bounds.width > viewport.x + viewport.width + tolerance
    || bounds.y + bounds.height > viewport.y + viewport.height + tolerance;
}

async function runLayoutInternal(context: StageContext): Promise<WebStageResult> {
  const capabilityFailure = requireRemoteTree(context, "layout");
  if (capabilityFailure !== null) return capabilityFailure;
  const sequence = context.config.playerSettingsSequence;
  if (sequence === null) {
    return stage("layout", "unobservable", "No streaming-discovered reset-relative player-settings sequence was supplied; layout discovery was not guessed.", [], [
      observation("player-settings-route", "unavailable", "playerSettingsSequence was absent."),
    ]);
  }
  const hook = context.options.hooks?.viewport;
  if (hook === undefined) {
    return stage("layout", "unobservable", "Viewport dimensions are not part of the core snapshot and no explicit viewport hook was supplied.", [], [
      observation("viewport", "unavailable", "Viewport observation hook was absent.", sequence),
    ]);
  }
  const snapshot = await context.session.restoreAndReplay(sequence, "probe");
  if (!isSettingsSurface(snapshot)) {
    return stage("layout", "partial", "The supplied sequence replayed, but did not expose a semantic player-settings surface.", [], [
      observation("player-settings-route", "partial", "Settings surface confirmation failed.", sequence),
    ]);
  }
  let viewportResult;
  try {
    viewportResult = await context.session.withinDuration(() => hook.observe(snapshot));
    if (viewportResult.status !== "available") {
      validateHookText(viewportResult.detail, "Viewport hook detail");
      return stage("layout", "unobservable", `Viewport proof was ${viewportResult.status}: ${viewportResult.detail}`, [], [
        observation("viewport", "unavailable", viewportResult.detail, sequence),
      ]);
    }
    validateHookText(viewportResult.source, "Viewport hook source");
    validateViewport(viewportResult.viewport);
  } catch (error) {
    rethrowPackStop(error);
    return stage("layout", "unobservable", `Viewport proof failed safely: ${safeErrorMessage(error)}`, [], [
      observation("viewport", "unavailable", safeErrorMessage(error), sequence),
    ]);
  }

  const surfaceEntries = activeWebSurfaceEntries(snapshot);
  const stableIdCounts = new Map<string, number>();
  for (const entry of surfaceEntries) {
    if (entry.node.stableId !== null) {
      stableIdCounts.set(entry.node.stableId, (stableIdCounts.get(entry.node.stableId) ?? 0) + 1);
    }
  }
  const candidates = surfaceEntries
    .filter((entry) => entry.node.visible === true
      && entry.node.stableId !== null
      && stableIdCounts.get(entry.node.stableId) === 1)
    .map((entry) => describeWebElement(entry.node))
    .filter((element) => clippedByViewport(element, viewportResult.viewport))
    .sort((left, right) => {
      const leftArea = (left.bounds?.width ?? 0) * (left.bounds?.height ?? 0);
      const rightArea = (right.bounds?.width ?? 0) * (right.bounds?.height ?? 0);
      return rightArea - leftArea
        || normaliseWebSemanticText(left.stableId).localeCompare(normaliseWebSemanticText(right.stableId), "en");
    });
  const clipped = candidates[0] ?? null;
  const observations = [observation(
    "viewport-geometry",
    "available",
    clipped === null
      ? `All visible stable settings nodes with finite bounds were inside the ${String(viewportResult.viewport.width)}x${String(viewportResult.viewport.height)} viewport.`
      : `A visible stable settings node crossed the observed viewport boundary.`,
    sequence,
    clipped,
  )];
  const issues = clipped === null ? [] : [viewportClippingIssue(
    clipped,
    snapshotLocation(snapshot),
    viewportResult.viewport,
    viewportResult.source,
  )];
  return stage(
    "layout",
    issues.length > 0 ? "failed" : "passed",
    issues.length > 0
      ? "Observable UI-tree geometry proved an in-scope viewport-clipping defect."
      : "Observable player-settings geometry stayed within the supplied viewport.",
    issues,
    observations,
  );
}

function responseLatency(result: ActionResult): number | null {
  const settled = result.timing.screenSettledAtMs;
  return settled === undefined ? null : settled - result.timing.inputSentAtMs;
}

async function runPerformanceInternal(context: StageContext): Promise<WebStageResult> {
  const capabilityFailure = requireRemoteTree(context, "performance");
  if (capabilityFailure !== null) return capabilityFailure;
  const sequence = context.config.playerSettingsSequence;
  if (sequence === null) {
    return stage("performance", "unobservable", "No streaming-discovered player-settings sequence was supplied; performance discovery was not guessed.", [], [
      observation("player-settings-route", "unavailable", "playerSettingsSequence was absent."),
    ]);
  }
  const threshold = context.config.menuResponseThresholdMs;
  if (threshold === null) {
    return stage("performance", "unobservable", "No project menu-response threshold was configured; the pack has no universal hidden threshold.", [], [
      observation("menu-response-threshold", "unavailable", "menuResponseThresholdMs was absent.", sequence),
    ]);
  }
  const prefix = sequence.slice(0, -1);
  const before = await context.session.restoreAndReplay(prefix, "probe");
  const focused = focusedWebEntry(before);
  if (focused === null
    || focused.node.stableId === null
    || !/\bsettings\b/u.test(normaliseWebSemanticText(focused.node.name ?? focused.node.text))) {
    return stage("performance", "partial", "The supplied route prefix did not restore a unique stable semantic Settings control.", [], [
      observation("player-settings-control", "partial", "Settings target confirmation failed.", prefix),
    ]);
  }
  const target = describeWebElement(focused.node);
  const action = await context.session.press("SELECT", "probe");
  const after = await context.session.snapshot();
  const latency = responseLatency(action);
  if (action.outcome !== "applied" || !isSettingsSurface(after)) {
    return stage("performance", "partial", "Settings Select did not produce a confirmed settings surface, so timing was not classified.", [], [
      observation("menu-response", "partial", "The timed action lacked semantic postcondition confirmation.", sequence, target, action),
    ]);
  }
  if (latency === null) {
    return stage("performance", "unobservable", "Settings opened, but ActionResult did not expose first-response or screen-settled timing.", [], [
      observation("menu-response", "unavailable", "ActionResult response timing was unavailable.", sequence, target, action),
    ]);
  }
  const slow = latency > threshold;
  const issues = slow ? [menuResponseIssue(target, snapshotLocation(before), action, threshold)] : [];
  return stage(
    "performance",
    slow ? "failed" : "passed",
    slow
      ? `Settings response ${String(latency)} ms exceeded the configured ${String(threshold)} ms threshold.`
      : `Settings response ${String(latency)} ms stayed within the configured ${String(threshold)} ms threshold.`,
    issues,
    [observation("menu-response", "available", `Measured ${String(latency)} ms using ActionResult timing against an explicit ${String(threshold)} ms threshold.`, sequence, target, action)],
  );
}

function validateLogs(value: readonly LogEntry[], maximum: number): readonly LogEntry[] {
  if (!Array.isArray(value)) throw new TypeError("Driver logs must be an array.");
  if (value.length > maximum) throw new RangeError("Driver logs exceeded the configured log budget; logs were not truncated into a false pass.");
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) throw new TypeError("Driver logs contained a malformed entry.");
    if (typeof entry.timestamp !== "string" || entry.timestamp.length === 0 || entry.timestamp.length > 128) {
      throw new TypeError("Driver log timestamp was invalid.");
    }
    if (!["debug", "info", "warning", "error"].includes(entry.level)) {
      throw new TypeError("Driver log level was invalid.");
    }
    if (typeof entry.message !== "string" || entry.message.length === 0 || entry.message.length > 2_048) {
      throw new TypeError("Driver log message was invalid or exceeded the bounded limit.");
    }
  }
  return value;
}

async function runCrashInternal(context: StageContext): Promise<WebStageResult> {
  const getLogs = context.session.driver.getLogs;
  if (!context.capabilities.has("logs") || getLogs === undefined) {
    return stage("crash", "unobservable", "The driver did not expose bounded application logs.", [], [
      observation("driver-logs", "unavailable", "logs capability or getLogs implementation unavailable."),
    ]);
  }
  let logs: readonly LogEntry[];
  try {
    logs = validateLogs(
      await context.session.withinDuration(() => getLogs.call(context.session.driver)),
      context.session.budgets.maxLogs,
    );
  } catch (error) {
    rethrowPackStop(error);
    return stage("crash", "unobservable", `Log observation failed safely: ${safeErrorMessage(error)}`, [], [
      observation("driver-logs", "unavailable", safeErrorMessage(error)),
    ]);
  }
  const errors = logs.filter((entry) => entry.level === "error");
  const unique = new Map<string, { readonly entry: LogEntry; count: number }>();
  for (const entry of errors) {
    const signature = logSemanticSignature(entry);
    const existing = unique.get(signature);
    if (existing === undefined) unique.set(signature, { entry, count: 1 });
    else existing.count += 1;
  }
  const issues = [...unique.values()].map(({ entry, count }) => consoleErrorIssue(entry, count));
  let liveSurface: WebStageObservation;
  if (!context.capabilities.has("ui-tree")) {
    liveSurface = observation(
      "live-surface",
      "unavailable",
      "No UI-tree capability was available to distinguish a live surface from a blank screen.",
    );
  } else {
    try {
      const snapshot = await context.session.snapshot();
      const visible = activeWebSurfaceEntries(snapshot).filter((entry) => entry.node.visible === true);
      liveSurface = observation(
        "live-surface",
        visible.length > 0 ? "available" : "partial",
        visible.length > 0
          ? `A live, non-blank semantic surface exposed ${String(visible.length)} visible nodes at the bounded observation point.`
          : "The UI tree exposed no visible semantic nodes; blank-screen robustness was not passed.",
      );
    } catch (error) {
      rethrowPackStop(error);
      liveSurface = observation(
        "live-surface",
        "unavailable",
        `The live-surface observation failed and was not converted into a pass: ${safeErrorMessage(error)}`,
      );
    }
  }
  const observableHealthySurface = liveSurface.status === "available";
  return stage(
    "crash",
    issues.length > 0 ? "failed" : observableHealthySurface ? "passed" : "partial",
    issues.length > 0
      ? `Captured ${String(errors.length)} error logs across ${String(issues.length)} stable signatures.`
      : observableHealthySurface
        ? `Captured ${String(logs.length)} bounded logs with no error-level entries and observed a live non-blank semantic surface.`
        : `Captured ${String(logs.length)} bounded logs with no error-level entries, but live/blank-screen robustness remained unobservable.`,
    issues,
    [
      observation(
        "driver-logs",
        "available",
        `Read ${String(logs.length)} bounded log entries; ${String(errors.length)} were error-level.`,
      ),
      liveSurface,
    ],
  );
}

const EMPTY_STATISTICS: WebPackStatistics = {
  physicalActions: 0,
  discoveryActions: 0,
  probeActions: 0,
  replayActions: 0,
  resets: 0,
  snapshots: 0,
  uniqueStates: 0,
  focusProbes: 0,
  pointerProbes: 0,
  elapsedMs: 0,
};

function skippedStages(names: readonly WebStageName[], detail: string): readonly WebStageResult[] {
  return names.map((name) => stage(name, "skipped", detail, [], []));
}

function failedResult(error: unknown, selected: readonly WebStageName[] = []): WebPackResult {
  const stop = error instanceof WebPackStop
    ? error
    : new WebPackStop("driver-error", safeErrorMessage(error));
  return {
    status: "error",
    termination: { reason: stop.reason, complete: false, detail: stop.message },
    budgets: { ...DEFAULT_WEB_PACK_BUDGETS },
    stages: skippedStages(selected, `Stage did not run: ${stop.message}`),
    issues: [],
    statistics: EMPTY_STATISTICS,
  };
}

export async function runWebPack(
  driver: TVDoctorDriver,
  options: WebPackOptions = {},
): Promise<WebPackResult> {
  let config: ResolvedWebPackConfiguration;
  try {
    config = resolveWebPackConfiguration(options);
  } catch (error) {
    const detail = safeErrorMessage(error);
    return {
      status: "error",
      termination: { reason: "invalid-options", complete: false, detail },
      budgets: { ...DEFAULT_WEB_PACK_BUDGETS },
      stages: [],
      issues: [],
      statistics: EMPTY_STATISTICS,
    };
  }

  let session: WebPackSession;
  try {
    session = new WebPackSession(driver, options, config.budgets);
  } catch (error) {
    return failedResult(error, config.stages);
  }

  const stages: WebStageResult[] = [];
  let activeStage: WebStageName | null = null;
  try {
    const capabilities = await session.capabilities();
    const context: StageContext = { session, options, config, capabilities };
    for (const name of config.stages) {
      session.ensureDuration();
      activeStage = name;
      switch (name) {
        case "search":
          stages.push(await runSearchInternal(context));
          break;
        case "settings":
          stages.push(await runSettingsInternal(context));
          break;
        case "accessibility":
          stages.push(await runAccessibilityInternal(context));
          break;
        case "layout":
          stages.push(await runLayoutInternal(context));
          break;
        case "performance":
          stages.push(await runPerformanceInternal(context));
          break;
        case "crash":
          stages.push(await runCrashInternal(context));
          break;
      }
      activeStage = null;
    }
    const issues = stages.flatMap((item) => item.issues);
    const uniqueIds = new Set(issues.map((issue) => issue.id));
    if (uniqueIds.size !== issues.length) {
      throw new TypeError("Independent web stages produced duplicate semantic issue IDs.");
    }
    const allUnobservable = stages.every((item) => item.status === "unobservable" || item.status === "skipped");
    const anyPartial = stages.some((item) => item.status === "partial" || item.status === "unobservable");
    return {
      status: allUnobservable ? "unobservable" : anyPartial ? "partial" : "complete",
      termination: {
        reason: "complete",
        complete: true,
        detail: "All selected web diagnostic stages terminated within their explicit budgets; stage statuses retain partial and unobservable evidence.",
      },
      budgets: config.budgets,
      stages,
      issues,
      statistics: session.statistics(),
    };
  } catch (error) {
    const stop = error instanceof WebPackStop
      ? error
      : new WebPackStop("driver-error", safeErrorMessage(error));
    const completedNames = new Set(stages.map((item) => item.stage));
    const interruptedName = stop.reason === "max-duration" ? activeStage : null;
    const interruptedStage = interruptedName !== null
      ? [stage(
        interruptedName,
        "partial",
        `Stage was interrupted by the pack-wide deadline: ${stop.message}`,
        [],
        [],
      )]
      : [];
    const remaining = config.stages.filter((name) => (
      !completedNames.has(name) && name !== interruptedName
    ));
    const retainedIssues = stages.flatMap((item) => item.issues);
    return {
      status: stop.reason === "max-duration" ? "partial" : "error",
      termination: { reason: stop.reason, complete: false, detail: stop.message },
      budgets: config.budgets,
      stages: [
        ...stages,
        ...interruptedStage,
        ...skippedStages(remaining, `Run stopped before this selected stage completed: ${stop.message}`),
      ],
      issues: retainedIssues,
      statistics: session.statistics(),
    };
  }
}

async function runSingleStage(
  name: WebStageName,
  driver: TVDoctorDriver,
  options: WebPackOptions,
): Promise<WebStageResult> {
  const result = await runWebPack(driver, { ...options, stages: [name] });
  return result.stages[0] ?? stage(name, "skipped", result.termination.detail, [], []);
}

export async function runSearchStage(driver: TVDoctorDriver, options: WebPackOptions = {}): Promise<WebStageResult> {
  return runSingleStage("search", driver, options);
}

export async function runSettingsStage(driver: TVDoctorDriver, options: WebPackOptions = {}): Promise<WebStageResult> {
  return runSingleStage("settings", driver, options);
}

export async function runAccessibilityStage(driver: TVDoctorDriver, options: WebPackOptions = {}): Promise<WebStageResult> {
  return runSingleStage("accessibility", driver, options);
}

export async function runLayoutStage(driver: TVDoctorDriver, options: WebPackOptions = {}): Promise<WebStageResult> {
  return runSingleStage("layout", driver, options);
}

export async function runPerformanceStage(driver: TVDoctorDriver, options: WebPackOptions = {}): Promise<WebStageResult> {
  return runSingleStage("performance", driver, options);
}

export async function runCrashStage(driver: TVDoctorDriver, options: WebPackOptions = {}): Promise<WebStageResult> {
  return runSingleStage("crash", driver, options);
}
