import re
import os
import sys
from playwright.sync_api import Playwright, sync_playwright, expect
from datetime import datetime, timedelta
from dotenv import load_dotenv

# --- .envから設定を読み込む ---
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_SCRIPT_DIR, '.env'))

# --- 設定値 ---
LOGIN_URL         = os.getenv("GOQ_LOGIN_URL")
USER_ID           = os.getenv("GOQ_USER_ID")
PASSWORD          = os.getenv("GOQ_PASSWORD")
SEQ_ID            = os.getenv("GOQ_SEQ_ID")
SEQ_PW            = os.getenv("GOQ_SEQ_PW")
FOLDER_ID         = os.getenv("GDRIVE_FOLDER_ID")
PRICETAR_EMAIL    = os.getenv("PRICETAR_EMAIL")
PRICETAR_PASSWORD = os.getenv("PRICETAR_PASSWORD")
FUKA_BOOK_ID      = os.getenv("FUKA_BOOK_ID")

DOWNLOAD_DIR = "販売データダウンロード"

if not os.path.exists(DOWNLOAD_DIR):
    os.makedirs(DOWNLOAD_DIR)

def upload_to_drive(page, file_path):
    """『新規』ボタンからファイルを選択してアップロードする手順"""
    print(f"ドライブへアップロード開始: {file_path}")

    page.goto(f"https://drive.google.com/drive/folders/{FOLDER_ID}")
    page.wait_for_url(f"**/folders/{FOLDER_ID}**", timeout=15000)

    page.get_by_role("button", name=re.compile(r"新規")).click()

    with page.expect_file_chooser() as fc_info:
        page.get_by_role("menuitem", name="ファイルをアップロード").click()

    file_chooser = fc_info.value
    absolute_path = os.path.abspath(file_path)
    file_chooser.set_files(absolute_path)

    print("アップロード中...")
    page.wait_for_timeout(8000)
    print("アップロード終了")

def update_inventory_data(page):
    """GASカスタムタブとメニューを識別して操作する"""
    print("スプレッドシートの在庫データを更新します...")

    page.goto(f"https://docs.google.com/spreadsheets/d/{FUKA_BOOK_ID}/edit?gid=533858072#gid=533858072")

    try:
        page.wait_for_selector("text=不買商品更新", timeout=30000)
        page.get_by_text("不買商品更新").click()
        print("カスタムタブをクリックしました")
    except Exception:
        print("カスタムタブが見つかりませんでした")
        return

    page.wait_for_selector("text=在庫データを更新・同期する", timeout=10000)
    page.get_by_text("在庫データを更新・同期する").click()

    page.get_by_role("button", name="OK").click()

    print("在庫データの更新・同期リクエストが完了しました。")

def login_goq(page):
    """GoQSystemへのログイン処理"""
    page.goto(LOGIN_URL)
    page.locator("#login_id").fill(USER_ID)
    page.locator("#login_pw").fill(PASSWORD)
    page.get_by_role("button", name="認証する").click()
    page.locator("#seq_id").fill(SEQ_ID)
    page.locator("#seq_pw").fill(SEQ_PW)
    page.get_by_role("button", name="ログイン", exact=True).click()
    page.get_by_role("button", name="同意してGoQSystemを利用します").click()

def handle_popups(page):
    """お知らせポップアップの閉じる処理"""
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

def download_page_csv(page):
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

    print(f"ダウンロード完了: {save_path}")
    new_page.close()

    upload_to_drive(page, save_path)


def download_pricetar_list(page):
    """プライスターの売れたものリストをダウンロード"""
    print("プライスターのリストダウンロードを開始します...")
    page.goto("https://jp2.pricetar.com/entry/login?")

    if page.locator("text=ログイン").count() > 0:
        page.get_by_role("textbox", name="メールアドレス").fill(PRICETAR_EMAIL)
        page.get_by_role("textbox", name="パスワード").fill(PRICETAR_PASSWORD)
        page.get_by_role("button", name="ログイン").click()

    page.goto("https://jp2.pricetar.com/seller/orders/orderlist")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y/%m/%d")
    input_field = page.locator("#jquery-ui-datepicker-from")
    input_field.click()
    input_field.press("Control+a")
    input_field.fill(yesterday)
    input_field.press("Tab")

    page.get_by_role("button", name="Left Align").click()
    page.get_by_text("発送済商品").click()
    page.get_by_text("FBAのみ").click()
    page.get_by_role("button", name="検索").click()

    with page.expect_download() as download_info:
        page.get_by_role("link", name="売れたものリストのダウンロード").click()
    download = download_info.value

    save_path = os.path.join(DOWNLOAD_DIR, download.suggested_filename)
    download.save_as(save_path)

    print(f"プライスターのリストダウンロード完了: {save_path}")

    upload_to_drive(page, save_path)

def run(playwright: Playwright) -> None:
    try:
        browser = playwright.chromium.connect_over_cdp("http://localhost:9222")
    except Exception as e:
        raise RuntimeError(
            f"Chrome (port 9222) への接続に失敗しました: {e}\n"
            "Chrome を --remote-debugging-port=9222 で起動してください。"
        ) from e

    # 既存タブのフレーム状態に依存しないよう、常に新規タブで操作する
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    page = ctx.new_page()

    try:
        # 1. GoQ処理
        login_goq(page)
        page.get_by_role("link", name=" 受注管理").click()
        handle_popups(page)
        page.get_by_role("link", name="全て", exact=True).first.click()

        page.get_by_role("checkbox", name="キャンセル").uncheck()
        page.get_by_role("cell", name=re.compile(r"-- \d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}")).locator("#s_day_type").select_option("a59")
        page.get_by_role("button", name="昨日").click()
        page.get_by_role("button", name="絞り込む").click()

        download_page_csv(page)

        # 2. プライスター処理
        download_pricetar_list(page)

        # 3. スプレッドシート同期処理
        update_inventory_data(page)
    finally:
        page.close()

with sync_playwright() as playwright:
    run(playwright)
