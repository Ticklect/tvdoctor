param(
    [string]$AndroidSdk,
    [string]$JavaHome,
    [string]$ExpectedCertificateSha256 = $env:TVDOCTOR_OBSERVER_CERTIFICATE_SHA256
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
        return Resolve-RequiredPath (Join-Path $ConfiguredJavaHome "bin\$Name.exe") $Name
    }
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw "$Name is required. Pass -JavaHome or add a JDK to PATH." }
    return [System.IO.Path]::GetFullPath($command.Source)
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build tool failed with exit code ${LASTEXITCODE}: $Executable" }
}

$configuredSdk = $AndroidSdk
if ([string]::IsNullOrWhiteSpace($configuredSdk)) { $configuredSdk = $env:TVDOCTOR_ANDROID_SDK }
if ([string]::IsNullOrWhiteSpace($configuredSdk)) { $configuredSdk = $env:ANDROID_SDK_ROOT }
if ([string]::IsNullOrWhiteSpace($configuredSdk)) { $configuredSdk = $env:ANDROID_HOME }
if ([string]::IsNullOrWhiteSpace($configuredSdk) -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $configuredSdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
$resolvedSdk = Resolve-RequiredPath $configuredSdk "Android SDK"
$buildToolsRoot = Resolve-RequiredPath (Join-Path $resolvedSdk "build-tools") "Android build-tools"
$platformsRoot = Resolve-RequiredPath (Join-Path $resolvedSdk "platforms") "Android platforms"
$buildTools = Get-ChildItem -LiteralPath $buildToolsRoot -Directory |
    Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } -Descending |
    Select-Object -First 1
$platform = Get-ChildItem -LiteralPath $platformsRoot -Directory |
    Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } -Descending |
    Select-Object -First 1
if ($null -eq $buildTools -or $null -eq $platform) { throw "A complete Android SDK platform and build-tools installation is required." }

$androidJar = Resolve-RequiredPath (Join-Path $platform.FullName "android.jar") "Android platform android.jar"
$aapt2 = Resolve-RequiredPath (Join-Path $buildTools.FullName "aapt2.exe") "aapt2"
$aapt = Resolve-RequiredPath (Join-Path $buildTools.FullName "aapt.exe") "aapt"
$d8 = Resolve-RequiredPath (Join-Path $buildTools.FullName "d8.bat") "d8"
$zipalign = Resolve-RequiredPath (Join-Path $buildTools.FullName "zipalign.exe") "zipalign"
$apksigner = Resolve-RequiredPath (Join-Path $buildTools.FullName "apksigner.bat") "apksigner"
$javac = Resolve-JavaTool "javac" $JavaHome
$jar = Resolve-JavaTool "jar" $JavaHome
$keytool = Resolve-JavaTool "keytool" $JavaHome

$observerRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $observerRoot ".build"))
$observerPrefix = $observerRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $buildRoot.StartsWith($observerPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a build directory outside the observer project."
}
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }

$compiledRoot = Join-Path $buildRoot "compiled"
$generatedRoot = Join-Path $buildRoot "generated"
$classesRoot = Join-Path $buildRoot "classes"
$dexRoot = Join-Path $buildRoot "dex"
$signingRoot = Join-Path $observerRoot "signing"
foreach ($directory in @($compiledRoot, $generatedRoot, $classesRoot, $dexRoot, $signingRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$compiledResources = Join-Path $compiledRoot "resources.zip"
$unsignedApk = Join-Path $buildRoot "observer-unsigned.apk"
$alignedApk = Join-Path $buildRoot "observer-aligned.apk"
$outputApk = Join-Path $observerRoot "tvdoctor-observer.apk"
Invoke-Checked $aapt2 @("compile", "--dir", (Join-Path $observerRoot "res"), "-o", $compiledResources)
Invoke-Checked $aapt2 @(
    "link", "-o", $unsignedApk,
    "--manifest", (Join-Path $observerRoot "AndroidManifest.xml"),
    "-I", $androidJar,
    "--java", $generatedRoot,
    "--min-sdk-version", "23",
    "--target-sdk-version", "36",
    "--version-code", "1",
    "--version-name", "0.1.8",
    $compiledResources
)

$sourceFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $observerRoot "src") -Filter "*.java" -Recurse -File | ForEach-Object { $_.FullName }
    Get-ChildItem -LiteralPath $generatedRoot -Filter "*.java" -Recurse -File | ForEach-Object { $_.FullName }
)
if ($sourceFiles.Count -lt 2) { throw "Expected observer source plus generated Android resources." }
Invoke-Checked $javac (@(
    "-encoding", "UTF-8",
    "--release", "17",
    "-Xlint:all,-deprecation,-options",
    "-Werror",
    "-classpath", $androidJar,
    "-d", $classesRoot
) + $sourceFiles)

