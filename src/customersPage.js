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
</style></head><body>
<header>
  <h1>👥 得意先別 商品一覧</h1>
  <span class="sub">得意先を選ぶと、その得意先が買う全商品（複数メーカーまたがり）を表示</span>
  <span class="spacer"></span>
  <a href="/">← シミュレーション画面へ</a>
  <a href="/list">📊 一覧・進捗</a>
</header>

<div class="toolbar">
  <button class="go" id="toggleListBtn" style="background:#5b6b8b" title="左の得意先一覧を隠して、右の明細を広く使えます（もう一度押すと表示）">◀ 一覧を隠す</button>
  <button class="go" id="reloadBtn">🔄 最新の状態を読み込む</button>
  <input id="search" type="text" placeholder="得意先を検索…">
  <span id="msg" class="muted"></span>
  <span class="spacer" style="margin-left:auto"></span>
  <span id="issuedStat" class="muted" title="見積書を提出（発行）済みの得意先数">提出済 0</span>
  <button class="go" id="resetIssuedBtn" style="background:#8a6d3b" title="提出済みマークをすべて消します（新しい改定サイクルの開始時に使用）。見積書ファイルは消えません">提出履歴をリセット</button>
</div>

<div class="calcbar">
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
</div>

<div class="exportbar">
  <button class="exp" id="exportAllBtn">📄 全得意先の見積書を作成</button>
  <button class="exp one" id="exportOneBtn" disabled>📄 選択中の得意先だけ作成</button>
  <span class="exphint">上の設定で、得意先ごと1枚（複数メーカー横断）の見積書を出力します。発行前に内容をプレビュー表示します（要確認は除外）。</span>
  <span id="exportMsg" class="muted"></span>
</div>
<div id="exportResult" style="display:none"></div>

