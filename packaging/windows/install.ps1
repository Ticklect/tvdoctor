[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$CommandDirectory = "",
  [switch]$SetupChromium
)

$ErrorActionPreference = "Stop"

function Require-MajorVersion {
  param(
    [string]$Command,
    [int]$Major,
    [string]$Label
  )

  $commandInfo = Get-Command $Command -ErrorAction SilentlyContinue
  if ($null -eq $commandInfo) {
    throw "$Label is required but was not found."
  }
  $raw = (& $commandInfo.Source --version 2>$null | Select-Object -First 1)
  if ($null -eq $raw -or [string]::IsNullOrWhiteSpace([string]$raw)) {
    throw "$Label is required but did not return a version."
  }
  $raw = ([string]$raw).Trim()
  $normalized = $raw.TrimStart("v")
  $parsedMajor = [int]($normalized.Split(".")[0])
  if ($parsedMajor -ne $Major) {
    throw "$Label $Major is required. Found $raw."
  }
}

Require-MajorVersion -Command "node" -Major 24 -Label "Node.js"
Require-MajorVersion -Command "npm" -Major 11 -Label "npm"

$releaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $releaseRoot "packages"
$appPackage = Join-Path $releaseRoot "app-package.json"
if (-not (Test-Path -LiteralPath $payload -PathType Container)) {
  throw "TVDoctor package payload is missing: $payload"
}
if (-not (Test-Path -LiteralPath $appPackage -PathType Leaf)) {
  throw "TVDoctor installer manifest is missing: $appPackage"
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "TVDoctor\0.1.0"
}
if ([string]::IsNullOrWhiteSpace($CommandDirectory)) {
  $CommandDirectory = (& npm prefix -g).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($CommandDirectory)) {
    throw "Unable to resolve npm's global command directory."
  }
}

Write-Host "Installing TVDoctor 0.1.0 into $InstallRoot"
Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-Item -LiteralPath $payload -Destination (Join-Path $InstallRoot "packages") -Recurse
Copy-Item -LiteralPath $appPackage -Destination (Join-Path $InstallRoot "package.json")

Push-Location $InstallRoot
try {
  npm install --ignore-scripts --no-audit --no-fund --package-lock=false
  if ($LASTEXITCODE -ne 0) {
    throw "npm failed to install the local TVDoctor release payload."
  }
} finally {
  Pop-Location
}

$cli = Join-Path $InstallRoot "node_modules\tvdoctor\dist\bin.js"
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "TVDoctor installed but the CLI entry point is missing."
}

New-Item -ItemType Directory -Path $CommandDirectory -Force | Out-Null
$launcher = Join-Path $CommandDirectory "tvdoctor.cmd"
$launcherBody = @(
  "@echo off",
  "node `"$cli`" %*"
) -join [Environment]::NewLine
Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding ASCII

& $launcher --version
if ($LASTEXITCODE -ne 0) {
  throw "The installed TVDoctor command failed its version check."
}

if ($SetupChromium) {
  Write-Host "Installing the matched Chromium runtime..."
  & $launcher setup
  if ($LASTEXITCODE -ne 0) {
    throw "TVDoctor installed, but Chromium setup failed."
  }
}

Write-Host ""
Write-Host "TVDoctor 0.1.0 is installed."
Write-Host "Launcher: $launcher"
if (-not $SetupChromium) {
  Write-Host "Next: run 'tvdoctor setup' once to install the matched Chromium runtime."
}
Write-Host "Then run 'tvdoctor doctor' to check the machine."
