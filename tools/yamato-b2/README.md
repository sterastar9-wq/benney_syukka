# ヤマトビジネスメンバーズ（B2クラウド）連携（ベニー様フロー 4）

ベニー様の送り状フローは、GoQ の発行ボタンを使わず、次の順で行います。

1. GoQ にログイン（`tools/goq-login.mjs`。印刷フローが自動で行う）
2. ピッキングリストをローカルで作って普通紙に印刷（`tools/local-picking/`）
3. GoQ から **B2クラウド用の送り状データCSV** を出力し、対象注文と突合して引き継ぎファイルを書く（`tools/goq-print-flow.mjs` の `b2-csv` モード）
4. **ヤマトビジネスメンバーズにログインし、CSV を B2クラウドに取り込んで送り状を印刷する**（このフォルダ）

## ファイル

| ファイル | 役割 | 状態 |
|---|---|---|
| `login.mjs` | `.env` の必須コード・任意コード・パスワードでログインし、ホームに会社名（既定 `合同会社Ｂｅｎｙ`）が出ることを確認する | 実装済み（ログイン欄のセレクタは画面から推定。走査後に `.env` の `YAMATO_SELECTOR_*` で固定可能） |
| `survey.mjs` | ログイン済みタブから同一ドメインの画面を読み取り専用でたどり、見出し・リンク・フォーム・ボタン・フレームを `.o11y/yamato-b2/survey/<日時>/` に記録する | 実装済み |
| `import-and-print.mjs` | 引き継ぎファイルの CSV を B2クラウドに取り込み、取込結果を確認し、送り状を印刷し、送り状番号を GoQ に戻す | **未実装**（走査結果を見てから作る） |

## 使い方

```powershell
# Chrome をリモートデバッグ付きで起動（初回だけ。以後は起動済みなら何もしない）
powershell -ExecutionPolicy Bypass -File scripts\start-chrome-cdp.ps1

# ログイン（.env を読む。パスワードは出力しない）
npm run yamato:login

# 画面構造の走査（副作用のあるリンクはたどらない）
npm run yamato:survey -- --max-pages 40 --depth 2 --screenshots
```

`--check` を付けるとログイン状態の確認だけ行います。

## `.env` のキー

| キー | 内容 |
|---|---|
| `YAMATO_BENY_CODE` | お客様コード（ログイン画面の `#code1`、9〜12桁） |
| `YAMATO_BENY_EDABAN` | お客様コードのハイフン以降の枝番（`#code2`、3桁。無ければ空） |
| `YAMATO_BENY_PASSWORD` | パスワード（`#password`） |
| `YAMATO_EXPECTED_COMPANY` | ログイン後に表示されるべき会社名（既定 `合同会社Ｂｅｎｙ`） |
| `YAMATO_LOGIN_URL` | ログインURL（既定は HMPLGI0010JspServlet） |
| `YAMATO_SELECTOR_CODE` など | 走査で確定した入力欄のセレクタ（任意） |

## 引き継ぎファイル

GoQ 側のフロー（`npm run goq:print -- --status yamato --execute` など）が成功すると、
`.o11y/goq-unified-print-flow/b2-handoff/<日時>-<status>.json` に次の内容が書かれます。

- `csv`: 出力した B2クラウド用CSV（Shift_JIS）のパス
- `targets`: 対象注文（GoQ番号・注文番号・配送業者・出荷日）
- `labelPrinter`: 送り状の送信先プリンタ（ヤマト／コンパクトは `ヤマト`、ネコポスは `ネコポス`）
- `yamato.imported` / `printed` / `trackingImportedToGoq`: ヤマト側の進捗（`import-and-print.mjs` が更新する）

## 走査で分かった画面構造（2026-09-30）

**ヤマトビジネスメンバーズ（bmypage.kuronekoyamato.co.jp）**

