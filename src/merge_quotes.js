// =====================================================================
//  得意先ごとに 1 枚へ統合した見積書を出力する
//  ・出力済みの「仕入先別」見積書（output/<仕入先>_照合結果_*_見積書_<stamp>/）を
//    読み込み、同じ得意先の明細を 1 ファイルにまとめる。
//  ・価格は再計算しない（既存xlsxの 現行単価/改定単価/実施日 をそのまま採用）
//    → 仕入先別に承認済みの単価とズレない。
//  ・要確認_*.xlsx は対象外（見積_*.xlsx のみマージ）。
//  使い方:
//    node src/merge_quotes.js                       … 最新の仕入先別セットを自動選択
//    node src/merge_quotes.js <folder1> <folder2> … … 対象フォルダを明示
// =====================================================================
const fs = require('fs');
const path = require('path');
const { readXlsxBuffer } = require('./xlsxread');
const { writeQuote } = require('./quoteXlsx');
const { getSettings } = require('./settings');
const { priceRowAnomaly } = require('./anomaly');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');

function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function jpDate() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function sanitizeName(s) {
  return String(s || '得意先不明').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim() || '得意先不明';
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : v; }

// 実施日の正常化:
//   取り込み時の年推定バグで 2027年/過去日(2026-04等) になった日付や、元見積に切替日の
//   無い空欄を、提出時点で妥当な既定日に揃える。正常な改定日(2026-06-01〜12-31)は保持。
//   ※価格には無影響（表示のみ）。根本原因＝取り込みの日本語日付→ISO年推定。
const DEFAULT_EFFECTIVE_DATE = '2026-06-01';
const KEEP_FROM = '2026-06-01';  // この範囲内のISO日付はそのまま保持
const KEEP_TO = '2026-12-31';
function normalizeEffectiveDate(d) {
  const s = String(d == null ? '' : d).trim();
  // ISO日付(YYYY-MM-DD)で保持範囲内ならそのまま、それ以外（空欄/過去日/2027等）は既定日へ
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && s >= KEEP_FROM && s <= KEEP_TO) return s;
  return DEFAULT_EFFECTIVE_DATE;
}

// 最新の「仕入先別 見積書」セットを自動検出（同じ時刻スタンプのフォルダ群）
function latestSupplierFolders() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  const dirs = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /_見積書_\d{8}_\d{4}$/.test(e.name) && !e.name.startsWith('得意先別'));
  if (!dirs.length) return [];
  const byStamp = {};
  for (const e of dirs) {
    const m = e.name.match(/_(\d{8}_\d{4})$/);
    (byStamp[m[1]] = byStamp[m[1]] || []).push(e.name);
  }
  const latest = Object.keys(byStamp).sort().pop();
  return byStamp[latest].map((n) => path.join(OUTPUT_DIR, n));
}

// 仕入先別 見積書 1 枚を読み、得意先名と明細を取り出す
function readQuote(file) {
  const { sheets } = readXlsxBuffer(fs.readFileSync(file));
  const grid = (sheets[0] && sheets[0].grid) || [];
  // 得意先名: 「○○　御中」のセルから
  let customer = '';
  for (const r of grid) {
    const c = r && r[0];
    if (typeof c === 'string' && /御中\s*$/.test(c)) { customer = c.replace(/[\s　]*御中[\s　]*$/, '').trim(); break; }
  }
  // 表ヘッダを「商品名」「改定単価」を含む行として探し、列はヘッダ名から動的に引く。
  //  ※ 見積書レイアウトは旧[No/商品名/現行単価/改定単価/実施日]→新[商品コード/商品名/現行単価/改定単価/実施日/備考]
  //    と変わったため、列位置を決め打ちせずヘッダ名で対応づける（新旧どちらも読める）。
  const findCol = (head, ...names) => head.findIndex((c) => { const s = String(c == null ? '' : c).trim(); return names.some((n) => s === n); });
  let hi = -1, col = null;
  for (let i = 0; i < grid.length; i++) {
    const head = grid[i] || [];
    const cName = findCol(head, '商品名');
    const cNew = findCol(head, '改定単価', '改定後単価');
    if (cName >= 0 && cNew >= 0) {
      hi = i;
      col = {
        code: findCol(head, '商品コード', '自社CD', 'コード'),
        name: cName,
        cur: findCol(head, '現行単価', '現単価'),
        nw: cNew,
        date: findCol(head, '実施日', '切替日'),
        note: findCol(head, '備考'),
      };
      break;
    }
  }
  const items = [];
  if (hi >= 0) {
    for (let i = hi + 1; i < grid.length; i++) {
      const r = grid[i] || [];
      const flat = r.map((c) => String(c == null ? '' : c));
      if (flat.some((c) => c.startsWith('品目数'))) break;
      const name = col.name >= 0 && r[col.name] != null ? String(r[col.name]).trim() : '';
      if (!name) continue;
      items.push({
        productCode: col.code >= 0 ? String(r[col.code] == null ? '' : r[col.code]).trim() : '',
        productName: name,
        currentSell: col.cur >= 0 ? num(r[col.cur]) : '',
        newSell: col.nw >= 0 ? num(r[col.nw]) : '',
        effectiveDate: normalizeEffectiveDate(col.date >= 0 ? r[col.date] : ''),
        note: col.note >= 0 ? String(r[col.note] == null ? '' : r[col.note]).trim() : '',
      });
    }
  }
  return { customer, items };
}

