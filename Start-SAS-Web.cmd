@echo off
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-SAS.ps1" -Action Web
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
endlocal
