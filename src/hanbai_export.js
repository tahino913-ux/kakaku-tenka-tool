// =====================================================================
//  販売大臣「単価履歴」取込CSVの生成（日野/販売大臣 専用の隔離オプション）
//   ・価格改定の見積を発行し、実施日が到来した分を販売大臣へ取り込み直すためのCSV。
//   ・形式は売上履歴tesuto.csv（11列・Shift_JIS・CRLF・BOMなし）に一致させる：
//       得意先コード, 商品コード, ＩＤ(=1), 履歴日付(年),(月),(日),
//       バラ／ケース区分(=1), 単価(=新販売単価), 原単価(=新仕入単価),
//       消費税区分(SHOHIN.ZEIKBN), 消費税率表№(SHOHIN.ZEIRITU)
//   ・Node標準にSJISエンコーダが無いため、日本語はヘッダー行のみ＝そのSJISバイト列を
//     固定で埋め込み、データ行は数字/カンマ(ASCII)だけで構成して連結する。
//   ※ 他社版(販売大臣でない)では使わない隔離機能。汎用版には載せない。
// =====================================================================

// 売上履歴tesuto.csv のヘッダー行をSJISでそのまま（120バイト）。可読: 得意先コード,商品コード,ＩＤ,履歴日付(年),(月),(日),バラ／ケース区分,単価,原単価,消費税区分,消費税率表№
const HEADER_SJIS = Buffer.from([147,190,136,211,144,230,131,82,129,91,131,104,44,143,164,149,105,131,82,129,91,131,104,44,130,104,130,99,44,151,154,151,240,147,250,149,116,40,148,78,41,44,151,154,151,240,147,250,149,116,40,140,142,41,44,151,154,151,240,147,250,149,116,40,147,250,41,44,131,111,131,137,129,94,131,80,129,91,131,88,139,230,149,170,44,146,80,137,191,44,140,180,146,80,137,191,44,143,193,148,239,144,197,139,230,149,170,44,143,193,148,239,144,197,151,166,149,92,135,130]);
const CRLF = Buffer.from('\r\n', 'ascii');
const ID_FIXED = '1';          // ＩＤ列は必ず 1
const BARACASE_FIXED = '1';    // バラ／ケース区分は必ず 1（バラ）
const DEFAULT_ZEI_KBN = '2';   // 税情報がDBから取れない時の既定（課税）
const DEFAULT_ZEI_RITU = '1';  // 同上（標準税率表）

// ISO日付(YYYY-MM-DD) → {year, month, day}（先頭0なしの数値文字列）。解釈不能なら null。
function splitIsoDate(iso) {
  const m = String(iso == null ? '' : iso).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { year: String(y), month: String(mo), day: String(d) };
}

// CSVセル（数字/コードのみ想定。万一カンマ等が混じってもファイルが壊れないよう最小限エスケープ）
function cell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 整数化（金額の小数誤差をならす）。空/不正は空文字。※数量等の整数列用。
function intStr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n));
}
// 銭（小数2桁）保持。単価/原単価は容器の銭単位なので整数に丸めず見積どおりに出す（78.69→78.69, 79→79, 17.11→17.11）。
//  String(round(n*100)/100) は末尾0・余分な小数点が付かない（仕入原価CSVと整合）。
function senStr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 100) / 100);
}

// 1明細 → 11列の配列。tax = {zeiKbn, zeiRitu}（無ければ既定）。
function toRow(line, tax) {
  const d = splitIsoDate(line.effectiveDate);
  if (!d) return null; // 実施日が読めない行は対象外
  const t = tax || {};
  return [
    line.customerCode,
    line.productCode,
    ID_FIXED,
    d.year, d.month, d.day,
    BARACASE_FIXED,
    senStr(line.newSell),                 // 単価 = 新販売単価（銭・小数保持＝見積どおり）
    (line.newCost != null && Number.isFinite(Number(line.newCost))) ? senStr(line.newCost) : '0', // 原単価 = 新仕入単価（銭・小数保持）
    (t.zeiKbn != null && String(t.zeiKbn) !== '') ? String(t.zeiKbn) : DEFAULT_ZEI_KBN,
    (t.zeiRitu != null && String(t.zeiRitu) !== '') ? String(t.zeiRitu) : DEFAULT_ZEI_RITU,
  ];
}

// lines: [{customerCode, productCode, newSell, newCost, effectiveDate(ISO)}]
// taxMap: { 商品コード: {zeiKbn, zeiRitu} }（DBから引いたもの。無ければ既定）
// 戻り値: { buffer(SJIS), count, skipped }
function buildHanbaiCsv(lines, taxMap) {
  taxMap = taxMap || {};
  const bodyRows = [];
  let skipped = 0;
  for (const line of (lines || [])) {
    const row = toRow(line, taxMap[String(line.productCode)]);
    if (!row) { skipped++; continue; }
    bodyRows.push(row.map(cell).join(','));
  }
  // ヘッダー(SJIS) + データ(ASCII)。末尾にもCRLF（サンプルと同様、行区切りで終端）。
  const bodyBuf = bodyRows.length ? Buffer.from(bodyRows.join('\r\n') + '\r\n', 'latin1') : Buffer.alloc(0);
  const buffer = Buffer.concat([HEADER_SJIS, CRLF, bodyBuf]);
  return { buffer, count: bodyRows.length, skipped };
}

module.exports = { buildHanbaiCsv, splitIsoDate, HEADER_SJIS };
