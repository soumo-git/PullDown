@echo off
REM run.bat - Run the Tauri app (debug)
REM Checks for existing binary; if not found, builds first. Logs to logs\pulldown_debug.log

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "VSINSTALL="

REM Find Visual Studio
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath 2^>nul`) do set "VSINSTALL=%%i"
)

REM Initialize MSVC environment
if defined VSINSTALL (
  call "!VSINSTALL!\VC\Auxiliary\Build\vcvarsall.bat" x64
)

REM Ensure Rust/cargo are available
if not defined RUSTUP_HOME set "RUSTUP_HOME=%USERPROFILE%\.rustup"
set "PATH=!RUSTUP_HOME!\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%"

REM Change to project directory
pushd "!SCRIPT_DIR!..\src-tauri"

REM Create logs directory
if not exist "..\logs" mkdir "..\logs"
set "LOGFILE=!SCRIPT_DIR!..\logs\pulldown_debug.log"

REM Check if binary exists
if exist "target\debug\pulldown.exe" (
  echo [%date% %time%] Running existing debug binary >> "!LOGFILE!"
  echo Running existing debug binary...
  target\debug\pulldown.exe tauri dev >> "!LOGFILE!" 2>&1
) else (
  echo [%date% %time%] No binary found. Building... >> "!LOGFILE!"
  echo Building project...
  cargo build >> "!LOGFILE!" 2>&1
  if !ERRORLEVEL! equ 0 (
    echo [%date% %time%] Build succeeded. Running... >> "!LOGFILE!"
    echo Build succeeded. Running application...
    target\debug\pulldown.exe tauri dev >> "!LOGFILE!" 2>&1
  ) else (
    echo [%date% %time%] Build failed with error code !ERRORLEVEL! >> "!LOGFILE!"
    echo Build failed. Check log for details.
    start notepad "!LOGFILE!"
    popd
    endlocal
    pause
    exit /b 1
  )
)

popd
echo Log saved to: !LOGFILE!
if not "%~1"=="called" pause
endlocal
exit /b 0
