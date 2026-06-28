// =====================================================================
//  商品マスタCSVの「仕入原価 異常品」抽出ツール（ツール本体とは独立の診断用）
//   背景: 販売大臣でCSV受入レイアウトを取り違え、列ズレで「年(2006/2007)」等が
//         仕入原価欄に入り込んだ品を洗い出すため。
//
//   使い方:  node src/costAudit.js <商品マスタ.csv>
//     省略時は project直下/ input/ の「商品マスタ/商品/master」を含むCSVを自動探索。
//   出力:  画面に一覧 ＋ output/原価異常_一覧.csv（Shift_JISではなくUTF-8 BOM）
//
//   判定（いずれかに該当で異常候補）:
//     A) 原価が「年」に見える       … 1990〜2031 の整数
//     B) 原価 > 売価               … 売価列が取れた場合のみ（逆ザヤ）
//     C) 原価が極端に大きい         … 既定 >2000 円（容器/箸の通常原価から外れ）
//   ※ A は今回の列ズレの確実な指紋。B/C は取りこぼし拾い（誤検知もあるので人が確認）。
// =====================================================================
const fs = require('fs');
const path = require('path');
const { loadCsv } = require('./csv');

const ROOT = path.join(__dirname, '..');

function findDefault() {
  const dirs = [ROOT, path.join(ROOT, 'input')];
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d); } catch (_) { continue; }
    const hit = files.find((f) => /\.csv$/i.test(f) && /(商品マスタ|商品マスター|商品一覧|商品|master|shohin)/i.test(f) && !/照合結果/.test(f));
    if (hit) return path.join(d, hit);
  }
  return null;
}

// ヘッダ名から列を推定（販売大臣の出力ゆれを吸収）
function pickCol(headers, patterns) {
  const norm = (s) => String(s == null ? '' : s).replace(/^﻿/, '').normalize('NFKC').replace(/\s+/g, '').trim();
  for (const p of patterns) {
    const idx = headers.findIndex((h) => p.test(norm(h)));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

function num(v) {
  const s = String(v == null ? '' : v).normalize('NFKC').replace(/[,\s¥￥円]/g, '').trim();
  if (s === '') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function audit(file, opts) {
  opts = opts || {};
  const bigThreshold = Number.isFinite(opts.big) ? opts.big : 2000;
  const { records, headers } = loadCsv(file);
  const codeCol = pickCol(headers, [/^商品コード$/, /商品コード/, /^コード$/, /^CD$/i]);
  const nameCol = pickCol(headers, [/^商品名$/, /商品名/, /品名/]);
  const costCol = pickCol(headers, [/仕入原価/, /原単価/, /仕入単価/, /原価/, /仕入価格/]);
  const sellCol = pickCol(headers, [/売価/, /販売単価/, /^単価$/, /バラ単価/, /上代/]);

  if (!codeCol || !costCol) {
    console.log('列の自動判定に失敗しました。ヘッダ一覧:');
    console.log('  ' + headers.join(' | '));
    console.log('→ 商品コード列・仕入原価列の名前を教えてください（手で指定して再実行します）。');
    return null;
  }
  console.log('判定に使う列: コード=「' + codeCol + '」 原価=「' + costCol + '」 売価=「' + (sellCol || '(なし)') + '」 名前=「' + (nameCol || '(なし)') + '」\n');

  const rows = [];
  for (const r of records) {
    const code = String(r[codeCol] == null ? '' : r[codeCol]).trim();
    if (!code) continue;
    const cost = num(r[costCol]);
    if (!Number.isFinite(cost)) continue;
    const sell = sellCol ? num(r[sellCol]) : NaN;
    const name = nameCol ? String(r[nameCol] || '').trim() : '';
    const flags = [];
    const isYear = Number.isInteger(cost) && cost >= 1990 && cost <= 2031;
    if (isYear) flags.push('年に見える(列ズレ濃厚)');
    if (Number.isFinite(sell) && sell > 0 && cost > sell) flags.push('原価>売価');
    if (cost > bigThreshold) flags.push('原価が大(>' + bigThreshold + ')');
    if (flags.length) rows.push({ code, name, cost, sell, flags: flags.join(' / '), isYear });
  }
  // 年に見える品を最優先で上に
  rows.sort((a, b) => (b.isYear - a.isYear) || (b.cost - a.cost));

  console.log('=== 異常候補 ' + rows.length + ' 件 ===');
  console.log('商品コード | 仕入原価 | 売価 | 商品名 | 理由');
  for (const r of rows) {
    console.log([r.code, r.cost, Number.isFinite(r.sell) ? r.sell : '', r.name.slice(0, 28), r.flags].join(' | '));
  }
  const yearN = rows.filter((r) => r.isYear).length;
  console.log('\n内訳: 「年に見える(列ズレ確定的)」=' + yearN + ' 件 / その他=' + (rows.length - yearN) + ' 件');

  // 出力CSV（UTF-8 BOM・Excelで開ける）
  try {
    const outDir = path.join(ROOT, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, '原価異常_一覧.csv');
    const esc = (s) => { const t = String(s == null ? '' : s); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const lines = ['商品コード,商品名,仕入原価,売価,理由'];
    for (const r of rows) lines.push([r.code, r.name, r.cost, Number.isFinite(r.sell) ? r.sell : '', r.flags].map(esc).join(','));
    fs.writeFileSync(out, '﻿' + lines.join('\r\n'), 'utf8');
    console.log('\n一覧を書き出しました: output/原価異常_一覧.csv');
  } catch (e) { console.log('（一覧の書き出しに失敗: ' + (e && e.message || e) + '）'); }
  return rows;
}

if (require.main === module) {
  const arg = process.argv[2];
  const file = arg ? (path.isAbsolute(arg) ? arg : path.join(ROOT, arg)) : findDefault();
  if (!file || !fs.existsSync(file)) {
    console.log('商品マスタCSVが見つかりません。');
    console.log('使い方: node src/costAudit.js <商品マスタ.csv>');
    console.log('（または商品マスタCSVを プロジェクト直下 か input/ に置いて再実行）');
    process.exit(0);
  }
  console.log('対象ファイル: ' + file + '\n');
  audit(file);
}

module.exports = { audit };
