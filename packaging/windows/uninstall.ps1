[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$CommandDirectory = ""
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
$releaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appPackage = Join-Path $releaseRoot "app-package.json"
$version = "0.1.0"
if (Test-Path -LiteralPath $appPackage -PathType Leaf) {
  $manifest = Get-Content -LiteralPath $appPackage -Raw | ConvertFrom-Json
  if (-not [string]::IsNullOrWhiteSpace([string]$manifest.version)) {
    $version = [string]$manifest.version
  }
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "TVDoctor\$version"
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$rootPath = [IO.Path]::GetPathRoot($InstallRoot)
if ([string]::IsNullOrWhiteSpace($rootPath) -or
    $InstallRoot.TrimEnd("\", "/") -eq $rootPath.TrimEnd("\", "/")) {
  throw "Refusing to remove a filesystem root: $InstallRoot"
}
$defaultInstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "TVDoctor\$version"))
$sentinel = Join-Path $InstallRoot $InstallSentinelName
$legacyCli = Join-Path $InstallRoot "node_modules\tvdoctor\dist\bin.js"
$installMetadata = Get-TVDoctorInstallMetadata -Path $sentinel -ExpectedInstallRoot $InstallRoot
if (Test-Path -LiteralPath $InstallRoot) {
  $owned = $null -ne $installMetadata
  $legacyOwned = $InstallRoot -eq $defaultInstallRoot -and (Test-Path -LiteralPath $legacyCli -PathType Leaf)
  if (-not $owned -and -not $legacyOwned) {
    throw "Refusing to remove a directory that is not owned by TVDoctor: $InstallRoot"
  }
}

$recordedCommandDirectory = if ($null -eq $installMetadata) { "" } else { [string]$installMetadata.commandDirectory }
$recordedLauncher = if ($null -eq $installMetadata) { "" } else { [string]$installMetadata.launcherPath }
if (-not [string]::IsNullOrWhiteSpace($recordedCommandDirectory)) {
  $recordedCommandDirectory = [IO.Path]::GetFullPath($recordedCommandDirectory)
  if (-not [string]::IsNullOrWhiteSpace($CommandDirectory) -and
      [IO.Path]::GetFullPath($CommandDirectory) -ne $recordedCommandDirectory) {
    throw "CommandDirectory does not match the launcher directory recorded by this TVDoctor install: $recordedCommandDirectory"
  }
  $CommandDirectory = $recordedCommandDirectory
}
if ([string]::IsNullOrWhiteSpace($CommandDirectory)) {
  $npmCommand = Get-Command "npm" -ErrorAction SilentlyContinue
  if ($null -eq $npmCommand) {
    throw "Unable to resolve the TVDoctor launcher directory from install metadata, and npm is not available."
  }
  $CommandDirectory = (& $npmCommand.Source prefix -g).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($CommandDirectory)) {
    throw "Unable to resolve npm's global command directory."
  }
}
$CommandDirectory = [IO.Path]::GetFullPath($CommandDirectory)
$launcher = Join-Path $CommandDirectory "tvdoctor.cmd"
if (-not [string]::IsNullOrWhiteSpace($recordedLauncher) -and
    [IO.Path]::GetFullPath($recordedLauncher) -ne $launcher) {
  throw "Recorded TVDoctor launcher path does not match its recorded command directory."
}
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
  $launcherText = Get-Content -LiteralPath $launcher -Raw
  $recordedHash = if ($null -eq $installMetadata) { "" } else { [string]$installMetadata.launcherSha256 }
  $hashMatches = -not [string]::IsNullOrWhiteSpace($recordedHash) -and
    (Get-FileHash -Algorithm SHA256 -LiteralPath $launcher).Hash.ToLowerInvariant() -eq $recordedHash.ToLowerInvariant()
  $legacyLauncherMatches = [string]::IsNullOrWhiteSpace($recordedHash) -and $launcherText -like "*$InstallRoot*"
  if ($hashMatches -or $legacyLauncherMatches) {
    Remove-Item -LiteralPath $launcher -Force
  } else {
    Write-Warning "Existing tvdoctor.cmd does not point at this TVDoctor install; leaving it untouched."
  }
}

if (Test-Path -LiteralPath $InstallRoot) {
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
Write-Host "TVDoctor $version was removed."
Write-Host "Playwright browser downloads are stored separately and are not deleted automatically."
