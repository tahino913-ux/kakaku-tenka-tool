// =====================================================================
//  設定の保存・読込（settings.json）
//  config.js を「初期値（フォールバック）」とし、settings.json を上書きして
//  「実効設定」を返す。利用者はコード(config.js)を触らず、画面から設定できる。
//  ※ settings.json は各社ごとの設定ファイル（会社情報・見積文言・計算既定）。
// =====================================================================
const fs = require('fs');
const path = require('path');
const base = require('../config');

const ROOT = path.join(__dirname, '..');
const SETTINGS_PATH = path.join(ROOT, 'settings.json');
const BACKUP_DIR = path.join(ROOT, 'settings_backup'); // 上書き直前の settings.json を世代退避（gitignore）
const BACKUP_KEEP = 50;                                // 直近この世代数だけ残す（ファイルは小さい＝50で十分）

// 原子的書き込み：一時ファイルへ書いてから rename で本体へ置換する。
//  途中でクラッシュ/Drive同期割り込みが起きても settings.json 本体が壊れない
//  （rename は同一フォルダ＝同一ボリュームで原子的に置換される）。失敗時は throw。
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// 上書き直前の settings.json を settings_backup/ へ世代退避する。
//  原子的書込みは「書込み途中のクラッシュで壊れる」事故は防ぐが、「誤った内容で正しく上書きした」事故は救えない。
//  そこで保存のたびに“上書き前の現物”を1ファイル退避し、紐付け/ルールを壊しても1ファイルで戻せるようにする。
//  ・バックアップ失敗は保存本体を絶対に止めない（保存が最優先）＝例外はすべて飲み込む。
//  ・対象は settings_YYYYMMDD_HHMMSS_mmm.json のみ（自分が作った名前だけ剪定＝他ファイルは決して触らない）。
//  ・名前が時刻順＝辞書順なので、ソートして古い方から BACKUP_KEEP を超える分だけ削除する。
function pad(n, w) { return String(n).padStart(w || 2, '0'); }
function backupCurrentSettings() {
  try { fs.statSync(SETTINGS_PATH); } catch (_) { return; } // 初回(ファイル無し)は退避不要
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
      '_' + pad(d.getMilliseconds(), 3);
    fs.copyFileSync(SETTINGS_PATH, path.join(BACKUP_DIR, 'settings_' + stamp + '.json'));
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^settings_\d{8}_\d{6}_\d{3}\.json$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
    }
  } catch (_) { /* バックアップ失敗は保存を止めない */ }
}

// バックアップ一覧を新しい順で返す。{ file=ファイル名, savedAt=表示用日時, size=バイト } の配列。
//  /self の「設定の復元」UI が使う。settings_YYYYMMDD_HHMMSS_mmm.json だけを対象にする。
function listSettingsBackups() {
  let files = [];
  try { files = fs.readdirSync(BACKUP_DIR); } catch (_) { return []; } // フォルダ未作成=まだ保存歴なし
  const out = [];
  for (const f of files) {
    const m = f.match(/^settings_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(\d{3})\.json$/);
    if (!m) continue;
    let size = 0;
    try { size = fs.statSync(path.join(BACKUP_DIR, f)).size; } catch (_) {}
    out.push({ file: f, savedAt: m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6], size });
  }
  out.sort((a, b) => (a.file < b.file ? 1 : -1)); // 名前=時刻順なので逆順ソート＝新しい順
  return out;
}

