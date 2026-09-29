"""G-出荷用シートの指定行に、ダウンロードした GoQ CSV（処理済）の注文を1件だけ書き込む（動作確認用）

  python scripts/write_test_row.py --row 138683 [--index 0]
  python scripts/write_test_row.py --row 138633 --all [--allow-overwrite 138683]   # 処理済の全件を書き込む

- 本番と同じ build_sheet_row（B〜S列、年・月は数値、O〜S列は関数）で書き込む
- 書き込む行が空でなければ上書きせずに止める
- 重複チェックはしない（テスト用）。書き込んだ行は消さずに残す
"""
import argparse
import glob
import os
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import GshippingDataDownload as g  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--row", type=int, required=True, help="書き込む行番号")
    parser.add_argument("--index", type=int, default=0, help="CSV の何件目の注文を使うか（0始まり）")
    parser.add_argument("--all", action="store_true", help="CSV の処理済の全件を --row から書き込む")
    parser.add_argument("--allow-overwrite", type=int, nargs="*", default=[], help="空でなくても上書きしてよい行")
    args = parser.parse_args()

    csv_files = sorted(glob.glob(os.path.join(g.DOWNLOAD_DIR, "*.csv")), key=os.path.getmtime)
    if not csv_files:
        print("NG: GoQ の CSV がありません")
        sys.exit(1)
    df = pd.read_csv(csv_files[-1], encoding="cp932").fillna("")
    df = df[df["受注ステータス"].astype(str).str.strip() == "処理済"].copy()
    # 本番と同じく出荷日の古い順に並べる
    df["_sort_date"] = pd.to_datetime(df["出荷日"], errors="coerce")
    df = df.sort_values(by="_sort_date", ascending=True)
    targets = df if args.all else df.iloc[[args.index]]
    first_row, last_row = args.row, args.row + len(targets) - 1
    print(f"書き込む注文: {len(targets)} 行 → {first_row}〜{last_row} 行目（重複チェックなし）")

    api = g.build_sheets_api()
    sheet_id, sheet = g.SHEET_ID, g.SHEET_NAME
    last = g.find_last_data_row(api)
    print(f"現在の最終行（F列=受注番号 基準）: {last}")

    g.ensure_sheet_has_rows(api, last_row)
    area = g.execute_with_retry(api.values().get(
        spreadsheetId=sheet_id, range=f"'{sheet}'!B{first_row}:S{last_row}"), "Read target area").get("values", [])
    non_empty = [first_row + i for i, r in enumerate(area) if any(str(v).strip() for v in r)]
    blocked = [r for r in non_empty if r not in args.allow_overwrite]
    if blocked:
        print(f"NG: 書き込む範囲に空でない行があるため止めます: {blocked[:10]}")
        sys.exit(1)
    if non_empty:
        print(f"上書きを許可された行: {non_empty}")
    if first_row > last + 1:
        print(f"注意: 最終行 {last} と {first_row} 行目の間に {first_row - last - 1} 行の空きがあります")

    values = []
    for i, (_, row) in enumerate(targets.iterrows()):
        ship_date = row["_sort_date"] if pd.notna(row["_sort_date"]) else None
        values.append(g.build_sheet_row(first_row + i, ship_date, str(row["受注番号"]).strip(),
                                        str(row["販売店舗"]).strip(), row))
    g.execute_with_retry(api.values().update(
        spreadsheetId=sheet_id, range=f"'{sheet}'!B{first_row}", valueInputOption="USER_ENTERED",
        body={"values": values}), "Write test rows")

    shown = g.execute_with_retry(api.values().get(
        spreadsheetId=sheet_id, range=f"'{sheet}'!B{first_row}:S{last_row}", valueRenderOption="FORMATTED_VALUE"
    ), "Read back").get("values", [])
    cd = g.execute_with_retry(api.values().get(
        spreadsheetId=sheet_id, range=f"'{sheet}'!C{first_row}:D{last_row}", valueRenderOption="UNFORMATTED_VALUE"
    ), "Read back C:D").get("values", [])
    written = sum(1 for r in shown if len(r) > 4 and str(r[4]).strip())
    numeric = sum(1 for r in cd if len(r) == 2 and all(isinstance(v, int) for v in r))
    print(f"OK: {first_row}〜{last_row} 行目に書き込みました（受注番号が入った行 {written}/{len(values)}、"
          f"年・月が数値の行 {numeric}/{len(values)}）")
    for label, r_idx in (("先頭", 0), ("末尾", len(shown) - 1)):
        r = shown[r_idx] + [""] * (18 - len(shown[r_idx]))
        print(f"    {label}（{first_row + r_idx} 行目）: " + " | ".join(str(v)[:30] for v in r))


if __name__ == "__main__":
    main()
