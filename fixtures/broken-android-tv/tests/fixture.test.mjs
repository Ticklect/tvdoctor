import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function text(path) {
  return await readFile(join(fixtureRoot, path), "utf8");
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

test("native activity exposes two semantic controls and isolates focus loss to Select", async () => {
  const source = await text("src/org/tvdoctor/fixture/MainActivity.java");
  assert.match(source, /R\.id\.focus_probe/u);
  assert.match(source, /R\.id\.safe_control/u);
  assert.match(source, /focusProbe\.setNextFocusRightId\(R\.id\.safe_control\)/u);
  assert.match(source, /safeControl\.setNextFocusLeftId\(R\.id\.focus_probe\)/u);
  assert.match(source, /focusSink\.setImportantForAccessibility\(View\.IMPORTANT_FOR_ACCESSIBILITY_NO\)/u);
  assert.match(source, /focusSink\.requestFocus\(\)/u);
  assert.equal((source.match(/setOnClickListener/gu) ?? []).length, 2);
  assert.doesNotMatch(source, /Runtime\.getRuntime|ProcessBuilder|System\.exit/u);
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
