// =====================================================================
//  AI 取り込みアシスト（任意・既定OFF）  ── 依存ゼロ（Node標準 https のみ）
// ---------------------------------------------------------------------
//  メーカー見積（崩れたExcel・PDF手紙・貼り付けテキスト）から
//  「メーカー品番／商品名／規格／現単価／新単価／切替日」を Claude API で抽出し、
//  取り込み画面(/import)の確認グリッドに流し込むための 2次元配列を返す。
//
//  ★ 設計の鉄則（価格に関わるツールなので厳守）
//   - AIは「抽出・提案」だけ。確定は従来どおり ③確認グリッド＋人。
//   - 価格計算・照合・見積書出力には一切関与しない（match.js / rules.js は無改造）。
//   - AIに数字を創作させない：抽出した単価は元テキストに在るか検証し、無ければ警告。
//   - 既定OFF：apiKey 未設定なら呼ばれない＝外部送信ゼロ・完全ローカルのまま。
//
//  ★ 隔離方針：外部APIへ出るのは このファイルだけ（xls2csv.js が Excel依存を
//    隔離しているのと同じ思想）。クラウド/他社版は ai.enabled=false のまま。
// =====================================================================
const https = require('https');
const { getSettings } = require('./settings');

const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 16000;          // 非ストリーミングの安全圏（これ以上はSDK/HTTPタイムアウト懸念）
const TIMEOUT_MS = 120000;

// 実効AI設定を返す。apiKey は settings.json 優先、無ければ環境変数 ANTHROPIC_API_KEY。
function getAiConfig() {
  let ai = {};
  try { ai = (getSettings() || {}).ai || {}; } catch (_) { ai = {}; }
  const apiKey = String(ai.apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  return {
    enabled: !!ai.enabled && !!apiKey,
    rawEnabled: !!ai.enabled,
    apiKey,
    model: String(ai.model || 'claude-haiku-4-5'),
    hardModel: String(ai.hardModel || 'claude-sonnet-4-6'),
  };
}

function isEnabled() { return getAiConfig().enabled; }

// 画面向けの状態（キー本体は返さない）。
function status() {
  const c = getAiConfig();
  return { enabled: c.enabled, rawEnabled: c.rawEnabled, hasKey: !!c.apiKey, model: c.model, hardModel: c.hardModel };
}

// Claude Messages API を生HTTPSで1回呼ぶ（SDK不要）。
//  body は Messages API の本体そのもの。成功でパース済みJSON、失敗でreject。
function callMessages(apiKey, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: API_HOST,
      path: API_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (_) { /* 非JSON応答 */ }
        if (res.statusCode >= 400) {
          const msg = (j && j.error && j.error.message) || (buf || '').slice(0, 300);
          return reject(new Error('AI APIエラー(HTTP ' + res.statusCode + '): ' + msg));
        }
        if (!j) return reject(new Error('AI応答の解析に失敗しました（HTTP ' + res.statusCode + '）'));
        resolve(j);
      });
    });
    req.on('error', (e) => reject(new Error('AI API 通信失敗: ' + (e && e.message || e))));
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('AI API タイムアウト（' + (TIMEOUT_MS / 1000) + '秒）')); });
    req.write(data);
    req.end();
  });
}

// 応答からテキストを連結（content[] の text ブロックのみ）。
function joinText(resp) {
  const blocks = (resp && resp.content) || [];
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
}

// AI出力テキストから JSON を頑強に取り出す（```json フェンスや前後の文を許容）。
function parseJsonLoose(text) {
  let s = String(text || '').trim();
  // ```json ... ``` フェンス除去
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  // 最初の { から最後の } までを試す
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { /* fall through */ }
  }
  return null;
}

// 抽出用システムプロンプト（安定＝先頭に置きキャッシュ対象にできる）。
const SYSTEM_PROMPT =
  'あなたはメーカーからの「価格改定見積（値上げ通知）」を読み取り、商品明細を構造化するアシスタントです。\n' +
  '入力（Excel表・PDFの手紙/表・貼り付けテキスト）から、価格改定の対象となる「商品の明細行」だけを抽出してください。\n' +
  '\n' +
  '【抽出する各行のフィールド】\n' +
  '- makerCode: メーカー品番/商品コード（無ければ空文字）\n' +
  '- productName: メーカー商品名（必須。これが無い行は出力しない）\n' +
  '- spec: 規格/サイズ/入数など（無ければ空文字）\n' +
  '- currentPrice: 現行単価（改定前）。書かれている数字をそのまま文字列で。無ければ空文字\n' +
  '- newPrice: 改定後単価（値上げ後）。書かれている数字をそのまま文字列で。無ければ空文字\n' +
  '- effectiveDate: 実施日/切替日。書式は問わない（例 2026-07-01 / 7月1日～）。\n' +
  '  手紙全体で1つの実施日しか書かれていない場合は、全行に同じ実施日を入れてください。無ければ空文字\n' +
  '\n' +
  '【厳守】\n' +
  '1. 数字は入力に書かれている値だけを使う。推測・計算・創作をしない。読み取れない値は空文字にする。\n' +
  '2. 挨拶文・前書き・合計行・小計・備考・ページ番号など、商品明細でないものは出力しない。\n' +
  '3. 通貨記号・カンマは取り除いてよい（例「¥1,234」→「1234」）が、数値そのものは変えない。\n' +
  '4. 出力は JSON のみ。前後に説明文やコードフェンスを付けない。\n' +
  '\n' +
  '【出力形式】 {"rows":[{"makerCode":"","productName":"","spec":"","currentPrice":"","newPrice":"","effectiveDate":""}, ...]}';

