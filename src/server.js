// =====================================================================
//  価格転嫁 シミュレーション画面（ローカルサーバ・依存ゼロ）
//  Node標準の http のみ使用。sim.bat から起動 → ブラウザで操作。
//  ・メーカー改定額(改定後 仕入単価)を画面で上書きして試せる
//  ・転嫁ルールを全体／行ごとに切り替えて即時再計算
//  ・昨年の年間販売実績量(あれば実数, 無ければ推定)で年間影響額を集計
// =====================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');
const { loadAndNormalize } = require('./load');
const { calcRow, sen, senStr } = require('./rules');
const { loadPL } = require('./pl');
const { writeQuote } = require('./quoteXlsx');
const { writeXlsx } = require('./xlsx');
const { normName } = require('./textnorm');
const { IMPORT_PAGE } = require('./importPage');
const { LIST_PAGE } = require('./listPage');
const { SUPPLIERS_PAGE } = require('./suppliersPage');
const { SELF_PAGE } = require('./selfPage');
const { CUSTOMERS_PAGE } = require('./customersPage');
const { CDLINK_PAGE } = require('./cdlinkPage');
const { getSettings, saveSettings, isConfigured, getMakers, saveMakerProfile, getProductLinks, saveProductLink, getProductLinkMarkedAt, getSuppliers, saveSuppliers, getSelfProfile, saveSelfProfile, getCdReview, confirmCdLink, rejectCdLink, unconfirmCdLink, getExcludedCustomers, setExcludedCustomer, setExcludedCustomersBulk, listSettingsBackups, restoreSettingsBackup, getCustomerEmails, setCustomerEmail, verifyAccessPassword, getCostOverrides } = require('./settings');
const { mailQuotePdf } = require('./mailQuote'); // 見積書PDF化＋Outlook下書き（会社PCのExcel/Outlook COM）
const { run: runShogo, resolveHanbaiSource, loadHanbaiRecords, mergeMakerFiles, makerProdKey } = require('./shogo');
const ai = require('./ai'); // AI取り込みアシスト（任意・既定OFF。外部API送信はこのモジュールに隔離）
const { readXlsxBuffer } = require('./xlsxread');
const { detectColumns: detectMakerCols, normDate } = require('./makerXlsx');
const { loadCsv, decodeBuffer } = require('./csv');
const { xlsToCsv } = require('./xls2csv');
const { priceRowAnomaly } = require('./anomaly');
const { shouldExcludeByProductLink, isProductLinkActive, auditProductLinks, normalizeLinkCode, EXCLUDE_MARK, DORMANT_MARK, isExcludeLink, linkMarkKind } = require('./productLink');
const { auditBetterManualLinks, auditSuspectManualLinks } = require('./linkBetterAudit');
const { auditDormantRevival } = require('./dormantRevival');
const { auditRows: costAuditRows, toCsv: costAuditCsv, findDefault: findMasterCsv } = require('./costAudit');
const { auditRequote, padCode: padRequoteCode } = require('./requoteAudit');
const { buildHanbaiCsv } = require('./hanbai_export');
const { describeNoiseRow, isNoiseRow } = require('./noiserow');
const { getImportSkips, importSkipMap, lookupImportSkip, updateImportSkips, removeImportSkip } = require('./importSkip');
// 配信HTMLの版（/api/ping の rev と一致＝古いサーバが残っていないか確認用）
const SIM_PAGE_REV = '20260613b';
const { SHOGO_LOCK_CSS, SHOGO_LOCK_HTML, SHOGO_LOCK_JS } = require('./shogoLockUi');

// 照合の同時実行防止（DB読取・input/ 書き込みの競合を防ぐ）
let _shogoRunning = false;
function shogoStatusPayload() { return { running: !!_shogoRunning }; }
function runShogoGuarded(args) {
  if (_shogoRunning) {
    const err = new Error('照合が既に実行中です。完了までお待ちください。');
    err.code = 'SHOGO_BUSY';
    throw err;
  }
  _shogoRunning = true;
  try {
    return runShogo(args);
  } finally {
    _shogoRunning = false;
  }
}
function shogoBusyJson() {
  return { ok: false, busy: true, error: '照合実行中です。完了までお待ちください。' };
}
const { buildCostCsv } = require('./cost_export');
const { pruneInputCsv } = require('./pruneInput');
const os = require('os');

const RATE_CAUTION_PCT = 30; // 値上率がこの%以上の行は sim で黄色く注意表示（除外はしない・調整可）
const ROOT = path.join(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'input');
const OUTPUT_DIR = path.join(ROOT, 'output');
const MAKER_DIR = path.join(ROOT, 'maker_quotes');
const ISSUE_LOG_PATH = path.join(OUTPUT_DIR, '発行履歴.json'); // 得意先別 見積書の提出履歴（output/=Drive同期で両PC共有）
const PORT_START = 8765;

// 原子的書き込み：一時ファイル→rename で本体を置換（書込途中のクラッシュ/同期割り込みでJSONが壊れない）。失敗時は throw。
function writeJsonAtomicFile(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj == null ? {} : obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---- 見積書の提出（発行）履歴 -------------------------------------
//  { 得意先名: { lastIssuedAt(ISO), count, quoteNo, itemCount, folder } }
//  得意先ページで「提出済みが一目で分かる」ための記録。価格や照合には一切影響しない表示専用データ。
function readIssueLog() {
  try { return JSON.parse(fs.readFileSync(ISSUE_LOG_PATH, 'utf8') || '{}') || {}; }
  catch (e) { return {}; }
}
function writeIssueLog(log) {
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); writeJsonAtomicFile(ISSUE_LOG_PATH, log); return true; }
  catch (e) { return false; /* 記録失敗は発行自体を妨げない（呼び出し側で必要なら検知） */ }
}
// 発行した得意先ぶんを履歴へ反映（同じ得意先は最終提出で更新＋回数を加算）。
function recordIssuance(issued, folderName, atIso) {
  if (!issued || !issued.length) return;
  const log = readIssueLog();
  for (const it of issued) {
    const prev = log[it.customer] || {};
    log[it.customer] = {
      lastIssuedAt: atIso,
      count: (Number(prev.count) || 0) + 1,
      quoteNo: it.quoteNo || '',
      itemCount: it.itemCount || 0,
      folder: folderName || '',
    };
  }
  writeIssueLog(log);
}

// 提出済み見積の一覧（発行履歴＋ファイル有無）。得意先ページの「提出済一覧」モーダル用。
function buildIssuedQuotesList() {
  const log = readIssueLog();
  const items = [];
  const folderSet = {};
  for (const [customer, ent] of Object.entries(log)) {
    if (!ent) continue;
    const folder = String(ent.folder || '');
    const folderPath = folder ? path.join(OUTPUT_DIR, folder) : '';
    const filePath = folder ? findQuoteFile(folderPath, customer) : '';
    const row = {
      customer,
      lastIssuedAt: ent.lastIssuedAt || '',
      quoteNo: ent.quoteNo || '',
      itemCount: Number(ent.itemCount) || 0,
      count: Number(ent.count) || 1,
      folder,
      fileExists: !!filePath,
      folderExists: !!(folderPath && fs.existsSync(folderPath)),
    };
    items.push(row);
    if (folder) {
      if (!folderSet[folder]) folderSet[folder] = { folder, customers: 0, lastIssuedAt: '' };
      folderSet[folder].customers++;
      if (row.lastIssuedAt > folderSet[folder].lastIssuedAt) folderSet[folder].lastIssuedAt = row.lastIssuedAt;
    }
  }
  items.sort((a, b) => String(b.lastIssuedAt).localeCompare(String(a.lastIssuedAt)));
  const folders = Object.values(folderSet).sort((a, b) => String(b.lastIssuedAt).localeCompare(String(a.lastIssuedAt)));
  const totalItems = items.reduce((s, x) => s + (x.itemCount || 0), 0);
  return { items, count: items.length, folders, totalItems };
}
// 「この商品を他の得意先にいくらで提出したか」を 品目ステータス.json の発行済み(issued)から横断収集。
//  rowKey = 得意先仕入先商品キー。先頭の得意先を外した suffix(=仕入先商品キー) が一致＝同じ商品。
//  表示専用（価格・照合には一切無影響）。excludeCustomer はその得意先自身を一覧から除く（「他の」得意先のため）。
function buildCrossCustomerQuotes(rowKey, excludeCustomer) {
  const key = String(rowKey || '');
  const sep = key.indexOf('');
  if (sep < 0) return { items: [], stats: null };
  const suffix = key.slice(sep + 1); // 仕入先商品キー（得意先をまたいで同じなら同一商品）
  const map = readItemStatus();
  const items = [];
  for (const [customer, ent] of Object.entries(map)) {
    if (!ent) continue;
    if (excludeCustomer && customer === excludeCustomer) continue;
    for (const [rk, st] of Object.entries(ent)) {
      if (!st || st.s !== 'issued') continue; // 発行（提出）済みの確定単価だけが対象
      const s = rk.indexOf('');
      if (s < 0 || rk.slice(s + 1) !== suffix) continue;
      items.push({
        customer,
        sell: (st.sell != null && Number.isFinite(Number(st.sell))) ? Number(st.sell) : null,
        eff: String(st.eff || ''),
        at: String(st.at || ''),
        quoteNo: String(st.quoteNo || ''),
      });
    }
  }
  // 売価のある行で統計（最安/最高/平均）。並びは実施日（無ければ発行日時）の新しい順。
  const sells = items.map((x) => x.sell).filter((v) => Number.isFinite(v));
  const stats = sells.length
    ? {
        count: items.length, priced: sells.length,
        min: Math.min(...sells), max: Math.max(...sells),
        avg: Math.round((sells.reduce((a, b) => a + b, 0) / sells.length) * 100) / 100,
      }
    : { count: items.length, priced: 0, min: null, max: null, avg: null };
  items.sort((a, b) => String(b.eff || b.at).localeCompare(String(a.eff || a.at)));
  return { items, stats };
}
// 手動修正一覧（照合できずツール外で直した品の記録）。品目ステータス.json の s=manual を集める。
function buildManualCorrectionsList() {
  const map = readItemStatus();
  const items = [];
  for (const [customer, ent] of Object.entries(map)) {
    for (const [rowKey, st] of Object.entries(ent || {})) {
      if (!st || st.s !== 'manual') continue;
      items.push({
        customer, rowKey,
        supplier: st.supplier || '',
        productCode: st.productCode || '',
        productName: st.productName || '',
        matchStatus: st.matchStatus || '',
        currentSell: st.currentSell,
        newSell: st.sell,
        currentCost: st.currentCost,
        newCost: st.cost,
        effectiveDate: st.eff || '',
        note: st.note || '',
        registeredAt: st.at || '',
      });
    }
  }
  items.sort((a, b) =>
    String(a.customer).localeCompare(String(b.customer), 'ja') ||
    String(a.supplier).localeCompare(String(b.supplier), 'ja') ||
    String(a.productName).localeCompare(String(b.productName), 'ja'));
  return { items, count: items.length };
}
function escCsvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function buildManualCorrectionsCsv() {
  const { items } = buildManualCorrectionsList();
  const numOut = (v) => (v != null && Number.isFinite(Number(v)) ? String(v) : '');
  const hdr = '得意先,仕入先,商品コード,商品名,照合,現売単価,改定後売単価,現仕入単価,改定後仕入単価,実施日,備考,登録日時';
  const rows = items.map((it) => [
    it.customer, it.supplier, it.productCode, it.productName, it.matchStatus,
    numOut(it.currentSell), numOut(it.newSell), numOut(it.currentCost), numOut(it.newCost),
    it.effectiveDate, it.note, it.registeredAt,
  ].map(escCsvCell).join(','));
  return '\uFEFF' + hdr + '\r\n' + rows.join('\r\n');
}

// ---- 得意先別アイテムの状態（検討中／手動修正／提出済み）-------------------
//  { 得意先名: { rowKey: { s:'hold'|'manual'|'issued', at?, quoteNo?, sell?, cost?, eff?, note?, ... } } }
//  s='hold'（検討中）＝見積作成時にあとで考えたい品。見積から除外するが一覧に残す（一時待機場所）。
//  s='dormant'（休眠）＝この得意先では今は仕入れていない品。見積から除外。検討中と同じ挙動だが意味（バッジ）が違う＝
//    「あとで考える(hold)」ではなく「今は出さない(dormant)」。再照合しても rowKey で残る＝毎回チェックを外す手間が消える。
//  s='manual'（手動修正）＝照合できない品をツール外で直した記録。見積から除外し一覧で把握・CSV出力。
//  s='issued'（提出済み）＝発行済みで別枠へ。
//  価格・照合には無影響＝見積書に「載せる/載せない」と表示の振り分けだけ。output/=Drive同期で両PC共有。
const ITEM_STATUS_PATH = path.join(OUTPUT_DIR, '品目ステータス.json');
// 品目ステータスのプロセス内キャッシュ。calcAll/buildCalendar/calcByDate/buildCustomerCandidates 等が
//  1リクエストで何度も読む（同一ファイルを3回以上）。mtime が同じ間は再パースしない。
//  ・書き込み(writeItemStatus)で破棄＝読み取り側は常に最新を見る。
//  ・他PC(Drive同期)が更新→mtime変化で自動再読込。読み取り専用の利用ばかりなので参照共有でも安全。
let _itemStatusCache = null; // { mtimeMs, map }
function readItemStatus() {
  try {
    const st = fs.statSync(ITEM_STATUS_PATH);
    if (_itemStatusCache && _itemStatusCache.mtimeMs === st.mtimeMs) return _itemStatusCache.map;
    const map = JSON.parse(fs.readFileSync(ITEM_STATUS_PATH, 'utf8') || '{}') || {};
    if (repairMigratedHold(map)) {
      // 修復で書き直す＝mtimeが変わる。失敗時は「未保存の修復結果」をキャッシュしない。
      if (!writeItemStatus(map)) {
        _itemStatusCache = null;
        try { return JSON.parse(fs.readFileSync(ITEM_STATUS_PATH, 'utf8') || '{}') || {}; } catch (_) { return {}; }
      }
    }
    let mtimeMs = st.mtimeMs;
    try { mtimeMs = fs.statSync(ITEM_STATUS_PATH).mtimeMs; } catch (_) {}
    _itemStatusCache = { mtimeMs, map };
    return map;
  }
  catch (e) { return {}; }
}
// 旧移行バグで hold→issued になった品を検討中へ戻す（migratedFromHold フラグ付きのみ）。
function repairMigratedHold(map) {
  let dirty = false;
  for (const cust of Object.keys(map || {})) {
    const ent = map[cust];
    if (!ent) continue;
    for (const rk of Object.keys(ent)) {
      const st = ent[rk];
      if (!st || !st.migratedFromHold) continue;
      ent[rk] = { s: 'hold', at: st.at || new Date().toISOString() };
      dirty = true;
    }
  }
  return dirty;
}
function writeItemStatus(map) {
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); writeJsonAtomicFile(ITEM_STATUS_PATH, map || {}); _itemStatusCache = null; return true; }
  catch (e) { _itemStatusCache = null; return false; } // 失敗時もキャッシュ破棄＝未保存の変更を残さず次回ファイルから再読込
}
function manualStatusEntry(snap) {
  snap = snap || {};
  return {
    s: 'manual',
    at: new Date().toISOString(),
    sell: snap.newSell != null ? snap.newSell : snap.sell,
    cost: snap.newCost != null ? snap.newCost : snap.cost,
    eff: String(snap.effectiveDate || snap.eff || ''),
    note: String(snap.note || ''),
    productCode: String(snap.productCode || ''),
    productName: String(snap.productName || ''),
    supplier: String(snap.supplier || ''),
    currentSell: snap.currentSell,
    currentCost: snap.currentCost,
    matchStatus: String(snap.matchStatus || ''),
  };
}
// 検討中(hold)・手動修正(manual)のON/OFF・提出済み(issued)の解除。status=''で「対象に戻す」。
function setItemStatus(customer, rowKey, status, snap) {
  const map = readItemStatus();
  if (!customer || !rowKey) return map;
  if (status === 'manual') { if (!map[customer]) map[customer] = {}; map[customer][rowKey] = manualStatusEntry(snap); }
  else if (status === 'hold') { if (!map[customer]) map[customer] = {}; map[customer][rowKey] = { s: 'hold', at: new Date().toISOString() }; }
  else if (status === 'dormant') { if (!map[customer]) map[customer] = {}; map[customer][rowKey] = { s: 'dormant', at: new Date().toISOString() }; }
  else if (map[customer]) { delete map[customer][rowKey]; if (!Object.keys(map[customer]).length) delete map[customer]; }
  return writeItemStatus(map); // 保存成否(boolean)を返す＝APIが ok を判定できる
}
// 複数アイテムをまとめて変更（hold=検討中／dormant=休眠／manual=手動修正／''=対象へ戻す）。
//  status='' のときは hold・dormant・manual・issued のどれでも対象へ戻す。
//  items=[{rowKey,snapshot}] を渡すと手動修正時に単価等を保存（hold/dormant は rowKeys のみで可）。
function setItemStatusBulk(customer, rowKeys, status, items) {
  const map = readItemStatus();
  const list = Array.isArray(items) && items.length
    ? items
    : (Array.isArray(rowKeys) ? rowKeys.map((rk) => ({ rowKey: rk })) : []);
  if (!customer || !list.length) return { changed: 0 };
  let changed = 0;
  for (const it of list) {
    const rowKey = String((it && it.rowKey) || it || '').trim();
    if (!rowKey) continue;
    if (status === 'manual') {
      if (!map[customer]) map[customer] = {};
      map[customer][rowKey] = manualStatusEntry(it.snapshot || it);
      changed++;
    } else if (status === 'hold') {
      if (!map[customer]) map[customer] = {};
      map[customer][rowKey] = { s: 'hold', at: new Date().toISOString() };
      changed++;
    } else if (status === 'dormant') {
      if (!map[customer]) map[customer] = {};
      map[customer][rowKey] = { s: 'dormant', at: new Date().toISOString() };
      changed++;
    } else if (map[customer] && map[customer][rowKey]) { delete map[customer][rowKey]; changed++; }
  }
  if (map[customer] && !Object.keys(map[customer]).length) delete map[customer];
  const ok = writeItemStatus(map);
  return { changed, ok };
}
// 発行時に「対象だったアイテム」を提出済みへ（rowKey 単位）。
// 発行時に「対象だったアイテム」を提出済みへ（rowKey 単位）。発行に使った実施日(eff)も保存する＝
//  自社製造（切替日が空）でも、提出した見積の実施日を カレンダー／単価履歴CSV に反映できる。
//  items: [{ rowKey, effectiveDate }]（keep 行をそのまま渡す）。
function markItemsIssued(customer, items, quoteNo, atIso) {
  if (!customer || !items || !items.length) return;
  const map = readItemStatus();
  if (!map[customer]) map[customer] = {};
  // 見積書(xlsx)は売価を2桁丸め(r2)で出力するので、保存単価も同じ2桁丸めで揃える
  //  （生値のまま保存すると 品目ステータス.json／基幹CSV が見積書と最大¥0.01ズレる）。
  const r2 = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null;
  for (const it of items) {
    const k = it && it.rowKey; if (!k) continue;
    map[customer][k] = {
      s: 'issued', at: atIso, quoteNo: quoteNo || '', eff: String((it && it.effectiveDate) || ''),
      // 発行時の確定単価を保存＝手入力/価格帯別/行ルールで決めた見積書の単価をそのまま基幹CSV(単価履歴/仕入原価)へ反映。
      sell: r2(it && it.newSell),
      cost: r2(it && it.newCost),
    };
  }
  writeItemStatus(map);
}
// 提出済み(issued)だけを対象へ戻す（検討中 hold・手動修正 manual は残す）。customer 指定でその得意先のみ、無指定で全件。
//  「提出履歴をリセット（新サイクル）」「提出済みを取消」と歩調を合わせる。
function clearIssuedStatuses(customer) {
  const map = readItemStatus();
  const custs = customer ? [customer] : Object.keys(map);
  for (const c of custs) {
    if (!map[c]) continue;
    for (const k of Object.keys(map[c])) if (map[c][k] && map[c][k].s === 'issued') delete map[c][k];
    if (!Object.keys(map[c]).length) delete map[c];
  }
  writeItemStatus(map);
}

// ---- 入力CSVの読込キャッシュ（ファイル名+更新時刻で判定） ----------
const cache = new Map();
function listCsv() {
  if (!fs.existsSync(INPUT_DIR)) return [];
  return fs.readdirSync(INPUT_DIR).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
}
// 照合結果CSVは実行のたびに日時つきで増える。ドロップダウンには「仕入先ごとの最新1本」だけ出す。
//  命名規則 <仕入先>_照合結果_<YYYYMMDD>_<時刻>.csv に一致するものを仕入先で集約し、日時最大を採用。
//  規則に合わない手動配置CSV等はそのまま全て残す（利用者のファイルを隠さない）。
let _latestCsvCache = null; // { fp, files }
let _mergedMakerCache = null; // { fp, channelKey, map }
let _makerListCache = null; // { fp, items }

function dirCsvFingerprint(dir, pred) {
  if (!fs.existsSync(dir)) return '0';
  try {
    const names = fs.readdirSync(dir).filter(pred);
    let max = 0;
    for (const f of names) {
      try { const m = fs.statSync(path.join(dir, f)).mtimeMs; if (m > max) max = m; } catch (_) {}
    }
    return names.length + ':' + max;
  } catch (_) { return '0'; }
}
function inputDirFingerprint() {
  return dirCsvFingerprint(INPUT_DIR, (f) => f.toLowerCase().endsWith('.csv'));
}
function makerQuotesFingerprint() {
  return dirCsvFingerprint(MAKER_DIR, (f) => /\.csv$/i.test(f) && !f.startsWith('_'));
}
function makerListFingerprint() {
  const outFp = fs.existsSync(OUTPUT_DIR)
    ? dirCsvFingerprint(OUTPUT_DIR, (f) => /_見積書_/.test(f) || f.startsWith('得意先別_'))
    : '0';
  return makerQuotesFingerprint() + '|' + inputDirFingerprint() + '|' + outFp;
}
function getMergedMakerMap() {
  const channelMap = getSettings().makerChannel || {};
  const channelKey = JSON.stringify(channelMap);
  const fp = makerQuotesFingerprint();
  if (_mergedMakerCache && _mergedMakerCache.fp === fp && _mergedMakerCache.channelKey === channelKey) {
    return _mergedMakerCache.map;
  }
  let map = new Map();
  if (fs.existsSync(MAKER_DIR)) {
    const files = fs.readdirSync(MAKER_DIR).filter((f) => /\.csv$/i.test(f) && !f.startsWith('_'));
    map = mergeMakerFiles(files.map((f) => path.join(MAKER_DIR, f)), channelMap);
  }
  _mergedMakerCache = { fp, channelKey, map };
  return map;
}
function flattenedMergedMakerItems() {
  const merged = getMergedMakerMap();
  const out = [];
  if (merged instanceof Map) { for (const arr of merged.values()) out.push(...arr); }
  else if (Array.isArray(merged)) out.push(...merged);
  return out;
}
const _supplierMakerItemsCache = new Map();

// 取込ヒント用：全仕入先の merge を避け、当該仕入先の CSV だけ読む（初回の重さを軽減）。
function getMakerItemsForSupplier(supplier) {
  supplier = String(supplier || '').trim();
  if (!supplier) return [];
  const channelMap = getSettings().makerChannel || {};
  const fp = makerQuotesFingerprint() + '|' + JSON.stringify(channelMap);
  const hit = _supplierMakerItemsCache.get(supplier);
  if (hit && hit.fp === fp) return hit.items;
  const rawNames = new Set([supplier]);
  for (const [raw, ch] of Object.entries(channelMap)) {
    if (ch === supplier) rawNames.add(raw);
  }
  const files = [];
  if (fs.existsSync(MAKER_DIR)) {
    for (const f of fs.readdirSync(MAKER_DIR).filter((x) => /\.csv$/i.test(x) && !x.startsWith('_'))) {
      if (rawNames.has(extractSupplierFromMakerFile(f))) files.push(path.join(MAKER_DIR, f));
    }
  }
  const map = files.length ? mergeMakerFiles(files, channelMap) : new Map();
  const items = map.get(supplier) || [];
  _supplierMakerItemsCache.set(supplier, { fp, items });
  return items;
}

function invalidateMakerCaches() {
  _mergedMakerCache = null;
  _makerListCache = null;
  _supplierMakerItemsCache.clear();
}

function listLatestCsv() {
  const fp = inputDirFingerprint();
  if (_latestCsvCache && _latestCsvCache.fp === fp) return _latestCsvCache.files.slice();
  const latest = new Map(); // 仕入先 -> { file, stamp }
  const others = [];
  for (const f of listCsv()) {
    const m = f.match(/^(.+?)_照合結果_(\d{8})_(\d{4,6})\.csv$/i);
    if (!m) { others.push(f); continue; }
    const supplier = m[1];
    const stamp = m[2] + '_' + m[3].padEnd(6, '0'); // HHMM→HHMM00 に揃えて文字列比較できるように
    const cur = latest.get(supplier);
    // 同じ日時スタンプ（分単位など）で複数本あるときは、実ファイルの更新時刻が新しい方を採用。
    let mtime = 0; try { mtime = fs.statSync(path.join(INPUT_DIR, f)).mtimeMs; } catch (_) {}
    if (!cur || cur.stamp < stamp || (cur.stamp === stamp && cur.mtime < mtime)) latest.set(supplier, { file: f, stamp, mtime });
  }
  const picked = [...latest.values()].map((x) => x.file).sort((a, b) => a.localeCompare(b, 'ja'));
  const files = picked.concat(others.sort());
  _latestCsvCache = { fp, files };
  return files.slice();
}
function getRecs(file) {
  const full = path.join(INPUT_DIR, path.basename(file));
  if (!fs.existsSync(full)) throw new Error('ファイルが見つかりません: ' + file);
  const mtime = fs.statSync(full).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.recs;
  const { recs } = loadAndNormalize(full);
  applyCostOverrides(recs); // 自社CD別の原価強制（身＋蓋セット等で照合が拾えない原価を固定）
  cache.set(file, { mtime, recs });
  return recs;
}

// 自社CD別の「新仕入原価」上書きを記録へ反映（rec.newCost を置換）。
//  キーは6桁ゼロ埋め／素の数字／先頭ゼロ無し のどれでも引けるようにする（productLink と同じ寛容さ）。
//  原価だけを置換＝売価・粗利・値上額は下流の calcRow がこの newCost を起点に再計算する。
function applyCostOverrides(recs) {
  const ov = getCostOverrides();
  if (!ov || !Object.keys(ov).length) return recs;
  for (const rec of recs) {
    const raw = String(rec.productCode == null ? '' : rec.productCode).trim();
    if (!raw) continue;
    let v = ov[raw];
    if (v == null && /^\d+$/.test(raw)) { v = ov[raw.padStart(6, '0')]; if (v == null) v = ov[String(Number(raw))]; }
    if (v == null) continue;
    if (typeof v === 'object') {
      // { newCost, currentCost }：身＋蓋セット等で 新原価・現原価の両方を合算値へ揃える。
      if (Number.isFinite(Number(v.newCost))) rec.newCost = sen(Number(v.newCost));
      if (Number.isFinite(Number(v.currentCost))) rec.currentCost = sen(Number(v.currentCost));
    } else if (Number.isFinite(Number(v))) {
      rec.newCost = sen(Number(v)); // 数値＝新原価のみ強制（後方互換）
    }
  }
  return recs;
}

const fin = Number.isFinite;

// アップロードファイル(base64+filename)を解析して { records, headers } を返す共通ヘルパー。
//  .xlsx → xlsxread.readXlsxBuffer の最初の非空シートをそのまま grid → records 化
//  .xls/.XLS → 一時ファイル経由で Excel COM 変換 (xlsToCsv) → loadCsv
//  .csv → 一時ファイルに書き出して loadCsv（Shift_JIS/UTF-8 自動判定）
function readUploadedTableFile(b64, filename) {
  if (!b64) throw new Error('ファイル本体が空です');
  const buf = Buffer.from(b64, 'base64');
  const ext = (path.extname(String(filename || '')).toLowerCase()) || '';
  if (ext === '.xlsx') {
    const { sheets } = readXlsxBuffer(buf);
    const sh = sheets.find((s) => Array.isArray(s.grid) && s.grid.some((r) => r.some((c) => String(c || '').trim() !== '')));
    if (!sh) throw new Error('シートに有効な行がありません');
    const grid = sh.grid;
    const headers = (grid[0] || []).map((s) => String(s == null ? '' : s).trim());
    const records = [];
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const rec = {};
      for (let i = 0; i < headers.length; i++) rec[headers[i]] = row[i] == null ? '' : row[i];
      records.push(rec);
    }
    return { records, headers };
  }
  // .xls / .csv → temp file
  const safeExt = ext || '.bin';
  const tmpIn = path.join(os.tmpdir(), 'upload_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + safeExt);
  fs.writeFileSync(tmpIn, buf);
  try {
    let csvPath = tmpIn;
    if (ext === '.xls') csvPath = xlsToCsv(tmpIn);
    const { records, headers } = loadCsv(csvPath);
    if (csvPath !== tmpIn) { try { fs.unlinkSync(csvPath); } catch (_) {} }
    return { records, headers };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
  }
}

// 仕入先表形式の records から suppliers マップを生成（{ 4桁コード: {name, phone, address, ... } }）
function parseSuppliersFromRecords(records) {
  const out = {};
  for (const r of records) {
    const code = String(r['仕入先コード'] || r['コード'] || '').trim();
    if (!/^\d{1,6}$/.test(code)) continue;
    const padded = code.padStart(4, '0'); // 標準は4桁文字列
    const name1 = String(r['仕入先名１'] || r['仕入先名1'] || r['仕入先名'] || '').trim();
    const name2 = String(r['仕入先名２'] || r['仕入先名2'] || '').trim();
    out[padded] = {
      name: (name1 + (name2 ? ' ' + name2 : '')).trim(),
      phone: String(r['電話番号'] || '').trim(),
      fax: String(r['FAX番号'] || '').trim(),
      zip: String(r['郵便番号'] || '').trim(),
      address: (String(r['住所１'] || r['住所1'] || '').trim() + ' ' + String(r['住所２'] || r['住所2'] || '').trim()).trim(),
    };
  }
  return out;
}

// 自社商品名の構造化パース。
// 例: "CF寿司容器L0.4　華紋　身 （朝日ﾋﾟｯｷﾝｸﾞ） 92988 ※50 13"
//   → core: "CF寿司容器L0.4 華紋 身"   (商品名そのもの)
//     freight: "朝日ﾋﾟｯｷﾝｸﾞ"           (運賃条件・どの仕入先からの仕入れか)
//     supplierCode: "92988"             (仕入先商品コード＝メーカー品番が埋まっている)
//     lot: "50"                          (※発注ロット)
//     supplierId: "13"                   (末尾の仕入先コード)
function parseSelfName(name) {
  const s = String(name || '').trim();
  const empty = { productCode: '', core: '', packSize: '', freight: '', note: '', supplierCode: '', lot: '', supplierId: '' };
  if (!s) return empty;

  // 1) 先頭の自社商品コード (3-7桁数字 + 空白) を切り出す。
  //    /self プレビューが「セルの全文」を渡すケースで `07394 白楊...` を分解できるように。
  //    hanbai.js 経由の `r.productName` はコード除去済みなので無影響。
  let productCode = '', work = s;
  const pcM = s.match(/^[\s　]*(\d{3,7})[\s　]+/);
  if (pcM) { productCode = pcM[1]; work = s.slice(pcM[0].length); }

  // 2) 「運賃条件」のカッコを探す。
  //    注記カッコ (M25)/(D)/(V)/(ｴｺ)/(ﾎﾞ)/(黒) と区別するため、
  //    中身に 和字 (CJK/Hiragana/Katakana 半角全角) が3文字以上 を必須とする。
  //    例: 取得 → `（朝日ﾋﾟｯｷﾝｸﾞ）`(8) / `（5ｹｰｽ元払）`(5) / `（10ｹ元/未満800円）`(5)
  //        スキップ → `(M25)`(0) / `(D)`(0) / `(ﾎﾞ)`(2) / `（黒）`(1) / `（4.2）`(0)
  const PAREN_RE = /[（(]([^）)]*)[）)]/g;
  let freight = '', freightStart = -1, freightEnd = -1;
  let mm;
  while ((mm = PAREN_RE.exec(work)) !== null) {
    const inner = mm[1];
    const nonAscii = (inner.match(/[^\x00-\x7F]/g) || []).length;
    // 和字3字以上＝運賃条件、または「N円」を含む＝価格注記（関門形式 `（700円）`）も運賃扱い
    if (nonAscii >= 3 || /\d\s*円/.test(inner)) {
      freight = inner.trim();
      freightStart = mm.index;
      freightEnd = mm.index + mm[0].length;
      break;
    }
  }
  // 2b) 未閉じの運賃カッコ（大黒形式）。例: `... 100（大黒P1.5元未満800P別途300 3541548【...】 ※1200 29`
  //    閉じ「）」が無いため上の PAREN_RE では拾えない。開きカッコを左から走査し、
  //    「閉じ「）」が無い（＝未閉じ）」かつ「直後40字に運賃キーワードを含む」最初の1つを運賃開始とみなし、
  //    そこから末尾までを after として後段(入数/ロット/コード/仕入先ID)抽出に回す。
  //    ※ 全カッコを走査するので、短い注記カッコ（白）（透明）等が運賃カッコより前にあっても、
  //       それらは閉じカッコありで素通りし、未閉じの（大黒…だけを運賃として拾える。
  //    ※ キーワードは「未閉じカッコの中身」だけで判定する＝商品名側の ｹｰｽ/TP8 等には反応しない。
  if (freightStart < 0) {
    const FREIGHT_KW = /(元払|未満|ｹｰｽ|ケース|別途|送料|運賃|前払|着払|混載|大黒|ﾋﾟｯｷﾝｸﾞ|ﾋﾟｯｸ|円|[Pp]\d)/;
    const parenRe = /[（(]/g; let pm;
    while ((pm = parenRe.exec(work)) !== null) {
      const tail = work.slice(pm.index + 1);
      if (!/[）)]/.test(tail) && FREIGHT_KW.test(tail.slice(0, 40))) {
        freight = tail.replace(/[\s　]+/g, ' ').trim();
        freightStart = pm.index;
        freightEnd = pm.index; // 「（」以降すべてを after に含める（ロット/コード/仕入先IDがこの中にある）
        break;
      }
    }
  }

  let preF, after;
  if (freightStart >= 0) {
    preF = work.slice(0, freightStart).trim();
    after = work.slice(freightEnd).trim();
  } else {
    preF = work.trim();
    after = '';
  }

  // 3) 入数 (packSize) ：preF の末尾が「空白 + 1-5桁数字」なら切り出し。
  //    例 `白楊8寸...3点 100（10ｹ元/未満800円）` → core=`白楊8寸...3点`, packSize=`100`
  //    `T-AP-F22-19 内篏合蓋A-PET` のように末尾が数字でなければ素通し（packSize='').
  //    ※ 末尾数字を入数と断定するのは「運賃カッコが入数/運賃の指標語を含むとき」だけ。
  //       `（朝日ﾋﾟｯｷﾝｸﾞ）` のような“問屋名だけ”のカッコの前にある数字は、商品名の一部
  //       （サイズ等）の可能性が高いので core に残す（入数と誤認しない）。
  const QTY_KW = /(ｹｰｽ|ケース|ｹ|入|元|未満|別途|送料|運賃|前払|着払|混載|円|個|枚|本|袋|束|[Pp]\d|ﾊﾟｯｸ|ﾊﾟｯｸ|pc|ﾛｰﾙ)/;
  let packSize = '', core = preF.replace(/[\s　]+/g, ' ');
  if (freightStart >= 0 && QTY_KW.test(freight)) {
    const psM = core.match(/^(.+?)[\s　]+(\d{1,5})$/);
    if (psM) { core = psM[1].trim(); packSize = psM[2]; }
  }

  // 4) 注記 (note) ：after や preF の中の 「...」 『...』 [...] 角括弧の中身を全て集める。
  //    `「元払」` `『着払』` `[未満800円]` 等の補足情報。
  const noteRe = /[「『\[]([^」』\]]+)[」』\]]/g;
  const notes = [];
  let nm;
  while ((nm = noteRe.exec(after)) !== null) notes.push(nm[1].trim());
  while ((nm = noteRe.exec(preF)) !== null) notes.push(nm[1].trim());
  const note = notes.join(' / ');

  // 5) 仕入先商品コード (4-7桁) ：※ロット部分は先に除外してから抽出。
  //    `※5000` の 5000 を誤ってメーカー品番として拾わないように。
  const afterNoLot = after.replace(/※\s*\S+/g, '');
  const codeMatch = afterNoLot.match(/(\d{4,7})/);
  const supplierCode = codeMatch ? codeMatch[1] : '';

  // 6) ロット ：`※1000` の 1000、`※50` の 50 など。
  const lotMatch = after.match(/※\s*(\S+)/);
  const lot = lotMatch ? lotMatch[1] : '';

  // 7) 仕入先コード (末尾1-4桁数字) ：※ロット → 4-7桁コード → 各種括弧 の順で除去し、
  //    残った末尾の数字を拾う。
  //    ※ /※\s*\S+/ を先に走らせる理由：先に /\d{4,7}/g で `※5000 88` の 5000 を消すと
  //       `※ 88` が残り、その後の /※\s*\S+/ が `※ 88` を一気に消して 88 が失われるため。
  //    例: `92988 ※50 13`→`13` / `1124803 ※1000 88`→`88` / `未満ｹｰｽ800円 ※5000 88`→`88`
  const cleanedTail = after
    .replace(/※\s*\S+/g, '').replace(/\d{4,7}/g, '')
    .replace(/[（(][^）)]*[）)]/g, '').replace(/[「『\[][^」』\]]*[」』\]]/g, '').replace(/【[^】]*】/g, '')
    .replace(/\s+/g, ' ').trim();
  const sidMatch = cleanedTail.match(/(\d{1,4})\s*$/);
  const supplierId = sidMatch ? sidMatch[1] : '';

  return { productCode, core, packSize, freight, note, supplierCode, lot, supplierId };
}

// ---- 計算: 設定＋画面上の上書き値から全行を再計算し集計を返す --------
function calcAll(body) {
  const allRecs = getRecs(body.file);
  const globalRule = body.rule || { type: 'add_increase' };
  const rounding = body.rounding || getSettings().rounding;
  const upliftRate = Number(body.selfUplift);
  const selfCostUplift = { rate: Number.isFinite(upliftRate) ? upliftRate : 0 }; // 自社コスト上乗せ%
  const over = Array.isArray(body.rows) ? body.rows : null; // 行ごとの上書き(改定額/ルール)
  // 仕入先名（同一ファイル内は単一仕入先）— 商品紐付け辞書の引き当て・画面の「🏢 仕入先」表示に使う。
  //  レコードに makerSupplier が無いCSVもあるので、無ければファイル名の「<仕入先>_照合結果_…」から補完。
  let supplier = String((allRecs[0] && allRecs[0].makerSupplier) || '').trim();
  if (!supplier && body.file) supplier = String(body.file).split('_照合結果_')[0].trim();
  // 自社製造（メーカーコード9000＝日野折箱店）か。原価＝材料費で0扱い・既定は据置(keep_sell)で
  //  「値上げなのに同額」の要確認誤判定を避け（値上げは得意先別ページで手入力）、現単価は販売単価として扱う。
  const isSelfMade = String(((getMakers() || {})[supplier] || {}).purchaseCode || '').trim() === '9000';
  const links = ((getProductLinks() || {})[supplier]) || {};
  const itemStatusMap = readItemStatus(); // 各行の状態（提出済み/検討中）を 得意先別ページと同じ rowKey で引く（メイン表で提出済みを隠す等に使う）
  // 紐付けの取り合い防止：自社CDが「別メーカー品」に予約されている行は除外。
  //  紐付け名がずれていて見積にその名のメーカー品が無いときは行を残す（typo で一覧から消えない）。
  const recs = allRecs.filter((rec) => !shouldExcludeByProductLink(rec, links, allRecs));

  const excludedCust = getExcludedCustomers(); // 取引終了などで除外設定された得意先（画面・損益・見積から外す）
  const rows = recs.map((rec, i) => {
    const o = over && over[i] ? over[i] : {};
    // 自社製造(9000)は原価0固定（仕入＝材料費・現単価は販売単価扱いで原価には入れない）。
    //  ルールは全体設定(現売価×掛率 等)・行上書きをそのまま使う＝掛率での一括値上げや手入力ができる。
    //  原価0だと add_increase 既定では「値上げなのに同額」になるが、自社製造は誤りではないので
    //  下の priceWarning で自社製造を除外する（要確認に落とさない）。
    // 手入力の改定後仕入は銭(2桁)へ丸めて取り込む（rec.newCost は load 側で sen 済み＝表示・計算の端数を揃える）。
    const effNewCost = isSelfMade ? 0 : (fin(Number(o.newCost)) && o.newCost !== '' && o.newCost != null ? sen(Number(o.newCost)) : rec.newCost);
    const effRule = o.rule ? { type: o.rule, factor: globalRule.factor } : globalRule;
    const cfg = { default: effRule, overrides: [], rounding, selfCostUplift };
    const recForCalc = isSelfMade ? { ...rec, currentCost: 0, newCost: effNewCost } : { ...rec, newCost: effNewCost };
    const r = calcRow(recForCalc, cfg);
    // 紐付け辞書で確定済の (自社CD ⇔ メーカー商品名) なら ステータスを 「📌 手動紐付け」 に上書き
    const linkedSelf = isProductLinkActive(r, links, allRecs);
    const matchStatus = linkedSelf ? '📌 手動紐付け' : (r.matchStatus || '');
    const ps = parseSelfName(r.productName); // 自社商品名を構造化
    // 提出対象（得意先あり・一致）行だけ価格異常を判定（休眠/未一致は売単価が無くて当然なので対象外）
    const isQuoteRow = !!r.customerName && r.customerName !== '-' && !/未一致/.test(matchStatus);
    const priceWarning = isQuoteRow ? priceRowAnomaly(r.currentSell, r.newSell, r.ruleType, isSelfMade, r.currentCost, r.newCost) : '';
    // 値上率が大きい行の「注意」（エラーではない＝除外しない）。メーカーの値上げ幅が正しいかの確認喚起。
    //  メイン画面は照合・仕入コストの確認用なので、判定は「メーカー仕入(原価)の値上率」で行う。
    //  ※売価ベースだと自社の転嫁ルール次第で過剰に点灯し、メッセージ「メーカーの値上げ幅」とも食い違うため。
    //  自社製造(9000)は原価0なので currentCost>0 ガードで自動的に対象外（従来どおり要確認に落とさない）。
    let rateWarning = '';
    if (isQuoteRow && !priceWarning && fin(r.currentCost) && r.currentCost > 0 && fin(r.newCost)) {
      const upPct = (r.newCost / r.currentCost - 1) * 100;
      if (upPct >= RATE_CAUTION_PCT) rateWarning = 'メーカー仕入の値上率が大きい（' + upPct.toFixed(0) + '%）。メーカーの値上げ幅が正しいか確認';
    }
    // 得意先別ページと同じ rowKey で状態を引く（''=未提出/対象・hold=検討中・issued=提出済み）。
    //  メイン表で「見積書を作成した（提出済み）」行を隠すのに使う。
    const __pk = (r.productCode != null && String(r.productCode).trim() !== '') ? normName(String(r.productCode)) : ('名:' + normName(r.productName));
    const __rk = (r.customerName || '') + '' + supplier + '' + __pk;
    const itemStatus = ((itemStatusMap[r.customerName] || {})[__rk] || {}).s || '';
    return {
      itemStatus, selfMade: isSelfMade, // 自社製造(9000)＝発注先バッジは材料仕入先が出て紛らわしいので画面側で「🏭 自社製造」に置換
      supplier, // このメーカー見積の取り込み元（仕入先）＝行に常時持たせ、画面で「🏢 仕入先」を必ず出せるように
      customerName: r.customerName || '', customerCode: r.customerCode || '',
      productName: r.productName || '', productCode: r.productCode || '',
      productNameCore: (rec.masterName && String(rec.masterName).trim()) ? String(rec.masterName).trim() : ps.core, // DB直結時はマスタ商品名(クリーン)を優先＝1/120等のゴミを含まない
      supplierCode: ps.supplierCode, freight: ps.freight, lot: ps.lot, supplierIdEmbed: ps.supplierId,
      makerName: r.makerName || '', makerCode: rec.makerCode || '', matchStatus, priceWarning, rateWarning, costConflict: '',
      currentCost: sen(r.currentCost), newCost: sen(r.newCost), costIncrease: r.costIncrease, costIncreaseRate: r.costIncreaseRate,
      currentSell: r.currentSell, newSell: r.newSell, sellIncrease: r.sellIncrease,
      currentMarginRate: r.currentMarginRate, newMarginRate: r.newMarginRate,
      qty: r.qty, qtySource: r.qtySource, lastDate: rec.lastDate || '',
      annualCostImpact: r.annualCostImpact, annualSellImpact: r.annualSellImpact,
      annualSellCurrent: r.annualSellCurrent, annualSellNew: r.annualSellNew,
      ruleType: r.ruleType,
      switchDate: rec.switchDate || '',
      effectiveDate: (o.effectiveDate != null && String(o.effectiveDate).trim() !== '') ? String(o.effectiveDate).trim() : (rec.switchDate || ''),
    };
  }).filter((r) => !(r.customerName && excludedCust[r.customerName])); // 除外設定の得意先の行を外す（休眠/未一致は得意先が無いので残る）

  // ---- 同一メーカー品で新仕入が複数ある重複の検知（メーカー見積側のデータ誤り）----
  //  同じメーカー品（品番。無ければメーカー商品名）に新仕入が2種以上あると、見積書出力では
  //  片方が黙って採用される（例: 大黒テープ 品番2061740 が 1280/1450）。両方が値上げだと
  //  価格異常では拾えないので、ここで重複自体を検知して各行に印を付ける（要確認に出す）。
  //  ※「1つの自社商品に複数の別メーカー品が名前一致した取り合い」（白がピンクに当たる等）は
  //    別メーカー品＝別品番なのでここでは拾わない（dedup/色ガードが解決する別現象）。
  {
    const byMaker = new Map();
    for (const r of rows) {
      if (!r.customerName || r.customerName === '-' || /未一致/.test(r.matchStatus)) continue;
      const code = r.makerCode && String(r.makerCode).trim();
      const k = code ? ('CD:' + normName(String(r.makerCode))) : ('名:' + normName(r.makerName || ''));
      if (k === 'CD:' || k === '名:') continue;
      if (!byMaker.has(k)) byMaker.set(k, []);
      byMaker.get(k).push(r);
    }
    for (const list of byMaker.values()) {
      const costs = Array.from(new Set(list.map((r) => (fin(r.newCost) ? Number(r.newCost) : null)).filter((v) => v != null)));
      if (costs.length > 1) {
        const msg = '同一メーカー品で新仕入が複数（' + costs.join('/') + '）。メーカー見積の重複の可能性';
        for (const r of list) r.costConflict = msg;
      }
    }
  }

  // ---- 集計（数量のある行のみ年間値に寄与） ----
  let totalCostImpact = 0, totalSellImpact = 0;
  let sumCurSales = 0, sumCurProfit = 0, sumNewSales = 0, sumNewProfit = 0;
  let withQty = 0, estimated = 0;
  for (const r of rows) {
    if (fin(r.annualCostImpact)) totalCostImpact += r.annualCostImpact;
    if (fin(r.annualSellImpact)) totalSellImpact += r.annualSellImpact;
    if (fin(r.qty) && r.qty > 0) {
      withQty++;
      if (r.qtySource === 'estimated') estimated++;
      if (fin(r.annualSellCurrent)) { sumCurSales += r.annualSellCurrent; sumCurProfit += (r.currentSell - r.currentCost) * r.qty; }
      if (fin(r.annualSellNew)) { sumNewSales += r.annualSellNew; sumNewProfit += (r.newSell - r.newCost) * r.qty; }
    }
  }
  const summary = {
    count: rows.length, withQty, estimated,
    totalCostImpact, totalSellImpact, net: totalSellImpact - totalCostImpact,
    avgCurMargin: sumCurSales > 0 ? (sumCurProfit / sumCurSales) * 100 : NaN,
    avgNewMargin: sumNewSales > 0 ? (sumNewProfit / sumNewSales) * 100 : NaN,
    totalSellNow: sumCurSales, totalSellNew: sumNewSales,
  };
  // 紐付け編集UIの選択肢＝照合結果の名前だけでなくメーカー見積・登録済み紐付けも含める（変更先がリストに無い事故を防ぐ）
  const makerNames = supplier ? collectMakerNamesForSupplier(supplier) : Array.from(new Set(rows.map((r) => r.makerName).filter(Boolean))).sort();
  // 仕入先マスタも返却 → 行ごとの「発注先コード→名前」解決に使う
  const suppliers = getSuppliers();
  return { rows, summary, supplier, productLinks: links, makerNames, suppliers };
}

// calcAll の結果をファイル単位でキャッシュ（同一方針での再計算を省略＝メイン/得意先/損益で共有）。
let _calcAllResultCache = null; // { policyKey, byFile: Map }
function calcAllPolicyKey(body) {
  const rule = (body && body.rule) ? body.rule : { type: 'add_increase' };
  const rounding = (body && body.rounding) ? body.rounding : getSettings().rounding;
  const selfUplift = body ? body.selfUplift : 0;
  return JSON.stringify({ rule, rounding, selfUplift, files: listLatestCsv() });
}
function calcAllCached(body) {
  body = body || {};
  if (Array.isArray(body.rows) && body.rows.length) return calcAll(body); // 行上書き付き再計算はキャッシュしない
  const file = body.file;
  if (!file) return calcAll(body);
  const policyKey = calcAllPolicyKey(body);
  if (!_calcAllResultCache || _calcAllResultCache.policyKey !== policyKey) {
    _calcAllResultCache = { policyKey, byFile: new Map() };
  }
  if (_calcAllResultCache.byFile.has(file)) return _calcAllResultCache.byFile.get(file);
  const result = calcAll(body);
  _calcAllResultCache.byFile.set(file, result);
  return result;
}

// ---- 全仕入先 横断の損益インパクト集計 ---------------------------------
//  損益パネルは「全社」の影響を見るためのものなので、選択中の1ファイルだけでなく
//  input/ にある全仕入先の最新照合結果（=画面の「対象」ドロップダウンと同じ集合）を
//  同じ全体方針（ルール/端数/自社上乗せ%）で計算し、年間 仕入増・増収を合算して返す。
//  ※行ごとの上書き(改定額/行ルール)は表示中ファイル限定の試算なので、ここでは使わない（全体方針で統一）。
function impactAllSuppliers(body) {
  const files = listLatestCsv();
  const rule = body && body.rule ? body.rule : { type: 'add_increase' };
  const rounding = body && body.rounding ? body.rounding : getSettings().rounding;
  const selfUplift = body ? body.selfUplift : 0;
  let totalCostImpact = 0, totalSellImpact = 0, rowCount = 0, withQty = 0;
  const perSupplier = [];
  for (const f of files) {
    try {
      const r = calcAllCached({ file: f, rule, rounding, selfUplift });
      const s = r.summary || {};
      const tc = fin(s.totalCostImpact) ? s.totalCostImpact : 0;
      const ts = fin(s.totalSellImpact) ? s.totalSellImpact : 0;
      totalCostImpact += tc; totalSellImpact += ts;
      rowCount += (s.count || 0); withQty += (s.withQty || 0);
      perSupplier.push({ supplier: r.supplier || f, file: f, totalCostImpact: tc, totalSellImpact: ts, count: s.count || 0, withQty: s.withQty || 0 });
    } catch (e) {
      perSupplier.push({ file: f, error: String((e && e.message) || e) });
    }
  }
  return {
    totalCostImpact, totalSellImpact, net: totalSellImpact - totalCostImpact,
    supplierCount: perSupplier.filter((p) => !p.error).length, rowCount, withQty,
    perSupplier,
  };
}

// ---- 全仕入先 横断「★全部」表示 ---------------------------------------
//  input/ の各仕入先 最新CSVを calcAll で計算し、全行を1リストに連結して返す（メイン表の「★全部」用）。
//  各行に supplier（仕入先名）を付与＝どの仕入先のメーカー品かが分かる。
//  並べ替え（一致品を先頭・得意先別／休眠を末尾）はクライアント側 renderMainRows で行う。
//  ※calcAll と同じく全体方針（ルール/端数/自社上乗せ%）で計算。行ごとの上書きは扱わない（横断のため）。
function calcAllSuppliers(body) {
  const files = listLatestCsv();
  const rule = body && body.rule ? body.rule : { type: 'add_increase' };
  const rounding = body && body.rounding ? body.rounding : getSettings().rounding;
  const selfUplift = body ? body.selfUplift : 0;
  const rows = [];
  for (const f of files) {
    let data;
    try { data = calcAllCached({ file: f, rule, rounding, selfUplift }); } catch (e) { continue; }
    const sup = (data.supplier || (String(f).split('_照合結果_')[0]) || '').trim();
    for (const r of data.rows) rows.push(Object.assign({ supplier: sup }, r));
  }
  const suppliers = getSuppliers();
  // 紐付け辞書は仕入先ごとに異なる＝全部ビューでは行の matchStatus(📌) で確定判定するため空でよい。
  return { rows, summary: summarizeRows(rows), supplier: '', productLinks: {}, makerNames: [], suppliers, allView: true };
}

// 二重登録検知：同じ自社商品コードが複数の仕入先（最新照合結果）にまたがって一致登録されていないか。
//  例: 修正見積を別の仕入先名で取り込むと、同じ商品が2仕入先に出て損益/見積/CSVが二重になる。
//  戻り値: [{ code, name, suppliers:[...], prices:{supplier:newCost} }]（2仕入先以上に出た商品だけ）。
function crossSupplierDupCheck() {
  const files = listLatestCsv();
  const byCode = new Map(); // 自社CD -> { name, prices:{仕入先:新仕入} }
  for (const f of files) {
    const sup = String(f).split('_照合結果_')[0];
    let recs; try { recs = getRecs(f); } catch (e) { continue; }
    const seen = new Set(); // 同一ファイル内の同一コードは1回（得意先が複数でも1商品）
    for (const r of recs) {
      if (!/^[✓📌]/.test(r['照合'] || '')) continue;         // 一致行のみ（✓=CD/名前一致・📌=手動紐付け）
      const code = String(r['販売実績商品コード'] || '').trim();
      if (!code || /^0+$/.test(code) || seen.has(code)) continue; seen.add(code); // 全ゼロ(000000等)は実商品でない＝除外
      if (!byCode.has(code)) byCode.set(code, { name: String(r['販売実績商品名'] || '').replace(/\s+/g, ' ').slice(0, 28), prices: {} });
      const e = byCode.get(code); if (e.prices[sup] == null) e.prices[sup] = r['新仕入単価'];
    }
  }
  const dups = [];
  for (const [code, e] of byCode) {
    const sups = Object.keys(e.prices);
    if (sups.length > 1) dups.push({ code, name: e.name, suppliers: sups, prices: e.prices });
  }
  dups.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return dups;
}

// 「CD一致化 候補」＝今は名前一致で当たっているが メーカー品番がある行を集める。
//  そのメーカー品番を自社マスタ(商品名3)に登録すれば、次の照合で「CD一致（高精度）」に昇格できる。
//  各行: { supplier, selfCode(自社CD), selfName, makerCode(メーカー品番), makerName, pct(一致度%) }。
//  自社CD×メーカー品番 で重複排除。休眠でも品番がある行は自社CD不明なので件数だけ数える（人が確認）。
function buildCdCandidates() {
  const files = listLatestCsv();
  const review = getCdReview(); // 人が確定/却下したものは候補から消す
  const fileRecs = [];
  // 先に「既にCD一致しているメーカー品番」を集める＝その品番は正しい自社品に当たっている。
  //  同じ品番が別の自社品に名前一致しているのは“別サイズ/別品の取り違え”なので候補から除外する。
  //  例: 3770661 は 005616(NM3=3770661)にCD一致済み。001374(実は3770660)への名前一致100%は誤り＝出さない。
  const cdMakerCodes = new Set();
  for (const f of files) {
    let recs; try { recs = getRecs(f); } catch (e) { continue; }
    fileRecs.push({ sup: String(f).split('_照合結果_')[0], recs });
    for (const r of recs) { if (/CD一致/.test(r['照合'] || '')) { const mc = String(r['メーカー商品CD'] || '').trim(); if (mc) cdMakerCodes.add(mc); } }
  }
  const seen = new Set();
  const items = [];
  let dormantWithCode = 0;
  const dormantItems = []; // 品番ありなのに休眠（自社品が見つからない）＝手で探してNM3登録すべき筆頭
  const dormSeen = new Set();
  for (const { sup, recs } of fileRecs) {
    for (const r of recs) {
      const st = r['照合'] || '';
      const makerCode = String(r['メーカー商品CD'] || '').trim();
      const selfCode = String(r['販売実績商品コード'] || '').trim();
      if (/休眠|未一致/.test(st)) {
        if (makerCode) {
          dormantWithCode++;
          const dk = sup + '\x01' + makerCode;
          if (!dormSeen.has(dk)) {
            dormSeen.add(dk);
            dormantItems.push({ supplier: sup, makerCode, makerName: String(r['メーカー商品名'] || '').replace(/\s+/g, ' ').slice(0, 50) });
          }
        }
        continue; // 休眠＝自社CD不明
      }
      if (!/名前一致/.test(st)) continue; // CD一致・手動紐付けは確定済み＝対象外
      if (!makerCode || !selfCode || /^0+$/.test(selfCode)) continue;
      if (cdMakerCodes.has(makerCode)) continue; // その品番は既に正しい自社品にCD一致済み＝別品への取り違え候補なので除外
      if (review.confirmed[sup] && review.confirmed[sup][selfCode]) continue; // 確定済み(登録済み)は消す
      if (review.rejected[sup] && review.rejected[sup][selfCode + "|" + makerCode]) continue; // 却下済みは消す
      const key = selfCode + '' + makerCode;
      if (seen.has(key)) continue; seen.add(key);
      const m = st.match(/(\d+)\s*%/);
      items.push({
        supplier: sup, selfCode,
        selfName: String(r['販売実績商品名'] || '').replace(/\s+/g, ' ').slice(0, 40),
        makerCode,
        makerName: String(r['メーカー商品名'] || '').replace(/\s+/g, ' ').slice(0, 40),
        pct: m ? Number(m[1]) : '',
      });
    }
  }
  items.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja') || String(a.selfCode).localeCompare(String(b.selfCode)));
  dormantItems.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja') || String(a.makerCode).localeCompare(String(b.makerCode)));
  return { items, count: items.length, dormantWithCode, dormantItems };
}
// 品番ありなのに休眠（自社品が見つからない）メーカー品の一覧CSV（UTF-8 BOM）。
//  ＝「この品番の自社品は何？」を社内で探してマスタ(商品名3)に登録する作業リスト＝CD一致カバレッジを上げる起点。
function buildCdDormantCsv() {
  const { dormantItems } = buildCdCandidates();
  const cell = (v) => { const s = (v == null ? '' : String(v)); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['仕入先', 'メーカー品番', 'メーカー商品名', '対応する自社商品コード（記入）'];
  const lines = [head.join(',')];
  for (const it of dormantItems) lines.push([it.supplier, it.makerCode, it.makerName, ''].map(cell).join(','));
  return '﻿' + lines.join('\r\n');
}
// 候補をマスタ登録用CSV（UTF-8 BOM＝Excelで日本語が文字化けしない）に。商品コード＋メーカー品番が主役。
//  ※販売大臣の商品マスタ取込フォーマット（列名/SJIS要否）は実機で要確認。まずは確認・作業用の汎用CSV。
function buildCdCandidatesCsv() {
  const { items } = buildCdCandidates();
  const cell = (v) => { const s = (v == null ? '' : String(v)); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['商品コード', 'メーカー品番（商品名3へ登録）', '現商品名（参考）', '仕入先', '一致度%'];
  const lines = [head.join(',')];
  for (const it of items) lines.push([it.selfCode, it.makerCode, it.selfName, it.supplier, it.pct].map(cell).join(','));
  return '﻿' + lines.join('\r\n');
}
// 1つの自社商品コードが「複数の異なるメーカー品（品番）」に名前一致し、新仕入単価が食い違う品を検出。
//  ＝仕入原価CSV/単価履歴CSVがどれか1件を選ぶため「照合で取り込んだ単価と違う」と見える原因（取り違え）。
//  正しいメーカー品番を商品マスタ(商品名3)に登録してCD一致にすれば1つに確定する（CD一致/手動紐付け済みは確定＝対象外）。
//  戻り値: [{ code, name, variants:[{makerCode, makerName, cost, supplier}] }]（コストが2種以上のものだけ）。
function multiMatchCheck() {
  const files = listLatestCsv();
  const byCode = new Map(); // code -> { name, byMaker:Map(makerCode -> {makerCode, makerName, cost, supplier}) }
  for (const f of files) {
    const sup = String(f).split('_照合結果_')[0];
    let recs; try { recs = getRecs(f); } catch (e) { continue; }
    for (const r of recs) {
      if (!/名前一致/.test(r['照合'] || '')) continue; // CD一致・手動紐付けは確定＝対象外
      const code = String(r['販売実績商品コード'] || '').trim();
      if (!code || /^0+$/.test(code)) continue;
      const mc = String(r['メーカー商品CD'] || '').trim();
      const cost = String(r['新仕入単価'] || '').trim();
      const pm = String(r['照合'] || '').match(/(\d+)\s*%/);
      const pct = pm ? Number(pm[1]) : 0;
      if (!byCode.has(code)) byCode.set(code, { name: String(r['販売実績商品名'] || '').replace(/\s+/g, ' ').slice(0, 28), byMaker: new Map() });
      byCode.get(code).byMaker.set(mc, { makerCode: mc, makerName: String(r['メーカー商品名'] || '').replace(/\s+/g, ' ').slice(0, 24), cost, supplier: sup, pct });
    }
  }
  const out = [];
  for (const [code, e] of byCode) {
    const vs = [...e.byMaker.values()];
    // 単価は銭(2桁)へ正規化して比較＝17.11 と 17.112 を「同じ」と見なす（浮動小数の見かけ違いを誤検出しない）。
    const costs = new Set(vs.map((v) => senStr(v.cost)).filter((s) => s !== ''));
    if (vs.length > 1 && costs.size > 1) {
      // 推定：一致度%が最も高い候補を「正しい候補」のヒントに（同%なら先頭）。＝どれを商品名3に登録すべきかの当たり。
      let best = vs[0];
      for (const v of vs) if ((v.pct || 0) > (best.pct || 0)) best = v;
      const suggestCode = vs.filter((v) => (v.pct || 0) === (best.pct || 0)).length === 1 ? best.makerCode : '';
      out.push({ code, name: e.name, variants: vs, suggest: suggestCode, suggestName: suggestCode ? best.makerName : '' });
    }
  }
  out.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return out;
}
// 「単価不確定（複数メーカー品に一致）」の品を確認用CSV（UTF-8 BOM）に。1商品×候補ごとに1行。
//  ＝どの商品にどのメーカー品番候補が当たっているかを見て、正しい品番を商品名3に登録するための一覧。
function buildMultiMatchCsv() {
  const items = multiMatchCheck();
  const cell = (v) => { const s = (v == null ? '' : String(v)); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['商品コード', '現商品名', 'メーカー品番（候補）', 'メーカー商品名', '新仕入単価', '一致度%', '仕入先', '推定（一致度が最も高い候補）'];
  const lines = [head.join(',')];
  for (const it of items) for (const v of it.variants) lines.push([it.code, it.name, v.makerCode, v.makerName, v.cost, (v.pct || ''), v.supplier, (it.suggest && v.makerCode === it.suggest) ? '★ これが有力' : ''].map(cell).join(','));
  return '﻿' + lines.join('\r\n');
}

// 紐付けモーダル用：仕入先のメーカー商品名候補（照合結果＋メーカー見積＋登録済み紐付け）を集める。
function collectMakerNamesForSupplier(supplier) {
  const sup = String(supplier || '').trim();
  const names = new Set();
  if (!sup) return [];
  for (const f of listLatestCsv()) {
    if (String(f).split('_照合結果_')[0] !== sup) continue;
    let recs; try { recs = getRecs(f); } catch (e) { continue; }
    for (const r of recs) {
      const nm = String(r['メーカー商品名'] || '').trim();
      if (nm && nm !== '【販売実績なし or 商品名不一致】') names.add(nm);
    }
  }
  try {
    const merged = getMergedMakerMap();
    const items = merged.get(sup) || [];
    for (const it of items) {
      if (String(it.supplier || '').trim() !== sup) continue;
      const nm = String(it.makerName || '').trim();
      if (nm) names.add(nm);
    }
  } catch (e) { /* maker_quotes 無しでも続行 */ }
  const pl = (getProductLinks()[sup]) || {};
  for (const v of Object.values(pl)) {
    const nm = String(v || '').trim();
    if (nm) names.add(nm);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'ja'));
}

// 紐付けモーダル用：指定仕入先の「メーカー商品名の候補」と既存の手動紐付けを返す。
//  実施日フィルタ（横断）ビューでは行ごとに仕入先が違うので、行の仕入先でこれを引いて候補を出す。
function linkContext(supplier) {
  const sup = String(supplier || '').trim();
  const links = (getProductLinks()[sup]) || {};
  return { ok: true, supplier: sup, makerNames: collectMakerNamesForSupplier(sup), links };
}

// 手動紐付けの健全性チェック：表記ゆれ・古い紐付け・手動より確実な自動候補。
function buildProductLinkCheck() {
  const productLinks = getProductLinks();
  const matchRowsBySupplier = {};
  for (const f of listLatestCsv()) {
    const sup = String(f).split('_照合結果_')[0];
    let recs; try { recs = getRecs(f); } catch (e) { continue; }
    matchRowsBySupplier[sup] = recs;
  }
  const base = auditProductLinks(productLinks, matchRowsBySupplier);
  let makerItems = [];
  try { makerItems = flattenedMergedMakerItems(); } catch (e) { /* maker_quotes 無しでも続行 */ }
  let hanbai = [];
  try { hanbai = getHanbaiRecordsCached(); } catch (e) { /* DB/ファイル不可でも続行 */ }
  const better = auditBetterManualLinks(productLinks, makerItems, hanbai);
  const suspect = auditSuspectManualLinks(productLinks, makerItems, hanbai);
  // 💤休眠にした自社品に、その後 新しい売上が立った（取引再開＝復帰検討）を検知。
  //  販売実績(hanbai)の最終売上日 と 休眠にした日(markedAt) を突き合わせる。DB不可(閲覧モード)では hanbai が空＝0件で素通り。
  const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
  const revival = auditDormantRevival(productLinks, getProductLinkMarkedAt(), hanbai, { today, fallbackDays: 120 });
  const issues = [...base.issues, ...better.issues, ...suspect.issues, ...revival.issues].sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja')
    || String(a.code).localeCompare(String(b.code)));
  return {
    issues,
    count: issues.length,
    mismatchCount: base.mismatchCount,
    orphanCount: base.orphanCount,
    betterCount: better.count,
    betterCdCount: better.betterCdCount,
    betterNameCount: better.betterNameCount,
    suspectCount: suspect.count,
    revivalCount: revival.count,
  };
}

// 販売実績レコードのキャッシュ（自社品検索の連打で毎回DB/ファイルを読まないよう短時間キャッシュ）。
//  ※ 照合(shogo)は毎回フレッシュに読むのでこのキャッシュは「自社品検索」専用。force で破棄して読み直せる。
let _hanbaiCache = null; // { at, records }
// buildCustomerCandidates の「全CSV×calcAll→byCustomer」結果キャッシュ。
//  行まるめ/行ルール/手入力売価などは split 段だけ再実行＝再照合なしの再計算を高速化。
let _candRawCache = null; // { key, byCustomer, fileCount, errors, thr, baseMeta }
// 照合し直したら呼ぶ：自社品検索キャッシュ（5分TTL）と照合結果CSVキャッシュを破棄して次回フレッシュに読む。
function invalidateCaches() {
  _hanbaiCache = null;
  _candRawCache = null;
  _calcAllResultCache = null;
  _latestCsvCache = null;
  invalidateMakerCaches();
  try { cache.clear(); } catch (_) {}
}
// 「販売実績や照合結果CSVは変わらないが calcAll の結果に効く」変更（手動紐付け・得意先除外）のあとに呼ぶ軽量版。
//  販売実績(_hanbaiCache)やCSV一覧は破棄せず、計算結果キャッシュだけ捨てて即時に表示へ反映する。
function invalidateCalcCaches() {
  _candRawCache = null;
  _calcAllResultCache = null;
}
// DBが実際に到達できるか（source=db/auto のときだけ意味を持つ）。閲覧モード判定の土台。短時間キャッシュ。
//  source=file は「DBを使わない」設定なので常に true（DB可否は無関係）扱いにする。
let _dbProbeCache = null; // { at, ok }
function isDbReachable(force) {
  const s = getSettings();
  const mode = String((s.hanbai && s.hanbai.source) || 'file');
  if (mode !== 'db' && mode !== 'auto') return true; // ファイル方式＝DB不要
  // 成功は60秒（DBの一時断を早めに拾い直す）／失敗は5分（自宅PC等は当面DB不可＝重いprobe連発を避ける）。
  const ttl = (_dbProbeCache && _dbProbeCache.ok) ? 60 * 1000 : 5 * 60 * 1000;
  if (!force && _dbProbeCache && (Date.now() - _dbProbeCache.at) < ttl) return _dbProbeCache.ok;
  let ok = false;
  try { require('./db_hanbai').probeDbConnection((s.hanbai && s.hanbai.db) || {}); ok = true; }
  catch (e) { ok = false; }
  _dbProbeCache = { at: Date.now(), ok };
  return ok;
}
// 閲覧モード＝販売実績の取得元がDB(db/auto)なのに、このPCからDBへ到達できない（＝自宅PC等）。
//  input/ の照合結果CSVでの表示は可能だが、照合・DB抽出・自社品検索（DB必須）はできない。
function isViewOnly() {
  const s = getSettings();
  const mode = String((s.hanbai && s.hanbai.source) || 'file');
  if (mode !== 'db' && mode !== 'auto') return false;
  return !isDbReachable();
}
function getHanbaiRecordsCached(force) {
  const TTL = 5 * 60 * 1000; // 5分（DB読取は約1.5秒・ファイルも数秒かかるため）
  if (!force && _hanbaiCache && (Date.now() - _hanbaiCache.at) < TTL) return _hanbaiCache.records;
  // 閲覧モード（DB未到達）では自社品検索等は使えない。例外で画面を壊さず、空（or 直近キャッシュ）で続行する。
  if (!isDbReachable()) return _hanbaiCache ? _hanbaiCache.records : [];
  let records = [];
  try { records = loadHanbaiRecords({ settings: getSettings() }).records; } // ログは無音（UI用途）
  catch (e) { return _hanbaiCache ? _hanbaiCache.records : []; }
  _hanbaiCache = { at: Date.now(), records };
  return records;
}

// 得意先マスタ（得意先コード→{name, kana}）。DB直結時(source=db/auto)だけ TOKUI から読む（読み取り専用）。
//  ＝得意先ページで「コード表示」「カナ検索」に使う。ファイル方式/DB不可のときは空＝名前・コードのみで検索。
//  DB読取は重いので短時間キャッシュ（5分）。失敗しても画面は壊さない（空マップで続行）。
let _custMasterCache = null; // { at, map }
function getCustomerMasterMap(force) {
  const TTL = 5 * 60 * 1000;
  if (!force && _custMasterCache && (Date.now() - _custMasterCache.at) < TTL) return _custMasterCache.map;
  const map = {};
  try {
    const s = getSettings();
    const mode = String((s.hanbai && s.hanbai.source) || 'file');
    if (mode === 'db' || mode === 'auto') {
      const { loadCustomerMaster } = require('./db_hanbai');
      const dbCfg = Object.assign({}, (s.hanbai && s.hanbai.db) || {});
      for (const c of loadCustomerMaster(dbCfg)) { if (c.code) map[c.code] = { name: c.name, kana: c.kana }; }
    }
  } catch (e) { /* DB不可＝コード/カナ無しで続行（名前検索は効く） */ }
  _custMasterCache = { at: Date.now(), map };
  return map;
}

// 休眠（メーカー品が自社品に1つも当たっていない行）を手動で直すための「自社販売実績品の候補」。
//  メイン画面の休眠行に自社CDが無い＝従来は紐付けできなかった。ここで販売実績から自社CDの一覧を返し、
//  利用者が「このメーカー品＝この自社実績品」を選べるようにする（保存は既存の /api/product-link）。
//  戻り値: { ok, supplier, supplierPurchaseCode, count, products:[{code,name,purchaseCode,currentSell}] }（自社CDで重複排除）。
function selfProducts(supplier, force) {
  const sup = String(supplier || '').trim();
  const { coreName } = require('./hanbai');
  const recs = getHanbaiRecordsCached(force);
  const byCode = new Map(); // 自社CD -> 代表レコード（現売単価が最大＝主力得意先のものを残す）
  for (const r of recs) {
    const code = String(r.productCode || '').trim();
    if (!code) continue;
    const cur = byCode.get(code);
    const sell = fin(r.currentSell) ? r.currentSell : null;
    if (!cur || (sell != null && (cur.currentSell == null || sell > cur.currentSell))) {
      byCode.set(code, {
        code,
        name: (coreName(r.productName || '') || r.productName || '').replace(/\s+/g, ' ').trim(),
        purchaseCode: r.purchaseCode || '',
        currentSell: sell,
      });
    }
  }
  const makers = getMakers() || {};
  const supPC = (makers[sup] && makers[sup].purchaseCode) || '';
  const products = [...byCode.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return { ok: true, supplier: sup, supplierPurchaseCode: supPC, count: products.length, products };
}

// 行配列から損益サマリを作る（calcAll の summary と同じ式）。calc-by-date 用。
function summarizeRows(rows) {
  let totalCostImpact = 0, totalSellImpact = 0, sumCurSales = 0, sumCurProfit = 0, sumNewSales = 0, sumNewProfit = 0, withQty = 0, estimated = 0;
  for (const r of rows) {
    if (fin(r.annualCostImpact)) totalCostImpact += r.annualCostImpact;
    if (fin(r.annualSellImpact)) totalSellImpact += r.annualSellImpact;
    if (fin(r.qty) && r.qty > 0) {
      withQty++;
      if (r.qtySource === 'estimated') estimated++;
      if (fin(r.annualSellCurrent)) { sumCurSales += r.annualSellCurrent; sumCurProfit += (r.currentSell - r.currentCost) * r.qty; }
      if (fin(r.annualSellNew)) { sumNewSales += r.annualSellNew; sumNewProfit += (r.newSell - r.newCost) * r.qty; }
    }
  }
  return {
    count: rows.length, withQty, estimated,
    totalCostImpact, totalSellImpact, net: totalSellImpact - totalCostImpact,
    avgCurMargin: sumCurSales > 0 ? (sumCurProfit / sumCurSales) * 100 : NaN,
    avgNewMargin: sumNewSales > 0 ? (sumNewProfit / sumNewSales) * 100 : NaN,
    totalSellNow: sumCurSales, totalSellNew: sumNewSales,
  };
}

// 実施日で全仕入先 横断に絞り込んだ「通常の表」用の行＋サマリ。
//  date=YYYY-MM-DD。各仕入先 最新CSVを全体方針で計算し、提出対象（一致）かつ
//  実施日(正規化ISO)が一致する行だけを集めて返す（読み取り専用の横断ビュー）。
function calcByDate(body) {
  const date = String((body && body.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: '日付が不正です' };
  const rule = body && body.rule ? body.rule : { type: 'add_increase' };
  const rounding = body && body.rounding ? body.rounding : getSettings().rounding;
  const selfUplift = body ? body.selfUplift : 0;
  const files = listLatestCsv();
  const itemStatusMap = readItemStatus(); // 各行の進捗（提出済み/検討中）を 得意先別ページと同じ rowKey で引く
  const rows = [];
  const supSet = new Set();
  for (const f of files) {
    let res;
    try { res = calcAllCached({ file: f, rule, rounding, selfUplift }); } catch (e) { continue; }
    const sup = res.supplier || String(f).split('_照合結果_')[0] || '';
    for (const r of (res.rows || [])) {
      if (!r.customerName || r.customerName === '-' || /未一致/.test(r.matchStatus || '')) continue; // 休眠/未一致は除外
      // 得意先別ページの状態（''=未提出/対象・hold=検討中・issued=提出済み）を rowKey で引く。
      const prodKey = (r.productCode != null && String(r.productCode).trim() !== '') ? normName(String(r.productCode)) : ('名:' + normName(r.productName));
      const rowKey = r.customerName + '\u0001' + sup + '\u0001' + prodKey;
      const stEntry = (itemStatusMap[r.customerName] && itemStatusMap[r.customerName][rowKey]) || null;
      if (stEntry && stEntry.s === 'dormant') continue; // 休眠＝改定予定なし＝日付横断ビューにも出さない（カレンダーと整合）
      // 提出済みは発行時の実施日を優先（自社製造＝切替日なしでも、その日付で絞り込める）。
      const issuedEff = (stEntry && stEntry.s === 'issued' && stEntry.eff) ? stEntry.eff : '';
      const eff = normDateInput(issuedEff || r.effectiveDate || r.switchDate || '');
      if (eff !== date) continue;
      // 提出済みは発行時に確定した単価を採用し、年影響(損益)も再計算＝見積書・得意先別ページと一致させる
      //  （既定再計算のままだと、手入力/価格帯別/行ルールで決めた発行単価とカレンダー上の損益がズレる）。
      let row = r;
      if (stEntry && stEntry.s === 'issued') {
        row = Object.assign({}, r);
        if (stEntry.sell != null && Number.isFinite(Number(stEntry.sell))) row.newSell = Number(stEntry.sell);
        if (stEntry.cost != null && Number.isFinite(Number(stEntry.cost))) row.newCost = Number(stEntry.cost);
        if (fin(row.qty) && row.qty > 0) {
          if (fin(row.newSell) && fin(row.currentSell)) { row.sellIncrease = row.newSell - row.currentSell; row.annualSellImpact = row.qty * row.sellIncrease; row.annualSellNew = row.qty * row.newSell; }
          if (fin(row.newCost) && fin(row.currentCost)) { row.costIncrease = row.newCost - row.currentCost; row.annualCostImpact = row.qty * row.costIncrease; }
        }
        if (fin(row.newSell) && row.newSell > 0 && fin(row.newCost)) row.newMarginRate = ((row.newSell - row.newCost) / row.newSell) * 100;
      }
      rows.push(Object.assign({ supplier: sup, itemStatus: (stEntry && stEntry.s) || '' }, row)); // 行に仕入先＋進捗を付与
      supSet.add(sup);
    }
  }
  // 仕入先→得意先→商品名で安定ソート
  rows.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja') ||
    String(a.customerName).localeCompare(String(b.customerName), 'ja') ||
    String(a.productName).localeCompare(String(b.productName), 'ja'));
  // 進捗の内訳（提出済み／検討中／未提出）。カレンダー日付ビューの「どこまで進んだか」表示用。
  const statusCounts = { issued: 0, hold: 0, manual: 0, todo: 0 };
  for (const r of rows) {
    const s = r.itemStatus;
    if (s === 'issued') statusCounts.issued++;
    else if (s === 'hold') statusCounts.hold++;
    else if (s === 'manual') statusCounts.manual++;
    else statusCounts.todo++;
  }
  return { ok: true, date, rows, summary: summarizeRows(rows), count: rows.length, supplierCount: supSet.size, statusCounts };
}

// ---- 実施日カレンダー（全仕入先 横断）の集計 ---------------------------
// input/ の各仕入先 最新CSVを calcAll で計算し、提出対象（一致）行だけを
// {実施日, 得意先, 商品名, 仕入先} として集めて返す。価格は使わない（既定設定で計算）。
// 併せて 販売実績ファイル と 損益.csv の最終更新日も返し、月替わりの更新喚起に使う。
function fileFreshness(p) {
  try {
    const st = fs.statSync(p);
    const d = new Date(st.mtimeMs);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    return { exists: true, name: path.basename(p), mtime: d.toISOString(), ym };
  } catch (e) { return { exists: false, name: path.basename(p), mtime: null, ym: null }; }
}
function buildCalendar() {
  const files = listLatestCsv();
  const entries = [];
  const suppliers = [];
  const itemStatus = readItemStatus(); // 提出済みアイテムの実施日（自社製造＝切替日なしでも提出見積の実施日を反映）
  for (const f of files) {
    let data;
    try { data = calcAllCached({ file: f }); } catch (e) { continue; }
    const sup = (data.supplier || (String(f).split('_照合結果_')[0]) || '').trim();
    if (sup && !suppliers.includes(sup)) suppliers.push(sup);
    for (const r of data.rows) {
      if (!r.customerName || r.customerName === '-' || /未一致/.test(r.matchStatus || '')) continue; // 休眠/未一致＝改定なし
      // 得意先別ページと同じ rowKey で提出済みの実施日を引く。提出済みなら発行時の実施日を優先。
      const prodKey = (r.productCode != null && String(r.productCode).trim() !== '') ? normName(String(r.productCode)) : ('名:' + normName(r.productName));
      const rowKey = r.customerName + '' + sup + '' + prodKey;
      const st = (itemStatus[r.customerName] && itemStatus[r.customerName][rowKey]) || null;
      // 休眠＝「今は出さない（改定予定なし）」＝実施日カレンダーに並べない（未提出オレンジに混ざって要対応に見える誤解を防ぐ）。
      if (st && st.s === 'dormant') continue;
      const issuedEff = (st && st.s === 'issued' && st.eff) ? st.eff : '';
      entries.push({
        date: issuedEff || r.effectiveDate || r.switchDate || '',
        customer: r.customerName,
        product: r.productNameCore || (r.productName && r.productName !== '-' ? r.productName : '') || r.makerName || '(商品名なし)',
        supplier: sup,
        itemStatus: (st && st.s) || '', // ''=未提出/対象 / hold=検討中 / manual=手動修正 / issued=提出済み
      });
    }
  }
  // 照合エンジンが実際に使う販売実績の取得元（file / db / auto）と、ファイル方式時の新しさ
  let hanbai = { exists: false, name: null, mtime: null, ym: null };
  let hanbaiSource = 'file';
  try {
    const s = getSettings();
    hanbaiSource = String((s.hanbai && s.hanbai.source) || 'file');
    const resolved = resolveHanbaiSource((s.hanbai && s.hanbai.path) || '');
    if (resolved) hanbai = fileFreshness(resolved);
  } catch (e) { /* ignore */ }
  const pl = fileFreshness(path.join(ROOT, '損益.csv'));
  return { ok: true, entries, suppliers, hanbai, hanbaiSource, pl, viewOnly: isViewOnly() };
}

// ---- 提出用見積書の出力（画面設定を反映して得意先ごとに1ファイル） --
function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function jpDate() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function todayIso() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Excel日付シリアル(例 46133)→ ISO 'YYYY-MM-DD'。25569 = 1970-01-01 のシリアル値。
function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const d = new Date((n - 25569) * 86400 * 1000);
  if (isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
// 実施日が生のExcelシリアル(4-6桁・妥当範囲)なら日付に直す。それ以外はそのまま。
function normalizeEffDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4,6}$/.test(s)) { const n = Number(s); if (n >= 20000 && n <= 90000) { const iso = excelSerialToISO(n); if (iso) return iso; } }
  return s;
}
// 実施日の入力を「どの形式でも ISO(YYYY-MM-DD)」に揃える。
//  対応: 2026-07-01 / 2026/7/1 / 2026年7月1日 / 7月1日 / 7/1（年なしは当年）/ Excelシリアル / 全角。
//  解釈できない文字列はそのまま返す（入力をロックしない）。
function normDateInput(v) {
  let s = String(v == null ? '' : v).normalize('NFKC').trim();
  if (s === '') return '';
  const p2 = (n) => String(n).padStart(2, '0');
  if (/^\d{4,6}$/.test(s)) { const n = Number(s); if (n >= 20000 && n <= 90000) { const iso = excelSerialToISO(n); if (iso) return iso; } }
  let m = s.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/); // 年つき
  if (m) { const mo = Number(m[2]), da = Number(m[3]); if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return m[1] + '-' + p2(mo) + '-' + p2(da); }
  m = s.match(/(\d{1,2})\D{1,3}(\d{1,2})/); // 年なし → 当年
  if (m) { const mo = Number(m[1]), da = Number(m[2]); if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return new Date().getFullYear() + '-' + p2(mo) + '-' + p2(da); }
  return s;
}
// 実施日が「有効な日付（ISO YYYY-MM-DD）」かどうか。normDateInput は解釈不能な入力
//  （空・「未定」等）を ISO に揃えられないので、その判定に使う＝得意先ページの見積発行で実施日を必須にする。
function isValidEff(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // 形だけでなく「実在する日付」かを確認（2026-02-31 / 2026-99-01 等を弾く）。
  //  発行ゲートと基幹CSV(splitIsoDate)の不整合を防ぐ。
  const y = Number(s.slice(0, 4)), mo = Number(s.slice(5, 7)), da = Number(s.slice(8, 10));
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return false;
  const d = new Date(y, mo - 1, da);
  return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da;
}
// 売価の手入力を「クリーンな数値」に揃える。¥ / 円 / カンマ / 全角 / 余分な空白を除去。
//  数値にできなければ null（＝手入力なしとして扱い、ルール計算に戻す）。
function parsePriceInput(v) {
  const s = String(v == null ? '' : v).normalize('NFKC').replace(/[¥,\s円]/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function sanitizeName(s) {
  return String(s || '得意先不明').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim() || '得意先不明';
}
// 提出見積書のファイル名に使う「敬称付き得意先名」。必ず「様」を付ける（既に 様/御中/殿 で終わる場合は付けない）。
function honorificName(customer) {
  const base = sanitizeName(customer);
  return /(様|御中|殿)$/.test(base) ? base : base + '様';
}
// 提出見積書のファイル名（得意先名に「様」付き）。例: ホホエミ → 見積_ホホエミ様.xlsx
function quoteFileName(customer) {
  return '見積_' + honorificName(customer) + '.xlsx';
}
// フォルダ内の見積書ファイルの実パスを返す（様あり＝新名 を優先、様なし＝旧名 もフォールバック）。どちらも無ければ ''。
function findQuoteFile(folderPath, customer) {
  if (!folderPath) return '';
  const cands = [
    path.join(folderPath, quoteFileName(customer)),                 // 新: 見積_<得意先>様.xlsx
    path.join(folderPath, '見積_' + sanitizeName(customer) + '.xlsx'), // 旧: 見積_<得意先>.xlsx（過去に発行した分）
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return '';
}

// 照合の信頼度スコア（大きいほど信頼できる）: 手動紐付け > CD一致 > 名前一致(%) > その他
// ※ CD一致 = 仕入先(メーカー)商品コードでの一致。名前の類似より確実。
// ※ 手動紐付け = 利用者が settings.productLinks で確定したもの。最優先で見積書に乗せる。
function matchScore(status) {
  const s = String(status || '');
  if (/手動紐付け|📌/.test(s)) return 2000;
  if (/CD一致|ｺｰﾄﾞ一致|コード一致/.test(s)) return 1000;
  const m = s.match(/(\d+)\s*%/);
  return m ? Number(m[1]) : 0;
}
// メーカー名の語数（2文字以上のトークン数）＝品名の具体性の目安。多いほど具体的。
function makerTokenCount(name) {
  return String(name || '').split(/[\s　]+/).filter((t) => t.length >= 2).length;
}

// ---- メーカー見積の保存（貼り付け取り込み画面から）------------------
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// Excel由来の数値表現を整える（浮動小数の誤差を丸めた短い文字列に）
function cleanNum(v) {
  const s = String(v == null ? '' : v).normalize('NFKC').trim();
  if (s === '' || !/^-?[\d,]*\d/.test(s)) return s; // 文字混じりはそのまま（先頭が数字/カンマ区切り数字のみ処理）
  const n = parseFloat(s.replace(/,/g, '')); // 桁区切りカンマを除去（"1,234.5" → 1234.5）
  if (!Number.isFinite(n)) return s;
  // 容器仕入単価は銭（小数2桁）が基準（2.549999999 → 2.55）
  return senStr(n);
}

// 取り込んだ表の「切替日（日付シリアル）」「現/新単価（浮動小数誤差）」を見やすい値に直す。
// 列はメーカー見積の見出しから自動検出（makerXlsx.detectColumns）。検出できない時は素通り。
function normalizeMakerGrid(grid) {
  if (!Array.isArray(grid) || !grid.length) return grid;
  const idx = detectMakerCols(grid);
  if (idx) {
    for (let r = idx.headerRow + 1; r < grid.length; r++) {
      const row = grid[r]; if (!Array.isArray(row)) continue;
      if (idx.date != null && row[idx.date] != null && row[idx.date] !== '') row[idx.date] = normDate(row[idx.date]);
      if (idx.cur  != null && row[idx.cur]  != null && row[idx.cur]  !== '') row[idx.cur]  = cleanNum(row[idx.cur]);
      if (idx.nw   != null && row[idx.nw]   != null && row[idx.nw]   !== '') row[idx.nw]   = cleanNum(row[idx.nw]);
    }
    return grid;
  }
  // 見出し自動検出に失敗しても、列名から現・新単価らしき列を推定して銭丸め
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const head = grid[r]; if (!Array.isArray(head)) continue;
    const cols = [];
    head.forEach((h, i) => {
      const t = String(h || '').normalize('NFKC').toLowerCase();
      if (/(新単価|新価格|改定後|改定単価)/.test(t)) cols.push(i);
      else if (/(現単価|現行|旧単価|現価)/.test(t)) cols.push(i);
      else if (/(単価|価格|仕入)/.test(t)) cols.push(i);
    });
    if (!cols.length) continue;
    for (let ri = r + 1; ri < grid.length; ri++) {
      const row = grid[ri]; if (!Array.isArray(row)) continue;
      for (const ci of cols) {
        if (row[ci] != null && row[ci] !== '') row[ci] = cleanNum(row[ci]);
      }
    }
    break;
  }
  return grid;
}

// 取り込み済みメーカー見積CSVの一覧と進捗（照合済み・見積書作成済み）を返す
function sanitizeForFs(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim(); }
function extractSupplierFromMakerFile(filename) {
  // 例: メーカー見積_朝日食品容器_20260526_1246.csv  /  エフピコ.csv
  // stamp は YYYYMMDD_HHMM (or HHMMSS) なので時刻部分は 4 or 6 桁を許容
  const base = filename.replace(/\.[^.]+$/, '');
  const m = base.match(/^メーカー見積_(.+?)_\d{8}_\d{4,6}$/);
  return m ? m[1] : base;
}
function countCsvDataRows(fullPath) {
  try {
    const txt = decodeBuffer(fs.readFileSync(fullPath)).replace(/^﻿/, ''); // 文字コード自動判定（Shift_JIS等でも行数が狂わない）
    const lines = txt.split(/\r?\n/).filter((l) => l.trim() !== '');
    return Math.max(0, lines.length - 1); // ヘッダー1行を除く
  } catch (e) { return 0; }
}
function listMakerQuotes() {
  const listFp = makerListFingerprint();
  if (_makerListCache && _makerListCache.fp === listFp) return _makerListCache.items;
  if (!fs.existsSync(MAKER_DIR)) return [];
  const csvs = fs.readdirSync(MAKER_DIR).filter((f) => /\.csv$/i.test(f));
  const inputFiles  = fs.existsSync(INPUT_DIR)  ? fs.readdirSync(INPUT_DIR)  : [];
  const outputItems = fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR) : [];
  const makers = getMakers() || {};
  const suppliers = getSuppliers() || {};

  // 仕入先ごとにソースCSVをまとめる（paste-import で同じ仕入先が複数CSVになっても1行に集約）
  const bySupplier = new Map();
  for (const f of csvs) {
    const full = path.join(MAKER_DIR, f);
    let mtimeMs = 0; try { mtimeMs = fs.statSync(full).mtimeMs; } catch (e) {}
    const supplier = extractSupplierFromMakerFile(f);
    if (!bySupplier.has(supplier)) bySupplier.set(supplier, []);
    bySupplier.get(supplier).push({ file: 'maker_quotes/' + f, mtimeMs, count: countCsvDataRows(full) });
  }

  const items = [];
  for (const [supplier, sources] of bySupplier) {
    sources.sort((a, b) => b.mtimeMs - a.mtimeMs);  // 新しい順
    const sup = sanitizeForFs(supplier);
    const matchFiles = inputFiles
      .filter((n) => n.startsWith(sup + '_照合結果_') && /\.csv$/i.test(n))
      .sort(); // ファイル名末尾の時刻スタンプ昇順 → 末尾が最新
    const quoteFolders = outputItems
      .filter((n) => n.startsWith(sup + '_照合結果_') && /_見積書_/.test(n))
      .sort();
    // ステータスは「最新照合に対する見積書」基準。古い見積書しか無いケースを見積書済みと誤判定しない
    const latestMatch = matchFiles[matchFiles.length - 1] || null;
    let status = '取り込みのみ';
    if (latestMatch) {
      const latestBase = latestMatch.replace(/\.csv$/i, '');
      const hasFreshQuote = quoteFolders.some((n) => n.startsWith(latestBase + '_見積書_'));
      status = hasFreshQuote ? '見積書作成済み' : '照合済み';
    }
    // 取込CSV(最新) の mtime が 最新照合 の mtime より新しい場合は「再照合が必要」。
    // 60秒の余裕を見るのは、照合.bat が xlsx を自動展開→直後に照合する流れで mtime が
    // ほぼ同時刻になるため。明確に「ユーザが取り込み直したのに照合してない」だけを拾う。
    let needsRematch = false;
    if (latestMatch) {
      try {
        const matchMtime = fs.statSync(path.join(INPUT_DIR, latestMatch)).mtimeMs;
        if (sources[0].mtimeMs > matchMtime + 60_000) needsRematch = true;
      } catch (e) {}
    }
    // 仕入先コード（4桁）と マスタ上の社名
    const purchaseCode = (makers[supplier] && makers[supplier].purchaseCode) || '';
    const purchaseName = (purchaseCode && suppliers[purchaseCode] && suppliers[purchaseCode].name) || '';
    items.push({
      supplier,
      file: sources[0].file, // 代表は最新ソース
      sources,               // 全ソースCSV（複数取り込みの可視化）
      importedAt: sources[0].mtimeMs ? new Date(sources[0].mtimeMs).toISOString() : null,
      count: sources.reduce((s, x) => s + (x.count || 0), 0),
      matchFiles, quoteFolders, status, needsRematch, latestMatch,
      purchaseCode, purchaseName,
    });
  }
  items.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
  _makerListCache = { fp: listFp, items };
  return items;
}

// 取込画面用：この仕入先が既に maker_quotes にあるか＋（任意）今回の表とのキー重複を返す。
function buildMakerImportHint(supplier, previewItems) {
  supplier = String(supplier || '').trim();
  if (!supplier) return { hasExisting: false };
  const savedSkipCount = getImportSkips(supplier).length;
  const listed = listMakerQuotes().find((x) => x.supplier === supplier);
  if (!listed) return { hasExisting: false, supplier, savedSkipCount };
  const res = {
    hasExisting: true,
    supplier,
    importedAt: listed.importedAt,
    count: listed.count,
    sourceCount: (listed.sources || []).length,
    status: listed.status,
    needsRematch: !!listed.needsRematch,
    savedSkipCount: getImportSkips(supplier).length,
  };
  const items = Array.isArray(previewItems) ? previewItems : [];
  if (items.length) {
    const existing = getMakerItemsForSupplier(supplier);
    const keySet = new Set(existing.map((it) => makerProdKey(it)));
    let matched = 0;
    let withKey = 0;
    for (const p of items) {
      const mc = String((p && p.makerCode) || '').trim();
      const mn = String((p && p.makerName) || '').trim();
      if (!mc && !mn) continue;
      withKey++;
      if (keySet.has(makerProdKey({ makerCode: mc, makerName: mn }))) matched++;
    }
    const newItems = withKey - matched;
    const ratio = withKey ? Math.round((matched / withKey) * 100) : 0;
    res.overlap = {
      incoming: withKey,
      matched,
      newItems,
      existingTotal: existing.length,
      ratio,
    };
    // 表の内容に基づく分類（仕入先名だけでは「再取込」と断定しない）
    if (ratio >= 50 || matched >= 5) res.hintKind = 'reimport';
    else if (matched > 0) res.hintKind = 'append';
    else res.hintKind = 'all_new';
  } else {
    res.hintKind = 'prior_only'; // 過去に取込あり・今回の表は未比較
  }
  return res;
}

// 一覧画面からの「📂 開く」用：ファイル/フォルダをOSの既定アプリで開く（ROOT配下のみ許可）
function safeOpenPath(rel) {
  const target = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const normalized = path.normalize(target);
  // ROOT配下のみ許可。末尾セパレータ込みで比較し、兄弟ディレクトリ(<ROOT>_evil 等)の取りこぼしを防ぐ。
  const rootN = path.normalize(ROOT);
  if (normalized !== rootN && !normalized.startsWith(rootN + path.sep)) throw new Error('範囲外のパスです');
  if (!fs.existsSync(normalized)) throw new Error('見つかりません: ' + rel);
  // パスは文字列連結でシェルに渡さず、引数配列で渡す（" 等が混じってもコマンドが壊れない）。
  if (process.platform === 'win32') execFile('explorer', [normalized]);
  else if (process.platform === 'darwin') execFile('open', [normalized]);
  else execFile('xdg-open', [normalized]);
  return normalized;
}

function saveMakerQuote(body) {
  const supplier = String((body && body.supplier) || '').trim() || '仕入先不明';
  const rawItems = Array.isArray(body && body.items) ? body.items : [];
  if (!rawItems.length) return { ok: false, error: 'データがありません' };
  // クライアントを信用せず、保存時に必ず銭丸め（2.54999 → 2.55）
  for (const it of rawItems) {
    if (it.currentCost != null && String(it.currentCost).trim() !== '') {
      if (Number.isFinite(sen(it.currentCost))) it.currentCost = senStr(it.currentCost);
    }
    if (it.newCost != null && String(it.newCost).trim() !== '') {
      if (Number.isFinite(sen(it.newCost))) it.newCost = senStr(it.newCost);
    }
  }
  // 自社製造（メーカーコード9000＝日野折箱店）判定。body.purchaseCode 優先・無ければ既存プロファイル。
  const effPurchase = String(
    (body && body.purchaseCode != null && String(body.purchaseCode).trim() !== '')
      ? body.purchaseCode
      : (((getMakers() || {})[supplier] || {}).purchaseCode || '')
  ).trim();
  const isSelfMade = effPurchase === '9000';
  // Web取込も照合/xlsx経路と同じく非商品行を除外（運賃案内・見出し再掲等）
  const items = [];
  let droppedNoise = 0;
  for (const it of rawItems) {
    if (isNoiseRow({
      name: it.makerName,
      makerCode: it.makerCode,
      currentCost: it.currentCost,
      newCost: it.newCost,
    })) {
      droppedNoise++;
      continue;
    }
    items.push(it);
  }
  if (!items.length) {
    return {
      ok: false,
      error: droppedNoise
        ? '取り込み対象が非商品行のみです（運賃案内・見出し再掲などは保存されません）'
        : 'データがありません',
      droppedNoise,
    };
  }
  // 防止策①（自動補完）：自社製造は「メーカー品番＝自社商品コード」。自社コード欄(selfCode)に入れていて
  //  メーカー品番が空なら、照合(matchSelf)が使う makerCode へ補完する＝どちらの列に入れても照合でき、
  //  自社コード無しの重複休眠を未然に防ぐ。
  if (isSelfMade) {
    for (const it of items) {
      const mc = String((it && it.makerCode) || '').trim();
      const sc = String((it && it.selfCode) || '').trim();
      if (!mc && sc) it.makerCode = sc;
    }
  }
  fs.mkdirSync(MAKER_DIR, { recursive: true });
  const header = ['仕入先', 'メーカー品番', 'メーカー商品名', '規格', '現単価', '新単価', '切替日'];
  const lines = [header.join(',')];
  for (const it of items) {
    const cur = senStr(it.currentCost);
    const nw = senStr(it.newCost);
    lines.push([supplier, it.makerCode, it.makerName, it.spec,
      Number.isFinite(sen(it.currentCost)) ? cur : it.currentCost,
      Number.isFinite(sen(it.newCost)) ? nw : it.newCost,
      it.switchDate].map(csvCell).join(','));
  }
  const fname = `メーカー見積_${sanitizeName(supplier)}_${stamp()}.csv`;
  fs.writeFileSync(path.join(MAKER_DIR, fname), '﻿' + lines.join('\r\n'), 'utf8');
  // 仕入先ごとの取り込みプロファイル（列マッピング等＋仕入先コード）を記憶し、次回から自動適用する
  if (body && (body.map && Object.keys(body.map).length || body.purchaseCode != null)) {
    try {
      const profile = {};
      if (body.map && Object.keys(body.map).length) {
        profile.map = body.map;
        profile.delim = body.delim || 'auto';
        profile.hasHeader = body.hasHeader !== false;
      }
      // 仕入先コード（4桁）。空文字なら「未設定に戻す」意図。
      if (body.purchaseCode != null) {
        profile.purchaseCode = String(body.purchaseCode || '').trim();
      }
      saveMakerProfile(supplier, profile);
    } catch (_) { /* プロファイル保存に失敗しても見積保存は成功扱い */ }
  }
  // 自社コードが入力された行は「📌 手動紐付け」として登録（照合で 自社CD⇔メーカー商品名 を100%確定）。
  //  ※ CSV(maker_quotes)には自社コード列を増やさない＝照合/下流は無改造。紐付け辞書(settings.productLinks)に
  //    積むことで、保存直後の自動照合からその商品が確定マッチとして扱われる。/list から解除も可能。
  let linkedCount = 0;
  for (const it of items) {
    const code = String((it && it.selfCode) || '').trim();
    const name = String((it && it.makerName) || '').trim();
    if (code && name) {
      try { saveProductLink(supplier, code, name); linkedCount++; } catch (_) { /* 紐付け失敗は無視（見積保存は成功） */ }
    }
  }
  const result = { ok: true, count: items.length, file: 'maker_quotes/' + fname, linkedCount };
  if (droppedNoise) result.droppedNoise = droppedNoise;
  invalidateMakerCaches(); // 新CSV追加＝統合キャッシュを破棄（照合前でも取込ヒントに反映）
  const skippedItems = Array.isArray(body && body.skippedItems) ? body.skippedItems : [];
  if (skippedItems.length || items.length) {
    try {
      const saved = updateImportSkips(supplier, items, skippedItems);
      if (skippedItems.length) result.recordedSkips = skippedItems.length;
      result.savedSkipTotal = saved.length;
    } catch (e) {
      result.skipRecordError = String(e && e.message || e);
    }
  }
  // 防止策②（警告）：自社製造で、補完しても自社コードが全く無い商品は照合できず休眠になる→重複の原因。
  if (isSelfMade) {
    const missing = items.filter((it) => !String((it && it.makerCode) || '').trim()).length;
    if (missing) result.selfCodeWarning = { missing, total: items.length };
  }
  return result;
}

// 自社製造品（日野折箱店）を 商品分類(BUN1/BUN2) で DB から抽出し、maker_quotes の取込CSVを再生成する。
//  ＝手入力CSVの代わりにDBから直接拾う：自社コードの入れ忘れ・重複休眠を根本から防ぐ。
//  既存の同一仕入先の取込CSVは _old へ退避してDB版に一本化する（重複防止）。価格は空＝照合で原価0扱い。
//  ⚠ DB直結(source=db/auto)のときだけ動く。読み取り専用(SELECTのみ)。
function refreshSelfFromDb() {
  const s = getSettings();
  const sm = (s && s.selfManufacture) || {};
  if (!sm.enabled) return { ok: false, error: '自社製造のDB抽出は無効です（config/settings の selfManufacture.enabled を true に）。' };
  const mode = (s.hanbai && s.hanbai.source) || 'file';
  if (mode !== 'db' && mode !== 'auto') return { ok: false, error: 'この機能は販売大臣DB直結（source=db/auto）のときだけ使えます。' };
  const supplier = String(sm.supplier || '日野折箱店').trim() || '日野折箱店';
  let list;
  try {
    const { loadSelfProductsFromDb } = require('./db_hanbai');
    const dbCfg = Object.assign({}, (s.hanbai && s.hanbai.db) || {});
    list = loadSelfProductsFromDb(dbCfg, { bun1: sm.bun1, bun2: sm.bun2, onlySold: sm.onlySold !== false });
  } catch (e) {
    return { ok: false, error: 'DBからの抽出に失敗しました: ' + String(e && e.message || e).split('\n')[0] };
  }
  if (!list || !list.length) return { ok: false, error: '該当する自社製造品がありませんでした（商品分類の設定 bun1/bun2 を確認してください）。' };
  fs.mkdirSync(MAKER_DIR, { recursive: true });
  // 既存の同一仕入先 取込CSVを _old へ退避（DB版で置き換え＝手入力分の重複や取り込み間違いを一掃）。
  const oldDir = path.join(MAKER_DIR, '_old');
  fs.mkdirSync(oldDir, { recursive: true });
  const prefix = 'メーカー見積_' + sanitizeName(supplier) + '_';
  let retired = 0;
  for (const f of fs.readdirSync(MAKER_DIR)) {
    if (f.indexOf(prefix) === 0 && /\.csv$/i.test(f)) {
      try { fs.renameSync(path.join(MAKER_DIR, f), path.join(oldDir, f)); retired++; } catch (_) {}
    }
  }
  // DB抽出 → 取込CSV（自社コード=メーカー品番／商品名／価格は空＝原価0扱い・値上げは得意先別で手入力）。
  const header = ['仕入先', 'メーカー品番', 'メーカー商品名', '規格', '現単価', '新単価', '切替日'];
  const lines = [header.join(',')];
  for (const it of list) lines.push([supplier, it.code, it.name, '', '', '', ''].map(csvCell).join(','));
  const fname = prefix + stamp() + '.csv';
  fs.writeFileSync(path.join(MAKER_DIR, fname), '﻿' + lines.join('\r\n'), 'utf8');
  // 仕入先プロファイルに purchaseCode を確実にセット（matchSelf が作動する条件）。
  try { saveMakerProfile(supplier, { purchaseCode: String(sm.purchaseCode || '9000') }); } catch (_) {}
  return { ok: true, count: list.length, retired, file: 'maker_quotes/' + fname, supplier };
}

function exportQuotes(body) {
  const calc = calcAllCached(body);
  const { rows } = calc;
  const supplier = calc.supplier || '';
  // 提出先のある明細だけ（未一致・得意先なしは除外）
  const matched = rows.filter((r) => r.customerName && r.customerName !== '-' && !/未一致/.test(r.matchStatus || ''));
  if (!matched.length) {
    // 例: 福助のように CSV内が休眠のみ。サーバエラーではなく「対象0件」を返す。
    return {
      ok: false, reason: 'no_matched', count: 0, totalRows: rows.length, supplier,
      message: '見積書化できる行がありません（CSV内 ' + rows.length + ' 行すべてが未一致／得意先なしでした）',
    };
  }

  // 得意先ごと → 自社商品ごとに、最も信頼できる照合1件へ絞る（誤マッチによる重複を除去）
  const groups = new Map();
  let dupRemoved = 0;
  for (const r of matched) {
    if (!groups.has(r.customerName)) groups.set(r.customerName, new Map());
    const byProd = groups.get(r.customerName);
    const key = (r.productCode != null && String(r.productCode).trim() !== '')
      ? normName(r.productCode)
      : ('名:' + normName(r.productName));
    const prev = byProd.get(key);
    if (!prev) { byProd.set(key, r); }
    else {
      dupRemoved++;
      // 同じ得意先×自社商品に複数メーカー品が当たったら、より信頼できる1件へ。
      //  一致度が同点なら「メーカー名のトークン数が多い＝より具体的な品」を優先
      //  （例: 角中太口(3語) > 角中(2語) で、太口の品が角中の品に取り違えられない）。
      const sNew = matchScore(r.matchStatus), sPrev = matchScore(prev.matchStatus);
      if (sNew > sPrev || (sNew === sPrev && makerTokenCount(r.makerName) > makerTokenCount(prev.makerName))) byProd.set(key, r);
    }
  }

  const base = path.basename(body.file).replace(/\.csv$/i, '');
  const folder = path.join(OUTPUT_DIR, `${base}_見積書_${stamp()}`);
  fs.mkdirSync(folder, { recursive: true });

  const date = jpDate();
  const s = getSettings();
  const opt = { company: s.company, quote: s.quote, date };
  const effectiveDate = String(body.effectiveDate || '').trim(); // 実施日（任意・空なら手書き枠）
  const forceDate = String(body.forceEffectiveDate || '').trim(); // 全行を強制的にこの実施日へ（指定時のみ）
  const ymd = (() => { const d2 = new Date(); const p = (n) => String(n).padStart(2, '0'); return '' + d2.getFullYear() + p(d2.getMonth() + 1) + p(d2.getDate()); })();
  const thr = Number.isFinite(Number(s.matchThreshold)) ? Number(s.matchThreshold) : 80; // 一致度しきい値(%)
  const r2 = (v) => fin(v) ? Math.round(v * 100) / 100 : v; // 小数2桁
  const r1 = (v) => fin(v) ? Math.round(v * 10) / 10 : v;   // 小数1桁

  const files = [];
  const reviewRows = []; // 要確認リストへ（低一致＝誤マッチの疑い／価格異常／重複の食い違い）
  let priceReviewCount = 0;
  for (const [customer, byProd] of groups) {
    const all = [...byProd.values()];
    // 見積書から外す対象：① 価格異常（売単価0/値下げ）・② 同一商品の新仕入食い違い・③ しきい値未満の名前一致
    //  ①②はメーカー側データの誤りの可能性→自動採用せず人に確認させる（CD一致でも外す）
    const keep = [], review = [];
    for (const r of all) {
      const priceReason = r.priceWarning || r.costConflict;
      if (priceReason) { review.push({ ...r, reviewReason: priceReason, estQty: r.qty }); priceReviewCount++; continue; }
      if (matchScore(r.matchStatus) >= thr) keep.push(r);
      else review.push({ ...r, reviewReason: '一致度が低い（' + (r.matchStatus || '') + '）', estQty: r.qty });
    }
    for (const r of review) reviewRows.push(r);
    if (!keep.length) continue; // 全部が要確認なら見積書は作らない

    keep.sort((a, b) => String(a.productCode || '').localeCompare(String(b.productCode || ''), 'ja'));
    const qrows = keep.map((r) => ({
      // 提出用の見積書には「コア商品名」だけを載せる（運賃条件・埋込メーカー品番・ロット・棚番を除外）。
      //  parseSelfName で分解した core を優先。抽出に失敗して空なら生の商品名にフォールバック。
      productCode: r.productCode || '',
      productName: (r.productNameCore && r.productNameCore.trim()) ? r.productNameCore.trim() : r.productName,
      currentSell: r2(r.currentSell),
      newSell: r2(r.newSell),
      effectiveDate: forceDate || normalizeEffDate((r.effectiveDate && String(r.effectiveDate).trim()) ? String(r.effectiveDate).trim() : effectiveDate),
    }));
    const fname = quoteFileName(customer);
    const quoteNo = ymd + '-' + String(files.length + 1).padStart(3, '0');
    writeQuote(customer, qrows, path.join(folder, fname), Object.assign({}, opt, { quoteNo }));
    files.push(fname);
  }

  // 要確認リスト（低一致＋価格異常＋重複の食い違い）を1ファイルにまとめて出力
  let reviewFile = null;
  if (reviewRows.length) {
    reviewRows.sort((a, b) =>
      String(a.customerName || '').localeCompare(String(b.customerName || ''), 'ja') ||
      String(a.productCode || '').localeCompare(String(b.productCode || ''), 'ja'));
    reviewFile = `要確認(低一致・価格異常).xlsx`;
    writeXlsx(reviewRows, path.join(folder, reviewFile), { sheetName: '要確認' });
  }

  // 要確認.xlsx の中身を簡易サマリ化（画面で「何の品が要確認になったか」を残せるように）
  const reviewSummary = reviewRows.slice(0, 50).map((r) => ({
    customerName: r.customerName,
    productCode: r.productCode,
    productName: r.productName,
    makerName: r.makerName,
    matchStatus: r.matchStatus,
  }));
  // 顧客ごとの内訳（夜遅くにフォルダを見返さなくても画面で把握できるように）
  const perCustomer = [];
  for (const [customer, byProd] of groups) {
    const all = [...byProd.values()];
    const kept = all.filter((r) => !(r.priceWarning || r.costConflict) && matchScore(r.matchStatus) >= thr).length;
    const review = all.length - kept;
    if (kept > 0) perCustomer.push({ customer, kept, review });
  }
  perCustomer.sort((a, b) => b.kept - a.kept || String(a.customer).localeCompare(String(b.customer), 'ja'));
  return {
    ok: true, folder, folderName: path.basename(folder), files,
    count: files.length, dupRemoved, reviewCount: reviewRows.length, priceReviewCount, reviewFile, threshold: thr,
    supplier, customerCount: files.length, perCustomer, reviewSummary,
  };
}

// 得意先ごとに「買う全商品」を横断集計する（/customers 画面用の逆引き）。
//  input/ の全照合CSV(listCsv)を calcAll で計算し、得意先ごとにまとめる＝得意先別.bat(統合見積書)
//  と同じ全CSVを使うので、画面と提出物の品揃えが一致する（大黒の122品/39品など複数見積も網羅）。
//  価格は sim/見積書と同じ既定（add_increase factor / 端数 / 自社上乗せ%）で算出。
//  重複除去：同一仕入先×同一自社商品が複数CSV(再照合等)に出たら最も信頼できる1件へ。
//   ※複数の仕入先にまたがる同一自社商品は、統合見積書どおり仕入先ごとに別行で残す。
//  見積書に載る行(keep)と要確認(価格異常/低一致)を分けて、keep だけを「該当商品」に集める。
// opts（画面から指定可）: ruleType / factor / roundingUnit / roundingMode / selfUplift / forceEffectiveDate
//  未指定の項目は settings.json の既定値にフォールバック（＝従来どおり）。
// 共通コア：全CSVを計算し、得意先ごとに keep（見積書に載る）/ review（要確認）へ分けて返す。
//  表示(aggregateCustomers)と出力(exportCustomerQuotes)の両方がこれを使う＝画面と提出物が必ず一致。
function candCacheBaseKey(opts) {
  opts = opts || {};
  const st = getSettings();
  const dflt = st.default || {};
  const files = listLatestCsv();
  return JSON.stringify({
    files,
    ruleType: opts.ruleType || dflt.type || 'add_increase',
    factor: Number.isFinite(Number(opts.factor)) ? Number(opts.factor) : ((dflt.factor) || 1.25),
    roundingUnit: Number.isFinite(Number(opts.roundingUnit)) ? Number(opts.roundingUnit) : ((st.rounding && st.rounding.unit) || 0.01),
    roundingMode: opts.roundingMode || (st.rounding && st.rounding.mode) || 'round',
    selfUplift: Number.isFinite(Number(opts.selfUplift)) ? Number(opts.selfUplift) : Number((st.selfCostUplift && st.selfCostUplift.rate) || 0),
    matchThreshold: (st.matchThreshold != null ? st.matchThreshold : 80), // しきい値変更を要確認判定へ反映（古いraw候補を使い回さない）
  });
}
// 照合CSVに指定得意先の一致行があるか（getRecs のみ＝calcAll より軽い）。
function fileHasCustomerMatched(file, customerName) {
  try {
    const recs = getRecs(file);
    for (const rec of recs) {
      const cust = rec.customerName || rec['得意先名'] || '';
      if (cust !== customerName || !cust || cust === '-') continue;
      const st = rec.matchStatus || rec['照合'] || '';
      if (/未一致/.test(st) || /休眠/.test(st)) continue;
      return true;
    }
  } catch (_) {}
  return false;
}

// 全仕入先CSVを calcAll し、得意先→商品候補の生マップを作る（行まるめ等の split 前段）。
//  opts.customerFilter があるときはその得意先が載るファイルだけ calcAll（得意先別の遅延取得を軽くする）。
function buildCustomerRawMap(opts) {
  opts = opts || {};
  const st = getSettings();
  const thr = Number.isFinite(Number(st.matchThreshold)) ? Number(st.matchThreshold) : 80;
  const dflt = st.default || {};
  const ruleType = opts.ruleType || dflt.type || 'add_increase';
  const factor = Number.isFinite(Number(opts.factor)) ? Number(opts.factor) : ((dflt.factor) || 1.25);
  const rounding = {
    unit: Number.isFinite(Number(opts.roundingUnit)) ? Number(opts.roundingUnit) : ((st.rounding && st.rounding.unit) || 0.01),
    mode: opts.roundingMode || (st.rounding && st.rounding.mode) || 'round',
  };
  const selfUplift = Number.isFinite(Number(opts.selfUplift)) ? Number(opts.selfUplift) : Number((st.selfCostUplift && st.selfCostUplift.rate) || 0);
  const baseBody = { rule: { type: ruleType, factor }, rounding, selfUplift };
  const customerFilter = String(opts.customerFilter || '').trim();
  let files = listLatestCsv();
  if (customerFilter) {
    files = files.filter((f) => fileHasCustomerMatched(f, customerFilter));
  }
  const byCustomer = new Map();
  const errors = [];
  for (const file of files) {
    let calc;
    try { calc = calcAllCached(Object.assign({ file }, baseBody)); }
    catch (e) { errors.push({ file, error: String(e && e.message || e) }); continue; }
    const supplier = calc.supplier || file;
    const rows = calc.rows || [];
    const matched = rows.filter((r) => r.customerName && r.customerName !== '-' && !/未一致/.test(r.matchStatus || ''));
    for (const r of matched) {
      const cust = r.customerName;
      if (!byCustomer.has(cust)) byCustomer.set(cust, new Map());
      const m = byCustomer.get(cust);
      const prodKey = (r.productCode != null && String(r.productCode).trim() !== '')
        ? normName(r.productCode) : ('名:' + normName(r.productName));
      const key = supplier + '\u0001' + prodKey;
      const cand = { supplier, r, score: matchScore(r.matchStatus), priceReason: r.priceWarning || r.costConflict };
      const prev = m.get(key);
      if (!prev) { m.set(key, cand); }
      else if (cand.score > prev.score ||
        (cand.score === prev.score && makerTokenCount(r.makerName) > makerTokenCount(prev.r.makerName))) {
        m.set(key, cand);
      }
    }
  }
  return { byCustomer, fileCount: files.length, errors, thr, ruleType, factor, rounding, selfUplift };
}
function buildCustomerCandidates(opts) {
  opts = opts || {};
  const st = getSettings();
  const dflt = st.default || {};
  const customerFilter = String(opts.customerFilter || '').trim();
  const cacheKey = candCacheBaseKey(opts);
  let raw;
  if (!customerFilter && _candRawCache && _candRawCache.key === cacheKey) {
    raw = _candRawCache;
  } else {
    const built = buildCustomerRawMap(opts);
    raw = Object.assign({ key: customerFilter ? (cacheKey + '|' + customerFilter) : cacheKey }, built);
    if (!customerFilter) _candRawCache = raw;
  }
  const { byCustomer: rawByCustomer, fileCount, errors, thr, ruleType, factor, rounding, selfUplift } = raw;
  // 自社製造（メーカーコード9000）判定用。原価0で「値上げなのに同額」を要確認に落とさないため。
  const makersProf = getMakers() || {};
  const isSelfMadeSup = (sup) => String((makersProf[sup] || {}).purchaseCode || '').trim() === '9000';
  const forceDate = String(opts.forceEffectiveDate || '').trim(); // 実施日 一括上書き（空なら各行の切替日）
  // 行ごと転嫁ルール（得意先ページで営業が微調整）。{ rowKey: ruleType }。無ければ全体ルール。
  const rowRules = (opts.rowRules && typeof opts.rowRules === 'object') ? opts.rowRules : {};
  // 行ごと 改定後売価／実施日 の手入力（得意先ページで直接入力）。{ rowKey: 値 }。
  const rowSell = (opts.rowSell && typeof opts.rowSell === 'object') ? opts.rowSell : {};
  const rowEff = (opts.rowEff && typeof opts.rowEff === 'object') ? opts.rowEff : {};
  // 行ごと 備考（得意先ページで直接入力 → 見積書の「備考」列に転記）。{ rowKey: 文字列 }。
  const rowNote = (opts.rowNote && typeof opts.rowNote === 'object') ? opts.rowNote : {};
  // 行ごと まるめ（改定後価格の端数処理）。{ rowKey: "単位|処理" 例 "1|floor" }。無ければ全体のまるめ。
  const rowRound = (opts.rowRound && typeof opts.rowRound === 'object') ? opts.rowRound : {};
  // 行ごと 掛率（行ルール=掛率×のときのその行の掛率）。{ rowKey: 数値 }。無ければ全体の factor。
  const rowFactor = (opts.rowFactor && typeof opts.rowFactor === 'object') ? opts.rowFactor : {};
  // 価格帯別ルール（全体反映）：現売価で転嫁ルール・まるめを変える。[{max, rule, factor, roundUnit, roundMode}] を max 昇順（null=それ以上は最後）。
  //  優先順位＝手入力売価 > 行ルール上書き > 価格帯別 > 全体ルール。まるめ＝行まるめ > 価格帯別まるめ > 全体まるめ。
  let priceBands = [];
  if (Array.isArray(opts.priceBands)) {
    priceBands = opts.priceBands
      .map((b) => {
        const ru = Number(b && b.roundUnit);
        const rm = String((b && b.roundMode) || '').trim();
        return {
          max: (b && b.max != null && Number.isFinite(Number(b.max))) ? Number(b.max) : null,
          rule: String((b && b.rule) || '').trim(),
          factor: (b && Number.isFinite(Number(b.factor)) && Number(b.factor) > 0) ? Number(b.factor) : factor,
          roundUnit: (ru === 1 || ru === 0.1 || ru === 0.01) ? ru : null,
          roundMode: (rm === 'floor' || rm === 'round' || rm === 'ceil') ? rm : '',
        };
      })
      .filter((b) => b.rule);
    priceBands.sort((a, b) => (a.max == null ? Infinity : a.max) - (b.max == null ? Infinity : b.max));
  }
  const bandFor = (curSell) => {
    if (!priceBands.length) return null;
    const v = Number(curSell);
    if (!Number.isFinite(v)) return null;
    for (const b of priceBands) { if (b.max == null || v <= b.max) return b; }
    return priceBands[priceBands.length - 1];
  };
  // keep（見積書に載る）/ review（要確認）へ振り分け（理由つき）
  const itemStatusMap = readItemStatus(); // アイテムの状態（検討中/提出済み）。keep行に status を付ける。
  const byCustomerSplit = new Map(); // name -> { keep:[item], review:[item] }
  for (const [name, m] of rawByCustomer) {
    if (customerFilter && name !== customerFilter) continue;
    const keep = [], review = [];
    for (const cand of m.values()) {
      const r = cand.r;
      // 行を一意に識別するキー（得意先|仕入先|商品）。画面の行ルール上書きと突き合わせる。
      const prodKey = (r.productCode != null && String(r.productCode).trim() !== '') ? normName(String(r.productCode)) : ('名:' + normName(r.productName));
      const rowKey = name + '\u0001' + cand.supplier + '\u0001' + prodKey;
      let newSell = fin(r.newSell) ? r.newSell : null;
      let ruleForRow = ruleType;
      // 優先順位：行ルール上書き > 価格帯別ルール（現売価で変える）> 全体ルール。
      const ov = rowRules[rowKey];
      // 行ルールが明示選択されていれば（全体と同じ値でも）価格帯別を抑止＝この行は手動ロック扱い。
      const hasRowRuleOv = !!ov;
      // 価格帯別ルール：行ルール上書きが無い行にだけ、現売価で帯のルール/掛率を当てる。
      const band = hasRowRuleOv ? null : bandFor(r.currentSell);
      const effRuleType = hasRowRuleOv ? ov : (band && band.rule ? band.rule : ruleType);
      // まるめ：行上書き > 価格帯別 > 全体。
      let effRounding = rounding;
      let roundDiffers = false;
      const roundOv = rowRound[rowKey];
      const roundManual = roundOv != null && String(roundOv).trim() !== '';
      if (roundManual) {
        const s = String(roundOv).trim();
        let eu = rounding.unit, em = rounding.mode;
        if (s.includes('|')) {
          const pr = s.split('|');
          const u = parseFloat(pr[0]);
          if (pr[0] !== '' && Number.isFinite(u) && (u === 1 || u === 0.1 || u === 0.01)) eu = u;
          const m = pr[1] || '';
          if (m === 'floor' || m === 'round' || m === 'ceil') em = m;
        } else {
          const u = parseFloat(s);
          if (Number.isFinite(u) && u > 0 && (u === 1 || u === 0.1 || u === 0.01)) {
            eu = u;
          } else if (s === 'floor' || s === 'round' || s === 'ceil') {
            em = s;
          }
        }
        effRounding = { unit: eu, mode: em };
        roundDiffers = effRounding.unit !== rounding.unit || effRounding.mode !== rounding.mode;
      } else if (band && (band.roundUnit != null || band.roundMode)) {
        const eu = (band.roundUnit === 1 || band.roundUnit === 0.1 || band.roundUnit === 0.01) ? band.roundUnit : rounding.unit;
        const em = (band.roundMode === 'floor' || band.roundMode === 'round' || band.roundMode === 'ceil') ? band.roundMode : rounding.mode;
        effRounding = { unit: eu, mode: em };
        roundDiffers = effRounding.unit !== rounding.unit || effRounding.mode !== rounding.mode;
      }
      // パラメータ（markup＝掛率／target_margin_rate＝目標粗利率%）：行値 > 帯の値 > 全体factor。
      //  どちらのルールも rule.factor の枠に値を載せる（掛率＝倍率／目標粗利率＝%）。
      let effFactor = factor;
      if (effRuleType === 'markup' || effRuleType === 'target_margin_rate') {
        const rf = Number(rowFactor[rowKey]);
        if (Number.isFinite(rf) && rf > 0) effFactor = rf;
        else if (band && band.rule === effRuleType && Number.isFinite(Number(band.factor)) && Number(band.factor) > 0) effFactor = Number(band.factor);
      }
      // ルール／まるめ／掛率 のいずれかが全体と違えば、その行だけ再計算（全体と同じ calcRow 経路＝ズレない）。
      const ruleDiffers = effRuleType !== ruleType;
      const factorDiffers = effFactor !== factor;
      if (ruleDiffers || roundDiffers || factorDiffers) {
        const rr = calcRow(r, { default: { type: effRuleType, factor: effFactor }, overrides: [], rounding: effRounding, selfCostUplift: { rate: selfUplift } });
        if (fin(rr.newSell)) { newSell = rr.newSell; ruleForRow = effRuleType; }
      }
      // 改定後売価の手入力（最優先）。¥/円/カンマ/全角を除去して数値に揃える。
      const manualSell = parsePriceInput(rowSell[rowKey]);
      const sellManual = manualSell != null;
      // 手入力は銭(2桁)に丸めて保持＝見積書xlsx(2桁丸め)・発行時保存と一致させる（端数のズレ防止）。
      if (sellManual) { newSell = sen(manualSell); ruleForRow = 'manual'; }
      // 実施日：行の手入力 > 全体一括 > 各行の切替日。どの形式でも ISO に揃える。
      const effManual = rowEff[rowKey] != null && String(rowEff[rowKey]).trim() !== '';
      const effRaw = effManual ? String(rowEff[rowKey]) : (forceDate || ((r.effectiveDate && String(r.effectiveDate).trim()) ? String(r.effectiveDate).trim() : (r.switchDate || '')));
      // 備考：得意先ページの手入力。空でも item に持たせて画面・見積書で同じ値を出す。
      const note = (rowNote[rowKey] != null) ? String(rowNote[rowKey]) : '';
      const item = {
        supplier: cand.supplier,
        customerCode: r.customerCode || '', // 販売大臣 単価履歴CSVの得意先コードに使用
        productCode: r.productCode || '',
        productName: (r.productNameCore && r.productNameCore.trim()) ? r.productNameCore.trim() : r.productName,
        makerName: r.makerName || '',
        currentSell: fin(r.currentSell) ? r.currentSell : null,
        newSell,
        effectiveDate: normDateInput(effRaw),
        matchStatus: r.matchStatus || '',
        currentCost: r.currentCost, newCost: r.newCost,
        annualQty: fin(r.qty) ? r.qty : 0, // 直近約1年の数量（0＝取引なし）
        lastDate: r.lastDate || '',       // 最終売上日（ISO・DB直結時のみ）＝得意先ページの「過去N年」フィルタ用
        rowKey, ruleForRow, sellManual, effManual, note,
      };
      // 実施日が有効な日付でない（空・「未定」等）行に印を付ける。得意先ページの見積発行では実施日が必須＝
      //  対象に残して赤く強調し、発行ゲートでブロックする（exportCustomerQuotes で参照）。
      item.noEff = !isValidEff(item.effectiveDate);
      // 状態を先に引く。提出済み(issued)は発行時に確定した内容（単価・実施日）を最優先で復元し、
      //  価格異常・低一致のゲートでは弾かない＝再照合や全体ルール変更で「提出済みが要確認に落ちて消える／
      //  発行時単価が復元されず基幹CSVに出ない」事故を防ぐ（CLAUDE.md: 発行時単価保存の方針を徹底）。
      const stEntry = (itemStatusMap[name] && itemStatusMap[name][rowKey]) || null;
      item.status = (stEntry && stEntry.s) || ''; // ''=対象 / 'hold'=検討中 / 'manual'=手動修正 / 'issued'=提出済み
      if (item.status === 'issued') {
        item.issuedAt = stEntry.at || ''; item.issuedQuoteNo = stEntry.quoteNo || '';
        // 提出済みは「発行に使った実施日」を採用（自社製造＝切替日なしでも実施日が残り、単価履歴CSV/カレンダーに反映）。
        if (stEntry.eff) { item.effectiveDate = stEntry.eff; item.noEff = !isValidEff(item.effectiveDate); }
        // 提出済みは「発行時に確定した単価」を優先＝手入力/価格帯別/行ルールで決めた見積書の単価をそのまま使う。
        //  これで 単価履歴CSV(新販売単価)・仕入原価CSV(新仕入単価) が見積書と完全一致する（既定再計算で上書きしない）。
        if (stEntry.sell != null && Number.isFinite(Number(stEntry.sell))) { newSell = Number(stEntry.sell); item.newSell = newSell; }
        if (stEntry.cost != null && Number.isFinite(Number(stEntry.cost))) { item.newCost = Number(stEntry.cost); }
        keep.push(item); // 提出済み＝発行済みの確定行。価格異常・低一致のゲートを通さずそのまま採用する。
        continue;
      }
      if (item.status === 'hold' || item.status === 'dormant') {
        keep.push(item); // 検討中・休眠＝見積から除外（activeOf の !p.status で外れる）。あとで対象に戻して発行できる。
        continue;
      }
      if (item.status === 'manual') {
        item.manualAt = stEntry.at || '';
        if (stEntry.sell != null && Number.isFinite(Number(stEntry.sell))) item.newSell = Number(stEntry.sell);
        if (stEntry.cost != null && Number.isFinite(Number(stEntry.cost))) item.newCost = Number(stEntry.cost);
        if (stEntry.eff) { item.effectiveDate = stEntry.eff; item.noEff = !isValidEff(item.effectiveDate); }
        if (stEntry.note) item.note = stEntry.note;
        if (stEntry.productName) item.productName = stEntry.productName;
        if (stEntry.supplier) item.supplier = stEntry.supplier;
        if (stEntry.productCode) item.productCode = stEntry.productCode;
        if (stEntry.matchStatus) item.matchStatus = stEntry.matchStatus;
        keep.push(item); // 手動修正＝見積から除外。登録時の単価等をスナップショットで保持。
        continue;
      }
      // 以下は提出済み・検討中・手動修正以外（対象）＝価格異常・低一致を判定して要確認(review)へ振り分ける。
      // 価格異常は「行ごと上書き後の改定後売価・ルール」で判定し直す（古い全体ルールの判定を使わない）。
      //  例: 全体=値上げ → ある行だけ keep_sell/手入力に上書きしても、上書き後の値で正しく判定。
      //  costConflict（同一メーカー品番に新仕入が複数＝売価に依らないメーカー見積の重複）は売価上書きと無関係なので元判定を保持。
      const effPriceWarning = priceRowAnomaly(item.currentSell, item.newSell, ruleForRow, isSelfMadeSup(cand.supplier), item.currentCost, item.newCost);
      const effPriceReason = effPriceWarning || (cand.r.costConflict || '');
      if (effPriceReason) { review.push(Object.assign({ reason: effPriceReason, reasonType: 'price' }, item)); continue; } // 価格異常
      if (cand.score < thr) { review.push(Object.assign({ reason: '一致度が低い（' + (r.matchStatus || '') + '）', reasonType: 'match' }, item)); continue; } // 低一致
      keep.push(item);
    }
    byCustomerSplit.set(name, { keep, review });
  }
  const applied = { ruleType, factor, roundingUnit: rounding.unit, roundingMode: rounding.mode, selfUplift, forceEffectiveDate: forceDate, priceBands };
  return { byCustomer: byCustomerSplit, fileCount, errors, thr, applied };
}

const bySupNameCust = (a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja') || String(a.productName).localeCompare(String(b.productName), 'ja');
// split 結果から /customers 画面用の1得意先レコードを組み立てる。
function customerRecordFromSplit(name, split, masterMap) {
  const { keep, review } = split;
  // 要確認(review)だけの得意先も画面に出す（軽量一覧の件数と明細の不整合を防ぐ）。
  if (!keep.length && !review.length) return null;
  const active = keep.filter((p) => !p.status).sort(bySupNameCust);
  const holdProducts = keep.filter((p) => p.status === 'hold').sort(bySupNameCust);
  const dormantProducts = keep.filter((p) => p.status === 'dormant').sort(bySupNameCust);
  const manualProducts = keep.filter((p) => p.status === 'manual').sort(bySupNameCust);
  const issuedProducts = keep.filter((p) => p.status === 'issued').sort(bySupNameCust);
  const suppliers = [...new Set(active.map((p) => p.supplier))].sort((a, b) => String(a).localeCompare(String(b), 'ja'));
  const allItems = keep;
  const code = (allItems.find((p) => p.customerCode && String(p.customerCode).trim()) || {}).customerCode || '';
  const kana = (code && masterMap[code] && masterMap[code].kana) || '';
  const hasRecent = allItems.some((p) => Number(p.annualQty) > 0);
  let lastDate = '';
  for (const p of allItems) { if (p.lastDate && p.lastDate > lastDate) lastDate = p.lastDate; }
  return {
    name, code, kana, hasRecent, lastDate,
    productCount: active.length, supplierCount: suppliers.length,
    suppliers, reviewCount: review.length, products: active,
    holdProducts, dormantProducts, manualProducts, issuedProducts,
    holdCount: holdProducts.length, dormantCount: dormantProducts.length,
    manualCount: manualProducts.length, issuedCount: issuedProducts.length,
  };
}
// /customers 画面の表示用。keep だけを「該当商品」に集め、要確認は件数のみ返す（従来互換）。
// opts.refreshOne + opts.customer ＝選択中得意先だけ返す（partial:true）＝再計算の体感を軽くする。
function aggregateCustomers(opts) {
  opts = opts || {};
  const refreshOne = !!(opts.refreshOne && opts.customer);
  const customerName = refreshOne ? String(opts.customer).trim() : '';
  const buildOpts = refreshOne ? Object.assign({}, opts, { customerFilter: customerName }) : opts;
  const { byCustomer, fileCount, errors, applied } = buildCustomerCandidates(buildOpts);
  const masterMap = getCustomerMasterMap();
  if (refreshOne && customerName) {
    const split = byCustomer.get(customerName);
    const customer = split ? customerRecordFromSplit(customerName, split, masterMap) : null;
    return { partial: true, customer, fileCount, errors, applied };
  }
  const customers = [];
  for (const [name, split] of byCustomer) {
    const rec = customerRecordFromSplit(name, split, masterMap);
    if (rec) customers.push(rec);
  }
  customers.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  return { customers, fileCount, errors, applied };
}

// /customers 起動用の軽量一覧：getRecs のみで得意先名・件数・コード等を集計（calcAll/calcRow なし）。
//  明細（価格・行ルール）は得意先選択時に aggregateCustomers(refreshOne) で遅延取得する。
function aggregateCustomersSummary() {
  const files = listLatestCsv();
  const excludedCust = getExcludedCustomers();
  const masterMap = getCustomerMasterMap();
  const itemStatusMap = readItemStatus();
  const byName = new Map();
  const errors = [];
  for (const file of files) {
    let recs;
    try { recs = getRecs(file); } catch (e) { errors.push({ file, error: String(e && e.message || e) }); continue; }
    const supplier = String(file).split('_照合結果_')[0] || '';
    for (const rec of recs) {
      const cust = rec.customerName || rec['得意先名'] || '';
      if (!cust || cust === '-' || excludedCust[cust]) continue;
      const st = rec.matchStatus || rec['照合'] || '';
      if (/未一致/.test(st) || /休眠/.test(st)) continue;
      if (!byName.has(cust)) {
        byName.set(cust, {
          keys: new Set(), suppliers: new Set(),
          customerCode: '', lastDate: '', hasRecent: false, earliestEff: '',
          holdCount: 0, dormantCount: 0, manualCount: 0, issuedCount: 0,
        });
      }
      const c = byName.get(cust);
      const prodKey = (rec.productCode != null && String(rec.productCode).trim() !== '')
        ? normName(String(rec.productCode)) : ('名:' + normName(rec.productName));
      c.keys.add(supplier + '\u0001' + prodKey);
      if (supplier) c.suppliers.add(supplier);
      if (rec.customerCode && String(rec.customerCode).trim()) c.customerCode = String(rec.customerCode).trim();
      if (rec.lastDate && rec.lastDate > c.lastDate) c.lastDate = rec.lastDate;
      if (Number(rec.qty) > 0) c.hasRecent = true;
      const effRaw = (rec.effectiveDate && String(rec.effectiveDate).trim()) || rec.switchDate || '';
      const eff = normDateInput(effRaw);
      if (isValidEff(eff) && (!c.earliestEff || eff < c.earliestEff)) c.earliestEff = eff;
    }
  }
  // 品目ステータス（検討中/手動修正/提出済み）の件数だけ先に付与（価格計算は不要）。
  for (const [name, ent] of Object.entries(itemStatusMap)) {
    if (!byName.has(name)) continue;
    let hold = 0, manual = 0, issued = 0, dormant = 0;
    for (const rk of Object.keys(ent)) {
      if (ent[rk].s === 'hold') hold++;
      else if (ent[rk].s === 'dormant') dormant++;
      else if (ent[rk].s === 'manual') manual++;
      else if (ent[rk].s === 'issued') issued++;
    }
    const c = byName.get(name);
    c.holdCount = hold;
    c.dormantCount = dormant;
    c.manualCount = manual;
    c.issuedCount = issued;
  }
  const customers = [];
  for (const [name, c] of byName) {
    if (!c.keys.size) continue;
    const code = c.customerCode || '';
    const kana = (code && masterMap[code] && masterMap[code].kana) || '';
    const suppliers = [...c.suppliers].sort((a, b) => String(a).localeCompare(String(b), 'ja'));
    customers.push({
      name, code, kana, hasRecent: !!c.hasRecent, lastDate: c.lastDate || '',
      productCount: c.keys.size, supplierCount: suppliers.length, suppliers,
      reviewCount: 0, holdCount: c.holdCount, dormantCount: c.dormantCount, manualCount: c.manualCount, issuedCount: c.issuedCount,
      products: c.earliestEff ? [{ effectiveDate: c.earliestEff }] : [],
      holdProducts: null, dormantProducts: null, manualProducts: null, issuedProducts: null,
      _lazy: true,
    });
  }
  customers.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  return { customers, fileCount: files.length, errors };
}

// 得意先 除外設定モーダル用データ：
//  active  = いま照合に出ている得意先（＝除外候補。既に除外済みの先は calcAll で消えるので出ない）。
//            要確認・価格異常だけの得意先（例 自社消費分＝売単価0）も含める＝見積対象(keep)が0でも一覧に出す。
//            最終売上日・取引有無も付ける＝「取引が無い先」を見つけやすく。
//  excluded= 現在 除外中の得意先（名前＋除外日時）。ここから「復活」できる。
function customerExclusionData() {
  let active = [];
  try {
    const byName = new Map();
    for (const file of listLatestCsv()) {
      let calc;
      try { calc = calcAllCached({ file }); } catch (e) { continue; }
      const supplier = calc.supplier || String(file).split('_照合結果_')[0] || '';
      for (const r of calc.rows || []) {
        const name = r.customerName;
        if (!name || name === '-' || /未一致/.test(r.matchStatus || '')) continue;
        if (!byName.has(name)) {
          byName.set(name, { name, code: '', lastDate: '', hasRecent: false, productCount: 0, suppliers: new Set() });
        }
        const c = byName.get(name);
        if (r.customerCode && String(r.customerCode).trim()) c.code = String(r.customerCode).trim();
        if (r.lastDate && r.lastDate > c.lastDate) c.lastDate = r.lastDate;
        if (Number(r.qty) > 0) c.hasRecent = true;
        c.productCount += 1;
        if (supplier) c.suppliers.add(supplier);
      }
    }
    active = [...byName.values()].map((c) => ({
      name: c.name, code: c.code || '', lastDate: c.lastDate || '',
      hasRecent: !!c.hasRecent, productCount: c.productCount || 0, supplierCount: c.suppliers.size,
    })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  } catch (e) { active = []; }
  const ex = getExcludedCustomers();
  const excluded = Object.keys(ex).map((name) => ({ name, at: ex[name] }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  return { active, excluded };
}

// /customers からの見積書出力。doIssue=false=発行前チェック（要確認の一覧を返すだけ・書かない）、
//  true=実発行（得意先ごと1枚のxlsxを書く。要確認行は本体から除外＝「発行ストップ→確認」運用の受け皿）。
//  scope: 'all'（全得意先）/ 'one'（opts.customer の1得意先）。
function exportCustomerQuotes(opts, doIssue) {
  opts = opts || {};
  const { byCustomer, applied, thr } = buildCustomerCandidates(opts);
  let entries = [...byCustomer.entries()];
  if (opts.scope === 'one' && opts.customer) entries = entries.filter(([n]) => n === opts.customer);
  const reviewAll = [];
  for (const [name, d] of entries) for (const rv of d.review) reviewAll.push(Object.assign({ customer: name }, rv));
  // 見積書に載るのは「対象」のみ＝検討中(hold)・手動修正(manual)・提出済み(issued)は除外。
  // onlyRowKeys（得意先1件の発行で、画面でチェックした商品だけを見積にする）が来ていれば、その rowKey に絞る。
  //  プレビュー・件数・実施日チェック・発行ループの全てがこの activeOf を通る＝1か所で整合。
  const onlyKeys = (opts.scope === 'one' && Array.isArray(opts.onlyRowKeys) && opts.onlyRowKeys.length)
    ? new Set(opts.onlyRowKeys.map((k) => String(k))) : null;
  const activeOf = (d) => d.keep.filter((p) => !p.status && (!onlyKeys || onlyKeys.has(p.rowKey)));
  const issuable = entries.filter(([, d]) => activeOf(d).length > 0);
  const issuableRowCount = issuable.reduce((s, [, d]) => s + activeOf(d).length, 0);
  // 実施日が未設定（必須）の対象アイテムを集める。発行ゲートで件数を示し、発行をブロックする。
  const missingEff = [];
  for (const [customer, d] of issuable) {
    for (const p of activeOf(d)) {
      if (p.noEff) missingEff.push({ customer, supplier: p.supplier, productCode: p.productCode || '', productName: p.productName, rowKey: p.rowKey });
    }
  }

  if (!doIssue) {
    // プレビュー：実際に見積書へ出力される内容（得意先ごとの明細）を、発行時と同じ並び・同じ値で返す。
    //  得意先数・行数が多い時は上限で打ち切る（preview は確認用。発行自体は全件に対して行われる）。
    const r2p = (v) => fin(v) ? Math.round(v * 100) / 100 : v;
    const PV_CUST_CAP = 300, PV_ROW_CAP = 4000;
    let rowBudget = PV_ROW_CAP;
    const preview = [];
    for (const [customer, d] of issuable) {
      if (preview.length >= PV_CUST_CAP || rowBudget <= 0) break;
      const keep = activeOf(d).sort((a, b) =>
        String(a.supplier).localeCompare(String(b.supplier), 'ja') ||
        String(a.productName).localeCompare(String(b.productName), 'ja'));
      const rows = keep.slice(0, rowBudget).map((p) => ({
        supplier: p.supplier, productCode: p.productCode || '', productName: p.productName,
        currentSell: r2p(p.currentSell), newSell: r2p(p.newSell),
        effectiveDate: p.effectiveDate, note: p.note || '',
      }));
      rowBudget -= rows.length;
      preview.push({ customer, productCount: keep.length, rows });
    }
    return {
      ok: true, action: 'check', applied, threshold: thr,
      scope: opts.scope || 'all', customer: opts.customer || null,
      issuableCustomerCount: issuable.length, issuableRowCount, reviewCount: reviewAll.length,
      missingEffCount: missingEff.length, missingEff: missingEff.slice(0, 800),
      preview, previewTruncated: preview.length < issuable.length,
      review: reviewAll.slice(0, 800).map((r) => ({
        customer: r.customer, supplier: r.supplier, productCode: r.productCode,
        productName: r.productName, makerName: r.makerName, reason: r.reason, reasonType: r.reasonType,
        currentSell: r.currentSell, newSell: r.newSell, matchStatus: r.matchStatus,
      })),
    };
  }

  // 実施日が必須：未設定の対象アイテムが1件でもあれば発行しない（サーバ側で強制＝クライアントを信用しない）。
  if (missingEff.length) {
    return {
      ok: false, reason: 'missing_eff', missingEffCount: missingEff.length,
      missingEff: missingEff.slice(0, 800),
      message: '実施日が未設定の商品が ' + missingEff.length + ' 件あります。実施日は必須です。各行の実施日を入力（または「実施日 一括」で統一）してから発行してください。',
    };
  }
  const r2 = (v) => fin(v) ? Math.round(v * 100) / 100 : v;
  const folder = path.join(OUTPUT_DIR, `得意先別_見積書_${stamp()}`);
  fs.mkdirSync(folder, { recursive: true });
  const s = getSettings();
  const opt = { company: s.company, quote: s.quote, date: jpDate() };
  const ymd = (() => { const d2 = new Date(); const p = (n) => String(n).padStart(2, '0'); return '' + d2.getFullYear() + p(d2.getMonth() + 1) + p(d2.getDate()); })();
  const files = [];
  const issued = []; // 提出履歴用（得意先・見積No・品数）
  const atIso = new Date().toISOString();
  for (const [customer, d] of issuable) {
    const keep = activeOf(d).sort((a, b) =>
      String(a.supplier).localeCompare(String(b.supplier), 'ja') ||
      String(a.productName).localeCompare(String(b.productName), 'ja'));
    const qrows = keep.map((p) => ({
      productCode: p.productCode || '', productName: p.productName, currentSell: r2(p.currentSell), newSell: r2(p.newSell), effectiveDate: p.effectiveDate, note: p.note || '',
    }));
    const quoteNo = ymd + '-' + String(files.length + 1).padStart(3, '0');
    const fname = quoteFileName(customer);
    writeQuote(customer, qrows, path.join(folder, fname), Object.assign({}, opt, { quoteNo }));
    files.push(fname);
    issued.push({ customer, quoteNo, itemCount: keep.length });
    // 発行した「対象」アイテムを提出済みへ＝次回から別枠（提出済み）に並び、作業表から外れる。
    //  実施日(effectiveDate)も保存＝自社製造（切替日なし）でも提出済みの実施日がカレンダー/単価履歴に出る。
    markItemsIssued(customer, keep, quoteNo, atIso);
  }
  // 提出履歴を記録（得意先ページで「提出済み」を表示するため）。価格・照合には無影響。
  recordIssuance(issued, path.basename(folder), atIso);
  let reviewFile = null;
  if (reviewAll.length) {
    const rows = reviewAll.map((r) => ({
      customerName: r.customer, productCode: r.productCode, productName: r.productName,
      makerName: r.makerName, currentSell: r.currentSell, newSell: r.newSell,
      matchStatus: r.matchStatus, reviewReason: r.reason,
    }));
    reviewFile = `要確認(発行から除外).xlsx`;
    writeXlsx(rows, path.join(folder, reviewFile), { sheetName: '要確認' });
  }
  return {
    ok: true, action: 'issued', folder, folderName: path.basename(folder), files,
    count: files.length, reviewCount: reviewAll.length, reviewFile, applied,
    scope: opts.scope || 'all', customer: opts.customer || null,
    issuedCustomers: issued.map((i) => i.customer), // 今回提出した得意先（クライアントが即バッジ表示）
    issuedDetail: issued, // [{ customer, quoteNo, itemCount }]（メール送信が見積No.等を引くため）
  };
}

// 見積メールの件名・本文を 雛形(settings.quote.mailSubject/mailBody)＋会社情報 から組み立てる。
//  差し込みタグ {customer}{quoteNo}{date}{count}{company} を置換し、末尾に差出人欄(会社情報)を付ける。
//  新規送信(/api/mail-quote)と再送(/api/mail-quote-resend)で共用＝文面を一元化。
function composeQuoteMail(customer, quoteNo, itemCount) {
  const s = getSettings();
  const q = s.quote || {};
  const co = s.company || {};
  const fill = (t) => String(t || '')
    .replace(/\{customer\}/g, customer)
    .replace(/\{quoteNo\}/g, quoteNo || '')
    .replace(/\{date\}/g, jpDate())
    .replace(/\{count\}/g, String(itemCount != null ? itemCount : ''))
    .replace(/\{company\}/g, co.name || '');
  const sig = ['', '──────────', co.name || '', [co.postal, co.address].filter(Boolean).join(' '), co.tel || '', co.fax || ''].filter((x) => x !== undefined).join('\n');
  const subject = fill(q.mailSubject || 'お見積書の送付（{customer}様）');
  const body = fill(q.mailBody || '{customer}　御中\n\n見積書を添付いたします。よろしくお願いいたします。') + '\n' + sig;
  return { subject, body };
}

// クライアントへ返す設定から機微情報（アクセスパスワードのハッシュ）を伏せる。
//  画面の設定フォームはパスワードを編集しない＝伏せても無影響。設定有無は hasAccessPassword で伝える。
function settingsForClient(s) {
  const out = Object.assign({}, s);
  out.hasAccessPassword = !!out.accessPassword;
  out.accessPassword = '';
  // AIキーはブラウザへ返さない。設計上は環境変数 ANTHROPIC_API_KEY のみ使用（settings.json に置いても効かない）が、
  //  万一 ai.apiKey が書かれていても平文を出さないよう防御的にマスクする。ネストは元設定を壊さないよう複製してから消す。
  if (out.ai && typeof out.ai === 'object') { out.ai = Object.assign({}, out.ai); if ('apiKey' in out.ai) out.ai.apiKey = ''; }
  return out;
}

// ---- 販売大臣 単価履歴CSV：発行済み×実施日到来分を集める（日野/販売大臣 専用の隔離機能） ----
//  cutoffIso(YYYY-MM-DD) 以前に実施日が到来した「発行済み得意先」の行を、得意先×商品で1件に集約。
//  価格は現在の設定で再計算した値（発行時から全体方針を変えていなければ見積書と一致）。
function collectHanbaiExportLines(cutoffIso, issuedOnly) {
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(String(cutoffIso || '')) ? cutoffIso : null;
  const { byCustomer } = buildCustomerCandidates({});
  const byPair = new Map(); // 得意先コード|商品コード -> line（実施日が新しい方を採用）
  for (const [name, { keep }] of byCustomer) {
    for (const it of keep) {
      // issuedOnly（既定・推奨）＝「発行した見積のみ」＝アイテム単位で提出済み(issued)の品だけ。
      //  発行時に確定した単価(newSell/newCost)が保存済み＝CSVが見積書と完全一致。未発行は載せない。
      if (issuedOnly) { if (it.status !== 'issued') continue; }
      else if (it.status === 'hold' || it.status === 'manual' || it.status === 'dormant') continue; // 検討中・手動修正・休眠は基幹更新に載せない
      const eff = String(it.effectiveDate || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) continue;         // 実施日がISOで取れない行は対象外
      if (cutoff && eff > cutoff) continue;                    // まだ実施日が来ていない行は除外
      const cc = String(it.customerCode || '').trim();
      const pc = String(it.productCode || '').trim();
      if (!cc || !pc) continue;                                // コードが無い行は取込不可
      if (!(Number(it.newSell) > 0)) continue;                 // 新販売単価が無い/0は除外
      const key = cc + '|' + pc;
      const line = { customerName: name, customerCode: cc, productCode: pc, newSell: it.newSell, newCost: it.newCost, effectiveDate: eff };
      const prev = byPair.get(key);
      if (!prev || eff > prev.effectiveDate) byPair.set(key, line); // 同一得意先×商品は実施日が新しい方
    }
  }
  const lines = [...byPair.values()];
  const customerCount = new Set(lines.map((l) => l.customerCode)).size;
  return { lines, customerCount };
}

// 上の行 + DBの税情報(ZEIKBN/ZEIRITU) を付けて CSVバッファ等を返す。
//  issuedOnly=true なら発行済みの得意先のみ。既定(false)は実施日が来た改定すべて。
//  DBに繋がらない時は税を既定(2/1)にフォールバックし dbError を立てる（他社版でも落ちない）。
function buildHanbaiExport(cutoffIso, issuedOnly) {
  const { lines, customerCount } = collectHanbaiExportLines(cutoffIso, issuedOnly);
  let taxMap = {}, dbError = '';
  if (lines.length) {
    try {
      const { lookupShohinTax } = require('./db_hanbai');
      const dbCfg = (getSettings().hanbai && getSettings().hanbai.db) || {};
      taxMap = lookupShohinTax(dbCfg, lines.map((l) => l.productCode)) || {};
    } catch (e) { dbError = String(e && e.message || e); taxMap = {}; }
  }
  const missingTax = lines.filter((l) => !taxMap[l.productCode]).length;
  const { buffer, count, skipped } = buildHanbaiCsv(lines, taxMap);
  return { buffer, count, skipped, customerCount, missingTax, dbError, total: lines.length };
}

// 仕入先単価（新原価）更新CSV：実施日が到来した照合済み商品の「新仕入原価」を商品コードで1件に集約。
//  コストは得意先に依らず同じなので商品単位（同一商品は実施日が新しい方を採用）。
//  発行(得意先見積)の有無は問わない＝メーカー見積照合で価格改定が確定した分すべてを基幹システムへ反映する。
//  新原価 = メーカー見積の新仕入単価(newCost)。自社上乗せ%は売価側にしか効かないので実際に払う仕入額そのもの。
function collectCostUpdateLines(cutoffIso) {
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(String(cutoffIso || '')) ? cutoffIso : null;
  const { byCustomer } = buildCustomerCandidates({});
  const byProduct = new Map(); // 商品コード -> line（実施日が新しい方）
  for (const [, sp] of byCustomer) {
    for (const it of sp.keep) {
      if (it.status === 'hold' || it.status === 'manual' || it.status === 'dormant') continue; // 検討中・手動修正・休眠は基幹更新にも載せない
      const eff = String(it.effectiveDate || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) continue;     // 実施日がISOで取れない行は対象外
      if (cutoff && eff > cutoff) continue;                // まだ実施日が来ていない行は除外
      const pc = String(it.productCode || '').trim();
      if (!pc) continue;                                   // 商品コードが無い行は取込不可
      if (!(Number(it.newCost) > 0)) continue;             // 新仕入原価が無い/0は除外
      const line = { productCode: pc, newCost: it.newCost, effectiveDate: eff, productName: it.productName, supplier: it.supplier };
      const prev = byProduct.get(pc);
      if (!prev || eff > prev.effectiveDate) byProduct.set(pc, line); // 同一商品は実施日が新しい方
    }
  }
  const lines = [...byProduct.values()];
  return { lines, productCount: lines.length };
}

// 上の行 → 2列CSV(商品コード,新原価・Shift_JIS)バッファ等を返す。DBは不要（コストは照合結果から取れる）。
function buildCostExport(cutoffIso) {
  const { lines, productCount } = collectCostUpdateLines(cutoffIso);
  const { buffer, count, skipped } = buildCostCsv(lines);
  return { buffer, count, skipped, productCount, total: lines.length };
}

// ---- HTTP ----------------------------------------------------------
const MAX_BODY_BYTES = 20 * 1024 * 1024; // POST本文上限（base64 xlsx 取込でも十分。巨大POSTによるOOM/DoS対策）
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('リクエスト本文が大きすぎます（上限 ' + Math.round(MAX_BODY_BYTES / 1024 / 1024) + 'MB）'));
        return;
      }
      chunks.push(c);
    });
    // 不正/空のJSONでも reject せず空オブジェクトで解決（各APIが 200+{ok:false} を返せる＝フロントの分岐が崩れない）。
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}

// ---- セキュリティ：ローカル専用ガード（#1）＋任意のアクセスパスワード（#2） ----
//  #1 Host/Origin チェック：ブラウザ経由の外部サイトからの攻撃（CSRF/DNSリバインディング）を防ぐ。
//     正規の同一オリジン操作（自分のPCの画面）は素通り。サーバは 127.0.0.1 バインドなので二重の防御。
//  #2 アクセスパスワード：settings.json の accessPassword が設定されている時だけ有効（既定は未設定＝認証なし）。
//     共用PC向けの簡易ロック。Cookieにはパスワードのハッシュのみ保存（平文は保存しない）。
function isLocalHostName(h) {
  const x = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  return x === 'localhost' || x === '127.0.0.1' || x === '::1';
}
function isLocalHostHeader(host) {
  const raw = String(host || '').trim().toLowerCase();
  if (!raw) return false;
  const name = raw[0] === '[' ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  return isLocalHostName(name);
}
function isLocalOrigin(origin) {
  if (!origin) return true; // Origin 無し＝同一オリジンのGET等。許可。
  try { return isLocalHostName(new URL(origin).hostname); } catch (e) { return false; }
}
function parseCookies(h) {
  const out = {};
  String(h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function pwToken(pw) { return crypto.createHash('sha256').update('apw|' + String(pw)).digest('hex'); }
const LOGIN_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>ログイン</title>
<style>body{font-family:"メイリオ",sans-serif;background:#f4f6f9;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{background:#fff;border:1px solid #e2e6ec;border-radius:12px;padding:28px 26px;width:300px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
h1{font-size:16px;margin:0 0 12px;color:#1f4e78}input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #c7ced8;border-radius:7px;font-size:14px}
button{margin-top:12px;width:100%;background:#1f4e78;color:#fff;border:0;border-radius:8px;padding:10px;font-weight:700;cursor:pointer}
.err{color:#c0392b;font-size:12px;margin-top:8px;min-height:16px}</style></head>
<body><div class="box"><h1>価格転嫁見積ツール</h1><div style="font-size:12px;color:#6b7785;margin-bottom:10px">パスワードを入力してください</div>
<input id="pw" type="password" autofocus><button id="b">ログイン</button><div class="err" id="e"></div></div>
<script>
const go=async()=>{const e=document.getElementById('e');e.textContent='';
 try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})}).then(x=>x.json());
 if(r.ok){location.href='/';}else{e.textContent=r.error||'ログインできません';}}catch(_){e.textContent='通信に失敗しました';}};
document.getElementById('b').addEventListener('click',go);
document.getElementById('pw').addEventListener('keydown',ev=>{if(ev.key==='Enter')go();});
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    // #1 ローカル専用ガード（外部サイト/別ホスト名からのアクセスを拒否）
    if (!isLocalHostHeader(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('forbidden: このツールはローカル(localhost)からのみ利用できます');
    }
    // 死活確認（起動時の二重起動防止に使う）。ローカル限定・パスワード不要・機微情報なし。
    if (url === '/api/ping') {
      return sendJson(res, 200, { ok: true, app: 'kakaku-tenka-sim', rev: SIM_PAGE_REV });
    }
    if (url === '/api/shogo-status') {
      return sendJson(res, 200, shogoStatusPayload());
    }
    // #2 アクセスパスワード（settings.accessPassword が設定されている場合のみ）
    const accessPw = String((getSettings().accessPassword) || '').trim();
    if (accessPw) {
      if (req.method === 'POST' && url === '/api/login') {
        const body = await readBody(req);
        if (verifyAccessPassword(String((body && body.password) || ''), accessPw)) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': 'apw=' + pwToken(accessPw) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400',
          });
          return res.end('{"ok":true}');
        }
        return sendJson(res, 200, { ok: false, error: 'パスワードが違います' });
      }
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.apw !== pwToken(accessPw)) {
        if (req.method === 'GET' && !url.startsWith('/api/')) {
          const buf = Buffer.from(LOGIN_PAGE, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
          return res.end(buf);
        }
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end('{"ok":false,"error":"未認証（再読み込みしてログインしてください）"}');
      }
    }
    if (req.method === 'GET' && url === '/') {
      const buf = Buffer.from(PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'GET' && (url === '/manual' || url === '/使い方')) {
      // 使い方手順書（HTML）。無ければ .md をテキストで、それも無ければ案内を返す。
      const htmlPath = path.join(ROOT, '使い方手順書.html');
      const mdPath = path.join(ROOT, '使い方手順書.md');
      if (fs.existsSync(htmlPath)) {
        const buf = fs.readFileSync(htmlPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
        return res.end(buf);
      }
      if (fs.existsSync(mdPath)) {
        const md = fs.readFileSync(mdPath, 'utf8').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const buf = Buffer.from('<!doctype html><meta charset="utf-8"><title>使い方手順書</title><pre style="font-family:メイリオ,sans-serif;white-space:pre-wrap;max-width:900px;margin:24px auto;padding:0 16px;line-height:1.7">' + md + '</pre>', 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
        return res.end(buf);
      }
      const buf = Buffer.from('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">使い方手順書が見つかりません（使い方手順書.html / .md）。</p>', 'utf8');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'GET' && url === '/api/files') {
      return sendJson(res, 200, { files: listLatestCsv() });
    }
    if (req.method === 'GET' && url === '/api/calendar') {
      return sendJson(res, 200, buildCalendar());
    }
    if (req.method === 'GET' && url === '/api/pl') {
      return sendJson(res, 200, loadPL());
    }
    if (req.method === 'GET' && url === '/api/settings') {
      return sendJson(res, 200, { settings: settingsForClient(getSettings()), configured: isConfigured() });
    }
    if (req.method === 'POST' && url === '/api/settings') {
      const body = await readBody(req);
      try {
        const settings = saveSettings(body || {});
        invalidateCalcCaches(); // matchThreshold/既定ルール/端数/自社上乗せ等の変更を計算結果へ即反映
        return sendJson(res, 200, { ok: true, settings: settingsForClient(settings) });
      } catch (e) {
        // saveSettings は settings.json 破損時など保存中止で throw する＝成功扱いにしない
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    // 設定バックアップ一覧（/self の「設定の復元」UI 用）
    if (req.method === 'GET' && url === '/api/settings-backups') {
      return sendJson(res, 200, { ok: true, backups: listSettingsBackups() });
    }
    // 指定バックアップへ復元（復元前に現状も自動退避＝この復元自体も取り消せる）
    if (req.method === 'POST' && url === '/api/settings-restore') {
      const body = await readBody(req);
      try {
        const settings = restoreSettingsBackup((body && body.file) || '');
        invalidateCalcCaches(); // 端数/しきい値/既定ルール等が変わり得るので計算キャッシュを更新
        return sendJson(res, 200, { ok: true, settings });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    if (req.method === 'GET' && url === '/import') {
      const buf = Buffer.from(IMPORT_PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'GET' && url === '/list') {
      const buf = Buffer.from(LIST_PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'GET' && url === '/suppliers') {
      const buf = Buffer.from(SUPPLIERS_PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'GET' && url === '/self') {
      const buf = Buffer.from(SELF_PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'GET' && url === '/customers') {
      const buf = Buffer.from(CUSTOMERS_PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'GET' && url === '/cdlink') {
      const buf = Buffer.from(CDLINK_PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (url === '/api/customers-summary' && (req.method === 'GET' || req.method === 'POST')) {
      return sendJson(res, 200, aggregateCustomersSummary());
    }
    if (url === '/api/customers' && (req.method === 'GET' || req.method === 'POST')) {
      const opts = req.method === 'POST' ? (await readBody(req)) : {};
      return sendJson(res, 200, aggregateCustomers(opts));
    }
    if (req.method === 'POST' && url === '/api/customers-export') {
      const body = await readBody(req);
      const doIssue = body && body.action === 'issue';
      try { return sendJson(res, 200, exportCustomerQuotes(body || {}, doIssue)); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    // 得意先別メール送信先：一覧取得・1件保存（{ 得意先名: メールアドレス }）
    if (req.method === 'GET' && url === '/api/customer-emails') {
      return sendJson(res, 200, { ok: true, emails: getCustomerEmails() });
    }
    if (req.method === 'POST' && url === '/api/customer-email') {
      const body = await readBody(req);
      const customer = String((body && body.customer) || '').trim();
      if (!customer) return sendJson(res, 200, { ok: false, error: '得意先が指定されていません' });
      try { return sendJson(res, 200, { ok: true, emails: setCustomerEmail(customer, (body && body.email) || '') }); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    // 選択中の得意先1件を「発行＋PDF化＋Outlook下書き」まで一気に行う（送信ボタンは人が押す）。
    if (req.method === 'POST' && url === '/api/mail-quote') {
      const body = await readBody(req) || {};
      const customer = String(body.customer || '').trim();
      if (!customer) return sendJson(res, 200, { ok: false, error: '得意先が指定されていません' });
      // ① 選択中得意先だけ発行（既存の発行ロジックを再利用＝画面と提出物が一致）。
      //    ここで提出済み登録＋xlsx生成が確定する。② のPDF/Outlookが失敗してもこの発行は有効。
      let ex;
      try { ex = exportCustomerQuotes(Object.assign({}, body, { scope: 'one', customer }), true); }
      catch (e) { return sendJson(res, 200, { ok: false, error: '発行に失敗: ' + String(e && e.message || e) }); }
      if (!ex || ex.ok === false) return sendJson(res, 200, ex || { ok: false, error: '発行に失敗しました' });
      if (!ex.files || !ex.files.length) return sendJson(res, 200, { ok: false, error: '発行できる対象がありません（すでに提出済み、または実施日未設定の可能性があります）。' });
      const xlsxPath = path.join(ex.folder, ex.files[0]);
      const det = (ex.issuedDetail && ex.issuedDetail[0]) || {};
      // ② 件名・本文を雛形から組み立て（送信・再送で共用の composeQuoteMail）。
      const { subject, body: mailBody } = composeQuoteMail(customer, det.quoteNo || '', det.itemCount);
      const to = String(body.email || getCustomerEmails()[customer] || '').trim();
      // ③ PDF化 → Outlook作成ウィンドウ（PDF添付済み）を開く。
      //    COM失敗（Excel/Outlook未起動など）でも ① の発行は済んでいるので、その旨を正直に返す
      //    （issued:true でクライアントが提出済み状態を反映＝アイテムが消えて混乱、を防ぐ）。
      try {
        const pdf = await mailQuotePdf({ xlsxPath, to, subject, body: mailBody });
        return sendJson(res, 200, {
          ok: true, customer, quoteNo: det.quoteNo || '', itemCount: det.itemCount || 0,
          to, pdf: path.basename(pdf), folderName: ex.folderName,
          issuedCustomers: ex.issuedCustomers || [customer],
          noEmail: !to,
        });
      } catch (e) {
        return sendJson(res, 200, {
          ok: false, issued: true, customer, quoteNo: det.quoteNo || '', itemCount: det.itemCount || 0,
          folderName: ex.folderName, issuedCustomers: ex.issuedCustomers || [customer],
          error: '⚠ 見積書の発行（提出済み登録）は完了しましたが、PDF化またはOutlook起動に失敗しました。\n'
            + String(e && e.message || e)
            + '\n\n対処：Excel/Outlookが使える会社PCで実行しているか、対象xlsxを閉じているかをご確認ください。'
            + '発行済みの見積書は「📄 提出済の見積書を開く」から開けます（フォルダ: ' + ex.folderName + '）。',
        });
      }
    }
    // 提出済みの得意先を「再送」：再発行はせず、既存の提出済みxlsxからPDF化→Outlook下書きを開く。
    if (req.method === 'POST' && url === '/api/mail-quote-resend') {
      const body = await readBody(req) || {};
      const customer = String(body.customer || '').trim();
      if (!customer) return sendJson(res, 200, { ok: false, error: '得意先が指定されていません' });
      const ent = readIssueLog()[customer];
      if (!ent || !ent.folder) return sendJson(res, 200, { ok: false, error: 'この得意先の提出履歴がありません（先に「📧 見積を作成してメール」で発行してください）。' });
      const xlsxPath = findQuoteFile(path.join(OUTPUT_DIR, ent.folder), customer); // 様あり優先・旧名フォールバック
      if (!xlsxPath) return sendJson(res, 200, { ok: false, error: '提出済みの見積書ファイルが見つかりません（移動／削除された可能性: ' + ent.folder + '）。' });
      const { subject, body: mailBody } = composeQuoteMail(customer, ent.quoteNo || '', ent.itemCount);
      const to = String(body.email || getCustomerEmails()[customer] || '').trim();
      try {
        const pdf = await mailQuotePdf({ xlsxPath, to, subject, body: mailBody });
        return sendJson(res, 200, { ok: true, resend: true, customer, quoteNo: ent.quoteNo || '', to, pdf: path.basename(pdf), noEmail: !to });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: 'PDF化またはOutlook起動に失敗しました。\n' + String(e && e.message || e) + '\n\n対処：Excel/Outlookが使える会社PCで実行しているか、対象xlsxを閉じているかをご確認ください。' });
      }
    }
    // 見積書の提出（発行）履歴：得意先ページで「提出済み」を表示する。
    if (req.method === 'GET' && url === '/api/issue-log') {
      return sendJson(res, 200, { ok: true, log: readIssueLog() });
    }
    if (req.method === 'GET' && url === '/api/issued-quotes-list') {
      return sendJson(res, 200, { ok: true, ...buildIssuedQuotesList() });
    }
    if (req.method === 'GET' && url === '/api/manual-corrections-list') {
      return sendJson(res, 200, { ok: true, ...buildManualCorrectionsList() });
    }
    if (req.method === 'POST' && url === '/api/cross-customer-quotes') {
      // この商品を「他の得意先」にいくらで提出（発行）したかを横断収集。表示専用・価格/照合に無影響。
      const body = await readBody(req);
      const rowKey = String((body && body.rowKey) || '').trim();
      if (!rowKey) return sendJson(res, 200, { ok: false, error: 'rowKey は必須です' });
      const excl = String((body && body.customer) || '').trim();   // この得意先自身は除く
      const productName = String((body && body.productName) || ''); // モーダル見出し用（クライアントから受領）
      return sendJson(res, 200, { ok: true, productName, ...buildCrossCustomerQuotes(rowKey, excl) });
    }
    if (req.method === 'GET' && url === '/api/manual-corrections.csv') {
      const buf = Buffer.from(buildManualCorrectionsCsv(), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="手動修正一覧.csv"',
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }
    if (req.method === 'POST' && url === '/api/issue-log-reset') {
      const body = await readBody(req);
      const cust = body && body.customer;
      let ok;
      if (cust) { const log = readIssueLog(); delete log[cust]; ok = writeIssueLog(log); } // 1得意先だけ取消
      else { ok = writeIssueLog({}); }                                                     // 全リセット（新サイクル用）
      if (!ok) return sendJson(res, 200, { ok: false, error: '保存に失敗しました（発行履歴.json に書き込めません）' });
      clearIssuedStatuses(cust || null); // 提出済みアイテムも対象へ戻す（検討中・手動修正は残す）＝バッジと別枠を同期
      invalidateCalcCaches(); // 提出済みバッジ（calcAllが焼き込む itemStatus）をメイン表示へ即反映
      return sendJson(res, 200, { ok: true, log: readIssueLog() });
    }
    if (req.method === 'POST' && url === '/api/item-status') {
      // 得意先別アイテムの状態：'hold'=検討中 / 'dormant'=休眠 / 'manual'=手動修正 / ''=対象に戻す。
      const body = await readBody(req);
      const customer = String((body && body.customer) || '').trim();
      const rowKey = String((body && body.rowKey) || '').trim();
      const st = body && body.status;
      const status = (st === 'manual' || st === 'hold' || st === 'dormant') ? st : '';
      if (!customer || !rowKey) return sendJson(res, 200, { ok: false, error: 'customer と rowKey は必須です' });
      const snap = (body && body.snapshot) || body || {};
      const ok = setItemStatus(customer, rowKey, status, snap);
      invalidateCalcCaches(); // 検討中/手動修正/対象 の切替を calcAll（メイン表示の非表示判定）へ即反映
      if (!ok) return sendJson(res, 200, { ok: false, error: '保存に失敗しました（品目ステータス.json に書き込めません）' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/item-status-bulk') {
      // 複数アイテムをまとめて 検討中('hold') / 休眠('dormant') / 手動修正('manual') / 対象('') へ。
      const body = await readBody(req);
      const customer = String((body && body.customer) || '').trim();
      const st = body && body.status;
      const status = (st === 'manual' || st === 'hold' || st === 'dormant') ? st : '';
      const items = Array.isArray(body && body.items) ? body.items : [];
      const rowKeys = Array.isArray(body && body.rowKeys) ? body.rowKeys : [];
      if (!customer || (!items.length && !rowKeys.length)) return sendJson(res, 200, { ok: false, error: 'customer と rowKeys/items は必須です' });
      const r = setItemStatusBulk(customer, rowKeys, status, items.length ? items : null);
      invalidateCalcCaches(); // 一括の状態変更も calcAll へ即反映
      if (!r.ok) return sendJson(res, 200, { ok: false, changed: r.changed, error: '保存に失敗しました（品目ステータス.json に書き込めません）' });
      return sendJson(res, 200, { ok: true, changed: r.changed });
    }
    if (req.method === 'GET' && url === '/api/suppliers') {
      return sendJson(res, 200, { suppliers: getSuppliers() });
    }
    if (req.method === 'POST' && url === '/api/upload-suppliers') {
      const body = await readBody(req);
      try {
        const { records } = readUploadedTableFile((body && body.b64) || '', (body && body.filename) || '');
        const suppliers = parseSuppliersFromRecords(records);
        return sendJson(res, 200, { ok: true, suppliers });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    if (req.method === 'POST' && url === '/api/save-suppliers') {
      const body = await readBody(req);
      const saved = saveSuppliers((body && body.suppliers) || {});
      return sendJson(res, 200, { ok: true, suppliers: saved });
    }
    if (req.method === 'GET' && url === '/api/maker-purchase-codes') {
      // 全メーカー（maker_quotes ベース）と、現在の purchaseCode 設定を一括返却
      const items = listMakerQuotes();
      const makers = getMakers();
      const out = items.map((it) => ({
        supplier: it.supplier,
        purchaseCode: (makers[it.supplier] && makers[it.supplier].purchaseCode) || '',
      }));
      return sendJson(res, 200, { items: out });
    }
    if (req.method === 'POST' && url === '/api/maker-purchase-code') {
      const body = await readBody(req);
      const maker = String((body && body.maker) || '').trim();
      const code = String((body && body.code) || '').trim();
      if (!maker) return sendJson(res, 200, { ok: false, error: 'メーカー名が空です' });
      saveMakerProfile(maker, { purchaseCode: code });
      invalidateCalcCaches(); // 9000=自社製造 切替は calcAll の isSelfMade/価格異常判定に効く（完全反映は↻照合）
      return sendJson(res, 200, { ok: true, maker, purchaseCode: code });
    }
    if (req.method === 'GET' && url === '/api/self-profile') {
      return sendJson(res, 200, { selfProfile: getSelfProfile() });
    }
    if (req.method === 'GET' && url === '/api/hanbai-source') {
      // 照合エンジンが実際に使う販売実績ファイルの情報を返す。
      // config.hanbai.path がフォルダなら resolveHanbaiSource が最新の .xls/.xlsx/.csv を選ぶ。
      const s = getSettings();
      const configured = (s.hanbai && s.hanbai.path) || '';
      let resolved = null, mtime = null, size = null, format = '', isDir = false, dirPath = '';
      try {
        if (configured) {
          const st = fs.statSync(configured);
          isDir = st.isDirectory();
          dirPath = isDir ? configured : path.dirname(configured);
        }
        resolved = resolveHanbaiSource(configured);
        if (resolved) {
          const rst = fs.statSync(resolved);
          mtime = new Date(rst.mtimeMs).toISOString();
          size = rst.size;
          const ext = (resolved.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
          format = ext;
        }
      } catch (e) { /* ignore */ }
      // 取得元（file/db/auto）。DB直結なら過去約1年のローリング期間も返す（ファイル設定は使わない旨を画面で案内）。
      const source = String((s.hanbai && s.hanbai.source) || 'file');
      let dbRange = null;
      if (source === 'db' || source === 'auto') {
        try {
          const { defaultRange } = require('./db_hanbai');
          const dbCfg = (s.hanbai && s.hanbai.db) || {};
          const r = defaultRange();
          dbRange = { start: dbCfg.start || r.start, end: dbCfg.end || r.end };
        } catch (e) { /* ignore */ }
      }
      // 照合に含めるさかのぼり期間。0=全期間／12〜60=その月数。未設定は0(全期間)扱い。年間金額(損益)は常に直近約1年なので歪まない。
      const candidateMonths = (() => { const v = Math.round(Number((s.hanbai && s.hanbai.candidateMonths))); if (!Number.isFinite(v) || v <= 0) return 0; return Math.max(12, Math.min(60, v)); })();
      // 自社製造品のDB抽出（日野折箱店の折箱）の有効/設定。/self の取り込みボタン表示判定に使う。
      const sm = s.selfManufacture || {};
      const selfManufacture = { enabled: !!sm.enabled, supplier: sm.supplier || '', bun1: sm.bun1 || [], bun2: sm.bun2 };
      return sendJson(res, 200, {
        configured, isDir, dirPath, resolved,
        resolvedName: resolved ? path.basename(resolved) : null,
        mtime, size, format, source, dbRange, candidateMonths, selfManufacture,
      });
    }
    if (req.method === 'POST' && url === '/api/hanbai-period') {
      // 照合に含める「さかのぼり期間（月数）」を保存。0=全期間／それ以外は12〜60に丸める。年間金額(損益)は直近約1年のまま。
      const body = await readBody(req);
      let months = Math.round(Number(body && body.months));
      if (!Number.isFinite(months)) return sendJson(res, 200, { ok: false, error: '月数が不正です' });
      months = months <= 0 ? 0 : Math.max(12, Math.min(60, months)); // 0=全期間
      saveSettings({ hanbai: { candidateMonths: months } }); // hanbai は浅いマージ＝source/db は保持
      _hanbaiCache = null; // 自社品検索のキャッシュも破棄（次回 最新期間で読む）
      return sendJson(res, 200, { ok: true, candidateMonths: months });
    }
    if (req.method === 'POST' && url === '/api/upload-self') {
      const body = await readBody(req);
      try {
        const { records, headers } = readUploadedTableFile((body && body.b64) || '', (body && body.filename) || '');
        // 自社販売実績は階層 (得意先見出し → 商品行 → 合計行) なので、先頭〜30件を grid 形式で返す
        const limit = 30;
        const sample = records.slice(0, limit);
        const grid = sample.map((r) => headers.map((h) => r[h]));
        // 列1の中身を parseSelfName でプレビュー
        const parsed = sample.map((r) => {
          const cell = String((r[headers[0]] != null ? r[headers[0]] : '') || '');
          return parseSelfName(cell);
        });
        return sendJson(res, 200, { ok: true, headers, grid, parsed, total: records.length });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    if (req.method === 'POST' && url === '/api/save-self-profile') {
      const body = await readBody(req);
      const saved = saveSelfProfile((body && body.selfProfile) || null);
      return sendJson(res, 200, { ok: true, selfProfile: saved });
    }
    if (req.method === 'GET' && url.startsWith('/api/maker-import-hint')) {
      const sp = new URLSearchParams(req.url.split('?')[1] || '');
      const supplier = (sp.get('supplier') || '').trim();
      return sendJson(res, 200, buildMakerImportHint(supplier));
    }
    if (req.method === 'POST' && url === '/api/maker-import-check') {
      const body = await readBody(req);
      const supplier = String((body && body.supplier) || '').trim();
      const items = Array.isArray(body && body.items) ? body.items : [];
      return sendJson(res, 200, buildMakerImportHint(supplier, items));
    }
    if (req.method === 'POST' && url === '/api/noise-rows') {
      const body = await readBody(req);
      const supplier = String((body && body.supplier) || '').trim();
      const rows = Array.isArray(body && body.rows) ? body.rows : [];
      const skipMap = supplier ? importSkipMap(supplier) : null;
      const flags = rows.map((r) => {
        const base = describeNoiseRow({
          name: r.makerName,
          makerCode: r.makerCode,
          currentCost: r.currentCost,
          newCost: r.newCost,
        });
        const saved = supplier ? lookupImportSkip(supplier, r, skipMap) : null;
        if (saved) {
          return {
            noise: base.noise,
            reason: saved.reason || base.reason || '前回取込対象外',
            remembered: true,
            savedAt: saved.at,
            savedTimes: saved.times || 1,
          };
        }
        return Object.assign({ remembered: false }, base);
      });
      return sendJson(res, 200, { flags, savedSkipCount: supplier ? getImportSkips(supplier).length : 0 });
    }
    if (req.method === 'GET' && url.startsWith('/api/import-skips')) {
      const sp = new URLSearchParams(req.url.split('?')[1] || '');
      const supplier = (sp.get('supplier') || '').trim();
      const skips = getImportSkips(supplier);
      return sendJson(res, 200, { supplier, skips, count: skips.length });
    }
    if (req.method === 'POST' && url === '/api/import-skip-remove') {
      const body = await readBody(req);
      const supplier = String((body && body.supplier) || '').trim();
      const key = String((body && body.key) || '').trim();
      if (!supplier || !key) return sendJson(res, 200, { ok: false, error: '仕入先と key が必要です' });
      try {
        const skips = removeImportSkip(supplier, key);
        return sendJson(res, 200, { ok: true, supplier, count: skips.length });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    if (req.method === 'GET' && url === '/api/maker-list') {
      return sendJson(res, 200, { items: listMakerQuotes() });
    }
    if (req.method === 'POST' && url === '/api/open') {
      const body = await readBody(req);
      try {
        const p = String((body && body.path) || '');
        if (!p) return sendJson(res, 200, { ok: false, error: 'pathが空です' });
        const opened = safeOpenPath(p);
        return sendJson(res, 200, { ok: true, opened });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    // 得意先ページから「提出済みの見積書」を直接開く。発行履歴(folder)＋得意先名で
    //  output/<folder>/見積_<得意先>.xlsx を特定して開く。ファイルが無ければフォルダを開く。
    if (req.method === 'POST' && url === '/api/open-issued') {
      const body = await readBody(req);
      try {
        const customer = String((body && body.customer) || '').trim();
        if (!customer) return sendJson(res, 200, { ok: false, error: '得意先が空です' });
        const ent = readIssueLog()[customer];
        if (!ent || !ent.folder) return sendJson(res, 200, { ok: false, error: 'この得意先の提出履歴がありません' });
        const folderPath = path.join(OUTPUT_DIR, ent.folder);
        const filePath = findQuoteFile(folderPath, customer); // 様あり優先・旧 様なし もフォールバック
        if (filePath) { safeOpenPath(filePath); return sendJson(res, 200, { ok: true, opened: 'file' }); }
        if (fs.existsSync(folderPath)) { safeOpenPath(folderPath); return sendJson(res, 200, { ok: true, opened: 'folder', note: '見積書ファイルが見つからないためフォルダを開きました' }); }
        return sendJson(res, 200, { ok: false, error: '見積書フォルダが見つかりません（移動／削除された可能性: ' + ent.folder + '）' });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    // 販売大臣 単価履歴CSV：件数の事前確認（ダウンロード前にユーザへ提示）
    if (req.method === 'POST' && url === '/api/hanbai-export-check') {
      const body = await readBody(req);
      try {
        const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(String(body && body.cutoff)) ? body.cutoff : todayIso();
        const issuedOnly = !!(body && body.issuedOnly);
        const r = buildHanbaiExport(cutoff, issuedOnly);
        return sendJson(res, 200, { ok: true, cutoff, issuedOnly, count: r.count, customerCount: r.customerCount, missingTax: r.missingTax, dbError: r.dbError, ambiguous: multiMatchCheck().length });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    // 販売大臣 単価履歴CSV：ダウンロード（Shift_JIS）。GETナビゲーションで添付ダウンロード。
    if (req.method === 'GET' && url === '/api/hanbai-export') {
      try {
        let cutoff = todayIso(); let issuedOnly = false;
        const qi = req.url.indexOf('?');
        if (qi >= 0) { const sp = new URLSearchParams(req.url.slice(qi + 1)); const c = sp.get('cutoff'); if (/^\d{4}-\d{2}-\d{2}$/.test(String(c))) cutoff = c; issuedOnly = sp.get('issuedOnly') === '1'; }
        const r = buildHanbaiExport(cutoff, issuedOnly);
        const fnAscii = 'tanka_rireki_' + cutoff + '.csv';
        const fnJp = '単価履歴_' + cutoff + '.csv';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=Shift_JIS',
          'Content-Disposition': 'attachment; filename="' + fnAscii + '"; filename*=UTF-8\'\'' + encodeURIComponent(fnJp),
          'Content-Length': r.buffer.length,
        });
        return res.end(r.buffer);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('export error: ' + String(e && e.message || e));
      }
    }
    // 仕入先単価（新原価）更新CSV：件数の事前確認（ダウンロード前にユーザへ提示）
    if (req.method === 'POST' && url === '/api/cost-export-check') {
      const body = await readBody(req);
      try {
        const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(String(body && body.cutoff)) ? body.cutoff : todayIso();
        const r = buildCostExport(cutoff);
        return sendJson(res, 200, { ok: true, cutoff, count: r.count, productCount: r.productCount, skipped: r.skipped, ambiguous: multiMatchCheck().length });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    // 仕入先単価（新原価）更新CSV：ダウンロード（Shift_JIS）。GETナビゲーションで添付ダウンロード。
    if (req.method === 'GET' && url === '/api/cost-export') {
      try {
        let cutoff = todayIso();
        const qi = req.url.indexOf('?');
        if (qi >= 0) { const sp = new URLSearchParams(req.url.slice(qi + 1)); const c = sp.get('cutoff'); if (/^\d{4}-\d{2}-\d{2}$/.test(String(c))) cutoff = c; }
        const r = buildCostExport(cutoff);
        const fnAscii = 'shiire_genka_' + cutoff + '.csv';
        const fnJp = '仕入原価更新_' + cutoff + '.csv';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=Shift_JIS',
          'Content-Disposition': 'attachment; filename="' + fnAscii + '"; filename*=UTF-8\'\'' + encodeURIComponent(fnJp),
          'Content-Length': r.buffer.length,
        });
        return res.end(r.buffer);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('export error: ' + String(e && e.message || e));
      }
    }
    if (req.method === 'GET' && url === '/api/makers') {
      return sendJson(res, 200, { makers: getMakers() });
    }
    if (req.method === 'GET' && url === '/api/product-links') {
      return sendJson(res, 200, { productLinks: getProductLinks() });
    }
    if (req.method === 'POST' && url === '/api/product-link') {
      const body = await readBody(req);
      const sup = String((body && body.supplier) || '').trim();
      const code = normalizeLinkCode((body && body.productCode) || '');
      const name = (body && body.makerName != null) ? String(body.makerName).trim() : '';
      if (!sup || !code) return sendJson(res, 200, { ok: false, error: 'supplier と productCode は必須です' });
      let linkWarn = '';
      if (name && !isExcludeLink(name)) { // 除外マークは実在メーカー名でないので候補チェックを行わない
        const ctx = linkContext(sup);
        const makers = ctx.makerNames || [];
        if (makers.length && !makers.includes(name)) {
          linkWarn = '登録したメーカー品名が、この仕入先の照合結果に見つかりません。候補リストから選ぶと表記ゆれで消える事故を防げます。';
        }
      }
      const links = saveProductLink(sup, code, name);
      invalidateCalcCaches(); // 紐付けは calcAll に即反映（古い計算結果キャッシュを破棄＝再照合せずとも画面が更新される）
      return sendJson(res, 200, { ok: true, productLinks: links, linkWarn: linkWarn || undefined });
    }
    if (req.method === 'POST' && url === '/api/maker-quote') {
      const body = await readBody(req);
      const saved = saveMakerQuote(body);
      // 取り込んだら自動で照合（maker_quotes × 販売実績 → input/）を実行し、
      //  利用者が「↻ 照合を実行」を押さなくても対象に出るようにする。
      if (saved && saved.ok) {
        try {
          const outFiles = runShogoGuarded(['', '']); // 既定: maker_quotes/ 全件 × config.hanbai
          invalidateCaches(); // 照合し直したので古いキャッシュを破棄
          saved.shogo = { ok: true, files: (outFiles || []).map((f) => path.basename(f)) };
          // 二重登録の検知：取り込んだ仕入先と「別の仕入先」に同じ自社商品が出ていないか。
          //  例: 修正見積を違う仕入先名で取り込むと、同じ商品が2仕入先に出て二重になる。
          try {
            const mySup = String((body && body.supplier) || '').trim();
            const all = crossSupplierDupCheck();
            const mine = all.filter((d) => d.suppliers.indexOf(mySup) >= 0);
            if (mine.length) saved.dupWarning = { count: mine.length, supplier: mySup, items: mine.slice(0, 8) };
          } catch (_) { /* 検知失敗は無視（保存は成功） */ }
        } catch (e) {
          saved.shogo = e.code === 'SHOGO_BUSY'
            ? { ok: false, busy: true, error: e.message }
            : { ok: false, error: String(e && e.message || e) };
        }
      }
      return sendJson(res, 200, saved);
    }
    if (req.method === 'POST' && url === '/api/self-from-db') {
      // 自社製造品（日野折箱店）を DB の商品分類から抽出して取込CSVを再生成 → 自動で照合。
      const r = refreshSelfFromDb();
      if (r && r.ok) {
        try {
          const outFiles = runShogoGuarded(['', '']);
          invalidateCaches(); // 照合し直したので古いキャッシュを破棄
          r.shogo = { ok: true, files: (outFiles || []).map((f) => path.basename(f)) };
        } catch (e) {
          r.shogo = e.code === 'SHOGO_BUSY'
            ? { ok: false, busy: true, error: e.message }
            : { ok: false, error: String(e && e.message || e) };
        }
      }
      return sendJson(res, 200, r);
    }
    if (req.method === 'POST' && url === '/api/read-xlsx') {
      // 取り込み画面の「ファイルを選択」(Excel) 用：base64で受け取りシート一覧と表(grid)を返す
      const body = await readBody(req);
      try {
        const b64 = String((body && body.b64) || '');
        if (!b64) return sendJson(res, 200, { ok: false, error: 'ファイルが空です' });
        const buf = Buffer.from(b64, 'base64');
        const { sheets } = readXlsxBuffer(buf);
        // 空シートは除外しつつ、日付シリアル→YYYY-MM-DD、価格列の浮動小数を整形して返す
        const out = sheets
          .filter((s) => Array.isArray(s.grid) && s.grid.some((r) => r.some((c) => String(c || '').trim() !== '')))
          .map((s) => ({ name: s.name, grid: normalizeMakerGrid(s.grid) }));
        if (!out.length) return sendJson(res, 200, { ok: false, error: '読み取れる中身がありません' });
        return sendJson(res, 200, { ok: true, sheets: out });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    if (req.method === 'GET' && url === '/api/ai-status') {
      // 取り込み画面が「🤖 AIで読み取る」ボタンを出すか判断するための死活情報（キー本体は返さない）
      try { return sendJson(res, 200, Object.assign({ ok: true }, ai.status())); }
      catch (e) { return sendJson(res, 200, { ok: false, enabled: false, error: String(e && e.message || e) }); }
    }
    if (req.method === 'POST' && url === '/api/ai-extract') {
      // メーカー見積（貼り付けテキスト or PDF base64）を AI で抽出 → 取り込みグリッド用の2次元配列を返す。
      //  ⚠ ここで返すのは「提案」。確定は従来どおり ③確認グリッド＋人（saveMakerQuote 経由）。
      const body = await readBody(req);
      try {
        const result = await ai.extractMakerQuote({
          supplier: String((body && body.supplier) || ''),
          text: (body && body.text != null) ? String(body.text) : '',
          pdfB64: (body && body.pdfB64) ? String(body.pdfB64) : '',
        });
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    if (req.method === 'POST' && url === '/api/shogo') {
      // メーカー見積 × 販売実績 を照合し input/ へ出力（中身は 照合.bat と同じ）
      try {
        if (isViewOnly()) return sendJson(res, 200, { ok: false, error: '🔒 閲覧モード：このPCはDBに接続できないため照合できません。照合はDBのある会社PCで「↻ 照合」を実行してください（結果CSVはDrive同期で届きます）。' });
        const outFiles = runShogoGuarded(['', '']); // 既定: maker_quotes/ 全件 × config.hanbai
        invalidateCaches(); // 照合し直したので古いキャッシュ（自社品検索・照合結果）を破棄
        return sendJson(res, 200, { ok: true, files: (outFiles || []).map((f) => path.basename(f)) });
      } catch (e) {
        if (e.code === 'SHOGO_BUSY') return sendJson(res, 200, shogoBusyJson());
        return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    }
    if (req.method === 'POST' && url === '/api/calc') {
      const body = await readBody(req);
      return sendJson(res, 200, calcAllCached(body));
    }
    if (req.method === 'POST' && url === '/api/calc-all') {
      const body = await readBody(req);
      return sendJson(res, 200, calcAllSuppliers(body));
    }
    if (req.method === 'GET' && url === '/api/customer-list') {
      return sendJson(res, 200, customerExclusionData());
    }
    if (req.method === 'POST' && url === '/api/exclude-customer') {
      const body = await readBody(req);
      const customer = String((body && body.customer) || '').trim();
      if (!customer) return sendJson(res, 200, { ok: false, error: '得意先名が空です' });
      setExcludedCustomer(customer, !!(body && body.exclude));
      invalidateCalcCaches(); // 除外/復活は calcAll の対象に即反映（メイン・損益・得意先別・見積書から外す/戻す）
      return sendJson(res, 200, Object.assign({ ok: true }, customerExclusionData()));
    }
    if (req.method === 'POST' && url === '/api/exclude-customers-bulk') {
      const body = await readBody(req);
      const names = Array.isArray(body && body.names) ? body.names : [];
      setExcludedCustomersBulk(names, !!(body && body.exclude));
      invalidateCalcCaches(); // 一括除外/復活も同様に即反映
      return sendJson(res, 200, Object.assign({ ok: true }, customerExclusionData()));
    }
    if (req.method === 'POST' && url === '/api/impact-all') {
      const body = await readBody(req);
      return sendJson(res, 200, impactAllSuppliers(body));
    }
    if (req.method === 'POST' && url === '/api/calc-by-date') {
      const body = await readBody(req);
      try { return sendJson(res, 200, calcByDate(body)); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    if (req.method === 'GET' && url === '/api/dup-check') {
      try { return sendJson(res, 200, { ok: true, dups: crossSupplierDupCheck() }); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e), dups: [] }); }
    }
    if (req.method === 'GET' && url === '/api/link-check') {
      try {
        const r = buildProductLinkCheck();
        return sendJson(res, 200, {
          ok: true, issues: r.issues.slice(0, 80), count: r.count,
          mismatchCount: r.mismatchCount, orphanCount: r.orphanCount,
          betterCount: r.betterCount || 0, betterCdCount: r.betterCdCount || 0, betterNameCount: r.betterNameCount || 0,
          revivalCount: r.revivalCount || 0,
        });
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e), issues: [], count: 0 }); }
    }
    // 照合 精度レポート（最新CSV × 人が確定した正解＝productLinks+cdReview）。読み取り専用。
    if (req.method === 'GET' && url === '/api/match-audit') {
      try { const { buildMatchAudit } = require('./matchaudit'); return sendJson(res, 200, Object.assign({ ok: true }, buildMatchAudit({ getSettings }))); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    // CD一致化 候補（メーカー品番をマスタ商品名3に登録すればCD一致にできる品）
    if (req.method === 'GET' && url === '/api/cd-candidates') {
      try { const r = buildCdCandidates(); return sendJson(res, 200, { ok: true, count: r.count, dormantWithCode: r.dormantWithCode, items: r.items.slice(0, 300) }); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e), count: 0 }); }
    }
    // 🔁 再見積もり要：提出済み単価が、最新照合の新原価で逆ザヤ/利幅薄になっていないか。
    if (req.method === 'GET' && url === '/api/requote-check') {
      try {
        // 最新照合から (仕入先|自社CD) -> 新仕入原価 を作る（newCost は applyCostOverrides 反映済み）。
        const costByKey = new Map();
        for (const f of listLatestCsv()) {
          const sup = String(f).split('_照合結果_')[0];
          let recs; try { recs = getRecs(f); } catch (e) { continue; }
          for (const rec of recs) {
            const cd = padRequoteCode(rec.productCode);
            if (!cd || !Number.isFinite(Number(rec.newCost)) || Number(rec.newCost) <= 0) continue;
            costByKey.set(sup + '|' + cd, Number(rec.newCost)); // 同一品が複数得意先行に出るが新原価は同一
          }
        }
        const r = auditRequote(readItemStatus(), costByKey, { marginPct: 10 });
        return sendJson(res, 200, { ok: true, count: r.count, gyaku: r.gyaku, thin: r.thin, up: r.up, down: r.down, items: r.issues.slice(0, 200) });
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e), count: 0 }); }
    }
    // 仕入原価の異常チェック（商品マスタCSVを直下/input に置けばライブ監査）。DB不要・read only。
    //  costAudit.js を再利用：A)原価が年(列ズレ破損) B)逆ザヤ(原価>売価) C)高額。
    if (req.method === 'GET' && url === '/api/cost-audit') {
      try {
        const file = findMasterCsv();
        if (!file) return sendJson(res, 200, { ok: true, placed: false });
        const r = costAuditRows(file);
        if (!r.ok) return sendJson(res, 200, { ok: true, placed: true, colError: true, file: path.basename(file), headers: r.headers });
        return sendJson(res, 200, {
          ok: true, placed: true, file: path.basename(file),
          count: r.count, year: r.year, gyaku: r.gyaku, big: r.big,
          cols: { code: r.codeCol, cost: r.costCol, sell: r.sellCol || '', name: r.nameCol || '' },
          rows: r.rows.slice(0, 300),
        });
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    if (req.method === 'GET' && url === '/api/cost-audit.csv') {
      try {
        const file = findMasterCsv();
        const r = file ? costAuditRows(file) : { ok: false };
        const buf = Buffer.from(costAuditCsv(r.ok ? r.rows : []), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="cost_audit.csv"; filename*=UTF-8\'\'' + encodeURIComponent('仕入原価_異常候補.csv'),
          'Content-Length': buf.length,
        });
        return res.end(buf);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('export error: ' + String(e && e.message || e));
      }
    }
    if (req.method === 'GET' && url === '/api/multimatch.csv') {
      try {
        const buf = Buffer.from(buildMultiMatchCsv(), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="multimatch.csv"; filename*=UTF-8\'\'' + encodeURIComponent('単価不確定の品.csv'),
          'Content-Length': buf.length,
        });
        return res.end(buf);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('export error: ' + String(e && e.message || e));
      }
    }
    if (req.method === 'GET' && url === '/api/cd-dormant.csv') {
      try {
        const buf = Buffer.from(buildCdDormantCsv(), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="cd_dormant.csv"; filename*=UTF-8\'\'' + encodeURIComponent('品番あり休眠_要マスタ登録.csv'),
          'Content-Length': buf.length,
        });
        return res.end(buf);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('export error: ' + String(e && e.message || e));
      }
    }
    if (req.method === 'GET' && url === '/api/cd-candidates.csv') {
      try {
        const buf = Buffer.from(buildCdCandidatesCsv(), 'utf8');
        const fnJp = 'CD一致化候補.csv';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="cd_candidates.csv"; filename*=UTF-8\'\'' + encodeURIComponent(fnJp),
          'Content-Length': buf.length,
        });
        return res.end(buf);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('export error: ' + String(e && e.message || e));
      }
    }
    if (req.method === 'GET' && url === '/api/link-context') {
      try { const sp = new URLSearchParams(req.url.split('?')[1] || ''); return sendJson(res, 200, linkContext(sp.get('supplier') || '')); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    // --- コード化（初期登録）レビュー ---
    if (req.method === 'POST' && url === '/api/cd-confirm') {
      // 候補を確定：productLinks に登録（↻照合で手動紐付けに）＋ メーカー品番を記録（書き戻しCSV用）。
      const body = await readBody(req);
      const sup = String((body && body.supplier) || '').trim();
      const sc = String((body && body.selfCode) || '').trim();
      if (!sup || !sc) return sendJson(res, 200, { ok: false, error: 'supplier と selfCode は必須です' });
      try { confirmCdLink(sup, sc, (body && body.makerCode) || '', (body && body.makerName) || ''); invalidateCalcCaches(); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    if (req.method === 'POST' && url === '/api/cd-reject') {
      const body = await readBody(req);
      const sup = String((body && body.supplier) || '').trim();
      const sc = String((body && body.selfCode) || '').trim();
      if (!sup || !sc) return sendJson(res, 200, { ok: false, error: 'supplier と selfCode は必須です' });
      try { rejectCdLink(sup, sc, (body && body.makerCode) || ''); invalidateCalcCaches(); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    if (req.method === 'POST' && url === '/api/cd-unconfirm') {
      const body = await readBody(req);
      const sup = String((body && body.supplier) || '').trim();
      const sc = String((body && body.selfCode) || '').trim();
      if (!sup || !sc) return sendJson(res, 200, { ok: false, error: 'supplier と selfCode は必須です' });
      try { unconfirmCdLink(sup, sc); invalidateCalcCaches(); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    if (req.method === 'GET' && url === '/api/cd-confirmed') {
      // 確定済み一覧（書き戻し前の確認用）。{ items:[{supplier,selfCode,makerCode,makerName,at}], count }
      try {
        const rv = getCdReview();
        const items = [];
        for (const sup of Object.keys(rv.confirmed || {})) {
          for (const sc of Object.keys(rv.confirmed[sup] || {})) {
            const e = rv.confirmed[sup][sc] || {};
            items.push({ supplier: sup, selfCode: sc, makerCode: e.code || '', makerName: e.name || '', at: e.at || '' });
          }
        }
        items.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), 'ja') || String(a.selfCode).localeCompare(String(b.selfCode)));
        return sendJson(res, 200, { ok: true, items, count: items.length });
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e), items: [], count: 0 }); }
    }
    if (req.method === 'GET' && url === '/api/cd-register.csv') {
      // 確定済みを「商品マスタ取込用」CSV（UTF-8 BOM）に。商品コード＋メーカー品番（商品名3へ登録）。
      //  ※販売大臣の商品マスタ取込フォーマット（列名/SJIS要否）は実機で要確認＝まずは汎用CSV。
      try {
        const rv = getCdReview();
        const cell = (v) => { const s = (v == null ? '' : String(v)); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const lines = [['商品コード', '商品名3（メーカー品番）', '現商品名（参考）', '仕入先'].join(',')];
        for (const sup of Object.keys(rv.confirmed || {})) {
          for (const sc of Object.keys(rv.confirmed[sup] || {})) {
            const e = rv.confirmed[sup][sc] || {};
            lines.push([sc, e.code || '', e.name || '', sup].map(cell).join(','));
          }
        }
        const buf = Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="cd_register.csv"; filename*=UTF-8\'\'' + encodeURIComponent('商品名3登録用.csv'),
          'Content-Length': buf.length,
        });
        return res.end(buf);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('export error: ' + String(e && e.message || e));
      }
    }
    if (req.method === 'GET' && url === '/api/self-products') {
      // 休眠（メーカー品が未マッチ）の手動紐付け用：販売実績の自社品（自社CD）候補を返す。
      try { const sp = new URLSearchParams(req.url.split('?')[1] || ''); return sendJson(res, 200, selfProducts(sp.get('supplier') || '', sp.get('force') === '1')); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    if (req.method === 'POST' && url === '/api/export') {
      const body = await readBody(req);
      const result = exportQuotes(body);
      if (result.ok === false) return sendJson(res, 200, result); // 対象0件は Explorer を開かない
      if (process.platform === 'win32') execFile('explorer', [result.folder]);
      else if (process.platform === 'darwin') execFile('open', [result.folder]);
      return sendJson(res, 200, result);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

// 既定ブラウザでURLを開く（OS別）。
function openBrowser(urlStr) {
  if (process.platform === 'win32') exec(`start "" "${urlStr}"`);
  else if (process.platform === 'darwin') exec(`open "${urlStr}"`);
  else exec(`xdg-open "${urlStr}"`);
}
// 指定ポートで「このツールのサーバが既に動いているか」を死活確認（/api/ping が app名を返すか）。
function probeOurServer(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => {
        try { const j = JSON.parse(d); resolve(!!(j && j.app === 'kakaku-tenka-sim')); }
        catch (_) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function listen(port) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < PORT_START + 20) listen(port + 1);
    else { console.error('サーバ起動に失敗:', e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const urlStr = `http://localhost:${port}`;
    console.log('=== 価格転嫁シミュレーション ===');
    console.log('ブラウザで開きます: ' + urlStr);
    if (port === PORT_START) console.log('※ ブックマーク用URL（次回からこれを開けばOK）: ' + urlStr);
    else console.log('※ ' + PORT_START + ' が使用中だったため ' + port + ' で起動しました（古いウィンドウを閉じて開き直すと ' + PORT_START + ' に戻ります）。');
    console.log('（終了するにはこの画面で Ctrl+C）');
    openBrowser(urlStr);
  });
}

// 既に起動済みなら二重起動せず、その画面(:8765)をブラウザで開くだけ。未起動なら 8765 で起動。
//  → ポートが固定されるので、ブックマーク(http://localhost:8765)が毎回確実に効く。
async function startOrReuse() {
  const urlStr = `http://localhost:${PORT_START}`;
  const alreadyRunning = await probeOurServer(PORT_START);
  if (alreadyRunning) {
    console.log('✓ すでに起動しています。その画面をブラウザで開きました: ' + urlStr);
    console.log('（二重には起動しません。このウィンドウは閉じて構いません。終了はもとのウィンドウで Ctrl+C）');
    openBrowser(urlStr);
    setTimeout(() => process.exit(0), 600); // ブラウザ起動コマンドを投げてから終了
    return;
  }
  listen(PORT_START);
}

// 直接 `node src/server.js` で起動したときだけサーバを立てる（テスト時は require のみ）
if (require.main === module) {
  // 想定外の例外・未処理のPromise拒否が起きても、サーバプロセスを落とさず動かし続ける。
  //  （1回のエラーで全停止すると、以降すべての操作が「Failed to fetch」になるのを防ぐ）
  process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack || e); });
  process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.stack || e); });
  try {
    const pr = pruneInputCsv({ minStale: 3 });
    if (pr.moved > 0) {
      console.log('✓ 古い照合CSV ' + pr.moved + ' 件を input/_old/ へ退避（最新 ' + pr.kept + ' 本を残しました）');
      invalidateCaches();
    }
  } catch (e) { console.error('[pruneInput]', e && e.message || e); }
  startOrReuse();
}

module.exports = { calcAll, calcAllSuppliers, impactAllSuppliers, exportQuotes, saveMakerQuote, server };

// =====================================================================
//  画面（HTML/CSS/JS をひとまとめ。外部ファイル不要）
// =====================================================================
const PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>価格転嫁シミュレーション</title>
<style>
  :root{ --bg:#f4f6f9; --card:#fff; --line:#e2e6ec; --ink:#1f2733; --sub:#6b7785;
         --accent:#1f4e78; --pos:#2e7d32; --neg:#c0392b; --hi:#fff7ec; }
  *{ box-sizing:border-box }
  body{ margin:0; font-family:"メイリオ","Meiryo","Segoe UI",sans-serif; background:var(--bg); color:var(--ink); font-size:13px; }
  header{ background:var(--accent); color:#fff; padding:10px 16px; display:flex; align-items:center; gap:14px; flex-wrap:wrap; position:sticky; top:0; z-index:50; }
  header h1{ font-size:16px; margin:0; font-weight:700; }
  header .sub{ color:#cfe0f0; font-size:12px; }
  .bar{ background:var(--card); border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:18px; align-items:flex-end; flex-wrap:wrap; }
  .field{ display:flex; flex-direction:column; gap:3px; }
  .field label{ font-size:11px; color:var(--sub); }
  select,input{ font:inherit; padding:5px 7px; border:1px solid #c7ced8; border-radius:6px; background:#fff; }
  input.num{ width:90px; text-align:right; }
  .cards{ display:flex; gap:12px; padding:12px 16px; flex-wrap:wrap; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; min-width:150px; box-shadow:0 1px 2px rgba(0,0,0,.03); }
  .card .k{ font-size:11px; color:var(--sub); }
  .card .v{ font-size:20px; font-weight:700; margin-top:2px; }
  .v.pos{ color:var(--pos) } .v.neg{ color:var(--neg) }
  .v small{ font-size:12px; font-weight:400; color:var(--sub) }
  /* 横に広い表を「高さ制限つきスクロール枠」に。見出し行は上端に固定。 */
  .wrap{ margin:0 16px 24px; overflow:auto; max-height:70vh; border:1px solid var(--line); border-top:none; border-radius:0 0 8px 8px; background:var(--card); }
  .wrap::-webkit-scrollbar{ height:14px; width:14px; }
  .wrap::-webkit-scrollbar-thumb{ background:#b9c4d0; border-radius:7px; border:3px solid var(--card); }
  .wrap::-webkit-scrollbar-thumb:hover{ background:#9aa9b8; }
  /* 表のすぐ上に「常に見える」横スクロールバー。画面に貼り付き、表と左右が連動する。
     表の下端まで行かなくても右側の列へスライドできるようにするための補助バー。 */
  .hbar{ position:sticky; top:var(--hdr-h,52px); z-index:6; margin:0 16px; height:16px; overflow-x:auto; overflow-y:hidden;
         background:#e3eaf2; border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; display:none; }
  .hbar::-webkit-scrollbar{ height:14px; }
  .hbar::-webkit-scrollbar-thumb{ background:#8fa3b8; border-radius:7px; }
  .hbar::-webkit-scrollbar-thumb:hover{ background:#71889f; }
  #hbarInner{ height:1px; }
  table{ border-collapse:separate; border-spacing:0; width:100%; min-width:1500px; background:var(--card); font-size:12px; }
  /* メイン表は9列。width:100% で枠いっぱいに広げて右の空白を埋め、余り幅は全列に分散させる
     （大きいモニターでスペースを使う）。min-width:0 で旧来の 1500px 強制を解除＝はみ出す時だけ
     横スクロール（hbar は syncHScroll が scrollWidth で判定して自動で出し入れ）。 */
  #tbl{ width:100%; min-width:0; }
  /* 商品名は内容（コード＋名称＋🏢仕入先バッジ）が長いと列を独占しがち→最大幅＋折り返しで
     横幅をキャップ。これで余り幅が商品名に集中せず全列へ分散する。 */
  #tbl td.pn, #tbl th.pn{ white-space:normal; word-break:break-word; max-width:420px; }
  #tbl th.sortable{ cursor:pointer; user-select:none; }
  #tbl th.sortable:hover{ background:#eef2f7; }
  #tbl th.sortable.sel{ background:#e3edf7; color:#1f4e78; }
  #tbl th.shogo-col, #tbl td.shogo-col{ width:44px; min-width:44px; max-width:52px; padding:4px 2px; vertical-align:middle; }
  #shogoBtn{ font-size:11px; padding:5px 4px; line-height:1.25; white-space:normal; }
  #shogoMsg{ display:block; margin-top:3px; font-size:10px; color:#6b7785; line-height:1.2; word-break:break-all; }
  th,td{ border-right:1px solid var(--line); border-bottom:1px solid var(--line); padding:5px 7px; white-space:nowrap; }
  th:first-child,td:first-child{ border-left:1px solid var(--line); }
  th{ background:#eef2f7; position:sticky; top:0; z-index:2; font-weight:700; color:#2a3a4a; }
  td.r,th.r{ text-align:right; } td.c,th.c{ text-align:center; }
  tr.unmatched td{ color:#9aa6b2; background:#fafbfc; }
  /* 得意先別ページから商品名リンクで飛んできた時、該当行を黄色く強調（数秒で消える） */
  tr.focusrow td{ background:#fff3bf !important; transition:background .8s ease; box-shadow:inset 0 0 0 9999px rgba(255,221,87,.18); }
  td.hi{ background:var(--hi); font-weight:700; }
  td.pricewarn{ background:#fdecea !important; color:#c0392b; font-weight:700; cursor:help; }
  td.ratewarn{ background:#fff4d6 !important; color:#9a6a00; font-weight:700; cursor:help; }
  #priceAlert{ display:none; margin:8px 0; padding:9px 12px; border-radius:8px; background:#fdecea; border:1px solid #f5b7b1; color:#922b21; font-size:13px; }
  #rateAlert{ display:none; margin:8px 0; padding:9px 12px; border-radius:8px; background:#fff4d6; border:1px solid #f0d090; color:#7a5200; font-size:13px; }
  #dupAlert{ margin:8px 0; padding:9px 12px; border-radius:8px; background:#fdeede; border:1px solid #e6b87a; color:#8a4b12; font-size:13px; line-height:1.7; }
  #linkAlert{ margin:8px 0; padding:9px 12px; border-radius:8px; background:#fff8e6; border:1px solid #e6c84a; color:#7a5a10; font-size:13px; line-height:1.7; }
  #cdCand{ margin:8px 0; padding:9px 12px; border-radius:8px; background:#eaf3fb; border:1px solid #9ec3e6; color:#1f4e78; font-size:13px; line-height:1.7; }
  #cdCand a.dl{ display:inline-block; margin-left:6px; padding:3px 10px; border-radius:6px; background:#1f6fb2; color:#fff; text-decoration:none; font-weight:700; font-size:12px; }
  #cdCand a.dl:hover{ background:#175a92; }
  .jumphint{ display:inline-block; margin-left:8px; padding:1px 8px; border-radius:10px; background:rgba(0,0,0,.08); font-weight:700; white-space:nowrap; }
  tr.flashrow{ animation:flashrow 1.4s ease-out 1; }
  @keyframes flashrow{ 0%{ background:#ffe08a; } 60%{ background:#fff3c4; } 100%{ background:transparent; } }
  .badge{ font-size:10px; padding:1px 6px; border-radius:9px; }
  .badge.act{ background:#e3f1e4; color:#2e7d32 } .badge.est{ background:#fdecea; color:#c0392b }
  .pos{ color:var(--pos) } .neg{ color:var(--neg) }
  .ml6{ margin-left:6px }
  .ratetag{ display:block; font-size:11px; font-weight:700; margin-top:1px; }
  .ratetag.pos{ color:var(--neg) } /* 値上げ＝赤で目立たせる */
  .ratetag.neg{ color:#2a6fb0 }    /* 値下げ＝青 */
  .ratetag.flat{ color:#9aa6b2 }
  button.go{ background:var(--accent); color:#fff; border:none; border-radius:8px; padding:9px 16px; font-size:13px; font-weight:700; cursor:pointer; }
  button.go:hover{ background:#163a5c }
  .foot{ padding:8px 16px 20px; }
  .hint{ color:var(--sub); font-size:11px; }
  .rule-sel{ padding:3px 5px; font-size:11px; }
  #msg{ padding:8px 16px; color:var(--neg); }
  /* 全社損益インパクト パネル */
  .plpanel{ margin:0 16px 14px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; box-shadow:0 1px 2px rgba(0,0,0,.03); }
  .plhead{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-weight:700; color:#2a3a4a; margin-bottom:10px; }
  .plhead .hint{ font-weight:400; }
  .plgrid{ display:flex; gap:18px; flex-wrap:wrap; align-items:flex-start; }
  .plinputs{ display:flex; flex-direction:column; gap:6px; min-width:200px; }
  .plinputs .row{ display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:12px; }
  .plinputs input.num{ width:120px; }
  .pltbl{ flex:1; min-width:420px; }
  .pltbl th,.pltbl td{ border:1px solid var(--line); padding:5px 9px; }
  .pltbl th{ background:#eef2f7; }
  .pltbl td.r{ text-align:right; } .pltbl th.r{ text-align:right; }
  .pltbl tr.op td{ font-weight:700; background:#f7faff; }
  .pltbl .d{ font-size:10px; margin-left:6px; }
  /* 設定（初回登録）画面 */
  #settingsBtn{ margin-left:8px; background:#fff; color:var(--accent); border:none; border-radius:8px; padding:7px 14px; font-weight:700; cursor:pointer; }
  #importLink, #listLink, #suppliersLink, #selfLink, #cdlinkLink{ background:#eaf1f8; color:var(--accent); border-radius:8px; padding:7px 14px; font-weight:700; text-decoration:none; font-size:13px; }
  #manualLink{ color:#fff; background:rgba(255,255,255,.18); border:1px solid rgba(255,255,255,.55); border-radius:8px; padding:7px 14px; font-weight:700; text-decoration:none; font-size:13px; }
  #manualLink:hover{ background:rgba(255,255,255,.30); }
  #calBtn{ color:#fff; background:rgba(255,255,255,.18); border:1px solid rgba(255,255,255,.55); border-radius:8px; padding:7px 14px; font-weight:700; cursor:pointer; font-size:13px; }
  #calBtn:hover{ background:rgba(255,255,255,.30); }
  /* 実施日カレンダー（ヘッダー直下に常時表示する折りたたみパネル） */
  #calPanel{ background:#fff; border:1px solid #e6ecf2; border-radius:14px; box-shadow:0 2px 10px rgba(0,0,0,.05); margin:12px 16px; }
  #calPanel .chead{ display:flex; align-items:center; gap:12px; padding:11px 18px; border-bottom:1px solid #e6ecf2; flex-wrap:wrap; }
  #calPanel.collapsed .chead{ border-bottom:none; }
  #calPanel .chead h2{ margin:0; font-size:16px; color:var(--accent); }
  #calPanel .cnav{ display:flex; align-items:center; gap:8px; margin-left:6px; }
  #calPanel .cnav button{ background:#eaf1f8; color:var(--accent); border:none; border-radius:8px; padding:5px 11px; font-weight:700; cursor:pointer; font-size:14px; }
  #calPanel .cnav button:hover{ background:#dbe8f5; }
  #calPanel .cnav .cmonth{ font-weight:800; font-size:15px; min-width:120px; text-align:center; }
  #calPanel #calNavRow{ margin-left:0; padding:12px 20px 0; }
  #calPanel .cclose{ margin-left:auto; background:#fff; border:1px solid #cdd7e1; border-radius:8px; padding:5px 13px; font-weight:700; cursor:pointer; color:#5a6b7a; font-size:13px; }
  #calBody.collapsed{ display:none; }
  #calChips{ display:flex; flex-wrap:wrap; gap:8px; padding:12px 20px 0; }
  #calChips .chip{ background:#f3f7fb; border:1px solid #d6e1ec; border-radius:999px; padding:5px 12px; font-size:13px; cursor:pointer; color:#33485c; font-weight:600; }
  #calChips .chip:hover{ background:#e4eef7; }
  #calChips .chip b{ color:var(--accent); }
  #calChips .chip.empty{ color:#9aa6b2; }
  .calgrid{ display:grid; grid-template-columns:repeat(7,1fr); gap:4px; padding:12px 20px; }
  .calgrid .dow{ text-align:center; font-size:12px; font-weight:700; color:#7a8794; padding:4px 0; }
  .calgrid .dow.sun{ color:#c0392b; } .calgrid .dow.sat{ color:#2a6fb0; }
  .calcell{ min-height:64px; border:1px solid #eef1f5; border-radius:8px; padding:4px 6px; background:#fcfdff; cursor:default; }
  .calcell.blank{ background:transparent; border:none; }
  .calcell .dn{ font-size:12px; color:#8a96a3; }
  .calcell.sun .dn{ color:#c0392b; } .calcell.sat .dn{ color:#2a6fb0; }
  .calcell.has{ background:#fff4e6; border-color:#f0c896; cursor:pointer; }
  .calcell.has:hover{ background:#ffe9cf; }
  .calcell.sel{ background:#ffe0b8; border-color:#e0922c; box-shadow:0 0 0 2px #e0922c inset; }
  .calcell.today .dn{ background:var(--accent); color:#fff; border-radius:50%; padding:0 5px; }
  .calcell .cnt{ display:inline-block; margin-top:3px; background:#e0922c; color:#fff; border-radius:999px; font-size:11px; font-weight:700; padding:1px 7px; }
  /* 実施日が「本日」のセル＝赤で強調（当日に価格改定が発効） */
  .calcell.has.today{ background:#fdecea; border-color:#e0392c; box-shadow:0 0 0 2px #e0392c inset; }
  .calcell.has.today .dn{ background:#e0392c; }
  .calcell.has.today .cnt{ background:#e0392c; }
  .calcell.has.today.sel{ box-shadow:0 0 0 3px #b5231a inset; }
  #calTodayBanner .tbnr{ margin:12px 20px 0; background:#fdecea; border:1px solid #f3b4ad; color:#a01b10; border-radius:10px; padding:9px 14px; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  #calTodayBanner .tbnr:hover{ background:#fbded9; }
  #calTodayBanner .tbnr .tbtn{ margin-left:auto; background:#c0392b; color:#fff; border-radius:7px; padding:4px 12px; font-size:12.5px; font-weight:800; white-space:nowrap; }
  #calTodayBanner .tbnr .thint{ margin-left:auto; color:#9a4b42; font-weight:600; font-size:11.5px; }
  /* 畳んでいるときは当日バナーをより目立たせる（開いて確認を促す） */
  #calPanel.collapsed #calTodayBanner .tbnr{ margin:10px 18px; box-shadow:0 1px 6px rgba(192,57,43,.18); }
  #calReminder .rbnr{ margin:12px 20px 0; border-radius:10px; padding:9px 14px; font-size:12.5px; display:flex; flex-wrap:wrap; gap:14px; align-items:center; }
  #calReminder .rbnr.warn{ background:#fff7e6; border:1px solid #f0c879; color:#7a5300; }
  #calReminder .rbnr.ok{ background:#eef7ef; border:1px solid #bfe0c4; color:#2e6b35; }
  #calReminder .ritem b{ font-weight:800; }
  #calReminder .rtag{ display:inline-block; border-radius:999px; padding:1px 8px; font-size:11px; font-weight:700; margin-right:5px; }
  #calReminder .rtag.w{ background:#f0a800; color:#fff; } #calReminder .rtag.g{ background:#3a9a4a; color:#fff; } #calReminder .rtag.x{ background:#b0b8c0; color:#fff; }
  #calReminder .rgo{ background:#fff; border:1px solid #d8c089; color:#7a5300; border-radius:7px; padding:3px 10px; font-size:11.5px; font-weight:700; cursor:pointer; text-decoration:none; }
  #calExport{ margin:12px 20px 0; border:1px solid #e3d2bb; background:#fbf6ef; border-radius:10px; padding:10px 14px; font-size:12.5px; }
  #calExport .cetitle{ font-weight:800; color:#8a5a1f; margin-bottom:7px; }
  #calExport .cerow{ display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  #calExport .celine{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px; }
  #calExport .ceop{ color:#6a5a42; font-size:12px; }
  #calExport .ceop b{ font-weight:800; color:#8a5a1f; }
  #calExport input[type=date], #calExport select{ font:inherit; padding:4px 6px; border:1px solid #d8c7b2; border-radius:6px; }
  #calExport .cehint{ margin-top:8px; color:#7a6a52; font-size:11px; line-height:1.6; }
  .calexpbtn{ color:#fff; border:none; border-radius:7px; padding:6px 12px; font-size:12px; font-weight:700; cursor:pointer; min-width:172px; }
  .calexpbtn:hover{ filter:brightness(1.08); }
  #calDetail{ border-top:1px solid #e6ecf2; padding:14px 20px 20px; max-height:46vh; overflow:auto; }
  #calDetail h3{ margin:0 0 8px; font-size:14px; color:#33485c; }
  #calDetail table{ width:100%; border-collapse:collapse; font-size:12.5px; }
  #calDetail th{ text-align:left; color:#7a8794; font-weight:700; border-bottom:1px solid #e6ecf2; padding:5px 8px; }
  #calDetail td{ border-bottom:1px solid #f1f4f7; padding:5px 8px; vertical-align:top; }
  #calDetail tr:hover td{ background:#f8fafc; }
  #calDetail .empty{ color:#9aa6b2; padding:8px 0; }
  #calDetail .calnote{ background:#eef7ee; border:1px solid #cfe6cf; border-radius:8px; padding:10px 14px; font-size:13px; color:#2e5a2e; margin-bottom:12px; }
  #calDetail .calsec{ margin-top:14px; }
  #calDetail .calsec h3{ margin:0 0 6px; font-size:13px; padding:6px 10px; border-radius:6px; }
  #calDetail .calsec.issued h3{ background:#eaf6ee; color:#1b6b3a; border-left:4px solid #1b6b3a; }
  #calDetail .calsec.todo h3{ background:#fff8ee; color:#8a5a12; border-left:4px solid #d4a017; }
  #calDetail .calsec.emptysec{ color:#9aa6b2; font-size:12px; padding:4px 0; }
  .calcell .cnts{ display:flex; flex-direction:column; gap:2px; margin-top:3px; }
  .calcell .cnt-issued,.calcell .cnt-todo,.chip .cnt-issued,.chip .cnt-todo{ display:inline-block; border-radius:999px; font-size:10px; font-weight:700; padding:1px 6px; }
  .calcell .cnt-issued,.chip .cnt-issued{ background:#1b6b3a; color:#fff; }
  .calcell .cnt-todo,.chip .cnt-todo{ background:#d4a017; color:#fff; }
  .chip .cnt-hold{ display:inline-block; border-radius:999px; font-size:10px; font-weight:700; padding:1px 6px; background:#8a5a12; color:#fff; margin-left:2px; }
  #importLink{ margin-left:auto; }
  #importLink:hover, #listLink:hover, #suppliersLink:hover, #selfLink:hover, #cdlinkLink:hover{ background:#dbe8f5; }
  #settingsBtn:hover{ background:#eaf1f8; }
  .overlay{ position:fixed; inset:0; background:rgba(15,25,40,.45); display:none; align-items:flex-start; justify-content:center; z-index:50; overflow:auto; padding:24px 12px; }
  .overlay.show{ display:flex; }
  .modal{ background:#fff; border-radius:12px; width:min(680px,100%); box-shadow:0 12px 40px rgba(0,0,0,.25); }
  .modal .mhead{ background:var(--accent); color:#fff; padding:14px 18px; border-radius:12px 12px 0 0; }
  .modal .mhead h2{ margin:0; font-size:16px; }
  .modal .mhead .sub{ color:#cfe0f0; font-size:12px; margin-top:2px; }
  .modal .mbody{ padding:16px 18px; }
  .modal .sec{ font-weight:700; color:#2a3a4a; margin:16px 0 8px; border-left:4px solid var(--accent); padding-left:8px; }
  .modal .sec:first-of-type{ margin-top:0; }
  .frow{ display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
  .fcol{ display:flex; flex-direction:column; gap:3px; flex:1; min-width:150px; }
  .fcol label{ font-size:11px; color:var(--sub); }
  .fcol input,.fcol select,.fcol textarea{ font:inherit; padding:6px 8px; border:1px solid #c7ced8; border-radius:6px; }
  .fcol textarea{ resize:vertical; min-height:54px; }
  .modal .mfoot{ padding:14px 18px; border-top:1px solid var(--line); display:flex; gap:10px; justify-content:flex-end; align-items:center; }
  .modal .mfoot .note{ margin-right:auto; color:var(--sub); font-size:11px; }
  button.ghost{ background:#fff; color:var(--sub); border:1px solid #c7ced8; border-radius:8px; padding:9px 16px; font-size:13px; cursor:pointer; }
  .welcome{ background:#fff7ec; border:1px solid #f0d9a8; color:#8a5a12; padding:9px 12px; border-radius:8px; margin:0 0 12px; font-size:12px; line-height:1.6; display:none; }
  .welcome.show{ display:block; }
${SHOGO_LOCK_CSS}
</style></head>
<body>
${SHOGO_LOCK_HTML}
<header>
  <h1>価格転嫁シミュレーション</h1>
  <span class="sub">メーカー改定額を入れて、転嫁後の単価・粗利・年間影響を試算</span>
  <a id="toCustomersBtnNav" href="/customers" style="margin-left:auto;background:#1b6b3a;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:700;white-space:nowrap" title="得意先別ページを開いて、得意先ごとに価格を決めて見積書を作成します" onmouseover="this.style.background='#15532c'" onmouseout="this.style.background='#1b6b3a'">👥 見積書を作成</a>
  <button id="calBtn" style="margin-left:0" title="実施日カレンダーの表示／非表示を切り替えます（常にページ上部に表示されています）">📅 実施日カレンダー</button>
  <button id="exclBtn" style="margin-left:0" title="すでに取引が無いのに照合に出てくる得意先を、画面・損益・見積書から隠します（いつでも復活できます）">🚫 得意先 除外設定</button>
  <a href="/manual" id="manualLink" target="_blank" style="margin-left:0" title="このツールの使い方手順書を新しいタブで開きます">📖 使い方</a>
  <a href="/list" id="listLink" style="margin-left:0">📊 一覧・進捗</a>
  <a href="/import" id="importLink" style="margin-left:0">＋ メーカー見積取込</a>
  <a href="/cdlink" id="cdlinkLink" style="margin-left:0">🏷 コード化</a>
  <a href="/suppliers" id="suppliersLink" style="margin-left:0">📒 仕入先マスタ</a>
  <a href="/self" id="selfLink" style="margin-left:0">🗂 自社データ設定</a>
  <button id="settingsBtn">⚙ 設定</button>
</header>

<div class="overlay" id="settingsOverlay">
  <div class="modal">
    <div class="mhead">
      <h2>⚙ 設定（初回登録）</h2>
      <div class="sub">自社の情報を登録します。ここで保存した内容が見積書に反映されます。</div>
    </div>
    <div class="mbody">
      <div class="welcome" id="welcomeMsg">はじめまして。まず自社の会社情報を入力して「保存する」を押してください。見積書の差出人として使われます（あとから「⚙ 設定」でいつでも変更できます）。</div>

      <div class="sec">会社情報（見積書に表示されます）</div>
      <div class="frow">
        <div class="fcol" style="flex:2"><label>会社名 *</label><input id="cName" placeholder="例: 日野折箱店"></div>
        <div class="fcol"><label>郵便番号</label><input id="cPostal" placeholder="〒000-0000"></div>
      </div>
      <div class="frow">
        <div class="fcol" style="min-width:100%"><label>住所</label><input id="cAddr" placeholder="○○県○○市○○ 0-0-0"></div>
      </div>
      <div class="frow">
        <div class="fcol"><label>電話</label><input id="cTel" placeholder="TEL: 000-000-0000"></div>
        <div class="fcol"><label>FAX（任意）</label><input id="cFax" placeholder="FAX: 000-000-0001"></div>
      </div>

      <div class="sec">見積書の文言</div>
      <div class="frow"><div class="fcol" style="min-width:100%"><label>タイトル</label><input id="qTitle" placeholder="御 見 積 書"></div></div>
      <div class="frow"><div class="fcol" style="min-width:100%"><label>あいさつ文</label><textarea id="qGreeting"></textarea></div></div>
      <div class="frow"><div class="fcol" style="min-width:100%"><label>脚注（注意書き）</label><textarea id="qFooter"></textarea></div></div>

      <div class="sec">見積書メールの文言（得意先別ページの「📧 見積を作成してメール」で使用）</div>
      <div class="frow"><div class="fcol" style="min-width:100%"><label>メール件名</label><input id="qMailSubject" placeholder="【お見積書】価格改定のご案内（{customer}様）"></div></div>
      <div class="frow"><div class="fcol" style="min-width:100%"><label>メール本文</label><textarea id="qMailBody" rows="6"></textarea>
        <div class="hint">差し込みタグ：<b>{customer}</b>=得意先名 / <b>{quoteNo}</b>=見積No / <b>{date}</b>=発行日 / <b>{count}</b>=品目数 / <b>{company}</b>=自社名。本文末尾に会社情報の差出人欄が自動で付きます。</div></div></div>

      <div class="sec">計算の既定値（画面上部の初期値になります）</div>
      <div class="frow">
        <div class="fcol"><label>既定の転嫁ルール</label>
          <select id="sRule">
            <option value="add_increase">値上げ分を上乗せ（利益額キープ）</option>
            <option value="keep_margin_rate">現在の粗利率を維持</option>
            <option value="markup">現売価 × 掛率</option>
            <option value="sell_cost_rate">現売価 × 仕入改定%（仕入と同率で値上げ＝粗利率維持と同結果）</option>
            <option value="keep_sell">据え置き（値上げしない）</option>
          </select></div>
        <div class="fcol" id="sFactorBox" style="display:none"><label>掛率</label><input id="sFactor" type="number" step="0.01" value="1.25"></div>
        <div class="fcol"><label>端数 単位 <span style="font-size:10px;color:#9aa6b2">得意先ページの初期桁</span></label>
          <select id="sUnit"><option value="1">整数</option><option value="0.1">0.1</option><option value="0.01">0.01</option></select></div>
        <div class="fcol"><label>端数 処理 <span style="font-size:10px;color:#9aa6b2">切捨て/四捨五入/切上げ</span></label>
          <select id="sMode"><option value="round">四捨五入（既定）</option><option value="ceil">切上げ</option><option value="floor">切捨て</option></select></div>
        <div class="fcol"><label>自社コスト上乗せ%</label><input id="sUplift" type="number" step="0.1" value="0"></div>
        <div class="fcol"><label>一致度しきい値%<br><span style="font-size:10px;color:#9aa6b2">未満は要確認へ</span></label><input id="sThreshold" type="number" step="1" value="80"></div>
      </div>
    </div>
    <div class="mfoot">
      <span class="note" id="setMsg">* 会社名は必須です</span>
      <button class="ghost" id="setCancel">閉じる</button>
      <button class="go" id="setSave">保存する</button>
    </div>
  </div>
</div>

<section id="calPanel">
  <div class="chead">
    <h2>📅 実施日カレンダー</h2>
    <button class="cclose" id="calToggle" title="カレンダーの表示／非表示を切り替え">▲ 畳む</button>
  </div>
  <div id="calTodayBanner"></div>
  <div id="calBody">
    <div id="calReminder"></div>
    <div id="calExport">
      <div class="cetitle">🏷 実施日が来た改定を 基幹システム（販売大臣）へ取込</div>
      <div class="cerow">
        <label style="color:#5a4630">実施日が <input type="date" id="calCutoff"> までに到来した分</label>
      </div>
      <div class="celine">
        <button id="calHanbaiBtn" class="calexpbtn" style="background:#2e6b3e">📥 単価履歴CSV（売価）</button>
        <select id="calHanbaiScope" title="単価履歴CSVの対象範囲">
          <option value="issued" selected>発行した見積のみ（発行時の単価）</option>
          <option value="all">改定すべて（未発行も既定計算）</option>
        </select>
        <span class="ceop">👉 取込先： <b>販売大臣 63→13 データ受入 → 売上履歴 → データ取込</b></span>
      </div>
      <div class="celine">
        <button id="calCostBtn" class="calexpbtn" style="background:#b5742a">🏭 仕入原価CSV</button>
        <span class="ceop">👉 取込先： <b>販売大臣 63→13 データ受入 → 商品 → データ取込</b></span>
      </div>
      <div class="celine">
        <a id="calMultiLink" href="/api/multimatch.csv" download class="ceop" style="color:#b1432f;text-decoration:underline;cursor:pointer">⚠ 単価が不確定な品（1商品が複数メーカー品に一致）の一覧をダウンロード</a>
        <span class="ceop">＝CSVの「単価不確定 N件」の中身。正しいメーカー品番を商品マスタ「商品名3」に登録→↻照合 で解消します。</span>
      </div>
      <div id="calExpMsg" style="font-size:11.5px;margin-top:7px"></div>
      <div class="cehint">単価履歴CSV＝得意先×商品の新「販売単価」（11列・税付き・DBから税自動付与）。仕入原価CSV＝商品ごとの新「仕入原価」（商品コード,新原価の2列）。どちらもShift_JIS。範囲セレクトは単価履歴CSVのみ有効。</div>
    </div>
    <div id="calChips"></div>
    <div class="cnav" id="calNavRow">
      <button id="calPrev" title="前の月">◀</button>
      <span class="cmonth" id="calMonth"></span>
      <button id="calNext" title="次の月">▶</button>
      <button id="calToday" title="今月へ" style="font-size:12px;padding:6px 10px">今月</button>
    </div>
    <div class="calgrid" id="calGrid"></div>
    <div id="calDetail"></div>
  </div>
</section>

<div class="bar">
  <div class="field"><label>対象（照合結果CSV）</label>
    <select id="file"></select>
  </div>
</div>

<!-- メインは照合・紐付けの確認用。価格設定・見積書作成は得意先別ページ（ヘッダーの「👥 見積書を作成」）で。 -->
<div style="margin:2px 16px 10px;color:#5a6b7d;font-size:12px">※ この画面は<b>照合・紐付けの確認</b>用です。価格の設定・見積書の作成は上部の「👥 見積書を作成」から。</div>

<div id="msg"></div>

<div class="cards" id="cards"></div>

<div class="plpanel">
  <div class="plhead">
    全社 損益インパクト（全仕入先の値上げ分・変動損益ベース）
    <span style="font-weight:400">単位</span>
    <select id="plUnit">
      <option value="1">円</option>
      <option value="1000" selected>千円</option>
      <option value="1000000">百万円</option>
    </select>
    <span id="plSrc" class="hint"></span>
    <span id="plScope" class="hint" style="display:block;width:100%;margin-top:4px;color:#1f4e78"></span>
  </div>
  <div class="plgrid">
    <div class="plinputs">
      <div class="row"><span>純売上高</span><input id="plSales" class="num" type="number" step="any"></div>
      <div class="row"><span>変動費合計</span><input id="plVar" class="num" type="number" step="any"></div>
      <div class="row"><span>固定費合計</span><input id="plFixed" class="num" type="number" step="any"></div>
      <div class="row"><span>自社コスト増/年(固定費)</span><input id="plSelfCost" class="num" type="number" step="any" value="0"></div>
      <div class="hint">数値は選択中の「単位」で扱います。損益.csv を直下に置くと自動読込。<br>「自社コスト増」は転嫁有無に関わらず固定費に加算します。</div>
    </div>
    <table class="pltbl">
      <thead><tr><th>項目</th><th class="r">現状</th><th class="r">転嫁しない</th><th class="r">転嫁する（現設定）</th></tr></thead>
      <tbody id="plBody"></tbody>
    </table>
  </div>
</div>

<div id="dateFilterBar" style="display:none;margin:8px 0;padding:9px 14px;background:#eef4fb;border:1px solid #c6d8ef;border-radius:8px;font-size:13px;color:#23476e;align-items:center;gap:12px;flex-wrap:wrap">
  <span id="dateFilterLabel" style="font-weight:700"></span>
  <span style="color:#5a6b7a;font-size:12px">📅 実施日カレンダーで選んだ改定を表示中（全仕入先・読み取り）。価格を編集したいときは解除して通常表示に戻してください。</span>
  <button id="dateFilterClear" type="button" style="margin-left:auto;background:#2f6fb0;color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">× 解除して通常表示に戻す</button>
</div>
<div id="dupAlert" style="display:none"></div>
<div id="requoteAlert" style="display:none"></div>
<div id="linkAlert" style="display:none"></div>
<div id="cdCand" style="display:none"></div>
<div id="priceAlert"></div>
<div id="rateAlert"></div>
<div id="issuedHideNote" style="display:none;margin:8px 0;padding:8px 12px;background:#eef7ef;border:1px solid #bfe0c4;border-radius:8px;font-size:12px;color:#1f6b35"></div>
<div class="hbar" id="hbar"><div id="hbarInner"></div></div>
<div class="wrap" id="wrap"><table id="tbl">
  <thead><tr>
    <th class="c shogo-col"><button id="shogoBtn" class="ghost" title="maker_quotes に取り込んだメーカー見積を販売実績と照合し、新しい照合結果CSVを作ります（販売実績が旧Excelなら自動変換）">↻<br>照合</button><span id="shogoMsg"></span></th>
    <th>得意先</th><th class="c sortable" id="sortMatchTh" title="クリックで並び替え：得意先順 → 一致度高い順 → 低い順">一致度<br><span class="hint">(自社↔仕入・並替可)</span></th><th class="pn">商品名</th><th class="c">紐付け<br><span class="hint">(手動確定)</span></th>
    <th class="r">現仕入</th><th class="c">改定後 仕入単価</th><th class="r">仕入値上額<br><span class="hint">(改定%)</span></th>
    <th class="c">年間数量</th><th class="r">仕入 年影響</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table></div>

<div class="foot hint">
  ※ メイン画面は「照合・紐付けの確認」用です。売価・粗利・見積書の作成は <a href="/customers" target="_blank">得意先別ページ</a> で行います。<br>
  ※ 年間数量は、CSVに「年間数量」列があれば<span class="badge act">実</span>その値、無ければ<span class="badge est">推</span>「年間金額÷現売単価」で推定します。
</div>

<script>
${SHOGO_LOCK_JS}
const SIM_PAGE_REV='${SIM_PAGE_REV}';
const $ = (s) => document.querySelector(s);
const RULE_LABEL = { add_increase:'上乗せ', keep_margin_rate:'粗利維持', markup:'掛率', sell_cost_rate:'売価×仕入率', keep_sell:'据置' };
let baseRows = [];      // 画面の行構造（ファイル読込時に確定）
let lastSummary = null; // 直近の集計（選択中ファイルのみ。カード表示に使用）
let allImpact = null;   // 全仕入先 横断の損益インパクト（損益パネルが ΔC/ΔS に使用）
let dateFilter = null;  // 実施日カレンダーで選んだ日(YYYY-MM-DD)。非nullの間は「全仕入先・その実施日」読み取り表示。
let allView = false;    // 「★全部（全仕入先まとめ）」表示中か。trueなら行ごとに仕入先名を表示＋紐付けは行の仕入先で処理。
let currentSupplier = ''; // 現在表示中の照合結果CSVの仕入先名（productLinks 引き当てに使用）
let currentLinks = {};    // 現在の仕入先の productLinks（{自社CD: メーカー商品名}）
let allMakerNames = [];   // 編集モーダルのドロップダウン候補
let currentSuppliers = {}; // 仕入先マスタ {コード: {name, ...}} ：発注先名の解決に使用
let linkUpgradeMap = {};   // 手動紐付けより確実な候補 { 仕入先\\x01自社CD: issue }
let linkSuspectMap = {};   // 手動紐付けの勘違いの疑い { 仕入先\\x01自社CD: issue }
let linkIssues = [];       // 紐付け監査の全issue（別枠「要見直し」パネル用）
let mainSortMode = '';     // 一致品の並び：''=得意先順 / 'matchDesc'=一致度高い順 / 'matchAsc'=低い順

const yen = (v) => Number.isFinite(v) ? '¥' + Math.round(v).toLocaleString('ja-JP') : '—';
const num = (v,d=2) => {
  const n = (typeof v==='number') ? v : parseFloat(String(v).replace(/,/g,''));
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n*100)/100;
  return r.toLocaleString('ja-JP',{minimumFractionDigits:d,maximumFractionDigits:d});
};
const pct = (v) => Number.isFinite(v) ? v.toFixed(1)+'%' : '—';
const signCls = (v) => Number.isFinite(v) ? (v>0?'pos':(v<0?'neg':'')) : '';

// メイン画面の全体方針は ⚙設定 に集約（上部の方針バーは撤去）。settings() は保存済み方針
//  （savedPolicy）を返す。初期化と設定保存のたびに applyToBar が savedPolicy を更新する。
//  ＝メイン＝照合・紐付けの確認／価格設定は得意先別ページ、という役割分担。
let savedPolicy = { rule:{ type:'add_increase', factor:1.25 }, rounding:{ unit:0.01, mode:'round' }, selfUplift:0 };
function settings(){
  return {
    rule: { type: savedPolicy.rule.type, factor: savedPolicy.rule.factor },
    rounding: { unit: savedPolicy.rounding.unit, mode: savedPolicy.rounding.mode },
    selfUplift: savedPolicy.selfUplift,
  };
}
function isUnmatched(r){ return !r.customerName || r.customerName==='-' || /未一致/.test(r.matchStatus||''); }

// 並び替え用の一致度スコア（CD一致・手動＝100、名前一致＝%、休眠＝-1）
function matchPctNum(r){
  const st = r.matchStatus || '';
  if (isUnmatched(r)) return -1;
  if (/手動紐付け/.test(st) || /CD一致/.test(st)) return 100;
  const m = st.match(/(\\d+)\\s*%/);
  return m ? Number(m[1]) : 0;
}
// 得意先別ページの状態 → 並び順の優先度（小さいほど上）。⬜未提出＝要対応を最上位に。
//  ※通常ビューでは提出済み(issued)は非表示なので実質 未提出/検討中/手動修正/休眠 の順になる。
function statusRank(r){
  switch (r && r.itemStatus) {
    case '':
    case undefined:
    case null:       return 0; // ⬜ 未提出（要対応）＝上
    case 'hold':     return 1; // 🤔 検討中
    case 'manual':   return 2; // ✏ 手動修正
    case 'dormant':  return 3; // 💤 休眠（得意先）
    case 'issued':   return 4; // ✅ 提出済み（通常は非表示）
    default:         return 5;
  }
}
function sortMatchedIndices(indices){
  const col = new Intl.Collator('ja');
  // どの並びでも「未提出を上に」＝状態の優先度を第1キーにする（既存の並びは同一状態内の第2キー以降）。
  if (mainSortMode === 'matchDesc' || mainSortMode === 'matchAsc') {
    const dir = mainSortMode === 'matchDesc' ? -1 : 1;
    indices.sort((a,b)=>{
      const sr = statusRank(baseRows[a]) - statusRank(baseRows[b]);
      if (sr !== 0) return sr;
      const pa = matchPctNum(baseRows[a]), pb = matchPctNum(baseRows[b]);
      if (pa !== pb) return (pa - pb) * dir;
      return col.compare(baseRows[a].customerName||'', baseRows[b].customerName||'')
        || col.compare(baseRows[a].supplier||'', baseRows[b].supplier||'')
        || col.compare(baseRows[a].productName||'', baseRows[b].productName||'');
    });
    return;
  }
  indices.sort((a,b)=> (statusRank(baseRows[a]) - statusRank(baseRows[b]))
    || col.compare(baseRows[a].customerName||'', baseRows[b].customerName||'')
    || col.compare(baseRows[a].supplier||'', baseRows[b].supplier||'')
    || col.compare(baseRows[a].productName||'', baseRows[b].productName||''));
}
function updateSortMatchTh(){
  const th = $('#sortMatchTh'); if(!th) return;
  th.classList.remove('sel');
  let mark = '';
  if (mainSortMode === 'matchDesc') { mark = ' ▼'; th.classList.add('sel'); }
  else if (mainSortMode === 'matchAsc') { mark = ' ▲'; th.classList.add('sel'); }
  const hint = mainSortMode === 'matchDesc' ? '高い順' : (mainSortMode === 'matchAsc' ? '低い順' : '並替可');
  th.innerHTML = '一致度'+mark+'<br><span class="hint">('+hint+'・クリック)</span>';
}
function cycleMainSort(){
  mainSortMode = mainSortMode === '' ? 'matchDesc' : (mainSortMode === 'matchDesc' ? 'matchAsc' : '');
  updateSortMatchTh();
  if (baseRows.length) renderMainRows(!!dateFilter);
}

// 一致度セル: matchStatus(「✓ CD一致」「✓ 名前一致(80%)」「📌 手動紐付け」) から % を取り出して大きく表示。
//  得意先と商品名の間に独立カラムとして置き、自社↔仕入の照合の確かさを一目で分かるようにする。
function matchPctCell(r){
  const st = r.matchStatus || '';
  if (isUnmatched(r)) return '<span style="color:#bbb" title="販売実績なし／商品名不一致">休眠</span>';
  let pctNum = null, label = '';
  if (/手動紐付け/.test(st)) { pctNum = 100; label = '📌 手動'; }
  else if (/CD一致/.test(st)) { pctNum = 100; label = 'CD一致'; }
  else { const m = st.match(/(\\d+)\\s*%/); if (m){ pctNum = Number(m[1]); label = '名前一致'; } }
  if (pctNum === null) return '<span style="color:#bbb">—</span>';
  const color = pctNum >= 80 ? '#2e7d32' : (pctNum >= 60 ? '#b8860b' : '#c0392b');
  const price = /\\+価格/.test(st) ? '<div style="font-size:10px;color:#2e7d32">+価格一致</div>' : '';
  return '<div style="font-weight:700;font-size:15px;color:'+color+'">'+pctNum+'%</div>'+
         '<div style="font-size:10px;color:#888">'+label+'</div>'+price;
}

// 商品名セルのHTML。自社とメーカーの紐付けを2行で並べ、違いを視覚化。
// 発注先（仕入先コード末尾"13"等）が分かれば、その名前(朝日食品容器等)も併記。
// 会社名のゆれ（空白・㈱/株式会社 等）を除いて比較できる形に。
function normSupName(s){ return String(s||'').replace(/[\\s　]/g,'').replace(/株式会社|有限会社|㈱|㈲|（株）|（有）/g,''); }
function sameSupplier(a,b){ a=normSupName(a); b=normSupName(b); if(!a||!b) return false; return a===b||a.indexOf(b)>=0||b.indexOf(a)>=0; }
function buildProdNameHtml(r){
  const selfCode = r.productCode ? ('<span style="color:#1976d2;font-weight:600">['+esc(r.productCode)+']</span> ') : '';
  const selfName = r.productNameCore ? esc(r.productNameCore) : (r.productName && r.productName!=='-' ? esc(r.productName) : '');
  const supCode = r.supplierCode ? ' <span style="color:#888;font-size:11px">#'+esc(r.supplierCode)+'</span>' : '';
  const mkCode = r.makerCode ? '['+esc(r.makerCode)+'] ' : '';
  const mkName = r.makerName ? esc(r.makerName) : '';
  const status = r.matchStatus ? ' <span style="color:#888;font-size:11px">'+esc(r.matchStatus)+'</span>' : '';
  // 仕入先バッジ：
  //  ・自社製造(9000) → 「🏭 自社製造」
  //  ・仕入れ品 → 「🏢 {仕入先}」＝このメーカー見積の取り込み元（必ず分かる）。
  //    過去伝票の発注先(埋め込みコード)が仕入先と違うときだけ、小さく「（過去発注先: …）」を添える
  //    （同じ／無いときは出さない＝重複や紛らわしさを避ける）。
  let supplierBadge = '';
  if (r.selfMade) {
    supplierBadge = ' <span style="color:#1b6b3a;background:#eaf6ee;padding:1px 6px;border-radius:999px;font-size:11px" title="自社製造品（日野折箱店）。原価は材料費＝0扱い。過去伝票の発注先は材料仕入先なので表示しません">🏭 自社製造</span>';
  } else if (r.supplier) {
    supplierBadge = ' <span style="color:#1f6fb2;background:#eaf2fb;padding:1px 6px;border-radius:999px;font-size:11px" title="このメーカー見積の取り込み元＝仕入先">🏢 '+esc(r.supplier)+'</span>';
    if (r.supplierIdEmbed) {
      const code4 = String(r.supplierIdEmbed).padStart(4, '0');
      const sup = currentSuppliers[code4];
      const nm = sup && sup.name ? sup.name : '';
      if (nm && !sameSupplier(nm, r.supplier)) {
        supplierBadge += ' <span style="color:#888;font-size:11px" title="自社販売実績の末尾コード＝過去伝票の発注先（仕入先と異なる）">（過去発注先: '+esc(code4)+' '+esc(nm)+'）</span>';
      }
    }
  } else if (r.supplierIdEmbed) {
    // 仕入先名が不明な稀なケースのフォールバック＝発注先で代用
    const code4 = String(r.supplierIdEmbed).padStart(4, '0');
    const sup = currentSuppliers[code4];
    const labelName = sup && sup.name ? sup.name : '';
    supplierBadge = ' <span style="color:#7a5a00;background:#fff4d6;padding:1px 6px;border-radius:999px;font-size:11px" title="自社販売実績の末尾コード＝発注先">🏢 '+esc(code4)+(labelName?' '+esc(labelName):'')+'</span>';
  }
  if (isUnmatched(r)) {
    return '<span style="color:#aa6">［メーカー品］</span>'+mkCode+mkName+status+supplierBadge;
  }
  const line1 = selfCode + selfName + supCode + supplierBadge;
  const line2 = mkName
    ? '<div style="color:#5a6975;font-size:12px;margin-top:2px">└メーカー: '+mkCode+mkName+'</div>'
    : '';
  return line1 + line2;
}
// 得意先セル。実在の得意先名はリンク化＝クリックでその得意先の得意先別ページを別タブで開く。
//  未一致/休眠（得意先が「-」や空）はリンクにしない。
function custCellHtml(r){
  const nm = r.customerName;
  if(!nm || nm==='-') return '<td>—</td>';
  return '<td><a href="/customers?customer='+encodeURIComponent(nm)+'" target="_blank" rel="noopener" '
    +'title="この得意先の得意先別ページを開く" '
    +'style="color:#1b6b3a;text-decoration:none;border-bottom:1px dotted #6aa97f">'+esc(nm)+'</a></td>';
}

// ===== 得意先 除外設定（取引終了の先を隠す／復活する）=====================
let exclData = { active:[], excluded:[] };
let exclChecked = new Set(); // 隠す対象に選択中の得意先名
function exclVisibleActive(){
  const si0=$('#exclSearch'); const q=(si0?si0.value:'').trim().toLowerCase();
  const norm = (s)=>String(s||'').toLowerCase();
  // active：取引なし(直近約1年 数量0)を先頭、その後 最終売上が古い順＝隠す候補を見つけやすく
  return exclData.active.slice().filter(c=> !q || norm(c.name).indexOf(q)>=0 || norm(c.code).indexOf(q)>=0)
    .sort((a,b)=>{ if(a.hasRecent!==b.hasRecent) return a.hasRecent?1:-1; return String(a.lastDate||'').localeCompare(String(b.lastDate||'')); });
}
function exclSyncSelCount(){
  const n=exclChecked.size; const b=$('#exclHideSel');
  if(b){ b.textContent='🚫 選択した '+n+' 件を隠す'; b.disabled=(n===0); b.style.opacity=n===0?'.5':'1'; b.style.cursor=n===0?'default':'pointer'; }
}
function exclRender(){
  const si0=$('#exclSearch'); const q=(si0?si0.value:'').trim().toLowerCase();
  const norm = (s)=>String(s||'').toLowerCase();
  const active = exclVisibleActive();
  const ex = exclData.excluded.slice().filter(c=> !q || norm(c.name).indexOf(q)>=0);
  let h = '';
  h += '<div style="font-size:12px;color:#6b7785;margin-bottom:8px">すでに取引が無いのに照合に出てくる得意先を隠せます。隠した先は<b>メイン画面・損益・得意先別・見積書</b>から外れます。いつでも「復活」で戻せます。</div>';
  h += '<input id="exclSearch" placeholder="🔍 得意先名・コードで絞り込み" style="width:100%;padding:6px;margin-bottom:8px;border:1px solid #c7ced8;border-radius:4px;font:inherit;box-sizing:border-box" value="'+esc(q)+'">';
  h += '<div style="font-weight:700;margin:6px 0 4px">🚫 除外中（'+ex.length+'件）</div>';
  if(!ex.length) h += '<div style="font-size:12px;color:#aaa;margin-bottom:10px">（なし）</div>';
  else { h += '<div style="max-height:120px;overflow:auto;border:1px solid #eee;border-radius:6px;margin-bottom:12px">';
    ex.forEach(c=>{ h += '<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid #f3f3f3"><span style="flex:1">'+esc(c.name)+'</span><button class="exclRestore" data-name="'+esc(c.name)+'" style="font-size:12px;background:#2f6fb0;color:#fff;border:none;border-radius:6px;padding:3px 10px;cursor:pointer">↩ 復活</button></div>'; });
    h += '</div>'; }
  h += '<div style="font-weight:700;margin:6px 0 4px">照合に出ている得意先（'+active.length+'件）<span style="font-weight:400;font-size:11px;color:#888"> ※赤＝直近約1年 取引なし</span></div>';
  // 操作バー：取引なし一括チェック・全解除・選択を隠す
  h += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">'
    + '<button id="exclCheckNoTrade" type="button" style="font-size:12px;background:#fff;border:1px solid #c0392b;color:#c0392b;border-radius:6px;padding:4px 10px;cursor:pointer">☑ 取引なしを一括チェック</button>'
    + '<button id="exclClearSel" type="button" style="font-size:12px;background:#fff;border:1px solid #bbb;color:#555;border-radius:6px;padding:4px 10px;cursor:pointer">選択を全解除</button>'
    + '<button id="exclHideSel" type="button" style="margin-left:auto;font-size:12px;background:#c0392b;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-weight:700">🚫 選択した 0 件を隠す</button>'
    + '</div>';
  h += '<div style="max-height:300px;overflow:auto;border:1px solid #eee;border-radius:6px"><table style="width:100%;border-collapse:collapse;font-size:12px">';
  h += '<thead><tr style="background:#f6f6f6"><th style="padding:4px 6px;width:34px"><input type="checkbox" id="exclChkAll" title="表示中をすべてチェック"></th><th style="text-align:left;padding:4px 8px">得意先</th><th style="padding:4px 8px">最終売上</th><th style="padding:4px 8px">品数</th></tr></thead><tbody>';
  active.forEach(c=>{
    const no = !c.hasRecent;
    const last = c.lastDate ? String(c.lastDate).slice(0,7) : '—';
    const ck = exclChecked.has(c.name) ? ' checked' : '';
    h += '<tr style="border-bottom:1px solid #f3f3f3'+(no?';background:#fdecec':'')+'">'
      + '<td style="padding:4px 6px;text-align:center"><input type="checkbox" class="exclChk" data-name="'+esc(c.name)+'"'+ck+'></td>'
      + '<td style="padding:4px 8px">'+esc(c.name)+(c.code?' <span style="color:#aaa">['+esc(c.code)+']</span>':'')+(no?' <span style="color:#c0392b;font-size:10px">取引なし</span>':'')+'</td>'
      + '<td style="padding:4px 8px;text-align:center;color:'+(no?'#c0392b':'#555')+'">'+last+'</td>'
      + '<td style="padding:4px 8px;text-align:center">'+c.productCount+'</td>'
      + '</tr>';
  });
  if(!active.length) h += '<tr><td colspan="4" style="padding:10px;color:#aaa;text-align:center">該当なし</td></tr>';
  h += '</tbody></table></div>';
  $('#exclBody').innerHTML = h;
  const si=$('#exclSearch'); if(si){ si.addEventListener('input', exclRender); si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
  // チェックボックス（行）
  $('#exclBody').querySelectorAll('.exclChk').forEach(cb=> cb.addEventListener('change', (e)=>{
    const nm=e.currentTarget.dataset.name;
    if(e.currentTarget.checked) exclChecked.add(nm); else exclChecked.delete(nm);
    exclSyncSelCount();
  }));
  // ヘッダーの全チェック（表示中のみ）
  const all=$('#exclChkAll'); if(all) all.addEventListener('change', (e)=>{
    const on=e.currentTarget.checked;
    exclVisibleActive().forEach(c=>{ if(on) exclChecked.add(c.name); else exclChecked.delete(c.name); });
    exclRender();
  });
  // 取引なしを一括チェック（フィルタ中なら表示中の取引なし）
  $('#exclCheckNoTrade').addEventListener('click', ()=>{
    exclVisibleActive().forEach(c=>{ if(!c.hasRecent) exclChecked.add(c.name); });
    exclRender();
  });
  $('#exclClearSel').addEventListener('click', ()=>{ exclChecked.clear(); exclRender(); });
  $('#exclHideSel').addEventListener('click', exclHideSelected);
  // 復活ボタン
  $('#exclBody').querySelectorAll('.exclRestore').forEach(b=> b.addEventListener('click', ()=> exclToggle(b.dataset.name, false)));
  exclSyncSelCount();
}
// 選択した得意先をまとめて隠す
async function exclHideSelected(){
  const names=[...exclChecked]; if(!names.length) return;
  try{
    const res = await fetch('/api/exclude-customers-bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({names, exclude:true})}).then(x=>x.json());
    if(!res.ok){ alert('保存に失敗: '+(res.error||'')); return; }
    exclData = { active:res.active||[], excluded:res.excluded||[] };
    exclChecked.clear();
    exclRender();
    if(allView) loadAll(); else if(!dateFilter) loadFile();
    loadAllImpact();
  }catch(e){ alert('通信に失敗: '+e); }
}
// 1件の除外/復活（復活ボタン用）
async function exclToggle(name, exclude){
  try{
    const res = await fetch('/api/exclude-customer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:name, exclude})}).then(x=>x.json());
    if(!res.ok){ alert('保存に失敗: '+(res.error||'')); return; }
    exclData = { active:res.active||[], excluded:res.excluded||[] };
    exclChecked.delete(name);
    exclRender();
    // メイン表・損益を最新に（除外結果を即反映）
    if(allView) loadAll(); else if(!dateFilter) loadFile();
    loadAllImpact();
  }catch(e){ alert('通信に失敗: '+e); }
}
async function openExcludeModal(){
  let data;
  try{ data = await fetch('/api/customer-list').then(x=>x.json()); }
  catch(e){ alert('得意先一覧の取得に失敗: '+e); return; }
  exclData = { active:data.active||[], excluded:data.excluded||[] };
  exclChecked = new Set();
  const wrap=document.createElement('div');
  wrap.innerHTML =
    '<div id="exclBack" style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9000"></div>'+
    '<div id="exclDlg" style="position:fixed;top:5%;left:50%;transform:translateX(-50%);background:#fff;border-radius:8px;padding:18px;width:680px;max-width:95%;z-index:9001;box-shadow:0 10px 40px rgba(0,0,0,.2)">'+
      '<div style="display:flex;align-items:center;margin-bottom:10px"><h3 style="margin:0;flex:1">🚫 得意先 除外設定</h3><button id="exclClose" style="font-size:13px;border:1px solid #ccc;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer">閉じる</button></div>'+
      '<div id="exclBody"></div>'+
    '</div>';
  document.body.appendChild(wrap);
  const close=()=>wrap.remove();
  $('#exclBack').addEventListener('click', close);
  $('#exclClose').addEventListener('click', close);
  exclRender();
}
async function loadFiles(selectFile){
  const r = await fetch('/api/files').then(x=>x.json());
  const sel = $('#file'); sel.innerHTML='';
  if(r.files && r.files.length){
    // 先頭に「★全部」＝全仕入先横断（件数が多く重いので既定は各仕入先の最新1本）。
    const oAll=document.createElement('option'); oAll.value='*ALL*'; oAll.textContent='★ 全部（全仕入先まとめて表示・重い）'; sel.appendChild(oAll);
  }
  (r.files||[]).forEach(f=>{ const o=document.createElement('option'); o.value=f; o.textContent=f; sel.appendChild(o); });
  if(!r.files || !r.files.length){ $('#msg').textContent='input フォルダに照合結果CSVがありません。「↻ 照合を実行」でメーカー見積から作れます。'; return; }
  // 指定があればその仕入先、無ければ最新1仕入先（前回選択を sessionStorage に記憶）。
  let def = r.files[0];
  try{
    const saved = sessionStorage.getItem('simFileSel');
    // ★全部は重いので起動時の既定復元から除外（明示選択時のみ *ALL* を使う）。
    if(saved && saved!=='*ALL*' && r.files.indexOf(saved)>=0) def = saved;
  }catch(e){}
  sel.value = (selectFile && r.files.indexOf(selectFile)>=0) ? selectFile : def;
  await loadFile();
}
// メーカー見積×販売実績を照合し、新しい照合結果CSVを作って読み込む
async function runShogo(){
  const btn=$('#shogoBtn');
  if(btn.disabled) return;
  btn.disabled=true;
  setShogoLock(true,'メーカー見積と販売実績を照合しています…');
  $('#shogoMsg').style.color='#6b7785'; $('#shogoMsg').textContent='照合中…（販売実績の変換に時間がかかる場合があります）';
  try{
    const res=await fetch('/api/shogo',{method:'POST'}).then(x=>x.json());
    if(res.busy){
      $('#shogoMsg').style.color='#c0392b'; $('#shogoMsg').textContent=res.error||'照合が既に実行中です';
      return;
    }
    if(res.ok){
      const newest=(res.files&&res.files.length)?res.files[res.files.length-1]:null;
      $('#shogoMsg').style.color='#2e7d32'; $('#shogoMsg').textContent='✓ 照合完了（'+(res.files?res.files.length:0)+'件のCSVを作成）';
      await loadFiles(newest);
      loadAllImpact(); // 照合結果が増減した可能性 → 全社損益を取り直す
      loadDupCheck(); loadLinkCheck(); loadCdCandidates(); loadRequoteCheck(); // 二重登録・紐付け名ずれ・CD候補・再見積もり要を取り直す
    } else {
      $('#shogoMsg').style.color='#c0392b'; $('#shogoMsg').textContent='照合できません: '+(res.error||'');
    }
  }catch(e){ $('#shogoMsg').style.color='#c0392b'; $('#shogoMsg').textContent='照合に失敗: '+e; }
  finally{ btn.disabled=false; setShogoLock(false); }
}

// 進捗バッジ（実施日カレンダーの横断ビュー用）。得意先別ページの状態を表示＝この実施日の品が
//  どこまで進んだか（提出済み／検討中で外した／まだ未提出）が一目で分かる。
function progressBadge(st){
  if(st==='issued') return '<div style="font-size:10px;font-weight:700;color:#1f6b35;margin-top:1px">✅ 提出済み</div>';
  if(st==='hold')   return '<div style="font-size:10px;font-weight:700;color:#8a5a12;margin-top:1px">🤔 検討中</div>';
  if(st==='dormant')return '<div style="font-size:10px;font-weight:700;color:#3a6ea5;margin-top:1px">💤 休眠</div>';
  if(st==='manual') return '<div style="font-size:10px;font-weight:700;color:#5a4a8a;margin-top:1px">✏ 手動修正</div>';
  return '<div style="font-size:10px;font-weight:700;color:#b1432f;margin-top:1px">⬜ 未提出</div>';
}
// 行メトリクス（仕入値上額・数量・年影響・改定後仕入）をHTML化。初回描画と updateView で共用。
function costIncreaseCellHtml(r){
  const rate = rateOf(r.currentCost, r.newCost);
  let html = '<span class="'+signCls(r.costIncrease)+'">'+num(r.costIncrease)+'</span>';
  if(Number.isFinite(rate)){
    const rc = rate>0.05 ? 'pos' : (rate<-0.05 ? 'neg' : 'flat');
    html += '<span class="ratetag '+rc+'">'+(rate>0?'+':'')+rate.toFixed(1)+'%</span>';
  }
  return html;
}
function qtyCellHtml(r){
  if(Number.isFinite(r.qty) && r.qty>0){
    const b = r.qtySource==='actual' ? '<span class="badge act">実</span>' : '<span class="badge est">推</span>';
    return Math.round(r.qty).toLocaleString('ja-JP') + ' <span class="ml6">'+b+'</span>';
  }
  return '—';
}
function newCostCellHtml(r){
  const red = r.priceWarning || r.costConflict || '';
  let cls = 'r', extra = '', content = num(r.newCost);
  if(red){ cls += ' pricewarn'; extra = ' title="⚠ '+esc(red)+'"'; content = '⚠ '+content; }
  else if(r.rateWarning){ cls += ' ratewarn'; extra = ' title="注意: '+r.rateWarning+'"'; content = '▲ '+content; }
  return { cls, extra, content, warn: !!red, rate: !!(r.rateWarning && !red) };
}
function rowWarnFlags(r){
  if(r.priceWarning || r.costConflict) return { warn: true, rate: false };
  if(r.rateWarning) return { warn: false, rate: true };
  return { warn: false, rate: false };
}
// 1行ぶんの <tr> を組み立てて tbody へ。readOnly=true（実施日フィルタの横断ビュー）では
//  改定後仕入の編集欄・行ルール・紐付けボタンを出さず、仕入先名＋進捗を商品名の下に小さく添える。
function buildMainRow(r, i, readOnly){
  const tr = document.createElement('tr');
  tr.id='row'+i;
  if(isUnmatched(r)) tr.className='unmatched';
  let prodName = buildProdNameHtml(r); // 仕入先は商品名内の「🏢 仕入先」バッジで全ビュー共通に表示（buildProdNameHtml）
  if(readOnly) prodName += progressBadge(r.itemStatus);
  const nc = newCostCellHtml(r);
  const linkCell = '<td class="c" id="lk'+i+'">'+linkCellHtml(r, i)+'</td>'; // 横断（読み取り）ビューでも紐付けは可能（id付き＝保存直後にこのセルだけ再描画）
  tr.innerHTML =
    '<td class="c shogo-col"></td>'+
    custCellHtml(r)+
    '<td class="c">'+matchPctCell(r)+'</td>'+
    '<td class="pn">'+prodName+'</td>'+
    linkCell+
    '<td class="r">'+num(r.currentCost)+'</td>'+
    '<td class="'+nc.cls+'" id="nc'+i+'"'+nc.extra+'>'+nc.content+'</td>'+
    '<td class="r" id="ci'+i+'">'+costIncreaseCellHtml(r)+'</td>'+
    '<td class="c" id="qt'+i+'">'+qtyCellHtml(r)+'</td>'+
    '<td class="r '+signCls(r.annualCostImpact)+'" id="aci'+i+'">'+yen(r.annualCostImpact)+'</td>';
  return tr;
}
// 区切り見出しの行（一致品／休眠の境目）。セルIDを持たないので updateView は素通り。
function sectionHeaderRow(text, bg, fg){
  const tr=document.createElement('tr'); tr.className='secthead';
  tr.innerHTML='<td colspan="10" style="background:'+bg+';color:'+fg+';font-weight:700;font-size:12px;padding:6px 10px;border-top:2px solid '+fg+'">'+text+'</td>';
  return tr;
}
// baseRows を表に描画。readOnly のときは編集系イベントを配線しない。
//  通常：①一致品 ②休眠。実施日カレンダー横断(readOnly)：①提出済み ②未提出 に分ける。
//  ※並べ替えても buildMainRow には元のインデックス i を渡す（セルIDが updateView と対応＝値がズレない）。
function renderMainRows(readOnly){
  const tb = $('#tbody'); tb.innerHTML='';
  // 行は DocumentFragment（DOM外）に貯めて最後に1回だけ挿入する＝行ごとの再レイアウトを避ける（データ増に強い）。
  const frag = document.createDocumentFragment();
  // 見積書を作成済み（提出済み）の行は通常表示では出さない（作業中の品だけに絞る）。
  //  ※実施日カレンダー横断ビューでは提出済／未提出を分けて表示する。
  let hiddenIssued=0;
  const matched=[], dormant=[], issued=[], todo=[];
  baseRows.forEach((r,i)=>{
    if(readOnly){
      if(r.itemStatus==='issued') issued.push(i);
      else todo.push(i);
      return;
    }
    if(r.itemStatus==='issued'){ hiddenIssued++; return; }
    (isUnmatched(r)?dormant:matched).push(i);
  });
  const col = new Intl.Collator('ja');
  if(readOnly){
    const byCustSup=(a,b)=> col.compare(baseRows[a].supplier||'', baseRows[b].supplier||'')
      || col.compare(baseRows[a].customerName||'', baseRows[b].customerName||'')
      || col.compare(baseRows[a].productName||'', baseRows[b].productName||'');
    issued.sort(byCustSup); todo.sort(byCustSup);
    const holdN=todo.filter(i=>baseRows[i].itemStatus==='hold').length;
    const manualN=todo.filter(i=>baseRows[i].itemStatus==='manual').length;
    // 並び順：⬜未提出（要対応）を上、✅提出済みを下へ。
    if(todo.length){
      let todoLbl='⬜ 未提出 '+todo.length+'件（見積書 未発行・要対応）';
      if(holdN) todoLbl+=' — うち検討中 '+holdN+'件';
      if(manualN) todoLbl+=' — うち手動修正 '+manualN+'件';
      frag.appendChild(sectionHeaderRow(todoLbl, '#fff8ee', '#8a5a12'));
      todo.forEach(i=> frag.appendChild(buildMainRow(baseRows[i], i, true)));
    }
    if(issued.length){
      frag.appendChild(sectionHeaderRow('✅ 提出済み '+issued.length+'件（見積書を発行済み）', '#eaf6ee', '#1b6b3a'));
      issued.forEach(i=> frag.appendChild(buildMainRow(baseRows[i], i, true)));
    }
  } else {
    sortMatchedIndices(matched);
    dormant.sort((a,b)=> col.compare(baseRows[a].supplier||'', baseRows[b].supplier||'')
      || col.compare(baseRows[a].makerName||'', baseRows[b].makerName||''));
    if(matched.length){
      const sortLbl = mainSortMode === 'matchDesc' ? '一致度 高い順' : (mainSortMode === 'matchAsc' ? '一致度 低い順' : '得意先別');
      const todoN = matched.filter(i=> statusRank(baseRows[i])===0).length;
      const todoLbl = todoN ? '・⬜未提出 '+todoN+'件を上に' : '';
      frag.appendChild(sectionHeaderRow('✓ 一致品 '+matched.length+'件（'+sortLbl+todoLbl+'）', '#eaf6ee', '#1b6b3a'));
      matched.forEach(i=> frag.appendChild(buildMainRow(baseRows[i], i, readOnly)));
    }
    if(dormant.length){
      frag.appendChild(sectionHeaderRow('💤 休眠・未一致 '+dormant.length+'件（販売実績なし／商品名が一致せず＝見積対象外。紐付けで救済できます）', '#f1f1f1', '#7a7a7a'));
      dormant.forEach(i=> frag.appendChild(buildMainRow(baseRows[i], i, readOnly)));
    }
  }
  const note=$('#issuedHideNote');
  if(note){
    if(hiddenIssued && !readOnly){ note.style.display=''; note.innerHTML='✅ <b>見積書 作成済み '+hiddenIssued+' 件</b>は非表示です（提出済み）。得意先別ページの「✅提出済み」で確認・対象へ戻せます。'; }
    else { note.style.display='none'; note.textContent=''; }
  }
  // 価格編集（改定後仕入・行ルール）はメイン画面から撤去＝得意先別ページに集約したので配線しない。
  // 全行をまとめて1回だけ挿入（行ごとの再レイアウトを避ける）。
  tb.appendChild(frag);
  // 紐付け✏ボタンのクリックは #tbody の委譲リスナ（initで1個だけ）が処理する＝行数ぶんの addEventListener を廃止。
}
// 「★全部」＝全仕入先まとめて1つの表に（取り込んでいる全件）。
async function loadAll(){
  clearDateFilter();
  $('#msg').textContent='';
  const s = settings();
  const res = await fetch('/api/calc-all',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ rule:s.rule, rounding:s.rounding, selfUplift:s.selfUplift })}).then(x=>x.json());
  if(res.error){ $('#msg').textContent='エラー: '+res.error; return; }
  allView = true;
  baseRows = res.rows;
  currentSupplier = ''; currentLinks = {};
  allMakerNames = res.makerNames || [];
  currentSuppliers = res.suppliers || {};
  renderMainRows(false); // 全部ビューでも提出済みは隠す＝作業中の品だけ
  updateView(res.rows, res.summary, { skipMetrics: true });
  syncHScroll();
}
// ファイルを読み込み、表の“構造”を作る（入力欄やルール選択を配置）
async function loadFile(){
  if($('#file').value==='*ALL*'){ return loadAll(); } // ★全部 を選んだら横断表示へ
  allView = false;
  clearDateFilter(); // 通常のファイル表示に入る＝実施日フィルタは解除
  $('#msg').textContent='';
  const s = settings();
  const res = await fetch('/api/calc',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ file:$('#file').value, rule:s.rule, rounding:s.rounding, selfUplift:s.selfUplift })}).then(x=>x.json());
  if(res.error){ $('#msg').textContent='エラー: '+res.error; return; }
  baseRows = res.rows;
  currentSupplier = res.supplier || '';
  currentLinks = res.productLinks || {};
  allMakerNames = res.makerNames || [];
  currentSuppliers = res.suppliers || {};
  renderMainRows(false);
  updateView(res.rows, res.summary, { skipMetrics: true });
  syncHScroll();
}
// 実施日カレンダーで選んだ日の改定を、全仕入先 横断で表に表示（読み取り）。
async function loadByDate(dateIso, label){
  if(!dateIso) return;
  const s = settings();
  $('#msg').textContent='';
  const res = await fetch('/api/calc-by-date',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ date:dateIso, rule:s.rule, rounding:s.rounding, selfUplift:s.selfUplift })}).then(x=>x.json());
  if(!res.ok){ $('#msg').textContent='エラー: '+(res.error||''); return; }
  dateFilter = dateIso;
  baseRows = res.rows; currentSupplier=''; currentLinks={};
  renderMainRows(true);
  updateView(res.rows, res.summary);
  syncHScroll();
  const lab = label || (function(d){ const p=String(d).split('-'); return Number(p[0])+'年'+Number(p[1])+'月'+Number(p[2])+'日'; })(dateIso);
  const bar=$('#dateFilterBar');
  const sc = res.statusCounts || {issued:0,hold:0,manual:0,todo:0};
  const todoAll=sc.todo+(sc.hold||0)+(sc.manual||0);
  $('#dateFilterLabel').innerHTML='📅 '+esc(lab)+' の改定 '+res.count+'件（全'+res.supplierCount+'仕入先）'
    +' ｜ <span style="color:#1f6b35">✅提出済 '+sc.issued+'</span>'
    +' <span style="color:#b1432f">⬜未提出 '+todoAll+'</span>'
    +(sc.hold?' <span style="color:#8a5a12;font-size:11px">(うち検討中 '+sc.hold+')</span>':'')
    +(sc.manual?' <span style="color:#5a4a8a;font-size:11px">(うち手動修正 '+sc.manual+')</span>':'');
  bar.style.display='flex';
  // 表が見えるようにスクロール
  const w=$('#wrap'); if(w) w.scrollIntoView({behavior:'smooth',block:'start'});
}
// 実施日フィルタを解除（表示状態のみ。次の loadFile / loadByDate で実データを描き直す）
function clearDateFilter(){ dateFilter=null; const b=$('#dateFilterBar'); if(b) b.style.display='none'; }

// 表の上の補助スクロールバーを表の実幅に合わせ、横スクロールが必要なときだけ表示する。
function syncHScroll(){
  const wrap=$('#wrap'), hbar=$('#hbar'), inner=$('#hbarInner'), tbl=$('#tbl');
  if(!wrap||!hbar||!inner||!tbl) return;
  const sw = tbl.scrollWidth;
  inner.style.width = sw + 'px';
  // 表が枠より広い（＝右が見切れる）ときだけ補助バーを出す
  hbar.style.display = (sw > wrap.clientWidth + 2) ? 'block' : 'none';
}

// 紐付けセルのHTML。確定済(📌)はラベル＋編集ボタン、未確定は淡色の「✏編集」のみ。
function linkCellHtml(r, i){
  const code = r.productCode || '';
  // 🚫除外 / 💤休眠（保留）：照合対象から外す指定。↻照合で休眠になる。✏で別品選択/解除に戻せる。確定判定より先に出す。
  const _mk = code ? linkLookup(currentLinks, code) : '';
  if (_mk === '__EXCLUDE__' || _mk === '__DORMANT__') {
    const _badge = (_mk === '__DORMANT__')
      ? '<span style="color:#6b7785;font-weight:700" title="この自社品は このメーカーでは休眠（保留）扱いです（正しい品だが今は仕入れていない）。「↻ 照合」で休眠になります。✏ から別のメーカー品を選ぶ／解除で戻せます。">💤 休眠（保留）</span>'
      : '<span style="color:#c0392b;font-weight:700" title="この自社品は このメーカーでは別物として除外中です（誤紐付け防止）。「↻ 照合」で休眠になります。✏ から別のメーカー品を選ぶ／解除で戻せます。">🚫 除外中</span>';
    return _badge + ' <button class="linkBtn" data-i="'+i+'" style="font-size:11px">✏</button>';
  }
  // 未照合の手動紐付け（保存直後の即時フィードバック）：選んで保存したが ↻照合 はまだ＝橙バッジで「やった行」を示す。
  //  確定（緑）より先に判定する＝既に📌確定の行を別品に変えても「未照合」が正しく出る。↻照合で baseRows が
  //  作り直され _pendingLink は消える（＝確定済みは緑「📌 確定」へ）。
  if (r._pendingLink) {
    const pv = r._pendingLink.value;
    const pb = pv
      ? '<span style="color:#fff;background:#e08a00;font-weight:700;border-radius:3px;padding:0 5px" title="紐付けを保存しました（未照合）。表の左「↻ 照合」を押すと照合結果に反映され「📌 確定」になります。">📌 紐付け済み（未照合）</span>'
      : '<span style="color:#fff;background:#8a94a6;font-weight:700;border-radius:3px;padding:0 5px" title="紐付けの解除を保存しました（未照合）。「↻ 照合」で自動マッチに戻ります。">🔄 解除予定（未照合）</span>';
    return pb + ' <button class="linkBtn" data-i="'+i+'" style="font-size:11px">✏</button>';
  }
  // 確定済み判定：現在ファイルの紐付け辞書 or 行のステータスが「📌 手動紐付け」（横断ビューは辞書が空なので後者で判定）
  const linked = code && (linkEq(linkLookup(currentLinks, code), r.makerName) || /📌/.test(r.matchStatus||''));
  if (linked) {
    const sup = r.supplier || currentSupplier || '';
    const up = linkUpgradeMap[sup+'\x01'+code];
    const upTip = up
      ? (up.kind==='better_cd'
        ? '手動よりCD一致の候補あり：'+up.betterMaker
        : '手動より一致度の高い候補あり（'+up.betterScore+'%）：'+up.betterMaker)
      : '';
    const upMark = up ? ' <span style="color:#c0392b;font-weight:700" title="'+esc(upTip)+'">⚠</span>' : '';
    const sus = linkSuspectMap[sup+'\x01'+code];
    const susReason = sus ? (sus.reasons||[]).map(function(x){ return x.k==='low_name'?('名前ほぼ別物('+x.v+'%)'):x.k==='size_mismatch'?'サイズ違い':x.k==='color_mismatch'?'色違い':x.k==='price_gap'?('原価約'+x.v+'倍ズレ'):x.k; }).join('・') : '';
    const susMark = sus ? ' <span style="color:#fff;background:#c0392b;font-weight:700;border-radius:3px;padding:0 4px" title="'+esc('勘違いの疑い：自社「'+(sus.selfName||'')+'」と別物かも（'+susReason+'）。✏で見直してください')+'">🚨</span>' : '';
    return '<span style="color:#1e7e34;font-weight:600">📌 確定</span>'+susMark+upMark+' <button class="linkBtn" data-i="'+i+'" style="font-size:11px">✏</button>';
  }
  if (!code) {
    // 休眠（メーカー品が自社品に未マッチ）でも、メーカー商品名があれば「実績のある自社品を選んで紐付け」できる
    if (r.makerName) return '<button class="linkBtn" data-i="'+i+'" style="font-size:11px;color:#b8860b" title="実績のある自社品を選んで、このメーカー品に紐付けます">✏ 実績と紐付け</button>';
    return '<span class="hint">—</span>';
  }
  return '<button class="linkBtn" data-i="'+i+'" style="font-size:11px;color:#6b7785">✏ 紐付け</button>';
}

// 紐付けセルだけを描き直す（保存直後の即時反映用）。↻照合を待たず「やった行」を可視化する。
//  クリックは #tbody の委譲リスナが拾うので、新しい ✏ ボタンへ貼り直す必要はない（innerHTML 差し替えだけ）。
function refreshLinkCell(idx){
  const r = baseRows[idx]; if(!r) return;
  const cell = document.getElementById('lk'+idx); if(!cell) return;
  cell.innerHTML = linkCellHtml(r, idx);
}

// 紐付けモーダルの類似度判定（クライアント側で軽量に計算）
function linkTokenize(s){
  return String(s||'').toLowerCase()
    .replace(/[（）()\\[\\]【】「」、，。．,\\.;:!?※#＊]/g,' ')
    .split(/[\\s\\-_\\/×・]+/)
    .filter((t) => t.length>=1);
}
function linkSim(a, b){
  const ta = linkTokenize(a), tb = linkTokenize(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
  return inter / Math.max(sa.size, sb.size);
}
// 紐付け名の表記ゆれ比較（productLink.js と同じ NFKC＋空白除去）
function linkNormN(s){ return String(s||'').normalize('NFKC').replace(/\\s+/g,'').toLowerCase(); }
function linkEq(a,b){ return !!a&&!!b&&(a===b||linkNormN(a)===linkNormN(b)); }
function linkLookup(links, code){
  const raw=String(code||'').trim(); if(!raw) return '';
  if(links[raw]) return links[raw];
  if(/^\\d+$/.test(raw)){
    const pad=raw.padStart(6,'0');
    if(links[pad]) return links[pad];
    const n=String(Number(pad));
    if(links[n]) return links[n];
  }
  return '';
}
function escAttr(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
// 「決定的」な語＝単一漢字(蓋/身/大/中/小/特/丸/角…) または 数字を含むトークン(0.4/28/11号…)、
// あるいは部位語(本体/内嵌合蓋/巻き蓋/防曇蓋/内嵌合/嵌合蓋/内外蓋/高蓋/中皿)。
// 取り違えが致命的になる語。両側で揃っていないと「品が違う」可能性が高い。
// ※ src/match.js:PART_TOKENS と同じ語彙。更新するときは両方を合わせる。
const LINK_PART_TOKENS = new Set(['本体','内嵌合蓋','内嵌合','巻き蓋','防曇蓋','嵌合蓋','内外蓋','高蓋','中皿','部分内嵌合蓋','部分内嵌合']);
function linkDecisiveTokens(s){
  return linkTokenize(s).filter((t) => /^[\\u4e00-\\u9fff]$/.test(t) || /\\d/.test(t) || LINK_PART_TOKENS.has(t));
}
function linkDecisiveDiff(selfCore, maker){
  const sd = new Set(linkDecisiveTokens(selfCore));
  const md = new Set(linkDecisiveTokens(maker));
  const onlyMaker = [...md].filter((t) => !sd.has(t));
  const onlySelf  = [...sd].filter((t) => !md.has(t));
  return { onlyMaker, onlySelf, hasDiff: onlyMaker.length>0 || onlySelf.length>0 };
}

// 編集モーダル: 自社CD ⇔ メーカー商品 を選び直す or 解除する。検索/類似度順/決定的トークン警告つき。
//  2モード:
//   ・maker（自社CDがある行）= 従来。自社品に対して「確定するメーカー商品」を選ぶ。
//   ・self （自社CDが無い休眠行）= 新。メーカー品(固定)に対して「実績のある自社品」を販売実績から選ぶ。
//     ＝休眠（メーカー品が自社品に1つも当たっていない）を、画面から直接 手動紐付けで救済できる。
async function openLinkModal(idx, preselect){
  const r = baseRows[idx]; if(!r) return;
  // 仕入先の確定（横断ビュー・★全部ビューは行の仕入先、通常は選択中ファイルの仕入先）
  const supplier = (dateFilter || allView) ? (r.supplier || '') : (currentSupplier || '');
  if (!supplier){ alert('仕入先が確定できない行です（紐付けは保存できません）'); return; }
  const mode = r.productCode ? 'maker' : 'self';
  if (mode === 'self' && !r.makerName){ alert('この行はメーカー商品名が無いため紐付けできません'); return; }

  // モード別: 固定側の表示・選ぶ側のタイトル・類似度の比較基準・保存ペイロード
  const selfCore = r.productNameCore || r.productName || '';
  let fixedHtml, pickTitle, baseName, savePayload;
  if (mode === 'maker'){
    fixedHtml = '<b>自社商品:</b> '+esc(r.productCode||'')+' <span style="color:#1f4e78">'+esc(selfCore)+'</span>';
    pickTitle = '確定するメーカー商品';
    baseName = selfCore;
    savePayload = (val)=>({ supplier: supplier, productCode: r.productCode, makerName: val });
  } else {
    const mk = (r.makerCode? '['+r.makerCode+'] ':'') + (r.makerName||'');
    fixedHtml = '<b>メーカー商品（休眠＝未マッチ）:</b> <span style="color:#8a5a00">'+esc(mk)+'</span>';
    pickTitle = '紐付ける自社商品（販売実績から選ぶ）';
    baseName = r.makerName || '';
    savePayload = (val)=>({ supplier: supplier, productCode: val, makerName: r.makerName });
  }

  const noteHtml = (mode === 'maker')
    ? '⚠ 保存すると、その自社商品はこのメーカー品に固定されます。照合結果CSVへ反映するには、表の左「↻ 照合」を押してください。先頭の「— 解除」で自動マッチに戻せます。'
    : '⚠ 保存すると、その自社品（販売実績）がこのメーカー品に固定されます。休眠の解消は表の左「↻ 照合」を押したあとに反映されます。';

  const wrap = document.createElement('div');
  wrap.innerHTML =
    '<div id="linkBack" style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9000"></div>'+
    '<div id="linkDlg" style="position:fixed;top:6%;left:50%;transform:translateX(-50%);background:#fff;border-radius:8px;padding:18px;width:640px;max-width:95%;z-index:9001;box-shadow:0 10px 40px rgba(0,0,0,.2)">'+
      '<h3 style="margin:0 0 12px">📌 商品紐付けの編集</h3>'+
      '<div style="margin-bottom:6px"><b>仕入先:</b> '+esc(supplier)+'</div>'+
      '<div style="margin-bottom:6px">'+fixedHtml+'</div>'+
      '<div style="margin-bottom:10px;font-size:12px;color:#6b7785"><b>現在の照合:</b> '+esc(r.matchStatus||(mode==='self'?'休眠':''))+' / '+esc(r.makerName||'(未マッチ)')+'</div>'+
      '<div style="margin-bottom:4px"><b>'+pickTitle+'</b> <span style="font-size:11px;color:#6b7785">（類似度順。✓=80%以上）</span></div>'+
      '<input id="linkSearch" placeholder="🔍 商品名・コードで絞り込み（部分一致）" style="width:100%;padding:6px;margin-bottom:4px;border:1px solid #c7ced8;border-radius:4px;font:inherit;box-sizing:border-box">'+
      '<select id="linkPick" size="8" style="width:100%;padding:4px;font:inherit;border:1px solid #c7ced8;border-radius:4px;box-sizing:border-box"></select>'+
      '<div id="linkWarn" style="margin-top:8px;padding:8px;background:#fdecea;border:1px solid #f3c0c0;border-radius:4px;font-size:12px;color:#8a3a3a;display:none"></div>'+
      '<div style="margin-top:10px;background:#fff8e1;border:1px solid #ffe082;padding:8px;border-radius:4px;font-size:11px;color:#5a4a1a">'+noteHtml+'</div>'+
      '<div style="display:flex;align-items:center;margin-top:12px">'+
        (mode==='maker' ? '<button id="linkDormant" style="padding:6px 12px;margin-right:6px;background:#fff;border:1px solid #8a94a6;color:#5a6470;border-radius:4px;cursor:pointer;font-size:12px" title="正しい品だが今は仕入れていない＝休眠（保留）として、この仕入先の照合対象から一時的に外します。解除はこの画面で別のメーカー品を選び保存／先頭の「— 解除」で戻せます。">💤 休眠（保留）にする</button>'+
          '<button id="linkExclude" style="padding:6px 12px;background:#fff;border:1px solid #c0392b;color:#c0392b;border-radius:4px;cursor:pointer;font-size:12px" title="似た名前の別メーカー品で そもそも別物＝誤紐付けとして、この仕入先の照合対象から外します。解除はこの画面で別のメーカー品を選び保存／先頭の「— 解除」で戻せます。">🚫 別物として除外</button>' : '')+
        '<span style="margin-left:auto"></span>'+
        '<button id="linkCancel" style="margin-right:8px;padding:6px 14px">キャンセル</button>'+
        '<button id="linkSave" style="padding:6px 14px;background:#1976d2;color:#fff;border:none;border-radius:4px;cursor:pointer">保存</button>'+
      '</div>'+
    '</div>';
  document.body.appendChild(wrap);
  const sel = $('#linkPick'), search = $('#linkSearch'), warn = $('#linkWarn'), saveBtn = $('#linkSave');

  // 候補の読み込み（maker=メーカー商品名 / self=販売実績の自社品）。self は非同期取得なので先に「読込中」を出す。
  //  各候補: { value(保存値), simName(類似度の比較名), label(表示), samePc(同じ発注先) }
  sel.innerHTML = '<option>読込中…</option>'; saveBtn.disabled = true;
  let cur = '';
  let list = [];
  if (mode === 'maker'){
    let makerNames, links;
    if (dateFilter || allView){
      // 横断（実施日フィルタ）／★全部ビューは行ごとに仕入先が違い、allMakerNames が空なので、
      //  その行の仕入先のメーカー商品名候補を /api/link-context から取得する。
      const ctx = await fetch('/api/link-context?supplier='+encodeURIComponent(supplier)).then(x=>x.json()).catch(()=>null);
      if (!ctx || !ctx.ok){ warn.style.display='block'; warn.textContent='⚠ 紐付け候補の取得に失敗しました'; return; }
      makerNames = ctx.makerNames || []; links = ctx.links || {};
    } else {
      // 単一仕入先ビューでも候補はサーバが返した拡張リスト（照合＋メーカー見積＋登録済み）
      if (!allMakerNames.length) {
        const ctx = await fetch('/api/link-context?supplier='+encodeURIComponent(supplier)).then(x=>x.json()).catch(()=>null);
        if (!ctx || !ctx.ok){ warn.style.display='block'; warn.textContent='⚠ 紐付け候補の取得に失敗しました'; return; }
        makerNames = ctx.makerNames || []; links = ctx.links || currentLinks;
      } else { makerNames = allMakerNames; links = currentLinks; }
    }
    cur = linkLookup(links, r.productCode) || '';
    list = makerNames.map((n)=>({ value:n, simName:n, label:n, samePc:false }));
  } else {
    const ctx = await fetch('/api/self-products?supplier='+encodeURIComponent(supplier)).then(x=>x.json()).catch(()=>null);
    if (!ctx || !ctx.ok){ warn.style.display='block'; warn.innerHTML='⚠ 自社品（販売実績）の取得に失敗しました'+(ctx&&ctx.error?'：'+esc(ctx.error):'（DB/ファイルに接続できません）'); return; }
    const supPC = ctx.supplierPurchaseCode || '';
    list = (ctx.products||[]).map((p)=>{
      const same = !!(supPC && p.purchaseCode === supPC);
      const pcTag = p.purchaseCode ? (' 〔'+p.purchaseCode+(same?' 🏢同発注先':'')+'〕') : '';
      const sellTag = (p.currentSell!=null) ? (' ¥'+p.currentSell) : '';
      return { value:p.code, simName:p.name, label:'['+p.code+'] '+p.name+pcTag+sellTag, samePc:same };
    });
  }
  // 登録済みの紐付け名が候補リストに無いときは先頭に追加（変更・解除できるように）
  if (mode === 'maker' && cur && !list.some((x) => linkEq(x.value, cur))) {
    list.unshift({ value: cur, simName: cur, label: cur + ' （現在の登録・候補外）', samePc: false });
  }
  // 類似度でスコアリング・降順（self は同じ発注先を少し優先）
  let scored = list.map((c)=>({ ...c, score: linkSim(baseName, c.simName) + (c.samePc?0.15:0) }))
    .sort((a,b)=> b.score - a.score);
  const byValue = {}; scored.forEach((c)=>{ byValue[c.value] = c; });
  saveBtn.disabled = false;

  function renderOptions(filter){
    const flt = String(filter||'').toLowerCase();
    const head = '<option value="">— （自動マッチに任せる／紐付け解除）</option>';
    const opts = scored
      .filter((x) => !flt || x.label.toLowerCase().includes(flt) || x.value.toLowerCase().includes(flt))
      .map((x) => {
        const pct = Math.min(100, Math.round(x.score*100));
        const mark = x.score >= 0.8 ? '✓' : (x.score >= 0.5 ? '·' : ' ');
        const selAttr = x.value === sel.value ? ' selected' : '';
        const padPct = (pct<10?'  ':(pct<100?' ':''))+pct;
        return '<option value="'+escAttr(x.value)+'"'+selAttr+'>'+mark+' ['+padPct+'%] '+esc(x.label)+'</option>';
      }).join('');
    const prev = sel.value;
    sel.innerHTML = head + opts;
    if (prev != null) sel.value = prev;
  }
  function updateWarning(){
    const parts = [];
    if (mode === 'maker' && r.productCode) {
      const sus = linkSuspectMap[supplier+'\x01'+r.productCode];
      if (sus) {
        const sr = (sus.reasons||[]).map(function(x){ return x.k==='low_name'?('名前がほぼ別物('+x.v+'%)'):x.k==='size_mismatch'?'サイズ違い':x.k==='color_mismatch'?'色違い':x.k==='price_gap'?('原価が約'+x.v+'倍ズレ'):x.k; }).join('・');
        parts.push('🚨 <b>現在の手動紐付けは勘違いの疑い</b>：自社品「'+esc(sus.selfName||'')+'」に対し 登録先「'+esc(sus.linked)+'」は<b>別商品の可能性</b>（'+esc(sr)+'）。取り違えなら正しいメーカー品を選び直すか、解除してください。');
      }
      const up = linkUpgradeMap[supplier+'\x01'+r.productCode];
      if (up) {
        if (up.kind === 'better_cd') {
          parts.push('⚠ 手動紐付けより <b>CD一致（品番一致）</b> の方が確実です：「'+esc(up.betterMaker)+'」への切り替えを検討してください。');
        } else {
          parts.push('⚠ 手動紐付けより一致度の高い候補があります（'+up.betterScore+'%）：「'+esc(up.betterMaker)+'」');
        }
      }
    }
    const v = sel.value;
    if (v) {
      const cand = byValue[v]; const candName = cand ? cand.simName : v;
      const d = linkDecisiveDiff(baseName, candName);
      if (d.hasDiff) {
        const lines = [];
        if (d.onlyMaker.length) lines.push('メーカー側にだけ含まれる語: <b>'+d.onlyMaker.map(esc).join(' / ')+'</b>');
        if (d.onlySelf.length)  lines.push((mode==='self'?'自社品':'自社')+'側にだけ含まれる語: <b>'+d.onlySelf.map(esc).join(' / ')+'</b>');
        parts.push('⚠ 決定的な語（蓋・身・サイズ等）が違います。別の品の可能性があります。<br>'+lines.join('<br>'));
      }
    }
    if (!parts.length) { warn.style.display='none'; warn.innerHTML=''; return; }
    warn.innerHTML = parts.join('<br>');
    warn.style.display = 'block';
  }

  // 初期表示: 登録済み紐付けを表記ゆれ込みで選択（無ければ行のメーカー名→トップ候補）
  let initVal = '';
  if (cur) {
    const hit = scored.find((x) => linkEq(x.value, cur));
    initVal = hit ? hit.value : cur;
  } else if (mode === 'maker' && r.makerName) {
    const hit = scored.find((x) => linkEq(x.value, r.makerName));
    if (hit) initVal = hit.value;
  }
  if (!initVal) initVal = (scored[0] && scored[0].value) || '';
  // 「✏ 直す」で推奨候補を指定して開いたときは、それを選択済みにする（中身を見て保存するだけ）。
  if (preselect) {
    const hp = scored.find((x) => linkEq(x.value, preselect));
    initVal = hp ? hp.value : preselect;
  }
  renderOptions('');
  sel.value = initVal;
  if (sel.value !== initVal && initVal) {
    // value が完全一致しなければ option を1件足して選択可能に
    const o = document.createElement('option'); o.value = initVal; o.textContent = initVal; o.selected = true;
    sel.appendChild(o);
  }
  updateWarning();

  search.addEventListener('input', () => { renderOptions(search.value); updateWarning(); });
  sel.addEventListener('change', updateWarning);
  setTimeout(() => search.focus(), 30);

  const close = () => wrap.remove();
  $('#linkBack').addEventListener('click', close);
  $('#linkCancel').addEventListener('click', close);
  saveBtn.addEventListener('click', async () => {
    const v = sel.value;
    // self モードは「解除（空）」を選んでも紐付け先(自社CD)が無いので無意味＝メーカー品単独では消せない
    if (mode === 'self' && !v){ alert('紐付ける自社商品を選んでください（解除する紐付けはまだありません）'); return; }
    try {
      const res = await fetch('/api/product-link',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify(savePayload(v))}).then(x=>x.json());
      if (!res.ok){ alert('保存に失敗: '+(res.error||'')); return; }
      if (res.linkWarn){ alert('⚠ '+res.linkWarn); }
      close();
      const shogoHint = ' 照合結果に反映するには、表の左「↻ 照合」を押してください。';
      if (mode === 'self') {
        $('#msg').textContent='📌 紐付けを保存しました（'+v+' ⇔ '+(r.makerName||'')+'）。'+shogoHint;
      } else {
        const lbl = v ? ('「'+v+'」に固定') : '紐付けを解除（自動マッチへ）';
        $('#msg').textContent='📌 '+lbl+'しました。'+shogoHint;
      }
      if (res.productLinks && supplier) {
        const pl = res.productLinks[supplier];
        if (pl && typeof pl === 'object') currentLinks = pl;
      }
      // 保存できたことを表で即可視化：この行を「未照合の紐付け」にして橙バッジを出す（確定は↻照合後）。
      r._pendingLink = { value: v };
      refreshLinkCell(idx);
      const pend = baseRows.filter((x)=> x && x._pendingLink).length;
      if (pend) $('#msg').textContent += '（未照合の紐付け '+pend+' 件 → ↻照合で反映）';
      loadLinkCheck(); // 監査バナー・⚠マークを取り直す（直した分は消える）
    } catch (e) { alert('保存に失敗: '+e); }
  });
  // 🚫除外 / 💤休眠：どちらも「この自社品をこの仕入先の照合対象から外す」。マーク値とメッセージだけ違う（解除は別品選択/解除で可逆）。
  const setSkipMark = async (mark, label, icon) => {
    if (!confirm('自社品「'+(r.productCode||'')+'  '+(selfCore||'')+'」を\\n仕入先「'+supplier+'」の照合対象から '+label+'します。\\n\\n（別のメーカー品を選んで保存／先頭の「— 解除」で戻せます）\\n\\nよろしいですか？')) return;
    try {
      const res = await fetch('/api/product-link',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ supplier: supplier, productCode: r.productCode, makerName: mark })}).then(x=>x.json());
      if (!res.ok){ alert('保存に失敗: '+(res.error||'')); return; }
      close();
      $('#msg').textContent=icon+' 「'+(r.productCode||'')+'」を '+supplier+' の照合対象から'+label+'しました。照合結果に反映するには 表の左「↻ 照合」を押してください。';
      if (res.productLinks && supplier){ const pl=res.productLinks[supplier]; if (pl && typeof pl==='object') currentLinks=pl; }
      r._pendingLink = null; // 除外/休眠は currentLinks 由来の 🚫/💤 バッジで示す（橙の未照合バッジは消す）
      refreshLinkCell(idx);  // 🚫除外中 / 💤休眠 を照合前に即表示
      loadLinkCheck();
    } catch (e) { alert('保存に失敗: '+e); }
  };
  const exclBtn = $('#linkExclude');
  if (exclBtn) exclBtn.addEventListener('click', () => setSkipMark('__EXCLUDE__', '別物として除外', '🚫'));
  const dormBtn = $('#linkDormant');
  if (dormBtn) dormBtn.addEventListener('click', () => setSkipMark('__DORMANT__', '休眠（保留）扱いに', '💤'));
}

// 現在の画面値を集めてサーバへ → 計算結果のセルだけ更新
async function recalc(){
  if(dateFilter){ await loadByDate(dateFilter); return; } // 実施日フィルタ中は横断ビューを方針変更で取り直す
  if(allView){ await loadAll(); return; }                 // ★全部 表示中は全仕入先を方針変更で取り直す
  const s = settings();
  const rows = baseRows.map((_,i)=>{
    // 提出済みなどで非表示の行は入力欄が無い → 空で送る（サーバは rec の値で再計算）。
    const nc=$('.newcost[data-i="'+i+'"]'), rl=$('.rowrule[data-i="'+i+'"]');
    return { newCost: nc?nc.value:'', rule: rl?rl.value:'' };
  });
  const res = await fetch('/api/calc',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ file:$('#file').value, rule:s.rule, rounding:s.rounding, selfUplift:s.selfUplift, rows })}).then(x=>x.json());
  if(res.error){ $('#msg').textContent='エラー: '+res.error; return; }
  updateView(res.rows, res.summary);
}

function updateView(rows, sm, opts){
  opts = opts || {};
  let warnN=0, rateN=0;
  const warnIdx=[], rateIdx=[];
  rows.forEach((r,i)=>{
    const flags = rowWarnFlags(r);
    if(flags.warn){ warnN++; warnIdx.push(i); }
    else if(flags.rate){ rateN++; rateIdx.push(i); }
    if(opts.skipMetrics) return;
    setAmtRate('ci'+i, r.costIncrease, rateOf(r.currentCost, r.newCost)); // 仕入値上額＋改定%
    // 改定後仕入単価セルの色分け：赤＝メーカーデータ疑わしい/重複（出力時に除外）、黄＝値上率が大きい（注意のみ）
    const nc = newCostCellHtml(r);
    const ncEl=$('#nc'+i);
    if(ncEl){
      ncEl.className = nc.cls;
      const red=r.priceWarning||r.costConflict||'';
      if(red) ncEl.title='⚠ '+red;
      else if(r.rateWarning) ncEl.title='注意: '+r.rateWarning;
      else ncEl.title='';
      ncEl.innerHTML = nc.content;
    }
    const q = $('#qt'+i);
    if(q) q.innerHTML = qtyCellHtml(r);
    const aci = $('#aci'+i);
    if(aci){ aci.innerHTML = yen(r.annualCostImpact); aci.className = 'r '+signCls(r.annualCostImpact); }
  });
  const pa=$('#priceAlert');
  if(pa){
    if(warnN>0){ pa.style.display='block'; pa.innerHTML='⚠ メーカー側データが疑わしい行が '+warnN+' 件あります（赤い「改定後 仕入単価」セル＝売単価0/値下げ/同一商品で新仕入が食い違い）。見積書出力時は自動で「要確認」に分離されます。<span class="jumphint">▶ クリックで該当行へ</span>'; bindJump(pa, warnIdx); }
    else pa.style.display='none';
  }
  const ra=$('#rateAlert');
  if(ra){
    if(rateN>0){ ra.style.display='block'; ra.innerHTML='▲ 値上率が大きい行が '+rateN+' 件あります（黄色い「改定後 仕入単価」セル）。メーカーの値上げ幅が正しいか確認してください。※これは注意のみで、見積書には通常どおり載ります。<span class="jumphint">▶ クリックで該当行へ</span>'; bindJump(ra, rateIdx); }
    else ra.style.display='none';
  }
  renderCards(sm);
  lastSummary = sm;
  renderPL();
}
function setCell(id, text, cls){ const el=$('#'+id); if(!el) return; el.textContent=text; el.className = el.className.replace(/\\b(pos|neg)\\b/g,'').trim(); if(cls) el.classList.add(cls); }
// 現→改定の改定率(%)。現単価>0 のときだけ算出（0や未設定は—）。
function rateOf(cur, neu){ return (Number.isFinite(cur) && cur>0 && Number.isFinite(neu)) ? (neu/cur-1)*100 : NaN; }
// 値上額(amt)＋その下に改定%(rate) を1セルに表示。値上げ=赤/値下げ=青。
function setAmtRate(id, amt, rate){
  const el=$('#'+id); if(!el) return;
  el.className = el.className.replace(/\\b(pos|neg)\\b/g,'').trim();
  let html = '<span class="'+signCls(amt)+'">'+num(amt)+'</span>';
  if(Number.isFinite(rate)){
    const rc = rate>0.05 ? 'pos' : (rate<-0.05 ? 'neg' : 'flat');
    html += '<span class="ratetag '+rc+'">'+(rate>0?'+':'')+rate.toFixed(1)+'%</span>';
  }
  el.innerHTML = html;
}
// バナーをクリックすると該当行へ順番にスクロール＆点滅ハイライトする
function bindJump(banner, idxArr){
  banner._idx = idxArr; banner._pos = 0;
  banner.style.cursor = idxArr.length ? 'pointer' : 'default';
  banner.onclick = function(){
    const arr = banner._idx || [];
    if(!arr.length) return;
    const i = arr[banner._pos % arr.length];
    banner._pos++;
    const tr = $('#row'+i);
    if(!tr) return;
    tr.scrollIntoView({behavior:'smooth', block:'center'});
    tr.classList.remove('flashrow');
    void tr.offsetWidth; // reflow を強制して再アニメーション
    tr.classList.add('flashrow');
  };
}

function renderCards(sm){
  const net = sm.net;
  $('#cards').innerHTML =
    card('対象明細', sm.count+'件', '<small>数量あり '+sm.withQty+'件'+(sm.estimated?'（推定 '+sm.estimated+'）':'')+'</small>')+
    card('年間 仕入増（メーカーへ）', yen(sm.totalCostImpact), '', 'neg')+
    card('年間 増収（得意先から）', yen(sm.totalSellImpact), '', 'pos')+
    card('差引 粗利インパクト', yen(net), '<small>増収 − 仕入増</small>', net>=0?'pos':'neg')+
    card('平均 粗利率', pct(sm.avgCurMargin)+' → '+pct(sm.avgNewMargin), '');
}
function card(k,v,sub,cls){ return '<div class="card"><div class="k">'+k+'</div><div class="v '+(cls||'')+'">'+v+(sub||'')+'</div></div>'; }

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
// confirm() 用：ユーザー/業務データを文字列連結するとき、クォート・バックスラッシュ・改行文字でJSが壊れるのを防ぐ（配信JS内のテンプレリテラルなので、バックスラッシュ記法はコメントでも書かない）
function escConfirm(s){ return String(s==null?'':s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/\\r/g,'').replace(/\\n/g,'\\\\n'); }
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

// ---- 全社損益インパクト（変動損益）-------------------------------------
const fmtU = (v) => Number.isFinite(v) ? v.toLocaleString('ja-JP',{maximumFractionDigits:1}) : '—';

async function fetchPL(){
  const r = await fetch('/api/pl').then(x=>x.json()).catch(()=>({source:'error'}));
  const src = $('#plSrc');
  if(r.source==='file'){
    if(Number.isFinite(r.sales))    $('#plSales').value = r.sales;
    if(Number.isFinite(r.variable)) $('#plVar').value   = r.variable;
    if(Number.isFinite(r.fixed))    $('#plFixed').value = r.fixed;
    src.textContent = '損益.csv から読込しました（金額は右の「単位」で扱います）';
  } else if(r.source==='none'){
    src.textContent = '損益.csv は未配置です。数値を手入力するか、プロジェクト直下に 損益.csv を置いてください。';
  } else {
    src.textContent = '損益.csv の読込に失敗: ' + (r.error||'');
  }
  renderPL();
}

// 全仕入先の最新照合結果を、現在の全体方針(ルール/端数/自社上乗せ%)で合算する。
//  損益パネルは「全社」を見るためのものなので、選択中の1ファイルではなく全商品で算出する。
async function loadAllImpact(){
  const s = settings();
  const scopeEl = $('#plScope');
  if(scopeEl && !allImpact) scopeEl.textContent = '（全仕入先の合算を計算中…）';
  try{
    const r = await fetch('/api/impact-all',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ rule:s.rule, rounding:s.rounding, selfUplift:s.selfUplift })}).then(x=>x.json());
    if(r && !r.error){ allImpact = r; renderPL(); }
  }catch(e){ /* 失敗時は選択中ファイルの集計にフォールバック（renderPL内で対応） */ }
}

function renderPL(){
  const f = parseFloat($('#plUnit').value)||1;
  const toYen = (id)=>{ const v=parseFloat($(id).value); return (Number.isFinite(v)?v:0)*f; };
  const S=toYen('#plSales'), V=toYen('#plVar'), F=toYen('#plFixed'), Fadd=toYen('#plSelfCost');
  // 実施日フィルタ中は「その日の改定だけ」の集計。通常は全仕入先 合算を優先（無ければ暫定）。
  const agg = dateFilter ? lastSummary : (allImpact || lastSummary);
  const dC = agg && Number.isFinite(agg.totalCostImpact) ? agg.totalCostImpact : 0; // 年間 仕入増
  const dS = agg && Number.isFinite(agg.totalSellImpact) ? agg.totalSellImpact : 0; // 年間 増収
  const scopeEl = $('#plScope');
  if(scopeEl){
    if(dateFilter) scopeEl.textContent = '＝実施日 '+dateFilter+' の改定のみ（'+((agg&&agg.count)||0)+'件・数量あり '+((agg&&agg.withQty)||0)+'）：年間 仕入増 '+yen(dC)+' ／ 増収 '+yen(dS);
    else if(allImpact) scopeEl.textContent = '＝全 '+allImpact.supplierCount+' 仕入先・数量あり '+allImpact.withQty+' 明細を合算（年間 仕入増 '+yen(dC)+' ／ 増収 '+yen(dS)+'）';
    else scopeEl.textContent = '（表示中の照合結果のみで暫定表示。全仕入先の合算を計算中…）';
  }

  // 自社コスト増(固定費)は転嫁有無に関わらず増える → 転嫁しない/転嫁する の両方に加算
  const scen = (s,v,fx,fadd)=>{ const fixed=fx+(fadd||0); const cm=s-v; return { s, v, cm, fx:fixed, op:cm-fixed }; };
  const cols = [ scen(S,V,F,0), scen(S,V+dC,F,Fadd), scen(S+dS,V+dC,F,Fadd) ]; // 現状 / 転嫁しない / 転嫁する
  const now = cols[0];

  const dv = (yen)=> fmtU(yen/f);
  const rate = (part,s)=> s>0 ? part/s*100 : NaN;
  const dlt = (val,base)=>{ const d=val-base; if(Math.abs(d)<1e-9) return ' <span class="d hint">±0</span>'; return ' <span class="d '+(d>0?"pos":"neg")+'">('+(d>0?"+":"")+fmtU(d/f)+')</span>'; };

  const valRow = (label,key,withDelta,op)=>{
    const cells = cols.map((c,i)=>'<td class="r">'+dv(c[key])+((withDelta&&i>0)?dlt(c[key],now[key]):'')+'</td>').join('');
    return '<tr'+(op?' class="op"':'')+'><td>'+label+'</td>'+cells+'</tr>';
  };
  const rateRow = (label,key)=>{
    const cells = cols.map(c=>{ const v=rate(c[key],c.s); return '<td class="r">'+(Number.isFinite(v)?v.toFixed(1)+'%':'—')+'</td>'; }).join('');
    return '<tr><td>'+label+'</td>'+cells+'</tr>';
  };
  $('#plBody').innerHTML =
    valRow('純売上高','s',true,false)+
    valRow('変動費合計','v',true,false)+
    valRow('限界利益','cm',true,false)+
    rateRow('限界利益率','cm')+
    valRow('固定費合計','fx',true,false)+
    valRow('営業利益','op',true,true)+
    rateRow('営業利益率','op');
}

// 全体方針(ルール/端数/自社上乗せ%)を変えたら、選択中ファイルの再計算に加えて
//  全仕入先 合算の損益も取り直す（損益パネルが全商品を反映するように）。
function recalcAll(){ if(dateFilter){ loadByDate(dateFilter); return; } recalc(); loadAllImpact(); }
$('#file').addEventListener('change', ()=>{
  try{ sessionStorage.setItem('simFileSel', $('#file').value); }catch(e){}
  loadFile(); // ファイル切替は表示の切替だけ＝損益(全社)は不変
});
$('#shogoBtn').addEventListener('click', runShogo);
// 紐付け✏ボタンはイベント委譲で処理（#tbody に1個だけ）。行を作り直しても貼り直し不要・行数に依存しない。
$('#tbody').addEventListener('click', (e)=>{ const b=e.target.closest && e.target.closest('.linkBtn'); if(b) openLinkModal(Number(b.dataset.i)); });
// 全体方針（転嫁ルール・端数・自社上乗せ%）はメイン画面から撤去し ⚙設定 に集約。
//  設定で保存すると applyToBar が savedPolicy を更新し、表示・損益にも反映される（setSave 内で再計算）。
// 見積書の作成はメイン画面では行わない（得意先別ページに集約）。#toCustomersBtn は /customers への通常リンク。
// 補助スクロールバー（上）と表本体（下）の左右位置を連動させる
(function(){
  const hbar=$('#hbar'), wrap=$('#wrap');
  if(!hbar||!wrap) return;
  let lock=false;
  hbar.addEventListener('scroll', ()=>{ if(lock) return; lock=true; wrap.scrollLeft=hbar.scrollLeft; lock=false; });
  wrap.addEventListener('scroll', ()=>{ if(lock) return; lock=true; hbar.scrollLeft=wrap.scrollLeft; lock=false; });
  window.addEventListener('resize', ()=> syncHScroll());
})();

// 見積書出力後のサマリ表示。フォルダ/要確認.xlsx を画面から直接開けるボタン付き。
$('#plUnit').addEventListener('change', renderPL);
['#plSales','#plVar','#plFixed','#plSelfCost'].forEach(s=> $(s).addEventListener('input', debounce(renderPL,150)));

// ---- 設定（初回登録）----------------------------------------------------
const setEl = (id)=>document.getElementById(id);
function fillSettings(s){
  const c=s.company||{}, q=s.quote||{}, rd=s.rounding||{}, df=s.default||{}, su=s.selfCostUplift||{};
  setEl('cName').value=c.name||''; setEl('cPostal').value=c.postal||''; setEl('cAddr').value=c.address||'';
  setEl('cTel').value=c.tel||''; setEl('cFax').value=c.fax||'';
  setEl('qTitle').value=q.title||''; setEl('qGreeting').value=q.greeting||''; setEl('qFooter').value=q.footer||'';
  setEl('qMailSubject').value=q.mailSubject||''; setEl('qMailBody').value=q.mailBody||'';
  setEl('sRule').value=df.type||'add_increase'; setEl('sFactor').value=df.factor||1.25;
  setEl('sUnit').value=String(rd.unit||0.01); setEl('sMode').value=rd.mode||'round';
  setEl('sUplift').value=Number(su.rate)||0;
  setEl('sThreshold').value=(s.matchThreshold!=null?s.matchThreshold:80);
  setEl('sFactorBox').style.display = setEl('sRule').value==='markup'?'flex':'none';
}
function collectSettings(){
  return {
    company:{ name:setEl('cName').value.trim(), postal:setEl('cPostal').value.trim(), address:setEl('cAddr').value.trim(), tel:setEl('cTel').value.trim(), fax:setEl('cFax').value.trim() },
    quote:{ title:setEl('qTitle').value, greeting:setEl('qGreeting').value, footer:setEl('qFooter').value, mailSubject:setEl('qMailSubject').value, mailBody:setEl('qMailBody').value },
    default:{ type:setEl('sRule').value, factor:parseFloat(setEl('sFactor').value)||1 },
    rounding:{ unit:parseFloat(setEl('sUnit').value)||0.01, mode:setEl('sMode').value },
    selfCostUplift:{ rate:parseFloat(setEl('sUplift').value)||0 },
    matchThreshold:(parseFloat(setEl('sThreshold').value)>=0 ? parseFloat(setEl('sThreshold').value) : 80),
  };
}
// 画面上部のバーの初期値を、保存済み設定に合わせる
// 保存済み設定を「全体方針」として取り込む（メインの方針バーは撤去したので DOM ではなく savedPolicy へ）。
function applyToBar(s){
  const df=s.default||{}, rd=s.rounding||{}, su=s.selfCostUplift||{};
  savedPolicy = {
    rule: { type: df.type||'add_increase', factor: Number(df.factor)||1.25 },
    rounding: { unit: Number(rd.unit)||0.01, mode: rd.mode||'round' },
    selfUplift: Number(su.rate)||0,
  };
}
function openSettings(){ setEl('settingsOverlay').classList.add('show'); }
function closeSettings(){ setEl('settingsOverlay').classList.remove('show'); }

async function initSettings(){
  const r = await fetch('/api/settings').then(x=>x.json()).catch(()=>null);
  if(!r) return;
  fillSettings(r.settings);
  applyToBar(r.settings);
  if(!r.configured){ setEl('welcomeMsg').classList.add('show'); openSettings(); }
}
setEl('settingsBtn').addEventListener('click', async ()=>{
  const r = await fetch('/api/settings').then(x=>x.json()).catch(()=>null);
  if(r) fillSettings(r.settings);
  setEl('welcomeMsg').classList.remove('show');
  openSettings();
});
setEl('setCancel').addEventListener('click', closeSettings);
setEl('sRule').addEventListener('change', ()=>{ setEl('sFactorBox').style.display = setEl('sRule').value==='markup'?'flex':'none'; });
setEl('setSave').addEventListener('click', async ()=>{
  const patch = collectSettings();
  if(!patch.company.name){ setEl('setMsg').style.color='#c0392b'; setEl('setMsg').textContent='会社名を入力してください'; return; }
  const btn=setEl('setSave'); btn.disabled=true; setEl('setMsg').style.color='#6b7785'; setEl('setMsg').textContent='保存中…';
  try{
    const res = await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)}).then(x=>x.json());
    if(res && res.ok){
      applyToBar(res.settings); // savedPolicy を更新（メインの方針バーは撤去済み）
      setEl('setMsg').style.color='#2e7d32'; setEl('setMsg').textContent='✓ 保存しました';
      // 全体方針が変わった可能性 → 表示中の表と 全社損益を新方針で取り直す
      setTimeout(()=>{ closeSettings(); if(baseRows.length) recalc(); loadAllImpact(); }, 600);
    } else { setEl('setMsg').style.color='#c0392b'; setEl('setMsg').textContent='保存に失敗しました'; }
  }catch(e){ setEl('setMsg').style.color='#c0392b'; setEl('setMsg').textContent='保存に失敗: '+e; }
  finally{ btn.disabled=false; }
});

// ===== 実施日カレンダー（全仕入先 横断）===================================
// /api/calendar が input/ の全仕入先CSVを集計して返す明細を、実施日ごとに
// 月カレンダーで一覧する。本日が実施日の日は赤強調。月替わりにデータ更新も促す。
const calState = { year: 0, month: 0, selKey: '' }; // month は 0始まり
let calData = { entries: [], suppliers: [], hanbai: {}, pl: {} }; // /api/calendar の結果

// Excelシリアル(日数) → {y,m,d}。基準は 1899-12-30（Excelの仕様）。
function excelSerialToYMD(n){
  const ms = Date.UTC(1899,11,30) + n*86400000;
  const d = new Date(ms);
  return { y:d.getUTCFullYear(), m:d.getUTCMonth()+1, d:d.getUTCDate() };
}
// 実施日テキスト（"2026-06-01" / "2026年7月1日" / "7月1日～" / Excelシリアル"46133"）を {y,m,d} に。
function parseEffDate(raw){
  const s = String(raw==null?'':raw).trim();
  if(!s) return null;
  // Excelシリアル（数字のみ・妥当範囲）
  if(/^\\d{4,6}$/.test(s)){ const n=Number(s); if(n>=20000 && n<=90000) return excelSerialToYMD(n); }
  // 年つき（2026-06-01 / 2026/6/1 / 2026年6月1日）
  let m = s.match(/(\\d{4})\\D+(\\d{1,2})\\D+(\\d{1,2})/);
  if(m) return { y:Number(m[1]), m:Number(m[2]), d:Number(m[3]) };
  // 年なし（6月1日 / 6/1）→ 今年を補う
  m = s.match(/(\\d{1,2})\\D+(\\d{1,2})\\s*日?/) || s.match(/(\\d{1,2})月(\\d{1,2})/);
  if(m){ const y=new Date().getFullYear(); const mo=Number(m[1]), da=Number(m[2]); if(mo>=1&&mo<=12&&da>=1&&da<=31) return { y, m:mo, d:da }; }
  return null;
}
const pad2 = (n)=> String(n).padStart(2,'0');
const ymdKey = (o)=> o ? (o.y+'-'+pad2(o.m)+'-'+pad2(o.d)) : '';
const todayKeyStr = ()=>{ const n=new Date(); return n.getFullYear()+'-'+pad2(n.getMonth()+1)+'-'+pad2(n.getDate()); };

// カレンダー明細の提出状況を集計（issued / hold / manual / todo）。
function calStatusCounts(list){
  const c={ issued:0, hold:0, manual:0, todo:0 };
  (list||[]).forEach(it=>{
    if(it.itemStatus==='issued') c.issued++;
    else if(it.itemStatus==='hold') c.hold++;
    else if(it.itemStatus==='manual') c.manual++;
    else c.todo++;
  });
  return c;
}
// チップ・グリッド用の提出済／未提出バッジHTML。
function calStatusBadgesHtml(c, inline){
  if(!c) return '';
  const parts=[];
  if(c.issued) parts.push('<span class="cnt-issued">✅'+c.issued+'</span>');
  const todo=c.todo+(c.hold||0)+(c.manual||0);
  if(todo) parts.push('<span class="cnt-todo">⬜'+todo+'</span>');
  if(!parts.length) return '';
  return inline ? parts.join(' ') : '<div class="cnts">'+parts.join('')+'</div>';
}
// カレンダー詳細パネル用の明細表HTML（提出済／未提出で2ブロック）。
function calDetailSplitHtml(list){
  const issued=[], todo=[];
  (list||[]).forEach(it=>{ (it.itemStatus==='issued'?issued:todo).push(it); });
  const col=new Intl.Collator('ja');
  const sort=(a,b)=> col.compare(a.supplier,b.supplier)||col.compare(a.customer,b.customer)||col.compare(a.name,b.name);
  issued.sort(sort); todo.sort(sort);
  const row=(it)=> '<tr><td>'+esc(it.supplier||'—')+'</td><td>'+esc(it.customer)+'</td><td>'+esc(it.name)+'</td></tr>';
  const tbl=(rows)=> rows.length
    ? '<table><thead><tr><th style="width:18%">仕入先</th><th style="width:28%">得意先</th><th>商品名</th></tr></thead><tbody>'+rows.map(row).join('')+'</tbody></table>'
    : '<div class="emptysec">（該当なし）</div>';
  let html='';
  html+='<div class="calsec issued"><h3>✅ 提出済み '+issued.length+'件</h3>'+tbl(issued)+'</div>';
  const holdN=todo.filter(it=>it.itemStatus==='hold').length;
  const manualN=todo.filter(it=>it.itemStatus==='manual').length;
  let todoH='⬜ 未提出 '+todo.length+'件';
  if(holdN) todoH+='（うち検討中 '+holdN+'件）';
  if(manualN) todoH+='（うち手動修正 '+manualN+'件）';
  html+='<div class="calsec todo"><h3>'+esc(todoH)+'</h3>'+tbl(todo)+'</div>';
  return html;
}

// 全仕入先 横断の明細(calData.entries) から「実施日キー → 明細[]」を作る。
// 日付が読めない/空の行は noDate にまとめる（実施日 未設定＝要入力の気づき）。
function buildEffIndex(){
  const byKey = new Map();   // 'YYYY-MM-DD' -> [{customer, name, supplier, itemStatus}]
  const noDate = [];
  (calData.entries||[]).forEach(e=>{
    const item = { customer: e.customer||'—', name: e.product||'(商品名なし)', supplier: e.supplier||'', itemStatus: e.itemStatus||'' };
    const o = parseEffDate(e.date);
    if(!o){ noDate.push(item); return; }
    const k = ymdKey(o);
    if(!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(item);
  });
  return { byKey, noDate };
}

// 常時表示パネルへデータを読み込んで描画（ページ表示時に1回呼ぶ）。
async function loadCalendar(){
  const btn=$('#calBtn'); const orig=btn?btn.textContent:''; if(btn){ btn.disabled=true; btn.textContent='📅 集計中…'; }
  try{
    const res = await fetch('/api/calendar').then(x=>x.json());
    calData = (res && res.ok) ? res : { entries:[], suppliers:[], hanbai:{}, pl:{} };
  }catch(e){ calData = { entries:[], suppliers:[], hanbai:{}, pl:{} }; }
  finally{ if(btn){ btn.disabled=false; btn.textContent=orig; } }
  const idx = buildEffIndex();
  const keys = Array.from(idx.byKey.keys()).sort();
  const tk = todayKeyStr();
  // 既定の表示月＝本日に実施日があればその月。無ければ最も早い実施月。それも無ければ今月。
  let y, mo, sel;
  if(idx.byKey.has(tk)){ const p=tk.split('-'); y=Number(p[0]); mo=Number(p[1])-1; sel=tk; }
  else if(keys.length){ const p=keys[0].split('-'); y=Number(p[0]); mo=Number(p[1])-1; sel=keys[0]; }
  else { const now=new Date(); y=now.getFullYear(); mo=now.getMonth(); sel=''; }
  calState.year=y; calState.month=mo; calState.selKey=sel;
  renderCalendar();
}
// パネルの折りたたみ。force 省略でトグル。状態は localStorage に記憶。
function setCalCollapsed(collapsed){
  const panel=$('#calPanel'), body=$('#calBody'), tog=$('#calToggle');
  if(!panel||!body) return;
  panel.classList.toggle('collapsed', collapsed);
  body.classList.toggle('collapsed', collapsed);
  if(tog) tog.textContent = collapsed ? '▼ 開く' : '▲ 畳む';
  renderTodayBanner(); // 畳む/開くで当日バナーの文言（▼開いて確認 ⇔ 操作ヒント）を更新
  try{ localStorage.setItem('calCollapsed', collapsed?'1':'0'); }catch(_){}
}
function toggleCalPanel(){
  const collapsed = $('#calBody') && $('#calBody').classList.contains('collapsed');
  setCalCollapsed(!collapsed);
  // ヘッダーボタンから開いたときはパネルが見えるよう先頭へスクロール
  if(collapsed){ const p=$('#calPanel'); if(p) p.scrollIntoView({behavior:'smooth',block:'start'}); }
}
function calShift(delta){
  let m = calState.month + delta, y = calState.year;
  while(m<0){ m+=12; y--; } while(m>11){ m-=12; y++; }
  calState.year=y; calState.month=m; renderCalendar();
}

// 月替わりの更新喚起バナー：販売実績ファイル・損益.csv が「今月」のものか確認を促す。
function renderReminder(){
  const box=$('#calReminder'); const now=new Date();
  const curYm = now.getFullYear()+'-'+pad2(now.getMonth()+1);
  function part(label, info, hint){
    if(!info || !info.exists) return { warn:true, html:'<span class="ritem"><span class="rtag x">未配置</span><b>'+label+'</b>：'+hint+'</span>' };
    const fresh = info.ym === curYm; // 今月更新済みか
    const md = info.mtime ? info.mtime.slice(0,10) : '';
    const tag = fresh ? '<span class="rtag g">今月更新済</span>' : '<span class="rtag w">要更新</span>';
    const msg = fresh ? '' : '（先月以前のままです。今月の最新に更新しましょう）';
    return { warn:!fresh, html:'<span class="ritem">'+tag+'<b>'+label+'</b>：最終更新 '+esc(md)+esc(msg)+'</span>' };
  }
  // 販売実績：DB直結(db/auto)なら「常に最新」＝ファイルの更新喚起は出さない（DBが本番ソース）。
  //  source='file' の時だけ従来どおりファイルの新しさを確認する。
  const src = (calData.hanbaiSource || 'file');
  // 閲覧モード（このPCはDB未接続）：照合・DB抽出はできず表示専用。↻照合ボタンを無効化する。
  const sb = $('#shogoBtn');
  if (sb) {
    if (calData.viewOnly) { sb.disabled = true; sb.style.opacity = '0.4'; sb.title = '🔒 閲覧モード：このPCはDBに接続できないため照合できません。照合はDBのある会社PCで。'; }
    else { sb.disabled = false; sb.style.opacity = ''; }
  }
  let a;
  if (calData.viewOnly) {
    a = { warn:true, html:'<span class="ritem"><span class="rtag w">🔒 閲覧モード</span><b>販売実績</b>：このPCはDBに接続できません。<b>表示専用</b>です（照合・DB抽出・自社品検索は会社PCで。結果はDrive同期で届きます）。</span>' };
  } else if (src === 'db' || src === 'auto') {
    const note = src === 'auto'
      ? '販売大臣DBから直接取得（常に最新／手動更新は不要）。DBが無いPCのみ販売実績ファイルを使用します。'
      : '販売大臣DBから直接取得（常に最新／手動更新は不要）。';
    a = { warn:false, html:'<span class="ritem"><span class="rtag g">DB直結</span><b>販売実績</b>：'+esc(note)+'</span>' };
  } else {
    a = part('販売実績ファイル', calData.hanbai, '「⚙ 自社データ設定」で場所を指定してください。');
  }
  const b = part('損益.csv', calData.pl, 'プロジェクト直下に置いてください。');
  const anyWarn = a.warn || b.warn;
  box.innerHTML = '<div class="rbnr '+(anyWarn?'warn':'ok')+'">'+
    '<span style="font-weight:800">'+(anyWarn?'🔔 月替わり時はデータ更新の確認を':'✓ 今月のデータは最新です')+'</span>'+
    a.html + b.html +
    (anyWarn?'<a class="rgo" href="/self" target="_blank">自社データ設定を開く</a>':'')+'</div>';
}

// 本日が実施日のとき、カレンダーを畳んでいても見える赤バナーを出す。
//  畳んでいるときは「▼ 開いて確認する」を、開いているときは操作ヒントを併記（クリックでその日の改定を表示）。
//  renderCalendar からも、畳む/開くの切替(setCalCollapsed)からも呼ばれ、状態に合わせて文言が変わる。
function renderTodayBanner(idx){
  const tb=$('#calTodayBanner'); if(!tb) return;
  idx = idx || buildEffIndex();
  const todayKey=todayKeyStr();
  const todayList = idx.byKey.get(todayKey);
  if(!(todayList && todayList.length)){ tb.innerHTML=''; return; }
  const p=todayKey.split('-');
  const sc=calStatusCounts(todayList);
  const scTxt='（✅提出済 '+sc.issued+' / ⬜未提出 '+(sc.todo+sc.hold+sc.manual)+'）';
  const collapsed = $('#calBody') && $('#calBody').classList.contains('collapsed');
  const cta = collapsed
    ? '<span class="tbtn">▼ カレンダーを開いて確認する</span>'
    : '<span class="thint">クリックでその日の改定を表で表示（カレンダーは赤で強調）</span>';
  tb.innerHTML='<div class="tbnr" title="クリックすると本日の改定を表示します">'
    +'🔔 <span>本日 '+Number(p[1])+'/'+Number(p[2])+' が実施日の商品が <b>'+todayList.length+'件</b>'+esc(scTxt)+' あります。基幹システムへの取込・見積提出のタイミングです。</span>'
    +cta+'</div>';
}

function renderCalendar(){
  const idx = buildEffIndex();
  const y=calState.year, mo=calState.month;
  const MON=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  $('#calMonth').textContent = y+'年 '+MON[mo];
  renderReminder();

  const todayKey = todayKeyStr();
  // 本日が実施日かのバナー（畳んでいても見える＝開いて確認を促す。state-aware で文言を出し分け）
  renderTodayBanner(idx);

  // 実施日チップ（全期間・件数つき）＝よく使う 06/01 等にワンタップ移動。本日は🔔赤で強調
  const keys = Array.from(idx.byKey.keys()).sort();
  let chips = keys.map(k=>{
    const p=k.split('-'); const list=idx.byKey.get(k);
    const n=list.length; const badges=calStatusBadgesHtml(calStatusCounts(list), true);
    const isT = (k===todayKey) ? ' style="border-color:#e0392c;color:#a01b10;font-weight:800"' : '';
    return '<span class="chip" data-key="'+k+'"'+isT+'>'+(k===todayKey?'🔔 ':'')+Number(p[1])+'/'+Number(p[2])+' <b>'+n+'件</b> '+badges+'</span>';
  }).join('');
  if(idx.noDate.length) chips += '<span class="chip empty" data-key="__none">実施日 未設定 '+idx.noDate.length+'件</span>';
  $('#calChips').innerHTML = chips || '<span class="chip empty">価格改定行がありません（input/ に照合結果CSVがありません）</span>';

  // 月グリッド
  const DOW=['日','月','火','水','木','金','土'];
  const first=new Date(y,mo,1).getDay();
  const days=new Date(y,mo+1,0).getDate();
  let html='';
  DOW.forEach((d,i)=> html+='<div class="dow'+(i===0?' sun':(i===6?' sat':''))+'">'+d+'</div>');
  for(let b=0;b<first;b++) html+='<div class="calcell blank"></div>';
  for(let day=1;day<=days;day++){
    const k=y+'-'+pad2(mo+1)+'-'+pad2(day);
    const list=idx.byKey.get(k);
    const dow=new Date(y,mo,day).getDay();
    const cls=['calcell'];
    if(dow===0) cls.push('sun'); if(dow===6) cls.push('sat');
    if(list) cls.push('has'); if(k===calState.selKey) cls.push('sel'); if(k===todayKey) cls.push('today');
    const badges = list ? calStatusBadgesHtml(calStatusCounts(list), false) : '';
    html+='<div class="'+cls.join(' ')+'" data-key="'+k+'">'+
      '<div class="dn">'+day+'</div>'+
      badges+'</div>';
  }
  $('#calGrid').innerHTML=html;
  // グリッドのクリック（実施日のある日だけ）
  $('#calGrid').querySelectorAll('.calcell.has').forEach(el=>
    el.addEventListener('click', ()=>{ calState.selKey=el.dataset.key; renderCalendar(); }));
  renderCalDetail(idx);
}

function renderCalDetail(idx){
  const k=calState.selKey;
  const box=$('#calDetail');
  const tk=todayKeyStr();
  if(k==='__none'){
    // 実施日が無い行は日付で絞り込めないので、従来どおりの一覧をここに出す。
    const list=idx.noDate;
    if(!list.length){ box.innerHTML=''; return; }
    const sorted=list.slice().sort((a,b)=> (a.supplier+a.customer+a.name).localeCompare(b.supplier+b.customer+b.name,'ja'));
    const rows=sorted.map(it=> '<tr><td>'+esc(it.supplier||'—')+'</td><td>'+esc(it.customer)+'</td><td>'+esc(it.name)+'</td></tr>').join('');
    box.innerHTML='<h3>'+esc('実施日 未設定（'+list.length+'件）— メーカー見積に実施日が無い行です')+'</h3>'+
      '<table><thead><tr><th style="width:20%">仕入先</th><th style="width:30%">得意先</th><th>商品名</th></tr></thead><tbody>'+rows+'</tbody></table>';
    return;
  }
  if(!k){ box.innerHTML='<div class="empty">日付（色つきの日）をクリックすると、その日に実施する改定が <b>下のシミュレーション表</b> に出ます。</div>'; return; }
  // 日付が選ばれたら、メインのシミュレーション表に「その日の改定（全仕入先・読み取り）」を表示する。
  const list = idx.byKey.get(k)||[];
  const p=k.split('-');
  const label=Number(p[0])+'年'+Number(p[1])+'月'+Number(p[2])+'日';
  const supN=(calData.suppliers && calData.suppliers.length)||0;
  const sc=calStatusCounts(list);
  box.innerHTML='<div class="calnote">▼ <b>下のシミュレーション表</b>に '+(k===tk?'🔔 本日 ':'')+esc(label)+' の改定（'+list.length+'件・全'+supN+'仕入先'
    +' ｜ ✅提出済 '+sc.issued+' / ⬜未提出 '+(sc.todo+sc.hold+sc.manual)+'）を <b>提出済み・未提出で分けて</b>表示しました。</div>'
    +calDetailSplitHtml(list);
  if(dateFilter!==k) loadByDate(k, label); // 既に同じ日を表示中なら再取得しない（月送り等での無駄打ち防止）
}

// 実施日フィルタの解除：通常表示（選択中ファイル）に戻し、全社損益を取り直す。カレンダーの選択も外す。
$('#dateFilterClear').addEventListener('click', ()=>{
  calState.selKey=null;
  loadFile();          // clearDateFilter を内包＝バナーも消える。選択中ファイルを編集可能で再描画。
  loadAllImpact();     // 損益パネルを全社合算へ戻す
  renderCalendar();    // カレンダーの選択ハイライト/注記をクリア
});
// カレンダーの操作配線（常時表示パネル）
$('#calBtn').addEventListener('click', toggleCalPanel);
$('#exclBtn').addEventListener('click', openExcludeModal);
$('#calToggle').addEventListener('click', toggleCalPanel);
// 当日バナーをクリック＝畳んでいれば開き、本日の改定をその場で表示（カレンダーへスクロール）
$('#calTodayBanner').addEventListener('click', (e)=>{
  if(!e.target.closest('.tbnr')) return; // バナーが無い（本日が実施日でない）ときは何もしない
  if($('#calBody') && $('#calBody').classList.contains('collapsed')) setCalCollapsed(false);
  calState.selKey = todayKeyStr();
  const n=new Date(); calState.year=n.getFullYear(); calState.month=n.getMonth(); // 本日の月へ移動
  renderCalendar();
  const p=$('#calPanel'); if(p) p.scrollIntoView({behavior:'smooth',block:'start'});
});
$('#calPrev').addEventListener('click', ()=> calShift(-1));
$('#calNext').addEventListener('click', ()=> calShift(1));
$('#calToday').addEventListener('click', ()=>{ const n=new Date(); calState.year=n.getFullYear(); calState.month=n.getMonth(); renderCalendar(); });
$('#calChips').addEventListener('click', (e)=>{
  const chip=e.target.closest('.chip'); if(!chip||!chip.dataset.key) return;
  const k=chip.dataset.key; calState.selKey=k;
  if(k!=='__none'){ const p=k.split('-'); calState.year=Number(p[0]); calState.month=Number(p[1])-1; }
  renderCalendar();
});
// 起動時：前回の折りたたみ状態を復元し、カレンダーを読み込んで常時表示する。
(function initCalendarPanel(){
  try{ if(localStorage.getItem('calCollapsed')==='1') setCalCollapsed(true); }catch(_){}
  loadCalendar();
})();
// 実施日が来た改定を 基幹システム（販売大臣）へ取込：2つのCSVダウンロード（カレンダー内）。
(function initCalExport(){
  const p=n=>String(n).padStart(2,'0');
  const today=()=>{const d=new Date();return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());};
  const cc=$('#calCutoff'); if(cc&&!cc.value) cc.value=today();
  const m=()=>$('#calExpMsg');
  const hb=$('#calHanbaiBtn'); if(hb) hb.addEventListener('click', async ()=>{
    const cutoff=($('#calCutoff').value||today());
    const issuedOnly=$('#calHanbaiScope').value==='issued';
    const box=m(); box.style.color='#6b7785'; box.textContent='確認中…';
    try{
      const r=await fetch('/api/hanbai-export-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cutoff,issuedOnly})}).then(x=>x.json());
      if(!r.ok){ box.style.color='#c0392b'; box.textContent='エラー: '+(r.error||''); return; }
      if(!r.count){ box.style.color='#b8860b'; box.textContent='対象なし（'+cutoff+' までに実施日が来た'+(issuedOnly?'発行済みの':'')+'改定はありません）'; return; }
      let warn='';
      if(r.dbError) warn='\\n※ 販売大臣DBに接続できず、消費税区分／税率表№は標準値(2／1)で出力します。';
      else if(r.missingTax) warn='\\n※ '+r.missingTax+' 件はDBに商品が無く、消費税は標準値(2／1)で出力します。';
      if(r.ambiguous) warn+='\\n⚠ '+r.ambiguous+'件は1つの自社商品が複数のメーカー品に一致＝単価が不確定です（どの品かは下の「単価が不確定な品の一覧をダウンロード」で確認。商品名3に正しい品番を登録→↻照合 で確定。発行済みは発行時の単価を使います）。';
      if(!confirm(cutoff+' までに実施日が到来した改定 '+r.count+' 行 / '+r.customerCount+' 得意先 を、販売大臣の「単価履歴」取込CSVとして出力します。'+warn+'\\n\\nダウンロードしますか？')){ box.textContent=''; return; }
      box.style.color='#2e7d32'; box.textContent='✓ 単価履歴CSVをダウンロードしました（'+r.count+' 行 / '+r.customerCount+' 得意先）。';
      window.location='/api/hanbai-export?cutoff='+encodeURIComponent(cutoff)+(issuedOnly?'&issuedOnly=1':'');
    }catch(e){ box.style.color='#c0392b'; box.textContent='通信に失敗しました: '+e; }
  });
  const cb=$('#calCostBtn'); if(cb) cb.addEventListener('click', async ()=>{
    const cutoff=($('#calCutoff').value||today());
    const box=m(); box.style.color='#6b7785'; box.textContent='確認中…';
    try{
      const r=await fetch('/api/cost-export-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cutoff})}).then(x=>x.json());
      if(!r.ok){ box.style.color='#c0392b'; box.textContent='エラー: '+(r.error||''); return; }
      if(!r.count){ box.style.color='#b8860b'; box.textContent='対象なし（'+cutoff+' までに実施日が来た改定はありません）'; return; }
      let cwarn='';
      if(r.ambiguous) cwarn='\\n⚠ '+r.ambiguous+'件は1つの自社商品が複数のメーカー品に一致＝新原価が不確定です（どの品かは下の「単価が不確定な品の一覧をダウンロード」で確認。商品名3に正しい品番を登録→↻照合 で確定。発行済みは発行時の原価を使います）。';
      if(!confirm(cutoff+' までに実施日が到来した商品 '+r.count+' 件 の新しい仕入原価を、基幹システム取込用CSV（商品コード,新原価）として出力します。'+cwarn+'\\n\\nダウンロードしますか？')){ box.textContent=''; return; }
      box.style.color='#2e7d32'; box.textContent='✓ 仕入原価CSVをダウンロードしました（'+r.count+' 商品）。';
      window.location='/api/cost-export?cutoff='+encodeURIComponent(cutoff);
    }catch(e){ box.style.color='#c0392b'; box.textContent='通信に失敗しました: '+e; }
  });
})();

// 得意先別ページから「商品名リンク」で開かれた時：その仕入先の照合結果を選んで該当行へジャンプ＋強調。
//  URL例 /?focusSupplier=エフピコ&focusCustomer=島田&focusCode=007486&focusName=...
function focusKey(s){ return String(s==null?'':s).normalize('NFKC').toLowerCase().replace(/[\\s　]/g,''); }
function focusRow(customer, code, name){
  if(!baseRows || !baseRows.length) return;
  const ncust=focusKey(customer), ncode=String(code||'').trim(), nname=focusKey(name);
  const matchCust=(r)=> !ncust || focusKey(r.customerName)===ncust;
  let idx=-1;
  // ① 得意先＋自社CD（最も確実）→ ② 得意先＋商品名 → ③ 自社CDのみ → ④ 商品名のみ
  for(let i=0;i<baseRows.length;i++){ const r=baseRows[i]; if(matchCust(r) && ncode && String(r.productCode||'').trim()===ncode){ idx=i; break; } }
  if(idx<0 && nname) for(let i=0;i<baseRows.length;i++){ const r=baseRows[i]; if(matchCust(r) && (focusKey(r.productNameCore)===nname || focusKey(r.productName)===nname)){ idx=i; break; } }
  if(idx<0 && ncode) for(let i=0;i<baseRows.length;i++){ if(String(baseRows[i].productCode||'').trim()===ncode){ idx=i; break; } }
  if(idx<0 && nname) for(let i=0;i<baseRows.length;i++){ const r=baseRows[i]; if(focusKey(r.productNameCore)===nname || focusKey(r.productName)===nname){ idx=i; break; } }
  if(idx<0){ $('#msg').style.color='#9a6a00'; $('#msg').textContent='指定された商品が見つかりませんでした（別の照合結果かもしれません）。'; return; }
  const tr=document.getElementById('row'+idx);
  if(!tr){
    // 提出済み等で非表示の行はジャンプできない＝その旨を案内。
    if(baseRows[idx] && baseRows[idx].itemStatus==='issued'){ $('#msg').style.color='#1f6b35'; $('#msg').textContent='この商品は「見積書 作成済み（提出済み）」のためメイン表では非表示です（得意先別ページで確認できます）。'; }
    return;
  }
  tr.scrollIntoView({behavior:'smooth', block:'center'});
  tr.classList.add('focusrow');
  setTimeout(()=>{ tr.classList.remove('focusrow'); }, 6000);
}
// 二重登録（同じ自社商品が複数の仕入先に出る）を検知してバナー表示。
async function loadDupCheck(){
  const box=$('#dupAlert'); if(!box) return;
  try{
    const r=await fetch('/api/dup-check').then(x=>x.json());
    const dups=(r&&r.dups)||[];
    if(!dups.length){ box.style.display='none'; box.innerHTML=''; return; }
    const sample=dups.slice(0,6).map(d=>'　・'+esc(d.name||d.code)+'（'+d.suppliers.map(s=>esc(s)).join(' / ')+'）').join('<br>');
    box.style.display='block';
    box.innerHTML='⚠ <b>二重登録の疑い '+dups.length+'件</b>：同じ自社商品が <b>複数の仕入先</b>に登録されています。'
      +'修正見積を違う仕入先名で取り込むと起きます（損益・見積・取込CSVが二重に）。正しい仕入先名で取り込み直すか、片方を整理してください。<br>'+sample+(dups.length>6?'<br>　…ほか':'');
  }catch(e){ box.style.display='none'; }
}
// 🔁 再見積もり要：提出済み単価が、最新照合の新原価で逆ザヤ/利幅薄になっていないか。
var requoteItems=[];
async function loadRequoteCheck(){
  const box=$('#requoteAlert'); if(!box) return;
  try{
    const r=await fetch('/api/requote-check').then(x=>x.json());
    const items=(r&&r.items)||[]; requoteItems=items;
    if(!items.length){ box.style.display='none'; box.innerHTML=''; return; }
    const TAG={gyaku:'<b style="color:#b71c1c">🔴逆ザヤ</b>',thin:'<b style="color:#b8860b">🟡値上利薄</b>',up:'<b style="color:#c46210">🔼値上がり</b>',down:'<b style="color:#1f6b35">🔽値下がり</b>'};
    const rows=items.map((i,idx)=>{
      const tag=TAG[i.severity]||'';
      const oc=(i.oldCost!=null?i.oldCost:'?');
      return '<div style="padding:2px 0">　・'+tag+' '+esc(i.customer)+'　'+esc(i.supplier)+' '+esc(i.code)
        +'：提出 <b>'+esc(i.sell)+'円</b>／原価 '+esc(oc)+'→<b>'+esc(i.newCost)+'円</b>（新利益率 <b>'+esc(i.marginPct)+'%</b>）'
        +' <button class="rqRevert" data-idx="'+idx+'" style="font-size:11px;padding:2px 8px;border:1px solid #b71c1c;color:#b71c1c;background:#fff;border-radius:5px;cursor:pointer;font-weight:700">🔁 対象に戻して見積へ</button>'
        +' <a class="rqGo" href="/customers?customer='+encodeURIComponent(i.customer)+'" target="_blank" style="font-size:11px;color:#1976d2;margin-left:4px">📝 見積ページ</a></div>';
    }).join('');
    box.style.display='block';
    box.innerHTML='🔁 <b>再見積もり要 '+r.count+'件</b>（🔴逆ザヤ '+r.gyaku+' / 🟡値上利薄 '+r.thin+' / 🔼値上がり '+r.up+' / 🔽値下がり '+r.down+'）：'
      +'<b>提出済み</b>の単価が、提出後に <b>仕入原価が変わった</b>品です（上がった/下がった両方）。'
      +'「🔁 対象に戻して見積へ」で提出を解除→ <b>得意先別ページで再見積もり</b>して出し直してください。<br>'+rows
      +'<div style="font-size:11px;color:#8a6d1a;margin-top:4px">※ 提出時の原価から1円でも変われば表示（原価据置は出しません）。🟡は値上がりで新利益率10%未満。</div>';
    box.querySelectorAll('.rqRevert').forEach(b=> b.addEventListener('click',()=> requoteRevert(Number(b.getAttribute('data-idx')))));
  }catch(e){ box.style.display='none'; }
}
// 「🔁 対象に戻す」＝提出済みを解除し対象へ戻す（得意先別で再見積もり可能に）。自動では単価を変えない。
async function requoteRevert(idx){
  const it=requoteItems[idx]; if(!it) return;
  if(!confirm('「'+it.customer+'　'+it.supplier+' '+it.code+'」の提出済みを解除し、見積の対象に戻します。\\n解除後、この得意先の見積ページを新しいタブで開きます。\\n（新原価 '+it.newCost+'円 を反映して再見積もり→出し直してください）\\n\\nよろしいですか？')) return;
  try{
    const res=await fetch('/api/item-status',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ customer:it.customer, rowKey:it.rowKey, status:'' })}).then(x=>x.json());
    if(!res.ok){ alert('解除に失敗: '+(res.error||'')); return; }
    $('#msg').style.color='#1f6b35';
    $('#msg').textContent='🔁 提出を解除しました（'+it.customer+' '+it.supplier+' '+it.code+'）。開いた見積ページで再見積もりしてください。';
    window.open('/customers?customer='+encodeURIComponent(it.customer),'_blank'); // 見積ページ（その得意先）へ
    await loadRequoteCheck();                                 // 一覧を取り直す（戻した分は消える）
    if(allView) await loadAll(); else if(!dateFilter) await loadFile(); // メイン表示も更新（提出解除で表に復帰）
  }catch(e){ alert('解除に失敗: '+e); }
}
// 手動紐付けの健全性：表記ずれ・手動より確実な自動候補（CD一致/高い名前一致%）。
async function loadLinkCheck(){
  const box=$('#linkAlert'); if(!box) return;
  try{
    const r=await fetch('/api/link-check').then(x=>x.json());
    const issues=(r&&r.issues)||[];
    linkIssues = issues;
    linkUpgradeMap = {};
    issues.filter(i=>i.kind==='better_cd'||i.kind==='better_name').forEach(i=>{
      linkUpgradeMap[i.supplier+'\x01'+i.code] = i;
    });
    linkSuspectMap = {};
    issues.filter(i=>i.kind==='suspect').forEach(i=>{ linkSuspectMap[i.supplier+'\x01'+i.code] = i; });
    const mism=issues.filter(i=>i.kind==='name_mismatch');
    const better=issues.filter(i=>i.kind==='better_cd'||i.kind==='better_name');
    const suspect=issues.filter(i=>i.kind==='suspect');
    const revival=issues.filter(i=>i.kind==='dormant_revival');
    if(!mism.length && !better.length && !suspect.length && !revival.length){ box.style.display='none'; box.innerHTML=''; return; }
    let html='';
    if(revival.length){
      const rs=revival.slice(0,8).map(i=>{
        const since=i.since?('／休眠 '+esc(i.since)+' 以降'):'';
        return '<div style="padding:2px 0">　・'+esc(i.supplier)+' '+esc(i.code)+'：自社「'+esc(i.selfName||'')+'」 <b>最終売上 '+esc(i.lastDate||'')+'</b>'+since+linkRowBtns(i)+'</div>';
      }).join('');
      html+='💤→🔼 <b>休眠なのに最近 売上あり '+revival.length+'件</b>：休眠（保留）にした自社品に、その後 新しい売上が立っています（取引再開の可能性）。'
        +'見積に戻すなら「🔄 復帰（解除）」→ <b>会社PCで「↻ 照合」</b>。違うなら放置でOK（休眠のまま）。<br>'+rs+(revival.length>8?'<br>　…ほか '+(revival.length-8)+' 件':'')+'<br>';
    }
    if(suspect.length){
      const reasonLabel=function(rs){
        return (rs||[]).map(function(x){
          if(x.k==='low_name') return '名前がほぼ別物('+x.v+'%)';
          if(x.k==='size_mismatch') return 'サイズ違い';
          if(x.k==='color_mismatch') return '色違い';
          if(x.k==='price_gap') return '原価が約'+x.v+'倍ズレ('+x.self+'→'+x.maker+')';
          return x.k;
        }).join('・');
      };
      const ss=suspect.slice(0,6).map(i=>'<div style="padding:2px 0">　・'+esc(i.supplier)+' '+esc(i.code)+'：自社「'+esc(i.selfName||'')+'」に 手動「'+esc(i.linked)+'」＝<b>'+esc(reasonLabel(i.reasons))+'</b>'+linkRowBtns(i)+'</div>').join('');
      html+='🚨 <b>手動紐付けの勘違いの疑い '+suspect.length+'件</b>：紐付け先のメーカー品が<b>自社商品とそもそも別物</b>の可能性があります（別商品に📌した取り違え）。'
        +'「✏ 紐付け」で正しいメーカー品に直す（取り違えなら一旦解除）と安全です。<br>'+ss+(suspect.length>6?'<br>　…ほか '+(suspect.length-6)+' 件':'')+'<br>';
    }
    if(better.length){
      const bs=better.slice(0,5).map(i=>{
        const lbl = i.kind==='better_cd' ? 'CD一致候補' : ('名前一致 '+i.betterScore+'%');
        return '<div style="padding:2px 0">　・'+esc(i.supplier)+' '+esc(i.code)+'：手動「'+esc(i.linked)+'」→ より確実「'+esc(i.betterMaker)+'」（'+lbl+'）'+linkRowBtns(i)+'</div>';
      }).join('');
      html+='🔔 <b>手動紐付けより確実な候補 '+better.length+'件</b>：自動照合では別のメーカー品の方が信頼度が高いです。'
        +'「✏ 紐付け」で切り替えるか、商品マスタ(商品名3)に品番を登録してCD一致にしてください。<br>'+bs+(better.length>5?'<br>　…ほか '+(better.length-5)+' 件':'')+'<br>';
    }
    if(mism.length){
      const ms=mism.slice(0,5).map(i=>'<div style="padding:2px 0">　・'+esc(i.supplier)+' '+esc(i.code)+'：登録「'+esc(i.linked)+'」→ 照合は「'+esc(i.hint||i.makers[0]||'?')+'」'+linkRowBtns(i)+'</div>').join('');
      html+='🔗 <b>手動紐付けの表記ずれ '+mism.length+'件</b>：登録名とメーカー品名が一致していません。'
        +'「✏ 紐付け」で<b>候補リストから選び直す</b>と安全です。<br>'+ms+(mism.length>5?'<br>　…ほか '+(mism.length-5)+' 件':'');
    }
    const totalN = suspect.length+better.length+mism.length;
    if(totalN>0){
      html = '<div style="margin-bottom:8px"><button id="linkReviewOpen" style="font-size:12px;font-weight:700;padding:4px 12px;background:#1976d2;color:#fff;border:none;border-radius:5px;cursor:pointer">📋 まとめて見直す（'+totalN+'件）</button>'
        +' <span style="font-size:11px;color:#8a6d1a">各行の「✅切替／解除／✏直す／🔍確認」でもその場で直せます。反映は会社PCで「↻ 照合」。</span></div>' + html;
    }
    box.style.display='block';
    box.innerHTML=html;
    // バナー各行のボタンを配線（ジャンプ／一括切替／解除／編集）
    box.querySelectorAll('.linkJump').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; jumpToLinkRow(t.dataset.sup,t.dataset.code);}));
    box.querySelectorAll('.linkSwitch').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; switchLinkTo(t.dataset.sup,t.dataset.code,t.dataset.better);}));
    box.querySelectorAll('.linkUnlink').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; switchLinkTo(t.dataset.sup,t.dataset.code,'');}));
    box.querySelectorAll('.linkEdit').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; editLinkRow(t.dataset.sup,t.dataset.code,t.dataset.better||'');}));
    box.querySelectorAll('.linkRevive').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; reviveDormant(t.dataset.sup,t.dataset.code);}));
    const ro=$('#linkReviewOpen'); if(ro) ro.addEventListener('click', openLinkReviewPanel);
    // 表の 📌 セルに ⚠ を付け直す（すでに描画済みのとき）
    if(baseRows.length && !dateFilter) renderMainRows(!!dateFilter);
  }catch(e){ box.style.display='none'; linkUpgradeMap={}; linkSuspectMap={}; linkIssues=[]; }
}
// 紐付け監査の各行に付ける操作ボタン（バナー・別枠パネル共通）。data-* に仕入先/自社CD/推奨候補を持たせる。
function linkRowBtns(i){
  const sup=escAttr(i.supplier||''), code=escAttr(i.code||'');
  const pre=escAttr(i.betterMaker||i.hint||'');
  const bs='font-size:11px;margin-left:6px;padding:1px 7px;border:1px solid #c7ced8;border-radius:4px;background:#fff;cursor:pointer';
  let h=' <button class="linkJump" data-sup="'+sup+'" data-code="'+code+'" style="'+bs+'">🔍 確認</button>';
  if(i.kind==='better_cd'||i.kind==='better_name'){
    h+='<button class="linkSwitch" data-sup="'+sup+'" data-code="'+code+'" data-better="'+escAttr(i.betterMaker||'')+'" style="'+bs+';color:#1565c0;border-color:#90caf9;font-weight:700">✅ この候補に切替</button>';
  }
  if(i.kind==='suspect'){
    h+='<button class="linkUnlink" data-sup="'+sup+'" data-code="'+code+'" style="'+bs+';color:#b71c1c;border-color:#ef9a9a;font-weight:700">解除</button>';
  }
  if(i.kind==='dormant_revival'){
    // 休眠の復帰＝休眠マークを解除（=次の照合で自動マッチに戻る）。違えば放置でOK。
    h+='<button class="linkRevive" data-sup="'+sup+'" data-code="'+code+'" style="'+bs+';color:#1565c0;border-color:#90caf9;font-weight:700">🔄 復帰（解除）</button>';
    return h; // 復帰は「確認」＋「復帰」だけ（✏直すは出さない＝紐付け修正とは用途が違う）
  }
  h+='<button class="linkEdit" data-sup="'+sup+'" data-code="'+code+'" data-better="'+pre+'" style="'+bs+'">✏ 直す</button>';
  return h;
}
// バナーから「🔄 復帰（解除）」＝休眠（保留）マークを外す。次の照合で自動マッチに戻る（＝見積に復帰）。
async function reviveDormant(supplier, code){
  const msg='「'+escConfirm(supplier)+'  '+escConfirm(code)+'」の💤休眠（保留）を解除します。\\n（次の照合で自動マッチに戻り、見積の対象に復帰します）\\n\\nよろしいですか？\\n\\n※照合結果への反映には 会社PC(DBあり) で「↻ 照合」が必要です。';
  if(!confirm(msg)) return;
  try{
    const res=await fetch('/api/product-link',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ supplier:supplier, productCode:code, makerName:'' })}).then(x=>x.json());
    if(!res.ok){ alert('保存に失敗: '+(res.error||'')); return; }
    $('#msg').style.color='#1f6b35';
    $('#msg').textContent='💤→🔼 休眠を解除しました（'+supplier+' '+code+'）。反映は会社PCで「↻ 照合」を押してください。';
    await loadLinkCheck();                                  // 監査を取り直す（戻した分は一覧から消える）
    if(allView) await loadAll(); else if(!dateFilter) await loadFile(); // 表の 💤 表示を更新
  }catch(e){ alert('保存に失敗: '+e); }
}
// reasons 配列 → 日本語ラベル（別枠パネル用）。loadLinkCheck 内の reasonLabel と同等。
function reasonLabelText(rs){
  return (rs||[]).map(function(x){
    if(x.k==='low_name') return '名前がほぼ別物('+x.v+'%)';
    if(x.k==='size_mismatch') return 'サイズ違い';
    if(x.k==='color_mismatch') return '色違い';
    if(x.k==='price_gap') return '原価が約'+x.v+'倍ズレ('+x.self+'→'+x.maker+')';
    return x.k;
  }).join('・');
}
// 自社CDの正規化（数字のみは6桁ゼロ詰め）＝行検索の突合キー。
function codePadN(c){ const s=String(c||'').trim(); return /^\\d+$/.test(s) ? s.padStart(6,'0') : s; }
// baseRows から 仕入先＋自社CD に一致する行の index を探す（見つからなければ -1）。
function findLinkRowIdx(supplier, code){
  const nc=codePadN(code), nsup=String(supplier||'');
  for(let i=0;i<baseRows.length;i++){
    const r=baseRows[i];
    if(codePadN(r.productCode)!==nc) continue;
    if(allView && nsup && String(r.supplier||'')!==nsup) continue;
    return i;
  }
  return -1;
}
// 該当行が今の表に無ければ「★全部」ビューへ切り替えてから探し直す。戻り値 idx（-1=見つからず）。
async function ensureLinkRowVisible(supplier, code){
  let idx=findLinkRowIdx(supplier,code);
  if(idx>=0) return idx;
  $('#file').value='*ALL*';
  await loadAll();
  return findLinkRowIdx(supplier,code);
}
// バナー/パネルから「🔍 確認」＝該当行へジャンプ＆ハイライト。
async function jumpToLinkRow(supplier, code){
  closeLinkReview();
  const idx=await ensureLinkRowVisible(supplier,code);
  if(idx<0){ $('#msg').style.color='#9a6a00'; $('#msg').textContent='該当行が見つかりませんでした（提出済みで非表示／別の照合結果の可能性）。'; return; }
  const tr=document.getElementById('row'+idx);
  if(!tr){
    if(baseRows[idx] && baseRows[idx].itemStatus==='issued'){ $('#msg').style.color='#1f6b35'; $('#msg').textContent='この商品は「見積書 作成済み（提出済み）」のためメイン表では非表示です（得意先別ページで確認できます）。'; }
    else { $('#msg').style.color='#9a6a00'; $('#msg').textContent='該当行は現在の表に表示されていません。'; }
    return;
  }
  tr.scrollIntoView({behavior:'smooth', block:'center'});
  tr.classList.add('focusrow'); setTimeout(()=>{ tr.classList.remove('focusrow'); }, 6000);
  $('#msg').textContent='';
}
// バナー/パネルから「✏ 直す」＝該当行の紐付けモーダルを推奨候補を選択済みで開く。
async function editLinkRow(supplier, code, better){
  closeLinkReview();
  const idx=await ensureLinkRowVisible(supplier,code);
  if(idx<0){ $('#msg').style.color='#9a6a00'; $('#msg').textContent='該当行が見つかりませんでした（提出済みで非表示／別の照合結果の可能性）。'; return; }
  openLinkModal(idx, better||'');
}
// バナー/パネルから「✅ この候補に切替」（better=推奨メーカー名）／「解除」（better=''）＝ワンクリック保存（確認つき）。
async function switchLinkTo(supplier, code, better){
  const isUnlink=!better;
  const msg=isUnlink
    ? '「'+escConfirm(supplier)+'  '+escConfirm(code)+'」の手動紐付けを\\n解除します（自動マッチに戻す）。よろしいですか？\\n\\n※照合結果への反映には 会社PC(DBあり) で「↻ 照合」が必要です。'
    : '「'+escConfirm(supplier)+'  '+escConfirm(code)+'」の紐付けを\\n「'+escConfirm(better)+'」に切り替えます。よろしいですか？\\n\\n※照合結果への反映には 会社PC(DBあり) で「↻ 照合」が必要です。';
  if(!confirm(msg)) return;
  try{
    const res=await fetch('/api/product-link',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ supplier:supplier, productCode:code, makerName:better||'' })}).then(x=>x.json());
    if(!res.ok){ alert('保存に失敗: '+(res.error||'')); return; }
    if(res.linkWarn){ alert('⚠ '+res.linkWarn); }
    $('#msg').style.color='#1f6b35';
    $('#msg').textContent=(isUnlink?'📌 紐付けを解除しました':'📌 紐付けを「'+better+'」に切り替えました')+'（'+supplier+' '+code+'）。反映は会社PCで「↻ 照合」を押してください。';
    const reopen=!!document.getElementById('linkRevDlg');
    closeLinkReview();
    await loadLinkCheck();                                  // 監査を取り直す（直した分は一覧から消える）
    if(allView) await loadAll(); else if(!dateFilter) await loadFile(); // 表の 📌 表示を更新
    if(reopen && linkIssues.length) openLinkReviewPanel();  // パネルから操作したなら開き直す
  }catch(e){ alert('保存に失敗: '+e); }
}
// 別枠「要見直し」パネル：suspect/better/mismatch を1つの表に並べ、その場で切替・解除・編集できる。
function openLinkReviewPanel(){
  closeLinkReview();
  // バナーと同じ3カテゴリだけ（孤立 orphan 等は除外＝古い紐付けでここでは扱わない）。
  const order={ suspect:0, better_cd:1, better_name:1, name_mismatch:2 };
  const items=linkIssues.filter(i=>order[i.kind]!=null).slice().sort((a,b)=>order[a.kind]-order[b.kind]);
  if(!items.length) return;
  const nsus=linkIssues.filter(i=>i.kind==='suspect').length;
  const nbet=linkIssues.filter(i=>i.kind==='better_cd'||i.kind==='better_name').length;
  const nmis=linkIssues.filter(i=>i.kind==='name_mismatch').length;
  const rows=items.map(i=>{
    let prob='', rec='';
    if(i.kind==='better_cd'){ prob='🔔 CD一致の方が確実'; rec=esc(i.betterMaker||''); }
    else if(i.kind==='better_name'){ prob='🔔 名前一致 '+i.betterScore+'% の方が高い'; rec=esc(i.betterMaker||''); }
    else if(i.kind==='suspect'){ prob='🚨 '+esc(reasonLabelText(i.reasons)); rec='<span style="color:#b71c1c">取り違えの疑い → 解除を推奨</span>'; }
    else { prob='🔗 登録名とメーカー名が不一致'; rec=esc(i.hint||(i.makers&&i.makers[0])||'?'); }
    const self=i.selfName? esc(i.selfName) : '<span class="hint">—</span>';
    return '<tr>'
      +'<td>'+esc(i.supplier||'')+'</td>'
      +'<td>'+esc(i.code||'')+'</td>'
      +'<td>'+self+'</td>'
      +'<td>'+esc(i.linked||'')+'</td>'
      +'<td>'+prob+'</td>'
      +'<td>'+rec+'</td>'
      +'<td style="white-space:nowrap">'+linkRowBtns(i)+'</td>'
      +'</tr>';
  }).join('');
  const wrap=document.createElement('div'); wrap.id='linkRevWrap';
  wrap.innerHTML=
    '<div id="linkRevBack" style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9000"></div>'+
    '<div id="linkRevDlg" style="position:fixed;top:4%;left:50%;transform:translateX(-50%);background:#fff;border-radius:8px;padding:18px;width:1000px;max-width:96%;max-height:88vh;overflow:auto;z-index:9001;box-shadow:0 10px 40px rgba(0,0,0,.2)">'+
      '<h3 style="margin:0 0 8px">📋 紐付けの 要見直し 一覧</h3>'+
      '<div style="font-size:12px;color:#6b7785;margin-bottom:10px">🚨 勘違いの疑い '+nsus+' ／ 🔔 より確実 '+nbet+' ／ 🔗 表記ずれ '+nmis+' 件。'+
        '「✅ この候補に切替」「解除」はその場で保存します（<b>照合結果への反映には 会社PC(DBあり) で「↻ 照合」</b>が必要）。</div>'+
      '<table id="linkRevTbl" style="width:100%;border-collapse:collapse;font-size:12px">'+
        '<thead><tr style="background:#f1f4f8;text-align:left">'+
          '<th style="padding:5px 6px">仕入先</th><th style="padding:5px 6px">自社CD</th><th style="padding:5px 6px">自社品名</th>'+
          '<th style="padding:5px 6px">今の紐付け</th><th style="padding:5px 6px">問題</th><th style="padding:5px 6px">推奨</th><th style="padding:5px 6px">操作</th>'+
        '</tr></thead><tbody>'+rows+'</tbody>'+
      '</table>'+
      '<div style="text-align:right;margin-top:12px"><button id="linkRevClose" style="padding:6px 14px">閉じる</button></div>'+
    '</div>';
  document.body.appendChild(wrap);
  wrap.querySelectorAll('#linkRevTbl tbody td').forEach(td=>{ td.style.padding='5px 6px'; td.style.borderTop='1px solid #eef1f5'; td.style.verticalAlign='top'; });
  $('#linkRevBack').addEventListener('click', closeLinkReview);
  $('#linkRevClose').addEventListener('click', closeLinkReview);
  wrap.querySelectorAll('.linkJump').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; jumpToLinkRow(t.dataset.sup,t.dataset.code);}));
  wrap.querySelectorAll('.linkSwitch').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; switchLinkTo(t.dataset.sup,t.dataset.code,t.dataset.better);}));
  wrap.querySelectorAll('.linkUnlink').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; switchLinkTo(t.dataset.sup,t.dataset.code,'');}));
  wrap.querySelectorAll('.linkEdit').forEach(el=>el.addEventListener('click',e=>{const t=e.currentTarget; editLinkRow(t.dataset.sup,t.dataset.code,t.dataset.better||'');}));
}
function closeLinkReview(){ const w=document.getElementById('linkRevWrap'); if(w) w.remove(); }
// CD一致化 候補：メーカー品番をマスタ(商品名3)に登録すればCD一致にできる品の案内＋CSVダウンロード。
async function loadCdCandidates(){
  const box=$('#cdCand'); if(!box) return;
  try{
    const r=await fetch('/api/cd-candidates').then(x=>x.json());
    if(!r||!r.ok||!r.count){ box.style.display='none'; box.innerHTML=''; return; }
    box.style.display='block';
    box.innerHTML='🏷 <b>メーカー品番を商品マスタ(商品名3)に登録すると「CD一致(高精度)」にできる品 '+r.count+'件</b>'
      +(r.dormantWithCode?'（ほか 品番ありの休眠 '+r.dormantWithCode+'件＝自社品の確認が必要 <a class="dl" href="/api/cd-dormant.csv" download>📥 休眠リストCSV</a>）':'')
      +' <a class="dl" href="/cdlink">🏷 コード化ページで1件ずつ確定 →</a>'
      +' <a class="dl" href="/api/cd-candidates.csv" download>📥 候補CSV</a>'
      +'<div style="font-size:11px;margin-top:3px;color:#3a567a">「コード化ページ」で1件ずつ確認→確定（確定はすぐ手動紐付けで効きます）→ たまったら商品名3登録用CSVで販売大臣に登録 → 「↻ 照合を実行」でCD一致に昇格。</div>';
  }catch(e){ box.style.display='none'; }
}
// 固定ヘッダーの高さを測り、横スクロールバー(.hbar)の sticky 位置をヘッダー直下に合わせる（折り返しで高さが変わるため）。
function syncHdrH(){ const h=document.querySelector('header'); if(h) document.documentElement.style.setProperty('--hdr-h', Math.ceil(h.getBoundingClientRect().height)+'px'); }
window.addEventListener('resize', syncHdrH);
(async ()=>{
  syncHdrH();
  await initSettings();
  syncHdrH();
  fetchPL();
  const smTh = $('#sortMatchTh');
  if (smTh) { updateSortMatchTh(); smTh.addEventListener('click', cycleMainSort); }
  const params=new URLSearchParams(location.search);
  const fSup=params.get('focusSupplier');
  if(fSup){
    // その仕入先の最新照合結果ファイルを選んで開く（ファイル名は <仕入先>_照合結果_<日時>.csv）
    const r=await fetch('/api/files').then(x=>x.json()).catch(()=>null);
    const files=(r&&r.files)||[];
    const target=files.find(f=> f.indexOf(fSup+'_照合結果')===0) || files.find(f=> f.indexOf(fSup)===0) || files[0];
    await loadFiles(target);
    focusRow(params.get('focusCustomer')||'', params.get('focusCode')||'', params.get('focusName')||'');
  } else {
    await loadFiles();
  }
  // 全社損益（全仕入先 calcAll）は表表示の後に遅延＝起動の体感を軽くする。
  setTimeout(()=>{ loadAllImpact(); }, 400);
  // バナー類も表の描画を阻害しないよう遅らせる
  setTimeout(()=>{ loadDupCheck(); loadLinkCheck(); loadCdCandidates(); loadRequoteCheck(); }, 600);
  initShogoLockWatch();
})();
</script>
</body></html>`;
