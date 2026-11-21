# Platform priority

TVDoctor v1 is focused on automatic remote-navigation failure discovery. A new
platform is useful only if it can preserve that promise with deterministic input,
observable focus/state, bounded restoration, and honest coverage accounting.

TVDoctor will choose its next device driver from evidence of real use rather
than estimated market share alone. Teams can open a
[platform request](https://github.com/Ticklect/tvdoctor/issues/new?template=platform-request.yml)
for Fire TV, Roku, Samsung Tizen, LG webOS, Apple tvOS, or additional Android
and Google TV hardware.

Fire TV is a special case: the Android-derived ADB/observer transport is now
implemented and can identify Amazon hardware as `fire-tv`, but it remains below
the compatibility bar until named physical hardware completes the proof runner.
Roku now has an unvalidated contributor adapter built on Roku's first-party
WebDriver, but still requires a real-device conformance/exploration/replay gate
before it becomes an Experimental product surface. Samsung Tizen, LG webOS, and
tvOS still require distinct supported observation/input adapters.

The qualification boundaries for those future adapters are recorded in the
[driver authoring guide](drivers/authoring.md), the
[Roku qualification guide](drivers/roku.md), the
[Samsung Tizen qualification guide](drivers/tizen.md), and the
[LG webOS qualification guide](drivers/webos.md).

Requests are compared using four public signals:

1. distinct teams with a current or planned TV application;
2. repeated workflows that TVDoctor can observe safely and deterministically;
3. platform and OS-version overlap between requests;
4. access to real devices and a redistributable fixture for a repeatable gate.

Issue reactions can show interest, but do not replace a request that describes a
real workflow. No request should contain credentials, private application URLs,
customer data, proprietary binaries, or unreviewed report bundles.

The first implementation target should have the strongest combination of demand
and provability. A proposed adapter still starts Experimental and follows the
[driver authoring guide](drivers/authoring.md). Market popularity alone does not
justify a compatibility claim.
