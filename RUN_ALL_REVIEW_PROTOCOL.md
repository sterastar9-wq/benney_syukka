# run_all Review Protocol

## Goal state

- Path: `.goq_flow_sessions/automation_goals/goq-run-all-daily-agent.json`
- Writer: `run_all.py`
- Purpose: survive archived/interrupted automation threads and let manager/reviewer agents resume from project state instead of chat history

## Roles

- Manager agent
  - Reads `resume-context`
  - Decides whether to wait, retry, or resume
  - Uses `resume_from_step`, `failure`, and `log_file` to choose the next action
- Reviewer agent
  - Verifies the final state before treating the run as done
  - Confirms all required steps are `completed`
  - Marks failures as `needs_attention`

## Commands

```powershell
python scripts\run_all_goal_guard.py status
python scripts\run_all_goal_guard.py resume-context
```

## Expected statuses

- Top-level: `pending`, `running`, `completed`, `failed`, `stale`, `blocked`
- Step-level: `pending`, `running`, `completed`, `failed`
- Review-level: `pending`, `passed`, `needs_attention`

## Verification checklist

- `current_run.run_id` is present and matches the latest start event
- `current_run.log_file` exists
- `gshipping_download`, `sales_download_local`, and `integrated_sales_automation` all have `status=completed`
- Each completed step has `started_at`, `ended_at`, and `exit_code=0`
- Top-level `status=completed`
- Top-level `review_status=passed`

## Stale-run rule

- If `status=running` and `heartbeat_at` is older than 15 minutes, treat the run as `stale`
- Resume from `resume_from_step`
- Inspect `failure.last_log_excerpt` and the referenced scheduled log before retrying
