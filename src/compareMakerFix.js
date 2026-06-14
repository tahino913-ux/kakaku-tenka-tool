// 容器メーカー xlsx「（修正）」シートの新売価 vs 照合結果の新仕入単価（商品CD突合）
const fs = require('fs');
const path = require('path');
const { readXlsx } = require('./xlsxread');
const { loadCsv } = require('./csv');
const { sen } = require('./rules');

const ROOT = path.join(__dirname, '..');
const xlsxNew = path.join(ROOT, '日野折箱店様（容器メーカー）.xlsx');
const xlsxOld = path.join(ROOT, 'maker_quotes', '日野折箱店様（容器メーカー）.xlsx');

function latestMatchCsv(supplier) {
  const dir = path.join(ROOT, 'input');
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.csv') || !f.startsWith(supplier + '_照合結果_')) continue;
    const m = f.match(/_照合結果_(\d{8})_(\d{6})\.csv$/);
    if (!m) continue;
    const st = m[1] + m[2];
    if (!best || st > best.st) best = { st, file: path.join(dir, f) };
  }
  return best ? best.file : null;
}

function parseSheet(grid, sheetLabel) {
  const out = new Map();
  let codeCol = 3;
  let nameCol = 4;
  let curCol = 6;
  let newCol = 7;
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    const row = grid[r].map((c) => String(c).replace(/\r?\n/g, '').normalize('NFKC'));
    const joined = row.join('|');
    if (/商品.*CD|品番/.test(joined) && /新/.test(joined)) {
      row.forEach((h, i) => {
        if (/商品.*CD|品番/.test(h)) codeCol = i;
        if (/商品名|品名/.test(h) && !/CD/.test(h)) nameCol = i;
        if (/現/.test(h) && /売価|単価/.test(h)) curCol = i;
        if (/新/.test(h) && /売価|単価/.test(h)) newCol = i;
      });
      for (let ri = r + 1; ri < grid.length; ri++) {
        const g = grid[ri];
        const code = String(g[codeCol] || '').trim();
        if (!code || !/^\d+$/.test(code)) continue;
        const nw = sen(Number(String(g[newCol] || '').replace(/,/g, '')));
        const cur = sen(Number(String(g[curCol] || '').replace(/,/g, '')));
        const name = String(g[nameCol] || '').trim();
        if (!Number.isFinite(nw)) continue;
        out.set(code, { code, name, cur, nw, sheet: sheetLabel });
      }
      return out;
    }
  }
  return out;
}

function loadMatchByCode(csvPath, matchedOnly) {
  const { records } = loadCsv(csvPath);
  const by = new Map();
  for (const r of records) {
    const st = r['照合'] || '';
    if (matchedOnly && !/^[✓📌]/.test(st)) continue;
    const code = String(r['メーカー商品CD'] || '').trim();
    if (!code) continue;
    const nc = sen(Number(r['新仕入単価']));
    const cc = sen(Number(r['現行仕入単価']));
    const entry = {
      code,
      name: r['メーカー商品名'] || '',
      newCost: nc,
      currentCost: cc,
      status: st,
      supplier: r['仕入先（メーカー）'] || '',
      rows: 1,
    };
    if (!by.has(code)) by.set(code, entry);
    else {
      const prev = by.get(code);
      prev.rows++;
      if (Math.abs(prev.newCost - nc) > 0.001) {
        prev.newCostConflict = (prev.newCostConflict || [prev.newCost]).concat(nc);
      }
    }
  }
  return by;
}

