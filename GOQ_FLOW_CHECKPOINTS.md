# GoQ Flow Checkpoints

This repository now treats every GoQ printing operation as a reviewed session.
Do not print, download label files, export label CSVs, or press carrier label
buttons unless the next action is approved by `scripts/goq_flow_guard.py`.

## Agent Roles

- Manager agent: creates the session objective, blocks already completed carriers,
  and keeps the carrier plan current.
- Executor agent: performs exactly one approved browser or print action.
- Reviewer agent: runs the guard before the action, checks evidence after the
  action, and marks the checkpoint complete or blocked.

The same Codex instance may perform all roles, but the review command must run
between every side-effecting action.

## Status Values

- `not_started`: checkpoint exists but no action has started.
- `running`: reviewer approved the action and executor may perform it.
- `completed`: evidence was recorded and the action must not be repeated.
- `blocked`: live state, print queue, or evidence did not match the plan.
- `skipped`: explicitly not part of the current user request.

## Required Checkpoints

Use these phases for each carrier:

- `sort`
- `picking_upload`
- `picking_print`
- `label_request`
- `ehiden_csv_export`
- `ehiden_import`
- `label_download`
- `label_print`
- `manifest_print`
- `ship_history_export`
- `goq_tracking_import`
- `tracking_verify`
- `post_label_verify`

`label_print` is blocked until `picking_print` is completed for the same carrier.
`label_download`, `label_print`, and `post_label_verify` are blocked until
`label_request` is completed for the same carrier.

Yamato-family phases are:

- `picking_print`
- `label_request`
- `label_download`
- `label_print`
- `post_label_verify`

Normal Sagawa phases are:

- `picking_print`
- `ehiden_csv_export`
- `ehiden_import`
- `label_print`
- `goq_tracking_import`
- `tracking_verify`
- `post_label_verify`

Sagawa 120+ phases are:

- `picking_print`
- `ehiden_csv_export`
- `ehiden_import`
- `label_print`
- `manifest_print`
- `ship_history_export`
- `goq_tracking_import`
- `tracking_verify`
- `post_label_verify`

`sagawa120` never uses the GoQ API/B2-style `label_request` phase in normal
operation. `sagawa` cannot use `manifest_print` or `ship_history_export`; those
are 120+ only.

## Normal Command Pattern

Initialize a session and record user constraints:

```powershell
python scripts\goq_flow_guard.py init --session 20260611 --objective "Print Yamato onward only" --completed-carrier sagawa --block-carrier sagawa
```

Before each side effect, reviewer approves or blocks the proposed action:

First capture live GoQ tabs, checkpoint state, legacy print guard, and print
queue:

```powershell
python scripts\goq_flow_guard.py capture --session 20260611 --name nekopos-before-picking-print --note "Before Nekopos picking print"
```

```powershell
python scripts\goq_flow_guard.py review --session 20260611 --carrier nekopos --phase picking_print --count 158 --printer "普通紙" --job-key 20260611-nekopos-picking-158 --csv "送り状ダウンロード\ネコポス徳島_picking_202606110912.csv" --evidence ".goq_flow_sessions\evidence\nekopos-before-picking-print.json" --with-print-queue
```

Only if approved, mark it running:

```powershell
python scripts\goq_flow_guard.py start --session 20260611 --carrier nekopos --phase picking_print --count 158 --printer "普通紙" --job-key 20260611-nekopos-picking-158 --csv "送り状ダウンロード\ネコポス徳島_picking_202606110912.csv" --evidence ".goq_flow_sessions\evidence\nekopos-before-picking-print.json" --with-print-queue
```

After the action, reviewer records completion evidence:

```powershell
python scripts\goq_flow_guard.py complete --session 20260611 --carrier nekopos --phase picking_print --note "Print preview closed and legacy guard has job key"
```

If state does not match, block instead:

```powershell
python scripts\goq_flow_guard.py block --session 20260611 --carrier nekopos --phase label_print --reason "Printer destination mismatch"
```

## Duplicate Prevention

The guard blocks:

- Any carrier in `blocked_carriers`.
- Any carrier in `completed_carriers`, unless `--allow-reprint` is explicit.
- A completed checkpoint for the same carrier and phase.
- A print action whose `--job-key` already exists in `.goq_print_guard.json`.
- A print action without a print queue snapshot.
- A side-effecting action without a live GoQ/tab/download evidence JSON file.
- A label print before picking print.
- A print destination that does not match the carrier route.
- A CSV row count that does not match `--count`.

## Current Incident State

For the 2026-06-11 session, Sagawa was already printed by the user and must be
blocked. Yamato 123, Compact 50, and Nekopos 158 were recorded as printed in
`.goq_print_guard.json`. A later Nekopos row `187703` had a blank ship date and
was not part of the 158-row CSV batch.

## Legacy Script Policy

`shippingLabelDownload.py` is blocked by default because it exports all carrier
label data without session checkpoints. It may only run when the operator
explicitly sets `GOQ_ALLOW_LEGACY_LABEL_DOWNLOAD=1` for that single command.
