# Release procedure

TVDoctor v0.1.x is distributed through GitHub Releases. The Windows release ZIP
contains the exact TVDoctor package tarballs plus the matching Playwright
runtime packages and installs without an npm account.

Record the exact commit SHA, local commands, hosted run URLs, conclusions, asset
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
.\scripts\build-github-release.ps1
.\scripts\test-github-release.ps1
```

The release-bundle smoke test must:

- validate every bundled SHA-256 checksum;
- install using only the local release tarballs with npm offline mode enabled;
- produce `tvdoctor 0.1.0`;
- exercise `tvdoctor --help`; and
- uninstall without leaving the TVDoctor install directory or launcher behind.

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

- `TVDoctor-v0.1.0-windows.zip`
- `TVDoctor-v0.1.0-windows.zip.sha256`

The ZIP contains:

- `install.ps1` / `install.cmd`;
- `uninstall.ps1` / `uninstall.cmd`;
- all versioned TVDoctor package tarballs;
- exact Playwright and Playwright Core tarballs;
- `CHECKSUMS-SHA256.txt`;
- `BUILD-METADATA.txt`;
- installation documentation; and
- the project licence.

Do not include signing keystores, npm credentials, GitHub tokens, browser
downloads, generated target reports, or private test evidence.

## 5. Tag and publish

- Create annotated tag `v0.1.0` at the exact fully proven release SHA.
- Push the tag without moving or rewriting it.
- Create the GitHub Release from that tag.
- Attach both Windows assets and preserve GitHub's automatic source archives.
- Release notes must state the Node.js 24/npm 11 requirement, the separate
  `tvdoctor setup` Chromium download, and the Beta/Experimental support
  boundaries.
- Do not describe Android TV as broadly production-supported; hosted API 36
  emulator evidence does not imply vendor or physical-device compatibility.

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
