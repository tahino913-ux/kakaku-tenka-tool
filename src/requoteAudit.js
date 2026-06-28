'use strict';
// =====================================================================
//  🔁 再見積もり要アラート
//   すでに「提出済み(issued)」で得意先に出した単価は、その時点の仕入原価(cost)で
//   利幅を決めている。だがメーカーがあとから値上げすると、提出済みのまま放置すると
//   利幅が消える／逆ザヤ（売価≦新原価）になる。照合エンジンは提出済みをそのまま保持
//   するので、気づく手立てが無いと損したまま売り続けてしまう。
//   ここで「提出時原価 と 最新照合の新仕入」を突き合わせ、再見積もりが要る品を検知する。
//  ・自動では戻さない（人が「🔁 対象に戻す」→ 得意先別で再見積もり＝既存方針どおり）。
//  ・対象は「提出後に原価が上がった品だけ」（提出時原価 < 新原価）。原価が据置/値下げの逆ザヤは
//    “値上げで再見積もり”ではなく元から薄利/単位ミスマッチ等の別問題なので、このアラートでは出さない
//    （提出0.73円 vs 原価178.9円＝ケース単価混入のような誤検知を排除する）。
//  ・判定（提出売価 sell が分かり、かつ 原価が上昇した品のみ）：
//     🔴 逆ザヤ : 売価 ≦ 新原価            （売るほど損・最優先）
//     🟡 利幅薄 : 新利益率 < 閾値（既定10%）＝原価上昇で利幅が痩せた
//   ※ 提出売価が0/不明、提出時原価が0/不明（上昇判定不能）、最新照合にその品が無い＝スキップ（誤検知防止）。
// =====================================================================

const SEP = String.fromCharCode(1); // 品目ステータスの rowKey 区切り（得意先\x01仕入先\x01自社CD）

