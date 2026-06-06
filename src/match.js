// =====================================================================
//  照合エンジン：メーカー見積 × 販売実績 → 照合結果レコード
//  2段階照合: ① CD一致(メーカー品番が販売実績に埋め込まれている) を優先
//             ② 名前一致(トークン重なり%) で補完
//  1メーカー品 → 該当する全(得意先×自社商品)へ展開。
//  出力は既存の照合結果CSVと同じ列なので、既存パイプラインへ直結できる。
// =====================================================================
const { nfkc, normName } = require('./textnorm');

// 名前のトークン分割（全角/半角スペース区切り・1文字ノイズは除外）
//  英字のみの注記カッコ (D)(KS)(R) 等は照合の邪魔なので除去する。
//  ※ 数字を含むカッコ (50)(20)(1800) はサイズ/ロットを表すため温存（別品の取り違え防止）。
//  ※ 1文字でも漢字なら保持＝「蓋/身/大/中/小/特」等の区別語を消さない。
//    （CF寿司容器L 0.4 蓋 ↔ … 華紋 身 のような取り違えを防ぐ）
//  ※ メーカー名末尾の材質コード(PP/PET/OPET/APET/OPS) は剥がす：
//    「T-ﾄﾞﾘｽｶｯﾌﾟ115内嵌合C字蓋PP」(メーカー) と「T-ﾄﾞﾘｽｶｯﾌﾟ115内篏合C字蓋」(自社)を
//    繋ぐ。自社側は材質を書かないことが多く、メーカーだけ末尾2-4文字のPP/OPS等が付くと
//    1文字ins/delを超えた違いになって取りこぼす。実害が大きいので名前空間から除去する。
const MATERIAL_SUFFIX_RE = /[-]?(opet|apet|pet|ops|pp)$/i;
function stripMaterialSuffix(t) {
  // normName 後（小文字化済）の token を仮定。
  // 末尾の材質コード(opt. 直前のハイフン込み)を1回剥がす。「字蓋pp」→「字蓋」/「rp-127opet」→「rp-127」
  return t.replace(MATERIAL_SUFFIX_RE, '');
}
// メーカー名はスペースを省くスタイルがあり (例: T-箱弁23-17内嵌合IC蓋 OPS)、
// 自社側に余分な1文字（例: 内嵌合"蓋"IC蓋 のように もう一つ 蓋 が挟まる）があると、
// 「メーカー側1文字ins/del」では救えなくなる。事前に部位語(PART_TOKENS)の前後へ
// スペースを差し込み、`内嵌合 IC蓋` のように分割しておくと、各トークンが自社の部分文字列
// として独立に拾える。PART_TOKENS は長い語から順に処理して `内嵌合蓋` が `内嵌合` に
// 二重分割されるのを防ぐ。
function preSegmentMaker(name) {
  let s = name;
  const sorted = [...PART_TOKENS].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    if (s.indexOf(p) !== -1) s = s.split(p).join(' ' + p + ' ');
  }
  return s;
}
// 改定マーク等の「商品の違いではない」単独語。メーカーが値上げ時に付ける「改」など。
//  自社販売実績には書かれないので、決定的トークン扱いされて休眠落ちする原因になる→除外する。
//  例:「ﾀﾚ壜 角小(D) 改」↔「ﾀﾚﾋﾞﾝ 角小」を 100% で繋ぐ（"改" の1文字で別商品扱いしない）。
const NOISE_TOKENS = new Set(['改']);
function tokenize(name) {
  return preSegmentMaker(nfkc(name))
    .split(/[\s　]+/)
    .map((t) => stripMaterialSuffix(normName(t).replace(/[(（][a-z][a-z\-]*[)）]/g, '')))
    .filter((t) => (t.length >= 2 || /^[一-鿿]$/.test(t)) && !NOISE_TOKENS.has(t));
}

