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
//     得意先×商品(自社CD)で集計：現売単価=最新の実売上(51/52)行のTANK、原単価=19/59除外の最新BTANK、年間金額=51+52のSUM(KG)。
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

// 既定の集計期間（月単位のローリング窓・過去約1年）。dbCfg.start/end があればそれを優先。
//  ※ 境界を月初に揃えているので「日が変わっても動かず、月が替わったときだけ1か月ぶん前へずれる」。
//     start = 12か月前の月初／end = 翌月の1日（＝当月末までを含む・排他上限）。
//     例: 2026年6月のどの日でも 2025-06-01 〜 2026-07-01（13か月分・当月含む）で一定。7月になると1か月ずれる。
function defaultRange() {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth();
  const start = new Date(y, m - 12, 1);  // 12か月前の月初（過去約1年）
  const end = new Date(y, m + 1, 1);     // 翌月の1日（当月末まで含める排他上限）
  const iso = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  return { start: iso(start), end: iso(end) };
}
// さかのぼり月数 → 開始日(ISO・月初)。defaultRange と同じ流儀（当月から months か月前の月初）。
//  照合の「候補に含める期間」用。12〜60に丸める（1年〜5年）。
function monthsBackStart(months) {
  const m = Math.max(12, Math.min(60, Math.round(Number(months) || 12)));
  const d = new Date();
  const s = new Date(d.getFullYear(), d.getMonth() - m, 1);
  return s.getFullYear() + '-' + String(s.getMonth() + 1).padStart(2, '0') + '-' + String(s.getDate()).padStart(2, '0');
}

// 伝票種(DSHU)の扱い（販売大臣・日野運用）
//  51=売上 / 52=現金売  … 実売上（現売単価・年間金額の対象）
//  59=区分別売上（仮）  … 消込等の仮計上。実績に反映しない＝拾わない
//  19=区分別仕入（仮）  … 仕入側の仮計上。原単価の参照から除外
const DSHU_ACTUAL_SELL = '51, 52';
const DSHU_EXCLUDE_COST = '19, 59';

