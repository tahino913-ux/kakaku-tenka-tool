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
  header{background:#1f4e78;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:14px}
  header h1{font-size:16px;margin:0}
  header a{color:#cfe0f0;margin-left:auto;font-size:12px}
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
  <a href="/" style="color:#cfe0f0;margin-left:auto;font-size:12px;text-decoration:none">← シミュレーション画面へ</a>
  <a href="/list" style="color:#cfe0f0;margin-left:14px;font-size:12px;text-decoration:none">📊 一覧・進捗</a>
</header>

<div class="step">
  <div class="lbl">① 仕入先（メーカー）を選ぶ／登録</div>
  <div class="hint">仕入先ごとに「メーカー見積のどの列が自社のどの項目か」を一度登録すれば、次回からは自動で当てはまります。<br>初めての仕入先は「＋ 新規」を選んで名前を入力してください。</div>
  <div class="row">
    <select id="supplierSel"><option value="__new__">＋ 新規…</option></select>
    <input id="supplier" placeholder="仕入先名（例: 大黒工業）" style="width:240px">
    <span id="profMsg" style="font-size:11px;color:#2e7d32"></span>
  </div>
  <div id="profSummary" style="display:none;margin-top:8px;padding:8px 10px;background:#eef7ee;border:1px solid #cfe6cf;border-radius:6px;font-size:12px;color:#2e5a2e"></div>
  <div class="row" style="margin-top:10px;padding:8px 10px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px">
    <label style="font-size:12px;color:#5a4a1a">🏢 仕入先コード（自社マスタから）：</label>
    <select id="purchaseCodeSel" style="min-width:380px">
      <option value="">（未設定／全件候補 — 推奨：選択する）</option>
    </select>
    <span id="purchaseCodeBadge" style="font-size:11px;color:#7a5a00;font-weight:700"></span>
  </div>
  <div class="hint" style="font-size:11px;color:#6b7785;margin-top:4px;line-height:1.6">
    この見積書がどの仕入先(発注先)から来た値上げ通知かを指定すると、自社販売実績の <b>末尾4桁コード</b>（例: 13=朝日食品容器 / 29=大黒工業 / 53=エフピコ商事）に一致する自社品だけを照合候補にします。<br>
    ※ 問屋経由で買っている同じメーカーの品は <b>その問屋のメーカー見積</b> で別途拾われます。
  </div>
</div>

<div class="step" id="step2">
  <div class="lbl">② メーカー見積の中身を読み込む</div>
  <div class="hint"><b>方法A：ファイルを選ぶ</b>（Excel／CSVに対応）　<b>方法B：PDFやExcelの表をコピーして貼り付け</b><br>ファイルを選ぶか貼り付けると、自動で表に展開されます。</div>
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
  <div class="wrap"><table id="grid"></table></div>
</div>

<script>
const $=s=>document.querySelector(s);
const FIELDS=[['','（無視）'],['makerCode','メーカー品番'],['makerName','メーカー商品名'],['spec','規格'],['currentCost','現単価'],['newCost','新単価'],['switchDate','切替日']];
let grid=[];
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
  sel.innerHTML='<option value="">（未設定／全件候補 — 推奨：選択する）</option>'+
    codes.map(c=>'<option value="'+esc(c)+'">'+esc(c)+' '+esc(SUPPLIERS[c].name||'')+'</option>').join('');
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
    activeProfile=null; $('#supplier').value=''; $('#supplier').focus();
    $('#profMsg').textContent='';
    $('#purchaseCodeSel').value=''; updatePurchaseBadge();
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
}
// ① の入力状態に応じて ② のフォームを有効／無効化
function updateStep2Lock(){
  const sel=$('#supplierSel').value;
  const name=$('#supplier').value.trim();
  // 既存仕入先を選んでいる、または「新規」で名前を入れている → 解放
  const ok = (sel && sel !== '__new__') || (sel === '__new__' && name.length > 0);
  const ids=['fileBtn','src','delim','hasHeader','parseBtn'];
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
// --- B: 「7月1日～」のような日本語日付 → "YYYY-MM-DD" ---
function jpDateToISO(s,refDate){
  s=String(s==null?'':s).trim();
  if(!s) return s;
  // 既にISO/スラッシュ形式ならそのまま（区切りはハイフンに統一）
  let m=s.match(/^(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})/);
  if(m) return m[1]+'-'+String(+m[2]).padStart(2,'0')+'-'+String(+m[3]).padStart(2,'0');
  // YYYY年M月D日
  m=s.match(/(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日/);
  if(m) return m[1]+'-'+String(+m[2]).padStart(2,'0')+'-'+String(+m[3]).padStart(2,'0');
  // M月D日 → 年なしは「当年」に統一（価格改定は当年が前提。過ぎた月日でも翌年に飛ばさない）。
  //  以前は「次に来る同月日」で推定していたが、当年の過去月日を翌年(2027等)に誤推定する不具合があった。
  m=s.match(/(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日/);
  if(m){
    const ref=refDate||new Date();
    const M=+m[1], D=+m[2];
    const Y=ref.getFullYear();
    return Y+'-'+String(M).padStart(2,'0')+'-'+String(D).padStart(2,'0');
  }
  return s; // 未対応の形は素通り
}

// 二次元配列を表として描画（ファイル読み込み・貼り付け共通の入口）
// A: 見出し検出 → skipN を自動セット　B+C: applySkipAndRender で適用
let originalRows=[];
function loadRows(rows){
  if(!rows||!rows.length){ alert('読み取れる行がありません'); return; }
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
  render(cols, skippedPadded); applyProfile();
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
    const it={makerCode:get('makerCode'),makerName:get('makerName'),spec:get('spec'),currentCost:get('currentCost'),newCost:get('newCost'),switchDate:get('switchDate')};
    if(it.makerName||it.makerCode||it.newCost) items.push(it);
  });
  return {map,items};
}
$('#parseBtn').addEventListener('click',parse);
$('#supplierSel').addEventListener('change',onSupplierPick);
$('#supplier').addEventListener('input',updateStep2Lock);
$('#purchaseCodeSel').addEventListener('change',updatePurchaseBadge);
$('#skipN').addEventListener('input',applySkipAndRender);
$('#fileBtn').addEventListener('click',()=>{ if($('#fileBtn').disabled) return; $('#file').click(); });
$('#file').addEventListener('change',onFilePicked);
loadMakers();
loadSuppliersMaster();
updateStep2Lock(); // 初期状態（仕入先未選択）でロック
$('#saveBtn').addEventListener('click',async()=>{
  const supplier=$('#supplier').value.trim();
  if(!supplier){ $('#msg').style.color='#c0392b'; $('#msg').textContent='① 仕入先名を入れてください'; return; }
  const {map,items}=collect();
  if(map.newCost==null||(map.makerName==null&&map.makerCode==null)){ $('#msg').style.color='#c0392b'; $('#msg').textContent='「新単価」と「メーカー商品名(または品番)」の列を指定してください'; return; }
  if(!items.length){ $('#msg').style.color='#c0392b'; $('#msg').textContent='データ行がありません'; return; }
  $('#msg').style.color='#6b7785'; $('#msg').textContent='保存中…';
  const purchaseCode=$('#purchaseCodeSel').value.trim();
  const payload={supplier,items,map,delim:$('#delim').value,hasHeader:$('#hasHeader').checked,purchaseCode};
  try{
    const res=await fetch('/api/maker-quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(x=>x.json());
    if(res.ok){
      $('#msg').style.color='#2e7d32';
      let extra='';
      if(res.shogo && res.shogo.ok){
        const n=(res.shogo.files||[]).length;
        extra=' ／ 🔄 自動で照合しました（照合結果 '+n+' 本を更新）。シミュレーション画面の「対象」にすぐ出ます。';
      } else if(res.shogo){
        extra=' ／ ⚠ 自動照合に失敗しました（'+(res.shogo.error||'')+'）。シミュレーション画面の「↻ 照合を実行」を押してください。';
        $('#msg').style.color='#b8860b';
      }
      $('#msg').textContent='✓ 保存しました（'+res.count+'件）。この仕入先の書式（列の対応）を登録しました。次回からは自動で当てはまります。 → '+res.file+extra;
      // 直近の保存内容を現在のプロファイルにも反映（再表示）
      activeProfile={ map:{...map}, delim:$('#delim').value, hasHeader:$('#hasHeader').checked };
      showProfSummary();
      loadMakers();
    }
    else { $('#msg').style.color='#c0392b'; $('#msg').textContent='保存失敗: '+(res.error||''); }
  }catch(e){ $('#msg').style.color='#c0392b'; $('#msg').textContent='保存失敗: '+e; }
});
</script>
</body></html>`;

module.exports = { IMPORT_PAGE };
