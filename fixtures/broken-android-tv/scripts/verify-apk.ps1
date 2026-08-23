param(
    [string]$AndroidSdk,
    [string]$ApkPath = "build\outputs\apk\debug\tvdoctor-broken-android-tv-debug.apk"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-RequiredPath {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        throw "$Label was not found at the configured path."
    }
    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Invoke-Captured {
    param([string]$Executable, [string[]]$Arguments)
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $Executable @Arguments 2>&1
        $toolExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorPreference
    }
    if ($toolExitCode -ne 0) {
        throw "Verification tool failed with exit code ${toolExitCode}: $Executable`n$output"
    }
    return ($output -join "`n")
}

$configuredSdk = $AndroidSdk
if ([string]::IsNullOrWhiteSpace($configuredSdk)) { $configuredSdk = $env:TVDOCTOR_ANDROID_SDK }
if ([string]::IsNullOrWhiteSpace($configuredSdk)) { $configuredSdk = $env:ANDROID_SDK_ROOT }
if ([string]::IsNullOrWhiteSpace($configuredSdk)) { $configuredSdk = $env:ANDROID_HOME }
if ([string]::IsNullOrWhiteSpace($configuredSdk)) {
    throw "Android SDK is required. Pass -AndroidSdk or set TVDOCTOR_ANDROID_SDK/ANDROID_SDK_ROOT."
}

$fixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$resolvedSdk = Resolve-RequiredPath $configuredSdk "Android SDK"
$buildTools = Resolve-RequiredPath (Join-Path $resolvedSdk "build-tools\36.0.0") "Android build-tools 36.0.0"
$aapt = Resolve-RequiredPath (Join-Path $buildTools "aapt.exe") "aapt"
$apksigner = Resolve-RequiredPath (Join-Path $buildTools "apksigner.bat") "apksigner"
$resolvedApk = if ([System.IO.Path]::IsPathRooted($ApkPath)) {
    Resolve-RequiredPath $ApkPath "fixture APK"
} else {
    Resolve-RequiredPath (Join-Path $fixtureRoot $ApkPath) "fixture APK"
}

$signature = Invoke-Captured $apksigner @("verify", "--verbose", "--print-certs", $resolvedApk)
if ($signature -notmatch "Verified using v2 scheme.*true") {
    throw "APK is not verified with Android signature scheme v2."
}

$badging = Invoke-Captured $aapt @("dump", "badging", $resolvedApk)
if ($badging -notmatch "package: name='org\.tvdoctor\.fixture'") {
    throw "APK package id is not org.tvdoctor.fixture."
}
if ($badging -notmatch "uses-feature: name='android\.software\.leanback'") {
    throw "APK does not require the Leanback TV feature."
}
if ($badging -notmatch "uses-feature-not-required: name='android\.hardware\.touchscreen'") {
    throw "APK does not explicitly mark touchscreen as optional."
}
if ($badging -notmatch "leanback-launchable-activity: name='org\.tvdoctor\.fixture\.MainActivity'") {
    throw "APK has no exported Leanback launcher activity."
}

$contents = Invoke-Captured $aapt @("list", $resolvedApk)
foreach ($requiredEntry in @("AndroidManifest.xml", "classes.dex", "resources.arsc")) {
    if (($contents -split "`n") -notcontains $requiredEntry) {
        throw "APK is missing required entry: $requiredEntry"
    }
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$apkStream = [System.IO.File]::OpenRead($resolvedApk)
try {
    $hashBytes = $sha256.ComputeHash($apkStream)
}
finally {
    $apkStream.Dispose()
    $sha256.Dispose()
}
$hash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
$length = (Get-Item -LiteralPath $resolvedApk).Length
Write-Output "APK verification passed: package, Leanback launcher, optional touchscreen, signature, and archive structure."
Write-Output "APK bytes: $length"
Write-Output "APK SHA-256: $hash"
