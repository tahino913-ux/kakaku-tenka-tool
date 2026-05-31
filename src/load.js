// 照合結果CSVの読み込み＋共通フィールドへの正規化（index.js と server.js で共用）。
const { loadCsv } = require('./csv');
const { buildColumnMap, FIELD_LABELS } = require('./columns');
const { toNum } = require('./rules');

// 照合結果CSVの行を、計算しやすい共通フィールドへ変換
function normalizeRecords(records, headers) {
  const colmap = buildColumnMap(headers);
  const required = ['currentSell', 'currentCost', 'newCost', 'productName'];
  const missing = required.filter((f) => !colmap[f]);
  if (missing.length) {
    throw new Error(
      '必要な列が見つかりません: ' + missing.map((m) => FIELD_LABELS[m]).join(' / ') +
      '\n     検出した列: ' + headers.join(', ')
    );
  }
  return records.map((row) => {
    const rec = {};
    for (const [field, headerKey] of Object.entries(colmap)) rec[field] = row[headerKey];
    for (const f of ['currentSell', 'currentCost', 'newCost', 'annualAmount', 'annualQty']) rec[f] = toNum(rec[f]);
    return rec;
  });
}

// パスを渡すと正規化済みレコードとヘッダを返す
function loadAndNormalize(inputPath) {
  const { records, headers } = loadCsv(inputPath);
  return { recs: normalizeRecords(records, headers), headers };
}

module.exports = { loadAndNormalize, normalizeRecords };