//  candidateStart..end = 照合の候補に含める期間（さかのぼり可変）。この間に売上があれば候補に出る。
//  annualStart..end    = 年間金額(損益)の集計期間（常に直近約1年）。候補期間を延ばしても損益は歪まない。
function buildSql(candidateStart, end, annualStart, scale) {
  // 「SELECTのみ」を堅牢化：SQLに埋め込む日付は必ず ISO(YYYY-MM-DD) だけ許可する。
  //  settings.json の hanbai.db.start/end は検証なしでマージされるため、不正値での文字列連結（SQL injection）を
  //  ここで遮断する＝販売大臣DBへ書込み系SQLが渡る経路を断つ。正常な日付は常に通る。
  const isIso = (s) => {
    const t = String(s == null ? '' : s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
    const mo = Number(t.slice(5, 7)), da = Number(t.slice(8, 10));
    return mo >= 1 && mo <= 12 && da >= 1 && da <= 31;
  };
  if (!isIso(candidateStart) || !isIso(end) || !isIso(annualStart)) {
    throw new Error('期間(日付)が不正です（YYYY-MM-DD のみ）。settings.json の hanbai.db.start/end を確認してください。');
  }
  const sc = Number(scale) || 10000;
  return `;WITH base AS (
  SELECT u.TOKSHI, u.SHO, u.DENDATE, u.NO, u.GYO, u.DSHU,
         u.TANK/${sc}.0 AS sell, u.BTANK/${sc}.0 AS cost, u.KG AS amt,
         LTRIM(RTRIM(ISNULL(u.NAME,'')))
           + CASE WHEN LTRIM(RTRIM(ISNULL(u.NAME2,''))) = '' THEN '' ELSE ' ' + LTRIM(RTRIM(u.NAME2)) END
           + CASE WHEN LTRIM(RTRIM(ISNULL(u.NAME3,''))) = '' THEN '' ELSE ' ' + LTRIM(RTRIM(u.NAME3)) END
           + CASE WHEN LTRIM(RTRIM(ISNULL(u.NAME4,''))) = '' THEN '' ELSE ' ' + LTRIM(RTRIM(u.NAME4)) END
           + CASE WHEN LTRIM(RTRIM(ISNULL(u.NAME5,''))) = '' THEN '' ELSE ' ' + LTRIM(RTRIM(u.NAME5)) END AS pname,
         u.SHIIRE AS shiicode
  FROM dbo.URIMEI u
  WHERE u.DENDATE >= '${candidateStart}' AND u.DENDATE < '${end}'
),
latest_sell AS (
  -- 現売単価＝得意先×商品の最新「実売上」行(51/52)のTANK。59(区分別・仮売上)は除外。
  SELECT TOKSHI, SHO, DENDATE, NO, GYO, sell, pname, shiicode,
    ROW_NUMBER() OVER (PARTITION BY TOKSHI, SHO ORDER BY DENDATE DESC, NO DESC, GYO DESC) AS rn
  FROM base
  WHERE DSHU IN (${DSHU_ACTUAL_SELL}) AND sell > 0
),
latest_cost AS (
  -- 原単価＝最新の実績行のBTANK。19(区分別仕入・仮)と59(区分別売上・仮)は除外。
  SELECT TOKSHI, SHO, cost,
    ROW_NUMBER() OVER (PARTITION BY TOKSHI, SHO ORDER BY DENDATE DESC, NO DESC, GYO DESC) AS rn
  FROM base
  WHERE DSHU NOT IN (${DSHU_EXCLUDE_COST}) AND cost > 0
),
-- 年間金額＝期間内の 売上(51)＋現金売(52) の KG 合計（59区分別・仮は含めない）。
--  ※実測：51+52=83.2%が現行エクスポートの年間金額に最も合う。
agg AS ( SELECT TOKSHI, SHO, SUM(CASE WHEN DSHU IN (${DSHU_ACTUAL_SELL}) AND DENDATE >= '${annualStart}' THEN amt ELSE 0 END) AS annual FROM base GROUP BY TOKSHI, SHO )
SELECT
  RTRIM(tk.CODE) AS tcd, RTRIM(sh.CODE) AS pcd,
  ls.sell AS sell, a.annual AS amt, ISNULL(lc.cost, 0) AS cost,
  CONVERT(char(10), ls.DENDATE, 23) AS lastdate,
  RTRIM(ISNULL(si.CODE,'')) AS scd,
  RTRIM(ISNULL(tk.NM1,'')) AS cname,
  RTRIM(ISNULL(sh.NM1,'')) AS sname,
  ls.pname AS pname,
  RTRIM(ISNULL(sh.NM3,'')) AS mname
FROM latest_sell ls
JOIN agg a ON a.TOKSHI = ls.TOKSHI AND a.SHO = ls.SHO
LEFT JOIN latest_cost lc ON lc.TOKSHI = ls.TOKSHI AND lc.SHO = ls.SHO AND lc.rn = 1
LEFT JOIN dbo.TOKUI  tk ON tk.ICODE = ls.TOKSHI
LEFT JOIN dbo.SHOHIN sh ON sh.ICODE = ls.SHO
LEFT JOIN dbo.SHIIRE si ON si.ICODE = ls.shiicode
WHERE ls.rn = 1
  AND RTRIM(ISNULL(tk.CODE,'')) <> '' AND RTRIM(ISNULL(tk.CODE,'')) <> '0000'  -- 諸口(0000)・得意先未設定は除外
  AND RTRIM(ISNULL(sh.CODE,'')) <> ''                                          -- 自社CDが無い行は除外
  AND REPLACE(RTRIM(ISNULL(sh.CODE,'')),'0','') <> ''                          -- 000000等の全ゼロ(プレースホルダ/未設定品)は除外`;
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
  // ⚠ 読み取り専用。安全の本体は「SELECT 以外を一切発行しない」こと。
  //   加えて ApplicationIntent=ReadOnly を意思表示として付与（スタンドアロンSQL Serverでは無視され
  //   書込み阻止効果は無いが、可用性グループ等では読み取りルーティングされる多層防御）。
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
    // 商品マスタ規約：mname＝商品名3(NM3)＝メーカーコード（CD一致専用）。商品名2/4/5・摘要は使わない。
    const mname = ix.mname != null ? String(r[ix.mname] == null ? '' : r[ix.mname]).trim() : '';
    // 商品名1(NM1)＝商品マスタのクリーンな商品名。表示・名前一致のベース（伝票テキストの運賃/入数ゴミを含まない）。
    const masterName = String(r[ix.sname] == null ? '' : r[ix.sname]).trim();
    const dispName = masterName || pname; // マスタ名が空なら従来どおり伝票名でフォールバック
    out.push({
      customerCode: tcd,
      customerName: String(r[ix.cname] == null ? '' : r[ix.cname]).trim(),
      productCode: pcd,
      productName: pname,                       // 伝票テキスト（NAME+NAME2..5 連結）＝CD一致の埋込品番探索に使う
      masterName,                               // 商品マスタのクリーン名（表示用）
      currentSell: toNum(r[ix.sell]),
      annualAmount: toNum(r[ix.amt]),
      origCost: toNum(r[ix.cost]),
      lastDate: String(r[ix.lastdate] == null ? '' : r[ix.lastdate]).trim(),
      norm: normName(dispName),
      // CD一致＝メーカーコードの探索範囲：① 売上明細の伝票テキスト(pname・過去の埋込品番) ＋ ② マスタの商品名3(mname=メーカーコード)。
      //  ＝マスタの商品名3にメーカー品番を登録しておけば、売上明細に品番が無くても CD一致で確実に拾える。
      codeNorm: normForCode((pname + ' ' + mname).trim()),
      // 名前一致は 商品マスタの商品名1(クリーン) を使う＝伝票テキストのゴミに左右されない（マスタ名が無ければ伝票名）。
      coreNorm: normName(coreName(dispName)),
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
  const annualStart = dbCfg.start || range.start; // 年間金額(損益)の起点＝直近約1年（明示startがあれば優先）
  const end = dbCfg.end || range.end;
  // 候補に含める期間（さかのぼり月数・既定12）。明示の start があるときはそれを候補起点にも使う。
  //  dbCfg.candidateStart（ISO・明示）があれば候補起点だけをそれに上書き＝年間金額(損益)の窓は直近1年のまま。
  //   自社製造(メーカーコード9000)を「遡れるだけ遡って」照合する用途で使う（損益は歪ませない）。
  const candidateStart = dbCfg.candidateStart || (dbCfg.start ? annualStart : monthsBackStart(dbCfg.candidateMonths));
  const sql = buildSql(candidateStart, end, annualStart, dbCfg.scale);
  const csv = runQueryToCsv(dbCfg, sql);
  try { return csvToRecords(csv); }
  finally { try { fs.unlinkSync(csv); } catch (_) {} }
}

// 商品コード(SHOHIN.CODE) → { zeiKbn(消費税区分=ZEIKBN), zeiRitu(消費税率表№=ZEIRITU) } を読み取り専用で引く。
//  販売大臣 単価履歴CSVの税2列に使う。codes は自社レコード由来だが、念のためASCII英数字等に限定（SQL安全）。
function lookupShohinTax(dbCfg, codes) {
  dbCfg = dbCfg || {};
  const uniq = Array.from(new Set((codes || []).map((c) => String(c == null ? '' : c).trim())))
    .filter((c) => c && /^[0-9A-Za-z._-]+$/.test(c));
  if (!uniq.length) return {};
  const inList = uniq.map((c) => "'" + c + "'").join(',');
  const sql = `SELECT RTRIM(CODE) AS code, ZEIKBN AS zeikbn, ZEIRITU AS zeiritu FROM dbo.SHOHIN WHERE RTRIM(CODE) IN (${inList})`;
  const csv = runQueryToCsv(dbCfg, sql);
  try {
    const { parseCsvText } = require('./csv');
    const rows = parseCsvText(fs.readFileSync(csv, 'utf8').replace(/^﻿/, ''));
    if (!rows.length) return {};
    const head = rows[0]; const ix = {}; head.forEach((h, i) => { ix[String(h).trim().toLowerCase()] = i; });
    const out = {};
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || !r.length) continue;
      const code = String(r[ix.code] == null ? '' : r[ix.code]).trim();
      if (!code) continue;
      out[code] = {
        zeiKbn: String(r[ix.zeikbn] == null ? '' : r[ix.zeikbn]).trim(),
        zeiRitu: String(r[ix.zeiritu] == null ? '' : r[ix.zeiritu]).trim(),
      };
    }
    return out;
  } finally { try { fs.unlinkSync(csv); } catch (_) {} }
}

// 自社製造品（日野折箱店）を 商品分類(BUN1/BUN2) で SHOHIN から抽出する（読み取り専用）。
//  ＝「どれが自社製か」を販売大臣の商品分類で持っているので、手入力CSVの代わりにDBから直接拾う。
//  opts.bun1=[1,5]（商品分類1の対象値・配列）、opts.bun2=1（商品分類2の対象値）。
//  onlySold=true（既定）＝販売実績(URIMEI)が1件でもある品だけ（得意先なし＝休眠の乱立を防ぐ）。
//  戻り値: [{ code:自社商品コード(SHOHIN.CODE), name:商品名(NM1) }]。価格は照合時に販売実績から取る（原価0）。
function loadSelfProductsFromDb(dbCfg, opts) {
  dbCfg = dbCfg || {}; opts = opts || {};
  // 分類値は整数だけ許可（SQL安全）。既定 BUN1∈{1,5}・BUN2=1。
  const bun1 = (Array.isArray(opts.bun1) ? opts.bun1 : [1, 5])
    .map((v) => parseInt(v, 10)).filter((v) => Number.isInteger(v));
  const bun2 = Number.isInteger(parseInt(opts.bun2, 10)) ? parseInt(opts.bun2, 10) : 1;
  if (!bun1.length) return [];
  const onlySold = opts.onlySold !== false;
  const in1 = bun1.join(',');
  const soldCond = onlySold ? ' AND EXISTS (SELECT 1 FROM dbo.URIMEI u WHERE u.SHO = s.ICODE)' : '';
  const sql =
    'SELECT DISTINCT RTRIM(s.CODE) AS code, RTRIM(ISNULL(s.NM1,\'\')) AS name ' +
    'FROM dbo.SHOHIN s ' +
    'WHERE s.BUN1 IN (' + in1 + ') AND s.BUN2 = ' + bun2 +
    ' AND RTRIM(ISNULL(s.CODE,\'\')) <> \'\'' + soldCond +
    ' ORDER BY code';
  const csv = runQueryToCsv(dbCfg, sql);
  try {
    const { parseCsvText } = require('./csv');
    const rows = parseCsvText(fs.readFileSync(csv, 'utf8').replace(/^﻿/, ''));
    if (!rows.length) return [];
    const head = rows[0]; const ix = {}; head.forEach((h, i) => { ix[String(h).trim().toLowerCase()] = i; });
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || !r.length) continue;
      const code = String(r[ix.code] == null ? '' : r[ix.code]).trim();
      const name = String(r[ix.name] == null ? '' : r[ix.name]).trim();
      if (code) out.push({ code, name });
    }
    return out;
  } finally { try { fs.unlinkSync(csv); } catch (_) {} }
}

