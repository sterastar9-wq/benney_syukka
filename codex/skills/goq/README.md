# GoQ Skills

GoQ関連のスキル・ルールの置き場所（ベニー様版）。

- `.claude/skills/goq-shipping-label-print-flow/SKILL.md`: ピッキングリスト/送り状印刷フロー、印刷前チェック、B2クラウドCSV経路、Sagawa 120+ 関連（Claude Code スキル。ランナーの必須ルールでもある）
- `.claude/skills/benny-picking-print/SKILL.md`: 注文CSVからピッキングリストを単体で作って印刷する
- `codex/skills/goq/skills/goq-amazon-routing`: Amazon振分、配送業者/ステータス移動、個口数、日時指定チェック
- `codex/memories/goq-print-flow-rules.md`: 印刷フローのルールメモ（ランナーの必須ルール）

## Credentials

認証情報はリポジトリ直下の `.env` に置く（`.env.example` 参照）。Windows 資格情報マネージャーは使わない。

- GoQ: `GOQ_LOGIN_URL` / `GOQ_USER_ID` / `GOQ_PASSWORD` / `GOQ_SEQ_ID` / `GOQ_SEQ_PW`
- ヤマトビジネスメンバーズ: `YAMATO_BENY_HISSU` / `YAMATO_BENY_NINNI` / `YAMATO_BENY_PASSWORD`

パスワードをスキル、チャット、コマンド履歴、スクリーンショット、ログに書かない。
設定されているかの確認は `npm run goq:login -- --check` / `npm run yamato:login -- --check`（値は表示しない）。
