# GoQ print flow runner (Benny version)

`goq-print-flow.mjs` unifies the non-Sagawa-120 print flow.

Sagawa 120+ is intentionally excluded because it uses the e-Hiden III / Sagawa Smart Club route.

Benny's flow: GoQ login → local picking-list print → **B2 Cloud CSV export from GoQ** → label print on Yamato Business Members (`tools/yamato-b2/`). Runtime is local Node.js + Chrome (`scripts\start-chrome-cdp.ps1`); Docker is not used; credentials come from `.env` only.

## B2 Cloud CSV Route

Yamato-family statuses (`yamato`, `compact`, `nekoposu`, and their `-amazon` variants) have `labelMode: 'b2-csv'` in `STATUS`. For them the runner does **not** press `#B2CloudGeneratePdfApi`. Instead, inside `outputLabels()`:

1. Reselect all visible rows, keep only targets, and re-verify today's ship date / empty tracking number (same as before).
2. Record the label target snapshot (`recorded shipping-label target snapshot`).
3. `exportLabelCsvToFile(config)`:
   - Select the B2 Cloud option in `#trader_s` (value `b2_cloud` by default, or `.env` `GOQ_B2_CSV_FORMAT_VALUE`; falls back to an option whose text matches `B2|Ｂ２|ヤマト` and is not e-飛伝).
   - Install hooks on `HTMLFormElement.prototype.submit`, the capturing `submit` event, and `window.open` so the output button (`button[name="B020"]`, which normally posts to a new window) does not open anything; then trusted-click the button. If no submission is captured within 8 s, call the page's `downcsv()` once.
   - Replay the captured `action`/`method`/body with `fetch` (same-origin). A direct CSV response is saved; an HTML response containing `infile.php?fname=` is followed like the picking CSV export.
   - Save under `.o11y/goq-unified-print-flow/downloads/` and record `exported shipping label csv` (format option, options seen, checked IDs, submit action, response headers, dialogs).
4. `verifyLabelCsvAgainstTargets()` (`tools/lib/label-csv.mjs`) decodes Shift_JIS, parses the CSV, and requires that every target GoQ ID or order number appears in a data row and that no row belongs to another order (multi-parcel duplicates allowed). Result is stored as `run.labelIssuanceVerification` with `mode: 'b2-csv'` and recorded as `verified shipping label csv against target snapshot`. Mismatch stops the run.
5. `writeB2Handoff()` writes `.o11y/goq-unified-print-flow/b2-handoff/<time>-<status>.json` (`csv`, `targets`, `labelPrinter`, `runLog`) and records `wrote b2 cloud handoff`, then the GoQ-side run ends. Label printing, tracking export and GoQ `送り状番号取込` are done by `tools/yamato-b2/import-and-print.mjs` (to be built after the site survey).

The reviewer (`goq-run-review.mjs`) switches its goal checks by `run.labelMode`: in b2-csv mode it requires the export, the verification, and the handoff, and it fails the run if a GoQ-side label request/download step appears (`GOQ_LABEL_API_USED_IN_B2_CSV_MODE`). Ordering (picking before CSV export), target snapshot, and address-warning gates apply the same way as for label generation.

Sagawa statuses (`sagawa`, `hold-sagawa`) keep `labelMode: 'goq-api'` and the original Smart API flow described below.

## GoQ Login

Before anything else the runner calls `ensureGoqLogin()` from `tools/goq-login.mjs`. If a GoQ tab is already logged in it records `goq login state verified`; if the login page is shown it fills `#login_id` / `#login_pw`, presses `認証する`, fills `#seq_id` / `#seq_pw`, presses `ログイン`, accepts `同意してGoQSystemを利用します` when present, and records `goq login attempted` (no password values). `--no-auto-login` disables this and stops instead. Standalone: `npm run goq:login` (`--check` for state only).

`tools/goq-print-flow.CHECKLIST.md` is the canonical common-flow checklist and status-difference table. The runner records it as required rule material before side effects, and the reviewer must use it with `run.goal` when judging completion.

## Supported Statuses

