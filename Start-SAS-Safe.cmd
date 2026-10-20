@echo off
setlocal
cd /d "%~dp0"
set "SAS_DISABLE_EXTENSIONS=1"
if exist "Super AI Story.exe" (
  start "" "%~dp0Super AI Story.exe"
  exit /b 0
)
call "%~dp0Start-SAS.cmd"
exit /b %errorlevel%
