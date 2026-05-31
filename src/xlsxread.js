// =====================================================================
//  .xlsx 直読みリーダ（外部ライブラリ不使用 / Node標準 zlib のみ）
//   .xlsx は ZIP(各エントリは raw deflate) なので、ZIP構造を手で読み、
//   xl/sharedStrings.xml・xl/workbook.xml・各シートXMLを解析してセル値を取り出す。
//   ※ .xls(旧OLE2バイナリ) は別物。旧Excelは xls2csv.js(Excel COM)で扱う。
//
//   readXlsx(filePath) -> { sheets: [ { name, grid: string[][] } ] }
//     grid は行×列の二次元配列（空セルは ''）。日付は数値シリアルの文字列で返す。
// =====================================================================
const fs = require('fs');
const zlib = require('zlib');

// --- ZIP 展開 -------------------------------------------------------
function findEOCD(buf) {
  // End Of Central Directory レコード(署名 0x06054b50)を末尾から探す
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('ZIPの終端が見つかりません（.xlsx ではない可能性があります）');
}
function readCentralDir(buf) {
  const eocd = findEOCD(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || total === 0xffff) throw new Error('ZIP64 形式は未対応です');
  const entries = {};
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries[name] = { method, compSize, localOff };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function extract(buf, e) {
  if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error('ローカルヘッダが不正です');
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const comp = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return comp;                  // 無圧縮
  if (e.method === 8) return zlib.inflateRawSync(comp); // deflate
  throw new Error('未対応の圧縮方式: ' + e.method);
}
function entryText(buf, entries, name) {
  const e = entries[name];
  return e ? extract(buf, e).toString('utf8') : null;
}

// --- XML ヘルパ -----------------------------------------------------
function unescapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&'); // &amp; は最後
}
// 共有文字列：各 <si> の本文（ふりがな <rPh> は除外、複数 <t> は連結）
function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
    const body = m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '');
    return [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join('');
  });
}
function colToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}
// シートXML → 二次元配列（行は文書順、列は A,B,… を 0,1,… に対応）
function parseSheet(xml, sst) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    let maxc = -1;
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const refM = attrs.match(/r="([A-Z]+\d+)"/);
      if (!refM) continue;
      const ci = colToIndex(refM[1]);
      const t = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
      let val = '';
      if (t === 's') {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (v) val = sst[+v[1]] != null ? sst[+v[1]] : '';
      } else if (t === 'inlineStr') {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1])).join('');
      } else { // n(数値) / str(数式文字列) / b(真偽) 等は <v> をそのまま
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (v) val = unescapeXml(v[1]);
      }
      cells[ci] = val;
      if (ci > maxc) maxc = ci;
    }
    const row = [];
    for (let i = 0; i <= maxc; i++) row.push(cells[i] != null ? cells[i] : '');
    rows.push(row);
  }
  return rows;
}

// --- 本体 -----------------------------------------------------------
function readXlsx(filePath) {
  return readXlsxBuffer(fs.readFileSync(filePath));
}

// ファイルパスではなくメモリ上のバッファから読む（アップロード受け取り用）。
function readXlsxBuffer(buf) {
  const entries = readCentralDir(buf);
  const sst = parseSharedStrings(entryText(buf, entries, 'xl/sharedStrings.xml'));
  const wb = entryText(buf, entries, 'xl/workbook.xml') || '';
  const relsXml = entryText(buf, entries, 'xl/_rels/workbook.xml.rels') || '';

  // r:id → ターゲットファイル
  const relMap = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*?\/>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
    const tgt = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && tgt) relMap[id] = tgt;
  }
  // <sheet name=… r:id=…/> をブック内の順序どおりに
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*?\/>/g)) {
    const name = (m[0].match(/name="([^"]+)"/) || [])[1];
    const rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    let tgt = relMap[rid];
    if (!tgt) continue;
    tgt = tgt.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = entryText(buf, entries, 'xl/' + tgt);
    if (xml == null) continue;
    sheets.push({ name: unescapeXml(name), grid: parseSheet(xml, sst) });
  }
  return { sheets };
}

module.exports = { readXlsx, readXlsxBuffer };
