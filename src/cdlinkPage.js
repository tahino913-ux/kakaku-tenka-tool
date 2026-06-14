// =====================================================================
//  コード化（初期登録）ページ（/cdlink で表示）
//   名前一致でしか紐づいていない品の「メーカー品番 → 自社マスタ商品名3」を
//   人がチェックして「確定」していく画面。
//   ・確定 = productLinks に登録（↻照合で 手動紐付け＝CD相当に効く）＋ メーカー品番を記録。
//   ・確定済みは「商品名3登録用CSV」で書き出し → 販売大臣の商品マスタ取込で NM3 に登録。
//   ・却下 = 候補から消す（誤った取り違え候補のノイズを減らす）。
//   ※ DBには書かない（鉄則）。書き戻しは販売大臣自身の取込で。
// =====================================================================
const CDLINK_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>コード化（メーカー品番の登録）</title>
<style>
  body{margin:0;font-family:"メイリオ","Meiryo","Segoe UI",sans-serif;background:#f4f6f9;color:#1f2733;font-size:13px}
  header{background:#1f4e78;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  header h1{font-size:16px;margin:0}
  header .sub{color:#cfe0f0;font-size:12px}
  header a{color:#cfe0f0;font-size:12px;text-decoration:none;background:rgba(255,255,255,.08);padding:5px 10px;border-radius:6px}
  header a:hover{background:rgba(255,255,255,.18)}
  header .spacer{margin-left:auto}
  .card{background:#fff;border:1px solid #e2e6ec;border-radius:10px;margin:12px 16px;padding:12px 14px}
  .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .note{background:#eef6ff;border:1px solid #cfe2f5;border-radius:8px;padding:10px 12px;color:#234;line-height:1.6}
  .note b{color:#1f4e78}
  button.go{background:#1f4e78;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
  button.go:disabled{opacity:.5;cursor:not-allowed}
  button.mini{background:#eaf1f8;color:#1f4e78;border:1px solid #c7d6e4;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}
  button.mini:hover{background:#dbe8f5}
  button.ok{background:#e1f3df;color:#2e5a2e;border:1px solid #b6d8b1}
  button.ok:hover{background:#cfe9ca}
  button.ng{background:#fdecea;color:#c0392b;border:1px solid #f0c4bd}
  button.ng:hover{background:#f8d8d2}
  input,select{font-size:13px;padding:5px 8px;border:1px solid #c7d2dd;border-radius:6px}
  table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}
  th,td{border:1px solid #e2e6ec;padding:6px 8px;vertical-align:middle}
  th{background:#eef2f7;text-align:left;white-space:nowrap}
  td.center{text-align:center}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .pct{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:700}
  .p-hi{background:#e1f3df;color:#2e5a2e}
  .p-mid{background:#fff4d6;color:#7a5a00}
  .p-lo{background:#fdecea;color:#c0392b}
  .code{font-variant-numeric:tabular-nums;font-weight:700}
  .muted{color:#6b7785;font-size:11px}
  .empty{padding:30px;text-align:center;color:#6b7785}
  #msg{font-size:12px}
  .dl{background:#1f4e78;color:#fff;text-decoration:none;border-radius:8px;padding:7px 12px;font-weight:700}
  .dl:hover{background:#163a5a}
</style></head><body>
<header>
  <h1>コード化（メーカー品番の登録）</h1>
  <span class="sub">名前一致の品を「品番一致(CD一致)」に格上げして、確実に紐づける</span>
  <span class="spacer"></span>
  <a href="/">← シミュレーション</a>
  <a href="/list">📋 一覧/進捗</a>
  <a href="/customers">👥 得意先別</a>
  <a href="/self">🗂 自社データ設定</a>
</header>

<div class="card">
  <div class="note">
    <b>使い方（3ステップ）</b><br>
    ① 下の候補は「メーカー品番はあるのに、自社マスタに未登録で <u>名前一致だけ</u>で紐づいている品」です。<br>
    ② 正しければ <button class="mini ok" style="pointer-events:none">確定</button>（＝すぐ手動紐付けで効きます）／違えば <button class="mini ng" style="pointer-events:none">却下</button>。
       <b>一致度100%は安全</b>・低い%は別サイズの取り違えに注意してから確定。<br>
    ③ 確定がたまったら下の <b>「📥 商品名3登録用CSV」</b> をダウンロード → 販売大臣の商品マスタ取込で <b>商品名3</b> に登録 → このツールで <b>↻照合</b>。以降は品番一致で確実に紐づきます。
  </div>
</div>

<div class="card">
  <div class="toolbar">
    <button class="go" id="reloadBtn">🔄 最新の状態</button>
    <label>仕入先 <select id="fSupplier"><option value="">すべて</option></select></label>
    <label>一致度 <input id="fMinPct" type="number" min="0" max="100" step="1" value="0" style="width:64px"> % 以上</label>
    <label>検索 <input id="fSearch" type="text" placeholder="商品名・コード・品番" style="width:180px"></label>
    <span class="spacer" style="margin-left:auto"></span>
    <span id="msg" class="muted"></span>
  </div>
</div>

<div class="card">
  <div class="toolbar" style="margin-bottom:6px">
    <b>① 確定待ちの候補</b>
    <span class="muted" id="candCount"></span>
  </div>
  <div id="candArea"><div class="empty">読み込み中…</div></div>
</div>

<div class="card">
  <div class="toolbar" style="margin-bottom:6px">
    <b>② 確定済み（商品名3に登録する品番）</b>
    <span class="muted" id="confCount"></span>
    <span class="spacer" style="margin-left:auto"></span>
    <a class="dl" id="dlBtn" href="/api/cd-register.csv" download>📥 商品名3登録用CSV</a>
  </div>
  <div id="confArea"><div class="empty">読み込み中…</div></div>
</div>

<script>
const $=s=>document.querySelector(s);
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function escConfirm(s){return String(s==null?'':s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/\\r/g,'').replace(/\\n/g,'\\\\n');}
let allCand=[];

function pctTag(p){
  if(p==='' || p==null) return '<span class="muted">—</span>';
  const n=Number(p); const cls = n>=100?'p-hi':(n>=80?'p-mid':'p-lo');
  return '<span class="pct '+cls+'">'+n+'%</span>';
}
function setMsg(t,color){ const m=$('#msg'); m.textContent=t||''; m.style.color=color||'#6b7785'; }

function renderSupplierFilter(){
  const cur=$('#fSupplier').value;
  const sups=[...new Set(allCand.map(c=>c.supplier))].sort((a,b)=>String(a).localeCompare(String(b),'ja'));
  $('#fSupplier').innerHTML='<option value="">すべて</option>'+sups.map(s=>'<option value="'+esc(s)+'">'+esc(s)+'</option>').join('');
  if(sups.indexOf(cur)>=0) $('#fSupplier').value=cur;
}
function filtered(){
  const sup=$('#fSupplier').value;
  const minp=Number($('#fMinPct').value)||0;
  const q=$('#fSearch').value.trim().toLowerCase();
  return allCand.filter(c=>{
    if(sup && c.supplier!==sup) return false;
    if(c.pct!=='' && Number(c.pct)<minp) return false;
    if(q){
      const hay=(c.selfCode+' '+c.selfName+' '+c.makerCode+' '+c.makerName).toLowerCase();
      if(hay.indexOf(q)<0) return false;
    }
    return true;
  });
}
function renderCand(){
  const list=filtered();
  $('#candCount').textContent='（表示 '+list.length+' 件 / 全 '+allCand.length+' 件）';
  if(!list.length){ $('#candArea').innerHTML='<div class="empty">確定待ちの候補はありません。<br>（すべて確定/却下済み、または ↻照合 がまだの可能性）</div>'; return; }
  let html='<table><thead><tr>'
    +'<th>仕入先</th><th>自社コード</th><th>現在の自社商品名</th><th>メーカー品番<br><span class="muted">商品名3へ登録</span></th><th>メーカー商品名</th><th class="center">一致度</th><th class="center" style="width:150px">操作</th>'
    +'</tr></thead><tbody>';
  for(let i=0;i<list.length;i++){
    const c=list[i];
    html+='<tr>'
      +'<td>'+esc(c.supplier)+'</td>'
      +'<td class="code">'+esc(c.selfCode)+'</td>'
      +'<td>'+esc(c.selfName)+'</td>'
      +'<td class="code" style="color:#7a5a00">'+esc(c.makerCode)+'</td>'
      +'<td>'+esc(c.makerName)+'</td>'
      +'<td class="center">'+pctTag(c.pct)+'</td>'
      +'<td class="center">'
        +'<button class="mini ok act-ok" data-i="'+i+'">確定</button> '
        +'<button class="mini ng act-ng" data-i="'+i+'">却下</button>'
      +'</td>'
      +'</tr>';
  }
  html+='</tbody></table>';
  $('#candArea').innerHTML=html;
  // フィルタ後リストを参照するため、ボタンに現在の filtered() の index を持たせている
  const cur=list;
  $('#candArea').querySelectorAll('.act-ok').forEach(b=>b.addEventListener('click',()=>confirmCand(cur[Number(b.getAttribute('data-i'))])));
  $('#candArea').querySelectorAll('.act-ng').forEach(b=>b.addEventListener('click',()=>rejectCand(cur[Number(b.getAttribute('data-i'))])));
}
async function confirmCand(c){
  if(!c) return;
  setMsg('登録中…');
  try{
    const r=await fetch('/api/cd-confirm',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({supplier:c.supplier,selfCode:c.selfCode,makerCode:c.makerCode,makerName:c.makerName})}).then(x=>x.json());
    if(r.ok){ setMsg('✓ 確定しました（↻照合で品番一致に反映されます）','#2e7d32'); await loadAll(); }
    else { setMsg('失敗：'+(r.error||''),'#c0392b'); }
  }catch(e){ setMsg('失敗：'+(e&&e.message||e),'#c0392b'); }
}
async function rejectCand(c){
  if(!c) return;
  setMsg('却下中…');
  try{
    const r=await fetch('/api/cd-reject',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({supplier:c.supplier,selfCode:c.selfCode,makerCode:c.makerCode})}).then(x=>x.json());
    if(r.ok){ setMsg('却下しました（候補から除外）','#6b7785'); await loadAll(); }
    else { setMsg('失敗：'+(r.error||''),'#c0392b'); }
  }catch(e){ setMsg('失敗：'+(e&&e.message||e),'#c0392b'); }
}
async function loadCand(){
  let res;
  try{ res=await fetch('/api/cd-candidates').then(x=>x.json()); }
  catch(e){ $('#candArea').innerHTML='<div class="empty">読み込み失敗：'+esc(e&&e.message||e)+'</div>'; return; }
  allCand = (res && res.items) ? res.items : [];
  renderSupplierFilter();
  renderCand();
}
async function loadConf(){
  let res;
  try{ res=await fetch('/api/cd-confirmed').then(x=>x.json()); }
  catch(e){ $('#confArea').innerHTML='<div class="empty">読み込み失敗：'+esc(e&&e.message||e)+'</div>'; return; }
  const items=(res && res.items)?res.items:[];
  $('#confCount').textContent='（'+items.length+' 件）';
  $('#dlBtn').style.opacity = items.length ? '1' : '.4';
  $('#dlBtn').style.pointerEvents = items.length ? 'auto' : 'none';
  if(!items.length){ $('#confArea').innerHTML='<div class="empty">まだ確定はありません。上の候補から「確定」してください。</div>'; return; }
  let html='<table><thead><tr><th>仕入先</th><th>自社コード</th><th>メーカー品番<br><span class="muted">商品名3へ登録</span></th><th>メーカー商品名</th><th class="center" style="width:90px">操作</th></tr></thead><tbody>';
  for(const it of items){
    html+='<tr>'
      +'<td>'+esc(it.supplier)+'</td>'
      +'<td class="code">'+esc(it.selfCode)+'</td>'
      +'<td class="code" style="color:#7a5a00">'+esc(it.makerCode)+'</td>'
      +'<td>'+esc(it.makerName)+'</td>'
      +'<td class="center"><button class="mini act-un" data-sup="'+esc(it.supplier)+'" data-code="'+esc(it.selfCode)+'">取消</button></td>'
      +'</tr>';
  }
  html+='</tbody></table>';
  $('#confArea').innerHTML=html;
  $('#confArea').querySelectorAll('.act-un').forEach(b=>b.addEventListener('click',()=>unconfirm(b.getAttribute('data-sup'),b.getAttribute('data-code'))));
}
async function unconfirm(sup,code){
  if(!confirm('確定を取り消します。よろしいですか？\\n\\n仕入先: '+escConfirm(sup)+'\\n自社コード: '+escConfirm(code))) return;
  try{
    const r=await fetch('/api/cd-unconfirm',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({supplier:sup,selfCode:code})}).then(x=>x.json());
    if(r.ok){ setMsg('取り消しました','#6b7785'); await loadAll(); }
    else { setMsg('失敗：'+(r.error||''),'#c0392b'); }
  }catch(e){ setMsg('失敗：'+(e&&e.message||e),'#c0392b'); }
}
async function loadAll(){ await loadCand(); await loadConf(); }
$('#reloadBtn').addEventListener('click',loadAll);
$('#fSupplier').addEventListener('change',renderCand);
$('#fMinPct').addEventListener('input',renderCand);
$('#fSearch').addEventListener('input',renderCand);
loadAll();
</script>
</body></html>`;

module.exports = { CDLINK_PAGE };
