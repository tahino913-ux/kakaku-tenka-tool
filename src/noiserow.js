// =====================================================================
//  メーカー見積の「非商品行」判定（取り込み・照合の入口で使う共通フィルタ）
//  運賃/送料/返品などの注記文、再掲された見出し行(品番/現行価格 等)、価格列に
//  見出しテキストが入った行、名前もコードも無い行を「商品でない」と判定して除外する。
//  ※ 数値の価格を持つ行は“商品”とみなす（商品名に注記語を含む「送料込みセット」等を誤除外しない）。
//  ※ コードだけの行（GL06 等の品番）は“商品”として残す（CD一致で拾うため）。
//  これにより、ハウスホールドジャパン見積の「返品手数料…/品番(再掲見出し)/次回御見積迄」のような
//  非商品行が“メーカー商品”として取り込まれ、すべて休眠としてカウントされる問題を解消する。
// =====================================================================

// 商品名が「見出し語そのもの」なら再掲ヘッダ＝非商品。
const HEADER_RE = /^(品番|コード|商品コード|商品名|品名|メーカー(名|品番|商品名)?|規格|現単価|新単価|現行(価格|単価)?|新(価格|単価)|改定(価格|単価)?|単価|金額|切替日|実施日|備考|数量|No|NO|＃)$/;
// 価格の無い行のうち、これらの注記語を含む商品名は非商品（運賃・送料・返品案内など）。
const NOTE_RE = /(運賃|送料|元払|着払|手数料|返品|納品書|指定(場所|倉庫)|別途|未満|以上|ご負担|御見積|次回|地域|エリア|お客様|振込|実費|合計|小計|消費税|備考欄|休暇|祝日|年末年始|夏季休業|冬季休業|お盆|ゴールデンウィーク|ＧＷ|GW)/;

// 文字列が「数値の価格」か（カンマ・空白・¥・円 を除いて数値ならtrue）。
function isNumericPrice(v) {
  const s = String(v == null ? '' : v).replace(/[,，\s¥円]/g, '');
  return s !== '' && Number.isFinite(Number(s));
}

// row: { name, makerCode, currentCost, newCost } ※ price は元の文字列でも数値でも可。
//  true=非商品（取り込み/照合から除外すべき）。
function isNoiseRow(row) {
  const name = String(row && row.name != null ? row.name : '').trim();
  const code = String(row && row.makerCode != null ? row.makerCode : '').trim();
  if (!name && !code) return true;                  // 名前もコードも無い
  if (name && HEADER_RE.test(name)) return true;    // 名前が見出し語そのもの（再掲ヘッダ）
  if (isNumericPrice(row && row.newCost) || isNumericPrice(row && row.currentCost)) return false; // 数値価格あり＝商品
  // ここから先は「商品らしい数値価格が無い」行
  if (name && NOTE_RE.test(name)) return true;      // 注記文（運賃・返品案内 等）
  const cp = String(row && row.currentCost != null ? row.currentCost : '');
  const np = String(row && row.newCost != null ? row.newCost : '');
  if (/価格|単価/.test(cp) || /価格|単価/.test(np)) return true; // 価格列が見出しテキスト（現行価格 等）
  return false;
}

// UI用：非商品かどうかと理由（取込画面のチェックボックス案内に使う）。
function describeNoiseRow(row) {
  const name = String(row && row.name != null ? row.name : '').trim();
  const code = String(row && row.makerCode != null ? row.makerCode : '').trim();
  if (!name && !code) return { noise: true, reason: '名前も品番も空の行' };
  if (name && HEADER_RE.test(name)) return { noise: true, reason: '見出しの再掲行（品番・商品名など）' };
  if (isNumericPrice(row && row.newCost) || isNumericPrice(row && row.currentCost)) return { noise: false, reason: '' };
  if (name && NOTE_RE.test(name)) return { noise: true, reason: '運賃・返品案内・休暇告知などの注記文' };
  const cp = String(row && row.currentCost != null ? row.currentCost : '');
  const np = String(row && row.newCost != null ? row.newCost : '');
  if (/価格|単価/.test(cp) || /価格|単価/.test(np)) return { noise: true, reason: '価格列が見出しテキスト（現行価格 等）' };
  return { noise: false, reason: '' };
}

module.exports = { isNoiseRow, isNumericPrice, describeNoiseRow };
