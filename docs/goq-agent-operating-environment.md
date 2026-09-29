# GoQ Agent Operating Environment

This file defines the guardrails for GoQ shipping-label work.

## Executor Startup

Before any GoQ side effect, the executor must load and keep these rule sources in the run log:

- `AGENTS.md`
- `tools/goq-print-flow.README.md`
- `C:\Users\tatsu\.codex\skills\goq-shipping-label-print-flow\SKILL.md`
- `C:\Users\tatsu\.codex\memories\goq-print-flow-rules.md`

If any required source is missing or does not contain the expected GoQ print-flow rules, the run must stop before printing, CSV export, shipping-date overwrite, or label generation.

## Address Warning Guardrail

- Immediately after entering each status, detect address warnings such as `【住】` in the GoQ order-list carrier column.
- Address-warning rows must be opened on the delivery-address correction page before label generation.
- A surface `【住】` warning that remains after correction is not, by itself, unresolved.
- "Reviewed/fixed" means the row was opened, normalized or externally validated as needed, and recorded in the run as fixed/confirmed. The warning may still remain visible in the GoQ list.
- "Unresolved" means the address still fails after correction/validation, such as a carrier/API error report after label generation, or a user-confirmed unresolved case.
- Do not proceed to picking-list printing or shipping-label printing while any target status row has an address warning that has not been reviewed/fixed or explicitly classified as unresolved.
- Manual exclusion is allowed only for rows explicitly classified as unresolved after correction/validation, not as a bypass for unreviewed warning rows.
- Address 1 is municipality plus town area.
- Address 2 is lot number and after, including building name and company name.

## Reviewer Guardrail

After every run, review the run log with:

```powershell
node tools/goq-run-review.mjs --latest
```

The reviewer must fail the run report if it finds:

- rule material was not loaded at startup
- picking/label output happened with unreviewed address warnings
- address-warning rows were manually excluded without being marked fixed or unresolved
- shipping-label generation happened before picking-list output
- label printing happened without a downloaded label record
- print preview evidence is missing from printed picking lists or labels
