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

if (failed) {
  console.error(`${failed} 件の不一致があります`);
  process.exit(1);
}
console.log('Smart Pick と一致しました');
