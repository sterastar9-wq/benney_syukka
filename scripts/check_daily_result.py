"""日次販売データ更新の結果チェック（毎朝 GitHub Actions で実行）

確認すること:
  1. 今日の「日次販売データ更新」ワークフローが成功したか（GitHub API）
  2. G-出荷用の E2（最終実行日）が今日の日付か
  3. 前日出荷分の行数、年・月が数値か、O〜S 列に関数が入っているか

問題があれば終了コード 1（GitHub から失敗通知メールが届く）。結果は GITHUB_STEP_SUMMARY に表で出す。
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import GshippingDataDownload as g  # noqa: E402

DAILY_WORKFLOW = "daily-sales.yml"
TAIL_ROWS = 3000  # 前日分は必ず末尾付近にある


def check_workflow_run(today):
    repo, token = os.getenv("GITHUB_REPOSITORY"), os.getenv("GITHUB_TOKEN")
    if not repo or not token:
        return None, "GitHub の情報がないため確認できません"
    url = f"https://api.github.com/repos/{repo}/actions/workflows/{DAILY_WORKFLOW}/runs?per_page=20"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        runs = json.load(res).get("workflow_runs", [])
    # 今日（日本時間）に開始された本番の実行（定時 or 手動）
    todays = []
    for run in runs:
        started = pd.Timestamp(run["run_started_at"]).tz_convert("Asia/Tokyo")
        # 確認モード（dry-run）は除き、本番（[full]）の実行だけを見る
        if started.date() == today and "[full]" in run.get("display_title", ""):
            todays.append((started, run))
    if not todays:
        return False, "今日の本番（full）の実行が見つかりません（定時実行が動いていない可能性）"
    started, run = max(todays, key=lambda x: x[0])
    ok = run["status"] == "completed" and run["conclusion"] == "success"
    return ok, f"{started:%H:%M} 開始 / {run['event']} / {run['status']} / {run['conclusion']} / {run['html_url']}"


def main():
    now = datetime.now()
    today, yesterday = now.date(), (now - timedelta(days=1)).date()
    results = []  # (項目, OK/NG/注意, 詳細)

    ok, detail = check_workflow_run(today)
    results.append(("日次販売データ更新の実行", "OK" if ok else ("注意" if ok is None else "NG"), detail))

    api = g.build_sheets_api()
    sheet_id, sheet = g.SHEET_ID, g.SHEET_NAME
    e2 = g.execute_with_retry(api.values().get(
        spreadsheetId=sheet_id, range=f"'{sheet}'!E2"), "Read E2").get("values", [[""]])[0][0]
    e2_date = pd.to_datetime(e2, errors="coerce")
    e2_ok = pd.notna(e2_date) and e2_date.date() == today
    results.append(("G-出荷用 E2（最終実行日）", "OK" if e2_ok else "NG", f"{e2}（今日: {today:%Y/%m/%d}）"))

    last = g.find_last_data_row(api)
    start = max(g.SHEET_DATA_START_ROW, last - TAIL_ROWS)
    def read(rng, render):
        return g.execute_with_retry(api.values().get(
            spreadsheetId=sheet_id, range=f"'{sheet}'!{rng}", valueRenderOption=render), f"Read {rng}").get("values", [])

    dates = read(f"E{start}:E{last}", "FORMATTED_VALUE")      # 出荷日（表示どおり）
    year_month = read(f"C{start}:D{last}", "UNFORMATTED_VALUE")  # 年・月（数値かどうか）
    formulas = read(f"O{start}:S{last}", "FORMULA")            # O〜S 列の関数

    y_rows, numeric, with_formulas = 0, 0, 0
    for i, d_row in enumerate(dates):
        d = pd.to_datetime(d_row[0] if d_row else "", errors="coerce")
        if pd.isna(d) or d.date() != yesterday:
            continue
        y_rows += 1
        cd = year_month[i] if i < len(year_month) else []
        if len(cd) >= 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in cd[:2]):
            numeric += 1
        f_row = formulas[i] if i < len(formulas) else []
        if len(f_row) >= 5 and all(str(v).startswith("=") for v in f_row[:5]):
            with_formulas += 1

    results.append(("前日出荷分の行数", "OK" if y_rows else "注意",
                    f"{yesterday:%Y/%m/%d} 出荷: {y_rows} 行（最終行 {last}）" + ("" if y_rows else " ※出荷のない日なら問題なし")))
    if y_rows:
        results.append(("年・月が数値", "OK" if numeric == y_rows else "NG", f"{numeric}/{y_rows} 行"))
        results.append(("O〜S 列の関数", "OK" if with_formulas == y_rows else "NG", f"{with_formulas}/{y_rows} 行"))

    lines = ["## 日次販売データ更新 チェック結果", "", "| 項目 | 判定 | 詳細 |", "| --- | --- | --- |"]
    lines += [f"| {a} | {b} | {c} |" for a, b, c in results]
    text = "\n".join(lines)
    print(text)
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")

    if any(b == "NG" for _, b, _ in results):
        print("\nNG の項目があります")
        sys.exit(1)


if __name__ == "__main__":
    main()
