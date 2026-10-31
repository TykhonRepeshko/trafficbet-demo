@echo off
setlocal
where pwsh.exe >nul 2>nul
if %errorlevel%==0 goto installed
set "TRAFFICBET_CHECK_PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if exist "%TRAFFICBET_CHECK_PWSH%" goto bundled
echo PowerShell 7 is required for checks. Install it or run scripts/check.ps1 in an allowed PowerShell host.
exit /b 1
:installed
pwsh.exe -NoProfile -File "%~dp0scripts\check.ps1" %*
exit /b %errorlevel%
:bundled
"%TRAFFICBET_CHECK_PWSH%" -NoProfile -File "%~dp0scripts\check.ps1" %*
exit /b %errorlevel%
