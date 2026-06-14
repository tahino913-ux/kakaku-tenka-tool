# 価格転嫁見積ツール — AI向けガイド（CLAUDE.md）

Claude Code / Cursor が起動時に読み込むファイルです。  
**会社PC・自宅PCのどちらでも、この内容で方針と構成を把握できます。**

> 過去の詳細な作業ログ・引き継ぎメモは **`CLAUDE_作業履歴.md`**（旧版の全文）にあります。日々の細かい検証結果はそちらを参照してください。

外販（他社への販売）に関する検討は 外販メモ_他社データ対応.md を参照。

---

## 📌 会社PCで再開したら最初に（保留タスク・AIは会話の冒頭で知らせる）

> **AIへの指示**：新しいチャットの最初に、ユーザーが会社PC（販売大臣DBに接続できる環境）で作業しているなら、下の未消化タスク（`[ ]`）を要約して知らせること。会社PC/自宅PCの判別は、必要なら `/api/hanbai-source` の `source` や DB接続（`probeDbConnection`）で裏取りする。済んだ項目はユーザー確認のうえ消す。自宅PC（DBなし）では「DB必須」印の項目は実行しない（日野9000自社製造照合が劣化する事故あり）。

**会社PC（DBあり）で実施する保留タスク：**

- [ ] **【DB必須】今回修正（A1〜B1・2026-06-14）反映後の定番チェック**：`sim.bat` 再起動 →（必要なら `照合.bat`）→ `/api/dup-check`=0／**日野の自社製造一致=1085** を確認。
- [ ] **【DB必須】002172 の再照合＋目視確認**：商品名3に `370121` 登録 → 再照合で ✓CD一致 へ昇格。`フレッシュメイト…A-6` のみ・703050に付かないことを確認（詳細は `CLAUDE_作業履歴.md`）。
- [ ] **【DB必須・要検証】監査の保留 #3**：DBの構造化信号をもう一段 照合に活用（`SHOHIN.SHIIRE`／`IRISUU`／`LASTSHITANK`）。`match.js` 改変＝再照合で副作用確認（`node src/matchaudit.js` の数字を前後で比較）。
- [ ] **【DB必須・要検証】監査の保留 #4**：スコアリング改良（共通語の重み下げ・双方向スコア・ブランド別名/接頭辞辞書）。同上で `matchaudit` 比較。
- [ ] **【DB必須・要検証】性能リファクタ D2〜D5**：照合の Map 化・DB二重ロード解消など。再照合で結果が変わらないことを確認してから採用。

**SaaS化の前に（会社PCでなくても可）：**

- [ ] パスワード（`accessPassword`）のハッシュ化、リクエスト本文サイズ上限（DoS対策）。
- [ ] 日付正規化／`normLinkName` の統合整理。

> 改良に着手する前に **`node src/matchaudit.js` の数字（一致/休眠/要確認の件数）を控える**と、変更の影響を前後比較で安全に判断できる。

---

## 最優先事項

1. **品質を最優先する**  
   スピードより「正しく動く」ことを優先する。動作未確認のコードを「できた」と言わない。変更後は `node -c`・該当スクリプトの実行・必要なら `sim.bat` 再起動まで含めて確認する。

2. **動作を重くしない**  
   不要なライブラリや過剰な処理を避け、軽い実装にする。重くなる選択（全件再読込の増加、キャッシュ破棄の乱用、同期I/Oの連打など）をするときは、**先に理由を説明する**。  
   本プロジェクトは **npm 依存ゼロ** が設計原則。新規 `npm install` は原則禁止。

3. **できないことは「できない」と正直に言う**  
   推測で実装を進めない。不明点・難しい点は勝手に判断せず、**先に確認する**（例：自宅PCでDB再照合不可、実データの所在、仕入先名の正式表記など）。

---

## 進め方

- **大きな変更は段階的に**進め、区切りごとに「何をしたか・次に何をするか」を報告し、確認を取ってから次へ進む。
- **既存の動いているコードを勝手に書き換え・削除しない**。変更時は理由を説明してから行う。
- 照合エンジン（`match.js`）や販売実績ローダの変更は副作用が大きい。**会社PC＋DB再照合での検証**が必要な場合は、その旨を明示する（自宅PCでは日野9000の自社製造照合が劣化する事故あり）。

---

## セキュリティ

- **APIキーやパスワードをコードに直接書かない**。  
  - AI: `settings.json` の `ai.apiKey` または環境変数 `ANTHROPIC_API_KEY`（`src/ai.js`）  
  - 画面ロック: `settings.json` の `accessPassword`（ハッシュのみ保存）  
  - DB接続: `config.js` / `settings.json` の `hanbai.db`（gitignore 対象の `settings.json` で上書き）
- **販売大臣DBは読み取り専用（SELECTのみ）**。INSERT/UPDATE/DELETE/DDL は絶対禁止。
- `settings.json`・`input/`・`output/`・`maker_quotes/` は **gitignore**（業務データをコミットしない）。

---

## その他

- **説明・コメント・コミットメッセージはすべて日本語**で行う。
- **`.bat` ファイルの本文は ASCII のみ**（日本語を書くと cmd が化ける。案内は `node` 側の `console.log` に任せる）。
- コード変更後は **`sim.bat` の再起動**が必要（Node は起動時に一度だけ読み込む。二重起動防止で古いサーバが残ると新コードが配信されない）。
- 2台PC（Google Drive同期）では **同期完了を待ってから編集**。同時編集しない。

---

## 使用技術

