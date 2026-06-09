// 照合結果CSVの読み込み＋共通フィールドへの正規化（index.js と server.js で共用）。
const { loadCsv } = require('./csv');
const { buildColumnMap, FIELD_LABELS } = require('./columns');
const { toNum, sen } = require('./rules');

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
    // 単価は容器の銭(小数2桁)が基準。現売価も銭丸めし、DB由来の /10000 端数(8.900000001 等)が
    //  markup(現売価×掛率)や粗利率に伝播しないようにする（現仕入/新仕入と揃える）。
    if (Number.isFinite(rec.currentSell)) rec.currentSell = sen(rec.currentSell);
    if (Number.isFinite(rec.currentCost)) rec.currentCost = sen(rec.currentCost);
    if (Number.isFinite(rec.newCost)) rec.newCost = sen(rec.newCost);
    return rec;
  });
}

// パスを渡すと正規化済みレコードとヘッダを返す
function loadAndNormalize(inputPath) {
  const { records, headers } = loadCsv(inputPath);
  return { recs: normalizeRecords(records, headers), headers };
}

module.exports = { loadAndNormalize, normalizeRecords };
