import re
import os
import sys
import time
import pandas as pd
import logging
import traceback
import ssl
from playwright.sync_api import Locator, Playwright, sync_playwright
from datetime import datetime
from google.oauth2 import service_account
from googleapiclient.discovery import build
from dotenv import load_dotenv

try:
    import certifi
    import httplib2
    from google_auth_httplib2 import AuthorizedHttp
except ImportError:
    certifi = None
    httplib2 = None
    AuthorizedHttp = None

# --- スクリプトのディレクトリを基準に絶対パスを設定 ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(SCRIPT_DIR, '.env')

# .envファイルから設定を読み込む（GitHub Actions では環境変数から直接渡すため任意）
if os.path.exists(ENV_FILE):
    load_dotenv(ENV_FILE)

# GOQ_HEADLESS=1: 画面なしでブラウザを起動（GitHub Actions 用）
HEADLESS = os.getenv("GOQ_HEADLESS", "").strip() == "1"
# GOQ_TRACE=1: Playwright のトレースを取り、失敗時に logs/ へ保存（ヘッドレス時は既定で有効）
TRACE = os.getenv("GOQ_TRACE", "1" if HEADLESS else "").strip() == "1"
# GOQ_LOGIN_ONLY=1: GoQ ログインの成否だけ確認し、シートには書き込まない
LOGIN_ONLY = os.getenv("GOQ_LOGIN_ONLY", "").strip() == "1"
# GOQ_DOWNLOAD_ONLY=1: CSVのダウンロードまで行い、シートには書き込まない
DOWNLOAD_ONLY = os.getenv("GOQ_DOWNLOAD_ONLY", "").strip() == "1"
# GOQ_ORDER_STATUS: 絞り込む受注ステータス（通常は「処理済」）。自社の販売リストに書くのは「処理済」だけ
TARGET_ORDER_STATUS = os.getenv("GOQ_ORDER_STATUS", "").strip() or "処理済"
if TARGET_ORDER_STATUS != "処理済":
    DOWNLOAD_ONLY = True  # 「処理済」以外はダウンロードのみ（調査用）。シートには絶対に書かない
WRITE_TO_SHEET = not (LOGIN_ONLY or DOWNLOAD_ONLY)
# GOQ_SHOW_SAMPLE_ROWS=5: ダウンロードしたCSVの最新行をログに出す（データ確認用。氏名・住所の列は含まない）
SHOW_SAMPLE_ROWS = int(os.getenv("GOQ_SHOW_SAMPLE_ROWS", "0") or 0)

LOGIN_URL = os.getenv("GOQ_LOGIN_URL")
USER_ID = os.getenv("GOQ_USER_ID")
PASSWORD = os.getenv("GOQ_PASSWORD")
SEQ_ID = os.getenv("GOQ_SEQ_ID")
SEQ_PW = os.getenv("GOQ_SEQ_PW")

SHEET_ID = os.getenv("GSHEET_ID")
SHEET_NAME = os.getenv("GSHEET_NAME")
CREDENTIALS_FILE = os.path.join(SCRIPT_DIR, os.getenv("CREDENTIALS_FILE", "credentials.json"))
DOWNLOAD_DIR = os.path.join(SCRIPT_DIR, os.getenv("DOWNLOAD_DIR", "販売データダウンロード"))

# --- 必須環境変数の確認 ---
required_env_vars = {
    "GOQ_LOGIN_URL": LOGIN_URL,
    "GOQ_USER_ID": USER_ID,
    "GOQ_PASSWORD": PASSWORD,
    "GOQ_SEQ_ID": SEQ_ID,
    "GOQ_SEQ_PW": SEQ_PW,
}
if WRITE_TO_SHEET:
    required_env_vars["GSHEET_ID"] = SHEET_ID
    required_env_vars["GSHEET_NAME"] = SHEET_NAME

for var_name, var_value in required_env_vars.items():
    if not var_value:
        print(f"エラー: 環境変数 {var_name} が設定されていません（.env または環境変数）")
        sys.exit(1)

# --- 日付指定設定 ---
# 指定したい場合のみ "YYYY-MM-DD" 形式で入力。空文字の場合は「昨日」を検索。
# 例: "2025-10-10"
GOQ_TARGET_DATE = os.getenv("GOQ_TARGET_DATE", "").strip()
SPECIFIED_START_DATE = GOQ_TARGET_DATE
# GOQ_TARGET_END_DATE: 期間で検索する場合の終了日（省略時は GOQ_TARGET_DATE の1日分）
SPECIFIED_END_DATE = os.getenv("GOQ_TARGET_END_DATE", "").strip() or GOQ_TARGET_DATE

