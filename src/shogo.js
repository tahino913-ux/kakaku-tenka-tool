// =====================================================================
//  照合の実行（CLI）：maker_quotes/ のメーカー見積 × 販売実績 → 照合結果CSV
//   出力: input/<仕入先>_照合結果_<日時>.csv（既存パイプラインがそのまま消費）
//
//  使い方:
//    node src/shogo.js                      … 既定どおり自動（販売実績は config.hanbai.path の最新）
//    node src/shogo.js <販売実績>            … 販売実績ファイルを指定
//    node src/shogo.js <メーカー見積CSV> <販売実績>  … 両方指定
//  ※ 販売実績が .XLS のときは Excel COM で自動CSV化（照合.bat 経由・ローカル限定）。
// =====================================================================
const fs = require('fs');
const path = require('path');
const { loadCsv } = require('./csv');
const { toNum } = require('./rules');
const { loadHanbai } = require('./hanbai');
const { matchAll, toCsv } = require('./match');
const { xlsToCsv, isXls } = require('./xls2csv');
const { convert: convertMakerXlsx } = require('./makerXlsx');
const { getSettings, getMakers } = require('./settings');

const ROOT = path.join(__dirname, '..');
const MAKER_DIR = path.join(ROOT, 'maker_quotes');
const INPUT_DIR = path.join(ROOT, 'input');

function stampAt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function stamp() { return stampAt(new Date()); }
// 出力ファイル名の衝突回避：1仕入先に複数のメーカー見積があると同じ秒に複数出力して
//  2本目が1本目を上書きする問題を防ぐ。既存/同一runの名前と被ったら1秒ずつ進める（HHMMSS6桁を維持）。
function uniqueOutPath(dir, supplier, used) {
  let d = new Date();
  for (;;) {
    const p = path.join(dir, sanitize(supplier) + '_照合結果_' + stampAt(d) + '.csv');
    if (!used.has(p) && !fs.existsSync(p)) { used.add(p); return p; }
    d = new Date(d.getTime() + 1000);
  }
}
function sanitize(s) {
  return String(s || '仕入先不明').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim() || '仕入先不明';
}

// フォルダなら中の最新 .XLS/.xlsx/.csv を、ファイルならそれ自体を返す
function resolveHanbaiSource(p) {
  if (!p) return null;
  let st;
  try { st = fs.statSync(p); } catch (e) { return null; }
  if (st.isFile()) return p;
  if (st.isDirectory()) {
    const cands = fs.readdirSync(p)
      .filter((f) => /\.(xlsx?|csv)$/i.test(f) && !/^~\$/.test(f))
      .map((f) => { const fp = path.join(p, f); return { fp, m: fs.statSync(fp).mtimeMs }; })
      .sort((a, b) => b.m - a.m);
    return cands.length ? cands[0].fp : null;
  }
  return null;
}

// メーカー見積CSV → matchAll に渡す items[]
function loadMakerQuote(csvPath) {
  const { records } = loadCsv(csvPath);
  const get = (r, names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };
  const items = [];
  for (const r of records) {
    const makerName = get(r, ['メーカー商品名', '商品名']);
    const makerCode = get(r, ['メーカー品番', 'メーカー商品CD', 'メーカー商品コード', '品番']);
    if (!makerName && !makerCode) continue;
    items.push({
      supplier: get(r, ['仕入先', '仕入先（メーカー）', 'メーカー']) || '仕入先不明',
      makerCode, makerName,
      currentCost: toNum(get(r, ['現単価', '現価格', '現行仕入単価', '現仕入単価'])),
      newCost: toNum(get(r, ['新単価', '新価格', '新仕入単価'])),
      switchDate: get(r, ['切替日', '実施日', '適用日']),
    });
  }
  return items;
}

