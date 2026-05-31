@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 価格転嫁見積ツールを実行します...
echo.
node src\index.js
echo.
pause
