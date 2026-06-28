'use strict';
// =====================================================================
//  💤休眠（保留）にした自社品に、その後 新しい売上が立ったら「復帰の検討」を知らせる。
//   休眠＝「正しい品だが今は仕入れていない」＝照合対象から外している。だが再び売れたなら
//   取引再開の可能性＝見積に戻すべきかもしれない。照合エンジンは休眠を黙ってスキップし続けるので、
//   気づく手立てが無いと見積から漏れる。ここで「休眠なのに最近売上あり」を検知して通知する。
//  ・自動では戻さない（1件の売上＝返品/サンプル/単発のこともある）。人が見て📌解除で戻す＝通知だけ。
//   🚫除外（別物＝誤紐付けの恒久除外）は復帰対象外。💤休眠のみを見る。
//  ・判定材料：休眠にした日(markedAt) と 自社CDの最終売上日(lastDate)。
//     - markedAt があれば「休眠にした後に売れた」(lastDate > markedAt) を厳密判定＝誤検知ゼロ。
//     - markedAt が無い旧マークは「直近 fallbackDays 日に売上あり」で代替判定。
// =====================================================================
const { linkMarkKind, padSelfCode } = require('./productLink');

// 'YYYY-MM-DD' から days 日前の 'YYYY-MM-DD' を返す（UTC基準の単純な日付演算）。
function isoMinusDays(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() - days);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

// productLinks × 休眠日(markedAt) × 販売実績 で「休眠なのに最近売上あり＝復帰候補」を検出。
//  productLinks: { 仕入先: { 自社CD: メーカー名 or '__DORMANT__'/'__EXCLUDE__' } }
//  markedAt    : { 仕入先: { 自社CD: '休眠にした日 YYYY-MM-DD' } }（無くてもよい）
//  hanbai      : [{ productCode, lastDate:'YYYY-MM-DD', masterName?, productName? }]
//  opts.today  : 基準日 'YYYY-MM-DD'（フォールバックの起点。呼び出し側が渡す＝テスト容易）
//  opts.fallbackDays : 休眠日が無い旧マーク用のさかのぼり日数（既定120）
// 戻り値 { issues:[{ supplier, code, kind:'dormant_revival', linked, lastDate, since, selfName }], count }
function auditDormantRevival(productLinks, markedAt, hanbai, opts) {
  const o = opts || {};
  const today = String(o.today || '').slice(0, 10);
  const fallbackDays = Number.isFinite(o.fallbackDays) ? o.fallbackDays : 120;
  const cutoffFallback = today ? isoMinusDays(today, fallbackDays) : '';

  // 自社CD → { 最新売上日, 代表品名 }
  const byCode = new Map();
  for (const r of hanbai || []) {
    const code = padSelfCode(r.productCode);
    if (!code) continue;
    const ld = String(r.lastDate || '').slice(0, 10);
    if (!ld) continue;
    const cur = byCode.get(code);
    if (!cur) {
      byCode.set(code, { lastDate: ld, name: String(r.masterName || r.productName || '').trim() });
    } else if (ld > cur.lastDate) {
      cur.lastDate = ld;
      if (!cur.name) cur.name = String(r.masterName || r.productName || '').trim();
    } else if (!cur.name) {
      cur.name = String(r.masterName || r.productName || '').trim();
    }
  }

  const issues = [];
  for (const [supplier, codes] of Object.entries(productLinks || {})) {
    for (const [rawCode, mark] of Object.entries(codes || {})) {
      if (linkMarkKind(mark) !== 'dormant') continue; // 💤休眠のみ（🚫除外＝別物は復帰対象外）
      const code = padSelfCode(rawCode);
      const info = byCode.get(code);
      if (!info || !info.lastDate) continue;          // 売上が全く無い＝復帰しようがない
      const sm = (markedAt && markedAt[supplier]) || null;
      const since = sm ? String(sm[rawCode] || sm[code] || '').slice(0, 10) : '';
      let revived;
      if (since) revived = info.lastDate > since;                          // 休眠にした後に売れた
      else revived = cutoffFallback ? (info.lastDate >= cutoffFallback) : false; // 旧マーク＝直近N日
      if (!revived) continue;
      issues.push({
        supplier,
        code: rawCode,
        kind: 'dormant_revival',
        linked: '💤 休眠（保留）',
        lastDate: info.lastDate,
        since,
        selfName: info.name,
      });
    }
  }
  // 売上が新しい順（戻す優先度が高い順）→ 仕入先名順。
  issues.sort((a, b) => (a.lastDate < b.lastDate ? 1 : (a.lastDate > b.lastDate ? -1 : 0))
    || String(a.supplier).localeCompare(String(b.supplier), 'ja')
    || String(a.code).localeCompare(String(b.code)));
  return { issues, count: issues.length };
}