# --- 認証ファイルの存在確認 ---
if WRITE_TO_SHEET and not os.path.exists(CREDENTIALS_FILE):
    print(f"エラー: credentials.jsonが見つかりません: {CREDENTIALS_FILE}")
    sys.exit(1)

if not os.path.exists(DOWNLOAD_DIR):
    os.makedirs(DOWNLOAD_DIR)

# --- ログ設定 ---
LOG_DIR = os.path.join(SCRIPT_DIR, 'logs')
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR)

log_file = os.path.join(LOG_DIR, 'shipping_download.log')

def get_logger():
    l = logging.getLogger(__name__)
    if not l.handlers:
        # Windowsでのエンコーディング問題を避けるためにutf-8を指定
        handler = logging.FileHandler(log_file, encoding='utf-8')
        fmt = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
        handler.setFormatter(fmt)
        l.addHandler(handler)
        
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        l.addHandler(console)
        l.setLevel(logging.INFO)
    return l

logger = get_logger()

CA_BUNDLE_FILE = os.path.join(LOG_DIR, "windows-plus-certifi-ca.pem")

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
        except Exception as e:
            logger.warning(f"Failed to read Windows certificate store {store_name}: {e}")

    with open(CA_BUNDLE_FILE, "w", encoding="ascii", newline="\n") as f:
        f.write("\n".join(part for part in bundle_parts if part))
        f.write("\n")

    return CA_BUNDLE_FILE

SHEET_DATA_START_ROW = 4
SHEET_WRITE_START_COLUMN = "B"
SHEET_LAST_KEY_COLUMN = "K"
TAIL_SCAN_CHUNK_ROWS = 1000
DUPLICATE_LOOKBACK_ROWS = 20000
SHEET_ROW_BUFFER = 1000
API_RETRY_COUNT = 3
API_RETRY_BASE_SECONDS = 5

def execute_with_retry(request, operation_name):
    last_error = None
    for attempt in range(1, API_RETRY_COUNT + 1):
        try:
            return request.execute()
        except Exception as e:
            last_error = e
            if attempt >= API_RETRY_COUNT:
                break
            wait_seconds = API_RETRY_BASE_SECONDS * attempt
            logger.warning(
                f"{operation_name} failed on attempt {attempt}/{API_RETRY_COUNT}: {e}. "
                f"Retrying in {wait_seconds}s."
            )
            time.sleep(wait_seconds)
    raise last_error

def get_sheet_properties(sheet_api):
    metadata = execute_with_retry(sheet_api.get(
        spreadsheetId=SHEET_ID,
        fields="sheets(properties(sheetId,title,gridProperties(rowCount)))"
    ), "Get spreadsheet metadata")

    for sheet in metadata.get("sheets", []):
        properties = sheet.get("properties", {})
        if properties.get("title") == SHEET_NAME:
            return properties

    raise RuntimeError(f"Sheet not found: {SHEET_NAME}")

def ensure_sheet_has_rows(sheet_api, required_last_row):
    target_sheet = get_sheet_properties(sheet_api)
    current_row_count = target_sheet.get("gridProperties", {}).get("rowCount", 0)
    required_row_count = required_last_row + SHEET_ROW_BUFFER
    if current_row_count >= required_row_count:
        return

    rows_to_add = required_row_count - current_row_count
    logger.info(
        f"Extending sheet rows: {current_row_count} -> {current_row_count + rows_to_add}"
    )
    execute_with_retry(sheet_api.batchUpdate(
        spreadsheetId=SHEET_ID,
        body={
            "requests": [
                {
                    "appendDimension": {
                        "sheetId": target_sheet["sheetId"],
                        "dimension": "ROWS",
                        "length": rows_to_add,
                    }
                }
            ]
        }
    ), "Append sheet rows")

