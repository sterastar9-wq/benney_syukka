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
| `export-b2-csv.mjs` | テスト・段階確認用。指定ステータスの注文から B2クラウド用CSV を出力して保存する（注文データは変更しない。お知らせモーダルが出ていても動く） | 実装済み（2026-10-01 に★発送済み2件で確認） |
| `rewrite-b2-csv.mjs` | 取込み直前の書き換え。5列目 出荷予定日を今日に、27/29列目 品名コード1/2 **と 28/30列目 品名1/2** を `data/hinmei-codes.csv` の品名コード（25文字以内）にする（送り状に印字されるのは品名1/2）。書き換える欄以外はバイト列のまま。品名コードを引けない品目は両欄とも GoQ の値のまま警告。B2 必須項目が空の注文は取込み用CSVから外す。印刷フローが自動で行う | 実装済み（実CSVで確認） |
| `import-and-print.mjs` | 引き継ぎファイルの CSV を B2クラウドに取り込み、取込み結果（件数・エラー行）を確認して止まる。**ピッキングリスト印刷の証跡ゲート**（GoQ 側 run log の `printed picking list`、送信先がピッキング用プリンタ）と、印刷済み引き継ぎの再取込みガード（`--reimport`）あり | 実装済み（取込みまで） |
| `issue-and-print.mjs` | 「3.印刷内容の確認」で件数（`--expect-count`）・用紙（`--paper`）を検証して発行開始を押し、PDF ビューア → Chrome 印刷プレビューで送信先（`--printer`）・白黒・両面OFF を確かめて印刷する | 実装済み |
| `print-labels.mjs` | **通常はこれを使う。** 取込み → 取込み結果の確認 → 「印刷内容の確認へ」→ 発行・印刷を 1 本で行う（`npm run yamato:print -- --handoff <引き継ぎJSON>`）。航空危険物の「重要なお知らせ」は `--air-notice-approved` が無ければ記録して止まる | 実装済み |
| `export-tracking.mjs` | 手順 52〜59。「発行済データの検索」で出荷予定日＝今日を検索し、`dataView` から全件読んで引き継ぎの対象がすべて発行済み（送り状番号あり）か検証 → 全選択 →「外部ファイルに出力」→「ファイル出力」（見出しなし）→「ファイルダウンロード」ダイアログの件数を確認して「ダウンロード」。CSV は `.o11y/yamato-b2/tracking-exports/` に保存し、行数・送り状番号を一覧と突合。引き継ぎに無い注文が一覧にあれば止まる（`--allow-extra` で含める）。`npm run yamato:export-tracking -- --handoffs a.json,b.json` | 実装済み（2026-10-01 に 17件で確認） |
| `import-tracking-to-goq.mjs` | 手順 60〜70。GoQ「送り状番号取込」の B2クラウド欄（`input[name=yamatob2webfile]` → `submitdata('YamatoB2WEB')`）に CSV を取り込み、「B2 Webの伝票番号をN件取り込みました。」を記録 → 対象注文ごとに送り状番号を検証（一覧の行には出ないので注文詳細 `order_details_beta.php` の `da19[*]` を読む）→ 検証できた注文だけ元ステータスで選択し `select[name=status_id]`＝★発送済み(29) →「変更」→ 元ステータスから消え ★発送済み に現れることを確認。`--set-ship-date today` で、出荷日が空の注文に注文詳細の出荷日（hidden `a59`）を入れて「入力内容を反映する」で保存してから移す。`--skip-status-change` で検証まで、`--status-only` で取込みを飛ばす | 実装済み（2026-10-01 に 16件で取込み→出荷日記入→★発送済みまで確認） |

## 使い方

```powershell
# 通し実行（GoQ 印刷 → ヤマト発行・印刷 → 送り状番号出力 → GoQ 取込・出荷日・★発送済み → 出荷件数報告）
npm run ship -- --statuses nekoposu,takkyubin [--air-notice-approved] [--allow-extra]
```

個別に実行する場合:

