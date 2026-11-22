## Problem and scope

<!-- Which user workflow improves? For MCP changes, identify the tools, affected clients, and any compatibility impact. -->

## Evidence

<!-- Link tests/evidence. Remove credentials, private URLs, proprietary target data, and absolute local paths. -->

## Verification

<!-- List exact commands and results. State whether any test retried, flaked, or was skipped. -->

- [ ] Tests fail without the fix and pass with it, or the change is documentation-only.
- [ ] `npm run lint` and `npm run typecheck` pass.
- [ ] `npm run test:presentation` passes when Markdown or SVG assets change.
- [ ] Visual assets were reviewed in both light and dark backgrounds.
- [ ] Relevant unit and real-platform gates pass on the first attempt.
- [ ] Partial/inconclusive results are not presented as clean.
- [ ] Fix-verification changes use the original finding and describe the supported evidence.
- [ ] Public behaviour, compatibility, limitations, and changelog are updated.
- [ ] Generated artifacts, package tarballs, secrets, and sensitive target data are not committed.
- [ ] Driver/support status is no stronger than the attached evidence.
- [ ] npm availability, repository visibility, and support maturity are not overstated.

## Release impact

<!-- Note protocol/schema, package, security/privacy, performance, or migration impact. Use “none” only after checking. -->
