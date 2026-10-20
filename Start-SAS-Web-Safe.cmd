@echo off
setlocal
cd /d "%~dp0"
set "SAS_DISABLE_EXTENSIONS=1"
call "%~dp0Start-SAS-Web.cmd"
exit /b %errorlevel%
