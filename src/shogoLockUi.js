// 照合実行中の全画面ブロック用（CSS/HTML/クライアントJS を各ページに埋め込む）
const SHOGO_LOCK_CSS = `
  #shogoLockOverlay{ display:none; position:fixed; inset:0; z-index:20000; background:rgba(244,246,249,.88);
    align-items:center; justify-content:center; flex-direction:column; }
  #shogoLockOverlay.on{ display:flex; }
  #shogoLockOverlay .shogo-lock-box{ background:#fff; border:2px solid #1f6b35; border-radius:12px;
    padding:28px 36px; max-width:420px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,.12); }
  #shogoLockOverlay .shogo-lock-title{ font-size:18px; font-weight:800; color:#1f6b35; }
  #shogoLockOverlay .shogo-lock-msg{ margin-top:10px; color:#5a6b7d; font-size:14px; line-height:1.55; }
  body.shogo-lock-busy{ overflow:hidden; }
`;

const SHOGO_LOCK_HTML =
  '<div id="shogoLockOverlay" role="alertdialog" aria-modal="true" aria-labelledby="shogoLockTitle">' +
  '<div class="shogo-lock-box">' +
  '<div class="shogo-lock-title" id="shogoLockTitle">↻ 照合を実行中</div>' +
  '<div class="shogo-lock-msg" id="shogoLockMsg">完了まで操作できません（1〜2分かかることがあります）</div>' +
  '</div></div>';

// 各ページのインライン script 内にそのまま貼れる（テンプレートリテラル内でも安全＝バッククォート無し）
const SHOGO_LOCK_JS = `
let _shogoPoll=null;
function setShogoLock(on,msg){
  const ov=document.getElementById('shogoLockOverlay');
  if(!ov) return;
  ov.classList.toggle('on',!!on);
  document.body.classList.toggle('shogo-lock-busy',!!on);
  const el=document.getElementById('shogoLockMsg');
  if(el&&msg) el.textContent=msg;
  if(on&&!_shogoPoll){ _shogoPoll=setInterval(pollShogoLock,2000); }
  else if(!on&&_shogoPoll){ clearInterval(_shogoPoll); _shogoPoll=null; }
}
async function pollShogoLock(){
  try{
    const st=await fetch('/api/shogo-status').then(x=>x.json());
    if(!st.running){
      setShogoLock(false);
      if(typeof onShogoLockEnd==='function') onShogoLockEnd();
    }
  }catch(_){}
}
async function initShogoLockWatch(){
  try{
    const st=await fetch('/api/shogo-status').then(x=>x.json());
    if(st.running) setShogoLock(true,'照合が実行中です…完了までお待ちください');
  }catch(_){}
}
`;

module.exports = { SHOGO_LOCK_CSS, SHOGO_LOCK_HTML, SHOGO_LOCK_JS };
