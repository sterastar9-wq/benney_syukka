# GoQ shipping-label print flow checklist

This checklist is the canonical execution checklist for the existing GoQ shipping-label print-flow skill.

The executor must read this checklist before side effects. The reviewer must use it with `run.goal` when judging completion. A run is not complete just because a button was clicked, a PDF was generated, or one print job succeeded.

## Required Skill And Entry Point

- Use skill: `goq-shipping-label-print-flow` (`.claude/skills/goq-shipping-label-print-flow/SKILL.md`).
- Use the reviewed wrapper for autonomous operation (local Node.js, no Docker):
  - `npm run goq:print -- --status <status> --execute`
- Use direct `node tools/goq-print-flow.mjs ...` only for debugging.
- Credentials come from `.env` only. The runner verifies GoQ login first and logs in when needed.
- The executor must record `run.goal` before side effects.
- The reviewer must read `run.goal` first, restate the concrete status/date/scope/output goal, then judge the run against this checklist.

## Common Flow

1. Load required rule material: `AGENTS.md`, `tools/goq-print-flow.README.md`, `tools/goq-print-flow.CHECKLIST.md`, skill `SKILL.md`, and memory rules.
2. Confirm the requested status key, GoQ status, date, optional order scope, optional exclusions, and optional store tab.
2a. Verify the GoQ login state; if the login page is shown, log in from `.env` and record `goq login attempted` / `goq login state verified`.
3. Enter GoQ and handle any dashboard notice modal before opening order rows.
4. Set and verify GoQ list display count to `500件`.
5. Read initial rows and record GoQ ID, order number, carrier, shipping date, tracking/label marker, and address-warning state.
6. Exclude rows only for rule-backed reasons: wrong carrier, already shipped date, already tracking/label marker, explicit request exclusion, outside order scope, or memo-marked unresolved address.
7. Detect address warnings such as `【住】` immediately after opening the status.
8. Resolve address warnings before output:
   - If a safe correction is clear, save it and record the reason.
   - If external/web validation clearly confirms a correction, apply it and record the source/reason.
   - If the address cannot be resolved confidently, write `住所不正` in the GoQ one-line memo and exclude only that row.
