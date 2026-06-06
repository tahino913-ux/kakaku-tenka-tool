@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Japanese guidance is printed by node (renders correctly under chcp 65001).
rem Keep this .bat ASCII-only: cmd misparses Japanese in batch source and shows mojibake.
node src\server.js
rem Normal start / reuse exits 0 -> window auto-closes. Pause only on error (errorlevel>=1) so it can be read.
if errorlevel 1 pause
