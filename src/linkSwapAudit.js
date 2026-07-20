'use strict';
// =====================================================================
//  📌手動紐付けの「貼り替え忘れ」（コード再利用）を検知する。
//   運用で「自社CDはそのまま・中身のアイテムだけ入れ替える」ことがある（例：コパックス V-79 を
//   同じ 002050 のまま エフピコ FLB-A13-20 へ差し替え）。このとき販売大臣のマスタ品名は新品に
//   更新されるが、ツールの 📌手動紐付け は旧品(V-79)を指したまま残りやすい。📌は最優先(score2000)で
//   照合を上書きするため、放置すると旧品・旧仕入先の原価(4.95)が“静かに”出続ける（新品4.8にならない）。
//   ＝人が気づきにくい価格事故。ここで「📌が指すメーカー品名(旧) と マスタ品名(新) の品番が別物」を検知する。
//
//   誤検知を避ける肝（実データで検証）：同一品の別表記は山ほどある（風呂敷 035x900＝№90／NK30BA＝NK30／
//   IF桃ﾊﾟｯｸ 267X427＝PS267×427…）。これらは品番コアが部分一致する。本物の入れ替えは品番が完全に無関係
//   （V79 と FLBA1320 は共通2文字なし）。よって「両者の品番コードが共通2文字を1つも持たない」ときだけ出す。
//   ＝ 判定不能（片方に品番が無い）や、少しでも重なる（同一品の疑い）ときは出さない＝保守的（誤検知ほぼゼロ）。
//   自動では直さない（[[prefer-flag-bad-data-not-auto-fix]]）＝通知して人が📌を貼り替える。
// =====================================================================
const { isExcludeLink, lookupProductLink, linkNamesEqual } = require('./productLink');

// 商品名から「品番らしいトークン」の集合を返す。英数字(＋ハイフン)の連なりで、英字と数字を両方含むもの。
//  例: "Vトレー V－79" → {V-79} ／ "ﾄﾚｰFLB-A13-20 W" → {FLB-A13-20}（"W" は数字なしで除外）。
//  純数字（100/2000, 83 等のロット・入数）は英字を含まないので品番扱いしない＝ノイズ除去。
function codeSignature(name) {
  const s = String(name || '').normalize('NFKC').toUpperCase();
  const set = new Set();
  const re = /[A-Z0-9]+(?:-[A-Z0-9]+)*/g;
  let m;
  while ((m = re.exec(s))) {
    const tok = m[0];
    if (/[A-Z]/.test(tok) && /\d/.test(tok)) set.add(tok);
  }
  return set;
}

