// input/ の照合結果CSVを整理：仕入先ごと最新1本だけ残し、古いものは input/_old/ へ退避（削除ではない）。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'input');
const OLD_DIR = path.join(INPUT_DIR, '_old');

// server.listLatestCsv と同規則で「残すファイル名」を決める。
function pickInputRetention(dir) {
  if (!fs.existsSync(dir)) return { keep: new Set(), stale: [], latestBySupplier: new Map(), other: [] };
  const latest = new Map();
  const other = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.csv')) continue;
    const m = f.match(/^(.+?)_照合結果_(\d{8})_(\d{4,6})\.csv$/i);
    if (!m) { other.push(f); continue; }
    const supplier = m[1];
    const stamp = m[2] + '_' + m[3].padEnd(6, '0');
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) {}
    const cur = latest.get(supplier);
    if (!cur || cur.stamp < stamp || (cur.stamp === stamp && cur.mtime < mtime)) {
      latest.set(supplier, { file: f, stamp, mtime });
    }
  }
  const keep = new Set(other);
  for (const v of latest.values()) keep.add(v.file);
  const all = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
  const stale = all.filter((f) => !keep.has(f));
  return { keep, stale, latestBySupplier: latest, other };
}

// 古い照合CSVを input/_old/ へ移動。dryRun=true なら件数だけ返す。
function pruneInputCsv(opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const minStale = Number.isFinite(Number(opts.minStale)) ? Number(opts.minStale) : 1;
  const { keep, stale, latestBySupplier } = pickInputRetention(INPUT_DIR);
  if (stale.length < minStale) {
    return {
      ok: true, moved: 0, kept: keep.size, stale: stale.length,
      suppliers: latestBySupplier.size, skipped: true,
    };
  }
  if (!dryRun) fs.mkdirSync(OLD_DIR, { recursive: true });
  let moved = 0;
  const errors = [];
  for (const f of stale) {
    const src = path.join(INPUT_DIR, f);
    let dest = path.join(OLD_DIR, f);
    if (!dryRun && fs.existsSync(dest)) {
      const base = f.replace(/\.csv$/i, '');
      dest = path.join(OLD_DIR, base + '_dup' + Date.now() + '.csv');
    }
    if (dryRun) { moved++; continue; }
    try {
      fs.renameSync(src, dest);
      moved++;
    } catch (e) {
      errors.push({ file: f, error: String(e && e.message || e) });
    }
  }
  return {
    ok: errors.length === 0,
    moved, kept: keep.size, stale: stale.length,
    suppliers: latestBySupplier.size, errors,
  };
}

if (require.main === module) {
  const dry = process.argv.includes('--dry-run');
  const r = pruneInputCsv({ dryRun: dry });
  if (dry) {
    console.log('dry-run: 退避対象 ' + r.stale + ' 件 / 残す ' + r.kept + ' 件（仕入先 ' + r.suppliers + '）');
  } else if (r.skipped) {
    console.log('整理不要（退避対象 ' + r.stale + ' 件）');
  } else {
    console.log('✓ 古い照合CSV ' + r.moved + ' 件を input/_old/ へ退避（最新 ' + r.kept + ' 本を残しました）');
    if (r.errors && r.errors.length) {
      for (const e of r.errors) console.log('  ⚠ ' + e.file + ': ' + e.error);
    }
  }
}

module.exports = { pruneInputCsv, pickInputRetention, INPUT_DIR, OLD_DIR };