$classesJar = Join-Path $buildRoot "classes.jar"
Invoke-Checked $jar @("--create", "--file", $classesJar, "-C", $classesRoot, ".")
Invoke-Checked $d8 @("--min-api", "23", "--lib", $androidJar, "--output", $dexRoot, $classesJar)
Push-Location $dexRoot
try { Invoke-Checked $aapt @("add", $unsignedApk, "classes.dex") } finally { Pop-Location }
Invoke-Checked $zipalign @("-f", "4", $unsignedApk, $alignedApk)

$configuredKeystore = $env:TVDOCTOR_OBSERVER_KEYSTORE
$releaseSigning = -not [string]::IsNullOrWhiteSpace($configuredKeystore)
if ($releaseSigning) {
    $keystore = Resolve-RequiredPath $configuredKeystore "TVDoctor observer release keystore"
    $signingAlias = $env:TVDOCTOR_OBSERVER_KEY_ALIAS
    if ([string]::IsNullOrWhiteSpace($signingAlias)) { throw "TVDOCTOR_OBSERVER_KEY_ALIAS is required for release signing." }
    if ([string]::IsNullOrWhiteSpace($env:TVDOCTOR_OBSERVER_STORE_PASSWORD)) { throw "TVDOCTOR_OBSERVER_STORE_PASSWORD is required for release signing." }
    if ([string]::IsNullOrWhiteSpace($env:TVDOCTOR_OBSERVER_KEY_PASSWORD)) { throw "TVDOCTOR_OBSERVER_KEY_PASSWORD is required for release signing." }
    $storePassword = "env:TVDOCTOR_OBSERVER_STORE_PASSWORD"
    $keyPassword = "env:TVDOCTOR_OBSERVER_KEY_PASSWORD"
} else {
    $keystore = Join-Path $signingRoot "tvdoctor-observer.p12"
    $signingAlias = "tvdoctor-observer"
    $storePassword = "pass:android"
    $keyPassword = "pass:android"
}
if (-not $releaseSigning -and -not (Test-Path -LiteralPath $keystore)) {
    Invoke-Checked $keytool @(
        "-genkeypair",
        "-keystore", $keystore,
        "-storetype", "PKCS12",
        "-storepass", "android",
        "-keypass", "android",
        "-alias", "tvdoctor-observer",
        "-dname", "CN=TVDoctor Observer, OU=Release Engineering, O=TVDoctor, L=Local, ST=Local, C=GB",
        "-keyalg", "RSA",
        "-keysize", "3072",
        "-sigalg", "SHA256withRSA",
        "-validity", "10000",
        "-noprompt"
    )
}
Invoke-Checked $apksigner @(
    "sign",
    "--ks", $keystore,
    "--ks-key-alias", $signingAlias,
    "--ks-pass", $storePassword,
    "--key-pass", $keyPassword,
    "--v4-signing-enabled", "false",
    "--out", $outputApk,
    $alignedApk
)
$previousErrorPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $verificationOutput = & $apksigner @("verify", "--verbose", "--print-certs", $outputApk) 2>&1
    $verificationExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $previousErrorPreference
}
if ($verificationExitCode -ne 0) { throw "Observer APK signature verification failed.`n$verificationOutput" }
$verificationOutput | Write-Output
$certificateMatch = [regex]::Match(
    ($verificationOutput -join "`n"),
    "Signer #1 certificate SHA-256 digest:\s*([0-9a-f]{64})",
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)
if (-not $certificateMatch.Success) { throw "Observer APK certificate SHA-256 digest was not reported by apksigner." }
$certificateSha256 = $certificateMatch.Groups[1].Value.ToLowerInvariant()
if (-not [string]::IsNullOrWhiteSpace($ExpectedCertificateSha256)) {
    $normalisedExpectedCertificate = $ExpectedCertificateSha256.Trim().ToLowerInvariant()
    if ($normalisedExpectedCertificate -notmatch '^[0-9a-f]{64}$') {
        throw "Expected observer certificate SHA-256 must contain exactly 64 hexadecimal characters."
    }
    if ($certificateSha256 -ne $normalisedExpectedCertificate) {
        throw "Observer APK certificate does not match the configured release certificate SHA-256."
    }
}

$sha256Algorithm = [System.Security.Cryptography.SHA256]::Create()
$apkStream = [System.IO.File]::OpenRead($outputApk)
try {
    $sha256 = ([System.BitConverter]::ToString($sha256Algorithm.ComputeHash($apkStream))).Replace("-", "").ToLowerInvariant()
} finally {
    $apkStream.Dispose()
    $sha256Algorithm.Dispose()
}
$manifest = [ordered]@{
    packageName = "org.tvdoctor.observer"
    versionName = "0.1.8"
    protocolVersion = 2
    sha256 = $sha256
    certificateSha256 = $certificateSha256
}
$manifestJson = $manifest | ConvertTo-Json
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $observerRoot "observer-manifest.json"), $manifestJson + [Environment]::NewLine, $utf8WithoutBom)
Write-Output "Built TVDoctor observer: $outputApk"