// 得意先マスタ(TOKUI)から コード・名称・検索カナ を読み取り専用で引く（得意先ページの表示/検索用）。
//  CODE=得意先コード(4桁)・NM1=名称・KCODE=販売大臣の検索カナ(半角カナ 例: 中島商店→ﾅｶｼﾞﾏ)。
//  諸口(0000)・コード空は除外。戻り値: [{ code, name, kana }]。⚠ SELECT のみ。
function loadCustomerMaster(dbCfg) {
  dbCfg = dbCfg || {};
  const sql =
    "SELECT RTRIM(CODE) AS code, RTRIM(ISNULL(NM1,'')) AS name, RTRIM(ISNULL(KCODE,'')) AS kana " +
    "FROM dbo.TOKUI " +
    "WHERE RTRIM(ISNULL(CODE,'')) <> '' AND RTRIM(ISNULL(CODE,'')) <> '0000'";
  const csv = runQueryToCsv(dbCfg, sql);
  try {
    const { parseCsvText } = require('./csv');
    const rows = parseCsvText(fs.readFileSync(csv, 'utf8').replace(/^﻿/, ''));
    if (!rows.length) return [];
    const head = rows[0]; const ix = {}; head.forEach((h, i) => { ix[String(h).trim().toLowerCase()] = i; });
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || !r.length) continue;
      const code = String(r[ix.code] == null ? '' : r[ix.code]).trim();
      if (!code) continue;
      out.push({
        code,
        name: String(r[ix.name] == null ? '' : r[ix.name]).trim(),
        kana: String(r[ix.kana] == null ? '' : r[ix.kana]).trim(),
      });
    }
    return out;
  } finally { try { fs.unlinkSync(csv); } catch (_) {} }
}

// DB接続の死活確認（SELECT 1 のみ・読み取り専用）。照合前のプレフライト用。
function probeDbConnection(dbCfg) {
  dbCfg = dbCfg || {};
  const out = runQueryToCsv(dbCfg, 'SELECT 1 AS ok');
  try { fs.unlinkSync(out); } catch (_) {}
  return true;
}

module.exports = { loadHanbaiFromDb, buildSql, csvToRecords, defaultRange, lookupShohinTax, loadSelfProductsFromDb, loadCustomerMaster, probeDbConnection, runQueryToCsv };
