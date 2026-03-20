@echo off
REM set_and_test_include_path.bat
REM Checks whether User INCLUDE contains the Windows SDK shared include and adds it if missing.

setlocal EnableDelayedExpansion
set "SDK_SHARED=C:\Program Files (x86)\Windows Kits\10\Include\10.0.22621.0\shared"

REM Read the User INCLUDE from registry (HKCU) if present
for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v INCLUDE 2^>nul') do (
  set "USR_INCLUDE=%%B"
)

if defined USR_INCLUDE (
  echo Current User INCLUDE found.
  echo !USR_INCLUDE! | find /I "!SDK_SHARED!" >nul
  if !ERRORLEVEL!==0 (
    echo User INCLUDE already contains the SDK shared path: !SDK_SHARED!
    REM Also update current process INCLUDE so builds see it immediately
    set "INCLUDE=!USR_INCLUDE!"
    if "%~1"=="called" (endlocal & exit /b 0) else (endlocal & pause & exit /b 0)
  ) else (
    set "NEW_INCLUDE=!USR_INCLUDE!;!SDK_SHARED!"
    echo Adding SDK shared path to User INCLUDE...
    setx INCLUDE "!NEW_INCLUDE!" >nul
    if !ERRORLEVEL!==0 (
      echo User INCLUDE updated successfully.
      echo Note: open a new terminal to see the persistent change.
      REM Update current session as well
      set "INCLUDE=!NEW_INCLUDE!"
      if "%~1"=="called" (endlocal & exit /b 0) else (endlocal & pause & exit /b 0)
    ) else (
      echo Failed to update User INCLUDE via setx.
      if "%~1"=="called" (endlocal & exit /b 1) else (endlocal & pause & exit /b 1)
    )
  )
) else (
  echo No User INCLUDE found. Creating one with the SDK shared path...
  setx INCLUDE "!SDK_SHARED!" >nul
  if !ERRORLEVEL!==0 (
    echo User INCLUDE created.
    set "INCLUDE=!SDK_SHARED!"
    echo Note: open a new terminal to see the persistent change.
    if "%~1"=="called" (endlocal & exit /b 0) else (endlocal & pause & exit /b 0)
  ) else (
    echo Failed to create User INCLUDE via setx.
    if "%~1"=="called" (endlocal & exit /b 1) else (endlocal & pause & exit /b 1)
  )
)
