// 依存ゼロの .xlsx 書き出し（社内分析表）。xlsx は XML を集めた ZIP。
// スタイル(色付きヘッダ・数値書式・罫線・固定行)に対応。共通部品は xlsxutil.js。
const fs = require('fs');
const { esc, colLetter, zip } = require('./xlsxutil');

// ---- 出力する列の定義 ------------------------------------------------
// type: 'text' | 'num00'(小数2桁) | 'num1'(小数1桁) | 'int'(整数) ; highlight: 強調列
const COLUMNS = [
  { header: '得意先名',         key: 'customerName',      width: 22, type: 'text' },
  { header: '商品コード',       key: 'productCode',       width: 12, type: 'text' },
  { header: '商品名',           key: 'productName',       width: 36, type: 'text' },
  { header: 'メーカー商品名',   key: 'makerName',         width: 28, type: 'text' },
  { header: '現仕入単価',       key: 'currentCost',       width: 11, type: 'num00' },
  { header: '新仕入単価',       key: 'newCost',           width: 11, type: 'num00' },
  { header: '仕入値上額',       key: 'costIncrease',      width: 11, type: 'num00' },
  { header: '仕入値上率%',      key: 'costIncreaseRate',  width: 10, type: 'num1' },
  { header: '現販売単価',       key: 'currentSell',       width: 11, type: 'num00' },
  { header: '現粗利率%',        key: 'currentMarginRate', width: 10, type: 'num1' },
  { header: '転嫁後 販売単価',  key: 'newSell',           width: 14, type: 'num00', highlight: true },
  { header: '値上げ額',         key: 'sellIncrease',      width: 10, type: 'num00', highlight: true },
  { header: '転嫁後 粗利率%',   key: 'newMarginRate',     width: 13, type: 'num1',  highlight: true },
  { header: '適用ルール',       key: 'ruleType',          width: 16, type: 'text' },
  { header: '推定年間数量',     key: 'estQty',            width: 12, type: 'int' },
  { header: '年間金額',         key: 'annualAmount',      width: 12, type: 'int' },
  { header: '値上げ年間影響額', key: 'annualCostImpact',  width: 14, type: 'int' },
  { header: '照合',             key: 'matchStatus',       width: 16, type: 'text' },
  { header: '要確認の理由',     key: 'reviewReason',      width: 38, type: 'text' },
];

// セルスタイル(s属性)番号: 0=既定 1=ヘッダ 2=ヘッダ強調 3=文字 4=小数2 5=小数1 6=整数 7=小数2強調 8=小数1強調
function dataStyle(c) {
  if (c.type === 'num00') return c.highlight ? 7 : 4;
  if (c.type === 'num1') return c.highlight ? 8 : 5;
  if (c.type === 'int') return 6;
  return 3;
}

// ---- 固定XMLパーツ ---------------------------------------------------
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0"/><numFmt numFmtId="166" formatCode="#,##0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="メイリオ"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="メイリオ"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC0504D"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyNumberFormat="1"/></cellXfs></styleSheet>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

function buildSheet(rows) {
  const nCols = COLUMNS.length;
  const lastRef = `${colLetter(nCols)}${rows.length + 1}`;

  let cols = '<cols>';
  COLUMNS.forEach((c, i) => { cols += `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`; });
  cols += '</cols>';

  let sd = '<sheetData><row r="1" ht="30" customHeight="1">';
  COLUMNS.forEach((c, i) => {
    sd += `<c r="${colLetter(i + 1)}1" t="inlineStr" s="${c.highlight ? 2 : 1}"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`;
  });
  sd += '</row>';

  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    sd += `<row r="${rowNum}">`;
    COLUMNS.forEach((c, i) => {
      const ref = `${colLetter(i + 1)}${rowNum}`;
      const v = r[c.key];
      if (c.type === 'text') {
        if (v === undefined || v === null || v === '') sd += `<c r="${ref}" t="inlineStr" s="3"/>`;
        else sd += `<c r="${ref}" t="inlineStr" s="3"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      } else {
        const s = dataStyle(c);
        if (typeof v === 'number' && Number.isFinite(v)) sd += `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
        else sd += `<c r="${ref}" s="${s}"/>`;
      }
    });
    sd += '</row>';
  });
  sd += '</sheetData>';

  const views = '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${lastRef}"/>${views}<sheetFormatPr defaultRowHeight="15"/>${cols}${sd}<autoFilter ref="A1:${lastRef}"/></worksheet>`;
}

function writeXlsx(rows, outPath, meta = {}) {
  const sheetName = (meta.sheetName || '価格転嫁見積').slice(0, 31);
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(sheetName), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WB_RELS, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(buildSheet(rows), 'utf8') },
  ];
  fs.writeFileSync(outPath, zip(files));
}

module.exports = { writeXlsx, COLUMNS };
