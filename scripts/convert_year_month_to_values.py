"""G-出荷用シートの C列（年）・D列（月）の関数を、表示中の数値に置き換える

  python scripts/convert_year_month_to_values.py          # 確認のみ（件数を表示、書き込みなし）
  python scripts/convert_year_month_to_values.py --apply  # 実際に置き換える

対象は C列が YEAR( 、D列が MONTH( を含む関数の行と、数字が文字として入っている行（'2025' など）。
計算結果が数値でない行（エラー・空欄）は変更しない。
何度実行しても、変換済みの行は対象外になるだけで結果は変わらない。
"""
import argparse
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import GshippingDataDownload as g  # noqa: E402  (シート接続・リトライ処理を共用)

CHUNK_ROWS = 5000
REQUEST_INTERVAL_SECONDS = 2  # Sheets API の上限（1分あたり読み取り60回）に当たらないよう間隔を空ける


def call(request, label):
    """429（回数上限）のときは1分待ってやり直す。それ以外は共通のリトライ処理に任せる"""
    for attempt in range(1, 6):
        try:
            result = g.execute_with_retry(request, label)
            time.sleep(REQUEST_INTERVAL_SECONDS)
            return result
        except Exception as e:
            if "429" not in str(e) or attempt == 5:
                raise
            print(f"  {label}: API の回数上限に達したため 65 秒待ちます（{attempt}/5）")
            time.sleep(65)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_digit_text(value):
    return isinstance(value, str) and value.strip().isdigit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="実際に書き込む（指定しなければ確認のみ）")
    args = parser.parse_args()

    api = g.build_sheets_api()
    sheet_id, sheet = g.SHEET_ID, g.SHEET_NAME
    last = g.find_last_data_row(api)
    print(f"対象: {g.SHEET_DATA_START_ROW}〜{last} 行目 / モード: {'書き込み' if args.apply else '確認のみ'}")

    total_target = total_written = total_skipped = total_values = total_blank = total_other = total_text = 0
    for start in range(g.SHEET_DATA_START_ROW, last + 1, CHUNK_ROWS):
        end = min(start + CHUNK_ROWS - 1, last)
        rng = f"'{sheet}'!C{start}:D{end}"
        formulas = call(api.values().get(
            spreadsheetId=sheet_id, range=rng, valueRenderOption="FORMULA"), f"Read formulas {start}-{end}"
        ).get("values", [])
        shown = call(api.values().get(
            spreadsheetId=sheet_id, range=rng, valueRenderOption="UNFORMATTED_VALUE"), f"Read values {start}-{end}"
        ).get("values", [])

        new_rows, changed, skipped, values_rows, blank_rows, other_rows, text_rows = [], 0, 0, 0, 0, 0, 0
        for i in range(end - start + 1):
            f_row = formulas[i] if i < len(formulas) else []
            v_row = shown[i] if i < len(shown) else []
            f_c = f_row[0] if len(f_row) > 0 else ""
            f_d = f_row[1] if len(f_row) > 1 else ""
            v_c = v_row[0] if len(v_row) > 0 else ""
            v_d = v_row[1] if len(v_row) > 1 else ""
            out_c, out_d = f_c, f_d
            is_target = (
                (isinstance(f_c, str) and "YEAR(" in f_c.upper())
                or (isinstance(f_d, str) and "MONTH(" in f_d.upper())
            )
            text_numbers = (
                not is_target
                and (is_digit_text(f_c) or is_digit_text(f_d))
                and (is_digit_text(f_c) or is_number(f_c))
                and (is_digit_text(f_d) or is_number(f_d))
            )
            if text_numbers:
                out_c, out_d = int(str(f_c).strip()), int(str(f_d).strip())
                changed += 1
                text_rows += 1
            elif is_target:
                if is_number(v_c) and is_number(v_d):
                    out_c, out_d = int(v_c), int(v_d)
                    changed += 1
                else:
                    skipped += 1
            elif f_c == "" and f_d == "":
                blank_rows += 1
            elif is_number(f_c) and is_number(f_d):
                values_rows += 1
            else:
                other_rows += 1
                if other_rows <= 2:
                    print(f"    その他の例（{start + i} 行目）: C={f_c!r:.40} D={f_d!r:.40} / 表示 C={v_c!r:.20} D={v_d!r:.20}")
            new_rows.append([out_c, out_d])

        total_target += changed + skipped
        total_skipped += skipped
        total_values += values_rows
        total_blank += blank_rows
        total_other += other_rows
        total_text += text_rows
        if changed and args.apply:
            # 変換しない行も元の内容（関数/値）をそのまま書き戻すので、範囲をまとめて1回で更新できる
            call(api.values().update(
                spreadsheetId=sheet_id, range=rng, valueInputOption="USER_ENTERED", body={"values": new_rows}
            ), f"Write values {start}-{end}")
            total_written += changed
        print(f"  {start}〜{end} 行目: 変換対象 {changed}（うち文字の数字 {text_rows}） / 据え置き {skipped} / 既に数値 {values_rows} "
              f"/ 空欄 {blank_rows} / その他 {other_rows}")

    print(f"合計: 変換対象 {total_target}（うち文字の数字 {total_text}） / 変換{'済み' if args.apply else '予定'} "
          f"{total_written if args.apply else total_target - total_skipped} / 据え置き {total_skipped} "
          f"/ 既に数値 {total_values} / 空欄 {total_blank} / その他 {total_other}")


if __name__ == "__main__":
    main()
