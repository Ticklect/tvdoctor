#!/usr/bin/env bash

set -euo pipefail

artifact_dir="artifacts/android-ci"
fixture_apk="fixtures/broken-android-tv/build/outputs/apk/debug/tvdoctor-broken-android-tv-debug.apk"
observer_apk="packages/driver-android/observer/tvdoctor-observer.apk"
observer_component="org.tvdoctor.observer/org.tvdoctor.observer.ObserverAccessibilityService"

mkdir -p "$artifact_dir"

preserve_android_diagnostics() {
  adb shell dumpsys accessibility > "$artifact_dir/accessibility-final.txt" 2>&1 || true
  adb logcat -d -t 2000 > "$artifact_dir/logcat-final.txt" 2>&1 || true
}
trap preserve_android_diagnostics EXIT

sdkmanager --install 'build-tools;36.0.0' 'platforms;android-36' > /dev/null
pwsh -NoProfile -File fixtures/broken-android-tv/scripts/build-apk.ps1

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

adb shell dumpsys accessibility > "$artifact_dir/accessibility-before-scan.txt"
if [[ "$observer_enabled" -ne 1 ]]; then
  echo "Observer accessibility service did not remain enabled on the emulator."
  exit 1
fi

set +e
node packages/cli/dist/bin.js test \
  --apk "$fixture_apk" \
  --device emulator-5554 \
  --mode quick \
  --output "$artifact_dir"
scan_status=$?
set -e

if [[ "$scan_status" -ne 1 ]]; then
  echo "Expected deterministic finding exit code 1; received $scan_status."
  exit 1
fi

node scripts/verify-android-ci-report.mjs "$artifact_dir/report.json"
