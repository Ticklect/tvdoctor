[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$CommandDirectory = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "TVDoctor\0.1.0"
}
if ([string]::IsNullOrWhiteSpace($CommandDirectory)) {
  $CommandDirectory = (& npm prefix -g).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($CommandDirectory)) {
    throw "Unable to resolve npm's global command directory."
  }
}

$launcher = Join-Path $CommandDirectory "tvdoctor.cmd"
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
  $launcherText = Get-Content -LiteralPath $launcher -Raw
  if ($launcherText -like "*$InstallRoot*") {
    Remove-Item -LiteralPath $launcher -Force
  } else {
    Write-Warning "Existing tvdoctor.cmd does not point at this TVDoctor install; leaving it untouched."
  }
}

Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "TVDoctor 0.1.0 was removed."
Write-Host "Playwright browser downloads are stored separately and are not deleted automatically."