def find_last_data_row(sheet_api):
    target_sheet = get_sheet_properties(sheet_api)
    row_count = target_sheet.get("gridProperties", {}).get("rowCount", 0)

    for end_row in range(row_count, SHEET_DATA_START_ROW - 1, -TAIL_SCAN_CHUNK_ROWS):
        start_row = max(SHEET_DATA_START_ROW, end_row - TAIL_SCAN_CHUNK_ROWS + 1)
        result = execute_with_retry(sheet_api.values().get(
            spreadsheetId=SHEET_ID,
            range=f"'{SHEET_NAME}'!F{start_row}:{SHEET_LAST_KEY_COLUMN}{end_row}",
        ), f"Scan last data row {start_row}:{end_row}")
        rows = result.get("values", [])
        for offset in range(len(rows) - 1, -1, -1):
            row = rows[offset]
            order_id = str(row[0]).strip() if len(row) > 0 else ""
            if order_id:
                return start_row + offset

    raise RuntimeError("Existing sheet data was empty; aborting to avoid overwriting from row 4")

def get_existing_keys(sheet_api, last_data_row):
    start_row = max(SHEET_DATA_START_ROW, last_data_row - DUPLICATE_LOOKBACK_ROWS + 1)
    result = execute_with_retry(sheet_api.values().batchGet(
        spreadsheetId=SHEET_ID,
        ranges=[f"'{SHEET_NAME}'!F{start_row}:F{last_data_row}", f"'{SHEET_NAME}'!K{start_row}:K{last_data_row}"],
        majorDimension="COLUMNS",
    ), f"Read duplicate keys {start_row}:{last_data_row}")

    value_ranges = result.get("valueRanges", [])
    order_ids = value_ranges[0].get("values", [[]])[0] if len(value_ranges) > 0 else []
    shop_names = value_ranges[1].get("values", [[]])[0] if len(value_ranges) > 1 else []

    existing_keys = set()
    for index in range(max(len(order_ids), len(shop_names))):
        order_id = str(order_ids[index]).strip() if index < len(order_ids) else ""
        shop_name = str(shop_names[index]).strip() if index < len(shop_names) else ""
        if order_id:
            existing_keys.add(f"{order_id}_{shop_name}")

    logger.info(
        f"Duplicate check range: rows {start_row}-{last_data_row}, keys={len(existing_keys)}"
    )
    return existing_keys

SHEETS_HTTP_TIMEOUT_SECONDS = 300

def build_sheets_api():
    """Google Sheets API クライアントを作る（重いブックでも待てるよう待ち時間を長めに取る）"""
    scopes = ['https://www.googleapis.com/auth/spreadsheets']
    creds = service_account.Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=scopes)
    if certifi and httplib2 and AuthorizedHttp:
        http = AuthorizedHttp(
            creds,
            http=httplib2.Http(ca_certs=get_ca_bundle_path(), timeout=SHEETS_HTTP_TIMEOUT_SECONDS),
        )
        service = build('sheets', 'v4', http=http)
    else:
        service = build('sheets', 'v4', credentials=creds)
    return service.spreadsheets()

def to_cell(value):
    """Sheets API（JSON）に渡せる値にする。pandas/numpy の数値型は Python の数値に、欠損は空文字にする"""
    if value is None:
        return ""
    if hasattr(value, "item"):  # numpy の int64 / float64 など
        value = value.item()
    if isinstance(value, float):
        if value != value:  # NaN
            return ""
        if value.is_integer():
            return int(value)
    return value

def build_sheet_row(sheet_row, ship_date, order_id, shop_name, row):
    """G-出荷用シートの B〜S 列 1行分を作る。年・月は関数ではなく数値で入れる（INDIRECT の再計算を避ける）"""
    ymd = ship_date.strftime('%Y/%m/%d') if ship_date is not None else ""
    year = ship_date.year if ship_date is not None else ""
    month = ship_date.month if ship_date is not None else ""
    func_o = f'=IF(H{sheet_row}="","",IF(COUNTIF(\'関数用\'!$H$4:$H$14161,I{sheet_row}),"SET品",IF(COUNTIF(GoQ!$Q$4:$Q$13134,I{sheet_row}),"単体","NO DATA")))'
    func_p = f'=IF(O{sheet_row}="","",IF(O{sheet_row}="単体","1",IF(O{sheet_row}="SET品",(INDEX(GoQ!$G$3:$G$13134,MATCH(I{sheet_row},GoQ!$Q$3:$Q$13134,0))),"FALSE")))'
    func_q = f'=IF(O{sheet_row}="","",IF(O{sheet_row}="単体",(INDEX(GoQ!$E$3:$E$13134,MATCH(I{sheet_row},GoQ!$Q$3:$Q$13134,0))),IF(O{sheet_row}="SET品",(INDEX(GoQ!$E$3:$E$13134,MATCH(I{sheet_row},GoQ!$Q$3:$Q$13134,0))),"正規ASIN入力")))'
    func_r = f'=IFERROR(IF(P{sheet_row}="","",P{sheet_row}*N{sheet_row}),"")'
    func_s = f'=IF(O{sheet_row}="","",IF(O{sheet_row}="〇","-",IF(COUNTIF(\'在庫増減用\'!$E$4:$E$20000,Q{sheet_row}),"〇","×")))'
    return [to_cell(v) for v in [
        "自動",             # B: 担当者
        year,               # C: 年（数値）
        month,              # D: 月（数値）
        ymd,                # E: 出荷日
        order_id,           # F: 受注番号
        row['商品名'],       # G: 商品名
        row['商品コード'],   # H: 商品管理番号
        row['商品SKU'],      # I: 商品SKU
        row['SKU管理番号'],  # J: SKU管理番号
        shop_name,          # K: 販売店舗
        row['合計金額'],     # L: 合計金額
        row['JANコード'],    # M: JANコード
        row['個数'],         # N: 個数
        func_o, func_p, func_q, func_r, func_s,  # O〜S: 関数
    ]]

