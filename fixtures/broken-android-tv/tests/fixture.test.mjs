import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(fixtureRoot, "..", "..");

async function text(path) {
  return await readFile(join(fixtureRoot, path), "utf8");
}

async function repositoryText(path) {
  return await readFile(join(repositoryRoot, path), "utf8");
}

test("manifest declares a native exported Leanback launcher without requiring touch", async () => {
  const manifest = await text("AndroidManifest.xml");
  assert.match(manifest, /package="org\.tvdoctor\.fixture"/u);
  assert.match(manifest, /android:name="android\.software\.leanback"[\s\S]*android:required="true"/u);
  assert.match(manifest, /android:name="android\.hardware\.touchscreen"[\s\S]*android:required="false"/u);
  assert.match(manifest, /android:banner="@drawable\/tv_banner"/u);
  assert.match(manifest, /android:name="\.MainActivity"[\s\S]*android:exported="true"/u);
  assert.match(manifest, /android\.intent\.category\.LEANBACK_LAUNCHER/u);
  assert.doesNotMatch(manifest, /INTERNET/u);
});

test("fixture has exactly one stable seeded defect", async () => {
  const defects = JSON.parse(await text("seeded-defects.json"));
  assert.equal(defects.length, 1);
  assert.deepEqual(defects[0], {
    id: "fixture-android-select-loses-focus",
    expectedRule: "remote.lost-focus",
    severity: "high",
    screen: "Android TV fixture home",
    target: "focus-probe",
    action: "SELECT",
    summary: "Selecting the dedicated Focus Probe diverts input focus to a transparent non-accessibility sink while the visible Safe Control remains focusable.",
  });
});

test("native activity exposes three semantic controls and isolates focus loss to Focus Probe Select", async () => {
  const source = await text("src/org/tvdoctor/fixture/MainActivity.java");
  assert.match(source, /R\.id\.focus_probe/u);
  assert.match(source, /R\.id\.safe_control/u);
  assert.match(source, /R\.id\.recreate_activity/u);
  assert.match(source, /focusProbe\.setNextFocusRightId\(R\.id\.safe_control\)/u);
  assert.match(source, /safeControl\.setNextFocusLeftId\(R\.id\.focus_probe\)/u);
  assert.match(source, /safeControl\.setNextFocusRightId\(R\.id\.recreate_activity\)/u);
  assert.match(source, /recreateActivity\.setNextFocusLeftId\(R\.id\.safe_control\)/u);
  assert.match(source, /focusSink\.setImportantForAccessibility\(View\.IMPORTANT_FOR_ACCESSIBILITY_NO\)/u);
  assert.match(source, /focusSink\.requestFocus\(\)/u);
  assert.equal((source.match(/setOnClickListener/gu) ?? []).length, 3);
  assert.doesNotMatch(source, /Runtime\.getRuntime|ProcessBuilder|System\.exit/u);
});

