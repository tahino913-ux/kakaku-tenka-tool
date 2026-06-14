---
name: tenka-maker-price-sync
description: メーカー見積（maker_quotes/xlsx/CSV）の単価統一・検証・問屋経由のmakerChannel設定。容器メーカーxlsx、中央化学、CP化成、朝日食品容器、単価ズレ、compareMakerFix、価格改定取込の依頼時に使う。
---

# メーカー見積単価の統一・検証

## よくある事故

- 直下の **修正版** `日野折箱店様（容器メーカー）.xlsx` と `maker_quotes/` 内の **古い版** が二重管理
- `maker_quotes/中央化学.csv` が残り、修正版より **約8%高い** 単価で再照合時に上書き
- 問屋経由メーカーを別仕入先のまま照合し、ドロップダウンが分裂

## 正しいxlsxの置き場所

1. 正 = プロジェクト直下の `日野折箱店様（容器メーカー）.xlsx`（修正シート入り）
2. これを **`maker_quotes/` に上書きコピー**
3. 古い `maker_quotes/日野折箱店様（容器メーカー）.xlsx` と **`maker_quotes/中央化学.csv`** は `maker_quotes/_old/` へ退避（削除しない）

## makerChannel（問屋経由 → 朝日食品容器）

`settings.json` の `makerChannel` に、xlsx 展開後の **仕入先名と完全一致** で登録:

```json
{
  "エフピコ": "朝日食品容器",
  "中央化学": "朝日食品容器",
  "中央化学(修正)": "朝日食品容器",
  "CP化成(修正)": "朝日食品容器",
  "リスパック": "朝日食品容器",
  "青葉": "朝日食品容器",
  "伊藤敏": "朝日食品容器"
}
```

シート名は `makerXlsx.js` の `makerFromSheet` で正規化される。不明なら:

```bash
node src/makerXlsx.js "日野折箱店様（容器メーカー）.xlsx" maker_quotes/_preview
```

出力の `supplier:` 名をそのままキーにする。

**20%改定などを反映するとき**は `/import` で **仕入先＝朝日食品容器** として保存（メーカー名だけだと古い朝日CSVに負けることがある）。

## 検証コマンド

```bash
node src/compareMakerFix.js --all
```

| 項目 | 合格 |
|------|------|
| 新単価不一致 | **0** |
| 現単価不一致 | **0** |
| 約+10% / +20%高い | **0** |
| 出力 | `output/価格比較_容器メーカー修正_vs照合.csv` |

照合CSVは最新の `input/朝日食品容器_照合結果_*.csv` を自動選択。

## 標準フロー（会社PC）

1. 古い `中央化学.csv` 等を `_old` へ退避
2. 修正版 xlsx → `maker_quotes/` 上書き
3. `makerChannel` 更新 → **sim.bat 再起動**
4. `node src/shogo.js`（または `照合.bat`）
5. `node src/compareMakerFix.js --all`
6. `tenka-shogo-check` の定番チェック

## 再照合なしで単価だけ直す場合

`node src/refreshMatchPrices.js` … 既存 `input/` CSV の仕入単価を `maker_quotes` に合わせるパッチ。**照合ロジックは再実行しない**。本番は再照合＋上記検証を優先。

## バックアップ

`settings.json`・退避する CSV は操作前に `maker_quotes/_old/価格統一_<日時>/` へ。`settings.json` は gitignore（コミットしない）。
