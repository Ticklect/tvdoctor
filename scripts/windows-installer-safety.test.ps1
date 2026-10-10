[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:TEMP ("tvdoctor-installer-safety-" + [Guid]::NewGuid().ToString("N"))
$fakeRelease = Join-Path $root "release"
$unsafeInstall = Join-Path $root "do-not-delete"
$ownedInstall = Join-Path $root "owned-install"
$commandDirectory = Join-Path $root "bin"
$collisionInstall = Join-Path $root "collision-install"
$managedInstall = Join-Path $root "managed-install"
$managedCommandDirectory = Join-Path $root "managed-bin"
$cliLog = Join-Path $root "fake-cli.log"
$forgedInstall = Join-Path $root "forged-install"
$forgedCommandDirectory = Join-Path $root "forged-bin"
$reinstallRoot = Join-Path $root "reinstall-root"
$reinstallCommandDirectory = Join-Path $root "reinstall-bin"
$movedCommandDirectory = Join-Path $root "moved-bin"
$npmAbsentInstall = Join-Path $root "npm-absent-install"
$npmAbsentCommandDirectory = Join-Path $root "npm-absent-bin"
$tamperedInstall = Join-Path $root "tampered-install"
$tamperedCommandDirectory = Join-Path $root "tampered-bin"

function New-FakeReleasePayload {
  param([string]$ReleaseRoot)

  $packageRoot = Join-Path $ReleaseRoot "packages\fake-tvdoctor"
  $distRoot = Join-Path $packageRoot "dist"
  New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
  @'
{
  "name": "tvdoctor",
  "version": "0.1.0",
  "bin": { "tvdoctor": "dist/bin.js" }
}
'@ | Set-Content -LiteralPath (Join-Path $packageRoot "package.json") -Encoding UTF8
  @'
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.TVDOCTOR_FAKE_CLI_LOG) {
  fs.appendFileSync(process.env.TVDOCTOR_FAKE_CLI_LOG, `${args.join(" ")}\n`);
}
if (args[0] === "--version") {
  console.log("tvdoctor 0.1.0");
} else if (args[0] === "doctor") {
  console.log("TVDoctor environment diagnosis");
} else if (args[0] === "setup") {
  console.log("Chromium setup complete");
} else {
  console.log("TVDoctor");
}
'@ | Set-Content -LiteralPath (Join-Path $distRoot "bin.js") -Encoding UTF8
  @'
{
  "name": "tvdoctor-github-release",
  "version": "0.1.0",
  "private": true,
  "dependencies": { "tvdoctor": "file:packages/fake-tvdoctor" }
}
'@ | Set-Content -LiteralPath (Join-Path $ReleaseRoot "app-package.json") -Encoding UTF8
}

