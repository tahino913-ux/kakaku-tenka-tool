// =====================================================================
//  見積書(.xlsx) → PDF 変換 ＋ Outlook 下書き作成（Windows + Excel/Outlook COM）
//  ・PDF化   : Excel COM の ExportAsFixedFormat（レイアウトはxlsxのページ設定どおり）
//  ・メール   : Outlook COM で MailItem を作り .Display() ＝ 宛先/本文/PDF添付済みの
//              「作成ウィンドウ」を開く。送信ボタンは人が押す（誤送信防止）。
//  ・依存ゼロ : Node標準 child_process + PowerShell + COM のみ（npm追加なし）。
//  ※ 会社PC（Excel + Outlook あり）専用。自宅PC（閲覧モード）では呼ばない。
//  ※ 日本語パス/文字は PowerShell 5.1 のスクリプト文字コードで壊れるため、
//     値は必ずUTF-8一時ファイル経由で渡し、.ps1本体はASCIIのみにする（xls2csv.js と同方針）。
// =====================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
const q = (p) => String(p).replace(/\\/g, '\\\\'); // .ps1内のWindowsパス用エスケープ（TEMP配下=ASCII）

// PowerShell を .ps1（ASCIIのみ）で「非同期」実行する共通ヘルパ。
//  execFile（非ブロッキング）＝Excel/Outlook COM実行中もNodeサーバが他リクエストを捌ける。
//  失敗時は stderr を添えて reject。完了/失敗どちらでも .ps1 は後始末する。
function runPs(script, errLabel) {
  return new Promise((resolve, reject) => {
    if (!isWin) { reject(new Error(errLabel + '：Windows（会社PC）でのみ実行できます。')); return; }
    const psFile = path.join(os.tmpdir(), 'mailq_' + process.pid + '_' + Date.now() + '_' + Math.floor(process.hrtime()[1] % 1e6) + '.ps1');
    try { fs.writeFileSync(psFile, script, 'ascii'); }
    catch (e) { reject(new Error(errLabel + '\n' + e.message)); return; }
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(psFile); } catch (_) {}
        if (err) { reject(new Error(errLabel + '\n' + ((stderr && stderr.toString()) || err.message))); return; }
        resolve();
      });
  });
}

