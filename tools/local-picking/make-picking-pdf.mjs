#!/usr/bin/env node
// ピッキングリストのPDFだけを作る（印刷しない）。
//
//   node tools/local-picking/make-picking-pdf.mjs --csv <GoQの注文CSV> | --latest-download
//        [--master-csv <GoQ全データをCSVで保存したもの>]   省略時は Sheets API でベニー様シートを読む
//        [--out-dir .o11y/local-picking]  [--port 9223]    --port 指定時はデバッグ用Chromeで、省略時はヘッドレスChromeでPDF化
//        [--exceptions tools/local-picking/exceptions.json]
//   --latest-download: ダウンロードフォルダで一番新しいGoQの注文CSV（商品名・個数・商品SKUの列があるもの）を使う

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLocalPickingPdf } from './build.mjs';
import { masterConfigFromEnv } from './master-sheet.mjs';
import { decodeCsvBuffer, parseOrdersCsv, readCsvBytes } from './picking-core.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

// ダウンロードフォルダで一番新しいGoQの注文CSVを探す
function latestGoqCsv(dir = path.join(os.homedir(), 'Downloads')) {
  const candidates = fs.readdirSync(dir)
    .filter(name => name.toLowerCase().endsWith('.csv'))
    .map(name => path.join(dir, name))
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file } of candidates) {
    try {
      const { missingHeaders } = parseOrdersCsv(decodeCsvBuffer(readCsvBytes(file)));
      if (!['商品名', '個数', '商品SKU'].some(h => missingHeaders.includes(h))) return file;
    } catch { /* 読めないCSVは飛ばす */ }
  }
  return '';
}

const args = parseArgs(process.argv.slice(2));
if (args['latest-download']) {
  args.csv = latestGoqCsv();
  if (!args.csv) {
    console.error(JSON.stringify({ ok: false, error: 'ダウンロードフォルダにGoQの注文CSVが見つかりません' }));
    process.exit(1);
  }
}
if (!args.csv || args.csv === true) {
  console.error('使い方: node tools/local-picking/make-picking-pdf.mjs --csv <ピッキングCSV> [--master-csv <file>] [--out-dir <dir>] [--port <n>]');
  process.exit(2);
}
const masterConfig = masterConfigFromEnv();
if (args['master-csv']) masterConfig.masterCsv = path.resolve(String(args['master-csv']));

try {
  const { summary } = await buildLocalPickingPdf({
    csvPath: path.resolve(String(args.csv)),
    outDir: path.resolve(String(args['out-dir'] || path.join('.o11y', 'local-picking'))),
    port: args.port ? Number(args.port) : null,
    masterConfig,
    exceptionsFile: args.exceptions ? path.resolve(String(args.exceptions)) : undefined,
  });
  const { anomalySkus, ...printable } = summary;
  console.log(JSON.stringify({ ok: true, ...printable, anomalySkuCount: anomalySkus.length }, null, 2));
  if (summary.anomalyOrders) console.error(`注意: マスタに無い注文が ${summary.anomalyOrders} 件あります（PDF末尾の異常検知リストを確認）`);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exit(1);
}