def write_to_google_sheets(csv_file_path):
    """CSVを昇順に並び替え、関数を含めてスプレッドシートの最新行に確実に追記する"""
    logger.info(f"スプレッドシートへの書き込みを開始します: {csv_file_path}")
    logger.info(f"対象シート名: {SHEET_NAME}")

    try:
        sheet_api = build_sheets_api()
    except Exception as e:
        logger.error(f"Google API サービスの構築に失敗しました: {e}")
        logger.error(traceback.format_exc())
        raise

    # 1. 既存データの取得（F列のデータから最終行を正確に把握する）
    try:
        last_data_row = find_last_data_row(sheet_api)
        next_row = last_data_row + 1
        existing_keys = get_existing_keys(sheet_api, last_data_row)
        logger.info(f"Last data row: {last_data_row}, next write row: {next_row}")
    except Exception as e:
        logger.warning(f"既存データの取得中にエラーが発生しました（範囲外の可能性があります）: {e}")
        raise

    # 2. CSV読み込み
    df = None
    for enc in ['cp932', 'utf-8-sig']:
        for sep in[',', '\t']:
            try:
                temp_df = pd.read_csv(csv_file_path, encoding=enc, sep=sep)
                if '受注番号' in temp_df.columns:
                    df = temp_df
                    break
            except: continue
        if df is not None: break

    if df is None:
        logger.error("エラー: CSVから'受注番号'列が見つかりませんでした。")
        raise ValueError("Required CSV column was not found")

    df = df.fillna("")

    # 「処理済」以外のステータスが混ざっていたら除外する（GoQ の絞り込みが崩れた場合の最終防衛線）
    if '受注ステータス' in df.columns:
        other = df[df['受注ステータス'].astype(str).str.strip() != TARGET_ORDER_STATUS]
        if len(other):
            counts = other['受注ステータス'].value_counts()
            logger.warning(
                f"「{TARGET_ORDER_STATUS}」以外の {len(other)} 行を除外します: "
                + ", ".join(f"{k}={v}" for k, v in counts.items())
            )
            df = df[df['受注ステータス'].astype(str).str.strip() == TARGET_ORDER_STATUS]

    # 3. 出荷日を基準に古い順（昇順）に並び替え
    df['_sort_date'] = pd.to_datetime(df['出荷日'], errors='coerce')
    df = df.sort_values(by='_sort_date', ascending=True)

    # 4. データの整形
    output_data = []
    for _, row in df.iterrows():
        csv_order_id = str(row['受注番号']).strip()
        csv_shop_name = str(row['販売店舗']).strip()

        # 重複チェック
        if f"{csv_order_id}_{csv_shop_name}" in existing_keys:
            continue

        ship_date = row['_sort_date'] if pd.notna(row['_sort_date']) else None
        sheet_row = next_row + len(output_data)
        output_data.append(build_sheet_row(sheet_row, ship_date, csv_order_id, csv_shop_name, row))

    # 5. データの追記（updateメソッドでピンポイント書き込み。同じ範囲への上書きなので再試行しても重複しない）
    if output_data:
        logger.info(f"{len(output_data)} 件の新規データを {next_row}行目 から書き込みます...")
        try:
            ensure_sheet_has_rows(sheet_api, next_row + len(output_data) - 1)
            execute_with_retry(sheet_api.values().update(
                spreadsheetId=SHEET_ID,
                range=f"'{SHEET_NAME}'!B{next_row}",  # ★計算した最新行のB列を指定
                valueInputOption="USER_ENTERED",
                body={'values': output_data}
            ), "Append rows")
            logger.info("書き込みが完了しました。")
        except Exception as e:
            logger.error(f"スプレッドシートへの書き込み中にエラーが発生しました: {e}")
            logger.error(traceback.format_exc())
            raise
    else:
        logger.info("新規データ（未登録の受注番号）がないため、書き込みをスキップしました。")

    # 6. E2セルの日付更新
    try:
        execute_with_retry(sheet_api.values().update(
            spreadsheetId=SHEET_ID,
            range=f"'{SHEET_NAME}'!E2",
            valueInputOption="USER_ENTERED",
            body={'values': [[datetime.now().strftime('%Y/%m/%d')]]}
        ), "Update E2")
        logger.info("日付(E2)を更新しました。")
    except Exception as e:
        logger.warning(f"日付(E2)の更新に失敗しました: {e}")

