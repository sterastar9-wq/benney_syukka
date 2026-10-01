---
name: goq-shipping-label-print-flow
description: ベニー様版 GoQ 出荷フロー（GoQログイン → ピッキングリストをローカル印刷 → B2クラウド用送り状CSVをGoQから出力 → ヤマトビジネスメンバーズで送り状発行・印刷 → 送り状番号を GoQ に戻し出荷日を入れて ★発送済み → 当日の出荷件数を報告）。「出荷して」「出荷作業」「今日の出荷」「発送処理して」「出荷フロー回して」「送り状まで全部」は工程1〜5の通し（npm run ship）、「印刷して」「刷って」はピッキングリスト＋送り状の印刷まで、「送り状発行して」「B2で発行」は送り状のみ、「送り状番号取込」「伝票番号を戻して」「発送済みにして」は番号戻し〜★発送済み、「今日の出荷件数」「出荷報告」は件数報告、「仕分け」は印刷前の整理だけ。GoQ のステータス修正・日時指定チェックの依頼でも使う。
---

## Triggers（言い回しと実行範囲）

| 言い回し | 実行範囲 | コマンド |
| --- | --- | --- |
| 出荷して / 出荷作業 / 今日の出荷 / 発送処理して / 出荷フロー回して / 送り状まで全部 | 工程1〜5の通し（印刷 → 送り状発行 → 番号戻し → 出荷日 → ★発送済み → 件数報告） | `npm run ship -- --statuses nekoposu,takkyubin` |
| 印刷して / 刷って | 工程1〜2（ピッキングリスト＋送り状）。番号戻しは続けて指示があれば | `npm run goq:print -- --status <status> --execute` → `npm run yamato:print -- --handoff <file>` |
| 送り状発行して / 送り状刷って / B2で発行 | 工程2のみ（引き継ぎファイルが必要。ピッキング印刷の証跡が無ければ止まる） | `npm run yamato:print -- --handoff <file>` |
| 送り状番号取込 / 伝票番号を戻して / 発送済みにして | 工程3〜4 | `npm run yamato:export-tracking -- --handoffs ...` → `npm run yamato:import-tracking -- --set-ship-date today --handoffs ...` |
| 今日の出荷件数 / 出荷報告 | 工程5（★発送済み以降に移した件数をステータス別に） | `import-tracking-to-goq.mjs` の `today shipping report`、または `npm run ship` の最後の行 |
| 仕分け | 印刷前の整理だけ（印刷・発行はしない） | 既存の仕分け手順 |

トリガーに関係なく、航空危険物の「重要なお知らせ」と、B2 の発行済み一覧に引き継ぎに無い注文がある場合は、毎回オペレーターに確認してから `--air-notice-approved` / `--allow-extra` を付ける。

# GoQ Shipping Label Print Flow (Benny version)

## Benny Flow Summary

1. GoQ login (`tools/goq-login.mjs`, credentials from `.env`; the runner does this automatically).
2. Picking list built locally from the Benny master sheet and printed to `普通紙` (`tools/local-picking/`).
3. Shipping-label data exported from GoQ as a **B2 Cloud CSV** (`labelMode: b2-csv`), verified against the target snapshot, and written to a handoff file. GoQ's own B2 Cloud API button is not pressed for Yamato-family statuses.
4. Yamato Business Members (B2 Cloud): import the CSV (picking-evidence gate), print labels to `C5240 ヤマト/コンパクト` / `C5240 ネコポス` (`tools/yamato-b2/print-labels.mjs`).
5. Tracking round trip: export the issued data from B2 (`export-tracking.mjs`), import it into GoQ 送り状番号取込, verify each order on its detail page, set today's shipping date, and move only orders with both tracking number and shipping date to ★発送済み (`import-tracking-to-goq.mjs --set-ship-date today`).
6. Report today's shipped count per status.

One command runs 1–6 in order and stops with a reason and a resume hint when a gate fails: `npm run ship -- [--statuses nekoposu,takkyubin] [--air-notice-approved] [--allow-extra] [--skip-goq] [--skip-labels]` (`tools/benny-shipping-flow.mjs`). Pass `--air-notice-approved` only after the operator has confirmed the items for the 航空危険物 notice, and `--allow-extra` only after confirming that an order in B2's issued list but not in the handoffs is our own manual issue.

