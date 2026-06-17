'use strict';
// 手動紐付け（productLinks）の共通ロジック。
// 紐付け名とメーカー品名の表記ゆれ（全角/半角スペース等）を正規化して比較する。

// 「このメーカーでは照合しない（除外）」の特別マーク。
//  productLinks[仕入先][自社CD] にこの値を入れると、その自社品はその仕入先の照合候補から完全に外れる。
//  ＝販売実績はあるが もうそのメーカーから仕入れない品が、似た名前の別メーカー品に誤紐付けされるのを根本から防ぐ。
//  実在するメーカー品名と衝突しない内部値。解除は通常の📌解除（空保存で削除）でそのまま戻せる＝可逆。
const EXCLUDE_MARK = '__EXCLUDE__';
function isExcludeLink(v) { return String(v == null ? '' : v).trim() === EXCLUDE_MARK; }

function normLinkName(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function linkNamesEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return normLinkName(a) === normLinkName(b);
}

// 自社商品コードのゼロ詰め（match.js と同規則・循環参照を避けるためここに複製）
function padSelfCode(c) {
  const t = String(c == null ? '' : c).trim();
  if (!t) return '';
  return /^\d+$/.test(t) ? t.padStart(6, '0') : t.toLowerCase();
}

function codesEqual(a, b) {
  const pa = padSelfCode(a);
  const pb = padSelfCode(b);
  if (pa && pb) return pa === pb;
  return String(a || '').trim() === String(b || '').trim();
}

// productLinks のキーゆれ（62 / 000062）を吸収して紐付け名を引く
function lookupProductLink(links, productCode) {
  if (!links || productCode == null || String(productCode).trim() === '') return '';
  const raw = String(productCode).trim();
  const pad = padSelfCode(raw);
  const candidates = [raw, pad];
  if (/^\d+$/.test(pad)) {
    const n = String(Number(pad));
    if (n !== raw && n !== pad) candidates.push(n);
  }
  for (const k of candidates) {
    if (links[k] != null && String(links[k]).trim() !== '') return String(links[k]).trim();
  }
  return '';
}

// 保存時のキーを正規化（数値コードは6桁ゼロ詰め）
function normalizeLinkCode(productCode) {
  const raw = String(productCode || '').trim();
  if (!raw) return '';
  const pad = padSelfCode(raw);
  return pad || raw;
}

function findLinkTargetsInQuote(quoteMakerNames, linkedMaker) {
  if (!linkedMaker || !quoteMakerNames) return [];
  const hits = [];
  const n = normLinkName(linkedMaker);
  for (const m of quoteMakerNames) {
    if (linkNamesEqual(m, linkedMaker)) hits.push(m);
  }
  if (hits.length) return [...new Set(hits)];
  for (const m of quoteMakerNames) {
    const mn = normLinkName(m);
    if (!mn || !n) continue;
    if (mn.includes(n) || n.includes(mn)) hits.push(m);
  }
  return [...new Set(hits)];
}

function quoteHasLinkedName(quoteMakerNames, linkedMaker) {
  return findLinkTargetsInQuote(quoteMakerNames, linkedMaker).length > 0;
}

function linkedMakerExactInPeer(peerRows, productCode, linkedMaker) {
  return peerRows.some((r) => codesEqual(r.productCode, productCode) && linkNamesEqual(r.makerName, linkedMaker));
}

// 紐付け先と異なるメーカー品への誤一致だけ除外。
function shouldExcludeByProductLink(rec, links, peerRows) {
  if (!rec || !rec.productCode) return false;
  const linkedMaker = lookupProductLink(links, rec.productCode);
  if (!linkedMaker) return false;
  if (linkNamesEqual(linkedMaker, rec.makerName)) return false;
  return linkedMakerExactInPeer(peerRows, rec.productCode, linkedMaker);
}

// この行に 📌 手動紐付け を当てるか（得意先ページ・calcAll 用）
function isProductLinkActive(rec, links, peerRows) {
  if (!rec || !rec.productCode) return false;
  const linkedMaker = lookupProductLink(links, rec.productCode);
  if (!linkedMaker) return false;
  if (isExcludeLink(linkedMaker)) return false; // 「照合しない」除外指定は手動紐付けではない（一致扱いしない）
  if (linkNamesEqual(linkedMaker, rec.makerName)) return true;
  return !linkedMakerExactInPeer(peerRows, rec.productCode, linkedMaker);
}

// 照合エンジン用：このメーカー品×自社CDの組に手動紐付けを適用するか
function isLinkActiveForItem(productCode, itemMakerName, linkedMaker, quoteMakerNames) {
  if (!linkedMaker) return false;
  if (linkNamesEqual(linkedMaker, itemMakerName)) return true;
  const targets = findLinkTargetsInQuote(quoteMakerNames, linkedMaker);
  if (!targets.length) return false;
  return targets.some((m) => linkNamesEqual(m, itemMakerName));
}

// 照合エンジン用：別メーカー品への取り合いを弾くか
function shouldBlockLinkOther(linkedMaker, itemMakerName, quoteMakerNames) {
  if (!linkedMaker || linkNamesEqual(linkedMaker, itemMakerName)) return false;
  return quoteHasLinkedName(quoteMakerNames, linkedMaker);
}

