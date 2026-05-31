// 一時: 中央化学のﾀﾚﾋﾞﾝ/ﾀﾚ壜 自社品ごとに全マッチ(得意先別)を一覧（検証後削除）
const http=require('http');
function post(p,b){return new Promise((res,rej)=>{const d=Buffer.from(JSON.stringify(b),'utf8');const q=http.request({host:'127.0.0.1',port:8765,path:p,method:'POST',headers:{'Content-Type':'application/json','Content-Length':d.length}},r=>{let s='';r.setEncoding('utf8');r.on('data',c=>s+=c);r.on('end',()=>res(s));});q.on('error',rej);q.write(d);q.end();});}
(async()=>{
  const j=JSON.parse(await post('/api/calc',{file:'中央化学_照合結果_20260528_145538.csv'}));
  const rows=(j.rows||[]).filter(r=>/ﾀﾚ|タレ|たれ/.test((r.productNameCore||r.productName||'')));
  // 自社品ごと: 出た matchStatus と maker の組合せをユニーク化
  const m=new Map();
  for(const r of rows){
    const k=(r.productCode||'?')+' '+(r.productNameCore||r.productName||'').slice(0,18);
    if(!m.has(k))m.set(k,new Map());
    const sub=m.get(k); const sk=(r.matchStatus||'')+' <- '+(r.makerName||'');
    sub.set(sk,(sub.get(sk)||0)+1);
  }
  for(const [k,sub] of m){
    console.log('\n['+k+']');
    for(const [sk,n] of sub) console.log('   '+sk+'   ('+n+'社)');
  }
})();
