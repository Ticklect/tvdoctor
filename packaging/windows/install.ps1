[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$CommandDirectory = "",
  [switch]$SetupChromium
)

$ErrorActionPreference = "Stop"
$InstallSentinelName = ".tvdoctor-install.json"

function Get-TVDoctorInstallMetadata {
  param(
    [string]$Path,
    [string]$ExpectedInstallRoot
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ([string]$value.name -ne "tvdoctor-install" -or
        [string]::IsNullOrWhiteSpace([string]$value.version) -or
        [string]::IsNullOrWhiteSpace([string]$value.installRoot)) {
      return $null
    }
    if ([IO.Path]::GetFullPath([string]$value.installRoot) -ne [IO.Path]::GetFullPath($ExpectedInstallRoot)) {
      return $null
    }
    return $value
  } catch {
    return $null
  }
}

function Test-DirectoryOnPath {
  param([string]$Directory)

  $expected = [IO.Path]::GetFullPath($Directory).TrimEnd("\", "/")
  foreach ($entry in ([string]$env:PATH -split [IO.Path]::PathSeparator)) {
    $candidate = $entry.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    try {
      if ([IO.Path]::GetFullPath($candidate).TrimEnd("\", "/") -eq $expected) {
        return $true
      }
    } catch {
      continue
    }
  }
  return $false
}

function Get-ToolVersion {
  param(
    [string]$Command,
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
  if ($raw -notmatch "^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$") {
    throw "$Label returned an unrecognised version: '$raw'."
  }
  return @{
    Raw = $raw
    Major = [int]$Matches[1]
    Minor = [int]$Matches[2]
    Patch = [int]$Matches[3]
  }
}

$nodeVersion = Get-ToolVersion -Command "node" -Label "Node.js"
$nodeSupported = $nodeVersion.Major -eq 24 -or
  ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 13)
if (-not $nodeSupported) {
  throw "Node.js >=22.13.0 <23 or >=24.0.0 <25 is required. Found $($nodeVersion.Raw)."
}

$npmVersion = Get-ToolVersion -Command "npm" -Label "npm"
if ($npmVersion.Major -lt 10 -or $npmVersion.Major -ge 12) {
  throw "npm >=10.0.0 <12 is required. Found $($npmVersion.Raw)."
}

$releaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $releaseRoot "packages"
$appPackage = Join-Path $releaseRoot "app-package.json"
if (-not (Test-Path -LiteralPath $payload -PathType Container)) {
  throw "TVDoctor package payload is missing: $payload"
}
if (-not (Test-Path -LiteralPath $appPackage -PathType Leaf)) {
  throw "TVDoctor installer manifest is missing: $appPackage"
}
$manifest = Get-Content -LiteralPath $appPackage -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "TVDoctor installer manifest does not declare a version."
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "TVDoctor\$version"
}
if ([string]::IsNullOrWhiteSpace($CommandDirectory)) {
  $CommandDirectory = (& npm prefix -g).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($CommandDirectory)) {
    throw "Unable to resolve npm's global command directory."
  }
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$CommandDirectory = [IO.Path]::GetFullPath($CommandDirectory)
$rootPath = [IO.Path]::GetPathRoot($InstallRoot)
if ([string]::IsNullOrWhiteSpace($rootPath) -or
    $InstallRoot.TrimEnd("\", "/") -eq $rootPath.TrimEnd("\", "/")) {
  throw "Refusing to install TVDoctor into a filesystem root: $InstallRoot"
}
$defaultInstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "TVDoctor\$version"))
$sentinel = Join-Path $InstallRoot $InstallSentinelName
$legacyCli = Join-Path $InstallRoot "node_modules\tvdoctor\dist\bin.js"
$launcher = Join-Path $CommandDirectory "tvdoctor.cmd"
$installMetadata = Get-TVDoctorInstallMetadata -Path $sentinel -ExpectedInstallRoot $InstallRoot
if (Test-Path -LiteralPath $InstallRoot) {
  $owned = $null -ne $installMetadata
  $legacyOwned = $InstallRoot -eq $defaultInstallRoot -and (Test-Path -LiteralPath $legacyCli -PathType Leaf)
  $empty = @(Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction Stop).Count -eq 0
  if (-not $owned -and -not $legacyOwned -and -not $empty) {
    throw "Refusing to replace an existing directory that is not owned by TVDoctor: $InstallRoot"
  }
}
if ($null -ne $installMetadata -and
    -not [string]::IsNullOrWhiteSpace([string]$installMetadata.commandDirectory)) {
  $recordedCommandDirectory = [IO.Path]::GetFullPath([string]$installMetadata.commandDirectory)
  if ($recordedCommandDirectory -ne $CommandDirectory) {
    throw "Refusing to move an existing TVDoctor install to a different launcher directory. Recorded launcher directory: $recordedCommandDirectory"
  }
}
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
  $launcherText = Get-Content -LiteralPath $launcher -Raw
  $ownedLauncher = $false
  if ($null -ne $installMetadata) {
    $recordedLauncher = [string]$installMetadata.launcherPath
    $recordedHash = [string]$installMetadata.launcherSha256
    $pathMatches = -not [string]::IsNullOrWhiteSpace($recordedLauncher) -and
      [IO.Path]::GetFullPath($recordedLauncher) -eq $launcher
    $hashMatches = -not [string]::IsNullOrWhiteSpace($recordedHash) -and
      (Get-FileHash -Algorithm SHA256 -LiteralPath $launcher).Hash.ToLowerInvariant() -eq $recordedHash.ToLowerInvariant()
    $ownedLauncher = $pathMatches -and (
      $hashMatches -or
      ([string]::IsNullOrWhiteSpace($recordedHash) -and $launcherText -like "*$InstallRoot*")
    )
  } elseif ($legacyOwned) {
    $ownedLauncher = $launcherText -like "*$InstallRoot*"
  }
  if (-not $ownedLauncher) {
    throw "Refusing to overwrite existing tvdoctor.cmd that is not owned by this TVDoctor install: $launcher"
  }
}

