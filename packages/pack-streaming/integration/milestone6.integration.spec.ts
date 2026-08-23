import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import * as ts from "typescript";
import {
  compileIssueReplay,
  executeReplay,
  type CompiledReplayPlan,
} from "@tvdoctor/core";
import {
  PlaywrightWebDriver,
  WEB_DRIVER_CAPABILITIES,
  type WebLogEntry,
} from "@tvdoctor/driver-web";
import {
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportJson,
  type ActionResult,
  type ArtifactDescriptor,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  createArtifactStore,
  renderReportJson,
  writeIssueEvidence,
  writeReportBundle,
  type ArtifactStore,
  type IssueEvidenceSlot,
  type JsonObject,
  type JsonValue,
} from "@tvdoctor/reporters";
import {
  STREAMING_STAGE_NAMES,
  runStreamingPack,
  type StreamingElementDescriptor,
  type StreamingPackResult,
  type StreamingPointerProbe,
  type StreamingPointerProbeRequest,
  type StreamingPointerProbeRecord,
  type StreamingPointerProbeResult,
  type StreamingStageName,
} from "../src/index.js";

interface SeededDefect {
  readonly id: string;
  readonly expectedRule: string;
  readonly screen: string;
  readonly target: string;
}

interface SeedManifest {
  readonly defects: readonly SeededDefect[];
}

interface PointerObservation {
  readonly kind: StreamingPointerProbeRequest["kind"];
  readonly element: StreamingElementDescriptor;
  readonly property: string;
  readonly before: string | null;
  readonly after: string;
  readonly surfaceSequence: readonly RemoteKey[];
}

interface RouteJunction {
  readonly from: StreamingElementDescriptor;
  readonly to: StreamingElementDescriptor;
  readonly sequence: readonly RemoteKey[];
  readonly visualRelation: "down" | "right" | null;
}

interface RouteProfile {
  readonly homeToContent: RouteJunction;
  readonly playerToSettings: RouteJunction;
  readonly captionsToAppearance: RouteJunction;
}

interface RealPackRun {
  readonly result: StreamingPackResult;
  readonly appearanceInventory: readonly string[];
  readonly routeProfile: RouteProfile;
}

interface CapturedIssue {
  readonly issue: TVDoctorIssue;
  readonly descriptors: readonly ArtifactDescriptor[];
  readonly plan: CompiledReplayPlan | null;
}

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(packageDirectory, "../../..");
const fixtureDirectory = resolve(workspaceDirectory, "fixtures/broken-streaming-web");
const manifestPath = resolve(fixtureDirectory, "seeded-defects.json");
const artifactRoot = resolve(workspaceDirectory, "artifacts/milestone-6-gate");
const M6_RULES = [
  "accessibility.pointer-only-control",
  "remote.reachability",
  "streaming.captions",
  "streaming.player-control",
] as const;
const ISSUE_SLOTS = [
  "before-screenshot",
  "after-screenshot",
  "ui-excerpt",
  "transition",
  "console-log",
  "navigation-path",
  "replay",
  "trace",
] as const satisfies readonly IssueEvidenceSlot[];

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The M6 fixture URL is required.");
  return baseURL;
}

function createDriver(artifactsDirectory?: string): PlaywrightWebDriver {
  return new PlaywrightWebDriver({
    ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }),
    settle: {
      noResponseGraceMs: 15,
      quietWindowMs: 100,
      timeoutMs: 5_000,
    },
  });
}

async function pressSequence(
  driver: PlaywrightWebDriver,
  sequence: readonly RemoteKey[],
): Promise<void> {
  for (const key of sequence) {
    const action = await driver.press(key);
    expect(action, `remote ${key}`).toMatchObject({ key, outcome: "applied" });
  }
}

function normalisedText(value: string | null): string | null {
  if (value === null) return null;
  const result = value.replace(/\s+/gu, " ").trim();
  return result.length === 0 ? null : result.slice(0, 240);
}

function semanticPointerStem(kind: StreamingPointerProbeRequest["kind"]): RegExp {
  return kind === "caption-text-colour"
    ? /Text Colou?r/iu
    : /Boost dialogue/iu;
}

function pointerRequestProblem(request: StreamingPointerProbeRequest): string | null {
  const requestedName = normalisedText(request.element.name);
  if (
    request.element.role !== "button"
    || requestedName === null
    || request.element.visible !== true
    || request.element.enabled !== true
    || !semanticPointerStem(request.kind).test(requestedName)
  ) {
    return "The requested pointer target lacked the required visible, enabled button semantics.";
  }

  const semanticMatches = flattenNodes(request.snapshot).filter((node) => (
    node.visible === true
    && node.enabled === true
    && node.role === request.element.role
    && normalisedText(node.name) === requestedName
  ));
  const exactMatches = semanticMatches.filter((node) => (
    request.element.stableId === null || node.stableId === request.element.stableId
  ));
  if (semanticMatches.length !== 1 || exactMatches.length !== 1) {
    return "The pointer target was not uniquely corroborated by the supplied semantic snapshot.";
  }
  return null;
}

function createFreshPointerProbe(
  fixtureUrl: string,
  observations: PointerObservation[],
): StreamingPointerProbe {
  return {
    async probe(request): Promise<StreamingPointerProbeResult> {
      const driver = createDriver();
      await driver.launch({
        id: `m6-isolated-pointer-${request.kind}-${String(observations.length + 1)}`,
        launchUri: fixtureUrl,
      });
      try {
        await pressSequence(driver, request.surfaceSequence);
        const requestProblem = pointerRequestProblem(request);
        if (requestProblem !== null) {
          return { status: "unobservable", detail: requestProblem };
        }
        const page = driver.getPage();
        const requestedName = request.element.name;
        if (requestedName === null) {
          return { status: "unobservable", detail: "The pointer target had no accessible name." };
        }
        const control = page.getByRole("button", { name: semanticPointerStem(request.kind) });
        if (await control.count() !== 1 || !await control.isVisible() || !await control.isEnabled()) {
          return {
            status: "unobservable",
            detail: `The isolated ${request.kind} target did not match the uniquely corroborated accessible button.`,
          };
        }

        if (request.kind === "caption-text-colour") {
          const sample = page.getByText("Caption preview", { exact: true });
          const beforeLabel = normalisedText(await control.innerText());
          const beforeColour = await sample.evaluate((element) => getComputedStyle(element).color);
          await control.click();
          const afterControl = page.getByRole("button", { name: semanticPointerStem(request.kind) });
          if (await afterControl.count() !== 1) {
            return { status: "unobservable", detail: "The activated semantic target was not unique after rerender." };
          }
          const afterLabel = normalisedText(await afterControl.innerText());
          const afterColour = await page.getByText("Caption preview", { exact: true })
            .evaluate((element) => getComputedStyle(element).color);
          const before = `${beforeLabel ?? "unknown"} | ${beforeColour}`;
          const after = `${afterLabel ?? "unknown"} | ${afterColour}`;
          if (beforeLabel === afterLabel || beforeColour === afterColour) {
            return {
              status: "unobservable",
              detail: "Pointer activation did not change both the Text Colour value and preview colour.",
            };
          }
          observations.push({
            kind: request.kind,
            element: request.element,
            property: "caption text colour",
            before,
            after,
            surfaceSequence: [...request.surfaceSequence],
          });
          return {
            status: "reachable",
            detail: "A fresh isolated Chromium page changed both the Text Colour value and preview colour by pointer.",
            observedChange: { property: "caption text colour", before, after },
          };
        }

        const status = page.getByRole("status");
        const before = await status.count() === 0 ? null : normalisedText(await status.textContent());
        await control.click();
        await expect(status).toContainText(/dialogue boost/iu);
        const after = normalisedText(await status.textContent());
        if (after === null || after === before) {
          return { status: "unobservable", detail: "Pointer activation produced no bounded dialogue-boost status change." };
        }
        observations.push({
          kind: request.kind,
          element: request.element,
          property: "dialogue boost status",
          before,
          after,
          surfaceSequence: [...request.surfaceSequence],
        });
        return {
          status: "reachable",
          detail: "A fresh isolated Chromium page changed the dialogue-boost status by pointer.",
          observedChange: { property: "dialogue boost status", before, after },
        };
      } finally {
        await driver.close();
      }
    },
  };
}

async function runRealPack(
  fixtureUrl: string,
  observations: PointerObservation[],
): Promise<RealPackRun> {
  const driver = createDriver();
  await driver.launch({ id: `m6-pack-${String(observations.length)}`, launchUri: fixtureUrl });
  try {
    const result = await runStreamingPack(driver, {
      pointerProbe: createFreshPointerProbe(fixtureUrl, observations),
    });
    if (result.status !== "complete" || !result.termination.complete) {
      throw new Error(`The real streaming pack did not complete: ${JSON.stringify({
        termination: result.termination,
        stages: result.stages,
        issues: result.issues.map((issue) => ({ rule: issue.rule, id: issue.id })),
        statistics: result.statistics,
      })}`);
    }
    const acceptance = await inspectAcceptanceSurfaces(driver, result);
    return { result, ...acceptance };
  } finally {
    await driver.close();
  }
}

