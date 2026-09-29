"""GitHub Secrets（CLIENT_EMAIL / PRIVATE_KEY / TOKEN_URI / PRIVATE_KEY_ID）から credentials.json を作る"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, "credentials.json")


def main():
    missing = [k for k in ("CLIENT_EMAIL", "PRIVATE_KEY", "TOKEN_URI") if not os.environ.get(k, "").strip()]
    if missing:
        print(f"::error::Secret が未設定です: {', '.join(missing)}")
        sys.exit(1)

    # 貼り付け時に改行が \n という文字になっていても復元する
    private_key = os.environ["PRIVATE_KEY"].strip().strip('"').replace("\\n", "\n")
    if not private_key.endswith("\n"):
        private_key += "\n"
    info = {
        "type": "service_account",
        "client_email": os.environ["CLIENT_EMAIL"].strip(),
        "private_key": private_key,
        "token_uri": os.environ["TOKEN_URI"].strip(),
    }
    if os.environ.get("PRIVATE_KEY_ID", "").strip():
        info["private_key_id"] = os.environ["PRIVATE_KEY_ID"].strip()

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(info, f)

    # 秘密鍵として読めるか事前確認（中身は出力しない）
    from google.oauth2 import service_account

    service_account.Credentials.from_service_account_file(OUTPUT)
    print("credentials.json を作成しました")


if __name__ == "__main__":
    main()
