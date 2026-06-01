// =====================================================================
//  メーカー見積 一覧／進捗ページ（/list で表示）
//   maker_quotes/ の取り込み済みCSVを一覧表示し、
//   input/<仕入先>_照合結果_*.csv の有無で「照合済み」、
//   output/<仕入先>_照合結果_見積書_*\ の有無で「見積書作成済み」を判定。
// =====================================================================
const LIST_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>メーカー見積 一覧</title>
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
  button.go{background:#1f4e78;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
  button.go:disabled{opacity:.5;cursor:not-allowed}
  button.mini{background:#eaf1f8;color:#1f4e78;border:1px solid #c7d6e4;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}
  button.mini:hover{background:#dbe8f5}
  table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}
  th,td{border:1px solid #e2e6ec;padding:6px 8px;vertical-align:middle}
  th{background:#eef2f7;text-align:left;white-space:nowrap}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.center{text-align:center}
  .status{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
  .s-imp{background:#e3f0fb;color:#1f4e78}
  .s-mat{background:#fff4d6;color:#7a5a00}
  .s-quo{background:#e1f3df;color:#2e5a2e}
  .s-stale{background:#fdecea;color:#c0392b;margin-left:4px}
  .src-extra{color:#6b7785;font-size:11px;margin-top:2px}
  .muted{color:#6b7785;font-size:11px}
  .empty{padding:30px;text-align:center;color:#6b7785}
  #msg{font-size:12px}
  .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:#6b7785}
</style></head><body>
<header>
  <h1>メーカー見積 一覧 / 進捗</h1>
  <span class="sub">取り込み・照合・見積書の進み具合をひと目で</span>
  <span class="spacer"></span>
  <a href="/">← シミュレーション画面へ</a>
  <a href="/import">＋ メーカー見積を取り込む</a>
</header>

<div class="card">
  <div class="toolbar">
    <button class="go" id="reloadBtn">🔄 最新の状態を読み込む</button>
    <button class="go" id="runShogoBtn">⚙ 未照合のメーカーを照合する</button>
    <span id="msg"></span>
  </div>
  <div class="legend">
    <span><span class="status s-imp">🔵 取り込みのみ</span> まだ照合していない</span>
    <span><span class="status s-mat">🟡 照合済み</span> 見積書はまだ作っていない</span>
    <span><span class="status s-quo">🟢 見積書作成済み</span> 顧客向け見積出力済み</span>
  </div>
</div>

<div class="card">
  <div id="tableArea"><div class="empty">読み込み中…</div></div>
</div>

<div class="card">
  <div class="toolbar" style="margin-bottom:6px">
    <b>📌 確定済み 商品紐付け一覧</b>
    <span class="muted">自社CD ↔ メーカー商品名（手動で確定したもの）。誤登録は「解除」ですぐ消せます</span>
    <span class="spacer" style="margin-left:auto"></span>
    <button class="mini" id="reloadLinksBtn">↻ 再読込</button>
  </div>
  <div id="linksArea"><div class="empty">読み込み中…</div></div>
</div>

<script>
const $=s=>document.querySelector(s);
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmtDate(iso){
  if(!iso) return '';
  const d=new Date(iso); if(isNaN(d)) return '';
  const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
function statusBadge(s){
  if(s==='見積書作成済み') return '<span class="status s-quo">🟢 見積書作成済み</span>';
  if(s==='照合済み')        return '<span class="status s-mat">🟡 照合済み</span>';
  return '<span class="status s-imp">🔵 取り込みのみ</span>';
}
async function load(){
  $('#tableArea').innerHTML='<div class="empty">読み込み中…</div>';
  let res;
  try{ res=await fetch('/api/maker-list').then(x=>x.json()); }
  catch(e){ $('#tableArea').innerHTML='<div class="empty">読み込み失敗：'+esc(e&&e.message||e)+'</div>'; return; }
  const list=res.items||[];
  if(!list.length){ $('#tableArea').innerHTML='<div class="empty">まだ取り込み済みのメーカー見積はありません。<br>「＋ メーカー見積を取り込む」から登録してください。</div>'; return; }
  let html='<table><thead><tr>'
    +'<th>仕入先</th><th>仕入先コード<br><span class="muted">照合フィルタ</span></th><th>取り込み日時</th><th>件数</th><th>状態</th><th>関連ファイル</th><th>操作</th>'
    +'</tr></thead><tbody>';
  for(const it of list){
    const sources = it.sources && it.sources.length ? it.sources : [{file:it.file}];
    const fileLine = '<div class="muted">'+esc(sources[0].file)+'</div>'
      + (sources.length>1 ? '<div class="src-extra">＋ '+(sources.length-1)+' 件の取込CSV</div>' : '');
    const relate=[];
    if(it.matchFiles && it.matchFiles.length) relate.push('照合結果 '+it.matchFiles.length+' 件');
    if(it.quoteFolders && it.quoteFolders.length) relate.push('見積書フォルダ '+it.quoteFolders.length+' 件');
    const relateHtml = relate.length ? relate.join(' / ') : '<span class="muted">—</span>';
    const ops=[];
    // 取込CSVを開く: 複数あれば最新を開く
    // ※ ファイル名は onclick の文字列に直接埋めず data 属性に入れる（' を含むと壊れるため）。
    ops.push('<button class="mini act-open" data-path="'+esc(sources[0].file)+'">📂 取込CSVを開く</button>');
    if(it.matchFiles && it.matchFiles.length){
      ops.push('<button class="mini act-sim" data-file="'+esc(it.matchFiles[it.matchFiles.length-1])+'">▶ シミュレーション</button>');
    }
    if(it.quoteFolders && it.quoteFolders.length){
      ops.push('<button class="mini act-open" data-path="'+esc('output/'+it.quoteFolders[it.quoteFolders.length-1])+'">📁 見積書フォルダ</button>');
    }
    const staleBadge = it.needsRematch ? '<span class="status s-stale">⚠ 再照合が必要</span>' : '';
    // 仕入先コード: 設定済みなら 0029 大黒... のように表示、未設定なら ⚠ 注意
    const pcHtml = it.purchaseCode
      ? '<b style="color:#7a5a00">🏢 '+esc(it.purchaseCode)+'</b>'+(it.purchaseName?'<div class="muted" style="margin-top:2px">'+esc(it.purchaseName)+'</div>':'')
      : '<span class="status s-stale">⚠ 未設定</span><div class="muted" style="margin-top:2px">/import で設定</div>';
    html+='<tr>'
      +'<td><b>'+esc(it.supplier)+'</b>'+fileLine+'</td>'
      +'<td>'+pcHtml+'</td>'
      +'<td>'+esc(fmtDate(it.importedAt))+'</td>'
      +'<td class="num">'+(it.count||0)+'</td>'
      +'<td>'+statusBadge(it.status)+staleBadge+'</td>'
      +'<td>'+relateHtml+'</td>'
      +'<td>'+ops.join(' ')+'</td>'
      +'</tr>';
  }
  html+='</tbody></table>';
  $('#tableArea').innerHTML=html;
  // data 属性方式の操作ボタンを配線（ファイル名に ' 等が含まれても安全）
  $('#tableArea').querySelectorAll('button.act-open').forEach(b=>b.addEventListener('click',()=>openPath(b.getAttribute('data-path'))));
  $('#tableArea').querySelectorAll('button.act-sim').forEach(b=>b.addEventListener('click',()=>openInSim(b.getAttribute('data-file'))));
}
async function openPath(p){
  try{
    const r=await fetch('/api/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})}).then(x=>x.json());
    if(!r.ok){ alert('開けませんでした：'+(r.error||'')); }
  }catch(e){ alert('開けませんでした：'+(e&&e.message||e)); }
}
function openInSim(matchFile){
  // 既存のシミュレーション画面は /api/files で input/ を一覧して選ぶ仕組み。
  // クエリで file= を渡して、画面側で受け取って自動選択する想定。
  location.href='/?file='+encodeURIComponent(matchFile);
}
async function runShogo(){
  $('#msg').style.color='#6b7785'; $('#msg').textContent='照合中… しばらくお待ちください';
  $('#runShogoBtn').disabled=true;
  try{
    const r=await fetch('/api/shogo',{method:'POST'}).then(x=>x.json());
    if(r.ok){ $('#msg').style.color='#2e7d32'; $('#msg').textContent='✓ 完了：'+((r.files&&r.files.length)||0)+' 件の照合結果を出力'; load(); }
    else { $('#msg').style.color='#c0392b'; $('#msg').textContent='失敗：'+(r.error||''); }
  }catch(e){ $('#msg').style.color='#c0392b'; $('#msg').textContent='失敗：'+(e&&e.message||e); }
  finally{ $('#runShogoBtn').disabled=false; }
}
async function loadLinks(){
  $('#linksArea').innerHTML='<div class="empty">読み込み中…</div>';
  let res;
  try{ res=await fetch('/api/product-links').then(x=>x.json()); }
  catch(e){ $('#linksArea').innerHTML='<div class="empty">読み込み失敗：'+esc(e&&e.message||e)+'</div>'; return; }
  const links = res.productLinks || {};
  const suppliers = Object.keys(links).sort();
  if(!suppliers.length){
    $('#linksArea').innerHTML='<div class="empty">確定済みの紐付けはまだありません。<br>シミュレーション画面の「✏ 紐付け」ボタンから登録できます。</div>';
    return;
  }
  let total = 0;
  let html = '';
  for(const sup of suppliers){
    const codes = Object.keys(links[sup]||{}).sort();
    if(!codes.length) continue;
    total += codes.length;
    html += '<div style="margin-top:10px;font-weight:700;color:#1f4e78">🏢 '+esc(sup)+' <span class="muted" style="font-weight:400">'+codes.length+'件</span></div>';
    html += '<table><thead><tr><th>自社CD</th><th>メーカー商品名</th><th style="width:80px">操作</th></tr></thead><tbody>';
    for(const code of codes){
      const maker = links[sup][code] || '';
      html += '<tr>'
        + '<td><b>'+esc(code)+'</b></td>'
        + '<td>'+esc(maker)+'</td>'
        + '<td class="center"><button class="mini" data-sup="'+esc(sup)+'" data-code="'+esc(code)+'" data-maker="'+esc(maker)+'" onclick="unlink(this)">解除</button></td>'
        + '</tr>';
    }
    html += '</tbody></table>';
  }
  html = '<div class="muted" style="margin-bottom:4px">合計 <b>'+total+'</b> 件の紐付けが登録されています</div>' + html;
  $('#linksArea').innerHTML = html;
}
async function unlink(btn){
  const sup = btn.getAttribute('data-sup');
  const code = btn.getAttribute('data-code');
  const maker = btn.getAttribute('data-maker');
  if(!confirm('紐付けを解除します。よろしいですか？\\n\\n仕入先: '+sup+'\\n自社CD: '+code+'\\nメーカー商品: '+maker)) return;
  btn.disabled = true;
  try{
    const r = await fetch('/api/product-link',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({supplier:sup, productCode:code, makerName:''})}).then(x=>x.json());
    if(r.ok){ loadLinks(); }
    else { alert('解除に失敗：'+(r.error||'')); btn.disabled = false; }
  }catch(e){ alert('解除に失敗：'+e); btn.disabled = false; }
}
$('#reloadBtn').addEventListener('click',()=>{ load(); loadLinks(); });
$('#runShogoBtn').addEventListener('click',runShogo);
$('#reloadLinksBtn').addEventListener('click',loadLinks);
load();
loadLinks();
</script>
</body></html>`;

module.exports = { LIST_PAGE };
