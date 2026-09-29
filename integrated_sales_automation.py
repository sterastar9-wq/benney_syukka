#!/usr/bin/env python3
"""
統合販売データ自動化スクリプト
GoQ / プライスター CSVをダウンロードし、Google Sheets APIで直接書き込む

GASの処理を全てPythonに統合:
  - updateProductMasterFromGoQ()  → update_product_master()
  - updateDatabaseBook()          → update_database()
  - createAllUnsoldLists()        → create_unsold_lists()
  - createEmptyCodeLists()        → create_empty_code_lists()
  - executeSyncLogic() [unSales]  → sync_unsold_to_fuka_sheet()

事前設定:
  pip install playwright google-auth google-api-python-client
  以下3スプレッドシートにサービスアカウント(credentials.jsonのclient_email)を編集者として共有:
    SOURCE/DB : 1DCw6MssJoad2G73mLOBKsurGzrvaNFqGhYwMGXpY4kc
    GoQ       : 1V_y-3QNZ0DLLdAG9NSgdn4S-934hhRUcQgNVc7Pxc4I
    不買商品  : 15rxWntqOGVRYSyXGgn5S4OI0bzQ_g5QkgQJWP9rjPr0
"""

import re
import os
import sys
import csv
import shutil
import ssl
import time
from datetime import datetime, timedelta

from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

try:
    import certifi
    import httplib2
    from google_auth_httplib2 import AuthorizedHttp
except ImportError:
    certifi = None
    httplib2 = None
    AuthorizedHttp = None

# --- .envから設定を読み込む ---
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_SCRIPT_DIR, '.env'))

# ============================================================
# 設定値
# ============================================================
SOURCE_BOOK_ID   = os.getenv("SOURCE_BOOK_ID")
DATABASE_BOOK_ID = SOURCE_BOOK_ID
GOQ_BOOK_ID      = os.getenv("GOQ_BOOK_ID")
FUKA_BOOK_ID     = os.getenv("FUKA_BOOK_ID")

DB_SALES_SHEET     = "販売データ"
DB_MASTER_SHEET    = "商品台帳"
DB_EXCLUSION_SHEET = "除外リスト"
GOQ_SHEET_NAME     = "GoQ全データ"
UNSOLD_SHEET_1W    = "未販売リスト-1週間-"
UNSOLD_SHEET_1M    = "未販売リスト-1ヶ月-"
UNSOLD_SHEET_2M    = "未販売リスト-2ヶ月-"
EMPTY_JAN_SHEET    = "JANが空欄リスト"
EMPTY_SKU_SHEET    = "商品SKU未登録リスト"
FUKA_SHEET_NAME    = "不買商品"

DOWNLOAD_DIR      = os.getenv("DOWNLOAD_DIR", "販売データダウンロード")
CREDENTIALS_FILE  = os.path.join(_SCRIPT_DIR, os.getenv("CREDENTIALS_FILE", "credentials.json"))
SCOPES            = ["https://www.googleapis.com/auth/spreadsheets"]
CA_BUNDLE_FILE    = os.path.join(_SCRIPT_DIR, "logs", "windows-plus-certifi-ca.pem")
API_RETRY_COUNT   = 3
API_RETRY_DELAY   = 5
SHEETS_HTTP_TIMEOUT_SECONDS = 300
RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}
# INTEGRATED_DRY_RUN=1: シートを変更せず、書き込む予定の内容（件数）だけ表示する
DRY_RUN = os.getenv("INTEGRATED_DRY_RUN", "").strip() == "1"


# ============================================================
# Google Sheets API ヘルパー
# ============================================================

def get_ca_bundle_path():
    if not certifi:
        return None

    if os.path.exists(CA_BUNDLE_FILE):
        return CA_BUNDLE_FILE

    bundle_parts = []
    with open(certifi.where(), "r", encoding="utf-8") as f:
        bundle_parts.append(f.read().strip())

    for store_name in (("ROOT", "CA") if sys.platform == "win32" else ()):
        try:
            for cert_bytes, encoding_type, _ in ssl.enum_certificates(store_name):
                if encoding_type == "x509_asn":
                    bundle_parts.append(ssl.DER_cert_to_PEM_cert(cert_bytes).strip())
        except Exception:
            pass

    os.makedirs(os.path.dirname(CA_BUNDLE_FILE), exist_ok=True)
    with open(CA_BUNDLE_FILE, "w", encoding="ascii", newline="\n") as f:
        f.write("\n".join(part for part in bundle_parts if part))
        f.write("\n")

    return CA_BUNDLE_FILE

