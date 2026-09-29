# GOQ_AUTOMATION（ベニー様版）

GoQ System（受注管理）の日々の業務を自動化するツール集です。

> **ベニー様版について**
> 元の `goq-automation`（`OneDrive\ドキュメント\GOQ\goq-automation`）をコピーして作ったものです。元版とは次の点が違います。
> - ピッキングリストは Smart Pick を使わず、ローカルでPDFを作って印刷します（詳しくは [tools/local-picking/README.md](tools/local-picking/README.md)）。
> - ピッキングのマスタは「ベニー様_ピッキング参照」の `GoQ全データ` タブです。元版のGoQ全データ（データ管理②）は読み先にも書き込み先にも使いません。
> - 販売データの日次集計（`run_all.py` など）は、まだ元版のままです。使う前に `.env` のIDをすべてベニー様用に設定してください。

## できること

| # | できること | 使うもの | 自動/手動 |
| --- | --- | --- | --- |
| 1 | 前日の販売データを GoQ・プライスターから取得し、Google スプレッドシートの販売DB・商品台帳・未販売リストなどを更新する | `run_all.py`（Python） | 毎日 00:01 に自動実行可 |
| 2 | ステータスごと（佐川／ヤマト／コンパクト／ネコポス）に、出荷日入力 → ピッキングリスト印刷 → 送り状発行・印刷までを一括で行う | `npm run goq:print`（Node.js） | 手動またはエージェント実行 |
| 3 | 印刷の二重実行・プリンタ取り違え・工程の順番違いを印刷前にブロックする | `scripts/goq_flow_guard.py` | 印刷の前後に実行 |
| 4 | AIエージェント（Codex など）に Amazon 振分・送り状印刷の業務ルールを教える | `codex/skills/goq/` | エージェントが参照 |

---

## 1. 販売データの日次集計

### 何をするか

`run_all.py` が次の3ステップを順番に実行します。途中で失敗したらそこで止まります。

1. **GoQ 処理済み受注の取得**（`GshippingDataDownload.py`）
   GoQ にログインし、前日分の処理済み受注CSVをダウンロードして、Google スプレッドシートへ重複なしで追記します。
2. **GoQ・プライスターの受注CSV取得**（`salesDataDownload_local.py`）
   起動中の Chrome を操作して、GoQ とプライスターから受注CSVをダウンロードします。
3. **スプレッドシート一括更新**（`integrated_sales_automation.py`）
   - 販売データDBの更新
   - 商品台帳の更新
   - 未販売リスト（1週間／1ヶ月／2ヶ月）の作成
   - JAN空欄リスト・商品SKU未登録リストの作成
   - 不買商品シートの同期

### 事前準備

1. Python 3.10 以上と必要なライブラリを入れる

   ```powershell
   python -m pip install -r requirements.txt
   python -m playwright install chromium
   ```

2. Google のサービスアカウント鍵を `credentials.json` としてリポジトリ直下に置き、対象スプレッドシートにそのサービスアカウントを編集者として共有する
3. リポジトリ直下に `.env` を作る（Git には入りません）

   ```dotenv
   # GoQ ログイン
   GOQ_LOGIN_URL=
   GOQ_USER_ID=
   GOQ_PASSWORD=
   GOQ_SEQ_ID=
   GOQ_SEQ_PW=

   # プライスター
   PRICETAR_EMAIL=
   PRICETAR_PASSWORD=

   # Google スプレッドシート
   GSHEET_ID=
   GSHEET_NAME=
   SOURCE_BOOK_ID=
   GOQ_BOOK_ID=
   FUKA_BOOK_ID=

   # 任意
   CREDENTIALS_FILE=credentials.json
   DOWNLOAD_DIR=販売データダウンロード
   ```

4. Chrome をリモートデバッグ付きで起動しておく（ステップ2で使用）

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
   ```

### 使い方

手動で実行する：

```powershell
python run_all.py
```

特定の日付分を取り直す（指定しなければ前日分）：

```powershell
$env:GOQ_TARGET_DATE = "2026-06-10"; python run_all.py
```

毎日自動で実行する（タスクスケジューラに登録）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register_run_all_daily_task.ps1
# 時刻を変える場合: -Time "06:00"
# 解除する場合:   scripts\unregister_run_all_daily_task.ps1
```