- ログイン: `#code1`（お客様コード）/ `#code2`（枝番）/ `#password` → `a.login`（`func_request_Link('LOGIN')` が `bmypageapi/login` に POST）
- ホーム（`ME0001.htm`）に会社名「合同会社Ｂｅｎｙ⇔ステラスター」が表示される
- B2クラウドへは `ybmCommonJs.useService('06','2')` を呼ぶと同じタブが `https://newb2web.kuronekoyamato.co.jp/main_menu.html` に遷移する

**B2クラウド（newb2web.kuronekoyamato.co.jp）**

| 画面 | URL | 主な要素 |
|---|---|---|
| メインメニュー | `main_menu.html` | `div#ex_data_import`（外部データから発行）、`div#issue_search`（発行済データの検索）、`div#data_import_ex`、`div#general_setting` |
| 外部データから発行 | `ex_data_import.html` | `select#torikomi_pattern`（0 新規レイアウト / 1 基本レイアウト(csv,xls,xlsx) / 2 EC自宅外受取 / 保存済みパターン）、`input#filename[type=file]`（非表示、`.csv` 可。表示欄は `#file` と `a#file_button`）、`input#torikomi_strat_row`（取込み開始行、既定 2）、`a#import_start`（取込み開始。無効時は class `disable`）、紐付け設定テーブル（出荷予定日・お客様管理番号・送り状種類…）。工程は「1.データ取込み → 2.取込み結果表示 → 3.印刷内容の確認 → 4.登録完了・印刷」 |
| 発行済データの検索 | `issue_search.html` | `#shipment_plan_from` / `#shipment_plan_to`（出荷予定日、既定は過去90日〜今日）、`#consignee_name`、`#tracking_number`、`a#Search`、結果テーブルの `input.allCheck`、`a#issue_data_btn`（外部ファイルに出力）、`a#delete_btn` |

GoQ が出す B2クラウド用CSV（`b2_cloud`）は見出しなし・98列で、B2クラウドの「基本レイアウト」と同じ並び（お客様管理番号 = `GoQ番号-枝番`、送り状種類、クール区分、伝票番号、出荷予定日、…）。取込みは「基本レイアウト」＋取込み開始行 `1` の想定。

**GoQ 側の送り状番号取込（`/goq21/input/deliveryslip.php`）**

- 「ヤマト運輸送り状発行ソフトB2クラウド」の欄: `input[type=file][name="yamatob2webfile"]` と隣の `データ取込` ボタン。B2クラウドの「外部ファイルに出力」で落とした CSV をそのまま取り込む

**ベニー様の手順書（Tango「ベニー伝票作成 完成」70手順）で確認できた後半の流れ**

52. B2クラウド「発行済データの検索」→ 53–54. 出荷予定日を今日〜今日にして検索 → 55–56. 今回発行した伝票をすべてチェック → 57. 外部ファイルに出力 → 58. ファイル出力（何も選択しない）→ 59. ダウンロード
60. GoQ「送り状番号取込」→ 61. B2クラウド欄でダウンロードしたCSVを選択 → 62. データ取込 → 63–65. 伝票番号が全件入っていることを確認（簡易詳細一覧表示）→ 66. 最後の追跡番号をチェックシートに記入
67–70. 元のステータスで すべてチェック → 受注ステータスの変更で「★発送済み」→ 変更する

手順 12–51（GoQ での CSV 出力と B2クラウドでの取込・印刷）は PDF から欠落しているため未確認。

## これから決めること（走査後）

- B2クラウドの「外部データ取込」で使う取込パターン（GoQ の B2 形式に合わせたもの）と、そのパターンの選び方
- 取込エラー行の見つけ方と、GoQ 側の注文への対応付け（お客様管理番号 = GoQ番号 の想定）
- 発行・印刷画面の構造（PDF が新しいタブで開くのか、印刷ダイアログが出るのか）と、印刷プレビューでの送信先確認方法
- 発行済みデータの出力（送り状番号）と、GoQ の `送り状番号取込` への戻し方
