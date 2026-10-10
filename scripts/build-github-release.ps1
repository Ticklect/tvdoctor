[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$OutputDirectory = "artifacts/github-release",
  [switch]$Rehearsal,
  [switch]$Preflight
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPackage = Get-Content -LiteralPath (Join-Path $repoRoot "packages\cli\package.json") -Raw | ConvertFrom-Json
$rootPackage = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$packageVersion = [string]$cliPackage.version
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = $packageVersion
}
if ($Version -ne $packageVersion) {
  throw "Requested release version $Version does not match the CLI package version $packageVersion."
}
if ($Version -notmatch "^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$") {
  throw "Release version contains unsupported filename characters: $Version"
}
if (-not $Rehearsal) {
  $existingTag = git -C $repoRoot tag --list "v$Version"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect existing release tags."
  }
  if (@($existingTag).Count -gt 0) {
    throw "Release tag v$Version already exists. Bump the package version before building a new release candidate."
  }
}
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory
} else {
  Join-Path $repoRoot $OutputDirectory
}
$artifactSuffix = if ($Rehearsal) { "-rehearsal" } else { "" }
$stage = Join-Path $outputRoot "TVDoctor-v$Version-windows$artifactSuffix"
$payload = Join-Path $stage "packages"
$zipPath = Join-Path $outputRoot "TVDoctor-v$Version-windows$artifactSuffix.zip"
$zipHashPath = "$zipPath.sha256"

Push-Location $repoRoot
try {
  $status = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Unable to read git status." }
  $dirtyStatus = @($status | Where-Object { $_ -notmatch "^\?\? artifacts/" })
  if (-not $Rehearsal -and $dirtyStatus.Count -gt 0) {
    throw "Release packaging requires a clean tracked working tree."
  }
  if ($Rehearsal) {
    Write-Warning "Building a rehearsal-only Windows bundle from the current working tree. This artifact must not be published."
  }

  $sha = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $sha.Length -ne 40) {
    throw "Unable to resolve the release commit SHA."
  }

  if ($Preflight) {
    npm run test:release-preflight
    if ($LASTEXITCODE -ne 0) { throw "Release packaging preflight: NO-GO." }
    Write-Host "Windows release candidate preflight: GO ($(if ($Rehearsal) { 'rehearsal' } else { 'clean candidate' }), no release asset written)"
    return
  }

  npm run build
  if ($LASTEXITCODE -ne 0) { throw "TVDoctor build failed." }

  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zipHashPath -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $payload -Force | Out-Null

  $workspaces = @(
    "@tvdoctor/protocol",
    "@tvdoctor/baseline",
    "@tvdoctor/core",
    "@tvdoctor/driver-web",
    "@tvdoctor/driver-android",
    "@tvdoctor/driver-roku",
    "@tvdoctor/pack-web",
    "@tvdoctor/pack-streaming",
    "@tvdoctor/reporters",
    "tvdoctor"
  )
  foreach ($workspace in $workspaces) {
    npm pack --workspace $workspace --pack-destination $payload | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "npm pack failed for $workspace."
    }
  }

  npm pack ".\node_modules\playwright" --pack-destination $payload | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Packing Playwright failed." }
  npm pack ".\node_modules\playwright-core" --pack-destination $payload | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Packing Playwright Core failed." }

  $playwrightPackage = Get-Content -LiteralPath (Join-Path $repoRoot "node_modules\playwright\package.json") -Raw | ConvertFrom-Json
  $playwrightCorePackage = Get-Content -LiteralPath (Join-Path $repoRoot "node_modules\playwright-core\package.json") -Raw | ConvertFrom-Json
  $playwrightVersion = [string]$playwrightPackage.version
  $playwrightCoreVersion = [string]$playwrightCorePackage.version
  $dependencies = [ordered]@{
    "@tvdoctor/baseline" = "file:packages/tvdoctor-baseline-$Version.tgz"
    "@tvdoctor/core" = "file:packages/tvdoctor-core-$Version.tgz"
    "@tvdoctor/driver-android" = "file:packages/tvdoctor-driver-android-$Version.tgz"
    "@tvdoctor/driver-roku" = "file:packages/tvdoctor-driver-roku-$Version.tgz"
    "@tvdoctor/driver-web" = "file:packages/tvdoctor-driver-web-$Version.tgz"
    "@tvdoctor/pack-streaming" = "file:packages/tvdoctor-pack-streaming-$Version.tgz"
    "@tvdoctor/pack-web" = "file:packages/tvdoctor-pack-web-$Version.tgz"
    "@tvdoctor/protocol" = "file:packages/tvdoctor-protocol-$Version.tgz"
    "@tvdoctor/reporters" = "file:packages/tvdoctor-reporters-$Version.tgz"
    "playwright" = "file:packages/playwright-$playwrightVersion.tgz"
    "playwright-core" = "file:packages/playwright-core-$playwrightCoreVersion.tgz"
    "tvdoctor" = "file:packages/tvdoctor-$Version.tgz"
  }
  $installerManifest = [ordered]@{
    name = "tvdoctor-github-release"
    version = $Version
    private = $true
    description = "Local dependency manifest for the TVDoctor $Version GitHub Release installer."
    dependencies = $dependencies
  }
  $installerManifest | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $stage "app-package.json") -Encoding UTF8

  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\install.ps1") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\uninstall.ps1") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\install.cmd") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\uninstall.cmd") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\INSTALL.md") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination $stage

  @(
    "TVDoctor version: $Version",
    "Git commit: $sha",
    "Build mode: $(if ($Rehearsal) { 'REHEARSAL ONLY - DO NOT PUBLISH' } else { 'Release candidate' })",
    "Working tree changes during build: $($dirtyStatus.Count)",
    "Node requirement: $($rootPackage.engines.node)",
    "npm requirement: $($rootPackage.engines.npm)",
    "Playwright: $playwrightVersion",
    "Release channel: GitHub Releases",
    "Android TV support: Experimental"
  ) | Set-Content -LiteralPath (Join-Path $stage "BUILD-METADATA.txt") -Encoding UTF8

  if ($Rehearsal) {
    @(
      "REHEARSAL ONLY - DO NOT PUBLISH",
      "This ZIP was built from a working tree that was allowed to contain local changes.",
      "Use the default build-github-release.ps1 mode for a release candidate; it requires a clean tracked tree."
    ) | Set-Content -LiteralPath (Join-Path $stage "REHEARSAL-ONLY.txt") -Encoding ASCII
  }

  $checksumFile = Join-Path $stage "CHECKSUMS-SHA256.txt"
  $hashLines = Get-ChildItem -LiteralPath $stage -File -Recurse |
    Where-Object { $_.FullName -ne $checksumFile } |
    Sort-Object FullName |
    ForEach-Object {
      $relative = $_.FullName.Substring($stage.Length).TrimStart("\", "/").Replace("\", "/")
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
      "$hash  $relative"
    }
  $hashLines | Set-Content -LiteralPath $checksumFile -Encoding ASCII

  Compress-Archive -LiteralPath $stage -DestinationPath $zipPath -CompressionLevel Optimal
  $zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  "$zipHash  $(Split-Path -Leaf $zipPath)" | Set-Content -LiteralPath $zipHashPath -Encoding ASCII

  Write-Host "Created:"
  Write-Host "  $zipPath"
  Write-Host "  $zipHashPath"
} finally {
  Pop-Location
}