test("fixture has a deterministic same-package Activity recreation path without weakening config handling", async () => {
  const [manifest, source, ids, strings] = await Promise.all([
    text("AndroidManifest.xml"),
    text("src/org/tvdoctor/fixture/MainActivity.java"),
    text("res/values/ids.xml"),
    text("res/values/strings.xml"),
  ]);

  assert.match(manifest, /android:configChanges="keyboard\|keyboardHidden\|navigation\|orientation\|screenSize"/u);
  assert.match(ids, /name="recreate_activity"/u);
  assert.match(strings, /<string name="recreate_activity">Recreate Activity<\/string>/u);
  assert.match(source, /private static final String STATE_RECREATION_REQUESTED/u);
  assert.match(source, /recreationRequested = true;[\s\S]*recreate\(\);/u);
  assert.match(source, /onSaveInstanceState\(Bundle outState\)[\s\S]*putBoolean\(STATE_RECREATION_REQUESTED, recreationRequested\)/u);
  assert.match(source, /savedInstanceState\.getBoolean\(STATE_RECREATION_REQUESTED, false\)/u);
  assert.match(source, /Activity instance created; sequence=/u);
  assert.match(source, /Activity instance destroyed; sequence=/u);
  assert.match(source, /Process\.myPid\(\)/u);
  assert.match(source, /Activity recreation completed; restored marker=true/u);
  assert.doesNotMatch(source, /startActivity\(|Intent\(/u);
});

test("build scripts stay SDK-local and avoid dynamic shell evaluation", async () => {
  const build = await text("scripts/build-apk.ps1");
  const verify = await text("scripts/verify-apk.ps1");
  assert.match(build, /Resolve-CompilePlatform/u);
  assert.match(build, /ApiLevel -lt 36/u);
  assert.match(build, /build-tools\/36\.0\.0/u);
  assert.match(build, /Refusing to clean a build directory outside the Android fixture/u);
  assert.match(build, /aapt2/u);
  assert.match(build, /d8\$scriptSuffix/u);
  assert.match(build, /apksigner\$scriptSuffix/u);
  for (const script of [build, verify]) {
    assert.doesNotMatch(script, /Invoke-Expression|cmd\s+\/c|Start-Process/u);
  }
});

test("runtime recreation verifier proves a new Activity instance in the same package and process", async () => {
  const verifier = await text("scripts/verify-recreation.mjs");
  assert.match(verifier, /KEYCODE_DPAD_RIGHT/u);
  assert.match(verifier, /KEYCODE_DPAD_CENTER/u);
  assert.match(verifier, /Activity instance created; sequence=1/u);
  assert.match(verifier, /Activity instance destroyed; sequence=1/u);
  assert.match(verifier, /Activity instance created; sequence=2/u);
  assert.match(verifier, /const PACKAGE = "org\.tvdoctor\.fixture"/u);
  assert.match(verifier, /const sameProcess = `pid=\$\{pidAfter\}; package=\$\{PACKAGE\}`/u);
  assert.match(verifier, /pidBefore !== pidAfter/u);
  assert.match(verifier, /Activity recreation completed\. Focus Probe has initial focus\./u);
});

test("hosted Android CI accepts completed safe coverage while preserving the seeded issue gate", async () => {
  const runner = await repositoryText("scripts/run-android-emulator-ci.sh");
  assert.match(runner, /\[\[ "\$scan_status" -ne 1 \]\]/u);
  assert.match(runner, /Expected completed seeded-issue exit code 1/u);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "tvdoctor-android-ci-verifier-"));
  const reportPath = join(temporaryDirectory, "report.json");
  const ledgerPath = join(temporaryDirectory, "android-coverage-ledger.json");
  const issueId = "TVDOCTOR-NAV-SEEDED";
  try {
    await writeFile(reportPath, JSON.stringify({
      run: { status: "completed" },
      target: { environment: { package: "org.tvdoctor.fixture" } },
      issues: [{
        id: issueId,
        rule: "remote.lost-focus",
        severity: "high",
        confidence: "deterministic",
      }],
      replays: [{ issueId }],
      coverage: { packs: [{ pack: "navigation", status: "completed" }] },
      artifacts: [{
        id: "run:android-coverage-ledger",
        status: "available",
        path: "android-coverage-ledger.json",
      }],
    }), "utf8");
    await writeFile(ledgerPath, JSON.stringify({
      schema: "tvdoctor.android-coverage/v1",
      strategy: "adaptive",
      targetPackage: "org.tvdoctor.fixture",
      remainingSafeFrontier: 0,
      counts: {
        failed: 0,
        inaccessible: 0,
        "operator-gated": 1,
      },
      entries: [{
        action: "SELECT",
        disposition: "operator-gated",
        reasonCode: "ambiguous-activation",
      }],
    }), "utf8");

    const verification = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts", "verify-android-ci-report.mjs"), reportPath, ledgerPath],
      { encoding: "utf8" },
    );
    assert.equal(verification.status, 0, verification.stderr);
    assert.match(verification.stdout, /completed safe coverage preserved/u);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