// 取り込みグリッド用の見出し（loadRows が受け取り、列の意味を自動推測する）。
const HEADER = ['メーカー品番', 'メーカー商品名', '規格', '現単価', '新単価', '切替日'];

// rows(オブジェクト配列) → 2次元配列（先頭=見出し）に変換。
function rowsToGrid(rows) {
  const out = [HEADER.slice()];
  for (const r of (rows || [])) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.productName || '').trim();
    if (!name) continue; // 商品名が無い行は捨てる（明細でない可能性）
    out.push([
      String(r.makerCode || '').trim(),
      name,
      String(r.spec || '').trim(),
      String(r.currentPrice || '').trim(),
      String(r.newPrice || '').trim(),
      String(r.effectiveDate || '').trim(),
    ]);
  }
  return out;
}

// 数字の創作チェック：rows の単価が元テキストに現れるか確認し、見つからない件数を返す。
//  （テキスト入力のときだけ実施。PDFは原文テキストが無いので検証不可。）
function verifyNumbers(rows, sourceText) {
  if (!sourceText) return { checked: false, missing: 0 };
  const digitsIn = String(sourceText).replace(/[^0-9]/g, ' ');
  const has = (v) => {
    const core = String(v || '').replace(/[^0-9]/g, '');
    if (!core) return true; // 空欄は対象外
    return digitsIn.indexOf(core) >= 0;
  };
  let missing = 0;
  for (const r of (rows || [])) {
    if (!has(r.newPrice)) missing++;
    if (!has(r.currentPrice)) missing++;
  }
  return { checked: true, missing };
}

// メーカー見積を抽出する本体。
//  opts: { supplier, text?, pdfB64? }（text か pdfB64 のどちらか必須）
//  戻り: { ok, rows:2次元配列, count, model, warnings:[文字列], usage }
async function extractMakerQuote(opts) {
  opts = opts || {};
  const cfg = getAiConfig();
  if (!cfg.rawEnabled) return { ok: false, error: 'AI取り込みは設定で無効です（settings.json の ai.enabled）。' };
  if (!cfg.apiKey) return { ok: false, error: 'APIキーが未設定です（settings.json の ai.apiKey か 環境変数 ANTHROPIC_API_KEY）。' };

  const text = (opts.text != null) ? String(opts.text) : '';
  const pdfB64 = opts.pdfB64 ? String(opts.pdfB64) : '';
  if (!text.trim() && !pdfB64) return { ok: false, error: '読み取る内容（貼り付けテキスト か PDF）がありません。' };

  // PDF は難物（手紙形式が多い）→ hardModel、テキスト/Excelは安価な model。
  const model = pdfB64 ? cfg.hardModel : cfg.model;

  const userContent = [];
  const supplierNote = opts.supplier ? ('仕入先（メーカー）名: ' + String(opts.supplier).trim() + '\n') : '';
  if (pdfB64) {
    userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } });
    userContent.push({ type: 'text', text: supplierNote + '上のPDFから価格改定の商品明細を抽出し、指定のJSON形式だけで返してください。' });
  } else {
    userContent.push({ type: 'text', text: supplierNote + '次の内容から価格改定の商品明細を抽出し、指定のJSON形式だけで返してください。\n\n----\n' + text + '\n----' });
  }

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  };

  const resp = await callMessages(cfg.apiKey, body);
  const warnings = [];
  if (resp.stop_reason === 'max_tokens') {
    warnings.push('出力が上限に達したため、明細が途中までの可能性があります（件数が多い見積は分割してお試しください）。');
  }
  if (resp.stop_reason === 'refusal') {
    return { ok: false, error: 'AIが応答を拒否しました（入力内容をご確認ください）。', model };
  }

  const out = parseJsonLoose(joinText(resp));
  if (!out || !Array.isArray(out.rows)) {
    return { ok: false, error: 'AIの応答を表として解釈できませんでした。お手数ですが手動の取り込みをご利用ください。', model };
  }

  // 数字の創作チェック（テキスト入力時のみ）
  const vr = verifyNumbers(out.rows, text);
  if (vr.checked && vr.missing > 0) {
    warnings.push('元データに見当たらない単価が ' + vr.missing + ' 箇所あります。③の表で必ず数字をご確認ください（赤字や空欄を優先確認）。');
  }
  if (pdfB64) {
    warnings.push('PDFからの抽出は原文との自動照合ができません。③の表で単価・実施日を必ずご確認ください。');
  }

  const grid = rowsToGrid(out.rows);
  const count = Math.max(0, grid.length - 1);
  if (!count) return { ok: false, error: '商品明細を1件も抽出できませんでした。手動の取り込みをご利用ください。', model, warnings };

  return { ok: true, rows: grid, count, model, warnings, usage: resp.usage || null };
}

module.exports = { isEnabled, status, getAiConfig, extractMakerQuote, callMessages };
