@echo off
chcp 65001 >nul
setlocal

rem Removes the hosts entries added by install-hosts.cmd.
rem Run this as administrator before switching back to the official installer.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set "HOSTS=%SystemRoot%\System32\drivers\etc\hosts"
set "TEMP_HOSTS=%TEMP%\fiddler-hosts.tmp"

powershell -NoProfile -Command "$src = Get-Content -LiteralPath $env:HOSTS -ErrorAction Stop | Where-Object { $_ -notmatch 'getfiddler|fiddler-everywhere-enhance' }; Set-Content -LiteralPath $env:TEMP_HOSTS -Value $src -Encoding ascii; Move-Item -LiteralPath $env:TEMP_HOSTS -Destination $env:HOSTS -Force"

if %errorlevel% neq 0 (
  echo hosts update FAILED - check permissions.
) else (
  echo hosts entries removed.
)

echo.
echo Done.
pause >nul