def get_sheets_service():
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    if certifi and httplib2 and AuthorizedHttp:
        http = AuthorizedHttp(
            creds, http=httplib2.Http(ca_certs=get_ca_bundle_path(), timeout=SHEETS_HTTP_TIMEOUT_SECONDS)
        )
        return build("sheets", "v4", http=http)
    return build("sheets", "v4", credentials=creds)


def execute_with_retry(request, label, retries=API_RETRY_COUNT, delay_seconds=API_RETRY_DELAY):
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            return request.execute()
        except (TimeoutError, OSError, ssl.SSLError, HttpError) as exc:
            if isinstance(exc, HttpError) and exc.resp.status not in RETRYABLE_HTTP_STATUS:
                raise
            last_error = exc
            if attempt >= retries:
                break
            # 429（回数上限）は1分単位で回復するため長めに待つ
            wait = 65 if isinstance(exc, HttpError) and exc.resp.status == 429 else delay_seconds * attempt
            print(
                f"[WARN] {label} failed on attempt {attempt}/{retries}: {exc}. "
                f"Retrying in {wait}s..."
            )
            time.sleep(wait)

    raise last_error


def sheet_read(service, spreadsheet_id, sheet_name):
    """シート全体を2次元リスト（文字列）で返す"""
    result = execute_with_retry(
        service.spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=f"'{sheet_name}'",
            valueRenderOption="FORMATTED_VALUE",
        ),
        f"sheet_read({sheet_name})",
    )
    return result.get("values", [])


def sheet_clear_write(service, spreadsheet_id, sheet_name, values):
    """シートの内容を values で置き換える。
    先に上書きしてから余った下の行を消すので、途中で失敗してもシートが空になることはない"""
    if DRY_RUN:
        print(f"  [DRY-RUN] 「{sheet_name}」に {len(values)} 行（ヘッダー含む）を書き込む予定（実際には書き込みません）")
        return
    api = service.spreadsheets().values()
    if not values:
        execute_with_retry(
            api.clear(spreadsheetId=spreadsheet_id, range=f"'{sheet_name}'"),
            f"sheet_clear({sheet_name})",
        )
        return
    # 行ごとの列数をそろえる（短い行の右側に古い値が残らないよう空文字で上書きする）
    width = max(len(r) for r in values)
    padded = [list(r) + [""] * (width - len(r)) for r in values]
    execute_with_retry(
        api.update(
            spreadsheetId=spreadsheet_id,
            range=f"'{sheet_name}'!A1",
            valueInputOption="USER_ENTERED",
            body={"values": padded},
        ),
        f"sheet_update({sheet_name})",
    )
    execute_with_retry(
        api.clear(spreadsheetId=spreadsheet_id, range=f"'{sheet_name}'!A{len(padded) + 1}:ZZZ"),
        f"sheet_clear_below({sheet_name})",
    )


def get_sheet_id(service, spreadsheet_id, sheet_name):
    """シート名からシートIDを取得。存在しない場合は None"""
    meta = execute_with_retry(
        service.spreadsheets().get(spreadsheetId=spreadsheet_id),
        f"get_sheet_id({sheet_name})",
    )
    for s in meta["sheets"]:
        if s["properties"]["title"] == sheet_name:
            return s["properties"]["sheetId"]
    return None


def ensure_sheet_exists(service, spreadsheet_id, sheet_name):
    """シートが存在しなければ作成し、sheetIdを返す"""
    sid = get_sheet_id(service, spreadsheet_id, sheet_name)
    if sid is not None:
        return sid
    if DRY_RUN:
        print(f"  [DRY-RUN] シート「{sheet_name}」を新規作成する予定（実際には作成しません）")
        return None
    resp = execute_with_retry(
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": [{"addSheet": {"properties": {"title": sheet_name}}}]},
        ),
        f"ensure_sheet_exists({sheet_name})",
    )
    return resp["replies"][0]["addSheet"]["properties"]["sheetId"]


