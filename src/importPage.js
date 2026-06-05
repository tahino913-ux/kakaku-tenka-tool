// =====================================================================
//  メーカー見積の「貼り付け＋確認」取り込み画面（依存ゼロ・/import で表示）
//  PDF/Excelの表をコピペ → 自動で列に分解 → 列の意味を指定・ズレを修正 →
//  正規化したメーカー見積CSV(maker_quotes/)として保存。
// =====================================================================
const IMPORT_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>メーカー見積 取り込み</title>
<style>
  body{margin:0;font-family:"メイリオ","Meiryo","Segoe UI",sans-serif;background:#f4f6f9;color:#1f2733;font-size:13px}
  header{background:#1f4e78;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  header h1{font-size:16px;margin:0}
  header a{color:#cfe0f0;font-size:12px;text-decoration:none;background:rgba(255,255,255,.08);padding:5px 10px;border-radius:6px}
  header a:hover{background:rgba(255,255,255,.18)}
  .step{background:#fff;border:1px solid #e2e6ec;border-radius:10px;margin:12px 16px;padding:12px 14px}
  .lbl{font-weight:700;color:#2a3a4a;margin-bottom:6px}
  .hint{color:#6b7785;font-size:11px;margin-bottom:6px;line-height:1.6}
  textarea{width:100%;font:inherit;border:1px solid #c7ced8;border-radius:6px;padding:8px;box-sizing:border-box}
  input,select{font:inherit;padding:5px 7px;border:1px solid #c7ced8;border-radius:6px}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px}
  button.go{background:#1f4e78;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
  .wrap{overflow:auto;max-height:55vh;border:1px solid #e2e6ec;border-radius:6px}
  table{border-collapse:collapse;background:#fff;font-size:12px}
  th,td{border:1px solid #e2e6ec;padding:2px}
  th{background:#eef2f7;position:sticky;top:0;z-index:1}
  td input{width:140px;border:1px solid transparent;background:transparent}
  td input:focus{border:1px solid #1f4e78;background:#fff}
  th select{width:150px}
  #msg{font-size:12px}
  /* ②のロック中：操作不可をはっきり伝える */
  #step2.locked button.go, #step2.locked textarea, #step2.locked select, #step2.locked input[type=checkbox]{
    opacity:.45;cursor:not-allowed;background:#f5f5f5
  }
  #step2:not(.locked) #step2Lock{display:none}
  /* 捨てる行（挨拶文・余白）— 表の上にグレー＋打ち消し線で表示 */
  tr.skipped td{ background:#f3f4f6; color:#a0a4ad; text-decoration:line-through;
    font-size:11px; padding:1px 4px; white-space:nowrap; max-width:160px; overflow:hidden; text-overflow:ellipsis }
  tr.divider td{ background:#fff4d6; color:#8a5a00; padding:4px 8px; font-weight:700;
    font-size:11px; text-align:center; border-top:2px dashed #c4a464; border-bottom:2px dashed #c4a464 }
</style></head><body>
<header>
  <h1>メーカー見積 取り込み</h1>
  <button id="resetBtn" type="button" title="入力中の仕入先・取り込みデータをすべて消して、別の仕入先を最初から取り込みます" style="margin-left:auto;background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.6);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">🆕 入力をクリア（別の仕入先へ）</button>
  <a href="/">← シミュレーション</a>
  <a href="/customers">👥 得意先別</a>
  <a href="/list">📊 一覧・進捗</a>
  <a href="/suppliers">📒 仕入先マスタ</a>
  <a href="/self">🗂 自社データ設定</a>
</header>
<div id="topMsg" style="display:none;margin:0 0 10px;padding:10px 14px;border-radius:8px;font-size:12.5px;line-height:1.6"></div>

<div class="step">
  <div class="lbl">① 仕入先を選ぶ（自社マスタの「仕入先コード」から）</div>
  <div class="hint">値上げ通知は問屋（朝日・中東など）からまとめて届くので、まず<b>仕入先（発注先）をマスタから選びます</b>。選ぶと「仕入先名」と「発注先コード」が自動で入ります。</div>
  <div class="row" style="padding:8px 10px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px">
    <label style="font-weight:700;color:#5a4a1a">🏢 仕入先（マスタ）：</label>
    <select id="purchaseCodeSel" style="min-width:420px">
      <option value="">― マスタから選択 ―</option>
    </select>
    <span id="purchaseCodeBadge" style="font-size:12px;color:#7a5a00;font-weight:700"></span>
  </div>
  <div class="hint" style="font-size:11px;color:#6b7785;margin-top:4px;line-height:1.6">
    選んだ仕入先(発注先)の <b>末尾4桁コード</b>（例: 13=朝日食品容器 / 29=大黒工業 / 47=ハウスホールドジャパン）に一致する自社品だけを照合候補にします。
  </div>
  <div class="row" style="margin-top:8px">
    <label>この見積の仕入先名：</label>
    <input id="supplier" placeholder="（マスタを選ぶと自動で入ります）" style="width:280px">
    <span id="profMsg" style="font-size:11px;color:#2e7d32"></span>
  </div>
  <div style="margin-top:6px">
    <a href="#" id="advToggle" style="font-size:12px;color:#1f4e78;text-decoration:none">▸ その他（登録済みから選ぶ／問屋の下のメーカーを分けて登録）</a>
    <div id="advArea" style="display:none;margin-top:6px;padding:8px 10px;background:#f7f9fc;border:1px solid #e2e6ec;border-radius:6px">
      <div class="row">
        <label>登録済みから選ぶ：</label>
        <select id="supplierSel"><option value="__new__">＋ 新規（上の「仕入先名」に直接入力）…</option></select>
      </div>
      <div class="hint" style="margin-top:4px">問屋の下のメーカーを分けて取り込みたいとき（例：朝日の下の「中央化学」「福助」）は、ここで登録済みを選ぶか、上の「仕入先名」に直接入力してください。</div>
    </div>
  </div>
  <div id="profSummary" style="display:none;margin-top:8px;padding:8px 10px;background:#eef7ee;border:1px solid #cfe6cf;border-radius:6px;font-size:12px;color:#2e5a2e"></div>
</div>

<div class="step" id="step2">
  <div class="lbl">② メーカー見積の中身を読み込む</div>
  <div class="hint"><b>方法A：ファイルを選ぶ</b>（Excel／CSVに対応）　<b>方法B：PDFやExcelの表をコピーして貼り付け</b>　<b>方法C：1件ずつ手入力</b><br>ファイルを選ぶ・貼り付ける・手入力する、どの方法でも自動で表に展開されます。</div>
  <div id="step2Lock" style="margin:6px 0;padding:8px 12px;background:#fff0f0;border:1px solid #f3c0c0;border-radius:6px;font-size:12px;color:#8a3a3a">
    ⤴ まず ① で仕入先（メーカー）を選んでください。新規の場合は名前を入力すると進めます。
  </div>
  <div class="row" style="margin-bottom:6px">
    <input type="file" id="file" accept=".csv,.xlsx,.txt" style="display:none">
    <button class="go" id="fileBtn" type="button" disabled>📂 ファイルを選択（Excel / CSV）</button>
    <span id="fileMsg" style="font-size:11px;color:#6b7785"></span>
    <select id="sheetSel" style="display:none"></select>
  </div>
  <textarea id="src" rows="6" placeholder="または、ここに貼り付け（Ctrl+V）― PDFの表もOK" disabled></textarea>
  <div class="row">
    区切り：<select id="delim" disabled><option value="auto">自動</option><option value="tab">タブ</option><option value="comma">カンマ</option><option value="space">連続スペース</option></select>
    <label><input type="checkbox" id="hasHeader" checked disabled> 1行目は見出し</label>
    <button class="go" id="parseBtn" disabled>貼り付けを読み取る</button>
  </div>

  <div class="row" id="aiRow" style="display:none;margin-top:8px;padding:8px 10px;background:#eef6ff;border:1px solid #cfe0f4;border-radius:8px;flex-wrap:wrap;gap:8px;align-items:center">
    <span style="font-weight:700;color:#1f4e78">🤖 AIで読み取る</span>
    <button class="go" id="aiTextBtn" type="button" disabled style="background:#5b6cb5" title="上の貼り付け欄/表の内容をAIが商品明細に整理して下の③へ入れます">貼り付け・表から</button>
    <button class="go" id="aiPdfBtn" type="button" disabled style="background:#5b6cb5" title="PDF（手紙形式の値上げ通知でもOK）をAIが読み取って下の③へ入れます">PDFから</button>
    <input type="file" id="aiPdf" accept=".pdf" style="display:none">
    <span id="aiMsg" style="font-size:11px;color:#6b7785"></span>
    <span style="font-size:10px;color:#8a93a0;flex-basis:100%;line-height:1.6">※ AIは読み取りの<b>下書き</b>です。③の表で<b>単価・実施日を必ず確認</b>してから保存してください（外部のAIに商品名・数字を送信します）。</span>
  </div>

  <div style="margin-top:12px;border-top:1px dashed #d8dee6;padding-top:10px">
    <div class="lbl" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      方法C：1件ずつ手入力（項目ごとに直接入力）
      <button class="go" id="manualToggle" type="button" disabled style="padding:4px 10px">✏ 手入力をひらく</button>
    </div>
    <div class="hint">貼り付けが使えないとき（口頭・メモ・FAX・電話連絡など）に、項目ごとに直接入力できます。最低でも <b>メーカー商品名</b> と <b>新単価</b> を入れてください。<br>
      <b>自社コード</b>（任意）を入れると、その商品は照合で <b>「📌 手動紐付け（100%確定）」</b> として扱われます（後で「📊 一覧・進捗」から解除できます）。</div>
    <div id="manualArea" style="display:none">
      <div class="wrap" style="max-height:42vh"><table id="manualTbl"></table></div>
      <div class="row">
        <button class="go" id="manualAddBtn" type="button" style="background:#3a6ea5">＋ 行を追加</button>
        <button class="go" id="manualApplyBtn" type="button">この内容を下の表に反映 →</button>
        <span id="manualMsg" style="font-size:11px;color:#6b7785"></span>
      </div>
    </div>
  </div>
</div>

<div class="step" id="mapArea" style="display:none">
  <div style="display:flex;gap:14px;align-items:flex-start">
    <div style="flex:1;min-width:0">
      <div class="lbl">③ 列の対応を確認・修正 → 保存</div>
      <div class="hint">各列の上のメニューで「何の列か」を選びます（自動で推測済み）。値がズレている所はマスを直接書き換えできます。<br>最低でも「メーカー商品名（または品番）」と「新単価」を指定してください。</div>
    </div>
    <div style="flex:0 0 auto;text-align:right">
      <button class="go" id="saveBtn">この内容で保存</button>
      <div id="msg" style="margin-top:4px;font-size:11px"></div>
    </div>
  </div>
  <div style="margin:8px 0 10px;padding:8px 12px;background:#fff8e1;border:1px solid #f0d68a;border-radius:6px;font-size:12px;color:#5a4a1a;line-height:1.7">
    <b>⚠ ここまでは未保存です。</b>「この内容で保存」を押すと次の2つがディスクに書き込まれます：<br>
    　① <b>メーカー見積データ本体</b> → <code>maker_quotes\\メーカー見積_&lt;仕入先&gt;_&lt;日時&gt;.csv</code>（あとで「照合」に使う材料）<br>
    　② <b>この仕入先の書式（列の対応）</b> → <code>settings.json</code> に記憶（次回この仕入先を選ぶと自動で当てはまります）<br>
    <span style="color:#8a7a3a">※ 保存せずに閉じる／仕入先を切り替えると、いま画面に出している中身は消えます。</span>
  </div>
  <div id="skipRow" class="row" style="margin-bottom:6px;display:none">
    <label>先頭の <input type="number" id="skipN" min="0" value="0" style="width:60px"> 行を捨てる</label>
    <span class="muted" id="skipHint" style="font-size:11px;color:#6b7785"></span>
  </div>
  <div id="bulkDateRow" style="margin:6px 0 10px;padding:8px 12px;background:#eef6ff;border:1px solid #bcd8f5;border-radius:6px;font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <b style="color:#1a4a7a;white-space:nowrap">📅 実施日（切替日）を一括入力</b>
    <span style="color:#5a6b7a">メーカー見積に実施日が無いとき、全商品にまとめて入れられます</span>
    <input type="text" id="bulkDate" placeholder="例 2026-07-01 / 7/1" style="width:140px">
    <select id="bulkDateScope" style="width:auto">
      <option value="empty">空欄の行だけに入れる</option>
      <option value="all">全行に上書きする</option>
    </select>
    <button id="bulkDateBtn" type="button" class="go" style="background:#2f6fb0">全商品に反映</button>
    <span id="bulkDateMsg" style="font-size:11px"></span>
  </div>
  <div class="wrap"><table id="grid"></table></div>
</div>

<script>
const $=s=>document.querySelector(s);
const FIELDS=[['','（無視）'],['makerCode','メーカー品番'],['makerName','メーカー商品名'],['selfCode','自社コード'],['spec','規格'],['currentCost','現単価'],['newCost','新単価'],['switchDate','切替日']];
let grid=[];
let suppressProfile=false; // true のとき applyProfile を抑止（手入力＝固定レイアウトを保存済み書式で上書きしない）
// 実施日（切替日）の一括入力。{date:'YYYY-MM-DD', scope:'empty'|'all'} or null。
//  実施日列が無いメーカー見積でも保存時に全商品へ付与できるよう、collect() で適用する（authoritative）。
let forcedSwitchDate=null;
// grid（取り込んだ表）を読み込んだ時点の仕入先名。別の仕入先に切り替えた取り違えを検知する。
let loadedForSupplier='';

// 上部の常設バナー（保存結果など。リセットしても消えない位置に出す）。kind: 'ok' | 'warn' | 'err'
function showTop(html, kind){
  const b=$('#topMsg'); if(!b) return;
  const st = kind==='err' ? ['#fdecea','#f3b6ae','#a32820']
           : kind==='warn' ? ['#fff7e6','#f0c879','#7a5300']
           : ['#eef7ee','#bfe0c4','#2e6b35'];
  b.style.display='block'; b.style.background=st[0]; b.style.border='1px solid '+st[1]; b.style.color=st[2];
  b.innerHTML=html;
}
function hideTop(){ const b=$('#topMsg'); if(b){ b.style.display='none'; b.innerHTML=''; } }
// 取り込みデータ部分だけクリア（仕入先の選択はそのまま）。②③・貼り付け・手入力・一括実施日を初期化。
function clearImportData(){
  $('#src').value=''; grid=[]; originalRows=[]; forcedSwitchDate=null; loadedForSupplier='';
  if($('#bulkDate')) $('#bulkDate').value=''; if($('#bulkDateMsg')) $('#bulkDateMsg').textContent='';
  if($('#grid')) $('#grid').innerHTML='';
  if($('#mapArea')) $('#mapArea').style.display='none';
  if($('#skipRow')) $('#skipRow').style.display='none';
  if($('#fileMsg')) $('#fileMsg').textContent='';
  if($('#msg')) $('#msg').textContent='';
  if($('#manualArea')){ $('#manualArea').style.display='none'; $('#manualTbl').innerHTML=''; }
  if($('#manualToggle')) $('#manualToggle').textContent='✏ 手入力をひらく';
  if($('#manualMsg')) $('#manualMsg').textContent='';
}
// すべてクリア（仕入先の選択も）＝別の仕入先を最初から取り込む。
function resetImport(){
  clearImportData();
  $('#supplier').value=''; if($('#supplierSel')) $('#supplierSel').value='__new__';
  if($('#purchaseCodeSel')) $('#purchaseCodeSel').value='';
  activeProfile=null; if($('#profMsg')) $('#profMsg').textContent='';
  updatePurchaseBadge(); showProfSummary(); updateStep2Lock();
}
// 取り込んだ表の仕入先と、いま選んでいる仕入先が食い違っていれば警告（取り違え防止）。一致なら何もしない。
function warnSupplierMismatch(){
  const now=$('#supplier').value.trim();
  if(grid.length && loadedForSupplier && now && now!==loadedForSupplier){
    showTop('⚠ 表示中の取り込みデータは <b>「'+esc(loadedForSupplier)+'」</b> で読み込んだものです。'
      +'いま選択中の仕入先は <b>「'+esc(now)+'」</b>。<br>別の仕入先の見積を取り込むなら、右上の '
      +'<b>「🆕 入力をクリア」</b> を押してから貼り付け／ファイル選択してください（このまま保存すると「'+esc(now)+'」として保存されます）。','warn');
  }
}
let MAKERS={};            // 仕入先プロファイル（サーバから取得）
let SUPPLIERS={};         // 仕入先マスタ {4桁: {name,...}}（仕入先コード選択用）
let activeProfile=null;   // いま選択中の仕入先の保存プロファイル

// 登録済み仕入先を読み込んでピッカーに反映
async function loadMakers(){
  try{
    const r=await fetch('/api/makers').then(x=>x.json());
    MAKERS=r.makers||{};
  }catch(e){ MAKERS={}; }
  const sel=$('#supplierSel');
  sel.innerHTML='<option value="__new__">＋ 新規…</option>'+
    Object.keys(MAKERS).sort().map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('');
}

// 仕入先マスタ(112社) を読み込んで仕入先コードピッカーに反映
async function loadSuppliersMaster(){
  try{
    const r=await fetch('/api/suppliers').then(x=>x.json());
    SUPPLIERS=r.suppliers||{};
  }catch(e){ SUPPLIERS={}; }
  const sel=$('#purchaseCodeSel');
  const codes=Object.keys(SUPPLIERS).sort();
  sel.innerHTML='<option value="">― マスタから選択 ―</option>'+
    codes.map(c=>'<option value="'+esc(c)+'">'+esc(c)+' '+esc(SUPPLIERS[c].name||'')+'</option>').join('');
}
// マスタ会社名 → 照合で使う短い仕入先名へ掃除（㈱/株式会社/全半角空白/末尾の時刻ゴミ等を除去）。
//  例: 「朝日食品容器　株式会社」→「朝日食品容器」 / 「株式会社　旭創業」→「旭創業」
//      「ハウスホールドジャパン　株式会社 11：00」→「ハウスホールドジャパン」
//  これにより既存の照合結果/紐付け(短い名前キー)とズレずに済む。
function cleanName(raw){
  let t=String(raw||'').normalize('NFKC');
  t=t.replace(/[（(]株[）)]|株式会社|㈱|有限会社|㈲|合同会社|合資会社/g,' ');
  t=t.replace(/\\s*\\d{1,2}[:：]\\d{2}\\s*$/,''); // 末尾の「11:00」のような時刻ゴミ
  t=t.replace(/[\\s　]+/g,' ').trim();
  return t;
}
// マスタ(仕入先コード)を選んだら：仕入先名を自動補完＋発注先コードを設定。これが主役の選択経路。
function onPurchaseCodePick(){
  updatePurchaseBadge();
  const code=$('#purchaseCodeSel').value;
  if(code && SUPPLIERS[code]){
    const nm=cleanName(SUPPLIERS[code].name||'');
    if(nm){
      $('#supplier').value=nm;
      if(MAKERS[nm]){
        activeProfile=MAKERS[nm];
        if(activeProfile.delim) $('#delim').value=activeProfile.delim;
        if(activeProfile.hasHeader!=null) $('#hasHeader').checked=!!activeProfile.hasHeader;
        $('#profMsg').textContent='✓ 書式登録済み（ファイルを選ぶか貼り付ければ自動で列対応します）';
        applyProfile();
      } else {
        activeProfile=null; $('#profMsg').textContent='';
      }
      // 「登録済みから選ぶ」を同期（一致があれば選択／無ければ新規扱い）
      $('#supplierSel').value = MAKERS[nm] ? nm : '__new__';
    }
  }
  showProfSummary();
  updateStep2Lock();
  warnSupplierMismatch();
}
function updatePurchaseBadge(){
  const code=$('#purchaseCodeSel').value;
  const badge=$('#purchaseCodeBadge');
  if(!code){ badge.textContent=''; return; }
  const sup=SUPPLIERS[code];
  badge.textContent='🏢 '+code+(sup && sup.name?' '+sup.name:'');
}
function onSupplierPick(){
  const v=$('#supplierSel').value;
  if(v==='__new__'){
    // 「上の仕入先名に直接入力」モード。マスタで選んだ発注先コードは保持する
    //  （問屋の下のメーカー名を手入力するケース＝コードは問屋のまま）。
    activeProfile=null; $('#supplier').value=''; $('#supplier').focus();
    $('#profMsg').textContent='';
    showProfSummary(); updateStep2Lock(); return;
  }
  $('#supplier').value=v;
  activeProfile=MAKERS[v]||null;
  if(activeProfile){
    if(activeProfile.delim) $('#delim').value=activeProfile.delim;
    if(activeProfile.hasHeader!=null) $('#hasHeader').checked=!!activeProfile.hasHeader;
    $('#profMsg').textContent='✓ 書式登録済み（ファイルを選ぶか貼り付ければ自動で列対応します）';
    applyProfile(); // 既に表があれば即適用
    // 保存済み purchaseCode を picker に反映（無ければ空）
    const pc=String(activeProfile.purchaseCode||'').trim();
    $('#purchaseCodeSel').value = (pc && SUPPLIERS[pc]) ? pc : '';
    updatePurchaseBadge();
  }
  showProfSummary();
  updateStep2Lock();
  warnSupplierMismatch();
}
// ① の入力状態に応じて ② のフォームを有効／無効化
function updateStep2Lock(){
  // 仕入先名が入っていれば解放（マスタ選択／登録済み選択／手入力のいずれでも名前が入る）。
  const ok = $('#supplier').value.trim().length > 0;
  const ids=['fileBtn','src','delim','hasHeader','parseBtn','manualToggle','aiTextBtn','aiPdfBtn'];
  ids.forEach(id=>{ const el=$('#'+id); if(el) el.disabled = !ok; });
  $('#step2').classList.toggle('locked', !ok);
}
// 登録済みの列対応を「商品名=2列目」のように人が読める形で表示
function fieldLabel(f){ for(var i=0;i<FIELDS.length;i++) if(FIELDS[i][0]===f) return FIELDS[i][1]; return f; }
function showProfSummary(){
  const box=$('#profSummary');
  if(!activeProfile||!activeProfile.map||!Object.keys(activeProfile.map).length){
    box.style.display='none'; box.innerHTML=''; return;
  }
  const m=activeProfile.map;
  const parts=Object.keys(m).map(f=>'<b>'+esc(fieldLabel(f))+'</b>＝'+(m[f]+1)+'列目');
  box.style.display='block';
  box.innerHTML='✓ この仕入先の書式（列の対応）が登録済みです：<br>'+parts.join('　／　')+
    '<br><span style="color:#6b7785">※ メーカーのフォーマットが同じ前提です。違う形式が来たら下の表で修正→保存すると上書きされます。</span>';
}
// 保存済みマッピングを列の見出しメニューへ反映
function applyProfile(){
  if(!activeProfile||!activeProfile.map) return;
  const selects=$('#grid').querySelectorAll('thead select');
  selects.forEach(s=>{ s.value=''; });
  Object.keys(activeProfile.map).forEach(field=>{
    const c=activeProfile.map[field];
    const s=$('#grid').querySelector('thead select[data-c="'+c+'"]');
    if(s) s.value=field;
  });
}
function norm(s){return String(s||'').normalize('NFKC').toLowerCase()}
function guess(h){
  const t=norm(h);
  if(/(新単価|新価格|改定後|new)/.test(t)) return 'newCost';
  if(/(現単価|現行|旧単価|現価)/.test(t)) return 'currentCost';
  if(/(自社コード|自社cd|自社商品|当社コード|弊社コード)/.test(t)) return 'selfCode'; // ※「コード」より前に判定
  if(/(品番|商品cd|商品コード|メーカーcd|^cd$|コード)/.test(t)) return 'makerCode';
  if(/(商品名|品名|名称)/.test(t)) return 'makerName';
  if(/(規格|サイズ|寸法)/.test(t)) return 'spec';
  if(/(切替|実施|適用|改定日)/.test(t)) return 'switchDate';
  if(/単価/.test(t)) return 'currentCost';
  return '';
}
function splitLine(line,delim){
  if(delim==='tab') return line.split('\\t');
  if(delim==='comma') return line.split(',');
  if(delim==='space') return line.split(/ {2,}|\\u3000+/);
  if(line.indexOf('\\t')>=0) return line.split('\\t');
  if(line.indexOf(',')>=0) return line.split(',');
  return line.split(/ {2,}|\\u3000+/);
}
function parse(){
  suppressProfile=false; // 貼り付けは保存済み書式を適用
  const text=$('#src').value.replace(/\\r/g,'');
  const delim=$('#delim').value;
  const lines=text.split('\\n').map(l=>l.replace(/\\s+$/,'')).filter(l=>l.trim()!=='');
  if(!lines.length){ alert('貼り付けが空です'); return; }
  const rows=lines.map(l=>splitLine(l,delim).map(c=>c.trim()));
  loadRows(rows);
}
// --- A: 見出し行（商品名・単価などを含む行）を自動検出 ---
function jsNorm(s){ return String(s==null?'':s).replace(/[\\s　]/g,'').normalize('NFKC').toLowerCase(); }
function jsDetectColumns(rows){
  for(let r=0;r<Math.min(rows.length,15);r++){
    const head=(rows[r]||[]).map(jsNorm);
    const idx={ headerRow:r };
    head.forEach((h,i)=>{
      if(!h) return;
      if(idx.name==null && /(商品名|品名|名称)/.test(h) && !/(cd|コード)/.test(h)) idx.name=i;
      if(idx.cur==null  && /現/.test(h) && /(単価|売価|価格|仕入)/.test(h)) idx.cur=i;
      if(idx.nw==null   && /(新|改定|改訂)/.test(h) && /(単価|売価|価格|仕入)/.test(h)) idx.nw=i;
      if(idx.date==null && /(切替|実施|適用|改定日|改訂日)/.test(h)) idx.date=i;
    });
    // フォールバック: 単価しか書かれていないファイル向け（大黒など）
    if(idx.name!=null && idx.cur==null && idx.nw!=null){
      const ci=head.findIndex((h,i)=>i!==idx.nw && /単価|売価|価格/.test(h));
      if(ci>=0) idx.cur=ci;
    }
    if(idx.name!=null && (idx.cur!=null||idx.nw!=null)) return idx;
  }
  return null;
}
// --- B: 切替日を「どんな入力でも YYYY-MM-DD に揃える」---
//  サーバ側 normDateInput と同じ強さ：NFKC（全角→半角）/ Excelシリアル / 区切りは何でも(-./年月日空白) /
//  年なしは当年。対応: 2026-07-01・2026/7/1・2026.7.1・2026年7月1日・7月1日・7月1日～・7/1・8/15・全角・46133(シリアル)。
//  解釈できない文字列（「未定」等）はそのまま返す（入力をロックしない）。
function jpDateToISO(s,refDate){
  s=String(s==null?'':s).normalize('NFKC').trim();
  if(!s) return s;
  const p2=n=>String(n).padStart(2,'0');
  // Excelシリアル(4-6桁・妥当範囲) → 日付
  if(/^\\d{4,6}$/.test(s)){
    const n=Number(s);
    if(n>=20000 && n<=90000){
      const d=new Date((n-25569)*86400*1000);
      if(!isNaN(d.getTime())) return d.getUTCFullYear()+'-'+p2(d.getUTCMonth()+1)+'-'+p2(d.getUTCDate());
    }
  }
  // 年つき（区切りは - / . 年 月 日 空白 など何でも）
  let m=s.match(/(\\d{4})\\D{1,3}(\\d{1,2})\\D{1,3}(\\d{1,2})/);
  if(m){ const mo=+m[2], da=+m[3]; if(mo>=1&&mo<=12&&da>=1&&da<=31) return m[1]+'-'+p2(mo)+'-'+p2(da); }
  // 年なし → 当年（価格改定は当年が前提。過ぎた月日でも翌年に飛ばさない）
  m=s.match(/(\\d{1,2})\\D{1,3}(\\d{1,2})/);
  if(m){ const mo=+m[1], da=+m[2]; if(mo>=1&&mo<=12&&da>=1&&da<=31){ const Y=(refDate||new Date()).getFullYear(); return Y+'-'+p2(mo)+'-'+p2(da); } }
  return s; // 未対応の形は素通り
}

// 二次元配列を表として描画（ファイル読み込み・貼り付け共通の入口）
// A: 見出し検出 → skipN を自動セット　B+C: applySkipAndRender で適用
let originalRows=[];
function loadRows(rows){
  if(!rows||!rows.length){ alert('読み取れる行がありません'); return; }
  // 新しいデータを読むたびに一括 実施日はリセット（別の見積へ持ち越さない）
  forcedSwitchDate=null;
  if($('#bulkDateMsg')) $('#bulkDateMsg').textContent='';
  // この表を「いまの仕入先」で読み込んだと記録（後で取り違え検知に使う）＋古い警告を消す
  loadedForSupplier=$('#supplier').value.trim();
  hideTop();
  // 元の生データを保持（Cで行数を変えるたびに参照）
  originalRows=rows.map(r=>r.slice());
  // A: 自動で見出し行を探す
  const idx=jsDetectColumns(originalRows);
  const auto=idx ? (idx.headerRow||0) : 0;
  $('#skipN').value=auto;
  $('#skipRow').style.display='flex';
  $('#skipHint').textContent = auto>0
    ? '✓ '+auto+' 行の挨拶文・余白を自動で除外しました（違う場合は数字を変更できます）'
    : '（必要なら数字を変えて先頭行を捨てられます）';
  applySkipAndRender();
}
function applySkipAndRender(){
  if(!originalRows.length) return;
  const skip=Math.max(0,Math.min(originalRows.length-1,parseInt($('#skipN').value,10)||0));
  const sliced=originalRows.slice(skip).map(r=>r.slice());
  const skippedRaw=originalRows.slice(0,skip).map(r=>r.slice()); // 表示用（捨てる行）
  // B: 切替日列を日付に統一
  const idx=jsDetectColumns(sliced);
  if(idx && idx.date!=null){
    const ref=new Date();
    for(let r=(idx.headerRow||0)+1;r<sliced.length;r++){
      const v=sliced[r][idx.date];
      if(v!=null && v!=='') sliced[r][idx.date]=jpDateToISO(v,ref);
    }
  }
  // 列数は「本表＋捨てる行」両方を含めた最大幅で揃える
  const cols=Math.max.apply(null,sliced.concat(skippedRaw).map(r=>r.length||0));
  grid=sliced.map(r=>{ const a=r.slice(); while(a.length<cols) a.push(''); return a.map(c=>String(c==null?'':c)); });
  const skippedPadded=skippedRaw.map(r=>{ const a=r.slice(); while(a.length<cols) a.push(''); return a; });
  render(cols, skippedPadded); if(!suppressProfile) applyProfile();
}
// 適切なCSVパーサ（クォート対応）。ファイル選択でのCSV読み込みに使用。
function csvParseRows(text){
  text=String(text||'').replace(/^\\uFEFF/,'');
  const rows=[]; let row=[],cur='',q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){ cur+='"'; i++; } else q=false; }
      else cur+=c;
    } else {
      if(c==='"') q=true;
      else if(c===','){ row.push(cur); cur=''; }
      else if(c==='\\r'){ /* skip */ }
      else if(c==='\\n'){ row.push(cur); cur=''; rows.push(row); row=[]; }
      else cur+=c;
    }
  }
  if(cur.length||row.length){ row.push(cur); rows.push(row); }
  while(rows.length && rows[rows.length-1].every(c=>!String(c).trim())) rows.pop();
  return rows;
}
// CSVのバイト列をUTF-8優先で、ダメならShift_JISでデコード
function decodeCsvBytes(buf){
  const u8=new Uint8Array(buf);
  // UTF-8 BOM
  if(u8.length>=3 && u8[0]===0xEF && u8[1]===0xBB && u8[2]===0xBF){
    return new TextDecoder('utf-8').decode(u8.subarray(3));
  }
  try { return new TextDecoder('utf-8',{fatal:true}).decode(u8); } catch(e){}
  try { return new TextDecoder('shift_jis').decode(u8); } catch(e){}
  return new TextDecoder('utf-8').decode(u8); // 最後の手段
}
// ArrayBuffer → base64（Excel送信用）
function bufToB64(buf){
  const u8=new Uint8Array(buf); let bin='';
  const chunk=0x8000;
  for(let i=0;i<u8.length;i+=chunk) bin+=String.fromCharCode.apply(null,u8.subarray(i,i+chunk));
  return btoa(bin);
}
// ファイル選択ハンドラ（CSV/Excelに対応）
async function onFilePicked(ev){
  const f=ev.target.files && ev.target.files[0]; if(!f) return;
  suppressProfile=false; // ファイル取り込みは保存済み書式を適用
  $('#fileMsg').style.color='#6b7785';
  $('#fileMsg').textContent='読み込み中… '+f.name;
  $('#sheetSel').style.display='none'; $('#sheetSel').innerHTML='';
  const lower=f.name.toLowerCase();
  try{
    if(lower.endsWith('.csv')||lower.endsWith('.txt')){
      const buf=await f.arrayBuffer();
      const text=decodeCsvBytes(buf);
      $('#src').value=text;
      $('#delim').value=lower.endsWith('.csv')?'comma':'auto';
      $('#hasHeader').checked=true;
      const rows=lower.endsWith('.csv')?csvParseRows(text):text.split(/\\r?\\n/).map(l=>splitLine(l,$('#delim').value));
      loadRows(rows);
      $('#fileMsg').style.color='#2e7d32'; $('#fileMsg').textContent='✓ 読み込み完了：'+f.name;
    } else if(lower.endsWith('.xlsx')){
      const buf=await f.arrayBuffer();
      const b64=bufToB64(buf);
      const res=await fetch('/api/read-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.name,b64})}).then(x=>x.json());
      if(!res.ok){ $('#fileMsg').style.color='#c0392b'; $('#fileMsg').textContent='読み込み失敗: '+(res.error||''); return; }
      window.__sheets=res.sheets||[];
      if(window.__sheets.length>1){
        const sel=$('#sheetSel');
        sel.innerHTML=window.__sheets.map((s,i)=>'<option value="'+i+'">'+esc(s.name||('シート'+(i+1)))+'</option>').join('');
        sel.style.display='inline-block';
        sel.onchange=()=>loadSheet(+sel.value);
      }
      loadSheet(0);
      $('#fileMsg').style.color='#2e7d32'; $('#fileMsg').textContent='✓ 読み込み完了：'+f.name+(window.__sheets.length>1?'（シート '+window.__sheets.length+' 個）':'');
    } else if(lower.endsWith('.xls')){
      $('#fileMsg').style.color='#c0392b';
      $('#fileMsg').textContent='古いExcel(.xls)は読めません。Excelで開いて「名前を付けて保存」→ .xlsx か CSV にしてください。';
    } else {
      $('#fileMsg').style.color='#c0392b';
      $('#fileMsg').textContent='対応していないファイル形式です（.csv / .xlsx を選んでください）';
    }
  }catch(e){
    $('#fileMsg').style.color='#c0392b'; $('#fileMsg').textContent='読み込み失敗: '+(e&&e.message||e);
  }finally{
    ev.target.value=''; // 同じファイル再選択時もイベントが発火するように
  }
}
function loadSheet(i){
  const s=(window.__sheets||[])[i]; if(!s) return;
  loadRows(s.grid||[]);
}
function render(cols, skippedRows){
  const hasH=$('#hasHeader').checked;
  const headerRow=hasH?grid[0]:[];
  const dataRows=hasH?grid.slice(1):grid;
  let html='<thead>';
  // 捨てる行（挨拶文・余白）— グレー＋打ち消し線でそのまま見せる
  if(skippedRows && skippedRows.length){
    skippedRows.forEach((r,i)=>{
      html+='<tr class="skipped" title="この行は捨てます（先頭の '+(i+1)+' 行目）">';
      for(let c=0;c<cols;c++) html+='<td>'+esc(String(r[c]==null?'':r[c]).slice(0,80))+'</td>';
      html+='</tr>';
    });
    html+='<tr class="divider"><td colspan="'+cols+'">▲ ここまで捨てる（先頭 '+skippedRows.length+' 行）　／　▼ ここから取り込み対象</td></tr>';
  }
  // 列の対応（プルダウン）と見出しテキスト
  html+='<tr>';
  for(let c=0;c<cols;c++){
    const g=guess(hasH?headerRow[c]:'');
    html+='<th><select data-c="'+c+'">'+FIELDS.map(f=>'<option value="'+f[0]+'"'+(f[0]===g?' selected':'')+'>'+f[1]+'</option>').join('')+'</select>'+(hasH?'<div style="font-size:10px;color:#6b7785">'+esc(headerRow[c]||'')+'</div>':'')+'</th>';
  }
  html+='</tr></thead><tbody>';
  dataRows.forEach((r,ri)=>{
    html+='<tr>';
    for(let c=0;c<cols;c++) html+='<td><input data-r="'+ri+'" data-c="'+c+'" value="'+esc(r[c]||'')+'"></td>';
    html+='</tr>';
  });
  html+='</tbody>';
  $('#grid').innerHTML=html;
  $('#mapArea').style.display='block';
  applyForcedDateToGrid(); // 一括 実施日が設定済みなら、再描画後も切替日列へ反映し続ける
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function collect(){
  const map={};
  $('#grid').querySelectorAll('thead select').forEach(s=>{ if(s.value) map[s.value]=+s.dataset.c; });
  const byRow={};
  $('#grid').querySelectorAll('tbody input').forEach(inp=>{ (byRow[inp.dataset.r]=byRow[inp.dataset.r]||{})[inp.dataset.c]=inp.value.trim(); });
  const items=[];
  Object.keys(byRow).forEach(r=>{
    const row=byRow[r], get=f=>map[f]!=null?(row[map[f]]||''):'';
    const it={makerCode:get('makerCode'),makerName:get('makerName'),selfCode:get('selfCode'),spec:get('spec'),currentCost:get('currentCost'),newCost:get('newCost'),switchDate:get('switchDate')};
    // 実施日 一括入力：列が無い／空欄の行へ付与（scope='all' なら既存も上書き）。
    if(forcedSwitchDate && forcedSwitchDate.date && (forcedSwitchDate.scope==='all' || !String(it.switchDate||'').trim())){
      it.switchDate=forcedSwitchDate.date;
    }
    if(it.makerName||it.makerCode||it.newCost) items.push(it);
  });
  return {map,items};
}
// ===== 方法C：1件ずつ手入力 =====
// 固定レイアウトの入力表（列の意味が決まっているので照合用の項目をそのまま入力できる）。
const MANUAL_COLS=[['makerCode','メーカー品番'],['makerName','メーカー商品名'],['selfCode','自社コード'],['spec','規格'],['currentCost','現単価'],['newCost','新単価'],['switchDate','切替日']];
const MANUAL_ROWS0=5;
function manualRowCount(){ return $('#manualTbl').querySelectorAll('tbody tr').length; }
function manualRowHtml(r){
  return '<tr>'+MANUAL_COLS.map((c,ci)=>'<td><input data-mr="'+r+'" data-mc="'+ci+'" style="width:120px;border:1px solid #d4dae2;background:#fff" '+((c[0]==='currentCost'||c[0]==='newCost')?'inputmode="decimal"':'')+'></td>').join('')+'</tr>';
}
function renderManual(){
  let h='<thead><tr>'+MANUAL_COLS.map(c=>'<th style="white-space:nowrap">'+esc(c[1])+((c[0]==='makerName'||c[0]==='newCost')?' <span style="color:#c0392b">*</span>':'')+'</th>').join('')+'</tr></thead><tbody>';
  for(let r=0;r<MANUAL_ROWS0;r++) h+=manualRowHtml(r);
  h+='</tbody>';
  $('#manualTbl').innerHTML=h;
}
function addManualRow(){
  const tb=$('#manualTbl').querySelector('tbody'); if(!tb) return;
  const tmp=document.createElement('tbody'); tmp.innerHTML=manualRowHtml(manualRowCount());
  tb.appendChild(tmp.firstChild);
}
function manualToGrid(){
  const rows=[];
  $('#manualTbl').querySelectorAll('tbody tr').forEach(tr=>{
    const vals=MANUAL_COLS.map(()=>'');
    tr.querySelectorAll('input').forEach(inp=>{ vals[+inp.dataset.mc]=inp.value.trim(); });
    if(vals.some(v=>v!=='')) rows.push(vals);
  });
  return rows;
}
function applyManual(){
  const data=manualToGrid();
  if(!data.length){ $('#manualMsg').style.color='#c0392b'; $('#manualMsg').textContent='入力された行がありません'; return; }
  const header=MANUAL_COLS.map(c=>c[1]);
  $('#hasHeader').checked=true;
  suppressProfile=true;          // 手入力＝固定レイアウト。保存済み書式での列上書きを抑止。
  loadRows([header].concat(data));
  $('#manualMsg').style.color='#2e7d32';
  $('#manualMsg').textContent='✓ '+data.length+'件を下の③に反映しました。内容を確認して「保存」してください。';
  const ma=$('#mapArea'); if(ma) ma.scrollIntoView({behavior:'smooth',block:'start'});
}
$('#manualToggle').addEventListener('click',()=>{
  if($('#manualToggle').disabled) return;
  const a=$('#manualArea'); const open=(a.style.display==='none'||!a.style.display);
  a.style.display=open?'block':'none';
  $('#manualToggle').textContent=open?'✕ 手入力をとじる':'✏ 手入力をひらく';
  if(open && !$('#manualTbl').innerHTML) renderManual();
});
$('#manualAddBtn').addEventListener('click',addManualRow);
$('#manualApplyBtn').addEventListener('click',applyManual);
// 最終行に入力したら自動で1行追加（行が足りなくならないように）
$('#manualTbl').addEventListener('input',(e)=>{
  const inp=e.target; if(!inp.dataset||inp.dataset.mr==null) return;
  if(+inp.dataset.mr===manualRowCount()-1 && inp.value.trim()!=='') addManualRow();
});

$('#parseBtn').addEventListener('click',parse);
$('#supplierSel').addEventListener('change',onSupplierPick);
$('#supplier').addEventListener('input',()=>{ updateStep2Lock(); warnSupplierMismatch(); });
$('#resetBtn').addEventListener('click',()=>{
  if((grid.length || $('#supplier').value.trim()) && !confirm('入力中の仕入先・取り込みデータをすべて消して、別の仕入先を最初から取り込みますか？')) return;
  resetImport(); hideTop(); $('#supplier').focus();
});
$('#purchaseCodeSel').addEventListener('change',onPurchaseCodePick);
$('#advToggle').addEventListener('click',(e)=>{
  e.preventDefault();
  const a=$('#advArea'); const open=(a.style.display==='none'||!a.style.display);
  a.style.display=open?'block':'none';
  $('#advToggle').textContent=(open?'▾':'▸')+' その他（登録済みから選ぶ／問屋の下のメーカーを分けて登録）';
});
$('#skipN').addEventListener('input',applySkipAndRender);
// 実施日列が grid にあれば、その列のセルへ forcedSwitchDate を反映（見える化）。戻り値: 埋めた行数／-1=列なし。
function applyForcedDateToGrid(){
  if(!forcedSwitchDate || !forcedSwitchDate.date) return 0;
  let dateCol=-1;
  $('#grid').querySelectorAll('thead select').forEach(s=>{ if(s.value==='switchDate') dateCol=+s.dataset.c; });
  if(dateCol<0) return -1; // 切替日の列が無い → 保存時に collect() で全商品へ付与
  let n=0;
  $('#grid').querySelectorAll('tbody input[data-c="'+dateCol+'"]').forEach(inp=>{
    if(forcedSwitchDate.scope==='all' || !inp.value.trim()){ inp.value=forcedSwitchDate.date; n++; }
  });
  return n;
}
$('#bulkDateBtn').addEventListener('click',()=>{
  const msg=$('#bulkDateMsg');
  const raw=$('#bulkDate').value.trim();
  if(!raw){ msg.style.color='#c0392b'; msg.textContent='日付を入れてください'; return; }
  if(!grid.length){ msg.style.color='#c0392b'; msg.textContent='先に②でデータを読み取ってください'; return; }
  const iso=jpDateToISO(raw,new Date());
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(iso)){ msg.style.color='#c0392b'; msg.textContent='日付として読み取れません（例 2026-07-01 / 7/1）'; return; }
  forcedSwitchDate={date:iso,scope:$('#bulkDateScope').value};
  const n=applyForcedDateToGrid();
  msg.style.color='#2e7d32';
  msg.textContent = (n>=0)
    ? '✓ 切替日列の '+n+' 行に '+iso+' を反映しました（保存時に書き込まれます）'
    : '✓ 実施日の列が無いので、保存時に全商品へ '+iso+' を付与します';
});
$('#fileBtn').addEventListener('click',()=>{ if($('#fileBtn').disabled) return; $('#file').click(); });
$('#file').addEventListener('change',onFilePicked);

// ── AI取り込みアシスト（任意・/api/ai-status が enabled のときだけ表示）──
let aiEnabled=false;
async function initAi(){
  try{
    const s=await fetch('/api/ai-status').then(x=>x.json());
    if(s && s.enabled){ aiEnabled=true; $('#aiRow').style.display='flex'; updateStep2Lock(); }
  }catch(_){ /* AI状態が取れなくても通常機能は動く */ }
}
function aiBusy(on,label){
  $('#aiTextBtn').disabled=on; $('#aiPdfBtn').disabled=on;
  $('#aiMsg').style.color='#6b7785';
  $('#aiMsg').textContent = on ? ('🤖 '+(label||'読み取り中')+'…（数十秒かかることがあります）') : '';
}
function aiApply(res){
  if(!res || !res.ok){
    $('#aiMsg').style.color='#c0392b';
    $('#aiMsg').textContent='AI読み取り失敗: '+((res&&res.error)||'不明なエラー');
    return false;
  }
  loadRows(res.rows); // 既存の確認グリッドへ流し込む（以降は手動取り込みと同じ：列対応→確認→保存）
  let m='✓ AIが '+res.count+' 件を読み取りました（'+esc(res.model||'')+'）。③の表で単価・実施日を確認して保存してください。';
  if(res.warnings && res.warnings.length){ m += '<br>⚠ '+res.warnings.map(esc).join('<br>⚠ '); }
  showTop(m);
  $('#aiMsg').style.color='#2e7d32';
  $('#aiMsg').textContent='✓ 読み取り完了（'+res.count+'件）';
  return true;
}
async function aiFromText(){
  const supplier=$('#supplier').value.trim();
  if(!supplier){ $('#aiMsg').style.color='#c0392b'; $('#aiMsg').textContent='① 仕入先名を入れてください'; return; }
  const text=$('#src').value.trim();
  if(!text){ $('#aiMsg').style.color='#c0392b'; $('#aiMsg').textContent='上の欄に貼り付け（または表を貼り付け）してから押してください'; return; }
  aiBusy(true,'AIが読み取り中');
  try{
    const res=await fetch('/api/ai-extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({supplier,text})}).then(x=>x.json());
    aiBusy(false); aiApply(res);
  }catch(e){ aiBusy(false); $('#aiMsg').style.color='#c0392b'; $('#aiMsg').textContent='通信失敗: '+(e&&e.message||e); }
}
async function aiFromPdfFile(ev){
  const f=ev.target.files && ev.target.files[0];
  ev.target.value=''; // 同じファイル再選択でも発火するように
  if(!f) return;
  const supplier=$('#supplier').value.trim();
  if(!supplier){ $('#aiMsg').style.color='#c0392b'; $('#aiMsg').textContent='① 仕入先名を入れてください'; return; }
  aiBusy(true,'PDFをAIが読み取り中');
  try{
    const buf=await f.arrayBuffer();
    const b64=bufToB64(buf);
    const res=await fetch('/api/ai-extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({supplier,pdfB64:b64})}).then(x=>x.json());
    aiBusy(false); aiApply(res);
  }catch(e){ aiBusy(false); $('#aiMsg').style.color='#c0392b'; $('#aiMsg').textContent='読み込み失敗: '+(e&&e.message||e); }
}
$('#aiTextBtn').addEventListener('click',aiFromText);
$('#aiPdfBtn').addEventListener('click',()=>{ if($('#aiPdfBtn').disabled) return; $('#aiPdf').click(); });
$('#aiPdf').addEventListener('change',aiFromPdfFile);
initAi();

loadMakers();
loadSuppliersMaster();
updateStep2Lock(); // 初期状態（仕入先未選択）でロック
$('#saveBtn').addEventListener('click',async()=>{
  const supplier=$('#supplier').value.trim();
  if(!supplier){ $('#msg').style.color='#c0392b'; $('#msg').textContent='① 仕入先名を入れてください'; return; }
  const {map,items}=collect();
  if(map.newCost==null||(map.makerName==null&&map.makerCode==null)){ $('#msg').style.color='#c0392b'; $('#msg').textContent='「新単価」と「メーカー商品名(または品番)」の列を指定してください'; return; }
  if(!items.length){ $('#msg').style.color='#c0392b'; $('#msg').textContent='データ行がありません'; return; }
  // 取り違えガード：表示中のデータを読み込んだ仕入先と、保存先の仕入先が違うときは確認する。
  if(loadedForSupplier && loadedForSupplier!==supplier &&
     !confirm('表示中のデータは「'+loadedForSupplier+'」で読み込んだものです。\\nこれを「'+supplier+'」として保存します。よろしいですか？')){ return; }
  $('#msg').style.color='#6b7785'; $('#msg').textContent='保存中…';
  const purchaseCode=$('#purchaseCodeSel').value.trim();
  const payload={supplier,items,map,delim:$('#delim').value,hasHeader:$('#hasHeader').checked,purchaseCode};
  try{
    const res=await fetch('/api/maker-quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(x=>x.json());
    if(res.ok){
      let extra='', kind='ok';
      if(res.shogo && res.shogo.ok){
        const n=(res.shogo.files||[]).length;
        extra=' ／ 🔄 自動で照合しました（照合結果 '+n+' 本を更新）。シミュレーション画面の「対象」にすぐ出ます。';
      } else if(res.shogo){
        extra=' ／ ⚠ 自動照合に失敗しました（'+(res.shogo.error||'')+'）。シミュレーション画面の「↻ 照合を実行」を押してください。';
        kind='warn';
      }
      const linkMsg=(res.linkedCount>0)?' ／ 📌 自社コード入力 '+res.linkedCount+'件を手動紐付け（100%確定）として登録しました。':'';
      let okMsg='✓ <b>'+esc(supplier)+'</b> を保存しました（'+res.count+'件）。書式（列の対応）も登録したので次回から自動適用されます。 → '+esc(res.file||'')+linkMsg+extra
        +'<br><b>続けて別の仕入先を取り込めます</b>（入力はクリアしました。① で次の仕入先を選んでください）。';
      // 二重登録の警告：同じ商品が「別の仕入先」にも登録されている＝取り違えの可能性。
      const dw=res.dupWarning;
      if(dw && dw.count){
        kind='warn';
        const ex=(dw.items||[]).slice(0,5).map(d=>'　・'+esc(d.name||d.code)+'（'+d.suppliers.map(s=>esc(s)).join(' / ')+'）').join('<br>');
        okMsg+='<br><br>⚠ <b>二重登録の疑い '+dw.count+'件</b>：取り込んだ商品が <b>別の仕入先にも</b>登録されています。同じ商品を2つの仕入先名で取り込むと、損益・見積・取込CSVが二重になります。正しい仕入先名で取り込み直すか、片方を整理してください。<br>'+ex+(dw.count>5?'<br>　…ほか':'');
      }
      // 自社製造（日野折箱店・コード9000）で自社コードが空の商品の警告（照合されず休眠＝重複の原因）。
      const sw=res.selfCodeWarning;
      if(sw && sw.missing){
        kind='warn';
        okMsg+='<br><br>⚠ <b>自社コードが空の商品 '+sw.missing+'/'+sw.total+'件</b>：自社製造（日野折箱店）は<b>自社コードで照合</b>します。コードが無い商品は<b>照合されず休眠</b>になり、重複の原因になります。③で「自社コード」列を割り当ててから取り込み直してください。';
      }
      // 保存できたら入力を全クリア（A社→B社の取り違え事故を防ぐ）。成功メッセージは消えない上部バナーに出す。
      resetImport();
      showTop(okMsg, kind);
      loadMakers();             // 新しく登録した書式をプルダウンに反映
    }
    else { $('#msg').style.color='#c0392b'; $('#msg').textContent='保存失敗: '+(res.error||''); }
  }catch(e){ $('#msg').style.color='#c0392b'; $('#msg').textContent='保存失敗: '+e; }
});
</script>
</body></html>`;

module.exports = { IMPORT_PAGE };
