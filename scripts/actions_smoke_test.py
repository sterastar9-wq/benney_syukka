"""GitHub Actions 移行前の動作確認（本番シートは変更しない）

  python scripts/actions_smoke_test.py pricetar  # プライスターにログインし前日分CSVを取得（件数・列名のみ表示）
  python scripts/actions_smoke_test.py sheets    # 各ブックへのアクセス・必要シートの有無・一時シートへのダミー書き込み
  python scripts/actions_smoke_test.py compare   # GoQ CSV と G-出荷用シートの既存行を 受注番号+販売店舗 で突合
  python scripts/actions_smoke_test.py gshipping-row  # G-出荷用の最終行の次にダミー行（全列）を書き込み、読み戻して消す

顧客情報はログに出さない（件数・列名・シート名のみ）。
"""
import argparse
import glob
import os
import sys
from datetime import datetime, timedelta

import pandas as pd
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env"))

DOWNLOAD_DIR = os.path.join(ROOT, os.getenv("DOWNLOAD_DIR", "販売データダウンロード"))
LOG_DIR = os.path.join(ROOT, "logs")
CREDENTIALS_FILE = os.path.join(ROOT, os.getenv("CREDENTIALS_FILE", "credentials.json"))
SHEETS_TIMEOUT_SECONDS = 300
TEST_SHEET_PREFIX = "_actions_smoke_"
COMPARE_TAIL_ROWS = 8000

# ブックごとに必要なシートと、ダミー書き込みを試すかどうか（integrated_sales_automation.py の使い方に合わせる）
BOOKS = [
    # G-出荷用は重く一時シートの追加が失敗しやすいため、gshipping-row で実データと同じ形のダミー行を試す
    ("G-出荷用", "GSHEET_ID", lambda: [os.getenv("GSHEET_NAME", "")], False),
    ("販売DB", "SOURCE_BOOK_ID", lambda: ["販売データ", "商品台帳", "除外リスト"], True),
    ("GoQ全データ", "GOQ_BOOK_ID", lambda: ["GoQ全データ"], False),
    ("不買商品", "FUKA_BOOK_ID", lambda: ["不買商品"], True),
]


def target_date():
    value = os.getenv("GOQ_TARGET_DATE", "").strip()
    if value:
        return datetime.strptime(value, "%Y-%m-%d")
    return datetime.now() - timedelta(days=1)


def require_env(*names):
    missing = [n for n in names if not os.getenv(n, "").strip()]
    if missing:
        print(f"NG: 環境変数が未設定です: {', '.join(missing)}")
        sys.exit(1)


def read_csv_any(path, required_column=None):
    for enc in ("cp932", "utf-8-sig"):
        for sep in (",", "\t"):
            try:
                df = pd.read_csv(path, encoding=enc, sep=sep, dtype=str)
            except Exception:
                continue
            if required_column is None or required_column in df.columns:
                return df, enc
    raise ValueError(f"CSVを読み込めませんでした: {path}")


# ---------------------------------------------------------------- pricetar
def test_pricetar():
    require_env("PRICETAR_EMAIL", "PRICETAR_PASSWORD")
    from playwright.sync_api import sync_playwright

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    date_str = target_date().strftime("%Y/%m/%d")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=os.getenv("GOQ_HEADLESS", "1") == "1")
        context = browser.new_context(locale="ja-JP", timezone_id="Asia/Tokyo", accept_downloads=True)
        page = context.new_page()
        try:
            page.goto("https://jp2.pricetar.com/entry/login?", timeout=60000)
            page.get_by_role("textbox", name="メールアドレス").fill(os.environ["PRICETAR_EMAIL"])
            page.get_by_role("textbox", name="パスワード").fill(os.environ["PRICETAR_PASSWORD"])
            page.get_by_role("button", name="ログイン").click()
            page.wait_for_load_state("load")

            page.goto("https://jp2.pricetar.com/seller/orders/orderlist", timeout=60000)
            date_input = page.locator("#jquery-ui-datepicker-from")
            try:
                date_input.wait_for(state="visible", timeout=30000)
            except Exception as e:
                raise RuntimeError(f"プライスターの注文一覧を開けませんでした（ログイン失敗の可能性） URL: {page.url}") from e
            print("OK: プライスター ログイン成功")

            date_input.click()
            date_input.press("Control+a")
            date_input.fill(date_str)
            date_input.press("Tab")
            page.get_by_role("button", name="Left Align").click()
            page.get_by_text("発送済商品").click()
            page.get_by_text("FBAのみ").click()
            page.get_by_role("button", name="検索").click()
            page.wait_for_timeout(3000)

            with page.expect_download() as download_info:
                page.get_by_role("link", name="売れたものリストのダウンロード").click()
            download = download_info.value
            save_path = os.path.join(DOWNLOAD_DIR, "pricetar_" + download.suggested_filename)
            download.save_as(save_path)
        except Exception:
            shot = os.path.join(LOG_DIR, f"pricetar_failure_{datetime.now():%Y%m%d_%H%M%S}.png")
            try:
                page.screenshot(path=shot, full_page=True)
                print(f"失敗時の画面を保存しました: {shot}")
            except Exception:
                pass
            raise
        finally:
            context.close()
            browser.close()

    df, enc = read_csv_any(save_path)
    print(f"OK: プライスター CSV取得 {len(df)} 件 / {len(df.columns)} 列 (対象日 {date_str} 以降, encoding={enc})")
    print(f"    列名: {', '.join(map(str, df.columns))}")


