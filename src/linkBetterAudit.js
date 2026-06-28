'use strict';
// 手動紐付けより自動照合の方が確実な候補があるかを検出（match.js 依存・productLink とは分離して循環参照を避ける）。

const { codeCandidates, codeHit, nameScoreInfo, padSelfCode, sizeMismatch, colorMismatch } = require('./match');
const { linkNamesEqual, findLinkTargetsInQuote, isExcludeLink } = require('./productLink');

function scoreMakerAgainstRec(maker, rec) {
  const codeNorm = String(rec.codeNorm || rec.norm || '').toLowerCase();
  const coreNorm = String(rec.coreNorm || rec.norm || '').toLowerCase();
  const mc = String(maker.makerCode || '').trim();
  if (mc && codeNorm) {
    const cands = codeCandidates(mc);
    if (cands.length && codeHit(cands, codeNorm)) {
      return { score: 1000, kind: 'cd', label: 'CD一致' };
    }
  }
  const info = nameScoreInfo(maker.makerName || '', coreNorm);
  return { score: info.score, kind: 'name', label: '名前一致(' + info.score + '%)' };
}

function bestScoreForMaker(maker, hanbaiPool) {
  let best = { score: 0, kind: 'none', label: '', makerName: '', makerCode: '' };
  for (const rec of hanbaiPool) {
    const s = scoreMakerAgainstRec(maker, rec);
    if (s.score > best.score) best = s;
  }
  return best;
}

function makersMatchingLink(makers, linkedName) {
  const names = new Set((makers || []).map((m) => m.makerName).filter(Boolean));
  const targets = findLinkTargetsInQuote(names, linkedName);
  const hit = new Set(targets);
  for (const m of makers || []) {
    if (linkNamesEqual(m.makerName, linkedName)) hit.add(m.makerName);
  }
  return (makers || []).filter((m) => hit.has(m.makerName));
}

// productLinks × メーカー見積 × 販売実績 で「手動より確実な候補」を検出。
// kind: better_cd（品番CD一致が優先）| better_name（名前一致%が明確に高い）
function auditBetterManualLinks(productLinks, makerItems, hanbaiRecords) {
  const bySup = new Map();
  for (const it of makerItems || []) {
    const sup = String(it.supplier || '').trim();
    if (!sup) continue;
    if (!bySup.has(sup)) bySup.set(sup, []);
    bySup.get(sup).push(it);
  }
  const hanbaiByCode = new Map();
  for (const r of hanbaiRecords || []) {
    const code = padSelfCode(r.productCode);
    if (!code) continue;
    if (!hanbaiByCode.has(code)) hanbaiByCode.set(code, []);
    hanbaiByCode.get(code).push(r);
  }
  const issues = [];
  const NAME_THRESH = 80;
  const NAME_MARGIN = 5;
  for (const [supplier, codes] of Object.entries(productLinks || {})) {
    const makers = bySup.get(supplier) || [];
    if (!makers.length) continue;
    for (const [rawCode, linked] of Object.entries(codes || {})) {
      const linkedName = String(linked || '').trim();
      if (!linkedName) continue;
      if (isExcludeLink(linkedName)) continue; // 🚫除外/💤休眠＝意図的に照合から外した品＝「より確実な候補」提案の対象外
      const code = padSelfCode(rawCode);
      const pool = hanbaiByCode.get(code);
      if (!pool || !pool.length) continue;

      const linkedMakers = makersMatchingLink(makers, linkedName);
      let linkedBest = { score: 0, kind: 'none', label: '', makerName: linkedName, makerCode: '' };
      const linkedPool = linkedMakers.length
        ? linkedMakers
        : [{ makerName: linkedName, makerCode: '' }];
      for (const m of linkedPool) {
        const s = bestScoreForMaker(m, pool);
        if (s.score > linkedBest.score) {
          linkedBest = { ...s, makerName: m.makerName || linkedName, makerCode: m.makerCode || '' };
        }
      }

      let bestOther = { score: 0, kind: 'none', label: '', makerName: '', makerCode: '' };
      for (const m of makers) {
        if (linkedMakers.some((lm) => linkNamesEqual(lm.makerName, m.makerName))) continue;
        const s = bestScoreForMaker(m, pool);
        if (s.score > bestOther.score) {
          bestOther = { ...s, makerName: m.makerName, makerCode: m.makerCode || '' };
        }
      }
      if (bestOther.score <= linkedBest.score) continue;

      const isCdBetter = bestOther.kind === 'cd' && bestOther.score >= 1000 && linkedBest.kind !== 'cd';
      const isNameBetter = bestOther.kind === 'name' && bestOther.score >= NAME_THRESH
        && linkedBest.kind !== 'cd'
        && (bestOther.score >= linkedBest.score + NAME_MARGIN || linkedBest.score < NAME_THRESH);
      if (!isCdBetter && !isNameBetter) continue;

      issues.push({
        supplier,
        code: rawCode,
        linked: linkedName,
        kind: isCdBetter ? 'better_cd' : 'better_name',
        linkedScore: linkedBest.score,
        linkedKind: linkedBest.kind,
        betterMaker: bestOther.makerName,
        betterMakerCode: bestOther.makerCode,
        betterScore: bestOther.score,
        betterKind: bestOther.kind,
        hint: bestOther.makerName,
      });
    }
  }
  issues.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja')
    || String(a.code).localeCompare(String(b.code)));
  return {
    issues,
    count: issues.length,
    betterCdCount: issues.filter((i) => i.kind === 'better_cd').length,
    betterNameCount: issues.filter((i) => i.kind === 'better_name').length,
  };
}