function compare(label, xlsxMap, tool, chuOld) {
  const rows = [];
  for (const [code, x] of xlsxMap) {
    const t = tool.get(code);
    if (!t) {
      rows.push({ label, code, name: x.name, xlsxNew: x.nw, toolNew: null, pctDiff: null, note: '照合に無し' });
      continue;
    }
    const pct = x.nw > 0 ? Math.round((t.newCost / x.nw - 1) * 1000) / 10 : null;
    const curPct = x.cur > 0 ? Math.round((t.currentCost / x.cur - 1) * 1000) / 10 : null;
    let note = '';
    if (Math.abs(t.newCost - x.nw) < 0.01) note = '新単価一致';
    else if (pct >= 9 && pct <= 11) note = '新単価:ツール約+10%高い';
    else if (pct <= -9 && pct >= -11) note = '新単価:ツール約-10%低い';
    else if (pct >= 19 && pct <= 21) note = '新単価:ツール約+20%高い';
    else note = '新単価差異';
    if (Math.abs((t.currentCost || 0) - (x.cur || 0)) >= 0.01) {
      note += (note ? '／' : '') + '現単価不一致';
    }
    const old = chuOld ? chuOld.get(code) : null;
    rows.push({
      label,
      code,
      name: x.name,
      xlsxCur: x.cur,
      xlsxNew: x.nw,
      xlsxOld: old ? old.nw : null,
      toolCur: t.currentCost,
      toolNew: t.newCost,
      pctDiff: pct,
      curPctDiff: curPct,
      status: t.status,
      toolRows: t.rows,
      note,
    });
  }
  return rows.sort((a, b) => Math.abs((b.pctDiff || 0)) - Math.abs((a.pctDiff || 0)));
}

