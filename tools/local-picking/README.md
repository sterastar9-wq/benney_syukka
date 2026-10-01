# ローカル ピッキングリスト（ベニー様版）

Smart Pick（https://picking-list-app.vercel.app/）を使わずに、ピッキングリストのPDFをこのPCの中だけで作り、送り状と同じ手順で印刷します。

Smart Pick はサーバー側で元版の「GoQ全データ」を読むため、ベニー様の商品では使えません。この仕組みは Smart Pick の集計ロジックと印刷レイアウトをそのまま移植したものです。同じ入力なら同じ結果になることを、回帰テストで確認しています。

## 流れ

1. `goq-print-flow.mjs` が、これまでどおりGoQのCSV API（`custom_id=6`）でピッキングCSVを取得する
2. `build.mjs` が、ピッキングCSVとマスタ（ベニー様シートの `GoQ全データ` タブ）を読み、集計してHTMLとPDFを作る
3. PDFを新しいタブで開き、PDFビューアの印刷ボタンから **普通紙** に印刷する（送り状PDFと同じ印刷プレビューの確認手順）
4. 実行ログに `generated local picking pdf` と `printed picking list` を記録し、レビューで検証する

作ったファイルは `.o11y/goq-unified-print-flow/picking/` に残ります。

| ファイル | 中身 |
|---|---|
| `picking-日時.pdf` | 印刷したPDF |
| `picking-日時.html` | PDFの元になったHTML |
| `picking-日時.report.json` | 集計結果（お客様の氏名を含むため、外に出さない） |
| `picking-日時.master.json` | そのとき読んだマスタのスナップショット |

## 初回の準備

1. **サービスアカウント鍵を置く**
   フォルダ直下に `credentials.json` を置きます（日次集計のPythonスクリプトと同じものを使えます）。別のファイルを使う場合は、環境変数 `PICKING_CREDENTIALS_FILE` でパスを指定します。
2. **ベニー様シートを共有する**
   「ベニー様_ピッキング参照」を、`credentials.json` の `client_email` に **閲覧者** で共有します。読み取り専用の権限で読むので、シートに書き込むことはありません。
3. **動作確認**
   GoQからピッキングCSVを1つ保存し、次のコマンドでPDFだけを作ります。印刷はしません。

   ```powershell
   npm run picking:pdf -- --csv <保存したCSV>
   ```

   出力の `pdf` に表示されたPDFを開いて、中身を確認してください。

## 注文CSVから単体で作って印刷する（スキル benny-picking-print）

GoQの送り状印刷フローを使わずに、注文CSVだけからピッキングリストを作って印刷することもできます。手順はスキル `.claude/skills/benny-picking-print/SKILL.md` にまとめてあります。

| やること | コマンド |
|---|---|
| PDFを作る（CSVを指定） | `npm run -s picking:pdf -- --csv <注文CSV>` |
| PDFを作る（ダウンロードフォルダの最新CSV） | `npm run -s picking:pdf -- --latest-download` |
| マスタのCSVを検証して取り込む（鍵が無いとき） | `npm run -s picking:import-master -- --b64 <file> --out <CSV>`（または `--csv <file>`） |
| 印刷する | `npm run -s picking:print -- --pdf <PDF>` |
| 印刷プレビューで設定だけ確認する | `npm run -s picking:print -- --pdf <PDF> --preview-only` |

印刷のときは、使い捨てのプロファイルでChromeを起動します。PDFビューアの印刷ボタンから印刷プレビューを開き、送信先「普通紙」・白黒・両面OFFを確かめ、スクリーンショットを残してから印刷します。結果は `.o11y/local-picking/print-logs/` に記録されます。

## 設定（環境変数）