# ---------------------------------------------------------------- sheets
def sheets_service():
    if not os.path.exists(CREDENTIALS_FILE):
        print(f"NG: credentials.json がありません: {CREDENTIALS_FILE}")
        sys.exit(1)
    import httplib2
    from google.oauth2 import service_account
    from google_auth_httplib2 import AuthorizedHttp
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        CREDENTIALS_FILE, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    print(f"    サービスアカウント: {creds.service_account_email}")
    # G-出荷用のブックは関数が多く応答が遅いため、標準の60秒ではなく長めに待つ
    http = AuthorizedHttp(creds, http=httplib2.Http(timeout=SHEETS_TIMEOUT_SECONDS))
    return build("sheets", "v4", http=http, cache_discovery=False).spreadsheets()


def remove_leftover_test_sheets(api, book_id, label):
    """以前のテストで削除しきれなかった一時シートを消す"""
    meta = api.get(spreadsheetId=book_id, fields="sheets(properties(sheetId,title))").execute()
    for sheet in meta.get("sheets", []):
        props = sheet["properties"]
        if props["title"].startswith(TEST_SHEET_PREFIX):
            api.batchUpdate(
                spreadsheetId=book_id, body={"requests": [{"deleteSheet": {"sheetId": props["sheetId"]}}]}
            ).execute(num_retries=2)
            print(f"    [{label}] 前回のテストで残っていた一時シート {props['title']} を削除しました")


def dummy_write(api, book_id):
    title = f"{TEST_SHEET_PREFIX}{os.getenv('GITHUB_RUN_ID', datetime.now().strftime('%H%M%S'))}"
    stamp = datetime.now().strftime("%Y/%m/%d %H:%M:%S")
    added = api.batchUpdate(
        spreadsheetId=book_id, body={"requests": [{"addSheet": {"properties": {"title": title}}}]}
    ).execute()
    sheet_id = added["replies"][0]["addSheet"]["properties"]["sheetId"]
    try:
        values = [["GitHub Actions 動作確認（自動削除）", stamp]]
        api.values().update(
            spreadsheetId=book_id, range=f"'{title}'!A1", valueInputOption="RAW", body={"values": values}
        ).execute()
        back = api.values().get(spreadsheetId=book_id, range=f"'{title}'!A1:B1").execute().get("values", [])
        if back != values:
            raise RuntimeError(f"書き込んだ値を読み戻せませんでした: {back}")
    finally:
        api.batchUpdate(
            spreadsheetId=book_id, body={"requests": [{"deleteSheet": {"sheetId": sheet_id}}]}
        ).execute()


def test_sheets():
    api = sheets_service()
    failures = 0
    for label, env_name, required_fn, try_write in BOOKS:
        book_id = os.getenv(env_name, "").strip()
        if not book_id:
            print(f"NG: [{label}] {env_name} が未設定です")
            failures += 1
            continue
        try:
            meta = api.get(spreadsheetId=book_id, fields="properties(title),sheets(properties(title))").execute()
        except Exception as e:
            print(f"NG: [{label}] 開けません（サービスアカウントに共有されていない可能性）: {e}")
            failures += 1
            continue
        titles = [s["properties"]["title"] for s in meta.get("sheets", [])]
        if try_write and any(t.startswith(TEST_SHEET_PREFIX) for t in titles):
            remove_leftover_test_sheets(api, book_id, label)
        missing = [t for t in required_fn() if t and t not in titles]
        print(f"OK: [{label}] 「{meta['properties']['title']}」を開けました（シート {len(titles)} 枚）")
        if missing:
            print(f"NG: [{label}] 必要なシートが見つかりません: {', '.join(missing)}")
            failures += 1
        if try_write:
            try:
                dummy_write(api, book_id)
                print(f"OK: [{label}] 一時シートへのダミー書き込み・読み戻し・削除に成功")
            except Exception as e:
                print(f"NG: [{label}] ダミー書き込みに失敗（閲覧権限のみの可能性）: {e}")
                failures += 1
        else:
            print(f"    [{label}] の書き込みテストは省略（G-出荷用は gshipping-row で確認）")
    if failures:
        sys.exit(1)