// 同長で1文字だけ違うとき、その違う文字ペア [a,b] を返す（2文字以上違えば null）
function singleSubPair(a, b) {
  let idx = -1;
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) { if (idx !== -1) return null; idx = k; }
  }
  return idx === -1 ? null : [a[idx], b[idx]];
}
// あいまい一致を許す“異体字”のホワイトリスト。
//  ※ 大/中/小/特・色・角/丸 等の「意味を持つ1文字」は意図的に含めない＝サイズ違い等の誤一致を防ぐ。
const VARIANT_SET = new Set();
//  記号ゆれ（区切り文字）も同一視: 115-380=115×380 / W･=W- 等。
[['篭', '籠'], ['竜', '龍'], ['桧', '檜'], ['麺', '麵'], ['鴎', '鷗'], ['x', '×'],
 ['-', '×'], ['・', '-'], ['-', '/']]
  .forEach((p) => { VARIANT_SET.add(p[0] + '|' + p[1]); VARIANT_SET.add(p[1] + '|' + p[0]); });
// 濁点/半濁点を外した“素のかな”（バッグ→バック の比較用）
function bareKana(c) { return c.normalize('NFD').replace(/[゙゚]/g, ''); }
function isVariantPair(a, b) {
  if (VARIANT_SET.has(a + '|' + b)) return true;
  // 濁点/半濁点だけの違い（ﾊﾞｯｸ↔ﾊﾞｯｸﾞ, ハ↔バ↔パ 等）は同一かなとみなす
  if (a !== b && /[぀-ヿ]/.test(a) && bareKana(a) === bareKana(b)) return true;
  return false;
}

function digitsOf(s) { return (String(s).match(/\d/g) || []).join(''); }

// 品番パターン: ハイフン+数字を含み長さ4+。AP-F15-11 / T-AP-F15-11 / R-12-N 等。
function isCodeLike(s) { return /-/.test(s) && /\d/.test(s) && s.length >= 4; }

// トークンが販売実績名に含まれるか。完全部分一致 or（3文字以上で“数字が同一”なら）異体字1字差まで許容。
//  → 「印篭型」↔「印籠型」等の漢字異体字・バック↔バッグ等の濁点ゆれは吸収するが、
//     「OK袋(50)」↔「OK袋(20)」「8号」↔「12号」「角中」↔「角小」のような
//     数字（サイズ/号数）・サイズ語の違いは別商品として弾き、取り違えを防ぐ。
//  数字始まりのトークン（5号 等）は「左隣が数字でない＝数字境界」を要求し、
//  「5号」が「15号」の一部に誤一致するのを防ぐ。
//  opts.hasAnchor=true（同じ品名内で品番アンカーが完全一致している）の時は、
//     長さ4+の他トークンについて「1文字 挿入/削除」のあいまい一致を許容。
//     (例)「内嵌合蓋」↔「内嵌合」の“蓋”有無を救う。数字内容が変わらない事を必須。
//  トークン自身が品番パターン(長さ5+)なら、アンカー無しでも 1文字 挿入/削除 を許容。
//     (例)「R-12-N」↔「-12-N」の R 有無を救う。
function tokenFound(t, recNorm, opts) {
  const hasAnchor = opts && opts.hasAnchor;
  const startsDigit = /^\d/.test(t);
  let from = 0, i;
  while ((i = recNorm.indexOf(t, from)) !== -1) {
    if (!startsDigit || i === 0 || !/\d/.test(recNorm[i - 1])) return true;
    from = i + 1;
  }
  if (t.length < 3) return false;
  const td = digitsOf(t);
  // あいまい一致は「同じ長さで1文字だけ違い、その差が“異体字/濁点ゆれ”」に限定。
  for (let j = 0; j + t.length <= recNorm.length; j++) {
    const sub = recNorm.substr(j, t.length);
    if (digitsOf(sub) !== td) continue;      // 数字が違えば別物とみなす
    if (startsDigit && j > 0 && /\d/.test(recNorm[j - 1])) continue; // 数字境界
    const pair = singleSubPair(t, sub);
    if (pair && isVariantPair(pair[0], pair[1])) return true;
  }
  // 1文字 挿入/削除 のあいまい一致（条件付き）。
  //  メーカー側に余分な1文字（蓋/Rなど）があり、販売実績側がそれ無しのケースを救う。
  //  ※「角中↔角小」（同長置換）はここに到達しない＝従来通り弾く。
  const selfCode = isCodeLike(t) && t.length >= 5;
  if ((hasAnchor && t.length >= 4) || selfCode) {
    for (let k = 0; k < t.length; k++) {
      const shorter = t.slice(0, k) + t.slice(k + 1);
      if (shorter.length < 3) continue;
      if (digitsOf(shorter) !== td) continue;     // 数字が変われば別物
      if (selfCode && !isCodeLike(shorter)) continue; // 品番→品番らしさを保つ
      if (recNorm.indexOf(shorter) !== -1) return true;
    }
  }
  return false;
}