```powershell
# 送り状の取込み〜印刷（GoQ 側のフローが書いた引き継ぎファイルを渡す）
npm run yamato:print -- --handoff .o11y\goq-unified-print-flow\b2-handoff\<日時>-<status>.json
# 航空危険物の確認ポップアップが出て止まったら、品目を確認したうえで
npm run yamato:print -- --handoff <同じファイル> --air-notice-approved

# 送り状番号を B2 から出力（複数ステータスの引き継ぎをまとめて）→ GoQ に取込み → ★発送済み へ
npm run yamato:export-tracking -- --handoffs <nekoposu.json>,<takkyubin.json>
npm run yamato:import-tracking -- --set-ship-date today --handoffs <nekoposu.json>,<takkyubin.json>
```

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

手順 12–51（GoQ での CSV 出力と B2クラウドでの取込・印刷）は PDF から欠落していたが、2026-10-01 に実運用で確認して実装済み（下の「取込みで分かったこと」「発行・印刷・再発行で分かったこと」）。

## 実装状況（2026-10-01 時点）

ヤマト側の自動化は、取込み → 発行・印刷 → 送り状番号の出力 → GoQ への取込み → 出荷日記入 → ★発送済み → 出荷件数の報告 まで一通り動作確認済み（ネコポス14件・宅急便2件）。走査時に未決だった点は次のとおり決着している。

- 取込みパターン: 「基本レイアウト(csv,xls,xlsx)」（`#torikomi_pattern` = 1）、取込み開始行 1
- 取込みエラー行: 取込み結果の「修正必要件数／確認必要件数」と赤字行で判定。注文との対応は お客様管理番号 = `GoQ番号-枝番`
- 発行・印刷: 「印刷内容の確認」→ 発行開始 → 同じ画面に PDF ビューア（fancybox）→ ツールバー印刷 → Chrome 印刷プレビュー（`issue-and-print.mjs`）
- 送り状番号の戻し: 「発行済データの検索」→ 外部ファイルに出力 → GoQ 送り状番号取込 B2クラウド欄 → 注文詳細で検証（`export-tracking.mjs` / `import-tracking-to-goq.mjs`）

未調査: GoQ の設定で一覧に出荷日の一括入力欄を出せるか（出せれば出荷日記入を1操作にできる）。

## 取込みで分かったこと（2026-10-01）

- 取込み開始行は既定が 2。GoQ のCSVは見出しなしなので 1 にする（`import-and-print.mjs` が設定）
- 出荷予定日が「本日〜30日後」の範囲外だと、取込み結果で「修正必要」になる（エラー内容は取込み結果一覧の No. セルを押すと出る: 「出荷予定日は本日～30日後までの範囲で指定して下さい。」）。GoQ の出荷日（未入力や過去日）がそのまま出るため、`rewrite-b2-csv.mjs` で今日に書き換える
- GoQ は品名コード1（27列目）に商品コードを先頭30文字で入れる。品名1（28列目）は商品名を途中で切ったもの
- ヤマトビジネスメンバーズは 7:00〜25:00 のみ（B2クラウドは 4:00〜）。時間外はログイン欄が出ない

## 発行・印刷・再発行で分かったこと（2026-10-01）

