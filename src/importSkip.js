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

module.exports = { getImportSkips, lookupImportSkip, updateImportSkips };
