# GoQ Print Flow Rules

## Reviewed Autonomous Execution

- Autonomous GoQ print work must use `docker compose exec goq npm run goq:print -- --status <status> --port 9223 --execute`.
- The reviewed wrapper runs `tools/goq-print-flow.mjs`, then always runs `tools/goq-run-review.mjs` against the produced run log and writes `.o11y/goq-unified-print-flow/reviews/*.review.json`.
- Do not report completion when the wrapper exits non-zero, when review violations remain, or when review warnings remain without explicit acceptance.
- Direct `node tools/goq-print-flow.mjs ...` execution is for debugging only.
- The executor records `run.goal` before side effects. The reviewer starts from that goal, verifies status/date/scope/output-mode alignment, and then verifies detailed guardrails. The reviewer should steer the executor back to the goal rather than merely checking whether steps happened.

## Amazon-only Store Split

- Amazon-only printing uses the order-list store tab, not a search-panel mall filter.
- Use explicit Amazon status keys for normal operation: `sagawa-amazon`, `yamato-amazon`, `compact-amazon`, `nekoposu-amazon`, or `hold-sagawa-amazon`.
- Base status keys such as `sagawa` and `nekoposu` must never apply the Amazon tab unless explicitly instructed with an Amazon status key or option.
- Click only the exact `Amazon` tab. Do not partial-match `Amazon福岡`, `Amazon振分用`, `Amazon 2号店`, or `Amazon 3号店`.
- For safety, apply the exact `Amazon` tab before any side effects so non-Amazon rows are not selected for shipping-date overwrite.
- For speed and stability, reapply or verify `#st = Amazon` immediately after the combined search filter `shipping date = today` + `tracking/report number = empty`.
- After the Amazon tab is applied, verify the DOM state (`#st`) and visible rows before sorting/selecting/printing.

## Product Name Sort

- 商品名ソートは、GoQ注文一覧の表示順に対して必須。
- ピッキングCSVの商品名順は一切確認しない。ピッキングリストの並び順はローカルのピッキングPDF作成処理（Smart Pickと同じJAN下4桁→商品名順）が決めるため、エージェントの判断対象から外す。
- 送り状印刷順に影響するのはGoQ注文一覧のDOM順。
- 商品名ヘッダーをクリックしただけでは完了扱いにしない。
- クリック後、GoQ一覧テーブルの `商品名` を含む列をDOMから読み、GoQ一覧のDOM順が更新されたことを検証してから次工程へ進む。GoQでは `商品名 送り先住所` のような複合ヘッダーになり得る。
- 商品名ソート後の確認は固定待ちではなく、約100ms間隔で `order_item.a6` とDOM行順変化をポーリングする。
- GoQ独自のソート順をエージェント側の辞書順で再判定しない。確認対象は、GoQの商品名ソート操作が実行され、一覧DOM順が反映されたこと。
- 商品名ソート操作が検証できない場合は、後工程へ進まず停止して報告する。
- フロー順は変えない: GoQ一覧を商品名順に並べる → ピッキングリスト印刷 → 送り状印刷。

## Selection And Filtering

- Before judging eligible rows or selecting rows, set and verify the GoQ order-list display count to `500件`.
- 出荷日上書き前の選択は、印刷対象選択ではなく、日付上書き対象の一時選択として扱う。
- 出荷日上書き後は画面更新で選択がクリアされるため、その選択を後工程に引き継いだ扱いにしない。
- 絞り込みは、出荷日 = 今日 と 伝票番号 = 未入力 を同時に設定してから1回だけ実行する。
- 商品名ソート後の印刷対象選択は、すべて選択チェックボックスで全表示行を選択し、除外対象だけチェックを外す。
- 伝票番号入力済みや出荷日不一致は検索条件で基本的に表示から落ちるが、選択後にもDOMで再確認し、漏れがあれば停止する。

## Address Safety

- 注文データにない住所要素は追加しない。
- 住所修正は正規化、分割、表記変換までに限定する。
- 外部情報が必要な場合でも、WEB検索や設定済み外部検証で根拠が明確なら自律的に修正してよい。保存した場合は根拠/source と before/after を実行ログへ残す。曖昧なら保存せず、未解決扱いにする。
- 解決できない住所エラーは勝手に補完せず、停止して次アクションを確認する。
## Phone Number Safety

- 電話番号は、全角数字を半角数字へ、全角ハイフン・長音・ダッシュ類などの区切り文字を半角ハイフン `-` へ寄せる正規化だけ許可する。
- 日本国内の電話番号は半角数字と半角ハイフンだけを許可する。`+`、空白、括弧など、それ以外の文字は数字列が変わらない場合に限り削除する。
- 電話番号の数字を追加しない。削除しない。桁数補正しない。先頭 `0`、国番号、市外局番、内線などを推測で補完しない。
- 電話番号のハイフンは削除しない。元データの区切りを半角ハイフンへ寄せるだけにする。
- 保存前に必ず `digits(before) === digits(after)` を検証する。数字列が変わる場合は保存せず停止して報告する。
- 電話番号を修正した場合は、before/after、数字列不変の検証結果、対象注文を run log に残す。

## Address Width Safety

- 全角半角の自動正規化は電話番号だけに限定する。
- 住所の全角数字、全角ハイフン、長音風区切りは、自動保存しない。住所警告がある場合は before/after 案を報告し、明示指示がある場合だけ保存する。
- 住所要素の追加、削除、推測補完は引き続き禁止する。

## Address Warning Detection And Normalization

