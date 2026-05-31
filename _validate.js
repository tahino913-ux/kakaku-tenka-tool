// 回帰検証：既存の照合結果(正解データ)を再現できるか確認する。
//   node _validate.js [正解CSV] [販売実績(.XLS/.csv)]
//   販売実績を省略すると config.hanbai.path から自動解決（.XLSは自動でCSV変換）。
const path = require('path');
const { loadCsv } = require('./src/csv');
const { loadHanbai } = require('./src/hanbai');
const { matchAll } = require('./src/match');
const { toNum } = require('./src/rules');
const { resolveHanbaiSource } = require('./src/shogo');
const { xlsToCsv, isXls } = require('./src/xls2csv');
const { getSettings } = require('./src/settings');

const GT = process.argv[2] || 'input/オリカ_照合結果.csv';
let HANBAI = process.argv[3] || resolveHanbaiSource((getSettings().hanbai || {}).path);
if (HANBAI && isXls(HANBAI)) { console.log('販売実績(.XLS)を変換中…'); HANBAI = xlsToCsv(HANBAI); }

function col(rec, names) { for (const n of names) if (rec[n] !== undefined) return rec[n]; return ''; }

const { records } = loadCsv(GT);
// メーカー見積を逆生成（メーカー品番でユニーク化）
const itemsMap = new Map();
for (const r of records) {
  const code = col(r, ['メーカー商品コード', 'メーカー商品CD']);
  const name = col(r, ['メーカー商品名']);
  if (!code && !name) continue;
  const key = code || name;
  if (!itemsMap.has(key)) itemsMap.set(key, {
    supplier: col(r, ['仕入先（メーカー）']) || 'テスト',
    makerCode: code, makerName: name,
    currentCost: toNum(col(r, ['仕入前回単価', '現行仕入単価', '現仕入単価'])),
    newCost: toNum(col(r, ['仕入新単価', '新仕入単価'])),
    switchDate: col(r, ['切替日']),
  });
}
const items = [...itemsMap.values()];

// 得意先コードが正解側に無ければ得意先名でキーにする
const hasCC = records.some((r) => col(r, ['得意先コード']));
const keyCust = (r, isMine) => hasCC
  ? (isMine ? (r.customerCode || '') : (col(r, ['得意先コード']) || ''))
  : (isMine ? (r.customerName || '') : (col(r, ['得意先名']) || ''));

// 正解の一致集合
const gtMatched = new Set();
const gtByKey = new Map();
let gtCount = 0;
for (const r of records) {
  const status = col(r, ['判定', '照合']);
  if (/未一致/.test(status)) continue;
  const pc = col(r, ['販売実績商品コード', '商品コード']);
  if (!pc || pc === '-') continue;
  const k = keyCust(r, false) + '|' + pc;
  gtMatched.add(k);
  gtByKey.set(k, r);
  gtCount++;
}

const hanbai = loadHanbai(HANBAI);
const rows = matchAll(items, hanbai);
const mine = new Set();
const mineByKey = new Map();
const scoreOf = (st) => /CD一致/.test(st) ? 1000 : (Number((String(st).match(/(\d+)%/) || [])[1]) || 0);
for (const r of rows) {
  if (!/^✓/.test(r.status)) continue;
  if (!r.productCode) continue;
  const k = keyCust(r, true) + '|' + r.productCode;
  mine.add(k);
  const cur = mineByKey.get(k);
  if (!cur || scoreOf(r.status) > scoreOf(cur.status)) mineByKey.set(k, r); // 最良スコアを残す
}

const hit = [...gtMatched].filter((k) => mine.has(k));
const missed = [...gtMatched].filter((k) => !mine.has(k));
const extra = [...mine].filter((k) => !gtMatched.has(k));

console.log('=== 検証:', path.basename(GT), '===');
console.log('メーカー品(逆生成):', items.length, ' / 販売実績レコード:', hanbai.length);
console.log('正解の一致行:', gtCount, '(ユニークkey', gtMatched.size, ')');
console.log('再現(hit):', hit.length, ' / 取りこぼし(missed):', missed.length, ' / 余分(extra):', extra.length);

// 商品レベル（得意先を無視＝得意先名の表記ゆれの影響を除く）
const gtProd = new Set([...gtMatched].map((k) => k.split('|')[1]));
const myProd = new Set([...mine].map((k) => k.split('|')[1]));
const pHit = [...gtProd].filter((p) => myProd.has(p));
const pMiss = [...gtProd].filter((p) => !myProd.has(p));
console.log('【商品レベル】正解商品:', gtProd.size, ' 再現:', pHit.length, ' 取りこぼし:', pMiss.length, '→', JSON.stringify(pMiss));

// 余分の判定別ヒストグラム（80%以上=自動見積に乗る=危険 / 80%未満=要確認に回り安全）
const hist = {};
let dangerous = 0;
for (const k of extra) {
  const r = mineByKey.get(k);
  let label = 'CD一致';
  const m = String(r.status).match(/(\d+)%/);
  if (m) { label = m[1] + '%'; if (Number(m[1]) >= 80) dangerous++; }
  else dangerous++; // CD一致は高信頼扱い
  hist[label] = (hist[label] || 0) + 1;
}
console.log('\n-- 余分の判定別内訳 --', JSON.stringify(hist));
console.log('  うち 80%以上(自動見積に乗りうる=要注意):', dangerous, ' / 80%未満(要確認に回り安全):', extra.length - dangerous);

console.log('\n-- 取りこぼし(正解にあるが拾えず) 先頭15 --');
for (const k of missed.slice(0, 15)) {
  const r = gtByKey.get(k);
  console.log('  ', k, '|', col(r, ['メーカー商品コード', 'メーカー商品CD']), col(r, ['メーカー商品名']), '→', col(r, ['販売実績商品名']));
}
console.log('\n-- 余分のうち 80%以上(要注意) 全件: メーカー名 → 販売実績名 --');
for (const k of extra) {
  const r = mineByKey.get(k);
  if (scoreOf(r.status) < 80) continue;
  console.log('  ', r.status, '|', r.makerName, '→', r.productName);
}

// 価格スポットチェック（hitの先頭8件で現売単価・年間金額を比較）
console.log('\n-- 価格スポットチェック(hit先頭8) --');
for (const k of hit.slice(0, 8)) {
  const g = gtByKey.get(k), m = mineByKey.get(k);
  const gSell = toNum(col(g, ['現販売単価', '現売単価'])), gAmt = toNum(col(g, ['年間金額']));
  const okSell = Math.abs(gSell - toNum(m.currentSell)) < 0.5 ? 'OK' : 'DIFF';
  const okAmt = Math.abs(gAmt - toNum(m.annualAmount)) < 1 ? 'OK' : 'DIFF';
  console.log('  ', k, '現売', gSell, 'vs', m.currentSell, okSell, '| 年間', gAmt, 'vs', m.annualAmount, okAmt, '|', m.status);
}
