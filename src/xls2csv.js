// =====================================================================
//  旧Excel(.xls/.XLS=OLE2バイナリ) → CSV 変換（ローカル限定）
//  純粋なNodeでは旧Excelを読めないため、Excel COM(PowerShell)に変換させる。
//  ※ Excel依存はこのファイル＝照合.bat 経由の実行時だけに閉じ込める。
//     クラウド版ではこの関数を呼ばず、CSVを直接渡せばエンジンはそのまま動く。
//  ※ 日本語パスは PowerShell 5.1 のスクリプト読込文字コードで壊れるため、
//     パスはUTF-8ファイル経由で渡し、.ps1本体はASCIIのみにする。
// =====================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function isXls(p) { return /\.xlsx?$/i.test(p); }

// xlsPath を CSV(既定: Shift-JIS。csv.js が自動判定で読める) へ変換し、出力パスを返す
function xlsToCsv(xlsPath, outCsvPath) {
  if (!outCsvPath) {
    outCsvPath = path.join(os.tmpdir(), 'hanbai_conv_' + Date.now() + '.csv');
  }
  const tmp = os.tmpdir();
  const tag = 'xls2csv_' + process.pid + '_' + Date.now();
  const srcTxt = path.join(tmp, tag + '_src.txt');
  const outTxt = path.join(tmp, tag + '_out.txt');
  const work = path.join(tmp, tag + '_work.xls');
  const psFile = path.join(tmp, tag + '.ps1');
  fs.writeFileSync(srcTxt, xlsPath, 'utf8');
  fs.writeFileSync(outTxt, outCsvPath, 'utf8');

  const q = (p) => p.replace(/\\/g, '\\\\'); // .ps1内のWindowsパス用エスケープ（TEMP配下=ASCII）
  const script =
    "$ErrorActionPreference='Stop'\n" +
    "$src=[System.IO.File]::ReadAllText('" + q(srcTxt) + "',[System.Text.Encoding]::UTF8).Trim()\n" +
    "$out=[System.IO.File]::ReadAllText('" + q(outTxt) + "',[System.Text.Encoding]::UTF8).Trim()\n" +
    "$work='" + q(work) + "'\n" +
    "Copy-Item -LiteralPath $src -Destination $work -Force\n" +
    "$xl=New-Object -ComObject Excel.Application\n" +
    "$xl.Visible=$false; $xl.DisplayAlerts=$false\n" +
    "try {\n" +
    "  $wb=$xl.Workbooks.Open($work,0,$true)\n" +
    "  $wb.SaveAs($out,6)\n" +   // 6 = xlCSV
    "  $wb.Close($false)\n" +
    "} finally {\n" +
    "  $xl.Quit()\n" +
    "  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl) | Out-Null\n" +
    "}\n";
  fs.writeFileSync(psFile, script, 'ascii');

  try {
    execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString() : '') || e.message;
    throw new Error('Excelでの変換に失敗しました。ExcelがインストールされたWindowsで実行してください。\n' + msg);
  } finally {
    for (const f of [srcTxt, outTxt, work, psFile]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  if (!fs.existsSync(outCsvPath)) throw new Error('変換後CSVが見つかりません: ' + outCsvPath);
  return outCsvPath;
}

module.exports = { xlsToCsv, isXls };