// 案A：メーカー見積を「仕入先ごとに1本へ統合」する。
//  並べ替え用にファイルの新しさを返す（ファイル名の日時印 メーカー見積_<仕入先>_YYYYMMDD_HHMM(SS) を優先、無ければ更新時刻）。
function fileTimeOf(f) {
  const m = path.basename(f).match(/_(\d{8})_(\d{4,6})(?:\.csv)?$/i);
  if (m) return Number(m[1] + m[2].padEnd(6, '0'));
  try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; }
}
// 商品の同一判定キー：メーカー品番があれば品番、無ければ商品名（NFKC・空白除去・小文字）。
function makerProdKey(it) {
  const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  return (it.makerCode && String(it.makerCode).trim()) ? ('CD:' + norm(it.makerCode)) : ('NM:' + norm(it.makerName));
}
// 複数のメーカー見積CSVを「仕入先ごと」に統合（同じ商品は新しい取り込みで上書き＝後勝ち）。
//  戻り値: Map(仕入先 -> items[])。古い→新しい順に upsert するので、最新の改定（価格・実施日）が残る。
//  channelMap: { メーカー名: 実際に仕入れる問屋名 }。例 {"エフピコ":"朝日食品容器"}。
//    問屋経由で買うメーカー（中東xlsxのエフピコシート等）を、実際の仕入先（朝日）に寄せて二重計上を防ぐ。
function mergeMakerFiles(makerFiles, channelMap) {
  channelMap = channelMap || {};
  const bySupplier = new Map(); // supplier -> Map(prodKey -> item)
  const ordered = makerFiles.slice().sort((a, b) => fileTimeOf(a) - fileTimeOf(b));
  for (const mf of ordered) {
    let items;
    try { items = loadMakerQuote(mf); } catch (_) { items = []; }
    for (const it of items) {
      const raw = it.supplier || '仕入先不明';
      const supplier = channelMap[raw] || raw;            // メーカー→問屋に寄せる
      const item = (supplier === raw) ? it : Object.assign({}, it, { supplier }); // 下流の表示も問屋名に
      if (!bySupplier.has(supplier)) bySupplier.set(supplier, new Map());
      bySupplier.get(supplier).set(makerProdKey(item), item); // 後勝ち＝最新で上書き
    }
  }
  const res = new Map();
  for (const [sup, m] of bySupplier) res.set(sup, [...m.values()]);
  return res;
}

