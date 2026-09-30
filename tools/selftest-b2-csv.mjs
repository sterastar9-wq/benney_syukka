#!/usr/bin/env node
// B2クラウド用CSVの突合ロジックの回帰テスト（合成データのみ。お客様情報なし）
import assert from 'node:assert/strict';
import { parseCsv, verifyLabelCsvText, decodeCsvBuffer } from './lib/label-csv.mjs';

const targets = [
  { goqId: '183479', orderNumber: '249-0000000-0000001' },
  { goqId: '183480', orderNumber: '249-0000000-0000002' },
];

// 1. 引用符・改行・CRLF を含む CSV を正しく分割する
const rows = parseCsv('a,"b,1","c""d"\r\n1,2,3\n');
assert.deepEqual(rows, [['a', 'b,1', 'c"d'], ['1', '2', '3']]);

// 2. 見出しあり・対象が全部ある・余分な行なし → ok
const okCsv = 'お客様管理番号,送り状種類,お届け先名\n183479,0,テスト太郎\n183480-1,0,テスト花子\n';
const ok = verifyLabelCsvText(okCsv, targets);
assert.equal(ok.ok, true, JSON.stringify(ok));
assert.equal(ok.dataRowCount, 2);
assert.equal(ok.unissued.length, 0);
assert.deepEqual(ok.header.slice(0, 2), ['お客様管理番号', '送り状種類']);

// 3. 対象が欠けている → ok=false、unissued に載る
const missing = verifyLabelCsvText('お客様管理番号,送り状種類\n183479,0\n', targets);
assert.equal(missing.ok, false);
assert.deepEqual(missing.unissued.map(t => t.goqId), ['183480']);

// 4. 対象外の行が混ざる → ok=false、unmatchedRows に載る
const extra = verifyLabelCsvText('183479,0\n183480,0\n999999,0\n', targets);
assert.equal(extra.ok, false);
assert.equal(extra.unmatchedRows.length, 1);
assert.equal(extra.header, null, 'headerless csv must not treat the first row as header');

// 5. 注文番号でも照合できる／複数個口の重複行は許容
const byOrder = verifyLabelCsvText('249-0000000-0000001,0\n249-0000000-0000001,0\n183480,0\n', targets);
assert.equal(byOrder.ok, true, JSON.stringify(byOrder));
assert.equal(byOrder.rowsPerTarget['183479'], 2);

// 6. Shift_JIS の復号
const sjis = Buffer.from([0x82, 0xa0, 0x2c, 0x31]); // 「あ,1」
const decoded = decodeCsvBuffer(sjis);
assert.equal(decoded.encoding, 'shift_jis');
assert.equal(decoded.text, 'あ,1');

console.log(JSON.stringify({ ok: true, tests: 6 }));
