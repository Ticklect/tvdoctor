# `@tvdoctor/pack-web`

Experimental, platform-neutral M7 diagnostics for TV-style web applications.

The package exports six independently runnable stages plus `runWebPack`, which
orchestrates them without merging their issue domains:

- search remote flow;
- safe settings traversal;
- accessibility and focus visibility;
- viewport layout;
- menu response performance;
- crash and console robustness.

Remote navigation consumes only `TVDoctorDriver`. Browser-only facts such as
computed focus styling, crop differences, viewport dimensions, pointer
activation, and query entry are supplied through explicit hooks. When a fact is
not observable the corresponding stage reports `unobservable` or `partial`; it
does not silently pass.

The layout and menu-response stages accept the reset-relative player-settings
sequence discovered by the streaming pack at run time. The sequence must end in
`SELECT`; this package contains no fixture route or stored player path.

Safety is fail closed. Destructive, account, profile, subscription, purchase,
and payment controls are never activated. Ambiguous settings rows are inspected
for reachability but are not selected. Cosmetic mutation requires a future
explicit reversible contract and is not performed by this package.

All exploration and host input are bounded. Defaults are intentionally small;
invalid, excessive, cyclic, or malformed driver data terminates with an honest
status instead of expanding without limit.
