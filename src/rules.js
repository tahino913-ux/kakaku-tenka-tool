// 価格転嫁の計算エンジン。1明細(rec)に対して転嫁後の販売単価などを計算する。
const { normName } = require('./textnorm');

// 文字列を数値へ。"1,234" / "390.0" / "nan" / "" を安全に処理。
function toNum(v) {
  if (v === null || v === undefined) return NaN;
  // 全角数字・全角カンマ等を半角化(NFKC)してから、桁区切り・通貨記号・空白を除去。
  //  例: "１２３４"→1234 / "1，234"→1234 / "¥1,234"→1234 / "390 円"→390
  //  ※CSV取込（販売実績・メーカー見積・照合結果）はこの関数を通るので、全角入力の取りこぼし(NaN)を防ぐ。
  const s = String(v).normalize('NFKC').replace(/[,\s¥￥円]/g, '').trim();
  if (s === '' || s.toLowerCase() === 'nan') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// 容器仕入単価の銭丸め（小数2桁）。Excel/計算値の 2.549999999 等を 2.55 に揃える。
function sen(v) {
  const n = (typeof v === 'number') ? v : toNum(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

// 銭丸めを「表示・CSV用文字列」に（2.55 が 2.549999999… と出る浮動小数表示を防ぐ）。
function senStr(v) {
  const n = sen(v);
  if (!Number.isFinite(n)) return String(v == null ? '' : v);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

// 端数処理
function applyRounding(value, rounding) {
  if (!Number.isFinite(value)) return value;
  const unit = rounding && rounding.unit ? rounding.unit : 0.01;
  const mode = (rounding && rounding.mode) || 'round';
  const q = value / unit;
  let r;
  if (mode === 'ceil') r = Math.ceil(q);
  else if (mode === 'floor') r = Math.floor(q);
  else r = Math.round(q);
  return Math.round(r * unit * 1e6) / 1e6; // 浮動小数の誤差対策
}

// 個別ルールの条件判定
function matchOverride(rec, when) {
  if (!when) return false;
  if (when.customer && rec.customerName !== when.customer) return false;
  if (when.customerCode && String(rec.customerCode) !== String(when.customerCode)) return false;
  if (when.product && !normName(rec.productName).includes(normName(when.product))) return false;
  if (when.productCodePrefix && !normName(rec.productCode).startsWith(normName(when.productCodePrefix))) return false;
  if (when.maker && !normName(rec.makerSupplier).includes(normName(when.maker))) return false;
  return true;
}

function pickRule(rec, config) {
  for (const ov of (config.overrides || [])) {
    if (matchOverride(rec, ov.when)) return ov.rule;
  }
  return config.default || { type: 'add_increase' };
}

// ルールに従って転嫁後の販売単価（丸め前）を求める
function computeNewSell(rec, rule) {
  const { currentSell, currentCost, newCost } = rec;
  switch (rule.type) {
    case 'keep_sell':
      return currentSell;
    case 'markup':
      return currentSell * (rule.factor || 1); // 現売価 × 掛率
    case 'sell_cost_rate': // 現売価 × 仕入改定%（仕入の値上げ率をそのまま売価に乗せる）
      // newSell = currentSell × (newCost / currentCost)。現仕入が無い/0、または新仕入が無い/0なら
      //  率が出せない（0なら売価0円になる）ので絶対額の上乗せにフォールバック（target_margin_rate と同作法）。
      if (currentCost > 0 && newCost > 0 && Number.isFinite(currentSell)) return currentSell * (newCost / currentCost);
      return currentSell + (newCost - currentCost);
    case 'keep_margin_rate': {
      if (!(currentSell > 0)) return currentSell + (newCost - currentCost);
      const marginRate = (currentSell - currentCost) / currentSell;
      const denom = 1 - marginRate;
      if (denom <= 0) return currentSell + (newCost - currentCost);
      return newCost / denom;
    }
    case 'target_margin_rate': {
      // 目標粗利率（%）から新売価を逆算：newSell = newCost ÷ (1 − 率/100)。
      //  例: 新原価7円・目標粗利率30% → 7 ÷ 0.7 = 10円。率は rule.factor（掛率と同じ枠）に載る。
      //  率が不正（0未満/100以上）や新原価が無い/0なら、値上げ分の上乗せにフォールバック（安全側）。
      const rate = Number(rule.factor);
      if (Number.isFinite(rate) && rate >= 0 && rate < 100 && Number.isFinite(newCost) && newCost > 0) {
        return newCost / (1 - rate / 100);
      }
      return currentSell + (newCost - currentCost);
    }
    case 'add_increase':
    default:
      return currentSell + (newCost - currentCost);
  }
}

// 1明細を計算して、表示・出力用の項目を付与した新オブジェクトを返す
function calcRow(rec, config) {
  const rule = pickRule(rec, config);
  let raw = computeNewSell(rec, rule);
  // 自社コスト(労務費・最低賃金)上乗せ：据え置き以外の行に、最終単価へ +rate% を掛ける
  const uplift = (config.selfCostUplift && Number(config.selfCostUplift.rate)) || 0;
  if (uplift && rule.type !== 'keep_sell' && Number.isFinite(raw)) raw = raw * (1 + uplift / 100);
  const newSell = applyRounding(raw, config.rounding);

  const { currentSell, currentCost, newCost } = rec;
  const fin = Number.isFinite;

  const costIncrease = (fin(newCost) && fin(currentCost)) ? newCost - currentCost : NaN;
  const costIncreaseRate = (fin(costIncrease) && currentCost > 0) ? (costIncrease / currentCost) * 100 : NaN;
  const currentMarginRate = (fin(currentSell) && currentSell > 0 && fin(currentCost)) ? ((currentSell - currentCost) / currentSell) * 100 : NaN;
  const newMarginRate = (fin(newSell) && newSell > 0 && fin(newCost)) ? ((newSell - newCost) / newSell) * 100 : NaN;
  const sellIncrease = (fin(newSell) && fin(currentSell)) ? newSell - currentSell : NaN;

  // 年間数量: 実績(年間数量列)があればそれを使い、無ければ「年間金額 ÷ 現販売単価」で推定
  const hasActualQty = fin(rec.annualQty) && rec.annualQty > 0;
  let qty = hasActualQty
    ? rec.annualQty
    : ((fin(rec.annualAmount) && currentSell > 0) ? rec.annualAmount / currentSell : NaN);
  // 推定値の暴発ガード：現売単価が極小（スケーリング誤り等）だと数量が天文学的になり損益を壊す。
  //  実在しえない桁（10億/年 超）は「推定不能」に倒す＝現実的なデータは一切影響を受けない。
  const QTY_SANITY_MAX = 1e9;
  if (!hasActualQty && fin(qty) && qty > QTY_SANITY_MAX) qty = NaN;
  const qtySource = hasActualQty ? 'actual' : (fin(qty) ? 'estimated' : 'none');

  // 年間影響額: 仕入増 = 仕入値上額×数量 / 増収 = 値上げ額×数量
  const annualCostImpact = (fin(qty) && fin(costIncrease)) ? qty * costIncrease : NaN;
  const annualSellImpact = (fin(qty) && fin(sellIncrease)) ? qty * sellIncrease : NaN;
  // 年間売上(現/転嫁後) = 単価×数量（全社評価・加重平均粗利の按分に使用）
  const annualSellCurrent = (fin(qty) && fin(currentSell)) ? qty * currentSell : NaN;
  const annualSellNew = (fin(qty) && fin(newSell)) ? qty * newSell : NaN;

  return {
    ...rec,
    ruleType: rule.type,
    costIncrease, costIncreaseRate,
    currentMarginRate,
    newSell, sellIncrease, newMarginRate,
    qty, qtySource, estQty: qty,
    annualCostImpact, annualSellImpact,
    annualSellCurrent, annualSellNew,
  };
}

module.exports = { calcRow, applyRounding, toNum, sen, senStr, pickRule };