def login_goq(page):
    """GoQSystemへのログイン処理"""
    page.goto(LOGIN_URL, timeout=60000)
    page.locator("#login_id").fill(USER_ID)
    page.locator("#login_pw").fill(PASSWORD)
    page.get_by_role("button", name="認証する").click()
    page.locator("#seq_id").fill(SEQ_ID)
    page.locator("#seq_pw").fill(SEQ_PW)
    page.get_by_role("button", name="ログイン", exact=True).click()
    try:
        page.get_by_role("button", name="同意してGoQSystemを利用します").click(timeout=5000)
    except:
        pass

def handle_popups(page):
    """お知らせポップアップの閉じる処理"""
    try:
        page.wait_for_selector("text=上記について確認しました", timeout=3000)
        labels = page.locator("section label")
        for i in range(labels.count()):
            labels.nth(i).click()
        page.get_by_role("button", name="上記について確認しました").click()
    except Exception:
        pass

    # ポップアップが完全に消えるまで待機（クリックブロック防止）
    try:
        page.wait_for_selector("#manage_pop_up_window", state="hidden", timeout=10000)
    except Exception:
        try:
            overlay = page.locator("#manage_pop_up_window")
            if overlay.count() > 0 and overlay.first.is_visible():
                record_popup(overlay.first)
                if close_popup_with_button(page, overlay.first):
                    return
                logger.warning("manage_pop_up_window remained visible; disabling overlay to continue")
                page.evaluate("""
                    () => {
                        for (const selector of ['#manage_pop_up_window', '.manage_overlay']) {
                            for (const overlay of document.querySelectorAll(selector)) {
                                overlay.style.display = 'none';
                                overlay.style.visibility = 'hidden';
                                overlay.style.pointerEvents = 'none';
                            }
                        }
                    }
                """)
                page.wait_for_timeout(500)
        except Exception as e:
            logger.warning(f"Failed to clear manage popup overlay: {e}")


def record_popup(popup):
    """ポップアップの中身を記録する（何のお知らせか・どのボタンで閉じるかを特定するため）"""
    try:
        text = " ".join(popup.inner_text(timeout=3000).split())[:500]
        logger.warning(f"manage_pop_up_window が表示されています。文面: {text}")
        buttons = popup.locator("button, a, input[type=button], input[type=submit]")
        labels = []
        for i in range(min(buttons.count(), 20)):
            b = buttons.nth(i)
            label = (b.inner_text(timeout=1000) or b.get_attribute("value") or b.get_attribute("class") or "").strip()
            labels.append(label[:30])
        logger.warning(f"ポップアップ内のボタン: {labels}")
        path = os.path.join(LOG_DIR, f"goq_popup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png")
        popup.screenshot(path=path, timeout=5000)
        logger.warning(f"ポップアップの画像を保存しました: {path}")
    except Exception as e:
        logger.warning(f"ポップアップの記録に失敗しました: {e}")