- Immediately after entering each GoQ status, inspect the order-list carrier column for address warnings such as `【住】`.
- Orders with address warnings must be opened on the delivery-address correction page and checked/fixed before shipping-label generation.
- Do not proceed to picking-list printing or shipping-label printing while a target order has an address warning that has not been reviewed/fixed or explicitly classified as unresolved after correction/validation and memo-marked with `住所不正`.
- If the prefecture field already contains the prefecture, remove duplicated prefecture text from address 1.
  - Example: `沖縄県 / 沖縄県豊見城市...` becomes `沖縄県 / 豊見城市...`.
- Normalize full-width digits to half-width digits.
  - Example: `１－１１７８` becomes `1-1178`.
- Normalize full-width hyphens, long-vowel-like separators, and dash-like address separators to ASCII `-`.
- Do not remove hyphens used in lot numbers.
- Do not remove telephone hyphens.
- Do not change telephone numbers unless explicitly required.
- Split address fields as: address 1 = municipality plus town area; address 2 = lot number and after, including building name and company name.
  - Before: `沖縄県 / 沖縄県豊見城市豊崎１－１１７８Fステージ豊崎パークフロント1003 / 株式会社ジャスミン`
  - After: `沖縄県 / 豊見城市豊崎 / 1-1178 Fステージ豊崎パークフロント1003 株式会社ジャスミン`

## Address Warning Resolution Definition

- A surface `【住】` warning that remains in the GoQ list after correction is not unresolved by itself.
- Reviewed/fixed means the row was opened and a safe correction was saved, or external/operator validation was explicitly recorded as confirmed. Merely opening the row and finding no safe mechanical change is not reviewed/fixed.
- Unresolved means the address still fails after correction/validation, such as a carrier/API error report after label generation, or a user-confirmed unresolved case. Before exclusion, write `住所不正` to the GoQ one-line memo.
- Do not proceed with unreviewed address warnings.
- Manual exclusion is allowed only for address-warning rows explicitly classified as unresolved after correction/validation and memo-marked.

## Output Order And Label-Issuance Difference Check

- Default order remains picking list, then shipping labels.
- Status auto-move is expected: orders may move out of the source status after shipping date and tracking number are set.
- Before shipping-label generation, persist the exact target snapshot: GoQ IDs, order numbers, status, carrier, ship date, and request time.
- After shipping-label generation, compare the target snapshot with GoQ rows that have a tracking number or label-issued marker. Do not rely only on PDF generation success.
- If target rows disappeared from the source status, use the `全て` status filtered by today's shipping date and directly target the saved GoQ/order numbers.
- A target row with no tracking number or label-issued marker after generation is `送り状未発行/除外された可能性あり`.
- If an error report exists, parse it and map `配送管理番号` values such as `183479-1` back to GoQ ID `183479`.
- Always report unissued label count and details. If the picking list was already printed, report the mismatch and rerun/correct only affected rows when needed.
- `--label-first` is emergency/special-case only and must not replace the normal difference-check workflow unless the user explicitly instructs it.

## Label Generation Dialog Handling

- After pressing a shipping-label generation button, especially Yamato-family labels (`yamato`, `compact`, or `nekoposu`), do not blindly accept a modal or JavaScript dialog and continue.
- If a modal, alert, confirm, prompt, or visible error dialog appears, read and record its type/text/buttons/context in the run log.
- Close only what is necessary to unblock the browser. For an alert this may require accepting the alert, but the flow must stop immediately afterward for review.
- Do not proceed to download-list lookup, PDF download, issuance verification, or print preview until the dialog content has been handled.
- A run that continues after such a dialog is a review violation.

## Yamato B2 Cloud Request Evidence

- For Yamato-family labels (`yamato`, `compact`, `nekoposu`), a request accepted by GoQ should create either a success PDF card or an error report card in the download file list within about one minute.
- If the bounded reload window finds neither success nor error, treat the primary suspicion as "B2 Cloud request not sent", not an address error.
- Monitor `axios.post` for `RequestB2CloudDeliveryInvoice.php` around `#B2CloudGeneratePdfApi` clicks and record the result in the run log.
- If no B2 Cloud POST is recorded, invoke the page-defined `b2CloudDeliveryInvoiceExportRequest('B2CloudGeneratePdfApi', 'b2_cloud_api_printStartLocation', 'ヤマト運輸', orderBySql)` once for the same selected GoQ IDs.
- Never run that fallback when a B2 Cloud POST was already recorded; this prevents duplicate label-generation requests.
- Record selected GoQ IDs, print-start location, `orderBySql`, success/error notice, download card, issuance verification, and print-preview evidence.

## Dashboard Notice Modal

- When entering the GoQ dashboard, handle an お知らせ/notice modal before entering the order list.
- If the notice has checkboxes, scroll the modal as needed and check every enabled checkbox, including checkboxes that are initially below the visible area.
- Press the confirmation button such as `上記について確認しました` or `確認しました` only after the required boxes are checked.
- Record the handled modal in the run log.

## Printer Destination Review Guard

- Every print-output step must record the expected printer and the actual Chrome print-preview destination.
- Review must fail when the destination is missing or does not match the status-specific printer route.
- Picking list destination must include `普通紙`.
- Sagawa and hold-Sagawa label destinations must include `佐川`.
- Yamato and Compact label destinations must include `ヤマト/コンパクト`.
- Nekopos label destination must include `ネコポス`.
- A Sagawa label printed to `ヤマト/コンパクト` is a review violation even if the print job completed.