// 「決定的トークン」: 商品の同一性を覆す違い（サイズ/部位/型番/数字）を示すもの。
//  これらがメーカー側にあって自社側にないなら、別商品の可能性が高い。
//   - 単一漢字: 蓋/身/大/中/小/特/丸/角/長 等（サイズ語・部位語・形状語）
//   - 数字を含むトークン: 0.4 / 28 / 11号 / 1500 等（サイズ/型番）
//   - 部位語(2文字以上): 本体/内嵌合蓋/内嵌合/巻き蓋/防曇蓋/嵌合蓋/内外蓋/高蓋/中皿
//     ※「本体↔内嵌合」のような部位違いを 名前一致 80% に化けないよう抑える。
//        tokenFound の 1文字 ins/del は「内嵌合蓋↔内嵌合」のような語幹一致を救うので
//        部位が同系統なら問題ない。完全に違う部位だけが criticalMiss に倒れる。
//  ※ 品番形式（ハイフン入り）は tokenFound の selfCode 内で 1文字 挿入/削除を救うので、
//     ここで弾いてもベースライン(オリカ9/9・朝日 hit45)は崩れない。
const PART_TOKENS = new Set([
  '本体', '内嵌合蓋', '内嵌合', '巻き蓋', '防曇蓋', '嵌合蓋',
  '内外蓋', '高蓋', '中皿', '部分内嵌合蓋', '部分内嵌合',
]);
function isCriticalToken(t) {
  if (/^[一-鿿]$/.test(t)) return true;
  if (/\d/.test(t)) return true;
  if (PART_TOKENS.has(t)) return true;
  // ラテン英字を含むトークンはシリーズ識別子(FP/MS/T-AP/DX/MFP/CF/AP/HS/T-/...)
  // の可能性が高く、自社側に無ければ別シリーズの可能性が高い。
  if (/[a-z]/i.test(t)) return true;
  return false;
}

