"""他社の注文（GoQ の受注ステータス「他社処理済み」）を、自社の販売リストから取り除く

前提: GshippingDataDownload.py を GOQ_ORDER_STATUS=他社処理済み で実行し、対象期間の CSV を
      DOWNLOAD_DIR に保存しておく（ダウンロードのみ・シートには書かない）。

  python scripts/remove_other_company_rows.py                 # 確認のみ（該当行を表示）
  python scripts/remove_other_company_rows.py --apply \\
      --expect-gshipping 1 --expect-db 1                        # 件数が一致したときだけ削除

対象シート:
  - G-出荷用（GSHEET_ID / GSHEET_NAME）: 受注番号(F列)+販売店舗(K列) が一致する行を削除
  - 販売DB の「販売データ」（SOURCE_BOOK_ID）: 受注番号+販売店舗 が一致する行を削除
"""
import argparse
import glob
import os
import sys
import time

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import GshippingDataDownload as g  # noqa: E402  (シート接続・リトライ処理を共用)

DB_SALES_SHEET = "販売データ"


def mask(order_id):
    """ログ用に受注番号の末尾4桁だけ残す"""
    text = str(order_id)
    return ("*" * max(0, len(text) - 4)) + text[-4:]


def load_other_company_keys():
    csv_files = sorted(glob.glob(os.path.join(g.DOWNLOAD_DIR, "*.csv")), key=os.path.getmtime)
    if not csv_files:
        print("NG: 他社処理済みの CSV が見つかりません（先に GOQ_ORDER_STATUS=他社処理済み でダウンロード）")
        sys.exit(1)
    path = csv_files[-1]
    df = None
    for enc in ("cp932", "utf-8-sig"):
        try:
            df = pd.read_csv(path, encoding=enc, dtype=str).fillna("")
            break
        except Exception:
            continue
    if df is None or "受注番号" not in df.columns:
        print(f"NG: CSV を読み込めませんでした: {path}")
        sys.exit(1)
    statuses = set(df["受注ステータス"].str.strip()) if "受注ステータス" in df.columns else set()
    if statuses - {"他社処理済み"}:
        print(f"NG: CSV に「他社処理済み」以外のステータスが含まれています: {sorted(statuses)}")
        sys.exit(1)
    keys = {f"{o.strip()}_{s.strip()}" for o, s in zip(df["受注番号"], df["販売店舗"]) if o.strip()}
    dates = pd.to_datetime(df["出荷日"], errors="coerce").dropna()
    period = f"{dates.min():%Y-%m-%d}〜{dates.max():%Y-%m-%d}" if not dates.empty else "(出荷日なし)"
    print(f"他社処理済みの注文: {len(keys)} 件（CSV {len(df)} 行, 出荷日 {period}）")
    return keys


def find_gshipping_rows(api, keys):
    last = g.find_last_data_row(api)
    result = g.execute_with_retry(api.values().batchGet(
        spreadsheetId=g.SHEET_ID,
        ranges=[f"'{g.SHEET_NAME}'!E{g.SHEET_DATA_START_ROW}:F{last}", f"'{g.SHEET_NAME}'!K{g.SHEET_DATA_START_ROW}:K{last}"],
        majorDimension="ROWS",
    ), "Read G-shipping keys").get("valueRanges", [])
    ef = result[0].get("values", []) if result else []
    k = result[1].get("values", []) if len(result) > 1 else []
    rows = []
    for i in range(len(ef)):
        date = ef[i][0] if len(ef[i]) > 0 else ""
        order = str(ef[i][1]).strip() if len(ef[i]) > 1 else ""
        shop = str(k[i][0]).strip() if i < len(k) and k[i] else ""
        if order and f"{order}_{shop}" in keys:
            rows.append((g.SHEET_DATA_START_ROW + i, date, order, shop))
    return rows


def find_db_rows(api, keys):
    book_id = os.environ["SOURCE_BOOK_ID"]
    values = g.execute_with_retry(api.values().get(
        spreadsheetId=book_id, range=f"'{DB_SALES_SHEET}'", valueRenderOption="FORMATTED_VALUE"
    ), "Read sales DB").get("values", [])
    if not values:
        return []
    header = values[0]
    order_idx, shop_idx = header.index("受注番号"), header.index("販売店舗")
    rows = []
    for i, r in enumerate(values[1:], start=2):
        order = str(r[order_idx]).strip() if len(r) > order_idx else ""
        shop = str(r[shop_idx]).strip() if len(r) > shop_idx else ""
        if order and f"{order}_{shop}" in keys:
            rows.append((i, r[0] if r else "", order, shop))
    return rows


def sheet_gid(api, book_id, title):
    meta = g.execute_with_retry(api.get(spreadsheetId=book_id, fields="sheets(properties(sheetId,title))"), "Get sheet id")
    return next(s["properties"]["sheetId"] for s in meta["sheets"] if s["properties"]["title"] == title)


def delete_rows(api, book_id, title, row_numbers):
    gid = sheet_gid(api, book_id, title)
    # 下の行から消すと、上の行の番号がずれない
    requests = [
        {"deleteDimension": {"range": {"sheetId": gid, "dimension": "ROWS", "startIndex": r - 1, "endIndex": r}}}
        for r in sorted(row_numbers, reverse=True)
    ]
    g.execute_with_retry(api.batchUpdate(spreadsheetId=book_id, body={"requests": requests}), f"Delete rows in {title}")


def report(label, rows):
    print(f"[{label}] 該当 {len(rows)} 行")
    for row_no, date, order, shop in rows:
        print(f"    {row_no} 行目: 日付={date} 受注番号={mask(order)} 販売店舗={shop}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="実際に削除する（指定しなければ確認のみ）")
    parser.add_argument("--expect-gshipping", type=int, help="G-出荷用で削除する想定の行数（一致しなければ削除しない）")
    parser.add_argument("--expect-db", type=int, help="販売データで削除する想定の行数（一致しなければ削除しない）")
    args = parser.parse_args()

    keys = load_other_company_keys()
    api = g.build_sheets_api()
    gs_rows = find_gshipping_rows(api, keys)
    time.sleep(1)
    db_rows = find_db_rows(api, keys)
    report("G-出荷用", gs_rows)
    report("販売データ", db_rows)

    if not args.apply:
        print("確認のみのため削除していません")
        return
    if args.expect_gshipping is None or args.expect_db is None:
        print("NG: --apply には --expect-gshipping と --expect-db の指定が必要です")
        sys.exit(1)
    if len(gs_rows) != args.expect_gshipping or len(db_rows) != args.expect_db:
        print(f"NG: 件数が想定と違うため削除しません（G-出荷用 {len(gs_rows)}/{args.expect_gshipping}, "
              f"販売データ {len(db_rows)}/{args.expect_db}）")
        sys.exit(1)

    if gs_rows:
        delete_rows(api, g.SHEET_ID, g.SHEET_NAME, [r[0] for r in gs_rows])
        print(f"OK: G-出荷用から {len(gs_rows)} 行を削除しました")
    if db_rows:
        delete_rows(api, os.environ["SOURCE_BOOK_ID"], DB_SALES_SHEET, [r[0] for r in db_rows])
        print(f"OK: 販売データから {len(db_rows)} 行を削除しました")


if __name__ == "__main__":
    main()
