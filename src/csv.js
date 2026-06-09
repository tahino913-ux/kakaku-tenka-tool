const fs = require('fs');

// ファイルを文字コード自動判定で文字列化（外部ライブラリ不使用）
// UTF-8(BOM有/無) と Shift-JIS(CP932) に対応。
function decodeBuffer(buf) {
  // UTF-16 BOM（一部のExcel/基幹がUTF-16でCSVを吐く）。LE=FF FE / BE=FE FF。TextDecoderがBOMを除去。
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  // UTF-8 BOM があれば UTF-8（TextDecoderはBOMを自動除去）
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf);
  }
  // UTF-8 として読んで不正バイト(置換文字)が無ければ UTF-8
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  // それ以外は Shift-JIS とみなす
  return new TextDecoder('shift-jis').decode(buf);
}

// CSV文字列を行(配列)の配列へ。引用符・改行・"" エスケープに対応(RFC4180準拠)。
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') {
        // CRLF は次の \n に任せて改行。CR のみ(旧Mac形式)はここで1行確定する。
        if (text[i + 1] !== '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// CSVを読み込み { records: [{列名:値,...}], headers:[列名,...] } を返す
function loadCsv(filePath) {
  const buf = fs.readFileSync(filePath);
  const text = decodeBuffer(buf);
  const raw = parseCsvText(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!raw.length) return { records: [], headers: [] };
  // 重複ヘッダー名は一意化（同名2列目以降に __2, __3… を付与）。
  //  ＝そのままだと records のオブジェクトキーが後勝ちで上書きされ、列の値が黙って消えるため。
  //  先頭の出現名は変えない＝列マッピング(buildColumnMap の先頭一致)に影響しない。
  const seenHead = new Map();
  const headers = raw[0].map((h) => {
    let name = String(h).replace(/^﻿/, '').trim();
    const cnt = (seenHead.get(name) || 0) + 1;
    seenHead.set(name, cnt);
    return cnt > 1 ? (name + '__' + cnt) : name;
  });
  const records = raw.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] !== undefined ? String(r[i]).trim() : ''); });
    return o;
  });
  return { records, headers };
}

module.exports = { loadCsv, decodeBuffer, parseCsvText };