Runtime is local Node.js + Chrome started by `scripts\start-chrome-cdp.ps1`. Docker is not used.

## Keyword Semantics

- `仕分け` is a global pre-print operation, not a per-status print-side check. Complete the whole sorting phase before any picking-list output, label CSV/export, label-generation button, or print-preview action.
- Global sorting order:
  1. Route all actionable orders from `Amazon振分用` and `発送待ち` into the correct shipping statuses.
  2. Reopen/rebuild the affected shipping statuses after moves.
  3. In every active shipping status, check delivery date/time fields.
  4. Check whether any order must move into `佐川120サイズ以上`, move it when rule-backed, then rebuild the affected status row sets.
  5. Fix/confirm/memo-mark address warnings in every active shipping status.
  6. Record a sorting-complete log. Printing may start only after this global gate is complete.
- Heavy liquid/dense-product routing must treat `24kg` as the practical per-parcel limit, not a total-weight exclusion. For products around `2000g/ml` or more with actual shipped units of `7+`, calculate product-pack count times GoQ sales unit, calculate total product weight, calculate minimum parcel count with `ceil(totalWeightKg / 24)`, and block printing until parcel count and normal-vs-Sagawa120 route are set.
- `印刷` / `刷って` must use the latest post-sorting status state. Do not start printing from a stale row snapshot taken before `仕分け`.

- `仕分け`: run only the pre-print cleanup scope. This means status-move correction plus delivery date/time checks, including reopening the source status and rebuilding the row set if rows move. Do not print picking lists, issue labels, export label CSVs, or press label generation buttons for a `仕分け` request unless the user explicitly adds `印刷` or `刷って`.
- `印刷` / `刷って`: run the full print scope. This includes the required `仕分け` work first, then picking-list output and shipping-label output as one set.
- If a user says both `仕分け` and `印刷`/`刷って`, treat it as the full print scope, with the `仕分け` phase completed before any print-side effects.

Use this skill for GoQ送り状発行 and related picking-list printing. Treat the picking list and shipping label as one operational set, and keep the post-label issuance check auditable.

## Required Reading

Before changing or running the non-Sagawa-120 flow, read (paths relative to the repository root):

- `AGENTS.md`
- `tools\goq-print-flow.README.md`
- `tools\goq-print-flow.CHECKLIST.md`
- `tools\goq-print-flow.mjs`
- `codex\memories\goq-print-flow-rules.md` (the runner loads this repository copy directly)
- `tools\yamato-b2\README.md` for the Yamato Business Members side

Sagawa labels for size 120+ may have a separate path; confirm the repository implementation before acting.

The runner must record loaded rule material in the run log before side effects. This includes `tools/goq-print-flow.CHECKLIST.md`, which is the canonical common-flow checklist and status-difference table. If the rule material is missing or stale, stop before printing, CSV export, date overwrite, or label generation.

## Core Workflow

Same-batch continuation rule: when one user request already completed the global sorting gate and the remaining work is continuing other statuses from that same sorted batch, use `--skip-sort-gate` on later reviewed-wrapper runs. Do not re-run global sorting before every carrier in the same batch unless the user asks for a fresh sort or live state invalidates the prior sorting log.

