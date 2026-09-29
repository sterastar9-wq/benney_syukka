# GoQ Automation Agent Rules

## Operator Approval Policy

- GoQ automation work in this workspace does not require per-command approval when it is run through the Dockerized environment, for example `docker compose exec goq ...`, or when it is a normal local read/verification/review command needed for that work.
- Prefer Docker execution for autonomous GoQ work. Avoid host-side destructive operations. Do not delete, move, overwrite, or reset files outside the GoQ automation workspace unless the user explicitly asks for that specific action.
- Autonomous GoQ print work must use the reviewed wrapper: `docker compose exec goq npm run goq:print -- --status <status> --port 9223 --execute`. The wrapper must run the review after every flow and must not report success when review violations or unaccepted warnings remain.
- Ask the user before continuing if the same problem has failed to be solved three consecutive times.
- Ask the user before continuing if a task that is not expected to be long-running has taken more than three minutes.
- Long-running GoQ operations, Docker build/startup, browser waits, download waits, print-preview waits, and review checks may continue past three minutes when they are clearly progressing. If progress is unclear, ask the user before continuing.

## セッション開始時の必須確認

- GoQの送り状発行に入る前に、この `AGENTS.md` と `tools/goq-print-flow.README.md` を必ず読む。
- `goq-shipping-label-print-flow` skill と `C:\Users\tatsu\.codex\memories\goq-print-flow-rules.md` も、実行前のルールソースとして確認する。
- 実行ログには、必読ルールを読み込んだ事実を残す。
- レビュー付きラッパー `npm run goq:print -- ...` を標準経路にし、実行後にルール違反がないか必ず確認する。レビュー違反または未承認warningが残る場合は成功扱いにしない。

## 実行エージェントとレビューエージェント

- 実行エージェントは、作業開始時に `run.goal` として目的・対象ステータス・日付・対象範囲・必要な出力・成功条件を記録する。
- レビューエージェントは、必ず最初に `run.goal` を読み、目的を具体化してからレビューする。単に「印刷できたか」ではなく、宣言された goal に到達したかを判定する。
- レビューエージェントは、実行エージェントを goal へ戻す役割を持つ。wrong status、wrong date、対象範囲の逸脱、住所警告の未処理、プリンタ違い、発行確認漏れを見つけた場合は成功扱いにしない。
- 実行エージェントは、レビュー違反または未承認warningが残った場合、完了報告をせず、原因・修正方針・再実行範囲を報告する。

## 承認・作業範囲

- このリポジトリ内の読み取り・編集・構文チェック・レビューコマンドは、外部影響がなければ通常作業として実行する。
- `C:\Users\tatsu\.codex\memories` と `C:\Users\tatsu\.codex\skills` は、GoQ運用ルールとskill更新で頻繁に使う作業範囲として扱う。
- `C:\Users\tatsu\.codex\skills` へのスキル作成・更新・修正は、外部影響がない限り通常作業として進める。
- ネットワークアクセス、印刷、GoQ本番操作、外部API、グローバルインストール、プロセス停止、破壊的操作は引き続き慎重に扱う。

## 実装メモ

- 佐川120以外の印刷フロー実装は `tools/goq-print-flow.mjs`。
- 操作仕様・検証モード・DOM構造の詳細は `tools/goq-print-flow.README.md` を必ず確認する。
- 各ステータス共通の実行フロー、住所警告ゲート、ステータス差分、完了基準は `tools/goq-print-flow.CHECKLIST.md` を毎回確認する。runner はこのファイルを side effect 前の必須 rule material として run log に記録する。
- ピッキングCSVはブラウザのDownloadsへ落とすのではなく、GoQ CSV APIから取得して `.o11y/goq-unified-print-flow/downloads/` に保存する。
- ベニー様版では Smart Pick を使わない（Smart Pick は元版のGoQ全データを読むため）。`tools/local-picking/` でベニー様シート（ベニー様_ピッキング参照の `GoQ全データ` タブ）を読んでピッキングリストPDFを作り、新しいタブで開いてPDFビューアから `普通紙` に印刷する。
- `~/.codex` の共用スキル・メモリにある Smart Pick の手順は元版向け。ベニー様版ではこのファイルと `tools/local-picking/README.md` の手順を優先する。共用スキル・メモリは元版と共用なので書き換えない。
- 元版のGoQ全データ（データ管理② `1V_y-3QNZ0DLLdAG9NSgdn4S-934hhRUcQgNVc7Pxc4I`）は、読み先・書き込み先のどちらにも使わない。
- Chrome印刷プレビューは `chrome://print/` の別ターゲットで、`print-preview-sidebar` のShadow DOM配下を操作する。
- 中断後は、直前の `node.exe` が残っていないか確認し、該当する実行プロセスを停止してから続行する。
- ダッシュボードお知らせモーダルが出た場合は、表示内またはスクロール後に見えるチェックボックスをすべて確認し、`上記について確認しました` などのお知らせ確認ボタンを押して閉じてから受注一覧へ進む。スクロールが必要な場合はモーダル内をスクロールしてチェックする。

## 印刷基本ルール

### 印刷順序