def set_text_format_column(service, spreadsheet_id, sheet_id, col_index, start_row_0, num_rows):
    """指定列をテキスト書式に設定（JAN列など）。start_row_0 は 0-based"""
    if DRY_RUN or sheet_id is None:
        return
    execute_with_retry(
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "requests": [
                    {
                        "repeatCell": {
                            "range": {
                                "sheetId": sheet_id,
                                "startRowIndex": start_row_0,
                                "endRowIndex": start_row_0 + num_rows,
                                "startColumnIndex": col_index,
                                "endColumnIndex": col_index + 1,
                            },
                            "cell": {
                                "userEnteredFormat": {
                                    "numberFormat": {"type": "TEXT"}
                                }
                            },
                            "fields": "userEnteredFormat.numberFormat",
                        }
                    }
                ]
            },
        ),
        f"set_text_format_column(sheet_id={sheet_id}, col={col_index})",
    )


def set_row_backgrounds(service, spreadsheet_id, sheet_id, start_row_0, row_colors):
    """行ごとの背景色を設定。row_colors は '#rrggbb' または None のリスト。start_row_0 は 0-based"""
    if DRY_RUN or sheet_id is None:
        return
    requests = []
    for i, color_hex in enumerate(row_colors):
        if not color_hex:
            continue
        r, g, b = _hex_to_rgb(color_hex)
        requests.append(
            {
                "repeatCell": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": start_row_0 + i,
                        "endRowIndex": start_row_0 + i + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "backgroundColor": {"red": r, "green": g, "blue": b}
                        }
                    },
                    "fields": "userEnteredFormat.backgroundColor",
                }
            }
        )
    if requests:
        execute_with_retry(
            service.spreadsheets().batchUpdate(
                spreadsheetId=spreadsheet_id, body={"requests": requests}
            ),
            f"set_row_backgrounds(sheet_id={sheet_id}, rows={len(requests)})",
        )


def _hex_to_rgb(hex_color):
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


def _pad_row(row, length):
    """行を指定長に空文字でパディング"""
    return list(row) + [""] * max(0, length - len(row))


# ============================================================
# CSV パース
# ============================================================

def parse_csv_file(file_path: str) -> list:
    """Shift-JIS CSVをパースして2次元リストを返す"""
    with open(file_path, encoding="shift_jis", errors="replace", newline="") as f:
        return list(csv.reader(f))


def parse_pricetar_data(csv_data: list, source_header: list, target_header: list) -> list:
    """プライスターCSVをターゲット形式に変換（FBAのみ）"""
    def col(name):
        try:
            return source_header.index(name)
        except ValueError:
            return -1

    idx_route    = col("配送経路")
    idx_date     = col("注文日")
    idx_name     = col("商品名")
    idx_order_id = col("AmazonOrderId")
    idx_sku      = col("SKU")
    idx_qty      = col("売れた個数")

    if idx_route == -1 or idx_order_id == -1:
        return []

    results = []
    for row in csv_data:
        if len(row) <= idx_route or row[idx_route] != "FBA":
            continue
        def get(i):
            return row[i] if i != -1 and i < len(row) else ""
        new_row = []
        for h in target_header:
            if   h == "注文日時":              new_row.append(get(idx_date))
            elif h == "商品名":                new_row.append(get(idx_name))
            elif h == "販売店舗":              new_row.append("Amazon")
            elif h == "受注番号":              new_row.append(get(idx_order_id))
            elif h == "商品SKU":               new_row.append(get(idx_sku))
            elif h == "個数":                  new_row.append(get(idx_qty))
            elif h == "配送方法(複数配送先)":  new_row.append("FBA")
            else:                              new_row.append("")
        results.append(new_row)
    return results


# ============================================================
# データ処理（GAS ロジックの Python 移植）
# ============================================================