| Key | GoQ status | Expected carrier | Label mode | Label printer |
| --- | --- | --- | --- | --- |
| `sagawa` | 佐川 | 佐川急便 | goq-api (佐川急便送り状発行) | 佐川 |
| `yamato` | ヤマト | ヤマト運輸 | b2-csv | ヤマト |
| `compact` | コンパクト | ヤマト運輸 コンパクト | b2-csv | ヤマト |
| `nekoposu` | ネコポス徳島 | ヤマト運輸 ネコポス | b2-csv | ネコポス |
| `hold-sagawa` | 保留（佐川想定） | 佐川急便 | goq-api (佐川急便送り状発行) | 佐川 |

Printer strings are substrings of this PC's printer names (`FUJIFILM Apeos C5240普通紙` / `ヤマト` / `佐川` / `ネコポス（手差し）`) and can be overridden with `.env` `PRINTER_PICKING` / `PRINTER_YAMATO` / `PRINTER_NEKOPOSU` / `PRINTER_SAGAWA` (`tools/lib/printers.mjs`).

Amazon-only variants are explicit separate status keys:

- `sagawa-amazon`
- `yamato-amazon`
- `compact-amazon`
- `nekoposu-amazon`
- `hold-sagawa-amazon`

The base status keys never apply the Amazon tab unless `--amazon-only` or `--store-tab` is explicitly supplied.

## Safety Model

Default mode is dry-run. It navigates to the status and reports eligible, excluded, and blocked rows, but does not select, overwrite, export, generate, download, or print.

At startup, the runner loads the required rule material (`AGENTS.md`, this README, `tools/goq-print-flow.CHECKLIST.md`, `.claude/skills/goq-shipping-label-print-flow/SKILL.md`, and `codex/memories/goq-print-flow-rules.md`; override the last two with `.env` `GOQ_RULE_SKILL_FILE` / `GOQ_RULE_MEMORY_FILE`) and records it in the run log. If any required rule source is missing or does not contain the expected guardrail sections, the run stops before side effects.

Autonomous operation must use the reviewed wrapper. The wrapper runs the flow, always runs the review command against the produced run log, writes a review report under `.o11y/goq-unified-print-flow/reviews/`, and exits non-zero when the flow fails, the review fails, or review warnings are present.

```powershell
npm run goq:print -- --status yamato --execute
```

`--port` defaults to `.env` `GOQ_CDP_PORT` (9223).

Use `tools/goq-print-flow.mjs` directly only for debugging, never as the normal autonomous print path.

The executor/reviewer contract is goal-first:

1. The executor records `run.goal` before side effects: objective, status, date, target scope, output mode, and success criteria.
2. The reviewer reads `run.goal` first and evaluates whether the evidence reaches that goal.
3. The reviewer fails the run when the goal is missing, the run drifts from the declared status/date/scope, required outputs are missing, or review warnings remain without explicit acceptance.
4. The executor must treat a failed review as unfinished work and report the correction path instead of reporting completion.

```powershell
node tools/goq-print-flow.mjs --status sagawa
```

Execution mode requires `--execute`:

```powershell
node tools/goq-print-flow.mjs --status sagawa --execute
```

Restrict a test to one order:

```powershell
node tools/goq-print-flow.mjs --status hold-sagawa --order 249-8461959-0519039 --execute
```

Verify only shipping-date overwrite, then stop:

```powershell
node tools/goq-print-flow.mjs --status hold-sagawa --order 249-8461959-0519039 --execute --stop-after-date
```

Controlled end-to-end check without sending either print job:

```powershell
node tools/goq-print-flow.mjs --status hold-sagawa --order 249-8461959-0519039 --execute --resume --preview-only-picking --stop-before-label-print
```

## Unified Flow