// 色マーカー（価格一致ブーストで「同シリーズの色違い」を誤救済しないためのガード）。
//  単一漢字色 + カタカナ色を網羅。NFKC 正規化後のトークンに対して評価する。
//  ※ ここに入れた語は nameScore 本体には影響せず、価格ブースト適用判定でのみ参照する。
const COLOR_TOKENS = new Set([
  '白', '黒', '赤', '青', '緑', '紫', '黄', '茶', '桃', '銀', '金', '灰',
  'ピンク', 'ホワイト', 'ブラック', 'レッド', 'ブルー', 'グリーン',
  'パープル', 'イエロー', 'ブラウン', 'シルバー', 'ゴールド',
  'ベージュ', 'オレンジ', 'グレー', 'ネイビー', 'クリア', '透明',
]);
// 名前から色マーカーを抽出。tokenize ではなく文字列全体を走査する
//  （「【白】」や「ﾋﾟﾝｸ容器」のようにカッコや他語と連結したケースでも拾う）。
//  単一漢字色は前後が漢字でない時のみ＝「白菜」「青物」のような複合語を誤検出しない。
//  カタカナ色は前後が同種のカナでない時のみ＝「ブラックバスター」のような複合語を誤検出しない。
const COLOR_KANJI_RE = /([白黒赤青緑紫黄茶桃銀金灰])/g;
const COLOR_KANA_RE  = /(ピンク|ホワイト|ブラック|レッド|ブルー|グリーン|パープル|イエロー|ブラウン|シルバー|ゴールド|ベージュ|オレンジ|グレー|ネイビー|クリア|透明)/g;
// 漢字色とカタカナ色を同じ色として扱う正準化（黒=ブラック, 白=ホワイト 等）。
//  メーカーが「黒」・自社が「ブラック」のように表記が割れても色一致と判定できるように。
const COLOR_CANON = new Map([
  ['白', 'w'], ['ホワイト', 'w'], ['黒', 'k'], ['ブラック', 'k'], ['赤', 'r'], ['レッド', 'r'],
  ['青', 'b'], ['ブルー', 'b'], ['緑', 'g'], ['グリーン', 'g'], ['紫', 'p'], ['パープル', 'p'],
  ['黄', 'y'], ['イエロー', 'y'], ['茶', 'br'], ['ブラウン', 'br'], ['桃', 'pk'], ['ピンク', 'pk'],
  ['銀', 'sv'], ['シルバー', 'sv'], ['金', 'gd'], ['ゴールド', 'gd'], ['灰', 'gr'], ['グレー', 'gr'],
  ['ベージュ', 'bg'], ['オレンジ', 'or'], ['ネイビー', 'nv'], ['クリア', 'cl'], ['透明', 'cl'],
]);
function canonColor(c) { return COLOR_CANON.get(c) || c; }
function isKanji(c)  { return c && /[一-鿿]/.test(c); }
function isKatakana(c) { return c && /[ァ-ヿー]/.test(c); }
function colorMarkersIn(name) {
  const out = new Set();
  const s = nfkc(String(name || ''));
  for (const m of s.matchAll(COLOR_KANJI_RE)) {
    const prev = s[m.index - 1] || '', next = s[m.index + 1] || '';
    if (!isKanji(prev) && !isKanji(next)) out.add(canonColor(m[1]));
  }
  for (const m of s.matchAll(COLOR_KANA_RE)) {
    const prev = s[m.index - 1] || '', next = s[m.index + m[1].length] || '';
    if (!isKatakana(prev) && !isKatakana(next)) out.add(canonColor(m[1]));
  }
  return out;
}
// 両側に色マーカーがあって 1つも共有していなければ「色違い」と判定（ブースト不可）。
//  片側にしか色が無い場合は不確定 → ブースト許可（自社が色を書き忘れているケースに優しい）。
function colorMismatch(makerName, selfName) {
  const a = colorMarkersIn(makerName);
  const b = colorMarkersIn(selfName);
  if (!a.size || !b.size) return false;
  for (const t of a) if (b.has(t)) return false;
  return true;
}

// 名前一致スコア(%)：メーカー名のトークンのうち、販売実績名に含まれる割合。
//  事前に「品番アンカー」が rec に完全一致しているかを判定し、tokenFoundへ渡す。
//  ※ 決定的トークン(サイズ/部位/数字)が自社側にない場合、スコアは 50% に抑える
//    （= floor 60% 未満で休眠扱い）。「CF寿司容器L 0.4 蓋」が「CF寿司容器L 巻 蓋」
//    に 67% で誤マッチするような取り違えを防ぐ。
// 詳細版：{ raw=生の重なり率, score=抑制後, critical=抑制が効いたか, missedCrit=抑制原因の決定的語 }
//  価格判定側が「抑制原因が英字ブランド語だけか（英↔カナ表記差の可能性）」を見るため missedCrit を返す。
function nameScoreInfo(makerName, recNorm) {
  const toks = tokenize(makerName);
  if (!toks.length) return { raw: 0, score: 0, critical: false, missedCrit: [] };
  let hasAnchor = false;
  for (const t of toks) {
    if (isCodeLike(t) && recNorm.indexOf(t) !== -1) { hasAnchor = true; break; }
  }
  let hit = 0;
  const missedCrit = [];
  for (const t of toks) {
    if (tokenFound(t, recNorm, { hasAnchor })) hit++;
    else if (isCriticalToken(t)) missedCrit.push(t);
  }
  const raw = Math.round((hit / toks.length) * 100);
  const capped = missedCrit.length > 0 && raw < 100;
  return { raw, score: capped ? Math.min(raw, 50) : raw, critical: capped, missedCrit };
}
function nameScore(makerName, recNorm) { return nameScoreInfo(makerName, recNorm).score; }

