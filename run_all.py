import os
import subprocess
import sys
from datetime import datetime


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
GOAL_GUARD = os.path.join(SCRIPT_DIR, "scripts", "run_all_goal_guard.py")
AUTOMATION_ID = os.getenv("GOQ_AUTOMATION_ID", "goq-run-all-daily-agent")
RUN_ID = os.getenv("GOQ_RUN_ID", datetime.now().strftime("%Y%m%d_%H%M%S"))
RUN_TRIGGER = os.getenv("GOQ_RUN_TRIGGER", "manual")
RUN_LOG_FILE = os.getenv("GOQ_RUN_LOG_FILE", "")
TARGET_DATE = os.getenv("GOQ_TARGET_DATE", "")

STEPS = [
    ("gshipping_download", "GshippingDataDownload.py"),
    ("sales_download_local", "salesDataDownload_local.py"),
    ("integrated_sales_automation", "integrated_sales_automation.py"),
]


def guard(*args):
    if not os.path.exists(GOAL_GUARD):
        return
    subprocess.run(
        [
            sys.executable,
            GOAL_GUARD,
            *args,
        ],
        cwd=SCRIPT_DIR,
        check=False,
    )


def start_run():
    guard(
        "start",
        "--automation-id",
        AUTOMATION_ID,
        "--run-id",
        RUN_ID,
        "--log-file",
        RUN_LOG_FILE,
        "--target-date",
        TARGET_DATE,
        "--trigger",
        RUN_TRIGGER,
    )


def complete_run():
    guard(
        "complete",
        "--automation-id",
        AUTOMATION_ID,
        "--run-id",
        RUN_ID,
        "--reviewed-by",
        "manager-reviewer-shared",
    )


def fail_run(exit_code, note):
    guard(
        "fail",
        "--automation-id",
        AUTOMATION_ID,
        "--run-id",
        RUN_ID,
        "--log-file",
        RUN_LOG_FILE,
        "--exit-code",
        str(exit_code),
        "--note",
        note,
    )


def run_script(step_name, script_name):
    script_path = os.path.join(SCRIPT_DIR, script_name)
    print(f"\n{'='*50}")
    print(f"実行開始: {script_name}")
    print(f"{'='*50}")
    guard(
        "step-start",
        "--automation-id",
        AUTOMATION_ID,
        "--run-id",
        RUN_ID,
        "--step",
        step_name,
    )
    result = subprocess.run(
        [sys.executable, script_path],
        cwd=SCRIPT_DIR,
    )
    if result.returncode != 0:
        guard(
            "step-fail",
            "--automation-id",
            AUTOMATION_ID,
            "--run-id",
            RUN_ID,
            "--step",
            step_name,
            "--exit-code",
            str(result.returncode),
            "--note",
            f"{script_name} failed",
        )
        print(f"\n[ERROR] {script_name} が終了コード {result.returncode} で失敗しました。処理を中断します。")
        fail_run(result.returncode, f"{script_name} failed")
        sys.exit(result.returncode)

    guard(
        "step-complete",
        "--automation-id",
        AUTOMATION_ID,
        "--run-id",
        RUN_ID,
        "--step",
        step_name,
    )
    print(f"\n[OK] {script_name} が正常に完了しました。")


if __name__ == "__main__":
    start_run()
    try:
        for step_name, script_name in STEPS:
            run_script(step_name, script_name)
        complete_run()
        print("\n全スクリプトの実行が完了しました。")
    except SystemExit:
        raise
    except Exception as exc:
        fail_run(1, f"run_all exception: {exc}")
        raise
