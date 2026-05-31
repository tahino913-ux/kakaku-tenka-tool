@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo メーカー見積を販売実績と照合します...
echo （販売実績が旧Excel形式の場合、自動でCSVに変換します。少し時間がかかることがあります）
echo.
node src\shogo.js
echo.
pause
