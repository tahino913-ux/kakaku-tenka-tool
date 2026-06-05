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

function readUser() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return null;
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8') || '{}');
  } catch (e) {
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
  };
}

// 画面から来た編集内容を settings.json に保存（既存とマージ）。
function saveSettings(patch) {
  patch = patch || {};
  const cur = readUser() || {};
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
    _savedAt:       new Date().toISOString(),
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
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

module.exports = { getSettings, saveSettings, isConfigured, SETTINGS_PATH, getMakers, saveMakerProfile, getProductLinks, saveProductLink, getSuppliers, saveSuppliers, getSelfProfile, saveSelfProfile };
