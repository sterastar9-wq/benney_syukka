# GoQ Print Flow Rules (Benny version)

## Reviewed Autonomous Execution

- Autonomous GoQ print work must use `npm run goq:print -- --status <status> --execute` (local Node.js; Docker is not used).
- The reviewed wrapper runs `tools/goq-print-flow.mjs`, then always runs `tools/goq-run-review.mjs` against the produced run log and writes `.o11y/goq-unified-print-flow/reviews/*.review.json`.
- Do not report completion when the wrapper exits non-zero, when review violations remain, or when review warnings remain without explicit acceptance.
- Direct `node tools/goq-print-flow.mjs ...` execution is for debugging only.
- The executor records `run.goal` before side effects. The reviewer starts from that goal, verifies status/date/scope/output-mode alignment, and then verifies detailed guardrails.
- Credentials come only from the repository `.env`. The runner verifies the GoQ login state first and logs in from `.env` when the login page is shown.

## B2 Cloud CSV Route (Benny Yamato-family)

- Benny's statuses are `nekoposu` (★ネコポス・クリックポスト, stat 30), `takkyubin` (★宅急便, 26), and `cool` (★クール便, 27); all use `labelMode: b2-csv`. The GoQ B2 Cloud API button (`#B2CloudGeneratePdfApi`) is never pressed. Rows with carrier `日本郵便` are excluded as carrier mismatch. Picking CSV is custom id 1.
- After the picking list is printed and rows are reselected/verified, the runner records the label target snapshot, selects the B2 Cloud format in `#trader_s`, hooks the output form submission, and fetches the same request to save the CSV under `.o11y/goq-unified-print-flow/downloads/`.
- The CSV (Shift_JIS) is verified row by row against the target snapshot: every target GoQ ID/order number must appear, and no row outside the snapshot may exist. Otherwise the run stops.
- On success the runner writes a handoff file under `.o11y/goq-unified-print-flow/b2-handoff/` and records `exported shipping label csv`, `verified shipping label csv against target snapshot`, and `wrote b2 cloud handoff`.
- Label printing, tracking-number export, and GoQ `送り状番号取込` happen on the Yamato Business Members side (`tools/yamato-b2/`). Completion of the whole shipping set requires that side too.
- The legacy `RequestB2CloudDeliveryInvoice.php` / `b2CloudDeliveryInvoiceExportRequest` evidence rules below apply only to `goq-api` mode (original version, Sagawa-style API generation).

## Amazon-only Store Split

- Amazon-only printing uses the order-list store tab, not a search-panel mall filter.
- Use explicit Amazon status keys for normal operation: `sagawa-amazon`, `yamato-amazon`, `compact-amazon`, `nekoposu-amazon`, or `hold-sagawa-amazon`.
- Base status keys such as `sagawa` and `nekoposu` must never apply the Amazon tab unless explicitly instructed with an Amazon status key or option.
- Click only the exact `Amazon` tab. Do not partial-match `Amazon福岡`, `Amazon振分用`, `Amazon 2号店`, or `Amazon 3号店`.
- Apply the exact `Amazon` tab before any side effects so non-Amazon rows are not selected for shipping-date overwrite, and reapply or verify `#st = Amazon` immediately after the combined search filter.

## Product Name Sort

- 商品名ソートは、GoQ注文一覧の表示順に対して必須。
- ピッキングCSVの商品名順は一切確認しない。ピッキングリストの並び順はローカルのピッキングPDF作成処理（JAN下4桁→商品名順）が決める。
- 送り状印刷順に影響するのはGoQ注文一覧のDOM順。商品名ヘッダーをクリックしただけでは完了扱いにせず、DOM順の更新を検証してから次工程へ進む。
- 商品名ソート後の確認は固定待ちではなく、約100ms間隔で `order_item.a6` とDOM行順変化をポーリングする。
- 商品名ソート操作が検証できない場合は、後工程へ進まず停止して報告する。

## Selection And Filtering

- Before judging eligible rows or selecting rows, set and verify the GoQ order-list display count to `500件`.
- 出荷日上書き前の選択は、印刷対象選択ではなく、日付上書き対象の一時選択として扱う。上書き後は画面更新で選択がクリアされる。
- 絞り込みは、出荷日 = 今日 と 伝票番号 = 未入力 を同時に設定してから1回だけ実行する。
- 商品名ソート後の印刷対象選択は、すべて選択チェックボックスで全表示行を選択し、除外対象だけチェックを外す。
- 伝票番号入力済みや出荷日不一致は検索条件で基本的に表示から落ちるが、選択後にもDOMで再確認し、漏れがあれば停止する。

## Address Safety

- 注文データにない住所要素は追加しない。住所修正は正規化、分割、表記変換までに限定する。
- 外部情報が必要な場合でも、WEB検索や設定済み外部検証で根拠が明確なら自律的に修正してよい。保存した場合は根拠/source と before/after を実行ログへ残す。曖昧なら保存せず、未解決扱いにする。
- 解決できない住所エラーは勝手に補完せず、停止して次アクションを確認する。

## Phone Number Safety

- 電話番号は、全角数字を半角数字へ、全角ハイフン・長音・ダッシュ類などの区切り文字を半角ハイフン `-` へ寄せる正規化だけ許可する。
- 電話番号の数字を追加しない。削除しない。桁数補正しない。先頭 `0`、国番号、市外局番、内線などを推測で補完しない。
- 保存前に必ず `digits(before) === digits(after)` を検証する。数字列が変わる場合は保存せず停止して報告する。