1. If the current page is the GoQ dashboard, handle the notice modal if it appears.
2. Enter order management from the dashboard or open the status URL directly.
3. Open the target GoQ status.
3b. Set and verify the GoQ order-list display count to `500件` before judging eligible rows or selecting output targets.
3a. Optional Amazon-only mode: apply the exact `Amazon` store tab before any side effects, so non-Amazon rows are not selected for shipping-date overwrite.
4. Read order rows from DOM.
5. Process address warnings first. Safe mechanical corrections are saved automatically. If web/external validation gives a clear correction, save it and record the source/reason. If the address cannot be corrected confidently, write `住所不正` to the GoQ one-line memo, mark the row unresolved, exclude it from output, and continue with the remaining rows.
6. Exclude rows with an existing ship date, unless running with `--resume` and the date is today.
7. When running with `--resume`, stop if any target row does not already have today's ship date.
8. Exclude rows with a tracking number or `[伝票入力済]`.
9. Exclude rows whose carrier does not match the status.
10. For non-resume runs, select eligible rows only as the temporary target for bulk date overwrite.
11. Bulk overwrite 出荷日 to today and verify the row DOM reflects it. The following page refresh clears this temporary selection.
12. Set both filters before submitting search: 出荷日 = today and 伝票番号 = 未入力.
13. Submit the search once.
13a. Optional Amazon-only mode: immediately after this search completes, reapply or verify the exact `Amazon` store tab (`#st = Amazon`). Do not use partial text matching because `Amazon 2号店` and `Amazon 3号店` are separate tabs.
14. Sort the GoQ order list by 商品名.
15. Verify the GoQ product-name sort action changed/reflected the order-list DOM. Do not rejudge GoQ's sort with agent-side dictionary order.
16. Use the all-select checkbox to select all visible rows, then uncheck only excluded/non-target rows.
17. Re-verify selected rows have today's ship date and no tracking number before CSV export.
18. Export 出荷日担当者用 CSV through the GoQ CSV API.
19. (Benny version) Build the picking-list PDF locally from the saved CSV and the Benny master sheet (`tools/local-picking/`). Do not inspect the CSV's product order; the local builder applies Smart Pick's display/print order (JAN last-4 digits, then product name).
20. Print, or preview-only verify, the picking list to 普通紙.
21. Before label generation, again use all-select and uncheck only excluded/non-target rows, then re-verify selected rows have today's ship date and no tracking number.
22. Verify the status-specific shipping-label generation button is enabled, then press it.
23. Open ダウンロードファイル一覧 and download the matching PDF by receipt time.
24. Print, or stop before printing, the shipping label with the status-specific printer, 白黒, duplex OFF.

Default print order remains picking list first, then shipping labels. Status auto-move makes this order safer because rows may leave the source status after both shipping date and tracking number are populated.

## Label Generation Dialog Handling

After pressing a shipping-label generation button, especially the Yamato-family button (`yamato`, `compact`, or `nekoposu`), do not blindly accept modals or JavaScript dialogs and continue.

If a modal, alert, confirm, prompt, or visible error dialog appears:

1. Capture its type, text, buttons, URL/context, and timestamp in the run log.
2. Close only what is necessary to unblock the browser. For an alert this may require accepting the alert, but the flow must still stop immediately after recording it.
3. Do not continue to the download list, PDF download, issuance verification, or print preview until the dialog content has been reviewed and the cause has been handled.
4. Treat any run that continues past such a dialog as a review violation.

Before shipping-label generation, persist the exact target snapshot: GoQ IDs, order numbers, status, carrier, ship date, and request time. After generation, verify label issuance by comparing the target snapshot with GoQ rows that have a tracking number or label-issued marker. Do not rely on PDF generation success alone. If the source status no longer contains the rows, use the `all`/`全て` status filtered by today's shipping date and directly target the saved GoQ IDs/order numbers.

Any target row that has no tracking number or label-issued marker after generation is `送り状未発行/除外された可能性あり`. If an error report exists, parse it and map `配送管理番号` values such as `183479-1` back to GoQ ID `183479`. Always report unissued label count and details. If the picking list was already printed, report the mismatch and only rerun/correct affected rows when needed.

`--label-first` is an emergency/special-case option only. Prefer the default order plus the post-label difference check unless the user explicitly instructs otherwise.

## Address Warning Handling

The runner opens `order_derivery2_1_4.php?oid={goqId}&stat={stat}` for rows with `【住】`.