def update_database(service, csv_files: list) -> list:
    """
    販売データシートを更新する（GAS: updateDatabaseBook 相当）
    戻り値: [header, ...data_rows]
    """
    print("[1/5] 販売データDB更新中...")

    existing = sheet_read(service, DATABASE_BOOK_ID, DB_SALES_SHEET)
    if not existing:
        raise ValueError(f"「{DB_SALES_SHEET}」シートにヘッダーがありません")

    target_header = existing[0]
    existing_data = existing[1:] if len(existing) > 1 else []

    try:
        store_idx = target_header.index("販売店舗")
        order_idx = target_header.index("受注番号")
    except ValueError as e:
        raise ValueError(f"販売データシートに必須列がありません: {e}")

    new_data = []
    for file_path in csv_files:
        records = parse_csv_file(file_path)
        if len(records) < 2:
            continue
        csv_header = records[0]
        csv_data   = records[1:]

        if "AmazonOrderId" in csv_header and "配送経路" in csv_header:
            # プライスター形式
            new_data.extend(parse_pricetar_data(csv_data, csv_header, target_header))
        else:
            # GoQ形式
            col_map = [
                csv_header.index(h) if h in csv_header else -1
                for h in target_header
            ]
            # GoQ出荷データは「出荷日」列を持つが「注文日時」列がない。
            # 「注文日時」が見つからない場合は「出荷日」をフォールバックとして使う。
            try:
                date_ti = target_header.index("注文日時")
                if col_map[date_ti] == -1 and "出荷日" in csv_header:
                    col_map[date_ti] = csv_header.index("出荷日")
            except ValueError:
                pass
            for row in csv_data:
                new_data.append(
                    [row[i] if i != -1 and i < len(row) else "" for i in col_map]
                )

    all_data = [r for r in existing_data + new_data if r]

    # 重複除去（販売店舗 + 受注番号 をキー、日付が入っている行を優先）
    seen: dict = {}
    for row in all_data:
        row = _pad_row(row, len(target_header))
        key = f"{row[store_idx]}|{row[order_idx]}"
        if key not in seen or (not seen[key][0] and row[0]):
            seen[key] = row
    unique = list(seen.values())

    unique.sort(key=lambda r: r[0] if r[0] else "", reverse=True)

    sheet_clear_write(service, DATABASE_BOOK_ID, DB_SALES_SHEET, [target_header] + unique)
    print(f"  → {len(unique)} 件書き込み完了")
    return [target_header] + unique


def update_product_master(service):
    """
    商品台帳をGoQシートから更新する（GAS: updateProductMasterFromGoQ 相当）
    GoQシートは3行目がヘッダー、4行目以降がデータ。
    """
    print("[2/5] 商品台帳更新中...")

    master_existing = sheet_read(service, DATABASE_BOOK_ID, DB_MASTER_SHEET)
    if not master_existing:
        raise ValueError(f"「{DB_MASTER_SHEET}」シートにヘッダーがありません")
    target_headers = [h for h in master_existing[0] if h]

    goq_all = sheet_read(service, GOQ_BOOK_ID, GOQ_SHEET_NAME)
    if len(goq_all) < 4:
        print("  GoQシートのデータ行が不足しています。スキップします。")
        return

    source_headers = goq_all[2]   # 3行目 (0-based index 2)
    source_data    = goq_all[3:]  # 4行目以降

    col_map = {}
    for h in target_headers:
        try:
            col_map[h] = source_headers.index(h)
        except ValueError:
            col_map[h] = -1

    jan_header = "JAN" if "JAN" in target_headers else "JANコード"
    jan_idx_in_target = (
        target_headers.index(jan_header) if jan_header in target_headers else -1
    )
    bad_jan = {"0", "1970/01/01", "1899/12/30"}

    processed = []
    for row in source_data:
        # 商品名・親ASIN・JANがすべて空の行をスキップ
        n_i = col_map.get("商品名", -1)
        p_i = col_map.get("親ASIN", -1)
        j_i = col_map.get("JAN", -1)
        pname = row[n_i] if n_i != -1 and n_i < len(row) else ""
        pasin = row[p_i] if p_i != -1 and p_i < len(row) else ""
        pjan  = row[j_i] if j_i != -1 and j_i < len(row) else ""
        if not pname and not pasin and not pjan:
            continue

        new_row = []
        for i, h in enumerate(target_headers):
            src_i = col_map.get(h, -1)
            val = row[src_i] if src_i != -1 and src_i < len(row) else ""
            if i == jan_idx_in_target:
                val = str(val).strip()
                if val in bad_jan:
                    val = ""
            new_row.append(val)
        processed.append(new_row)

    sheet_clear_write(service, DATABASE_BOOK_ID, DB_MASTER_SHEET, [target_headers] + processed)

    if jan_idx_in_target != -1 and processed:
        sheet_id = ensure_sheet_exists(service, DATABASE_BOOK_ID, DB_MASTER_SHEET)
        set_text_format_column(
            service, DATABASE_BOOK_ID, sheet_id, jan_idx_in_target, 1, len(processed)
        )

    print(f"  → 商品台帳 {len(processed)} 件更新完了")