function stage(result: StreamingPackResult, name: StreamingStageName) {
  const matches = result.stages.filter((candidate) => candidate.stage === name);
  expect(matches, `stage ${name}`).toHaveLength(1);
  const value = matches[0];
  if (value === undefined) throw new Error(`Missing streaming stage ${name}.`);
  return value;
}

function issueStageName(rule: string): StreamingStageName {
  switch (rule) {
    case "streaming.player-control": return "seek-backward";
    case "streaming.captions": return "caption-selection";
    case "remote.reachability": return "caption-text-colour";
    case "accessibility.pointer-only-control": return "player-volume";
    default: throw new Error(`Unexpected M6 rule: ${rule}`);
  }
}

function issueTarget(result: StreamingPackResult, issue: TVDoctorIssue): string {
  const target = stage(result, issueStageName(issue.rule)).target?.stableId ?? null;
  if (target === null) throw new Error(`Issue ${issue.id} has no observable semantic target.`);
  const transitionValues = [
    issue.transition?.fromElement,
    issue.transition?.expectedElement,
    issue.transition?.observedElement,
  ];
  expect(transitionValues, `${issue.rule} transition target`).toContain(target);
  return target;
}

function scopedSeeds(manifest: SeedManifest): readonly SeededDefect[] {
  const rules = new Set<string>(M6_RULES);
  return manifest.defects.filter((defect) => (
    defect.screen.startsWith("player") && rules.has(defect.expectedRule)
  ));
}

function issueKeys(result: StreamingPackResult): readonly string[] {
  return result.issues
    .map((issue) => `${issue.rule}|${issueTarget(result, issue)}`)
    .sort();
}

function seedKeys(seeds: readonly SeededDefect[]): readonly string[] {
  return seeds.map((seed) => `${seed.expectedRule}|${seed.target}`).sort();
}

interface TypeScriptSourceFile {
  readonly path: string;
  readonly source: string;
}

async function readTypeScriptTree(directory: string): Promise<readonly TypeScriptSourceFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: TypeScriptSourceFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await readTypeScriptTree(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push({ path: absolute, source: await readFile(absolute, "utf8") });
    }
  }
  return files;
}

const REMOTE_KEY_LITERALS = new Set<string>(["UP", "RIGHT", "DOWN", "LEFT", "SELECT", "BACK"]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticRemoteSequence(
  expression: ts.Expression,
  declarations: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): readonly string[] | null {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current)) {
    return REMOTE_KEY_LITERALS.has(current.text) ? [current.text] : null;
  }
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return null;
    const initializer = declarations.get(current.text);
    if (initializer === undefined) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(current.text);
    return staticRemoteSequence(initializer, declarations, nextSeen);
  }
  if (ts.isArrayLiteralExpression(current)) {
    const result: string[] = [];
    for (const element of current.elements) {
      const value = ts.isSpreadElement(element)
        ? staticRemoteSequence(element.expression, declarations, seen)
        : staticRemoteSequence(element, declarations, seen);
      if (value === null) return null;
      result.push(...value);
    }
    return result;
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === "concat"
  ) {
    const base = staticRemoteSequence(current.expression.expression, declarations, seen);
    if (base === null) return null;
    const result = [...base];
    for (const argument of current.arguments) {
      const value = staticRemoteSequence(argument, declarations, seen);
      if (value === null) return null;
      result.push(...value);
    }
    return result;
  }
  return null;
}

function hardcodedRemoteSequences(file: TypeScriptSourceFile): readonly string[] {
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const violations: string[] = [];
  const inspect = (node: ts.Node): void => {
    if (ts.isExpression(node)) {
      const sequence = staticRemoteSequence(node, declarations);
      if (sequence !== null && sequence.length >= 5) {
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(`${file.path}:${String(location.line + 1)} (${sequence.join(" ")})`);
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return [...new Set(violations)];
}

function hardcodedRemoteRouteFragments(file: TypeScriptSourceFile): readonly string[] {
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, ts.Expression>();
  const fragments: { readonly line: number; readonly sequence: readonly string[] }[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const inspect = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const sequence = staticRemoteSequence(node, declarations);
      const directionalEnumeration = sequence !== null
        && sequence.length === 4
        && new Set(sequence).size === 4
        && sequence.every((key) => key === "UP" || key === "RIGHT" || key === "DOWN" || key === "LEFT");
      if (sequence !== null && sequence.length >= 2 && !directionalEnumeration) {
        fragments.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          sequence,
        });
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  if (fragments.reduce((total, fragment) => total + fragment.sequence.length, 0) < 5) return [];
  return fragments.map((fragment) => (
    `${file.path}:${String(fragment.line)} (${fragment.sequence.join(" ")})`
  ));
}

function productionShortcutViolations(files: readonly TypeScriptSourceFile[]): readonly string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (/\bdataset\b|data-(?:defect-id|nav|tv-id)|\b(?:dataDefectId|dataNav|dataTvId)\b/iu.test(file.source)) {
      violations.push(`fixture data attribute: ${file.path}`);
    }
    if (/\bmanifest\b|seeded-defects(?:\.json)?|broken-streaming-web/iu.test(file.source)) {
      violations.push(`fixture manifest: ${file.path}`);
    }
    if (/\b(?:routeVariant|semantic-alternate|searchParams|launchUri)\b|\.location\b/iu.test(file.source)) {
      violations.push(`fixture route channel: ${file.path}`);
    }
    for (const sequence of hardcodedRemoteSequences(file)) {
      violations.push(`hardcoded remote sequence: ${sequence}`);
    }
    for (const fragment of hardcodedRemoteRouteFragments(file)) {
      violations.push(`hardcoded route fragments: ${fragment}`);
    }
  }
  return violations;
}

async function assertNoFixtureShortcuts(manifest: SeedManifest): Promise<void> {
  const files = await readTypeScriptTree(resolve(packageDirectory, "../src"));
  const source = files.map((file) => file.source).join("\n");
  expect(productionShortcutViolations(files)).toEqual([]);
  const guardSamples: readonly TypeScriptSourceFile[] = [
    { path: "data-shortcut.ts", source: "const target = element.dataset.nav;" },
    { path: "manifest-shortcut.ts", source: "const targets = readFile('seeded-defects.json');" },
    {
      path: "route-shortcut.ts",
      source: "const first = ['UP', 'RIGHT']; const second = ['DOWN', 'LEFT', 'SELECT']; const route = [...first, ...second];",
    },
    {
      path: "fragmented-route-shortcut.ts",
      source: "const open = ['RIGHT', 'SELECT']; const nested = ['DOWN', 'RIGHT', 'SELECT']; run(open); run(nested);",
    },
    {
      path: "variant-shortcut.ts",
      source: "const alternate = snapshot.location.value.includes('semantic-alternate');",
    },
  ];
  const guardResults = productionShortcutViolations(guardSamples).join("\n");
  expect(guardResults).toContain("fixture data attribute");
  expect(guardResults).toContain("fixture manifest");
  expect(guardResults).toContain("fixture route channel");
  expect(guardResults).toContain("hardcoded remote sequence");
  expect(guardResults).toContain("hardcoded route fragments");
  const semanticApiNames = new Set<string>([
    ...STREAMING_STAGE_NAMES,
    "caption-text-colour",
    "player-volume-control",
  ]);
  for (const defect of scopedSeeds(manifest)) {
    const escaped = defect.target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const identityUse = new RegExp(
      `(?:stableId|fromElement|expectedElement|observedElement|querySelector|locator|getByTestId)[^\\r\\n]{0,120}["']${escaped}["']`,
      "iu",
    );
    expect(source, `fixture identity leaked into pack source: ${defect.target}`).not.toMatch(identityUse);
    if (!semanticApiNames.has(defect.target)) {
      expect(source, `fixture target literal leaked into pack source: ${defect.target}`)
        .not.toMatch(new RegExp(`["']${escaped}["']`, "u"));
    }
  }
}

function flattenNodes(snapshot: StateSnapshot): readonly UiNodeSnapshot[] {
  if (snapshot.uiTree.status !== "available") return [];
  const result: UiNodeSnapshot[] = [];
  const pending = [...snapshot.uiTree.value].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return result;
}

function flattenSubtree(root: UiNodeSnapshot): readonly UiNodeSnapshot[] {
  const result: UiNodeSnapshot[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return result;
}

function descriptorFromNode(node: UiNodeSnapshot): StreamingElementDescriptor {
  return {
    stableId: node.stableId,
    role: node.role,
    name: node.name,
    bounds: node.bounds,
    visible: node.visible,
    enabled: node.enabled,
    focusable: node.focusable,
    selectionState: node.selectionState,
    valueNow: node.valueNow,
  };
}

function descriptorIdentity(descriptor: StreamingElementDescriptor): string {
  return JSON.stringify([
    descriptor.stableId,
    descriptor.role,
    normalisedText(descriptor.name),
  ]);
}

function uniqueNode(
  snapshot: StateSnapshot,
  label: string,
  predicate: (node: UiNodeSnapshot) => boolean,
): UiNodeSnapshot {
  const matches = flattenNodes(snapshot).filter(predicate);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`${label} was not uniquely observable (${String(matches.length)} matches).`);
  }
  return matches[0];
}

