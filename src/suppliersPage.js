// =====================================================================
//  仕入先マスタ管理ページ（/suppliers）
//   ・販売大臣「仕入先表形式」(.XLS/.csv) を取込
//   ・settings.json:suppliers に保存（コード4桁: { name, address, phone, ... }）
//   ・自社販売実績の末尾「仕入先コード」と紐付けて誤マッチ抑止に使う
// =====================================================================
const { navLinks } = require('./navUi');
const SUPPLIERS_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>仕入先マスタ</title>
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
  button.go:disabled{opacity:.5;cursor:not-allowed}
  button.mini{background:#eaf1f8;color:#1f4e78;border:1px solid #c7d6e4;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}
  table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;table-layout:auto}
  th,td{border:1px solid #e2e6ec;padding:5px 8px;vertical-align:middle}
  th{background:#eef2f7;text-align:left;white-space:nowrap}
  .muted{color:#6b7785;font-size:11px}
  .ok{color:#2e7d32}
  .err{color:#c0392b}
  .hint{color:#6b7785;font-size:12px}
  .badge{display:inline-block;background:#fff4d6;color:#7a5a00;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
</style></head><body>
<header>
  <h1>📒 仕入先マスタ</h1>
  <span class="hint" style="color:#cfe0f0">販売大臣「仕入先表形式」を取込</span>
  <span class="spacer"></span>
  ${navLinks('suppliers')}
</header>

<div class="card" style="background:#eef3fb;border-color:#cdddf3">
  <div style="font-size:13px;color:#1f4e78;line-height:1.8">
    ℹ️ <b>照合に使うのは「仕入先コード」と「仕入先名」だけ</b>です。<br>
    <span style="color:#33405a">電話番号・住所は<b>連絡先メモ（参考情報）</b>で、メーカー見積の取込・照合・見積書には一切影響しません（メーカーへ価格確認の連絡をするとき用）。</span>
  </div>
</div>

<div class="card">
  <div class="toolbar">
    <label>① ファイル選択
      <input type="file" id="file" accept=".XLS,.xls,.xlsx,.csv">
    </label>
    <button class="go" id="loadBtn" disabled>② 読み込み</button>
    <span id="msg" class="muted"></span>
  </div>
  <div class="hint" style="margin-top:6px">
    対応形式: .XLS（Excel COM経由・Windows + Excel必要） / .xlsx / .csv（Shift_JIS or UTF-8 自動判定）
  </div>
</div>

<div class="card" id="previewCard" style="display:none">
  <h3 style="margin:0 0 8px">読み込み結果（保存前プレビュー）</h3>
  <div id="previewSum" class="hint" style="margin-bottom:6px"></div>
  <div style="max-height:300px;overflow:auto">
    <table id="previewTbl"><thead></thead><tbody></tbody></table>
  </div>
  <div style="margin-top:10px">
    <button class="go" id="saveBtn">💾 この内容で仕入先マスタを保存</button>
    <span id="saveMsg" class="muted"></span>
  </div>
</div>

<div class="card">
  <h3 style="margin:0 0 8px">現在保存されている仕入先マスタ</h3>
  <div id="currentSum" class="hint" style="margin-bottom:6px">読込中…</div>
  <div style="max-height:400px;overflow:auto">
    <table id="currentTbl">
      <thead><tr><th>仕入先コード</th><th>仕入先名</th><th>電話番号<span class="muted">（参考）</span></th><th>住所<span class="muted">（参考）</span></th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let pendingMap = null; // 保存前の暫定マップ

$('#file').addEventListener('change', () => {
  $('#loadBtn').disabled = !$('#file').files.length;
  $('#msg').textContent = '';
});

$('#loadBtn').addEventListener('click', async () => {
  const f = $('#file').files[0]; if (!f) return;
  $('#msg').textContent = '読み込み中…';
  $('#msg').className = 'muted';
  try {
    const buf = await f.arrayBuffer();
    let bin = ''; const u8 = new Uint8Array(buf);
    for (let i=0; i<u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);
    const res = await fetch('/api/upload-suppliers', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ b64, filename: f.name })
    }).then(x => x.json());
    if (!res.ok) { $('#msg').textContent = '読み込み失敗: '+(res.error||''); $('#msg').className='err'; return; }
    pendingMap = res.suppliers;
    const keys = Object.keys(pendingMap);
    $('#msg').textContent = '✓ '+keys.length+'件 検出';
    $('#msg').className = 'ok';
    renderPreview(pendingMap);
  } catch (e) {
    $('#msg').textContent = '読み込み失敗: '+e; $('#msg').className = 'err';
  }
});

function renderPreview(map) {
  $('#previewCard').style.display = '';
  const keys = Object.keys(map).sort();
  $('#previewSum').textContent = keys.length + '件の仕入先を検出（保存ボタンで settings.json に書き込み）';
  const thead = $('#previewTbl thead'); thead.innerHTML = '<tr><th>仕入先コード</th><th>仕入先名</th><th>電話番号（参考）</th><th>住所（参考）</th></tr>';
  const tb = $('#previewTbl tbody'); tb.innerHTML = '';
  for (const k of keys.slice(0, 50)) {
    const v = map[k] || {};
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>'+esc(k)+'</td><td>'+esc(v.name||'')+'</td><td>'+esc(v.phone||'')+'</td><td>'+esc(v.address||'')+'</td>';
    tb.appendChild(tr);
  }
  if (keys.length > 50) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" class="muted">… 他 '+(keys.length-50)+'件（保存後は下の一覧に全件表示）</td>';
    tb.appendChild(tr);
  }
}

$('#saveBtn').addEventListener('click', async () => {
  if (!pendingMap) { $('#saveMsg').textContent = 'まずファイルを読み込んでください'; return; }
  $('#saveMsg').textContent = '保存中…'; $('#saveMsg').className = 'muted';
  const res = await fetch('/api/save-suppliers', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ suppliers: pendingMap })
  }).then(x => x.json());
  if (res.ok) {
    $('#saveMsg').textContent = '✓ 保存しました ('+Object.keys(res.suppliers||{}).length+'件)';
    $('#saveMsg').className = 'ok';
    await loadCurrent();
    pendingMap = null;
    $('#previewCard').style.display = 'none';
  } else {
    $('#saveMsg').textContent = '保存失敗: '+(res.error||''); $('#saveMsg').className = 'err';
  }
});

async function loadCurrent() {
  const res = await fetch('/api/suppliers').then(x => x.json());
  const map = (res && res.suppliers) || {};
  const keys = Object.keys(map).sort();
  $('#currentSum').textContent = keys.length ? (keys.length+'件保存されています') : 'まだ仕入先マスタは保存されていません。上で取込してください。';
  const tb = $('#currentTbl tbody'); tb.innerHTML = '';
  for (const k of keys) {
    const v = map[k] || {};
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>'+esc(k)+'</td><td>'+esc(v.name||'')+'</td><td>'+esc(v.phone||'')+'</td><td>'+esc(v.address||'')+'</td>';
    tb.appendChild(tr);
  }
}
loadCurrent();
</script>
</body></html>`;

module.exports = { SUPPLIERS_PAGE };