# ---------------------------------------------------------------- compare
def test_compare():
    require_env("GSHEET_ID", "GSHEET_NAME")
    csv_files = sorted(
        (f for f in glob.glob(os.path.join(DOWNLOAD_DIR, "*.csv")) if not os.path.basename(f).startswith("pricetar_")),
        key=os.path.getmtime,
    )
    if not csv_files:
        print("NG: GoQ CSV が見つかりません（先に GshippingDataDownload.py を download-only で実行）")
        sys.exit(1)
    df, _ = read_csv_any(csv_files[-1], required_column="受注番号")
    csv_keys = {
        f"{str(o).strip()}_{str(s).strip()}"
        for o, s in zip(df["受注番号"].fillna(""), df["販売店舗"].fillna(""))
        if str(o).strip()
    }
    dates = pd.to_datetime(df["出荷日"], errors="coerce").dropna().dt.normalize().unique()
    if len(dates) != 1:
        print(f"NG: CSVの出荷日が1日分ではありません: {[str(d.date()) for d in dates]}")
        sys.exit(1)
    day = pd.Timestamp(dates[0])

    api = sheets_service()
    sheet = os.environ["GSHEET_NAME"]
    meta = api.get(
        spreadsheetId=os.environ["GSHEET_ID"], fields="sheets(properties(title,gridProperties(rowCount)))"
    ).execute()
    row_count = next(
        s["properties"]["gridProperties"]["rowCount"] for s in meta["sheets"] if s["properties"]["title"] == sheet
    )
    # 全行は重いので末尾だけ読む（前日分は必ず末尾付近にある）
    start_row = max(4, row_count - COMPARE_TAIL_ROWS)
    rows = api.values().get(
        spreadsheetId=os.environ["GSHEET_ID"],
        range=f"'{sheet}'!E{start_row}:K{row_count}",
        valueRenderOption="FORMATTED_VALUE",
    ).execute(num_retries=2).get("values", [])
    sheet_keys = set()
    for r in rows:
        if len(r) < 2 or not str(r[1]).strip():
            continue
        d = pd.to_datetime(r[0], errors="coerce")
        if pd.isna(d) or d.normalize() != day:
            continue
        shop = str(r[6]).strip() if len(r) > 6 else ""
        sheet_keys.add(f"{str(r[1]).strip()}_{shop}")

    both = csv_keys & sheet_keys
    if "受注ステータス" in df.columns:
        extra = df[df["受注ステータス"] != "処理済"]
        extra_keys = {f"{str(o).strip()}_{str(s).strip()}" for o, s in zip(extra["受注番号"], extra["販売店舗"])}
        if extra_keys:
            print(f"    「処理済」以外のステータスの注文: {len(extra_keys)} 件（うちシートに既存: {len(extra_keys & sheet_keys)} 件）")
    print(f"    対象日: {day:%Y-%m-%d}")
    print(f"    GoQ CSV: {len(df)} 行 / 注文 {len(csv_keys)} 件")
    print(f"    シート既存（同日）: 注文 {len(sheet_keys)} 件")
    print(f"    一致: {len(both)} 件 / CSVのみ: {len(csv_keys - sheet_keys)} 件 / シートのみ: {len(sheet_keys - csv_keys)} 件")
    if csv_keys and csv_keys == sheet_keys:
        print("OK: GitHub Actions で取得したデータは、現行システムが書き込んだ内容と一致しました")
    else:
        print("NG: 差分があります（現行システムの実行後にステータスが変わった注文の可能性も含む）")
        sys.exit(1)


# ---------------------------------------------------------------- gshipping-row
DUMMY_ORDER_PREFIX = "ACTIONS-TEST-"