// 指定したバックアップを settings.json へ復元する。復元前に必ず現状も世代退避＝復元自体も取り消せる。
//  安全策：
//   ・file はファイル名のみ許可（パス区切り・連番外の名前は拒否＝ディレクトリトラバーサル防止）。
//   ・バックアップが妥当なJSONであることを確認してから上書き（壊れたファイルで本体を潰さない）。
//   ・原子的書込み（tmp→rename）で置換し、書込み途中での破損を防ぐ。
function restoreSettingsBackup(file) {
  const name = String(file || '');
  if (!/^settings_\d{8}_\d{6}_\d{3}\.json$/.test(name)) throw new Error('バックアップ名が不正です。');
  let raw;
  try { raw = fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8'); }
  catch (_) { throw new Error('指定のバックアップが見つかりません。'); }
  let obj;
  try { obj = JSON.parse(raw); }
  catch (_) { throw new Error('バックアップが壊れています（JSONとして読めません）。復元を中止しました。'); }
  backupCurrentSettings();            // 復元前の現状を退避（戻したあとに「やっぱり元へ」も可能に）
  writeJsonAtomic(SETTINGS_PATH, obj); // 原子的に置換（検証済みの内容を整形して書き出す）
  _userCache = null;                   // キャッシュ破棄＝次回 readUser は最新を読む
  return getSettings();
}

// settings.json のプロセス内キャッシュ。getSettings/getProductLinks/getMakers 等がほぼ全API・全calcで
//  何度も呼ばれ、毎回 readFileSync+JSON.parse すると遅い（Drive同期中は特に）。mtime が同じ間は再パースしない。
//  ・他PC(Drive同期)が更新→mtimeが変わる→自動で読み直す。
//  ・自分が saveSettings で書く→ _userCache=null で明示破棄（同一ms内の書込みでも確実に最新化）。
let _userCache = null; // { mtimeMs, data }
function readUser() {
  try {
    const st = fs.statSync(SETTINGS_PATH); // 無ければ throw → catch で null（旧 existsSync と同じ挙動）
    if (_userCache && _userCache.mtimeMs === st.mtimeMs) return _userCache.data;
    const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8') || '{}');
    _userCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch (e) {
    _userCache = null;
    return null; // 壊れていても既定値で動く
  }
}

// config.js の初期値に settings.json を上書きした実効設定を返す。
// 形は config.js と同じ（default / overrides / rounding / selfCostUplift / company / quote）。
function getSettings() {
  const u = readUser() || {};
  return {
    default:        u.default || base.default || { type: 'add_increase' },
    overrides:      base.overrides || [],                 // 個別ルールは当面 config.js 側
    rounding:       Object.assign({}, base.rounding, u.rounding),
    selfCostUplift: Object.assign({}, base.selfCostUplift, u.selfCostUplift),
    company:        Object.assign({}, base.company, u.company),
    quote:          Object.assign({}, base.quote, u.quote),
    matchThreshold: (u.matchThreshold != null ? u.matchThreshold : (base.matchThreshold != null ? base.matchThreshold : 80)),
    hanbai:         Object.assign({}, base.hanbai, u.hanbai),
    makers:         u.makers || {}, // 仕入先ごとの取り込みプロファイル（列マッピング等）
    // メーカー→問屋(仕入先)の寄せ替え: { メーカー名: 実際に仕入れる仕入先名 }
    //  例 {"エフピコ":"朝日食品容器"}＝エフピコ商品は朝日経由で買うので、照合時に朝日へ統合し二重計上を防ぐ。
    makerChannel:   u.makerChannel || {},
    // 商品紐付け辞書: { 仕入先名: { 自社商品コード: メーカー商品名 } }
    //  名前一致が外れる(蓋/身, エコ表記差, 別名等)ケースを手動で確定。
    //  照合時、ここで指定された (自社CD, メーカー商品名) は 100% 強制マッチし、
    //  同じ自社CDへの他メーカー品の名前一致は除外される（取り合い防止）。
    productLinks:   u.productLinks || {},
    // 仕入先マスタ: 自社で発注している全仕入先の一覧
    //  { 仕入先コード4桁: { name, address, phone, ... } }
    //  例: "0013" → { name: "朝日食品容器", ... }
    //  自社販売実績の商品名末尾に出る「13」と紐付き、誤マッチ抑止に使う。
    suppliers:      u.suppliers || {},
    // 自社販売実績ファイルの取込ルール（列の役割・階層セルの分解規則）
    //  画面で設定して保存。hanbai.js のパースに反映される。
    selfProfile:    u.selfProfile || null,
    // 任意のアクセスパスワード（共用PC向け簡易ロック）。空＝認証なし（既定）。
    accessPassword: u.accessPassword || '',
    // 自社製造品をDBの商品分類から抽出する設定（config.js 既定 ＋ settings.json 上書き）。
    selfManufacture: Object.assign({}, base.selfManufacture, u.selfManufacture),
    // AI取り込みアシスト設定（config.js 既定 ＋ settings.json 上書き）。既定OFF。
    ai: Object.assign({}, base.ai, u.ai),
    // コード化（初期登録）レビューの記録：
    //  confirmed = 人が確定した {仕入先:{自社CD:{code:メーカー品番, name:メーカー商品名, at}}}
    //  rejected  = 人が却下した {仕入先:{"自社CD|メーカー品番": at}}（候補から消すため）
    //  確定は同時に productLinks にも登録され、↻照合で 手動紐付け として効く。
    cdReview:       u.cdReview && typeof u.cdReview === 'object'
      ? { confirmed: u.cdReview.confirmed || {}, rejected: u.cdReview.rejected || {} }
      : { confirmed: {}, rejected: {} },
    // 得意先 除外設定：{ 得意先名: 除外した日時(ISO) }
    //  すでに取引が無いのに照合に出てくる先を、画面・損益・得意先別・見積書から除外（非表示）する。
    //  いつでも「復活」で戻せる（記録を消すだけ）。
    excludedCustomers: (u.excludedCustomers && typeof u.excludedCustomers === 'object') ? u.excludedCustomers : {},
  };
}

// 画面から来た編集内容を settings.json に保存（既存とマージ）。
function saveSettings(patch) {
  patch = patch || {};
  // 既存設定の保護：settings.json が「在るのに読めない」（破損 or Drive同期途中）なら保存を中止する。
  //  ここで cur={} ベースに上書きすると productLinks/makers/除外設定 等を全消ししてしまうため。
  //  ・ファイルが無い（初回）→ cur=null だが fileExists=false なので通常どおり作成する。
  let fileExists = false;
  try { fs.statSync(SETTINGS_PATH); fileExists = true; } catch (_) {}
  const cur0 = readUser();
  if (fileExists && cur0 === null) {
    throw new Error('settings.json を読み込めませんでした（破損 or 同期中の可能性）。既存設定を守るため保存を中止しました。少し待って再度お試しください。');
  }
  const cur = cur0 || {};
  const next = {
    default:        patch.default || cur.default || base.default || { type: 'add_increase' },
    rounding:       Object.assign({}, cur.rounding, patch.rounding),
    selfCostUplift: Object.assign({}, cur.selfCostUplift, patch.selfCostUplift),
    company:        Object.assign({}, cur.company, patch.company),
    quote:          Object.assign({}, cur.quote, patch.quote),
    matchThreshold: (patch.matchThreshold != null ? patch.matchThreshold : (cur.matchThreshold != null ? cur.matchThreshold : (base.matchThreshold != null ? base.matchThreshold : 80))),
    hanbai:         Object.assign({}, cur.hanbai, patch.hanbai),
    makers:         Object.assign({}, cur.makers, patch.makers), // 既存プロファイルを保持
    makerChannel:   patch.makerChannel !== undefined ? patch.makerChannel : (cur.makerChannel || {}), // メーカー→問屋の寄せ替えを保持
    productLinks:   patch.productLinks !== undefined ? patch.productLinks : (cur.productLinks || {}),
    suppliers:      patch.suppliers !== undefined ? patch.suppliers : (cur.suppliers || {}),
    selfProfile:    patch.selfProfile !== undefined ? patch.selfProfile : (cur.selfProfile || null),
    accessPassword: patch.accessPassword !== undefined ? patch.accessPassword : (cur.accessPassword || ''),
    selfManufacture: patch.selfManufacture !== undefined ? patch.selfManufacture : cur.selfManufacture,
    // AI設定はマージで保持（UI保存で消えないように）。部分patchでも既存を残す。
    ai:             patch.ai !== undefined ? Object.assign({}, cur.ai, patch.ai) : cur.ai,
    // コード化レビューの記録（UI保存で消えないように保持）。
    cdReview:       patch.cdReview !== undefined ? patch.cdReview : (cur.cdReview || { confirmed: {}, rejected: {} }),
    // 得意先 除外設定（UI保存で消えないように保持）。
    excludedCustomers: patch.excludedCustomers !== undefined ? patch.excludedCustomers : (cur.excludedCustomers || {}),
    _savedAt:       new Date().toISOString(),
  };
  backupCurrentSettings(); // 上書き直前の現行 settings.json を世代退避（失敗しても保存は続行）
  try { writeJsonAtomic(SETTINGS_PATH, next); }
  catch (e) { _userCache = null; throw e; } // 書込失敗：キャッシュも破棄して次回ファイルから読み直す
  _userCache = null; // 書いたのでキャッシュ破棄（次回 readUser は最新を読む）
  return getSettings();
}

// 仕入先プロファイル（取り込みの列マッピング等）を読む
function getMakers() {
  const u = readUser() || {};
  return u.makers || {};
}

// 1仕入先ぶんのプロファイルを保存（他の設定・他社プロファイルは保持）
function saveMakerProfile(supplier, profile) {
  const name = String(supplier || '').trim();
  if (!name) return getMakers();
  const cur = readUser() || {};
  cur.makers = cur.makers || {};
  cur.makers[name] = Object.assign({}, cur.makers[name], profile, { _savedAt: new Date().toISOString() });
  // 既存ファイルが無い/壊れている場合に備え、保存は saveSettings 経由で全体を整える
  saveSettings({ makers: cur.makers });
  return getMakers();
}

// 初回設定が済んでいるか（settings.json があるか）。
function isConfigured() {
  return fs.existsSync(SETTINGS_PATH);
}

// 商品紐付け辞書を読む（{ 仕入先名: { 自社商品コード: メーカー商品名 } }）
function getProductLinks() {
  const u = readUser() || {};
  return u.productLinks || {};
}

// 1件分の紐付けを保存（自社商品コード ⇔ メーカー商品名）。
// makerName が空文字/null/undefined ならその紐付けを削除する。
function saveProductLink(supplier, productCode, makerName) {
  const sup = String(supplier || '').trim();
  const code = String(productCode || '').trim();
  if (!sup || !code) return getProductLinks();
  const cur = readUser() || {};
  cur.productLinks = cur.productLinks || {};
  cur.productLinks[sup] = cur.productLinks[sup] || {};
  const name = (makerName == null) ? '' : String(makerName).trim();
  if (!name) {
    delete cur.productLinks[sup][code];
    if (!Object.keys(cur.productLinks[sup]).length) delete cur.productLinks[sup];
  } else {
    cur.productLinks[sup][code] = name;
  }
  saveSettings({ productLinks: cur.productLinks });
  return getProductLinks();
}

// 仕入先マスタを読む（{ 仕入先コード: { name, address, phone, ... } }）
function getSuppliers() {
  const u = readUser() || {};
  return u.suppliers || {};
}

// 仕入先マスタを丸ごと差し替えで保存（マスタCSV取込画面から）。
function saveSuppliers(suppliers) {
  const map = suppliers && typeof suppliers === 'object' ? suppliers : {};
  saveSettings({ suppliers: map });
  return getSuppliers();
}

// 自社販売実績の取込プロファイルを読む
function getSelfProfile() {
  const u = readUser() || {};
  return u.selfProfile || null;
}

// 自社販売実績の取込プロファイルを保存
function saveSelfProfile(profile) {
  saveSettings({ selfProfile: profile || null });
  return getSelfProfile();
}

// コード化レビューの記録を読む（{confirmed, rejected} を正規化して返す）。
function getCdReview() {
  const u = readUser() || {};
  const c = (u.cdReview && typeof u.cdReview === 'object') ? u.cdReview : {};
  return { confirmed: c.confirmed || {}, rejected: c.rejected || {} };
}
// 候補を「確定」：productLinks に登録（↻照合で 手動紐付けに）＋ cdReview.confirmed に メーカー品番を記録（書き戻しCSV用）。
//  同じ候補に対する過去の却下があれば消す。1回の保存にまとめる。
function confirmCdLink(supplier, selfCode, makerCode, makerName) {
  const sup = String(supplier || '').trim();
  const code = String(selfCode || '').trim();
  if (!sup || !code) return getCdReview();
  const mCode = String(makerCode == null ? '' : makerCode).trim();
  const mName = String(makerName == null ? '' : makerName).trim();
  const cur = readUser() || {};
  cur.productLinks = cur.productLinks || {};
  cur.productLinks[sup] = cur.productLinks[sup] || {};
  if (mName) cur.productLinks[sup][code] = mName; // 紐付けはメーカー商品名（既存仕様）で保存
  cur.cdReview = (cur.cdReview && typeof cur.cdReview === 'object') ? cur.cdReview : {};
  cur.cdReview.confirmed = cur.cdReview.confirmed || {};
  cur.cdReview.rejected = cur.cdReview.rejected || {};
  cur.cdReview.confirmed[sup] = cur.cdReview.confirmed[sup] || {};
  cur.cdReview.confirmed[sup][code] = { code: mCode, name: mName, at: new Date().toISOString() };
  if (cur.cdReview.rejected[sup]) delete cur.cdReview.rejected[sup][code + '|' + mCode];
  saveSettings({ productLinks: cur.productLinks, cdReview: cur.cdReview });
  return getCdReview();
}
// 候補を「却下」：cdReview.rejected に記録（候補一覧から消す）。productLinks は触らない。
function rejectCdLink(supplier, selfCode, makerCode) {
  const sup = String(supplier || '').trim();
  const code = String(selfCode || '').trim();
  if (!sup || !code) return getCdReview();
  const mCode = String(makerCode == null ? '' : makerCode).trim();
  const cur = readUser() || {};
  cur.cdReview = (cur.cdReview && typeof cur.cdReview === 'object') ? cur.cdReview : {};
  cur.cdReview.confirmed = cur.cdReview.confirmed || {};
  cur.cdReview.rejected = cur.cdReview.rejected || {};
  cur.cdReview.rejected[sup] = cur.cdReview.rejected[sup] || {};
  cur.cdReview.rejected[sup][code + '|' + mCode] = new Date().toISOString();
  saveSettings({ cdReview: cur.cdReview });
  return getCdReview();
}
// 確定の取消：productLinks と cdReview.confirmed の両方から消す。
function unconfirmCdLink(supplier, selfCode) {
  const sup = String(supplier || '').trim();
  const code = String(selfCode || '').trim();
  if (!sup || !code) return getCdReview();
  const cur = readUser() || {};
  if (cur.productLinks && cur.productLinks[sup]) {
    delete cur.productLinks[sup][code];
    if (!Object.keys(cur.productLinks[sup]).length) delete cur.productLinks[sup];
  }
  if (cur.cdReview && cur.cdReview.confirmed && cur.cdReview.confirmed[sup]) {
    delete cur.cdReview.confirmed[sup][code];
    if (!Object.keys(cur.cdReview.confirmed[sup]).length) delete cur.cdReview.confirmed[sup];
  }
  saveSettings({ productLinks: cur.productLinks || {}, cdReview: cur.cdReview || { confirmed: {}, rejected: {} } });
  return getCdReview();
}

// 得意先 除外設定を読む（{ 得意先名: 除外日時 }）。
function getExcludedCustomers() {
  const u = readUser() || {};
  return (u.excludedCustomers && typeof u.excludedCustomers === 'object') ? u.excludedCustomers : {};
}
// 1得意先の除外/復活。exclude=true で除外（日時記録）、false で復活（記録削除）。他設定は保持。
function setExcludedCustomer(customer, exclude) {
  const name = String(customer || '').trim();
  if (!name) return getExcludedCustomers();
  const cur = readUser() || {};
  cur.excludedCustomers = (cur.excludedCustomers && typeof cur.excludedCustomers === 'object') ? cur.excludedCustomers : {};
  if (exclude) cur.excludedCustomers[name] = new Date().toISOString();
  else delete cur.excludedCustomers[name];
  saveSettings({ excludedCustomers: cur.excludedCustomers });
  return getExcludedCustomers();
}

// 複数得意先の除外/復活を1回の保存でまとめて行う（チェックして一括で隠す用）。
function setExcludedCustomersBulk(names, exclude) {
  const cur = readUser() || {};
  cur.excludedCustomers = (cur.excludedCustomers && typeof cur.excludedCustomers === 'object') ? cur.excludedCustomers : {};
  const now = new Date().toISOString();
  (Array.isArray(names) ? names : []).forEach((n) => {
    const name = String(n || '').trim();
    if (!name) return;
    if (exclude) cur.excludedCustomers[name] = now;
    else delete cur.excludedCustomers[name];
  });
  saveSettings({ excludedCustomers: cur.excludedCustomers });
  return getExcludedCustomers();
}

module.exports = { getSettings, saveSettings, isConfigured, SETTINGS_PATH, backupCurrentSettings, listSettingsBackups, restoreSettingsBackup, BACKUP_DIR, getMakers, saveMakerProfile, getProductLinks, saveProductLink, getSuppliers, saveSuppliers, getSelfProfile, saveSelfProfile, getCdReview, confirmCdLink, rejectCdLink, unconfirmCdLink, getExcludedCustomers, setExcludedCustomer, setExcludedCustomersBulk };
