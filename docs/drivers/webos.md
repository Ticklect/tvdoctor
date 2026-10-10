# LG webOS TV qualification boundary

TVDoctor does not currently ship an LG webOS TV driver.

LG's current webOS CLI provides supported development operations such as device
configuration, app installation, launch/termination, system information, and Web
Inspector access. Those primitives are useful for setup and debugging, but the
documented CLI surface does not by itself provide the complete deterministic
remote-input plus focused-semantic-state contract that TVDoctor's automatic graph
explorer needs.

The older webOS TV CLI has been deprecated in favour of the current webOS CLI, so
new TVDoctor work should target the maintained toolchain rather than depending on
deprecated commands.

## What would be required

Before adding `@tvdoctor/driver-webos`, prove a maintained mechanism that can:

1. launch a disposable fixture through the current webOS toolchain;
2. send bounded D-pad, Select, and Back input to that app;
3. observe focus and a stable semantic UI state after each input;
4. restore the app deterministically enough for sibling exploration and replay;
5. surface unsupported inspector/device states as unavailable instead of clean;
   and
6. pass `runDriverConformance()` plus repeated real-platform
   exploration/report/replay tests on a named webOS TV version.

Web Inspector DOM access may become part of a web-app adapter if it can be
connected and stabilized through supported tooling, but TVDoctor should not claim
webOS support from simulator rendering or install/launch success alone.
