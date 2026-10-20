@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto :failed
call "%~dp0scripts\check-node.cmd"
if errorlevel 1 goto :failed
set "SAS_INSTALL_DEPS="
if not exist "node_modules\.bin\electron.cmd" set "SAS_INSTALL_DEPS=1"
if not exist "node_modules\google-translate-api-x\package.json" set "SAS_INSTALL_DEPS=1"
if defined SAS_INSTALL_DEPS (
  echo Installing SAS dependencies for the first launch...
  call npm.cmd ci --include=dev
  if errorlevel 1 goto :failed
)
echo Building the current SAS interface...
call npm.cmd run build
if errorlevel 1 goto :failed
call npm.cmd run desktop
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo SAS could not start. Read the error above or see README.md.
pause
exit /b 1
