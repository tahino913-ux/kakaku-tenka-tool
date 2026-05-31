// =====================================================================
//  メーカー見積 .xlsx → maker_quotes/<メーカー>.csv 変換（本体組込のインポータ）
//   ・1ブック複数シート対応（シート名＝メーカー名。中東のような形式に対応）
//   ・見出し行と列(商品名/現単価/新単価/切替日/仕入先)を自動検出
//   ・出力CSVは loadMakerQuote(shogo.js) が読む列名に合わせる
//
//   使い方(CLI):  node src/makerXlsx.js <メーカー見積.xlsx> [出力先=maker_quotes]
//   照合.bat からは maker_quotes/ に置かれた .xlsx を自動で本変換にかける。
// =====================================================================
const fs = require('fs');
const path = require('path');
const { readXlsx } = require('./xlsxread');

const norm = (s) => String(s == null ? '' : s).replace(/[\s　]/g, '').normalize('NFKC');

// 見出し行から列番号を検出（先頭〜15行を走査）
//  ※ 商品CD/品番 列も拾う。検出できると CD一致パスが使えるので100%信頼マッチが可能。
//    得意先CD/仕入先CD は対象外（先頭の語で識別）。
function detectColumns(grid) {
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const head = grid[r].map(norm);
    const idx = { headerRow: r };
    head.forEach((h, i) => {
      if (!h) return;
      if (idx.code == null && /^(商品(CD|コード)|品番|メーカー(商品(CD|コード)|品番))$/i.test(h)) idx.code = i;
      if (idx.name == null && /(商品名|品名)/.test(h) && !/(CD|コード)/i.test(h)) idx.name = i;
      if (idx.cur == null && /現/.test(h) && /(単価|売価|価格|仕入)/.test(h)) idx.cur = i;
      if (idx.nw == null && /(新|改定|改訂)/.test(h) && /(単価|売価|価格|仕入)/.test(h)) idx.nw = i;
      if (idx.date == null && /(切替|実施|適用|改定日|改訂日)/.test(h)) idx.date = i;
      if (idx.sup == null && /(仕入先|メーカー)/.test(h)) idx.sup = i;
    });
    if (idx.name != null && (idx.cur != null || idx.nw != null)) return idx;
  }
  return null;
}

function cleanName(s) {
  return String(s || '').replace(/[▲△▼▽◆◇■□●○★☆※]/g, '').replace(/\s+/g, ' ').trim();
}
// Excelの日付シリアル → YYYY-MM-DD（日付っぽくなければ原文のまま）
function serialToDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !/^\d+(\.\d+)?$/.test(String(v).trim()) || n < 20000 || n > 80000) return String(v || '');
  const d = new Date((n - 25569) * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}
function sanitize(s) {
  return String(s || 'メーカー不明').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim() || 'メーカー不明';
}
function makerFromSheet(name) {
  return name.replace(/^[\s\d.\-_／/]+/, '').normalize('NFKC').trim() || name;
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// .xlsx → maker_quotes CSV(s)。戻り値: [{supplier,file,items} | {sheet,skipped}]
function convert(xlsxPath, outDir) {
  const { sheets } = readXlsx(xlsxPath);
  fs.mkdirSync(outDir, { recursive: true });
  const bySupplier = new Map();
  const summary = [];
  for (const sh of sheets) {
    const idx = detectColumns(sh.grid);
    if (!idx) { summary.push({ sheet: sh.name, skipped: '見出し(商品名・価格)を検出できず' }); continue; }
    const sheetMaker = makerFromSheet(sh.name);
    for (let r = idx.headerRow + 1; r < sh.grid.length; r++) {
      const row = sh.grid[r];
      const name = cleanName(row[idx.name]);
      const cur = idx.cur != null ? (row[idx.cur] || '') : '';
      const nw = idx.nw != null ? (row[idx.nw] || '') : '';
      const code = idx.code != null ? String(row[idx.code] || '').trim() : '';
      if (!name) continue;
      if (String(cur).trim() === '' && String(nw).trim() === '') continue;
      const sup = (idx.sup != null && norm(row[idx.sup])) ? String(row[idx.sup]).trim() : sheetMaker;
      if (!bySupplier.has(sup)) bySupplier.set(sup, []);
      bySupplier.get(sup).push({
        メーカー商品CD: code, 商品名: name, 現単価: String(cur).trim(), 新単価: String(nw).trim(),
        切替日: idx.date != null ? serialToDate(row[idx.date]) : '',
      });
    }
  }
  for (const [sup, rows] of bySupplier) {
    const lines = ['仕入先,メーカー商品CD,商品名,現単価,新単価,切替日'];
    for (const r of rows) lines.push([sup, r.メーカー商品CD, r.商品名, r.現単価, r.新単価, r.切替日].map(csvCell).join(','));
    const out = path.join(outDir, sanitize(sup) + '.csv');
    fs.writeFileSync(out, '﻿' + lines.join('\r\n'));
    summary.push({ supplier: sup, file: path.basename(out), items: rows.length });
  }
  return summary;
}

if (require.main === module) {
  const ROOT = path.join(__dirname, '..');
  const arg = process.argv[2];
  if (!arg) {
    console.error('使い方: node src/makerXlsx.js <メーカー見積.xlsx> [出力先フォルダ=maker_quotes]');
    process.exit(1);
  }
  const file = path.isAbsolute(arg) ? arg : path.join(ROOT, arg);
  const outDir = process.argv[3] ? (path.isAbsolute(process.argv[3]) ? process.argv[3] : path.join(ROOT, process.argv[3])) : path.join(ROOT, 'maker_quotes');
  try {
    const s = convert(file, outDir);
    for (const r of s) {
      if (r.skipped) console.log('（スキップ）シート「' + r.sheet + '」: ' + r.skipped);
      else console.log('✓ ' + r.supplier + ' → maker_quotes/' + r.file + '（' + r.items + ' 品）');
    }
    console.log('\n完了。照合.bat（または node src/shogo.js）で照合できます。');
  } catch (e) {
    console.error('✗ ' + (e && e.message || e));
    process.exit(1);
  }
}

module.exports = { convert, detectColumns, serialToDate };
