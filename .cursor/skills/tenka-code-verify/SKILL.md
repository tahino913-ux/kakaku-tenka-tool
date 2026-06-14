---
name: tenka-code-verify
description: 価格転嫁見積ツールのコード変更後検証。server.js、customersPage.js、importPage.js、配信JS、batファイル変更時。node -c、sim再起動、npm禁止、二重エスケープ正規表現の確認に使う。
---

# コード変更後の検証

## 設計制約（破らない）

- **npm install / 外部ライブラリ追加禁止**（Node標準＋自前実装のみ）
- **販売大臣DBは SELECT のみ**
- `.bat` 本文は **ASCII のみ**（日本語は `node` の `console.log`）
- `settings.json` / `input/` / `output/` / `maker_quotes/` は **git コミットしない**

## 変更後の最低限チェック

```bash
node -c src/server.js
node -c src/<変更したファイル>.js
```

`server.js`・`*Page.js` を触ったら **配信クライアントJSの構文**も確認（テンプレート展開後の実体で `vm.Script` 等。プロジェクト内の既存検証手順に合わせる）。

## server.js インラインJSの罠

配信JSは `` const PAGE = `...` `` 内の文字列。正規表現は **二重エスケープ**:

- ✅ `\\d` `\\s` `\\+`
- ❌ `\d` → 配信時に壊れ **画面全停止（SyntaxError）**

`confirm` 内の改行は `\\n`（実改行にしない）。

## 単体検証（該当時）

| コマンド | 用途 |
|----------|------|
| `node src/productLink.js` | 手動紐付け（📌）ロジック |
| `node src/linkBetterAudit.js` | suspect 手動紐付け監査 |
| `node src/matchaudit.js` | 照合精度（読取専用・DB不要） |

## 完了報告に必ず含める

- 変更したファイル一覧
- `node -c` 結果
- 配信JS検証（実施した場合）
- **要 `sim.bat` 再起動**（server.js / settings.js / *Page.js 変更時は必須）

## サーバ再起動

二重起動防止で古いプロセスが残ると新コードが配信されない。停止してから `sim.bat`:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { if ($_.OwningProcess -gt 0) { Stop-Process -Id $_.OwningProcess -Force } }
```

## 照合エンジンを触る場合

`match.js` / `hanbai.js` / `db_hanbai.js` の変更は **`tenka-match-engine-change`** も併用する。
