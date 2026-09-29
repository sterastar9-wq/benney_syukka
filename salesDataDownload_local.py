"""
販売データCSVダウンロード専用スクリプト（Drive アップロードなし）
GoQ / プライスター からCSVをローカルの DOWNLOAD_DIR に保存するのみ。
処理後は integrated_sales_automation.py を実行してシートに書き込む。
"""

import re
import os
import sys
from playwright.sync_api import Playwright, sync_playwright
from datetime import datetime, timedelta
from dotenv import load_dotenv

# --- .envから設定を読み込む ---
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_SCRIPT_DIR, '.env'))

# --- 設定値 ---
LOGIN_URL = os.getenv("GOQ_LOGIN_URL")
USER_ID   = os.getenv("GOQ_USER_ID")
PASSWORD  = os.getenv("GOQ_PASSWORD")
SEQ_ID    = os.getenv("GOQ_SEQ_ID")
SEQ_PW    = os.getenv("GOQ_SEQ_PW")

PRICETAR_EMAIL    = os.getenv("PRICETAR_EMAIL")
PRICETAR_PASSWORD = os.getenv("PRICETAR_PASSWORD")

DOWNLOAD_DIR = "販売データダウンロード"

os.makedirs(DOWNLOAD_DIR, exist_ok=True)


def find_recent_csv(max_age_seconds=1800):
    latest_path = None
    latest_mtime = 0.0
    now = datetime.now().timestamp()

    for entry in os.scandir(DOWNLOAD_DIR):
        if not entry.is_file() or not entry.name.lower().endswith(".csv"):
            continue
        stat = entry.stat()
        if now - stat.st_mtime > max_age_seconds:
            continue
        if stat.st_mtime > latest_mtime:
            latest_mtime = stat.st_mtime
            latest_path = entry.path

    return latest_path


def get_target_date():
    """Default to yesterday, but allow an explicit backfill date."""
    target_date = os.getenv("GOQ_TARGET_DATE", "").strip()
    if target_date:
        return datetime.strptime(target_date, "%Y-%m-%d")
    return datetime.now() - timedelta(days=1)


def click_enabled_button(page, *names):
    for name in names:
        button = page.get_by_role("button", name=name, exact=True)
        if button.count() > 0 and button.first.is_visible() and button.first.is_enabled():
            button.first.click()
            return

    visible_buttons = []
    for button in page.locator("button").all():
        if not button.is_visible():
            continue
        visible_buttons.append(
            {
                "text": button.inner_text(),
                "enabled": button.is_enabled(),
            }
        )
    raise RuntimeError(f"No enabled GOQ button found for {names!r}. Visible buttons: {visible_buttons!r}")


def login_goq(page):
    page.goto(LOGIN_URL)
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(1000)

    if page.locator("a:has(i.icon-order)").count() > 0:
        return

    login_id = page.locator("#login_id")
    if login_id.count() == 0 or not login_id.first.is_visible():
        if page.locator("a:has(i.icon-order)").count() > 0:
            return
        raise RuntimeError(f"GOQ login form was not available. Current URL: {page.url}")

    if login_id.is_enabled():
        login_id.fill(USER_ID)
    else:
        current_value = login_id.input_value()
        if current_value != USER_ID:
            raise RuntimeError(
                f"GOQ login ID field is disabled with unexpected value: {current_value!r}"
            )
    login_pw = page.locator("#login_pw")
    if login_pw.is_enabled():
        login_pw.fill(PASSWORD)
    else:
        current_value = login_pw.input_value()
        if current_value != PASSWORD:
            raise RuntimeError(
                "GOQ password field is disabled with an unexpected saved value."
            )
    seq_id = page.locator("#seq_id")
    seq_pw = page.locator("#seq_pw")
    if not seq_id.is_enabled():
        page.locator("#loginbtn1").click(force=True)
        page.wait_for_function(
            "() => { const el = document.querySelector('#seq_id'); return !!el && !el.disabled; }"
        )
    seq_id.fill(SEQ_ID)
    seq_pw.fill(SEQ_PW)
    page.locator("button.btn.btn-danger.btn-lg").last.click(force=True)
    # [Fix] 同意ボタンは毎回表示されないため try/except で安全に処理
    try:
        page.get_by_role("button", name="同意してGoQSystemを利用します").click(timeout=5000)
    except Exception:
        pass


