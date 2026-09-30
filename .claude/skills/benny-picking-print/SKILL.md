---
name: benny-picking-print
description: ベニー様用。GoQの注文データ（受注CSV）を読み込み、Smart Pickと同じ形式のピッキングリストPDF（商品名・JAN・総個数、複数個注文リスト、異常検知リスト）を作って、普通紙プリンタに印刷する。「注文データを読み込んでピッキングリストを印刷して」「ピッキングリスト作って」「このCSVでピッキングPDF」「ダウンロードした注文CSVを印刷」などの依頼で使う。GoQの送り状印刷フロー（npm run goq:print）の中のピッキング印刷はフローが自動で行うので、このスキルは使わない。
---

# ベニー様 ピッキングリスト印刷

GoQの注文CSVとマスタ（「ベニー様_ピッキング参照」の `GoQ全データ` タブ）から、Smart Pickと同じ集計・レイアウトのピッキングリストPDFを作り、印刷プレビューで設定を確認してから普通紙に印刷する。

作業フォルダは `C:\Users\stera\Documents\BENNEY\benney_syukka`。コマンドはすべてここで実行する。仕組みの詳細は `tools/local-picking/README.md` にある。

## 守ること

- **元版のGoQ全データ（データ管理② `1V_y-3QNZ0DLLdAG9NSgdn4S-934hhRUcQgNVc7Pxc4I`）は読まない・書かない。** マスタはベニー様シート `1XjamST5FsXEP1-SnPZUotp3naU-KFSgOU57YKmbEwo8` だけを使う。
- **Smart Pick（picking-list-app.vercel.app）は使わない。** 元版のマスタを読むため。
- **PDFと集計結果にはお客様の氏名が入る。** `.o11y/` の外に置かない。チャットやほかのサービスに中身を貼らない。件数・SKU・商品名だけを報告する。
- **印刷は紙が出る操作。** 手順5の条件を満たすまで印刷ボタンを押さない。

## 手順

### 1. 注文CSVを決める

- ユーザーがパスを指定していれば、そのファイルを使う。
- 指定がなければ `--latest-download` を使う（ダウンロードフォルダで一番新しい、商品名・個数・商品SKUの列があるCSV）。どのファイルを使ったかを必ず報告する。
- GoQの注文CSVはShift_JIS。必要な列は「商品名」「個数」「商品SKU」。「商品コード」「SKU管理番号」「GoQ管理番号」「送付先氏名」「配送方法(複数配送先)」「チェック項目」があれば使う。

### 2. マスタを用意する

**A. `credentials.json` がフォルダ直下にある場合（標準）**
何もしなくてよい。手順3でSheets API（読み取り専用）から最新のマスタを読む。
権限エラーが出たら、ベニー様シートがサービスアカウント（`credentials.json` の `client_email`）に閲覧者で共有されているかをユーザーに確認してもらう。

**B. `credentials.json` が無い場合**
Google Driveコネクタで最新のマスタを取り、検証してから使う。

1. Driveコネクタの `download_file_content` を実行する。`fileId` は `1XjamST5FsXEP1-SnPZUotp3naU-KFSgOU57YKmbEwo8`、`exportMimeType` は `text/csv`。
2. 返ってきた `content`（base64）を、1文字も変えずに `.o11y/local-picking/master-<日付>.b64` へ保存する。
3. 検証して取り込む。
   ```
   npm run -s picking:import-master -- --b64 .o11y/local-picking/master-<日付>.b64 --out .o11y/local-picking/master-<日付>.csv
   ```
4. `ok: false` の場合は使わない。`problems` を見て、次のように対応する。
   - 列の位置、または一部の行だけJANのチェックデジット不一致：保存時の書き写しミスか、シート側の誤りが考えられる。取得からやり直し、それでも同じならユーザーに報告する。
   - SET数が数字ではない、または商品SKUの重複：シート側の問題なので、ユーザーに報告して直してもらう。

ユーザーがシートをCSVでダウンロードして渡してくれた場合は、`--csv <そのファイル>` で同じように検証する。

### 3. PDFを作る

```
npm run -s picking:pdf -- --csv <注文CSV>
npm run -s picking:pdf -- --latest-download
npm run -s picking:pdf -- --csv <注文CSV> --master-csv .o11y/local-picking/master-<日付>.csv
```

- 1行目はAのとき、2行目はCSVの指定がないとき、3行目はBのとき。
- 出力されるJSONの `ok` が `true` であることを確認する。
- `false` のときは `error` の内容を報告して止める。よくあるもの：マスタの3行目の見出しと列の位置がずれている（シートの列の挿入・削除）、CSVに必要な列が無い、鍵が無い。

### 4. 中身を確かめる

出力されたPDFを開いて、1ページ目を目で確認し、次の点を報告する。

- `pickingLines`（ピッキング行数）、`totalSingleUnits`（総個数）、`uniqueOrders`（注文件数）
- `anomalyOrders` が1以上のとき：マスタに無い注文がある。`anomalySkus` を示し、PDF末尾の「異常検知リスト」に載っていることを伝える。その商品はピッキング対象から外れているので、マスタへの登録を提案する。
- `emptyJanLines` が1以上のとき：JANが空の行がある。マスタのF列（JAN）の入力を提案する。
- 総個数がおかしい（桁違い、NaN）とき：マスタのG列（SET数）を確認する。

### 5. 印刷する

次のどちらかを満たしたときに印刷する。

- ユーザーが今回の依頼で印刷まで明示していて、手順4で異常（`anomalyOrders`・`emptyJanLines` が0より大きい、総個数が不自然）が無い。
- 手順4の報告を見たユーザーが「印刷して」と答えた。

```
npm run -s picking:print -- --pdf <PDFのパス>
```

- 使い捨てのプロファイルでChromeを起動する。PDFビューアの印刷ボタンを押し、印刷プレビューで送信先「普通紙」・白黒・両面OFFを設定して確かめ、スクリーンショットを撮ってから印刷する。普段使いのChromeやGoQのログインには触れない。
- 設定だけ確認したいときは `--preview-only` を付ける。この場合は印刷しない。
- 結果のJSONで `destination` が「普通紙」、`printed` が `true` になっていることを確認する。スクリーンショット（`screenshot`）を開いて、プレビューに意図したPDFが出ていたかを見る。
- 「プリンタが見つかりません」が出たら、PCに「普通紙」プリンタが登録されているかを確認する（PowerShellの `Get-Printer`）。

### 6. 報告する

- 使った注文CSV
- マスタの取得経路（Sheets API、またはDrive経由で検証済み）
- ピッキング行数・総個数・注文件数、異常検知・JAN空欄の有無
- 作ったPDF、印刷プレビューのスクリーンショット、印刷ログ（`.o11y/local-picking/print-logs/`）のパス
- 印刷したかどうか