// メーカー品番から、販売実績の文字列に埋め込まれていそうな候補キーを作る
//  例: 2AA5186-00 → [2aa518600, 2aa5186, aa518600, aa5186]
function codeCandidates(makerCode) {
  const alnum = String(makerCode || '').replace(/[^0-9A-Za-z]/g, '').toLowerCase();
  if (alnum.length < 4) return [];
  const set = new Set([alnum]);
  set.add(alnum.replace(/0+$/, ''));        // 末尾0群を除去 (…-00 等)
  const noLead = alnum.replace(/^\d+/, ''); // 先頭数字を除去 (2AA… → aa…)
  if (noLead.length >= 2) {
    set.add(noLead);
    set.add(noLead.replace(/0+$/, ''));
  }
  return [...set].filter((s) => s.length >= 4);
}

// 1レコードが CD一致するか。
//  英字を含む候補(len>=4) … その文字列がレコード名に含まれるだけでヒット（記号間でなくてもOK）
//  純数字の候補(len>=5)    … レコード名に含まれかつ前後が「英数字でない」（=単語境界）。
//   ※ 92988 が「（朝日ピッキング）92988※50 13」のように区切られて埋まる前提。
//   ※ 4桁純数字は誤一致が起きやすい（年号/サイズ/ロット数）ので未対応。
function codeHit(cands, recNorm) {
  for (const c of cands) {
    const hasAlpha = /[a-z]/.test(c);
    if (hasAlpha) {
      if (c.length >= 4 && recNorm.includes(c)) return true;
      continue;
    }
    if (c.length < 5) continue;
    let from = 0, i;
    while ((i = recNorm.indexOf(c, from)) !== -1) {
      const before = i === 0 || !/[\dA-Za-z]/.test(recNorm[i - 1]);
      const after = (i + c.length) === recNorm.length || !/[\dA-Za-z]/.test(recNorm[i + c.length]);
      if (before && after) return true;
      from = i + 1;
    }
  }
  return false;
}

// 自社商品コードの正規化：純数字は6桁ゼロ詰め（販売大臣 SHOHIN.CODE 形式に合わせる）。
//  例 62→000062 / 5071→005071。英数字混在はそのまま小文字化（前後空白除去）。
function padSelfCode(c) {
  const t = String(c == null ? '' : c).trim();
  if (!t) return '';
  return /^\d+$/.test(t) ? t.padStart(6, '0') : t.toLowerCase();
}
// 自社製造（メーカーコード9000＝日野折箱店）専用の照合。
//  取り込んだメーカー品番＝自社商品コードとして、販売実績の商品コードに「完全一致」で当てる。
//  ＝自社の折箱は過去伝票が発注先0000/別コードで切られており、仕入先フィルタ9000では全滅するため、
//    名前一致でもなく仕入先フィルタでもなく、自社コードの完全一致だけで確実に拾う。
//  1メーカー品 → 該当する全(得意先×自社商品)へ展開（販売実績は得意先×商品で集約済み＝1得意先1行）。
function matchSelf(item, hanbai) {
  const code = padSelfCode(item.makerCode);
  if (!code) return [];
  const best = new Map();
  for (const r of hanbai) {
    if (String(r.productCode == null ? '' : r.productCode).trim() !== code) continue;
    const key = (r.customerCode || '') + '' + (r.productCode || '');
    if (!best.has(key)) best.set(key, { rec: r, score: 1000, cd: true, ns: 100, link: false, self: true, pm: false });
  }
  return [...best.values()];
}

// 自社原単価 vs メーカー現単価 の一致判定（許容差 tol 以内なら true）。
// 両方とも 0 超でないと判定不能 → null（=「比較せず」、後段では false 同様にスルー）。
function pricesEqual(a, b, tol) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a <= 0 || b <= 0) return null;
  const diff = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
  return diff <= (Number.isFinite(tol) ? tol : 0.02);
}

