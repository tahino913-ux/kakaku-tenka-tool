// 照合結果CSVの「列名のゆれ」を吸収し、共通フィールド名へ対応づける。
// （例: 現仕入単価 は朝日では「現行仕入単価」、オリカでは「仕入前回単価」）

const FIELD_ALIASES = {
  matchStatus:   ['照合', '判定'],
  makerSupplier: ['仕入先（メーカー）', '仕入先(メーカー)', '仕入先'],
  switchDate:    ['切替日', '適用日', '切り替え日'],
  makerCode:     ['メーカー商品CD', 'メーカー商品コード', 'メーカーCD'],
  makerName:     ['メーカー商品名'],
  customerCode:  ['得意先コード'],
  customerName:  ['得意先名'],
  productCode:   ['販売実績商品コード', '商品コード'],
  productName:   ['販売実績商品名', '商品名'],
  masterName:    ['商品名(マスタ)', '商品名（マスタ）'],
  currentSell:   ['現販売単価', '現行販売単価', '現売単価'],
  currentCost:   ['現行仕入単価', '仕入前回単価', '現仕入単価', '仕入前単価'],
  newCost:       ['新仕入単価', '仕入新単価'],
  annualAmount:  ['年間金額'],
  annualQty:     ['年間数量', '年間販売数量', '販売数量', '数量', '年間販売量', '販売量'],
  lastDate:      ['最終売上日', '最終売上', '最終出荷日'],
};

// 人が読むためのフィールド日本語名（エラーメッセージ用）
const FIELD_LABELS = {
  matchStatus: '照合', makerSupplier: '仕入先(メーカー)', switchDate: '切替日',
  makerCode: 'メーカー商品コード', makerName: 'メーカー商品名',
  customerCode: '得意先コード', customerName: '得意先名',
  productCode: '商品コード', productName: '商品名',
  currentSell: '現販売単価', currentCost: '現仕入単価', newCost: '新仕入単価',
  annualAmount: '年間金額', annualQty: '年間数量',
};

// headers: CSVの実ヘッダ配列。戻り値: { field: 実ヘッダ名 }
function buildColumnMap(headers) {
  const norm = (s) => String(s == null ? '' : s).replace(/^﻿/, '').normalize('NFKC').trim();
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const normalized = aliases.map((a) => a.normalize('NFKC'));
    const idx = headers.findIndex((h) => normalized.includes(norm(h)));
    if (idx !== -1) map[field] = headers[idx];
  }
  return map;
}

module.exports = { FIELD_ALIASES, FIELD_LABELS, buildColumnMap };
