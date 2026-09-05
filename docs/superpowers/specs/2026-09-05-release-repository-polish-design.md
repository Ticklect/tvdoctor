# TVDoctor 0.1.0 Release and Repository Polish Design

## Goal

Prepare TVDoctor's private repository as a polished `0.1.0` release candidate,
prove the exact candidate locally and in GitHub Actions, and leave npm publication,
tagging, and repository visibility behind explicit owner approval gates.

The repository should feel distinctive, trustworthy, and easy to evaluate without
overstating the maturity or availability of the product.

## Fixed decisions

- The GitHub repository remains private until the owner explicitly says otherwise.
- No package is published and no release tag is created during this work.
- The intended package version remains `0.1.0`.
- Existing Beta, Experimental, and Planned boundaries remain explicit.
- Release evidence is tied to one immutable commit SHA.

## Presentation direction

Use a polished technical-product style rather than a marketing-heavy or badge-heavy
layout. The visual identity combines a television frame, a focus target, and a
diagnostic pulse. It must work on both light and dark GitHub themes and remain clear
when scaled down.

Repository artwork will be code-native SVG so it is sharp, reviewable, compact, and
easy to maintain. The design will avoid screenshots or generated reports that could
conflict with the release rule against tracked target evidence and transient output.

## README information architecture

The README will open as a concise product page, then retain the detailed engineering
reference already present.

1. Branded hero artwork and one-sentence product promise.
2. Honest badges for CI, licence, runtime, and release-candidate status. No npm badge
   appears before registry publication.
3. A compact explanation of what TVDoctor finds and how its evidence model differs.
4. A visual, text-based version of the deterministic Northstar demo journey.
5. A fast source-checkout path and a clearly separated future registry-install path.
6. Capability and maturity tables with links to limitations and supporting docs.
7. Detailed CLI, report, replay, troubleshooting, compatibility, security, and
   contribution material, edited for scanability without removing important caveats.

The first screenful should answer what TVDoctor is, who it is for, why it is useful,
and whether it is currently published. Deeper sections should remain linkable and
useful to implementers.

## Repository-wide polish

- Add reusable SVG brand artwork under `docs/assets/`, including a README hero and a
  1280×640 social-preview source asset.
- Ensure issue and pull-request templates use consistent terminology and point to
  the right validation and security guidance.
- Check top-level metadata and documentation links for stale wording, broken paths,
  misleading publication claims, and inconsistent product naming.
- Keep decorative additions restrained: no animated badges, visitor counters,
  unsupported compatibility badges, or claims not backed by a release gate.

GitHub's repository social preview may require an owner-side UI upload. The asset
will be prepared in the repository, but it will not be uploaded through account UI
unless the available authenticated tooling can do so safely and without changing
visibility.

## Release-candidate flow

1. Implement the presentation changes and review the final diff for accidental
   release claims or sensitive/generated artifacts.
2. Verify SVG and Markdown references and run formatting/static checks appropriate
   to the changed files.
3. Run the complete clean local release gate from `RELEASE.md` at the final commit:
   locked install, Chromium install, `npm run check`, package smoke, baseline example,
   audit, and clean-worktree confirmation.
4. Commit the final candidate and push the existing
   `codex/android-v2-observer` branch.
5. Wait for the first-attempt GitHub Actions `Aggregate release-candidate gate` and
   Android observer job at that exact SHA. Record the run URL and result.
6. Run `npm publish --dry-run` for every package and compare the inventories with the
   package-smoke output. Authentication-dependent checks are reported as blockers if
   npm credentials are unavailable.
7. Stop before publication, tagging, GitHub release creation, or visibility changes.

## Failure handling

- A local gate failure blocks the push until diagnosed and corrected.
- A hosted failure or rerun blocks first-attempt release evidence and is investigated
  rather than hidden by rerunning.
- Any unexpected tracked artifact, credential-shaped value, or sensitive evidence
  blocks the candidate.
- Missing npm authentication blocks registry-account verification and publication,
  but not the creation of a fully tested private release candidate.
- A social-preview upload limitation is reported separately and does not weaken the
  code or package release gates.

## Verification and acceptance

The work is accepted as a release candidate only when:

- the repository is still private;
- the README and repository artwork render cleanly on light and dark backgrounds;
- every internal README link resolves;
- the complete documented local gate passes at the final commit;
- the worktree is clean and contains no tracked transient evidence;
- the exact pushed SHA passes the hosted aggregate and Android gates on attempt one;
- all package dry-runs have valid, expected inventories; and
- remaining operator-only blockers are stated explicitly.

Publication itself is a separate owner-approved operation and is outside this
design's completion boundary.
