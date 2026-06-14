// 読み取り専用：得意先×商品の売上明細を URIMEI から直引き（診断用）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../config');

function runQuery(dbCfg, sql) {
  const server = String(dbCfg.server || 'localhost\\OHKEN');
  const database = String(dbCfg.database || '');
  const tmp = os.tmpdir();
  const tag = 'diag_' + process.pid + '_' + Date.now();
  const sqlFile = path.join(tmp, tag + '_q.sql');
  const outFile = path.join(tmp, tag + '_out.csv');
  const paramFile = path.join(tmp, tag + '_p.txt');
  const psFile = path.join(tmp, tag + '.ps1');
  fs.writeFileSync(sqlFile, sql, 'utf8');
  fs.writeFileSync(paramFile, [server, database, sqlFile, outFile].join('\n'), 'utf8');
  const q = (p) => p.replace(/\\/g, '\\\\');
  const script =
    "$ErrorActionPreference='Stop'\n" +
    "$p=[System.IO.File]::ReadAllLines('" + q(paramFile) + "',[System.Text.Encoding]::UTF8)\n" +
    "$server=$p[0]; $db=$p[1]; $sqlf=$p[2]; $outf=$p[3]\n" +
    "$sql=[System.IO.File]::ReadAllText($sqlf,[System.Text.Encoding]::UTF8)\n" +
    "$cs=\"Server=$server;Database=$db;Integrated Security=SSPI;TrustServerCertificate=True;Encrypt=False;Connect Timeout=15;ApplicationIntent=ReadOnly;Application Name=PriceTool-ReadOnly\"\n" +
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
    "foreach($row in $dt.Rows){ $line=foreach($c in $cols){ [string]$row[$c] }; [void]$sb.AppendLine(($line -join ',')) }\n" +
    "[System.IO.File]::WriteAllText($outf, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))\n";
  fs.writeFileSync(psFile, script, 'ascii');
  execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const text = fs.readFileSync(outFile, 'utf8');
  for (const f of [sqlFile, paramFile, psFile, outFile]) { try { fs.unlinkSync(f); } catch (_) {} }
  return text;
}

const tcd = process.argv[2] || '0350';
const pcd = process.argv[3] || '002601';
const dbCfg = config.hanbai.db;

const sql =
  "SELECT TOP 30\n" +
  "  CONVERT(char(10), u.DENDATE, 23) AS dendate,\n" +
  "  u.NO AS denno, u.GYO, u.DSHU,\n" +
  "  u.TANK/10000.0 AS sell, u.SUU/10000.0 AS qty, u.KG AS amt,\n" +
  "  RTRIM(tk.CODE) AS tcd, RTRIM(sh.CODE) AS pcd,\n" +
  "  LEFT(LTRIM(u.NAME), 50) AS name1\n" +
  "FROM dbo.URIMEI u\n" +
  "JOIN dbo.TOKUI tk ON tk.ICODE = u.TOKSHI\n" +
  "JOIN dbo.SHOHIN sh ON sh.ICODE = u.SHO\n" +
  "WHERE RTRIM(tk.CODE) = '" + tcd + "' AND RTRIM(sh.CODE) = '" + pcd + "'\n" +
  "ORDER BY u.DENDATE DESC, u.NO DESC, u.GYO DESC";

console.log('=== URIMEI lines (newest first) ===');
console.log(runQuery(dbCfg, sql));

const { loadHanbaiFromDb } = require('./db_hanbai');
const recs = loadHanbaiFromDb(Object.assign({}, dbCfg, { candidateMonths: 0 }));
const hit = recs.find((r) => String(r.customerCode).trim() === tcd && String(r.productCode).trim() === pcd);
console.log('=== tool aggregate (db_hanbai.js: sell=51/52 only, cost excludes 19/59) ===');
console.log(hit ? JSON.stringify({
  customer: hit.customerName,
  currentSell: hit.currentSell,
  lastDate: hit.lastDate,
  annualAmount: hit.annualAmount,
}, null, 2) : 'not found');