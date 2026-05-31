@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 価格転嫁シミュレーションを起動します...
echo ブラウザが自動で開きます。終了するときはこのウィンドウで Ctrl+C を押してください。
echo.
node src\server.js
echo.
pause