def handle_popups(page):
    try:
        page.wait_for_selector("text=上記について確認しました", timeout=3000)
        labels = page.locator("section label")
        for i in range(labels.count()):
            labels.nth(i).click()
        page.get_by_role("button", name="上記について確認しました").click()
        print("ポップアップを閉じました。")
    except Exception:
        print("ポップアップはありませんでした。")

    # ポップアップが完全に消えるまで待機（クリックブロック防止）
    try:
        page.wait_for_selector("#manage_pop_up_window", state="hidden", timeout=10000)
    except Exception:
        pass


def download_goq_csv(page) -> str:
    """GoQから昨日の受注CSVをダウンロードしてパスを返す"""
    recent_csv = find_recent_csv()
    if recent_csv:
        print(f"Recent GoQ CSV already exists, reusing: {recent_csv}")
        return recent_csv
    page.get_by_text("全ての受注", exact=True).click()
    page.locator("#trader_s3").select_option("customize_csv_6")

    with page.context.expect_page() as new_page_info:
        page.get_by_role("button", name="出力").nth(1).click()

    new_page = new_page_info.value

    with new_page.expect_download() as download_info:
        pass

    download = download_info.value
    save_path = os.path.join(DOWNLOAD_DIR, download.suggested_filename)
    download.save_as(save_path)
    new_page.close()
    print(f"GoQ CSVダウンロード完了: {save_path}")
    return save_path


def download_pricetar_csv(page) -> str:
    """プライスターからFBA売れたものリストをダウンロードしてパスを返す"""
    page.goto("https://jp2.pricetar.com/entry/login?")
    if page.locator("text=ログイン").count() > 0:
        page.get_by_role("textbox", name="メールアドレス").fill(PRICETAR_EMAIL)
        page.get_by_role("textbox", name="パスワード").fill(PRICETAR_PASSWORD)
        page.get_by_role("button", name="ログイン").click()
        page.wait_for_load_state("load")

    page.goto("https://jp2.pricetar.com/seller/orders/orderlist")
    target_date = get_target_date().strftime("%Y/%m/%d")
    input_field = page.locator("#jquery-ui-datepicker-from")
    input_field.click()
    input_field.press("Control+a")
    input_field.fill(target_date)
    input_field.press("Tab")

    page.get_by_role("button", name="Left Align").click()
    page.get_by_text("発送済商品").click()
    page.get_by_text("FBAのみ").click()
    page.get_by_role("button", name="検索").click()
    # [Fix] 検索結果のロードを待ってからダウンロードリンクを押す
    page.wait_for_timeout(3000)

    with page.expect_download() as download_info:
        page.get_by_role("link", name="売れたものリストのダウンロード").click()
    download = download_info.value
    save_path = os.path.join(DOWNLOAD_DIR, download.suggested_filename)
    download.save_as(save_path)
    print(f"プライスター CSVダウンロード完了: {save_path}")
    show_sample_rows(save_path)
    return save_path


def show_sample_rows(path):
    """GOQ_SHOW_SAMPLE_ROWS=5 のとき、CSVの最新行をログに出す（データ確認用）"""
    count = int(os.getenv("GOQ_SHOW_SAMPLE_ROWS", "0") or 0)
    if count <= 0:
        return
    import csv
    with open(path, encoding="cp932", errors="replace", newline="") as f:
        rows = list(csv.reader(f))
    if len(rows) < 2:
        print("プライスター CSV にデータ行がありません")
        return
    header = rows[0]
    cols = [header.index(c) for c in ["注文日", "AmazonOrderId", "商品名", "SKU", "配送経路", "売れた個数", "販売価格"] if c in header]
    print(f"プライスター CSV: {len(rows) - 1} 行 / 最新 {count} 行（CSVの末尾）:")
    print("  | " + " | ".join(header[i] for i in cols))
    for r in rows[-count:]:
        print("  | " + " | ".join((r[i] if i < len(r) else "")[:40] for i in cols))


