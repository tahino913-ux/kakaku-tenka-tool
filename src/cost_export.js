// =====================================================================
//  仕入先単価（新原価）更新CSV の生成（日野/販売大臣 専用の隔離オプション）
//   ・価格改定の実施日が到来した商品の「新しい仕入原価」を基幹システム(販売大臣)へ
//     取り込み直すためのCSV。メーカー見積×販売実績の照合結果から作る。
//   ・2列だけ：見出し「商品コード,新原価」＋データ行（Shift_JIS・CRLF・BOMなし）。
//       商品コード = 自社商品コード(SHOHIN.CODE。単価履歴CSVの商品コード列と同じ)
//       新原価     = メーカー見積の新仕入単価(newCost。自社上乗せ%は含まない＝実際に払う仕入額)
//   ・商品ごとに1件（得意先に依らずコストは同じ）。同一商品は実施日が新しい方を採用。
//   ・Node標準にSJISエンコーダが無いため、日本語の見出しはSJISバイト列を固定で埋め込み、
//     データ行は数字/カンマ(ASCII)だけで構成して連結する（単価履歴CSVと同じ方式）。
//   ※ 他社版(販売大臣でない基幹システム)では使わない隔離機能。汎用版には載せない。
// =====================================================================

// 見出し "商品コード,新原価" を Shift_JIS でそのまま（検証済み: TextDecoder('shift_jis') で復号一致）。
const HEADER_SJIS = Buffer.from([143, 164, 149, 105, 131, 82, 129, 91, 131, 104, 44, 144, 86, 140, 180, 137, 191]);
const CRLF = Buffer.from('\r\n', 'ascii');

// CSVセル（数字/コードのみ想定。万一カンマ等が混じってもファイルが壊れないよう最小限エスケープ）
function cell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 金額を「小数は保持し、無駄な末尾0は落とす」文字列に（例 42.3→"42.3" / 42.0→"42" / 12.90→"12.9"）。
//  コストは小数を含む（メーカー見積の新仕入単価）ため整数に丸めず精度を保つ。
function numStr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  // 浮動小数の誤差をならしてから不要な0を除去（最大4桁＝販売大臣の内部精度に合わせる）
  let s = n.toFixed(4);
  s = s.replace(/\.?0+$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

// lines: [{productCode, newCost}]
// 戻り値: { buffer(SJIS), count, skipped }
function buildCostCsv(lines) {
  const bodyRows = [];
  let skipped = 0;
  for (const line of (lines || [])) {
    const code = String(line && line.productCode == null ? '' : line.productCode).trim();
    const cost = numStr(line && line.newCost);
    if (!code || cost === '' || !(Number(line.newCost) > 0)) { skipped++; continue; } // コード無し/原価0は対象外
    bodyRows.push([cell(code), cell(cost)].join(','));
  }
  // 見出し(SJIS) + データ(ASCII)。末尾にもCRLF（単価履歴CSVと同様、行区切りで終端）。
  const bodyBuf = bodyRows.length ? Buffer.from(bodyRows.join('\r\n') + '\r\n', 'latin1') : Buffer.alloc(0);
  const buffer = Buffer.concat([HEADER_SJIS, CRLF, bodyBuf]);
  return { buffer, count: bodyRows.length, skipped };
}

module.exports = { buildCostCsv, numStr, HEADER_SJIS };