## Address Width Safety

- 全角半角の自動正規化は電話番号だけに限定する。
- 住所の全角数字、全角ハイフン、長音風区切りは、自動保存しない。住所警告がある場合は before/after 案を報告し、明示指示がある場合だけ保存する。

## Address Warning Detection And Normalization

- Immediately after entering each GoQ status, inspect the order-list carrier column for address warnings such as `【住】`.
- Orders with address warnings must be opened on the delivery-address correction page and checked/fixed before CSV export or shipping-label generation.
- Do not proceed to picking-list printing, label CSV export, or shipping-label printing while a target order has an address warning that has not been reviewed/fixed or explicitly classified as unresolved after correction/validation and memo-marked with `住所不正`.
- If the prefecture field already contains the prefecture, remove duplicated prefecture text from address 1.
- Normalize full-width digits to half-width digits; normalize dash-like address separators to ASCII `-`.
- Do not remove hyphens used in lot numbers. Do not remove telephone hyphens. Do not change telephone numbers unless explicitly required.
- Split address fields as: address 1 = municipality plus town area; address 2 = lot number and after, including building name and company name.
  - Before: `沖縄県 / 沖縄県豊見城市豊崎１－１１７８Fステージ豊崎パークフロント1003 / 株式会社ジャスミン`
  - After: `沖縄県 / 豊見城市豊崎 / 1-1178 Fステージ豊崎パークフロント1003 株式会社ジャスミン`

## Address Warning Resolution Definition

- A surface `【住】` warning that remains in the GoQ list after correction is not unresolved by itself.
- Reviewed/fixed means the row was opened and a safe correction was saved, or external/operator validation was explicitly recorded as confirmed.
- Unresolved means the address still fails after correction/validation, or a user-confirmed unresolved case. Before exclusion, write `住所不正` to the GoQ one-line memo.
- Manual exclusion is allowed only for address-warning rows explicitly classified as unresolved after correction/validation and memo-marked.

## Output Order And Label-Issuance Difference Check

- Default order remains picking list, then shipping labels (or, for b2-csv, the label CSV export).
- Before shipping-label CSV export or generation, persist the exact target snapshot: GoQ IDs, order numbers, status, carrier, ship date, and request time.
- goq-api mode: after generation, compare the target snapshot with GoQ rows that have a tracking number or label-issued marker. Do not rely only on PDF generation success. If target rows disappeared from the source status, use the `全て` status filtered by today's shipping date and directly target the saved GoQ/order numbers.
- b2-csv mode: compare the CSV rows with the target snapshot; later compare Yamato's issued list and GoQ's imported tracking numbers with the same snapshot.
- A target row with no tracking number or label-issued marker after the whole set is `送り状未発行/除外された可能性あり`. Always report unissued label count and details.
- `--label-first` is emergency/special-case only.

## Label Generation Dialog Handling

- After pressing a shipping-label generation button or the CSV output button, do not blindly accept a modal or JavaScript dialog and continue.
- If a modal, alert, confirm, prompt, or visible error dialog appears, read and record its type/text/buttons/context in the run log.
- Close only what is necessary to unblock the browser, then stop for review unless the recorded text is a known non-blocking success/confirmation notice.

## Yamato B2 Cloud Request Evidence (goq-api mode only)

- For Yamato-family labels generated through the GoQ API, a request accepted by GoQ should create either a success PDF card or an error report card in the download file list within about one minute.
- Monitor `axios.post` for `RequestB2CloudDeliveryInvoice.php` around `#B2CloudGeneratePdfApi` clicks and record the result in the run log.
- If no B2 Cloud POST is recorded, invoke the page-defined `b2CloudDeliveryInvoiceExportRequest('B2CloudGeneratePdfApi', 'b2_cloud_api_printStartLocation', 'ヤマト運輸', orderBySql)` once for the same selected GoQ IDs. Never run that fallback when a B2 Cloud POST was already recorded.
- In the Benny version this section is not used for `yamato`, `compact`, or `nekoposu` because they use the B2 Cloud CSV route.

## Dashboard Notice Modal

- When entering the GoQ dashboard, handle an お知らせ/notice modal before entering the order list.
- If the notice has checkboxes, scroll the modal as needed and check every enabled checkbox, then press the confirmation button such as `上記について確認しました`.
- Record the handled modal in the run log.

## Printer Destination Review Guard

- Every print-output step must record the expected printer and the actual Chrome print-preview destination.
- Review must fail when the destination is missing or does not match the status-specific printer route.
- Printer names on this PC: `FUJIFILM Apeos C5240普通紙` / `FUJIFILM Apeos C5240ヤマト` / `FUJIFILM Apeos C5240佐川` / `FUJIFILM Apeos C5240ネコポス（手差し）`. Matching is by substring; override with `.env` `PRINTER_*`.
- Picking list destination must include `普通紙`.
- Sagawa and hold-Sagawa label destinations must include `佐川`.
- Yamato and Compact label destinations must include `ヤマト`.
- Nekopos label destination must include `ネコポス`.
- A Sagawa label printed to the Yamato printer is a review violation even if the print job completed.