def close_popup_with_button(page, popup):
    """ポップアップ内の閉じる系ボタンを押して正規の方法で閉じる。閉じられたら True
    GoQ の「緊急なお知らせ」は、中のチェックボックスをすべて入れないと「上記について確認しました」が押せない"""
    # チェックボックスは非表示で見た目は別要素のため、要素自体をクリックしてイベントを発生させる
    boxes = popup.locator("input[type=checkbox]")
    total = boxes.count()
    if total:
        checked = popup.evaluate("""(root) => {
            const boxes = [...root.querySelectorAll('input[type=checkbox]')];
            for (const el of boxes) { if (!el.checked) el.click(); }
            return boxes.filter(el => el.checked).length;
        }""")
        logger.info(f"ポップアップ内のチェックボックス: {checked}/{total} 個にチェック")

    candidates = popup.locator(
        "button, a, input[type=button], input[type=submit], .close, [aria-label*='close' i]"
    ).filter(has_text=re.compile(r"閉じる|×|✕|確認しました|同意|OK|close", re.I))
    for i in range(candidates.count()):
        button = candidates.nth(i)
        try:
            if not button.is_visible():
                continue
            label = (button.inner_text(timeout=1000) or "").strip()
            button.click(timeout=5000)
            page.wait_for_selector("#manage_pop_up_window", state="hidden", timeout=5000)
            logger.info(f"ポップアップをボタン「{label}」で閉じました")
            return True
        except Exception:
            continue
    return False

def clear_manage_overlay(page):
    """Remove blocking GOQ popup overlays when they remain above the page."""
    page.evaluate("""
        () => {
            for (const selector of ['#manage_pop_up_window', '.manage_overlay']) {
                for (const overlay of document.querySelectorAll(selector)) {
                    overlay.remove();
                }
            }
        }
    """)
    page.wait_for_timeout(200)

def click_with_overlay_recovery(locator, description, *, retries=2):
    """Retry clicks when GOQ popup overlays keep intercepting pointer events."""
    for attempt in range(1, retries + 1):
        try:
            clear_manage_overlay(locator.page)
            locator.click(timeout=5000)
            return
        except Exception as exc:
            logger.warning(
                f"{description} click attempt {attempt}/{retries} failed; clearing overlay and retrying: {exc}"
            )
            clear_manage_overlay(locator.page)
            locator.page.locator("body").click(position={"x": 0, "y": 0}, force=True)
            locator.page.wait_for_timeout(500)

    clear_manage_overlay(locator.page)
    locator.click(timeout=5000, force=True)

