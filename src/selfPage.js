// =====================================================================
//  自社データ（販売実績）取込ルール設定ページ（/self）
//   ・自社販売実績ファイルを取込し、列の役割をユーザに見せる
//   ・「階層セル」(0019  男寿し / 007923  ...商品名... 92988 ※50 13) の
//     パース結果（自社CD・商品名コア・仕入先商品コード・運賃条件・ロット・仕入先コード）
//     を一行ずつ表示してユーザが確認できる
//   ・列の役割と「使う/使わない」設定を settings.json:selfProfile に保存
// =====================================================================
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
</style></head><body>
<header>
  <h1>🗂 自社データ取込設定</h1>
  <span class="hint" style="color:#cfe0f0">販売実績を読み込み、どこが何の情報か確認・保存</span>
  <span class="spacer"></span>
  <a href="/">← シミュレーション</a>
  <a href="/customers">👥 得意先別</a>
  <a href="/list">📊 一覧・進捗</a>
  <a href="/import">＋ メーカー見積取込</a>
  <a href="/suppliers">📒 仕入先マスタ</a>
</header>

<div class="card" id="srcCard">
  <h3 style="margin:0 0 6px">📂 照合で実際に使われる販売実績ファイル</h3>
  <div class="hint" style="margin-bottom:8px">
    照合.bat ／ シミュレーション画面「↻ 照合を実行」が裏で読み込んでいる本番ファイル。<br>
    config.js の <code>hanbai.path</code> が フォルダ指定 の場合、その中の <b>最新の .XLS/.xlsx/.csv</b> が毎回自動選択されます。
  </div>
  <div id="srcInfo" class="muted">読込中…</div>
</div>

<div class="card">
  <h3 style="margin:0 0 6px">🔍 別ファイルをプレビュー（取込ルールの確認用）</h3>
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

<div class="card">
  <h3 style="margin:0 0 6px">現在の selfProfile</h3>
  <pre id="currentProfile" class="hint" style="background:#f5f7fa;padding:8px;border-radius:4px;white-space:pre-wrap">読込中…</pre>
</div>

<script>
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
  $('#previewSum').textContent = pendingGrid.length+'行を表示（全'+pendingGrid.length+'件中）';

  // 生データテーブル
  const th = pendingHeaders.map((h,i)=>'<th>'+(h||'(列'+(i+1)+')')+'</th>').join('');
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
    await loadCurrent();
  } else {
    $('#saveMsg').textContent = '保存失敗: '+(res.error||''); $('#saveMsg').className = 'err';
  }
});

async function loadCurrent() {
  const res = await fetch('/api/self-profile').then(x => x.json());
  const sp = res && res.selfProfile;
  if (!sp) { $('#currentProfile').textContent = '（まだ保存されていません。上で取込してください）'; return; }
  $('#currentProfile').textContent = JSON.stringify(sp, null, 2);
}
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
      const cm = Number(r.candidateMonths) || 12;
      banner = '<div style="margin-bottom:10px;padding:10px 12px;background:#e9f6ec;border:1px solid #b7e0c0;border-radius:8px;color:#1f6b35;font-size:13px;line-height:1.8">'
        + '<b>✅ 現在は販売大臣DBから直接取得しています'+(r.source==='auto'?'（自動：DBが無いPCのみ下のファイルを使用）':'（DB直結）')+'。</b><br>'
        + '年間金額・損益の集計期間：<b>'+rng+'</b>（実行のたびに「今日を基準に直近約1年」を自動で取り直します）。手動エクスポートは不要です。'
        + '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #b7e0c0">'
        +   '⏳ <b>照合に含める期間（さかのぼり）</b>：'
        +   '<input id="candMonths" type="number" min="12" max="60" step="1" value="'+cm+'" style="width:64px;padding:3px 6px;border:1px solid #b7e0c0;border-radius:4px;font:inherit;text-align:right"> か月　'
        +   '<button id="candSave" style="padding:4px 12px;background:#1f6b35;color:#fff;border:none;border-radius:4px;cursor:pointer">保存</button>'
        +   ' <span id="candMsg" style="font-size:12px"></span><br>'
        +   '<span style="color:#4a7a55;font-size:12px">この期間に売上がある商品を照合の<b>候補</b>に含めます（既定12か月）。長くすると、1年以上ご無沙汰の商品も見積で拾えます。'
        +   '<b>年間金額・損益は上記のとおり直近約1年で計算</b>するので、延ばしても損益は歪みません。変更は次回の「↻ 照合を実行」から有効。</span></div>'
        + '<div style="margin-top:6px"><span style="color:#4a7a55">↓ 下の「ファイル」設定は、DBが無いPC（自宅など）や他社運用のための予備です。会社PCでは使われません。</span></div></div>';
    }
    // 「照合に含める期間」保存ボタンを配線（DB案内バナーがあるときだけ要素が存在）
    function bindPeriod(){
      const b = $('#candSave'); if(!b) return;
      b.addEventListener('click', async ()=>{
        const m = $('#candMonths').value, msg = $('#candMsg');
        msg.style.color='#6b7785'; msg.textContent='保存中…';
        try{
          const res = await fetch('/api/hanbai-period',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({months:m})}).then(x=>x.json());
          if(res.ok){ msg.style.color='#1f6b35'; msg.textContent='✓ 保存（'+res.candidateMonths+'か月）。次回の「↻ 照合を実行」から有効'; $('#candMonths').value=res.candidateMonths; }
          else { msg.style.color='#c0392b'; msg.textContent='失敗: '+(res.error||''); }
        }catch(e){ msg.style.color='#c0392b'; msg.textContent='失敗: '+e; }
      });
    }
    if (!r.configured) {
      target.innerHTML = banner + (usesDb
        ? '<div class="hint" style="padding:4px 8px">ファイルパスは未設定ですが、DB直結のため問題ありません。</div>'
        : '<span class="err">⚠ config.js の hanbai.path が未設定です</span>');
      bindPeriod();
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
    bindPeriod();
  } catch (e) {
    target.innerHTML = '<span class="err">読込失敗: '+esc(String(e))+'</span>';
  }
}
loadCurrent();
loadHanbaiSource();
</script>
</body></html>`;

module.exports = { SELF_PAGE };
