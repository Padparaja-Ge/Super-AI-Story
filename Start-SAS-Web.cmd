@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto :failed
call "%~dp0scripts\check-node.cmd"
if errorlevel 1 goto :failed
set "SAS_INSTALL_DEPS="
if not exist "node_modules\express\package.json" set "SAS_INSTALL_DEPS=1"
if not exist "node_modules\google-translate-api-x\package.json" set "SAS_INSTALL_DEPS=1"
if defined SAS_INSTALL_DEPS (
  echo Installing SAS web dependencies...
  call npm.cmd ci --omit=dev
  if errorlevel 1 goto :failed
)
if not exist "dist\index.html" (
  echo Building the SAS web interface...
  call npm.cmd ci --include=dev
  if errorlevel 1 goto :failed
  call npm.cmd run build
  if errorlevel 1 goto :failed
)
node server\web.mjs %*
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo SAS Web could not start. Read the error above or see README.md.
pause
exit /b 1