| 変数 | 既定値 | 内容 |
|---|---|---|
| `PICKING_MASTER_SHEET_ID` | `1XjamST5FsXEP1-SnPZUotp3naU-KFSgOU57YKmbEwo8` | マスタのスプレッドシートID（ベニー様_ピッキング参照） |
| `PICKING_MASTER_RANGE` | `GoQ全データ` | 読むタブ名（1行目から全行を読む）。未設定で `PICKING_MASTER_GID` がある場合は gid からタブ名を解決する |
| `PICKING_MASTER_GID` | なし | スプレッドシートURLの `gid=` の値（ベニー様シートは `1344234198`） |
| `PICKING_CREDENTIALS_FILE` | `credentials.json` | サービスアカウント鍵 |
| `PICKING_MASTER_CSV` | なし | 指定すると、Sheets APIではなくこのCSV（マスタをCSVで保存したもの）を読む |
| `PICKING_CHROME_PATH` | 自動検出 | 単体でPDFを作るときに使うChrome |

元版のGoQ全データ（データ管理② `1V_y-3QNZ0DLLdAG9NSgdn4S-934hhRUcQgNVc7Pxc4I`）を指定すると、読む前に止まります。

## マスタの読み方（Smart Pickと同じ）

GoQ全データの列を **位置** で読みます。1行目はメモ行で見出しではないので、Smart Pickも実際は常に既定の列番号で読んでいます。

| 列 | 見出し | 使い方 |
|---|---|---|
| Q | 商品SKU | CSVの「商品SKU」（なければ「SKU管理番号」）と大文字・小文字を区別せずに照合する |
| F | JAN | まとめる単位・並び順（JANの下4桁）・表示 |
| G | SET数 | 単品に換算した数 = SET数 × 個数（空欄なら1） |
| R | 親 | 表示する商品名（空欄ならCSVの商品名） |
| H・I・J | 親ASIN-2・親JAN-2・SET-2 | H列が入っていれば親JAN・親数量を括弧書きで出す |
| V・W | 引継ぎ元・引継ぎ先 | V列に値があれば、W列が同じ値の行に差し替える |

ピッキングの対象になるかどうかは、CSVの「商品コード」か「商品SKU」がQ列にあるかで決まります。無い注文は、PDF末尾の「⚠ 異常検知リスト（マスタ未登録）」に載ります。

**列ずれ防止**:3行目の見出し（Q=商品SKU、F=JAN、G=SET数、E=親ASIN、H=親ASIN-2、I=親JAN-2、J=SET-2、K=子ASIN、R=親）が想定と違う場合は、PDFを作らずに止まります。列を挿入・削除すると数量を別の列から読んでしまうためです。

## 3品以上の注文リスト（ベニー様独自）

送り状（B2クラウド）の品名コード欄は2品までなので、1つの注文に3品以上ある場合は送り状で商品を確認できません。そのため、ピッキングリストの合計欄の下に「3品以上の注文リスト」を出し、注文ごとに全商品の **品名コード・商品名・個数・JAN** を並べます。

- 品名コードは `data/hinmei-codes.csv`（商品SKU → 品名コード）から引きます。無い商品は「（品名コード未登録）」と表示されます
- 3品以上の注文が無いときは、この一覧は出ません
- Smart Pick には無い機能なので、Smart Pick との一致テストの対象外です（`npm run test:picking` の `manyItemOrders` で別に確認）

## 特別扱いの商品

Smart Pickのコードに直接書かれていた「JAN確認が必要なSKU」と「JANの表示を差し替えるJAN」は、[exceptions.json](exceptions.json) に移しました。ベニー様版は空から始めています。

- `janCheckSkus`: ここに入れたSKUは「JAN確認用リスト」に載り、複数個注文の判定をSET数×個数で行う
- `janDisplayExceptions`: `{"JAN": "表示したい文字"}` の形で書くと、JAN欄にその文字の下4桁を出す

## テスト

```powershell
npm run test:picking
```

`fixtures/` の合成データ（お客様情報なし）で集計し、Smart Pickの元コードで出した正解（`fixtures/expected-smart-pick.json`）と全項目を比べます。`npm run check` でも実行されます。集計ロジックを変えたときは、必ずこのテストを通してください。Smart Pick側の仕様が変わった場合は、Smart Pickの元コードで正解を作り直してください。
