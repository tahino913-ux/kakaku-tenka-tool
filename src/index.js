const fs = require('fs');
const path = require('path');
const { loadAndNormalize } = require('./load');
const { calcRow } = require('./rules');
const { writeXlsx } = require('./xlsx');
const config = require('./settings').getSettings();

const ROOT = path.join(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'input');
const OUTPUT_DIR = path.join(ROOT, 'output');

async function processFile(inputPath, outputPath) {
  const { recs } = loadAndNormalize(inputPath);
  const rows = recs.map((r) => calcRow(r, config))
    .sort((a, b) => String(a.customerName || '').localeCompare(String(b.customerName || ''), 'ja'));
  await writeXlsx(rows, outputPath, { source: path.basename(inputPath) });
  return rows;
}

function findInputs(argPath) {
  if (argPath) return [path.resolve(argPath)];
  if (!fs.existsSync(INPUT_DIR)) return [];
  return fs.readdirSync(INPUT_DIR)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => path.join(INPUT_DIR, f));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n, '　');
}

function printPreview(rows) {
  const n = Math.min(rows.length, 5);
  if (!n) return;
  console.log(`     --- プレビュー（先頭${n}件） ---`);
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    console.log(
      `     ${trunc(r.customerName, 10)}｜${trunc(r.productName, 16)}｜仕入 ${f(r.currentCost)}→${f(r.newCost)}` +
      `｜売 ${f(r.currentSell)}→${f(r.newSell)}｜粗利 ${f(r.currentMarginRate, 1)}%→${f(r.newMarginRate, 1)}%｜${r.ruleType}`
    );
  }
}

async function main() {
  console.log('=== 価格転嫁見積ツール ===');
  const inputs = findInputs(process.argv[2]);
  if (!inputs.length) {
    console.log('入力CSVが見つかりません。');
    console.log('  ・input フォルダに「○○_照合結果.csv」を入れて run.bat を実行する');
    console.log('  ・または: node src/index.js <CSVファイルのパス>');
    return;
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const inp of inputs) {
    const base = path.basename(inp).replace(/\.csv$/i, '');
    const out = path.join(OUTPUT_DIR, `${base}_見積_${stamp()}.xlsx`);
    try {
      const rows = await processFile(inp, out);
      console.log(`✓ ${path.basename(inp)}  →  output/${path.basename(out)}  (${rows.length}件)`);
      printPreview(rows);
    } catch (e) {
      console.error(`✗ ${path.basename(inp)} の処理に失敗:\n     ${e.message}`);
    }
  }
  console.log('完了しました。output フォルダの Excel を確認してください。');
}

main().catch((e) => { console.error(e); process.exit(1); });