9. Do not treat a row as reviewed/fixed merely because it was opened or no mechanical change was found.
10. Stop before picking or labels if any target row has an unreviewed address warning.
11. Set today's shipping date for eligible rows and verify the resulting target state.
12. Preserve target identity by GoQ ID and order number because rows may move after shipping-date or label updates.
13. Apply required sorting/filtering only when the page confirms the result; stop on ambiguous page action failure.
14. Fetch picking CSV from the GoQ CSV API and save it under `.o11y/goq-unified-print-flow/downloads/`.
15. (Benny version) Build the picking list locally: read the saved CSV and the Benny master sheet (`GoQ全データ` tab of ベニー様_ピッキング参照), then write HTML/PDF under `.o11y/goq-unified-print-flow/picking/`. Do not use Smart Pick — it reads the original version's master.
16. Stop if the master's row-3 headers do not match the GoQ全データ column layout, and check the anomaly list (orders missing from the master) recorded in `generated local picking pdf`.
17. Print the picking list first to `普通紙`.
18. On resume after a picking list was already printed for the same status/date/GoQ IDs, do not print the picking list again. Reuse the previous picking print evidence and continue only the unfinished label side.
19. Inspect Chrome print preview before pressing print and record the actual destination.
20. Before shipping-label CSV export or generation, save the exact label target snapshot: GoQ IDs, order numbers, status, carrier, shipping date, and request time.
20a. (Benny Yamato-family, `labelMode: b2-csv`) Select the B2 Cloud format in `#trader_s`, press the output button, and save the CSV. Record `exported shipping label csv`.
20b. Verify the CSV against the target snapshot (every target present, no extra rows) and record `verified shipping label csv against target snapshot`. Stop on mismatch.
20c. Write the handoff file for `tools/yamato-b2/` and record `wrote b2 cloud handoff`. Steps 21-28 below do not apply to b2-csv mode; label printing happens on the Yamato Business Members side with the same print-preview checks and printer routing.
20d. (Benny Yamato side) Run `npm run yamato:print -- --handoff <file>` (`tools/yamato-b2/print-labels.mjs`): import → result check (count = targets, no error rows) → 印刷内容の確認へ → issue → print, in one go. It refuses to import when the GoQ run log has no `printed picking list` step to the picking printer (a `--preview-only-picking` run is not a printed picking list). If the 航空危険物 "重要なお知らせ" appears, it stops; continue only with operator approval (`--air-notice-approved`) after checking the items.
20f. (Benny Yamato side) Tracking round trip: `npm run yamato:export-tracking -- --handoffs <files>` (B2 発行済データの検索 → verify every target is issued → 外部ファイルに出力 CSV, stops on orders missing from the handoffs unless `--allow-extra`), then `npm run yamato:import-tracking -- --handoffs <files>` (GoQ 送り状番号取込 B2クラウド欄 → per-order verification on the order detail page `da19[0]`, because the list rows do not show the number → move only orders that have **both** a verified tracking number and a shipping date to ★発送済み and confirm they left the source status; use `--set-ship-date today` to write today's shipping date on the order detail page first, because Benny's statuses do not manage the shipping date). Report any target without a verified tracking number as `送り状未発行/除外された可能性あり`, and finish with today's shipped count per status.
20e. Label product names: the B2 label prints 品名1/2. `rewrite-b2-csv.mjs` must have written the 品名コード (`data/hinmei-codes.csv`) into 品名コード1/2 and 品名1/2; verify the label shows the short code (e.g. `ｵｰﾙﾄﾞｽﾊﾟｲｽ(1)5580`), not the GoQ product name.
21. (goq-api mode) Press the status-specific shipping-label generation button.
22. If a modal, alert, confirm, visible error, or error report appears, read and record the text. Do not continue blindly after closing it.
22a. For Yamato-family statuses (`yamato`, `compact`, `nekoposu`), verify that the B2 Cloud generation click actually produced a `RequestB2CloudDeliveryInvoice.php` POST. If the download list does not show either success PDF or error report after the bounded reload window, treat it as "request not sent", not as an address error.
22b. When the B2 Cloud POST is missing, record the monitor evidence and invoke the page-defined `b2CloudDeliveryInvoiceExportRequest('B2CloudGeneratePdfApi', 'b2_cloud_api_printStartLocation', 'ヤマト運輸', orderBySql)` once for the same selected GoQ IDs. Do not invoke it if the monitor already recorded a B2 Cloud POST.
23. Download or open only the label PDF/resource associated with the current request time and target snapshot.
24. Validate downloaded label resources as PDF when applicable.
25. Verify label issuance by comparing the target snapshot with post-generation GoQ rows that have tracking/label-issued markers.
26. Treat missing tracking/label-issued markers as `送り状未発行/除外された可能性あり`.
27. Print the shipping label to the status-specific printer.
28. For shipping labels, verify print preview destination, black-and-white color, details expanded, and duplex OFF before pressing print.
29. Run review and do not report completion if there are violations or unaccepted warnings.
30. Report final completion only when picking output, label generation, label issuance verification, label print, and review all pass for the declared goal.

## Status Differences

Benny's GoQ statuses (verified on the live system on 2026-09-30):

| Status key | GoQ status | stat | Expected carrier | Label mode | Label output | Label printer |
| --- | --- | ---: | --- | --- | --- | --- |
| `nekoposu` | ★ネコポス・クリックポスト | 30 | ヤマト運輸 (ネコポス) | b2-csv | `#trader_s` = `b2_cloud` (B2クラウド) → `B020` 出力 → ヤマトビジネスメンバーズ | ネコポス |
| `takkyubin` | ★宅急便 | 26 | ヤマト運輸 | b2-csv | same | ヤマト |
| `compact` | コンパクト (only when `GOQ_COMPACT_STAT` is set) | env | ヤマト運輸 (コンパクト) | b2-csv | same | コンパクト |

