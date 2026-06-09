'use strict';
// 照合精度の「測定基盤」（読み取り専用）。
//  最新の照合結果CSV（input/<仕入先>_照合結果_*.csv）と、人が確定した正解情報
//  （settings.json の productLinks=📌手動紐付け / cdReview.confirmed=確定 / cdReview.rejected=却下）を
//  突き合わせ、CD一致率・名前一致率・休眠率・recall（正解が拾えているか）・false positive（却下した組が
//  今も一致しているか）を一覧で出す。
//  ＝エンジンを直す前後で「良くなった/悪くなった」を数字で比較するための土台（CLAUDE.mdの最重要提案①）。
//  ※ DB/再照合は不要。今ある input/ のCSVをそのまま測るだけ＝どのPCでも安全に動く。

const fs = require('fs');
const path = require('path');
const { loadCsv } = require('./csv');
const { padSelfCode } = require('./match');

const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'input');

// input/ から「仕入先ごと最新1本」の照合結果CSVを選ぶ（server.listLatestCsv と同規則）。
function listLatestCsv() {
  let files = [];
  try { files = fs.readdirSync(INPUT_DIR); } catch (_) { return []; }
  files = files.filter((f) => /_照合結果_.*\.csv$/i.test(f) && !f.startsWith('_'));
  const latest = new Map();
  for (const f of files) {
    const supplier = String(f).split('_照合結果_')[0];
    const m = f.match(/_照合結果_(\d{4,})/);
    const stamp = m ? m[1] : '0';
    let mtime = 0; try { mtime = fs.statSync(path.join(INPUT_DIR, f)).mtimeMs; } catch (_) {}
    const cur = latest.get(supplier);
    if (!cur || cur.stamp < stamp || (cur.stamp === stamp && cur.mtime < mtime)) latest.set(supplier, { file: f, stamp, mtime });
  }
  return [...latest.values()].map((v) => v.file);
}

function statusKind(st) {
  const s = String(st || '');
  if (/休眠|未一致/.test(s)) return 'dormant';
  if (/📌/.test(s)) return 'manual';
  if (/CD一致（自社品）/.test(s)) return 'self';
  if (/CD一致/.test(s)) return 'cd';
  if (/名前一致/.test(s)) return 'name';
  if (/要確認/.test(s)) return 'review';
  return 'other';
}

// 名前一致行のスコア%を取り出す（'✓ 名前一致(87%)+価格' → 87）
function nameScoreOf(st) {
  const m = String(st || '').match(/名前一致\((\d+)%\)/);
  return m ? Number(m[1]) : NaN;
}