try {
  New-Item -ItemType Directory -Path `
    $fakeRelease,$unsafeInstall,$ownedInstall,$commandDirectory,$collisionInstall,$managedCommandDirectory,`
    $forgedInstall,$forgedCommandDirectory,$reinstallCommandDirectory,$movedCommandDirectory,$npmAbsentCommandDirectory,$tamperedCommandDirectory `
    -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\install.ps1") -Destination $fakeRelease
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\windows\uninstall.ps1") -Destination $fakeRelease
  New-FakeReleasePayload -ReleaseRoot $fakeRelease

  $keep = Join-Path $unsafeInstall "keep.txt"
  Set-Content -LiteralPath $keep -Value "keep" -Encoding ASCII
  '{"name":"some-other-tool","version":"0.1.0"}' |
    Set-Content -LiteralPath (Join-Path $unsafeInstall ".tvdoctor-install.json") -Encoding UTF8
  $installBlocked = $false
  try {
    & (Join-Path $fakeRelease "install.ps1") -InstallRoot $unsafeInstall -CommandDirectory $commandDirectory
  } catch {
    $installBlocked = $_.Exception.Message -like "*not owned by TVDoctor*"
  }
  if (-not $installBlocked -or -not (Test-Path -LiteralPath $keep -PathType Leaf)) {
    throw "Installer did not preserve an existing unowned directory."
  }

  $uninstallBlocked = $false
  try {
    & (Join-Path $fakeRelease "uninstall.ps1") -InstallRoot $unsafeInstall -CommandDirectory $commandDirectory
  } catch {
    $uninstallBlocked = $_.Exception.Message -like "*not owned by TVDoctor*"
  }
  if (-not $uninstallBlocked -or -not (Test-Path -LiteralPath $keep -PathType Leaf)) {
    throw "Uninstaller did not preserve an existing unowned directory."
  }

  $forgedKeep = Join-Path $forgedInstall "keep.txt"
  Set-Content -LiteralPath $forgedKeep -Value "keep" -Encoding ASCII
  '{"name":"tvdoctor-install","version":"0.1.0"}' |
    Set-Content -LiteralPath (Join-Path $forgedInstall ".tvdoctor-install.json") -Encoding UTF8
  $forgedInstallBlocked = $false
  try {
    & (Join-Path $fakeRelease "install.ps1") -InstallRoot $forgedInstall -CommandDirectory $forgedCommandDirectory
  } catch {
    $forgedInstallBlocked = $_.Exception.Message -like "*not owned by TVDoctor*"
  }
  if (-not $forgedInstallBlocked -or -not (Test-Path -LiteralPath $forgedKeep -PathType Leaf)) {
    throw "Installer trusted a copied legacy sentinel for an arbitrary install directory."
  }
  $forgedUninstallBlocked = $false
  try {
    & (Join-Path $fakeRelease "uninstall.ps1") -InstallRoot $forgedInstall -CommandDirectory $forgedCommandDirectory
  } catch {
    $forgedUninstallBlocked = $_.Exception.Message -like "*not owned by TVDoctor*"
  }
  if (-not $forgedUninstallBlocked -or -not (Test-Path -LiteralPath $forgedKeep -PathType Leaf)) {
    throw "Uninstaller trusted a copied legacy sentinel for an arbitrary install directory."
  }

  $unrelatedLauncher = Join-Path $commandDirectory "tvdoctor.cmd"
  Set-Content -LiteralPath $unrelatedLauncher -Value "@echo off`r`necho unrelated" -Encoding ASCII
  $launcherCollisionBlocked = $false
  try {
    & (Join-Path $fakeRelease "install.ps1") -InstallRoot $collisionInstall -CommandDirectory $commandDirectory
  } catch {
    $launcherCollisionBlocked = $_.Exception.Message -like "*tvdoctor.cmd*not owned*"
  }
  if (-not $launcherCollisionBlocked) {
    throw "Installer did not refuse an unrelated existing tvdoctor.cmd launcher."
  }
  if ((Get-Content -LiteralPath $unrelatedLauncher -Raw) -notlike "*unrelated*") {
    throw "Installer changed an unrelated existing tvdoctor.cmd launcher."
  }

  $oldCliLog = $env:TVDOCTOR_FAKE_CLI_LOG
  try {
    $env:TVDOCTOR_FAKE_CLI_LOG = $cliLog
    $installWarnings = @()
    & (Join-Path $fakeRelease "install.ps1") `
      -InstallRoot $managedInstall `
      -CommandDirectory $managedCommandDirectory `
      -WarningVariable installWarnings
  } finally {
    $env:TVDOCTOR_FAKE_CLI_LOG = $oldCliLog
  }
  $managedLauncher = Join-Path $managedCommandDirectory "tvdoctor.cmd"
  $managedSentinelPath = Join-Path $managedInstall ".tvdoctor-install.json"
  $managedSentinel = Get-Content -LiteralPath $managedSentinelPath -Raw | ConvertFrom-Json
  if ([string]$managedSentinel.installRoot -ne [IO.Path]::GetFullPath($managedInstall) -or
      [string]$managedSentinel.commandDirectory -ne [IO.Path]::GetFullPath($managedCommandDirectory) -or
      [string]$managedSentinel.launcherPath -ne [IO.Path]::GetFullPath($managedLauncher)) {
    throw "Install sentinel did not record the owned install root and launcher location."
  }
  $launcherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $managedLauncher).Hash.ToLowerInvariant()
  if ([string]$managedSentinel.launcherSha256 -ne $launcherHash) {
    throw "Install sentinel did not record the owned launcher hash."
  }
  $cliInvocations = @(Get-Content -LiteralPath $cliLog)
  if ($cliInvocations -notcontains "--version" -or $cliInvocations -notcontains "doctor") {
    throw "Installer did not run post-install --version and doctor verification."
  }
  if (-not ($installWarnings | Where-Object { [string]$_ -like "*not on PATH*" })) {
    throw "Installer did not explain that its explicit launcher directory is not on PATH."
  }

  $changedPrefix = Join-Path $root "changed-prefix"
  $fakeTools = Join-Path $root "fake-tools"
  New-Item -ItemType Directory -Path $changedPrefix,$fakeTools -Force | Out-Null
  @'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
