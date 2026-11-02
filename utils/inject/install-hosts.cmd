@echo off
chcp 65001 >nul
setlocal

rem Adds the hosts entries Fiddler Everywhere 8.x needs so that the patched
rem application talks to its local API server instead of the real cloud.
rem Run this once, as administrator.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set "HOSTS=%SystemRoot%\System32\drivers\etc\hosts"

findstr /C:"api.getfiddler.be" "%HOSTS%" >nul 2>&1
if %errorlevel% neq 0 (
  echo.>> "%HOSTS%"
  echo # fiddler-everywhere-enhance>> "%HOSTS%"
  echo 127.0.0.1 api.getfiddler.be>> "%HOSTS%"
  echo 127.0.0.1 identity.getfiddler.be>> "%HOSTS%"
  echo hosts entries added.
) else (
  echo hosts entries already exist.
)

echo.
echo Verifying:
ping -n 1 api.getfiddler.be | findstr /C:"127.0.0.1" >nul 2>&1
if %errorlevel% equ 0 (echo   OK   api.getfiddler.be -^> 127.0.0.1) else (echo   FAIL api.getfiddler.be)
ping -n 1 identity.getfiddler.be | findstr /C:"127.0.0.1" >nul 2>&1
if %errorlevel% equ 0 (echo   OK   identity.getfiddler.be -^> 127.0.0.1) else (echo   FAIL identity.getfiddler.be)

echo.
echo Done. Start Fiddler Everywhere now.
pause >nul
