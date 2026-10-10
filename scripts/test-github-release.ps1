[CmdletBinding()]
param(
  [string]$Bundle = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPackage = Get-Content -LiteralPath (Join-Path $repoRoot "packages\cli\package.json") -Raw | ConvertFrom-Json
$expectedVersion = [string]$cliPackage.version
if ([string]::IsNullOrWhiteSpace($Bundle)) {
  $Bundle = "artifacts/github-release/TVDoctor-v$expectedVersion-windows.zip"
}
$bundlePath = if ([IO.Path]::IsPathRooted($Bundle)) { $Bundle } else { Join-Path $repoRoot $Bundle }
if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
  throw "Release bundle not found: $bundlePath"
}
$bundleHashPath = "$bundlePath.sha256"
if (-not (Test-Path -LiteralPath $bundleHashPath -PathType Leaf)) {
  throw "Release bundle SHA-256 sidecar is missing: $bundleHashPath"
}
$bundleHashLine = (Get-Content -LiteralPath $bundleHashPath -Raw).Trim()
$bundleFileName = Split-Path -Leaf $bundlePath
if ($bundleHashLine -notmatch "^([0-9a-f]{64})  (.+)$" -or $Matches[2] -ne $bundleFileName) {
  throw "Release bundle SHA-256 sidecar is invalid."
}
$expectedBundleHash = $Matches[1]
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bundlePath).Hash.ToLowerInvariant() -ne $expectedBundleHash) {
  throw "Release bundle SHA-256 does not match its sidecar."
}

$root = Join-Path $env:TEMP ("tvdoctor-github-release-smoke-" + [Guid]::NewGuid().ToString("N"))
$extract = Join-Path $root "extract"
$installRoot = Join-Path $root "install"
$commandDirectory = Join-Path $root "bin"
$cache = Join-Path $root "empty-npm-cache"
New-Item -ItemType Directory -Path $extract,$installRoot,$commandDirectory,$cache -Force | Out-Null

function Remove-RehearsalRoot {
  param([string]$Path)

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\", "/")
  $expectedPrefix = $resolvedTemp + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Split-Path -Leaf $resolvedPath).StartsWith("tvdoctor-github-release-smoke-", [StringComparison]::Ordinal)) {
    throw "Refusing to remove an unexpected rehearsal path: $resolvedPath"
  }

  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    if (-not (Test-Path -LiteralPath $resolvedPath)) { return }
    try {
      [IO.Directory]::Delete("\\?\$resolvedPath", $true)
      return
    } catch {
      if ($attempt -eq 5) { throw }
      Start-Sleep -Milliseconds 200
    }
  }
}

Expand-Archive -LiteralPath $bundlePath -DestinationPath $extract
$releaseRoots = @(Get-ChildItem -LiteralPath $extract -Force)
if ($releaseRoots.Count -ne 1 -or -not $releaseRoots[0].PSIsContainer) {
  throw "Release ZIP must contain exactly one root directory."
}
$releaseRoot = $releaseRoots[0]
$standardName = "TVDoctor-v$expectedVersion-windows"
$isRehearsal = $releaseRoot.Name -eq "$standardName-rehearsal"
if (-not $isRehearsal -and $releaseRoot.Name -ne $standardName) {
  throw "Unexpected release ZIP root directory: $($releaseRoot.Name)"
}
$rehearsalMarker = Join-Path $releaseRoot.FullName "REHEARSAL-ONLY.txt"
$metadataText = Get-Content -LiteralPath (Join-Path $releaseRoot.FullName "BUILD-METADATA.txt") -Raw
if ($isRehearsal) {
  if (-not (Test-Path -LiteralPath $rehearsalMarker -PathType Leaf) -or
      $metadataText -notlike "*REHEARSAL ONLY - DO NOT PUBLISH*") {
    throw "Rehearsal ZIP is missing its do-not-publish markers."
  }
} elseif ((Test-Path -LiteralPath $rehearsalMarker) -or
          $metadataText -like "*REHEARSAL ONLY - DO NOT PUBLISH*") {
  throw "Publishable ZIP contains a rehearsal-only marker."
}
$installerManifest = Get-Content -LiteralPath (Join-Path $releaseRoot.FullName "app-package.json") -Raw | ConvertFrom-Json
$bundleVersion = [string]$installerManifest.version
if ($bundleVersion -ne $expectedVersion) {
  throw "Release bundle version $bundleVersion does not match CLI package version $expectedVersion."
}

