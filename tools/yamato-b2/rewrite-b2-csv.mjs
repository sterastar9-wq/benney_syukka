#!/usr/bin/env node
// GoQ が出力した送り状データCSV（B2クラウド基本レイアウト、見出しなし・98列・Shift_JIS）を、取り込む直前に書き換える。
//   - 5列目 出荷予定日  → 今日（日本時間）。B2クラウドは「本日〜30日後」以外を修正必要エラーにするため（2026-10-01 確認）
//   - 27列目 品名コード1 / 29列目 品名コード2 → data/hinmei-codes.csv の品名コード（例: ｵｰﾙﾄﾞｽﾊﾟｲｽ(1)5580、25文字以内）
// 品名コードは同じ注文のピッキング用CSV（GoQ管理番号・商品SKU・商品コードがある）から1品目・2品目のSKUを取って引く。
// 書き換える欄以外はバイト列のまま残す（Shift_JISの2バイト目は , " 改行 と重ならないので、バイト単位で列を区切れる）。
//
//   node tools/yamato-b2/rewrite-b2-csv.mjs --csv <B2用CSV> --picking-csv <ピッキング用CSV> [--date 2026/10/01] [--out <出力>]
//
// 問題があれば書き換えたファイルを作らずに終了コード1で止まる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCsvBuffer, loadHinmeiCodes, parseOrdersCsv, readCsvBytes } from '../local-picking/picking-core.mjs';

export const B2_COLUMN_COUNT = 98;
const COL = { customerNo: 0, shipDate: 4, itemCode1: 26, itemName1: 27, itemCode2: 28, itemName2: 29 };
export const HINMEI_CODE_MAX = 25;
// B2クラウドの必須項目（0始まりの列番号）。空だと取込み結果が「修正必要」になる。
// 2026-10-01 の取込み結果エラー（ご依頼主名・郵便番号・住所、請求先が未設定）と B2 の紐付け設定の「必須」表示から
export const B2_REQUIRED_COLUMNS = [
  [1, '送り状種類'],
  [8, 'お届け先電話番号'], [10, 'お届け先郵便番号'], [11, 'お届け先住所'], [15, 'お届け先名'],
  [19, 'ご依頼主電話番号'], [21, 'ご依頼主郵便番号'], [22, 'ご依頼主住所'], [24, 'ご依頼主名'],
  [39, '請求先顧客コード'], [41, '運賃管理番号'],
];
// GoQ は品名コード欄に商品SKUを先頭30文字で切って入れている（2026-10-01 本番で確認。商品コードではない）。
// この値で同じ注文の商品を特定する（並び順には頼らない）
const GOQ_ITEM_CODE_WIDTH = 30;

