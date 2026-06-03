@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 価格転嫁シミュレーションを起動します...
echo ブラウザが自動で開きます。終了するときはこのウィンドウで Ctrl+C を押してください。
echo.
echo ブックマーク用URL: http://localhost:8765
echo  ・起動中なら、ブラウザのブックマークからこのURLを開くだけで画面に戻れます
echo  ・sim.bat をもう一度押しても、二重起動せずその画面を開き直します
echo.
node src\server.js
echo.
pause
