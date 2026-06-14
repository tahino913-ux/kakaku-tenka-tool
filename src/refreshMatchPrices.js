// 照合結果CSVの「新仕入単価」を maker_quotes 統合後の正しい値へ揃える（再照合なし・DB不要）。
//  中央化学→朝日 寄せで古い1回目価格が残った行を一括修正する用途。
//  使い方: node src/refreshMatchPrices.js [仕入先名]
//    省略時＝input/ の各仕入先 最新1本すべて。
const fs = require('fs');
const path = require('path');
const { loadCsv } = require('./csv');
const { sen } = require('./rules');
const { mergeMakerFiles, makerProdKey } = require('./shogo');
const { getSettings } = require('./settings');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(ROOT, 'input');
const MAKER_DIR = path.join(ROOT, 'maker_quotes');

function listLatestInput(supplierFilter) {
  const latest = new Map();
  for (const f of fs.readdirSync(INPUT)) {
    if (!f.endsWith('.csv')) continue;
    const m = f.match(/^(.+?)_照合結果_(\d{8})_(\d{4,6})\.csv$/i);
    if (!m) continue;
    const sup = m[1];
    if (supplierFilter && sup !== supplierFilter) continue;
    const stamp = m[2] + '_' + m[3].padEnd(6, '0');
    let mtime = 0;
    try { mtime = fs.statSync(path.join(INPUT, f)).mtimeMs; } catch (_) {}
    const cur = latest.get(sup);
    if (!cur || cur.stamp < stamp || (cur.stamp === stamp && cur.mtime < mtime)) {
      latest.set(sup, { file: f, stamp, mtime });
    }
  }
  return [...latest.entries()].map(([sup, x]) => ({ supplier: sup, file: x.file }));
}

function priceMapForSupplier(merged, supplier) {
  const m = new Map();
  for (const it of merged.get(supplier) || []) {
    m.set(makerProdKey(it), { newCost: sen(it.newCost), currentCost: sen(it.currentCost) });
  }
  return m;
}

function refreshFile(filePath, priceMap) {
  const { records, headers } = loadCsv(filePath);
  let changed = 0;
  for (const r of records) {
    const st = r['照合'] || '';
    if (!/^[✓📌]/.test(st)) continue;
    const code = r['メーカー商品CD'] || '';
    const name = r['メーカー商品名'] || '';
    const norm = (s) => String(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const key = code ? ('CD:' + norm(code)) : ('NM:' + norm(name));
    const exp = priceMap.get(key);
    if (!exp) continue;
    const cur = sen(Number(r['現行仕入単価']));
    const got = sen(Number(r['新仕入単価']));
    const nc = exp.newCost;
    if (!Number.isFinite(nc) || Math.abs(got - nc) < 0.001) continue;
    const cc = Number.isFinite(cur) ? cur : exp.currentCost;
    const inc = Number.isFinite(cc) && Number.isFinite(nc) ? nc - cc : '';
    const rate = (Number.isFinite(inc) && cc > 0) ? Math.round((inc / cc) * 1000) / 10 : '';
    r['新仕入単価'] = String(nc);
    if (inc !== '') r['仕入値上額'] = String(Math.round(inc * 100) / 100);
    if (rate !== '') r['仕入値上率(%)'] = String(rate);
    changed++;
  }
  if (!changed) return 0;
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push(headers.map((h) => {
      const s = (r[h] === null || r[h] === undefined) ? '' : String(r[h]);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  return changed;
}

function main() {
  const filter = process.argv[2] || '';
  const s = getSettings();
  const makerFiles = fs.readdirSync(MAKER_DIR).filter((f) => /\.csv$/i.test(f)).map((f) => path.join(MAKER_DIR, f));
  const merged = mergeMakerFiles(makerFiles, s.makerChannel || {});
  const targets = listLatestInput(filter || null);
  if (!targets.length) {
    console.log('対象の照合結果CSVがありません。');
    return;
  }
  let total = 0;
  for (const { supplier, file } of targets) {
    const priceMap = priceMapForSupplier(merged, supplier);
    const n = refreshFile(path.join(INPUT, file), priceMap);
    console.log(supplier + ': ' + file + ' → ' + n + ' 行を更新');
    total += n;
  }
  console.log('合計 ' + total + ' 行を更新しました。sim.bat 再起動後に画面を確認してください。');
}

if (require.main === module) main();
module.exports = { refreshFile, listLatestInput, priceMapForSupplier };
