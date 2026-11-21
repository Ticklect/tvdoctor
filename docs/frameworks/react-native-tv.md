# React Native TV integration

TVDoctor's current React Native path is the experimental Android TV driver. Build
the Android TV APK produced by your React Native TV project, install it through
TVDoctor, and test the rendered native focus surface. The runtime driver does not
inspect JavaScript source or React component trees. In a GitHub Actions checkout,
the separate bounded source-correlation pass can still report exact textual
matches when a runtime stable ID/resource identifier also appears in repository
text; it never infers a component from unrelated text.

```powershell
tvdoctor test --apk .\app-tv-release.apk --device emulator-5554 --mode quick --output tvdoctor-rn-tv
```

The Android driver sends real DPAD key events through ADB and observes the target
through the TVDoctor Observer accessibility service. This makes the quality of the
native accessibility/focus surface significant. Focusable React Native controls
should resolve to stable Android accessibility nodes with useful names and state;
screen transitions should settle to a repeatable focus state after remote input.

Use a disposable test account/build when Select can reach purchases, destructive
actions, or other persistent changes. TVDoctor already gates ambiguous or risky
Select actions during automatic exploration, but the benchmark target should
still be safe to exercise repeatedly.

## What to verify in the app first

- the Android TV build launches directly into the intended TV activity;
- one predictable control receives initial focus;
- DPAD navigation works without touch input;
- important focusable controls expose stable accessibility semantics; and
- overlays/modals keep focus inside the visible surface until dismissed.

## Current limits

This path covers Android TV only. It is not tvOS support and it does not establish
React Native framework compatibility in general. The maintained automated gate is
an Android TV API 36 emulator; physical Android/Google TV and vendor behaviour
remain experimental evidence. Sparse accessibility semantics can reduce diagnosis
quality, and screenshot fingerprints may help TVDoctor decide that a state changed
without turning pixels into a semantic accessibility tree. A successful run is a
bounded observation of that APK/device/environment, not certification.

See the [Android TV driver guide](../drivers/android.md) for Observer setup and
device requirements, and use the
[real-app benchmark workflow](../BENCHMARKING.md#reusable-real-app-benchmark-workflow)
when comparing several React Native builds or devices.