0. For autonomous print work, use the reviewed wrapper: `npm run goq:print -- --status <status> --execute` (Chrome on the port in `.env` `GOQ_CDP_PORT`, default 9223). Direct `node tools/goq-print-flow.mjs ...` execution is for debugging only because it does not enforce the post-run review gate.
0-login. The runner first verifies the GoQ login state and logs in from `.env` when the login page is shown. If `.env` lacks `GOQ_*` keys, stop and ask the operator to fill `.env` (never type credentials in chat).
0a. The executor must write `run.goal` before side effects. The reviewer must read that goal first, state it back in concrete terms, and judge the run against that declared objective before checking individual rule violations.
0b. Before side effects, confirm the common-flow checklist in `tools/goq-print-flow.CHECKLIST.md`: required skill/entry point, address-warning gate, picking-before-label order, status-specific printer, label target snapshot, post-label issuance verification, and completion standard.
0c. Before any print-side effect, complete global `仕分け`: `Amazon振分用`/`発送待ち` routing, all shipping-status delivery date/time checks, `佐川120サイズ以上` migration checks, and all-status address-warning resolution. A print run must not treat per-status cleanup as a substitute for this global sorting gate.
1. Confirm no stale `node.exe` process from the previous run remains. Stop only the relevant leftover automation process before continuing.
2. Complete exclusion checks, ship-date checks, tracking-number checks, and carrier checks before printing.
2a. Set and verify the GoQ order-list display count to `500件` before judging eligible rows, selecting rows, exporting CSV, or generating labels.
2b. For a normal non-resume run, eligible rows with no ship date are first selected only as the temporary bulk ship-date overwrite target. Bulk overwrite the ship date to today, verify it in the row DOM, then search with ship date = today and tracking number = unentered before selecting rows for picking/label output.
3. For address warnings, fix safe/approved normalizations first. If web/external validation gives a clear correction, the agent may fix it autonomously and record the source/reason. If a row cannot be resolved confidently, write `住所不正` to the GoQ one-line memo and exclude only that memo-marked unresolved row.
4. Print in this order: `ピッキングリスト` first, then `送り状`.
5. Never treat only one side as complete. A picking list without its labels, or labels without the picking list, is incomplete.
5a. Exception recovery after a successful shipping-label request: if the label-generation request has already succeeded but the label PDF/error handling is still unresolved, preserve the original GoQ list tab and its selected orders. Open `ダウンロードファイル一覧` in a separate tab, resolve the label PDF/error there, print the label when it is valid, then return to the original selected-order tab and print/reprint the picking list from that preserved selection if the target count changed or no matching picking evidence exists. Do not reload/search/navigate the original tab before deciding whether its selection must be reused.
5b. If the target count changed after a previous picking list was printed, the previous picking list evidence is stale. Reprint the picking list for the exact current selected target set; do not resume with the old count.
6. Before shipping-label generation, persist the exact target snapshot: GoQ IDs, order numbers, status, carrier, ship date, and request time.
7. After shipping-label generation, verify label issuance by comparing the target snapshot with GoQ rows that have a tracking number/label-issued marker. Do not rely on PDF generation success alone.
8. If target rows moved out of the source status after ship date and tracking number were set, use the `全て` status filtered by today's shipping date and directly target the saved GoQ IDs/order numbers.
9. Treat any target row without a tracking number/label-issued marker after generation as `送り状未発行/除外された可能性あり`; parse any error report and map `配送管理番号` such as `183479-1` back to GoQ ID `183479` when available.
10. Always report unissued label count and details. If a picking list was already printed, do not hide the mismatch; report whether correction/rerun is needed for only the affected rows.
11. Fetch picking CSV from the GoQ CSV API and save it under `.o11y/goq-unified-print-flow/downloads/`; do not rely on the browser Downloads folder.
12. Build the picking-list PDF locally from that CSV and the Benny master sheet (`tools/local-picking/`). Do not use Smart Pick; it reads the original version's master.
13. For Yamato-family statuses, export the B2 Cloud CSV instead of pressing the GoQ label button (see "B2 Cloud CSV Route" below), verify it against the target snapshot, and hand it off to the Yamato Business Members step.
14. After execution, review the run log with `npm run goq:review` and do not report completion if the review finds a violation or an unaccepted warning. The reviewed wrapper performs this automatically and stores a report under `.o11y/goq-unified-print-flow/reviews/`.

## B2 Cloud CSV Route

Applies to all Benny statuses: `nekoposu` (★ネコポス・クリックポスト, stat 30, printer `ネコポス`), `takkyubin` (★宅急便, 26, `ヤマト`), `compact` (only when `GOQ_COMPACT_STAT` is set, printer `コンパクト`; ★クール便 27 is not handled). Expected carrier is `ヤマト運輸`; `日本郵便` (クリックポスト) rows are excluded as carrier mismatch. Picking CSV is GoQ custom CSV id 1.