def set_checkbox_state(locator, checked):
    """Force a checkbox into the requested state with a DOM fallback."""
    if locator.is_checked() == checked:
        return

    action = locator.check if checked else locator.uncheck
    try:
        action(force=True, timeout=CHECKBOX_TIMEOUT_MS)
    except Exception:
        pass

    locator.page.wait_for_timeout(300)
    if locator.is_checked() == checked:
        return

    locator.evaluate(
        """(element, desiredChecked) => {
            element.checked = desiredChecked;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        checked,
    )
    locator.page.wait_for_timeout(300)

    if locator.is_checked() != checked:
        raise RuntimeError(f"Failed to set checkbox state to {checked}")

_ORIGINAL_LOCATOR_CHECK = Locator.check
_ORIGINAL_LOCATOR_UNCHECK = Locator.uncheck

CHECKBOX_TIMEOUT_MS = 5000  # 標準の30秒だと、失敗時のやり直しまでに何分も待つことになるため短くする

def _safe_locator_toggle(original_method, locator, desired_checked, *args, **kwargs):
    kwargs.setdefault("timeout", CHECKBOX_TIMEOUT_MS)
    try:
        return original_method(locator, *args, **kwargs)
    except Exception:
        set_checkbox_state(locator, desired_checked)

def _patched_locator_check(self, *args, **kwargs):
    return _safe_locator_toggle(_ORIGINAL_LOCATOR_CHECK, self, True, *args, **kwargs)

def _patched_locator_uncheck(self, *args, **kwargs):
    return _safe_locator_toggle(_ORIGINAL_LOCATOR_UNCHECK, self, False, *args, **kwargs)

Locator.check = _patched_locator_check
Locator.uncheck = _patched_locator_uncheck

def download_page_csv(page):    
    # 1. 全ての受注チェックボックスON
    click_with_overlay_recovery(page.get_by_text("全ての受注", exact=True), "全ての受注 checkbox")

    # 2. カスタムCSV選択＆出力
    page.locator("#trader_s3").select_option("customize_csv_5")
    
    with page.context.expect_page() as new_page_info:
        click_with_overlay_recovery(page.get_by_role("button", name="出力").nth(1), "出力 button")
    
    new_page = new_page_info.value
    
    with new_page.expect_download() as download_info:
        pass
        
    download = download_info.value
    save_path = os.path.join(DOWNLOAD_DIR, download.suggested_filename)
    download.save_as(save_path)
    logger.info(f"ダウンロード完了: {save_path}")
    new_page.close()

    if DOWNLOAD_ONLY:
        summarize_csv(save_path)
        logger.info("GOQ_DOWNLOAD_ONLY=1 のため、シートへの書き込みは行いません")
        return

    # スプレッドシートへ書き込み
    write_to_google_sheets(save_path)

def summarize_csv(csv_file_path):
    """ダウンロードしたCSVの件数と列名だけをログに出す（顧客情報は出さない）"""
    for enc in ['cp932', 'utf-8-sig']:
        for sep in [',', '	']:
            try:
                df = pd.read_csv(csv_file_path, encoding=enc, sep=sep)
            except Exception:
                continue
            if '受注番号' in df.columns:
                logger.info(f"CSV確認: {len(df)} 件 / {len(df.columns)} 列 (encoding={enc})")
                logger.info(f"列名: {', '.join(map(str, df.columns))}")
                if '受注ステータス' in df.columns:
                    counts = df['受注ステータス'].fillna('(空欄)').value_counts()
                    logger.info("受注ステータス別件数: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
                if SHOW_SAMPLE_ROWS > 0:
                    logger.info(f"最新 {SHOW_SAMPLE_ROWS} 行（CSVの末尾）:")
                    cols = [c for c in ['出荷日', '受注番号', '商品名', '販売店舗', '合計金額', '個数', '受注ステータス'] if c in df.columns]
                    for _, r in df[cols].tail(SHOW_SAMPLE_ROWS).iterrows():
                        logger.info("  | " + " | ".join(str(r[c])[:40] for c in cols))
                if '出荷日' in df.columns:
                    dates = pd.to_datetime(df['出荷日'], errors='coerce').dropna()
                    if not dates.empty:
                        logger.info(f"出荷日の範囲: {dates.min():%Y-%m-%d} 〜 {dates.max():%Y-%m-%d}")
                return
    raise ValueError(f"CSVから'受注番号'列が見つかりませんでした: {csv_file_path}")

_STATUS_LABEL_JS = "(el) => (el.closest('label')?.innerText || el.labels?.[0]?.innerText || '').trim()"

def get_checked_statuses(page):
    """受注ステータス欄でチェックが入っている項目名の一覧"""
    row = page.get_by_role("row", name=re.compile(r"^受注ステータス")).first
    return row.evaluate(f"""(tr) => [...tr.querySelectorAll('input[type=checkbox]')]
        .filter(el => el.checked).map({_STATUS_LABEL_JS}).map(t => t || '(名称なし)')""")

def ensure_status_filter(page):
    """検索前に、受注ステータスが「処理済」だけになっているか確認し、違えば直す。直らなければ止める"""
    checked = get_checked_statuses(page)
    logger.info(f"チェック中の受注ステータス: {', '.join(checked) if checked else '(なし)'}")
    if checked == [TARGET_ORDER_STATUS]:
        return

    logger.warning(f"受注ステータスの絞り込みが「{TARGET_ORDER_STATUS}」だけになっていないため修正します")
    # 状態を直接書き換えると GoQ の検索条件に反映されないため、実際にクリックして切り替える
    clear_manage_overlay(page)
    row = page.get_by_role("row", name=re.compile(r"^受注ステータス")).first
    boxes = row.locator("input[type=checkbox]")
    for i in range(boxes.count()):
        box = boxes.nth(i)
        label = box.evaluate(_STATUS_LABEL_JS)
        if not label:
            continue  # 全選択用のチェックボックスは触らない
        if box.is_checked() != (label == TARGET_ORDER_STATUS):
            box.click(force=True, timeout=5000)
    page.wait_for_timeout(500)

    checked = get_checked_statuses(page)
    logger.info(f"修正後の受注ステータス: {', '.join(checked) if checked else '(なし)'}")
    if checked != [TARGET_ORDER_STATUS]:
        raise RuntimeError(f"受注ステータスを「{TARGET_ORDER_STATUS}」だけに絞り込めませんでした: {checked}")

def save_failure_screenshot(page, name):
    """失敗時の画面を logs/ に保存（GitHub Actions では成果物として回収）"""
    path = os.path.join(LOG_DIR, f"{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png")
    try:
        page.screenshot(path=path, full_page=True)
        logger.error(f"失敗時の画面を保存しました: {path} (URL: {page.url})")
    except Exception as e:
        logger.error(f"スクリーンショットの保存に失敗しました: {e}")


def run(playwright: Playwright) -> None:
    if HEADLESS:
        # サーバー内でブラウザを起動（GitHub Actions 用）
        logger.info("ブラウザ自動操作を開始します（ヘッドレスモード）")
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
            locale="ja-JP",
            timezone_id="Asia/Tokyo",
            accept_downloads=True,
        )
    else:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context()

    # GitHub Actions ではトレース（画面・通信・操作の記録）を取り、失敗したときだけ保存する
    if TRACE:
        context.tracing.start(screenshots=True, snapshots=True, sources=False)
    page = context.new_page()
    failed = False
    try:
        run_steps(page)
    except Exception:
        failed = True
        save_failure_screenshot(page, "gshipping_failure")
        raise
    finally:
        if TRACE:
            save_trace(context, "gshipping_trace" if failed else None)
        if HEADLESS:
            context.close()
            browser.close()


def save_trace(context, name):
    """name があればトレースを logs/ に保存（https://trace.playwright.dev で開ける）。None なら破棄"""
    try:
        if name:
            path = os.path.join(LOG_DIR, f"{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip")
            context.tracing.stop(path=path)
            logger.error(f"失敗時のトレースを保存しました: {path}（https://trace.playwright.dev で開けます）")
        else:
            context.tracing.stop()
    except Exception as e:
        logger.warning(f"トレースの保存に失敗しました: {e}")


def run_steps(page) -> None:
    login_goq(page)
    order_menu = page.get_by_role("link", name=" 受注管理")
    try:
        order_menu.wait_for(state="visible", timeout=30000)
    except Exception as e:
        raise RuntimeError(f"GoQ ログイン後の画面に到達できませんでした (URL: {page.url})") from e
    logger.info("GoQ ログイン成功")

    if LOGIN_ONLY:
        logger.info("GOQ_LOGIN_ONLY=1 のため、ログイン確認のみで終了します（シートへの書き込みなし）")
        return

    order_menu.click()
    handle_popups(page)
    clear_manage_overlay(page)
    logger.info("受注管理を開きました")
    page.get_by_role("link", name="全て", exact=True).first.click()
    clear_manage_overlay(page)
    logger.info("ステータス「全て」を開きました")
    page.get_by_role("row", name="受注ステータス 新規受付 発送前入金待ち Amazon").get_by_label("", exact=True).uncheck(force=True)
    logger.info("受注ステータスの全選択を解除しました")
    page.get_by_role("checkbox", name="処理済", exact=True).check(force=True)
    logger.info("受注ステータス「処理済」を選択しました")
    ensure_status_filter(page)

    # ★記憶したセレクター（正規表現による指定）
    page.get_by_role("cell", name=re.compile(r"-- \d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}")).locator("#s_day_type").select_option("a59")

    # --- 条件分岐ロジック ---
    if SPECIFIED_START_DATE and SPECIFIED_END_DATE:
        date_range_str = f"{SPECIFIED_START_DATE} - {SPECIFIED_END_DATE}"
        logger.info(f"指定された期間で検索します: {date_range_str}")
        
        # ★名前ベースの確実なセレクターでカレンダー入力
        date_input = page.locator('input[name="search-date-range"]')
        date_input.fill(date_range_str)
        
        # カレンダーのUIを閉じるため、画面の端をクリック
        page.locator("body").click(position={"x": 0, "y": 0})
        
    else:
        logger.info("日付指定がないため、昨日分を検索します。")
        click_with_overlay_recovery(page.get_by_role("button", name="昨日"), "昨日 button")

    # 絞り込むボタンをクリック
    click_with_overlay_recovery(page.get_by_role("button", name="絞り込む"), "絞り込む button")

    # 検索結果が反映されるまでしっかり待機（TimeoutError防止）
    logger.info("検索結果を読み込んでいます...")
    page.wait_for_timeout(5000) 
    page.wait_for_load_state("networkidle")

    # ダウンロード・書き込み実行
    download_page_csv(page)

if __name__ == "__main__":
    with sync_playwright() as playwright:
        run(playwright)