// 単体検証（node src/dormantRevival.js）
function selfTest() {
  const productLinks = {
    'シンコー': {
      '006921': '__DORMANT__',  // 休眠：休眠日(2026-01-01)より後(2026-05-10)に売上 → 復帰候補
      '000100': '__DORMANT__',  // 休眠：休眠日(2026-06-01)より後の売上なし(2025-12-01) → 出さない
      '000200': '__EXCLUDE__',  // 除外：別物＝復帰対象外（売上が新しくても出さない）
      '000300': 'ふつうのメーカー品名', // 通常紐付け＝対象外
    },
    'レガシー社': {
      '000400': '__DORMANT__',  // 休眠日なし＝直近120日に売上(2026-06-20) → フォールバックで復帰候補
      '000500': '__DORMANT__',  // 休眠日なし＝最終売上が古い(2024-01-01) → 出さない
    },
  };
  const markedAt = {
    'シンコー': { '006921': '2026-01-01', '000100': '2026-06-01' },
    // レガシー社は休眠日の記録が無い（旧マーク）
  };
  const hanbai = [
    { productCode: '6921', lastDate: '2026-05-10', masterName: 'ビリジスメロン L-2083' },
    { productCode: '000100', lastDate: '2025-12-01', masterName: '古い品' },
    { productCode: '000200', lastDate: '2026-06-25', masterName: '別物だが売れた品' },
    { productCode: '000300', lastDate: '2026-06-25', masterName: '通常品' },
    { productCode: '000400', lastDate: '2026-06-20', masterName: 'レガシー復活品' },
    { productCode: '000500', lastDate: '2024-01-01', masterName: 'レガシー死蔵品' },
  ];
  const r = auditDormantRevival(productLinks, markedAt, hanbai, { today: '2026-06-26', fallbackDays: 120 });
  const codes = r.issues.map((i) => i.code);
  // 並びは lastDate 降順：000400(2026-06-20) > 006921(2026-05-10) なので先頭は 000400 が正しい。
  const orderOk = r.issues[0].code === '000400' && r.issues[1].code === '006921';
  // 最終売上日・休眠日が載っていること。
  const fieldsOk = r.issues.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.lastDate));
  if (!(r.count === 2 && codes.includes('006921') && codes.includes('000400')
        && !codes.includes('000100') && !codes.includes('000200')
        && !codes.includes('000300') && !codes.includes('000500')
        && orderOk && fieldsOk)) {
    console.error('dormantRevival selfTest FAILED', JSON.stringify(r, null, 2));
    process.exit(1);
  }
  // isoMinusDays の月またぎ。
  if (isoMinusDays('2026-03-01', 1) !== '2026-02-28') {
    console.error('isoMinusDays FAILED', isoMinusDays('2026-03-01', 1));
    process.exit(1);
  }
  console.log('dormantRevival selfTest OK');
}

if (require.main === module) selfTest();

module.exports = { auditDormantRevival, isoMinusDays, selfTest };