function uniqueSubtreeNode(
  root: UiNodeSnapshot,
  label: string,
  predicate: (node: UiNodeSnapshot) => boolean,
): UiNodeSnapshot {
  const matches = flattenSubtree(root).filter(predicate);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`${label} was not uniquely observable (${String(matches.length)} matches).`);
  }
  return matches[0];
}

function focusedNode(snapshot: StateSnapshot, label: string): UiNodeSnapshot {
  return uniqueNode(snapshot, label, (node) => node.visible === true && node.focused === true);
}

async function resetAndSnapshot(
  driver: PlaywrightWebDriver,
  sequence: readonly RemoteKey[],
): Promise<StateSnapshot> {
  await driver.reset("reload");
  await pressSequence(driver, sequence);
  return await driver.snapshot();
}

function withoutTerminalSelect(sequence: readonly RemoteKey[], label: string): readonly RemoteKey[] {
  if (sequence.at(-1) !== "SELECT") {
    throw new Error(`${label} did not end with the semantic SELECT activation.`);
  }
  return sequence.slice(0, -1);
}

function suffixAfter(
  sequence: readonly RemoteKey[],
  prefix: readonly RemoteKey[],
  label: string,
): readonly RemoteKey[] {
  if (
    prefix.length > sequence.length
    || !prefix.every((key, index) => sequence[index] === key)
  ) {
    throw new Error(`${label} was not an independent suffix of its containing semantic route.`);
  }
  return sequence.slice(prefix.length);
}

function visualRelation(
  from: StreamingElementDescriptor,
  to: StreamingElementDescriptor,
  axis: "down" | "right",
): "down" | "right" | null {
  if (from.bounds === null || to.bounds === null) return null;
  const fromCentre = axis === "right"
    ? from.bounds.x + from.bounds.width / 2
    : from.bounds.y + from.bounds.height / 2;
  const toCentre = axis === "right"
    ? to.bounds.x + to.bounds.width / 2
    : to.bounds.y + to.bounds.height / 2;
  return toCentre > fromCentre ? axis : null;
}

async function inspectAcceptanceSurfaces(
  driver: PlaywrightWebDriver,
  result: StreamingPackResult,
): Promise<{ readonly appearanceInventory: readonly string[]; readonly routeProfile: RouteProfile }> {
  const appearanceStage = stage(result, "appearance");
  const appearanceEntrySequence = withoutTerminalSelect(
    appearanceStage.sequence,
    "Appearance route",
  );
  const appearanceSnapshot = await resetAndSnapshot(driver, appearanceStage.sequence);
  const appearanceDialog = uniqueNode(appearanceSnapshot, "Caption Appearance dialog", (node) => (
    node.role === "dialog"
    && node.visible === true
    && /^Appearance$/iu.test(normalisedText(node.name) ?? "")
  ));
  const selectableRoles = new Set(["button", "checkbox", "combobox", "option", "radio", "slider", "switch"]);
  const appearanceInventory = flattenSubtree(appearanceDialog)
    .filter((node) => (
      node !== appearanceDialog
      && node.visible === true
      && node.enabled === true
      && node.role !== null
      && selectableRoles.has(node.role)
    ))
    .map((node) => descriptorIdentity(descriptorFromNode(node)))
    .sort();
  if (appearanceInventory.length === 0) {
    throw new Error("The independent Caption Appearance inventory was empty.");
  }

  const home = stage(result, "home").target;
  const content = stage(result, "content").target;
  if (home === null || content === null) throw new Error("The Home/content junction lacked semantic targets.");

  const playerStage = stage(result, "player");
  const playerSnapshot = await resetAndSnapshot(driver, playerStage.sequence);
  const playerFrom = descriptorFromNode(focusedNode(playerSnapshot, "Player Play/Pause focus"));
  const settingsNode = uniqueNode(playerSnapshot, "Player Settings control", (node) => (
    node.role === "button"
    && node.visible === true
    && node.enabled === true
    && /\bSettings\b/iu.test(normalisedText(node.name) ?? "")
  ));
  const settingsTarget = descriptorFromNode(settingsNode);
  const playerToSettings = suffixAfter(
    withoutTerminalSelect(stage(result, "settings").sequence, "Settings route"),
    playerStage.sequence,
    "Player-to-Settings route",
  );

  const captionsStage = stage(result, "captions");
  const captionsSnapshot = await resetAndSnapshot(driver, appearanceEntrySequence);
  const captionsDialog = uniqueNode(captionsSnapshot, "Captions dialog", (node) => (
    node.role === "dialog"
    && node.visible === true
    && /^Captions$/iu.test(normalisedText(node.name) ?? "")
  ));
  const captionsFrom = descriptorFromNode(uniqueSubtreeNode(captionsDialog, "selected caption track", (node) => (
    node.role === "button"
    && node.visible === true
    && node.enabled === true
    && node.selectionState === "on"
  )));
  const appearanceNode = uniqueSubtreeNode(captionsDialog, "Caption Appearance control", (node) => (
    node.role === "button"
    && node.visible === true
    && node.enabled === true
    && /^Appearance/iu.test(normalisedText(node.name) ?? "")
  ));
  const appearanceTarget = descriptorFromNode(appearanceNode);
  const captionsToAppearance = suffixAfter(
    appearanceEntrySequence,
    captionsStage.sequence,
    "Captions-to-Appearance route",
  );

  return {
    appearanceInventory,
    routeProfile: {
      homeToContent: {
        from: home,
        to: content,
        sequence: suffixAfter(stage(result, "content").sequence, stage(result, "home").sequence, "Home-to-content route"),
        visualRelation: visualRelation(home, content, "right"),
      },
      playerToSettings: {
        from: playerFrom,
        to: settingsTarget,
        sequence: playerToSettings,
        visualRelation: visualRelation(playerFrom, settingsTarget, "right"),
      },
      captionsToAppearance: {
        from: captionsFrom,
        to: appearanceTarget,
        sequence: captionsToAppearance,
        visualRelation: visualRelation(captionsFrom, appearanceTarget, "down"),
      },
    },
  };
}

function snapshotJson(snapshot: StateSnapshot): JsonObject {
  const focus = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value
    : null;
  const interactive = flattenNodes(snapshot)
    .filter((node) => node.visible === true && (
      node.focusable === true
      || node.role === "button"
      || node.selectionState !== null
      || node.valueNow !== null
    ))
    .slice(0, 80)
    .map((node): JsonObject => ({
      stableId: node.stableId,
      role: node.role,
      name: node.name,
      visible: node.visible,
      enabled: node.enabled,
      focusable: node.focusable,
      focused: node.focused,
      selectionState: node.selectionState,
      valueNow: node.valueNow,
      bounds: node.bounds === null
        ? null
        : {
            x: node.bounds.x,
            y: node.bounds.y,
            width: node.bounds.width,
            height: node.bounds.height,
          },
    }));
  return {
    capturedAt: snapshot.capturedAt,
    location: snapshot.location.status === "available" ? snapshot.location.value : null,
    focusedElement: focus === null
      ? null
      : {
          stableId: focus.stableId ?? null,
          role: focus.role ?? null,
          name: focus.name ?? null,
        },
    interactive,
  };
}

function actionJson(result: ActionResult): JsonObject {
  return {
    key: result.key,
    outcome: result.outcome,
    message: result.message ?? null,
    timing: {
      inputSentAtMs: result.timing.inputSentAtMs,
      firstResponseAtMs: result.timing.firstResponseAtMs ?? null,
      focusSettledAtMs: result.timing.focusSettledAtMs ?? null,
      screenSettledAtMs: result.timing.screenSettledAtMs ?? null,
    },
  };
}

function descriptorJson(descriptor: StreamingElementDescriptor): JsonObject {
  return {
    stableId: descriptor.stableId,
    role: descriptor.role,
    name: descriptor.name,
    bounds: descriptor.bounds === null
      ? null
      : {
          x: descriptor.bounds.x,
          y: descriptor.bounds.y,
          width: descriptor.bounds.width,
          height: descriptor.bounds.height,
        },
    visible: descriptor.visible,
    enabled: descriptor.enabled,
    focusable: descriptor.focusable,
    selectionState: descriptor.selectionState,
    valueNow: descriptor.valueNow,
  };
}