// 照合結果CSV行 → { productCode, makerName, customerName, matchStatus }
function matchRowToPeer(r) {
  return {
    productCode: String(r['販売実績商品コード'] || '').trim(),
    makerName: String(r['メーカー商品名'] || '').trim(),
    customerName: String(r['得意先名'] || '').trim(),
    matchStatus: String(r['照合'] || '').trim(),
  };
}

// productLinks 全体を監査。戻り値 issues[] = { supplier, code, linked, kind, makers[], hint? }
// kind: ok | name_mismatch（表記ゆれ・要修正推奨）| orphan（照合に無い・古い紐付け）
function auditProductLinks(productLinks, matchRowsBySupplier) {
  const issues = [];
  for (const [supplier, codes] of Object.entries(productLinks || {})) {
    const rows = (matchRowsBySupplier[supplier] || []).map(matchRowToPeer)
      .filter((r) => r.productCode && /^[✓📌]/.test(r.matchStatus));
    for (const [code, linked] of Object.entries(codes || {})) {
      const linkedName = String(linked || '').trim();
      if (!linkedName) continue;
      if (isExcludeLink(linkedName)) continue; // 「照合しない」除外指定は意図的＝監査対象外（orphan扱いしない）
      const hit = rows.filter((r) => codesEqual(r.productCode, code));
      const makers = [...new Set(hit.map((r) => r.makerName).filter(Boolean))];
      if (!hit.length) {
        issues.push({ supplier, code, linked: linkedName, kind: 'orphan', makers: [] });
        continue;
      }
      const exactHit = makers.some((m) => linkNamesEqual(m, linkedName));
      if (!exactHit) {
        issues.push({
          supplier, code, linked: linkedName, kind: 'name_mismatch', makers,
          hint: makers[0] || '',
        });
      }
    }
  }
  issues.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja')
    || String(a.code).localeCompare(String(b.code)));
  return {
    issues,
    count: issues.length,
    mismatchCount: issues.filter((i) => i.kind === 'name_mismatch').length,
    orphanCount: issues.filter((i) => i.kind === 'orphan').length,
  };
}

// 単体検証（node src/productLink.js）
function selfTest() {
  const peers = [
    { productCode: '002575', makerName: 'ﾆｭｰｲｰｼﾞｰﾊﾞｯｸ LL 半透明(№45)' },
    { productCode: '002575', makerName: '別メーカー品' },
  ];
  const links = { '002575': 'ﾆｭｰｲｰｼﾞｰﾊﾞｯｸ LL(№45)' };
  const rec = peers[0];
  const exclWrong = shouldExcludeByProductLink(peers[1], links, peers);
  const exclRight = shouldExcludeByProductLink(rec, links, peers);
  const active = isProductLinkActive(rec, links, peers);
  const quote = new Set(['ﾆｭｰｲｰｼﾞｰﾊﾞｯｸ LL 半透明(№45)']);
  const linkSelf = isLinkActiveForItem('002575', rec.makerName, links['002575'], quote);
  const blockOther = shouldBlockLinkOther(links['002575'], '別メーカー品', quote);
  // 略称リンクは照合では拾わないが、画面表示(isProductLinkActive)では残す
  const ok = !exclWrong && !exclRight && active && !blockOther;
  // 表記ゆれ：半角スペースの紐付け名でも正しいメーカー品にだけ適用（全品に噴き出さない）
  const quote2 = new Set(['フレッシュメイト　不織布［平］乳白無地　Ａ－６']);
  const linkHalf = 'フレッシュメイト 不織布［平］乳白無地 Ａ－６';
  const sprayWrong = isLinkActiveForItem('002172', 'パープルパワーパッド　Ｎｏ．２００３', linkHalf, quote2);
  const sprayRight = isLinkActiveForItem('002172', 'フレッシュメイト　不織布［平］乳白無地　Ａ－６', linkHalf, quote2);
  const ok2 = !sprayWrong && sprayRight;
  const okPad = lookupProductLink({ '000062': 'テスト品A' }, '62') === 'テスト品A'
    && lookupProductLink({ '62': 'テスト品B' }, '000062') === 'テスト品B';
  const auditOk = auditProductLinks(
    { テスト仕入: { '000062': 'テスト品' } },
    { テスト仕入: [{ 販売実績商品コード: '62', 照合: '✓ 名前一致(100%)', メーカー商品名: 'テスト品' }] },
  );
  const okAudit = auditOk.orphanCount === 0 && auditOk.count === 0;
  if (!ok || !ok2 || !okPad || !okAudit) {
    console.error('productLink selfTest FAILED', { exclWrong, exclRight, active, linkSelf, blockOther, sprayWrong, sprayRight, okPad, okAudit, auditOk });
    process.exit(1);
  }
  console.log('productLink selfTest OK');
}

if (require.main === module) selfTest();

module.exports = {
  EXCLUDE_MARK,
  isExcludeLink,
  normLinkName,
  linkNamesEqual,
  padSelfCode,
  codesEqual,
  lookupProductLink,
  normalizeLinkCode,
  findLinkTargetsInQuote,
  quoteHasLinkedName,
  linkedMakerExactInPeer,
  shouldExcludeByProductLink,
  isProductLinkActive,
  isLinkActiveForItem,
  shouldBlockLinkOther,
  matchRowToPeer,
  auditProductLinks,
  selfTest,
};
