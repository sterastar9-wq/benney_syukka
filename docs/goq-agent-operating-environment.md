# GoQ Agent Operating Environment（ベニー様版）

This file defines the guardrails for GoQ shipping-label work in this repository.

## Runtime

- Everything runs locally on Windows with Node.js 20+ and Chrome. Docker is not used.
- Chrome must be started with a remote-debugging port (default `9223`) via `scripts\start-chrome-cdp.ps1`.
- Credentials live only in the repository `.env` (see `.env.example`). Never store them in skills, memories, chat, logs, or screenshots.
- Standard entry point: `npm run goq:print -- --status <status> --execute` (reviewed wrapper).

## Executor Startup

Before any GoQ side effect, the executor must load and keep these rule sources in the run log:

- `AGENTS.md`
- `tools/goq-print-flow.README.md`
- `tools/goq-print-flow.CHECKLIST.md`
- `.claude/skills/goq-shipping-label-print-flow/SKILL.md`
- `codex/memories/goq-print-flow-rules.md`

If any required source is missing or does not contain the expected GoQ print-flow rules, the run must stop before printing, CSV export, shipping-date overwrite, or label generation.

The executor also verifies the GoQ login state first and, if the login page is shown, logs in from `.env` (`tools/goq-login.mjs`).

## Benny Flow

1. GoQ login
2. Picking list built locally (`tools/local-picking/`) and printed to `普通紙`
3. Shipping-label data exported from GoQ as a B2 Cloud CSV (`labelMode: b2-csv`) and verified against the target snapshot
4. Yamato Business Members: import the CSV into B2 Cloud, print labels (`ヤマト` / `ネコポス`), export tracking numbers, import them into GoQ (`tools/yamato-b2/`)

GoQ-side label generation buttons (B2クラウドAPI) are not pressed for Yamato-family statuses.

## Address Warning Guardrail

- Immediately after entering each status, detect address warnings such as `【住】` in the GoQ order-list carrier column.
- Address-warning rows must be opened on the delivery-address correction page before CSV export or label generation.
- A surface `【住】` warning that remains after correction is not, by itself, unresolved.
- "Reviewed/fixed" means the row was opened, normalized or externally validated as needed, and recorded in the run as fixed/confirmed. The warning may still remain visible in the GoQ list.
- "Unresolved" means the address still fails after correction/validation, such as a carrier/API error report after label generation, or a user-confirmed unresolved case.
- Do not proceed to picking-list printing, label CSV export, or shipping-label printing while any target status row has an address warning that has not been reviewed/fixed or explicitly classified as unresolved.
- Manual exclusion is allowed only for rows explicitly classified as unresolved after correction/validation, not as a bypass for unreviewed warning rows.
- Address 1 is municipality plus town area.
- Address 2 is lot number and after, including building name and company name.

## Reviewer Guardrail

After every run, review the run log with:

```powershell
npm run goq:review
```

The reviewer must fail the run report if it finds:

- rule material was not loaded at startup
- picking/label output happened with unreviewed address warnings
- address-warning rows were manually excluded without being marked fixed or unresolved
- shipping-label generation or CSV export happened before picking-list output
- (b2-csv) the exported CSV does not match the target snapshot, or no handoff file was written
- (goq-api) label printing happened without a downloaded label record
- print preview evidence is missing from printed picking lists or labels
- the actual print-preview destination does not match the status printer route
