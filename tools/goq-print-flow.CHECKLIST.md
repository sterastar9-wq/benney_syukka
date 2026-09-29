# GoQ shipping-label print flow checklist

This checklist is the canonical execution checklist for the existing GoQ shipping-label print-flow skill.

The executor must read this checklist before side effects. The reviewer must use it with `run.goal` when judging completion. A run is not complete just because a button was clicked, a PDF was generated, or one print job succeeded.

## Required Skill And Entry Point

- Use skill: `goq-shipping-label-print-flow`.
- Use Docker reviewed wrapper for autonomous operation:
  - `docker compose exec goq npm run goq:print -- --status <status> --port 9223 --execute`
- Use direct `node tools/goq-print-flow.mjs ...` only for debugging.
- The executor must record `run.goal` before side effects.
- The reviewer must read `run.goal` first, restate the concrete status/date/scope/output goal, then judge the run against this checklist.

## Common Flow

1. Load required rule material: `AGENTS.md`, `tools/goq-print-flow.README.md`, `tools/goq-print-flow.CHECKLIST.md`, skill `SKILL.md`, and memory rules.
2. Confirm the requested status key, GoQ status, date, optional order scope, optional exclusions, and optional store tab.
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
20. Before shipping-label generation, save the exact label target snapshot: GoQ IDs, order numbers, status, carrier, shipping date, and request time.
21. Press the status-specific shipping-label generation button.
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

| Status key | GoQ status | stat | Expected carrier | Label button | Label printer |
| --- | --- | ---: | --- | --- | --- |
| `sagawa` | 佐川 | 28 | 佐川急便 | `#smartAPI` / 佐川急便送り状発行 | 佐川 |
| `yamato` | ヤマト | 30 | ヤマト運輸 | `#B2CloudGeneratePdfApi` / ヤマト運輸送り状発行 | ヤマト/コンパクト |
| `compact` | コンパクト | 29 | ヤマト運輸 コンパクト | `#B2CloudGeneratePdfApi` / ヤマト運輸送り状発行 | ヤマト/コンパクト |
| `nekoposu` | ネコポス徳島 | 31 | ヤマト運輸 ネコポス | `#B2CloudGeneratePdfApi` / ヤマト運輸送り状発行 | ネコポス |
| `hold-sagawa` | 保留（佐川想定） | 10 | 佐川急便 | `#smartAPI` / 佐川急便送り状発行 | 佐川 |

Amazon-only variants are separate explicit status keys:

- `sagawa-amazon`
- `yamato-amazon`
- `compact-amazon`
- `nekoposu-amazon`
- `hold-sagawa-amazon`

Base status keys must not implicitly apply the Amazon tab. Use an Amazon variant, `--amazon-only`, or explicit `--store-tab "Amazon"` only when requested.

## Status-Specific Warnings

- Sagawa and hold-Sagawa use Smart API. The label card/resource may not behave like a normal browser download. Use only a resource/PDF tied to the current request, and parse error reports such as postal-code/address mismatch.
- Yamato, Compact, and Nekopos use the Yamato B2 Cloud generation button. Dialogs and alerts must be recorded and treated as blockers unless the recorded text is a known non-blocking success notice.
- Yamato, Compact, and Nekopos must record B2 Cloud request evidence. If a generation request is accepted by GoQ, the download file list should show either a success PDF or an error report within about one minute. After the bounded reload window, absence of both means the button click probably did not send the B2 Cloud request. In that case, use the monitored single fallback call to `b2CloudDeliveryInvoiceExportRequest(...)` and record the selected GoQ IDs, print-start location, `orderBySql`, and resulting success/error notice.
- Nekopos labels must print to `ネコポス`, not `ヤマト/コンパクト`.
- Sagawa labels must print to `佐川`, not a Yamato-family printer.
- Picking lists always print to `普通紙` regardless of status.

## Completion Standard

The run is complete only when all of these are true:

- `run.goal` exists and matches the requested operation.
- Required rule material, including this checklist, was loaded before side effects.
- Address warnings were fixed, confirmed, or memo-marked `住所不正` and excluded.
- Picking list output completed to `普通紙`.
- Shipping-label generation target snapshot was recorded.
- Label issuance was verified against the target snapshot.
- Shipping labels printed to the correct status-specific destination.
- Review reports no violations and no unaccepted warnings.
