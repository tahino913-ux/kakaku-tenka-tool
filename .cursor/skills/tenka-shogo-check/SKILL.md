---
name: tenka-shogo-check
description: 価格転嫁見積ツールの照合・再照合（照合.bat/shogo.js）を安全に実行し、再照合後の定番チェックを行う。ユーザーが照合、再照合、↻照合、shogo、match結果の更新を依頼したとき、または会社PC/自宅PCの判断が必要なときに使う。
---

# 照合・再照合の安全手順

## 鉄則

| 環境 | 照合.bat / `node src/shogo.js` |
|------|-------------------------------|
| **会社PC（販売大臣DBあり）** | 実行可 |
| **自宅PC（DBなし）** | **本番再照合禁止**（日野9000自社製造が 1085→0 に劣化した事故あり） |

自宅PCでできること: コード閲覧、`node src/matchaudit.js`、`node src/productLink.js`、ファイル整理、`compareMakerFix.js`（既存CSVとの突合のみ）。

DB有無の目安: 照合実行時にコンソールに「販売大臣DBから直接取得中」が出る／`MSSQL$OHKEN` サービス稼働。

## 再照合の手順（会社PC）

1. `settings.json` の `makerChannel`・`productLinks` を壊さない（保存は `settings.js` 経由の部分マージ）
2. `照合.bat` または `node src/shogo.js`
3. 下記「定番チェック」
4. **`sim.bat` 再起動**（設定変更時。古い8765プロセスが残ると新コードが配信されない）

### サーバ停止（Windows）

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { if ($_.OwningProcess -gt 0) { Stop-Process -Id $_.OwningProcess -Force } }
```

## 再照合後の定番チェック

| 項目 | 期待値 |
|------|--------|
| 日野折箱店 自社製造 | **一致 1085 / 休眠 4**（`input/日野折箱店_照合結果_<最新>.csv` または shogo ログ） |
| 二重登録 | `/api/dup-check` → `dups: []`（sim 起動中） |
| 副作用確認（任意） | `node src/matchsnap.js check`（baseline あり時） |

日野が 1085 でない場合: **すぐに照合を止め、`input/_old` から良好版を復元**。原因調査まで本番運用しない。

## 報告に含めること

- 実行したPC（会社/自宅）と DB 使用の有無
- 各仕入先の 一致/休眠 件数（shogo ログ）
- 定番チェック結果
- `sim.bat` 再起動の要否

## 参照

- プロジェクトルート `CLAUDE.md`（最優先事項・開発注意）
- `src/shogo.js`（`mergeMakerFiles`・xlsx 自動展開）
