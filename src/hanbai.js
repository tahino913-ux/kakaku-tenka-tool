// =====================================================================
//  販売実績ローダ（販売大臣の階層CSVをフラットな商品レコードへ）
//  ※ 元データは旧Excel(.XLS=OLE2)。テキストでは読めないため、事前に
//     Excel COM 等でCSV化したものを読む（変換は src/xlsToCsv 側の責務）。
//
//  販売大臣の出力構造:
//    1行目  : ,バラ最新購買暦,バラ最新単価,金額,バラ最新原単価
//    得意先行: 「<得意先CD>␣␣<得意先名>…」, (購買暦=空), , 金額(得意先計),
//    商品行  : 「␣␣<自社CD>␣␣<商品名(埋込メーカー品番/ロット/棚番込)>」,
//              購買暦(日付), バラ最新単価(=現売単価), 金額(=年間金額), バラ最新原単価
//  → 商品行は直前の得意先見出しに属する。同一商品が複数得意先に出る。
// =====================================================================
const fs = require('fs');
const { decodeBuffer, parseCsvText } = require('./csv');
const { nfkc, normName } = require('./textnorm');
const { toNum } = require('./rules');

// CD照合用の正規化：normName は空白を削除するため、埋込メーカー品番が直後の数量と連結し
//  （例「… 170078 50【…」→「17007850…」）、コードの単語境界判定が落ちて CD一致を取りこぼす。
//  コード照合では NFKC＋小文字化のみ行い、区切り（空白）は1個に畳んで“残す”。
//  → 「コード 数量」は空白境界で正しく一致し、「大きい数字に埋もれたコード(25186内の5186)」は従来通り弾ける。
function normForCode(s) {
  return nfkc(String(s == null ? '' : s)).toLowerCase().replace(/\s+/g, ' ').trim();
}

// コア商品名の抽出：ロット記号「※」以降（ロット数量・棚番）を落とす。
//  注記（全角括弧）やサイズ括弧（半角(20)/全角（25））は残す
//  （全角括弧で切るとサイズが全角の商品名 OK袋（25） を壊すため）。
//  残るロット数・棚番の数字は、名前照合側の「数字境界＋同長あいまい一致」で弾く。
function coreName(body) {
  return String(body == null ? '' : body).split('※')[0].trim();
}

// 列見出しから各列のインデックスを求める（並びのゆれに強くする）
function findColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i].map((c) => normName(c));
    const dateIdx = r.findIndex((c) => /購買|日付|暦/.test(c));
    const sellIdx = r.findIndex((c) => /最新単価|販売単価|単価/.test(c) && !/原単価/.test(c));
    const amtIdx = r.findIndex((c) => /金額/.test(c));
    const costIdx = r.findIndex((c) => /原単価|原価/.test(c));
    if (amtIdx !== -1 && (sellIdx !== -1 || dateIdx !== -1)) {
      return { headerRow: i, dateIdx, sellIdx, amtIdx, costIdx };
    }
  }
  // 既定（観測どおりの並び）
  return { headerRow: 0, dateIdx: 1, sellIdx: 2, amtIdx: 3, costIdx: 4 };
}

// 「<CD>␣␣<本文>」を分解。先頭の数字コードと残りの本文を返す
function splitCodeBody(c0) {
  const s = String(c0 == null ? '' : c0).replace(/\r/g, '');
  const m = s.match(/^\s*(\d{3,})\s+([\s\S]*)$/);
  if (m) return { code: m[1], body: m[2].trim() };
  return { code: '', body: s.trim() };
}

// 得意先名の整形：先頭CD除去後、半角スペースで始まる配送メモを落とす
// （社名内は全角スペース。「【メンテナンス】」等の部門表記は残す）
function cleanCustomerName(body) {
  let n = String(body || '').trim();
  const m = n.match(/^([\s\S]*?)[ \t]+([\s\S]*(?:元払|未満|ｹｰｽ|ケース|混載|送料|別途|東北|北\d|個口|前払|着払)[\s\S]*)$/);
  if (m && m[1].trim()) n = m[1].trim();
  return n;
}

// 商品名(本文)から日付パターンを判定（商品行は購買暦が入る）
function looksLikeDate(s) {
  return /\d{1,4}\s*[\/年\-]\s*\d{1,2}/.test(String(s || ''));
}

// 商品名末尾の「仕入先コード(1〜2桁)」を取り出す。
//  販売大臣の自社販売実績では「(朝日ﾋﾟｯｷﾝｸﾞ) 92988 ※50 13」のように
//  末尾に1〜2桁の発注先コードが付くケースがある（13=0013=朝日食品容器）。
//  4桁にパディングして返す（仕入先マスタのキーと揃える）。
function trailingPurchaseCode(name) {
  const s = String(name || '').trim();
  // 末尾の括弧注記を除去（"13（S-2)" → "13"）
  const cleaned = s.replace(/\s*[（(][^）)]*[）)]\s*$/, '');
  const m = cleaned.match(/(?:^|[\s\D])(\d{1,2})\s*$/);
  return m ? m[1].padStart(4, '0') : '';
}

// CSV(文字列 or パス)を読み、フラットな商品レコード配列を返す
function parseHanbai(text) {
  const rows = parseCsvText(text);
  if (!rows.length) return [];
  const { headerRow, dateIdx, sellIdx, amtIdx, costIdx } = findColumns(rows);
  const out = [];
  let cust = { code: '', name: '' };
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const c0 = row[0] != null ? String(row[0]) : '';
    if (c0.trim() === '' && row.every((c) => String(c == null ? '' : c).trim() === '')) continue;

    const dateRaw = dateIdx !== -1 ? String(row[dateIdx] == null ? '' : row[dateIdx]).trim() : '';
    const indented = /^\s/.test(c0); // 商品行は先頭にスペース字下げ
    const isProduct = (dateRaw !== '' && looksLikeDate(dateRaw)) || (indented && /^\s*\d{3,}\s/.test(c0));

    const { code, body } = splitCodeBody(c0);
    if (!isProduct) {
      // 得意先見出し行
      if (code) cust = { code, name: cleanCustomerName(body) };
      continue;
    }
    if (!code) continue; // 商品行だが自社CDが取れない→スキップ
    const currentSell = sellIdx !== -1 ? toNum(row[sellIdx]) : NaN;
    const annualAmount = amtIdx !== -1 ? toNum(row[amtIdx]) : NaN;
    const origCost = costIdx !== -1 ? toNum(row[costIdx]) : NaN; // 原単価（0が多く信頼薄）
    out.push({
      customerCode: cust.code,
      customerName: cust.name,
      productCode: code,
      productName: body,            // 自社CDを除いた本文（埋込品番・ロット・棚番込み）
      currentSell,
      annualAmount,
      origCost,
      lastDate: dateRaw,
      norm: normName(body),         // 全名(埋込メーカー品番を含む)・名前照合の補助
      codeNorm: normForCode(body),  // CD照合用：区切りを残した正規化（コードが数量と連結しない）
      coreNorm: normName(coreName(body)), // 名前照合用：ノイズ除去済みコア名
      purchaseCode: trailingPurchaseCode(body), // 発注先コード(4桁文字列, 例 "0013")
    });
  }
  return out;
}

function loadHanbai(filePath) {
  const buf = fs.readFileSync(filePath);
  return parseHanbai(decodeBuffer(buf));
}

module.exports = { loadHanbai, parseHanbai, cleanCustomerName, splitCodeBody, coreName, trailingPurchaseCode };