1. After the picking list is printed, reselect all visible rows, keep only targets, and re-verify today's ship date / empty tracking number.
2. Record the label target snapshot (GoQ IDs, order numbers, status, carrier, ship date, request time).
3. In the GoQ list footer, select the B2 Cloud format in the `送り状データ出力` select (`#trader_s`, option value `b2_cloud` by default; `.env` `GOQ_B2_CSV_FORMAT_VALUE` overrides) and press the output button (`name="B020"`). The runner hooks the form submission, fetches the same request, and saves the CSV (Shift_JIS) under `.o11y/goq-unified-print-flow/downloads/`.
4. Verify the CSV: every target GoQ ID or order number appears in at least one data row, and no data row belongs to an order outside the snapshot. Multi-parcel duplicates of the same order are allowed. On mismatch, stop and report.
5. Write the handoff file under `.o11y/goq-unified-print-flow/b2-handoff/` (`csv`, `targets`, `labelPrinter`, run log path) and record `exported shipping label csv`, `verified shipping label csv against target snapshot`, and `wrote b2 cloud handoff`.
6. The Yamato Business Members side (`tools/yamato-b2/`) then logs in from `.env`, confirms the company name `合同会社Ｂｅｎｙ` on the home page, imports the CSV into B2 Cloud, checks the import result (count and error rows), prints the labels to the status printer with the same print-preview checks, exports issued tracking numbers, and imports them into GoQ `送り状番号取込`. Use `npm run yamato:print -- --handoff <file>` (`print-labels.mjs`), which does import → confirm → issue → print in one go. Rules enforced there:
   - Picking before labels: the import refuses a handoff whose GoQ run log lacks `printed picking list` to the picking printer. A `--preview-only-picking` run must not be followed by label issuance.
   - Do not leave the B2 import-result screen idle (about 30 minutes causes a B2 system error); that is why the steps run in one process.
   - The 航空危険物 "重要なお知らせ" popup (air_shipment_notice.html) is never accepted automatically. Stop, show the text, and continue only with operator approval (`--air-notice-approved`); the approval is recorded in the handoff.
   - Label product names: B2 prints 品名1/2, not 品名コード. `rewrite-b2-csv.mjs` writes the 品名コード into both; check the printed label shows the short code.
   - Reprint after a misprint uses the B2 main menu 「再発行」 (`reissue_search`), not a new import (a new import would issue new tracking numbers).
   - Tracking round trip: `npm run yamato:export-tracking -- --handoffs <files>` then `npm run yamato:import-tracking -- --handoffs <files>`. The export verifies every handoff target is in B2's issued list for today and stops on extra orders (`--allow-extra` after confirming they are ours). The import verifies each order on its GoQ detail page (`da19[0]`), since list rows do not display the tracking number, and moves to ★発送済み only orders that have both the verified tracking number and a shipping date (`--set-ship-date today` writes today's date through the order detail page first). End with today's shipped count per status.
7. The set is complete only when picking print, CSV verification, Yamato import/print, and GoQ tracking import/verification all pass. Report `送り状未発行/除外された可能性あり` for any target without a tracking number after the round trip.

## Label Generation Dialog Handling

- After pressing a shipping-label generation button, especially Yamato-family labels (`yamato`, `compact`, or `nekoposu`), do not blindly accept a modal or JavaScript dialog and continue.
- If a modal, alert, confirm, prompt, or visible error dialog appears, read and record its type/text/buttons/context in the run log.
- Close only what is necessary to unblock the browser. For an alert this may require accepting the alert, but the flow must stop immediately afterward for review.
- Do not proceed to download-list lookup, PDF download, issuance verification, or print preview until the dialog content has been handled.
- A run that continues after such a dialog is a review violation.

## Yamato B2 Cloud Request Evidence

This section applies only to `goq-api` label mode (GoQ-side API generation). In the Benny version, Yamato-family statuses use the B2 Cloud CSV Route above, so these rules are not exercised for them.

- For Yamato-family labels (`yamato`, `compact`, `nekoposu`), a successful GoQ request should put either a success PDF or an error report in the download file list within about one minute.
- If the download file list does not show either success or error after the bounded reload window, treat the problem as "B2 Cloud request not sent" before assuming an address or carrier data error.
- The flow must monitor whether the generation click produced a `RequestB2CloudDeliveryInvoice.php` POST. Record that monitor evidence in the run log.
- If no B2 Cloud POST was recorded, invoke the page-defined `b2CloudDeliveryInvoiceExportRequest('B2CloudGeneratePdfApi', 'b2_cloud_api_printStartLocation', 'ヤマト運輸', orderBySql)` once for the same selected GoQ IDs.
- Do not run the fallback when a B2 Cloud POST was already recorded; this prevents duplicate label-generation requests.
- Record selected GoQ IDs, print-start location, `orderBySql`, success/error alert text, download card, issuance verification, and print-preview evidence.