$checksumFile = Join-Path $releaseRoot.FullName "CHECKSUMS-SHA256.txt"
$listedFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($line in Get-Content -LiteralPath $checksumFile) {
  if ($line -notmatch "^([0-9a-f]{64})  (.+)$") {
    throw "Invalid checksum entry: $line"
  }
  $expected = $Matches[1]
  $relative = $Matches[2].Replace("\", "/")
  if ([IO.Path]::IsPathRooted($relative) -or
      @($relative.Split("/") | Where-Object { $_ -eq ".." -or $_ -eq "." -or $_ -eq "" }).Count -gt 0 -or
      -not $listedFiles.Add($relative)) {
    throw "Invalid or duplicate release checksum path: $relative"
  }
  $path = Join-Path $releaseRoot.FullName $relative.Replace("/", "\")
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Release checksum references a missing file: $relative"
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "Checksum mismatch for $relative."
  }
}
foreach ($file in (Get-ChildItem -LiteralPath $releaseRoot.FullName -File -Recurse)) {
  if ($file.FullName -eq $checksumFile) { continue }
  $relative = $file.FullName.Substring($releaseRoot.FullName.Length).TrimStart("\", "/").Replace("\", "/")
  if (-not $listedFiles.Contains($relative)) {
    throw "Release ZIP contains a file absent from checksums: $relative"
  }
}
foreach ($property in $installerManifest.dependencies.PSObject.Properties) {
  $value = [string]$property.Value
  if ($value -notmatch '^file:packages/[^/]+\.tgz$' -or
      -not (Test-Path -LiteralPath (Join-Path $releaseRoot.FullName $value.Substring(5)) -PathType Leaf)) {
    throw "Installer dependency $($property.Name) does not resolve to a bundled tarball: $value"
  }
}

function Invoke-OfflineInstall {
  $previousOffline = $env:npm_config_offline
  $previousCache = $env:npm_config_cache
  try {
    $env:npm_config_offline = "true"
    $env:npm_config_cache = $cache
    & (Join-Path $releaseRoot.FullName "install.ps1") -InstallRoot $installRoot -CommandDirectory $commandDirectory
    if ($LASTEXITCODE -ne 0) { throw "Release installer failed." }
  } finally {
    $env:npm_config_offline = $previousOffline
    $env:npm_config_cache = $previousCache
  }
}

Invoke-OfflineInstall

$tvdoctor = Join-Path $commandDirectory "tvdoctor.cmd"
if (-not (Test-Path -LiteralPath $tvdoctor -PathType Leaf)) {
  throw "Release installer did not create the TVDoctor command."
}
$sentinelPath = Join-Path $installRoot ".tvdoctor-install.json"
$sentinel = Get-Content -LiteralPath $sentinelPath -Raw | ConvertFrom-Json
$launcherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tvdoctor).Hash.ToLowerInvariant()
if ([string]$sentinel.installRoot -ne [IO.Path]::GetFullPath($installRoot) -or
    [string]$sentinel.commandDirectory -ne [IO.Path]::GetFullPath($commandDirectory) -or
    [string]$sentinel.launcherPath -ne [IO.Path]::GetFullPath($tvdoctor) -or
    [string]$sentinel.launcherSha256 -ne $launcherHash) {
  throw "Release installer did not persist its install and launcher ownership metadata."
}

Invoke-OfflineInstall
if (-not (Test-Path -LiteralPath $tvdoctor -PathType Leaf)) {
  throw "Release reinstall did not preserve a working TVDoctor launcher."
}

$version = (& $tvdoctor --version).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne "tvdoctor $expectedVersion") {
  throw "Unexpected installed TVDoctor version: $version"
}

