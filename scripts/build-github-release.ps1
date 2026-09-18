[CmdletBinding()]
param(
  [string]$Version = "0.1.0",
  [string]$OutputDirectory = "artifacts/github-release"
)

$ErrorActionPreference = "Stop"

if ($Version -ne "0.1.0") {
  throw "This release packager is currently pinned to TVDoctor 0.1.0."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory
} else {
  Join-Path $repoRoot $OutputDirectory
}
$stage = Join-Path $outputRoot "TVDoctor-v$Version-windows"
$payload = Join-Path $stage "packages"
$zipPath = Join-Path $outputRoot "TVDoctor-v$Version-windows.zip"
$zipHashPath = "$zipPath.sha256"

Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipHashPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $payload -Force | Out-Null

Push-Location $repoRoot
try {
  $status = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Unable to read git status." }
  if ($status | Where-Object { $_ -notmatch "^\?\? artifacts/" }) {
    throw "Release packaging requires a clean tracked working tree."
  }

  $sha = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $sha.Length -ne 40) {
    throw "Unable to resolve the release commit SHA."
  }

  npm run build:packages
  if ($LASTEXITCODE -ne 0) { throw "TVDoctor package build failed." }

  $workspaces = @(
    "@tvdoctor/protocol",
    "@tvdoctor/baseline",
    "@tvdoctor/core",
    "@tvdoctor/driver-web",
    "@tvdoctor/driver-android",
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

  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\install.ps1") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\uninstall.ps1") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\install.cmd") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\uninstall.cmd") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\INSTALL.md") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\app-package.json") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination $stage

  @(
    "TVDoctor version: $Version",
    "Git commit: $sha",
    "Node requirement: 24.x",
    "npm requirement: 11.x",
    "Playwright: 1.63.0",
    "Release channel: GitHub Releases",
    "Android TV support: Experimental"
  ) | Set-Content -LiteralPath (Join-Path $stage "BUILD-METADATA.txt") -Encoding UTF8

  $checksumFile = Join-Path $stage "CHECKSUMS-SHA256.txt"
  $hashLines = Get-ChildItem -LiteralPath $stage -File -Recurse |
    Where-Object { $_.FullName -ne $checksumFile } |
    Sort-Object FullName |
    ForEach-Object {
      $relative = [IO.Path]::GetRelativePath($stage, $_.FullName).Replace("\", "/")
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
