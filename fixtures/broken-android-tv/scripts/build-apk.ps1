param(
    [string]$AndroidSdk,
    [string]$JavaHome
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

function Resolve-JavaTool {
    param([string]$Name, [string]$ConfiguredJavaHome)
    if (-not [string]::IsNullOrWhiteSpace($ConfiguredJavaHome)) {
        $candidate = Join-Path $ConfiguredJavaHome "bin\$Name.exe"
        return Resolve-RequiredPath $candidate $Name
    }
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "$Name is required. Pass -JavaHome or add a JDK to PATH."
    }
    return [System.IO.Path]::GetFullPath($command.Source)
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Build tool failed with exit code ${LASTEXITCODE}: $Executable"
    }
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
$androidJar = Resolve-RequiredPath (Join-Path $resolvedSdk "platforms\android-36\android.jar") "Android API 36 platform"
$aapt2 = Resolve-RequiredPath (Join-Path $buildTools "aapt2.exe") "aapt2"
$aapt = Resolve-RequiredPath (Join-Path $buildTools "aapt.exe") "aapt"
$d8 = Resolve-RequiredPath (Join-Path $buildTools "d8.bat") "d8"
$zipalign = Resolve-RequiredPath (Join-Path $buildTools "zipalign.exe") "zipalign"
$apksigner = Resolve-RequiredPath (Join-Path $buildTools "apksigner.bat") "apksigner"
$javac = Resolve-JavaTool "javac" $JavaHome
$jar = Resolve-JavaTool "jar" $JavaHome
$keytool = Resolve-JavaTool "keytool" $JavaHome

$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $fixtureRoot "build"))
$fixturePrefix = $fixtureRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $buildRoot.StartsWith($fixturePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a build directory outside the Android fixture."
}
if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}

$compiledRoot = Join-Path $buildRoot "compiled"
$generatedRoot = Join-Path $buildRoot "generated"
$classesRoot = Join-Path $buildRoot "classes"
$dexRoot = Join-Path $buildRoot "dex"
$signingRoot = Join-Path $buildRoot "signing"
$outputRoot = Join-Path $buildRoot "outputs\apk\debug"
foreach ($directory in @($compiledRoot, $generatedRoot, $classesRoot, $dexRoot, $signingRoot, $outputRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$compiledResources = Join-Path $compiledRoot "resources.zip"
$unsignedApk = Join-Path $buildRoot "fixture-unsigned.apk"
$alignedApk = Join-Path $buildRoot "fixture-aligned.apk"
$outputApk = Join-Path $outputRoot "tvdoctor-broken-android-tv-debug.apk"
$manifest = Join-Path $fixtureRoot "AndroidManifest.xml"
$resources = Join-Path $fixtureRoot "res"

Invoke-Checked $aapt2 @("compile", "--dir", $resources, "-o", $compiledResources)
Invoke-Checked $aapt2 @(
    "link",
    "-o", $unsignedApk,
    "--manifest", $manifest,
    "-I", $androidJar,
    "--java", $generatedRoot,
    "--min-sdk-version", "23",
    "--target-sdk-version", "36",
    "--version-code", "1",
    "--version-name", "0.1.0",
    $compiledResources
)

$sourceFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $fixtureRoot "src") -Filter "*.java" -Recurse -File | ForEach-Object { $_.FullName }
    Get-ChildItem -LiteralPath $generatedRoot -Filter "*.java" -Recurse -File | ForEach-Object { $_.FullName }
)
if ($sourceFiles.Count -lt 2) {
    throw "Expected fixture source plus generated Android resources."
}
$javacArguments = @(
    "-encoding", "UTF-8",
    "--release", "17",
    "-Xlint:all",
    "-Werror",
    "-classpath", $androidJar,
    "-d", $classesRoot
) + $sourceFiles
Invoke-Checked $javac $javacArguments

$classesJar = Join-Path $buildRoot "classes.jar"
Invoke-Checked $jar @("--create", "--file", $classesJar, "-C", $classesRoot, ".")
Invoke-Checked $d8 @("--min-api", "23", "--lib", $androidJar, "--output", $dexRoot, $classesJar)

Push-Location $dexRoot
try {
    Invoke-Checked $aapt @("add", $unsignedApk, "classes.dex")
}
finally {
    Pop-Location
}

Invoke-Checked $zipalign @("-f", "4", $unsignedApk, $alignedApk)

$keystore = Join-Path $signingRoot "fixture-debug.p12"
Invoke-Checked $keytool @(
    "-genkeypair",
    "-keystore", $keystore,
    "-storetype", "PKCS12",
    "-storepass", "android",
    "-keypass", "android",
    "-alias", "androiddebugkey",
    "-dname", "CN=TVDoctor Fixture, OU=Development, O=TVDoctor, L=Local, ST=Local, C=GB",
    "-keyalg", "RSA",
    "-keysize", "2048",
    "-sigalg", "SHA256withRSA",
    "-validity", "10000",
    "-noprompt"
)
Invoke-Checked $apksigner @(
    "sign",
    "--ks", $keystore,
    "--ks-key-alias", "androiddebugkey",
    "--ks-pass", "pass:android",
    "--key-pass", "pass:android",
    "--out", $outputApk,
    $alignedApk
)

& (Join-Path $PSScriptRoot "verify-apk.ps1") -AndroidSdk $resolvedSdk -ApkPath $outputApk
if ($LASTEXITCODE -ne 0) {
    throw "APK verification failed."
}

Write-Output "Built Android TV fixture: $outputApk"
