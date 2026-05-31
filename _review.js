// 一時: 要確認候補(60-79%の名前一致)を仕入先別・自社商品別に集約して表示（検証後に削除）
const http = require('http');
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host:'127.0.0.1', port:8765, path, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':data.length}},
      r=>{let d='';r.setEncoding('utf8');r.on('data',c=>d+=c);r.on('end',()=>resolve(d));});
    req.on('error',reject); req.write(data); req.end();
  });
}
function get(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:8765,path},r=>{let d='';r.setEncoding('utf8');r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});}
const score = st => { if(/手動/.test(st))return 2000; if(/CD一致/.test(st))return 1000; const m=st.match(/(\d+)\s*%/); return m?Number(m[1]):0; };
(async()=>{
  const files=JSON.parse(await get('/api/files')).files;
  for(const f of files){
    const j=JSON.parse(await post('/api/calc',{file:f}));
    const rows=j.rows||[];
    // 要確認 = matched かつ 60<=%<80（CD一致/手動/100%は対象外、休眠も対象外）
    const review=rows.filter(r=>{const s=score(r.matchStatus||'');return s>=60&&s<80;});
    if(!review.length){console.log('\n=== '+f.split('_')[0]+' : 要確認 0 件 ===');continue;}
    // 自社商品コードで集約（同一商品が複数得意先で要確認になるので1つに）
    const byProd=new Map();
    for(const r of review){
      const k=r.productCode||('名:'+r.productName);
      if(!byProd.has(k))byProd.set(k,{self:r.productNameCore||r.productName,code:r.productCode,maker:r.makerName,st:r.matchStatus,custs:new Set()});
      byProd.get(k).custs.add(r.customerName);
    }
    console.log('\n=== '+f.split('_')[0]+' : 要確認 '+byProd.size+' 品（得意先延べ'+review.length+'行） ===');
    [...byProd.values()].sort((a,b)=>score(b.st)-score(a.st)).forEach(p=>{
      console.log('  ['+(p.code||'?')+'] '+(p.self||'').slice(0,28).padEnd(28)+' '+p.st.padEnd(14)+' ← '+(p.maker||'').slice(0,30)+'  ('+p.custs.size+'社)');
    });
  }
})();