## Dashboard Notice Modal

- When entering the GoQ dashboard, handle an お知らせ/notice modal before entering the order list.
- If the notice has checkboxes, scroll the modal as needed and check every enabled checkbox, including checkboxes that are initially below the visible area.
- Press the confirmation button such as `上記について確認しました` or `確認しました` only after the required boxes are checked.
- Record the handled modal in the run log.

## Printer Routing

Use these destinations unless the user explicitly says otherwise. Printer names on this PC are the Apeos C5240 queues with the `C5240 ` prefix; matching is by substring (`tools/lib/printers.mjs`, `.env` `PRINTER_*` overrides). The queues without the prefix (`普通紙` / `ヤマト/コンパクト` / `ネコポス` / `佐川`) are the old C3530 driver and must not be used; always pass the prefixed name (a bare `ヤマト` matched the old queue on 2026-10-01).

- Picking list: `C5240 普通紙`
- Sagawa normal labels: `C5240 佐川`
- Sagawa labels size 120+: `C5240 佐川`
- Yamato Takkyubin labels: `C5240 ヤマト/コンパクト`
- Takkyubin Compact labels: `C5240 ヤマト/コンパクト`
- Nekopos labels: `C5240 ネコポス`

Amazon-specific handling: do not split or route Amazon orders differently unless the user explicitly requests Amazon-specific separation.

## Print Preview Checks

Before every print, inspect Chrome print preview with a screenshot. The print preview is a separate `chrome://print/` target; operate controls under the `print-preview-sidebar` Shadow DOM.

Verify all of the following before pressing print:

- The right-side destination printer matches the intended printer.
- The page count is plausible for the target count and document type.
- Previous printer settings have not carried over incorrectly.
- For shipping labels, color is set to `白黒`.
- For shipping labels, details are expanded and `両面に印刷する` is OFF.
- Record both the expected printer and the actual Chrome print-preview destination in the run log.

Do not print if the destination is unknown, differs from the intended printer, or cannot be verified from preview.

The reviewer must fail a run when the actual logged destination is missing or does not match the status-specific printer route. In particular, Sagawa labels must not pass review when printed to `ヤマト/コンパクト`.

Manual print-preview fallback is still part of the reviewed flow. Do not call `tools/press-open-print-preview.mjs` directly. Use `tools/reviewed-press-open-print-preview.mjs <port> <printer> <color> --purpose picking|label --status <status>` so the print button cannot be pressed unless the declared document type/status matches the expected printer.

## Safety Rules

- Do not infer printer settings from memory; verify them every time.
- Do not advance to printing before shipment exclusions, dates, tracking numbers, and carriers are checked.

## Address Warning Rules

- Do not exclude all address warnings by default; exclude only unresolved address warnings after safe/approved fixes are handled.
- Detect address warnings such as `【住】` in the GoQ carrier column immediately after opening each status.
- A surface `【住】` warning that remains after correction is not unresolved by itself.
- Reviewed/fixed means the row was opened and a safe correction was saved, or external/operator validation was explicitly recorded as confirmed. Merely opening the row and finding no safe mechanical change is not reviewed/fixed.
- Unresolved means the address still fails after correction/validation, such as a carrier/API error report after label generation, or a user-confirmed unresolved case.
- If any target row has an address warning that has not been reviewed/fixed or explicitly classified as unresolved with `住所不正` recorded in the GoQ one-line memo, do not proceed to picking-list or label printing.
- Manual exclusion is allowed only for rows explicitly classified as unresolved after correction/validation and memo-marked.
- For address normalization, remove duplicated prefecture text from address 1 when the prefecture field already contains it.
- Normalize full-width digits to half-width digits. Normalize full-width hyphens, long-vowel-like separators, and dash-like address separators to ASCII `-`.
- Do not remove address hyphens used in lot numbers. Do not remove telephone hyphens. Do not change telephone numbers unless explicitly required.
- Split address fields as: address 1 = municipality plus town area; address 2 = lot number and after, including building name and company name.
- Example: `沖縄県 / 沖縄県豊見城市豊崎１－１１７８Fステージ豊崎パークフロント1003 / 株式会社ジャスミン` becomes `沖縄県 / 豊見城市豊崎 / 1-1178 Fステージ豊崎パークフロント1003 株式会社ジャスミン`.
- When saving GoQ address edits, choose the save button by the exact `upbtm`/`orderform.submit()` control and explicitly exclude `upbtm2` actions such as `ラッピング追加`.
- Do not pass Japanese address values through an inline PowerShell/Node command unless the values are encoded safely. Use Unicode escapes, a UTF-8 file, or another verified UTF-8 path, then re-read the saved GoQ fields and stop immediately if any `?` replacement characters appear.
- Do not complete a label-only or picking-only run.
- If the live page state conflicts with the expected flow, pause the operation and report the specific mismatch.

