@echo off
setlocal
chcp 65001 >nul
rem =====================================================================
rem  Price pass-through SIMULATION (web tool) - START, no black window.
rem
rem  IMPORTANT: keep this file ASCII-only. cmd.exe misparses Japanese in
rem  batch source (mojibake / stray bytes read as commands).
rem
rem  What it does:
rem    1) Stops any old server on port 8765 so new code always loads
rem       (reuse alone would keep stale JS).
rem    2) Unblocks the sibling launcher sim.vbs (Google Drive marks new
rem       files ZoneId=3 and would refuse to run them).
rem    3) Launches sim.vbs hidden -> node runs the resident server with
rem       NO console window. server.js opens the browser itself.
rem
rem  This .bat window only flashes briefly and closes; the SERVER runs
rem  hidden. (A double-clicked .bat always shows a short console; that is
rem  unavoidable. The point is: no PERSISTENT black window.)
rem =====================================================================
cd /d "%~dp0"

rem 1) Stop old server on 8765 so code changes always load.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

rem 2) Unblock the sibling launcher .vbs (idempotent; quiet).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path '%~dp0sim.vbs' -ErrorAction SilentlyContinue | Unblock-File" >nul 2>&1

rem 3) Launch the hidden launcher -> node runs with no console window.
if exist "%~dp0sim.vbs" (
    start "" "%~dp0sim.vbs"
) else (
    echo WARNING: sim.vbs was not found next to this file.
    echo Falling back to a visible window...
    node src\server.js
    if errorlevel 1 pause
)

endlocal
