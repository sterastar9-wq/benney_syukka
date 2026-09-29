from datetime import datetime, timedelta, timezone
import json

import scripts.run_all_goal_guard as guard


def test_run_transitions_include_step_state(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(guard, "STATE_DIR", tmp_path)

    assert guard.main(
        [
            "start",
            "--automation-id",
            "goq-run-all-daily-agent",
            "--run-id",
            "20260615_100000",
            "--log-file",
            "logs/scheduled/run_all_20260615_100000.log",
            "--target-date",
            "2026-06-13",
            "--trigger",
            "scheduled_task",
        ]
    ) == 0

    assert guard.main(
        [
            "step-start",
            "--automation-id",
            "goq-run-all-daily-agent",
            "--run-id",
            "20260615_100000",
            "--step",
            "gshipping_download",
        ]
    ) == 0
    assert guard.main(
        [
            "step-complete",
            "--automation-id",
            "goq-run-all-daily-agent",
            "--run-id",
            "20260615_100000",
            "--step",
            "gshipping_download",
        ]
    ) == 0
    assert guard.main(
        [
            "complete",
            "--automation-id",
            "goq-run-all-daily-agent",
            "--run-id",
            "20260615_100000",
        ]
    ) == 0
    capsys.readouterr()

    state_file = tmp_path / "goq-run-all-daily-agent.json"
    state = guard.read_json(state_file, {})
    assert state["status"] == guard.STATUS_COMPLETED
    assert state["review_status"] == "passed"
    assert state["current_run"]["steps"]["gshipping_download"]["status"] == guard.STATUS_COMPLETED
    assert state["current_run"]["steps"]["gshipping_download"]["exit_code"] == 0

    assert guard.main(["resume-context", "--automation-id", "goq-run-all-daily-agent"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == guard.STATUS_COMPLETED
    assert output["completed_steps"] == ["gshipping_download"]


def test_stale_failed_run_exposes_resume_step(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(guard, "STATE_DIR", tmp_path)

    assert guard.main(
        [
            "start",
            "--automation-id",
            "goq-run-all-daily-agent",
            "--run-id",
            "20260615_110000",
            "--log-file",
            str(tmp_path / "run_all.log"),
        ]
    ) == 0
    assert guard.main(
        [
            "step-start",
            "--automation-id",
            "goq-run-all-daily-agent",
            "--run-id",
            "20260615_110000",
            "--step",
            "sales_download_local",
        ]
    ) == 0
    capsys.readouterr()

    state_file = tmp_path / "goq-run-all-daily-agent.json"
    state = guard.read_json(state_file, {})
    stale_time = datetime.now(timezone.utc).astimezone() - timedelta(minutes=20)
    state["current_run"]["heartbeat_at"] = stale_time.isoformat(timespec="seconds")
    guard.write_json(state_file, state)

    assert guard.main(
        [
            "status",
            "--automation-id",
            "goq-run-all-daily-agent",
            "--stale-minutes",
            "15",
        ]
    ) == 0
    status_output = json.loads(capsys.readouterr().out)
    assert status_output["status"] == guard.STATUS_STALE

    assert guard.main(
        [
            "step-fail",
            "--automation-id",
            "goq-run-all-daily-agent",
            "--run-id",
            "20260615_110000",
            "--step",
            "sales_download_local",
            "--exit-code",
            "1",
            "--note",
            "download_failed",
        ]
    ) == 0
    capsys.readouterr()
    assert guard.main(
        [
            "resume-context",
            "--automation-id",
            "goq-run-all-daily-agent",
        ]
    ) == 0
    resume_output = json.loads(capsys.readouterr().out)
    assert resume_output["review_status"] == "needs_attention"
    assert resume_output["resume_from_step"] == "sales_download_local"
    assert resume_output["failure"]["step"] == "sales_download_local"
