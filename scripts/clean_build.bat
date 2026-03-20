@echo off
REM clean_build.bat - Full clean and build (debug)
REM Usage: run from anywhere; script uses repository-relative paths.

setlocal
set "SCRIPT_DIR=%~dp0"
call "%SCRIPT_DIR%set_and_test_include_path.bat" called
call "%SCRIPT_DIR%common_helpers.bat"
call :call_vcvars

pushd "%SCRIPT_DIR%..\src-tauri"
echo Running: cargo clean
cargo clean
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