def _get_exclusion_set(service) -> set:
    """除外リストを JAN/SKU の大文字セットで返す"""
    data = sheet_read(service, DATABASE_BOOK_ID, DB_EXCLUSION_SHEET)
    result = set()
    if not data or len(data) < 2:
        return result
    headers = data[0]
    jan_idx = next((i for i, h in enumerate(headers) if h in ("JAN", "JANコード")), -1)
    sku_idx = next((i for i, h in enumerate(headers) if h in ("商品SKU", "SKU")), -1)
    for row in data[1:]:
        if jan_idx != -1 and jan_idx < len(row) and row[jan_idx]:
            result.add(str(row[jan_idx]).strip().upper())
        if sku_idx != -1 and sku_idx < len(row) and row[sku_idx]:
            result.add(str(row[sku_idx]).strip().upper())
    return result


def _get_existing_date_map(service, sheet_name: str, book_id: str) -> dict:
    """未販売リストシートから {groupKey: 登録日文字列} を返す"""
    data = sheet_read(service, book_id, sheet_name)
    result = {}
    if not data or len(data) < 2:
        return result
    if str(data[0][0]).strip() != "リスト登録日":
        return result
    date_pat = re.compile(r"^\d{4}[/\-]\d{1,2}[/\-]\d{1,2}")
    for row in data[1:]:
        row = _pad_row(row, 5)
        raw_date = str(row[0])
        pasin = str(row[2]).strip().upper()
        jan   = str(row[3]).strip().upper()
        sku   = str(row[4]).strip().upper()
        key   = pasin or sku or jan
        if key and date_pat.match(raw_date):
            result[key] = raw_date
    return result