## Sagawa 120+ Post-Label Flow

For GoQ status `佐川120サイズ以上` (`stat=42`), e-Hiden III label printing is not the end of the waybill-number flow.

Before e-Hiden III label printing:

1. Use the common GoQ pre-label flow only through picking-list output. For a hold-status test, this means `hold-sagawa` with `--skip-labels`; do not press the normal GoQ Sagawa label button.
2. The operational target is all orders for which Sagawa 120+ labels are issued in this run. Before CSV export, every target must have today's ship date, empty tracking number, expected Sagawa carrier, and no unresolved address warning.
3. Export e-Hiden III CSV with exactly all GoQ rows that will have labels issued in this run selected. Do not shrink this to one row just because a previous test used one order.
4. If an exported CSV contains rows outside the issued-label target set, do not import it. Re-export or filter it to exactly all issued-label rows by order number and customer management number.
5. Normalize product columns only for affected target rows, import the all-issued-orders CSV into e-Hiden III with common template `e飛伝Ⅱ_飛脚宅配便移行_CSV_ヘッダ無`, and confirm the import modal shows total N / normal N for the issued-label count before registration.
6. On e-Hiden III `送り状印刷一覧`, select all and only the customer management numbers for the orders being issued in this run, generate the label PDF, verify the PDF content/count, and print it to the Sagawa printer.
7. Record the tracking number for every issued order from the e-Hiden row/PDF/history evidence; use that customer-management-number/tracking-number map for the post-label flow.

After the label PDF is generated/printed:

1. Go to e-Hiden III `荷物受渡書印刷`.
2. Search/confirm all orders whose labels were issued in this run by ship date and the saved customer-management-number/tracking-number map.
3. Select all and only those issued orders in one batch. Do not run this gate one order at a time unless the user explicitly requests single-order recovery.
4. Click `印刷` and then the print button inside the `荷物受渡書印刷設定` modal. A manifest PDF may open; do not assume paper output is required unless the user explicitly asks for paper.
5. Only after this step, go to `出荷履歴一覧`.
6. Search/filter the history for the same issued-order batch by ship date and saved customer-management-number/tracking-number evidence.
7. Select all and only the issued-order rows in one batch.
8. Click `データ出力`, choose `共通テンプレートを使用`, then click `直接出力`.
9. Verify the downloaded `shukka_rireki_YYYYMMDD.csv` contains exactly all orders whose labels were issued in this run: same count, same customer management numbers, and same tracking numbers. Import this CSV once as a batch.
10. Import that batch CSV once into GoQ `送り状番号取込` for e-Hiden III.
11. Return to the GoQ source status first (`佐川120サイズ以上`, `stat=42`) and verify every target row contains `[伝票入力済]` plus its exact numeric tracking number.
12. If a target is not found in the source status, then search the `全て` status (`stat=12`) by saved GoQ ID or order number and verify `[処理済]` or the current moved status, `[伝票入力済]`, and the exact numeric tracking number. GoQ automatic status movement runs as a periodic batch, roughly every 15 minutes, so the source status is the primary check and `全て` is only the fallback.
13. Open GoQ order detail pages only for target rows that failed both list-level checks. Do not verify an entire batch through order details. In detail fallback, confirm the exact tracking field such as `da19[0]` and the delivery management field such as `da1[0]`.

Do not search `出荷履歴一覧` before completing `荷物受渡書印刷`; the row may not exist there yet.

Standard command after label generation/printing is batch-based over the saved map of all orders issued in this run, not the old one-order test flow:

