const fs = require('fs');

// ファイルを文字コード自動判定で文字列化（外部ライブラリ不使用）
// UTF-8(BOM有/無) と Shift-JIS(CP932) に対応。
function decodeBuffer(buf) {
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
      else if (ch === '\r') { /* skip */ }
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
  const headers = raw[0].map((h) => String(h).replace(/^﻿/, '').trim());
  const records = raw.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] !== undefined ? String(r[i]).trim() : ''); });
    return o;
  });
  return { records, headers };
}

module.exports = { loadCsv, decodeBuffer, parseCsvText };