// makerItem: { supplier, makerCode, makerName, currentCost, newCost, switchDate }
// hanbai:    parseHanbai() の配列（rec.purchaseCode は4桁ゼロ詰めの末尾仕入先コード）
// opts:
//   nameFloor=60 未満は「未一致(休眠)」扱い
//   productLinks={仕入先名:{自社CD:メーカー商品名}} 手動紐付け辞書。
//     - 自社CD が「このメーカー品」に予約済なら 100% 強制マッチ（仕入先コードフィルタを無視）。
//     - 自社CD が「別メーカー品」に予約済なら、その自社CDへの fuzzy マッチは除外。
//   purchaseCode='0029' 等 4桁文字列: 仕入先コードフィルタ。
//     - 自社販売実績の rec.purchaseCode と一致する行のみを照合候補にする。
//     - 例 大黒工業のメーカー見積(tag=0029) → 末尾29の自社品だけ。
//       問屋経由(末尾13)の同じ大黒製品は、朝日問屋(tag=0013)側の見積で拾う運用。
//     - 未設定(空文字列)なら従来通り全件候補（後方互換）。
//     - productLinks 行はフィルタを bypass（ユーザ明示の意思を優先）。
//   priceBoost=20 / priceTolerance=0.02:
//     - 自社原単価 ≒ メーカー現単価 のとき名前スコアに +N（上限100）。
//     - 67-79% で要確認に落ちていた真の組合せを 80%以上に押し上げる救済信号。
//     - 価格不一致や片方未設定でも減点はしない（後方互換）。
function matchOne(item, hanbai, opts = {}) {
  // 自社製造（メーカーコード9000＝日野折箱店）専用モード：自社コード完全一致だけで照合する。
  //  opts.selfMatch=true、または 仕入先コード(=opts.purchaseCode)が '9000' のとき有効。
  //  仕入先フィルタ・名前一致・価格判定はすべて使わない（自社品は名前にゴミが付き名前一致では拾えず、
  //  発注先コードも9000では切られていないため）。他メーカーの照合には一切影響しない。
  const selfMatch = opts.selfMatch === true || String(opts.purchaseCode || '').trim() === '9000';
  if (selfMatch) return matchSelf(item, hanbai);
  const nameFloor = Number.isFinite(opts.nameFloor) ? opts.nameFloor : 60;
  const priceBoost = Number.isFinite(opts.priceBoost) ? opts.priceBoost : 20;
  const priceTol   = Number.isFinite(opts.priceTolerance) ? opts.priceTolerance : 0.02;
  // 価格不一致のとき、この%未満の名前一致は別商品として休眠へ落とす（サイズ違い誤マッチ掃除）。
  const priceVetoBelow = Number.isFinite(opts.priceVetoBelow) ? opts.priceVetoBelow : 80;
  const cands = codeCandidates(item.makerCode);
  const supLinks = (opts.productLinks && opts.productLinks[item.supplier]) || {};
  const filterCode = String(opts.purchaseCode || '').trim();
  // 自社製造（9000分類）の自社CD集合。これらは「自社で作る品＝原価0」なので、他の仕入先の照合候補からは除外。
  //  例 008080「ﾄﾚｰ279-1」は自社製造分類だが過去伝票の発注先が0014(北原)のため、除外しないと北原の値上げ
  //  「トレー279-1」に名前一致して二重計上になる（自社製造品は9000側だけに出すのが正）。
  const excludeSelf = opts.excludeSelfCodes;
  // (得意先CD + 自社商品CD) ごとに最良の1件へ集約
  const best = new Map();
  for (const r of hanbai) {
    // 自社製造分類の自社CDは他の仕入先には出さない（名前一致・CD一致・手動紐付けすべてに優先して除外）
    if (excludeSelf && excludeSelf.size && excludeSelf.has(padSelfCode(r.productCode))) continue;
    // 手動紐付けチェック: その自社CDが他メーカー品に予約されているならスキップ（取り合い防止）
    const linkedMakerName = supLinks[r.productCode];
    const linkSelf = linkedMakerName && linkedMakerName === item.makerName;
    const linkOther = linkedMakerName && linkedMakerName !== item.makerName;
    if (linkOther) continue;
    // 仕入先コードフィルタ（productLinks の行は bypass する）
    if (filterCode && !linkSelf && r.purchaseCode && r.purchaseCode !== filterCode) continue;
    let cd, ns, isLink = false, raw = 0, brandOnlyMiss = false;
    if (linkSelf) {
      cd = false; ns = 100; isLink = true; // 100%紐付け扱い
    } else {
      cd = cands.length && codeHit(cands, r.codeNorm || r.norm);
      if (cd) { ns = 100; raw = 100; }
      else {
        const info = nameScoreInfo(item.makerName, r.coreNorm || r.norm);
        ns = info.score; raw = info.raw;
        // 抑制の原因が「英字を含み数字を含まない語」だけ＝英↔カナのブランド表記差の可能性
        //  （例 メーカー「Fresh+」↔ 自社「フレッシュプラス」）。サイズ/型番(数字含む)違いは含めないので
        //  WSR-110↔WSR-90 のような誤救済は起きない。
        brandOnlyMiss = info.critical && info.missedCrit.length > 0 &&
          info.missedCrit.every((t) => /[a-z]/i.test(t) && !/\d/.test(t));
      }
    }
    // 価格による判定（自社原単価 ≒ メーカー改定前単価）。CD一致/手動紐付けは高信頼なので対象外。
    //  ※「色違い」（両側に色があるが共有 0）は同シリーズで同価格になりやすいので加点しない。
    const pm = pricesEqual(r.origCost, item.currentCost, priceTol);
    const colorMis = pm === true && colorMismatch(item.makerName, r.productName);
    // 赤字販売ガード: 売値 < メーカー改定前単価 はほぼあり得ない → 弱い名前一致は別商品として除外。
    //  原単価が無く価格VETOが効かない行でも効く独立した保険。CD一致/手動は対象外。
    const belowCost = Number.isFinite(r.currentSell) && r.currentSell > 0 &&
      Number.isFinite(item.currentCost) && item.currentCost > 0 && r.currentSell < item.currentCost;
    let pmTag = false;
    if (!cd && !isLink) {
      if (belowCost && ns < priceVetoBelow) continue; // 赤字 × 弱い一致 → 除外
      if (pm === true && !colorMis) {
        // 価格一致：抑制原因が英字ブランド語だけなら抑制を解除して救済（英↔カナ表記差を救う）。
        //  それ以外はフロア超の名前一致にブースト（67-79%→80%以上＝見積書へ）。
        //  ※ サイズ/型番(数字)違いは raw を上げないので救済対象にならない＝誤マッチを生まない。
        if (brandOnlyMiss) ns = Math.min(100, raw + priceBoost);
        else if (ns >= nameFloor) ns = Math.min(100, ns + priceBoost);
        pmTag = true;
      } else if (pm === false && ns < priceVetoBelow) {
        // 価格不一致 ＝ 別商品の可能性大。しきい値未満の弱い名前一致（見積書に乗らない要確認ノイズ）は
        //   休眠へ落として掃除する。例「角小 ↔ 角特大(13.34 vs 約4)」のサイズ違い。
        continue;
      }
      // pm===null（片側でも単価が空）は従来どおり名前のみで判定（後方互換）。
      if (ns < nameFloor) continue;
    }
    const key = (r.customerCode || '') + '' + (r.productCode || '');
    const cur = best.get(key);
    const score = isLink ? 2000 : (cd ? 1000 : ns);
    if (!cur || score > cur.score) best.set(key, { rec: r, score, cd, ns, link: isLink, pm: pmTag });
  }
  const arr = [...best.values()];
  // 取り違え抑制：このメーカー品が CD一致／手動紐付け で特定の自社品に当たっているなら、
  //  「それ以外の自社品」への“名前だけ一致”は別サイズ/別品の取り違えとして落とす。
  //  ※同じ自社品の別得意先行（その得意先の伝票に品番が埋まっておらず名前一致になった等）は残す。
  //  例: メーカー品番3770661 は 005616(NM3=3770661)にCD一致。名前が似た 001374(実は3770660)への
  //      名前一致100% は誤りなので除外＝見積に001374が大黒価格で混入するのを防ぐ。
  const cdSelf = new Set(arr.filter((h) => h.cd || h.link).map((h) => h.rec.productCode));
  if (cdSelf.size) return arr.filter((h) => h.cd || h.link || cdSelf.has(h.rec.productCode));
  return arr;
}

