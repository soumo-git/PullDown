param(
    [string]$Version = "3.0.23",
    [string]$Arch = "win64"
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host "[PullDown][fetch-vlc] $Message"
}

function Download-File([string]$Url, [string]$OutFile) {
    & curl.exe -fsSL --retry 3 --retry-delay 2 -o $OutFile $Url
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed for $Url (exit=$LASTEXITCODE)"
    }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tmpDir = Join-Path $projectRoot ".tmp\vlc"
$downloadDir = Join-Path $tmpDir "downloads"
$extractDir = Join-Path $tmpDir "extract"
$targetDir = Join-Path $projectRoot "src-tauri\resources\vlc\windows"

$zipName = "vlc-$Version-$Arch.zip"
$zipUrl = "https://get.videolan.org/vlc/$Version/$Arch/$zipName"
$shaUrl = "$zipUrl.sha256"
$zipPath = Join-Path $downloadDir $zipName
$shaPath = Join-Path $downloadDir "$zipName.sha256"

Write-Step "projectRoot=$projectRoot"
Write-Step "version=$Version arch=$Arch"
Write-Step "downloading: $zipUrl"

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

Download-File -Url $zipUrl -OutFile $zipPath

try {
    Download-File -Url $shaUrl -OutFile $shaPath
    $shaFile = (Get-Content -Path $shaPath -Raw).Trim()
    $expectedHash = ($shaFile -split "\s+")[0].Trim().ToUpperInvariant()
    $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($expectedHash -notmatch "^[A-F0-9]{64}$") {
        throw "Checksum file did not contain a SHA256 hash."
    }
    if ($expectedHash -ne $actualHash) {
        throw "SHA256 mismatch. expected=$expectedHash actual=$actualHash"
    }
    Write-Step "sha256 verified"
} catch {
    Write-Warning "[PullDown][fetch-vlc] sha256 verification skipped/failed: $($_.Exception.Message)"
}

Write-Step "extracting archive"
if (Test-Path $extractDir) {
    Remove-Item -Path $extractDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$rootFolder = Join-Path $extractDir ("vlc-$Version")
if (-not (Test-Path $rootFolder)) {
    $candidate = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
    if (-not $candidate) {
        throw "Could not find extracted VLC root directory."
    }
    $rootFolder = $candidate.FullName
}

if (-not (Test-Path (Join-Path $rootFolder "vlc.exe"))) {
    throw "Extracted directory does not contain vlc.exe: $rootFolder"
}

Write-Step "syncing into src-tauri/resources/vlc/windows"
if (Test-Path $targetDir) {
    Remove-Item -Path $targetDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -Path (Join-Path $rootFolder "*") -Destination $targetDir -Recurse -Force

$exePath = Join-Path $targetDir "vlc.exe"
$pluginsPath = Join-Path $targetDir "plugins"

if (-not (Test-Path $exePath)) {
    throw "Bundled VLC executable missing after copy: $exePath"
}
if (-not (Test-Path $pluginsPath)) {
    throw "Bundled VLC plugins directory missing after copy: $pluginsPath"
}

Write-Step "done: bundled VLC prepared at $targetDir"
