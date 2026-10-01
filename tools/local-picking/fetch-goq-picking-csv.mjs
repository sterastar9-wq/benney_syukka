#!/usr/bin/env node
// GoQ の指定ステータスの注文から、ピッキング用CSV（カスタムCSV）を取得して保存する。読み取り専用。
// ステータス・配送業者・チェック項目などは一切変更しない（一覧を開いて、カスタムCSVを出力するだけ）。
//
//   node tools/local-picking/fetch-goq-picking-csv.mjs --stat 29 [--limit 30] [--port 9223]
//
// 前提: リモートデバッグ付きChrome（scripts\start-chrome-cdp.ps1）で GoQ にログイン済み（npm run goq:login）。
// 取得方法は goq-print-flow.mjs の exportPickingCsvToFile と同じ（/goq21/export/create_custom_csv.php → infile.php）。

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../lib/env.mjs';
import { connectOrOpen, waitUntil } from '../lib/cdp.mjs';

loadEnv();

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || process.env.GOQ_CDP_PORT || 9223);
const stat = String(args.stat || '');
const limit = Number(args.limit || 0);
const customId = String(process.env.GOQ_PICKING_CSV_CUSTOM_ID || '1');
if (!/^\d+$/.test(stat)) {
  console.error('使い方: node tools/local-picking/fetch-goq-picking-csv.mjs --stat <ステータス番号> [--limit N] [--port 9223]');
  process.exit(2);
}

const LIST_URL = `https://order.goqsystem.com/goq21/index_beta.php?stat=${stat}&s_day_type=&page=1`;

const page = await connectOrOpen(port, LIST_URL, t => t.url.includes('order.goqsystem.com/goq21'));
await page.enable();
await page.navigate(LIST_URL);
const listState = await waitUntil(async () => page.eval(`(() => {
  if (document.readyState !== 'complete') return false;
  if (/systemlogin|login/i.test(location.pathname)) return { login: true, url: location.href };
  const ids = Array.from(document.getElementsByName('order_number[]')).map(b => b.value);
  const text = document.body?.innerText || '';
  if (ids.length || /0\\s*件|0 \\/ 0件/.test(text)) return { login: false, url: location.href, ids, title: document.title };
  return false;
})()`), 30000, 500);
if (listState.login) {
  console.error(JSON.stringify({ ok: false, error: 'GoQ にログインしていません。npm run goq:login を実行してください。', url: listState.url }));
  process.exit(1);
}
const allIds = listState.ids;
const ids = limit > 0 ? allIds.slice(0, limit) : allIds;
if (!ids.length) {
  console.error(JSON.stringify({ ok: false, error: `stat=${stat} に注文がありません`, url: listState.url }));
  process.exit(1);
}

const result = await page.eval(`(async () => {
  const ids = ${JSON.stringify(ids)};
  const data = new URLSearchParams();
  data.set('trader_s3', 'customize_csv_${customId}');
  for (const id of ids) data.append('order_number[]', id);
  const createResponse = await fetch('/goq21/export/create_custom_csv.php?custom_id=${customId}', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data.toString(),
  });
  const html = await createResponse.text();
  const marker = 'infile.php?fname=';
  const at = html.indexOf(marker);
  if (!createResponse.ok || at < 0) return { ok: false, step: 'create', status: createResponse.status, html: html.slice(0, 300) };
  const fname = html.slice(at + marker.length).split('"')[0].split("'")[0].split(')')[0].trim();
  const csvResponse = await fetch('/goq21/infile.php?fname=' + encodeURIComponent(fname), { credentials: 'same-origin' });
  const bytes = new Uint8Array(await csvResponse.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { ok: csvResponse.ok, status: csvResponse.status, type: csvResponse.headers.get('content-type') || '', fname, size: bytes.length, base64: btoa(binary) };
})()`);
page.close?.();
if (!result.ok || !result.size) {
  console.error(JSON.stringify({ ok: false, error: 'カスタムCSVの取得に失敗しました', detail: { step: result.step, status: result.status, html: result.html } }));
  process.exit(1);
}

const outDir = path.join('.o11y', 'goq-unified-print-flow', 'downloads');
fs.mkdirSync(outDir, { recursive: true });
const file = path.resolve(outDir, `picking-stat${stat}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
fs.writeFileSync(file, Buffer.from(result.base64, 'base64'));
console.log(JSON.stringify({ ok: true, stat, customId, ordersInList: allIds.length, ordersExported: ids.length, csv: file, bytes: result.size, type: result.type }, null, 2));