function run(folders) {
  folders = (folders && folders.length) ? folders : latestSupplierFolders();
  if (!folders.length) throw new Error('仕入先別の見積書フォルダが見つかりません（先に sim で見積書を出力してください）');

  // 得意先 → (商品名 → 明細)。挿入順を保つため Map を使用。
  const byCust = new Map();
  const conflicts = [];
  let srcFiles = 0;
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    for (const f of fs.readdirSync(folder)) {
      if (!/^見積_.+\.xlsx$/.test(f)) continue; // 要確認_*.xlsx は除外
      const { customer, items } = readQuote(path.join(folder, f));
      if (!customer || !items.length) continue;
      srcFiles++;
      if (!byCust.has(customer)) byCust.set(customer, { byProd: new Map(), suppliers: new Set() });
      const ent = byCust.get(customer);
      ent.suppliers.add(path.basename(folder).split('_照合結果')[0]);
      for (const it of items) {
        const prev = ent.byProd.get(it.productName);
        if (!prev) { ent.byProd.set(it.productName, it); }
        else if (Number(prev.newSell) !== Number(it.newSell) || Number(prev.currentSell) !== Number(it.currentSell)) {
          conflicts.push({ customer, productName: it.productName, a: prev, b: it });
        }
      }
    }
  }

  const s = getSettings();
  const opt = { company: s.company, quote: s.quote, date: jpDate() };
  const outFolder = path.join(OUTPUT_DIR, `得意先別_見積書_${stamp()}`);
  fs.mkdirSync(outFolder, { recursive: true });
  const ymd = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); })();

  const customers = [...byCust.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  const written = [];
  const review = [];   // 要確認（メーカー側データ異常で見積から外した行）
  let multi = 0, totalItems = 0, idx = 0;
  customers.forEach((customer) => {
    const ent = byCust.get(customer);
    const all = [...ent.byProd.values()].sort((a, b) => String(a.productName).localeCompare(String(b.productName), 'ja'));
    // 価格の異常検知 → 見積から外して要確認へ。
    //  ※ ここで読むのは「仕入先別の段階で承認済み（exportQuotes が ruleType 込みで異常を分離した後）」の
    //    見積書。据置(keep_sell)は 改定単価＝現単価 が正常で、そのまま発行されている。xlsx から ruleType は
    //    復元できないため、② の「値上げなのに同額/値下げ」を再判定すると 据置の正常行を誤って外してしまう。
    //    そこで keep_sell を渡して ② を抑止し、統合段では ①「売単価が無い/0（見積に載せられない）」だけを弾く。
    const rows = [];
    for (const it of all) {
      const reason = priceRowAnomaly(it.currentSell, it.newSell, 'keep_sell');
      if (reason) review.push({ customer, productName: it.productName, currentSell: it.currentSell, newSell: it.newSell, reason });
      else rows.push(it);
    }
    if (!rows.length) return;   // 全行が異常な得意先（自社消費分など）は見積書を作らない
    idx++;
    const quoteNo = ymd + '-' + String(idx).padStart(3, '0');
    const fname = `見積_${sanitizeName(customer)}.xlsx`;
    writeQuote(customer, rows, path.join(outFolder, fname), Object.assign({}, opt, { quoteNo }));
    written.push({ customer, items: rows.length, suppliers: [...ent.suppliers] });
    if (ent.suppliers.size > 1) multi++;
    totalItems += rows.length;
  });

  // 要確認（価格チェック）＋単価の食い違いを CSV に書き出し（統合段で外した分）
  if (review.length || conflicts.length) {
    const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = ['区分,得意先,商品名,現行単価,改定単価,内容'];
    for (const r of review) lines.push(['価格異常', r.customer, r.productName, r.currentSell, r.newSell, r.reason].map(esc).join(','));
    for (const c of conflicts) lines.push(['単価の食い違い', c.customer, c.productName, '', '', `${c.a.currentSell}->${c.a.newSell} と ${c.b.currentSell}->${c.b.newSell}（先に読んだ方を採用）`].map(esc).join(','));
    fs.writeFileSync(path.join(outFolder, '_要確認_価格チェック.csv'), '﻿' + lines.join('\r\n'), 'utf8');
  }

  // 各仕入先の見積書出力(exportQuotes)が作った要確認ファイルを統合フォルダにも集約コピー
  //  （異常は仕入先別の段階で分離済みなので、提出物フォルダ1か所で確認できるように）
  let reviewCopied = 0;
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    // 同一仕入先でも複数の照合結果(_234733/_234735等)があるので、見積書フォルダ名から
    // 「仕入先_照合結果_日時」部分を一意キーにしてコピー先名の衝突(上書き)を防ぐ。
    const key = path.basename(folder).replace(/_見積書_\d{8}_\d{4}$/, '');
    for (const f of fs.readdirSync(folder)) {
      if (/^要確認.*\.xlsx$/.test(f) && !/^~\$/.test(f)) {
        try { fs.copyFileSync(path.join(folder, f), path.join(outFolder, `_要確認_${sanitizeName(key)}.xlsx`)); reviewCopied++; } catch (e) { /* ロック等は無視 */ }
      }
    }
  }

  return { outFolder, folders, srcFiles, customerCount: written.length, multiSupplier: multi, totalItems, conflicts, written, review, reviewCopied };
}