function num(s) {
  const t = String(s == null ? '' : s).replace(/[,¥￥\s]/g, '');
  if (t === '') return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
// 自社CDの正規化（match.js padSelfCode と同規則・ここに複製＝循環参照回避）。
function padCode(c) {
  const t = String(c == null ? '' : c).trim();
  if (!t) return '';
  return /^\d+$/.test(t) ? t.padStart(6, '0') : t.toLowerCase();
}

// statusMap : 品目ステータス { 得意先: { rowKey: { s, sell, cost, eff, quoteNo, ... } } }
// costByKey : Map（または素オブジェクト） '仕入先|自社CD(pad)' -> 新仕入原価
// opts.marginPct : 利幅薄の閾値%（既定10）
// 戻り値 { issues:[{customer,supplier,code,rowKey,sell,oldCost,newCost,marginPct,severity,costRose,eff,quoteNo}], count, gyaku, thin }
function auditRequote(statusMap, costByKey, opts) {
  const o = opts || {};
  const thr = Number.isFinite(o.marginPct) ? o.marginPct : 10;
  const getCost = (k) => (costByKey instanceof Map ? costByKey.get(k) : (costByKey ? costByKey[k] : undefined));

  const issues = [];
  for (const customer of Object.keys(statusMap || {})) {
    const ent = statusMap[customer];
    if (!ent || typeof ent !== 'object') continue;
    for (const rowKey of Object.keys(ent)) {
      const v = ent[rowKey];
      if (!v || v.s !== 'issued') continue;
      const parts = String(rowKey).split(SEP);
      if (parts.length < 3) continue;
      const supplier = parts[1];
      const code = padCode(parts[2]);
      const newCost = num(getCost(supplier + '|' + code));
      if (!Number.isFinite(newCost) || newCost <= 0) continue; // 最新照合に新原価が無い＝比較不能
      const sell = num(v.sell);
      if (!(sell > 0)) continue;                               // 提出売価が不明＝逆ザヤ判定不能
      const oldCost = num(v.cost);
      const marginPct = Math.round(((sell - newCost) / sell) * 1000) / 10;
      const costRose = Number.isFinite(oldCost) && oldCost > 0 && newCost > oldCost + 0.005;
      if (!costRose) continue;                                 // 提出後に原価が上がった品だけが対象
      let severity = '';
      if (newCost >= sell) severity = 'gyaku';                 // 🔴 逆ザヤ
      else if (marginPct < thr) severity = 'thin';            // 🟡 原価上昇で利幅薄
      if (!severity) continue;
      issues.push({
        customer, supplier, code, rowKey,
        sell, oldCost: Number.isFinite(oldCost) ? oldCost : null, newCost,
        marginPct, severity, costRose,
        eff: String(v.eff || ''), quoteNo: String(v.quoteNo || ''),
      });
    }
  }
  // 逆ザヤを最上位 → 利益率の低い順（戻す優先度が高い順）→ 得意先名。
  const rank = (s) => (s === 'gyaku' ? 0 : 1);
  issues.sort((a, b) => rank(a.severity) - rank(b.severity)
    || a.marginPct - b.marginPct
    || String(a.customer).localeCompare(String(b.customer), 'ja'));
  return { issues, count: issues.length, gyaku: issues.filter((i) => i.severity === 'gyaku').length, thin: issues.filter((i) => i.severity === 'thin').length };
}

// 単体検証（node src/requoteAudit.js）
function selfTest() {
  const K = (c, s, cd) => c + SEP + s + SEP + cd;
  const statusMap = {
    '田中細巾': { [K('田中細巾', 'マレー', '004080')]: { s: 'issued', sell: 88, cost: 68.75, eff: '2026-05-01' } }, // 88売/新82.5原 → 利幅6.25%<10 かつ原価上昇 → thin
    'トモテツ売店': { [K('トモテツ売店', 'マレー', '004080')]: { s: 'issued', sell: 82, cost: 68.75 } },             // 82売≦82.5原 → gyaku
    '健全社': { [K('健全社', 'マレー', '004080')]: { s: 'issued', sell: 120, cost: 68.75 } },                       // 120売/新82.5原 → 利幅31% → 出さない
    '原価据置社': { [K('原価据置社', '大黒工業', '002376')]: { s: 'issued', sell: 440, cost: 360 } },               // 新原価=360で据置（上昇なし）→ 利幅18%でも thin にしない
    '原価下落逆ザヤ社': { [K('原価下落逆ザヤ社', 'マレー', '004080')]: { s: 'issued', sell: 82, cost: 90 } },          // 82≦新82.5で逆ザヤだが原価は90→82.5と下落 → 値上げ起因でない＝出さない
    '提出中社': { [K('提出中社', 'マレー', '004080')]: { s: 'hold', sell: 50 } },                                   // issued でない → 対象外
    '売価不明社': { [K('売価不明社', 'マレー', '004080')]: { s: 'issued', sell: 0, cost: 68.75 } },                 // 売価0 → 判定不能でスキップ
    '照合なし社': { [K('照合なし社', '謎メーカー', '999999')]: { s: 'issued', sell: 50, cost: 30 } },               // 新原価無し → スキップ
  };
  const costByKey = new Map([
    ['マレー|004080', 82.5],
    ['大黒工業|002376', 360],
  ]);
  const r = auditRequote(statusMap, costByKey, { marginPct: 10 });
  const custs = r.issues.map((i) => i.customer);
  const ok = r.count === 2 && r.gyaku === 1 && r.thin === 1
    && custs[0] === 'トモテツ売店'   // 逆ザヤが先頭
    && custs.includes('田中細巾')
    && !custs.includes('健全社') && !custs.includes('原価据置社') && !custs.includes('原価下落逆ザヤ社')
    && !custs.includes('提出中社') && !custs.includes('売価不明社') && !custs.includes('照合なし社');
  if (!ok) { console.error('requoteAudit selfTest FAILED', JSON.stringify(r, null, 2)); process.exit(1); }
  console.log('requoteAudit selfTest OK');
}

if (require.main === module) selfTest();

module.exports = { auditRequote, padCode };
