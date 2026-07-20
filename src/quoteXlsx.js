// =====================================================================
//  提出用 見積書（得意先向け）の .xlsx ライター
//  タイトル / 見積番号・発行日 / 得意先「御中」/ 会社情報 / あいさつ文
//  ＋ 明細表（商品コード / 商品名 / 現行単価 / 改定単価 / 実施日 / 備考）
//  ※ 実施日は商品ごと。仕入原価・粗利率・値上額・値上率は載せない（得意先向け）。
//  ※ 商品コード=自社商品コード。空のときは空欄（先頭ゼロ保持のため文字列で出力）。
//  共通部品は xlsxutil.js。
// =====================================================================
const fs = require('fs');
const { esc, colLetter, zip } = require('./xlsxutil');

// ---- 固定XMLパーツ ---------------------------------------------------
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

// numFmt: 164=#,##0.## (単価)
// fonts: 0=既定11 1=タイトル18B 2=得意先14B 3=会社12B 4=小10 5=ヘッダ11B白 6=脚注10灰
// fills: 0=なし 1=gray125 2=濃紺(ヘッダ) 3=薄橙(未使用・旧改定単価)
// borders: 0=なし 1=細罫 2=下太罫(得意先下線)
// cellXfs: 0既定 1タイトル 2得意先 3右小(番号/日付) 4会社名右 5会社情報右 6あいさつ
//          7表ヘッダ 8文字セル 9中央セル 10数値 11数値(改定・塗りなし) 12脚注 13品目数右
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.##"/></numFmts><fonts count="7"><font><sz val="11"/><name val="メイリオ"/></font><font><b/><sz val="18"/><name val="メイリオ"/></font><font><b/><sz val="14"/><name val="メイリオ"/></font><font><b/><sz val="12"/><name val="メイリオ"/></font><font><sz val="10"/><name val="メイリオ"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="メイリオ"/></font><font><sz val="10"/><color rgb="FF808080"/><name val="メイリオ"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/></patternFill></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border><border><left/><right/><top/><bottom style="medium"><color rgb="FF1F4E78"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="14"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="5" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf></cellXfs></styleSheet>`;

const COLS = [
  { w: 14 },  // A 商品コード
  { w: 44 },  // B 商品名
  { w: 13 },  // C 現行単価
  { w: 13 },  // D 改定単価
  { w: 15 },  // E 実施日
  { w: 26 },  // F 備考
];

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

// セル生成ヘルパ
function tCell(ref, style, value) {
  if (value === undefined || value === null || value === '') return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}
function nCell(ref, style, value) {
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}"/>`;
}

// 脚注（フッター）の行高を内容から概算する。固定だと長文・複数行で下が隠れるため。
//  A:F 結合幅(125)から余白を引いた1行ぶんの収容幅で、各行の折り返し本数を見積もって合算する。
//  全角=2・半角=1 で幅を数え、隠れるより少し高め（過大評価寄り）に出す。
function footerHeight(text) {
  const USABLE = 110;      // 1行に入る半角換算の目安（結合幅125 − 余白、安全側に小さめ）
  const PT_PER_LINE = 15;  // メイリオ10pt 1行ぶんの高さ目安(pt)
  let visual = 0;
  String(text).split('\n').forEach((ln) => {
    let w = 0; for (const ch of ln) w += (ch.codePointAt(0) > 0xFF ? 2 : 1);
    visual += Math.max(1, Math.ceil(w / USABLE));
  });
  return Math.max(40, visual * PT_PER_LINE + 8);
}