export function todayJst(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}/${get('month')}/${get('day')}`;
}

// 半角英数記号と半角カナだけを Shift_JIS にする（品名コード・日付用）。それ以外の文字は扱わない
export function encodeSjisNarrow(text) {
  const out = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp < 0x7f) out.push(cp);
    else if (cp >= 0xff61 && cp <= 0xff9f) out.push(0xa1 + (cp - 0xff61));
    else throw new Error(`Shift_JIS 1バイト文字にできない文字です: ${JSON.stringify(ch)} (${text})`);
  }
  return Buffer.from(out);
}

function splitLines(bytes) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      const end = i > start && bytes[i - 1] === 0x0d ? i - 1 : i;
      lines.push(bytes.subarray(start, end));
      start = i + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

function splitFields(line) {
  const fields = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === 0x2c) { fields.push(line.subarray(start, i)); start = i + 1; }
  }
  fields.push(line.subarray(start));
  return fields;
}

const ascii = buf => buf.toString('latin1');

export function rewriteB2Csv({ bytes, pickingOrders, hinmeiCodes, shipDate = todayJst(), maxLen = HINMEI_CODE_MAX }) {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(shipDate)) throw new Error(`出荷予定日の形式が違います: ${shipDate}`);
  if (bytes.includes(0x22)) throw new Error('B2用CSVに引用符が含まれています（想定外の形式）。書き換えを中止します。');
  const itemsByOrder = new Map();
  for (const item of pickingOrders) {
    const id = String(item['GoQ管理番号'] || '').trim();
    if (!id) continue;
    if (!itemsByOrder.has(id)) itemsByOrder.set(id, []);
    itemsByOrder.get(id).push(item);
  }
  const lookup = item => {
    for (const key of [item['商品SKU'], item['SKU管理番号'], item['商品コード']]) {
      const code = key && hinmeiCodes.get(String(key).trim().toLowerCase());
      if (code) return code;
    }
    return '';
  };

  // fatal: CSV全体の形式が想定外（書き換えを中止）。blocked: その注文は送り状を発行しない（取込み用CSVから外す）。
  // warnings: 発行はするが確認が必要（品名コードを引けず GoQ の元の値のまま、3品以上 など）
  const fatal = [];
  const warnings = [];
  const changes = [];
  const blockedById = new Map();
  const block = (goqId, customerNo, reason) => {
    if (!blockedById.has(goqId)) blockedById.set(goqId, { goqId, customerNo, reasons: [] });
    const entry = blockedById.get(goqId);
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  };
  const rowsOut = [];
  const lines = splitLines(bytes).filter(line => line.length > 0);
  lines.forEach((line, index) => {
    const rowNo = index + 1;
    const fields = splitFields(line);
    if (fields.length !== B2_COLUMN_COUNT) {
      fatal.push({ row: rowNo, kind: '列数が98ではない', columns: fields.length });
      return;
    }
    const customerNo = ascii(fields[COL.customerNo]).trim();
    const goqId = customerNo.split('-')[0];
    if (!goqId) { fatal.push({ row: rowNo, kind: 'お客様管理番号が空' }); return; }
    // B2クラウドの必須項目（空だと取込み結果で「修正必要」になり発行できない）
    const missing = B2_REQUIRED_COLUMNS.filter(([col]) => ascii(fields[col]).trim() === '').map(([, name]) => name);
    if (missing.length) block(goqId, customerNo, `B2の必須項目が空: ${missing.join('・')}`);

    const items = itemsByOrder.get(goqId) || [];
    const change = { row: rowNo, customerNo, goqId, shipDate: { from: ascii(fields[COL.shipDate]), to: shipDate }, codes: [] };
    fields[COL.shipDate] = Buffer.from(shipDate, 'latin1');
    if (!items.length) {
      warnings.push({ row: rowNo, customerNo, kind: 'ピッキング用CSVにこの注文が無いため品名コードは GoQ の値のまま' });
    } else {
      if (items.length > 2) warnings.push({ row: rowNo, customerNo, kind: '3品以上の注文（品名コードは先頭2品のみ。残りはピッキングリストの「3品以上の注文リスト」で確認）', items: items.length });
      const used = new Set();
      [COL.itemCode1, COL.itemCode2].forEach((col, slot) => {
        const goqValue = ascii(fields[col]).trim();
        if (!goqValue) return; // GoQ が入れていない欄（2品目が無い注文など）は触らない
        const head = v => String(v || '').trim().slice(0, GOQ_ITEM_CODE_WIDTH);
        const item = items.find((it, i) => !used.has(i) && head(it['商品SKU']) === goqValue)
          || items.find((it, i) => !used.has(i) && head(it['SKU管理番号']) === goqValue)
          || items.find((it, i) => !used.has(i) && head(it['商品コード']) === goqValue);
        const keep = kind => warnings.push({ row: rowNo, customerNo, slot: slot + 1, kind: `${kind}（品名コードは GoQ の値のまま）`, goq: goqValue });
        if (!item) { keep('GoQの品名コード欄の値に一致する商品がピッキング用CSVにありません'); return; }
        used.add(items.indexOf(item));
        const code = lookup(item);
        const sku = item['商品SKU'] || item['SKU管理番号'] || item['商品コード'] || '';
        if (!code) { keep(`品名コードが未登録（data/hinmei-codes.csv）: ${sku}`); return; }
        if ([...code].length > maxLen) { keep(`品名コードが${maxLen}文字を超えています: ${code}`); return; }
        try {
          fields[col] = encodeSjisNarrow(code);
          change.codes.push({ slot: slot + 1, sku, from: goqValue, to: code });
        } catch (error) {
          keep(String(error.message));
        }
      });
    }
    changes.push(change);
    const joined = [];
    fields.forEach((f, i) => { if (i) joined.push(Buffer.from([0x2c])); joined.push(f); });
    rowsOut.push({ goqId, bytes: Buffer.concat(joined) });
  });

  const crlf = Buffer.from([0x0d, 0x0a]);
  const kept = rowsOut.filter(r => !blockedById.has(r.goqId));
  const out = Buffer.concat(kept.flatMap(r => [r.bytes, crlf]));
  const blocked = Array.from(blockedById.values());
  return {
    ok: fatal.length === 0,
    bytes: out,
    rows: lines.length,
    importRows: kept.length,
    shipDate,
    changes,
    blocked,
    fatal,
    warnings,
    // 互換: 以前の呼び出し側が見ていた problems は fatal と同じ
    problems: fatal,
  };
}

export function rewriteB2CsvFile({ csvPath, pickingCsvPath, outPath, shipDate = todayJst(), hinmeiCodesFile }) {
  const bytes = fs.readFileSync(csvPath /* Buffer: Shift_JIS のまま扱う */);
  const { orders } = parseOrdersCsv(decodeCsvBuffer(readCsvBytes(pickingCsvPath)));
  const hinmeiCodes = loadHinmeiCodes(hinmeiCodesFile);
  const result = rewriteB2Csv({ bytes, pickingOrders: orders, hinmeiCodes, shipDate });
  const out = outPath || csvPath.replace(/\.csv$/i, '') + '.for-b2.csv';
  const write = result.ok && result.importRows > 0;
  if (write) fs.writeFileSync(out, Buffer.from(result.bytes)); // Shift_JIS のバイト列のまま保存
  const { bytes: _omit, ...summary } = result;
  return { ...summary, source: path.resolve(csvPath), pickingCsv: path.resolve(pickingCsvPath), out: write ? path.resolve(out) : null, hinmeiCodesLoaded: hinmeiCodes.size };
}

// ---- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[argv[i].slice(2)] = true;
    else { args[argv[i].slice(2)] = next; i++; }
  }
  if (typeof args.csv !== 'string' || typeof args['picking-csv'] !== 'string') {
    console.error('使い方: node tools/yamato-b2/rewrite-b2-csv.mjs --csv <B2用CSV> --picking-csv <ピッキング用CSV> [--date YYYY/MM/DD] [--out <file>]');
    process.exit(2);
  }
  try {
    const summary = rewriteB2CsvFile({ csvPath: args.csv, pickingCsvPath: args['picking-csv'], outPath: typeof args.out === 'string' ? args.out : undefined, shipDate: typeof args.date === 'string' ? args.date : undefined });
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exit(1);
    if (summary.blocked.length) console.error(`送り状を発行しない注文: ${summary.blocked.map(b => b.goqId).join(', ')}`);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error.message || error) }));
    process.exit(1);
  }
}
