[CmdletBinding()]
param(
  [string]$Bundle = "artifacts/github-release/TVDoctor-v0.1.0-windows.zip"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$bundlePath = if ([IO.Path]::IsPathRooted($Bundle)) { $Bundle } else { Join-Path $repoRoot $Bundle }
if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
  throw "Release bundle not found: $bundlePath"
}

$root = Join-Path $env:TEMP "tvdoctor-github-release-smoke"
$extract = Join-Path $root "extract"
$installRoot = Join-Path $root "install"
$commandDirectory = Join-Path $root "bin"
$cache = Join-Path $root "empty-npm-cache"
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $extract,$installRoot,$commandDirectory,$cache -Force | Out-Null

Expand-Archive -LiteralPath $bundlePath -DestinationPath $extract
$releaseRoot = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
if ($null -eq $releaseRoot) {
  throw "Release ZIP did not contain its expected root directory."
}

$checksumFile = Join-Path $releaseRoot.FullName "CHECKSUMS-SHA256.txt"
foreach ($line in Get-Content -LiteralPath $checksumFile) {
  if ($line -notmatch "^([0-9a-f]{64})  (.+)$") {
    throw "Invalid checksum entry: $line"
  }
  $expected = $Matches[1]
  $relative = $Matches[2].Replace("/", "\")
  $path = Join-Path $releaseRoot.FullName $relative
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "Checksum mismatch for $relative."
  }
}

$oldOffline = $env:npm_config_offline
$oldCache = $env:npm_config_cache
try {
  $env:npm_config_offline = "true"
  $env:npm_config_cache = $cache
  & (Join-Path $releaseRoot.FullName "install.ps1") -InstallRoot $installRoot -CommandDirectory $commandDirectory
  if ($LASTEXITCODE -ne 0) { throw "Release installer failed." }
} finally {
  $env:npm_config_offline = $oldOffline
  $env:npm_config_cache = $oldCache
}

$tvdoctor = Join-Path $commandDirectory "tvdoctor.cmd"
if (-not (Test-Path -LiteralPath $tvdoctor -PathType Leaf)) {
  throw "Release installer did not create the TVDoctor command."
}

$version = (& $tvdoctor --version).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne "tvdoctor 0.1.0") {
  throw "Unexpected installed TVDoctor version: $version"
}

& $tvdoctor --help *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Installed TVDoctor help command failed."
}

& (Join-Path $releaseRoot.FullName "uninstall.ps1") -InstallRoot $installRoot -CommandDirectory $commandDirectory
if ($LASTEXITCODE -ne 0) {
  throw "Release uninstaller failed."
}
if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $tvdoctor)) {
  throw "Release uninstaller left TVDoctor installation files behind."
}

Write-Host "GitHub Release Windows bundle smoke test: PASS"
