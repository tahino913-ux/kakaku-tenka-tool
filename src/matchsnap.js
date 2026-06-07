// =====================================================================
//  照合の回帰スナップショット（基準の保存／差分チェック）
//  照合エンジン(match.js 等)を変更する前に「今の良好な一致」を基準として保存し、
//  変更＋再照合のあとに「失われた一致・変わった一致・増えた一致」を洗い出す安全網。
//  ※ DB不要。input/ の最新照合結果CSV（仕入先ごと最新1本）だけを読む。
//
//  使い方:
//    node src/matchsnap.js save     … 現在の照合結果を output/match_baseline.json に保存（基準づくり）
//    node src/matchsnap.js check    … 現在の照合結果を基準と比較し、差分を表示
//    node src/matchsnap.js check -v … 差分の明細も全部表示
// =====================================================================
const fs = require('fs');
const path = require('path');

const INPUT_DIR = path.join(__dirname, '..', 'input');
const BASELINE = path.join(__dirname, '..', 'output', 'match_baseline.json');

function parseCsv(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\r') {} else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; } else cur += c; }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
// 仕入先ごとに最新（ファイル名の日時印が最大）の照合結果CSVを選ぶ。
function latestPerSupplier() {
  const files = fs.readdirSync(INPUT_DIR).filter((f) => /_照合結果_\d/.test(f) && f.endsWith('.csv'));
  const by = {};
  for (const f of files) { const m = f.match(/^(.+?)_照合結果_(\d{8}_\d{6})\.csv$/); if (!m) continue; if (!by[m[1]] || m[2] > by[m[1]].st) by[m[1]] = { st: m[2], f }; }
  return by;
}
// ステータス文字列をカテゴリへ正規化（名前一致の%も保持）。
function statusCat(s) {
  if (/CD一致（自社品）/.test(s)) return 'self';
  if (/📌|手動紐付け/.test(s)) return 'link';
  if (/✓ CD一致/.test(s)) return 'cd';
  const m = s.match(/名前一致\((\d+)%\)/); if (m) return 'name' + m[1];
  return s.replace(/\s+/g, '');
}
// 現在の照合結果から「一致ペア」を集める。key=仕入先|得意先|自社CD|メーカーCD、val=ステータス。
function collectPairs() {
  const by = latestPerSupplier();
  const pairs = new Map();
  let dormant = 0;
  for (const sup of Object.keys(by)) {
    const rows = parseCsv(fs.readFileSync(path.join(INPUT_DIR, by[sup].f), 'utf8'));
    const h = rows[0].map((s) => s.replace(/^﻿/, '')); const ci = (n) => h.indexOf(n);
    const iSt = ci('照合'), iMc = ci('メーカー商品CD'), iMk = ci('メーカー商品名'), iC = ci('販売実績商品コード'), iCust = ci('得意先名');
    for (let r = 1; r < rows.length; r++) {
      const st = rows[r][iSt] || '';
      if (/未一致|休眠/.test(st)) { dormant++; continue; }
      const mk = (rows[r][iMc] || '').trim() || ('名:' + (rows[r][iMk] || '').trim());
      const key = [sup, (rows[r][iCust] || '').trim(), (rows[r][iC] || '').trim(), mk].join('|');
      pairs.set(key, statusCat(st));
    }
  }
  return { pairs, dormant };
}

const mode = process.argv[2] || 'check';
const verbose = process.argv.includes('-v');
const { pairs, dormant } = collectPairs();

if (mode === 'save') {
  const obj = { savedAt: new Date().toISOString(), count: pairs.size, dormant, pairs: Object.fromEntries(pairs) };
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(obj, null, 0));
  console.log('✅ 基準を保存しました: ' + BASELINE);
  console.log('   一致ペア ' + pairs.size + ' 件 / 休眠 ' + dormant + ' 件');
} else {
  if (!fs.existsSync(BASELINE)) { console.log('❌ 基準がありません。先に `node src/matchsnap.js save` を実行してください。'); process.exit(1); }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const basePairs = new Map(Object.entries(base.pairs || {}));
  const lost = [], gained = [], changed = [];
  for (const [k, v] of basePairs) { if (!pairs.has(k)) lost.push([k, v]); else if (pairs.get(k) !== v) changed.push([k, v, pairs.get(k)]); }
  for (const [k, v] of pairs) { if (!basePairs.has(k)) gained.push([k, v]); }
  console.log('=== 照合 回帰チェック（基準 ' + (base.savedAt || '') + '） ===');
  console.log('基準: 一致' + base.count + ' / 休眠' + base.dormant + '   今回: 一致' + pairs.size + ' / 休眠' + dormant);
  console.log('🔴 失われた一致(lost): ' + lost.length + '  ← 意図した除去(サイズ取り違え等)以外があれば要注意');
  console.log('🟡 ステータス変化(changed): ' + changed.length);
  console.log('🟢 増えた一致(gained): ' + gained.length);
  const show = (arr, fmt) => (verbose ? arr : arr.slice(0, 15)).forEach(fmt);
  if (lost.length) { console.log('--- lost ' + (verbose ? '(全件)' : '(先頭15)') + ' [仕入先|得意先|自社CD|メーカーCD] = 旧状態 ---'); show(lost, ([k, v]) => console.log('  ' + k + ' = ' + v)); }
  if (changed.length) { console.log('--- changed ' + (verbose ? '(全件)' : '(先頭15)') + ' ---'); show(changed, ([k, a, b]) => console.log('  ' + k + ' : ' + a + ' → ' + b)); }
  if (gained.length && verbose) { console.log('--- gained (全件) ---'); gained.forEach(([k, v]) => console.log('  ' + k + ' = ' + v)); }
  process.exit(lost.length ? 2 : 0);
}