Immediately after opening each status, inspect the GoQ order-list carrier column for address warnings such as `【住】`.
Any order with an address warning must be opened on the delivery-address correction page and checked/fixed before shipping-label generation.
Do not treat a surface `【住】` warning that remains after correction as unresolved by itself.
Reviewed/fixed means the row was opened, a safe correction was saved, or external/operator validation was explicitly recorded as confirmed. Merely opening the row and finding no safe mechanical change is not reviewed/fixed. The GoQ list may still show the warning after a real correction.
Unresolved means the address still fails after correction/validation, such as a carrier/API error report after label generation, or a user-confirmed unresolved case. Unresolved rows must be marked with `住所不正` in the GoQ one-line memo before they are excluded from output.
Do not proceed to picking-list printing or shipping-label printing while a target order has an address warning that has not been safely fixed, externally/operator confirmed, or marked unresolved with the memo.
Manual exclusion is allowed only for rows explicitly classified as unresolved after correction/validation and memo-marked, not as a bypass for unreviewed warning rows.

Automatic address corrections are disabled by default. The runner may report a safe-looking normalized proposal, but it must not save address width/dash changes without explicit instruction.

Previously implemented proposal logic:

- Convert full-width alphanumerics and symbols to normalized width.
- Convert dash-like address separators to `-`.
- Remove duplicated prefecture text from address 1 when the prefecture field already contains it.
- Do not change telephone numbers.
- Do not remove lot-number hyphens from addresses.
- Do not remove telephone hyphens.
- Split address fields as: address 1 contains municipality plus town area; address 2 contains lot number and after, including building name and company name.

Address split example:

- Before: `沖縄県 / 沖縄県豊見城市豊崎１－１１７８Fステージ豊崎パークフロント1003 / 株式会社ジャスミン`
- After: `沖縄県 / 豊見城市豊崎 / 1-1178 Fステージ豊崎パークフロント1003 株式会社ジャスミン`

Manual-only / not yet automated:

- Full romanized address transliteration, for example `Sapporo Shi, Kita-Ku...`.
- Any address fields that still contain English/romanized text before external validation.
- Ambiguous address 1/address 2/building/company repartition that requires human judgment.
- Postal-code lookup based address reconstruction.

If a warning row is safely corrected and saved, it is treated as fixed for the current run even if `【住】` still appears after returning to the list. If a row requires manual-only normalization, the flow stops before date entry or printing.

Every address warning result must be auditable. The run log records, per order:

- `before`: original postal code, prefecture, address 1, address 2, company, department, and telephone.
- `after`: proposed or saved values. Telephone must remain unchanged unless the rule explicitly requires a change.
- `changes`: field-level before -> after pairs.
- `required`: missing confirmation when the runner stops instead of saving.

Romanized or English addresses are not considered safe mechanical corrections. They must be normalized by WEB search or a configured Post-kun API flow before saving. The agent may perform this validation autonomously when the result is clear and must record the source/reason in the run log. If the result is ambiguous or the memo field cannot be updated, stop and report the blocker.

## Phone Number Normalization

Telephone numbers use a stricter rule than addresses.

Allowed automatic changes:

- Convert full-width digits to ASCII digits.
- Convert full-width hyphens, long-vowel marks, and dash-like separators to ASCII `-`.
- Remove characters other than ASCII digits and ASCII hyphens, for example `+`, spaces, parentheses, and other separators, only when the digit sequence remains unchanged.

Forbidden automatic changes:

- Do not add digits.
- Do not delete digits.
- Do not infer a leading `0`, country code, area code, extension, or missing number.
- Do not remove telephone hyphens as a formatting shortcut.

Before saving a telephone change, the runner verifies `digits(before) === digits(after)`. If the digit sequence changes, the runner stops and reports the blocker instead of saving. Every saved telephone normalization records the order, before/after, and digit-invariant values in the run log.

## Shipping Label Download Wait

After the shipping-label generation button is pressed, the matching card may appear in ダウンロードファイル一覧 after a short delay.