| 区分 | 内容 |
|------|------|
| **言語** | **JavaScript（Node.js）** のみ。CommonJS（`require` / `module.exports`）。TypeScript・Python・PHP・React・Vue は**未使用**。 |
| **ランタイム** | Node.js LTS（`package.json` あり。**`npm install` 不要**＝`dependencies` なし） |
| **Webサーバ** | Node 標準の **`http` モジュールのみ**（Express / Fastify 等なし） |
| **フロントエンド** | **バニラ JavaScript**（HTML/CSS を `server.js` や `*Page.js` が文字列テンプレートで配信）。ビルドツール・SPAフレームワークなし |
| **Excel** | 自前実装：`xlsxread.js`（zlib で .xlsx ZIP 解凍）、`xlsx.js` / `xlsxutil.js`（書き出し）、`quoteXlsx.js`（見積書レイアウト） |
| **CSV** | 自前 `csv.js`（UTF-8 / Shift-JIS 自動判定） |
| **DB（会社PCのみ）** | Microsoft SQL Server（販売大臣）へ **PowerShell + .NET SqlClient** 経由で読取（`db_hanbai.js`） |
| **旧Excel .XLS** | Windows + Excel COM（`xls2csv.js`）。照合.bat 実行時のみ。クラウドでは未使用 |
| **AI（任意・既定OFF）** | Claude API を `https` 直叩き（`ai.js`）。キー未設定時は外部送信ゼロ |
| **バッチ** | Windows `.bat`（`sim.bat` / `照合.bat` / `取込.bat` / `run.bat` / `得意先別.bat`） |
| **バージョン管理** | Git（業務データは `.gitignore` で除外） |

---

## このツールは何か

メーカーからの値上げに対し、**得意先ごとの「転嫁後 販売単価」を計算し、見積書（Excel）を出力**する社内ツール。

**役割分担（確定）**

| 画面 | 役割 |
|------|------|
| **メイン（sim `/`）** | 照合・紐付けの確認、コスト確認、全体損益 |
| **得意先別（`/customers`）** | 転嫁ルール・単価調整・見積書発行 |
| **取込（`/import`）** | メーカー見積の貼り付け / ファイル取込 |
| **コード化（`/cdlink`）** | 商品名3（メーカー品番）登録候補の確定 |

---

## ディレクトリ構成

```
価格転嫁見積ツール/
├── config.js              # 初期値（会社情報・既定ルール・DB接続テンプレ）
├── settings.json          # 利用者設定（gitignore・Drive同期）
├── package.json           # npm メタのみ（依存パッケージなし）
├── sim.bat / 照合.bat / 取込.bat / run.bat / 得意先別.bat
├── 使い方手順書.md / .html
├── src/                   # ソース一式（下表）
├── input/                 # 照合結果CSV（gitignore）
├── output/                # 見積書・発行履歴等（gitignore）
├── maker_quotes/          # メーカー見積CSV（gitignore）
├── CLAUDE.md              # 本ファイル（AI向けガイド）
└── CLAUDE_作業履歴.md     # 過去の詳細作業ログ
```

---

## 主要モジュール（`src/`）

| ファイル | 役割 |
|----------|------|
| `server.js` | 中核。HTTPサーバ・API・メイン画面・設定・見積出力 |
| `customersPage.js` | 得意先別ページ（見積作成・発行） |
| `importPage.js` | メーカー見積取込画面 |
| `shogo.js` | 照合実行（`照合.bat` の中身）。メーカー見積統合 `mergeMakerFiles` |
| `match.js` | 照合エンジン（CD一致・名前一致・手動紐付け） |
| `hanbai.js` / `db_hanbai.js` | 販売実績ローダ（ファイル / DB直結） |
| `rules.js` | 転嫁ルール計算 |
| `settings.js` | `config.js` + `settings.json` の合成・保存 |
| `quoteXlsx.js` / `xlsx.js` | 見積書 Excel 出力 |
| `makerXlsx.js` / `xlsxread.js` | メーカー見積 .xlsx 読込 |
| `productLink.js` | 手動紐付け（📌）の共通ロジック |
| `merge_quotes.js` | 得意先別見積の統合（`得意先別.bat`） |
| `ai.js` | AI取り込みアシスト（既定OFF） |
| `pruneInput.js` | 古い照合CSVの `input/_old` 退避 |

---

## 典型的な運用フロー

1. メーカー見積を **`/import`** または `取込.bat` / `maker_quotes/` へ配置  
2. **`照合.bat`**（または sim の「↻ 照合」）→ `input/<仕入先>_照合結果_*.csv`  
3. **`sim.bat`** → ブラウザ `http://localhost:8765` で照合確認  
4. **`/customers`** で得意先ごとに単価・実施日を決めて見積発行  

**問屋経由のメーカー**（例：中央化学・エフピコ → 朝日食品容器）は `settings.json` の `makerChannel` で寄せる。  
**20%などの改定単価を反映するときは、取込仕入先を「朝日食品容器」で保存する**（中央化学名義だけだと古い朝日取込に負けることがある）。

---

## 開発・検証の注意

- **配信クライアントJS**は `server.js` 内のテンプレートリテラル経由。正規表現は **`\\d` `\\s` 等の二重エスケープ**が必要（単一 `\` だと SyntaxError で画面全壊）。
- 構文確認: `node -c src/server.js`  
- 単体テスト例: `node src/productLink.js`、`node src/matchaudit.js`  
- **自宅PC（DBなし）では `照合.bat` の本番再照合を避ける**（日野9000自社製造照合の劣化事故あり）。データ修正・merge検証は可。
- 会社PCでの定番チェック: `/api/dup-check`=0、日野の自社製造一致=1085（再照合後）

---

## 参照ドキュメント

- 利用者向け手順: `使い方手順書.md` / `使い方手順書.html`（sim の「📖 使い方」からも開ける）
- 概要: `README.md`
- 詳細な過去セッションの記録: `CLAUDE_作業履歴.md`
