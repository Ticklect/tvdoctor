# Release procedure

TVDoctor v0.1.x ships through GitHub Releases. The Windows ZIP contains the
TVDoctor package tarballs and matching Playwright runtime packages, and installs
without an npm account.

For every release, record the candidate SHA, validation commands, CI run URLs,
checksums, and GitHub Release URL in the release audit issue.

## 1. Prepare the candidate

- Select the intended version and update package metadata, lockfile,
  `CHANGELOG.md`, compatibility statements, and `SECURITY.md`.
- Confirm no generated reports, screenshots, traces, temporary consumers,
  credentials, signing material, or target evidence are tracked.
- Confirm Android TV support remains described as Experimental unless new
  physical/vendor evidence explicitly changes that boundary.
- Review `npm audit`. A clean dependency audit is supporting evidence, not a
  substitute for application-security review.

## 2. Run the local clean gate

From the canonical clean checkout:

```sh
npm ci
npx playwright install chromium
npm run check
npm run test:package-smoke
node examples/baseline-ci-example.mjs
npm audit
git status --short
```

On Windows, build and smoke-test the GitHub Release bundle:

```powershell
.\scripts\build-github-release.ps1 -Preflight
.\scripts\build-github-release.ps1
.\scripts\test-github-release.ps1
```

`-Preflight` is a **dry run**: it rebuilds the packages and demo, checks all
public workspace manifests against the lockfile and the emitted runtime/type
imports, and runs `npm publish --dry-run --ignore-scripts` for each workspace.
It rejects missing exports, required assets, source or unexpected files, and
invalid package identities. It does not create a release ZIP, publish to npm,
or tag Git. The default mode also requires a clean working tree and an unused
`v<version>` tag. A preflight `GO` covers local packaging only: hosted CI,
signing, registry availability and real installation remain separate gates.

The default builder requires a clean tracked working tree. For local product
hardening before the candidate is clean, use the explicitly non-publishing
rehearsal mode and pass its distinct bundle to the smoke test:

```powershell
$rehearsal = Join-Path $env:TEMP "tvdoctor-release-rehearsal"
$version = (Get-Content .\packages\cli\package.json -Raw | ConvertFrom-Json).version
.\scripts\build-github-release.ps1 -Preflight -Rehearsal
.\scripts\build-github-release.ps1 -Rehearsal -OutputDirectory $rehearsal
.\scripts\test-github-release.ps1 -Bundle (Join-Path $rehearsal "TVDoctor-v$version-windows-rehearsal.zip")
```

Rehearsal ZIPs use the `-rehearsal` suffix, contain `REHEARSAL-ONLY.txt`, and
record `REHEARSAL ONLY - DO NOT PUBLISH` in build metadata. They are test
artifacts only; the publishable candidate must be rebuilt with the default
clean-tree mode.

The release-bundle smoke test must:

- validate every bundled SHA-256 checksum;
- validate the ZIP `.sha256` sidecar, required release markers, and completeness
  of checksum coverage (including rejecting unexpected files);
- verify every installer dependency references an actual bundled tarball;
- install using only the local release tarballs with npm offline mode enabled;
- persist and verify installer ownership metadata for the exact launcher;
- reinstall safely into the same install/launcher locations;
- produce the package-declared `tvdoctor <version>` output;
- exercise `--help`, `setup --help`, `doctor`, the deterministic demo, saved
  replay, and baseline create/compare on the controlled demo output; and
- uninstall without leaving the TVDoctor install directory or owned launcher
  behind, while preserving unrelated files in the launcher directory.

The hosted runtime/package rehearsal runs the same package and Windows safety
proof on four supported cells: Node 22.13 + npm 10, Node 22.13 + npm 11, Node 24
+ npm 10, and Node 24 + npm 11. Package smoke must print explicit `SKIPPED`
status for external website and Android probes when their opt-in environment
inputs are absent.

## 3. Prove the exact hosted candidate

```sh
git rev-parse HEAD
git status --short
git rev-list --left-right --count origin/main...HEAD
```

- Push the reviewed commit without amending it afterward.
- Require **Aggregate release-candidate gate** and
  **Android TV observer integration (API 36)** to pass at that exact SHA.