// 戻り値：仕入先別・全体の集計＋正解突合（recall/falsePositive）。
function buildMatchAudit(opts) {
  const o = opts || {};
  const getSettings = o.getSettings || require('./settings').getSettings;
  const s = getSettings();
  const productLinks = s.productLinks || {};
  const cdReview = (s.cdReview && typeof s.cdReview === 'object') ? s.cdReview : { confirmed: {}, rejected: {} };
  const confirmed = cdReview.confirmed || {};
  const rejected = cdReview.rejected || {};

  // 照合結果を仕入先別に読み、(仕入先, 自社CD) → そのCDに当たった一致行 を索引化。
  const bySupplier = {}; // sup -> { rows, counts }
  const matchedByKey = new Map(); // sup\x01padCode -> [{makerName, makerCode, kind, score}]
  const overall = { total: 0, matched: 0, cd: 0, name: 0, manual: 0, self: 0, dormant: 0, review: 0, other: 0, nameScoreSum: 0, nameScoreN: 0 };

  for (const f of listLatestCsv()) {
    const sup = String(f).split('_照合結果_')[0];
    let recs;
    try { recs = loadCsv(path.join(INPUT_DIR, path.basename(f))).records; } catch (e) { continue; }
    const c = { file: f, total: 0, matched: 0, cd: 0, name: 0, manual: 0, self: 0, dormant: 0, review: 0, other: 0 };
    for (const r of recs) {
      const st = r['照合'] || '';
      const kind = statusKind(st);
      c.total++; overall.total++;
      c[kind]++; overall[kind] = (overall[kind] || 0) + 1;
      if (kind === 'cd' || kind === 'name' || kind === 'manual' || kind === 'self') { c.matched++; overall.matched++; }
      if (kind === 'name') {
        const sc = nameScoreOf(st);
        if (Number.isFinite(sc)) { overall.nameScoreSum += sc; overall.nameScoreN++; }
      }
      const code = padSelfCode(r['販売実績商品コード']);
      if (code && (kind === 'cd' || kind === 'name' || kind === 'manual' || kind === 'self')) {
        const key = sup + '\x01' + code;
        if (!matchedByKey.has(key)) matchedByKey.set(key, []);
        matchedByKey.get(key).push({
          makerName: String(r['メーカー商品名'] || '').trim(),
          makerCode: String(r['メーカー商品CD'] || '').trim(),
          kind, score: nameScoreOf(st),
        });
      }
    }
    bySupplier[sup] = c;
  }

  const norm = (x) => String(x || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

  // recall：人が「正しい」と確定した組（productLinks + cdReview.confirmed）が、今の照合で拾えているか。
  const recall = { totalKnown: 0, present: 0, exactMaker: 0, missing: [] };
  const seen = new Set();
  const addKnown = (sup, code, wantName, wantCode) => {
    const padc = padSelfCode(code);
    const k = sup + '\x01' + padc + '\x01' + norm(wantName) + '\x01' + norm(wantCode);
    if (seen.has(k)) return; seen.add(k);
    recall.totalKnown++;
    const hits = matchedByKey.get(sup + '\x01' + padc) || [];
    if (hits.length) {
      recall.present++;
      const ok = hits.some((h) => (wantName && norm(h.makerName) === norm(wantName))
        || (wantCode && norm(h.makerCode) === norm(wantCode)));
      if (ok) recall.exactMaker++;
      else recall.missing.push({ supplier: sup, code, want: wantName || wantCode, got: hits.map((h) => h.makerName).slice(0, 3), kind: 'wrong_maker' });
    } else {
      recall.missing.push({ supplier: sup, code, want: wantName || wantCode, got: [], kind: 'dormant' });
    }
  };
  for (const [sup, codes] of Object.entries(productLinks)) {
    for (const [code, linked] of Object.entries(codes || {})) {
      if (String(linked || '').trim()) addKnown(sup, code, linked, '');
    }
  }
  for (const [sup, codes] of Object.entries(confirmed)) {
    for (const [code, info] of Object.entries(codes || {})) {
      if (info && (info.name || info.code)) addKnown(sup, code, info.name || '', info.code || '');
    }
  }

  // false positive：人が「別物」と却下した組（cdReview.rejected: code|makerCode）が、今も名前一致で繋がっているか。
  const fp = { totalRejected: 0, stillMatched: 0, hits: [] };
  for (const [sup, pairs] of Object.entries(rejected)) {
    for (const key of Object.keys(pairs || {})) {
      const bar = key.lastIndexOf('|');
      if (bar < 0) continue;
      const code = key.slice(0, bar); const mCode = key.slice(bar + 1);
      fp.totalRejected++;
      const hits = matchedByKey.get(sup + '\x01' + padSelfCode(code)) || [];
      const bad = hits.find((h) => mCode && norm(h.makerCode) === norm(mCode) && (h.kind === 'name' || h.kind === 'cd'));
      if (bad) { fp.stillMatched++; fp.hits.push({ supplier: sup, code, makerCode: mCode, maker: bad.makerName, kind: bad.kind }); }
    }
  }

  const matchedTotal = overall.matched || 0;
  return {
    overall: Object.assign({}, overall, {
      cdRate: matchedTotal ? Math.round((overall.cd + overall.self) / matchedTotal * 1000) / 10 : 0,
      nameRate: matchedTotal ? Math.round(overall.name / matchedTotal * 1000) / 10 : 0,
      manualRate: matchedTotal ? Math.round(overall.manual / matchedTotal * 1000) / 10 : 0,
      dormantRate: overall.total ? Math.round(overall.dormant / overall.total * 1000) / 10 : 0,
      avgNameScore: overall.nameScoreN ? Math.round(overall.nameScoreSum / overall.nameScoreN * 10) / 10 : 0,
    }),
    bySupplier,
    recall: Object.assign({}, recall, {
      presentRate: recall.totalKnown ? Math.round(recall.present / recall.totalKnown * 1000) / 10 : 0,
      exactRate: recall.totalKnown ? Math.round(recall.exactMaker / recall.totalKnown * 1000) / 10 : 0,
    }),
    fp,
  };
}

function printReport() {
  const a = buildMatchAudit();
  const o = a.overall;
  console.log('===== 照合 精度レポート（input/ の最新CSV）=====');
  console.log(`総行数: ${o.total} / 一致: ${o.matched}（CD+自社 ${o.cd + o.self}=${o.cdRate}% ・名前 ${o.name}=${o.nameRate}% ・手動 ${o.manual}=${o.manualRate}%） / 休眠 ${o.dormant}=${o.dormantRate}% / 要確認 ${o.review}`);
  console.log(`名前一致の平均スコア: ${o.avgNameScore}%`);
  console.log('');
  console.log('--- 仕入先別 ---');
  for (const [sup, c] of Object.entries(a.bySupplier).sort((x, y) => x[0].localeCompare(y[0], 'ja'))) {
    console.log(`  ${sup}: 一致${c.matched}(CD${c.cd}+自社${c.self}/名前${c.name}/手動${c.manual}) 休眠${c.dormant} 要確認${c.review} 計${c.total}`);
  }
  console.log('');
  console.log('--- recall（人が確定した正解＝📌+確定 が拾えているか）---');
  console.log(`  正解 ${a.recall.totalKnown}件中 / 一致行あり ${a.recall.present}(${a.recall.presentRate}%) / 紐付け先まで一致 ${a.recall.exactMaker}(${a.recall.exactRate}%)`);
  if (a.recall.missing.length) {
    console.log(`  ⚠ 拾えていない ${a.recall.missing.length}件（上位20）:`);
    for (const m of a.recall.missing.slice(0, 20)) {
      console.log(`    [${m.kind}] ${m.supplier} ${m.code} 期待「${m.want}」 現状: ${m.got.length ? m.got.join(' / ') : '休眠'}`);
    }
  }
  console.log('');
  console.log('--- false positive（却下した「別物」の組が今も一致しているか）---');
  console.log(`  却下 ${a.fp.totalRejected}件中 / まだ一致 ${a.fp.stillMatched}件`);
  for (const h of a.fp.hits.slice(0, 20)) {
    console.log(`    ⚠ ${h.supplier} ${h.code} ⇔ ${h.makerCode}「${h.maker}」(${h.kind}) ＝却下したのに一致`);
  }
  console.log('==============================================');
}

if (require.main === module) printReport();

module.exports = { buildMatchAudit, listLatestCsv, statusKind, nameScoreOf };
