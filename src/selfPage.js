// =====================================================================
//  自社データ（販売実績）取込ルール設定ページ（/self）
//   ・自社販売実績ファイルを取込し、列の役割をユーザに見せる
//   ・「階層セル」(0019  男寿し / 007923  ...商品名... 92988 ※50 13) の
//     パース結果（自社CD・商品名コア・仕入先商品コード・運賃条件・ロット・仕入先コード）
//     を一行ずつ表示してユーザが確認できる
//   ・列の役割と「使う/使わない」設定を settings.json:selfProfile に保存
// =====================================================================
const { SHOGO_LOCK_CSS, SHOGO_LOCK_HTML, SHOGO_LOCK_JS } = require('./shogoLockUi');
const { navLinks } = require('./navUi');
const SELF_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>自社データ取込設定</title>
<style>
  body{margin:0;font-family:"メイリオ","Meiryo","Segoe UI",sans-serif;background:#f4f6f9;color:#1f2733;font-size:13px}
  header{background:#1f4e78;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  header h1{font-size:16px;margin:0}
  header a{color:#cfe0f0;font-size:12px;text-decoration:none;background:rgba(255,255,255,.08);padding:5px 10px;border-radius:6px}
  header a:hover{background:rgba(255,255,255,.18)}
  header .spacer{margin-left:auto}
  .card{background:#fff;border:1px solid #e2e6ec;border-radius:10px;margin:12px 16px;padding:12px 14px}
  .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  button.go{background:#1f4e78;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
  table{border-collapse:collapse;width:100%;background:#fff;font-size:12px}
  th,td{border:1px solid #e2e6ec;padding:4px 6px;vertical-align:middle}
  th{background:#eef2f7;text-align:left;white-space:nowrap}
  .role{font-weight:700;color:#1f4e78}
  .role.unused{color:#aa6}
  .role.code{color:#1976d2}
  .role.name{color:#2e7d32}
  .muted{color:#6b7785;font-size:11px}
  .ok{color:#2e7d32} .err{color:#c0392b}
  .hint{color:#6b7785;font-size:12px}
  .row{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px}
  .col{background:#f8fafc;border:1px solid #dde3ec;border-radius:8px;padding:8px 10px;min-width:200px}
  .col h4{margin:0 0 6px;font-size:12px;color:#1f4e78}
  select{padding:3px;font-size:12px}
  .swatch{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
  .sw-name{background:#2e7d32} .sw-code{background:#1976d2} .sw-unused{background:#aa6}
  .info-box{background:#fff8e1;border:1px solid #ffe082;padding:8px 10px;border-radius:6px;font-size:12px;margin:6px 0}
${SHOGO_LOCK_CSS}
</style></head><body>
${SHOGO_LOCK_HTML}
<header>
  <h1>🗂 自社データ取込設定</h1>
  <span class="hint" style="color:#cfe0f0">販売実績を読み込み、どこが何の情報か確認・保存</span>
  <span class="spacer"></span>
  ${navLinks('self')}
</header>

<div class="card" id="srcCard">
  <h3 style="margin:0 0 6px">📂 照合で実際に使われる販売実績ファイル</h3>
  <div class="hint" style="margin-bottom:8px">
    照合.bat ／ シミュレーション画面「↻ 照合を実行」が裏で読み込んでいる本番ファイル。<br>
    config.js の <code>hanbai.path</code> が フォルダ指定 の場合、その中の <b>最新の .XLS/.xlsx/.csv</b> が毎回自動選択されます。
  </div>
  <div id="srcInfo" class="muted">読込中…</div>
</div>

<div class="card" style="border-left:4px solid #1f6fb2">
  <h3 style="margin:0 0 6px">🏷 商品マスタの入力ルール（照合の精度を上げる）</h3>
  <div class="hint" style="line-height:1.9">
    DB直結では商品マスタ（SHOHIN）の項目を次のルールで読みます：<br>
    ・<b style="color:#2e7d32">商品名1</b> ＝ <b>商品名</b>（見積・画面の表示名／名前照合に使用＝クリーンな名前）<br>
    ・<b style="color:#1976d2">商品名3</b> ＝ <b>メーカー品番</b>（CD一致に使用＝ここに入れると高精度で確実に照合）<br>
    ・商品名2／4／5 ＝ <span style="color:#aa6">使いません</span>（運賃・入数などのメモ欄。照合には使わない）<br>
    👉 <b>メーカー品番は「商品名3」に登録</b>してください。シミュレーション画面の「🏷 CD一致化候補」CSVが、登録すべき品の一覧です（登録→「↻ 照合を実行」でCD一致に昇格）。
  </div>
</div>

<div class="card" id="backupCard" style="border-left:4px solid #2e7d32">
  <h3 style="margin:0 0 6px">💾 設定のバックアップと復元</h3>
  <div class="hint" style="margin-bottom:8px;line-height:1.8">
    設定（転嫁ルール・単価調整・<b>商品の手動紐付け（📌）</b>・コード化の確定/却下・除外設定など）を保存するたびに、<b>上書き直前の状態を自動で世代バックアップ</b>しています（直近50世代・<code>settings_backup/</code>）。<br>
    紐付けやルールを誤って変更してしまったときは、下の一覧から選んで<b>ワンクリックで元に戻せます</b>。復元の前に「今の状態」も自動退避するので、戻したあとに「やっぱり元へ」も可能です。
  </div>
  <div id="backupList" class="muted">読込中…</div>
</div>

<div class="card" id="costAuditCard" style="border-left:4px solid #b71c1c">
  <h3 style="margin:0 0 6px">🔎 仕入原価の異常チェック（CSV列ズレ・逆ザヤ）</h3>
  <div class="hint" style="margin-bottom:8px;line-height:1.8">
    販売大臣のCSV受入で列を取り違えると、仕入原価欄に「年(2006/2007)」や桁違いの値が紛れ込みます。<br>
    <b>商品マスタCSVを プロジェクト直下 か <code>input/</code> に置く</b>と（ファイル名に「商品マスタ／商品／master」を含むもの）、ここで最新状態を監査できます。<br>
    判定：<b style="color:#b71c1c">A 原価が「年」に見える</b>（列ズレ確定的）／<b>B 逆ザヤ</b>（原価＞売価）／<b>C 高額</b>（原価＞2000円）。<br>
    ※ 見積の現仕入はメーカー見積取込が源で、この商品マスタ原価は使いません。これは<b>マスタ自体の汚れ</b>を販売大臣で直すための一覧です。
  </div>
  <div class="toolbar">
    <button class="go" id="costAuditBtn">🔄 チェックする</button>
    <a class="go" id="costAuditDl" href="/api/cost-audit.csv" download style="display:none;text-decoration:none">📥 一覧CSV</a>
    <span id="costAuditMsg" class="muted"></span>
  </div>
  <div id="costAuditResult" style="margin-top:8px"></div>
</div>

<details class="prevwrap" style="border:1px solid #e2e6ec;border-radius:8px;padding:8px 14px;margin-bottom:14px;background:#fff">
<summary style="cursor:pointer;font-weight:700;font-size:14px;color:#33415a;padding:4px 0">🔍 別ファイルをプレビュー（取込ルールの確認用）　<span class="hint" style="font-weight:normal">※DB直結時は予備（ファイル方式・DBなしPC用）— クリックで開く</span></summary>
<div style="padding-top:6px">
  <div class="hint" style="margin-bottom:8px">
    上の本番ファイルとは別に、任意のファイルを開いて列構成・パース結果を確認できます。<br>
    ここで保存した「列の役割」は <code>settings.json:selfProfile</code> に書き込まれ、次回以降の取込で使われます。
  </div>
  <div class="toolbar">
    <label>① ファイルを選択
      <input type="file" id="file" accept=".XLS,.xls,.xlsx,.csv">
    </label>
    <button class="go" id="loadBtn" disabled>② 読み込み</button>
    <span id="msg" class="muted"></span>
  </div>
  <div class="hint" style="margin-top:6px">
    対応形式: .XLS（販売大臣の出力・Excel必要） / .xlsx / .csv（Shift_JIS or UTF-8 自動判定）。先頭30行をプレビュー表示。
  </div>
</div>

<div class="card" id="previewCard" style="display:none">
  <h3 style="margin:0 0 6px">プレビューと列の役割設定</h3>
  <div id="previewSum" class="hint" style="margin-bottom:6px"></div>

  <div class="info-box">
    <b>階層セル</b>とは：1列目に「得意先見出し行」「商品行」「合計行」が混在している列です。<br>
    商品行の中身は次の順番で詰まっています：<br>
    <span class="role code">[自社商品CD]</span>＋
    <span class="role name">商品名コア</span>＋
    <span class="hint">(入数)</span>＋
    <span class="hint">（運賃条件※和字3+）</span>＋
    <span class="hint">「注記」</span>＋
    <span class="role code">メーカー品番(4-7桁)</span>＋
    <span class="hint">※発注ロット</span>＋
    <span class="role">仕入先コード(末尾1-4桁)</span><br>
    例: <code style="font-size:11px">07394 白楊8寸... <span style="color:#aaa">3点</span> <b style="color:#7a5a00">100</b>（10ｹ元/未満800円）「元払」 <b style="color:#1976d2">1124803</b> ※1000 <b>88</b></code>
  </div>

  <div style="overflow:auto;max-height:200px">
    <table id="rawTbl"><thead></thead><tbody></tbody></table>
  </div>

  <div id="roles" class="row"></div>

  <h4 style="margin:12px 0 6px">階層セルのパース結果（先頭〜12件）</h4>
  <div class="hint" style="margin-bottom:6px">
    1列目（階層セル）の各行を、商品ID／商品名コア／入数／運賃条件／注記／メーカー品番／ロット／仕入先コードに分解して表示します。
  </div>
  <div style="overflow:auto;max-height:400px">
    <table id="parsedTbl">
      <thead><tr>
        <th>行種別</th>
        <th>自社CD<br><span class="muted">先頭数字</span></th>
        <th>商品名コア<br><span class="muted">照合に使う</span></th>
        <th>入数<br><span class="muted">パック数</span></th>
        <th>運賃条件<br><span class="muted">和字3+の()</span></th>
        <th>注記<br><span class="muted">「」/[]内</span></th>
        <th>メーカー品番<br><span class="muted">4-7桁</span></th>
        <th>ロット<br><span class="muted">※の値</span></th>
        <th>仕入先<br><span class="muted">末尾1-4桁</span></th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div style="margin-top:10px">
    <button class="go" id="saveBtn">💾 この設定で保存（selfProfile）</button>
    <span id="saveMsg" class="muted"></span>
  </div>
</div>
</details>

<script>
${SHOGO_LOCK_JS}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const ROLES = [
  { v:'cell', label:'階層セル（コード+商品名+...）' },
  { v:'date', label:'購買日' },
  { v:'sell', label:'現売単価' },
  { v:'amount', label:'年間金額' },
  { v:'cost', label:'現仕入単価' },
  { v:'unused', label:'使わない' },
];
let pendingHeaders = [];
let pendingGrid = [];
let pendingParsed = [];

$('#file').addEventListener('change', () => {
  $('#loadBtn').disabled = !$('#file').files.length;
  $('#msg').textContent = '';
});

$('#loadBtn').addEventListener('click', async () => {
  const f = $('#file').files[0]; if (!f) return;
  $('#msg').textContent = '読み込み中…（XLSは時間がかかる場合があります）';
  $('#msg').className = 'muted';
  try {
    const buf = await f.arrayBuffer();
    let bin = ''; const u8 = new Uint8Array(buf);
    for (let i=0; i<u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);
    const res = await fetch('/api/upload-self', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ b64, filename: f.name })
    }).then(x => x.json());
    if (!res.ok) { $('#msg').textContent = '読み込み失敗: '+(res.error||''); $('#msg').className='err'; return; }
    pendingHeaders = res.headers || [];
    pendingGrid = res.grid || [];
    pendingParsed = res.parsed || [];
    $('#msg').textContent = '✓ 全'+res.total+'行を読込（先頭'+pendingGrid.length+'行をプレビュー）';
    $('#msg').className = 'ok';
    renderAll();
  } catch (e) {
    $('#msg').textContent = '読み込み失敗: '+e; $('#msg').className = 'err';
  }
});

function guessRole(header, ci) {
  const h = String(header || '').replace(/\\s/g,'');
  if (ci === 0) return 'cell';
  if (/購買|日付|暦/.test(h)) return 'date';
  if (/最新単価|販売単価|単価/.test(h) && !/原/.test(h)) return 'sell';
  if (/金額/.test(h)) return 'amount';
  if (/原単価|原価|仕入/.test(h)) return 'cost';
  return 'unused';
}

function renderAll() {
  $('#previewCard').style.display = '';
  const pv=document.querySelector('.prevwrap'); if(pv) pv.open=true; // 折りたたみ内なので、読み込んだら自動で開く
  $('#previewSum').textContent = pendingGrid.length+'行を表示（全'+pendingGrid.length+'件中）';

  // 生データテーブル
  const th = pendingHeaders.map((h,i)=>'<th>'+(h?esc(h):'(列'+(i+1)+')')+'</th>').join('');
  $('#rawTbl thead').innerHTML = '<tr>'+th+'</tr>';
  const tb = $('#rawTbl tbody'); tb.innerHTML = '';
  pendingGrid.slice(0, 15).forEach((row) => {
    const tds = row.map((c)=>'<td>'+esc(c)+'</td>').join('');
    tb.innerHTML += '<tr>'+tds+'</tr>';
  });

  // 列の役割
  const roles = $('#roles'); roles.innerHTML = '';
  pendingHeaders.forEach((h, i) => {
    const def = guessRole(h, i);
    const opts = ROLES.map(r=>'<option value="'+r.v+'"'+(r.v===def?' selected':'')+'>'+r.label+'</option>').join('');
    const sample = (pendingGrid[1] && pendingGrid[1][i] != null) ? String(pendingGrid[1][i]) : '';
    const div = document.createElement('div'); div.className = 'col';
    div.innerHTML = '<h4>列'+(i+1)+'：'+esc(h||'(無名)')+'</h4>'+
      '<div class="hint" style="margin-bottom:4px">サンプル: '+esc(sample.slice(0,60))+'</div>'+
      '<select data-i="'+i+'" class="role-sel">'+opts+'</select>';
    roles.appendChild(div);
  });

  // 階層セルのパース結果（12件）
  const ptb = $('#parsedTbl tbody'); ptb.innerHTML = '';
  pendingParsed.slice(0, 12).forEach((p, idx) => {
    const cell = String((pendingGrid[idx] && pendingGrid[idx][0]) || '');
    let kind = '商品';
    if (/^[\\s　]*※\\s*合計/.test(cell)) kind = '合計';
    else if (/^\\s*\\d{1,5}\\s/.test(cell) && !p.supplierCode && !p.lot) kind = '得意先';
    const sid = p.supplierId || '';
    const sidHtml = sid ? '<b>'+esc(sid)+'</b>' : '<span class="muted">—</span>';
    ptb.innerHTML += '<tr>'+
      '<td>'+kind+'</td>'+
      '<td><b style="color:#1976d2">'+esc(p.productCode||extractLeadCode(cell))+'</b></td>'+
      '<td>'+esc(p.core||'')+'</td>'+
      '<td>'+esc(p.packSize||'')+'</td>'+
      '<td class="muted">'+esc(p.freight||'')+'</td>'+
      '<td class="muted">'+esc(p.note||'')+'</td>'+
      '<td><b style="color:#1976d2">'+esc(p.supplierCode||'')+'</b></td>'+
      '<td class="muted">'+esc(p.lot||'')+'</td>'+
      '<td>'+sidHtml+'</td>'+
    '</tr>';
  });
}

// 先頭の数字（自社コード or 得意先コード）を抽出
function extractLeadCode(s) {
  const m = String(s||'').match(/^\\s*(\\d{3,7})\\s/);
  return m ? m[1] : '';
}

$('#saveBtn').addEventListener('click', async () => {
  const profile = {
    headers: pendingHeaders,
    roles: Array.from(document.querySelectorAll('.role-sel')).map((s) => ({ col: Number(s.dataset.i), role: s.value })),
    _savedAt: new Date().toISOString(),
  };
  $('#saveMsg').textContent = '保存中…'; $('#saveMsg').className = 'muted';
  const res = await fetch('/api/save-self-profile', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ selfProfile: profile })
  }).then(x => x.json());
  if (res.ok) {
    $('#saveMsg').textContent = '✓ 保存しました'; $('#saveMsg').className = 'ok';
  } else {
    $('#saveMsg').textContent = '保存失敗: '+(res.error||''); $('#saveMsg').className = 'err';
  }
});

function fmtBytes(n){
  if(!Number.isFinite(n)) return '';
  if(n < 1024) return n + ' B';
  if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/(1024*1024)).toFixed(1) + ' MB';
}
function fmtDate(iso){
  if(!iso) return '';
  const d = new Date(iso); if(isNaN(d)) return '';
  const p = (n)=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
async function loadHanbaiSource(){
  const target = $('#srcInfo');
  try {
    const r = await fetch('/api/hanbai-source').then(x => x.json());
    const usesDb = (r.source === 'db' || r.source === 'auto');
    let banner = '';
    if (usesDb) {
      const rng = r.dbRange ? (esc(r.dbRange.start)+' 〜 '+esc(r.dbRange.end)) : '過去約1年';
      const cm = (function(){ const v=Number(r.candidateMonths); return (Number.isFinite(v)&&v>=12)?v:0; })(); // 0=全期間
      banner = '<div style="margin-bottom:10px;padding:10px 12px;background:#e9f6ec;border:1px solid #b7e0c0;border-radius:8px;color:#1f6b35;font-size:13px;line-height:1.8">'
        + '<b>✅ 現在は販売大臣DBから直接取得しています'+(r.source==='auto'?'（自動：DBが無いPCのみ下のファイルを使用）':'（DB直結）')+'。</b><br>'
        + '年間金額・損益の集計期間：<b>'+rng+'</b>（実行のたびに「今日を基準に直近約1年」を自動で取り直します）。手動エクスポートは不要です。'
        + '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #b7e0c0">'
        +   '⏳ <b>照合に含める期間（さかのぼり）</b>：'
        +   '<select id="candMonths" style="padding:3px 6px;border:1px solid #b7e0c0;border-radius:4px;font:inherit">'
        +     '<option value="0"'+(cm<12?' selected':'')+'>全期間（過去すべて）</option>'
        +     '<option value="60"'+(cm===60?' selected':'')+'>過去5年（60か月）</option>'
        +     '<option value="36"'+(cm===36?' selected':'')+'>過去3年（36か月）</option>'
        +     '<option value="24"'+(cm===24?' selected':'')+'>過去2年（24か月）</option>'
        +     '<option value="12"'+(cm===12?' selected':'')+'>過去1年（12か月）</option>'
        +   '</select> '
        +   '<button id="candSave" style="padding:4px 12px;background:#1f6b35;color:#fff;border:none;border-radius:4px;cursor:pointer">保存</button>'
        +   ' <span id="candMsg" style="font-size:12px"></span><br>'
        +   '<span style="color:#4a7a55;font-size:12px">この期間に売上がある商品を照合の<b>候補</b>に含めます。短くすると休眠/過去客が減り、長く（全期間）すると季節品も拾えます。'
        +   '自社製造（折箱・9000）は常に全期間。年間金額・損益は直近約1年で計算するので期間を変えても歪みません。変更は次回の「↻ 照合を実行」から有効。</span></div>'
        + (r.selfManufacture && r.selfManufacture.enabled
          ? ('<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #b7e0c0">'
            + '🏭 <b>自社製造品（折箱）をDBから取り込む</b>　'
            + '<button id="selfDbBtn" style="padding:4px 12px;background:#1f6b35;color:#fff;border:none;border-radius:4px;cursor:pointer">DBから取り込んで照合</button>'
            + ' <span id="selfDbMsg" style="font-size:12px"></span><br>'
            + '<span style="color:#4a7a55;font-size:12px">商品マスタの<b>商品分類（自社製造の折箱）</b>から自動抽出します（手入力CSV不要・自社コードの入れ忘れや重複の心配なし）。価格・得意先はDBから、値上げは得意先別ページで手入力。既存の自社製造取込はDB版に置き換え（退避）。</span></div>')
          : '')
        + '<div style="margin-top:6px"><span style="color:#4a7a55">↓ 下の「ファイル」設定は、DBが無いPC（自宅など）や他社運用のための予備です。会社PCでは使われません。</span></div></div>';
    }
    // 「自社製造品をDBから取り込む」ボタンの配線（selfManufacture.enabled のときだけ要素が存在）。
    function bindSelfDb(){
      const b = $('#selfDbBtn'); if(!b) return;
      b.addEventListener('click', async ()=>{
        const msg = $('#selfDbMsg');
        if(!confirm('自社製造品をDBの商品分類から取り込み直します。\\n既存の自社製造の取込CSVはDB版に置き換わります（_old へ退避＝戻せます）。よろしいですか？')) return;
        b.disabled=true; msg.style.color='#6b7785'; msg.textContent='DBから抽出して照合中…（数秒かかります）';
        setShogoLock(true,'自社製造品をDBから取り込み、照合を実行しています…');
        try{
          const res = await fetch('/api/self-from-db',{method:'POST'}).then(x=>x.json());
          if(res.busy){
            msg.style.color='#c0392b'; msg.textContent=res.error||'照合が既に実行中です';
            return;
          }
          if(res.ok){
            const sh = (res.shogo && res.shogo.ok) ? '・照合を更新しました' : (res.shogo ? '・⚠ 照合失敗:'+(res.shogo.error||'') : '');
            msg.style.color='#1f6b35'; msg.textContent='✓ '+res.count+'品をDBから取り込み（'+esc(res.supplier)+'／旧'+res.retired+'本を退避）'+sh+'。シミュレーション画面の「対象」で確認できます。';
          } else { msg.style.color='#c0392b'; msg.textContent='失敗: '+(res.error||''); }
        }catch(e){ msg.style.color='#c0392b'; msg.textContent='失敗: '+e; }
        finally{ b.disabled=false; setShogoLock(false); }
      });
    }
    // 「照合に含める期間」保存ボタンを配線（DB案内バナーがあるときだけ要素が存在）
    function bindPeriod(){
      const b = $('#candSave'); if(!b) return;
      b.addEventListener('click', async ()=>{
        const m = $('#candMonths').value, msg = $('#candMsg');
        msg.style.color='#6b7785'; msg.textContent='保存中…';
        try{
          const res = await fetch('/api/hanbai-period',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({months:m})}).then(x=>x.json());
          if(res.ok){ msg.style.color='#1f6b35'; msg.textContent='✓ 保存（'+(res.candidateMonths>0?res.candidateMonths+'か月':'全期間')+'）。次回の「↻ 照合を実行」から有効'; $('#candMonths').value=String(res.candidateMonths); }
          else { msg.style.color='#c0392b'; msg.textContent='失敗: '+(res.error||''); }
        }catch(e){ msg.style.color='#c0392b'; msg.textContent='失敗: '+e; }
      });
    }
    if (!r.configured) {
      target.innerHTML = banner + (usesDb
        ? '<div class="hint" style="padding:4px 8px">ファイルパスは未設定ですが、DB直結のため問題ありません。</div>'
        : '<span class="err">⚠ config.js の hanbai.path が未設定です</span>');
      bindPeriod(); bindSelfDb();
      return;
    }
    let html = banner;
    html += '<table style="border:none;font-size:13px"><tbody>';
    html += '<tr><td style="border:none;padding:3px 8px;color:#6b7785;white-space:nowrap">設定パス</td><td style="border:none;padding:3px 8px"><code style="background:#f5f7fa;padding:2px 6px;border-radius:3px">'+esc(r.configured)+'</code> '+(r.isDir?'<span class="hint">（フォルダ）</span>':'<span class="hint">（ファイル直接指定）</span>')+'</td></tr>';
    if (r.resolved) {
      html += '<tr><td style="border:none;padding:3px 8px;color:#6b7785;white-space:nowrap">📄 実際に使われる最新ファイル</td><td style="border:none;padding:3px 8px"><b style="color:#1f4e78;font-size:14px">'+esc(r.resolvedName)+'</b></td></tr>';
      html += '<tr><td style="border:none;padding:3px 8px;color:#6b7785;white-space:nowrap">更新日時</td><td style="border:none;padding:3px 8px">'+esc(fmtDate(r.mtime))+' <span class="hint">／ '+esc(fmtBytes(r.size))+' ／ '+esc((r.format||'').toUpperCase())+'</span></td></tr>';
      html += '<tr><td style="border:none;padding:3px 8px;color:#6b7785;white-space:nowrap">フルパス</td><td style="border:none;padding:3px 8px;font-size:11px;color:#6b7785;word-break:break-all">'+esc(r.resolved)+'</td></tr>';
      html += '</tbody></table>';
      if (r.format === 'xls' || r.format === 'XLS') {
        html += '<div class="info-box" style="margin-top:8px">⚠ <b>.XLS（旧Excel）</b>は照合.bat 実行時に Excel COM 経由で自動 CSV 変換されます。Excel がインストールされた Windows でのみ動作。クラウド化時はこのファイルを CSV にして同じフォルダへ置いてください。</div>';
      }
    } else {
      html += '<tr><td style="border:none;padding:3px 8px;color:#6b7785">📄 実際のファイル</td><td style="border:none;padding:3px 8px"><span class="err">⚠ 見つかりません</span></td></tr>';
      html += '</tbody></table>';
      html += '<div class="info-box" style="margin-top:8px">⚠ パスは設定されていますが、その場所にファイル(または.xls/.xlsx/.csv) が存在しません。config.js を確認するか、フォルダに販売実績ファイルを置いてください。</div>';
    }
    target.innerHTML = html;
    bindPeriod(); bindSelfDb();
  } catch (e) {
    target.innerHTML = '<span class="err">読込失敗: '+esc(String(e))+'</span>';
  }
}
// 設定バックアップ一覧の表示＋ワンクリック復元
async function loadBackups(){
  const box = $('#backupList');
  try {
    const r = await fetch('/api/settings-backups').then(x=>x.json());
    const list = (r && r.backups) || [];
    if (!list.length) { box.innerHTML = '<span class="hint">まだバックアップはありません（設定を1回保存すると作成されます）。</span>'; return; }
    let html = '<div style="overflow:auto;max-height:300px"><table style="font-size:12px"><thead><tr>'
      + '<th>保存日時（この時点の設定に戻せます）</th><th>サイズ</th><th></th></tr></thead><tbody>';
    list.forEach((b,i)=>{
      const tag = i===0 ? ' <span class="hint">（最新）</span>' : '';
      html += '<tr><td>'+esc(b.savedAt)+tag+'</td><td>'+esc(fmtBytes(b.size))+'</td>'
        + '<td><button class="restoreBtn go" data-file="'+esc(b.file)+'" data-when="'+esc(b.savedAt)+'" '
        + 'style="background:#2e7d32;padding:4px 12px;font-size:12px">↩ この状態に戻す</button></td></tr>';
    });
    html += '</tbody></table></div><div id="restoreMsg" class="muted" style="margin-top:8px"></div>';
    box.innerHTML = html;
    box.querySelectorAll('.restoreBtn').forEach((btn)=>{
      btn.addEventListener('click', async ()=>{
        const file = btn.getAttribute('data-file'), when = btn.getAttribute('data-when');
        if (!confirm(when+' 時点の設定に戻します。\\n\\n現在の設定はこの操作の直前に自動バックアップされるので、戻したあとに元へ戻すこともできます。\\nよろしいですか？')) return;
        const msg = $('#restoreMsg');
        box.querySelectorAll('.restoreBtn').forEach((b)=>{ b.disabled=true; });
        msg.style.color='#6b7785'; msg.textContent='復元中…';
        try {
          const res = await fetch('/api/settings-restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file})}).then(x=>x.json());
          if (res.ok) {
            msg.style.color='#1f6b35';
            msg.textContent='✓ '+when+' 時点の設定に復元しました。各画面を再読み込みすると反映されます。';
            loadBackups(); // 復元で「直前の状態」が新たに退避されたので一覧を更新
          } else {
            msg.style.color='#c0392b'; msg.textContent='失敗: '+(res.error||'');
            box.querySelectorAll('.restoreBtn').forEach((b)=>{ b.disabled=false; });
          }
        } catch(e){
          msg.style.color='#c0392b'; msg.textContent='失敗: '+e;
          box.querySelectorAll('.restoreBtn').forEach((b)=>{ b.disabled=false; });
        }
      });
    });
  } catch(e){ box.innerHTML = '<span class="err">読込失敗: '+esc(String(e))+'</span>'; }
}
// 仕入原価の異常チェック（商品マスタCSVをライブ監査）
async function loadCostAudit(){
  const box = $('#costAuditResult'); const msg = $('#costAuditMsg'); const dl = $('#costAuditDl');
  const btn = $('#costAuditBtn');
  if (dl) dl.style.display='none';
  if (btn) btn.disabled = true;
  msg.style.color='#6b7785'; msg.textContent='チェック中…'; box.innerHTML='';
  try {
    const r = await fetch('/api/cost-audit').then(x=>x.json());
    if (!r.ok) { msg.style.color='#c0392b'; msg.textContent='失敗: '+(r.error||''); return; }
    if (!r.placed) {
      msg.textContent='';
      box.innerHTML = '<div class="info-box">商品マスタCSVが見つかりません。ファイル名に「商品マスタ／商品／master」を含むCSVを <b>プロジェクト直下</b> か <code>input/</code> に置いてから「🔄 チェックする」を押してください。</div>';
      return;
    }
    if (r.colError) {
      msg.textContent='';
      box.innerHTML = '<div class="info-box">「'+esc(r.file)+'」の列を自動判定できませんでした（商品コード列・仕入原価列が見つからない）。<br>ヘッダ: '+esc((r.headers||[]).join(' | '))+'</div>';
      return;
    }
    msg.style.color = r.count ? '#b71c1c' : '#1f6b35';
    msg.textContent = '対象「'+r.file+'」（原価='+r.cols.cost+'・売価='+(r.cols.sell||'なし')+'）';
    if (dl && r.count) dl.style.display='';
    let html = '<div style="font-size:13px;margin-bottom:6px">'
      + (r.count ? ('⚠ 異常候補 <b>'+r.count+'</b> 件 ＝ ') : '✓ 異常候補は <b>0</b> 件です。')
      + (r.count ? ('<b style="color:#b71c1c">A 年化け '+r.year+'</b> / B 逆ザヤ '+r.gyaku+' / C 高額 '+r.big+'（重複あり）') : '')
      + '</div>';
    if (r.count) {
      html += '<div style="overflow:auto;max-height:340px"><table style="font-size:12px"><thead><tr>'
        + '<th>商品コード</th><th>仕入原価</th><th>売価</th><th>商品名</th><th>理由</th></tr></thead><tbody>';
      r.rows.forEach((x)=>{
        const yc = x.isYear ? ' style="color:#b71c1c;font-weight:700"' : '';
        html += '<tr><td>'+esc(x.code)+'</td><td'+yc+'>'+esc(x.cost)+'</td><td>'+esc(x.sell!=null&&x.sell!==''&&!isNaN(x.sell)?x.sell:'')+'</td>'
          + '<td>'+esc(String(x.name||'').slice(0,30))+'</td><td>'+esc(x.flags)+'</td></tr>';
      });
      html += '</tbody></table></div>';
      if (r.count > r.rows.length) html += '<div class="hint" style="margin-top:4px">（先頭 '+r.rows.length+' 件を表示。全件はCSVで）</div>';
    }
    box.innerHTML = html;
  } catch(e){ msg.style.color='#c0392b'; msg.textContent='失敗: '+e; }
  finally { if (btn) btn.disabled=false; }
}
(function bindCostAudit(){ const b=$('#costAuditBtn'); if (b) b.addEventListener('click', loadCostAudit); })();
loadBackups();
loadCostAudit();
loadHanbaiSource();
initShogoLockWatch();
</script>
</body></html>`;

module.exports = { SELF_PAGE };
