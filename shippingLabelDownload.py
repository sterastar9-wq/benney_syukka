import os
import sys

if os.getenv("GOQ_ALLOW_LEGACY_LABEL_DOWNLOAD") != "1":
    print(
        "Blocked: shippingLabelDownload.py is a legacy bulk label-data export path.\n"
        "Use scripts/goq_flow_guard.py and the reviewed carrier-by-carrier print flow instead.\n"
        "If this legacy export is explicitly required, set GOQ_ALLOW_LEGACY_LABEL_DOWNLOAD=1 for that one command."
    )
    sys.exit(2)

import os
from playwright.sync_api import Playwright, sync_playwright
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

DOWNLOAD_DIR = "送り状ダウンロード"

# 各配送業者と送り状フォーマットの対応
# format の値は GoQ の <select> の <option value="..."> を F12 で確認して設定してください
#   e-飛伝Ⅲ  → 佐川、佐川120サイズ以上
#   B2クラウド → ヤマト、コンパクト、ネコポス徳島
CARRIERS = [
    {"name": "佐川",              "format": "ehiden_ver3"},
    {"name": "ヤマト",            "format": "b2_cloud"},
    {"name": "コンパクト",        "format": "b2_cloud"},
    {"name": "ネコポス徳島",      "format": "b2_cloud"},
    {"name": "佐川120サイズ以上", "format": "ehiden_ver3"},
]

os.makedirs(DOWNLOAD_DIR, exist_ok=True)


def login_goq(page):
    page.goto(LOGIN_URL)
    page.locator("#login_id").fill(USER_ID)
    page.locator("#login_pw").fill(PASSWORD)
    page.get_by_role("button", name="認証する").click()
    page.locator("#seq_id").fill(SEQ_ID)
    page.locator("#seq_pw").fill(SEQ_PW)
    page.get_by_role("button", name="ログイン", exact=True).click()
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


def accept_dialog_safely(dialog):
    try:
        dialog.accept()
    except Exception as exc:
        print(f"ダイアログ承認をスキップしました: {exc}")


def download_carrier_label(page, carrier_name: str, format_option: str):
    """指定キャリアタブに移動し、ピッキングリスト→送り状データの順にダウンロードする"""
    # 注文数バッジが存在しない（件数ゼロ）場合はスキップ
    carrier_link = page.locator(
        f'xpath=//a[contains(@class,"order-tabs__link") and normalize-space(text()[1])="{carrier_name}"]'
    )
    if carrier_link.locator(".order-tabs__badge").count() == 0:
        print(f"\n--- {carrier_name}: 注文なし。スキップします。 ---")
        return

    print(f"\n--- {carrier_name} の処理を開始 ---")

    # 1. キャリアタブをクリック
    #    <a> 内に件数スパン（例: <span>23</span>）が含まれるため accessible name が "佐川 23" になる。
    #    XPath で最初のテキストノードのみを比較することで件数に関係なく正確にマッチさせる。
    page.locator(
        f'xpath=//a[contains(@class,"order-tabs__link") and normalize-space(text()[1])="{carrier_name}"]'
    ).click()
    page.wait_for_load_state("networkidle")

    # 2. ピッキングリスト（出荷担当者用CSV）ダウンロード
    page.get_by_text("全ての受注", exact=True).click()
    page.locator("#trader_s3").select_option("customize_csv_6")

    with page.context.expect_page() as new_page_info:
        page.get_by_role("button", name="出力").nth(1).click()

    new_page = new_page_info.value
    with new_page.expect_download() as download_info:
        pass

    download = download_info.value
    save_path = os.path.join(DOWNLOAD_DIR, f"{carrier_name}_picking_{download.suggested_filename}")
    download.save_as(save_path)
    new_page.close()
    print(f"ピッキングリストダウンロード完了: {save_path}")

    # 3. 送り状データダウンロード
    page.get_by_text("全ての受注", exact=True).click()
    page.locator("#trader_s").select_option(format_option)

    with page.context.expect_page() as new_page_info:
        page.locator('button[name="B020"]').click()

    new_page = new_page_info.value
    with new_page.expect_download() as download_info:
        pass

    download = download_info.value
    save_path = os.path.join(DOWNLOAD_DIR, f"{carrier_name}_{download.suggested_filename}")
    download.save_as(save_path)
    new_page.close()
    print(f"送り状データダウンロード完了: {save_path}")


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
        # 出力時に確認ダイアログが出る場合に自動承認する
        page.on("dialog", accept_dialog_safely)

        login_goq(page)
        page.locator("a:has(i.icon-order)").click()
        handle_popups(page)

        for carrier in CARRIERS:
            download_carrier_label(page, carrier["name"], carrier["format"])

        print(f"\n全業者のダウンロード完了。{DOWNLOAD_DIR} フォルダを確認してください。")
    finally:
        page.close()


with sync_playwright() as playwright:
    run(playwright)
