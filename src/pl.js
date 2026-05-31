// =====================================================================
//  変動損益計算書（損益.csv）の読込
//  プロジェクト直下の「損益.csv」(2列: 項目,金額) を読み、
//  純売上高 / 変動費合計 / 固定費合計 を抽出する。列ラベルのゆれは吸収。
//  金額の単位（円/千円/百万円）は画面側の「単位」で扱うため、ここでは原数値を返す。
// =====================================================================
const fs = require('fs');
const path = require('path');
const { decodeBuffer, parseCsvText } = require('./csv');

const PL_FILE = path.join(__dirname, '..', '損益.csv');

const PL_ALIASES = {
  sales:      ['純売上高', '売上高', '売上', '純売上', '総売上', '売上高合計'],
  variable:   ['変動費合計', '変動費', '変動費計', '変動原価', '変動費用'],
  fixed:      ['固定費合計', '固定費', '固定費計'],
  labor:      ['人件費'],
  otherFixed: ['他の固定費', 'その他の固定費', 'その他固定費', '他固定費'],
  // 参考（クロスチェック用に読むが計算には必須でない）
  contribution: ['限界利益', '貢献利益'],
  operating:    ['営業利益'],
};

// "97,220" / "-1,822" / "△417" / "¥1,000円" / "—" を数値へ
function cleanNum(s) {
  let t = String(s == null ? '' : s).trim();
  t = t.replace(/[△▲]/g, '-').replace(/[¥￥円,，\s]/g, '');
  if (t === '' || /^[-—–ー]+$/.test(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function matchKey(label) {
  const L = String(label || '').replace(/\s/g, '').trim();
  if (!L) return null;
  for (const [k, al] of Object.entries(PL_ALIASES)) if (al.some((a) => L === a)) return k; // 完全一致優先
  for (const [k, al] of Object.entries(PL_ALIASES)) if (al.some((a) => L.includes(a))) return k; // 部分一致
  return null;
}

function loadPL() {
  if (!fs.existsSync(PL_FILE)) return { source: 'none' };
  let rows;
  try { rows = parseCsvText(decodeBuffer(fs.readFileSync(PL_FILE))); }
  catch (e) { return { source: 'error', error: String(e && e.message || e) }; }

  const got = {};
  for (const r of rows) {
    if (!r || !r.length) continue;
    const key = matchKey(r[0]);
    if (!key || got[key] !== undefined) continue;
    let v = cleanNum(r[1]); // 2列目（実績）を優先
    if (!Number.isFinite(v)) { // 空なら以降の最初の数値を採用
      for (let i = 2; i < r.length; i++) { v = cleanNum(r[i]); if (Number.isFinite(v)) break; }
    }
    if (Number.isFinite(v)) got[key] = v;
  }

  // 固定費合計が無ければ 人件費 + 他の固定費 から算出
  let fixed = got.fixed;
  if (!Number.isFinite(fixed) && (Number.isFinite(got.labor) || Number.isFinite(got.otherFixed))) {
    fixed = (got.labor || 0) + (got.otherFixed || 0);
  }

  return {
    source: 'file',
    sales: got.sales, variable: got.variable, fixed,
    labor: got.labor, otherFixed: got.otherFixed,
    operating: got.operating, contribution: got.contribution,
  };
}

module.exports = { loadPL, PL_FILE };
