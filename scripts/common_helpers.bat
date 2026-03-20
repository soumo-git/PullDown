@echo off
REM common_helpers.bat - internal helpers used by build scripts
REM Usage: call common_helpers.bat from other scripts to get VS setup function

:find_vs
REM Locate Visual Studio installation path using vswhere
set "VSINSTALL="
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath 2^>nul`) do set "VSINSTALL=%%i"
)
if defined VSINSTALL (
  echo Found Visual Studio at %VSINSTALL%
  goto :eof
) else (
  echo vswhere not found or Visual Studio not detected. Ensure Visual Studio or Build Tools are installed.
  goto :eof
)

:call_vcvars
REM Call this label: call :call_vcvars
if not defined VSINSTALL (
  call :find_vs
)
if defined VSINSTALL (
  call "%VSINSTALL%\VC\Auxiliary\Build\vcvarsall.bat" x64
)
goto :eof