// 手動紐付けの「勘違い」検出：紐付け先メーカー名が“自社品そのもの”と大きく食い違う組を洗い出す。
//  背景（CLAUDE.md 002172）：002172『ﾌﾚｯｼｭﾒｲﾄ不織布』を 📌 で『パープルパワーパッド』に紐付け＝別商品。
//   従来の audit（表記ゆれ/孤立/別品の方が良い）は「紐付け先が実在のメーカー名」かつ「別に良い候補が無い」と
//   素通りしてしまう。ここは “メーカー見積を一切見ず” 自社品名 vs 紐付け先名 だけで妥当性を測る。
//  signals: low_name（名前の重なりが極端に低い）/ size_mismatch / color_mismatch / price_gap（原価が大きく乖離）。
//  ＝あくまで「人が見直すべき候補」を挙げるだけ（自動解除はしない）。
// 表記を詰める（NFKC＋空白・記号除去・小文字）＝含包含/bigram比較用。
function normCompact(s) {
  return String(s || '').normalize('NFKC')
    .replace(/[\s　・,，.。\-_/|()（）\[\]【】「」『』※]/g, '').toLowerCase();
}
// 文字bigram の Dice係数（0〜1）。詰めた文字列同士の“見た目の近さ”を測る。
function bigramDice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } if (s.length === 1) g.set(s, 1); return g; };
  const A = grams(a); const B = grams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const [k, v] of B) { nb += v; if (A.has(k)) inter += Math.min(v, A.get(k)); }
  return (na + nb) ? (2 * inter) / (na + nb) : 0;
}
// 名前から「コードらしい語」（英字+数字 or 3桁以上の数字）をハイフン除去で取り出す。
function codeTokensCompact(s) {
  // ハイフン/記号を先に除いてから英数字の塊を取る＝「LG-11」を分断せず "lg11" として拾う。
  const flat = String(s || '').normalize('NFKC').toLowerCase().replace(/[-\s　()（）\[\]【】「」『』.,/№#]/g, '');
  const m = flat.match(/[a-z0-9]+/g) || [];
  const out = [];
  for (const c of m) {
    // 英字+数字の品番（lg11 等）か、3桁以上の数字＝強いコード。"25"(サイズ)は弱いので除外。
    if ((/[a-z]/.test(c) && /\d/.test(c) && c.length >= 3) || /\d{3,}/.test(c)) out.push(c);
  }
  return out;
}
// 名前が「ほぼ別物」か（誤アラーム抑制を最優先）。同一商品の詰め表記/コード共有は suspect にしない。
//  戻り値 { suspect:bool, score(0-100) }。
function nameLooksDifferent(linkedName, selfDisp, selfCore, threshold) {
  const a = normCompact(linkedName);
  const bDisp = normCompact(selfDisp);
  const bCore = normCompact(selfCore);
  if (!a) return { suspect: false, score: 100 };
  // ① 含包含：紐付け先名が自社名（表示/コア）に丸ごと入る＝詰め表記の同一品 → 別物ではない。
  if (bDisp.includes(a) || bCore.includes(a)) return { suspect: false, score: 100 };
  if (bCore.length >= 4 && a.includes(bCore)) return { suspect: false, score: 100 };
  // ② コード共有：LG-11 等の品番が両方に出る → 同一品 → 別物ではない。
  const aCodes = codeTokensCompact(linkedName);
  if (aCodes.length && aCodes.some((c) => bDisp.includes(c) || bCore.includes(c))) return { suspect: false, score: 100 };
  // ③ 見た目の近さ（bigram Dice）。低いほど別物。
  const dice = Math.max(bigramDice(a, bDisp), bigramDice(a, bCore));
  const score = Math.round(dice * 100);
  return { suspect: dice < threshold, score };
}

function auditSuspectManualLinks(productLinks, makerItems, hanbaiRecords, opts) {
  const o = opts || {};
  // bigram類似がこれ未満＝ほぼ別語（例:不織布↔パワーパッド=0）。略称/漢字違い(タレビン↔タレ壜=0.13等)で
  //  正しい紐付けを誤検出しないよう、あえて極小に絞る＝「名前がほぼ完全に無関係」のときだけ拾う。
  const NAME_DICE = Number.isFinite(o.nameDice) ? o.nameDice : 0.08;
  const PRICE_RATIO = Number.isFinite(o.priceRatio) ? o.priceRatio : 3;     // 原価が3倍以上ズレ
  const hanbaiByCode = new Map();
  for (const r of hanbaiRecords || []) {
    const code = padSelfCode(r.productCode);
    if (!code) continue;
    if (!hanbaiByCode.has(code)) hanbaiByCode.set(code, []);
    hanbaiByCode.get(code).push(r);
  }
  // 紐付け先名 → 代表メーカー原価（改定前）を引くための索引（同名は最初の1件）。
  const makerCostByName = new Map();
  for (const it of makerItems || []) {
    const nm = String(it.makerName || '').trim();
    if (nm && !makerCostByName.has(nm)) makerCostByName.set(nm, Number(it.currentCost));
  }
  const issues = [];
  for (const [supplier, codes] of Object.entries(productLinks || {})) {
    for (const [rawCode, linked] of Object.entries(codes || {})) {
      const linkedName = String(linked || '').trim();
      if (!linkedName) continue;
      if (isExcludeLink(linkedName)) continue; // 🚫除外/💤休眠＝意図的に外した品＝「勘違いの疑い」判定の対象外
      const pool = hanbaiByCode.get(padSelfCode(rawCode));
      if (!pool || !pool.length) continue; // 自社品が販売実績に無い＝orphan は別audit が扱う
      // 自社品の代表（マスタ名優先・無ければ販売実績名）。名前スコアは coreNorm（正規化済）で計算。
      const rep = pool[0];
      const selfDisp = String(rep.masterName || rep.productName || '').trim();
      const selfNorm = String(rep.coreNorm || rep.norm || '').toLowerCase();
      if (!selfNorm) continue;
      const reasons = [];
      // ① 名前がほぼ別物か（含包含・コード共有で“同一品の詰め表記”は除外＝誤アラーム抑制）。
      const nd = nameLooksDifferent(linkedName, selfDisp, selfNorm, NAME_DICE);
      if (nd.suspect) reasons.push({ k: 'low_name', v: nd.score });
      // ② サイズ違い（S↔L 等）・③ 色違い（黒↔白 等）＝明示があり共有ゼロなら別商品。
      if (sizeMismatch(linkedName, selfDisp)) reasons.push({ k: 'size_mismatch' });
      if (colorMismatch(linkedName, selfDisp)) reasons.push({ k: 'color_mismatch' });
      // ④ 原価の乖離：自社の現行原価 と 紐付け先メーカーの改定前原価 が桁違い（両方>0のときだけ）。
      const selfCost = Number(rep.currentCost);
      const makerCost = makerCostByName.has(linkedName) ? makerCostByName.get(linkedName) : NaN;
      if (Number.isFinite(selfCost) && selfCost > 0 && Number.isFinite(makerCost) && makerCost > 0) {
        const ratio = Math.max(selfCost, makerCost) / Math.min(selfCost, makerCost);
        if (ratio >= PRICE_RATIO) reasons.push({ k: 'price_gap', v: Math.round(ratio * 10) / 10, self: selfCost, maker: makerCost });
      }
      if (!reasons.length) continue;
      issues.push({
        supplier,
        code: rawCode,
        linked: linkedName,
        kind: 'suspect',
        selfName: selfDisp,
        nameScore: nd.score,
        reasons,
      });
    }
  }
  issues.sort((a, b) => (a.nameScore - b.nameScore)
    || String(a.supplier).localeCompare(String(b.supplier), 'ja')
    || String(a.code).localeCompare(String(b.code)));
  return { issues, count: issues.length };
}

function selfTest() {
  const hanbai = [{
    productCode: '009999',
    codeNorm: 'abc12345 xyz',
    coreNorm: 'テスト容器角小',
    norm: 'テスト容器角小',
  }];
  const makers = [
    { supplier: 'テスト仕入', makerCode: 'ABC12345', makerName: 'テスト容器 角小 本体', currentCost: 10, newCost: 12 },
    { supplier: 'テスト仕入', makerCode: 'WRONG99', makerName: '別の容器 角大', currentCost: 10, newCost: 12 },
  ];
  const better = auditBetterManualLinks(
    { 'テスト仕入': { '009999': '別の容器 角大' } },
    makers,
    hanbai,
  );
  if (better.count !== 1 || better.issues[0].kind !== 'better_cd') {
    console.error('linkBetterAudit selfTest FAILED', better);
    process.exit(1);
  }
  // 勘違い検出：002172 不織布 を パープルパワーパッド に紐付け＝別物 → suspect で拾えること。
  const suspectHanbai = [
    { productCode: '002172', coreNorm: 'ふれっしゅめいと不織布平乳白無地a-6', masterName: 'ﾌﾚｯｼｭﾒｲﾄ不織布(平)乳白無地 A-6', currentCost: 5.2 },
    { productCode: '003000', coreNorm: 'かくしょうばっぐ l 黒', masterName: '角小バッグ L 黒', currentCost: 10 },
  ];
  const suspectMakers = [
    { supplier: '大黒工業', makerName: 'パープルパワーパッド　Ｎｏ．２００３', currentCost: 480 },
    { supplier: '大黒工業', makerName: '角小バッグ S 白', currentCost: 11 },
  ];
  const sus = auditSuspectManualLinks(
    {
      '大黒工業': {
        '002172': 'パープルパワーパッド　Ｎｏ．２００３', // 別物（名前ゼロ重なり＋原価桁違い）→ suspect
        '003000': '角小バッグ S 白',                      // サイズ(L↔S)＋色(黒↔白)違い → suspect
      },
    },
    suspectMakers,
    suspectHanbai,
  );
  const has2172 = sus.issues.some((i) => i.code === '002172');
  const has3000 = sus.issues.some((i) => i.code === '003000'
    && i.reasons.some((r) => r.k === 'size_mismatch') && i.reasons.some((r) => r.k === 'color_mismatch'));
  if (sus.count !== 2 || !has2172 || !has3000) {
    console.error('auditSuspectManualLinks selfTest FAILED', JSON.stringify(sus, null, 2));
    process.exit(1);
  }
  console.log('linkBetterAudit selfTest OK');
}

if (require.main === module) selfTest();

module.exports = { auditBetterManualLinks, auditSuspectManualLinks, selfTest };
