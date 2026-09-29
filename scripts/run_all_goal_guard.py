"""Persistent manager/reviewer goal state for the GOQ run_all automation."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = ROOT / ".goq_flow_sessions" / "automation_goals"
DEFAULT_AUTOMATION = "goq-run-all-daily-agent"
DEFAULT_OBJECTIVE = "Run GOQ run_all.py to completion and verify outcome."
DEFAULT_STALE_MINUTES = 15

STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_STALE = "stale"
STATUS_BLOCKED = "blocked"

STEP_ORDER = [
    ("gshipping_download", "GshippingDataDownload.py"),
    ("sales_download_local", "salesDataDownload_local.py"),
    ("integrated_sales_automation", "integrated_sales_automation.py"),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def parse_iso(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    tmp.replace(path)


def state_path(automation_id: str) -> Path:
    safe = "".join(ch for ch in automation_id if ch.isalnum() or ch in ("-", "_"))
    if not safe:
        raise SystemExit("automation_id must contain a safe name")
    return STATE_DIR / f"{safe}.json"


def make_steps() -> dict[str, Any]:
    return {
        key: {
            "script": script,
            "status": STATUS_PENDING,
            "started_at": "",
            "ended_at": "",
            "exit_code": None,
            "note": "",
            "artifacts": [],
            "verification": {
                "reviewed_by": "",
                "reviewed_at": "",
                "result": "pending",
                "evidence": [],
            },
        }
        for key, script in STEP_ORDER
    }


def default_state(automation_id: str) -> dict[str, Any]:
    return {
        "schema": 2,
        "automation_id": automation_id,
        "objective": DEFAULT_OBJECTIVE,
        "status": STATUS_PENDING,
        "review_status": "pending",
        "created_at": now_iso(),
        "manager": {
            "role": "manager",
            "required": True,
            "responsibilities": [
                "keep the automation objective current",
                "resume interrupted runs from persisted state",
                "choose the next safe command from step status and logs",
            ],
        },
        "reviewer": {
            "role": "reviewer",
            "required": True,
            "responsibilities": [
                "verify each step transition",
                "inspect logs on failure",
                "record completion evidence before the run is treated as done",
            ],
        },
        "current_run": {},
        "history": [],
    }


def normalize_state(state: dict[str, Any], automation_id: str) -> dict[str, Any]:
    if not state:
        return default_state(automation_id)

    state.setdefault("schema", 2)
    state.setdefault("automation_id", automation_id)
    state.setdefault("objective", DEFAULT_OBJECTIVE)
    state.setdefault("status", STATUS_PENDING)
    state.setdefault("review_status", "pending")
    state.setdefault("manager", default_state(automation_id)["manager"])
    state.setdefault("reviewer", default_state(automation_id)["reviewer"])
    state.setdefault("history", [])

    current = state.setdefault("current_run", {})
    current.setdefault("run_id", "")
    current.setdefault("target_date", "")
    current.setdefault("trigger", "")
    current.setdefault("started_at", "")
    current.setdefault("heartbeat_at", "")
    current.setdefault("ended_at", "")
    current.setdefault("exit_code", None)
    current.setdefault("log_file", "")
    current.setdefault("resume_from_step", STEP_ORDER[0][0])
    current.setdefault("steps", make_steps())
    current.setdefault("failure", {"step": "", "reason": "", "last_log_excerpt": ""})
    current.setdefault("review", {"reviewed_by": "", "reviewed_at": "", "result": "pending", "note": ""})

    for key, value in make_steps().items():
        current["steps"].setdefault(key, value)
        current["steps"][key].setdefault("verification", value["verification"])

    return state


def load_state(automation_id: str) -> dict[str, Any]:
    path = state_path(automation_id)
    raw = read_json(path, {}) if path.exists() else {}
    return normalize_state(raw, automation_id)


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = now_iso()
    write_json(state_path(state["automation_id"]), state)


def append_history(state: dict[str, Any], event_type: str, details: dict[str, Any]) -> None:
    state.setdefault("history", []).append({"at": now_iso(), "type": event_type, **details})


def compute_resume_from_step(steps: dict[str, Any]) -> str:
    for key, _script in STEP_ORDER:
        if steps.get(key, {}).get("status") != STATUS_COMPLETED:
            return key
    return ""


def stale_run(state: dict[str, Any], stale_minutes: int) -> bool:
    if state.get("status") != STATUS_RUNNING:
        return False
    heartbeat = parse_iso(state.get("current_run", {}).get("heartbeat_at", ""))
    if not heartbeat:
        return False
    now = datetime.now(timezone.utc).astimezone()
    return now - heartbeat > timedelta(minutes=stale_minutes)


def summarize_log(log_file: str, max_lines: int = 20) -> str:
    if not log_file:
        return ""
    path = Path(log_file)
    if not path.exists():
        return ""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-max_lines:])


def command_start(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    if args.objective:
        state["objective"] = args.objective

    if stale_run(state, args.stale_minutes):
        state["status"] = STATUS_STALE
        append_history(
            state,
            "stale",
            {
                "run_id": state["current_run"].get("run_id", ""),
                "resume_from_step": state["current_run"].get("resume_from_step", ""),
            },
        )

    run_id = args.run_id
    state["status"] = STATUS_RUNNING
    state["review_status"] = "pending"
    state["current_run"] = {
        "run_id": run_id,
        "target_date": args.target_date or "",
        "trigger": args.trigger or "manual",
        "started_at": now_iso(),
        "heartbeat_at": now_iso(),
        "ended_at": "",
        "exit_code": None,
        "log_file": args.log_file,
        "resume_from_step": STEP_ORDER[0][0],
        "steps": make_steps(),
        "failure": {"step": "", "reason": "", "last_log_excerpt": ""},
        "review": {"reviewed_by": "", "reviewed_at": "", "result": "pending", "note": ""},
    }
    append_history(
        state,
        "start",
        {
            "run_id": run_id,
            "log_file": args.log_file,
            "target_date": args.target_date or "",
            "trigger": args.trigger or "manual",
        },
    )
    save_state(state)
    print(json.dumps({"ok": True, "status": state["status"], "run_id": run_id, "state": str(state_path(args.automation_id))}, ensure_ascii=False, indent=2))
    return 0


def command_step_start(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    current = state["current_run"]
    step = current["steps"][args.step]
    state["status"] = STATUS_RUNNING
    current["heartbeat_at"] = now_iso()
    current["resume_from_step"] = args.step
    step["status"] = STATUS_RUNNING
    step["started_at"] = now_iso()
    step["ended_at"] = ""
    step["exit_code"] = None
    step["note"] = args.note or ""
    append_history(state, "step_start", {"run_id": args.run_id, "step": args.step, "script": step["script"]})
    save_state(state)
    print(json.dumps({"ok": True, "step": args.step, "status": step["status"]}, ensure_ascii=False, indent=2))
    return 0


def command_step_complete(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    current = state["current_run"]
    step = current["steps"][args.step]
    current["heartbeat_at"] = now_iso()
    step["status"] = STATUS_COMPLETED
    step["ended_at"] = now_iso()
    step["exit_code"] = 0
    step["note"] = args.note or ""
    current["resume_from_step"] = compute_resume_from_step(current["steps"])
    append_history(state, "step_complete", {"run_id": args.run_id, "step": args.step})
    save_state(state)
    print(json.dumps({"ok": True, "step": args.step, "status": step["status"]}, ensure_ascii=False, indent=2))
    return 0


def command_step_fail(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    current = state["current_run"]
    step = current["steps"][args.step]
    state["status"] = STATUS_FAILED
    state["review_status"] = "needs_attention"
    current["heartbeat_at"] = now_iso()
    current["exit_code"] = args.exit_code
    current["resume_from_step"] = args.step
    current["failure"] = {
        "step": args.step,
        "reason": args.note or "step_failed",
        "last_log_excerpt": summarize_log(current.get("log_file", "")),
    }
    step["status"] = STATUS_FAILED
    step["ended_at"] = now_iso()
    step["exit_code"] = args.exit_code
    step["note"] = args.note or ""
    append_history(
        state,
        "step_fail",
        {"run_id": args.run_id, "step": args.step, "exit_code": args.exit_code, "note": args.note or ""},
    )
    save_state(state)
    print(json.dumps({"ok": True, "step": args.step, "status": step["status"]}, ensure_ascii=False, indent=2))
    return 0


def command_heartbeat(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    state["current_run"]["heartbeat_at"] = now_iso()
    append_history(state, "heartbeat", {"run_id": args.run_id})
    save_state(state)
    print(json.dumps({"ok": True, "heartbeat_at": state["current_run"]["heartbeat_at"]}, ensure_ascii=False, indent=2))
    return 0


def command_complete(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    current = state["current_run"]
    current["heartbeat_at"] = now_iso()
    current["ended_at"] = now_iso()
    current["exit_code"] = 0
    current["resume_from_step"] = ""
    current["review"] = {
        "reviewed_by": args.reviewed_by or "manager-reviewer-shared",
        "reviewed_at": now_iso(),
        "result": "passed",
        "note": args.note or "",
    }
    state["status"] = STATUS_COMPLETED
    state["review_status"] = "passed"
    append_history(
        state,
        "complete",
        {"run_id": args.run_id, "reviewed_by": current["review"]["reviewed_by"], "review_status": "passed"},
    )
    save_state(state)
    print(json.dumps({"ok": True, "status": state["status"]}, ensure_ascii=False, indent=2))
    return 0


def command_fail(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    current = state["current_run"]
    state["status"] = STATUS_FAILED
    state["review_status"] = "needs_attention"
    current["heartbeat_at"] = now_iso()
    current["ended_at"] = now_iso()
    current["exit_code"] = args.exit_code
    current["failure"] = {
        "step": current.get("resume_from_step", ""),
        "reason": args.note or "run_failed",
        "last_log_excerpt": summarize_log(args.log_file or current.get("log_file", "")),
    }
    current["review"] = {
        "reviewed_by": "",
        "reviewed_at": "",
        "result": "needs_attention",
        "note": args.note or "",
    }
    append_history(
        state,
        "fail",
        {"run_id": args.run_id, "exit_code": args.exit_code, "note": args.note or "", "review_status": "needs_attention"},
    )
    save_state(state)
    print(json.dumps({"ok": True, "status": state["status"]}, ensure_ascii=False, indent=2))
    return 0


def command_status(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    if stale_run(state, args.stale_minutes):
        state["status"] = STATUS_STALE
        state["current_run"]["review"]["result"] = "needs_attention"
    save_state(state)
    print(json.dumps(state, ensure_ascii=False, indent=2))
    return 0


def command_resume_context(args: argparse.Namespace) -> int:
    state = load_state(args.automation_id)
    if stale_run(state, args.stale_minutes):
        state["status"] = STATUS_STALE
        state["review_status"] = "needs_attention"

    current = state.get("current_run", {})
    resume_from_step = current.get("resume_from_step", compute_resume_from_step(current.get("steps", {})))
    summary = {
        "automation_id": args.automation_id,
        "objective": state.get("objective", DEFAULT_OBJECTIVE),
        "status": state.get("status", STATUS_PENDING),
        "review_status": state.get("review_status", "pending"),
        "run_id": current.get("run_id", ""),
        "target_date": current.get("target_date", ""),
        "log_file": current.get("log_file", ""),
        "resume_from_step": resume_from_step,
        "resume_command": f"python run_all.py" if resume_from_step else "",
        "completed_steps": [
            key for key, _script in STEP_ORDER if current.get("steps", {}).get(key, {}).get("status") == STATUS_COMPLETED
        ],
        "failure": current.get("failure", {}),
    }
    save_state(state)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Persistent manager/reviewer goal state for run_all automation")
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start")
    start.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    start.add_argument("--run-id", required=True)
    start.add_argument("--objective", default=DEFAULT_OBJECTIVE)
    start.add_argument("--log-file", required=True)
    start.add_argument("--target-date", default="")
    start.add_argument("--trigger", default="manual")
    start.add_argument("--note", default="")
    start.add_argument("--stale-minutes", type=int, default=DEFAULT_STALE_MINUTES)
    start.set_defaults(func=command_start)

    step_start = sub.add_parser("step-start")
    step_start.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    step_start.add_argument("--run-id", required=True)
    step_start.add_argument("--step", choices=[key for key, _script in STEP_ORDER], required=True)
    step_start.add_argument("--note", default="")
    step_start.set_defaults(func=command_step_start)

    step_complete = sub.add_parser("step-complete")
    step_complete.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    step_complete.add_argument("--run-id", required=True)
    step_complete.add_argument("--step", choices=[key for key, _script in STEP_ORDER], required=True)
    step_complete.add_argument("--note", default="")
    step_complete.set_defaults(func=command_step_complete)

    step_fail = sub.add_parser("step-fail")
    step_fail.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    step_fail.add_argument("--run-id", required=True)
    step_fail.add_argument("--step", choices=[key for key, _script in STEP_ORDER], required=True)
    step_fail.add_argument("--exit-code", type=int, required=True)
    step_fail.add_argument("--note", default="")
    step_fail.set_defaults(func=command_step_fail)

    heartbeat = sub.add_parser("heartbeat")
    heartbeat.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    heartbeat.add_argument("--run-id", required=True)
    heartbeat.set_defaults(func=command_heartbeat)

    complete = sub.add_parser("complete")
    complete.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    complete.add_argument("--run-id", required=True)
    complete.add_argument("--note", default="")
    complete.add_argument("--reviewed-by", default="manager-reviewer-shared")
    complete.set_defaults(func=command_complete)

    fail = sub.add_parser("fail")
    fail.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    fail.add_argument("--run-id", required=True)
    fail.add_argument("--log-file", default="")
    fail.add_argument("--exit-code", type=int, required=True)
    fail.add_argument("--note", default="")
    fail.set_defaults(func=command_fail)

    status = sub.add_parser("status")
    status.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    status.add_argument("--stale-minutes", type=int, default=DEFAULT_STALE_MINUTES)
    status.set_defaults(func=command_status)

    resume = sub.add_parser("resume-context")
    resume.add_argument("--automation-id", default=DEFAULT_AUTOMATION)
    resume.add_argument("--stale-minutes", type=int, default=DEFAULT_STALE_MINUTES)
    resume.set_defaults(func=command_resume_context)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