// 見積書 .xlsx を PDF に変換して pdfPath を返す（非同期）。
//  日本語パス回避のため、入出力ともASCIIのTEMPで処理し、最後にNodeで最終パスへコピーする。
async function xlsxToPdf(xlsxPath, pdfPath) {
  if (!fs.existsSync(xlsxPath)) throw new Error('xlsxが見つかりません: ' + xlsxPath);
  if (!pdfPath) pdfPath = xlsxPath.replace(/\.xlsx$/i, '') + '.pdf';

  const tmp = os.tmpdir();
  const tag = 'mailq_pdf_' + process.pid + '_' + Date.now();
  const work = path.join(tmp, tag + '.xlsx');   // ASCIIの作業用xlsx（Open対象）
  const outPdf = path.join(tmp, tag + '.pdf');   // ASCIIの出力PDF（ExportAsFixedFormat先）
  fs.copyFileSync(xlsxPath, work);

  const script =
    "$ErrorActionPreference='Stop'\n" +
    "$work='" + q(work) + "'\n" +
    "$out='" + q(outPdf) + "'\n" +
    "$xl=New-Object -ComObject Excel.Application\n" +
    "$xl.Visible=$false; $xl.DisplayAlerts=$false\n" +
    "try {\n" +
    "  $wb=$xl.Workbooks.Open($work,0,$true)\n" +
    "  $wb.ExportAsFixedFormat(0, $out)\n" +   // 0 = xlTypePDF（ページ設定どおりに出力）
    "  $wb.Close($false)\n" +
    "} finally {\n" +
    "  $xl.Quit()\n" +
    "  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl) | Out-Null\n" +
    "}\n";

  try {
    await runPs(script, 'ExcelでのPDF変換に失敗しました。ExcelがインストールされたWindowsで実行してください。');
    if (!fs.existsSync(outPdf)) throw new Error('PDFが生成されませんでした: ' + outPdf);
    fs.copyFileSync(outPdf, pdfPath); // 日本語名の最終パスへはNodeでコピー（COMに日本語を渡さない）
  } finally {
    for (const f of [work, outPdf]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  if (!fs.existsSync(pdfPath)) throw new Error('PDFが見つかりません: ' + pdfPath);
  return pdfPath;
}

// Outlook で メール作成ウィンドウ（下書き）を開く（非同期）。送信は人が行う（.Display=非モーダル表示）。
//  to/subject/body/attachments（日本語可）はUTF-8一時ファイル経由でPowerShellへ渡す。
async function openOutlookDraft(opt) {
  opt = opt || {};
  const to = String(opt.to || '');
  const subject = String(opt.subject || '');
  const body = String(opt.body || '');
  const atts = (opt.attachments || []).filter(Boolean);
  for (const a of atts) { if (!fs.existsSync(a)) throw new Error('添付ファイルが見つかりません: ' + a); }

  const tmp = os.tmpdir();
  const tag = 'mailq_ol_' + process.pid + '_' + Date.now();
  const fTo = path.join(tmp, tag + '_to.txt');
  const fSub = path.join(tmp, tag + '_sub.txt');
  const fBody = path.join(tmp, tag + '_body.txt');
  const fAtt = path.join(tmp, tag + '_att.txt');
  fs.writeFileSync(fTo, to, 'utf8');
  fs.writeFileSync(fSub, subject, 'utf8');
  fs.writeFileSync(fBody, body, 'utf8');
  fs.writeFileSync(fAtt, atts.join('\n'), 'utf8'); // 1行1パス（日本語名可）

  const rd = (f) => "[System.IO.File]::ReadAllText('" + q(f) + "',[System.Text.Encoding]::UTF8)";
  const script =
    "$ErrorActionPreference='Stop'\n" +
    "$to=" + rd(fTo) + ".Trim()\n" +
    "$sub=" + rd(fSub) + "\n" +
    "$body=" + rd(fBody) + "\n" +
    "$attRaw=" + rd(fAtt) + "\n" +
    "$ol=New-Object -ComObject Outlook.Application\n" +
    "$mail=$ol.CreateItem(0)\n" +           // 0 = olMailItem
    "if($to){ $mail.To=$to }\n" +
    "$mail.Subject=$sub\n" +
    "$mail.Body=$body\n" +
    "foreach($line in ($attRaw -split \"`n\")){ $p=$line.Trim(); if($p){ [void]$mail.Attachments.Add($p) } }\n" +
    "$mail.Display($false)\n";            // 非モーダルで作成ウィンドウを表示（送信は人）

  try {
    await runPs(script, 'Outlookでのメール作成に失敗しました。OutlookがインストールされたWindowsで実行してください（起動しておくと確実です）。');
  } finally {
    for (const f of [fTo, fSub, fBody, fAtt]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

// 見積書xlsx → PDF化 → Outlook下書きを開く（1件ぶん・非同期）。生成したPDFパスを返す。
async function mailQuotePdf(opt) {
  opt = opt || {};
  if (!opt.xlsxPath) throw new Error('xlsxPath が必要です');
  const pdfPath = await xlsxToPdf(opt.xlsxPath, opt.pdfPath);
  await openOutlookDraft({ to: opt.to, subject: opt.subject, body: opt.body, attachments: [pdfPath] });
  return pdfPath;
}

module.exports = { xlsxToPdf, openOutlookDraft, mailQuotePdf };

// CLI（会社PCでの単体検証用）:
//   node src/mailQuote.js <見積書.xlsx> <宛先メール> [件名] [本文]
//   → 同じ場所に PDF を作り、Outlookの作成ウィンドウ（PDF添付済み）を開く。
if (require.main === module) {
  const [xlsxPath, to, subject, body] = process.argv.slice(2);
  if (!xlsxPath) {
    console.log('使い方: node src/mailQuote.js <見積書.xlsx> <宛先メール> [件名] [本文]');
    process.exit(1);
  }
  (async () => {
    try {
      const pdf = await mailQuotePdf({
        xlsxPath,
        to: to || '',
        subject: subject || 'お見積書の送付',
        body: body || 'お世話になっております。\n見積書を添付いたします。ご確認のほどよろしくお願いいたします。',
      });
      console.log('OK: PDF=' + pdf + '\nOutlookの作成ウィンドウを開きました（内容を確認して送信してください）。');
    } catch (e) {
      console.error('失敗: ' + e.message);
      process.exit(1);
    }
  })();
}