HEADLESS = os.getenv("GOQ_HEADLESS", "").strip() == "1"


def open_page(playwright: Playwright):
    """GitHub Actions（GOQ_HEADLESS=1）では自前でブラウザを起動し、ローカルでは起動中の Chrome に接続する"""
    if HEADLESS:
        browser = playwright.chromium.launch(headless=True)
        ctx = browser.new_context(locale="ja-JP", timezone_id="Asia/Tokyo", accept_downloads=True)
        # トレース（画面・通信・操作の記録）を取り、失敗したときだけ logs/ に保存する
        ctx.tracing.start(screenshots=True, snapshots=True, sources=False)
        return browser, ctx.new_page()
    try:
        browser = playwright.chromium.connect_over_cdp("http://localhost:9222")
    except Exception as e:
        raise RuntimeError(
            f"Chrome (port 9222) への接続に失敗しました: {e}\n"
            "Chrome を --remote-debugging-port=9222 で起動してください。"
        ) from e
    # 既存タブのフレーム状態に依存しないよう、常に新規タブで操作する
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    return browser, ctx.new_page()


def run(playwright: Playwright) -> None:
    # GoQ の CSV は直前の GshippingDataDownload.py が保存したもの（処理済のみ）を使う
    recent_goq_csv = find_recent_csv()
    if not recent_goq_csv and HEADLESS:
        raise RuntimeError(
            "GoQ の CSV が見つかりません。先に GshippingDataDownload.py を実行してください"
            "（GitHub Actions では絞り込み対策済みの GshippingDataDownload.py の CSV を使います）"
        )

    browser, page = open_page(playwright)
    failed = False
    try:
        if recent_goq_csv:
            print(f"GoQ CSV は GshippingDataDownload.py の出力を使います: {recent_goq_csv}")
        else:
            # GoQ（ローカルで GshippingDataDownload.py の CSV がない場合のみ）
            login_goq(page)
            page.locator("a:has(i.icon-order)").click()
            handle_popups(page)
            page.get_by_role("link", name="全て", exact=True).first.click()

            page.get_by_role("row", name="受注ステータス 新規受付 発送前入金待ち Amazon").get_by_label("", exact=True).uncheck()
            page.get_by_role("checkbox", name="処理済", exact=True).check()

            page.get_by_role(
                "cell", name=re.compile(r"-- \d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}")
            ).locator("#s_day_type").select_option("a59")
            page.get_by_role("button", name="昨日").click()
            page.get_by_role("button", name="絞り込む").click()

            print("検索結果を読み込んでいます...")
            page.wait_for_timeout(5000)
            page.wait_for_load_state("networkidle")

            download_goq_csv(page)

        # プライスター
        download_pricetar_csv(page)

        print(f"\nダウンロード完了。{DOWNLOAD_DIR} 内のCSVを確認してください。")
        print("次に integrated_sales_automation.py を実行するとシートに書き込まれます。")
    except Exception:
        failed = True
        raise
    finally:
        if HEADLESS:
            try:
                if failed:
                    os.makedirs("logs", exist_ok=True)
                    path = os.path.join("logs", f"sales_trace_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip")
                    page.context.tracing.stop(path=path)
                    print(f"失敗時のトレースを保存しました: {path}（https://trace.playwright.dev で開けます）")
                else:
                    page.context.tracing.stop()
            except Exception as exc:
                print(f"トレースの保存に失敗しました: {exc}")
        try:
            page.close()
        except Exception as exc:
            print(f"Page close failed after downloads completed: {exc}")
        if HEADLESS:
            browser.close()


with sync_playwright() as playwright:
    run(playwright)
