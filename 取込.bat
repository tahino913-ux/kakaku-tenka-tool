@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo メーカー見積の Excel(.xlsx) を maker_quotes フォルダのCSVに取り込みます。
echo 使い方: この 取込.bat に Excelファイルをドラッグ＆ドロップしてください。
echo （または maker_quotes フォルダに .xlsx を置いて 照合.bat を実行すれば自動で取り込まれます）
echo.
if "%~1"=="" (
  echo ※ファイルが指定されていません。Excelファイルをこのバットにドロップしてください。
  echo.
  pause
  exit /b 1
)
node src\makerXlsx.js "%~1"
echo.
pause