function stageJson(stageResult: StreamingPackResult["stages"][number]): JsonObject {
  return {
    name: stageResult.stage,
    status: stageResult.status,
    detail: stageResult.detail,
    sequence: [...stageResult.sequence],
    target: stageResult.target === null ? null : descriptorJson(stageResult.target),
  };
}

function packProofJson(result: StreamingPackResult, issue: TVDoctorIssue): JsonObject {
  const observedStage = stage(result, issueStageName(issue.rule));
  return {
    stage: stageJson(observedStage),
    stageLedger: result.stages.map(stageJson),
    termination: {
      reason: result.termination.reason,
      complete: result.termination.complete,
      detail: result.termination.detail,
    },
    budgets: { ...result.budgets },
    statistics: { ...result.statistics },
  };
}

function pointerKindForIssue(
  issue: TVDoctorIssue,
): StreamingPointerProbeRequest["kind"] | null {
  if (issue.rule === "remote.reachability") return "caption-text-colour";
  if (issue.rule === "accessibility.pointer-only-control") return "player-volume-control";
  return null;
}

function pointerRecordForIssue(
  result: StreamingPackResult,
  issue: TVDoctorIssue,
): StreamingPointerProbeRecord | null {
  const kind = pointerKindForIssue(issue);
  if (kind === null) return null;
  const matches = result.pointerProbes.filter((record) => record.kind === kind);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Issue ${issue.id} did not have exactly one ${kind} pointer record.`);
  }
  return matches[0];
}

function pointerRecordJson(record: StreamingPointerProbeRecord | null): JsonObject | null {
  if (record === null) return null;
  return {
    kind: record.kind,
    element: descriptorJson(record.element),
    remoteJourneyRestored: record.mainSessionRestored,
    restorationDetail: record.restorationDetail,
    result: record.result.status === "reachable"
      ? {
          status: record.result.status,
          detail: record.result.detail,
          observedChange: {
            property: record.result.observedChange.property,
            before: record.result.observedChange.before,
            after: record.result.observedChange.after,
          },
        }
      : {
          status: record.result.status,
          detail: record.result.detail,
        },
  };
}

function logsJson(logs: readonly WebLogEntry[]): JsonValue {
  return logs.map((entry): JsonObject => ({
    timestamp: entry.timestamp,
    level: entry.level,
    message: entry.message,
    source: entry.source,
    location: entry.location,
    stack: entry.stack,
  }));
}

function expandSteps(steps: readonly { readonly key: RemoteKey; readonly repeat: number }[]): readonly RemoteKey[] {
  return steps.flatMap((step) => Array.from({ length: step.repeat }, () => step.key));
}

function sequenceForIssue(result: StreamingPackResult, issue: TVDoctorIssue): readonly RemoteKey[] {
  if (issue.reproduction.status === "available") {
    return expandSteps(issue.reproduction.originalSequence);
  }
  return stage(result, issueStageName(issue.rule)).sequence;
}

function replayText(replay: TVDoctorReplayV1): string {
  // JSON is a strict portable subset of YAML 1.2 and preserves replay semantics exactly.
  return `${JSON.stringify(replay, null, 2)}\n`;
}

function compileAvailableIssue(issue: TVDoctorIssue): CompiledReplayPlan | null {
  if (issue.reproduction.status === "unavailable") return null;
  const compiled = compileIssueReplay(issue);
  expect(compiled.status, issue.id).toBe("compiled");
  if (compiled.status !== "compiled") throw new Error(compiled.reason.message);
  return compiled.plan;
}

function evidenceSlotForSummary(summary: string): IssueEvidenceSlot {
  if (/screenshot records the state before/iu.test(summary)) return "before-screenshot";
  if (/screenshot records the state after/iu.test(summary)) return "after-screenshot";
  if (/exact reset-relative|\bexpanded\b|\bexpansion\b/iu.test(summary)) return "navigation-path";
  if (/pointer|--(?:UP|RIGHT|DOWN|LEFT|SELECT|BACK)-->/iu.test(summary)) return "transition";
  return "ui-excerpt";
}

async function captureIssue(
  store: ArtifactStore,
  fixtureUrl: string,
  result: StreamingPackResult,
  issue: TVDoctorIssue,
): Promise<CapturedIssue> {
  const sequence = sequenceForIssue(result, issue);
  if (sequence.length === 0) throw new Error(`Issue ${issue.id} has no evidence sequence.`);
  const plan = compileAvailableIssue(issue);
  const pointerRecord = pointerRecordForIssue(result, issue);
  const setup = sequence.slice(0, -1);
  const assertionKey = sequence.at(-1);
  if (assertionKey === undefined) throw new Error(`Issue ${issue.id} has no assertion key.`);

  const driver = createDriver(store.outputRoot);
  await driver.launch({ id: `m6-evidence-${issue.id}`, launchUri: fixtureUrl });
  try {
    await pressSequence(driver, setup);
    const beforeSnapshot = await driver.snapshot();
    const beforeScreenshot = await driver.getPage().screenshot({ animations: "disabled", type: "png" });
    const action = await driver.press(assertionKey);
    expect(action).toMatchObject({ key: assertionKey, outcome: "applied" });
    const afterSnapshot = await driver.snapshot();
    const afterScreenshot = await driver.getPage().screenshot({ animations: "disabled", type: "png" });
    const logs = await driver.getLogs();
    const written = await writeIssueEvidence(store, {
      issueId: issue.id,
      artifacts: [
        {
          slot: "before-screenshot",
          capture: { status: "available", format: "binary", data: beforeScreenshot, mediaType: "image/png" },
        },
        {
          slot: "after-screenshot",
          capture: { status: "available", format: "binary", data: afterScreenshot, mediaType: "image/png" },
        },
        {
          slot: "ui-excerpt",
          capture: {
            status: "available",
            format: "json",
            value: { before: snapshotJson(beforeSnapshot), after: snapshotJson(afterSnapshot) },
          },
        },
        {
          slot: "transition",
          capture: {
            status: "available",
            format: "json",
            value: {
              assertion: issue.transition === null
                ? null
                : {
                    fromElement: issue.transition.fromElement,
                    action: issue.transition.action,
                    expectedElement: issue.transition.expectedElement,
                    observedElement: issue.transition.observedElement,
                  },
              dispatched: actionJson(action),
              beforeFocus: beforeSnapshot.focusedElement.status === "available"
                ? beforeSnapshot.focusedElement.value?.stableId ?? null
                : null,
              afterFocus: afterSnapshot.focusedElement.status === "available"
                ? afterSnapshot.focusedElement.value?.stableId ?? null
                : null,
              pointerProbe: pointerRecordJson(pointerRecord),
            },
          },
        },
        {
          slot: "console-log",
          capture: { status: "available", format: "json", value: logsJson(logs) },
        },
        {
          slot: "navigation-path",
          capture: {
            status: "available",
            format: "json",
            value: {
              exactResetRelativeSequence: sequence,
              assertionKey,
              resetStrategy: issue.reproduction.status === "available"
                ? issue.reproduction.resetStrategy
                : "reload",
              reproductionStatus: issue.reproduction.status,
              reproductionReason: issue.reproduction.status === "unavailable"
                ? issue.reproduction.reason
                : null,
              packProof: packProofJson(result, issue),
            },
          },
        },
        {
          slot: "replay",
          capture: plan === null
            ? {
                status: "unavailable",
                reason: issue.reproduction.status === "unavailable"
                  ? issue.reproduction.reason
                  : "No portable replay plan was compiled.",
              }
            : {
                status: "available",
                format: "text",
                text: replayText(plan.replay),
                mediaType: "text/yaml",
              },
        },
        {
          slot: "trace",
          capture: {
            status: "unavailable",
            reason: "This gate captured exact snapshots and screenshots but no standalone Playwright trace.",
          },
        },
      ],
    });

    const transitionPath = written.pathsBySlot["transition"] ?? null;
    const uiPath = written.pathsBySlot["ui-excerpt"] ?? null;
    const navigationPath = written.pathsBySlot["navigation-path"] ?? null;
    const beforePath = written.pathsBySlot["before-screenshot"] ?? null;
    const afterPath = written.pathsBySlot["after-screenshot"] ?? null;
    if (
      transitionPath === null
      || uiPath === null
      || navigationPath === null
      || beforePath === null
      || afterPath === null
    ) {
      throw new Error(`Issue ${issue.id} lacked a required structured evidence artifact.`);
    }
    const pathForEvidenceSlot = (slot: IssueEvidenceSlot): string => {
      if (slot === "before-screenshot") return beforePath;
      if (slot === "after-screenshot") return afterPath;
      if (slot === "navigation-path") return navigationPath;
      if (slot === "transition") return transitionPath;
      return uiPath;
    };
    const enhanced: TVDoctorIssue = {
      ...issue,
      evidence: [
        ...issue.evidence.map((entry) => ({
          ...entry,
          artifact: pathForEvidenceSlot(evidenceSlotForSummary(entry.summary)),
        })),
        {
          kind: "verified-fact",
          summary: "A fresh Chromium screenshot records the state before the exact final remote action.",
          source: "M6 acceptance gate",
          artifact: beforePath,
        },
        {
          kind: "verified-fact",
          summary: "A fresh Chromium screenshot records the state after the exact final remote action.",
          source: "M6 acceptance gate",
          artifact: afterPath,
        },
        {
          kind: "verified-fact",
          summary: "A bounded UI-tree excerpt records visible controls, focus, selection, and numeric values.",
          source: "PlaywrightWebDriver.snapshot",
          artifact: uiPath,
        },
      ],
      reproduction: issue.reproduction.status === "available"
        ? { ...issue.reproduction, artifact: written.pathsBySlot["replay"] ?? null }
        : issue.reproduction,
    };
    return { issue: enhanced, descriptors: written.descriptors, plan };
  } finally {
    await driver.close();
  }
}

async function assertArtifactIntegrity(
  root: string,
  artifacts: readonly ArtifactDescriptor[],
): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.status !== "available") continue;
    const absolute = resolve(root, ...artifact.path.split("/"));
    const [metadata, bytes] = await Promise.all([stat(absolute), readFile(absolute)]);
    expect(metadata.isFile(), artifact.id).toBe(true);
    expect(metadata.size, artifact.id).toBe(artifact.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex"), artifact.id).toBe(artifact.sha256);
  }
}

async function assertArtifactCrossLinks(
  root: string,
  issues: readonly TVDoctorIssue[],
  artifacts: readonly ArtifactDescriptor[],
  replays: readonly TVDoctorReplayV1[],
): Promise<void> {
  const paths = new Set(artifacts.flatMap((artifact) => (
    artifact.status === "available" ? [artifact.path] : []
  )));
  for (const issue of issues) {
    const owned = artifacts.filter((artifact) => ISSUE_SLOTS.some((slot) => (
      artifact.id === `${issue.id}:${slot}`
    )));
    const ownedPaths = new Set(owned.flatMap((artifact) => (
      artifact.status === "available" ? [artifact.path] : []
    )));
    expect(owned.map((artifact) => artifact.id).sort(), issue.id)
      .toEqual(ISSUE_SLOTS.map((slot) => `${issue.id}:${slot}`).sort());
    for (const evidence of issue.evidence) {
      if (evidence.artifact !== null) {
        expect(paths.has(evidence.artifact), evidence.artifact).toBe(true);
        expect(ownedPaths.has(evidence.artifact), `${issue.id} owns ${evidence.artifact}`).toBe(true);
        const supportingArtifact = owned.find((artifact) => (
          artifact.status === "available" && artifact.path === evidence.artifact
        ));
        expect(supportingArtifact?.id, evidence.summary)
          .toBe(`${issue.id}:${evidenceSlotForSummary(evidence.summary)}`);
      }
    }
    const embedded = replays.filter((replay) => replay.issueId === issue.id);
    if (issue.reproduction.status === "available") {
      expect(embedded, issue.id).toHaveLength(1);
      const replayArtifact = owned.find((artifact) => artifact.id === `${issue.id}:replay`);
      expect(replayArtifact?.status, issue.id).toBe("available");
      if (replayArtifact?.status !== "available" || embedded[0] === undefined) continue;
      expect(issue.reproduction.artifact, issue.id).toBe(replayArtifact.path);
      expect(JSON.parse(await readFile(resolve(root, ...replayArtifact.path.split("/")), "utf8")))
        .toEqual(embedded[0]);
    } else {
      expect(embedded, issue.id).toEqual([]);
      expect(owned.find((artifact) => artifact.id === `${issue.id}:replay`)?.status).toBe("unavailable");
    }
  }
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertStructuredPointerEvidence(
  root: string,
  issues: readonly TVDoctorIssue[],
  artifacts: readonly ArtifactDescriptor[],
): Promise<void> {
  for (const issue of issues) {
    const kind = pointerKindForIssue(issue);
    if (kind === null) continue;
    const transition = artifacts.find((artifact) => artifact.id === `${issue.id}:transition`);
    if (transition?.status !== "available") {
      throw new Error(`Pointer issue ${issue.id} lacked an available transition artifact.`);
    }
    const parsed: unknown = JSON.parse(await readFile(
      resolve(root, ...transition.path.split("/")),
      "utf8",
    ));
    if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed["pointerProbe"])) {
      throw new Error(`Pointer issue ${issue.id} lacked structured pointer evidence.`);
    }
    const pointer = parsed["pointerProbe"];
    if (!isUnknownRecord(pointer["result"]) || !isUnknownRecord(pointer["element"])) {
      throw new Error(`Pointer issue ${issue.id} had malformed pointer provenance.`);
    }
    const result = pointer["result"];
    if (!isUnknownRecord(result["observedChange"])) {
      throw new Error(`Pointer issue ${issue.id} lacked a structured observed change.`);
    }
    const observedChange = result["observedChange"];
    expect(pointer["kind"], issue.id).toBe(kind);
    expect(pointer["remoteJourneyRestored"], issue.id).toBe(true);
    expect(result["status"], issue.id).toBe("reachable");
    expect(observedChange["property"], issue.id).toEqual(expect.any(String));
    expect(observedChange["before"], issue.id).not.toBe(observedChange["after"]);
    expect(observedChange["after"], issue.id).toEqual(expect.any(String));
    expect(pointer["element"], issue.id).toMatchObject({
      stableId: issueTargetFromTransition(issue),
      role: "button",
      visible: true,
      enabled: true,
    });
  }
}

async function assertStructuredStageEvidence(
  root: string,
  issues: readonly TVDoctorIssue[],
  artifacts: readonly ArtifactDescriptor[],
): Promise<void> {
  const expectedStatuses = [
    ["home", "passed"],
    ["content", "passed"],
    ["details", "passed"],
    ["play", "passed"],
    ["player", "passed"],
    ["controls", "passed"],
    ["player-volume", "failed"],
    ["pause-resume", "passed"],
    ["seek-forward", "passed"],
    ["seek-backward", "failed"],
    ["player-back", "passed"],
    ["settings", "passed"],
    ["captions", "passed"],
    ["caption-selection", "failed"],
    ["appearance", "passed"],
    ["caption-text-colour", "failed"],
    ["nested-back", "passed"],
  ] as const;

  for (const issue of issues) {
    const navigation = artifacts.find((artifact) => artifact.id === `${issue.id}:navigation-path`);
    if (navigation?.status !== "available") {
      throw new Error(`Issue ${issue.id} lacked available navigation-path evidence.`);
    }
    const parsed: unknown = JSON.parse(await readFile(
      resolve(root, ...navigation.path.split("/")),
      "utf8",
    ));
    if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed["packProof"])) {
      throw new Error(`Issue ${issue.id} lacked structured pack proof.`);
    }
    const packProof = parsed["packProof"];
    const ledger = packProof["stageLedger"];
    const observedStage = packProof["stage"];
    if (!Array.isArray(ledger) || !isUnknownRecord(observedStage)) {
      throw new Error(`Issue ${issue.id} lacked a structured stage ledger.`);
    }
    expect(ledger, `${issue.id} stage ledger`).toHaveLength(STREAMING_STAGE_NAMES.length);
    expect(ledger.map((entry) => {
      if (!isUnknownRecord(entry)) throw new Error(`Issue ${issue.id} had a malformed stage ledger entry.`);
      return [entry["name"], entry["status"]];
    }), `${issue.id} ordered stage ledger`).toEqual(expectedStatuses);
    expect(observedStage["name"], issue.id).toBe(issueStageName(issue.rule));
    expect(observedStage["status"], issue.id).toBe("failed");
  }
}

async function assertStructuredProgressEvidence(
  root: string,
  issues: readonly TVDoctorIssue[],
  artifacts: readonly ArtifactDescriptor[],
): Promise<void> {
  const issue = issues.find((candidate) => candidate.rule === "streaming.player-control");
  if (issue === undefined) throw new Error("The player-control issue was not reported.");
  const uiExcerpt = artifacts.find((artifact) => artifact.id === `${issue.id}:ui-excerpt`);
  if (uiExcerpt?.status !== "available") {
    throw new Error(`Issue ${issue.id} lacked available UI-tree evidence.`);
  }
  const parsed: unknown = JSON.parse(await readFile(
    resolve(root, ...uiExcerpt.path.split("/")),
    "utf8",
  ));
  if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed["before"]) || !isUnknownRecord(parsed["after"])) {
    throw new Error(`Issue ${issue.id} lacked structured before/after UI evidence.`);
  }
  const valueFor = (snapshot: Readonly<Record<string, unknown>>, phase: "before" | "after"): number => {
    const interactive = snapshot["interactive"];
    if (!Array.isArray(interactive)) throw new Error(`Issue ${issue.id} lacked ${phase} interactive nodes.`);
    const values = interactive.flatMap((entry) => (
      isUnknownRecord(entry) && entry["role"] === "progressbar" && typeof entry["valueNow"] === "number"
        ? [entry["valueNow"]]
        : []
    ));
    expect(values, `${issue.id} ${phase} progress values`).toHaveLength(1);
    const value = values[0];
    if (value === undefined) throw new Error(`Issue ${issue.id} lacked a ${phase} progress value.`);
    return value;
  };
  const before = valueFor(parsed["before"], "before");
  const after = valueFor(parsed["after"], "after");
  expect(after, issue.id).toBeGreaterThan(before);
  expect(issue.evidence.some((entry) => entry.summary.includes(`valueNow was ${String(before)} before SELECT`)), issue.id)
    .toBe(true);
  expect(issue.evidence.some((entry) => entry.summary.includes(`valueNow was ${String(after)} after SELECT`)), issue.id)
    .toBe(true);
}

function issueTargetFromTransition(issue: TVDoctorIssue): string | null {
  return issue.transition?.expectedElement ?? issue.transition?.fromElement ?? null;
}

function assertPointerObservations(
  result: StreamingPackResult,
  observations: readonly PointerObservation[],
): void {
  expect(observations).toHaveLength(2);
  expect(observations.map((observation) => observation.kind).sort()).toEqual([
    "caption-text-colour",
    "player-volume-control",
  ]);
  for (const observation of observations) {
    expect(observation.surfaceSequence.length, observation.kind).toBeGreaterThan(0);
    expect(observation.before, observation.kind).not.toBe(observation.after);
    expect(observation.property.length, observation.kind).toBeGreaterThan(0);
    const record = result.pointerProbes.find((candidate) => candidate.kind === observation.kind);
    expect(record, observation.kind).toBeDefined();
    if (record !== undefined) {
      expect(descriptorIdentity(observation.element)).toBe(descriptorIdentity(record.element));
      if (record.result.status === "reachable") {
        expect(observation.property).toBe(record.result.observedChange.property);
      }
    }
  }
}

function assertCompletePack(
  result: StreamingPackResult,
  expectedKeys: readonly string[],
  appearanceInventory: readonly string[],
): void {
  expect(result.status, JSON.stringify({
    termination: result.termination,
    stages: result.stages,
    issues: result.issues.map((issue) => ({ rule: issue.rule, id: issue.id })),
    statistics: result.statistics,
  })).toBe("complete");
  expect(result.termination).toMatchObject({ reason: "complete", complete: true });
  expect(result.statistics.physicalActions).toBeLessThanOrEqual(result.budgets.maxActions);
  expect(result.statistics.uniqueStates).toBeLessThanOrEqual(result.budgets.maxStates);
  expect(result.statistics.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(result.statistics.elapsedMs).toBeLessThanOrEqual(result.budgets.maxDurationMs);
  expect(result.stages.map((value) => value.stage)).toEqual(STREAMING_STAGE_NAMES);
  expect(result.stages.map((value) => [value.stage, value.status])).toEqual([
    ["home", "passed"],
    ["content", "passed"],
    ["details", "passed"],
    ["play", "passed"],
    ["player", "passed"],
    ["controls", "passed"],
    ["player-volume", "failed"],
    ["pause-resume", "passed"],
    ["seek-forward", "passed"],
    ["seek-backward", "failed"],
    ["player-back", "passed"],
    ["settings", "passed"],
    ["captions", "passed"],
    ["caption-selection", "failed"],
    ["appearance", "passed"],
    ["caption-text-colour", "failed"],
    ["nested-back", "passed"],
  ]);
  expect(result.issues).toHaveLength(4);
  expect(result.issues.every((issue) => (
    issue.pack === "streaming" && issue.confidence === "deterministic"
  ))).toBe(true);
  expect(issueKeys(result)).toEqual(expectedKeys);
  expect(result.issues.some((issue) => issue.rule === "layout.viewport-clipping")).toBe(false);

  const unavailableRules = result.issues
    .filter((issue) => issue.reproduction.status === "unavailable")
    .map((issue) => issue.rule)
    .sort();
  expect(unavailableRules).toEqual(["streaming.captions", "streaming.player-control"]);
  const replayableRules = result.issues
    .filter((issue) => issue.reproduction.status === "available")
    .map((issue) => issue.rule)
    .sort();
  expect(replayableRules).toEqual([
    "accessibility.pointer-only-control",
    "remote.reachability",
  ]);
  expect(result.replays).toHaveLength(2);
  expect(result.replays.every((replay) => replay.status === "reproduced")).toBe(true);

  expect(result.pointerProbes.map((record) => record.kind).sort()).toEqual([
    "caption-text-colour",
    "player-volume-control",
  ]);
  expect(result.pointerProbes).toHaveLength(2);
  for (const record of result.pointerProbes) {
    expect(record.result.status, record.kind).toBe("reachable");
    if (record.result.status === "reachable") {
      expect(record.result.observedChange.before, record.kind)
        .not.toBe(record.result.observedChange.after);
      expect(record.result.observedChange.after.length, record.kind).toBeGreaterThan(0);
    }
    expect(record.mainSessionRestored, record.restorationDetail).toBe(true);
  }
  expect(result.statistics.pointerProbes).toBe(2);
  expect(result.volumeControl).not.toBeNull();
  expect(result.volumeControl).toMatchObject({
    remotelyReachable: false,
    exactSequence: null,
    activation: "observed",
  });

  const textControls = result.appearanceControls.filter((control) => (
    /Text Colou?r/iu.test(control.element.name ?? "")
  ));
  expect(textControls).toHaveLength(1);
  expect(textControls[0]).toMatchObject({
    remotelyReachable: false,
    exactSequence: null,
  });
  expect(stage(result, "appearance").detail).toMatch(/expansion completed/iu);
  const enumeratedAppearance = result.appearanceControls
    .map((control) => descriptorIdentity(control.element))
    .sort();
  expect(new Set(enumeratedAppearance).size).toBe(enumeratedAppearance.length);
  expect(enumeratedAppearance).toEqual(appearanceInventory);
}

type ReportBudgetExhaustion = "depth" | "actions" | "states" | "duration" | "repetitive-items";

function exhaustedBudgetCategories(result: StreamingPackResult): readonly ReportBudgetExhaustion[] {
  if (result.termination.complete) return [];
  switch (result.termination.reason) {
    case "max-actions": return ["actions"];
    case "max-states":
    case "max-local-states": return ["states"];
    case "max-local-depth": return ["depth"];
    case "max-duration": return ["duration"];
    default: return [];
  }
}

async function executeFreshReplay(
  fixtureUrl: string,
  plan: CompiledReplayPlan,
  label: string,
): Promise<void> {
  const driver = createDriver();
  await driver.launch({ id: label, launchUri: fixtureUrl });
  try {
    const replay = await executeReplay(driver, plan);
    expect(replay.status, `${label}: ${JSON.stringify(replay.reason)}`).toBe("reproduced");
    expect(replay.sequence.executedSequence).toEqual(plan.sequence.executedSequence);
  } finally {
    await driver.close();
  }
}

function replayLabelMatches(node: UiNodeSnapshot, label: string): boolean {
  if (node.stableId !== null && node.stableId.trim().length > 0) return node.stableId === label;
  if (node.name !== null && node.name.trim().length > 0) return node.name === label;
  return node.role === label;
}

function snapshotFocusedOn(snapshot: StateSnapshot, label: string): StateSnapshot {
  if (snapshot.uiTree.status !== "available") {
    throw new Error(`The fixed simulation could not observe ${label} in the UI tree.`);
  }
  const matches = flattenNodes(snapshot).filter((node) => replayLabelMatches(node, label));
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`The fixed simulation expected one ${label} target, observed ${String(matches.length)}.`);
  }
  const target = matches[0];
  const cloneNode = (node: UiNodeSnapshot): UiNodeSnapshot => ({
    ...node,
    focused: node === target,
    focusable: node === target ? true : node.focusable,
    children: node.children.map(cloneNode),
  });
  return {
    ...snapshot,
    focusedElement: {
      status: "available",
      value: {
        ...(target.stableId === null ? {} : { stableId: target.stableId }),
        ...(target.role === null ? {} : { role: target.role }),
        ...(target.name === null ? {} : { name: target.name }),
        ...(target.bounds === null ? {} : { bounds: target.bounds }),
      },
    },
    uiTree: { status: "available", value: snapshot.uiTree.value.map(cloneNode) },
  };
}

function replaySimulationDriver(
  driver: PlaywrightWebDriver,
  plan: CompiledReplayPlan,
  mode: "checkpoint-drift" | "fixed",
): TVDoctorDriver {
  const setupActions = plan.setup.steps.reduce((total, step) => total + step.repeat, 0);
  let presses = 0;
  return {
    capabilities: async () => await driver.capabilities(),
    async press(key) {
      const result = await driver.press(key);
      presses += 1;
      return result;
    },
    async snapshot() {
      const snapshot = await driver.snapshot();
      if (mode === "checkpoint-drift" && presses === setupActions) {
        return {
          ...snapshot,
          focusedElement: {
            status: "available",
            value: {
              stableId: "m6-checkpoint-drift-sentinel",
              role: "button",
              name: "M6 checkpoint drift sentinel",
            },
          },
        };
      }
      if (mode === "fixed" && presses === setupActions + 1) {
        const expected = plan.assertion.expectedElement;
        if (expected === null) throw new Error("The fixed simulation requires an expected focus target.");
        return snapshotFocusedOn(snapshot, expected);
      }
      return snapshot;
    },
    async reset(strategy) {
      presses = 0;
      await driver.reset(strategy);
    },
  };
}

async function assertFixedSimulation(
  fixtureUrl: string,
  plan: CompiledReplayPlan,
): Promise<void> {
  if (plan.assertion.fromElement === null || plan.assertion.expectedElement === null) {
    throw new Error(`Replay ${plan.replay.id} needs concrete focus identifiers for fixed simulation.`);
  }
  const driver = createDriver();
  await driver.launch({ id: `m6-fixed-${plan.replay.issueId}`, launchUri: fixtureUrl });
  try {
    const fixed = await executeReplay(replaySimulationDriver(driver, plan, "fixed"), plan);
    expect(fixed.status, JSON.stringify(fixed.reason)).toBe("fixed");
  } finally {
    await driver.close();
  }
}

async function assertCheckpointDriftSimulation(
  fixtureUrl: string,
  plan: CompiledReplayPlan,
): Promise<void> {
  const driver = createDriver();
  await driver.launch({ id: `m6-drift-${plan.replay.issueId}`, launchUri: fixtureUrl });
  try {
    const drift = await executeReplay(replaySimulationDriver(driver, plan, "checkpoint-drift"), plan);
    expect(drift.status, JSON.stringify(drift.reason)).toBe("inconclusive");
    expect(drift.reason).toMatchObject({ code: "checkpoint-drift", phase: "checkpoint" });
    expect(drift.actionsPressed).toBe(plan.totalActions - 1);
  } finally {
    await driver.close();
  }
}

function aiTaskForIssue(
  markdown: string,
  kind: "Fix" | "Review",
  issueId: string,
): string {
  const heading = `# TVDoctor ${kind} Task — ${issueId}`;
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`The AI report lacked ${heading}.`);
  const end = markdown.indexOf("\n\n---\n\n", start);
  return markdown.slice(start, end < 0 ? undefined : end);
}

