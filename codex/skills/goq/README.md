# GoQ Skills

GoQ関連のスキルをまとめたディレクトリです。

- `skills/goq-amazon-routing`: Amazon振分、配送業者/ステータス移動、個口数、日時指定チェック
- `skills/goq-shipping-label-print-flow`: ピッキングリスト/送り状印刷フロー、印刷前チェック、Sagawa 120+ 関連

## Credentials

Use Windows Credential Manager, not local `.env` files.

Create Generic Credentials with these target names:

- `GOQ_LOGIN_1`: GoQ first login step
- `GOQ_LOGIN_2`: GoQ second login step
- `GOQ_SMARTCLUB`: Sagawa Smart Club / e-Hiden III login

Do not store passwords in skill files, chat, command history, screenshots, logs, or local `.env` files.

Use `node .\goq_cdp_runner.mjs credentials-status` to verify presence without printing passwords.