function main() {
  const matchCsv = latestMatchCsv('朝日食品容器');
  if (!matchCsv) throw new Error('朝日食品容器の照合結果CSVが見つかりません');

  const { sheets: sheetsNew } = readXlsx(xlsxNew);
  const chuSheet = sheetsNew.find((s) => s.name.includes('中央化学') && s.name.includes('修正'));
  const cpSheet = sheetsNew.find((s) => s.name.includes('CP化成') && s.name.includes('修正'));
  if (!chuSheet || !cpSheet) throw new Error('修正シートが見つかりません');

  const chuNew = parseSheet(chuSheet.grid, '中央化学（修正）');
  const cpNew = parseSheet(cpSheet.grid, 'CP化成（修正）');

  let chuOld = null;
  if (fs.existsSync(xlsxOld)) {
    const { sheets: sheetsOld } = readXlsx(xlsxOld);
    const oldSheet = sheetsOld.find((s) => s.name.includes('中央化学') && !s.name.includes('修正'));
    if (oldSheet) chuOld = parseSheet(oldSheet.grid, '中央化学(旧)');
  }

  const matchedOnly = !process.argv.includes('--all');
  const tool = loadMatchByCode(matchCsv, matchedOnly);
  const all = [
    ...compare('中央化学（修正）', chuNew, tool, chuOld),
    ...compare('CP化成（修正）', cpNew, tool, null),
  ];
  const mismatchNew = all.filter((r) => r.toolNew != null && Math.abs(r.toolNew - r.xlsxNew) >= 0.01);
  const mismatchCur = all.filter((r) => r.toolCur != null && Math.abs(r.toolCur - r.xlsxCur) >= 0.01);
  const hi10 = mismatchNew.filter((r) => r.pctDiff >= 9 && r.pctDiff <= 11);
  const hi20 = mismatchNew.filter((r) => r.pctDiff >= 19 && r.pctDiff <= 21);
  const missing = all.filter((r) => r.toolNew == null);

  console.log('照合CSV:', path.basename(matchCsv), matchedOnly ? '(一致行のみ)' : '(全行・休眠含む)');
  console.log('中央化学（修正）:', chuNew.size, '品');
  console.log('CP化成（修正）:', cpNew.size, '品');
  console.log('照合のユニーク品番:', tool.size);
  console.log('【新単価】修正xlsx vs 照合 不一致:', mismatchNew.length);
  console.log('  約+10%高い(ツール>修正):', hi10.length);
  console.log('  約+20%高い:', hi20.length);
  console.log('【現単価】修正xlsx現行売価 vs 照合現行仕入 不一致:', mismatchCur.length);
  console.log('修正にあるが照合CSVに無い:', missing.length);

  console.log('\n--- 新単価不一致 TOP25 ---');
  for (const r of mismatchNew.slice(0, 25)) {
    const parts = [
      r.label,
      r.code,
      r.note,
      '修正=' + r.xlsxNew,
      r.xlsxOld != null ? '旧=' + r.xlsxOld : '',
      '照合=' + r.toolNew,
      r.pctDiff != null ? '差' + r.pctDiff + '%' : '',
      r.status,
    ].filter(Boolean);
    console.log(parts.join(' | '));
  }

  if (hi10.length) {
    console.log('\n--- 新単価 約+10%高い ---');
    for (const r of hi10) console.log(r.code, r.name, '修正', r.xlsxNew, '照合', r.toolNew, '+' + r.pctDiff + '%');
  }
  if (mismatchCur.length) {
    console.log('\n--- 現単価不一致 TOP25 ---');
    for (const r of mismatchCur.slice(0, 25)) {
      console.log([
        r.label, r.code, r.note,
        'xlsx現=' + r.xlsxCur,
        '照合現=' + r.toolCur,
        r.curPctDiff != null ? '差' + r.curPctDiff + '%' : '',
        r.status,
      ].filter(Boolean).join(' | '));
    }
  }

  const outPath = path.join(ROOT, 'output', '価格比較_容器メーカー修正_vs照合.csv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const hdr = 'シート,商品CD,商品名,修正_現行売価,修正_新売価,旧xlsx_新売価,照合_現仕入,照合_新仕入,新単価差%,現単価差%,照合状態,備考';
  const lines = all.map((r) => [
    r.label,
    r.code,
    '"' + (r.name || '').replace(/"/g, '""') + '"',
    r.xlsxCur ?? '',
    r.xlsxNew,
    r.xlsxOld ?? '',
    r.toolCur ?? '',
    r.toolNew ?? '',
    r.pctDiff ?? '',
    r.curPctDiff ?? '',
    r.status || '',
    r.note,
  ].join(','));
  fs.writeFileSync(outPath, '\uFEFF' + hdr + '\n' + lines.join('\n'), 'utf8');
  console.log('\nCSV:', outPath);

  if (chuOld) {
    let oldBad = 0;
    for (const [code, x] of chuNew) {
      const o = chuOld.get(code);
      if (!o || Math.abs(o.nw - x.nw) < 0.01) continue;
      oldBad++;
      if (oldBad <= 5) {
        const pct = Math.round((o.nw / x.nw - 1) * 1000) / 10;
        console.log('旧xlsx≠修正', code, '旧', o.nw, '修正', x.nw, '差', pct + '%');
      }
    }
    console.log('旧xlsx(6.1中央化学)と修正で価格が違う品:', oldBad, '/', chuNew.size);
  }
  const chuCsv = path.join(ROOT, 'maker_quotes', '中央化学.csv');
  if (fs.existsSync(chuCsv)) {
    const { records: mc } = loadCsv(chuCsv);
    let csvBad = 0;
    for (const [code, x] of chuNew) {
      const row = mc.find((r) => String(r['メーカー商品CD'] || r['メーカー品番'] || '').trim() === code);
      if (!row) continue;
      const nc = sen(Number(row['新単価'] || row['新仕入単価']));
      if (Math.abs(nc - x.nw) < 0.01) continue;
      csvBad++;
      if (csvBad <= 5) {
        const pct = Math.round((nc / x.nw - 1) * 1000) / 10;
        console.log('中央化学.csv≠修正', code, 'csv', nc, '修正', x.nw, '差', pct + '%');
      }
    }
    console.log('maker_quotes/中央化学.csv が修正と違う品:', csvBad, '/', chuNew.size);
  }
}

if (require.main === module) main();
module.exports = { parseSheet, compare, loadMatchByCode };
