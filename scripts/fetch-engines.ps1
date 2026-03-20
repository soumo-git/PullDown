param(
  [ValidateSet("windows")]
  [string]$Platform = "windows"
)

$ErrorActionPreference = "Stop"

if ($Platform -ne "windows") {
  throw "Only windows platform is currently implemented by this script."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $repoRoot "src-tauri/engines/windows"
New-Item -ItemType Directory -Path $engineDir -Force | Out-Null

$ytPath = Join-Path $engineDir "yt-dlp.exe"
$ffmpegZip = Join-Path $env:TEMP "pulldown-ffmpeg.zip"
$ffmpegExtractDir = Join-Path $env:TEMP "pulldown-ffmpeg-extract"
$ffmpegPath = Join-Path $engineDir "ffmpeg.exe"

Write-Host "Downloading yt-dlp.exe..."
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $ytPath

Write-Host "Downloading ffmpeg zip..."
Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $ffmpegZip

if (Test-Path $ffmpegExtractDir) {
  Remove-Item -Recurse -Force $ffmpegExtractDir
}
New-Item -ItemType Directory -Path $ffmpegExtractDir | Out-Null

Write-Host "Extracting ffmpeg..."
Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegExtractDir -Force

$ffmpegSource = Get-ChildItem -Path $ffmpegExtractDir -Recurse -Filter "ffmpeg.exe" |
  Where-Object { $_.FullName -match "\\bin\\ffmpeg.exe$" } |
  Select-Object -First 1

if (-not $ffmpegSource) {
  throw "Unable to find ffmpeg.exe in extracted archive."
}

Copy-Item -Path $ffmpegSource.FullName -Destination $ffmpegPath -Force

Remove-Item -Force $ffmpegZip
Remove-Item -Recurse -Force $ffmpegExtractDir

Write-Host "Engines ready:"
Write-Host "  $ytPath"
Write-Host "  $ffmpegPath"