def _parse_date(val):
    """文字列から datetime をパース。パース不能の場合は None"""
    if not val:
        return None
    s = str(val).strip()
    for fmt in (
        "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y/%m/%d",
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def create_unsold_lists(service, master_data_all: list, sales_data_all: list):
    """
    未販売リスト3種を作成する（GAS: createAllUnsoldLists 相当）
    master_data_all, sales_data_all は [header, ...rows] 形式
    """
    print("[3/5] 未販売リスト作成中...")

    exclusion_set = _get_exclusion_set(service)
    today_str = datetime.now().strftime("%Y/%m/%d")
    base_date = (
        datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        - timedelta(days=1)
    )

    master_headers = master_data_all[0]
    master_data    = master_data_all[1:]
    m_name_idx  = master_headers.index("商品名")
    m_pasin_idx = master_headers.index("親ASIN")
    m_jan_idx   = master_headers.index("JAN")
    m_sku_idx   = master_headers.index("商品SKU")

    s_header   = sales_data_all[0]
    sales_data = sales_data_all[1:]
    s_jan_idx  = s_header.index("JANコード")
    s_sku_idx  = s_header.index("商品SKU")
    s_date_idx = s_header.index("注文日時")

    # SKU/JAN → 親ASINのグルーピングマップ
    sku_to_parent = {}
    jan_to_parent = {}
    for row in master_data:
        pasin = str(row[m_pasin_idx] if m_pasin_idx < len(row) else "").strip().upper()
        jan   = str(row[m_jan_idx]   if m_jan_idx   < len(row) else "").strip().upper()
        sku   = str(row[m_sku_idx]   if m_sku_idx   < len(row) else "").strip().upper()
        group_key = pasin or sku
        if group_key:
            if sku: sku_to_parent[sku] = group_key
            if jan: jan_to_parent[jan] = group_key

    # 最終販売日マップ
    last_sale_map = {}
    for row in sales_data:
        s_jan   = str(row[s_jan_idx]  if s_jan_idx  < len(row) else "").strip().upper()
        s_sku   = str(row[s_sku_idx]  if s_sku_idx  < len(row) else "").strip().upper()
        s_date  = _parse_date(row[s_date_idx] if s_date_idx < len(row) else "")
        if not s_date:
            continue
        target_key = sku_to_parent.get(s_sku) or jan_to_parent.get(s_jan)
        if target_key:
            if target_key not in last_sale_map or s_date > last_sale_map[target_key]:
                last_sale_map[target_key] = s_date

    old_1w = _get_existing_date_map(service, UNSOLD_SHEET_1W, SOURCE_BOOK_ID)
    old_1m = _get_existing_date_map(service, UNSOLD_SHEET_1M, SOURCE_BOOK_ID)
    old_2m = _get_existing_date_map(service, UNSOLD_SHEET_2M, SOURCE_BOOK_ID)

    list_1w, list_1m, list_2m = [], [], []
    added_1w, added_1m, added_2m = set(), set(), set()

    for row in master_data:
        name  = row[m_name_idx]  if m_name_idx  < len(row) else ""
        pasin = row[m_pasin_idx] if m_pasin_idx < len(row) else ""
        jan   = row[m_jan_idx]   if m_jan_idx   < len(row) else ""
        sku   = row[m_sku_idx]   if m_sku_idx   < len(row) else ""

        pasin_u = str(pasin or "").strip().upper()
        jan_u   = str(jan   or "").strip().upper()
        sku_u   = str(sku   or "").strip().upper()

        if sku_u in exclusion_set or jan_u in exclusion_set:
            continue

        check_key = pasin_u or sku_u
        if not check_key:
            continue

        last_date = last_sale_map.get(check_key)
        days_diff = (base_date - last_date).days if last_date else 99999

        row_data = [name, pasin, jan, sku]

        if days_diff > 7 and check_key not in added_1w:
            list_1w.append([old_1w.get(check_key, today_str)] + row_data)
            added_1w.add(check_key)
        if days_diff > 30 and check_key not in added_1m:
            list_1m.append([old_1m.get(check_key, today_str)] + row_data)
            added_1m.add(check_key)
        if days_diff > 60 and check_key not in added_2m:
            list_2m.append([old_2m.get(check_key, today_str)] + row_data)
            added_2m.add(check_key)

    header = ["リスト登録日", "商品名", "親ASIN", "JAN", "商品SKU"]
    _write_unsold_list(service, SOURCE_BOOK_ID, UNSOLD_SHEET_1W, header, list_1w, today_str)
    _write_unsold_list(service, SOURCE_BOOK_ID, UNSOLD_SHEET_1M, header, list_1m, today_str)
    _write_unsold_list(service, SOURCE_BOOK_ID, UNSOLD_SHEET_2M, header, list_2m, today_str)
    print(f"  → 1週間:{len(list_1w)}件 / 1ヶ月:{len(list_1m)}件 / 2ヶ月:{len(list_2m)}件")


def _write_unsold_list(service, book_id, sheet_name, header, items, today_str):
    """未販売リストをハイライト付きで書き込む"""
    ensure_sheet_exists(service, book_id, sheet_name)
    items_sorted = sorted(items, key=lambda r: r[0] if r[0] else "", reverse=True)

    all_values = [header] + items_sorted
    sheet_clear_write(service, book_id, sheet_name, all_values)

    if not items_sorted:
        return

    sheet_id = get_sheet_id(service, book_id, sheet_name)
    if sheet_id is None:
        return

    # JAN列（index 3）をテキスト書式に
    set_text_format_column(service, book_id, sheet_id, 3, 1, len(items_sorted))

    # 今日登録の行を薄黄色でハイライト
    colors = ["#fff2cc" if row[0] == today_str else None for row in items_sorted]
    set_row_backgrounds(service, book_id, sheet_id, 1, colors)


def create_empty_code_lists(service, master_data_all: list):
    """
    JAN/SKU未登録リストを作成する（GAS: createEmptyCodeLists 相当）
    """
    print("[4/5] 未登録コードリスト作成中...")

    headers   = master_data_all[0]
    master    = master_data_all[1:]
    name_idx  = headers.index("商品名")
    pasin_idx = headers.index("親ASIN")
    jan_idx   = headers.index("JAN")
    sku_idx   = headers.index("商品SKU")

    empty_jan, empty_sku = [], []
    for row in master:
        name  = row[name_idx]  if name_idx  < len(row) else ""
        pasin = row[pasin_idx] if pasin_idx < len(row) else ""
        jan   = row[jan_idx]   if jan_idx   < len(row) else ""
        sku   = row[sku_idx]   if sku_idx   < len(row) else ""
        if not jan: empty_jan.append([name, pasin, jan, sku])
        if not sku: empty_sku.append([name, pasin, jan, sku])

    list_header = ["商品名", "親ASIN", "JAN", "商品SKU"]
    for sheet_name, items in [(EMPTY_JAN_SHEET, empty_jan), (EMPTY_SKU_SHEET, empty_sku)]:
        ensure_sheet_exists(service, SOURCE_BOOK_ID, sheet_name)
        sheet_clear_write(service, SOURCE_BOOK_ID, sheet_name, [list_header] + items)

    print(f"  → JAN空欄:{len(empty_jan)}件 / SKU空欄:{len(empty_sku)}件")


def sync_unsold_to_fuka_sheet(service):
    """
    未販売1週間リストを不買商品シートへ同期する（GAS: executeSyncLogic 相当）
    シート上部のメタ行・ヘッダー行の位置は「ASIN」「最終更新日」テキストで動的に特定する。
    """
    print("[5/5] 不買商品シート同期中...")

    # 不買商品シートを全読み込み
    fuka_all = sheet_read(service, FUKA_BOOK_ID, FUKA_SHEET_NAME)
    if not fuka_all:
        print("  不買商品シートが空です。スキップします。")
        return

    max_cols = max((len(r) for r in fuka_all), default=9)
    max_cols = max(max_cols, 9)
    fuka_all = [_pad_row(r, max_cols) for r in fuka_all]

    # C列(index 2)で「ASIN」がある行を探す → 次の行がデータ開始
    header_row_idx = next(
        (i for i, r in enumerate(fuka_all[:30]) if str(r[2]).strip() == "ASIN"),
        None,
    )
    if header_row_idx is None:
        print("  不買商品シートに「ASIN」ヘッダーが見つかりません。スキップします。")
        return
    target_start_idx = header_row_idx + 1  # 0-based データ開始行
    target_start_row = target_start_idx + 1  # 1-based（数式用）

    # C列で「最終更新日」がある行の次行に集計値を書き込む
    meta_label_idx = next(
        (i for i, r in enumerate(fuka_all[:30]) if str(r[2]).strip() == "最終更新日"),
        None,
    )
    meta_write_idx = meta_label_idx + 1 if meta_label_idx is not None else None

    # 未販売リスト-1週間- を取得
    source_all = sheet_read(service, SOURCE_BOOK_ID, UNSOLD_SHEET_1W)
    src_rows = [_pad_row(r, 5) for r in source_all[1:]] if len(source_all) > 1 else []

    src_asin_map = {}
    src_jan_set  = set()
    for row in src_rows:
        asin = str(row[2]).strip()
        jan  = str(row[3]).strip()
        if asin:
            src_asin_map[asin] = row
        if jan and jan not in ("-", ""):
            src_jan_set.add(jan)

    def clean_jan(v):
        s = str(v).strip()
        return "-" if not s or s == "0" else s

    # 既存データ行をフィルタリング（ソースに存在するものだけ残す）
    existing_rows = fuka_all[target_start_idx:]
    kept = []
    for row in existing_rows:
        name = str(row[1]).strip()
        asin = str(row[2]).strip()
        jan  = str(row[3]).strip()
        if not name and not asin and not jan:
            continue
        if (asin and asin in src_asin_map) or (jan and jan in src_jan_set):
            row = list(row)
            # JAN を最新値に更新
            if asin and asin in src_asin_map:
                row[3] = clean_jan(src_asin_map[asin][3])
            else:
                row[3] = clean_jan(row[3])
            row[4] = ""  # E列（数式列）はクリア
            row[5] = ""  # F列（数式列）はクリア
            kept.append(row)

    existing_asins = {str(r[2]).strip() for r in kept if str(r[2]).strip()}
    existing_jans  = {str(r[3]).strip() for r in kept if str(r[3]).strip() not in ("", "-")}

    # ソースにあって不買商品シートにない → 新規追加
    today_str = datetime.now().strftime("%Y/%m/%d")
    for src_row in src_rows:
        s_asin = str(src_row[2]).strip()
        s_jan  = clean_jan(src_row[3])
        # ASINがある場合はASIN優先で重複チェック、ない場合はJANで判定
        if s_asin:
            if s_asin in existing_asins:
                continue
        elif s_jan and s_jan != "-":
            if s_jan in existing_jans:
                continue
        else:
            continue  # ASIN も JAN もない行はスキップ
        new_row = [""] * max_cols
        new_row[0] = src_row[0]          # リスト登録日
        new_row[1] = src_row[1]          # 商品名
        new_row[2] = src_row[2]          # ASIN
        new_row[3] = s_jan               # JAN
        kept.append(new_row)
        if s_asin:
            existing_asins.add(s_asin)
        elif s_jan and s_jan != "-":
            existing_jans.add(s_jan)

    # 日付降順ソート
    def row_date(r):
        d = _parse_date(r[0])
        return d if d else datetime.min
    kept.sort(key=row_date, reverse=True)

    # ソート後に行位置が確定するので、ここでE・F列の数式を設定する
    for i, row in enumerate(kept):
        sheet_row = target_start_row + i  # 1-based のシート行番号
        row[4] = (
            f"=IFERROR(INDEX('シート22'!$L$10:$L$12445,"
            f"MATCH(C{sheet_row},'シート22'!$I$10:$I$12445,0)),\"\")"
        )
        row[5] = (
            f"=IFERROR(INDEX('シート22'!$O$10:$O$12445,"
            f"MATCH(C{sheet_row},'シート22'!$I$10:$I$12445,0)),\"\")"
        )

    # 今日の新規件数をカウント（登録日が今日の行数）
    match_count = sum(1 for r in kept if str(r[0]).strip() == today_str)

    # メタ行を更新
    top_rows = [list(r) for r in fuka_all[:target_start_idx]]
    if meta_write_idx is not None and meta_write_idx < len(top_rows):
        meta_row = _pad_row(top_rows[meta_write_idx], max_cols)
        meta_row[2] = today_str                       # C: 最終更新日
        meta_row[3] = str(match_count)                # D: 新規件数
        meta_row[4] = f"=SUM(E{target_start_row}:E)"  # E: 合計数式
        top_rows[meta_write_idx] = meta_row

    # シートに全データを書き戻す
    all_values = top_rows + kept
    sheet_clear_write(service, FUKA_BOOK_ID, FUKA_SHEET_NAME, all_values)

    # 今日追加の行を黄色でハイライト
    sheet_id = get_sheet_id(service, FUKA_BOOK_ID, FUKA_SHEET_NAME)
    if sheet_id is not None and kept:
        colors = ["#ffff00" if str(r[0]).strip() == today_str else None for r in kept]
        set_row_backgrounds(service, FUKA_BOOK_ID, sheet_id, target_start_idx, colors)

    print(f"  → 不買商品シート同期完了（新規: {match_count}件 / 合計: {len(kept)}件）")


# ============================================================
# メイン処理
# ============================================================

def main():
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    processed_dir = os.path.join(DOWNLOAD_DIR, "processed")
    os.makedirs(processed_dir, exist_ok=True)

    # ---- ステップ 1: ローカルCSVを収集 ----
    csv_files = sorted([
        os.path.join(DOWNLOAD_DIR, f)
        for f in os.listdir(DOWNLOAD_DIR)
        if f.lower().endswith(".csv")
        and os.path.isfile(os.path.join(DOWNLOAD_DIR, f))
    ])
    if not csv_files:
        print(f"処理対象のCSVが {DOWNLOAD_DIR} に見つかりません。")
        print("先に salesDataDownload_local.py を実行してください。")
        return
    print(f"対象CSV ({len(csv_files)}件): {[os.path.basename(f) for f in csv_files]}")

    # ---- ステップ 2: Google Sheets API で処理 ----
    print("\n=== Sheets API処理開始 ===")
    service = get_sheets_service()

    update_product_master(service)

    sales_data = update_database(service, csv_files)

    master_data = sheet_read(service, DATABASE_BOOK_ID, DB_MASTER_SHEET)
    if not master_data:
        raise ValueError("商品台帳の取得に失敗しました")

    create_unsold_lists(service, master_data, sales_data)
    create_empty_code_lists(service, master_data)
    sync_unsold_to_fuka_sheet(service)

    if DRY_RUN:
        print("\n=== 確認のみ（INTEGRATED_DRY_RUN=1）のため、シートは変更していません ===")
        return

    # ---- ステップ 3: 処理済みCSVを移動 ----
    for f in csv_files:
        shutil.move(f, os.path.join(processed_dir, os.path.basename(f)))
    print(f"\n処理済みCSVを {processed_dir} に移動しました。")

    print("\n=== 全処理完了 ===")


if __name__ == "__main__":
    main()