def test_gshipping_row():
    require_env("GSHEET_ID", "GSHEET_NAME")
    sys.path.insert(0, ROOT)
    import GshippingDataDownload as g  # 本番と同じ行の組み立て・書き込み処理を使う

    api = g.build_sheets_api()
    sheet_id, sheet = os.environ["GSHEET_ID"], os.environ["GSHEET_NAME"]

    def clear_row(row_no):
        g.execute_with_retry(
            api.values().clear(spreadsheetId=sheet_id, range=f"'{sheet}'!B{row_no}:S{row_no}"), f"Clear row {row_no}"
        )

    # 前回消しきれなかったダミー行を消す
    last = g.find_last_data_row(api)
    tail_start = max(g.SHEET_DATA_START_ROW, last - 500)
    tail = g.execute_with_retry(
        api.values().get(spreadsheetId=sheet_id, range=f"'{sheet}'!F{tail_start}:F{last}"), "Read tail"
    ).get("values", [])
    for offset, r in enumerate(tail):
        if r and str(r[0]).startswith(DUMMY_ORDER_PREFIX):
            clear_row(tail_start + offset)
            print(f"    前回のテストで残っていたダミー行（{tail_start + offset} 行目）を消しました")
    last = g.find_last_data_row(api)

    # シートの最終行（手作業でコピペされた関数）と、プログラムが作る O〜S 列の関数を比べる
    existing = g.execute_with_retry(api.values().get(
        spreadsheetId=sheet_id, range=f"'{sheet}'!O{last}:S{last}", valueRenderOption="FORMULA"
    ), "Read last row formulas").get("values", [[]])
    existing = (existing[0] if existing else []) + [""] * 5
    generated = g.build_sheet_row(last, None, "", "", {k: "" for k in
                                  ("商品名", "商品コード", "商品SKU", "SKU管理番号", "合計金額", "JANコード", "個数")})[13:18]
    mismatch = 0
    for col, have, want in zip("OPQRS", existing[:5], generated):
        if str(have).strip() == want:
            print(f"    {col}列: シートとプログラムの関数が一致")
        else:
            mismatch += 1
            print(f"    {col}列: 不一致")
            print(f"      シート（{last} 行目）: {have}")
            print(f"      プログラム          : {want}")
    print(("OK" if not mismatch else "NG") + f": O〜S 列の関数の比較（不一致 {mismatch} 列）")

    row_no = last + 1
    order_id = f"{DUMMY_ORDER_PREFIX}{os.getenv('GITHUB_RUN_ID', datetime.now().strftime('%H%M%S'))}"
    dummy = {"商品名": "GitHub Actions 動作確認（自動削除）", "商品コード": "", "商品SKU": "",
             "SKU管理番号": "", "合計金額": 0, "JANコード": "", "個数": 0}
    values = g.build_sheet_row(row_no, pd.Timestamp(datetime.now().date()), order_id, "動作確認", dummy)
    print(f"    最終行: {last} / ダミー行を {row_no} 行目に書き込みます（B〜S 列）")
    try:
        g.ensure_sheet_has_rows(api, row_no)
        g.execute_with_retry(api.values().update(
            spreadsheetId=sheet_id, range=f"'{sheet}'!B{row_no}", valueInputOption="USER_ENTERED",
            body={"values": [values]},
        ), "Write dummy row")
        formulas = g.execute_with_retry(api.values().get(
            spreadsheetId=sheet_id, range=f"'{sheet}'!B{row_no}:S{row_no}", valueRenderOption="FORMULA"
        ), "Read back formulas").get("values", [[]])[0]
        shown = g.execute_with_retry(api.values().get(
            spreadsheetId=sheet_id, range=f"'{sheet}'!B{row_no}:S{row_no}", valueRenderOption="FORMATTED_VALUE"
        ), "Read back values").get("values", [[]])[0]
        if len(formulas) < 18 or formulas[4] != order_id:
            raise RuntimeError(f"書き込んだ行を読み戻せませんでした（{len(formulas)} 列）")
        if not all(str(f).startswith("=") for f in formulas[13:18]):
            raise RuntimeError("O〜S 列に関数が入っていません")
        if formulas[1] != values[1] or formulas[2] != values[2]:
            raise RuntimeError(f"年・月が数値で入っていません: C={formulas[1]!r} D={formulas[2]!r}")
        print(f"OK: 全 18 列を書き込み・読み戻しできました（年={formulas[1]}, 月={formulas[2]} は数値）")
        print(f"    O〜S 列の関数の計算結果: {shown[13:18] if len(shown) >= 18 else shown[13:]}")
    finally:
        clear_row(row_no)
        print(f"    ダミー行（{row_no} 行目）を消しました")


def main():
    parser = argparse.ArgumentParser()
    checks = {"pricetar": test_pricetar, "sheets": test_sheets, "compare": test_compare,
              "gshipping-row": test_gshipping_row}
    parser.add_argument("check", choices=list(checks))
    args = parser.parse_args()
    checks[args.check]()


if __name__ == "__main__":
    main()