if (($Rest -join " ") -eq "prefix -g") {
  Write-Output $env:TVDOCTOR_TEST_NPM_PREFIX
  exit 0
}
if (($Rest -join " ") -eq "--version") {
  Write-Output "11.16.0"
  exit 0
}
exit 1
'@ | Set-Content -LiteralPath (Join-Path $fakeTools "npm.ps1") -Encoding UTF8
  $oldPath = $env:PATH
  $oldTestPrefix = $env:TVDOCTOR_TEST_NPM_PREFIX
  try {
    $env:TVDOCTOR_TEST_NPM_PREFIX = $changedPrefix
    $env:PATH = "$fakeTools$([IO.Path]::PathSeparator)$oldPath"
    & (Join-Path $fakeRelease "uninstall.ps1") -InstallRoot $managedInstall
  } finally {
    $env:PATH = $oldPath
    $env:TVDOCTOR_TEST_NPM_PREFIX = $oldTestPrefix
  }
  if ((Test-Path -LiteralPath $managedInstall) -or (Test-Path -LiteralPath $managedLauncher)) {
    throw "Uninstaller did not use the recorded launcher path after npm's global prefix changed."
  }

  & (Join-Path $fakeRelease "install.ps1") -InstallRoot $npmAbsentInstall -CommandDirectory $npmAbsentCommandDirectory *> $null
  $npmAbsentLauncher = Join-Path $npmAbsentCommandDirectory "tvdoctor.cmd"
  $oldPath = $env:PATH
  try {
    $env:PATH = "$env:SystemRoot\System32$([IO.Path]::PathSeparator)$env:SystemRoot"
    & (Join-Path $fakeRelease "uninstall.ps1") -InstallRoot $npmAbsentInstall
  } finally {
    $env:PATH = $oldPath
  }
  if ((Test-Path -LiteralPath $npmAbsentInstall) -or (Test-Path -LiteralPath $npmAbsentLauncher)) {
    throw "Uninstaller did not work from recorded metadata when npm was absent from PATH."
  }

  & (Join-Path $fakeRelease "install.ps1") -InstallRoot $reinstallRoot -CommandDirectory $reinstallCommandDirectory *> $null
  $reinstallLauncher = Join-Path $reinstallCommandDirectory "tvdoctor.cmd"
  $reinstallMarker = Join-Path $reinstallRoot "preserve-until-reinstall-approved.txt"
  Set-Content -LiteralPath $reinstallMarker -Value "preserve" -Encoding ASCII
  $movedReinstallBlocked = $false
  try {
    & (Join-Path $fakeRelease "install.ps1") -InstallRoot $reinstallRoot -CommandDirectory $movedCommandDirectory *> $null
  } catch {
    $movedReinstallBlocked = $_.Exception.Message -like "*launcher directory*"
  }
  if (-not $movedReinstallBlocked -or
      -not (Test-Path -LiteralPath $reinstallMarker -PathType Leaf) -or
      -not (Test-Path -LiteralPath $reinstallLauncher -PathType Leaf)) {
    throw "Installer did not block a reinstall that would orphan its recorded launcher."
  }
  & (Join-Path $fakeRelease "install.ps1") -InstallRoot $reinstallRoot -CommandDirectory $reinstallCommandDirectory *> $null
  if (-not (Test-Path -LiteralPath $reinstallLauncher -PathType Leaf)) {
    throw "Installer did not allow a reinstall using its recorded owned launcher directory."
  }
  & (Join-Path $fakeRelease "uninstall.ps1") -InstallRoot $reinstallRoot *> $null

  & (Join-Path $fakeRelease "install.ps1") -InstallRoot $tamperedInstall -CommandDirectory $tamperedCommandDirectory *> $null
  $tamperedLauncher = Join-Path $tamperedCommandDirectory "tvdoctor.cmd"
  $tamperedMarker = Join-Path $tamperedInstall "preserve-on-blocked-reinstall.txt"
  Set-Content -LiteralPath $tamperedMarker -Value "preserve" -Encoding ASCII
  Add-Content -LiteralPath $tamperedLauncher -Value "echo tampered" -Encoding ASCII
  $tamperedReinstallBlocked = $false
  try {
    & (Join-Path $fakeRelease "install.ps1") -InstallRoot $tamperedInstall -CommandDirectory $tamperedCommandDirectory *> $null
  } catch {
    $tamperedReinstallBlocked = $_.Exception.Message -like "*tvdoctor.cmd*not owned*"
  }
  if (-not $tamperedReinstallBlocked -or -not (Test-Path -LiteralPath $tamperedMarker -PathType Leaf)) {
    throw "Installer trusted a launcher whose recorded ownership hash no longer matched."
  }
  & (Join-Path $fakeRelease "uninstall.ps1") -InstallRoot $tamperedInstall *> $null
  if ((Test-Path -LiteralPath $tamperedInstall) -or -not (Test-Path -LiteralPath $tamperedLauncher -PathType Leaf)) {
    throw "Uninstaller removed a launcher whose recorded ownership hash no longer matched."
  }

  $prerequisiteTools = Join-Path $root "prerequisite-tools"
  $prerequisiteInstall = Join-Path $root "prerequisite-install"
  $prerequisiteBin = Join-Path $root "prerequisite-bin"
  New-Item -ItemType Directory -Path $prerequisiteTools,$prerequisiteInstall,$prerequisiteBin -Force | Out-Null
  @'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
