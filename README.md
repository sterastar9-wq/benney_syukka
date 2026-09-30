# GOQ_AUTOMATION（ベニー様版）

GoQ System（受注管理）の日々の出荷業務を自動化するツール集です。

> **ベニー様版について**
> 元の `goq-automation` をコピーして作ったものです。元版とは次の点が違います。
> - ピッキングリストは Smart Pick を使わず、ローカルでPDFを作って印刷します（[tools/local-picking/README.md](tools/local-picking/README.md)）。マスタは「ベニー様_ピッキング参照」の `GoQ全データ` タブです。
> - ヤマト・コンパクト・ネコポスの送り状は、GoQ の発行ボタンを使わず、**GoQ から B2クラウド用の送り状データCSVを出力し、ヤマトビジネスメンバーズ（B2クラウド）で印刷**します（[tools/yamato-b2/README.md](tools/yamato-b2/README.md)）。
> - Docker は使いません。Windows ローカルの Node.js と Chrome で動かします。
> - 認証情報は `.env` に統一しています（`.env.example` 参照）。
> - 販売データの日次集計（`run_all.py` など）は、まだ元版のままです。使う前に `.env` のIDをすべてベニー様用に設定してください。

## ベニー様の出荷フロー

| # | 工程 | 使うもの | 状態 |
| --- | --- | --- | --- |
| 1 | GoQ ログイン | `tools/goq-login.mjs`（印刷フローが自動で行う） | 実装済み・未検証 |
| 2 | ピッキングリストをローカルで印刷（普通紙） | `tools/local-picking/` | 実装済み |
| 3 | 送り状データ（B2クラウド形式CSV）を GoQ から出力し、対象注文と突合 | `tools/goq-print-flow.mjs`（`b2-csv` モード） | 実装済み・未検証（GoQ 実画面の option value の確認が必要） |
| 4 | ヤマトビジネスメンバーズにログインし、CSV を取り込んで送り状を印刷、送り状番号を GoQ に戻す | `tools/yamato-b2/` | ログイン・画面走査まで実装。取込・印刷は画面走査後に作る |

## 事前準備

1. **Node.js 20 以上** を入れて、依存パッケージをインストールする

   ```powershell
   npm install
   ```

2. **`.env` を作る**（`.env.example` をコピーして値を入れる。Git には入りません）

   - GoQ: `GOQ_LOGIN_URL` / `GOQ_USER_ID` / `GOQ_PASSWORD` / `GOQ_SEQ_ID` / `GOQ_SEQ_PW`
   - ヤマトビジネスメンバーズ: `YAMATO_BENY_HISSU`（必須コード）/ `YAMATO_BENY_NINNI`（任意コード）/ `YAMATO_BENY_PASSWORD`
   - プリンタ名の一部（既定はこのPCの `FUJIFILM Apeos C5240普通紙 / ヤマト / 佐川 / ネコポス（手差し）` に合わせてある）

3. **`credentials.json`**（Google サービスアカウント鍵）をフォルダ直下に置き、「ベニー様_ピッキング参照」をそのサービスアカウントに **閲覧者** で共有する