- `issue-and-print.mjs` で「3.印刷内容の確認」から発行・印刷できる（宅急便 1件 → A4マルチ用紙、ネコポス 12件 → ネコポス用紙で確認）。発行後は同じ画面に PDF ビューア（fancybox）が開き、ツールバーの印刷ボタンから Chrome の印刷プレビューに進む
- 取込み結果画面の「印刷内容の確認へ」（`a#confirm_issue_btn2`）は、品目によって **「重要なお知らせ」ポップアップ（`air_shipment_notice.html`、航空危険物の確認）** が iframe で開く。ボタンは `#dangerous_list` / `#return_btn`（修正する）/ `#airline_equipped_sub`（伝票発行）。続行の判断はオペレーターに確認する（2026-10-01 はオールドスパイス・シャンプーで「伝票発行」を承認）
- 取込み結果を表示したまま 30 分ほど放置すると、次の操作で `system_error.html?api=0`（スクリプトエラー）になる。B2 の画面を直接 URL で開いても同じエラーになるので、メンバーズのホーム（ME0001.htm）から `useService('06','2')` で入り直す（`import-and-print.mjs` が自動で行う）。取込み済み・未発行のデータは残らないので取込み直す
- ヘッダの「メインメニュー」（`#mainMenu_href`）は **ビジネスメンバーズ側** のメニューに戻る（確認ダイアログ付き）。B2 のメインメニューへは「B2クラウド」（`#B2WebmenuEtc_href`、確認ダイアログ「B2クラウド TOPに戻ります」）を使う
- **印刷不良時の再印刷はメインメニューの「再発行」（`div#reissue_search` → `reissue_search.html`）**。「発行済データの検索」には再印刷ボタンがない。出荷予定日 `#shipment_from` / `#shipment_to` → `a#Search`。一覧は SlickGrid（左ペーン `.slick-pane-left` に `input.data_check`、右ペーン `.slick-pane-right` にデータ。`style.top` で行を対応づける）。選択後 `a#confirm_issue_btn`（印刷内容の確認へ）→ 通常と同じ `print_check.html` に進むので `issue-and-print.mjs` がそのまま使える。再発行しても送り状番号は変わらない
- **送り状番号の戻し（2026-10-01）**: 「発行済データの検索」の一覧は SlickGrid で、グローバル `dataView.getItems()`（`tracking_number` / `service_type` / `shipment_number`＝お客様管理番号 / `shipment_date`）と `grid.getSelectedRows()` で全件読める（描画されていない行も含む）。「外部ファイルに出力」（`a#issue_data_btn`）→ iframe `external_output.html`（`#check_title` 見出し、`a#output_file`）→ jQuery UI ダイアログ「ファイルダウンロード N件出力しました。」→ `button` ダウンロード。ダウンロードは CDP `Browser.setDownloadBehavior`（allowAndName）で保存先を固定して捕まえる。出力 CSV は Shift_JIS・引用符付き・見出しなし、1列目 お客様管理番号、4列目 送り状番号（ハイフンなし12桁）
- GoQ「送り状番号取込」は `submitdata('YamatoB2WEB')` で同じページに POST され、「B2 Webの伝票番号をN件取り込みました。」が出る。取込み後も受注一覧の行には送り状番号も `[伝票入力済]` も出ない（★発送済みの行には出る）ので、確認は注文詳細（`order_details_beta.php?oid=`）の `input[name="da19[0]"]` で行う。受注ステータスの一括変更は一覧の `select[name=status_id]`（30/26/27/29/32/17/33/24/3/6）と隣の「変更」ボタン
- **出荷日**: ベニー様のステータスは出荷日を扱わず、送り状番号取込でも出荷日は入らない。一覧に出荷日の一括入力欄（元版の `#inputstype` / `B012`）も無い。★発送済み に移す条件は「送り状番号と出荷日の両方あり」（2026-10-01 オペレーター指示）なので、`import-tracking-to-goq.mjs --set-ship-date today` が注文詳細（`order_details_beta.php?oid=`）の hidden `a59` に `YYYY-MM-DD` を入れて「入力内容を反映する」を押す（「更新しました」が出て、一覧の `#ship_send_date_<番号>` と17列目に反映される）。GoQ の設定で一括入力欄を出せるなら、そちらに切り替える余地あり（未調査）
- B2 で手動発行した注文（例 2026-10-01 の 17213）が一覧に混ざることがある。`export-tracking.mjs` は止まるので、自社の注文と確認したうえで `--allow-extra` で含める（送り状番号は GoQ に戻す。ステータス変更は引き継ぎの対象だけ）
- ビジネスメンバーズのセッションが切れると、B2 への `useService` が OAuth の authorize でシステムエラーになる。`npm run yamato:login` で入り直す
- プリンタは Apeos C5240 用に作った「C5240 普通紙 / C5240 ヤマト/コンパクト / C5240 ネコポス / C5240 佐川」を使う（`.env` の `PRINTER_*`）。接頭辞なしの同名キューは旧機 C3530 用で、送信先の部分一致（「ヤマト」）だと先にそちらが選ばれるため、必ず接頭辞付きで指定する。「C5240 ネコポス」は作成直後は普通紙トレイ指定になっていて普通紙に出た（キュー側の給紙設定を直して再発行）