- Run **Android observer release-signing verification** at that exact SHA and
  require byte-for-byte reproduction of the tracked observer APK and manifest.
- Record the workflow URLs and exact SHA in the release audit.
- Confirm branch protection, repository visibility, and required checks match
  the intended release posture.

If any release file, package, installer, observer asset, or metadata changes
after proof, the resulting new SHA is a new candidate and must be proved again.

## 4. Build the GitHub Release assets

Run:

```powershell
.\scripts\build-github-release.ps1
.\scripts\test-github-release.ps1
```

The expected public assets are:

- `TVDoctor-v<version>-windows.zip`
- `TVDoctor-v<version>-windows.zip.sha256`

The ZIP contains:

- `install.ps1` / `install.cmd`;
- `uninstall.ps1` / `uninstall.cmd`;
- all versioned TVDoctor package tarballs;
- the experimental Roku adapter package tarball (while the CLI remains
  independent of that adapter);
- exact Playwright and Playwright Core tarballs;
- `CHECKSUMS-SHA256.txt`;
- `BUILD-METADATA.txt`;
- installation documentation; and
- the project licence.

Do not include signing keystores, npm credentials, GitHub tokens, browser
downloads, generated target reports, or private test evidence.

## 5. Tag and publish

- Confirm `v<version>` does not already exist. The release builder refuses to
  create a publishable bundle for an existing tag; bump all package metadata and
  the lockfile before preparing a new candidate.
- Create annotated tag `v<version>` at the exact fully proven release SHA.
- Push the tag without moving or rewriting it.
- Create the GitHub Release from that tag.
- Attach both Windows assets and preserve GitHub's automatic source archives.
- Release notes must state the supported Node.js ranges (22.13+ within Node 22,
  or Node 24) and npm 10/11, the separate `tvdoctor setup` Chromium download,
  and the Beta/Experimental support boundaries.
- Do not describe Android TV as broadly production-supported; hosted API 36
  emulator evidence does not imply vendor or physical-device compatibility.

### Optional npm publication

Npm publication is prepared but is not performed by this release procedure
unless it is explicitly authorized. Before any npm publish, require the hosted
runtime/package compatibility matrix to pass for Node 22.13 + npm 10.9, Node
22.13 + npm 11, Node 24 + npm 10.9, and Node 24 + npm 11, then rerun
`npm run test:package-smoke`.
The smoke must verify every tarball, the packaged Northstar demo fixture, a clean
nested consumer install, the installed deterministic demo and reproduced replay,
and the real global CLI shim. Optional external web or Android probes must report
`SKIPPED` when their explicit environment inputs are absent.

Run `npm publish --dry-run --workspace <package>` for every public workspace in
the dependency order below and resolve every packaging or prepack failure before
publishing anything.

Publish the public packages in dependency order so registry installs can resolve
the exact `0.1.x` package set:

1. `@tvdoctor/protocol`;
2. `@tvdoctor/baseline`, `@tvdoctor/core`, `@tvdoctor/driver-android`,
   `@tvdoctor/driver-roku`, `@tvdoctor/driver-web`, and `@tvdoctor/reporters`;
3. `@tvdoctor/pack-web` and `@tvdoctor/pack-streaming`; and
4. `tvdoctor` last.

After an explicitly authorized npm publish, verify each package from the public
registry with `npm view <package>@<version> version dist.integrity`, then verify
`npm view tvdoctor@<version> bin dependencies` before testing `npx tvdoctor` and
`npm install --global tvdoctor` from a clean location.

Windows code signing is a separate release prerequisite. A release candidate is
not signed unless an actual trusted signing identity/certificate is available
and the signed artifacts are verified; local rehearsal does not simulate or
claim signing.

## 6. Verify the published release

On a clean Windows location:

1. download the ZIP and SHA-256 file from the GitHub Release;
2. verify the ZIP hash;
3. extract the ZIP;
4. run `install.ps1`;
5. run `tvdoctor --version` and `tvdoctor --help`;
6. run `tvdoctor setup` and `tvdoctor doctor`; and
7. run a bounded local fixture audit.

Confirm the GitHub Release points to the intended tag and commit, the assets
download successfully, the published hashes match, and the release audit issue
contains the final URLs and evidence.