if (require.main === module) {
  const args = process.argv.slice(2).map((a) => (path.isAbsolute(a) ? a : path.join(OUTPUT_DIR, a)));
  const r = run(args);
  console.log('読み込んだ仕入先別フォルダ:');
  for (const f of r.folders) console.log('  - ' + path.basename(f));
  console.log(`元ファイル: ${r.srcFiles} 枚 → 統合後: ${r.customerCount} 得意先（うち複数仕入先=${r.multiSupplier}社）/ 明細合計 ${r.totalItems} 行`);
  console.log('出力先: ' + r.outFolder);
  if (r.review && r.review.length) {
    console.log('');
    console.log(`⚠ 要確認＝メーカー側データが疑わしい行を ${r.review.length} 件、見積書から外しました（_要確認_価格チェック.csv 参照）:`);
    for (const v of r.review.slice(0, 20)) console.log(`   [${v.customer}] ${v.productName} | ${v.currentSell}->${v.newSell} | ${v.reason}`);
    console.log('   → 内容を確認し、正しい単価が分かれば手動で見積書に追加してください。');
    console.log('');
  } else {
    console.log('価格の異常: なし');
  }
  if (r.conflicts.length) {
    console.log(`⚠ 同一商品名で単価が食い違う組み合わせ ${r.conflicts.length} 件（先に読んだ方を採用）:`);
    for (const c of r.conflicts.slice(0, 20)) console.log(`   ${c.customer} / ${c.productName}: ${c.a.currentSell}->${c.a.newSell} vs ${c.b.currentSell}->${c.b.newSell}`);
  } else {
    console.log('単価の食い違い: なし');
  }
}

module.exports = { run, latestSupplierFolders, readQuote };
