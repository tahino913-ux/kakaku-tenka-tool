'use strict';
// =====================================================================
//  🔁 再見積もり要アラート
//   すでに「提出済み(issued)」で得意先に出した単価は、その時点の仕入原価(cost)で
//   利幅を決めている。だがメーカーがあとから値上げすると、提出済みのまま放置すると
//   利幅が消える／逆ザヤ（売価≦新原価）になる。照合エンジンは提出済みをそのまま保持
//   するので、気づく手立てが無いと損したまま売り続けてしまう。
//   ここで「提出時原価 と 最新照合の新仕入」を突き合わせ、再見積もりが要る品を検知する。
//  ・自動では戻さない（人が「🔁 対象に戻す」→ 得意先別で再見積もり＝既存方針どおり）。
//  ・対象は「提出後に原価が変わった品」＝提出時原価と新原価が違えば、上がっても下がっても出す
//    （利用者の方針：1円でも変わったら知らせる＝人が再見積もりの要否を判断する）。
//    原価が据置（変化なし）の品は出さない＝これで「提出0.73円 vs 原価178.9円(据置)」の
//    ケース単価混入のような誤検知も自然に除外される。
//  ・色分け（severity・出す/出さないの判定には使わない＝あくまで見分け用）：
//     🔴 逆ザヤ   : 売価 ≦ 新原価               （売るほど損・最優先）
//     🟡 値上利薄 : 値上がり かつ 新利益率 < 閾値（既定10%）
//     🔼 値上がり : 値上がり かつ 利幅は確保
//     🔽 値下がり : 原価が下がった（値下げ余地／利幅増）
//   ※ 提出売価が0/不明、提出時原価が0/不明（変化判定不能）、最新照合にその品が無い＝スキップ。
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
      if (!(Number.isFinite(oldCost) && oldCost > 0)) continue; // 提出時原価が不明＝変化を判定できない
      if (Math.abs(newCost - oldCost) <= 0.005) continue;       // 原価が据置（変化なし）＝出さない
      const marginPct = Math.round(((sell - newCost) / sell) * 1000) / 10;
      const up = newCost > oldCost;                              // 値上がりか
      let severity;
      if (newCost >= sell) severity = 'gyaku';                  // 🔴 逆ザヤ（向き問わず）
      else if (up && marginPct < thr) severity = 'thin';       // 🟡 値上がりで利幅薄
      else if (up) severity = 'up';                            // 🔼 値上がり（利幅確保）
      else severity = 'down';                                  // 🔽 値下がり
      issues.push({
        customer, supplier, code, rowKey,
        sell, oldCost, newCost,
        marginPct, severity, up,
        eff: String(v.eff || ''), quoteNo: String(v.quoteNo || ''),
      });
    }
  }
  // 🔴逆ザヤ → 🟡値上利薄 → 🔼値上がり → 🔽値下がり、各内では利益率の低い順 → 得意先名。
  const rank = (s) => ({ gyaku: 0, thin: 1, up: 2, down: 3 }[s] != null ? { gyaku: 0, thin: 1, up: 2, down: 3 }[s] : 9);
  issues.sort((a, b) => rank(a.severity) - rank(b.severity)
    || a.marginPct - b.marginPct
    || String(a.customer).localeCompare(String(b.customer), 'ja'));
  const cnt = (s) => issues.filter((i) => i.severity === s).length;
  return { issues, count: issues.length, gyaku: cnt('gyaku'), thin: cnt('thin'), up: cnt('up'), down: cnt('down') };
}

// 単体検証（node src/requoteAudit.js）
function selfTest() {
  const K = (c, s, cd) => c + SEP + s + SEP + cd;
  const statusMap = {
    '田中細巾': { [K('田中細巾', 'マレー', '004080')]: { s: 'issued', sell: 88, cost: 68.75, eff: '2026-05-01' } }, // 値上 68.75→82.5・売88・利幅6.25%<10 → thin
    'トモテツ売店': { [K('トモテツ売店', 'マレー', '004080')]: { s: 'issued', sell: 80, cost: 68.75 } },             // 値上・80≦82.5 → gyaku(利幅-3.1%)
    '健全社': { [K('健全社', 'マレー', '004080')]: { s: 'issued', sell: 120, cost: 68.75 } },                       // 値上だが利幅31% → up（今は出す）
    '値下社': { [K('値下社', 'マレー', '004080')]: { s: 'issued', sell: 120, cost: 90 } },                          // 90→82.5 値下がり・利幅31% → down
    '原価据置社': { [K('原価据置社', '大黒工業', '002376')]: { s: 'issued', sell: 440, cost: 360 } },               // 360→360 据置（変化なし）→ 出さない
    '値下逆ザヤ社': { [K('値下逆ザヤ社', 'マレー', '004080')]: { s: 'issued', sell: 82, cost: 90 } },                // 90→82.5 値下がりだが 82≦82.5 → gyaku（向き問わず逆ザヤは出す）
    '提出中社': { [K('提出中社', 'マレー', '004080')]: { s: 'hold', sell: 50 } },                                   // issued でない → 対象外
    '売価不明社': { [K('売価不明社', 'マレー', '004080')]: { s: 'issued', sell: 0, cost: 68.75 } },                 // 売価0 → スキップ
    '原価不明社': { [K('原価不明社', 'マレー', '004080')]: { s: 'issued', sell: 90, cost: 0 } },                    // 提出時原価0 → 変化判定不能でスキップ
    '照合なし社': { [K('照合なし社', '謎メーカー', '999999')]: { s: 'issued', sell: 50, cost: 30 } },               // 新原価無し → スキップ
  };
  const costByKey = new Map([
    ['マレー|004080', 82.5],
    ['大黒工業|002376', 360],
  ]);
  const r = auditRequote(statusMap, costByKey, { marginPct: 10 });
  const custs = r.issues.map((i) => i.customer);
  const ok = r.count === 5 && r.gyaku === 2 && r.thin === 1 && r.up === 1 && r.down === 1
    && custs[0] === 'トモテツ売店' && custs[1] === '値下逆ザヤ社' // 逆ザヤ2件が先頭（利益率の低い順）
    && custs.includes('田中細巾') && custs.includes('健全社') && custs.includes('値下社')
    && !custs.includes('原価据置社') && !custs.includes('提出中社')
    && !custs.includes('売価不明社') && !custs.includes('原価不明社') && !custs.includes('照合なし社');
  if (!ok) { console.error('requoteAudit selfTest FAILED', JSON.stringify(r, null, 2)); process.exit(1); }
  console.log('requoteAudit selfTest OK');
}

if (require.main === module) selfTest();

module.exports = { auditRequote, padCode };
