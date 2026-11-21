# Samsung Tizen TV qualification boundary

TVDoctor does not currently ship a Samsung Tizen TV driver.

Samsung's current Smart TV application-testing documentation explicitly states
that automated testing is not supported on Samsung TVs and that the older legacy
automatic-testing tools are no longer supported. That makes a production driver
materially different from the Roku case: TVDoctor does not have a current
first-party remote/focus automation contract that it can safely wrap and call a
supported product surface.

## What would be required

Before adding `@tvdoctor/driver-tizen`, a contributor must establish a supported,
repeatable mechanism for all of the following on an authorized current Samsung TV
or official runtime:

1. send bounded D-pad, Select, and Back input to the target app;
2. observe the currently focused semantic control and enough UI hierarchy/state
   to distinguish transitions from no-ops;
3. launch and restore the target to a deterministic root without persistent or
   destructive side effects;
4. bound every transport/read operation and fail closed when observation is
   unavailable; and
5. repeat the shared `runDriverConformance()` plus exploration/report/replay gate
   on a redistributable fixture and a named real device/firmware version.

Tizen Studio/Web Inspector debugging can help investigate an app, but debugging
access alone is not treated as a stable TVDoctor automation API. Private or
unsupported remote-control tricks are not a basis for a public compatibility
claim.

Until the input/observation contract above is proven against current supported
Samsung tooling, Tizen stays a requested future platform rather than a stub
adapter that could produce unreliable green results.