Write-Host "Installing TVDoctor $version into $InstallRoot"
if (Test-Path -LiteralPath $InstallRoot) {
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-Item -LiteralPath $payload -Destination (Join-Path $InstallRoot "packages") -Recurse
Copy-Item -LiteralPath $appPackage -Destination (Join-Path $InstallRoot "package.json")
@{
  name = "tvdoctor-install"
  version = $version
  installRoot = $InstallRoot
  commandDirectory = $CommandDirectory
  launcherPath = $launcher
} | ConvertTo-Json | Set-Content -LiteralPath $sentinel -Encoding UTF8

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
$launcherBody = @(
  "@echo off",
  "node `"$cli`" %*"
) -join [Environment]::NewLine
Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding ASCII

$installedVersion = & $launcher --version
$versionExitCode = $LASTEXITCODE
$installedVersionText = ([string]($installedVersion | Select-Object -First 1)).Trim()
if ($versionExitCode -ne 0 -or $installedVersionText -ne "tvdoctor $version") {
  throw "The installed TVDoctor command failed its version check. Expected 'tvdoctor $version', found '$installedVersionText' (exit $versionExitCode)."
}

if ($SetupChromium) {
  Write-Host "Installing the matched Chromium runtime..."
  & $launcher setup
  if ($LASTEXITCODE -ne 0) {
    throw "TVDoctor installed, but Chromium setup failed."
  }
}

& $launcher doctor
$doctorExitCode = $LASTEXITCODE
if ($doctorExitCode -ne 0) {
  if ($SetupChromium) {
    throw "TVDoctor installed, but doctor reported an environment failure after Chromium setup."
  }
  Write-Warning "TVDoctor doctor found an environment prerequisite that is not ready yet. Run 'tvdoctor setup' and then 'tvdoctor doctor' after installation."
}

$launcherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $launcher).Hash.ToLowerInvariant()
@{
  name = "tvdoctor-install"
  version = $version
  installRoot = $InstallRoot
  commandDirectory = $CommandDirectory
  launcherPath = $launcher
  launcherSha256 = $launcherHash
} | ConvertTo-Json | Set-Content -LiteralPath $sentinel -Encoding UTF8

if (-not (Test-DirectoryOnPath -Directory $CommandDirectory)) {
  Write-Warning "TVDoctor launcher directory is not on PATH: $CommandDirectory. Add it to PATH or run '$launcher' directly."
} else {
  $resolvedCommand = Get-Command "tvdoctor.cmd" -ErrorAction SilentlyContinue
  if ($null -eq $resolvedCommand -or [IO.Path]::GetFullPath($resolvedCommand.Source) -ne $launcher) {
    Write-Warning "Another tvdoctor command is being resolved before the installed launcher. Run '$launcher' directly or fix PATH ordering."
  }
}

Write-Host ""
Write-Host "TVDoctor $version is installed."
Write-Host "Launcher: $launcher"
if (-not $SetupChromium) {
  Write-Host "Next: run 'tvdoctor setup' once to install the matched Chromium runtime."
}
Write-Host "Then run 'tvdoctor doctor' to check the machine."
