// =====================================================================
//  価格の異常検知（共通）
//  sim（calcAll）・見積書出力（exportQuotes）・得意先別統合（merge_quotes）が
//  すべてこの判定を使う。メーカー側データの誤りを「自動補正せず」検知して
//  人に知らせる（＝要確認に逃がす）ための単一の真実。
// =====================================================================

// 1行の価格を見て、異常があれば理由文字列、無ければ '' を返す。
//   ① 売単価が無い/0      … 社内消費分・データ欠落（見積書に載せられない）
//   ② 値上げなのに改定単価が下がる/同じ … メーカー見積の食い違い（例: 同一品番に新単価2種）
function priceRowAnomaly(currentSell, newSell, ruleType, selfMade, currentCost, newCost) {
  const cur = Number(currentSell), nw = Number(newSell);
  if (!(cur > 0) || !(nw > 0)) return '売単価が無い/0（社内消費・データ欠落の可能性）';
  // 据置(keep_sell)は「改定単価＝現単価」が正常仕様なので ② は判定しない。
  //  （これを判定すると 据置選択時に全行が要確認になり一覧が0件になる）
  // manual（得意先ページで売価を手入力）は利用者が意図的に決めた固定価格なので ② は判定しない
  //  （手入力で値下げ等をしても要確認に落とさない＝発行から除外しない）。①(0/欠落)は引き続き検知。
  // selfMade（自社製造＝メーカーコード9000）は原価0で値上げは利用者が決める（掛率/手入力）。
  //  メーカー見積の食い違いという概念が無いので ② は判定しない（同額でも要確認に落とさない）。①は検知。
  if (ruleType === 'keep_sell' || ruleType === 'manual' || selfMade) return '';
  // ③ 現仕入(currentCost)が「0/マイナス」なのに、現仕入を基準に値上げするルールで新仕入>0 ＝ 値上げ幅の根拠が無い。
  //   add_increase/sell_cost_rate/keep_margin_rate は現仕入を差し引き・割り戻しに使うため、現仕入0だと
  //   「現売価 ＋ 新仕入を丸ごと」上乗せした過大な売価になり、しかも nw>cur なので②をすり抜ける。
  //   markup/keep_sell/target_margin_rate は現仕入を使わないので対象外。現仕入NaN(欠落)は newSell が NaN になり①で捕捉済み。
  const costBasedRule = (ruleType == null || ruleType === '' || ruleType === 'add_increase' || ruleType === 'sell_cost_rate' || ruleType === 'keep_margin_rate');
  if (costBasedRule) {
    const cc0 = Number(currentCost), nc0 = Number(newCost);
    if (Number.isFinite(cc0) && cc0 <= 0 && Number.isFinite(nc0) && nc0 > 0) {
      return '現仕入単価が0で値上げ根拠が不明（新仕入を丸ごと上乗せの恐れ＝要確認）';
    }
    // ④ 現仕入が「年(1990〜2031)」の形に化け、かつ現売価を上回る＝販売大臣のCSV列ズレ破損の指紋。
    //   この壊れた原価を基準に値上げすると売価が暴落し、しかも②は「原価が下がった＝正常な値下げ」と
    //   誤認して見逃す（上方破損の盲点）。現売価より小さい年値（例 ﾊｲﾗｯﾌﾟ 2000<売2800）は実価格の
    //   可能性があるので対象外＝誤検知を出さない。cur は①で >0 を保証済み。
    if (Number.isFinite(cc0) && cc0 >= 1990 && cc0 <= 2031 && cc0 > cur) {
      return '現仕入単価が「年」に見える異常値（CSV列ズレ破損の疑い＝要確認）';
    }
  }
  if (nw <= cur) {
    // ② は「メーカーが仕入を値上げしたのに改定後売価が同額/値下げ」を疑うもの。前提＝“仕入が実際に上がった”。
    //  仕入が据置/値下げ(=値上げでない)なら売価据置は正常（現売価×仕入改定%=sell_cost_rate・掛率×1 等で起こる）。
    //  ＝仕入の現/新が分かるときは、仕入が上がっていなければ ② を出さない（正常行を要確認に落とさない）。
    //  仕入が不明（cost未指定）のときは従来どおり ② を判定する（安全側）。
    const cc = Number(currentCost), nc = Number(newCost);
    const costKnown = Number.isFinite(cc) && Number.isFinite(nc);
    if (costKnown && !(nc > cc + 0.005)) return '';
    return '値上げなのに改定単価が下がる/同じ（メーカー見積の食い違いの可能性）';
  }
  return '';
}

module.exports = { priceRowAnomaly };