```powershell
node tools/sagawa120-post-label-flow.mjs --targets .o11y/sagawa120/target-map-YYYYMMDD.json --date 2026/06/02 --port 9222 --execute
```

The old `--customer ... --tracking ...` mode is recovery-only for a single failed row after the batch path has already been attempted and the user agrees to single-row recovery.

### Sagawa 120+ Recovery Rules Learned From Failures

These are not shortcuts and must not change the required flow. Use them only to keep the required flow auditable when the browser, e-Hiden III, or GoQ behaves unexpectedly.

- SmartClub/e-Hiden III login credentials, if ever needed, go in `.env` like every other credential in this repository (Windows Credential Manager is not used). If the current page is SmartClub `spastart.jsp` or the SmartClub menu, treat it as logged in; if e-Hiden III opens an auth redirect tab, run the same login helper again and verify the final page is e-Hiden III `/menu`.
- When exporting the GoQ e-Hiden III CSV, trusted-click coordinates must be recomputed after scrolling the output button into the viewport. If the click event log is empty or no `/export/ehiden_ver3.php` tab/download appears, the button was not actually pressed; do not continue to e-Hiden import until the CSV is verified to contain exactly the issued target GoQ IDs/customer-management numbers.
- GoQ CSV downloads may not appear in the normal Downloads folder. If the browser download panel shows UUID-like 341-byte files, search the Playwright temp artifact folders for the most recent small file, verify its header/body contains the expected GoQ/e-Hiden CSV fields and target order, then copy it into the run workspace with a descriptive name.
- If e-Hiden III CSV import returns `品名１ 桁溢れ`, do not register the import. Export the error CSV, shorten only the product-name columns for the affected target rows, keep order/customer/tracking fields unchanged, and reimport until the modal shows total N / normal N for the target batch.
- After e-Hiden III label generation, do not print a `directdownload` web page blindly. If `Ctrl+P` does not open Chrome print preview or the PDF viewer print control cannot be found, use the PDF viewer download control, verify the saved file begins with `%PDF`, open the local PDF, then print that PDF to the Sagawa printer. This prevents printing the web application screen instead of the label.
- Do not derive the tracking number from a loose PDF digit scan. A random 12-digit string in the PDF can be a false candidate. Prefer the e-Hiden row, 荷物受渡書/送り状印刷一覧 row, or 出荷履歴一覧 row that also contains the target customer management number.
- Never skip 荷物受渡書印刷 as a recovery idea. If 出荷履歴一覧 does not show the rows, first confirm the 荷物受渡書印刷 gate was completed for the exact target batch and tracking numbers.
- When e-Hiden `directdownload` tabs are open, automation must choose a usable e-Hiden page such as `/menu`, `/niukesho/print/list`, `/ship-history/list`, or `/ship-history/export/template`; explicitly exclude `/directdownload` and PDF tabs. A `directdownload` tab has little/no page text and will break TOP/menu navigation.
- If direct Vue export methods fail with errors like `rowsvcBetu`, use the visible DOM path instead: search the exact batch, select the visible target-row checkboxes, click footer `データ出力`, choose `共通テンプレートを使用`, then click `直接出力`.
- For GoQ e-Hiden III waybill-number import, set `input[type="file"][name="ehiden3file"]`, scroll the nearby `データ取込` button into view, and click the element/locator itself. Do not use document coordinates as viewport click coordinates. Wait for the page result after the click, then require success text like `e-飛伝IIIの伝票番号をN件取り込みました。`, where N matches the issued-label count.
- Do not trust a stale import error message after a click attempt. Final completion requires checking the GoQ source status first for every issued order with `[伝票入力済]` plus the exact tracking number, then falling back to `全て` (`stat=12`) by GoQ ID/order number only if the source status no longer contains an issued order. Order-detail verification is a narrow fallback for still-unverified target rows only; never use it as the default batch verification method.

## Mojibake Guardrail

- New standard operation scripts must not rely on mojibake button text.
- Prefer UTF-8 Japanese labels such as `印刷`, `検索`, `データ出力`, `直接出力`, `荷物受渡書印刷`, and `出荷履歴一覧`.
- Prefer stable URLs, input names, and Vue component names when labels are ambiguous.
- Keep old mojibake-based scripts as diagnostics only; do not promote them as the normal flow.