<div class="exportbar" id="hanbaiBar" style="background:#eef3fb;border-color:#cdddf3">
  <b style="color:#1f4e78">📥 販売大臣へ取込</b>
  <label style="font-size:12px;color:#33405a">実施日が <input type="date" id="hanbaiCutoff" style="font:inherit;padding:4px 6px;border:1px solid #c7ced8;border-radius:6px"> までに到来した</label>
  <select id="hanbaiScope" style="font:inherit;padding:4px 6px;border:1px solid #c7ced8;border-radius:6px">
    <option value="all">改定すべて</option>
    <option value="issued">発行済みの得意先だけ</option>
  </select>
  <button class="exp" id="hanbaiExportBtn" style="background:#2e6b3e">単価履歴CSVをダウンロード</button>
  <span class="exphint">実施日が来た価格改定を、販売大臣の「単価履歴」取込用CSV（Shift_JIS）にします。消費税区分・税率表№はDBから自動付与。既定は改定すべて（発行の有無を問わず）。</span>
  <span id="hanbaiMsg" class="muted"></span>
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
let selName=null; // 選択中の得意先名
let ISSUED={};    // 提出（発行）履歴 { 得意先名: {lastIssuedAt,count,quoteNo,itemCount,folder} }
let rowRules={};  // 行ごと転嫁ルールの上書き { rowKey: ruleType }（空=全体ルール）
let rowSell={};   // 行ごと 改定後売価 の手入力 { rowKey: 入力文字列 }
let rowEff={};    // 行ごと 実施日 の手入力 { rowKey: 入力文字列 }
let rowNote={};   // 行ごと 備考 の手入力 { rowKey: 入力文字列 }（見積書の備考列に転記）
let rowRound={};  // 行ごと まるめ の上書き { rowKey: "単位|処理" 例 "1|floor" }（空=全体のまるめ）
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
// 行ルールの選択肢（先頭＝全体ルールを継承）
const ROW_RULE_OPTS=[['','（全体）'],['add_increase','上乗せ'],['keep_margin_rate','粗利維持'],['markup','掛率×'],['sell_cost_rate','売価×仕入率'],['keep_sell','据置']];
function rowRuleSelect(p){
  const cur = rowRules[p.rowKey]||'';
  const opts = ROW_RULE_OPTS.map(o=>'<option value="'+o[0]+'"'+(o[0]===cur?' selected':'')+'>'+o[1]+'</option>').join('');
  return '<select class="rowrule'+(cur?' ov':'')+'" data-key="'+esc(p.rowKey)+'">'+opts+'</select>';
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
    rowRules, rowSell, rowEff, rowNote, rowRound,
  };
}
const RULE_LABEL={add_increase:'上乗せ',keep_margin_rate:'粗利維持',markup:'掛率×',sell_cost_rate:'売価×仕入率',keep_sell:'据置'};
const MODE_LABEL={round:'四捨五入',ceil:'切上げ',floor:'切捨て'};
function toggleFactor(){ $('#cFactorBox').style.display = ($('#cRule').value==='markup')?'flex':'none'; }
function showApplied(a){
  if(!a){ $('#appliedMsg').textContent=''; return; }
  const parts=[ (RULE_LABEL[a.ruleType]||a.ruleType)+(a.ruleType==='markup'?(' '+a.factor):''),
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
function applyFilter(){
  const q=($('#search').value||'').trim();
  filtered = q ? DATA.filter(c=>c.name.indexOf(q)>=0) : DATA.slice();
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
  if(!filtered.length){ $('#listCol').innerHTML='<div class="empty">該当する得意先がありません。<br>照合結果がない場合は「↻ 照合を実行」してください。</div>'; return; }
  let html='';
  for(const c of filtered){
    const sel = c.name===selName ? ' sel' : '';
    const rev = c.reviewCount ? '<span class="rev">要確認'+c.reviewCount+'</span>' : '';
    const lowN = lowMarginCount(c);
    const low = lowN ? '<span class="lowm">薄利'+lowN+'</span>' : '';
    const iss = ISSUED[c.name];
    const issBadge = iss ? '<span class="issued" title="最終提出 '+esc(iss.lastIssuedAt||'')+(iss.count>1?' / 提出'+iss.count+'回':'')+'">✅ 提出済 '+issuedShort(iss.lastIssuedAt)+(iss.count>1?'×'+iss.count:'')+'</span>' : '';
    html+='<div class="cust'+sel+(iss?' done':'')+'" data-name="'+esc(c.name)+'" onclick="selectCust(this.getAttribute(\\'data-name\\'))">'
      +'<div style="min-width:0"><div class="nm">'+esc(c.name)+'</div>'
      +'<div class="meta">仕入先 '+c.supplierCount+' 社'+rev+low+issBadge+'</div></div>'
      +'<span class="cnt">'+c.productCount+'</span>'
      +'</div>';
  }
  $('#listCol').innerHTML=html;
}
function selectCust(name){
  selName=name;
  const oneBtn=$('#exportOneBtn');
  if(oneBtn){ oneBtn.disabled=false; oneBtn.textContent='📄 「'+(name.length>12?name.slice(0,12)+'…':name)+'」だけ作成'; }
  renderList();
  const c=DATA.find(x=>x.name===name);
  if(!c){ $('#detailCol').innerHTML='<div class="empty">データがありません。</div>'; return; }
  const supChips=c.suppliers.map(s=>'<span class="sup-badge">'+esc(s)+'</span>').join(' ');
  let html='<div class="detail-head"><h2>'+esc(c.name)+'</h2>'
    +'<div class="sum">該当商品 <b>'+c.productCount+'</b> 品／仕入先 <b>'+c.supplierCount+'</b> 社　'+supChips+'</div></div>';
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
  html+='<div class="table-pad"><table><thead>'
    +'<tr><th rowspan="2">仕入先</th><th rowspan="2">商品コード</th><th rowspan="2">商品名</th>'
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
      +'<td>'+rowRuleSelect(p)+'</td>'
      +'<td>'+rowRoundSelect(p)+'</td>'
      +'<td><input class="cellinp effinp'+(p.effManual?' man':'')+'" data-key="'+esc(p.rowKey)+'" value="'+esc(p.effectiveDate||'')+'" placeholder="例: 2026-07-01" title="直接入力できます（2026/7/1・7月1日 等でもISO表記に揃います）"></td>'
      +'<td><input class="cellinp noteinp'+(p.note?' man':'')+'" data-key="'+esc(p.rowKey)+'" value="'+esc(p.note||'')+'" placeholder="（任意）" title="ここに入力すると見積書の「備考」列に転記されます"></td>'
      +'</tr>';
  }
  html+='</tbody></table></div>';
  $('#detailCol').innerHTML=html;
  // 行まるめの変更 → その行だけ別のまるめで再計算（サーバ集計＝見積書と同じ計算）。
  //  ※ rowround も .rowrule クラスを持つので、行ルールの配線が拾わないよう先に処理して除外する。
  $('#detailCol').querySelectorAll('select.rowround').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const k=sel.getAttribute('data-key');
      if(sel.value) rowRound[k]=sel.value; else delete rowRound[k];
      load();
    });
  });
  // 行ルールの変更 → その行だけ別ルールで再計算（サーバ集計＝見積書と同じ計算）。rowround は除外。
  $('#detailCol').querySelectorAll('select.rowrule:not(.rowround)').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const k=sel.getAttribute('data-key');
      if(sel.value) rowRules[k]=sel.value; else delete rowRules[k];
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
  const canIssue=res.issuableRowCount>0;
  $('#gateTitle').textContent=who+' の発行プレビュー ― '+res.issuableCustomerCount+'得意先 / '+res.issuableRowCount+'品'+(hasReview?'（要確認 '+res.reviewCount+'件は除外）':'');
  if(!canIssue){
    $('#gateNote').innerHTML='発行できる明細がありません'+(hasReview?'（'+res.reviewCount+'件すべてが要確認のため除外）':'')+'。「戻る」で設定や紐付けを見直してください。';
  } else {
    $('#gateNote').innerHTML='以下が<b>見積書に出力される内容</b>です（得意先ごとに1枚）。確認して問題なければ下の「'+(hasReview?'要確認を除外して発行':'この内容で発行')+'」を押してください。'
      +(hasReview?' 価格異常・低一致の <b>'+res.reviewCount+'</b> 件は見積書に載りません（下部の「要確認」一覧）。':'');
  }
  let body='';
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
  issueBtn.textContent=hasReview?'要確認を除外して発行':'この内容で発行';
  issueBtn.disabled=!canIssue;
  $('#gateOverlay').classList.add('show');
}
function closeGate(){ $('#gateOverlay').classList.remove('show'); }
function doIssue(opts){
  setExpBusy(true);
  fetch('/api/customers-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:'issue'},opts))})
    .then(x=>x.json()).then(res=>{
      setExpBusy(false); showExportMsg(''); closeGate();
      if(!res.ok){ showExportMsg('発行に失敗: '+(res.error||''),true); return; }
      // 提出履歴を更新（今回提出した得意先に「✅ 提出済」を付ける）
      if(res.issuedCustomers && res.issuedCustomers.length){
        const now=new Date().toISOString();
        for(const nm of res.issuedCustomers){ const prev=ISSUED[nm]||{}; ISSUED[nm]={lastIssuedAt:now,count:(prev.count||0)+1,quoteNo:prev.quoteNo||'',itemCount:prev.itemCount||0,folder:res.folderName||''}; }
        renderList(); if(selName) selectCust(selName);
      }
      loadIssueLog().then(()=>{ renderList(); if(selName&&DATA.find(x=>x.name===selName)) selectCust(selName); }); // サーバの正確な記録で上書き
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
  }catch(e){/* 既定のHTML値のまま */}
  toggleFactor();
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
$('#search').addEventListener('input',applyFilter);
$('#resetIssuedBtn').addEventListener('click',resetAllIssued);
$('#exportAllBtn').addEventListener('click',()=>exportFlow('all'));
$('#exportOneBtn').addEventListener('click',()=>exportFlow('one'));
// 販売大臣 単価履歴CSV（実施日到来分）のダウンロード
(function(){
  const p=n=>String(n).padStart(2,'0');
  const today=()=>{const d=new Date();return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());};
  const hc=$('#hanbaiCutoff'); if(hc&&!hc.value) hc.value=today();
  $('#hanbaiExportBtn').addEventListener('click',async()=>{
    const cutoff=($('#hanbaiCutoff').value||today());
    const issuedOnly = $('#hanbaiScope').value==='issued';
    const scopeLabel = issuedOnly ? '発行済みの得意先' : '改定すべて';
    const msg=$('#hanbaiMsg'); msg.style.color='#6b7785'; msg.textContent='確認中…';
    try{
      const r=await fetch('/api/hanbai-export-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cutoff,issuedOnly})}).then(x=>x.json());
      if(!r.ok){ msg.style.color='#c0392b'; msg.textContent='エラー: '+(r.error||''); return; }
      if(!r.count){ msg.style.color='#b8860b'; msg.textContent='対象なし（'+cutoff+' までに実施日が来た'+(issuedOnly?'発行済みの':'')+'改定行はありません）'; return; }
      let warn='';
      if(r.dbError) warn='\\n※ 販売大臣DBに接続できなかったため、消費税区分／税率表№は標準値(2／1)で出力します。';
      else if(r.missingTax) warn='\\n※ '+r.missingTax+' 件はDBに商品が見つからず、消費税は標準値(2／1)で出力します。';
      if(!confirm(cutoff+' までに実施日が到来した改定（'+scopeLabel+'）'+r.count+' 行 / '+r.customerCount+' 得意先 を、販売大臣の単価履歴取込CSVとして出力します。'+warn+'\\n\\nダウンロードしますか？')){ msg.textContent=''; return; }
      msg.style.color='#2e7d32'; msg.textContent='✓ ダウンロードしました（'+r.count+' 行 / '+r.customerCount+' 得意先）。販売大臣の「単価履歴」取込で読み込んでください。';
      window.location='/api/hanbai-export?cutoff='+encodeURIComponent(cutoff)+(issuedOnly?'&issuedOnly=1':'');
    }catch(e){ msg.style.color='#c0392b'; msg.textContent='通信に失敗しました: '+e; }
  });
})();
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
(async()=>{ await initControls(); await loadIssueLog(); load(); })();
</script>
</body></html>`;

module.exports = { CUSTOMERS_PAGE };