Other statuses on Benny's GoQ (not print targets): 29 ★発送済み, 32 ★出荷通知, 17 メール待機, 33 ★処理済み, 24 出荷日記入, 3 発送前入金待ち, 6 発送後入金待ち. Carrier options are 日本郵便 / ヤマト運輸 / 佐川急便. Rows whose carrier is `日本郵便` (クリックポスト) are excluded as `carrier mismatch`.

Picking CSV is custom CSV id 1 (`カスタムCSV全項目(サンプル)`), which contains 商品名 / 個数 / 商品SKU / 商品コード / JANコード / GoQ管理番号 / 送付先氏名 / 配送方法(複数配送先) / チェック項目. Override with `.env` `GOQ_PICKING_CSV_CUSTOM_ID`.

Printer names on this PC: use the `C5240 ` prefixed queues (`C5240 普通紙` / `C5240 ヤマト/コンパクト` / `C5240 ネコポス` / `C5240 佐川`). Queues without the prefix are the old C3530 driver and must not be used. `.env` `PRINTER_*` overrides the defaults in `tools/lib/printers.mjs`.

★クール便 (27) is not handled by Benny and is not a flow target. Before shipping date / label steps, the runner changes carrier 日本郵便 → ヤマト運輸, then sets the チェック項目/フラグ in a separate operation (`nekoposu` → ネコポス, `compact` → コンパクト; ★宅急便 has none), because GoQ cannot change both at once. Amazon-only variants (`nekoposu-amazon`, `takkyubin-amazon`) exist for compatibility only; Benny's GoQ has no store tab (`#st`).

Base status keys must not implicitly apply the Amazon tab. Use an Amazon variant, `--amazon-only`, or explicit `--store-tab "Amazon"` only when requested.

## Status-Specific Warnings

- Sagawa and hold-Sagawa use Smart API. The label card/resource may not behave like a normal browser download. Use only a resource/PDF tied to the current request, and parse error reports such as postal-code/address mismatch.
- Yamato, Compact, and Nekopos (Benny version) export the B2 Cloud CSV; the GoQ B2 Cloud generation button is not pressed. Dialogs and alerts during CSV output must still be recorded, and a run that used `requested shipping label generation` in b2-csv mode is a review violation.
- (goq-api mode only) Yamato-family labels generated through the GoQ API must record B2 Cloud request evidence (`RequestB2CloudDeliveryInvoice.php` POST); when it is missing, use the monitored single fallback call to `b2CloudDeliveryInvoiceExportRequest(...)`.
- Nekopos labels must print to `ネコポス`, not `ヤマト`.
- Sagawa labels must print to `佐川`, not a Yamato-family printer.
- Picking lists always print to `普通紙` regardless of status.
- Specify printers with the `C5240 ` prefix; a bare `ヤマト` substring selected the old C3530 queue on 2026-10-01.

## Completion Standard

The run is complete only when all of these are true:

- `run.goal` exists and matches the requested operation.
- Required rule material, including this checklist, was loaded before side effects.
- Address warnings were fixed, confirmed, or memo-marked `住所不正` and excluded.
- GoQ login state was verified (or auto-login succeeded).
- Picking list output completed to `普通紙`.
- Shipping-label target snapshot was recorded.
- goq-api mode: label issuance was verified against the target snapshot and labels printed to the correct status-specific destination.
- b2-csv mode: the exported CSV matched the target snapshot, the handoff file was written, and the Yamato Business Members side completed: import with the picking-evidence gate, label print to the `C5240 ` printer, tracking CSV export verified against the handoff targets, GoQ tracking import verified per order on the detail page, shipping date set to today, verified orders moved to ★発送済み, and today's shipped count reported per status (`npm run ship` does all of this in order).
- Review reports no violations and no unaccepted warnings.
