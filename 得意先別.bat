@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 仕入先別の見積書を「得意先ごと1枚」に統合します...
echo （最新の仕入先別 見積書セットを自動で読み込みます。価格は再計算しません）
echo.
node src\merge_quotes.js
echo.
echo 出力先フォルダ（output\得意先別_見積書_*）を開きます...
for /f "delims=" %%D in ('dir /b /ad /o-d "output\得意先別_見積書_*" 2^>nul') do (
  start "" "output\%%D"
  goto :opened
)
:opened
echo.
pause