- 必ず `ピッキングリスト -> 送り状` の順で印刷する。
- ピッキングリストと送り状はワンセット扱いにする。
- 送り状だけ、またはピッキングリストだけで完了扱いにしない。
- 出荷日と送り状番号が入ると注文は元ステータスから移動するため、標準順序は崩さず、送り状発行後に差分確認で未発行を検出する。
- 送り状発行前に、対象のGoQ番号・注文番号・ステータス・配送業者・出荷日・発行要求時刻を記録する。
- 送り状発行ダイアログ: 特にヤマト系（ヤマト・コンパクト・ネコポス）の送り状印刷/発行ボタン押下後にモーダル、JavaScriptダイアログ、エラー表示が出た場合は、内容を読み取り実行ログへ記録し、何も考えずにOKを押して先へ進まない。アラートは閉じる必要がある場合でも、閉じた後に停止して原因確認・修正・再実行判断へ進む。
- 送り状発行後は、事前対象と、送り状番号または発行済み表示が確認できた注文を突合する。PDF生成成功だけで全件発行済みと判断しない。
- 元ステータスから注文が消えた場合は、`全て` ステータスで発送日=今日に絞り込み、記録済みGoQ番号または注文番号を直接指定して確認する。
- 発行後も送り状番号または発行済み表示が確認できない対象は `送り状未発行/除外された可能性あり` として件数・詳細を必ず報告する。エラーレポートがある場合は `配送管理番号`（例: `183479-1`）をGoQ番号（例: `183479`）へ対応付ける。
- `--label-first` はユーザーが明示した場合の例外手段に限り、通常の除外検知策としては使わない。

### 送信先プリンタ

- ピッキングリスト: `普通紙`
- 佐川通常の送り状: `佐川`
- 佐川120サイズ以上の送り状: `佐川`
- ヤマト宅急便の送り状: `ヤマト/コンパクト`
- 宅急便コンパクトの送り状: `ヤマト/コンパクト`
- ネコポスの送り状: `ネコポス`

### 印刷前確認

- 印刷プレビューをスクリーンショットで確認する。
- 右側の送信先が意図したプリンタか確認する。
- ページ数が対象件数・帳票種別と大きく矛盾していないか確認する。
- 前回のプリンタ設定が残るため、毎回必ず送信先を確認する。
- 送り状印刷ではカラーを `白黒` にする。
- 送り状印刷では詳細設定を開き、`両面に印刷する` がOFFであることを確認する。
- 印刷ステップのログには、期待プリンタだけでなくChrome印刷プレビューで確認した実際の送信先を `destination` として残す。
- レビューでは、帳票種別・ステータスから決まる期待プリンタと、ログ上の実送信先 `destination` が一致することを必ず検証する。
- 佐川ステータスの送り状で `ヤマト/コンパクト` など別プリンタが送信先になっている場合は、印刷済みでも完了扱いにせずレビュー違反として報告する。

### 住所警告

- 各ステータスに入った直後、GoQ一覧の配送業者欄に `【住】` など住所警告が付いている注文を検出する。
- 住所警告がある注文は、送り状発行前に必ず送付先修正画面で確認・修正する。
- 修正後にGoQ一覧の表面上で `【住】` が残ることはあるため、それだけを未解決とは判断しない。
- 解決済みとは、送付先修正画面で安全な修正を保存した、またはWEB検索/外部検証で根拠が明確な修正・確認を行い、実行ログ上で修正済み・確認済みとして記録された状態を指す。
- 未解決とは、修正・検証後にも送り状発行時のエラーレポート等で引っかかる状態、またはユーザーが未解決として承認した状態を指す。
- 住所警告が未レビューの状態では、ピッキングリスト・送り状へ進まない。
- 修正不能または根拠不十分な住所警告は、一言メモに `住所不正` を記録してから未解決として印刷対象から除外する。未レビューの住所警告を回避して印刷へ進むための手段にしない。

### 住所正規化ルール

- 都道府県欄に入っている都道府県名を、住所1から重複していたら除去する。
- 全角数字は半角数字へ寄せる。
- 全角ハイフン・長音風の区切りは半角ハイフン `-` に寄せる。
- 番地のハイフンは削除しない。
- 電話番号のハイフンは削除しない。
- 電話番号は、明示的に必要がない限り変更しない。
- 住所1・住所2の分割は、住所1に市区町村＋町域、住所2に番地以降・建物名・会社名を寄せる。

例:

```text
修正前:
沖縄県 / 沖縄県豊見城市豊崎１－１１７８Fステージ豊崎パークフロント1003 / 株式会社ジャスミン

修正後:
沖縄県 / 豊見城市豊崎 / 1-1178 Fステージ豊崎パークフロント1003 株式会社ジャスミン
```

### 運用上の注意

- プリンタ設定の推測だけで印刷しない。
- 送信先プリンタが不明、または意図した送信先と違う場合は印刷しない。
- 印刷対象の除外、出荷日、送り状番号、配送業者のチェックが終わる前に印刷へ進まない。

## レビュー

- 実行後は `node tools/goq-run-review.mjs --latest` でランログをレビューする。
- レビューで違反が出た場合は、完了扱いにせず、修正・再実行・報告のいずれかに進む。

## Command Approval Policy

- すでに skill 化され、通常運用に組み込まれているローカル確認・検証・読取コマンドは、追加承認を求めずに実行する。
- `C:\Users\tatsu\.codex` 配下の skill・memory・設定確認・検証・修正作業は、外部影響がない限り通常作業として進める。
- `C:\Users\tatsu\.codex\skills` への skill 作成・更新・修正・検証は、GoQ 運用改善の通常作業として扱う。
- 承認を求めるのは、`.codex` 外のファイルを変更する操作、`.codex` 外へ副作用を及ぼす操作、ネットワーク送信、印刷、GoQ 本番操作、外部 API、依存関係インストール、破壊的な削除・移動、プロセス停止など、明確な外部影響または復旧困難な影響がある場合に限定する。
- ツール実行基盤がサンドボックス上の制約として承認を要求する場合は、その制約に従う。ただし、その場合も目的と影響範囲を短く明示し、同種作業で再承認が減るように適切な prefix rule を提案する。