ログは `logs\scheduled\` に保存されます。

### 失敗したとき

```powershell
python scripts\run_all_goal_guard.py status          # 各ステップの状態
python scripts\run_all_goal_guard.py resume-context  # どこから再開すべきか・直近のログ抜粋
```

詳しい判定ルールは [RUN_ALL_REVIEW_PROTOCOL.md](RUN_ALL_REVIEW_PROTOCOL.md) を参照。

### GitHub Actions で動かす（G-出荷用のみ・試験中）

`.github/workflows/gshipping-daily.yml` で `GshippingDataDownload.py` を GitHub 上で実行できます。

1. リポジトリの Settings → Secrets and variables → Actions → Secrets に登録する
   - GoQ（全モード）: `GOQ_LOGIN_URL` / `GOQ_USER_ID` / `GOQ_PASSWORD` / `GOQ_SEQ_ID` / `GOQ_SEQ_PW`
   - シート書き込み（`full` のみ）: `GSHEET_ID` / `GSHEET_NAME`
   - サービスアカウント（`full` のみ、credentials.json の各値）: `CLIENT_EMAIL` / `PRIVATE_KEY` / `TOKEN_URI` / `PRIVATE_KEY_ID`
     実行時にこれらから credentials.json を組み立て、終了時に削除する
2. Actions → 「G-出荷用 日次書き込み」→ Run workflow
   - `login-only`: GoQ にログインできるかだけ確認（シートには書き込まない）
   - `download-only`: CSV のダウンロードまで行い、件数と列名をログに出す（シートには書き込まない）
   - `full`: シートまで書き込む（対象日を空欄にすると前日分）
3. 毎日 01:00（JST）の定時実行を有効にするには、Variables に `GSHIPPING_SCHEDULE_ENABLED` = `true` を登録する

失敗時のログと画面は、実行結果ページの Artifacts からダウンロードできます（7日間保存）。

---

## 2. 送り状・ピッキングリスト印刷フロー

### 何をするか

指定した GoQ ステータスの注文について、以下を一括で行います（佐川120サイズ以上は対象外）。

1. 住所警告（`【住】`）のある注文を検出し、修正・確認する
2. 出荷日・送り状番号・配送業者をチェックして対象外の注文を除外する
3. 対象注文の出荷日を今日に一括入力する
4. 商品名順に並べ、ピッキング用CSVを取得し、ベニー様シートを参照してピッキングリストのPDFをローカルで作り、**普通紙** に印刷する
5. 送り状を発行し、PDF をダウンロードして、配送業者ごとのプリンタに印刷する
6. 送り状が全件発行されたか突合し、未発行があれば報告する
7. 実行ログを自動レビューし、ルール違反があれば失敗扱いにする

| `--status` | GoQ ステータス | 送り状プリンタ |
| --- | --- | --- |
| `sagawa` | 佐川 | 佐川 |
| `yamato` | ヤマト | ヤマト/コンパクト |
| `compact` | コンパクト | ヤマト/コンパクト |
| `nekoposu` | ネコポス徳島 | ネコポス |
| `hold-sagawa` | 保留（佐川想定） | 佐川 |

Amazon 注文だけを対象にする場合は `sagawa-amazon` のように `-amazon` を付けます。

### 事前準備

1. Node.js 20 以上を入れて、依存パッケージをインストールする

   ```powershell
   npm install
   ```

2. Chrome をリモートデバッグ付き（ポート 9223）で起動し、GoQ にログインしておく
2a. ピッキングのマスタを読むため、`credentials.json`（サービスアカウント鍵）をフォルダ直下に置き、「ベニー様_ピッキング参照」をそのサービスアカウントのメールアドレスに **閲覧者** で共有しておく（[tools/local-picking/README.md](tools/local-picking/README.md)）
3. `~/.codex/skills/goq-shipping-label-print-flow/SKILL.md` と `~/.codex/memories/goq-print-flow-rules.md` を配置しておく（実行時に必ず読み込まれ、無いと止まります。リポジトリ内の原本は `codex/` 配下）

Docker で動かす場合は `start-goq-docker.cmd` をダブルクリックするとコンテナが起動します（詳細は [docs/docker-environment.md](docs/docker-environment.md)）。

### 使い方

まずは確認だけ（何も変更・印刷しない。対象・除外される注文を表示）：

```powershell
node tools/goq-print-flow.mjs --status yamato --port 9223
```

本番実行（レビュー付き。通常はこちらを使う）：

```powershell
npm run goq:print -- --status yamato --port 9223 --execute
# Docker の場合
docker compose exec goq npm run goq:print -- --status yamato --port 9223 --execute
```

よく使うオプション：

| オプション | 内容 |
| --- | --- |
| `--order <注文番号>` | 1件だけで試す |
| `--stop-after-date` | 出荷日の入力まで行って止める |
| `--preview-only-picking` | ピッキングリストは印刷プレビューで止める |
| `--stop-before-label-print` | 送り状の印刷直前で止める |
| `--resume` | 出荷日入力済みの状態から再開する |
| `--amazon-only` | Amazon タブの注文だけに絞る |

直近の実行をレビューし直す：

```powershell
npm run goq:review
```

操作仕様の詳細は [tools/goq-print-flow.README.md](tools/goq-print-flow.README.md)、毎回の確認項目は [tools/goq-print-flow.CHECKLIST.md](tools/goq-print-flow.CHECKLIST.md) を参照。

---

## 3. 印刷チェックポイントガード

佐川120サイズ以上を含む手作業・エージェント作業で、印刷の前に「この操作をしてよいか」を判定します。

主にブロックするもの：

- 既に印刷済みの配送業者・工程の再印刷
- ピッキングリスト印刷前の送り状印刷
- 配送業者とプリンタの不一致
- CSV の件数と指定件数の不一致

```powershell
# 1. セッション開始
python scripts\goq_flow_guard.py init --session 20260611 --objective "ヤマト以降を印刷"
# 2. 印刷前の状態を記録
python scripts\goq_flow_guard.py capture --session 20260611 --name yamato-before-picking
# 3. 印刷してよいか判定 → OK なら start
python scripts\goq_flow_guard.py review --session 20260611 --carrier yamato --phase picking_print ...
python scripts\goq_flow_guard.py start  --session 20260611 --carrier yamato --phase picking_print ...
# 4. 印刷後に完了（問題があれば block）
python scripts\goq_flow_guard.py complete --session 20260611 --carrier yamato --phase picking_print
```

工程の一覧とルールは [GOQ_FLOW_CHECKPOINTS.md](GOQ_FLOW_CHECKPOINTS.md) を参照。

---

## 4. エージェント用スキル

| スキル | 内容 |
| --- | --- |
| `codex/skills/goq/skills/goq-amazon-routing` | `Amazon振分用`・`発送待ち` の注文を配送業者・ステータスへ振り分けるルール（120サイズ判定、個口数、日時指定チェック） |
| `codex/skills/goq/skills/goq-shipping-label-print-flow.*` | 仕分け → ピッキングリスト → 送り状印刷の流れと確認事項 |
| `codex/memories/goq-print-flow-rules.md` | 印刷フローのルールメモ |

エージェントの運用ルールは [AGENTS.md](AGENTS.md) にまとめています。

---

## フォルダ構成

```text
run_all.py                     販売データ集計の入口
GshippingDataDownload.py       GoQ 処理済み受注 → スプレッドシート
salesDataDownload_local.py     GoQ / プライスター受注CSV取得
integrated_sales_automation.py スプレッドシート一括更新
salesDataDownload.py           旧版（Drive アップロード版）
shippingLabelDownload.py       旧版の送り状一括DL（通常は無効）
*.mjs（直下）                  印刷プレビュー操作などの小ツール
tools/                         印刷フロー本体とCDP操作ツール
scripts/                       ガード・タスクスケジューラ登録
codex/                         エージェント用スキル・ルール
docs/                          Docker・エージェント運用環境
tests/                         ガードのテスト（pytest）
```

## 注意

- `.env`・`credentials.json`・CSV・PDF・Chrome プロファイルは Git に入れない設定です。パスワードや顧客情報をコミットしないでください。
- 印刷・送り状発行・出荷日入力は GoQ 本番データを変更します。初めて使うステータスはオプションなしの確認モードか `--order` で1件から試してください。
- `shippingLabelDownload.py` は全配送業者の送り状を一括出力してしまうため、通常は動かないようにしています。
