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
const { isNoiseRow } = require('./noiserow');

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
// 切替日(実施日)を「どの形式でも ISO(YYYY-MM-DD)」に揃える。serialToDate より広く対応。
//  対応: Excelシリアル / 2026-07-01 / 2026/7/1 / 2026年7月1日 / 7月1日～ / 7/1（年なしは当年）/ 全角。
//  ※ 年なしは「当年」に固定（過ぎた月日でも翌年に飛ばさない）＝取り込みの年推定バグの根治。
//  解釈できない文字列（「未定」等）はそのまま返す。
function normDate(v) {
  let s = String(v == null ? '' : v).normalize('NFKC').trim();
  if (s === '') return '';
  const p2 = (n) => String(n).padStart(2, '0');
  if (/^\d{4,6}(\.\d+)?$/.test(s)) { const n = Number(s); if (n >= 20000 && n <= 80000) { const iso = serialToDate(n); if (/^\d{4}-/.test(iso)) return iso; } }
  let m = s.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/); // 年つき
  if (m) { const mo = Number(m[2]), da = Number(m[3]); if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return m[1] + '-' + p2(mo) + '-' + p2(da); }
  m = s.match(/(\d{1,2})\D{1,3}(\d{1,2})/); // 年なし → 当年
  if (m) { const mo = Number(m[1]), da = Number(m[2]); if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return new Date().getFullYear() + '-' + p2(mo) + '-' + p2(da); }
  return s;
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
      // 運賃・返品案内・再掲見出しなどの非商品行を取り込まない（商品らしい数値価格が無い注記/見出し）。
      if (isNoiseRow({ name, makerCode: code, currentCost: cur, newCost: nw })) continue;
      if (String(cur).trim() === '' && String(nw).trim() === '') continue;
      const sup = (idx.sup != null && norm(row[idx.sup])) ? String(row[idx.sup]).trim() : sheetMaker;
      if (!bySupplier.has(sup)) bySupplier.set(sup, []);
      bySupplier.get(sup).push({
        メーカー商品CD: code, 商品名: name, 現単価: String(cur).trim(), 新単価: String(nw).trim(),
        切替日: idx.date != null ? normDate(row[idx.date]) : '',
      });
    }
  }
  for (const [sup, rows] of bySupplier) {
    const out = path.join(outDir, sanitize(sup) + '.csv');
    // 商品単位 upsert：既存 <仕入先>.csv があれば読み込み、商品キー（品番優先・無ければ商品名）で
    //  「今回の取り込みを後勝ち」で統合する。これで同一仕入先の異なる部分xlsxを別々に取り込んでも
    //  前回の商品が消えない（上書きによる無音のデータ消失を防止）。paste-import＋mergeMakerFiles と同じ
    //  「蓄積＋後勝ち」モデルに揃える（xlsx取込だけが上書きで消す唯一の例外だった＝是正）。
    const merged = new Map();
    for (const r of readExistingMakerRows(out)) merged.set(prodKey(r.メーカー商品CD, r.商品名), r);
    for (const r of rows) merged.set(prodKey(r.メーカー商品CD, r.商品名), r); // 今回が後勝ち
    const final = [...merged.values()];
    const lines = ['仕入先,メーカー商品CD,商品名,現単価,新単価,切替日'];
    for (const r of final) lines.push([sup, r.メーカー商品CD, r.商品名, r.現単価, r.新単価, r.切替日].map(csvCell).join(','));
    fs.writeFileSync(out, '﻿' + lines.join('\r\n'));
    summary.push({ supplier: sup, file: path.basename(out), items: final.length });
  }
  return summary;
}

// 商品の同一判定キー（shogo.makerProdKey と同じ規則：品番があれば品番、無ければ商品名を NFKC＋空白除去＋小文字で）。
//  ※ shogo は makerXlsx を require するため、循環参照を避けてここに同等実装を置く。
function prodKey(code, name) {
  const n = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  return (code && String(code).trim()) ? ('CD:' + n(code)) : ('NM:' + n(name));
}
// 既存 maker_quotes/<仕入先>.csv を行配列で読む（無ければ空）。makerXlsx が書いた列名を読む。
function readExistingMakerRows(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const { loadCsv } = require('./csv');
    const { records } = loadCsv(file);
    return records.map((r) => ({
      メーカー商品CD: r['メーカー商品CD'] || r['メーカー品番'] || r['品番'] || '',
      商品名: r['商品名'] || r['メーカー商品名'] || '',
      現単価: r['現単価'] || r['現価格'] || '',
      新単価: r['新単価'] || r['新価格'] || '',
      切替日: r['切替日'] || r['実施日'] || r['適用日'] || '',
    })).filter((r) => String(r.商品名).trim() !== '' || String(r.メーカー商品CD).trim() !== '');
  } catch (_) { return []; }
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

module.exports = { convert, detectColumns, serialToDate, normDate };