For Yamato-family labels (`yamato`, `compact`, `nekoposu`), GoQ should show either a B2 Cloud success PDF or an error report in the download file list within about one minute when the generation request was actually accepted. If the bounded reload window finds neither a matching success card nor a matching error card, first suspect that the button click did not send the B2 Cloud request. Do not treat that state as an address error without request evidence.

The runner verifies this by monitoring `axios.post` for `RequestB2CloudDeliveryInvoice.php` before and after pressing `#B2CloudGeneratePdfApi`. If the monitor records no B2 Cloud POST, the runner performs exactly one fallback call through the page-defined function:

```js
b2CloudDeliveryInvoiceExportRequest(
  'B2CloudGeneratePdfApi',
  'b2_cloud_api_printStartLocation',
  'ヤマト運輸',
  orderBySql
)
```

The fallback is allowed only for the same selected GoQ IDs and only when no B2 Cloud POST was already recorded. The run log must show the monitor result, selected GoQ IDs, print-start location, `orderBySql`, the resulting success/error notice, the matching download card, label issuance verification, and print-preview evidence.

The runner handles this by:

1. Opening ダウンロードファイル一覧.
2. Looking for a card whose reception time is close to the generation request time.
3. If no matching card exists, waiting 3 seconds.
4. Reloading the download list.
5. Repeating up to `--download-refresh-attempts` times.
6. Stopping with an error if the card still does not appear.

Default retry count is 20. This is intentionally bounded so repeated refresh failures stop the flow instead of guessing or clicking an unrelated file.

The runner refreshes the download list on a short cycle: wait about 2 seconds, reload, then wait briefly for the refreshed DOM. This keeps normal Sagawa label detection close to the service's actual generation time while still stopping if no matching resource appears.

For Sagawa Smart API cards, the card link may point to `https://smart-api-shipping.sagawa-exp.co.jp/api/resource/...`. Do not wait for a normal browser download after clicking that link. Extract only a label resource/PDF href, download it directly as a PDF, then validate the first bytes are `%PDF-` before opening it for print preview.

Do not treat header/menu links or page-level containers as download cards. If no `smart-api-shipping.../api/resource/...`, `/api/resource/`, or `.pdf` link is found near the requested receipt time, stop instead of guessing.

If a matching error card appears near the requested receipt time, do not keep waiting for a normal download card. Fetch the `エラーレポート`, record its body in the run log, and stop so the failed order data can be corrected before retrying label generation.

Preferred route: open the label resource URL directly in Chrome and print from the Chrome PDF Viewer iframe. This avoids Node/PowerShell network differences and removes the slow local-download fallback from the normal path.

Fallback route: if a local file must be produced, Node `fetch()` may retry once with PowerShell `Invoke-WebRequest`, then validate the saved file as a PDF. Do not use this fallback for the normal Sagawa Smart API print path.

## CSV Export

Picking CSV export is API-proven for `custom_id=6`.

This is not a browser download into the user's Downloads folder. The runner retrieves the CSV through the GoQ API, writes it under `.o11y/goq-unified-print-flow/downloads/`, and passes that local file to the local picking-list builder.

Steps:

1. POST the selected `order_number[]` values and `trader_s3=customize_csv_6` to `/goq21/export/create_custom_csv.php?custom_id=6`.
2. Parse the returned `infile.php?fname=/tmp/...csv` redirect target from the HTML response.
3. GET `/goq21/infile.php?fname=...`.
4. Save the returned CSV to `.o11y/goq-unified-print-flow/downloads/`.

The response is validated by status, content type, byte length, and filename before the flow continues.

Do not inspect, judge, or rewrite the picking CSV for product-name order. The workflow concern is only the GoQ list order before printing labels; the local picking-list builder handles the display/print order.

## GoQ Product Sort

Product-name sorting must be verified on the GoQ order list itself. Do not evaluate the picking CSV for this at all. The shipping-label print order follows the GoQ list order, so the runner must:

1. Click the `商品名` header.
2. Locate the GoQ table header cell that contains `商品名`; GoQ may render it as a combined header such as `商品名 送り先住所`.
3. Read the visible order rows in DOM order before and after the click.
4. Poll about every 100ms until the GoQ list DOM order changed or was otherwise reflected for a one-row list.
5. Do not apply agent-side Japanese/numeric collation as the source of truth; GoQ owns the sort semantics.
6. Stop before CSV export or shipping-label generation if the product-name sort action cannot be verified.