test("M6 discovers, proves, reports, and replays the semantic streaming showcase without a stored route", async ({
  baseURL,
  page,
}) => {
  const fixtureUrl = requireBaseURL(baseURL);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SeedManifest;
  const expectedSeeds = scopedSeeds(manifest);
  expect(expectedSeeds).toHaveLength(4);
  const expectedKeys = seedKeys(expectedSeeds);
  expect(new Set(expectedKeys).size).toBe(expectedKeys.length);
  await assertNoFixtureShortcuts(manifest);

  const alternate = new URL(fixtureUrl);
  alternate.searchParams.set("routeVariant", "semantic-alternate");
  const alternatePointerObservations: PointerObservation[] = [];
  const alternateRun = await runRealPack(alternate.href, alternatePointerObservations);
  const alternateResult = alternateRun.result;
  assertCompletePack(alternateResult, expectedKeys, alternateRun.appearanceInventory);
  assertPointerObservations(alternateResult, alternatePointerObservations);

  const startedAt = new Date();
  const defaultPointerObservations: PointerObservation[] = [];
  const defaultRun = await runRealPack(fixtureUrl, defaultPointerObservations);
  const defaultResult = defaultRun.result;
  assertCompletePack(defaultResult, expectedKeys, defaultRun.appearanceInventory);
  assertPointerObservations(defaultResult, defaultPointerObservations);
  expect(alternateResult.issues.map((issue) => `${issue.rule}|${issue.id}`).sort())
    .toEqual(defaultResult.issues.map((issue) => `${issue.rule}|${issue.id}`).sort());

  const defaultRoutes = defaultRun.routeProfile;
  const alternateRoutes = alternateRun.routeProfile;
  expect(defaultRoutes.homeToContent.sequence.length).toBeGreaterThan(0);
  expect(defaultRoutes.homeToContent.sequence.every((key) => key === "RIGHT")).toBe(true);
  expect(alternateRoutes.homeToContent.sequence).toEqual([]);
  expect(defaultRoutes.homeToContent.visualRelation).toBe("right");
  expect(alternateRoutes.homeToContent.visualRelation).toBeNull();
  expect(normalisedText(alternateRoutes.homeToContent.from.name))
    .toBe(normalisedText(alternateRoutes.homeToContent.to.name));
  expect(alternateRoutes.homeToContent.from.role).toBe(alternateRoutes.homeToContent.to.role);
  expect(alternateRoutes.playerToSettings.sequence.length).toBeGreaterThan(0);
  expect(defaultRoutes.playerToSettings.sequence.length)
    .toBeGreaterThan(alternateRoutes.playerToSettings.sequence.length);
  expect([...defaultRoutes.playerToSettings.sequence, ...alternateRoutes.playerToSettings.sequence]
    .every((key) => key === "RIGHT")).toBe(true);
  expect(defaultRoutes.playerToSettings.visualRelation).toBe("right");
  expect(alternateRoutes.playerToSettings.visualRelation).toBe("right");
  expect(alternateRoutes.captionsToAppearance.sequence.length).toBeGreaterThan(0);
  expect(defaultRoutes.captionsToAppearance.sequence.length)
    .toBeGreaterThan(alternateRoutes.captionsToAppearance.sequence.length);
  expect([...defaultRoutes.captionsToAppearance.sequence, ...alternateRoutes.captionsToAppearance.sequence]
    .every((key) => key === "DOWN")).toBe(true);
  expect(defaultRoutes.captionsToAppearance.visualRelation).toBe("down");
  expect(alternateRoutes.captionsToAppearance.visualRelation).toBe("down");
  const routePairs = [
    [defaultRoutes.homeToContent, alternateRoutes.homeToContent],
    [defaultRoutes.playerToSettings, alternateRoutes.playerToSettings],
    [defaultRoutes.captionsToAppearance, alternateRoutes.captionsToAppearance],
  ] as const;
  expect(routePairs.every(([defaultRoute, alternateRoute]) => (
    JSON.stringify(defaultRoute.sequence) !== JSON.stringify(alternateRoute.sequence)
  )), JSON.stringify({ defaultRoutes, alternateRoutes })).toBe(true);

  const store = await createArtifactStore(artifactRoot, { overwrite: true });
  const captured: CapturedIssue[] = [];
  for (const issue of defaultResult.issues) {
    captured.push(await captureIssue(store, fixtureUrl, defaultResult, issue));
  }
  const plans = captured.flatMap((entry) => entry.plan === null ? [] : [entry.plan]);
  expect(plans).toHaveLength(2);

  for (const plan of plans) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await executeFreshReplay(
        fixtureUrl,
        plan,
        `m6-fresh-replay-${plan.replay.issueId}-${String(attempt)}`,
      );
    }
    await assertFixedSimulation(fixtureUrl, plan);
    await assertCheckpointDriftSimulation(fixtureUrl, plan);
  }

  const reportedDurationMs = Math.max(0, Math.round(defaultResult.statistics.elapsedMs));
  const completedAt = new Date(startedAt.getTime() + reportedDurationMs);
  const report = buildTVDoctorReportV1({
    run: {
      id: `m6-northstar-${String(startedAt.getTime())}`,
      tvdoctorVersion: "0.0.0",
      mode: "standard",
      status: "completed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: reportedDurationMs,
    },
    target: {
      name: "Northstar broken streaming fixture",
      platform: "web",
      location: fixtureUrl,
      environment: {
        browser: "chromium",
        viewport: "1280x720",
        journey: "semantic discovery with no configured route or fixture hints",
        authToken: "M6_SUPER_SECRET_MUST_NOT_LEAK",
        hostileObservation: "<img src=x onerror=\"window.__m6Injected=true\">",
      },
    },
    coverage: {
      screenStatesDiscovered: 6,
      focusStatesDiscovered: defaultResult.statistics.uniqueStates,
      transitionsTested: defaultResult.statistics.physicalActions,
      actionsSent: defaultResult.statistics.physicalActions,
      capabilitiesObserved: [...WEB_DRIVER_CAPABILITIES],
      packs: [{ pack: "streaming", status: "completed" }],
      budget: {
        maxActions: defaultResult.budgets.maxActions,
        maxStates: defaultResult.budgets.maxStates,
        maxDepth: defaultResult.budgets.maxLocalDepth,
        maxDurationMs: defaultResult.budgets.maxDurationMs,
        maxRepetitiveItems: null,
        exhausted: exhaustedBudgetCategories(defaultResult),
      },
    },
    issues: captured.map((entry) => entry.issue),
    artifacts: captured.flatMap((entry) => entry.descriptors),
    replays: plans.map((plan) => plan.replay),
  });
  const bundle = await writeReportBundle(store, report);

  const reportText = await readFile(bundle.reportJson.absolutePath, "utf8");
  const parsed = parseTVDoctorReportJson(reportText);
  expect(parsed.schemaVersion).toBe(REPORT_SCHEMA_VERSION_V1);
  if (parsed.schemaVersion !== REPORT_SCHEMA_VERSION_V1) throw new Error("M6 report was not V1.");
  expect(parsed.issues).toHaveLength(4);
  expect(parsed.replays).toHaveLength(2);
  expect(parsed.artifacts).toHaveLength(32);
  expect(parsed.run.durationMs).toBe(reportedDurationMs);
  expect(new Date(parsed.run.completedAt).getTime() - new Date(parsed.run.startedAt).getTime())
    .toBe(parsed.run.durationMs);
  expect(parsed.coverage.actionsSent).toBe(defaultResult.statistics.physicalActions);
  expect(parsed.coverage.focusStatesDiscovered).toBe(defaultResult.statistics.uniqueStates);
  expect(parsed.coverage.budget.exhausted).toEqual([]);
  expect(parsed.coverage.packs).toEqual([{ pack: "streaming", status: "completed" }]);
  expect(parsed.target.environment["authToken"]).toBe("[REDACTED]");
  expect(reportText).not.toContain("M6_SUPER_SECRET_MUST_NOT_LEAK");
  expect(renderReportJson(parsed)).toBe(reportText);
  await assertArtifactIntegrity(store.outputRoot, parsed.artifacts);
  await assertArtifactCrossLinks(store.outputRoot, parsed.issues, parsed.artifacts, parsed.replays);
  await assertStructuredPointerEvidence(store.outputRoot, parsed.issues, parsed.artifacts);
  await assertStructuredStageEvidence(store.outputRoot, parsed.issues, parsed.artifacts);
  await assertStructuredProgressEvidence(store.outputRoot, parsed.issues, parsed.artifacts);

  const reportConsoleErrors: string[] = [];
  const reportPageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") reportConsoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => { reportPageErrors.push(error.message); });
  await page.goto(pathToFileURL(bundle.reportHtml.absolutePath).href);
  await expect(page.locator("h1")).toHaveText("TVDoctor");
  await expect(page.locator("details.issue")).toHaveCount(4);
  await page.locator("details.issue").evaluateAll((elements) => {
    for (const element of elements) (element as HTMLDetailsElement).open = true;
  });
  for (const issue of parsed.issues) {
    const panel = page.locator("details.issue", { hasText: issue.id });
    await expect(panel, issue.id).toHaveCount(1);
    await expect(panel, issue.id).toContainText(issue.title);
    await expect(panel, issue.id).toContainText(issue.expected);
    await expect(panel, issue.id).toContainText(issue.observed);
    await expect(panel.locator("img"), `${issue.id} screenshot pair`).toHaveCount(2);
    if (issue.reproduction.status === "available") {
      await expect(panel, issue.id).toContainText(`tvdoctor replay ${issue.id}`);
    }
  }
  await expect(page.locator("img")).toHaveCount(8);
  await expect.poll(async () => await page.locator("img").evaluateAll((images) => (
    images.every((image) => (image as HTMLImageElement).naturalWidth === 1280
      && (image as HTMLImageElement).naturalHeight === 720)
  ))).toBe(true);
  expect(await page.evaluate(() => (window as Window & { __m6Injected?: boolean }).__m6Injected))
    .toBeUndefined();
  expect(reportConsoleErrors).toEqual([]);
  expect(reportPageErrors).toEqual([]);

  const html = await readFile(bundle.reportHtml.absolutePath, "utf8");
  expect(html).toContain("Content-Security-Policy");
  expect(html).toContain("&lt;img src=x onerror=&quot;window.__m6Injected=true&quot;&gt;");
  expect(html).not.toContain("M6_SUPER_SECRET_MUST_NOT_LEAK");
  const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => ({
    raw: (anchor as HTMLAnchorElement).getAttribute("href"),
    resolved: (anchor as HTMLAnchorElement).href,
  })));
  for (const artifact of parsed.artifacts) {
    if (artifact.status !== "available") continue;
    const link = links.find((candidate) => candidate.raw === artifact.path);
    expect(link, artifact.id).toBeDefined();
    if (link !== undefined) {
      expect(fileURLToPath(link.resolved), artifact.id)
        .toBe(resolve(store.outputRoot, ...artifact.path.split("/")));
    }
  }
  const inspectionPath = resolve(store.outputRoot, "m6-report-inspection.png");
  await page.screenshot({ path: inspectionPath, fullPage: true });
  const inspectionMetadata = await stat(inspectionPath);
  expect(inspectionMetadata.isFile()).toBe(true);
  expect(inspectionMetadata.size).toBeGreaterThan(0);

  const markdown = await readFile(bundle.reportMarkdown.absolutePath, "utf8");
  const aiMarkdown = await readFile(bundle.aiReportMarkdown.absolutePath, "utf8");
  expect(markdown).not.toContain("M6_SUPER_SECRET_MUST_NOT_LEAK");
  expect(aiMarkdown).not.toContain("M6_SUPER_SECRET_MUST_NOT_LEAK");
  for (const issue of parsed.issues) {
    expect(markdown).toContain(issue.id);
    expect(aiMarkdown).toContain(issue.id);
  }
  expect((aiMarkdown.match(/^# TVDoctor Fix Task/gmu) ?? [])).toHaveLength(2);
  expect((aiMarkdown.match(/^# TVDoctor Review Task/gmu) ?? [])).toHaveLength(2);
  const textIssue = parsed.issues.find((issue) => issue.rule === "remote.reachability");
  const volumeIssue = parsed.issues.find((issue) => issue.rule === "accessibility.pointer-only-control");
  const expectedFixIds = [textIssue?.id, volumeIssue?.id]
    .filter((value): value is string => value !== undefined)
    .sort();
  const expectedReviewIds = parsed.issues
    .filter((issue) => issue.rule === "streaming.captions" || issue.rule === "streaming.player-control")
    .map((issue) => issue.id)
    .sort();
  expect(expectedFixIds).toHaveLength(2);
  expect(expectedReviewIds).toHaveLength(2);
  for (const issue of parsed.issues) {
    const kind = expectedFixIds.includes(issue.id) ? "Fix" : "Review";
    const task = aiTaskForIssue(aiMarkdown, kind, issue.id);
    const ownedArtifacts = parsed.artifacts.filter((artifact) => artifact.id.startsWith(`${issue.id}:`));
    expect(ownedArtifacts).toHaveLength(ISSUE_SLOTS.length);
    for (const artifact of ownedArtifacts) {
      expect(task, artifact.id).toContain(artifact.id);
      if (artifact.status === "available") expect(task, artifact.path).toContain(artifact.path);
    }
    for (const evidence of issue.evidence) expect(task, evidence.summary).toContain(evidence.summary);
    if (kind === "Fix") {
      expect(task).toContain(`tvdoctor replay ${issue.id}`);
      expect(issue.reproduction.status).toBe("available");
    } else {
      expect(task).not.toContain(`tvdoctor replay ${issue.id}`);
      expect(issue.reproduction.status).toBe("unavailable");
    }
  }
  for (const issue of [textIssue, volumeIssue]) {
    if (issue === undefined || issue.reproduction.status !== "available") {
      throw new Error("Both pointer-only findings require deterministic focus-transition replays.");
    }
    const pointerNarrative = [issue.title, issue.description, issue.expected, issue.observed].join(" ");
    expect(pointerNarrative).toMatch(/pointer reachable/iu);
    expect(pointerNarrative).toMatch(/(?:remote.{0,24}unreachable|unreachable.{0,24}remote|D-pad.{0,40}(?:could not|did not))/iu);
    expect(issue.evidence.some((entry) => /before.+after|exact reset-relative|observed change/iu.test(entry.summary)))
      .toBe(true);
    expect(aiMarkdown).toContain(`tvdoctor replay ${issue.id}`);
  }
});
