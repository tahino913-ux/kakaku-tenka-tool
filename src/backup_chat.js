#!/usr/bin/env node
// チャット自動バックアップ（Claude Code の Stop フックから呼ばれる）
//
// 役割：Claudeが応答を終えるたびに、その会話ログ(.jsonl)を
//   ① 元ログそのままコピー   _chatlogs/<日付>_<session>.jsonl
//   ② 人が読める整形版        _chatlogs/<日付>_<session>.md
// として Drive 上の _chatlogs/ に保存する（両PCに同期される）。
//
// フックは stdin に JSON を渡す: { session_id, transcript_path, cwd, hook_event_name, ... }
// 失敗してもClaude本体を止めないよう、エラーは握りつぶして必ず exit 0。

const fs = require('fs');
const path = require('path');

// stdin（フックのJSON）を読む。Windowsでは fd0 の同期読みが失敗しやすいので
// 非同期ストリームで受ける。TTY（手動実行で入力なし）の場合は何もしない。
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { raw += d; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
    setTimeout(() => resolve(raw), 3000); // 念のための保険（ハング防止）
  });
}

async function main() {
  const raw = await readStdin();
  let hook;
  try { hook = JSON.parse(raw.replace(/^﻿/, '')); } catch { return; }

  const tp = hook && hook.transcript_path;
  if (!tp || !fs.existsSync(tp)) return;

  const outDir = path.join(__dirname, '..', '_chatlogs');
  fs.mkdirSync(outDir, { recursive: true });

  const lines = fs.readFileSync(tp, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const entries = [];
  for (const l of lines) { try { entries.push(JSON.parse(l)); } catch {} }

  // ファイル名：先頭エントリの日付 + session_id 先頭8桁（1セッション1ファイル、毎回上書き）
  const sid = String(hook.session_id || path.basename(tp, '.jsonl')).slice(0, 8);
  const firstTs = entries.find((e) => e && e.timestamp) || {};
  const dateStr = tsToDate(firstTs.timestamp) || tsToDate(new Date().toISOString());
  const base = dateStr + '_' + sid;

  // ① 元ログをそのままコピー（完全な復元用）
  try { fs.copyFileSync(tp, path.join(outDir, base + '.jsonl')); } catch {}

  // ② 読みやすい Markdown
  try { fs.writeFileSync(path.join(outDir, base + '.md'), renderMd(entries, sid), 'utf8'); } catch {}
}

function tsToDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

function tsToLocal(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  try { return d.toLocaleString('ja-JP'); } catch { return d.toISOString(); }
}

// system-reminder などのノイズを落とし、人が読む発言だけ残す
function cleanText(s) {
  return String(s)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, '')
    .trim();
}

// ツール呼び出しを1行で要約（コマンド・ファイル名など要点だけ）
function summarizeTool(b) {
  const name = b.name || 'tool';
  const inp = b.input || {};
  let detail = '';
  if (inp.command) detail = String(inp.command).split(/\r?\n/)[0].slice(0, 120);
  else if (inp.file_path) detail = inp.file_path;
  else if (inp.path) detail = inp.path;
  else if (inp.pattern) detail = inp.pattern;
  else if (inp.prompt) detail = String(inp.prompt).slice(0, 80);
  else if (inp.description) detail = inp.description;
  return '  🔧 `' + name + '`' + (detail ? '：' + detail : '');
}

function blocksToText(content) {
  if (typeof content === 'string') return { text: cleanText(content), tools: [] };
  if (!Array.isArray(content)) return { text: '', tools: [] };
  const texts = [];
  const tools = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) texts.push(cleanText(b.text));
    else if (b.type === 'tool_use') tools.push(summarizeTool(b));
    // thinking / tool_result / image はノイズなので整形版では省略（元ログには残る）
  }
  return { text: texts.filter(Boolean).join('\n\n'), tools };
}

function renderMd(entries, sid) {
  const out = [];
  out.push('# チャットログ — ' + sid);
  out.push('最終バックアップ: ' + tsToLocal(new Date().toISOString()));
  out.push('');
  out.push('> Claudeが応答するたびに自動更新されます。完全な復元用の元データは同名の `.jsonl` です。');
  out.push('');
  out.push('---');
  out.push('');

  let count = 0;
  for (const e of entries) {
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    if (e.isSidechain) continue; // サブエージェント内部のやりとりは除外
    const msg = e.message;
    if (!msg) continue;
    const { text, tools } = blocksToText(msg.content);
    if (!text && !tools.length) continue; // ツール結果のみ等の空ターンは飛ばす

    const when = tsToLocal(e.timestamp);
    if (e.type === 'user') {
      if (!text) continue; // 人の発言が無いuserターン（ツール結果運搬）は省略
      out.push('### 👤 あなた' + (when ? '  ' + when : ''));
      out.push('');
      out.push(text);
    } else {
      out.push('### 🤖 Claude' + (when ? '  ' + when : ''));
      out.push('');
      if (text) out.push(text);
      if (tools.length) { out.push(''); out.push(tools.join('\n')); }
    }
    out.push('');
    out.push('---');
    out.push('');
    count++;
  }
  out.splice(1, 0, '発言数: ' + count);
  return out.join('\n');
}

main();
// 何が起きても Claude 本体を止めない
process.on('uncaughtException', () => process.exit(0));
