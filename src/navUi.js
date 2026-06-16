// =====================================================================
//  共通ナビ部品（全ページ共通のヘッダーリンク）
//   各ページがヘッダーHTMLを手書きコピーしていたため、項目の歯抜け・並び順・
//   ラベルのズレが生じていた。ここを唯一の情報源にして全ページで navLinks() を使う。
//   ・各ページは <header> 枠・<h1>・固有ボタン・CSS をそのまま残し、リンク部分だけ
//     navLinks('現在ページ') に置き換える（見た目は各ページの header a{} を踏襲）。
//   ・現在ページは押せない「ここに居ます」表示（インラインstyle＝各ページのCSS変更不要）。
// =====================================================================
'use strict';

// ナビの正準順序（左→右）。ページを足すときはここに1行足すだけで全ページに反映される。
//  key … 現在ページの判定キー（navLinks(key) で「ここ」を非リンク表示にする）
//  blank … 別タブで開く（使い方手順書）
const NAV_ITEMS = [
  { key: 'home',      href: '/',          label: '← シミュレーション' },
  { key: 'customers', href: '/customers', label: '👥 得意先別' },
  { key: 'import',    href: '/import',    label: '＋ メーカー見積取込' },
  { key: 'cdlink',    href: '/cdlink',    label: '🏷 コード化' },
  { key: 'list',      href: '/list',      label: '📊 一覧・進捗' },
  { key: 'suppliers', href: '/suppliers', label: '📒 仕入先マスタ' },
  { key: 'self',      href: '/self',      label: '🗂 自社データ設定' },
  { key: 'manual',    href: '/manual',    label: '📖 使い方', blank: true },
];

// 現在ページ(current)を「ここ」表示にしたリンク列のHTMLを返す。
//  通常項目は <a>（各ページの header a{} CSS で装飾される）。現在ページはインラインstyleの <span>。
function navLinks(current) {
  return NAV_ITEMS.map((it) => {
    if (it.key === current) {
      return '<span title="今このページです" style="background:rgba(255,255,255,.28);color:#fff;font-weight:700;'
        + 'font-size:12px;padding:5px 10px;border-radius:6px;white-space:nowrap">' + it.label + '</span>';
    }
    const t = it.blank ? ' target="_blank"' : '';
    return '<a href="' + it.href + '"' + t + '>' + it.label + '</a>';
  }).join('\n  ');
}

module.exports = { NAV_ITEMS, navLinks };
