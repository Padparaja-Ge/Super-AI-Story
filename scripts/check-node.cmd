@echo off
where node >nul 2>nul
if errorlevel 1 goto :missing
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto :missing
where npm.cmd >nul 2>nul
if errorlevel 1 goto :missing
exit /b 0
:missing
echo.
echo SAS needs Node.js 22 or newer and npm to run from source.
echo Download the Windows LTS installer from the official website:
echo https://nodejs.org/en/download
echo Install Node.js with npm, then close this window and run SAS again.
echo The portable SAS .exe includes its runtime and does not need Node.js.
echo.
exit /b 1
