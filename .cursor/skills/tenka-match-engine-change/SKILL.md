---
name: tenka-match-engine-change
description: 価格転嫁見積ツールの照合エンジン（match.js、hanbai.js、db_hanbai.js、shogo.jsの照合ロジック）変更時の安全手順。match.js改修、スコアリング、DB信号、再照合検証、matchsnap、matchauditの依頼時に使う。
---

# 照合エンジン改修の安全手順

## 前提

照合エンジン変更は **副作用が最大**。自宅PCでは本番再照合で検証できない（日野9000劣化）。  
**会社PC＋DB** で before/after を必ず比較する。

## 変更前（会社PC）

1. 現状を記録:

```bash
node src/matchaudit.js
```

数字（CD率・名前率・休眠率等）をメモまたは `CLAUDE_作業履歴.md` に1行記録。

2. baseline がある場合:

```bash
node src/matchsnap.js check
```

## 実装時の原則

- 変更は **最小差分**。無関係なリファクタを混ぜない
- `productLink.js` / `settings.productLinks` との整合を確認
- DB変更は **読取のみ**（`db_hanbai.js` も SELECT のみ）

## 変更後（会社PC・必須）

1. `node -c src/match.js`（他の変更ファイルも）
2. **`node src/shogo.js`** または `照合.bat`（本番再照合）
3. 定番チェック（`tenka-shogo-check` 参照）:
   - 日野折箱店 **1085 / 休眠 4**
   - `/api/dup-check` = 0
4. 精度の before/after:

```bash
node src/matchaudit.js
node src/matchsnap.js check
```

`matchsnap` の **lost** が想定外（S↔L取り違え以外）ならロールバック検討。

## 自宅PCでできること

- コード編集・`node -c`
- `node src/productLink.js` / `linkBetterAudit` 単体
- `matchaudit.js`（既存 input CSV のみ・再照合不要）

**「検証完了」と報告するのは会社PC再照合後まで待つ。**

## ロールバック

- `input/_old/` の良好版CSV
- git でコード巻き戻し
- 日野が 1085 でない場合は **即停止・復元**
