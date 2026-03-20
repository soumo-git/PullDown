@echo off
REM build_debug.bat - Build debug without cleaning

setlocal
set "SCRIPT_DIR=%~dp0"
call "%SCRIPT_DIR%set_and_test_include_path.bat" called
call "%SCRIPT_DIR%common_helpers.bat"
call :call_vcvars

pushd "%SCRIPT_DIR%..\src-tauri"
echo Running: cargo build
cargo build
popd

if "%~1"=="called" (
	endlocal & exit /b %ERRORLEVEL%
) else (
	endlocal
	echo.
	pause
	exit /b %ERRORLEVEL%
)