## Local Picking PDF (Benny version)

The Benny version does not use Smart Pick (`picking-list-app.vercel.app` reads the original version's GoQ全データ). Instead:

1. `buildLocalPickingPdf()` (`tools/local-picking/build.mjs`) reads the saved picking CSV (Shift_JIS) and the master sheet through the Sheets API with the service account in `credentials.json` (read-only scope). Default master: ベニー様_ピッキング参照 `1ymVLW4eAf95RzBAjFWbrrvjZxOM6onKdRqcllfT5z0s`, range `GoQ全データ`. Override with `PICKING_MASTER_SHEET_ID` / `PICKING_MASTER_RANGE`. The original GoQ全データ ID is refused.
2. It verifies the master's row-3 headers (Q=商品SKU, F=JAN, G=SET数, E=親ASIN, H=親ASIN-2, I=親JAN-2, J=SET-2, K=子ASIN, R=親) and stops if the columns are shifted.
3. It applies the same aggregation as Smart Pick (`usePickingLogic.ts`): SKU match on column Q, SET数 × 個数, grouping by JAN, JAN-last-4 then name order, 複数個注文リスト, JAN確認用リスト, and 異常検知リスト for orders missing from the master.
4. It writes HTML, PDF, report JSON and a master snapshot under `.o11y/goq-unified-print-flow/picking/`, and records `generated local picking pdf` in the run log.
5. The PDF is opened in a new tab (the GoQ tab is not navigated away), and printed through the Chrome PDF Viewer toolbar print button to `普通紙`, the same way as shipping-label PDFs.

The reviewer requires every picking print step to carry `source: local-picking-pdf` and a matching `generated local picking pdf` record whose master is not the original GoQ全データ and whose layout check passed.

## Chrome Print Preview DOM

Chrome print preview is a separate `chrome://print/` page target. Its controls are inside Shadow DOM.

Current structure:

- Root: `print-preview-app`
- Sidebar: `print-preview-app` shadow root -> `print-preview-sidebar` shadow root
- Destination: `print-preview-destination-settings`
- Color: `print-preview-color-settings`
- More settings: `print-preview-more-settings`
- Duplex: `print-preview-duplex-settings`
- Print/cancel buttons: `print-preview-button-strip` shadow root

Do not use the old assumption that all controls are under a top-level `print-preview-settings-section`. In the current Chrome DOM, each setting component is directly available under the sidebar shadow root.

Printer selection rule:

1. Inspect the destination `<select>` first.
2. If the target printer is already listed, select it directly.
3. Open `もっと見る` only when the target printer is absent from the direct options.

Additional destination-dialog rule:

- In current Chrome, the destination dialog is under `print-preview-destination-settings` shadow root, not directly under `print-preview-app`.
- If the target printer exists in Chrome's destination store, select it by key such as `佐川/local/`.
- After selecting a printer via the More destinations dialog, close the dialog if it remains open and verify the destination again on the main print preview panel.

Before pressing any print button, verify:

- destination text includes the intended printer
- color value is `bw`
- duplex checkbox is unchecked
- print button has `aria-disabled=false`
- page count is reasonable for the job

Every output step must record both the expected printer and the actual Chrome print-preview destination. The reviewer must fail the run if:

- the actual destination is missing from the output-step detail
- a picking-list output destination does not include `普通紙`
- a Sagawa or hold-Sagawa label destination does not include `佐川`
- a Yamato/Takkyubin Compact label destination does not include `ヤマト/コンパクト`
- a Nekopos label destination does not include `ネコポス`

After pressing the print button, the print preview must close. If it remains open, treat the print as failed or unconfirmed, cancel/close the preview, and retry the same print action once. Do not report the picking list or shipping label as printed while `chrome://print/` remains open.

## Dashboard Notice Modal

When GoQ opens at `https://order.goqsystem.com/goq21/dashboard/`, the runner calls `handleDashboardNoticeModal()` before entering order management.

The handler looks for a visible dialog/form containing:

- one or more enabled checkboxes
- submit/confirm style button text such as `上記について確認しました`, `確認しました`, `送信`, `確認`, `同意`, `OK`, `保存`, or `次へ`
- notice-like text such as `通知`, `お知らせ`, `確認`, `同意`, `重要`, or `チェック`

It scrolls each checkbox into view, including scrolling inside the modal when necessary, checks all unchecked boxes, then scrolls to and presses the submit button. If no matching modal exists, it does nothing.

## Execution Method Policy

Use the least fragile method available:

1. API/browser-to-api for endpoints that are proven by trace and response validation.
2. DOM/Playwright-style page operations for normal GoQ controls.
3. CDP/shadow DOM for Chrome PDF Viewer and Chrome print preview.
4. Coordinate clicks only as a last resort for proven trusted-user-gesture requirements.

The runner avoids coordinate clicks for normal GoQ actions such as row selection, bulk date input, filters, product-name sort, label buttons, and ordinary download links. Those actions are executed through DOM state changes or element `click()` and then verified before continuing.

## Interruption Safety

If a run is interrupted from the chat UI, the Node process may keep running in the background. Before continuing, check for a recently started `node.exe` process and stop the matching run process if it is still active. This prevents an interrupted flow from continuing to later side-effect steps.

## Run Review

After every execution, review the newest run log:

```powershell
node tools/goq-run-review.mjs --latest
```

The reviewer fails when rule material was not loaded, unreviewed address warnings were bypassed, address-warning rows were manually excluded without being marked fixed or memo-marked unresolved, unresolved rows lack a recorded `住所不正` memo marker, label generation happened before picking-list output, a label print lacks a matching download record, print-preview screenshot evidence is missing, the actual print-preview destination was not logged, or the logged destination does not match the status-specific expected printer.

## Useful Options

- `--port 9223`: Chrome DevTools port (default from `.env` `GOQ_CDP_PORT`).
- `--no-auto-login`: do not log in from `.env`; stop if GoQ is not logged in.
- `--date YYYY-MM-DD`: override ship date; default is local today.
- `--skip-print`: perform GoQ generation/download steps without pressing print.
- `--skip-labels`: stop after picking-list export/print.
- `--label-first`: emergency/special-case option to print shipping labels first, then the picking list. Do not use as the normal answer to possible label exclusions; prefer the default order plus post-label difference check.
- `--stop-after-date`: stop immediately after shipping-date overwrite verification.
- `--preview-only-picking`: open and verify the picking-list print preview, then close it without pressing print.
- `--stop-before-label-print`: open and verify the shipping-label print preview, then leave it at the final print button without pressing print.
- `--resume`: continue a partially completed run when the target rows already have today's ship date.
- `--address-fixed 183440,183523`: mark address-warning rows as reviewed/fixed or externally confirmed for this run even if the surface warning remains visible. In execute mode this must be paired with `--address-fixed-confirmed`; use it only after actual correction, external validation, or explicit operator confirmation.
- `--address-fixed-confirmed`: explicit audit flag that `--address-fixed` IDs were not guessed or bypassed.
- `--address-unresolved 183479`: mark address-warning rows as unresolved after correction/validation, allowing them to be excluded while other reviewed/fixed rows proceed. In execute mode this must be paired with `--address-unresolved-confirmed` unless the current run wrote the `住所不正` memo itself.
- `--address-unresolved-confirmed`: explicit audit flag that unresolved address rows already have the `住所不正` one-line memo or were otherwise operator-confirmed before exclusion.
- `--amazon-only`: print only rows behind the exact `Amazon` store tab. Prefer explicit status keys such as `sagawa-amazon` or `nekoposu-amazon` for normal operation.
- `--store-tab "Amazon"`: advanced exact store-tab filter. Prefer `--amazon-only` for the standard Amazon flow.
- `--wait-ms 180000`: max wait for generated downloads.
- `--download-refresh-attempts 20`: max download-list refresh attempts while waiting for a shipping-label card.
