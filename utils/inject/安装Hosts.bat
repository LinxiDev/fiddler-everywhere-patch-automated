@echo off
setlocal EnableExtensions

rem ===========================================================================
rem  Fiddler Everywhere patch - install hosts entries
rem
rem  Maps the Fiddler API hostnames to the local mock server so that the .NET
rem  backend can sign in. Right-click this file and choose
rem  "Run as administrator".
rem
rem  These entries must stay in place while you use the patched app: every
rem  launch needs them, not only the first one.
rem ===========================================================================

set "MARKER=# fiddler-everywhere-enhance"
set "HOSTS=%SystemRoot%\System32\drivers\etc\hosts"

rem --- require administrator ------------------------------------------------
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo.
    echo  Administrator rights are required.
    echo  A UAC prompt will appear. Choose "Yes".
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "%HOSTS%" (
    echo.
    echo  [FAIL] hosts file not found: %HOSTS%
    goto :finish
)

echo.
echo  Hosts file: %HOSTS%
echo.

rem --- add only what is missing ---------------------------------------------
set "ADDED=0"
call :ensure api.getfiddler.be
call :ensure identity.getfiddler.be

echo.
if "%ADDED%"=="0" (
    echo  Nothing to do, the entries were already present.
) else (
    echo  Entries written.
)

rem --- verify what the resolver actually returns ---------------------------
echo.
echo  Verifying resolution...
set "DNSBAD="
call :verify api.getfiddler.be
call :verify identity.getfiddler.be

if defined DNSBAD (
    echo.
    echo  The file was updated but these names still resolve elsewhere.
    echo  Flushing the DNS cache...
    ipconfig /flushdns >nul 2>&1
    echo.
    echo  If the check keeps failing:
    echo    1. Open the file and make sure it is named "hosts", not "hosts.txt":
    echo         notepad "%HOSTS%"
    echo    2. Confirm it contains:  127.0.0.1 api.getfiddler.be
    echo    3. Run this file again as administrator.
)

echo.
echo ---------------------------------------------------------------------------
echo  Start Fiddler Everywhere now. This setup is needed only once.
echo  Do not remove these entries: sign-in breaks on the next launch.
echo ---------------------------------------------------------------------------
goto :finish

rem --- subroutines ----------------------------------------------------------

:ensure
findstr /I /C:"127.0.0.1 %~1" "%HOSTS%" >nul 2>&1
if "%errorlevel%"=="0" (
    echo   [skip] %~1
    exit /b
)
if "%ADDED%"=="0" (
    >>"%HOSTS%" echo.
    >>"%HOSTS%" echo %MARKER%
)
>>"%HOSTS%" echo 127.0.0.1 %~1
set "ADDED=1"
echo   [add ] %~1
exit /b

:verify
ping -n 1 -w 1000 %~1 | findstr /C:"127.0.0.1" >nul 2>&1
if "%errorlevel%"=="0" (
    echo   [OK]   %~1  -^>  127.0.0.1
) else (
    echo   [FAIL] %~1  is NOT resolving to 127.0.0.1
    set "DNSBAD=1"
)
exit /b

:finish
echo.
pause
endlocal
exit /b