function run(argv) {
  const s = getSettings();
  const nameFloor = (s.hanbai && Number(s.hanbai.nameFloor)) || 60;
  // 価格不一致による除外しきい値＝見積書しきい値(matchThreshold)。これ未満（=要確認ノイズ）だけを掃除する。
  const priceVetoBelow = Number(s.matchThreshold) || 80;
  const productLinks = s.productLinks || {};

  // 引数解釈：拡張子で「メーカー見積(.xlsx/.csv)」か「販売実績(.xls)」かをざっくり判定
  const args = argv.slice(2);
  let makerArg = null, hanbaiArg = null;
  for (const a of args) {
    if (/\.xlsx$/i.test(a)) makerArg = a;       // 新Excelのメーカー見積
    else if (/\.xls$/i.test(a)) hanbaiArg = a;  // 旧Excelの販売実績(販売大臣)
    else if (/\.csv$/i.test(a)) { if (!makerArg && /maker|見積/i.test(a)) makerArg = a; else if (!hanbaiArg) hanbaiArg = a; else makerArg = a; }
  }
  // 引数が1つだけ(.csv)のときは販売実績扱い、と取り違えないよう：拡張子と既存場所で判断
  if (args.length === 1 && /\.csv$/i.test(args[0]) && fs.existsSync(path.join(MAKER_DIR, path.basename(args[0])))) {
    makerArg = args[0]; hanbaiArg = null;
  }

  // 販売実績の取得元。'db'=販売大臣SQL Server直結(読み取り専用) / 'auto'=DBが繋がれば直結・ダメならファイル
  //  / 'file'(既定)=従来どおりファイル(CSV/XLS)。引数で販売実績ファイルを明示した時は常にファイルを優先。
  //  ※ 'auto' は会社PC(DBあり)=直結／自宅PC(DBなし・Drive同期)=ファイル を1設定で両立させるため。
  const mode = (!hanbaiArg && s.hanbai && s.hanbai.source) || 'file';
  let hanbai = null;
  if (mode === 'db' || mode === 'auto') {
    try {
      console.log('販売実績を 販売大臣DB から直接取得中…（読み取り専用・書き込みなし）');
      const { loadHanbaiFromDb } = require('./db_hanbai');
      hanbai = loadHanbaiFromDb((s.hanbai && s.hanbai.db) || {});
      console.log('販売実績レコード: ' + hanbai.length + ' 件（DB: ' + ((s.hanbai.db && s.hanbai.db.database) || '') + '）');
    } catch (e) {
      if (mode === 'db') throw e; // 'db'(厳格)は失敗＝中断（古いファイルで黙って続行しない）
      console.log('⚠ DB直結に失敗→販売実績ファイルにフォールバックします: ' + String(e && e.message || e).split('\n')[0]);
      hanbai = null;
    }
  }
  if (hanbai === null) {
    const hanbaiSrc = resolveHanbaiSource(hanbaiArg || (s.hanbai && s.hanbai.path));
    if (!hanbaiSrc) {
      throw new Error('販売実績が見つかりません。config.js の hanbai.path を確認してください（指定: ' + ((s.hanbai && s.hanbai.path) || '未設定') + '）');
    }
    let hanbaiCsv = hanbaiSrc;
    if (isXls(hanbaiSrc)) {
      console.log('販売実績(.XLS)をCSVへ変換中… ' + path.basename(hanbaiSrc));
      hanbaiCsv = xlsToCsv(hanbaiSrc);
    }
    hanbai = loadHanbai(hanbaiCsv);
    console.log('販売実績レコード: ' + hanbai.length + ' 件（' + path.basename(hanbaiSrc) + '）');
  }

  // .xlsx のメーカー見積を maker_quotes/ のCSVへ展開（ドロップ→照合.bat だけで使える）
  const expandXlsx = (file) => {
    try {
      const sum = convertMakerXlsx(file, MAKER_DIR);
      for (const r of sum) {
        if (r.skipped) console.log('（スキップ）' + path.basename(file) + ' / シート「' + r.sheet + '」: ' + r.skipped);
        else console.log('取込: ' + path.basename(file) + ' → ' + r.file + '（' + r.items + ' 品）');
      }
      return sum.filter((r) => r.file).map((r) => path.join(MAKER_DIR, r.file));
    } catch (e) { console.log('（取込失敗）' + path.basename(file) + ': ' + (e && e.message || e)); return []; }
  };

  // メーカー見積の決定（指定が無ければ maker_quotes/ の全 .csv／.xlsx は自動展開）
  let makerFiles;
  if (makerArg) {
    const mp = path.isAbsolute(makerArg) ? makerArg : path.join(ROOT, makerArg);
    makerFiles = /\.xlsx$/i.test(mp) ? expandXlsx(mp) : [mp];
  } else {
    if (!fs.existsSync(MAKER_DIR)) { throw new Error('maker_quotes フォルダがありません。先にメーカー見積を取り込んでください。'); }
    for (const xf of fs.readdirSync(MAKER_DIR).filter((f) => /\.xlsx$/i.test(f) && !/^~\$/.test(f))) {
      expandXlsx(path.join(MAKER_DIR, xf));
    }
    makerFiles = fs.readdirSync(MAKER_DIR).filter((f) => /\.csv$/i.test(f)).map((f) => path.join(MAKER_DIR, f));
  }
  if (!makerFiles.length) { throw new Error('メーカー見積がありません（maker_quotes/ に .xlsx か .csv を置いてください）。'); }

  fs.mkdirSync(INPUT_DIR, { recursive: true });
  const makersProfile = getMakers() || {};
  const outFiles = [];
  const usedOut = new Set(); // 出力名の衝突回避（同一run内）
  // 案A：仕入先ごとに統合（同じ商品は最新の取り込みで上書き）してから1仕入先1本で照合・出力する。
  //  さらに makerChannel で「問屋経由のメーカー」を実際の仕入先に寄せる（エフピコ→朝日 等）＝二重計上の防止。
  const merged = mergeMakerFiles(makerFiles, s.makerChannel || {});
  for (const [supplier, items] of merged) {
    if (!items.length) continue;
    // 仕入先コードフィルタ: 各メーカー見積に紐づく 4桁仕入先コードを settings.makers から拾う。
    // 設定済なら自社末尾コードと一致する自社品だけが候補に。未設定なら従来通り全件候補。
    const purchaseCode = (makersProfile[supplier] && makersProfile[supplier].purchaseCode) || '';
    const rows = matchAll(items, hanbai, { nameFloor, productLinks, purchaseCode, priceVetoBelow });
    const matched = rows.filter((r) => /^✓/.test(r.status)).length;
    const dormant = rows.length - matched;
    const out = uniqueOutPath(INPUT_DIR, supplier, usedOut);
    fs.writeFileSync(out, toCsv(rows));
    outFiles.push(out);
    const tag = purchaseCode ? ' [仕入先=' + purchaseCode + ']' : ' [仕入先未設定]';
    console.log('✓ ' + supplier + tag + ': 統合メーカー品 ' + items.length + ' → 照合行 ' + rows.length + '（一致 ' + matched + ' / 休眠 ' + dormant + '）');
    console.log('   出力: input/' + path.basename(out));
  }
  console.log('\n完了。シミュレーション画面（sim.bat）で照合結果CSVを選んで見積書を出せます。');
  return outFiles;
}

if (require.main === module) {
  try { run(process.argv); }
  catch (e) { console.error('✗ ' + (e && e.message || e)); process.exit(1); }
}
module.exports = { run, loadMakerQuote, resolveHanbaiSource, mergeMakerFiles, makerProdKey, fileTimeOf };