// 記号を除いた英数字だけに畳む（V-79 → V79）。共通部分文字列の判定用。
function collapseCode(tok) {
  return String(tok || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

// 2つの品番トークンが「共通の2文字以上の部分文字列」を持つか（= 同一品の別表記の疑い）。
function pairShareCore(a, b) {
  const A = collapseCode(a), B = collapseCode(b);
  if (A.length < 2 || B.length < 2) return A && B && (A.includes(B) || B.includes(A));
  for (let i = 0; i + 2 <= A.length; i++) {
    if (B.includes(A.substr(i, 2))) return true;
  }
  return false;
}

// 2つの品番集合が、どのペアも共通コアを持たない＝完全に別物か。
function setsAreForeign(setA, setB) {
  for (const a of setA) for (const b of setB) if (pairShareCore(a, b)) return false;
  return true;
}

// 照合結果（仕入先ごとの行配列）から「📌が旧品を指したまま＝貼り替え忘れ」を検出。
//  productLinks: { 仕入先: { 自社CD: メーカー名 or 除外/休眠マーク } }（除外/休眠は対象外にする保険）
//  matchRowsBySupplier: { 仕入先: [ 照合結果CSVの行オブジェクト ] }
//  戻り値 { issues:[{ supplier, code, kind:'link_swap', linked(旧メーカー名), master(新マスタ名), selfName, makerCodes, masterCodes }], count }
function auditLinkSwaps(productLinks, matchRowsBySupplier) {
  const issues = [];
  for (const [supplier, rows] of Object.entries(matchRowsBySupplier || {})) {
    const links = (productLinks && productLinks[supplier]) || {};
    // 📌行を自社CD単位にまとめ、メーカー名・マスタ名それぞれの品番集合を作る。
    //  行は正規化済みレコード（matchStatus/productCode/makerName/masterName）でも、
    //  生CSV行（'照合'/'販売実績商品コード'/…）でも読めるよう両対応にする。
    const byCode = new Map();
    for (const r of rows || []) {
      const status = String(r.matchStatus != null ? r.matchStatus : (r['照合'] || ''));
      if (!/^📌/.test(status)) continue; // 手動紐付けが実際に勝っている行だけ
      const code = String((r.productCode != null ? r.productCode : r['販売実績商品コード']) || '').trim();
      if (!code) continue;
      const mk = String((r.makerName != null ? r.makerName : r['メーカー商品名']) || '').trim();
      const ms = String((r.masterName != null ? r.masterName : r['商品名(マスタ)']) || '').trim();
      const g = byCode.get(code) || { maker: new Set(), master: new Set(), makerName: '', masterName: '' };
      if (mk) { codeSignature(mk).forEach((t) => g.maker.add(t)); if (!g.makerName) g.makerName = mk; }
      if (ms) { codeSignature(ms).forEach((t) => g.master.add(t)); if (!g.masterName) g.masterName = ms; }
      byCode.set(code, g);
    }
    for (const [code, g] of byCode) {
      // 検知は照合結果CSV（前回照合時のスナップショット）で判定するが、📌の解決有無だけは
      //  “現在の” productLinks を見て判定する。＝利用者が「✏直す/解除」した直後（まだ↻照合していない）に
      //  同じ🔁が出続け、隣の「解除」を誤クリックして直したばかりの新📌を消す事故を防ぐ（Fable5レビュー指摘）。
      const linked = lookupProductLink(links, code);
      if (!linked) continue;                                 // 📌解除済み＝もう警告不要（照合し直せば自動へ戻る）
      if (isExcludeLink(linked)) continue;                   // 🚫除外/💤休眠は意図的＝対象外
      if (!linkNamesEqual(linked, g.makerName)) continue;    // 既に別のメーカー品へ貼り替え済み＝解決済み（表記ゆれは name_mismatch 監査が拾う）
      if (!g.maker.size || !g.master.size) continue;         // どちらかに品番が無い＝判定不能（出さない）
      if (!setsAreForeign(g.maker, g.master)) continue;      // 品番コアが少しでも重なる＝同一品＝正常
      issues.push({
        supplier,
        code,
        kind: 'link_swap',
        linked: g.makerName,      // 📌が指す“旧”メーカー品名
        master: g.masterName,     // 現在の“新”マスタ品名
        selfName: g.masterName,   // 別枠パネルの自社品名欄用（他監査と同じフィールド名）
        makerCodes: [...g.maker],
        masterCodes: [...g.master],
      });
    }
  }
  issues.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja')
    || String(a.code).localeCompare(String(b.code)));
  return { issues, count: issues.length };
}

// 単体検証（node src/linkSwapAudit.js）
function selfTest() {
  const productLinks = {
    'コパックス 本部業務課': { '002050': 'Vトレー V－79', '002043': 'Vトレー V－26' },
    '朝日食品容器': { '002179': 'ﾎﾟﾘ風呂敷 水玉ﾋﾟﾝｸ 035x900', '003512': 'ﾊﾞｲｵｶｯﾌﾟ ﾂﾌﾞNK30BA' },
    'テスト': { '000900': '__DORMANT__' },
    // 「直した直後（未照合）」＝CSVは旧📌のままでも、現productLinksが解決済みなら出さない。
    'テスト再利用': { '007001': '新メーカー品 X-99' /* 別品へ貼替済 */ /* 007002 は解除済＝キー無し */ },
  };
  const rows = {
    // 本物の貼り替え忘れ（品番が完全に別物）
    'コパックス 本部業務課': [
      { '照合': '📌 手動紐付け', '販売実績商品コード': '002050', 'メーカー商品名': 'Vトレー V－79', '商品名(マスタ)': 'ﾄﾚｰFLB-A13-20　W' },
      { '照合': '📌 手動紐付け', '販売実績商品コード': '002043', 'メーカー商品名': 'Vトレー V－26', '商品名(マスタ)': 'ﾄﾚｰFLB-012-33　ｴｺ' },
    ],
    // 同一品の別表記＝出してはいけない（035x900＝№90／NK30BA＝NK30 で共通コアあり）
    '朝日食品容器': [
      { '照合': '📌 手動紐付け', '販売実績商品コード': '002179', 'メーカー商品名': 'ﾎﾟﾘ風呂敷 水玉ﾋﾟﾝｸ 035x900', '商品名(マスタ)': 'ﾎﾟﾘ風呂敷　№90　水玉ﾋﾟﾝｸ' },
      { '照合': '📌 手動紐付け', '販売実績商品コード': '003512', 'メーカー商品名': 'ﾊﾞｲｵｶｯﾌﾟ ﾂﾌﾞNK30BA', '商品名(マスタ)': 'ﾊﾞｲｵｶｯﾌﾟ　ﾂﾌﾞNK30　BA　本体' },
    ],
    // 品番は別物(Q1↔X99)だが、007001はもう別品へ貼替済／007002は解除済＝どちらも出してはいけない（未照合でCSVは旧📌のまま）。
    'テスト再利用': [
      { '照合': '📌 手動紐付け', '販売実績商品コード': '007001', 'メーカー商品名': '旧品 Q-1', '商品名(マスタ)': '新品 X-99' },
      { '照合': '📌 手動紐付け', '販売実績商品コード': '007002', 'メーカー商品名': '旧品 A-1', '商品名(マスタ)': '新品 B-2' },
    ],
  };
  const r = auditLinkSwaps(productLinks, rows);
  const codes = r.issues.map((i) => i.code).sort();
  // 貼替済(007001)・解除済(007002)は現productLinksで解決済み＝出さない → 本物2件だけ残る。
  const ok = r.count === 2 && codes.join(',') === '002043,002050';
  // pairShareCore の要点：90⊂900 は同一(true)、V79↔FLBA1320 は別物(false)
  const coreOk = pairShareCore('035X900', 'NO90') === true
    && pairShareCore('V-79', 'FLB-A13-20') === false
    && pairShareCore('NK30BA', 'NK30') === true
    && pairShareCore('W2', 'TCB-W2') === true;
  if (!ok || !coreOk) {
    console.error('linkSwapAudit selfTest FAILED', JSON.stringify({ codes, coreOk, issues: r.issues }, null, 2));
    process.exit(1);
  }
  console.log('linkSwapAudit selfTest OK');
}

if (require.main === module) selfTest();

module.exports = { auditLinkSwaps, codeSignature, pairShareCore, setsAreForeign, selfTest };
