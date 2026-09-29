@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-docker-env.ps1"
if errorlevel 1 (
  echo.
  echo GoQ Docker startup failed.
  pause
  exit /b 1
)
echo.
echo GoQ Docker startup finished.
pause
