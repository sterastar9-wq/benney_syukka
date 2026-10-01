#!/usr/bin/env node
// B2クラウド用CSVの突合ロジックの回帰テスト（合成データのみ。お客様情報なし）
import assert from 'node:assert/strict';
import { parseCsv, verifyLabelCsvText, decodeCsvBuffer } from './lib/label-csv.mjs';
import { rewriteB2Csv, encodeSjisNarrow } from './yamato-b2/rewrite-b2-csv.mjs';

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

// 7〜10. 取込み前の書き換え（出荷予定日・品名コード）
{
  // 98列の行を作る（1列目 お客様管理番号、5列目 出荷予定日、27/29列目 品名コード、28列目 品名に全角文字）
  const makeRow = (customerNo, code1, code2 = '') => {
    const cols = Array(98).fill('');
    cols[0] = customerNo; cols[1] = 'A'; cols[4] = '2026/09/23'; cols[26] = code1; cols[28] = code2;
    for (const i of [8, 10, 11, 15, 19, 21, 22, 24, 39, 41]) cols[i] = 'x';
    return cols;
  };
  const sjisName = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]); // 「テスト」（全角。バイト列のまま残ること）
  const toBytes = rows => Buffer.concat(rows.flatMap(cols => {
    const parts = cols.map((v, i) => (i === 27 ? sjisName : Buffer.from(v, 'latin1')));
    const joined = [];
    parts.forEach((p, i) => { if (i) joined.push(Buffer.from(',')); joined.push(p); });
    return [...joined, Buffer.from('\r\n')];
  }));
  // GoQ は品名コード欄に商品SKUを入れる。SKUと商品コードが違う商品（実例: PRO TEC シャンプー）でも正しく引けること
  const picking = [
    { 'GoQ管理番号': '500', '商品SKU': 'SKU-A', '商品コード': 'SHARED-CODE' },
    { 'GoQ管理番号': '500', '商品SKU': 'SKU-B', '商品コード': 'SHARED-CODE' },
    { 'GoQ管理番号': '501', '商品SKU': 'SKU-X', '商品コード': 'CODE-X' },
  ];
  const codes = new Map([['sku-a', 'ﾃｽﾄA(1)1111'], ['sku-b', 'ﾃｽﾄB(2)2222']]);

  // 7. 2品の注文: 出荷予定日と品名コード1・2だけ変わり、他の列（全角の品名）はバイト列のまま
  const ok2 = rewriteB2Csv({ bytes: toBytes([makeRow('500-1', 'SKU-A', 'SKU-B')]), pickingOrders: picking, hinmeiCodes: codes, shipDate: '2026/10/01' });
  assert.equal(ok2.ok, true, JSON.stringify(ok2.problems));
  const out = decodeCsvBuffer(ok2.bytes).text.split('\r\n')[0].split(',');
  assert.equal(out.length, 98);
  assert.equal(out[4], '2026/10/01');
  assert.equal(out[26], 'ﾃｽﾄA(1)1111');
  assert.equal(out[28], 'ﾃｽﾄB(2)2222');
  assert.equal(out[27], 'テスト');
  assert.deepEqual(encodeSjisNarrow('ｱ(1)'), Buffer.from([0xb1, 0x28, 0x31, 0x29]));

  // 8. 品名コード未登録 → 発行は止めず（B2のエラーではない）、GoQの値のまま残して警告
  const missingCode = rewriteB2Csv({ bytes: toBytes([makeRow('501-1', 'SKU-X')]), pickingOrders: picking, hinmeiCodes: codes, shipDate: '2026/10/01' });
  assert.equal(missingCode.ok, true);
  assert.equal(missingCode.blocked.length, 0);
  assert.equal(missingCode.importRows, 1);
  assert.match(missingCode.warnings[0].kind, /未登録/);
  assert.equal(decodeCsvBuffer(missingCode.bytes).text.split(/\r?\n/)[0].split(',')[26], 'SKU-X');

  // 9. 25文字を超える品名コード → 止まる
  const tooLong = rewriteB2Csv({ bytes: toBytes([makeRow('500-1', 'SKU-A', 'SKU-B')]), pickingOrders: picking, hinmeiCodes: new Map([['sku-a', 'ｱ'.repeat(26)], ['sku-b', 'ﾃｽﾄB(2)2222']]), shipDate: '2026/10/01' });
  assert.equal(tooLong.ok, true);
  assert.match(tooLong.warnings[0].kind, /25文字/);
  assert.equal(decodeCsvBuffer(tooLong.bytes).text.split(/\r?\n/)[0].split(',')[26], 'SKU-A');

  // 10. 並び順が逆でも、欄の値（SKU）で商品を特定する。どの商品にも一致しない値なら止まる
  const swapped = rewriteB2Csv({ bytes: toBytes([makeRow('500-1', 'SKU-B', 'SKU-A')]), pickingOrders: picking, hinmeiCodes: codes, shipDate: '2026/10/01' });
  assert.equal(swapped.ok, true, JSON.stringify(swapped.problems));
  const swappedOut = decodeCsvBuffer(swapped.bytes).text.split(/\r?\n/)[0].split(',');
  assert.equal(swappedOut[26], 'ﾃｽﾄB(2)2222');
  assert.equal(swappedOut[28], 'ﾃｽﾄA(1)1111');
  const unknown = rewriteB2Csv({ bytes: toBytes([makeRow('500-1', 'SKU-ZZZ')]), pickingOrders: picking, hinmeiCodes: codes, shipDate: '2026/10/01' });
  assert.equal(unknown.ok, true);
  assert.match(unknown.warnings[0].kind, /一致する商品/);

  // 11. B2の必須項目（ご依頼主・請求先）が空の注文は送り状を発行しない: 取込み用CSVから外し、blocked に理由を載せる
  const noSender = makeRow('502-1', 'SKU-A');
  noSender[21] = ''; noSender[22] = ''; noSender[24] = ''; noSender[39] = ''; noSender[41] = '';
  const blockedRun = rewriteB2Csv({ bytes: toBytes([makeRow('500-1', 'SKU-A', 'SKU-B'), noSender]), pickingOrders: [...picking, { 'GoQ管理番号': '502', '商品SKU': 'SKU-A', '商品コード': 'X' }], hinmeiCodes: codes, shipDate: '2026/10/01' });
  assert.equal(blockedRun.ok, true);
  assert.equal(blockedRun.rows, 2);
  assert.equal(blockedRun.importRows, 1);
  assert.deepEqual(blockedRun.blocked.map(b => b.goqId), ['502']);
  assert.match(blockedRun.blocked[0].reasons[0], /ご依頼主郵便番号・ご依頼主住所・ご依頼主名・請求先顧客コード・運賃管理番号/);
  assert.equal(decodeCsvBuffer(blockedRun.bytes).text.split(/\r?\n/).filter(Boolean).length, 1);
}

console.log(JSON.stringify({ ok: true, tests: 11 }));
