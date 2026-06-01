// =====================================================================
//  販売実績ローダ（販売大臣 SQL Server 直結・読み取り専用）
//   ・毎回の手動エクスポートを廃止し、SQL Server から直接「現在の販売実績」を取得する。
//   ・⚠ SELECT のみ。会計DBへ INSERT/UPDATE/DELETE/DDL は一切発行しない。
//   ・Node標準だけでは SQL Server に繋げないため、PowerShell(.NET SqlClient) を介する。
//     → Excel依存を xls2csv.js に隔離したのと同じ「隔離オプション」設計。
//        クラウド/他社版では使わず（config.hanbai.source='file' のまま）、本ファイルは未使用。
//   ・戻り値は hanbai.js:parseHanbai と同じレコード形（下流 match.js / server.calcAll が無改造で使える）。
//
//   データモデル（HBDATA0001_001C）:
//     URIMEI=売上明細（SUU/TANK/BTANK は ×10000 格納＝/10000 で実値。KG=金額は素の円）。
//     得意先×商品(自社CD)で集計：現売単価=最新DENDATE行のTANK、年間金額=期間内SUM(KG)。
//     TOKSHI→TOKUI(得意先)、SHO→SHOHIN(自社CD)、SHIIRE→SHIIRE(仕入先CD) を ICODE で結合。
// =====================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { nfkc, normName } = require('./textnorm');
const { coreName } = require('./hanbai');
const { toNum } = require('./rules');

// CD照合用の正規化（hanbai.js と同一規則：区切り空白を1個残す）
function normForCode(s) {
  return nfkc(String(s == null ? '' : s)).toLowerCase().replace(/\s+/g, ' ').trim();
}

// 既定の集計期間（約13か月のローリング窓）。dbCfg.start/end があればそれを優先。
function defaultRange() {
  const d = new Date();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); // 明日（今日を含める）
  const start = new Date(d.getFullYear(), d.getMonth() - 13, 1);        // 13か月前の月初
  const iso = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  return { start: iso(start), end: iso(end) };
}

// 読み取り専用の集計SQLを組み立てる（パラメータは検証済みの定数のみ＝SQLインジェクション面なし）。
function buildSql(start, end, scale) {
  const sc = Number(scale) || 10000;
  return `;WITH base AS (
  SELECT u.TOKSHI, u.SHO, u.DENDATE, u.NO, u.GYO,
         u.TANK/${sc}.0 AS sell, u.BTANK/${sc}.0 AS cost, u.KG AS amt,
         LTRIM(RTRIM(ISNULL(u.NAME,'')))
           + CASE WHEN LTRIM(RTRIM(ISNULL(u.NAME2,''))) = '' THEN '' ELSE ' ' + LTRIM(RTRIM(u.NAME2)) END
           + CASE WHEN LTRIM(RTRIM(ISNULL(u.NAME3,''))) = '' THEN '' ELSE ' ' + LTRIM(RTRIM(u.NAME3)) END
           + CASE WHEN LTRIM(RTRIM(ISNULL(u.NAME4,''))) = '' THEN '' ELSE ' ' + LTRIM(RTRIM(u.NAME4)) END
           + CASE WHEN LTRIM(RTRIM(ISNULL(u.NAME5,''))) = '' THEN '' ELSE ' ' + LTRIM(RTRIM(u.NAME5)) END AS pname,
         u.SHIIRE AS shiicode
  FROM dbo.URIMEI u
  WHERE u.DENDATE >= '${start}' AND u.DENDATE < '${end}'
),
latest AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY TOKSHI, SHO ORDER BY DENDATE DESC, NO DESC, GYO DESC) AS rn
  FROM base
),
agg AS ( SELECT TOKSHI, SHO, SUM(amt) AS annual FROM base GROUP BY TOKSHI, SHO )
SELECT
  RTRIM(tk.CODE) AS tcd, RTRIM(sh.CODE) AS pcd,
  l.sell AS sell, a.annual AS amt, l.cost AS cost,
  CONVERT(char(10), l.DENDATE, 23) AS lastdate,
  RTRIM(ISNULL(si.CODE,'')) AS scd,
  RTRIM(ISNULL(tk.NM1,'')) AS cname,
  l.pname AS pname
FROM latest l
JOIN agg a ON a.TOKSHI = l.TOKSHI AND a.SHO = l.SHO
LEFT JOIN dbo.TOKUI  tk ON tk.ICODE = l.TOKSHI
LEFT JOIN dbo.SHOHIN sh ON sh.ICODE = l.SHO
LEFT JOIN dbo.SHIIRE si ON si.ICODE = l.shiicode
WHERE l.rn = 1
  AND RTRIM(ISNULL(tk.CODE,'')) <> '' AND RTRIM(ISNULL(tk.CODE,'')) <> '0000'  -- 諸口(0000)・得意先未設定は除外
  AND RTRIM(ISNULL(sh.CODE,'')) <> ''                                          -- 自社CDが無い行は除外`;
}