// 全メーカー品を照合し、照合結果レコード配列を返す
function matchAll(items, hanbai, opts = {}) {
  const out = [];
  // 自社製造（メーカーコード9000）モードでは 仕入(原価)＝材料費なので 0 で扱う。
  //  取り込んだ「現単価」は販売単価の意味（＝下流では販売実績の現売単価をそのまま使う）であり、
  //  仕入原価ではないため、現行仕入単価・新仕入単価をどちらも 0 にする（値上げは得意先別で手入力）。
  const selfMode = opts.selfMatch === true || String(opts.purchaseCode || '').trim() === '9000';
  for (const item of items) {
    const hits = matchOne(item, hanbai, opts);
    const cCost = selfMode ? 0 : item.currentCost;
    const nCost = selfMode ? 0 : item.newCost;
    const costInc = (Number.isFinite(nCost) && Number.isFinite(cCost))
      ? nCost - cCost : NaN;
    const costRate = (Number.isFinite(costInc) && cCost > 0)
      ? Math.round((costInc / cCost) * 1000) / 10 : NaN;
    if (!hits.length) {
      out.push({
        status: '✗ 未一致（休眠）',
        supplier: item.supplier, switchDate: item.switchDate,
        makerCode: item.makerCode, makerName: item.makerName,
        productCode: '', productName: '【販売実績なし or 商品名不一致】', masterName: '',
        customerCode: '', customerName: '',
        currentSell: '', currentCost: cCost, newCost: nCost,
        costInc, costRate, annualAmount: '', lastDate: '',
      });
      continue;
    }
    for (const h of hits) {
      const r = h.rec;
      const pmTag = h.pm ? '+価格' : '';
      out.push({
        status: h.link ? ('📌 手動紐付け' + pmTag)
          : (h.self ? '✓ CD一致（自社品）'
            : (h.cd ? ('✓ CD一致' + pmTag) : ('✓ 名前一致(' + h.ns + '%)' + pmTag))),
        supplier: item.supplier, switchDate: item.switchDate,
        makerCode: item.makerCode, makerName: item.makerName,
        productCode: r.productCode, productName: r.productName, masterName: r.masterName || '',
        customerCode: r.customerCode, customerName: r.customerName,
        currentSell: r.currentSell, currentCost: cCost, newCost: nCost,
        costInc, costRate, annualAmount: r.annualAmount, lastDate: r.lastDate || '',
      });
    }
  }
  return out;
}

// 照合結果レコード → 既存パイプラインが読むCSV文字列（列は朝日形式準拠＋得意先コード）
const RESULT_HEADER = [
  '照合', '仕入先（メーカー）', '切替日', 'メーカー商品CD', 'メーカー商品名',
  '販売実績商品コード', '販売実績商品名', '商品名(マスタ)', '得意先コード', '得意先名',
  '現販売単価', '現行仕入単価', '新仕入単価', '仕入値上額', '仕入値上率(%)', '年間金額', '最終売上日',
];
function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  const lines = [RESULT_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      r.status, r.supplier, r.switchDate, r.makerCode, r.makerName,
      r.productCode, r.productName, r.masterName || '', r.customerCode, r.customerName,
      r.currentSell, r.currentCost, r.newCost,
      Number.isFinite(r.costInc) ? r.costInc : '', Number.isFinite(r.costRate) ? r.costRate : '',
      r.annualAmount, r.lastDate || '',
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

module.exports = { matchAll, matchOne, nameScore, codeCandidates, codeHit, tokenize, toCsv, RESULT_HEADER, padSelfCode };