// rows: [{ productCode, productName, currentSell, newSell, effectiveDate, note }]
//  列：A 商品コード / B 商品名 / C 現行単価 / D 改定単価 / E 実施日 / F 備考（No列は廃止）
function buildSheet(customer, rows, opt) {
  const c = opt.company || {};
  const q = opt.quote || {};
  const addr = [c.postal, c.address].filter(Boolean).join(' ');
  const contact = [c.tel, c.fax].filter(Boolean).join('　');

  const HEADER_ROW = 8;
  const firstItem = HEADER_ROW + 1;
  const lastItem = HEADER_ROW + rows.length;
  const countRow = (rows.length ? lastItem : HEADER_ROW) + 1;
  const footerRow = countRow + 2;

  let sd = '<sheetData>';
  // 1: タイトル
  sd += `<row r="1" ht="30" customHeight="1">${tCell('A1', 1, q.title || '御 見 積 書')}${empties('B1','F1',1)}</row>`;
  // 2: 見積番号・発行日（右）
  const headRight = [opt.quoteNo ? ('見積No. ' + opt.quoteNo) : '', opt.date ? ('発行日: ' + opt.date) : ''].filter(Boolean).join('　　');
  sd += `<row r="2">${tCell('D2', 3, headRight)}${tCell('E2', 3, '')}${tCell('F2', 3, '')}</row>`;
  // 3: 得意先 御中（左・下線） / 会社名（右）
  sd += `<row r="3" ht="22" customHeight="1">${tCell('A3', 2, (customer || '') + '　御中')}${tCell('B3', 2, '')}${tCell('C3', 2, '')}${tCell('D3', 4, c.name || '')}${tCell('E3', 4, '')}${tCell('F3', 4, '')}</row>`;
  // 4: 住所（右）
  sd += `<row r="4">${tCell('D4', 5, addr)}${tCell('E4', 5, '')}${tCell('F4', 5, '')}</row>`;
  // 5: 連絡先（右）
  sd += `<row r="5">${tCell('D5', 5, contact)}${tCell('E5', 5, '')}${tCell('F5', 5, '')}</row>`;
  // 6: あいさつ文
  sd += `<row r="6" ht="46" customHeight="1">${tCell('A6', 6, q.greeting || '')}${empties('B6','F6',6)}</row>`;
  // 8: 表ヘッダ
  const heads = ['商品コード', '商品名', '現行単価', '改定単価', '実施日', '備考'];
  sd += `<row r="${HEADER_ROW}" ht="24" customHeight="1">` +
    heads.map((h, i) => tCell(colLetter(i + 1) + HEADER_ROW, 7, h)).join('') + '</row>';
  // 明細
  rows.forEach((r, i) => {
    const rn = firstItem + i;
    sd += `<row r="${rn}">` +
      tCell('A' + rn, 9, r.productCode || '') +
      tCell('B' + rn, 8, r.productName || '') +
      nCell('C' + rn, 10, r.currentSell) +
      nCell('D' + rn, 11, r.newSell) +
      tCell('E' + rn, 9, r.effectiveDate || '') +
      tCell('F' + rn, 8, r.note || '') +
      '</row>';
  });
  // 品目数
  sd += `<row r="${countRow}">${tCell('A' + countRow, 13, '品目数：' + rows.length + ' 件')}${empties('A' + countRow, 'F' + countRow, 13)}</row>`;
  // 脚注（内容に応じて行高を可変に＝長文・複数行でも下が隠れない）
  if (q.footer) sd += `<row r="${footerRow}" ht="${footerHeight(q.footer)}" customHeight="1">${tCell('A' + footerRow, 12, q.footer)}${empties('A' + footerRow, 'F' + footerRow, 12)}</row>`;
  sd += '</sheetData>';

  let cols = '<cols>';
  COLS.forEach((cc, i) => { cols += `<col min="${i + 1}" max="${i + 1}" width="${cc.w}" customWidth="1"/>`; });
  cols += '</cols>';

  const merges = ['A1:F1', 'D2:F2', 'A3:C3', 'D3:F3', 'D4:F4', 'D5:F5', 'A6:F6', `A${countRow}:F${countRow}`, `A${footerRow}:F${footerRow}`];
  const mergeXml = `<mergeCells count="${merges.length}">` + merges.map((m) => `<mergeCell ref="${m}"/>`).join('') + '</mergeCells>';

  const dim = `A1:F${footerRow}`;
  // A4・横向き・「幅は1ページに収める」（高さは品目数に応じて複数ページ可）。Excelの印刷で自動縮小される。
  const sheetPr = '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';
  const pageSetup = '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetPr}<dimension ref="${dim}"/><sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="16"/>${cols}${sd}${mergeXml}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>${pageSetup}</worksheet>`;
}

// 結合範囲の被覆セル（左端以外）に同じスタイルを置き、罫線/塗りを通す
function empties(fromRef, toRef, style) {
  const colA = fromRef.replace(/\d+/, '');
  const colB = toRef.replace(/\d+/, '');
  const row = fromRef.replace(/\D+/, '');
  const a = lettersToNum(colA) + 1; // 左端の次から
  const b = lettersToNum(colB);
  let s = '';
  for (let n = a; n <= b; n++) s += `<c r="${colLetter(n)}${row}" s="${style}"/>`;
  return s;
}
function lettersToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

function writeQuote(customer, rows, outPath, opt = {}) {
  const sheetName = '見積';
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(sheetName), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WB_RELS, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(buildSheet(customer, rows, opt), 'utf8') },
  ];
  fs.writeFileSync(outPath, zip(files));
}

module.exports = { writeQuote };
