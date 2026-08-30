#!/usr/bin/env bash

set -euo pipefail

artifact_root="artifacts/android-ci"
scan_output="$artifact_root/scan"
fixture_apk="fixtures/broken-android-tv/build/outputs/apk/debug/tvdoctor-broken-android-tv-debug.apk"
observer_apk="packages/driver-android/observer/tvdoctor-observer.apk"
observer_component="org.tvdoctor.observer/org.tvdoctor.observer.ObserverAccessibilityService"

mkdir -p "$artifact_root"

preserve_android_diagnostics() {
  adb shell dumpsys accessibility > "$artifact_root/accessibility-final.txt" 2>&1 || true
  adb shell dumpsys power > "$artifact_root/power-final.txt" 2>&1 || true
  adb shell dumpsys display > "$artifact_root/display-final.txt" 2>&1 || true
  adb shell dumpsys window > "$artifact_root/window-final.txt" 2>&1 || true
  adb shell dumpsys input > "$artifact_root/input-final.txt" 2>&1 || true
  adb logcat -d -t 2000 > "$artifact_root/logcat-final.txt" 2>&1 || true
}
trap preserve_android_diagnostics EXIT

sdkmanager --install 'build-tools;36.0.0' 'platforms;android-36' > /dev/null
pwsh -NoProfile -File fixtures/broken-android-tv/scripts/build-apk.ps1
node scripts/ensure-android-display-ready.mjs

adb install -r "$observer_apk"
adb shell am start -W -n org.tvdoctor.observer/.SetupActivity > /dev/null

observer_enabled=0
for attempt in $(seq 1 10); do
  adb shell settings put secure enabled_accessibility_services "$observer_component"
  adb shell settings put secure accessibility_enabled 1
  enabled_services=$(adb shell settings get secure enabled_accessibility_services | tr -d '\r')
  if [[ "$enabled_services" == *org.tvdoctor.observer* ]]; then
    observer_enabled=1
    echo "Observer accessibility service registered on attempt $attempt."
    break
  fi
  sleep 1
done

adb shell dumpsys accessibility > "$artifact_root/accessibility-before-scan.txt"
if [[ "$observer_enabled" -ne 1 ]]; then
  echo "Observer accessibility service did not remain enabled on the emulator."
  exit 1
fi

node scripts/ensure-android-display-ready.mjs
adb shell dumpsys power > "$artifact_root/power-before-scan.txt"
adb shell dumpsys display > "$artifact_root/display-before-scan.txt"
adb shell dumpsys window > "$artifact_root/window-before-scan.txt"
adb shell dumpsys input > "$artifact_root/input-before-scan.txt"
adb exec-out screencap -p > "$artifact_root/display-before-scan.png"

set +e
node packages/cli/dist/bin.js test \
  --apk "$fixture_apk" \
  --device emulator-5554 \
  --mode quick \
  --output "$scan_output"
scan_status=$?
set -e

if [[ "$scan_status" -ne 1 ]]; then
  echo "Expected deterministic finding exit code 1; received $scan_status."
  exit 1
fi

node scripts/verify-android-ci-report.mjs "$scan_output/report.json"
