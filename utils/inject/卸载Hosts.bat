@echo off
setlocal EnableExtensions

rem ===========================================================================
rem  Fiddler Everywhere patch - remove hosts entries
rem
rem  Removes the entries added by the install script. Run this as
rem  administrator before switching back to the official installer,
rem  otherwise the official app would also be pointed at the local server.
rem ===========================================================================

set "HOSTS=%SystemRoot%\System32\drivers\etc\hosts"
set "TMPFILE=%TEMP%\fiddler-hosts-%RANDOM%%RANDOM%.tmp"

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

findstr /I /C:"getfiddler" "%HOSTS%" >nul 2>&1
if not "%errorlevel%"=="0" (
    echo  No Fiddler entries found, nothing to remove.
    goto :finish
)

rem --- rewrite the file without our lines -----------------------------------
set "PS=$ErrorActionPreference='Stop'; $src=$env:HOSTS; $dst=$env:TMPFILE; $keep=@(Get-Content -LiteralPath $src | Where-Object { $_ -notmatch 'getfiddler' -and $_ -notmatch 'fiddler-everywhere-enhance' }); Set-Content -LiteralPath $dst -Value $keep -Encoding ascii; Copy-Item -LiteralPath $dst -Destination $src -Force; Remove-Item -LiteralPath $dst -Force"

powershell -NoProfile -ExecutionPolicy Bypass -Command "%PS%"

if not "%errorlevel%"=="0" (
    echo.
    echo  [FAIL] Could not update the hosts file.
    goto :finish
)

echo  Entries removed.

rem --- verify -------------------------------------------------------------
echo.
echo  Verifying removal...
findstr /I /C:"getfiddler" "%HOSTS%" >nul 2>&1
if "%errorlevel%"=="0" (
    echo   [WARN] some Fiddler lines are still present, check the file:
    echo          notepad "%HOSTS%"
) else (
    echo   [OK]   no Fiddler entries remain
)

echo.
echo  Flushing the DNS cache...
ipconfig /flushdns >nul 2>&1

echo.
echo ---------------------------------------------------------------------------
echo  Done. The official installer can be used again.
echo  To also reset the patched login session, delete:
echo      %%APPDATA%%\Fiddler Everywhere
echo ---------------------------------------------------------------------------
goto :finish

:finish
echo.
pause
endlocal
exit /b
