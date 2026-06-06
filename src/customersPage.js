// =====================================================================
//  得意先別 商品 一覧ページ（/customers で表示）
//   全仕入先の最新照合結果を横断集計し、得意先ごとに「買う全商品」を
//   （複数メーカーまたがりで）1画面で確認できる逆引きビュー。
//   データは GET /api/customers（server.js: aggregateCustomers）から取得。
//   価格は sim/見積書と同じ既定で算出（出力前の総ざらい用）。
// =====================================================================
const CUSTOMERS_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>得意先別 商品一覧</title>
<style>
  body{margin:0;font-family:"メイリオ","Meiryo","Segoe UI",sans-serif;background:#f4f6f9;color:#1f2733;font-size:13px}
  header{background:#1f4e78;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  header h1{font-size:16px;margin:0}
  header .sub{color:#cfe0f0;font-size:12px}
  header a{color:#cfe0f0;font-size:12px;text-decoration:none;background:rgba(255,255,255,.08);padding:5px 10px;border-radius:6px}
  header a:hover{background:rgba(255,255,255,.18)}
  header .spacer{margin-left:auto}
  .wrap{display:flex;gap:0;align-items:stretch;min-height:calc(100vh - 110px)}
  .col-list{width:300px;flex:0 0 300px;border-right:1px solid #e2e6ec;background:#fff;overflow:auto;max-height:calc(100vh - 110px)}
  .col-detail{flex:1;overflow:auto;max-height:calc(100vh - 110px)}
  .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border-bottom:1px solid #e2e6ec;padding:10px 16px}
  button.go{background:#1f4e78;color:#fff;border:none;border-radius:8px;padding:7px 13px;font-weight:700;cursor:pointer}
  button.go:disabled{opacity:.5;cursor:not-allowed}
  #search{padding:7px 10px;border:1px solid #c7d6e4;border-radius:8px;font-size:13px;width:200px}
  /* 計算カスタマイズ バー（メインページと同じ項目） */
  .calcbar{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;background:#f7fafd;border-bottom:1px solid #e2e6ec;padding:10px 16px}
  .calcbar .fld{display:flex;flex-direction:column;gap:3px}
  .calcbar label{font-size:11px;color:#5a6b7a;font-weight:700}
  .calcbar label .h{font-weight:400;color:#9aa6b2}
  .calcbar select,.calcbar input{padding:6px 8px;border:1px solid #c7d6e4;border-radius:7px;font-size:13px;background:#fff}
  .calcbar input.num{width:96px;text-align:right}
  .calcbar input.eff{width:140px}
  .calcbar .recalc{background:#1f4e78;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
  .calcbar .applied{font-size:11px;color:#6b7785}
  .calcbar .sep{width:1px;align-self:stretch;background:#dde5ee;margin:2px 2px}
  /* 見積書 出力バー */
  .exportbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#eef4fb;border-bottom:1px solid #d6e1ee;padding:9px 16px}
  .exportbar .exp{background:#1b6b3a;color:#fff;border:none;border-radius:8px;padding:8px 15px;font-weight:700;cursor:pointer;font-size:13px}
  .exportbar .exp.one{background:#2f7d52}
  .exportbar .exp:disabled{opacity:.45;cursor:not-allowed}
  .exportbar .exp:hover:not(:disabled){filter:brightness(1.08)}
  .exportbar .exphint{font-size:11px;color:#5a6b7a}
  #exportResult{margin:10px 16px 0}
  .ok-banner{background:#eef7ef;border:1px solid #bfe0c4;color:#1f6b35;border-radius:10px;padding:10px 14px;font-size:13px}
  .ok-banner .mini,.ok-banner button{background:#fff;border:1px solid #9fcbab;color:#1f6b35;border-radius:7px;padding:3px 10px;font-weight:700;cursor:pointer;font-size:12px;margin-left:8px}
  .err-banner{background:#fdecea;border:1px solid #f5b7b1;color:#922b21;border-radius:10px;padding:10px 14px;font-size:13px}
  /* 発行前 確認ゲート モーダル */
  .gate-overlay{position:fixed;inset:0;background:rgba(15,25,40,.5);display:none;align-items:center;justify-content:center;z-index:60;padding:20px}
  .gate-overlay.show{display:flex}
  .gate{background:#fff;border-radius:14px;width:100%;max-width:1000px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.3)}
  .gate-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #e6ecf2}
  .gate-head h2{margin:0;font-size:17px;color:#a01b10}
  .gate-x{margin-left:auto;background:#fff;border:1px solid #cdd7e1;border-radius:8px;width:30px;height:30px;font-size:18px;cursor:pointer;color:#5a6b7a}
  .gate-note{padding:12px 18px;font-size:12.5px;color:#5a3c00;background:#fff7e6;border-bottom:1px solid #f0d9a8}
  .gate-table-wrap{overflow:auto;flex:1;padding:0 6px}
  .gate-table-wrap table{width:100%;border-collapse:collapse;font-size:12.5px}
  .gate-table-wrap th{position:sticky;top:0;background:#f3f6fa;text-align:left;padding:6px 9px;border-bottom:1px solid #e2e6ec;z-index:1}
  .gate-table-wrap td{padding:6px 9px;border-bottom:1px solid #eef1f5;vertical-align:top}
  .gate-table-wrap tr.price td{background:#fdf3f2}
  .gate-table-wrap tr.match td{background:#fffaf0}
  .gate-table-wrap th.num,.gate-table-wrap td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  /* 発行プレビュー：得意先ごとのセクション */
  .pv-cust{margin:0 0 14px}
  .pv-cust .pv-head{position:sticky;top:0;background:#1f4e78;color:#fff;font-weight:700;padding:6px 10px;border-radius:6px 6px 0 0;z-index:2}
  .pv-cust .pv-cnt{font-weight:400;color:#cfe0f0;font-size:11px;margin-left:6px}
  .pv-cust table th{position:static;background:#eef2f7}
  .pv-sec-rev{margin:18px 0 6px;font-weight:700;color:#a01b10;border-top:2px solid #f0c6c2;padding-top:10px}
  .gate-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #e6ecf2}
  .gate-foot .go{background:#1b6b3a;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
  .gate-foot .go:disabled{opacity:.45;cursor:not-allowed}
  .gate-foot .ghost{background:#fff;border:1px solid #c7d6e4;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer;color:#33485c}
  .cust{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid #eef1f5;cursor:pointer}
  .cust:hover{background:#f0f6fd}
  .cust.sel{background:#e3f0fb}
  .cust .nm{font-weight:700;color:#1f2733;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cust .meta{font-size:11px;color:#6b7785;margin-top:2px}
  .cust .cnt{flex:0 0 auto;background:#1f4e78;color:#fff;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700}
  .cust .rev{color:#c0392b;font-size:11px;font-weight:700;margin-left:6px}
  .cust .ccode{display:inline-block;background:#eef2f7;color:#41526b;border-radius:4px;padding:0 5px;font-size:10px;font-weight:700;margin-right:5px;font-family:monospace}
  .cust .nrec{color:#9aa6b2;font-size:11px;font-weight:700;margin-left:6px}
  .listnote{font-size:11px;color:#8a6d3b;background:#fbf6e7;border:1px solid #ecdba8;border-radius:6px;padding:5px 8px;margin:0 0 8px}
  table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}
  th,td{border:1px solid #e2e6ec;padding:6px 9px;vertical-align:middle}
  th{background:#eef2f7;text-align:left;white-space:nowrap;position:sticky;top:0;z-index:1}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  td.pcode{font-family:Consolas,'Courier New',monospace;color:#444;white-space:nowrap}
  td.up{color:#c0392b;font-weight:700}
  td.down{color:#2a6fb0;font-weight:700}
  td.rate{font-weight:700}
  th.grp{background:#e7eef6;text-align:center}
  .sup-badge{display:inline-block;background:#eaf1f8;color:#1f4e78;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:700;white-space:nowrap}
  a.prodlink{color:#1565c0;text-decoration:none;border-bottom:1px dotted #90b4d8}
  a.prodlink:hover{color:#0d47a1;border-bottom-style:solid;background:#eaf3fb}
  /* 一覧を畳むと右の明細が全幅に */
  .wrap.list-collapsed .col-list{display:none}
  /* 低マージン（改定後粗利率がしきい値未満）の強調 */
  td.lowmargin{background:#fdeccb !important;color:#9a5b00;font-weight:700}
  .cust .lowm{color:#b8860b;font-size:11px;font-weight:700;margin-left:6px}
  /* 提出済みバッジ（得意先一覧・ヘッダー） */
  .cust .issued{display:inline-block;background:#e1f3df;color:#1f6b35;border:1px solid #bfe0c4;border-radius:999px;font-size:10px;font-weight:700;padding:0 6px;margin-left:6px}
  .cust.done{background:#f5fbf6}
  .issuednote{margin:8px 16px;padding:8px 12px;border-radius:8px;background:#eef7ef;border:1px solid #bfe0c4;color:#1f6b35;font-size:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .issuednote .un{background:#fff;border:1px solid #9fcbab;color:#1f6b35;border-radius:7px;padding:2px 9px;font-weight:700;cursor:pointer;font-size:11px}
  .issuednote .openq{background:#1f6b35;border:1px solid #1f6b35;color:#fff;border-radius:7px;padding:2px 10px;font-weight:700;cursor:pointer;font-size:11px}
  .issuednote .openq:hover{background:#175a2b}
  .notyet{margin:8px 16px;padding:6px 12px;border-radius:8px;background:#f4f6f9;border:1px solid #e2e6ec;color:#6b7785;font-size:12px}
  /* 検討中タグ（得意先一覧）／アイテム状態ボタン／別枠セクション */
  .cust .holdm{color:#8a5a12;font-size:11px;font-weight:700;margin-left:6px}
  td.actcell{white-space:nowrap}
  /* チェックボックス一括移動バー */
  .bulkbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0;padding:6px 10px;background:#f4f7fb;border:1px solid #d8e0ea;border-radius:8px}
  .bulkbar .bulkinfo{font-size:12px;color:#1f4e78;font-weight:700}
  .bulkbtn{border:none;border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer}
  .bulkbtn:disabled{opacity:.45;cursor:default}
  .bulkbtn.hold{background:#f0c14b;color:#5c3d00}
  .bulkbtn.hold:not(:disabled):hover{background:#e8b430}
  .bulkbtn.back{background:#1f6b35;color:#fff}
  .bulkbtn.back:not(:disabled):hover{background:#175a2b}
  label.selall{font-size:11px;color:#6b7785;font-weight:400;white-space:nowrap;cursor:pointer}
  input.selchk-target,input.selchk-hold,input.selchk-issued{cursor:pointer;vertical-align:middle}
  /* 行ルール（ラジオボタン） */
  td.rrcell{min-width:190px}
  .rrradios{display:flex;flex-wrap:wrap;gap:1px 8px;align-items:center}
  .rrradios label.rr{font-size:11px;color:#33405a;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;gap:2px;padding:1px 0}
  .rrradios input[type=radio]{margin:0;cursor:pointer}
  .rrradios.ov{background:#eafaef;border-radius:6px;padding:2px 4px}
  input.rowfactor{vertical-align:middle}
  button.hold-btn{background:#fff;border:1px solid #e0c48a;color:#8a5a12;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer}
  button.hold-btn:hover{background:#fff8ec}
  button.back-btn{background:#fff;border:1px solid #9fcbab;color:#1f6b35;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer}
  button.back-btn:hover{background:#f0faf2}
  details.itemsec{margin:10px 16px;border-radius:8px;border:1px solid #e2e6ec;overflow:hidden}
  details.itemsec>summary{cursor:pointer;padding:8px 12px;font-size:13px;font-weight:700;user-select:none}
  details.sec-hold{border-color:#f0d49a}
  details.sec-hold>summary{background:#fff4d6;color:#8a5a12}
  details.sec-issued{border-color:#bfe0c4}
  details.sec-issued>summary{background:#eef7ef;color:#1f6b35}
  details.itemsec .table-pad{padding:0 0 6px}
  details.itemsec table{font-size:12px}
  .lowmnote{margin:8px 16px;padding:8px 12px;border-radius:8px;background:#fff4d6;border:1px solid #f0d49a;color:#8a5a12;font-size:12px}
  .detail-head{padding:12px 16px 4px}
  .detail-head h2{margin:0;font-size:18px;color:#1f4e78}
  .detail-head .sum{color:#6b7785;font-size:12px;margin-top:4px}
  .muted{color:#6b7785;font-size:11px}
  .empty{padding:30px;text-align:center;color:#6b7785}
  .revnote{margin:8px 16px;padding:8px 12px;border-radius:8px;background:#fdecea;border:1px solid #f5b7b1;color:#922b21;font-size:12px}
  .table-pad{padding:0 16px 24px}
  select.rowrule{padding:3px 5px;border:1px solid #c7d6e4;border-radius:6px;font-size:12px;background:#fff}
  select.rowrule.ov{border-color:#1b6b3a;background:#eef7ef;font-weight:700;color:#1b6b3a}
  input.cellinp{border:1px solid #c7d6e4;border-radius:6px;font-size:12px;padding:3px 5px}
  input.sellinp{width:84px;text-align:right;font-variant-numeric:tabular-nums}
  input.effinp{width:108px;text-align:left}
  input.noteinp{width:180px;text-align:left}
  input.cellinp.man{border-color:#1b6b3a;background:#eef7ef;font-weight:700;color:#1b6b3a}
  input.effinp.effmissing{border-color:#c0392b;background:#fdecea}
  .effnote{margin:8px 16px;padding:8px 12px;border-radius:8px;background:#fdecea;border:1px solid #f5b7b1;color:#922b21;font-size:12px;font-weight:700}
</style></head><body>
<header>
  <h1>👥 得意先別 商品一覧</h1>
  <span class="sub">得意先を選ぶと、その得意先が買う全商品（複数メーカーまたがり）を表示</span>
  <span class="spacer"></span>
  <a href="/">← シミュレーション</a>
  <a href="/list">📊 一覧・進捗</a>
  <a href="/import">＋ メーカー見積取込</a>
  <a href="/suppliers">📒 仕入先マスタ</a>
  <a href="/self">🗂 自社データ設定</a>
</header>

<div class="toolbar">
  <button class="go" id="toggleListBtn" style="background:#5b6b8b" title="左の得意先一覧を隠して、右の明細を広く使えます（もう一度押すと表示）">◀ 一覧を隠す</button>
  <button class="go" id="reloadBtn">🔄 最新の状態を読み込む</button>
  <input id="search" type="text" placeholder="得意先を検索（名前・コード・カナ）…">
  <label style="font-size:12px;color:#5a6b7d;display:flex;align-items:center;gap:4px;white-space:nowrap" title="この期間に取引のある得意先だけ表示します（最終売上日で判定・DB直結時）。照合は全期間で拾うので、ここで何年ぶんを見るか決められます。"><span>表示期間</span>
    <select id="recentYears" style="padding:5px 8px;border:1px solid #c7d6e4;border-radius:8px;font-size:13px">
      <option value="1">過去1年（取引あり）</option>
      <option value="2">過去2年</option>
      <option value="3">過去3年</option>
      <option value="0">全期間（過去客も）</option>
    </select></label>
  <span id="msg" class="muted"></span>
  <span class="spacer" style="margin-left:auto"></span>
  <span id="issuedStat" class="muted" title="見積書を提出（発行）済みの得意先数">提出済 0</span>
  <button class="go" id="resetIssuedBtn" style="background:#8a6d3b" title="提出済みマークをすべて消します（新しい改定サイクルの開始時に使用）。見積書ファイルは消えません">提出履歴をリセット</button>
</div>

<div id="calcbarHome" style="display:none"><div class="calcbar" id="calcbar">
  <div class="fld"><label>転嫁ルール（全体）<span class="h">メインの全体方針が初期値</span></label>
    <select id="cRule">
      <option value="add_increase">値上げ分を上乗せ（利益額キープ）</option>
      <option value="keep_margin_rate">現在の粗利率を維持</option>
      <option value="markup">現売価 × 掛率</option>
      <option value="sell_cost_rate">現売価 × 仕入改定%（仕入と同率で値上げ＝粗利率維持と同結果）</option>
      <option value="keep_sell">据え置き（値上げしない）</option>
    </select></div>
  <div class="fld" id="cFactorBox" style="display:none"><label>掛率</label>
    <input id="cFactor" class="num" type="number" step="0.01" value="1.25"></div>
  <div class="fld" id="cBandFld" style="flex-basis:100%;min-width:100%">
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="cBandOn"> 💴 現売価で転嫁ルールを変える（価格帯別・全体反映）</label>
    <div id="bandBox" style="display:none;margin-top:5px;background:#f6f9fc;border:1px solid #d4e0ec;border-radius:8px;padding:8px"></div>
  </div>
  <div class="fld"><label>改定後価格 まるめ <span class="h">小数の扱い</span></label>
    <select id="cRound">
      <optgroup label="切り捨て（カット）">
        <option value="1|floor">小数点以下カット（整数）</option>
        <option value="0.1|floor">小数第1位以下カット</option>
        <option value="0.01|floor">小数第2位以下カット</option>
      </optgroup>
      <optgroup label="四捨五入">
        <option value="1|round">整数（円）で四捨五入</option>
        <option value="0.1|round">小数第1位まで（四捨五入）</option>
        <option value="0.01|round">銭まで（小数第2位・四捨五入）</option>
      </optgroup>
      <optgroup label="切り上げ">
        <option value="1|ceil">整数（円）で切り上げ</option>
        <option value="0.1|ceil">小数第1位まで（切り上げ）</option>
        <option value="0.01|ceil">銭まで（小数第2位・切り上げ）</option>
      </optgroup>
    </select></div>
  <div class="fld"><label>自社コスト上乗せ% <span class="h">労務費等</span></label>
    <input id="cUplift" class="num" type="number" step="0.1" value="0"></div>
  <div class="fld"><label>低マージン警告 <span class="h">改定後粗利率</span></label>
    <div style="display:flex;align-items:center;gap:4px"><input id="cLowMargin" type="number" step="1" value="15" style="width:62px;padding:6px 8px;border:1px solid #c7d6e4;border-radius:7px;font-size:13px;text-align:right"><span style="font-size:12px;color:#5a6b7a">% 未満で警告</span></div></div>
  <div class="sep"></div>
  <div class="fld"><label>実施日 一括 <span class="h">空=各行の切替日</span></label>
    <input id="cEff" class="eff" type="text" placeholder="例: 2026-07-01"></div>
  <div class="fld"><label>&nbsp;</label>
    <button class="recalc" id="recalcBtn">この設定で再計算</button></div>
  <div class="fld"><label>&nbsp;</label>
    <button class="recalc" id="reloadPolicyBtn" style="background:#5b6b8b" title="メインで保存した『全体方針』を取り込んで、全体の各設定を初期値に戻します（行ごとの上書きは残ります）">↻ 全体方針を取込</button></div>
  <span class="applied" id="appliedMsg"></span>
</div></div>

<div class="exportbar">
  <button class="exp" id="exportAllBtn">📄 全得意先の見積書を作成</button>
  <button class="exp one" id="exportOneBtn" disabled>📄 選択中の得意先だけ作成</button>
  <span class="exphint">上の設定で、得意先ごと1枚（複数メーカー横断）の見積書を出力します。発行前に内容をプレビュー表示します（要確認は除外）。</span>
  <span id="exportMsg" class="muted"></span>
</div>
<div id="exportResult" style="display:none"></div>

<div class="exportbar" id="hanbaiMoved" style="background:#f3f5f8;border-color:#d8dee6;color:#55606e;font-size:12.5px">
  📦 <b>基幹システム（販売大臣）への取込CSV</b>（単価履歴＝売価／仕入原価）は、
  <a href="/" style="color:#2f6fb0;font-weight:700">シミュレーション画面の「📅 実施日カレンダー」</a>
  に移動しました（実施日が来た分をその場でダウンロードできます）。
</div>

<div class="gate-overlay" id="gateOverlay">
  <div class="gate">
    <div class="gate-head">
      <h2 id="gateTitle">発行前の確認</h2>
      <button class="gate-x" id="gateClose" title="閉じる">×</button>
    </div>
    <div class="gate-note" id="gateNote"></div>
    <div class="gate-table-wrap" id="gateBody"></div>
    <div class="gate-foot">
      <span id="gateSummary" class="muted"></span>
      <span style="flex:1"></span>
      <button class="ghost" id="gateBack">戻る（修正する）</button>
      <button class="go" id="gateIssue">要確認を除外して発行</button>
    </div>
  </div>
</div>

<div class="wrap">
  <div class="col-list" id="listCol"><div class="empty">読み込み中…</div></div>
  <div class="col-detail" id="detailCol"><div class="empty">左の一覧から得意先を選んでください。</div></div>
</div>

<script>
const $=s=>document.querySelector(s);
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
// 商品名を、メイン画面の該当照合行へ飛ぶリンクにする（新しいウィンドウ）。
//  メイン側は ?focusSupplier/Customer/Code/Name を読んで該当行へジャンプ＋強調する。
function prodLink(customer, supplier, code, name){
  const q='/?focusSupplier='+encodeURIComponent(supplier||'')
    +'&amp;focusCustomer='+encodeURIComponent(customer||'')
    +'&amp;focusCode='+encodeURIComponent(code||'')
    +'&amp;focusName='+encodeURIComponent(name||'');
  return '<a class="prodlink" href="'+q+'" rel="noopener" onclick="return openSimWindow(this.href)" title="メイン画面でこの商品の照合（一致度・メーカー品・現/改定後 仕入）を確認（新しいウィンドウ）">'+esc(name)+'</a>';
}
// 別タブではなく別ウィンドウで開く（window.open にサイズ指定を渡すとブラウザはタブでなくウィンドウにする）。
//  同じウィンドウ名を再利用＝クリックのたびに同じポップアップで内容が切り替わる（窓が増えない）。
function openSimWindow(href){
  const aw=(window.screen&&screen.availWidth)||1400, ah=(window.screen&&screen.availHeight)||900;
  const w=Math.min(aw,1500), h=Math.min(ah,1000);
  const left=Math.max(0,Math.round((aw-w)/2)), top=Math.max(0,Math.round((ah-h)/2));
  const win=window.open(href,'simfocus','width='+w+',height='+h+',left='+left+',top='+top+',resizable=yes,scrollbars=yes');
  if(win) win.focus();
  return false; // 既定のリンク遷移を止める
}
function yen(v){ return (v==null||isNaN(v))?'—':Number(v).toLocaleString('ja-JP',{maximumFractionDigits:2}); }
// 現→改定の改定率(%)。現単価>0 のときだけ算出。{txt, cls} を返す（値上げ=up赤/値下げ=down青）。
function pctChg(cur,neu){
  if(cur==null||neu==null||isNaN(cur)||isNaN(neu)||Number(cur)<=0) return {txt:'—',cls:''};
  const p=(Number(neu)/Number(cur)-1)*100;
  const cls = p>0.05?'rate up':(p<-0.05?'rate down':'rate');
  return {txt:(p>0?'+':'')+p.toFixed(1)+'%', cls};
}
let DATA=[];      // 得意先配列
let filtered=[];  // 検索後
let hiddenNoRecent=0; // 「取引のない先を隠す」で隠した件数（一覧上部に表示）
let selName=null; // 選択中の得意先名
let ISSUED={};    // 提出（発行）履歴 { 得意先名: {lastIssuedAt,count,quoteNo,itemCount,folder} }
let rowRules={};  // 行ごと転嫁ルールの上書き { rowKey: ruleType }（空=全体ルール）
let rowSell={};   // 行ごと 改定後売価 の手入力 { rowKey: 入力文字列 }
let rowEff={};    // 行ごと 実施日 の手入力 { rowKey: 入力文字列 }
let rowNote={};   // 行ごと 備考 の手入力 { rowKey: 入力文字列 }（見積書の備考列に転記）
let rowRound={};  // 行ごと まるめ の上書き { rowKey: "単位|処理" 例 "1|floor" }（空=全体のまるめ）
let rowFactor={}; // 行ごと 掛率（行ルール=掛率×のとき）{ rowKey: 数値 }（未設定=上の全体「掛率」を使う）
let lowMarginPct=15; // 低マージン警告のしきい値（%）。改定後粗利率がこの値未満なら警告。画面で調整可。
// 数値を表示用にクリーン化（¥・円・カンマ無し、最大2桁）。空/非数は''。
function numStr(v){ return (v==null||isNaN(v))?'':String(Math.round(Number(v)*100)/100); }
// 粗利率(%) = (売価-仕入)/売価 ×100。売価が無い/0なら null。
function marginRate(sell,cost){
  if(sell==null||cost==null||isNaN(sell)||isNaN(cost)||Number(sell)<=0) return null;
  return (Number(sell)-Number(cost))/Number(sell)*100;
}
function fmtPct1(v){ return v==null?'—':v.toFixed(1)+'%'; }
function isLowMargin(m){ return m!=null && m < lowMarginPct; }
// 得意先の「改定後粗利率がしきい値未満」の商品数
function lowMarginCount(c){ let n=0; for(const p of (c.products||[])){ if(isLowMargin(marginRate(p.newSell,p.newCost))) n++; } return n; }
// 対象アイテムのうち実施日が未設定（サーバが noEff を付与）の件数。発行には実施日が必須。
function effMissingCount(c){ let n=0; for(const p of (c.products||[])){ if(p.noEff) n++; } return n; }
// 別枠セクション（検討中／提出済み）の表。kind: 'hold'|'issued'
function sectionHtml(title, items, kind){
  if(!items || !items.length) return '';
  const open = kind==='hold' ? ' open' : ''; // 検討中は開いて見せる／提出済みは畳む
  const issuedTh = kind==='issued' ? '<th>提出</th>' : '';
  // 検討中(hold)・提出済み(issued) どちらも「チェックでまとめて対象へ戻す」を出す。
  const hasChk = (kind==='hold' || kind==='issued');
  const chkCls = 'selchk-'+kind;          // selchk-hold / selchk-issued
  const chkTh = hasChk ? '<th><label class="selall"><input type="checkbox" id="selAll-'+kind+'"> 全</label></th>' : '';
  let rows='';
  for(const p of items){
    const info = kind==='issued' ? (issuedShort(p.issuedAt)+(p.issuedQuoteNo?'（'+esc(p.issuedQuoteNo)+'）':'')) : '';
    const chkTd = hasChk ? '<td><input type="checkbox" class="'+chkCls+'" data-key="'+esc(p.rowKey)+'" title="まとめて移動するチェック"></td>' : '';
    rows+='<tr>'
      + chkTd
      +'<td><span class="sup-badge">'+esc(p.supplier)+'</span></td>'
      +'<td class="pcode">'+esc(p.productCode||'')+'</td>'
      +'<td>'+esc(p.productName)+'</td>'
      +'<td class="num">'+yen(p.currentSell)+'</td>'
      +'<td class="num">'+yen(p.newSell)+'</td>'
      +'<td>'+esc(p.effectiveDate||'')+'</td>'
      +(kind==='issued'?'<td class="muted">'+info+'</td>':'')
      +'<td><button class="back-btn" data-key="'+esc(p.rowKey)+'" title="この商品を見積の「対象」に戻します">↩ 対象へ戻す</button></td>'
      +'</tr>';
  }
  const bulkBar = hasChk
    ? ('<div class="bulkbar"><span class="bulkinfo">☑ 選択 <b id="cnt-'+kind+'">0</b> 件</span>'
       +'<button class="bulkbtn back" id="bulkBack-'+kind+'" disabled>↩ 選択をまとめて対象へ戻す</button>'
       +'<span class="muted">チェックした商品を見積の「対象」に戻します。</span></div>')
    : '';
  return '<details class="itemsec sec-'+kind+'"'+open+'><summary>'+title+' <b>'+items.length+'</b> 件</summary>'
    +'<div class="table-pad">'+bulkBar+'<table><thead><tr>'+chkTh+'<th>仕入先</th><th>商品コード</th><th>商品名</th><th class="num">現売価</th><th class="num">改定後売価</th><th>実施日</th>'+issuedTh+'<th>操作</th></tr></thead><tbody>'
    +rows+'</tbody></table></div></details>';
}
// チェックした複数アイテムをまとめて移動（cls=チェック対象クラス, status='hold'|''）。
async function bulkMove(cls, status){
  const keys = Array.from(document.querySelectorAll('#detailCol input.'+cls+':checked')).map(c=> c.getAttribute('data-key')).filter(Boolean);
  if(!selName || !keys.length) return;
  try{
    const res=await fetch('/api/item-status-bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:selName,rowKeys:keys,status:status})}).then(x=>x.json());
    if(!res.ok){ alert('一括変更に失敗: '+(res.error||'')); return; }
    await load(); // 再計算＋再描画（3区分が更新される）
  }catch(e){ alert('一括変更に失敗: '+e); }
}
// アイテムの状態変更（hold=検討中へ／''=対象へ戻す）→ 保存して再取得（3区分が更新される）
async function setItemState(rowKey, status){
  if(!selName || !rowKey) return;
  try{
    const res=await fetch('/api/item-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:selName,rowKey:rowKey,status:status})}).then(x=>x.json());
    if(!res.ok){ alert('変更に失敗: '+(res.error||'')); return; }
    await load(); // 再計算＋再描画（selectCust 再実行で対象/検討中/提出済みが更新）
  }catch(e){ alert('変更に失敗: '+e); }
}
// 行ルールの選択肢（先頭＝全体ルールを継承）
const ROW_RULE_OPTS=[['','（全体）'],['add_increase','上乗せ'],['keep_margin_rate','粗利維持'],['markup','掛率×'],['sell_cost_rate','売価×仕入率'],['keep_sell','据置']];
function rowRuleSelect(p){
  const cur = rowRules[p.rowKey]||'';
  const opts = ROW_RULE_OPTS.map(o=>'<option value="'+o[0]+'"'+(o[0]===cur?' selected':'')+'>'+o[1]+'</option>').join('');
  return '<select class="rowrule'+(cur?' ov':'')+'" data-key="'+esc(p.rowKey)+'">'+opts+'</select>';
}
// 行ルールをラジオボタンで表示（プルダウンの代わり）。全選択肢をその場でクリックできる。
//  行ごとに独立した name（連番）でグループ化。先頭「（全体）」は value=''＝上の全体ルールを継承。
let _rrSeq=0;
function rowRuleRadios(p){
  const cur = rowRules[p.rowKey]||'';
  const name = 'rr'+(_rrSeq++); // 行ごとに一意のグループ名
  let h='<div class="rrradios'+(cur?' ov':'')+'">';
  for(const o of ROW_RULE_OPTS){
    h+='<label class="rr"><input type="radio" class="rowrule-radio" name="'+name+'" data-key="'+esc(p.rowKey)+'" value="'+esc(o[0])+'"'+(o[0]===cur?' checked':'')+'>'+esc(o[1])+'</label>';
  }
  return h+'</div>';
}
// 行ルールが「掛率×」のときだけ、その行の掛率入力欄を出す（未入力なら上の全体「掛率」を使う）。
function rowFactorInput(p){
  if((rowRules[p.rowKey]||'')!=='markup') return '';
  const gf = parseFloat(($('#cFactor')||{}).value)||1.25; // 既定＝全体の掛率
  const v = (rowFactor[p.rowKey]!=null && rowFactor[p.rowKey]!=='') ? rowFactor[p.rowKey] : gf;
  return ' ×<input class="rowfactor" type="text" inputmode="decimal" data-key="'+esc(p.rowKey)+'" value="'+esc(v)+'" title="この行の掛率（現売価 × この値）。空欄なら上の全体「掛率」を使います" style="width:52px">';
}
// 行ごと まるめ（改定後価格の端数処理）の選択肢。先頭＝全体のまるめを継承。値="単位|処理"。
const ROW_ROUND_GROUPS=[
  ['切り捨て（カット）',[['1|floor','整数'],['0.1|floor','0.1'],['0.01|floor','0.01']]],
  ['四捨五入',[['1|round','整数'],['0.1|round','0.1'],['0.01|round','0.01']]],
  ['切り上げ',[['1|ceil','整数'],['0.1|ceil','0.1'],['0.01|ceil','0.01']]],
];
function rowRoundSelect(p){
  const cur = rowRound[p.rowKey]||'';
  let opts = '<option value=""'+(cur===''?' selected':'')+'>（全体）</option>';
  for(const g of ROW_ROUND_GROUPS){
    opts += '<optgroup label="'+g[0]+'">';
    for(const o of g[1]) opts += '<option value="'+o[0]+'"'+(o[0]===cur?' selected':'')+'>'+o[1]+'</option>';
    opts += '</optgroup>';
  }
  return '<select class="rowrule rowround'+(cur?' ov':'')+'" data-key="'+esc(p.rowKey)+'" title="この行だけ改定後価格のまるめを変える（空＝上の全体設定に従う）">'+opts+'</select>';
}

// 画面のカスタマイズ操作 → サーバへ渡す計算設定（メインページと同じ項目）
// 価格帯別ルール（現売価で転嫁ルールを変える）。最後の1件は max=null＝「それ以上」。
let priceBands=[{max:null, rule:'add_increase', factor:1.25}];
const BAND_RULES=[['add_increase','上乗せ'],['keep_margin_rate','粗利維持'],['markup','掛率×'],['sell_cost_rate','売価×仕入率'],['keep_sell','据置']];
function bandsEnabled(){ return !!($('#cBandOn')&&$('#cBandOn').checked); }
function calcOpts(){
  // 「改定後価格 まるめ」は "単位|処理"（例 1|floor＝小数点以下カット）の1値。単位と処理に分解して送る。
  const rp=String($('#cRound').value||'0.01|round').split('|');
  return {
    ruleType: $('#cRule').value,
    factor: parseFloat($('#cFactor').value)||1,
    roundingUnit: parseFloat(rp[0])||0.01,
    roundingMode: rp[1]||'round',
    selfUplift: parseFloat($('#cUplift').value)||0,
    forceEffectiveDate: ($('#cEff').value||'').trim(),
    priceBands: bandsEnabled() ? priceBands.filter(b=>b.rule) : undefined, // 価格帯別ON時のみ送る
    rowRules, rowSell, rowEff, rowNote, rowRound, rowFactor,
  };
}
// 価格帯別ルールの編集UIを描画（max昇順・null=それ以上は最後）。変更で即 load()（再計算）。
function renderBands(){
  const box=$('#bandBox'); if(!box) return;
  priceBands.sort((a,b)=>((a.max==null?Infinity:a.max)-(b.max==null?Infinity:b.max)));
  const inS='padding:4px 6px;border:1px solid #c7d6e4;border-radius:6px;font-size:13px';
  const ruleSel=(i,val)=>'<select class="band-rule" data-i="'+i+'" style="'+inS+'">'+BAND_RULES.map(o=>'<option value="'+o[0]+'"'+(o[0]===val?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>';
  let h='<div style="font-size:11px;color:#5a6b7a;margin-bottom:6px">現売価の小さい順に「〜○○円まで」の帯を作り、各帯の転嫁ルールを選びます。最後の「それ以上」が残り全部です。<br>例：〜100円＝粗利維持／〜500円＝掛率×1.2／それ以上＝上乗せ。</div>';
  priceBands.forEach((b,i)=>{
    const isLast=(b.max==null);
    const mx=isLast?'<b style="min-width:96px;display:inline-block">それ以上</b>'
      :'〜 <input class="band-max" data-i="'+i+'" type="text" inputmode="decimal" value="'+(b.max==null?'':b.max)+'" style="width:74px;text-align:right;'+inS+'"> 円まで';
    const fac=(b.rule==='markup')?(' ×<input class="band-factor" data-i="'+i+'" type="text" inputmode="decimal" value="'+(b.factor||'')+'" style="width:56px;text-align:right;'+inS+'">'):'';
    const del=isLast?'':'<button class="band-del" data-i="'+i+'" title="この帯を削除" style="border:none;background:#e4ebf2;color:#5a6b7a;border-radius:6px;width:24px;height:24px;cursor:pointer">×</button>';
    h+='<div style="display:flex;align-items:center;gap:6px;margin:4px 0;flex-wrap:wrap">'+mx+' ： '+ruleSel(i,b.rule)+fac+' '+del+'</div>';
  });
  h+='<button id="bandAdd" style="margin-top:4px;border:1px dashed #9ec3e6;background:#fff;color:#1f6fb2;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px">＋ 帯を追加</button>';
  box.innerHTML=h;
  box.querySelectorAll('.band-rule').forEach(el=>el.addEventListener('change',()=>{ priceBands[+el.dataset.i].rule=el.value; renderBands(); load(); }));
  box.querySelectorAll('.band-max').forEach(el=>el.addEventListener('change',()=>{ const v=parseFloat(el.value); priceBands[+el.dataset.i].max=Number.isFinite(v)?v:null; renderBands(); load(); }));
  box.querySelectorAll('.band-factor').forEach(el=>el.addEventListener('change',()=>{ const v=parseFloat(el.value); priceBands[+el.dataset.i].factor=Number.isFinite(v)&&v>0?v:1.25; load(); }));
  box.querySelectorAll('.band-del').forEach(el=>el.addEventListener('click',()=>{ priceBands.splice(+el.dataset.i,1); renderBands(); load(); }));
  const add=$('#bandAdd'); if(add) add.addEventListener('click',()=>{ priceBands.unshift({max:100,rule:'add_increase',factor:1.25}); renderBands(); load(); });
}
const RULE_LABEL={add_increase:'上乗せ',keep_margin_rate:'粗利維持',markup:'掛率×',sell_cost_rate:'売価×仕入率',keep_sell:'据置'};
const MODE_LABEL={round:'四捨五入',ceil:'切上げ',floor:'切捨て'};
function toggleFactor(){ $('#cFactorBox').style.display = ($('#cRule').value==='markup')?'flex':'none'; }
function showApplied(a){
  if(!a){ $('#appliedMsg').textContent=''; return; }
  // 価格帯別ルールが効いているときは、単体ルールの代わりに帯の内容を表示。
  const bands=Array.isArray(a.priceBands)?a.priceBands:[];
  const ruleDisp = bands.length
    ? ('💴 価格帯別: '+bands.map(b=>(b.max==null?'それ以上':('〜'+b.max))+'='+(RULE_LABEL[b.rule]||b.rule)+(b.rule==='markup'?('×'+(b.factor||'')):'')).join(' / '))
    : ((RULE_LABEL[a.ruleType]||a.ruleType)+(a.ruleType==='markup'?(' '+a.factor):''));
  const parts=[ ruleDisp,
    '端数 '+a.roundingUnit+'円/'+(MODE_LABEL[a.roundingMode]||a.roundingMode),
    '自社+'+a.selfUplift+'%',
    a.forceEffectiveDate?('実施日 '+a.forceEffectiveDate+' に統一'):'実施日 各行' ];
  const ovN=Object.keys(rowRules).length, sN=Object.keys(rowSell).length, eN=Object.keys(rowEff).length;
  const nN=Object.keys(rowNote).length, rN=Object.keys(rowRound).length;
  let manual='';
  if(ovN) manual+='　🟢 行ルール '+ovN+'件';
  if(rN) manual+='　🟢 行まるめ '+rN+'件';
  if(sN) manual+='　🟢 売価手入力 '+sN+'件';
  if(eN) manual+='　🟢 実施日手入力 '+eN+'件';
  if(nN) manual+='　🟢 備考 '+nN+'件';
  $('#appliedMsg').textContent='適用中（全体）: '+parts.join(' ／ ')+manual;
}

async function load(){
  $('#listCol').innerHTML='<div class="empty">読み込み中…</div>';
  $('#msg').textContent='集計中… この設定で全仕入先の照合結果を再計算しています';
  $('#recalcBtn').disabled=true;
  let res;
  try{
    res=await fetch('/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(calcOpts())}).then(x=>x.json());
  }
  catch(e){ $('#listCol').innerHTML='<div class="empty">読み込み失敗：'+esc(e&&e.message||e)+'</div>'; $('#msg').textContent=''; $('#recalcBtn').disabled=false; return; }
  finally{ $('#recalcBtn').disabled=false; }
  DATA=res.customers||[];
  const errN=(res.errors||[]).length;
  $('#msg').textContent='得意先 '+DATA.length+' 件 ／ 仕入先ファイル '+(res.fileCount||0)+' 本'+(errN?'（読み取り失敗 '+errN+' 本）':'');
  showApplied(res.applied);
  applyFilter();
  updateIssuedToolbar();
  if(selName && DATA.find(x=>x.name===selName)) selectCust(selName); // 再計算後も選択中の得意先を保持
}
// カナ検索の正規化キー：NFKC（半角カナ→全角・全角英数→半角）→カタカナをひらがなへ→小文字・空白除去。
//  これで「なかじま / ナカジマ / ﾅｶ」のどれで打っても KCODE(半角カナ ﾅｶｼﾞﾏ) に一致する。※正規表現は使わない。
function kanaKey(s){
  s=String(s==null?'':s).normalize('NFKC');
  let out='';
  for(const ch of s){
    let c=ch.charCodeAt(0);
    if(c>=0x30A1 && c<=0x30F6) c-=0x60; // 全角カタカナ→ひらがな
    const x=String.fromCharCode(c).toLowerCase();
    if(x!==' ' && x!=='　') out+=x;
  }
  return out;
}
// 得意先が検索語に一致するか（名前・得意先コード・検索カナ のいずれか）。
function matchCust(c,q){
  if(!q) return true;
  if(c.name && c.name.indexOf(q)>=0) return true;
  if(c.code && String(c.code).indexOf(q)>=0) return true;
  const qk=kanaKey(q);
  if(qk){
    if(c.kana && kanaKey(c.kana).indexOf(qk)>=0) return true;
    if(c.name && kanaKey(c.name).indexOf(qk)>=0) return true;
  }
  return false;
}
// 過去N年の判定。最終売上日(ISO)が「今日からN年前」以降なら期間内。
//  最終売上日が無い（ファイル方式/未再照合のCSV）ときは直近1年フラグ(hasRecent)で代用。
function cutoffIso(years){
  const d=new Date(); const t=new Date(d.getFullYear()-years, d.getMonth(), d.getDate());
  const p=(n)=>String(n).padStart(2,'0');
  return t.getFullYear()+'-'+p(t.getMonth()+1)+'-'+p(t.getDate());
}
function withinYears(c, years){
  if(!years || years<=0) return true; // 全期間
  if(c.lastDate) return c.lastDate >= cutoffIso(years);
  return !!c.hasRecent; // 最終売上日が無いときは直近1年(hasRecent)で代用
}
function applyFilter(){
  const q=($('#search').value||'').trim();
  const years = parseInt(($('#recentYears') && $('#recentYears').value) || '1', 10);
  let list = DATA.slice();
  hiddenNoRecent = 0;
  if(years>0){ const before=list.length; list=list.filter(c=>withinYears(c,years)); hiddenNoRecent = before-list.length; }
  filtered = q ? list.filter(c=>matchCust(c,q)) : list;
  renderList();
}
// 提出（発行）履歴をサーバから取得
async function loadIssueLog(){
  try{ const r=await fetch('/api/issue-log').then(x=>x.json()); ISSUED=(r&&r.log)||{}; }
  catch(e){ ISSUED={}; }
}
// ISO日時 → "M/D" 表示
function issuedShort(iso){
  if(!iso) return '';
  const d=new Date(iso); if(isNaN(d)) return '';
  return (d.getMonth()+1)+'/'+d.getDate();
}
function issuedCountN(){ return Object.keys(ISSUED||{}).length; }
// 提出済みの見積書(xlsx)をこのページから直接開く（発行履歴の folder から特定）
async function openIssued(name){
  try{
    const r=await fetch('/api/open-issued',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:name})}).then(x=>x.json());
    if(!r.ok){ alert('見積書を開けませんでした：'+(r.error||'')); return; }
    if(r.note) alert(r.note); // ファイルが見つからずフォルダを開いた場合などの注記
  }catch(e){ alert('通信に失敗しました：'+e); }
}
// 1得意先の「提出済み」を取り消す
async function unmarkIssued(name){
  if(!confirm('「'+name+'」の提出済みマークを取り消します。よろしいですか？\\n（見積書ファイル自体は消えません。表示の記録だけ消します）')) return;
  try{
    const r=await fetch('/api/issue-log-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:name})}).then(x=>x.json());
    ISSUED=(r&&r.log)||{};
  }catch(e){ delete ISSUED[name]; }
  renderList(); if(selName) selectCust(selName); updateIssuedToolbar();
}
// 提出履歴を全消去（新しい改定サイクルの開始時に使う）
async function resetAllIssued(){
  const n=issuedCountN();
  if(!n){ alert('提出済みの記録はありません。'); return; }
  if(!confirm('提出履歴をすべてリセットします（'+n+'得意先）。\\n新しい改定サイクルを始めるときに使います。\\n※見積書ファイル自体は消えません。表示の「✅提出済」マークだけ消します。よろしいですか？')) return;
  try{
    const r=await fetch('/api/issue-log-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}).then(x=>x.json());
    ISSUED=(r&&r.log)||{};
  }catch(e){ ISSUED={}; }
  renderList(); if(selName) selectCust(selName); updateIssuedToolbar();
}
// ツールバーの「提出 N/全」表示を更新
function updateIssuedToolbar(){
  const el=$('#issuedStat'); if(!el) return;
  const n=issuedCountN(), total=DATA.length;
  el.textContent = n ? ('✅ 提出済 '+n+(total?'/'+total:'')+' 得意先') : '提出済 0';
}
function renderList(){
  // 「取引のない先を隠す」で隠した件数の案内（解除リンク付き）。
  const yrs = parseInt(($('#recentYears') && $('#recentYears').value) || '1', 10);
  const note = hiddenNoRecent
    ? '<div class="listnote">🔇 過去'+yrs+'年に取引のない先 '+hiddenNoRecent+'件 を非表示中。<a href="#" onclick="showAllCusts();return false">全期間を表示</a></div>'
    : '';
  if(!filtered.length){ $('#listCol').innerHTML=note+'<div class="empty">該当する得意先がありません。'+(hiddenNoRecent?'<br>表示期間を「全期間」にすると過去客も表示されます。':'<br>照合結果がない場合は「↻ 照合を実行」してください。')+'</div>'; return; }
  let html=note;
  for(const c of filtered){
    const sel = c.name===selName ? ' sel' : '';
    const rev = c.reviewCount ? '<span class="rev">要確認'+c.reviewCount+'</span>' : '';
    const lowN = lowMarginCount(c);
    const low = lowN ? '<span class="lowm">薄利'+lowN+'</span>' : '';
    const hold = c.holdCount ? '<span class="holdm">検討中'+c.holdCount+'</span>' : '';
    const nrec = c.hasRecent ? '' : (c.lastDate ? '<span class="nrec" title="最終売上 '+esc(c.lastDate)+'">最終 '+esc(c.lastDate.slice(0,7))+'</span>' : '<span class="nrec" title="直近約1年に取引がありません（過去の得意先）">取引なし</span>');
    const code = c.code ? '<span class="ccode" title="得意先コード">'+esc(c.code)+'</span>' : '';
    const iss = ISSUED[c.name];
    const issBadge = iss ? '<span class="issued" title="最終提出 '+esc(iss.lastIssuedAt||'')+(iss.count>1?' / 提出'+iss.count+'回':'')+'">✅ 提出済 '+issuedShort(iss.lastIssuedAt)+(iss.count>1?'×'+iss.count:'')+'</span>' : '';
    html+='<div class="cust'+sel+(iss?' done':'')+'" data-name="'+esc(c.name)+'" onclick="selectCust(this.getAttribute(\\'data-name\\'))">'
      +'<div style="min-width:0"><div class="nm">'+esc(c.name)+'</div>'
      +'<div class="meta">'+code+'仕入先 '+c.supplierCount+' 社'+rev+low+hold+nrec+issBadge+'</div></div>'
      +'<span class="cnt">'+c.productCount+'</span>'
      +'</div>';
  }
  $('#listCol').innerHTML=html;
}
// 「全期間を表示」リンク：表示期間を全期間にして再描画
function showAllCusts(){ const sel=$('#recentYears'); if(sel) sel.value='0'; applyFilter(); }
function selectCust(name){
  selName=name;
  // 転嫁ルールバーは社名の下（該当商品〜提出済の間）へ移す。innerHTML再描画で消えないよう、
  //  まずホルダーへ退避（ノードを保持＝設定値・配線をそのまま維持）→描画後にスロットへ差し込む。
  const __bar=document.getElementById('calcbar'), __home=document.getElementById('calcbarHome');
  if(__bar && __home) __home.appendChild(__bar);
  const oneBtn=$('#exportOneBtn');
  if(oneBtn){ oneBtn.disabled=false; oneBtn.textContent='📄 「'+(name.length>12?name.slice(0,12)+'…':name)+'」だけ作成'; }
  renderList();
  const c=DATA.find(x=>x.name===name);
  if(!c){ $('#detailCol').innerHTML='<div class="empty">データがありません。</div>'; return; }
  const supChips=c.suppliers.map(s=>'<span class="sup-badge">'+esc(s)+'</span>').join(' ');
  const codeTag = c.code ? '<span class="ccode" style="margin-left:8px;vertical-align:middle">'+esc(c.code)+'</span>' : '';
  const nrecTag = c.hasRecent ? '' : (c.lastDate ? '<span class="nrec" style="margin-left:6px" title="最終売上日">最終売上 '+esc(c.lastDate)+'</span>' : '<span class="nrec" style="margin-left:6px">取引なし</span>');
  let html='<div class="detail-head"><h2>'+esc(c.name)+codeTag+nrecTag+'</h2>'
    +'<div class="sum">該当商品 <b>'+c.productCount+'</b> 品／仕入先 <b>'+c.supplierCount+'</b> 社　'+supChips+'</div></div>'
    +'<div id="calcbarSlot"></div>';  // ← ここに転嫁ルールバーを差し込む（社名の下・提出済の上）
  // 提出（発行）状況
  const iss=ISSUED[c.name];
  if(iss){
    html+='<div class="issuednote">✅ <b>提出済み</b>　最終提出 '+esc(issuedShort(iss.lastIssuedAt))
      +(iss.quoteNo?'（見積No. '+esc(iss.quoteNo)+'）':'')+(iss.itemCount?' '+iss.itemCount+'品':'')+(iss.count>1?'　／　提出 '+iss.count+' 回':'')
      +'<button class="openq" data-name="'+esc(c.name)+'" onclick="openIssued(this.getAttribute(\\'data-name\\'))">📄 提出済の見積書を開く</button>'
      +'<button class="un" data-name="'+esc(c.name)+'" onclick="unmarkIssued(this.getAttribute(\\'data-name\\'))">提出済みを取消</button></div>';
  } else {
    html+='<div class="notyet">未提出（この得意先はまだ見積書を発行していません）</div>';
  }
  if(c.reviewCount){
    html+='<div class="revnote">⚠ この得意先には「要確認」が '+c.reviewCount+' 件あります（価格異常・低一致で見積書から自動で外れる行）。'
      +'シミュレーション画面で内容を確認してください。</div>';
  }
  const lowN=lowMarginCount(c);
  if(lowN){
    html+='<div class="lowmnote">⚠ 低マージン '+lowN+' 件（改定後粗利率が '+lowMarginPct+'% 未満）。値上げ後も粗利が薄い行です。'
      +'行ルールや改定後売価を見直すと、表の「改定後粗利率」がオレンジから外れます。</div>';
  }
  const effN=effMissingCount(c);
  if(effN){
    html+='<div class="effnote">⚠ 実施日が未設定 '+effN+' 件（赤い欄）。<b>実施日は発行に必須</b>です。各行の実施日を入力するか、上の「実施日 一括」で統一してから発行してください。</div>';
  }
  html+='<div class="bulkbar" id="bulkTargetBar">'
    +'<span class="bulkinfo">☑ 選択 <b id="cntTarget">0</b> 件</span>'
    +'<button class="bulkbtn hold" id="bulkHoldBtn" disabled>🤔 選択をまとめて検討中へ</button>'
    +'<span class="muted">チェックした商品を今回の見積から外します（検討中へ）。</span>'
    +'</div>';
  html+='<div class="table-pad"><table><thead>'
    +'<tr><th rowspan="2">操作<br><label class="selall"><input type="checkbox" id="selAllTarget"> 全</label></th><th rowspan="2">仕入先</th><th rowspan="2">商品コード</th><th rowspan="2">商品名</th>'
    +'<th class="grp" colspan="3">仕入（現→改定後）</th>'
    +'<th class="grp" colspan="5">売価・粗利率（現→改定後）</th>'
    +'<th rowspan="2">行ルール<br><span class="muted">(全体=メイン設定)</span></th>'
    +'<th rowspan="2">まるめ<br><span class="muted">(全体=上の設定)</span></th>'
    +'<th rowspan="2">実施日</th>'
    +'<th rowspan="2">備考<br><span class="muted">見積書に転記</span></th></tr>'
    +'<tr><th>現仕入</th><th>改定後仕入</th><th>改定%</th>'
    +'<th>現売価</th><th>現粗利率</th><th>改定後売価</th><th>改定後粗利率</th><th>改定%</th></tr>'
    +'</thead><tbody>';
  for(const p of c.products){
    const cr = pctChg(p.currentCost, p.newCost); // 仕入の改定%
    const sr = pctChg(p.currentSell, p.newSell); // 売価の改定%
    const curM = marginRate(p.currentSell, p.currentCost); // 現粗利率
    const newM = marginRate(p.newSell, p.newCost);         // 改定後粗利率
    const lowCls = isLowMargin(newM) ? ' lowmargin' : '';
    html+='<tr>'
      +'<td class="actcell"><input type="checkbox" class="selchk-target" data-key="'+esc(p.rowKey)+'" title="まとめて移動するチェック"> <button class="hold-btn" data-key="'+esc(p.rowKey)+'" title="この商品を今回の見積から外して「検討中（除外）」へ移します">🤔 検討中</button></td>'
      +'<td><span class="sup-badge">'+esc(p.supplier)+'</span></td>'
      +'<td class="pcode">'+esc(p.productCode||'')+'</td>'
      +'<td>'+prodLink(c.name, p.supplier, p.productCode, p.productName)+'</td>'
      +'<td class="num">'+yen(p.currentCost)+'</td>'
      +'<td class="num">'+yen(p.newCost)+'</td>'
      +'<td class="num '+cr.cls+'">'+cr.txt+'</td>'
      +'<td class="num">'+yen(p.currentSell)+'</td>'
      +'<td class="num">'+fmtPct1(curM)+'</td>'
      +'<td class="num"><input class="cellinp sellinp'+(p.sellManual?' man':'')+'" data-key="'+esc(p.rowKey)+'" value="'+esc(numStr(p.newSell))+'" title="直接入力できます（¥や円・カンマ・全角でもOK→数値に揃います）"></td>'
      +'<td class="num'+lowCls+'"'+(lowCls?' title="改定後粗利率が '+lowMarginPct+'% 未満（低マージン）"':'')+'>'+fmtPct1(newM)+'</td>'
      +'<td class="num '+sr.cls+'">'+sr.txt+'</td>'
      +'<td class="rrcell">'+rowRuleRadios(p)+rowFactorInput(p)+'</td>'
      +'<td>'+rowRoundSelect(p)+'</td>'
      +'<td><input class="cellinp effinp'+(p.effManual?' man':'')+(p.noEff?' effmissing':'')+'" data-key="'+esc(p.rowKey)+'" value="'+esc(p.effectiveDate||'')+'" placeholder="例: 2026-07-01" title="'+(p.noEff?'実施日が未設定です（発行には必須）。例: 2026-07-01':'直接入力できます（2026/7/1・7月1日 等でもISO表記に揃います）')+'"></td>'
      +'<td><input class="cellinp noteinp'+(p.note?' man':'')+'" data-key="'+esc(p.rowKey)+'" value="'+esc(p.note||'')+'" placeholder="（任意）" title="ここに入力すると見積書の「備考」列に転記されます"></td>'
      +'</tr>';
  }
  html+='</tbody></table></div>';
  // 別枠：🤔 検討中（除外）／✅ 提出済み（発行したアイテム）
  html+=sectionHtml('🤔 検討中（見積から除外）', c.holdProducts, 'hold');
  html+=sectionHtml('✅ 提出済み（発行したアイテム）', c.issuedProducts, 'issued');
  $('#detailCol').innerHTML=html;
  // 退避していた転嫁ルールバーを、社名の下のスロットへ差し込む（該当商品 と 提出済 の間）。
  const __slot=document.getElementById('calcbarSlot');
  if(__bar && __slot) __slot.appendChild(__bar);
  // 「🤔 検討中へ」「↩ 対象へ戻す」の配線（1件ずつ）
  $('#detailCol').querySelectorAll('button.hold-btn').forEach(b=> b.addEventListener('click',()=> setItemState(b.getAttribute('data-key'),'hold')));
  $('#detailCol').querySelectorAll('button.back-btn').forEach(b=> b.addEventListener('click',()=> setItemState(b.getAttribute('data-key'),'')));
  // チェックボックスでまとめて移動（対象→検討中 ／ 検討中→対象 ／ 提出済み→対象）の配線
  const bulkRoot = $('#detailCol');
  const BULK_GROUPS = [
    { cls:'selchk-target', cnt:'#cntTarget',    btn:'#bulkHoldBtn',     all:'#selAllTarget',  status:'hold' },
    { cls:'selchk-hold',   cnt:'#cnt-hold',     btn:'#bulkBack-hold',   all:'#selAll-hold',   status:''     },
    { cls:'selchk-issued', cnt:'#cnt-issued',   btn:'#bulkBack-issued', all:'#selAll-issued', status:''     },
  ];
  function bulkUpdate(){
    for(const g of BULK_GROUPS){
      const all = bulkRoot.querySelectorAll('input.'+g.cls);
      const n = bulkRoot.querySelectorAll('input.'+g.cls+':checked').length;
      const cnt=$(g.cnt), btn=$(g.btn), sa=$(g.all);
      if(cnt) cnt.textContent=n;
      if(btn) btn.disabled=!n;
      if(sa) sa.checked = all.length>0 && n===all.length;
    }
  }
  bulkRoot.querySelectorAll('input.selchk-target, input.selchk-hold, input.selchk-issued').forEach(c=> c.addEventListener('change', bulkUpdate));
  for(const g of BULK_GROUPS){
    const sa=$(g.all);
    if(sa) sa.addEventListener('change',()=>{ bulkRoot.querySelectorAll('input.'+g.cls).forEach(c=>{c.checked=sa.checked;}); bulkUpdate(); });
    const btn=$(g.btn);
    if(btn) btn.addEventListener('click',()=> bulkMove(g.cls, g.status));
  }
  // 行まるめの変更 → その行だけ別のまるめで再計算（サーバ集計＝見積書と同じ計算）。
  //  ※ rowround も .rowrule クラスを持つので、行ルールの配線が拾わないよう先に処理して除外する。
  $('#detailCol').querySelectorAll('select.rowround').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const k=sel.getAttribute('data-key');
      if(sel.value) rowRound[k]=sel.value; else delete rowRound[k];
      load();
    });
  });
  // 行ごと掛率（掛率×のときだけ表示）の変更 → その行を再計算。
  $('#detailCol').querySelectorAll('input.rowfactor').forEach(inp=>{
    inp.addEventListener('change',()=>{
      const k=inp.getAttribute('data-key');
      const v=parseFloat(inp.value);
      if(Number.isFinite(v) && v>0) rowFactor[k]=v; else delete rowFactor[k];
      load();
    });
  });
  // 行ルール（ラジオボタン）の変更 → その行だけ別ルールで再計算（サーバ集計＝見積書と同じ計算）。
  $('#detailCol').querySelectorAll('input.rowrule-radio').forEach(rb=>{
    rb.addEventListener('change',()=>{
      if(!rb.checked) return;
      const k=rb.getAttribute('data-key');
      if(rb.value) rowRules[k]=rb.value; else delete rowRules[k];
      load();
    });
  });
  // 改定後売価 の直接入力 → 手入力の固定価格として保存し再計算（空ならルール計算に戻す）
  $('#detailCol').querySelectorAll('input.sellinp').forEach(inp=>{
    inp.addEventListener('change',()=>{
      const k=inp.getAttribute('data-key'); const v=inp.value.trim();
      if(v==='') delete rowSell[k]; else rowSell[k]=v;
      load();
    });
  });
  // 実施日 の直接入力 → どの形式でもISOに揃えて保存・再表示（空なら自動の切替日に戻す）
  $('#detailCol').querySelectorAll('input.effinp').forEach(inp=>{
    inp.addEventListener('change',()=>{
      const k=inp.getAttribute('data-key'); const v=inp.value.trim();
      if(v==='') delete rowEff[k]; else rowEff[k]=v;
      load();
    });
  });
  // 備考 の直接入力 → 見積書の「備考」列に転記される。価格には影響しない（空なら備考なし）。
  $('#detailCol').querySelectorAll('input.noteinp').forEach(inp=>{
    inp.addEventListener('change',()=>{
      const k=inp.getAttribute('data-key'); const v=inp.value;
      if(v.trim()==='') delete rowNote[k]; else rowNote[k]=v;
      load();
    });
  });
}
// ===== 見積書 出力（このページから）＝発行前に要確認をチェックするゲート付き =====
let gateOpts=null;
function setExpBusy(b){ $('#exportAllBtn').disabled=b; $('#exportOneBtn').disabled = b || !selName; if(b) showExportMsg('処理中…'); }
function showExportMsg(t,isErr){ const m=$('#exportMsg'); m.textContent=t||''; m.style.color=isErr?'#c0392b':'#1f6b35'; }
function exportFlow(scope){
  if(scope==='one' && !selName){ showExportMsg('先に左の一覧で得意先を選んでください',true); return; }
  const opts=Object.assign(calcOpts(),{scope, customer: scope==='one'?selName:null});
  setExpBusy(true);
  fetch('/api/customers-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:'check'},opts))})
    .then(x=>x.json()).then(res=>{
      setExpBusy(false); showExportMsg('');
      if(res.error){ showExportMsg('エラー: '+res.error,true); return; }
      openGate(res,opts); // 要確認の有無にかかわらず、まずプレビューを表示してから発行
    }).catch(e=>{ setExpBusy(false); showExportMsg('通信失敗: '+(e&&e.message||e),true); });
}
function openGate(res,opts){
  gateOpts=opts;
  const who=opts.scope==='all'?'全得意先':opts.customer;
  const hasReview=res.reviewCount>0;
  const missEff=res.missingEffCount||0;
  // 実施日が未設定の対象があるあいだは発行できない（実施日は必須）。
  const canIssue=res.issuableRowCount>0 && missEff===0;
  $('#gateTitle').textContent=who+' の発行プレビュー ― '+res.issuableCustomerCount+'得意先 / '+res.issuableRowCount+'品'+(hasReview?'（要確認 '+res.reviewCount+'件は除外）':'');
  if(missEff>0){
    $('#gateNote').innerHTML='<b style="color:#c0392b">⚠ 実施日が未設定の商品が '+missEff+' 件あります。実施日は発行に必須です。</b><br>'
      +'「戻る」で表に戻り、赤い実施日欄を入力（または上の「実施日 一括」で統一）してから、もう一度この画面を開いて発行してください。';
  } else if(!canIssue){
    $('#gateNote').innerHTML='発行できる明細がありません'+(hasReview?'（'+res.reviewCount+'件すべてが要確認のため除外）':'')+'。「戻る」で設定や紐付けを見直してください。';
  } else {
    $('#gateNote').innerHTML='以下が<b>見積書に出力される内容</b>です（得意先ごとに1枚）。確認して問題なければ下の「'+(hasReview?'要確認を除外して発行':'この内容で発行')+'」を押してください。'
      +(hasReview?' 価格異常・低一致の <b>'+res.reviewCount+'</b> 件は見積書に載りません（下部の「要確認」一覧）。':'');
  }
  let body='';
  // ⓪ 実施日が未設定（必須）の一覧 ― あれば発行ブロック。最初に目立たせる。
  if(missEff>0){
    body+='<div class="pv-sec-rev" style="background:#fdecea;color:#922b21">⚠ 実施日が未設定（発行に必須）'+missEff+'件</div>';
    body+='<table><thead><tr><th>得意先</th><th>仕入先</th><th>商品コード</th><th>商品名</th></tr></thead><tbody>';
    for(const r of (res.missingEff||[])){
      body+='<tr class="price"><td>'+esc(r.customer)+'</td><td><span class="sup-badge">'+esc(r.supplier)+'</span></td>'
        +'<td class="pcode">'+esc(r.productCode||'')+'</td><td>'+esc(r.productName)+'</td></tr>';
    }
    body+='</tbody></table>';
    if((res.missingEff||[]).length<missEff) body+='<div class="muted" style="padding:8px">…ほか '+(missEff-res.missingEff.length)+' 件</div>';
  }
  // ① プレビュー（実際に発行される内容）
  for(const c of (res.preview||[])){
    body+='<div class="pv-cust"><div class="pv-head">'+esc(c.customer)+' <span class="pv-cnt">'+c.productCount+'品</span></div>';
    body+='<table><thead><tr><th>仕入先</th><th>商品コード</th><th>商品名</th><th class="num">現売価</th><th class="num">改定後売価</th><th>実施日</th><th>備考</th></tr></thead><tbody>';
    for(const r of c.rows){
      body+='<tr><td><span class="sup-badge">'+esc(r.supplier)+'</span></td><td class="pcode">'+esc(r.productCode||'')+'</td><td>'+prodLink(c.customer, r.supplier, r.productCode, r.productName)+'</td>'
        +'<td class="num">'+yen(r.currentSell)+'</td><td class="num">'+yen(r.newSell)+'</td>'
        +'<td>'+esc(r.effectiveDate||'')+'</td><td>'+esc(r.note||'')+'</td></tr>';
    }
    body+='</tbody></table></div>';
  }
  if(res.previewTruncated) body+='<div class="muted" style="padding:8px">…プレビュー表示は一部のみ（得意先数が多いため）。発行は全 '+res.issuableCustomerCount+' 得意先に対して行われます。</div>';
  // ② 要確認（発行から除外）
  if(hasReview){
    body+='<div class="pv-sec-rev">⚠ 要確認（発行から除外）'+res.reviewCount+'件</div>';
    body+='<table><thead><tr><th>得意先</th><th>仕入先</th><th>商品名</th><th class="num">現単価</th><th class="num">改定単価</th><th>理由</th></tr></thead><tbody>';
    for(const r of res.review){
      const cls=r.reasonType==='price'?'price':'match';
      body+='<tr class="'+cls+'"><td>'+esc(r.customer)+'</td>'
        +'<td><span class="sup-badge">'+esc(r.supplier)+'</span></td>'
        +'<td>'+esc(r.productName)+(r.makerName?'<div class="muted">メーカー: '+esc(r.makerName)+'</div>':'')+'</td>'
        +'<td class="num">'+yen(r.currentSell)+'</td><td class="num">'+yen(r.newSell)+'</td>'
        +'<td>'+esc(r.reason)+'</td></tr>';
    }
    body+='</tbody></table>';
    if(res.review.length<res.reviewCount) body+='<div class="muted" style="padding:8px">…ほか '+(res.reviewCount-res.review.length)+' 件（表示は先頭'+res.review.length+'件）</div>';
  }
  $('#gateBody').innerHTML=body;
  $('#gateSummary').textContent='発行: '+res.issuableCustomerCount+' 得意先 / '+res.issuableRowCount+' 品'+(hasReview?'　／　除外（要確認）: '+res.reviewCount+' 件':'');
  const issueBtn=$('#gateIssue');
  issueBtn.textContent=missEff>0?'実施日を入力してください（発行不可）':(hasReview?'要確認を除外して発行':'この内容で発行');
  issueBtn.disabled=!canIssue;
  $('#gateOverlay').classList.add('show');
}
function closeGate(){ $('#gateOverlay').classList.remove('show'); }
function doIssue(opts){
  setExpBusy(true);
  fetch('/api/customers-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:'issue'},opts))})
    .then(x=>x.json()).then(res=>{
      setExpBusy(false); showExportMsg('');
      if(!res.ok){
        // 実施日未設定など、サーバ側で発行をブロックした場合はメッセージを出してゲートは閉じない（戻って直せる）。
        if(res.reason==='missing_eff'){ showExportMsg(res.message||'実施日が未設定の商品があります。',true); if(selName) load(); return; }
        closeGate(); showExportMsg('発行に失敗: '+(res.message||res.error||''),true); return;
      }
      closeGate();
      // 提出履歴を更新（今回提出した得意先に「✅ 提出済」を付ける）
      if(res.issuedCustomers && res.issuedCustomers.length){
        const now=new Date().toISOString();
        for(const nm of res.issuedCustomers){ const prev=ISSUED[nm]||{}; ISSUED[nm]={lastIssuedAt:now,count:(prev.count||0)+1,quoteNo:prev.quoteNo||'',itemCount:prev.itemCount||0,folder:res.folderName||''}; }
        renderList(); if(selName) selectCust(selName);
      }
      loadIssueLog().then(()=>load()); // 履歴更新＋顧客データ再取得（発行したアイテムを「提出済み」別枠へ移す）
      showResult(res);
    }).catch(e=>{ setExpBusy(false); showExportMsg('発行に失敗: '+(e&&e.message||e),true); });
}
function showResult(res){
  const who=res.scope==='all'?'全得意先':res.customer;
  const el=$('#exportResult'); el.style.display='block';
  el.innerHTML='<div class="ok-banner"><b>✓ 見積書を発行しました</b>（'+esc(who)+'）　'
    +res.count+' 件 ／ フォルダ: '+esc(res.folderName)
    +(res.reviewCount?'　／ 要確認 '+res.reviewCount+' 件は「'+esc(res.reviewFile||'要確認')+'」に控え':'')
    +' <button id="openFolderBtn">📁 フォルダを開く</button></div>';
  const b=document.getElementById('openFolderBtn');
  if(b) b.addEventListener('click',()=>{ fetch('/api/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:res.folder})}).catch(()=>{}); });
}

// 起動時：メインページと同じ既定値を settings.json から読んでカスタマイズ操作に反映
async function initControls(){
  try{
    const r=await fetch('/api/settings').then(x=>x.json());
    const s=r&&r.settings?r.settings:{};
    const df=s.default||{}; const rd=s.rounding||{}; const up=s.selfCostUplift||{};
    if(df.type) $('#cRule').value=df.type;
    if(df.factor!=null) $('#cFactor').value=df.factor;
    // メイン設定の 端数単位/処理 を「まるめ」プルダウンの "単位|処理" 値に合成。該当が無ければ既定のまま。
    const u=(rd.unit!=null)?String(rd.unit):'0.01';
    const md=rd.mode||'round';
    const want=u+'|'+md;
    if([...$('#cRound').options].some(o=>o.value===want)) $('#cRound').value=want;
    if(up.rate!=null) $('#cUplift').value=up.rate;
    // 価格帯別ルールの「それ以上」既定を、全体ルールに合わせて初期化（帯はOFFが既定）。
    priceBands=[{max:null, rule:(df.type||'add_increase'), factor:(df.factor!=null?Number(df.factor):1.25)}];
  }catch(e){/* 既定のHTML値のまま */}
  toggleFactor();
  renderBands();
}

$('#reloadBtn').addEventListener('click',async()=>{ await loadIssueLog(); load(); });
$('#recalcBtn').addEventListener('click',load);
// 左の得意先一覧の開閉（右の明細を広く使う）
$('#toggleListBtn').addEventListener('click',()=>{
  const wrap=document.querySelector('.wrap');
  const collapsed=wrap.classList.toggle('list-collapsed');
  $('#toggleListBtn').textContent = collapsed ? '▶ 一覧を表示' : '◀ 一覧を隠す';
});
// 低マージン警告のしきい値変更 → 再計算不要（粗利率はクライアントで算出）。表示だけ即更新。
$('#cLowMargin').addEventListener('input',()=>{
  const v=parseFloat($('#cLowMargin').value); lowMarginPct = isNaN(v) ? 15 : v;
  renderList(); if(selName) selectCust(selName);
});
$('#reloadPolicyBtn').addEventListener('click', async ()=>{ await initControls(); load(); }); // メインの全体方針を取り込み直す
// 価格帯別ルールのON/OFF：ONで帯エディタ表示＋単体ルールを無効化（帯が全体を支配）、OFFで従来の単体ルール。
$('#cBandOn').addEventListener('change',()=>{
  const on=bandsEnabled();
  $('#bandBox').style.display = on?'':'none';
  $('#cRule').disabled = on; $('#cFactor').disabled = on;
  $('#cBandFld').querySelector('label').style.color = on?'#1f6fb2':'';
  if(on) renderBands();
  load();
});
$('#search').addEventListener('input',applyFilter);
$('#recentYears').addEventListener('change',applyFilter);
$('#resetIssuedBtn').addEventListener('click',resetAllIssued);
$('#exportAllBtn').addEventListener('click',()=>exportFlow('all'));
$('#exportOneBtn').addEventListener('click',()=>exportFlow('one'));
// 基幹システム取込CSV（単価履歴／仕入原価）のダウンロードは sim 画面の「📅 実施日カレンダー」へ移動した。
$('#gateClose').addEventListener('click',closeGate);
$('#gateBack').addEventListener('click',closeGate);
$('#gateIssue').addEventListener('click',()=>{ if(gateOpts) doIssue(gateOpts); });
$('#gateOverlay').addEventListener('click',e=>{ if(e.target===$('#gateOverlay')) closeGate(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && $('#gateOverlay').classList.contains('show')) closeGate(); });
// ルール/端数の変更は即再計算。掛率・自社%・実施日はEnterまたはフォーカスアウトで再計算（打鍵ごとの連打を防ぐ）。
$('#cRule').addEventListener('change',()=>{ toggleFactor(); load(); });
$('#cRound').addEventListener('change',load);
['#cFactor','#cUplift','#cEff'].forEach(sel=>{
  const el=$(sel);
  el.addEventListener('change',load);
  el.addEventListener('keydown',e=>{ if(e.key==='Enter') load(); });
});
(async()=>{
  await initControls(); await loadIssueLog(); await load();
  // メイン表の得意先リンク（/customers?customer=...）で来たら、その得意先を選択して表示。
  try{
    const want=new URLSearchParams(location.search).get('customer');
    if(want){
      if(DATA.find(x=>x.name===want)){
        selectCust(want);
        const sel=$('#listCol .cust.sel'); if(sel) sel.scrollIntoView({block:'center'});
      } else {
        $('#msg').textContent='「'+want+'」は現在の改定対象に見つかりませんでした（実施日・照合の結果に含まれていない可能性）。';
      }
    }
  }catch(e){}
})();
</script>
</body></html>`;

module.exports = { CUSTOMERS_PAGE };
