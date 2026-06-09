// =====================================================================
//  メーカー見積取込：前回「取込対象外」にした行の記憶（仕入先ごと・settings.makers に保存）
// =====================================================================
const { getMakers, saveMakerProfile } = require('./settings');
const { makerProdKey } = require('./shogo');

const MAX_SKIPS = 250;

function getImportSkips(supplier) {
  const sup = String(supplier || '').trim();
  if (!sup) return [];
  const arr = ((getMakers() || {})[sup] || {}).importSkips;
  return Array.isArray(arr) ? arr : [];
}

function lookupImportSkip(supplier, row) {
  const sup = String(supplier || '').trim();
  if (!sup) return null;
  const key = makerProdKey({ makerCode: row.makerCode, makerName: row.makerName });
  if (!key) return null;
  return getImportSkips(sup).find((x) => x.key === key) || null;
}

// 保存時：取り込んだ行は記録から削除、チェック OFF の行は記録に追加（上書き更新）。
function updateImportSkips(supplier, includedItems, skippedItems) {
  const sup = String(supplier || '').trim();
  if (!sup) return [];
  const map = new Map(getImportSkips(sup).map((x) => [x.key, x]));
  for (const it of Array.isArray(includedItems) ? includedItems : []) {
    const mc = String(it.makerCode || '').trim();
    const mn = String(it.makerName || '').trim();
    if (!mc && !mn) continue;
    map.delete(makerProdKey({ makerCode: mc, makerName: mn }));
  }
  const at = new Date().toISOString();
  for (const it of Array.isArray(skippedItems) ? skippedItems : []) {
    const mc = String(it.makerCode || '').trim();
    const mn = String(it.makerName || '').trim();
    if (!mc && !mn) continue;
    const key = makerProdKey({ makerCode: mc, makerName: mn });
    const prev = map.get(key);
    map.set(key, {
      key,
      makerCode: mc,
      makerName: mn,
      reason: String(it.reason || (prev && prev.reason) || '取込対象外').slice(0, 120),
      at,
      times: (prev && prev.times) ? prev.times + 1 : 1,
    });
  }
  const merged = [...map.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, MAX_SKIPS);
  saveMakerProfile(sup, { importSkips: merged });
  return merged;
}

// 1件の記録を解除（次回の自動除外を止める）
function removeImportSkip(supplier, key) {
  const sup = String(supplier || '').trim();
  const k = String(key || '').trim();
  if (!sup || !k) return getImportSkips(sup);
  const merged = getImportSkips(sup).filter((x) => x.key !== k);
  saveMakerProfile(sup, { importSkips: merged });
  return merged;
}

// 単体検証（settings.json は触らない＝キー生成の整合のみ）
function selfTest() {
  const kCd = makerProdKey({ makerCode: '  AbC12  ', makerName: '無視される' });
  const kNm = makerProdKey({ makerCode: '', makerName: '返品　案内' });
  if (kCd !== 'CD:abc12' || kNm !== 'NM:返品案内') {
    console.error('importSkip selfTest FAILED keys', { kCd, kNm });
    process.exit(1);
  }
  // updateImportSkips のマージロジック（メモリ上のみ）
  const map = new Map([['NM:旧', { key: 'NM:旧', makerName: '旧', times: 2, at: '2020-01-01', reason: 'x' }]]);
  map.delete(makerProdKey({ makerCode: '', makerName: '旧' }));
  const at = '2026-06-09T00:00:00.000Z';
  const key = makerProdKey({ makerCode: '', makerName: '新規除外' });
  map.set(key, { key, makerName: '新規除外', reason: '手動', at, times: 1 });
  const merged = [...map.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (merged.length !== 1 || merged[0].makerName !== '新規除外') {
    console.error('importSkip selfTest FAILED merge', merged);
    process.exit(1);
  }
  console.log('importSkip selfTest OK');
}

if (require.main === module) selfTest();

module.exports = { getImportSkips, lookupImportSkip, updateImportSkips, removeImportSkip, selfTest };