// PowerShell(.NET SqlClient) で SQL を実行し、結果CSV(UTF-8)のパスを返す。SELECT のみ。
function runQueryToCsv(dbCfg, sql) {
  const server = String(dbCfg.server || 'localhost\\OHKEN');
  const database = String(dbCfg.database || '');
  if (!database) throw new Error('config.hanbai.db.database（販売大臣のDB名）が未設定です');
  const tmp = os.tmpdir();
  const tag = 'dbhanbai_' + process.pid + '_' + Date.now();
  const sqlFile = path.join(tmp, tag + '_q.sql');
  const outFile = path.join(tmp, tag + '_out.csv');
  const paramFile = path.join(tmp, tag + '_p.txt'); // 1:server 2:db 3:sqlfile 4:outfile（日本語なし・各行UTF8）
  const psFile = path.join(tmp, tag + '.ps1');
  fs.writeFileSync(sqlFile, sql, 'utf8');
  fs.writeFileSync(paramFile, [server, database, sqlFile, outFile].join('\n'), 'utf8');

  const q = (p) => p.replace(/\\/g, '\\\\'); // TEMP配下=ASCII。.ps1内Windowsパス用
  // ⚠ 読み取り専用。Application Intent=ReadOnly を付け、SELECT 以外は発行しない。
  const script =
    "$ErrorActionPreference='Stop'\n" +
    "$p=[System.IO.File]::ReadAllLines('" + q(paramFile) + "',[System.Text.Encoding]::UTF8)\n" +
    "$server=$p[0]; $db=$p[1]; $sqlf=$p[2]; $outf=$p[3]\n" +
    "$sql=[System.IO.File]::ReadAllText($sqlf,[System.Text.Encoding]::UTF8)\n" +
    "$cs=\"Server=$server;Database=$db;Integrated Security=SSPI;TrustServerCertificate=True;Encrypt=False;Connect Timeout=15;Application Name=PriceTool-ReadOnly\"\n" +
    "$cn=New-Object System.Data.SqlClient.SqlConnection $cs\n" +
    "$cn.Open()\n" +
    "try {\n" +
    "  $cmd=$cn.CreateCommand(); $cmd.CommandText=$sql; $cmd.CommandTimeout=180\n" +
    "  $da=New-Object System.Data.SqlClient.SqlDataAdapter $cmd\n" +
    "  $dt=New-Object System.Data.DataTable; [void]$da.Fill($dt)\n" +
    "} finally { $cn.Close() }\n" +
    "$cols=@($dt.Columns | ForEach-Object { $_.ColumnName })\n" +
    "$sb=New-Object System.Text.StringBuilder\n" +
    "[void]$sb.AppendLine(($cols -join ','))\n" +
    "function Q($v){ $s=[string]$v; if($s -match '[\",\\r\\n]'){ '\"'+$s.Replace('\"','\"\"')+'\"' } else { $s } }\n" +
    "foreach($row in $dt.Rows){ $line=foreach($c in $cols){ Q $row[$c] }; [void]$sb.AppendLine(($line -join ',')) }\n" +
    "[System.IO.File]::WriteAllText($outf, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))\n";
  fs.writeFileSync(psFile, script, 'ascii');

  try {
    execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString() : '') || e.message;
    throw new Error('販売大臣DBからの読み取りに失敗しました（SQL Serverに接続できません）。\n' +
      'config.hanbai.db の server/database を確認してください（指定: ' + server + ' / ' + database + '）。\n' + msg);
  } finally {
    for (const f of [sqlFile, paramFile, psFile]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  if (!fs.existsSync(outFile)) throw new Error('DB読み取りの出力CSVが見つかりません: ' + outFile);
  return outFile;
}

// 結果CSV → parseHanbai と同じレコード配列に変換
function csvToRecords(csvPath) {
  const { parseCsvText } = require('./csv');
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const rows = parseCsvText(text);
  if (!rows.length) return [];
  const head = rows[0]; const ix = {}; head.forEach((h, i) => ix[String(h).trim()] = i);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const tcd = String(r[ix.tcd] == null ? '' : r[ix.tcd]).trim();
    const pcd = String(r[ix.pcd] == null ? '' : r[ix.pcd]).trim();
    const pname = String(r[ix.pname] == null ? '' : r[ix.pname]).trim();
    if (!pcd && !pname) continue;
    const scd = String(r[ix.scd] == null ? '' : r[ix.scd]).trim();
    out.push({
      customerCode: tcd,
      customerName: String(r[ix.cname] == null ? '' : r[ix.cname]).trim(),
      productCode: pcd,
      productName: pname,                       // 自社CDを除いた本文（NAME+NAME2..5 連結＝埋込品番込み）
      currentSell: toNum(r[ix.sell]),
      annualAmount: toNum(r[ix.amt]),
      origCost: toNum(r[ix.cost]),
      lastDate: String(r[ix.lastdate] == null ? '' : r[ix.lastdate]).trim(),
      norm: normName(pname),
      codeNorm: normForCode(pname),
      coreNorm: normName(coreName(pname)),
      // 仕入先コード：DB結合の実値(4桁)を優先。空なら従来の末尾数字推定にフォールバック。
      purchaseCode: scd ? scd.padStart(4, '0') : require('./hanbai').trailingPurchaseCode(pname),
    });
  }
  return out;
}

// 公開API：DB設定を受け取り、販売実績レコード配列を返す（読み取り専用）。
function loadHanbaiFromDb(dbCfg) {
  dbCfg = dbCfg || {};
  const range = defaultRange();
  const start = dbCfg.start || range.start;
  const end = dbCfg.end || range.end;
  const sql = buildSql(start, end, dbCfg.scale);
  const csv = runQueryToCsv(dbCfg, sql);
  try { return csvToRecords(csv); }
  finally { try { fs.unlinkSync(csv); } catch (_) {} }
}

module.exports = { loadHanbaiFromDb, buildSql, csvToRecords, defaultRange };
