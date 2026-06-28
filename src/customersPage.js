// =====================================================================
//  得意先別 商品 一覧ページ（/customers で表示）
//   全仕入先の最新照合結果を横断集計し、得意先ごとに「買う全商品」を
//   （複数メーカーまたがりで）1画面で確認できる逆引きビュー。
//   データは GET /api/customers（server.js: aggregateCustomers）から取得。
//   価格は sim/見積書と同じ既定で算出（出力前の総ざらい用）。
// =====================================================================
const { SHOGO_LOCK_CSS, SHOGO_LOCK_HTML, SHOGO_LOCK_JS } = require('./shogoLockUi');
const { navLinks } = require('./navUi');
const CUSTOMERS_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>得意先別 商品一覧</title>
<style>
  body{margin:0;font-family:"メイリオ","Meiryo","Segoe UI",sans-serif;background:#f4f6f9;color:#1f2733;font-size:13px}
  header{background:#1f4e78;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  header h1{font-size:16px;margin:0}
  header .sub{color:#cfe0f0;font-size:12px}
  header a{color:#cfe0f0;font-size:12px;text-decoration:none;background:rgba(255,255,255,.08);padding:5px 10px;border-radius:6px}
  header a:hover{background:rgba(255,255,255,.18)}
  header .spacer{margin-left:auto}
  .wrap{display:flex;gap:0;align-items:stretch;min-height:calc(100vh - 110px)}
  .col-list{width:300px;flex:0 0 300px;border-right:1px solid #e2e6ec;background:#fff;overflow:auto;max-height:calc(100vh - 110px)}
  .col-detail{flex:1;overflow:auto;max-height:calc(100vh - 110px)}
  .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border-bottom:1px solid #e2e6ec;padding:10px 16px}
  button.go{background:#1f4e78;color:#fff;border:none;border-radius:8px;padding:7px 13px;font-weight:700;cursor:pointer}
  button.go:disabled{opacity:.5;cursor:not-allowed}
  #search{padding:7px 10px;border:1px solid #c7d6e4;border-radius:8px;font-size:13px;width:200px}
  /* 得意先一覧カラムの上部に固定する検索バー（一覧の見出し「実施日を超過」のすぐ上＝名前一覧の直上） */
  .listsearchbar{position:sticky;top:0;z-index:3;background:#fff;padding:8px;border-bottom:1px solid #e2e6ec}
  .listsearchbar #search{width:100%;box-sizing:border-box}
  /* 計算カスタマイズ バー（メインページと同じ項目） */
  .calcbar{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;background:#f7fafd;border-bottom:1px solid #e2e6ec;padding:10px 16px}
  .calcbar .fld{display:flex;flex-direction:column;gap:3px}
  .calcbar label{font-size:11px;color:#5a6b7a;font-weight:700}
  .calcbar label .h{font-weight:400;color:#9aa6b2}
  .calcbar select,.calcbar input{padding:6px 8px;border:1px solid #c7d6e4;border-radius:7px;font-size:13px;background:#fff}
  .calcbar input.num{width:96px;text-align:right}
  .calcbar input.eff{width:140px}
  .calcbar .recalc{background:#1f4e78;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
  .calcbar .applied{font-size:11px;color:#6b7785}
  .calcbar .sep{width:1px;align-self:stretch;background:#dde5ee;margin:2px 2px}
  /* 案B：性質ごとに「価格の決め方／まるめ／警告・実施日」をグループ化して見やすく */
  .calcgrp{display:flex;flex-direction:column;gap:6px}
  .calcgrp .grp-h{font-size:10px;font-weight:800;color:#8fa0b1;letter-spacing:.04em;border-bottom:1px solid #e4eaf1;padding:0 2px 3px}
  .calcgrp .grp-body{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
  /* 見積書 出力バー */
  .exportbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#eef4fb;border-bottom:1px solid #d6e1ee;padding:9px 16px}
  .exportbar .exp{background:#1b6b3a;color:#fff;border:none;border-radius:8px;padding:8px 15px;font-weight:700;cursor:pointer;font-size:13px}
  .exportbar .exp:disabled{opacity:.45;cursor:not-allowed}
  .exportbar .exp:hover:not(:disabled){filter:brightness(1.08)}
  /* 「○○だけ作成」＝選択中得意先の本番発行（緑の .exportbar .exp と別クラスで確実に赤表示） */
  #exportOneBtn.issue-one-btn,#bulkTargetBar #exportOneBtn{background:#c62828 !important;color:#fff !important;border:2px solid #a31515 !important;border-radius:9px;padding:10px 20px;font-weight:800;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(198,40,40,.45);white-space:nowrap;filter:none !important}
  #exportOneBtn.issue-one-btn:hover:not(:disabled),#bulkTargetBar #exportOneBtn:hover:not(:disabled){background:#b71c1c !important;border-color:#8e0000 !important;box-shadow:0 3px 10px rgba(183,28,28,.5)}
  #exportOneBtn.issue-one-btn:disabled,#bulkTargetBar #exportOneBtn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
  .exportbar .exphint{font-size:11px;color:#5a6b7a}
  #exportResult{margin:10px 16px 0}
  .ok-banner{background:#eef7ef;border:1px solid #bfe0c4;color:#1f6b35;border-radius:10px;padding:10px 14px;font-size:13px}
  .ok-banner .mini,.ok-banner button{background:#fff;border:1px solid #9fcbab;color:#1f6b35;border-radius:7px;padding:3px 10px;font-weight:700;cursor:pointer;font-size:12px;margin-left:8px}
  .err-banner{background:#fdecea;border:1px solid #f5b7b1;color:#922b21;border-radius:10px;padding:10px 14px;font-size:13px}
  /* 発行前 確認ゲート モーダル */
  .gate-overlay{position:fixed;inset:0;background:rgba(15,25,40,.5);display:none;align-items:center;justify-content:center;z-index:60;padding:20px}
  .gate-overlay.show{display:flex}
  .gate{background:#fff;border-radius:14px;width:100%;max-width:1000px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.3)}
  .gate-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #e6ecf2}
  .gate-head h2{margin:0;font-size:17px;color:#a01b10}
  .gate-x{margin-left:auto;background:#fff;border:1px solid #cdd7e1;border-radius:8px;width:30px;height:30px;font-size:18px;cursor:pointer;color:#5a6b7a}
  .gate-note{padding:12px 18px;font-size:12.5px;color:#5a3c00;background:#fff7e6;border-bottom:1px solid #f0d9a8}
  .gate-table-wrap{overflow:auto;flex:1;padding:0 6px}
  .gate-table-wrap table{width:100%;border-collapse:collapse;font-size:12.5px}
  .gate-table-wrap th{position:sticky;top:0;background:#f3f6fa;text-align:left;padding:6px 9px;border-bottom:1px solid #e2e6ec;z-index:1}
  .gate-table-wrap td{padding:6px 9px;border-bottom:1px solid #eef1f5;vertical-align:top}
  .gate-table-wrap tr.price td{background:#fdf3f2}
  .gate-table-wrap tr.match td{background:#fffaf0}
  .gate-table-wrap th.num,.gate-table-wrap td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  /* 発行プレビュー：得意先ごとのセクション */
  .pv-cust{margin:0 0 14px}
  .pv-cust .pv-head{position:sticky;top:0;background:#1f4e78;color:#fff;font-weight:700;padding:6px 10px;border-radius:6px 6px 0 0;z-index:2}
  .pv-cust .pv-cnt{font-weight:400;color:#cfe0f0;font-size:11px;margin-left:6px}
  .pv-cust table th{position:static;background:#eef2f7}
  .pv-sec-rev{margin:18px 0 6px;font-weight:700;color:#a01b10;border-top:2px solid #f0c6c2;padding-top:10px}
  .gate-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #e6ecf2}
  .gate-foot .go{background:#1b6b3a;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
  /* 提出済み見積一覧モーダル */
  .issued-list-gate{max-width:980px}
  .issued-list-gate .gate-head h2{color:#1f6b35}
  .issued-list-folders{margin:0 18px 8px;padding:8px 10px;background:#e8f5ec;border:1px solid #bfe0c4;border-radius:8px;font-size:12.5px;line-height:1.6}
  .issued-list-folders .foldbtn{background:#fff;border:1px solid #9fcbab;color:#1f6b35;border-radius:7px;padding:3px 10px;font-weight:700;cursor:pointer;font-size:12px;margin:2px 4px 2px 0}
  .issued-list-search{margin:0 18px 8px;padding:7px 10px;border:1px solid #c7d6e4;border-radius:8px;width:calc(100% - 36px);font-size:13px;box-sizing:border-box}
  .issued-list-gate .actbtn{font-size:12px;padding:4px 9px;margin-right:4px;border-radius:7px;cursor:pointer;font-weight:700}
  .issued-list-gate .actbtn.go{background:#1b6b3a;color:#fff;border:none}
  .issued-list-gate .actbtn.ghost{background:#fff;border:1px solid #cdd7e1;color:#3d4f63}
  #issuedListBtn{background:#1f6b35;color:#fff;border:none;border-radius:8px;padding:7px 12px;font-weight:700;cursor:pointer;font-size:13px}
  #issuedListBtn:hover{background:#165a2b}
  #manualListBtn{background:#5a4a8a;color:#fff;border:none;border-radius:8px;padding:7px 12px;font-weight:700;cursor:pointer;font-size:13px}
  #manualListBtn:hover{background:#4a3d72}
  .manual-list-gate{max-width:1100px}
  .manual-list-gate .gate-head h2{color:#5a4a8a}
  .manual-list-note{margin:0 18px 10px;font-size:12.5px;color:#5a4a8a;line-height:1.55}
  #manualCsvLink{background:#fff;border:1px solid #b8a8d8;color:#5a4a8a;border-radius:8px;padding:9px 16px;font-weight:700}
  .gate-foot .go:disabled{opacity:.45;cursor:not-allowed}
  .gate-foot .ghost{background:#fff;border:1px solid #c7d6e4;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer;color:#33485c}
  .cust{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid #eef1f5;cursor:pointer}
  .cust:hover{background:#f0f6fd}
  .cust.sel{background:#e3f0fb}
  .cust .nm{font-weight:700;color:#1f2733;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cust .meta{font-size:11px;color:#6b7785;margin-top:2px}
  .cust .cnt{flex:0 0 auto;background:#1f4e78;color:#fff;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700}
  .cust .rev{color:#c0392b;font-size:11px;font-weight:700;margin-left:6px}
  .cust .ccode{display:inline-block;background:#eef2f7;color:#41526b;border-radius:4px;padding:0 5px;font-size:10px;font-weight:700;margin-right:5px;font-family:monospace}
  .cust .nrec{color:#9aa6b2;font-size:11px;font-weight:700;margin-left:6px}
  .listnote{font-size:11px;color:#8a6d3b;background:#fbf6e7;border:1px solid #ecdba8;border-radius:6px;padding:5px 8px;margin:0 0 8px}
  table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}
  th,td{border:1px solid #e2e6ec;padding:6px 9px;vertical-align:middle}
  th{background:#eef2f7;text-align:left;white-space:nowrap;position:sticky;top:0;z-index:1}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  td.pcode{font-family:Consolas,'Courier New',monospace;color:#444;white-space:nowrap}
  td.up{color:#c0392b;font-weight:700}
  td.down{color:#2a6fb0;font-weight:700}
  td.rate{font-weight:700}
  th.grp{background:#e7eef6;text-align:center}
  .sup-badge{display:inline-block;background:#eaf1f8;color:#1f4e78;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:700;white-space:nowrap}
  a.prodlink{color:#1565c0;text-decoration:none;border-bottom:1px dotted #90b4d8}
  a.prodlink:hover{color:#0d47a1;border-bottom-style:solid;background:#eaf3fb}
  /* 一覧を畳むと右の明細が全幅に */
  .wrap.list-collapsed .col-list{display:none}
  /* 低マージン（改定後粗利率がしきい値未満）の強調 */
  td.lowmargin{background:#fdeccb !important;color:#9a5b00;font-weight:700}
  .cust .lowm{color:#b8860b;font-size:11px;font-weight:700;margin-left:6px}
  /* 提出済みバッジ（得意先一覧・ヘッダー） */
  .cust .issued{display:inline-block;background:#e1f3df;color:#1f6b35;border:1px solid #bfe0c4;border-radius:999px;font-size:10px;font-weight:700;padding:0 6px;margin-left:6px}
  .cust.done{background:#f5fbf6}
  /* 実施日バッジ（並び替えの根拠を見える化）＝超過は赤・控えは青 */
  .cust .effb{display:inline-block;border-radius:999px;font-size:10px;font-weight:700;padding:0 6px;margin-left:6px;white-space:nowrap}
  .cust .effb.over{background:#fdecea;color:#c0392b;border:1px solid #f2b8b1}
  .cust .effb.soon{background:#eef4fb;color:#1f5fa6;border:1px solid #c6d8ef}
  /* 一覧のグループ区切り見出し（実施日 超過／控え／なし・提出済） */
  .listgrp{position:sticky;top:0;z-index:1;background:#eef1f5;color:#33425a;font-size:11px;font-weight:700;padding:5px 12px;border-top:1px solid #d8dee7;border-bottom:1px solid #d8dee7}
  .listgrp.over{background:#fdecea;color:#a5311f;border-color:#f2b8b1}
  .listgrp.soon{background:#eef4fb;color:#1f5fa6;border-color:#c6d8ef}
  .issuednote{margin:8px 16px;padding:8px 12px;border-radius:8px;background:#eef7ef;border:1px solid #bfe0c4;color:#1f6b35;font-size:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .issuednote .un{background:#fff;border:1px solid #9fcbab;color:#1f6b35;border-radius:7px;padding:2px 9px;font-weight:700;cursor:pointer;font-size:11px}
  .issuednote .openq{background:#1f6b35;border:1px solid #1f6b35;color:#fff;border-radius:7px;padding:2px 10px;font-weight:700;cursor:pointer;font-size:11px}
  .issuednote .openq:hover{background:#175a2b}
  .notyet{margin:8px 16px;padding:6px 12px;border-radius:8px;background:#f4f6f9;border:1px solid #e2e6ec;color:#6b7785;font-size:12px}
  /* 手動修正タグ（得意先一覧）／検討中タグ／アイテム状態ボタン／別枠セクション */
  .cust .holdm{color:#8a5a12;font-size:11px;font-weight:700;margin-left:6px}
  .cust .dormantm{color:#3a6ea5;font-size:11px;font-weight:700;margin-left:6px}
  .cust .manualm{color:#5a4a8a;font-size:11px;font-weight:700;margin-left:6px}
  td.actcell{white-space:nowrap}
  /* チェックボックス一括移動バー */
  .bulkbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0;padding:6px 10px;background:#f4f7fb;border:1px solid #d8e0ea;border-radius:8px}
  .bulkbar .bulkinfo{font-size:12px;color:#1f4e78;font-weight:700}
  .bulkbtn{border:none;border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer}
  .bulkbtn:disabled{opacity:.45;cursor:default}
  .bulkbtn.hold{background:#f5e6c8;color:#6b4a0a}
  .bulkbtn.hold:not(:disabled):hover{background:#edd9b0}
  .bulkbtn.dormant{background:#cfe0f3;color:#1f4e78}
  .bulkbtn.dormant:not(:disabled):hover{background:#bcd4ec}
  .bulkbtn.manual{background:#d4c8f0;color:#3d2f66}
  .bulkbtn.manual:not(:disabled):hover{background:#c4b4e8}
  .bulkbtn.back{background:#1f6b35;color:#fff}
  .bulkbtn.back:not(:disabled):hover{background:#175a2b}
  label.selall{font-size:11px;color:#6b7785;font-weight:400;white-space:nowrap;cursor:pointer}
  input.selchk-target,input.selchk-hold,input.selchk-dormant,input.selchk-manual,input.selchk-issued{cursor:pointer;vertical-align:middle}
  /* 行ルール（ラジオボタン） */
  td.rrcell{min-width:190px}
  .rrradios{display:flex;flex-wrap:wrap;gap:1px 8px;align-items:center}
  .rrradios label.rr{font-size:11px;color:#33405a;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;gap:2px;padding:1px 0}
  .rrradios input[type=radio]{margin:0;cursor:pointer}
  .rrradios.ov{background:#eafaef;border-radius:6px;padding:2px 4px}
  .calcbar .round-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .calcbar .round-radios{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:center}
  .calcbar .round-radios label{font-size:12px;color:#33405a;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;gap:3px;font-weight:400}
  .calcbar .round-radios input{margin:0;cursor:pointer}
  .calcbar #cRoundMode{padding:6px 8px;border:1px solid #c7d6e4;border-radius:7px;font-size:13px;background:#fff}
  .rowround-wrap.ov{background:#eafaef;border-radius:6px;padding:2px 4px}
  select.rowround-mode{font-size:11px;padding:2px 4px;border:1px solid #c7d6e4;border-radius:5px}
  input.rowfactor{vertical-align:middle}
  button.hold-btn{background:#fff;border:1px solid #d4a84a;color:#8a5a12;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer}
  button.hold-btn:hover{background:#fff8eb}
  button.dormant-btn{background:#fff;border:1px solid #8fb4dd;color:#1f4e78;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer}
  button.dormant-btn:hover{background:#eef5fc}
  button.manual-btn{background:#fff;border:1px solid #b8a8d8;color:#5a4a8a;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer}
  button.manual-btn:hover{background:#f3effa}
  button.back-btn{background:#fff;border:1px solid #9fcbab;color:#1f6b35;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer}
  button.back-btn:hover{background:#f0faf2}
  details.itemsec{margin:10px 16px;border-radius:8px;border:1px solid #e2e6ec;overflow:hidden}
  details.itemsec>summary{cursor:pointer;padding:8px 12px;font-size:13px;font-weight:700;user-select:none}
  details.sec-hold{border-color:#e8d4a8}
  details.sec-hold>summary{background:#fff8eb;color:#8a5a12}
  details.sec-dormant{border-color:#bcd4ec}
  details.sec-dormant>summary{background:#eef5fc;color:#1f4e78}
  details.sec-manual{border-color:#d4c8f0}
  details.sec-manual>summary{background:#f3effa;color:#5a4a8a}
  details.sec-issued{border-color:#bfe0c4}
  details.sec-issued>summary{background:#eef7ef;color:#1f6b35}
  details.itemsec .table-pad{padding:0 0 6px}
  details.itemsec table{font-size:12px}
  .lowmnote{margin:8px 16px;padding:8px 12px;border-radius:8px;background:#fff4d6;border:1px solid #f0d49a;color:#8a5a12;font-size:12px}
  .detail-head{padding:12px 16px 4px}
  .detail-head h2{margin:0;font-size:18px;color:#1f4e78}
  .detail-head .sum{color:#6b7785;font-size:12px;margin-top:4px}
  .muted{color:#6b7785;font-size:11px}
  .empty{padding:30px;text-align:center;color:#6b7785}
  .revnote{margin:8px 16px;padding:8px 12px;border-radius:8px;background:#fdecea;border:1px solid #f5b7b1;color:#922b21;font-size:12px}
  .table-pad{padding:0 16px 24px}
  details.itemsec .table-pad{overflow-x:auto}
  /* 対象商品一覧：一括バー＋表ヘッダーを縦スクロール時も固定（.col-detail がスクロール容器） */
  .col-detail #bulkTargetBar{position:sticky;top:0;z-index:12;margin:8px 16px 0;padding:8px 10px;background:#f4f7fb;border:1px solid #d8e0ea;border-radius:8px 8px 0 0;box-shadow:0 2px 8px rgba(31,39,51,.1)}
  .col-detail #custMainTbl thead th{position:sticky;top:var(--cust-sticky-bulk,48px);z-index:11;background:#eef2f7;box-shadow:0 1px 0 #e2e6ec}
  /* 商品一覧：コンパクト表（転嫁確認向け・新を大きく現は括弧） */
  table.cust-compact{width:100%;min-width:1020px;table-layout:fixed;font-size:12px}
  table.cust-compact.cust-smart td{line-height:1.45}
  table.cust-compact th{font-size:11px;line-height:1.35;padding:5px 6px;white-space:normal;text-align:center}
  table.cust-compact th.col-prod,table.cust-compact th.col-meta{text-align:left}
  table.cust-compact td{padding:5px 6px;vertical-align:middle}
  table.cust-compact .col-act{width:52px}
  table.cust-compact .col-prod{width:112px;max-width:112px}
  table.cust-compact .col-cost{width:72px}
  table.cust-compact .col-chg{width:50px}
  table.cust-compact .col-sell{width:142px}
  table.cust-compact .col-schg{width:64px}
  table.cust-compact .col-rulemeta{width:108px}
  table.cust-compact .col-meta{width:172px;min-width:172px}
  table.cust-compact td.col-prod,table.cust-compact th.col-prod{white-space:normal;word-break:break-word;overflow-wrap:anywhere}
  table.cust-compact td.col-meta,table.cust-compact th.col-meta{white-space:normal}
  table.cust-compact .prodcell{max-width:112px}
  table.cust-compact .prodname{font-size:12px;line-height:1.45;word-break:break-word;overflow-wrap:anywhere;white-space:normal}
  table.cust-compact .prodname a{word-break:break-word;overflow-wrap:anywhere}
  table.cust-compact .subline{color:#6b7785;font-size:11px;margin-top:2px;line-height:1.35;word-break:break-all}
  .xquote-btn{display:inline-block;margin-top:3px;padding:1px 6px;font-size:10px;line-height:1.5;color:#345;background:#eef3fb;border:1px solid #c7d6ea;border-radius:10px;cursor:pointer;white-space:nowrap}
  .xquote-btn:hover{background:#dbe7f8;border-color:#9fb9dd}
  .xq-gate{max-width:560px;width:96%}
  .xq-stats{display:flex;gap:14px;flex-wrap:wrap;margin:2px 0 10px;font-size:13px;color:#33414f}
  .xq-stats b{font-size:15px;color:#1f6feb}
  table.xq-table{width:100%;border-collapse:collapse;font-size:13px}
  table.xq-table th,table.xq-table td{border-bottom:1px solid #e6ebf1;padding:6px 8px;text-align:left}
  table.xq-table td.num,table.xq-table th.num{text-align:right;font-variant-numeric:tabular-nums}
  table.xq-table tbody tr:hover{background:#f6f9fe}
  .xq-empty{padding:16px;text-align:center;color:#6b7785}
  table.cust-compact .subline.lastsale{color:#41526b;font-weight:700;white-space:nowrap;word-break:keep-all}
  table.cust-compact .pcode{font-family:Consolas,'Courier New',monospace;font-size:10px;color:#6b7785}
  table.cust-compact .paren{color:#9aa6b2;font-size:11px;font-weight:400}
  table.cust-compact .main-num{font-weight:700;font-variant-numeric:tabular-nums}
  table.cust-compact .cost-block,.table.cust-compact .sell-block{text-align:right;line-height:1.4}
  table.cust-compact .cost-cur,.table.cust-compact .sell-cur{font-size:10px;color:#9aa6b2;margin-top:2px}
  table.cust-compact td.col-sell{text-align:right}
  table.cust-compact .sell-new{display:flex;align-items:center;justify-content:flex-end;gap:3px;flex-wrap:nowrap;white-space:nowrap}
  table.cust-compact .sell-new .sellinp{width:64px;min-width:64px;max-width:64px;flex:0 0 64px;padding:2px 4px;font-size:12px}
  table.cust-compact .sell-sep{color:#9aa6b2;font-weight:400;flex:0 0 auto}
  table.cust-compact .sell-marg{font-weight:700;font-size:11px;color:#41526b;white-space:nowrap;flex:0 0 auto}
  table.cust-compact .schg-block{text-align:center;line-height:1.35}
  table.cust-compact .schg-badge{margin-top:2px}
  table.cust-compact .schg-badge .pass-ok,.table.cust-compact .schg-badge .pass-warn{margin-left:0}
  table.cust-compact .chg-val{font-weight:800;font-size:13px;color:#c0392b}
  table.cust-compact .chg-val.down{color:#1f6b35}
  table.cust-compact .marg.lowmargin{background:#fdeccb;color:#9a5b00;font-weight:700;padding:1px 4px;border-radius:4px}
  table.cust-compact .sell-marg.lowmargin{background:#fdeccb;color:#9a5b00;padding:1px 4px;border-radius:4px}
  table.cust-compact .pass-ok{display:inline-block;background:#eef7ef;color:#1f6b35;border:1px solid #bfe0c4;border-radius:4px;font-size:10px;padding:0 5px;font-weight:700;white-space:nowrap}
  table.cust-compact .pass-warn{display:inline-block;background:#fdeccb;color:#9a5b00;border:1px solid #f0d49a;border-radius:4px;font-size:10px;padding:0 5px;font-weight:700;white-space:nowrap}
  table.cust-compact .ruleline{margin-bottom:3px}
  table.cust-compact .roundline select.rowround-sel{max-width:100%}
  .datenote .effinp{width:100%;min-width:0;box-sizing:border-box;margin-bottom:4px;font-size:12px}
  .datenote .noteinp{width:100%;min-width:0;box-sizing:border-box;font-size:12px}
  select.rowround-sel{width:100%;max-width:108px;font-size:11px;padding:2px 3px;border:1px solid #c7d6e4;border-radius:5px;background:#fff}
  select.rowround-sel.ov{border-color:#1b6b3a;background:#eef7ef;font-weight:700;color:#1b6b3a}
  .pending-note{margin:0 16px 6px;padding:6px 10px;border-radius:8px;background:#fff8e6;border:1px solid #f0d49a;color:#8a5a12;font-size:12px;display:none}
  select.rowrule{padding:3px 5px;border:1px solid #c7d6e4;border-radius:6px;font-size:12px;background:#fff;max-width:100%}
  select.rowrule.ov{border-color:#1b6b3a;background:#eef7ef;font-weight:700;color:#1b6b3a}
  input.cellinp{border:1px solid #c7d6e4;border-radius:6px;font-size:12px;padding:3px 5px}
  input.sellinp{width:84px;text-align:right;font-variant-numeric:tabular-nums}
  input.effinp{width:108px;text-align:left}
  input.noteinp{width:180px;text-align:left}
  table.cust-compact .datenote input.effinp,table.cust-compact .datenote input.noteinp{width:100%;min-width:0}
  input.cellinp.man{border-color:#1b6b3a;background:#eef7ef;font-weight:700;color:#1b6b3a}
  input.effinp.effmissing{border-color:#c0392b;background:#fdecea}
  .effnote{margin:8px 16px;padding:8px 12px;border-radius:8px;background:#fdecea;border:1px solid #f5b7b1;color:#922b21;font-size:12px;font-weight:700}
${SHOGO_LOCK_CSS}
</style></head><body>
${SHOGO_LOCK_HTML}
<header>
  <h1>👥 得意先別 商品一覧</h1>
  <span class="sub">得意先を選ぶと、その得意先が買う全商品（複数メーカーまたがり）を表示</span>
  <span class="spacer"></span>
  ${navLinks('customers')}
</header>

<div class="toolbar">
  <button class="go" id="toggleListBtn" style="background:#5b6b8b" title="左の得意先一覧を隠して、右の明細を広く使えます（もう一度押すと表示）">◀ 一覧を隠す</button>
  <button class="go" id="reloadBtn">🔄 最新の状態を読み込む</button>
  <label style="font-size:12px;color:#5a6b7d;display:flex;align-items:center;gap:4px;white-space:nowrap" title="見積の対象にする得意先を、この期間に取引のある先だけに絞ります（最終売上日で判定）。照合は全期間で拾うので、ここで『見積に出す期間』を決められます。選んだ期間はこのPCに記憶されます。"><span>抽出期間</span>
    <select id="recentYears" style="padding:5px 8px;border:1px solid #c7d6e4;border-radius:8px;font-size:13px">
      <option value="1">過去1年（取引あり）</option>
      <option value="2">過去2年</option>
      <option value="3">過去3年</option>
      <option value="0">全期間（過去客も）</option>
    </select></label>
  <span id="msg" class="muted"></span>
  <span class="spacer" style="margin-left:auto"></span>
  <button type="button" id="manualListBtn" title="照合できず手動で直した品の一覧・CSV出力">📝 手動で修正一覧</button>
  <button type="button" id="issuedListBtn" title="提出済みの見積書を一覧で見る">📋 提出済一覧</button>
  <span id="issuedStat" class="muted" title="見積書を提出（発行）済みの得意先数">提出済 0</span>
  <button class="go" id="resetIssuedBtn" style="background:#8a6d3b" title="提出済みマークをすべて消します（新しい改定サイクルの開始時に使用）。見積書ファイルは消えません">提出履歴をリセット</button>
</div>

<div id="calcbarHome" style="display:none"><div class="calcbar" id="calcbar">
  <div class="calcgrp">
    <div class="grp-h">価格の決め方</div>
    <div class="grp-body">
      <div class="fld" id="cRuleFld"><label>転嫁ルール（全体）<span class="h">既定の上書き</span></label>
        <select id="cRule">
          <option value="add_increase">値上げ分を上乗せ（利益額キープ）</option>
          <option value="keep_margin_rate">現在の粗利率を維持</option>
          <option value="target_margin_rate">目標粗利率で逆算（新原価ベース）</option>
          <option value="markup">現売価 × 掛率</option>
          <option value="sell_cost_rate">現売価 × 仕入改定%（仕入と同率で値上げ＝粗利率維持と同結果）</option>
          <option value="keep_sell">据え置き（値上げしない）</option>
        </select></div>
      <div class="fld" id="cFactorBox" style="display:none"><label>掛率</label>
        <input id="cFactor" class="num" type="number" step="0.01" value="1.25"></div>
      <div class="fld" id="cMarginBox" style="display:none"><label>目標粗利率% <span class="h">新売価=新原価÷(1−率)</span></label>
        <input id="cMargin" class="num" type="number" step="0.1" value="30"></div>
      <div class="fld"><label>自社コスト上乗せ% <span class="h">労務費等</span></label>
        <input id="cUplift" class="num" type="number" step="0.1" value="0"></div>
    </div>
  </div>
  <div class="sep"></div>
  <div class="calcgrp">
    <div class="grp-h">まるめ</div>
    <div class="grp-body">
      <div class="fld"><label>改定後価格 <span class="h">変更後は再計算</span></label>
        <input type="hidden" id="cPolicyRoundMode" value="round">
        <div class="round-row">
          <div class="round-radios" id="cRoundUnitBox">
            <label><input type="radio" name="cRoundUnit" value="1"> 整数</label>
            <label><input type="radio" name="cRoundUnit" value="0.1"> 0.1</label>
            <label><input type="radio" name="cRoundUnit" value="0.01" checked> 0.01</label>
          </div>
          <select id="cRoundMode" title="「全体」＝⚙設定の端数処理に従う">
            <option value="">全体（⚙設定）</option>
            <option value="floor">切捨て</option>
            <option value="round">四捨五入</option>
            <option value="ceil">切上げ</option>
          </select>
        </div></div>
    </div>
  </div>
  <div class="sep"></div>
  <div class="calcgrp">
    <div class="grp-h">警告・実施日</div>
    <div class="grp-body">
      <div class="fld"><label>低マージン警告 <span class="h">改定後粗利率</span></label>
        <div style="display:flex;align-items:center;gap:4px"><input id="cLowMargin" type="number" step="1" value="15" style="width:62px;padding:6px 8px;border:1px solid #c7d6e4;border-radius:7px;font-size:13px;text-align:right"><span style="font-size:12px;color:#5a6b7a">% 未満で警告</span></div></div>
      <div class="fld"><label>実施日 一括 <span class="h">空=各行の切替日</span></label>
        <input id="cEff" class="eff" type="text" placeholder="例: 2026-07-01"></div>
    </div>
  </div>
  <div class="sep"></div>
  <div class="calcgrp">
    <div class="grp-h">&nbsp;</div>
    <div class="grp-body">
      <button class="recalc" id="recalcBtn">この設定で再計算</button>
      <button class="recalc" id="reloadPolicyBtn" style="background:#5b6b8b" title="メインで保存した『全体方針』を取り込んで、全体の各設定を初期値に戻します（行ごとの上書きは残ります）">↻ 全体方針を取込</button>
    </div>
  </div>
  <div class="fld" id="cBandFld" style="flex-basis:100%;min-width:100%;margin-top:2px">
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="cBandOn"> 💴 現売価で転嫁ルール・まるめを変える（価格帯別・全体反映）<span class="h" style="font-weight:400">ONにすると上の「転嫁ルール／掛率」の代わりに帯で決めます</span></label>
    <div id="bandBox" style="display:none;margin-top:5px;background:#f6f9fc;border:1px solid #d4e0ec;border-radius:8px;padding:8px"></div>
  </div>
  <span class="applied" id="appliedMsg" style="flex-basis:100%"></span>
</div></div>

<div class="exportbar">
  <button class="exp" id="exportAllBtn">📄 全得意先の見積書を作成</button>
  <span class="exphint">上の設定で、得意先ごと1枚（複数メーカー横断）の見積書を出力します。発行前に内容をプレビュー表示します（要確認は除外）。</span>
  <span id="exportMsg" class="muted"></span>
</div>
<!-- 「選択中の得意先だけ作成」ボタンは、得意先選択時に下の一括バー右端へ移動する（普段はここに退避）。 -->
<span id="exportOneHome" style="display:none"><button class="issue-one-btn" id="exportOneBtn" disabled>📄 選択中の得意先だけ作成</button></span>
<div id="exportResult" style="display:none"></div>

<div class="exportbar" id="hanbaiMoved" style="background:#f3f5f8;border-color:#d8dee6;color:#55606e;font-size:12.5px">
  📦 <b>基幹システム（販売大臣）への取込CSV</b>（単価履歴＝売価／仕入原価）は、
  <a href="/" style="color:#2f6fb0;font-weight:700">シミュレーション画面の「📅 実施日カレンダー」</a>
  に移動しました（実施日が来た分をその場でダウンロードできます）。
</div>

<div class="gate-overlay" id="gateOverlay">
  <div class="gate">
    <div class="gate-head">
      <h2 id="gateTitle">発行前の確認</h2>
      <button class="gate-x" id="gateClose" title="閉じる">×</button>
    </div>
    <div class="gate-note" id="gateNote"></div>
    <div class="gate-table-wrap" id="gateBody"></div>
    <div class="gate-foot">
      <span id="gateSummary" class="muted"></span>
      <span style="flex:1"></span>
      <button class="ghost" id="gateBack">戻る（修正する）</button>
      <button class="go" id="gateIssue">要確認を除外して発行</button>
    </div>
  </div>
</div>

<div class="gate-overlay" id="issuedListOverlay">
  <div class="gate issued-list-gate">
    <div class="gate-head">
      <h2>📋 提出済みの見積書一覧</h2>
      <button class="gate-x" id="issuedListClose" title="閉じる">×</button>
    </div>
    <div id="issuedListFolders" class="issued-list-folders"></div>
    <input id="issuedListSearch" class="issued-list-search" type="text" placeholder="得意先名で絞り込み…">
    <div class="gate-table-wrap" id="issuedListBody"></div>
    <div class="gate-foot">
      <span id="issuedListSummary" class="muted"></span>
      <span style="flex:1"></span>
      <button class="ghost" id="issuedListClose2">閉じる</button>
    </div>
  </div>
</div>

<div class="gate-overlay" id="manualListOverlay">
  <div class="gate manual-list-gate">
    <div class="gate-head">
      <h2>📝 手動で修正一覧</h2>
      <button class="gate-x" id="manualListClose" title="閉じる">×</button>
    </div>
    <p class="manual-list-note">照合できない品はツール外で手直しした記録です。得意先ページで「✏ 手動修正」に移した品がここに集まります。後から把握するためにCSVをダウンロードできます。</p>
    <input id="manualListSearch" class="issued-list-search" type="text" placeholder="得意先・商品名・仕入先で絞り込み…">
    <div class="gate-table-wrap" id="manualListBody"></div>
    <div class="gate-foot">
      <span id="manualListSummary" class="muted"></span>
      <span style="flex:1"></span>
      <a href="/api/manual-corrections.csv" id="manualCsvLink" download="手動修正一覧.csv">📥 CSVダウンロード</a>
      <button class="ghost" id="manualListClose2">閉じる</button>
    </div>
  </div>
</div>

<div class="gate-overlay" id="xqOverlay">
  <div class="gate xq-gate">
    <div class="gate-head">
      <h2 id="xqTitle">📋 他の得意先への見積価格</h2>
      <button class="gate-x" id="xqClose" title="閉じる">×</button>
    </div>
    <p class="muted" style="margin:2px 0 8px">この商品を <b>他の得意先</b> に提出（発行）済みの確定単価です。発行した見積だけが対象です。</p>
    <div id="xqStats" class="xq-stats"></div>
    <div class="gate-table-wrap" id="xqBody"></div>
    <div class="gate-foot">
      <span style="flex:1"></span>
      <button class="ghost" id="xqClose2">閉じる</button>
    </div>
  </div>
</div>

<div class="wrap">
  <div class="col-list">
    <div class="listsearchbar"><input id="search" type="text" placeholder="得意先を検索（名前・コード・カナ）…"></div>
    <div id="listCol"><div class="empty">読み込み中…</div></div>
  </div>
  <div class="col-detail" id="detailCol"><div class="empty">左の一覧から得意先を選んでください。</div></div>
</div>

<script>
${SHOGO_LOCK_JS}
function onShogoLockEnd(){
  $('#msg').textContent='';
  load(true);
}
const $=s=>document.querySelector(s);
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function escConfirm(s){return String(s==null?'':s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/\\r/g,'').replace(/\\n/g,'\\\\n');}
// 商品名を、メイン画面の該当照合行へ飛ぶリンクにする（新しいウィンドウ）。
//  メイン側は ?focusSupplier/Customer/Code/Name を読んで該当行へジャンプ＋強調する。
function prodLink(customer, supplier, code, name){
  const q='/?focusSupplier='+encodeURIComponent(supplier||'')
    +'&amp;focusCustomer='+encodeURIComponent(customer||'')
    +'&amp;focusCode='+encodeURIComponent(code||'')
    +'&amp;focusName='+encodeURIComponent(name||'');
  return '<a class="prodlink" href="'+q+'" rel="noopener" onclick="return openSimWindow(this.href)" title="メイン画面でこの商品の照合（一致度・メーカー品・現/改定後 仕入）を確認（新しいウィンドウ）">'+esc(name)+'</a>';
}
// 別タブではなく別ウィンドウで開く（window.open にサイズ指定を渡すとブラウザはタブでなくウィンドウにする）。
//  同じウィンドウ名を再利用＝クリックのたびに同じポップアップで内容が切り替わる（窓が増えない）。
function openSimWindow(href){
  const aw=(window.screen&&screen.availWidth)||1400, ah=(window.screen&&screen.availHeight)||900;
  const w=Math.min(aw,1500), h=Math.min(ah,1000);
  const left=Math.max(0,Math.round((aw-w)/2)), top=Math.max(0,Math.round((ah-h)/2));
  const win=window.open(href,'simfocus','width='+w+',height='+h+',left='+left+',top='+top+',resizable=yes,scrollbars=yes');
  if(win) win.focus();
  return false; // 既定のリンク遷移を止める
}
function yen(v){ return (v==null||isNaN(v))?'—':Number(v).toLocaleString('ja-JP',{maximumFractionDigits:2}); }
// 現→改定の改定率(%)。現単価>0 のときだけ算出。{txt, cls} を返す（値上げ=up赤/値下げ=down青）。
function pctChg(cur,neu){
  if(cur==null||neu==null||isNaN(cur)||isNaN(neu)||Number(cur)<=0) return {txt:'—',cls:''};
  const p=(Number(neu)/Number(cur)-1)*100;
  const cls = p>0.05?'rate up':(p<-0.05?'rate down':'rate');
  return {txt:(p>0?'+':'')+p.toFixed(1)+'%', cls};
}
let DATA=[];      // 得意先配列
let filtered=[];  // 検索後
let hiddenNoRecent=0; // 「取引のない先を隠す」で隠した件数（一覧上部に表示）
let selName=null; // 選択中の得意先名
let ISSUED={};    // 提出（発行）履歴 { 得意先名: {lastIssuedAt,count,quoteNo,itemCount,folder} }
let CUST_EMAILS={}; // 得意先別 送信先メール { 得意先名: メールアドレス }（見積PDFのOutlook送信用）
let rowRules={};  // 行ごと転嫁ルールの上書き { rowKey: ruleType }（空=全体ルール）
let rowSell={};   // 行ごと 改定後売価 の手入力 { rowKey: 入力文字列 }
let rowEff={};    // 行ごと 実施日 の手入力 { rowKey: 入力文字列 }
let rowNote={};   // 行ごと 備考 の手入力 { rowKey: 入力文字列 }（見積書の備考列に転記）
let rowRound={};  // 行ごと まるめ { rowKey: "単位|処理" 例 "0.01|floor"。空|空＝上の全体 }
let calcPending=false; // 行ルール・まるめ等の未反映変更（再計算または見積発行プレビューまでサーバへ送らない）
let lastApplied=null;  // 直近の再計算結果（備考入力時に appliedMsg だけ更新する用）
let rowFactor={}; // 行ごと 掛率（行ルール=掛率×のとき）{ rowKey: 数値 }（未設定=上の全体「掛率」を使う）
let lowMarginPct=15; // 低マージン警告のしきい値（%）。改定後粗利率がこの値未満なら警告。画面で調整可。
// 数値を表示用にクリーン化（¥・円・カンマ無し、最大2桁）。空/非数は''。
function numStr(v){ return (v==null||isNaN(v))?'':String(Math.round(Number(v)*100)/100); }
// 粗利率(%) = (売価-仕入)/売価 ×100。売価が無い/0なら null。
function marginRate(sell,cost){
  if(sell==null||cost==null||isNaN(sell)||isNaN(cost)||Number(sell)<=0) return null;
  return (Number(sell)-Number(cost))/Number(sell)*100;
}
function fmtPct1(v){ return v==null?'—':v.toFixed(1)+'%'; }
function isLowMargin(m){ return m!=null && m < lowMarginPct; }
// 得意先の「改定後粗利率がしきい値未満」の商品数
function lowMarginCount(c){ let n=0; for(const p of (c.products||[])){ if(isLowMargin(marginRate(p.newSell,p.newCost))) n++; } return n; }
// 対象アイテムのうち実施日が未設定（サーバが noEff を付与）の件数。発行には実施日が必須。
function effMissingCount(c){ let n=0; for(const p of (c.products||[])){ if(p.noEff) n++; } return n; }
// 実施日の手入力(rowEff)を反映した未設定件数（再計算前の画面上の警告用）。
function effMissingCountLive(c){
  let n=0;
  for(const p of (c.products||[])){
    const raw=rowEff[p.rowKey]!=null?String(rowEff[p.rowKey]):(p.effectiveDate||'');
    if(!isValidEffIso(normDateInputClient(raw))) n++;
  }
  return n;
}
function markCalcPending(){
  calcPending=true;
  const n=$('#pendingNote');
  if(n) n.style.display='';
}
function clearCalcPending(){
  calcPending=false;
  const n=$('#pendingNote');
  if(n) n.style.display='none';
}
// 改定率の数値（%）。現>0 のときだけ。比較用。
function pctNum(cur, neu){
  if(cur==null||neu==null||isNaN(cur)||isNaN(neu)||Number(cur)<=0) return null;
  return (Number(neu)/Number(cur)-1)*100;
}
// コンパクト表示用の改定率テキスト（+31 / +33.6 など）。
function chgPctShort(pct){
  if(pct==null||isNaN(pct)) return {txt:'—', cls:''};
  const abs=Math.abs(pct);
  const txt=(pct>0?'+':'')+(abs>=10?pct.toFixed(0):pct.toFixed(1));
  const cls=pct>0.05?'chg-val':(pct<-0.05?'chg-val down':'chg-val');
  return {txt, cls};
}
// 仕入改定率が売価改定率に十分乗っているかのバッジ。
function passTransferBadge(costPct, sellPct){
  if(costPct==null||sellPct==null) return '';
  const diff=sellPct-costPct;
  if(Math.abs(diff)<0.15&&Math.abs(costPct)>0.05) return '<span class="pass-ok">同率</span>';
  if(sellPct+0.05>=costPct) return '<span class="pass-ok">転嫁OK</span>';
  return '<span class="pass-warn">要確認</span>';
}
// 商品欄の最終売上日（この得意先へのこの商品の最終販売日）。DB直結時のみ値が入る。
//  値が無い（ファイル方式/未再照合）ときは何も出さない。
function lastSaleLine(p){
  const d=p&&p.lastDate?String(p.lastDate):'';
  if(!d) return '';
  return '<div class="subline lastsale" title="この得意先へのこの商品の最終売上日（販売大臣DB）">🗓 最終 '+esc(d)+'</div>';
}
function compactCostCell(cur, nw){
  const c=numStr(cur), n=numStr(nw);
  return '<td class="num col-cost"><div class="cost-block"><div class="main-num">'+(n||'—')+'</div>'
    +(c?'<div class="cost-cur">（'+c+'）</div>':'')+'</div></td>';
}
function compactChgCell(pct){
  const ch=chgPctShort(pct);
  if(ch.txt==='—') return '<td class="num col-chg"><span class="paren">—</span></td>';
  return '<td class="num col-chg"><span class="'+ch.cls+'">'+ch.txt+'</span><span class="paren">%</span></td>';
}
function compactSellCell(p, curM, newM, lowCls){
  const curSell=numStr(p.currentSell);
  const mCls=lowCls?' sell-marg lowmargin':' sell-marg';
  return '<td class="num col-sell"><div class="sell-block"><div class="sell-new">'
    +'<input class="cellinp sellinp'+(p.sellManual?' man':'')+'" data-key="'+esc(p.rowKey)+'" value="'+esc(numStr(p.newSell))+'" title="直接入力（¥・カンマ可）">'
    +'<span class="sell-sep">/</span><span class="'+mCls+'">'+fmtPct1(newM)+'</span></div>'
    +(curSell?'<div class="sell-cur">（'+curSell+' / '+fmtPct1(curM)+'）</div>':'')
    +'</div></td>';
}
function compactSellChgCell(costPct, sellPct){
  const ch=chgPctShort(sellPct);
  if(ch.txt==='—') return '<td class="num col-schg"><span class="paren">—</span></td>';
  const badge=passTransferBadge(costPct, sellPct);
  return '<td class="num col-schg"><div class="schg-block"><span class="'+ch.cls+'">'+ch.txt+'</span><span class="paren">%</span>'
    +(badge?'<div class="schg-badge">'+badge+'</div>':'')+'</div></td>';
}
// 別枠セクション（検討中／休眠／手動修正／提出済み）の表。kind: 'hold'|'dormant'|'manual'|'issued'
function sectionHtml(title, items, kind){
  if(!items || !items.length) return '';
  const open = (kind==='hold' || kind==='manual') ? ' open' : ''; // 検討中・手動修正は開く／休眠・提出済みは畳む
  const issuedTh = kind==='issued' ? '<th>提出</th>' : '';
  const noteTh = kind==='manual' ? '<th>備考</th>' : '';
  const hasChk = (kind==='hold' || kind==='dormant' || kind==='manual' || kind==='issued');
  const chkCls = 'selchk-'+kind;
  const chkTh = hasChk ? '<th><label class="selall"><input type="checkbox" id="selAll-'+kind+'"> 全</label></th>' : '';
  // 検討中⇄休眠 は対象に戻さず直接付け替えできる。per-row は既存の hold-btn/dormant-btn 配線をそのまま流用。
  const cross = kind==='hold'    ? { btnCls:'dormant-btn', label:'💤 休眠へ',   bulkId:'bulkCross-hold',    bulkCls:'dormant', bulkLabel:'💤 選択を休眠へ',   word:'休眠' }
              : kind==='dormant' ? { btnCls:'hold-btn',    label:'🤔 検討中へ', bulkId:'bulkCross-dormant', bulkCls:'hold',    bulkLabel:'🤔 選択を検討中へ', word:'検討中' }
              : null;
  let rows='';
  for(const p of items){
    const info = kind==='issued' ? (issuedShort(p.issuedAt)+(p.issuedQuoteNo?'（'+esc(p.issuedQuoteNo)+'）':'')) : '';
    const chkTd = hasChk ? '<td><input type="checkbox" class="'+chkCls+'" data-key="'+esc(p.rowKey)+'" title="まとめて移動するチェック"></td>' : '';
    const crossBtn = cross ? '<button class="'+cross.btnCls+'" data-key="'+esc(p.rowKey)+'" title="この商品を'+cross.word+'へ付け替えます（対象には戻しません）">'+cross.label+'</button> ' : '';
    rows+='<tr>'
      + chkTd
      +'<td class="prodcell col-prod"><div class="prodname">'+esc(p.productName)+'</div>'
      +'<div class="subline"><span class="sup-badge">'+esc(p.supplier)+'</span> <span class="pcode">'+esc(p.productCode||'')+'</span></div></td>'
      +'<td class="num col-sell"><span class="main-num">'+numStr(p.newSell)+'</span><span class="paren">（'+numStr(p.currentSell)+'）</span></td>'
      +'<td>'+esc(p.effectiveDate||'')+'</td>'
      +(kind==='manual'?'<td class="muted">'+esc(p.note||'')+'</td>':'')
      +(kind==='issued'?'<td class="muted">'+info+'</td>':'')
      +'<td>'+crossBtn+'<button class="back-btn" data-key="'+esc(p.rowKey)+'" title="この商品を見積の「対象」に戻します">↩ 対象へ戻す</button></td>'
      +'</tr>';
  }
  const crossBulkBtn = cross ? '<button class="bulkbtn '+cross.bulkCls+'" id="'+cross.bulkId+'" disabled>'+cross.bulkLabel+'</button>' : '';
  const bulkBar = hasChk
    ? ('<div class="bulkbar"><span class="bulkinfo">☑ 選択 <b id="cnt-'+kind+'">0</b> 件</span>'
       +'<button class="bulkbtn back" id="bulkBack-'+kind+'" disabled>↩ 選択をまとめて対象へ戻す</button>'
       + crossBulkBtn
       +'<span class="muted">チェックした商品を「対象」へ戻す'+(cross?('／'+cross.word+'へ付け替え'):'')+'。</span></div>')
    : '';
  return '<details class="itemsec sec-'+kind+'"'+open+'><summary>'+title+' <b>'+items.length+'</b> 件</summary>'
    +'<div class="table-pad">'+bulkBar+'<table class="cust-compact cust-smart"><thead><tr>'+chkTh+'<th class="col-prod">商品</th><th class="col-sell">新売価<span class="paren">（現）</span></th><th>実施日</th>'+noteTh+issuedTh+'<th>操作</th></tr></thead><tbody>'
    +rows+'</tbody></table></div></details>';
}
// 得意先内の商品を rowKey で探す（対象・検討中・手動修正・提出済みの全セクション）。
function findProductInCust(c, rowKey){
  if(!c||!rowKey) return null;
  const all=[].concat(c.products||[], c.holdProducts||[], c.dormantProducts||[], c.manualProducts||[], c.issuedProducts||[]);
  return all.find(p=>p.rowKey===rowKey)||null;
}
// 手動修正登録時に保存する単価スナップショット。
function productSnapshot(p){
  return {
    productCode:p.productCode||'', productName:p.productName||'', supplier:p.supplier||'',
    currentSell:p.currentSell, newSell:p.newSell, currentCost:p.currentCost, newCost:p.newCost,
    effectiveDate:(rowEff[p.rowKey]!=null)?String(rowEff[p.rowKey]):(p.effectiveDate||''),
    note:(rowNote[p.rowKey]!=null)?String(rowNote[p.rowKey]):(p.note||''),
    matchStatus:p.matchStatus||'',
  };
}
// チェックした複数アイテムをまとめて移動（cls=チェック対象クラス, status='hold'|'manual'|''）。
async function bulkMove(cls, status){
  const keys = Array.from(document.querySelectorAll('#detailCol input.'+cls+':checked')).map(c=> c.getAttribute('data-key')).filter(Boolean);
  if(!selName || !keys.length) return;
  try{
    const body={ customer:selName, status };
    if(status==='manual'){
      const c=DATA.find(x=>x.name===selName);
      body.items=keys.map(k=>{ const p=findProductInCust(c,k); return Object.assign({ rowKey:k }, p?productSnapshot(p):{}); });
    } else body.rowKeys=keys;
    const res=await fetch('/api/item-status-bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(x=>x.json());
    if(!res.ok){ alert('一括変更に失敗: '+(res.error||'')); return; }
    await load();
  }catch(e){ alert('一括変更に失敗: '+e); }
}
// アイテムの状態変更（hold=検討中／manual=手動修正／''=対象へ戻す）→ 保存して再取得
async function setItemState(rowKey, status, snap){
  if(!selName || !rowKey) return;
  try{
    const res=await fetch('/api/item-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:selName,rowKey:rowKey,status:status,snapshot:snap||{}})}).then(x=>x.json());
    if(!res.ok){ alert('変更に失敗: '+(res.error||'')); return; }
    await load();
  }catch(e){ alert('変更に失敗: '+e); }
}
// 行ルールの選択肢（先頭＝全体ルールを継承）
const ROW_RULE_OPTS=[['','（全体）'],['add_increase','上乗せ'],['keep_margin_rate','粗利維持'],['target_margin_rate','粗利率%'],['markup','掛率×'],['sell_cost_rate','売価×仕入率'],['keep_sell','据置']];
function rowRuleSelect(p){
  const cur = rowRules[p.rowKey]||'';
  const opts = ROW_RULE_OPTS.map(o=>'<option value="'+o[0]+'"'+(o[0]===cur?' selected':'')+'>'+o[1]+'</option>').join('');
  return '<select class="rowrule'+(cur?' ov':'')+'" data-key="'+esc(p.rowKey)+'" title="変更はローカルに保存。価格は見積発行プレビューで確認">'+opts+'</select>'
    +'<span class="rowfactor-slot" data-key="'+esc(p.rowKey)+'">'+rowFactorInput(p)+'</span>';
}
function bindOneRowFactor(inp){
  inp.addEventListener('change',()=>{
    const k=inp.getAttribute('data-key');
    const v=parseFloat(inp.value);
    if(Number.isFinite(v) && v>0) rowFactor[k]=v; else delete rowFactor[k];
    markCalcPending();
    if(lastApplied) showApplied(lastApplied);
  });
}
function refreshRowFactorSlot(sel){
  const k=sel.getAttribute('data-key');
  const slot=sel.parentElement && sel.parentElement.querySelector('.rowfactor-slot');
  if(!slot) return;
  slot.innerHTML=rowFactorInput({rowKey:k});
  const inp=slot.querySelector('input.rowfactor');
  if(inp) bindOneRowFactor(inp);
}
// 行ルールが「掛率×」または「粗利率%（目標粗利率）」のときだけ、その行のパラメータ入力欄を出す
//  （未入力なら上の全体「掛率」/「目標粗利率%」を使う）。
function rowFactorInput(p){
  const rr=(rowRules[p.rowKey]||'');
  if(rr!=='markup' && rr!=='target_margin_rate') return '';
  const isMargin=(rr==='target_margin_rate');
  const gf = isMargin ? (parseFloat(($('#cMargin')||{}).value)||30) : (parseFloat(($('#cFactor')||{}).value)||1.25);
  const v = (rowFactor[p.rowKey]!=null && rowFactor[p.rowKey]!=='') ? rowFactor[p.rowKey] : gf;
  const pre = isMargin ? ' 粗利' : ' ×';
  const suf = isMargin ? '%' : '';
  const ttl = isMargin ? 'この行の目標粗利率%（新原価÷(1−率)）。空欄なら上の全体「目標粗利率%」を使います' : 'この行の掛率（現売価 × この値）。空欄なら上の全体「掛率」を使います';
  return pre+'<input class="rowfactor" type="text" inputmode="decimal" data-key="'+esc(p.rowKey)+'" value="'+esc(v)+'" title="'+ttl+'" style="width:52px">'+suf;
}
// 行ごと まるめ：1つのプルダウン（変更は即サーバへ送らず「再計算」で一括反映）
const ROW_ROUND_SEL_OPTS=[
  ['','（全体）'],
  ['1|floor','整数・切捨'],['1|round','整数・四捨五入'],['1|ceil','整数・切上'],
  ['0.1|floor','0.1・切捨'],['0.1|round','0.1・四捨五入'],['0.1|ceil','0.1・切上'],
  ['0.01|floor','銭・切捨'],['0.01|round','銭・四捨五入'],['0.01|ceil','銭・切上'],
];
const BAND_ROUND_OPTS=[['','（全体のまるめ）'], ...ROW_ROUND_SEL_OPTS.slice(1)];
function bandRoundSelectVal(b){
  const u=b.roundUnit, m=b.roundMode||'';
  if((u===1||u===0.1||u===0.01)&&(m==='floor'||m==='round'||m==='ceil')) return String(u)+'|'+m;
  return '';
}
function rowRoundSelect(p){
  const cur=rowRound[p.rowKey]||'';
  let h='<select class="rowround-sel'+(cur?' ov':'')+'" data-key="'+esc(p.rowKey)+'" title="変更後は上の「この設定で再計算」">';
  for(const o of ROW_ROUND_SEL_OPTS){
    h+='<option value="'+esc(o[0])+'"'+(o[0]===cur?' selected':'')+'>'+esc(o[1])+'</option>';
  }
  return h+'</select>';
}

// 画面のカスタマイズ操作 → サーバへ渡す計算設定（メインページと同じ項目）
// 価格帯別ルール（現売価で転嫁ルールを変える）。最後の1件は max=null＝「それ以上」。
let priceBands=[{max:null, rule:'add_increase', factor:1.25}];
let bandRoundOn=false; // 帯ごとの「まるめ」を出すか（既定OFF＝上の全体まるめを使う。上級者だけ開く）
const BAND_RULES=[['add_increase','上乗せ'],['keep_margin_rate','粗利維持'],['target_margin_rate','粗利率%'],['markup','掛率×'],['sell_cost_rate','売価×仕入率'],['keep_sell','据置']];
function bandsEnabled(){ return !!($('#cBandOn')&&$('#cBandOn').checked); }
function getRoundUnit(){
  const el=document.querySelector('input[name="cRoundUnit"]:checked');
  const u=el?parseFloat(el.value):0.01;
  return (u===1||u===0.1||u===0.01)?u:0.01;
}
function getRoundMode(){
  const sel=String(($('#cRoundMode')||{}).value||'').trim();
  if(sel==='floor'||sel==='ceil'||sel==='round') return sel;
  const pol=String(($('#cPolicyRoundMode')||{}).value||'round').trim();
  return (pol==='floor'||pol==='ceil')?pol:'round';
}
function calcOpts(){
  const rt=$('#cRule').value;
  // factor は「ルールのパラメータ」枠：掛率(markup)は倍率、目標粗利率(target_margin_rate)は%を載せる。
  const param = (rt==='target_margin_rate') ? (parseFloat($('#cMargin').value)||0) : (parseFloat($('#cFactor').value)||1);
  return {
    ruleType: rt,
    factor: param,
    roundingUnit: getRoundUnit(),
    roundingMode: getRoundMode(),
    selfUplift: parseFloat($('#cUplift').value)||0,
    forceEffectiveDate: ($('#cEff').value||'').trim(),
    priceBands: bandsEnabled() ? priceBands.filter(b=>b.rule) : undefined, // 価格帯別ON時のみ送る
    rowRules, rowSell, rowEff, rowNote, rowRound, rowFactor,
  };
}
// 価格帯別ルールの編集UIを描画（max昇順・null=それ以上は最後）。変更は markCalcPending（再計算ボタンで反映）。
function renderBands(){
  const box=$('#bandBox'); if(!box) return;
  priceBands.sort((a,b)=>((a.max==null?Infinity:a.max)-(b.max==null?Infinity:b.max)));
  // 帯まるめが既に設定済みなら自動で開く（隠したまま黙って効く事故を防ぐ）
  if(!bandRoundOn && priceBands.some(b=>bandRoundSelectVal(b))) bandRoundOn=true;
  const inS='padding:4px 6px;border:1px solid #c7d6e4;border-radius:6px;font-size:13px';
  const ruleSel=(i,val)=>'<select class="band-rule" data-i="'+i+'" style="'+inS+'">'+BAND_RULES.map(o=>'<option value="'+o[0]+'"'+(o[0]===val?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>';
  const roundSel=(i,b)=>'<select class="band-round" data-i="'+i+'" style="'+inS+'" title="この価格帯の改定後まるめ（空＝上の全体まるめ）">'
    +BAND_ROUND_OPTS.map(o=>'<option value="'+esc(o[0])+'"'+(bandRoundSelectVal(b)===o[0]?' selected':'')+'>'+esc(o[1])+'</option>').join('')+'</select>';
  let h='<div style="font-size:11px;color:#5a6b7a;margin-bottom:6px">現売価の小さい順に「〜○○円まで」の帯を作り、各帯の<strong>転嫁ルール</strong>を選びます。最後の「それ以上」が残り全部です。<br>例：〜100円＝粗利維持／〜500円＝掛率×1.2／それ以上＝上乗せ。</div>';
  h+='<label style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#5a6b7a;margin-bottom:5px;cursor:pointer"><input type="checkbox" id="bandRoundToggle"'+(bandRoundOn?' checked':'')+'> まるめも帯ごとに変える（上級／既定は上の「全体まるめ」）</label>';
  priceBands.forEach((b,i)=>{
    const isLast=(b.max==null);
    const mx=isLast?'<b style="min-width:96px;display:inline-block">それ以上</b>'
      :'〜 <input class="band-max" data-i="'+i+'" type="text" inputmode="decimal" value="'+(b.max==null?'':b.max)+'" style="width:74px;text-align:right;'+inS+'"> 円まで';
    const fac=(b.rule==='markup')?(' ×<input class="band-factor" data-i="'+i+'" type="text" inputmode="decimal" value="'+(b.factor||'')+'" style="width:56px;text-align:right;'+inS+'">')
      :(b.rule==='target_margin_rate')?(' 粗利<input class="band-factor" data-i="'+i+'" type="text" inputmode="decimal" value="'+(b.factor||'')+'" style="width:50px;text-align:right;'+inS+'">%')
      :'';
    const del=isLast?'':'<button class="band-del" data-i="'+i+'" title="この帯を削除" style="border:none;background:#e4ebf2;color:#5a6b7a;border-radius:6px;width:24px;height:24px;cursor:pointer">×</button>';
    h+='<div style="display:flex;align-items:center;gap:6px;margin:4px 0;flex-wrap:wrap">'+mx+' ： '+ruleSel(i,b.rule)+fac
      +(bandRoundOn?(' まるめ '+roundSel(i,b)):'')+' '+del+'</div>';
  });
  h+='<button id="bandAdd" style="margin-top:4px;border:1px dashed #9ec3e6;background:#fff;color:#1f6fb2;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px">＋ 帯を追加</button>';
  box.innerHTML=h;
  const brt=$('#bandRoundToggle'); if(brt) brt.addEventListener('change',()=>{
    bandRoundOn=brt.checked;
    if(!bandRoundOn){ priceBands.forEach(b=>{ delete b.roundUnit; delete b.roundMode; }); } // 閉じたら帯まるめは全体に戻す
    renderBands(); markCalcPending();
  });
  box.querySelectorAll('.band-rule').forEach(el=>el.addEventListener('change',()=>{ priceBands[+el.dataset.i].rule=el.value; renderBands(); markCalcPending(); }));
  box.querySelectorAll('.band-max').forEach(el=>el.addEventListener('change',()=>{ const v=parseFloat(el.value); priceBands[+el.dataset.i].max=Number.isFinite(v)?v:null; renderBands(); markCalcPending(); }));
  box.querySelectorAll('.band-factor').forEach(el=>el.addEventListener('change',()=>{ const v=parseFloat(el.value); priceBands[+el.dataset.i].factor=Number.isFinite(v)&&v>0?v:1.25; markCalcPending(); }));
  box.querySelectorAll('.band-round').forEach(el=>el.addEventListener('change',()=>{
    const i=+el.dataset.i;
    const v=el.value||'';
    if(!v){ delete priceBands[i].roundUnit; delete priceBands[i].roundMode; }
    else { const p=v.split('|'); priceBands[i].roundUnit=parseFloat(p[0]); priceBands[i].roundMode=p[1]||'round'; }
    markCalcPending();
  }));
  box.querySelectorAll('.band-del').forEach(el=>el.addEventListener('click',()=>{ priceBands.splice(+el.dataset.i,1); renderBands(); markCalcPending(); }));
  const add=$('#bandAdd'); if(add) add.addEventListener('click',()=>{ priceBands.unshift({max:100,rule:'add_increase',factor:1.25}); renderBands(); markCalcPending(); });
}
const RULE_LABEL={add_increase:'上乗せ',keep_margin_rate:'粗利維持',target_margin_rate:'粗利率%',markup:'掛率×',sell_cost_rate:'売価×仕入率',keep_sell:'据置'};
const MODE_LABEL={round:'四捨五入',ceil:'切上げ',floor:'切捨て'};
const UNIT_LABEL={'1':'整数','0.1':'0.1','0.01':'0.01'};
function toggleFactor(){
  const rt=$('#cRule').value;
  $('#cFactorBox').style.display = (rt==='markup')?'flex':'none';
  const mb=$('#cMarginBox'); if(mb) mb.style.display = (rt==='target_margin_rate')?'flex':'none';
}
function showApplied(a){
  if(a) lastApplied=a;
  if(!a){ lastApplied=null; $('#appliedMsg').textContent=''; return; }
  // 価格帯別ルールが効いているときは、単体ルールの代わりに帯の内容を表示。
  const bands=Array.isArray(a.priceBands)?a.priceBands:[];
  const ruleDisp = bands.length
    ? ('💴 価格帯別: '+bands.map(b=>{
        let s=(b.max==null?'それ以上':('〜'+b.max))+'='+(RULE_LABEL[b.rule]||b.rule)+(b.rule==='markup'?('×'+(b.factor||'')):(b.rule==='target_margin_rate'?((b.factor||'')+'%'):''));
        const rv=bandRoundSelectVal(b);
        if(rv){ const o=BAND_ROUND_OPTS.find(x=>x[0]===rv); if(o) s+=' まるめ'+o[1]; }
        return s;
      }).join(' / '))
    : ((RULE_LABEL[a.ruleType]||a.ruleType)+(a.ruleType==='markup'?(' '+a.factor):(a.ruleType==='target_margin_rate'?(' '+a.factor+'%'):'')));
  const uLbl=UNIT_LABEL[String(a.roundingUnit)]||String(a.roundingUnit);
  const mSel=String(($('#cRoundMode')||{}).value||'');
  const mLbl=mSel?(MODE_LABEL[mSel]||mSel):('⚙'+(MODE_LABEL[a.roundingMode]||a.roundingMode));
  const parts=[ ruleDisp,
    'まるめ '+uLbl+' / '+mLbl,
    '自社+'+a.selfUplift+'%',
    a.forceEffectiveDate?('実施日 '+a.forceEffectiveDate+' に統一'):'実施日 各行' ];
  const ovN=Object.keys(rowRules).length, sN=Object.keys(rowSell).length, eN=Object.keys(rowEff).length;
  const nN=Object.keys(rowNote).length, rN=Object.keys(rowRound).length, fN=Object.keys(rowFactor).length;
  let manual='';
  if(ovN) manual+='　🟢 行ルール '+ovN+'件';
  if(rN) manual+='　🟢 行まるめ '+rN+'件';
  if(fN) manual+='　🟢 行掛率 '+fN+'件';
  if(sN) manual+='　🟢 売価手入力 '+sN+'件';
  if(eN) manual+='　🟢 実施日手入力 '+eN+'件';
  if(nN) manual+='　🟢 備考 '+nN+'件';
  $('#appliedMsg').textContent='適用中（全体）: '+parts.join(' ／ ')+manual;
}

// 起動時の軽量一覧（calcAll なし）。明細は selectCust → loadCustomerDetail で遅延取得。
async function loadSummary(){
  $('#listCol').innerHTML='<div class="empty">読み込み中…</div>';
  $('#msg').textContent='一覧を読み込み中…';
  try{
    const res=await fetch('/api/customers-summary').then(x=>x.json());
    DATA=res.customers||[];
    const errN=(res.errors||[]).length;
    $('#msg').textContent='得意先 '+DATA.length+' 件 ／ 仕入先ファイル '+(res.fileCount||0)+' 本'
      +(errN?'（読み取り失敗 '+errN+' 本）':'')
      +'（明細は得意先を選ぶと読み込みます）';
    applyFilter();
    updateIssuedToolbar();
  }catch(e){
    $('#listCol').innerHTML='<div class="empty">読み込み失敗：'+esc(e&&e.message||e)+'</div>';
    $('#msg').textContent='';
  }
}
// 選択中得意先の明細だけ再計算（refreshOne）。
async function loadCustomerDetail(name){
  const opts=calcOpts();
  opts.customer=name;
  opts.refreshOne=true;
  let res;
  try{
    res=await fetch('/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(opts)}).then(x=>x.json());
  }catch(e){
    return { error: String(e&&e.message||e) };
  }
  if(res.error){ return { error: res.error }; }
  if(res.partial && res.customer){
    const merged=Object.assign({}, res.customer, { _lazy: false });
    const idx=DATA.findIndex(x=>x.name===merged.name);
    if(idx>=0) DATA[idx]=merged; else { DATA.push(merged); DATA.sort((a,b)=>String(a.name).localeCompare(String(b.name),'ja')); }
    showApplied(res.applied);
    return res.customer;
  }
  return res.customer || null;
}

async function load(soft){
  try{
    const st=await fetch('/api/shogo-status').then(x=>x.json());
    if(st.running){
      setShogoLock(true,'照合が実行中です…完了までお待ちください');
      $('#msg').textContent='照合実行中のため、データの更新を待っています…';
      return;
    }
  }catch(_){}
  const keepList = !!(soft && DATA.length);
  const partial = !!(soft && selName && DATA.length);
  if(!keepList) $('#listCol').innerHTML='<div class="empty">読み込み中…</div>';
  $('#msg').textContent=partial?'再計算中（選択中の得意先のみ）…':(keepList?'再計算中…':'集計中… 全仕入先の照合結果を再計算しています');
  $('#recalcBtn').disabled=true;
  const opts=calcOpts();
  if(partial){ opts.customer=selName; opts.refreshOne=true; }
  let res;
  try{
    res=await fetch('/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(opts)}).then(x=>x.json());
  }
  catch(e){
    if(!keepList) $('#listCol').innerHTML='<div class="empty">読み込み失敗：'+esc(e&&e.message||e)+'</div>';
    $('#msg').textContent=''; $('#recalcBtn').disabled=false; return;
  }
  finally{ $('#recalcBtn').disabled=false; }
  if(res.partial && res.customer){
    const merged=Object.assign({}, res.customer, { _lazy: false });
    const idx=DATA.findIndex(x=>x.name===merged.name);
    if(idx>=0) DATA[idx]=merged;
    else DATA.push(merged);
    DATA.sort((a,b)=>String(a.name).localeCompare(String(b.name),'ja'));
  } else {
    DATA=(res.customers||[]).map(c=>Object.assign({}, c, { _lazy: false }));
  }
  const errN=(res.errors||[]).length;
  $('#msg').textContent='得意先 '+DATA.length+' 件 ／ 仕入先ファイル '+(res.fileCount||0)+' 本'+(errN?'（読み取り失敗 '+errN+' 本）':'')+(partial?'（選択中のみ更新）':'');
  showApplied(res.applied);
  clearCalcPending();
  applyFilter();
  updateIssuedToolbar();
  if(selName && DATA.find(x=>x.name===selName)) await selectCust(selName);
}
// カナ検索の正規化キー：NFKC（半角カナ→全角・全角英数→半角）→カタカナをひらがなへ→小文字・空白除去。
//  これで「なかじま / ナカジマ / ﾅｶ」のどれで打っても KCODE(半角カナ ﾅｶｼﾞﾏ) に一致する。※正規表現は使わない。
function kanaKey(s){
  s=String(s==null?'':s).normalize('NFKC');
  let out='';
  for(const ch of s){
    let c=ch.charCodeAt(0);
    if(c>=0x30A1 && c<=0x30F6) c-=0x60; // 全角カタカナ→ひらがな
    const x=String.fromCharCode(c).toLowerCase();
    if(x!==' ' && x!=='　') out+=x;
  }
  return out;
}
// 得意先が検索語に一致するか（名前・得意先コード・検索カナ のいずれか）。
function matchCust(c,q){
  if(!q) return true;
  if(c.name && c.name.indexOf(q)>=0) return true;
  if(c.code && String(c.code).indexOf(q)>=0) return true;
  const qk=kanaKey(q);
  if(qk){
    if(c.kana && kanaKey(c.kana).indexOf(qk)>=0) return true;
    if(c.name && kanaKey(c.name).indexOf(qk)>=0) return true;
  }
  return false;
}
// 過去N年の判定。最終売上日(ISO)が「今日からN年前」以降なら期間内。
//  最終売上日が無い（ファイル方式/未再照合のCSV）ときは直近1年フラグ(hasRecent)で代用。
function cutoffIso(years){
  const d=new Date(); const t=new Date(d.getFullYear()-years, d.getMonth(), d.getDate());
  const p=(n)=>String(n).padStart(2,'0');
  return t.getFullYear()+'-'+p(t.getMonth()+1)+'-'+p(t.getDate());
}
function withinYears(c, years){
  if(!years || years<=0) return true; // 全期間
  if(c.lastDate) return c.lastDate >= cutoffIso(years);
  return !!c.hasRecent; // 最終売上日が無いときは直近1年(hasRecent)で代用
}
// 今日(ISO) ・ ISO日付判定 ・ M/D短縮（正規表現は使わない＝テンプレ配信での \\d 事故回避）
function todayIso(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
function isIsoDate(e){ if(!e||e.length!==10||e[4]!=='-'||e[7]!=='-') return false; for(let i=0;i<10;i++){ if(i===4||i===7) continue; if(e[i]<'0'||e[i]>'9') return false; } return true; }
function isValidEffIso(v){
  var s=String(v==null?'':v).trim();
  if(!isIsoDate(s)) return false;
  // 形式だけでなく実在する日付かを確認（2026-02-31 等を弾く）＝サーバ isValidEff と判定を一致させ、
  //  画面の赤表示・件数バッジと発行ゲート（発行可否）がズレないようにする。
  var y=Number(s.slice(0,4)),mo=Number(s.slice(5,7)),da=Number(s.slice(8,10));
  if(mo<1||mo>12||da<1||da>31) return false;
  var d=new Date(y,mo-1,da);
  return d.getFullYear()===y&&d.getMonth()===mo-1&&d.getDate()===da;
}
function excelSerialToISO(serial){
  const n=Number(serial);
  if(!Number.isFinite(n)) return null;
  const d=new Date((n-25569)*86400*1000);
  if(isNaN(d.getTime())) return null;
  const p=x=>String(x).padStart(2,'0');
  return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate());
}
// 実施日入力の正規化（server.js normDateInput と同じ。配信JSなので正規表現は \\d / \\D）
function normDateInputClient(v){
  let s=String(v==null?'':v).normalize('NFKC').trim();
  if(s==='') return '';
  const p2=n=>String(n).padStart(2,'0');
  if(/^\\d{4,6}$/.test(s)){ const n=Number(s); if(n>=20000&&n<=90000){ const iso=excelSerialToISO(n); if(iso) return iso; } }
  let m=s.match(/(\\d{4})\\D{1,3}(\\d{1,2})\\D{1,3}(\\d{1,2})/);
  if(m){ const mo=Number(m[2]),da=Number(m[3]); if(mo>=1&&mo<=12&&da>=1&&da<=31) return m[1]+'-'+p2(mo)+'-'+p2(da); }
  m=s.match(/(\\d{1,2})\\D{1,3}(\\d{1,2})/);
  if(m){ const mo=Number(m[1]),da=Number(m[2]); if(mo>=1&&mo<=12&&da>=1&&da<=31) return new Date().getFullYear()+'-'+p2(mo)+'-'+p2(da); }
  return s;
}
function updateEffUi(){
  const c=selName?DATA.find(x=>x.name===selName):null;
  if(!c) return;
  const effN=effMissingCountLive(c);
  const msg='⚠ 実施日が未設定 '+effN+' 件（赤い欄）。<b>実施日は発行に必須</b>です。各行の実施日を入力するか、上の「実施日 一括」で統一してから発行してください。';
  let banner=$('#effNoteBanner');
  if(effN){
    if(banner) banner.innerHTML=msg;
    else{
      const anchor=$('#pendingNote')||$('#bulkTargetBar');
      if(anchor) anchor.insertAdjacentHTML('beforebegin','<div class="effnote" id="effNoteBanner">'+msg+'</div>');
    }
  } else if(banner) banner.remove();
  $('#detailCol').querySelectorAll('input.effinp').forEach(inp=>{
    const k=inp.getAttribute('data-key');
    const raw=rowEff[k]!=null?String(rowEff[k]):inp.value;
    const miss=!isValidEffIso(normDateInputClient(raw));
    inp.classList.toggle('effmissing', miss);
    inp.title=miss?'実施日未設定（発行必須）':'実施日';
  });
}
function mdShort(iso){ if(!isIsoDate(iso)) return iso||''; return String(parseInt(iso.slice(5,7),10))+'/'+String(parseInt(iso.slice(8,10),10)); }
// 得意先の並び替え区分：1=実施日を超過(上)／2=実施日が控えている(中)／3=実施日なし or 提出済(下)。
//  代表日＝対象アイテム中で最も早い有効な実施日（直近の締切）。提出済み(ISSUED)は下段へ。
function custEffInfo(c){
  let earliest='';
  const items=(c&&c.products)||[];
  for(let i=0;i<items.length;i++){ const e=items[i]&&items[i].effectiveDate; if(isIsoDate(e)){ if(!earliest||e<earliest) earliest=e; } }
  const issued=!!(ISSUED&&ISSUED[c.name]);
  if(issued||!earliest) return { group:3, date:earliest||'', issued };
  return { group: (earliest < todayIso() ? 1 : 2), date:earliest, issued };
}
// 区分→日付昇順（超過は古い順／控えは近い順）→同点は名前順 で並べ替え。
function sortByEff(list){
  return list.map(c=>({c,e:custEffInfo(c)})).sort((A,B)=>{
    if(A.e.group!==B.e.group) return A.e.group-B.e.group;
    if(A.e.group!==3 && A.e.date!==B.e.date) return A.e.date<B.e.date?-1:1;
    return String(A.c.name).localeCompare(String(B.c.name),'ja');
  }).map(x=>x.c);
}
function effBadge(ef){
  if(ef.group===1) return '<span class="effb over" title="実施日 '+esc(ef.date)+'（超過）">⏰ '+mdShort(ef.date)+' 超過</span>';
  if(ef.group===2) return '<span class="effb soon" title="実施日 '+esc(ef.date)+'">📅 '+mdShort(ef.date)+'</span>';
  return '';
}
function applyFilter(){
  const q=($('#search').value||'').trim();
  const years = parseInt(($('#recentYears') && $('#recentYears').value) || '1', 10);
  try{ localStorage.setItem('recentYears', String(years)); }catch(e){} // 抽出期間の選択を記憶（change/全期間リンク/プログラム変更すべてを拾う単一経路）
  let list = DATA.slice();
  hiddenNoRecent = 0;
  if(years>0){ const before=list.length; list=list.filter(c=>withinYears(c,years)); hiddenNoRecent = before-list.length; }
  filtered = q ? list.filter(c=>matchCust(c,q)) : list;
  filtered = sortByEff(filtered); // 実施日 超過→控え→なし/提出済 の順に並べ替え
  renderList();
}
// 提出（発行）履歴をサーバから取得
async function loadIssueLog(){
  try{ const r=await fetch('/api/issue-log').then(x=>x.json()); ISSUED=(r&&r.log)||{}; }
  catch(e){ ISSUED={}; }
}
// 得意先別メール送信先を読み込む（見積PDFのOutlook送信用）。失敗しても画面は壊さない。
async function loadCustomerEmails(){
  try{ const r=await fetch('/api/customer-emails').then(x=>x.json()); CUST_EMAILS=(r&&r.emails)||{}; }
  catch(e){ CUST_EMAILS={}; }
}
// ISO日時 → "M/D" 表示
function issuedShort(iso){
  if(!iso) return '';
  const d=new Date(iso); if(isNaN(d)) return '';
  return (d.getMonth()+1)+'/'+d.getDate();
}
function issuedCountN(){ return Object.keys(ISSUED||{}).length; }
// 提出済みの見積書(xlsx)をこのページから直接開く（発行履歴の folder から特定）
async function openIssued(name){
  try{
    const r=await fetch('/api/open-issued',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:name})}).then(x=>x.json());
    if(!r.ok){ alert('見積書を開けませんでした：'+(r.error||'')); return; }
    if(r.note) alert(r.note); // ファイルが見つからずフォルダを開いた場合などの注記
  }catch(e){ alert('通信に失敗しました：'+e); }
}
let ISSUED_LIST_DATA=null; // 提出済一覧モーダル用（/api/issued-quotes-list の結果）
function fmtIssuedAt(iso){
  if(!iso) return '—';
  const d=new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(0,16).replace('T',' ');
  const pad=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());
}
function renderIssuedList(data, q){
  const items=(data&&data.items)||[];
  const folders=(data&&data.folders)||[];
  const query=(q||'').trim().toLowerCase();
  const shown=query ? items.filter(row=>String(row.customer||'').toLowerCase().indexOf(query)>=0) : items;
  let fh='';
  if(folders.length){
    fh='<strong>出力フォルダ</strong> ';
    for(const f of folders){
      fh+='<button type="button" class="foldbtn" data-folder="'+esc(f.folder)+'" onclick="openIssuedFolder(this.getAttribute(\\'data-folder\\'))">📁 '+esc(f.folder)+'（'+f.customers+'社）</button>';
    }
  } else fh='<span class="muted">出力フォルダ情報なし</span>';
  const fel=$('#issuedListFolders'); if(fel) fel.innerHTML=fh;
  let html='<table><thead><tr><th>得意先</th><th>提出日時</th><th>見積No</th><th class="num">品目</th><th class="num">回数</th><th>操作</th></tr></thead><tbody>';
  if(!shown.length){
    html+='<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">'
      +(query?'「'+esc(q)+'」に一致する提出済みはありません。':'提出済みの見積はまだありません。<br>見積を「発行」するとここに表示されます。')
      +'</td></tr>';
  } else {
    for(const row of shown){
      const miss=!row.fileExists;
      html+='<tr'+(miss?' style="opacity:.8"':'')+'>'
        +'<td>'+esc(row.customer)+(miss?' <span class="muted" title="見積書ファイルが見つかりません">⚠</span>':'')+'</td>'
        +'<td>'+esc(fmtIssuedAt(row.lastIssuedAt))+'</td>'
        +'<td>'+esc(row.quoteNo||'—')+'</td>'
        +'<td class="num">'+(row.itemCount||0)+'</td>'
        +'<td class="num">'+(row.count||1)+'</td>'
        +'<td>'
        +'<button type="button" class="actbtn go" data-name="'+esc(row.customer)+'" onclick="openIssued(this.getAttribute(\\'data-name\\'))">📄 開く</button>'
        +'<button type="button" class="actbtn ghost" data-name="'+esc(row.customer)+'" onclick="jumpToIssuedCustomer(this.getAttribute(\\'data-name\\'))">👤 得意先へ</button>'
        +'</td></tr>';
    }
  }
  html+='</tbody></table>';
  const body=$('#issuedListBody'); if(body) body.innerHTML=html;
  const sum=$('#issuedListSummary');
  if(sum){
    const totalItems=data.totalItems!=null?data.totalItems:items.reduce((s,x)=>s+(x.itemCount||0),0);
    sum.textContent = shown.length
      ? ('表示 '+shown.length+(query?' / 全'+items.length:'')+' 社・合計 '+totalItems+' 品')
      : '';
  }
}
async function openIssuedList(){
  await loadIssueLog();
  let data={items:[],folders:[],count:0,totalItems:0};
  try{
    const r=await fetch('/api/issued-quotes-list').then(x=>x.json());
    if(r&&r.ok) data=r;
  }catch(e){
    data.items=Object.entries(ISSUED||{}).map(([customer,ent])=>({
      customer,lastIssuedAt:ent.lastIssuedAt||'',quoteNo:ent.quoteNo||'',itemCount:ent.itemCount||0,
      count:ent.count||1,folder:ent.folder||'',fileExists:true,folderExists:true
    })).sort((a,b)=>String(b.lastIssuedAt).localeCompare(String(a.lastIssuedAt)));
    data.count=data.items.length;
    data.totalItems=data.items.reduce((s,x)=>s+(x.itemCount||0),0);
  }
  ISSUED_LIST_DATA=data;
  const search=$('#issuedListSearch'); if(search) search.value='';
  renderIssuedList(data,'');
  $('#issuedListOverlay').classList.add('show');
}
function closeIssuedList(){ $('#issuedListOverlay').classList.remove('show'); }
// 📋 他社価格：この商品を他の得意先にいくらで提出（発行）したかの一覧モーダル。
function closeCrossQuotes(){ $('#xqOverlay').classList.remove('show'); }
async function openCrossQuotes(rowKey, cust, name){
  if(!rowKey) return;
  const title=$('#xqTitle'), stats=$('#xqStats'), bodyEl=$('#xqBody');
  title.textContent='📋 '+(name||'この商品')+' — 他の得意先への見積価格';
  stats.innerHTML='';
  bodyEl.innerHTML='<div class="xq-empty">読み込み中…</div>';
  $('#xqOverlay').classList.add('show');
  let data={ok:false,items:[],stats:null};
  try{
    data=await fetch('/api/cross-customer-quotes',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rowKey,customer:cust||'',productName:name||''})}).then(x=>x.json());
  }catch(e){ data={ok:false}; }
  if(!data||!data.ok){ bodyEl.innerHTML='<div class="xq-empty">読み込みに失敗しました。</div>'; return; }
  const items=data.items||[];
  if(!items.length){
    stats.innerHTML='';
    bodyEl.innerHTML='<div class="xq-empty">他の得意先への発行（提出）実績はまだありません。<br>見積を発行すると、ここに横断で価格が並びます。</div>';
    return;
  }
  const s=data.stats||{};
  stats.innerHTML='<span>提出先 <b>'+items.length+'</b> 先</span>'
    +(s.priced?'<span>最安 <b>'+yen(s.min)+'</b></span><span>最高 <b>'+yen(s.max)+'</b></span><span>平均 <b>'+yen(s.avg)+'</b></span>':'');
  let html='<table class="xq-table"><thead><tr><th>得意先</th><th class="num">提出単価</th><th>実施日</th><th>発行日</th><th>見積No</th></tr></thead><tbody>';
  for(const it of items){
    html+='<tr><td>'+esc(it.customer)+'</td>'
      +'<td class="num">'+(it.sell!=null?yen(it.sell):'—')+'</td>'
      +'<td>'+esc(it.eff||'')+'</td>'
      +'<td>'+esc(it.at?String(it.at).slice(0,10):'')+'</td>'
      +'<td>'+esc(it.quoteNo||'')+'</td></tr>';
  }
  html+='</tbody></table>';
  bodyEl.innerHTML=html;
}
let MANUAL_LIST_DATA=null;
function renderManualList(data, query){
  const items=(data&&data.items)||[];
  const q=String(query||'').trim().toLowerCase();
  const shown=q?items.filter(it=>{
    const hay=(it.customer+' '+it.supplier+' '+it.productName+' '+it.productCode+' '+it.note).toLowerCase();
    return hay.indexOf(q)>=0;
  }):items;
  let html='<table><thead><tr><th>得意先</th><th>仕入先</th><th>商品</th><th class="num">現売価</th><th class="num">改定売価</th><th class="num">現仕入</th><th class="num">改定仕入</th><th>実施日</th><th>備考</th><th>登録</th><th>操作</th></tr></thead><tbody>';
  if(!shown.length){
    html+='<tr><td colspan="11" class="muted" style="padding:16px;text-align:center">'+(items.length?'該当なし':'手動修正の記録はまだありません。対象商品の「✏」ボタンで登録できます。')+'</td></tr>';
  } else {
    for(const row of shown){
      html+='<tr>'
        +'<td>'+esc(row.customer)+'</td>'
        +'<td>'+esc(row.supplier||'')+'</td>'
        +'<td><div>'+esc(row.productName||'')+'</div><div class="muted">'+esc(row.productCode||'')+'</div></td>'
        +'<td class="num">'+numStr(row.currentSell)+'</td>'
        +'<td class="num">'+numStr(row.newSell)+'</td>'
        +'<td class="num">'+numStr(row.currentCost)+'</td>'
        +'<td class="num">'+numStr(row.newCost)+'</td>'
        +'<td>'+esc(row.effectiveDate||'')+'</td>'
        +'<td>'+esc(row.note||'')+'</td>'
        +'<td class="muted">'+esc((row.registeredAt||'').slice(0,10))+'</td>'
        +'<td><button type="button" class="actbtn ghost" data-name="'+esc(row.customer)+'" onclick="jumpToManualCustomer(this.getAttribute(\\'data-name\\'))">👤 得意先へ</button></td>'
        +'</tr>';
    }
  }
  html+='</tbody></table>';
  const body=$('#manualListBody'); if(body) body.innerHTML=html;
  const sum=$('#manualListSummary');
  if(sum) sum.textContent=shown.length?('表示 '+shown.length+(query?' / 全'+items.length:'')+' 件'):'';
}
async function openManualList(){
  let data={items:[],count:0};
  try{
    const r=await fetch('/api/manual-corrections-list').then(x=>x.json());
    if(r&&r.ok) data=r;
  }catch(e){ alert('一覧の取得に失敗: '+e); return; }
  MANUAL_LIST_DATA=data;
  const search=$('#manualListSearch'); if(search) search.value='';
  renderManualList(data,'');
  $('#manualListOverlay').classList.add('show');
}
function closeManualList(){ $('#manualListOverlay').classList.remove('show'); }
function jumpToManualCustomer(name){
  closeManualList();
  if(DATA.find(x=>x.name===name)) selectCust(name);
  else $('#msg').textContent='「'+name+'」は現在の改定対象に見つかりません（手動修正の記録のみ残っています）。';
}
async function openIssuedFolder(folder){
  if(!folder) return;
  try{
    const r=await fetch('/api/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'output/'+folder})}).then(x=>x.json());
    if(r&&r.ok) $('#msg').textContent='フォルダを開きました: '+folder;
    else alert((r&&r.error)||'フォルダを開けませんでした');
  }catch(e){ alert('通信に失敗しました：'+e); }
}
function jumpToIssuedCustomer(name){
  closeIssuedList();
  if(DATA.find(x=>x.name===name)) selectCust(name);
  else $('#msg').textContent='「'+name+'」は現在の改定対象に見つかりません（提出済みの記録のみ残っています）。';
}
// 1得意先の「提出済み」を取り消す
async function unmarkIssued(name){
  if(!confirm('「'+escConfirm(name)+'」の提出済みマークを取り消します。よろしいですか？\\n（見積書ファイル自体は消えません。表示の記録だけ消します）')) return;
  try{
    const r=await fetch('/api/issue-log-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:name})}).then(x=>x.json());
    if(!r||!r.ok){ alert((r&&r.error)||'保存に失敗しました'); return; }
    ISSUED=(r&&r.log)||{};
  }catch(e){ delete ISSUED[name]; }
  renderList(); if(selName) selectCust(selName); updateIssuedToolbar();
}
// 提出履歴を全消去（新しい改定サイクルの開始時に使う）
async function resetAllIssued(){
  const n=issuedCountN();
  if(!n){ alert('提出済みの記録はありません。'); return; }
  if(!confirm('提出履歴をすべてリセットします（'+n+'得意先）。\\n新しい改定サイクルを始めるときに使います。\\n※見積書ファイル自体は消えません。表示の「✅提出済」マークだけ消します。よろしいですか？')) return;
  try{
    const r=await fetch('/api/issue-log-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}).then(x=>x.json());
    if(!r||!r.ok){ alert((r&&r.error)||'保存に失敗しました'); return; }
    ISSUED=(r&&r.log)||{};
  }catch(e){ ISSUED={}; }
  renderList(); if(selName) selectCust(selName); updateIssuedToolbar();
}
// ツールバーの「提出 N/全」表示を更新
function updateIssuedToolbar(){
  const el=$('#issuedStat'); if(!el) return;
  const n=issuedCountN(), total=DATA.length;
  el.textContent = n ? ('✅ 提出済 '+n+(total?'/'+total:'')+' 得意先') : '提出済 0';
}
function renderList(){
  // 「取引のない先を隠す」で隠した件数の案内（解除リンク付き）。
  const yrs = parseInt(($('#recentYears') && $('#recentYears').value) || '1', 10);
  const note = hiddenNoRecent
    ? '<div class="listnote">🔇 過去'+yrs+'年に取引のない先 '+hiddenNoRecent+'件 を非表示中。<a href="#" onclick="showAllCusts();return false">全期間を表示</a></div>'
    : '';
  if(!filtered.length){ $('#listCol').innerHTML=note+'<div class="empty">該当する得意先がありません。'+(hiddenNoRecent?'<br>表示期間を「全期間」にすると過去客も表示されます。':'<br>照合結果がない場合は「↻ 照合を実行」してください。')+'</div>'; return; }
  let html=note;
  let lastG=0; // 直前の区分（グループ区切り見出しの挿入用）
  for(const c of filtered){
    const ef = custEffInfo(c);
    if(ef.group!==lastG){
      lastG=ef.group;
      const lbl = ef.group===1?'⏰ 実施日を超過（至急）':ef.group===2?'📅 実施日が控えている':'— 実施日なし・提出済み';
      const gcls = ef.group===1?'over':ef.group===2?'soon':'';
      html+='<div class="listgrp '+gcls+'">'+lbl+'</div>';
    }
    const sel = c.name===selName ? ' sel' : '';
    const rev = c.reviewCount ? '<span class="rev">要確認'+c.reviewCount+'</span>' : '';
    const lowN = lowMarginCount(c);
    const low = lowN ? '<span class="lowm">薄利'+lowN+'</span>' : '';
    const hold = c.holdCount ? '<span class="holdm">検討中'+c.holdCount+'</span>' : '';
    const dormant = c.dormantCount ? '<span class="dormantm">💤休眠'+c.dormantCount+'</span>' : '';
    const manual = c.manualCount ? '<span class="manualm">手動修正'+c.manualCount+'</span>' : '';
    const nrec = c.hasRecent ? '' : (c.lastDate ? '<span class="nrec" title="最終売上 '+esc(c.lastDate)+'">最終 '+esc(c.lastDate.slice(0,7))+'</span>' : '<span class="nrec" title="直近約1年に取引がありません（過去の得意先）">取引なし</span>');
    const code = c.code ? '<span class="ccode" title="得意先コード">'+esc(c.code)+'</span>' : '';
    const iss = ISSUED[c.name];
    const issBadge = iss ? '<span class="issued" title="最終提出 '+esc(iss.lastIssuedAt||'')+(iss.count>1?' / 提出'+iss.count+'回':'')+'">✅ 提出済 '+issuedShort(iss.lastIssuedAt)+(iss.count>1?'×'+iss.count:'')+'</span>' : '';
    const effb = effBadge(ef); // 実施日バッジ（超過=赤/控え=青）
    html+='<div class="cust'+sel+(iss?' done':'')+'" data-name="'+esc(c.name)+'" onclick="selectCust(this.getAttribute(\\'data-name\\'))">'
      +'<div style="min-width:0"><div class="nm">'+esc(c.name)+'</div>'
      +'<div class="meta">'+code+'仕入先 '+c.supplierCount+' 社'+effb+rev+low+hold+dormant+manual+nrec+issBadge+'</div></div>'
      +'<span class="cnt">'+c.productCount+'</span>'
      +'</div>';
  }
  $('#listCol').innerHTML=html;
}
// 「全期間を表示」リンク：表示期間を全期間にして再描画
function showAllCusts(){ const sel=$('#recentYears'); if(sel) sel.value='0'; applyFilter(); }
let custStickyObs=null;
// 一括バーの高さに合わせて表ヘッダーの sticky 位置をずらす（折り返し・ボタン追加で高さが変わるため）
function syncCustStickyTop(){
  const col=document.getElementById('detailCol');
  const bar=document.getElementById('bulkTargetBar');
  if(!col||!bar) return;
  const sync=()=>{
    col.style.setProperty('--cust-sticky-bulk', Math.ceil(bar.getBoundingClientRect().height)+'px');
  };
  sync();
  if(custStickyObs){ custStickyObs.disconnect(); custStickyObs=null; }
  if(typeof ResizeObserver!=='undefined'){
    custStickyObs=new ResizeObserver(sync);
    custStickyObs.observe(bar);
  }
}
async function selectCust(name){
  selName=name;
  // 転嫁ルールバーは社名の下（該当商品〜提出済の間）へ移す。innerHTML再描画で消えないよう、
  //  まずホルダーへ退避（ノードを保持＝設定値・配線をそのまま維持）→描画後にスロットへ差し込む。
  const __bar=document.getElementById('calcbar'), __home=document.getElementById('calcbarHome');
  if(__bar && __home) __home.appendChild(__bar);
  // 「○○だけ作成」ボタンも innerHTML 再描画で消えないようホルダーへ退避（描画後に一括バー右端へ差し込む）。
  const oneBtn=document.getElementById('exportOneBtn'), __oneHome=document.getElementById('exportOneHome');
  if(oneBtn && __oneHome) __oneHome.appendChild(oneBtn);
  if(oneBtn){ oneBtn.disabled=false; oneBtn.textContent='📄 「'+(name.length>12?name.slice(0,12)+'…':name)+'」だけ作成'; }
  renderList();
  let c=DATA.find(x=>x.name===name);
  if(!c){ $('#detailCol').innerHTML='<div class="empty">データがありません。</div>'; return; }
  // 軽量一覧からの初回選択＝明細を遅延取得（全仕入先 calcAll を起動時に走らせない）。
  if(c._lazy || !Array.isArray(c.products)){
    $('#detailCol').innerHTML='<div class="empty">明細を読み込み中…</div>';
    const det=await loadCustomerDetail(name);
    c=DATA.find(x=>x.name===name);
    if(det&&det.error){ $('#detailCol').innerHTML='<div class="empty">明細の読み込みに失敗しました：'+esc(det.error)+'</div>'; return; }
    if(!c || c._lazy){ $('#detailCol').innerHTML='<div class="empty">データがありません。</div>'; return; }
  }
  const supChips=c.suppliers.map(s=>'<span class="sup-badge">'+esc(s)+'</span>').join(' ');
  const codeTag = c.code ? '<span class="ccode" style="margin-left:8px;vertical-align:middle">'+esc(c.code)+'</span>' : '';
  const nrecTag = c.hasRecent ? '' : (c.lastDate ? '<span class="nrec" style="margin-left:6px" title="最終売上日">最終売上 '+esc(c.lastDate)+'</span>' : '<span class="nrec" style="margin-left:6px">取引なし</span>');
  let html='<div class="detail-head"><h2>'+esc(c.name)+codeTag+nrecTag+'</h2>'
    +'<div class="sum">該当商品 <b>'+c.productCount+'</b> 品／仕入先 <b>'+c.supplierCount+'</b> 社　'+supChips+'</div></div>'
    +'<div id="calcbarSlot"></div>';  // ← ここに転嫁ルールバーを差し込む（社名の下・提出済の上）
  // 提出（発行）状況
  const iss=ISSUED[c.name];
  if(iss){
    html+='<div class="issuednote">✅ <b>提出済み</b>　最終提出 '+esc(issuedShort(iss.lastIssuedAt))
      +(iss.quoteNo?'（見積No. '+esc(iss.quoteNo)+'）':'')+(iss.itemCount?' '+iss.itemCount+'品':'')+(iss.count>1?'　／　提出 '+iss.count+' 回':'')
      +'<button class="openq" data-name="'+esc(c.name)+'" onclick="openIssued(this.getAttribute(\\'data-name\\'))">📄 提出済の見積書を開く</button>'
      +'<button class="openq" data-name="'+esc(c.name)+'" onclick="mailResendFlow(this.getAttribute(\\'data-name\\'))" title="提出済みの見積書をPDF化してOutlookで開きます（再発行はしません）">📧 メールで再送</button>'
      +'<button class="un" data-name="'+esc(c.name)+'" onclick="unmarkIssued(this.getAttribute(\\'data-name\\'))">提出済みを取消</button></div>';
  } else {
    html+='<div class="notyet">未提出（この得意先はまだ見積書を発行していません）</div>';
  }
  // 📧 見積PDFのメール送信：得意先別アドレスを登録し、Outlookの作成画面（PDF添付済み）を開く。
  html+='<div class="mailbox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;padding:8px 10px;background:#f3f7fb;border:1px solid #d4e1ef;border-radius:8px">'
    +'<span style="font-weight:700;color:#1f4e78">📧 送信先メール</span>'
    +'<input id="custEmailInp" type="email" value="'+esc(CUST_EMAILS[c.name]||'')+'" placeholder="example@domain.co.jp" style="flex:1;min-width:200px;padding:5px 8px;border:1px solid #c7d6e4;border-radius:6px;font:inherit">'
    +'<button id="custEmailSave" class="go" style="background:#5b6b8b;padding:6px 12px">💾 保存</button>'
    +'<button id="mailQuoteBtn" class="go" style="background:#1f8a4c;padding:6px 14px;font-weight:700">📧 見積を作成してメール</button>'
    +'<span class="muted" style="flex-basis:100%;font-size:11px">この得意先だけ発行→PDF化→Outlookの作成画面（PDF添付済み）を開きます。送信ボタンはあなたが押します（会社PCのExcel/Outlookが必要）。</span>'
    +'</div>';
  if(c.reviewCount){
    html+='<div class="revnote">⚠ この得意先には「要確認」が '+c.reviewCount+' 件あります（価格異常・低一致で見積書から自動で外れる行）。'
      +'シミュレーション画面で内容を確認してください。</div>';
  }
  const lowN=lowMarginCount(c);
  if(lowN){
    html+='<div class="lowmnote">⚠ 低マージン '+lowN+' 件（改定後粗利率が '+lowMarginPct+'% 未満）。値上げ後も粗利が薄い行です。'
      +'行ルールや改定後売価を見直すと、表の「改定後粗利率」がオレンジから外れます。</div>';
  }
  const effN=effMissingCountLive(c);
  if(effN){
    html+='<div class="effnote" id="effNoteBanner">⚠ 実施日が未設定 '+effN+' 件（赤い欄）。<b>実施日は発行に必須</b>です。各行の実施日を入力するか、上の「実施日 一括」で統一してから発行してください。</div>';
  }
  html+='<div id="pendingNote" class="pending-note"'+(calcPending?' style="display:block"':'')+'>⚠ 未反映の変更があります（行ルール・まるめ・掛率など）。表の価格は「この設定で再計算」または「見積発行」のプレビューで反映・確認できます。</div>';
  let bulkRoundOpts='';
  for(const o of ROW_ROUND_SEL_OPTS){ if(o[0]) bulkRoundOpts+='<option value="'+esc(o[0])+'">'+esc(o[1])+'</option>'; }
  html+='<div class="bulkbar" id="bulkTargetBar">'
    +'<span class="bulkinfo">☑ 選択 <b id="cntTarget">0</b> 件</span>'
    +'<button class="bulkbtn hold" id="bulkHoldBtn" disabled>🤔 選択をまとめて検討中へ</button>'
    +'<button class="bulkbtn dormant" id="bulkDormantBtn" disabled>💤 選択をまとめて休眠へ</button>'
    +'<button class="bulkbtn manual" id="bulkManualBtn" disabled>✏ 選択をまとめて手動修正へ</button>'
    +'<select id="bulkRoundSel" style="padding:4px 6px;border:1px solid #c7d6e4;border-radius:6px;font-size:12px" title="選択行に適用するまるめ">'+bulkRoundOpts+'</select>'
    +'<button class="bulkbtn" id="bulkRoundBtn" disabled>まるめを選択行に適用</button>'
    +'<span class="muted">チェックした商品を検討中／手動修正へ／まるめ一括（反映は「再計算」）。右の発行ボタンは<b>チェックした品だけ</b>を見積にできます（無選択＝全対象）。</span>'
    +'<span id="exportOneSlot" style="margin-left:auto"></span>'
    +'</div>';
  html+='<div class="table-pad cust-main-pad"><table class="cust-compact cust-smart" id="custMainTbl"><thead><tr>'
    +'<th class="col-act">操作<br><label class="selall"><input type="checkbox" id="selAllTarget"> 全</label></th>'
    +'<th class="col-prod">商品</th>'
    +'<th class="col-cost">新仕入<span class="paren">（現）</span></th>'
    +'<th class="col-chg">仕入<br>改定</th>'
    +'<th class="col-sell">新売価/新粗利<span class="paren">（現売価/現粗利）</span></th>'
    +'<th class="col-schg">売価<br>改定</th>'
    +'<th class="col-rulemeta">行ルール<br>まるめ</th>'
    +'<th class="col-meta">実施日<br>備考</th>'
    +'</tr></thead><tbody>';
  for(const p of (c.products||[])){
    const costPct = pctNum(p.currentCost, p.newCost);
    const sellPct = pctNum(p.currentSell, p.newSell);
    const curM = marginRate(p.currentSell, p.currentCost);
    const newM = marginRate(p.newSell, p.newCost);
    const lowCls = isLowMargin(newM) ? ' lowmargin' : '';
    const effVal=(rowEff[p.rowKey]!=null)?String(rowEff[p.rowKey]):(p.effectiveDate||'');
    const effMan=(rowEff[p.rowKey]!=null&&String(rowEff[p.rowKey]).trim()!=='')||p.effManual;
    const effMiss=!isValidEffIso(normDateInputClient(effVal));
    const noteVal=(rowNote[p.rowKey]!=null)?String(rowNote[p.rowKey]):(p.note||'');
    html+='<tr>'
      +'<td class="actcell col-act"><input type="checkbox" class="selchk-target" data-key="'+esc(p.rowKey)+'" title="まとめて移動">'
      +' <button class="hold-btn" data-key="'+esc(p.rowKey)+'" title="検討中へ（あとで考えたい品を見積から一時除外）">🤔</button>'
      +' <button class="dormant-btn" data-key="'+esc(p.rowKey)+'" title="休眠へ（今は仕入れていない品を見積から除外。再照合しても残る）">💤</button>'
      +' <button class="manual-btn" data-key="'+esc(p.rowKey)+'" title="手動修正へ（照合できない品をツール外で直した記録）">✏</button></td>'
      +'<td class="prodcell col-prod"><div class="prodname">'+prodLink(c.name, p.supplier, p.productCode, p.productName)+'</div>'
      +'<div class="subline"><span class="sup-badge">'+esc(p.supplier)+'</span> <span class="pcode">'+esc(p.productCode||'')+'</span></div>'
      +'<div><button class="xquote-btn" data-key="'+esc(p.rowKey)+'" data-cust="'+esc(c.name)+'" data-name="'+esc(p.productName||'')+'" title="この商品を他の得意先にいくらで提出したか（発行済み）を一覧">📋 他社価格</button></div>'
      +lastSaleLine(p)+'</td>'
      +compactCostCell(p.currentCost, p.newCost)
      +compactChgCell(costPct)
      +compactSellCell(p, curM, newM, lowCls)
      +compactSellChgCell(costPct, sellPct)
      +'<td class="col-rulemeta"><div class="ruleline">'+rowRuleSelect(p)+'</div><div class="roundline">'+rowRoundSelect(p)+'</div></td>'
      +'<td class="datenote col-meta"><input class="cellinp effinp'+(effMan?' man':'')+(effMiss?' effmissing':'')+'" data-key="'+esc(p.rowKey)+'" value="'+esc(effVal)+'" placeholder="実施日" title="'+(effMiss?'実施日未設定（発行必須）':'実施日')+'">'
      +'<input class="cellinp noteinp'+(noteVal.trim()?' man':'')+'" data-key="'+esc(p.rowKey)+'" value="'+esc(noteVal)+'" placeholder="備考" title="見積書の備考列へ"></td>'
      +'</tr>';
  }
  html+='</tbody></table></div>';
  // 別枠：🤔 検討中／✏ 手動修正／✅ 提出済み
  html+=sectionHtml('🤔 検討中（あとで考えたい品・見積から一時除外）', c.holdProducts, 'hold');
  html+=sectionHtml('💤 休眠（今は仕入れていない品・見積から除外。再照合しても残る）', c.dormantProducts, 'dormant');
  html+=sectionHtml('✏ 手動修正（照合できずツール外で直す品）', c.manualProducts, 'manual');
  html+=sectionHtml('✅ 提出済み（発行したアイテム）', c.issuedProducts, 'issued');
  $('#detailCol').innerHTML=html;
  // 退避していた転嫁ルールバーを、社名の下のスロットへ差し込む（該当商品 と 提出済 の間）。
  const __slot=document.getElementById('calcbarSlot');
  if(__bar && __slot) __slot.appendChild(__bar);
  // 「○○だけ作成」ボタンを 一括バー（チェックして手動修正へ）の右端スロットへ差し込む。
  const __oneSlot=document.getElementById('exportOneSlot');
  if(oneBtn && __oneSlot) __oneSlot.appendChild(oneBtn);
  // 📧 メール送信先の保存／「見積を作成してメール」の配線（この得意先＝c.name）。
  const __emInp=document.getElementById('custEmailInp');
  const __emSave=document.getElementById('custEmailSave');
  if(__emSave && __emInp) __emSave.addEventListener('click', ()=>saveCustEmail(c.name, __emInp.value));
  if(__emInp) __emInp.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); saveCustEmail(c.name, __emInp.value); } });
  const __mailBtn=document.getElementById('mailQuoteBtn');
  if(__mailBtn) __mailBtn.addEventListener('click', ()=>mailQuoteFlow(c.name));
  // 「🤔 検討中へ」「✏ 手動修正へ」「↩ 対象へ戻す」の配線（1件ずつ）
  $('#detailCol').querySelectorAll('button.hold-btn').forEach(b=> b.addEventListener('click',()=> setItemState(b.getAttribute('data-key'),'hold')));
  $('#detailCol').querySelectorAll('button.dormant-btn').forEach(b=> b.addEventListener('click',()=> setItemState(b.getAttribute('data-key'),'dormant')));
  $('#detailCol').querySelectorAll('button.manual-btn').forEach(b=> b.addEventListener('click',()=>{
    const c=DATA.find(x=>x.name===selName);
    const p=findProductInCust(c,b.getAttribute('data-key'));
    setItemState(b.getAttribute('data-key'),'manual',p?productSnapshot(p):{});
  }));
  $('#detailCol').querySelectorAll('button.back-btn').forEach(b=> b.addEventListener('click',()=> setItemState(b.getAttribute('data-key'),'')));
  $('#detailCol').querySelectorAll('button.xquote-btn').forEach(b=> b.addEventListener('click',()=> openCrossQuotes(b.getAttribute('data-key'), b.getAttribute('data-cust'), b.getAttribute('data-name'))));
  // チェックボックスでまとめて移動（対象→検討中／対象→手動修正 ／ 各別枠→対象）の配線
  const bulkRoot = $('#detailCol');
  const BULK_GROUPS = [
    { cls:'selchk-hold',    cnt:'#cnt-hold',     btn:'#bulkBack-hold',     all:'#selAll-hold',    status:'', cross:'#bulkCross-hold',    crossStatus:'dormant' },
    { cls:'selchk-dormant', cnt:'#cnt-dormant',  btn:'#bulkBack-dormant',  all:'#selAll-dormant', status:'', cross:'#bulkCross-dormant', crossStatus:'hold' },
    { cls:'selchk-manual',  cnt:'#cnt-manual',   btn:'#bulkBack-manual',   all:'#selAll-manual',  status:'' },
    { cls:'selchk-issued',  cnt:'#cnt-issued',   btn:'#bulkBack-issued',   all:'#selAll-issued',  status:'' },
  ];
  function bulkUpdate(){
    const targetAll = bulkRoot.querySelectorAll('input.selchk-target');
    const targetN = bulkRoot.querySelectorAll('input.selchk-target:checked').length;
    const cntT=$('#cntTarget');
    if(cntT) cntT.textContent=targetN;
    // 「○○だけ作成」ボタンの表示を選択状況に合わせる（チェックがあれば『選択N品だけ見積』＝挙動を見える化）。
    const oneBtn=document.getElementById('exportOneBtn');
    if(oneBtn && selName){
      const nm = selName.length>12?selName.slice(0,12)+'…':selName;
      oneBtn.textContent = targetN>0 ? ('📄 選択 '+targetN+' 品だけ見積') : ('📄 「'+nm+'」だけ作成');
    }
    const hb=$('#bulkHoldBtn'), mb=$('#bulkManualBtn'), db=$('#bulkDormantBtn');
    if(hb) hb.disabled=!targetN;
    if(mb) mb.disabled=!targetN;
    if(db) db.disabled=!targetN;
    const saT=$('#selAllTarget');
    if(saT) saT.checked=targetAll.length>0 && targetN===targetAll.length;
    for(const g of BULK_GROUPS){
      const all = bulkRoot.querySelectorAll('input.'+g.cls);
      const n = bulkRoot.querySelectorAll('input.'+g.cls+':checked').length;
      const cnt=$(g.cnt), btn=$(g.btn), sa=$(g.all);
      if(cnt) cnt.textContent=n;
      if(btn) btn.disabled=!n;
      const cb=g.cross&&$(g.cross); if(cb) cb.disabled=!n; // 検討中⇄休眠 の付け替えボタンも選択数で活性
      if(sa) sa.checked = all.length>0 && n===all.length;
    }
    const tn=bulkRoot.querySelectorAll('input.selchk-target:checked').length;
    const br=$('#bulkRoundBtn'); if(br) br.disabled=!tn;
  }
  const bulkRoundBtn=$('#bulkRoundBtn');
  if(bulkRoundBtn) bulkRoundBtn.addEventListener('click',()=>{
    const keys=Array.from(bulkRoot.querySelectorAll('input.selchk-target:checked')).map(c=>c.getAttribute('data-key')).filter(Boolean);
    const v=($('#bulkRoundSel')||{}).value||'';
    if(!keys.length||!v) return;
    for(const k of keys) rowRound[k]=v;
    bulkRoot.querySelectorAll('select.rowround-sel').forEach(sel=>{
      const k=sel.getAttribute('data-key');
      if(keys.indexOf(k)>=0){ sel.value=v; sel.classList.add('ov'); }
    });
    markCalcPending();
  });
  bulkRoot.querySelectorAll('input.selchk-target, input.selchk-hold, input.selchk-dormant, input.selchk-manual, input.selchk-issued').forEach(c=> c.addEventListener('change', bulkUpdate));
  const saTarget=$('#selAllTarget');
  if(saTarget) saTarget.addEventListener('change',()=>{ bulkRoot.querySelectorAll('input.selchk-target').forEach(c=>{c.checked=saTarget.checked;}); bulkUpdate(); });
  const hb=$('#bulkHoldBtn');
  if(hb) hb.addEventListener('click',()=> bulkMove('selchk-target','hold'));
  const mb=$('#bulkManualBtn');
  if(mb) mb.addEventListener('click',()=> bulkMove('selchk-target','manual'));
  const db=$('#bulkDormantBtn');
  if(db) db.addEventListener('click',()=> bulkMove('selchk-target','dormant'));
  for(const g of BULK_GROUPS){
    const sa=$(g.all);
    if(sa) sa.addEventListener('change',()=>{ bulkRoot.querySelectorAll('input.'+g.cls).forEach(c=>{c.checked=sa.checked;}); bulkUpdate(); });
    const btn=$(g.btn);
    if(btn) btn.addEventListener('click',()=> bulkMove(g.cls, g.status));
    const cb=g.cross&&$(g.cross);
    if(cb) cb.addEventListener('click',()=> bulkMove(g.cls, g.crossStatus)); // 検討中→休眠 / 休眠→検討中 の一括付け替え
  }
  // 行まるめ：変更はローカルに保持し、再計算ボタンで一括反映（毎回 load しない＝軽い）
  $('#detailCol').querySelectorAll('select.rowround-sel').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const k=sel.getAttribute('data-key');
      const v=sel.value||'';
      if(!v) delete rowRound[k]; else rowRound[k]=v;
      sel.classList.toggle('ov', !!v);
      markCalcPending();
    });
  });
  // 行ごと掛率：ローカル保持のみ（再計算・見積発行プレビューで反映）。
  $('#detailCol').querySelectorAll('input.rowfactor').forEach(inp=> bindOneRowFactor(inp));
  // 行ルール：ローカル保持のみ（毎回 load しない。見積発行プレビューで価格確認）。
  $('#detailCol').querySelectorAll('select.rowrule:not(.rowround-mode)').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const k=sel.getAttribute('data-key');
      if(sel.value) rowRules[k]=sel.value; else delete rowRules[k];
      sel.classList.toggle('ov', !!sel.value);
      // 目標粗利率に切替えた行は、表示中の率（既定＝全体の目標粗利率%）を明示的に確定させる。
      //  全体ルールが目標粗利率以外だと「全体factor」は掛率なので、シードしないと率が伝わらないため。
      if(sel.value==='target_margin_rate' && (rowFactor[k]==null||rowFactor[k]==='')){
        const gm=parseFloat(($('#cMargin')||{}).value); if(Number.isFinite(gm)&&gm>0) rowFactor[k]=gm;
      }
      refreshRowFactorSlot(sel);
      markCalcPending();
      if(lastApplied) showApplied(lastApplied);
    });
  });
  // 改定後売価 の直接入力 → 手入力の固定価格として保存し再計算（空ならルール計算に戻す）
  $('#detailCol').querySelectorAll('input.sellinp').forEach(inp=>{
    inp.addEventListener('change',()=>{
      const k=inp.getAttribute('data-key'); const v=inp.value.trim();
      if(v==='') delete rowSell[k]; else rowSell[k]=v;
      load(true);
    });
  });
  // 実施日：ローカル保持（blur で日付正規化）。再計算・発行時に rowEff を送る。
  $('#detailCol').querySelectorAll('input.effinp').forEach(inp=>{
    const syncEff=(doNorm)=>{
      const k=inp.getAttribute('data-key');
      let v=inp.value;
      if(doNorm){ v=normDateInputClient(v); inp.value=v; }
      if(v.trim()==='') delete rowEff[k]; else rowEff[k]=v;
      inp.classList.toggle('man', v.trim()!=='');
      updateEffUi();
      if(doNorm) markCalcPending();
      if(lastApplied) showApplied(lastApplied);
    };
    inp.addEventListener('input',()=>syncEff(false));
    inp.addEventListener('blur',()=>syncEff(true));
  });
  // 備考：ローカルに保持のみ（再計算・発行時に calcOpts.rowNote で送る）。入力のたびに load しない＝連続入力しやすく。
  $('#detailCol').querySelectorAll('input.noteinp').forEach(inp=>{
    const syncNote=()=>{
      const k=inp.getAttribute('data-key'); const v=inp.value;
      if(v.trim()==='') delete rowNote[k]; else rowNote[k]=v;
      inp.classList.toggle('man', v.trim()!=='');
      if(lastApplied) showApplied(lastApplied);
    };
    inp.addEventListener('input', syncNote);
  });
  syncCustStickyTop();
}
// ===== 見積書 出力（このページから）＝発行前に要確認をチェックするゲート付き =====
let gateOpts=null;
function setExpBusy(b){ $('#exportAllBtn').disabled=b; $('#exportOneBtn').disabled = b || !selName; if(b) showExportMsg('処理中…'); }
function showExportMsg(t,isErr){ const m=$('#exportMsg'); m.textContent=t||''; m.style.color=isErr?'#c0392b':'#1f6b35'; }
// 対象表でチェックされた商品の rowKey 一覧（『選択した商品だけ見積』用）。0件＝全対象を見積（従来どおり）。
function selectedTargetKeys(){
  return Array.from(document.querySelectorAll('#detailCol input.selchk-target:checked')).map(c=>c.getAttribute('data-key')).filter(Boolean);
}
function exportFlow(scope){
  if(scope==='one' && !selName){ showExportMsg('先に左の一覧で得意先を選んでください',true); return; }
  const opts=Object.assign(calcOpts(),{scope, customer: scope==='one'?selName:null});
  // 得意先1件の発行で、対象表のチェックがあれば「その商品だけ」を見積にする（0件＝全対象＝従来どおり）。
  if(scope==='one'){ const keys=selectedTargetKeys(); if(keys.length) opts.onlyRowKeys=keys; }
  setExpBusy(true);
  fetch('/api/customers-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:'check'},opts))})
    .then(x=>x.json()).then(res=>{
      setExpBusy(false); showExportMsg('');
      if(res.error){ showExportMsg('エラー: '+res.error,true); return; }
      openGate(res,opts); // 要確認の有無にかかわらず、まずプレビューを表示してから発行
    }).catch(e=>{ setExpBusy(false); showExportMsg('通信失敗: '+(e&&e.message||e),true); });
}
function openGate(res,opts){
  gateOpts=opts;
  const who=opts.scope==='all'?'全得意先':opts.customer;
  const hasReview=res.reviewCount>0;
  const missEff=res.missingEffCount||0;
  // 実施日が未設定の対象があるあいだは発行できない（実施日は必須）。
  const canIssue=res.issuableRowCount>0 && missEff===0;
  $('#gateTitle').textContent=who+' の発行プレビュー ― '+res.issuableCustomerCount+'得意先 / '+res.issuableRowCount+'品'+(hasReview?'（要確認 '+res.reviewCount+'件は除外）':'');
  if(missEff>0){
    $('#gateNote').innerHTML='<b style="color:#c0392b">⚠ 実施日が未設定の商品が '+missEff+' 件あります。実施日は発行に必須です。</b><br>'
      +'「戻る」で表に戻り、赤い実施日欄を入力（または上の「実施日 一括」で統一）してから、もう一度この画面を開いて発行してください。';
  } else if(!canIssue){
    $('#gateNote').innerHTML='発行できる明細がありません'+(hasReview?'（'+res.reviewCount+'件すべてが要確認のため除外）':'')+'。「戻る」で設定や紐付けを見直してください。';
  } else {
    $('#gateNote').innerHTML='以下が<b>見積書に出力される内容</b>です（得意先ごとに1枚）。確認して問題なければ下の「'+(hasReview?'要確認を除外して発行':'この内容で発行')+'」を押してください。'
      +(hasReview?' 価格異常・低一致の <b>'+res.reviewCount+'</b> 件は見積書に載りません（下部の「要確認」一覧）。':'');
  }
  let body='';
  // ⓪ 実施日が未設定（必須）の一覧 ― あれば発行ブロック。最初に目立たせる。
  if(missEff>0){
    body+='<div class="pv-sec-rev" style="background:#fdecea;color:#922b21">⚠ 実施日が未設定（発行に必須）'+missEff+'件</div>';
    body+='<table><thead><tr><th>得意先</th><th>仕入先</th><th>商品コード</th><th>商品名</th></tr></thead><tbody>';
    for(const r of (res.missingEff||[])){
      body+='<tr class="price"><td>'+esc(r.customer)+'</td><td><span class="sup-badge">'+esc(r.supplier)+'</span></td>'
        +'<td class="pcode">'+esc(r.productCode||'')+'</td><td>'+esc(r.productName)+'</td></tr>';
    }
    body+='</tbody></table>';
    if((res.missingEff||[]).length<missEff) body+='<div class="muted" style="padding:8px">…ほか '+(missEff-res.missingEff.length)+' 件</div>';
  }
  // ① プレビュー（実際に発行される内容）
  for(const c of (res.preview||[])){
    body+='<div class="pv-cust"><div class="pv-head">'+esc(c.customer)+' <span class="pv-cnt">'+c.productCount+'品</span></div>';
    body+='<table><thead><tr><th>仕入先</th><th>商品コード</th><th>商品名</th><th class="num">現売価</th><th class="num">改定後売価</th><th>実施日</th><th>備考</th></tr></thead><tbody>';
    for(const r of c.rows){
      body+='<tr><td><span class="sup-badge">'+esc(r.supplier)+'</span></td><td class="pcode">'+esc(r.productCode||'')+'</td><td>'+prodLink(c.customer, r.supplier, r.productCode, r.productName)+'</td>'
        +'<td class="num">'+yen(r.currentSell)+'</td><td class="num">'+yen(r.newSell)+'</td>'
        +'<td>'+esc(r.effectiveDate||'')+'</td><td>'+esc(r.note||'')+'</td></tr>';
    }
    body+='</tbody></table></div>';
  }
  if(res.previewTruncated) body+='<div class="muted" style="padding:8px">…プレビュー表示は一部のみ（得意先数が多いため）。発行は全 '+res.issuableCustomerCount+' 得意先に対して行われます。</div>';
  // ② 要確認（発行から除外）
  if(hasReview){
    body+='<div class="pv-sec-rev">⚠ 要確認（発行から除外）'+res.reviewCount+'件</div>';
    body+='<table><thead><tr><th>得意先</th><th>仕入先</th><th>商品名</th><th class="num">現単価</th><th class="num">改定単価</th><th>理由</th></tr></thead><tbody>';
    for(const r of res.review){
      const cls=r.reasonType==='price'?'price':'match';
      body+='<tr class="'+cls+'"><td>'+esc(r.customer)+'</td>'
        +'<td><span class="sup-badge">'+esc(r.supplier)+'</span></td>'
        +'<td>'+esc(r.productName)+(r.makerName?'<div class="muted">メーカー: '+esc(r.makerName)+'</div>':'')+'</td>'
        +'<td class="num">'+yen(r.currentSell)+'</td><td class="num">'+yen(r.newSell)+'</td>'
        +'<td>'+esc(r.reason)+'</td></tr>';
    }
    body+='</tbody></table>';
    if(res.review.length<res.reviewCount) body+='<div class="muted" style="padding:8px">…ほか '+(res.reviewCount-res.review.length)+' 件（表示は先頭'+res.review.length+'件）</div>';
  }
  $('#gateBody').innerHTML=body;
  $('#gateSummary').textContent='発行: '+res.issuableCustomerCount+' 得意先 / '+res.issuableRowCount+' 品'+(hasReview?'　／　除外（要確認）: '+res.reviewCount+' 件':'');
  const issueBtn=$('#gateIssue');
  issueBtn.textContent=missEff>0?'実施日を入力してください（発行不可）':(hasReview?'要確認を除外して発行':'この内容で発行');
  issueBtn.disabled=!canIssue;
  $('#gateOverlay').classList.add('show');
}
function closeGate(){ $('#gateOverlay').classList.remove('show'); }
// PDF作成中の全画面ロック。照合中と同じオーバーレイ(#shogoLockOverlay)を、ポーリング無しで
//  メール処理の間だけ表示する＝ページ移動・操作を防ぐ（Excel COMでサーバが同期ブロックするため）。
//  off時は照合ロックの既定文言へ戻す（後で本物の照合ロックが正しく表示されるように）。
function setMailBusy(on){
  const ov=document.getElementById('shogoLockOverlay'); if(!ov) return;
  const t=document.getElementById('shogoLockTitle'), m=document.getElementById('shogoLockMsg');
  if(on){ if(t)t.textContent='📧 見積PDFを作成中'; if(m)m.textContent='PDF化してOutlookを起動しています…完了まで操作しないでください（ページを移動しないでください）'; }
  else { if(t)t.textContent='↻ 照合を実行中'; if(m)m.textContent='完了まで操作できません（1〜2分かかることがあります）'; }
  ov.classList.toggle('on',!!on);
  document.body.classList.toggle('shogo-lock-busy',!!on);
}
// 得意先別 送信先メールを保存（空で削除）。
function saveCustEmail(name, email){
  const addr=String(email||'').trim();
  fetch('/api/customer-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:name,email:addr})})
    .then(x=>x.json()).then(res=>{
      if(!res.ok){ showExportMsg('メール保存に失敗: '+(res.error||''),true); return; }
      CUST_EMAILS=res.emails||CUST_EMAILS;
      showExportMsg(addr?('📧 送信先メールを保存しました（'+name+'）'):('📧 送信先メールを削除しました（'+name+'）'));
    }).catch(e=>showExportMsg('通信失敗: '+(e&&e.message||e),true));
}
// 選択中の得意先1件を「発行→PDF化→Outlook作成画面」まで一気に行う（送信は人が押す）。
function mailQuoteFlow(name){
  if(!name){ showExportMsg('得意先が選択されていません',true); return; }
  const inp=document.getElementById('custEmailInp');
  const email=inp?String(inp.value||'').trim():String(CUST_EMAILS[name]||'').trim();
  const selKeys=selectedTargetKeys(); // チェックがあればその商品だけを見積にする（メール発行も同じ挙動に揃える）
  const warn=email?'':'\\n\\n※ 送信先メール未登録です（Outlookの宛先は空で開きます。あとで手入力できます）。';
  const pick=selKeys.length?('\\n\\n（チェックした '+selKeys.length+' 品だけを見積にします）'):'';
  if(!confirm('「'+name+'」の見積を発行し、PDF化してOutlookの作成画面を開きます。\\n（送信ボタンはあなたが押します）'+pick+warn+'\\n\\nよろしいですか？')) return;
  if(email && CUST_EMAILS[name]!==email) saveCustEmail(name, email); // 入力中のアドレスは保存もしておく
  const opts=Object.assign(calcOpts(),{customer:name, email});
  if(selKeys.length) opts.onlyRowKeys=selKeys;
  setExpBusy(true); setMailBusy(true); showExportMsg('PDF化してOutlookを起動中…');
  fetch('/api/mail-quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(opts)})
    .then(x=>x.json()).then(res=>{
      setExpBusy(false); setMailBusy(false);
      if(!res.ok){
        if(res.reason==='missing_eff'){ showExportMsg(res.message||'実施日が未設定の商品があります。',true); if(selName) load(); return; }
        // 発行は成功・PDF/Outlookだけ失敗（res.issued）：提出済み状態を正しく反映してから失敗を知らせる。
        if(res.issued && res.issuedCustomers && res.issuedCustomers.length){
          const now=new Date().toISOString();
          for(const nm of res.issuedCustomers){ const prev=ISSUED[nm]||{}; ISSUED[nm]={lastIssuedAt:now,count:(prev.count||0)+1,quoteNo:res.quoteNo||prev.quoteNo||'',itemCount:res.itemCount||prev.itemCount||0,folder:res.folderName||''}; }
          loadIssueLog().then(()=>load());
        }
        showExportMsg(res.error||res.message||'メール作成に失敗しました',true); return;
      }
      // 発行済みになったので提出履歴を更新（doIssue と同様）。別枠移動は load() の再取得で反映。
      if(res.issuedCustomers && res.issuedCustomers.length){
        const now=new Date().toISOString();
        for(const nm of res.issuedCustomers){ const prev=ISSUED[nm]||{}; ISSUED[nm]={lastIssuedAt:now,count:(prev.count||0)+1,quoteNo:res.quoteNo||prev.quoteNo||'',itemCount:res.itemCount||prev.itemCount||0,folder:res.folderName||''}; }
      }
      const toMsg=res.to?('宛先 '+res.to):'宛先は空（Outlookで入力してください）';
      showExportMsg('📧 Outlookの作成画面を開きました（'+name+'：'+toMsg+'／PDF '+(res.pdf||'')+'）。内容を確認して送信してください。');
      loadIssueLog().then(()=>load());
    }).catch(e=>{ setExpBusy(false); setMailBusy(false); showExportMsg('通信失敗: '+(e&&e.message||e),true); });
}
// 提出済みの得意先を「再送」：再発行せず、提出済みxlsxからPDF化→Outlookを開く。
function mailResendFlow(name){
  if(!name){ showExportMsg('得意先が選択されていません',true); return; }
  const inp=document.getElementById('custEmailInp');
  const email=inp?String(inp.value||'').trim():String(CUST_EMAILS[name]||'').trim();
  const warn=email?'':'\\n\\n※ 送信先メール未登録です（Outlookの宛先は空で開きます。あとで手入力できます）。';
  if(!confirm('「'+name+'」の提出済み見積書をPDF化してOutlookで開きます（再発行はしません）。'+warn+'\\n\\nよろしいですか？')) return;
  if(email && CUST_EMAILS[name]!==email) saveCustEmail(name, email);
  setExpBusy(true); setMailBusy(true); showExportMsg('PDF化してOutlookを起動中…');
  fetch('/api/mail-quote-resend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:name, email})})
    .then(x=>x.json()).then(res=>{
      setExpBusy(false); setMailBusy(false);
      if(!res.ok){ showExportMsg(res.error||'再送に失敗しました',true); return; }
      const toMsg=res.to?('宛先 '+res.to):'宛先は空（Outlookで入力してください）';
      showExportMsg('📧 Outlookの作成画面を開きました（再送 '+name+'：'+toMsg+'／PDF '+(res.pdf||'')+'）。内容を確認して送信してください。');
    }).catch(e=>{ setExpBusy(false); setMailBusy(false); showExportMsg('通信失敗: '+(e&&e.message||e),true); });
}
function doIssue(opts){
  setExpBusy(true);
  fetch('/api/customers-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:'issue'},opts))})
    .then(x=>x.json()).then(res=>{
      setExpBusy(false); showExportMsg('');
      if(!res.ok){
        // 実施日未設定など、サーバ側で発行をブロックした場合はメッセージを出してゲートは閉じない（戻って直せる）。
        if(res.reason==='missing_eff'){ showExportMsg(res.message||'実施日が未設定の商品があります。',true); if(selName) load(); return; }
        closeGate(); showExportMsg('発行に失敗: '+(res.message||res.error||''),true); return;
      }
      closeGate();
      // 提出履歴を更新（今回提出した得意先に「✅ 提出済」を付ける）
      if(res.issuedCustomers && res.issuedCustomers.length){
        const now=new Date().toISOString();
        for(const nm of res.issuedCustomers){ const prev=ISSUED[nm]||{}; ISSUED[nm]={lastIssuedAt:now,count:(prev.count||0)+1,quoteNo:prev.quoteNo||'',itemCount:prev.itemCount||0,folder:res.folderName||''}; }
        renderList(); if(selName) selectCust(selName);
      }
      loadIssueLog().then(()=>load()); // 履歴更新＋顧客データ再取得（発行したアイテムを「提出済み」別枠へ移す）
      showResult(res);
    }).catch(e=>{ setExpBusy(false); showExportMsg('発行に失敗: '+(e&&e.message||e),true); });
}
function showResult(res){
  const who=res.scope==='all'?'全得意先':res.customer;
  const el=$('#exportResult'); el.style.display='block';
  el.innerHTML='<div class="ok-banner"><b>✓ 見積書を発行しました</b>（'+esc(who)+'）　'
    +res.count+' 件 ／ フォルダ: '+esc(res.folderName)
    +(res.reviewCount?'　／ 要確認 '+res.reviewCount+' 件は「'+esc(res.reviewFile||'要確認')+'」に控え':'')
    +' <button id="openFolderBtn">📁 フォルダを開く</button></div>';
  const b=document.getElementById('openFolderBtn');
  if(b) b.addEventListener('click',()=>{ fetch('/api/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:res.folder})}).catch(()=>{}); });
}

// 起動時：メインページと同じ既定値を settings.json から読んでカスタマイズ操作に反映
async function initControls(){
  // 見積の抽出期間（表示期間）は前回この PC で選んだ値を復元する（既定は過去1年）。loadSummary より前に設定。
  try{ const rv=localStorage.getItem('recentYears'); if(rv!==null && $('#recentYears')) $('#recentYears').value=rv; }catch(e){}
  try{
    const r=await fetch('/api/settings').then(x=>x.json());
    const s=r&&r.settings?r.settings:{};
    const df=s.default||{}; const rd=s.rounding||{}; const up=s.selfCostUplift||{};
    if(df.type) $('#cRule').value=df.type;
    // factor は枠の共有：目標粗利率(target_margin_rate)なら%として #cMargin、それ以外は掛率として #cFactor へ。
    if(df.factor!=null){ if(df.type==='target_margin_rate') $('#cMargin').value=df.factor; else $('#cFactor').value=df.factor; }
    // まるめ：桁＝ラジオ、処理＝ドロップダウン（「全体」＝⚙設定の端数処理）
    const u=String((rd.unit!=null)?rd.unit:0.01);
    const md=(rd.mode==='floor'||rd.mode==='ceil')?rd.mode:'round';
    $('#cPolicyRoundMode').value=md;
    document.querySelectorAll('input[name="cRoundUnit"]').forEach(r=>{ r.checked=(r.value===u); });
    $('#cRoundMode').value='';
    if(up.rate!=null) $('#cUplift').value=up.rate;
    // 価格帯別ルールの「それ以上」既定を、全体ルールに合わせて初期化（帯はOFFが既定）。
    priceBands=[{max:null, rule:(df.type||'add_increase'), factor:(df.factor!=null?Number(df.factor):1.25)}];
  }catch(e){/* 既定のHTML値のまま */}
  toggleFactor();
  renderBands();
}

$('#reloadBtn').addEventListener('click',async()=>{
  await loadIssueLog();
  await loadSummary();
  if(selName && DATA.find(x=>x.name===selName)) await selectCust(selName);
});
$('#recalcBtn').addEventListener('click',()=>load(true));
// 左の得意先一覧の開閉（右の明細を広く使う）
$('#toggleListBtn').addEventListener('click',()=>{
  const wrap=document.querySelector('.wrap');
  const collapsed=wrap.classList.toggle('list-collapsed');
  $('#toggleListBtn').textContent = collapsed ? '▶ 一覧を表示' : '◀ 一覧を隠す';
});
// 低マージン警告のしきい値変更 → 再計算不要（粗利率はクライアントで算出）。表示だけ即更新。
$('#cLowMargin').addEventListener('input',()=>{
  const v=parseFloat($('#cLowMargin').value); lowMarginPct = isNaN(v) ? 15 : v;
  renderList(); if(selName) selectCust(selName);
});
$('#reloadPolicyBtn').addEventListener('click', async ()=>{
  await initControls();
  if(selName) await load(true);
  else await loadSummary();
}); // メインの全体方針を取り込み直す
// 価格帯別ルールのON/OFF：ONで帯エディタ表示＋単体ルールを無効化（帯が全体を支配）、OFFで従来の単体ルール。
$('#cBandOn').addEventListener('change',()=>{
  const on=bandsEnabled();
  $('#bandBox').style.display = on?'':'none';
  // 価格帯別ならまず「〜100円まで」を1本用意（キャッチオール=それ以上 だけだと単体ルールと同じで意味が無いため）。
  // 価格は変えない＝それ以上と同じルール/掛率で初期化し、ユーザが編集して初めて差が出る。
  if(on && priceBands.length===1 && priceBands[0].max==null){
    const c=priceBands[0];
    priceBands.unshift({max:100, rule:c.rule||'add_increase', factor:(c.factor!=null?c.factor:1.25)});
  }
  // 価格帯別ONなら 単体の「転嫁ルール／掛率」は隠す（指定場所を帯に一本化＝効いていないのに見える混乱を防ぐ）
  $('#cRuleFld').style.display = on?'none':'';
  if(on){ $('#cFactorBox').style.display='none'; if($('#cMarginBox')) $('#cMarginBox').style.display='none'; } else toggleFactor();
  $('#cBandFld').querySelector('label').style.color = on?'#1f6fb2':'';
  if(on) renderBands();
  load(true);
});
$('#search').addEventListener('input',applyFilter);
$('#recentYears').addEventListener('change',applyFilter);
$('#resetIssuedBtn').addEventListener('click',resetAllIssued);
$('#issuedListBtn').addEventListener('click',openIssuedList);
$('#manualListBtn').addEventListener('click',openManualList);
$('#manualListClose').addEventListener('click',closeManualList);
$('#manualListClose2').addEventListener('click',closeManualList);
$('#manualListOverlay').addEventListener('click',e=>{ if(e.target===$('#manualListOverlay')) closeManualList(); });
$('#manualListSearch').addEventListener('input',()=>{
  if(MANUAL_LIST_DATA) renderManualList(MANUAL_LIST_DATA, $('#manualListSearch').value);
});
$('#issuedListClose').addEventListener('click',closeIssuedList);
$('#issuedListClose2').addEventListener('click',closeIssuedList);
$('#issuedListOverlay').addEventListener('click',e=>{ if(e.target===$('#issuedListOverlay')) closeIssuedList(); });
$('#xqClose').addEventListener('click',closeCrossQuotes);
$('#xqClose2').addEventListener('click',closeCrossQuotes);
$('#xqOverlay').addEventListener('click',e=>{ if(e.target===$('#xqOverlay')) closeCrossQuotes(); });
$('#issuedListSearch').addEventListener('input',()=>{
  if(ISSUED_LIST_DATA) renderIssuedList(ISSUED_LIST_DATA, $('#issuedListSearch').value);
});
$('#exportAllBtn').addEventListener('click',()=>exportFlow('all'));
$('#exportOneBtn').addEventListener('click',()=>exportFlow('one'));
// 基幹システム取込CSV（単価履歴／仕入原価）のダウンロードは sim 画面の「📅 実施日カレンダー」へ移動した。
$('#gateClose').addEventListener('click',closeGate);
$('#gateBack').addEventListener('click',closeGate);
$('#gateIssue').addEventListener('click',()=>{ if(gateOpts) doIssue(gateOpts); });
$('#gateOverlay').addEventListener('click',e=>{ if(e.target===$('#gateOverlay')) closeGate(); });
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  if($('#xqOverlay').classList.contains('show')) closeCrossQuotes();
  else if($('#manualListOverlay').classList.contains('show')) closeManualList();
  else if($('#issuedListOverlay').classList.contains('show')) closeIssuedList();
  else if($('#gateOverlay').classList.contains('show')) closeGate();
});
// 転嫁ルールは即再計算（価格が一括で変わるため）。まるめ・掛率・自社%・一括実施日は再計算ボタンまで保留。
$('#cRule').addEventListener('change',()=>{ toggleFactor(); load(true); });
document.querySelectorAll('input[name="cRoundUnit"]').forEach(r=> r.addEventListener('change',markCalcPending));
$('#cRoundMode').addEventListener('change',markCalcPending);
['#cFactor','#cMargin','#cUplift','#cEff'].forEach(sel=>{
  const el=$(sel);
  el.addEventListener('change',markCalcPending);
  el.addEventListener('keydown',e=>{ if(e.key==='Enter') markCalcPending(); });
});
(async()=>{
  await initShogoLockWatch();
  await Promise.all([initControls(), loadIssueLog(), loadCustomerEmails()]);
  await loadSummary();
  // メイン表の得意先リンク（/customers?customer=...）で来たら、その得意先を選択して表示。
  try{
    const want=new URLSearchParams(location.search).get('customer');
    if(want){
      if(DATA.find(x=>x.name===want)){
        await selectCust(want);
        const sel=$('#listCol .cust.sel'); if(sel) sel.scrollIntoView({block:'center'});
      } else {
        $('#msg').textContent='「'+want+'」は現在の改定対象に見つかりませんでした（実施日・照合の結果に含まれていない可能性）。';
      }
    }
  }catch(e){}
})();
</script>
</body></html>`;

module.exports = { CUSTOMERS_PAGE };