4. **Chrome をリモートデバッグ付きで起動する**（自動化専用プロファイル `.chrome-goq` を使うので普段の Chrome とは別）

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\start-chrome-cdp.ps1
   ```

5. 動作確認

   ```powershell
   npm run check            # 構文チェックと回帰テスト（ピッキング集計・B2 CSV 突合）
   npm run goq:login -- --check     # GoQ のログイン状態だけ確認
   npm run yamato:login -- --check  # ヤマトのログイン状態だけ確認
   ```

## 使い方（送り状・ピッキングリスト印刷）

まずは確認だけ（何も変更・印刷しない。対象・除外される注文を表示）：

```powershell
node tools/goq-print-flow.mjs --status yamato
```

本番実行（レビュー付き。通常はこちらを使う）：

```powershell
npm run goq:print -- --status yamato --execute
```

ヤマト系（`yamato` / `compact` / `nekoposu`）ではここまでで「ピッキングリスト印刷 → B2クラウド用CSV出力 → 突合 → 引き継ぎファイル」が終わります。続きはヤマト側です。

```powershell
npm run yamato:login      # .env でログインし、ホームに「合同会社Ｂｅｎｙ」が出ることを確認
npm run yamato:survey     # 画面構造を .o11y/yamato-b2/survey/ に記録（読み取り専用）
# 取込・印刷（走査後に実装）: node tools/yamato-b2/import-and-print.mjs --handoff <引き継ぎファイル>
```

| `--status` | GoQ ステータス | 送り状の出し方 | 送り状プリンタ |
| --- | --- | --- | --- |
| `yamato` | ヤマト | B2クラウドCSV → ヤマトビジネスメンバーズ | ヤマト |
| `compact` | コンパクト | B2クラウドCSV → ヤマトビジネスメンバーズ | ヤマト |
| `nekoposu` | ネコポス徳島 | B2クラウドCSV → ヤマトビジネスメンバーズ | ネコポス |
| `sagawa` | 佐川 | GoQ の佐川 Smart API（元版のまま） | 佐川 |
| `hold-sagawa` | 保留（佐川想定） | GoQ の佐川 Smart API（元版のまま） | 佐川 |

Amazon 注文だけを対象にする場合は `yamato-amazon` のように `-amazon` を付けます。

よく使うオプション：

| オプション | 内容 |
| --- | --- |
| `--order <注文番号>` | 1件だけで試す |
| `--stop-after-date` | 出荷日の入力まで行って止める |
| `--preview-only-picking` | ピッキングリストは印刷プレビューで止める |
| `--skip-labels` | ピッキングリストまでで止める（送り状CSVを出さない） |
| `--resume` | 出荷日入力済みの状態から再開する |
| `--no-auto-login` | `.env` での自動ログインをしない（未ログインなら止まる） |

直近の実行をレビューし直す：

```powershell
npm run goq:review
```

操作仕様の詳細は [tools/goq-print-flow.README.md](tools/goq-print-flow.README.md)、毎回の確認項目は [tools/goq-print-flow.CHECKLIST.md](tools/goq-print-flow.CHECKLIST.md)、エージェントの運用ルールは [AGENTS.md](AGENTS.md) を参照。

## 印刷チェックポイントガード

手作業・エージェント作業で、印刷の前に「この操作をしてよいか」を判定します（`scripts/goq_flow_guard.py`）。ヤマト系は `picking_print → b2_csv_export → b2_import → label_print → b2_tracking_export → goq_tracking_import → tracking_verify → post_label_verify` の順でしか進めません。工程の一覧とルールは [GOQ_FLOW_CHECKPOINTS.md](GOQ_FLOW_CHECKPOINTS.md) を参照。Python 3.10 以上が必要です。

## 販売データの日次集計（元版のまま）

`run_all.py` が GoQ・プライスターから前日の販売データを取り、Google スプレッドシートを更新します。Python 3.10 以上と `requirements.txt`、`playwright install chromium` が必要で、`.env` の `PRICETAR_*` / `GSHEET_*` / `*_BOOK_ID` をベニー様用に設定するまで動かさないでください。詳細は元版の手順（`RUN_ALL_REVIEW_PROTOCOL.md`、`scripts/register_run_all_daily_task.ps1`）を参照。

## フォルダ構成

```text
tools/goq-print-flow.mjs       印刷フロー本体（ログイン → ピッキング → 送り状CSV/発行）
tools/goq-login.mjs            GoQ ログイン（.env）
tools/yamato-b2/               ヤマトビジネスメンバーズ（ログイン・走査・取込印刷）
tools/local-picking/           ピッキングリストのローカル作成・印刷
tools/lib/                     .env 読み込み、CDP、プリンタ振り分け、CSV突合
tools/goq-run-review.mjs       実行ログのレビュー
scripts/start-chrome-cdp.ps1   自動化用 Chrome の起動
scripts/goq_flow_guard.py      印刷チェックポイントガード
.claude/skills/                エージェント用スキル（印刷フロー、ピッキング単体印刷）
codex/                         Amazon 振分スキル、印刷ルールメモ
docs/                          エージェント運用環境
tests/                         ガードのテスト（pytest）
run_all.py ほか *.py           販売データ集計（元版のまま）
```

## 注意

- `.env`・`credentials.json`・CSV・PDF・Chrome プロファイルは Git に入れない設定です。パスワードや顧客情報をコミットしないでください。
- 印刷・送り状CSV出力・出荷日入力・ヤマトでの取込発行は本番データを変更します。初めて使うステータスはオプションなしの確認モードか `--order` で1件から試してください。
- `shippingLabelDownload.py` は全配送業者の送り状データを一括出力してしまうため、通常は動かないようにしています。
