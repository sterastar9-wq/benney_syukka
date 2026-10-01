#!/usr/bin/env node
// ローカル版ピッキング集計が Smart Pick と同じ結果になるかの回帰テスト。
// fixtures/expected-smart-pick.json は、Smart Pick の元コード（page.tsx の処理 + usePickingLogic.ts + PickingList.tsx のソート）を
// fixtures/orders.csv と fixtures/master.csv（どちらも合成データ）で実行した結果。
//   npm run test:picking

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPickingReport, checkMasterLayout, decodeCsvBuffer, formatJanDisplay, parseMasterCsv, parseOrdersCsv, readCsvBytes } from './picking-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const exceptions = { janCheckSkus: {}, janDisplayExceptions: {} };

const { orders } = parseOrdersCsv(decodeCsvBuffer(readCsvBytes(path.join(FIXTURES, 'orders.csv'))));
const sheet = parseMasterCsv(fs.readFileSync(path.join(FIXTURES, 'master.csv'), 'utf8'));
const r = buildPickingReport(orders, sheet, exceptions);
const actual = {
  shippingMethod: r.shippingMethod,
  shippingNotes: r.shippingNotes,
  uniqueOrderCount: r.uniqueOrderCount,
  pickingList: r.pickingList,
  totalSingleUnits: r.totalSingleUnits,
  multi: r.multiItemOrders.map(i => [i['GoQ管理番号'], i['商品SKU'], i.表示個数, formatJanDisplay(i.JANコード, exceptions)]),
  janCheck: r.janCheckOrders.map(i => [i['GoQ管理番号'], i['商品SKU'], i.計算後総個数, formatJanDisplay(i.JANコード, exceptions)]),
  anomaly: r.anomalyOrders.map(i => [i['GoQ管理番号'], i['商品SKU'], i['個数']]),
  janDisplay: r.pickingList.map(l => [formatJanDisplay(l.JANコード, exceptions), l.親JANコード ? formatJanDisplay(l.親JANコード, exceptions) : null]),
};
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected-smart-pick.json'), 'utf8'));

let failed = 0;
for (const key of Object.keys(expected)) {
  const same = JSON.stringify(expected[key]) === JSON.stringify(actual[key]);
  if (!same) {
    failed++;
    console.error(`NG ${key}\n  expected: ${JSON.stringify(expected[key])}\n  actual:   ${JSON.stringify(actual[key])}`);
  } else {
    console.log(`OK ${key}`);
  }
}

// 列ずれ検知: 3行目の見出しが1列ずれたマスタは不合格になること
const shifted = sheet.map(row => ['', ...row]);
const layoutOk = checkMasterLayout(sheet).ok === true && checkMasterLayout(shifted).ok === false;
console.log(`${layoutOk ? 'OK' : 'NG'} masterLayoutCheck`);
if (!layoutOk) failed++;

// 3品以上の注文リスト（ベニー様独自）: 3品の注文だけが載り、品名コードはSKUで引ける
{
  const base = { 'GoQ管理番号': '', '送付先氏名': 'テスト 様', '個数': '1', '商品コード': '', 'SKU管理番号': '' };
  const many = buildPickingReport([
    { ...base, 'GoQ管理番号': '9001', '商品SKU': 'A-1', '商品名': 'x' },
    { ...base, 'GoQ管理番号': '9001', '商品SKU': 'B-12', '商品名': 'y' },
    { ...base, 'GoQ管理番号': '9001', '商品SKU': 'ZZZ', '商品名': 'z' },
    { ...base, 'GoQ管理番号': '9002', '商品SKU': 'A-1', '商品名': 'x' },
    { ...base, 'GoQ管理番号': '9002', '商品SKU': 'B-12', '商品名': 'y' },
  ], sheet, exceptions, { hinmeiCodes: new Map([['a-1', 'ﾃｽﾄ(1)1001']]) }).manyItemOrders;
  const ok = many.length === 1 && many[0].GoQ管理番号 === '9001' && many[0].items.length === 3
    && many[0].items[0].品名コード === 'ﾃｽﾄ(1)1001' && many[0].items[2].品名コード === '';
  console.log(`${ok ? 'OK' : 'NG'} manyItemOrders`);
  if (!ok) failed++;
}

if (failed) {
  console.error(`${failed} 件の不一致があります`);
  process.exit(1);
}
console.log('Smart Pick と一致しました');