if (($Rest -join " ") -eq "--version") {
  Write-Output $env:TVDOCTOR_TEST_NODE_VERSION
  exit 0
}
exit 1
'@ | Set-Content -LiteralPath (Join-Path $prerequisiteTools "node.ps1") -Encoding UTF8
  @'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
if (($Rest -join " ") -eq "--version") {
  Write-Output $env:TVDOCTOR_TEST_NPM_VERSION
  exit 0
}
exit 1
'@ | Set-Content -LiteralPath (Join-Path $prerequisiteTools "npm.ps1") -Encoding UTF8
  $oldPath = $env:PATH
  $oldNodeVersion = $env:TVDOCTOR_TEST_NODE_VERSION
  $oldNpmVersion = $env:TVDOCTOR_TEST_NPM_VERSION
  try {
    $env:PATH = "$prerequisiteTools$([IO.Path]::PathSeparator)$oldPath"
    $env:TVDOCTOR_TEST_NODE_VERSION = "v22.12.0"
    $env:TVDOCTOR_TEST_NPM_VERSION = "10.9.4"
    $unsupportedNodeBlocked = $false
    try {
      & (Join-Path $fakeRelease "install.ps1") -InstallRoot $prerequisiteInstall -CommandDirectory $prerequisiteBin
    } catch {
      $unsupportedNodeBlocked = $_.Exception.Message -like "*>=22.13.0 <23 or >=24.0.0 <25*"
    }
    if (-not $unsupportedNodeBlocked) {
      throw "Installer did not reject Node.js 22.12 below the supported floor."
    }

    $env:TVDOCTOR_TEST_NODE_VERSION = "v24.18.0"
    $env:TVDOCTOR_TEST_NPM_VERSION = "12.0.0"
    $unsupportedNpmBlocked = $false
    try {
      & (Join-Path $fakeRelease "install.ps1") -InstallRoot $prerequisiteInstall -CommandDirectory $prerequisiteBin
    } catch {
      $unsupportedNpmBlocked = $_.Exception.Message -like "*npm >=10.0.0 <12*"
    }
    if (-not $unsupportedNpmBlocked) {
      throw "Installer did not reject npm 12 outside the supported range."
    }
  } finally {
    $env:PATH = $oldPath
    $env:TVDOCTOR_TEST_NODE_VERSION = $oldNodeVersion
    $env:TVDOCTOR_TEST_NPM_VERSION = $oldNpmVersion
  }

  $ownedSentinel = [ordered]@{
    name = "tvdoctor-install"
    version = "0.1.0"
    installRoot = [IO.Path]::GetFullPath($ownedInstall)
    commandDirectory = [IO.Path]::GetFullPath($commandDirectory)
    launcherPath = [IO.Path]::GetFullPath((Join-Path $commandDirectory "tvdoctor.cmd"))
  } | ConvertTo-Json
  $ownedSentinel |
    Set-Content -LiteralPath (Join-Path $ownedInstall ".tvdoctor-install.json") -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $ownedInstall "owned.txt") -Value "owned" -Encoding ASCII
  & (Join-Path $fakeRelease "uninstall.ps1") -InstallRoot $ownedInstall -CommandDirectory $commandDirectory
  if (Test-Path -LiteralPath $ownedInstall) {
    throw "Uninstaller did not remove a sentinel-owned TVDoctor directory."
  }

  Write-Host "Windows installer ownership safety: PASS"
  $global:LASTEXITCODE = 0
} finally {
  if (Test-Path -LiteralPath $root) {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
