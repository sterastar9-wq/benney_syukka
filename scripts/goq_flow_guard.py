"""Checkpoint and review gate for GoQ print operations.

This tool is intentionally local and conservative. It does not perform GoQ
browser actions. It decides whether a proposed action is allowed, records the
action state, and blocks duplicates by comparing session checkpoints with the
legacy print guard.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = ROOT / ".goq_flow_sessions"
LEGACY_PRINT_GUARD = ROOT / ".goq_print_guard.json"

STATUS_NOT_STARTED = "not_started"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_BLOCKED = "blocked"
STATUS_SKIPPED = "skipped"

PHASE_ORDER = {
    "sort": 10,
    "picking_upload": 20,
    "picking_print": 30,
    "label_request": 40,
    "ehiden_csv_export": 40,
    # ベニー様版ヤマト系: GoQ から B2クラウド用CSVを出力 → ヤマトビジネスメンバーズに取込 → 印刷 → 送り状番号を GoQ へ戻す
    "b2_csv_export": 40,
    "ehiden_import": 50,
    "b2_import": 50,
    "label_download": 50,
    "label_print": 60,
    "manifest_print": 70,
    "ship_history_export": 80,
    "b2_tracking_export": 80,
    "goq_tracking_import": 90,
    "tracking_verify": 100,
    "post_label_verify": 110,
}

YAMATO_B2_PHASES = {
    "sort",
    "picking_upload",
    "picking_print",
    "b2_csv_export",
    "b2_import",
    "label_print",
    "b2_tracking_export",
    "goq_tracking_import",
    "tracking_verify",
    "post_label_verify",
}

CARRIER_ALLOWED_PHASES = {
    "sagawa": {
        "sort",
        "picking_upload",
        "picking_print",
        "ehiden_csv_export",
        "ehiden_import",
        "label_print",
        "goq_tracking_import",
        "tracking_verify",
        "post_label_verify",
    },
    "sagawa120": {
        "sort",
        "picking_upload",
        "picking_print",
        "ehiden_csv_export",
        "ehiden_import",
        "label_print",
        "manifest_print",
        "ship_history_export",
        "goq_tracking_import",
        "tracking_verify",
        "post_label_verify",
    },
    # ベニー様版: ヤマト系は GoQ の発行ボタン（label_request / label_download）を使わず B2クラウドCSV経路のみ
    "yamato": set(YAMATO_B2_PHASES),
    "compact": set(YAMATO_B2_PHASES),
    "nekopos": set(YAMATO_B2_PHASES),
}

YAMATO_B2_PREREQUISITES = {
    "b2_csv_export": ["picking_print"],
    "b2_import": ["b2_csv_export"],
    "label_print": ["b2_import"],
    "b2_tracking_export": ["label_print"],
    "goq_tracking_import": ["b2_tracking_export"],
    "tracking_verify": ["goq_tracking_import"],
    "post_label_verify": ["tracking_verify"],
}

PHASE_PREREQUISITES = {
    **{(carrier, phase): list(required) for carrier in ("yamato", "compact", "nekopos") for phase, required in YAMATO_B2_PREREQUISITES.items()},
    ("sagawa", "ehiden_csv_export"): ["picking_print"],
    ("sagawa", "ehiden_import"): ["ehiden_csv_export"],
    ("sagawa", "label_print"): ["ehiden_import"],
    ("sagawa", "goq_tracking_import"): ["label_print"],
    ("sagawa", "tracking_verify"): ["goq_tracking_import"],
    ("sagawa", "post_label_verify"): ["tracking_verify"],
    ("sagawa120", "ehiden_csv_export"): ["picking_print"],
    ("sagawa120", "ehiden_import"): ["ehiden_csv_export"],
    ("sagawa120", "label_print"): ["ehiden_import"],
    ("sagawa120", "manifest_print"): ["label_print"],
    ("sagawa120", "ship_history_export"): ["manifest_print"],
    ("sagawa120", "goq_tracking_import"): ["ship_history_export"],
    ("sagawa120", "tracking_verify"): ["goq_tracking_import"],
    ("sagawa120", "post_label_verify"): ["tracking_verify"],
}

# このPCのプリンタ名（FUJIFILM Apeos C5240普通紙 / ヤマト / 佐川 / ネコポス（手差し））に「含まれる」文字列。
# 変える場合は .env の PRINTER_* と tools/lib/printers.mjs と合わせる。
PRINTERS = {
    "picking": os.getenv("PRINTER_PICKING", "普通紙"),
    "sagawa": os.getenv("PRINTER_SAGAWA", "佐川"),
    "sagawa120": os.getenv("PRINTER_SAGAWA", "佐川"),
    "yamato": os.getenv("PRINTER_YAMATO", "ヤマト"),
    "compact": os.getenv("PRINTER_YAMATO", "ヤマト"),
    "nekopos": os.getenv("PRINTER_NEKOPOSU", "ネコポス"),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def today_session() -> str:
    return datetime.now().strftime("%Y%m%d")


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


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def csv_data_rows(path: Path) -> int:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.reader(fh))
    if not rows:
        return 0
    return max(0, len(rows) - 1)


def state_path(session: str) -> Path:
    safe = "".join(ch for ch in session if ch.isalnum() or ch in ("-", "_"))
    if not safe:
        raise SystemExit("session must contain a safe name")
    return STATE_DIR / f"{safe}.json"


def load_state(session: str) -> dict[str, Any]:
    path = state_path(session)
    if path.exists():
        return read_json(path, {})
    return {
        "schema": 1,
        "session": session,
        "created_at": now_iso(),
        "objective": "",
        "policy": {
            "blocked_carriers": [],
            "completed_carriers": [],
            "allow_legacy_bulk_label_download": False,
        },
        "checkpoints": {},
        "actions": [],
        "reviewer": {"required": True, "mode": "manager-executor-reviewer"},
    }


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = now_iso()
    write_json(state_path(state["session"]), state)


def checkpoint_key(carrier: str, phase: str) -> str:
    return f"{carrier}:{phase}"


def action_key(carrier: str, phase: str, target_count: int | None, target_hash: str = "") -> str:
    count = "unknown" if target_count is None else str(target_count)
    suffix = f":{target_hash[:12]}" if target_hash else ""
    return f"{carrier}:{phase}:{count}{suffix}"


def legacy_guard_keys() -> set[str]:
    data = read_json(LEGACY_PRINT_GUARD, {})
    if not isinstance(data, dict):
        return set()
    return set(data.keys())


def get_print_queue_snapshot() -> list[dict[str, str]]:
    cmd = [
        "powershell",
        "-NoProfile",
        "-Command",
        "Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue | "
        "Select-Object @{n='Printer';e={$_.PrinterName}},ID,JobStatus,DocumentName,SubmittedTime } | ConvertTo-Json -Depth 3",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10, cwd=ROOT)
    except Exception as exc:
        return [{"error": f"print_queue_unavailable: {exc}"}]
    if result.returncode != 0 or not result.stdout.strip():
        return []
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError:
        return [{"error": "print_queue_json_parse_failed", "stdout": result.stdout[-500:]}]
    if isinstance(parsed, dict):
        return [parsed]
    if isinstance(parsed, list):
        return parsed
    return []


def get_chrome_tabs_snapshot(port: int) -> list[dict[str, Any]]:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/json/list", timeout=5) as response:
            tabs = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return [{"error": f"chrome_tabs_unavailable: {exc}"}]
    result = []
    for tab in tabs:
        if tab.get("type") != "page":
            continue
        result.append({
            "id": tab.get("id", ""),
            "title": tab.get("title", ""),
            "url": tab.get("url", ""),
        })
    return result


@dataclass
class Proposal:
    session: str
    carrier: str
    phase: str
    target_count: int | None
    printer: str
    job_key: str
    evidence_file: Path | None
    csv_file: Path | None
    target_hash: str
    note: str
    allow_reprint: bool
    require_picking_before_label: bool
    print_queue_checked: bool
    allow_sagawa120_goq_api: bool

    @property
    def action_key(self) -> str:
        return action_key(self.carrier, self.phase, self.target_count, self.target_hash)


def build_proposal(args: argparse.Namespace) -> Proposal:
    csv_file = Path(args.csv).resolve() if args.csv else None
    evidence_file = Path(args.evidence).resolve() if args.evidence else None
    target_hash = args.target_hash or ""
    target_count = args.count

    if csv_file:
        if not csv_file.exists():
            raise SystemExit(f"CSV not found: {csv_file}")
        target_hash = target_hash or sha256_file(csv_file)
        if target_count is None:
            target_count = csv_data_rows(csv_file)

    if evidence_file and not evidence_file.exists():
        raise SystemExit(f"evidence file not found: {evidence_file}")

    printer = args.printer or (
        PRINTERS["picking"] if args.phase.startswith("picking") else PRINTERS.get(args.carrier, "")
    )

    return Proposal(
        session=args.session,
        carrier=args.carrier,
        phase=args.phase,
        target_count=target_count,
        printer=printer,
        job_key=args.job_key or "",
        evidence_file=evidence_file,
        csv_file=csv_file,
        target_hash=target_hash,
        note=args.note or "",
        allow_reprint=args.allow_reprint,
        require_picking_before_label=not args.no_require_picking_before_label,
        print_queue_checked=args.with_print_queue,
        allow_sagawa120_goq_api=args.allow_sagawa120_goq_api,
    )


def review_proposal(state: dict[str, Any], proposal: Proposal) -> tuple[str, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    policy = state.get("policy", {})
    checkpoints = state.get("checkpoints", {})
    legacy_keys = legacy_guard_keys()

    if proposal.carrier in set(policy.get("blocked_carriers", [])):
        errors.append(f"carrier_is_blocked_by_policy:{proposal.carrier}")

    if proposal.carrier in set(policy.get("completed_carriers", [])) and not proposal.allow_reprint:
        errors.append(f"carrier_already_marked_completed:{proposal.carrier}")

    if proposal.phase not in PHASE_ORDER:
        errors.append(f"unknown_phase:{proposal.phase}")

    allowed_phases = CARRIER_ALLOWED_PHASES.get(proposal.carrier, set())
    if proposal.phase not in allowed_phases:
        errors.append(f"phase_not_allowed_for_carrier:{proposal.carrier}:{proposal.phase}")

    if proposal.carrier == "sagawa120" and proposal.phase == "label_request" and not proposal.allow_sagawa120_goq_api:
        errors.append("sagawa120_goq_api_label_request_blocked_use_ehiden_flow")

    if proposal.target_count is None:
        errors.append("target_count_required")
    elif proposal.target_count <= 0:
        errors.append("target_count_must_be_positive")

    if proposal.phase in {"picking_print", "label_print"} and not proposal.printer:
        errors.append("printer_required_for_print")

    if proposal.phase in {"picking_print", "label_request", "label_download", "label_print", "post_label_verify", "b2_csv_export", "b2_import", "goq_tracking_import"}:
        if not proposal.evidence_file:
            errors.append("live_state_evidence_file_required")

    if proposal.phase.endswith("_print") and not proposal.print_queue_checked:
        errors.append("print_queue_snapshot_required")

    if proposal.phase == "label_print" and proposal.require_picking_before_label:
        picking = checkpoints.get(checkpoint_key(proposal.carrier, "picking_print"), {})
        if picking.get("status") != STATUS_COMPLETED:
            errors.append("picking_print_must_be_completed_before_label_print")

    for required_phase in PHASE_PREREQUISITES.get((proposal.carrier, proposal.phase), []):
        required = checkpoints.get(checkpoint_key(proposal.carrier, required_phase), {})
        if required.get("status") != STATUS_COMPLETED:
            errors.append(f"required_checkpoint_missing:{proposal.carrier}:{required_phase}")

    if proposal.carrier in {"yamato", "compact", "nekopos"} and proposal.phase in {"label_download", "label_print", "post_label_verify"}:
        req = checkpoints.get(checkpoint_key(proposal.carrier, "label_request"), {})
        if req.get("status") != STATUS_COMPLETED:
            errors.append("label_request_must_be_completed_first")

    phase_prefix = f"{proposal.carrier}:{proposal.phase}:"
    for key, cp in checkpoints.items():
        if key == checkpoint_key(proposal.carrier, proposal.phase) and cp.get("status") == STATUS_COMPLETED and not proposal.allow_reprint:
            errors.append(f"checkpoint_already_completed:{key}")
        if cp.get("action_key", "").startswith(phase_prefix) and cp.get("status") == STATUS_COMPLETED and not proposal.allow_reprint:
            errors.append(f"same_phase_already_completed:{cp.get('action_key')}")

    if proposal.job_key and proposal.job_key in legacy_keys and not proposal.allow_reprint:
        errors.append(f"legacy_print_guard_has_job_key:{proposal.job_key}")

    if proposal.phase.endswith("_print") and not proposal.job_key:
        warnings.append("print_action_without_job_key_cannot_use_legacy_print_guard")

    if proposal.csv_file and proposal.target_count is not None:
        csv_count = csv_data_rows(proposal.csv_file)
        if csv_count != proposal.target_count:
            errors.append(f"csv_count_mismatch:{csv_count}!={proposal.target_count}")

    expected_printer = PRINTERS["picking"] if proposal.phase == "picking_print" else PRINTERS.get(proposal.carrier)
    if proposal.phase.endswith("_print") and expected_printer and proposal.printer != expected_printer:
        errors.append(f"printer_mismatch:expected={expected_printer}:actual={proposal.printer}")

    status = "approved" if not errors else "blocked"
    return status, errors, warnings


def command_init(args: argparse.Namespace) -> int:
    state = load_state(args.session)
    if args.objective:
        state["objective"] = args.objective
    if args.block_carrier:
        blocked = set(state.setdefault("policy", {}).get("blocked_carriers", []))
        blocked.update(args.block_carrier)
        state["policy"]["blocked_carriers"] = sorted(blocked)
    if args.completed_carrier:
        completed = set(state.setdefault("policy", {}).get("completed_carriers", []))
        completed.update(args.completed_carrier)
        state["policy"]["completed_carriers"] = sorted(completed)
    save_state(state)
    print(json.dumps({"ok": True, "state": str(state_path(args.session)), "session": args.session}, ensure_ascii=False, indent=2))
    return 0


def command_review(args: argparse.Namespace) -> int:
    state = load_state(args.session)
    proposal = build_proposal(args)
    status, errors, warnings = review_proposal(state, proposal)
    review = {
        "ok": status == "approved",
        "status": status,
        "reviewed_at": now_iso(),
        "session": args.session,
        "proposal": proposal.__dict__ | {
            "evidence_file": str(proposal.evidence_file) if proposal.evidence_file else "",
            "csv_file": str(proposal.csv_file) if proposal.csv_file else "",
        },
        "errors": errors,
        "warnings": warnings,
    }
    if args.with_print_queue:
        review["print_queue"] = get_print_queue_snapshot()
    state.setdefault("actions", []).append({"type": "review", **review})
    save_state(state)
    print(json.dumps(review, ensure_ascii=False, indent=2, default=str))
    return 0 if status == "approved" else 2


def command_start(args: argparse.Namespace) -> int:
    state = load_state(args.session)
    proposal = build_proposal(args)
    status, errors, warnings = review_proposal(state, proposal)
    if status != "approved":
        print(json.dumps({"ok": False, "status": "blocked", "errors": errors, "warnings": warnings}, ensure_ascii=False, indent=2))
        return 2
    cp_key = checkpoint_key(proposal.carrier, proposal.phase)
    state.setdefault("checkpoints", {})[cp_key] = {
        "status": STATUS_RUNNING,
        "started_at": now_iso(),
        "carrier": proposal.carrier,
        "phase": proposal.phase,
        "target_count": proposal.target_count,
        "target_hash": proposal.target_hash,
        "printer": proposal.printer,
        "job_key": proposal.job_key,
        "csv_file": str(proposal.csv_file) if proposal.csv_file else "",
        "evidence_file": str(proposal.evidence_file) if proposal.evidence_file else "",
        "action_key": proposal.action_key,
        "note": proposal.note,
        "review": {"status": status, "warnings": warnings},
    }
    state.setdefault("actions", []).append({"type": "start", "checkpoint": cp_key, "at": now_iso(), "action_key": proposal.action_key})
    save_state(state)
    print(json.dumps({"ok": True, "checkpoint": cp_key, "status": STATUS_RUNNING}, ensure_ascii=False, indent=2))
    return 0


def command_complete(args: argparse.Namespace) -> int:
    state = load_state(args.session)
    cp_key = checkpoint_key(args.carrier, args.phase)
    cp = state.setdefault("checkpoints", {}).get(cp_key)
    if not cp:
        print(json.dumps({"ok": False, "error": f"checkpoint_not_started:{cp_key}"}, ensure_ascii=False, indent=2))
        return 2
    if cp.get("status") == STATUS_COMPLETED and not args.allow_rewrite:
        print(json.dumps({"ok": False, "error": f"checkpoint_already_completed:{cp_key}"}, ensure_ascii=False, indent=2))
        return 2
    if args.evidence:
        evidence = Path(args.evidence).resolve()
        if not evidence.exists():
            print(json.dumps({"ok": False, "error": f"evidence_not_found:{evidence}"}, ensure_ascii=False, indent=2))
            return 2
        cp["completion_evidence_file"] = str(evidence)
    cp["status"] = STATUS_COMPLETED
    cp["completed_at"] = now_iso()
    cp["completion_note"] = args.note or ""
    state.setdefault("actions", []).append({"type": "complete", "checkpoint": cp_key, "at": now_iso(), "note": args.note or ""})
    save_state(state)
    print(json.dumps({"ok": True, "checkpoint": cp_key, "status": STATUS_COMPLETED}, ensure_ascii=False, indent=2))
    return 0


def command_block(args: argparse.Namespace) -> int:
    state = load_state(args.session)
    cp_key = checkpoint_key(args.carrier, args.phase)
    cp = state.setdefault("checkpoints", {}).setdefault(cp_key, {"carrier": args.carrier, "phase": args.phase})
    cp["status"] = STATUS_BLOCKED
    cp["blocked_at"] = now_iso()
    cp["block_reason"] = args.reason
    state.setdefault("actions", []).append({"type": "block", "checkpoint": cp_key, "at": now_iso(), "reason": args.reason})
    save_state(state)
    print(json.dumps({"ok": True, "checkpoint": cp_key, "status": STATUS_BLOCKED}, ensure_ascii=False, indent=2))
    return 0


def command_status(args: argparse.Namespace) -> int:
    state = load_state(args.session)
    checkpoints = state.get("checkpoints", {})
    summary = {
        "session": args.session,
        "objective": state.get("objective", ""),
        "policy": state.get("policy", {}),
        "checkpoints": checkpoints,
        "legacy_print_guard_hits": sorted(k for k in legacy_guard_keys() if args.session in k or any(token in k for token in ("yamato", "compact", "nekopos", "sagawa"))),
    }
    if args.with_print_queue:
        summary["print_queue"] = get_print_queue_snapshot()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def command_capture(args: argparse.Namespace) -> int:
    state = load_state(args.session)
    evidence_dir = STATE_DIR / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    name = args.name or f"{args.session}-{datetime.now().strftime('%H%M%S')}"
    safe = "".join(ch for ch in name if ch.isalnum() or ch in ("-", "_"))
    path = evidence_dir / f"{safe}.json"
    evidence = {
        "captured_at": now_iso(),
        "session": args.session,
        "note": args.note or "",
        "objective": state.get("objective", ""),
        "policy": state.get("policy", {}),
        "checkpoints": state.get("checkpoints", {}),
        "chrome_port": args.port,
        "chrome_tabs": get_chrome_tabs_snapshot(args.port),
        "legacy_print_guard_keys": sorted(legacy_guard_keys()),
        "print_queue": get_print_queue_snapshot(),
    }
    write_json(path, evidence)
    print(json.dumps({"ok": True, "evidence": str(path)}, ensure_ascii=False, indent=2))
    return 0


def command_bootstrap_from_guard(args: argparse.Namespace) -> int:
    state = load_state(args.session)
    mapping = {
        "yamato-picking": ("yamato", "picking_print", 123, "普通紙"),
        "yamato-label": ("yamato", "label_print", 123, "ヤマト/コンパクト"),
        "compact-picking": ("compact", "picking_print", 50, "普通紙"),
        "compact-label": ("compact", "label_print", 50, "ヤマト/コンパクト"),
        "nekopos-picking": ("nekopos", "picking_print", 158, "普通紙"),
        "nekopos-label": ("nekopos", "label_print", 158, "ネコポス"),
    }
    guard = read_json(LEGACY_PRINT_GUARD, {})
    added = []
    for key in guard:
        for token, (carrier, phase, count, printer) in mapping.items():
            if token in key:
                cp_key = checkpoint_key(carrier, phase)
                state.setdefault("checkpoints", {})[cp_key] = {
                    "status": STATUS_COMPLETED,
                    "carrier": carrier,
                    "phase": phase,
                    "target_count": count,
                    "printer": printer,
                    "job_key": key,
                    "action_key": action_key(carrier, phase, count),
                    "completed_at": guard[key].get("reservedAt", now_iso()) if isinstance(guard.get(key), dict) else now_iso(),
                    "source": ".goq_print_guard.json",
                }
                added.append(cp_key)
    save_state(state)
    print(json.dumps({"ok": True, "added": sorted(set(added)), "state": str(state_path(args.session))}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="GoQ flow checkpoint and review gate")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    init.add_argument("--session", default=today_session())
    init.add_argument("--objective", default="")
    init.add_argument("--block-carrier", action="append", default=[])
    init.add_argument("--completed-carrier", action="append", default=[])
    init.set_defaults(func=command_init)

    for name, func in (("review", command_review), ("start", command_start)):
        p = sub.add_parser(name)
        p.add_argument("--session", default=today_session())
        p.add_argument("--carrier", required=True, choices=["sagawa", "sagawa120", "yamato", "compact", "nekopos"])
        p.add_argument("--phase", required=True, choices=sorted(PHASE_ORDER))
        p.add_argument("--count", type=int)
        p.add_argument("--printer", default="")
        p.add_argument("--job-key", default="")
        p.add_argument("--csv", default="")
        p.add_argument("--target-hash", default="")
        p.add_argument("--evidence", default="")
        p.add_argument("--note", default="")
        p.add_argument("--allow-reprint", action="store_true")
        p.add_argument("--allow-sagawa120-goq-api", action="store_true")
        p.add_argument("--no-require-picking-before-label", action="store_true")
        p.add_argument("--with-print-queue", action="store_true")
        p.set_defaults(func=func)

    complete = sub.add_parser("complete")
    complete.add_argument("--session", default=today_session())
    complete.add_argument("--carrier", required=True)
    complete.add_argument("--phase", required=True)
    complete.add_argument("--evidence", default="")
    complete.add_argument("--note", default="")
    complete.add_argument("--allow-rewrite", action="store_true")
    complete.set_defaults(func=command_complete)

    block = sub.add_parser("block")
    block.add_argument("--session", default=today_session())
    block.add_argument("--carrier", required=True)
    block.add_argument("--phase", required=True)
    block.add_argument("--reason", required=True)
    block.set_defaults(func=command_block)

    status = sub.add_parser("status")
    status.add_argument("--session", default=today_session())
    status.add_argument("--with-print-queue", action="store_true")
    status.set_defaults(func=command_status)

    capture = sub.add_parser("capture")
    capture.add_argument("--session", default=today_session())
    capture.add_argument("--name", default="")
    capture.add_argument("--note", default="")
    capture.add_argument("--port", type=int, default=9222)
    capture.set_defaults(func=command_capture)

    bootstrap = sub.add_parser("bootstrap-from-guard")
    bootstrap.add_argument("--session", default=today_session())
    bootstrap.set_defaults(func=command_bootstrap_from_guard)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