& $tvdoctor --help *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Installed TVDoctor help command failed."
}

$setupHelp = (& $tvdoctor setup --help | Out-String)
if ($LASTEXITCODE -ne 0 -or $setupHelp -notlike "*matched to this TVDoctor version*") {
  throw "Installed TVDoctor setup help command failed."
}

$doctor = (& $tvdoctor doctor | Out-String)
if ($LASTEXITCODE -ne 0 -or $doctor -notlike "*TVDoctor environment diagnosis*") {
  throw "Installed TVDoctor doctor command failed."
}

$demoOutput = Join-Path $root "demo-report"
$demo = (& $tvdoctor demo --output $demoOutput | Out-String)
if ($LASTEXITCODE -ne 0 -or $demo -notlike "*Demo VERIFIED*" -or $demo -notlike "*Replay: REPRODUCED*") {
  throw "Installed TVDoctor deterministic demo failed."
}
$demoReportPath = Join-Path $demoOutput "report.json"
$demoInventoryPath = Join-Path $demoOutput "inventory.json"
$demoReport = Get-Content -LiteralPath $demoReportPath -Raw | ConvertFrom-Json
$seededIssue = $demoReport.issues | Where-Object {
  $_.rule -eq "remote.reachability" -and
  $_.transition.fromElement -eq "hero-watch" -and
  $_.transition.action -eq "RIGHT" -and
  $_.transition.expectedElement -eq "hero-more-info" -and
  $_.transition.observedElement -eq "hero-watch"
} | Select-Object -First 1
if ($null -eq $seededIssue) {
  throw "Installed TVDoctor demo report is missing its seeded navigation finding."
}
$savedReplay = (& $tvdoctor replay ([string]$seededIssue.id) --report $demoReportPath | Out-String)
if ($LASTEXITCODE -ne 1 -or $savedReplay -notlike "*Replay classification REPRODUCED*") {
  throw "Installed TVDoctor saved replay did not reproduce the demo finding."
}

$baselinePath = Join-Path $root "demo-baseline.json"
$comparisonPath = Join-Path $root "demo-comparison.json"
$baselineCreate = (& $tvdoctor baseline create --report $demoReportPath --inventory $demoInventoryPath --output $baselinePath | Out-String)
if ($LASTEXITCODE -ne 0 -or $baselineCreate -notlike "*Baseline created from*") {
  throw "Installed TVDoctor baseline create failed."
}
$baselineCompare = (& $tvdoctor baseline compare --baseline $baselinePath --report $demoReportPath --inventory $demoInventoryPath --output $comparisonPath | Out-String)
if ($LASTEXITCODE -ne 0 -or $baselineCompare -notlike "*Baseline result: IDENTICAL*") {
  throw "Installed TVDoctor baseline compare failed."
}

$unrelatedCommandFile = Join-Path $commandDirectory "keep.txt"
Set-Content -LiteralPath $unrelatedCommandFile -Value "unrelated" -Encoding ASCII

& (Join-Path $releaseRoot.FullName "uninstall.ps1") -InstallRoot $installRoot
if ($LASTEXITCODE -ne 0) {
  throw "Release uninstaller failed."
}
if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $tvdoctor)) {
  throw "Release uninstaller left TVDoctor installation files behind."
}
if (-not (Test-Path -LiteralPath $unrelatedCommandFile -PathType Leaf)) {
  throw "Release uninstaller removed an unrelated file from the launcher directory."
}

Remove-RehearsalRoot -Path $root
Write-Host "GitHub Release Windows bundle install/reinstall/demo/replay/baseline/uninstall rehearsal: PASS"
