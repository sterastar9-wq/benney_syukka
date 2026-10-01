#!/usr/bin/env node
// GoQ の指定ステータスの注文から、送り状データCSV（B2クラウド形式）を出力して保存する。
// 注文データ（ステータス・配送業者・出荷日など）は変更しない。一覧で対象にチェックを入れ、送り状データ出力を行うだけ。
// テストや手動の段階確認用。本番は goq-print-flow.mjs の b2-csv モードが同じことを行う。
//
//   node tools/yamato-b2/export-b2-csv.mjs --stat 29 [--ids 17155,17154 | --limit 2] [--port 9223]
//
// 画面のお知らせモーダルがあっても動くように、座標クリックではなくページ内で
// 形式選択（#trader_s = b2_cloud）→ 出力ボタンの処理（フォーム送信）を行い、送信内容を fetch で取得する。

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../lib/env.mjs';
import { connectOrOpen, waitUntil } from '../lib/cdp.mjs';
import { decodeCsvBuffer, parseCsv } from '../lib/label-csv.mjs';

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
const format = process.env.GOQ_B2_CSV_FORMAT_VALUE || 'b2_cloud';
if (!/^\d+$/.test(stat)) {
  console.error('使い方: node tools/yamato-b2/export-b2-csv.mjs --stat <番号> [--ids a,b | --limit N]');
  process.exit(2);
}
const LIST_URL = `https://order.goqsystem.com/goq21/index_beta.php?stat=${stat}&s_day_type=&page=1`;

const page = await connectOrOpen(port, LIST_URL, t => t.url.includes('order.goqsystem.com/goq21'));
await page.navigate(LIST_URL);
const listIds = await waitUntil(async () => page.eval(`(() => {
  if (document.readyState !== 'complete') return false;
  if (/systemlogin/i.test(location.pathname)) return { login: true };
  const ids = Array.from(document.getElementsByName('order_number[]')).map(b => b.value);
  return ids.length ? { ids } : false;
})()`), 30000, 500);
if (listIds.login) {
  console.error(JSON.stringify({ ok: false, error: 'GoQ にログインしていません（npm run goq:login）' }));
  process.exit(1);
}
const wanted = typeof args.ids === 'string'
  ? args.ids.split(',').map(s => s.trim()).filter(Boolean)
  : listIds.ids.slice(0, Number(args.limit || 2));
const missing = wanted.filter(id => !listIds.ids.includes(id));
if (missing.length) {
  console.error(JSON.stringify({ ok: false, error: `stat=${stat} の一覧に無いGoQ番号: ${missing.join(',')}` }));
  process.exit(1);
}

const captured = await page.eval(`(async () => {
  const wanted = new Set(${JSON.stringify(wanted)});
  for (const box of document.getElementsByName('order_number[]')) {
    if (box.checked !== wanted.has(box.value)) box.click();
  }
  const checked = Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
  const select = document.querySelector('#trader_s');
  if (!select) return { ok: false, error: '#trader_s not found' };
  const options = Array.from(select.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
  const option = options.find(o => o.value === ${JSON.stringify(format)});
  if (!option) return { ok: false, error: 'B2クラウド形式が見つかりません', options };
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const submits = [];
  const serialize = form => ({ action: form.action, method: (form.method || 'get').toUpperCase(), body: new URLSearchParams(new FormData(form)).toString() });
  const origSubmit = HTMLFormElement.prototype.submit;
  const origOpen = window.open;
  HTMLFormElement.prototype.submit = function () { submits.push(serialize(this)); };
  window.open = () => null;
  const onSubmit = event => { submits.push(serialize(event.target)); event.preventDefault(); event.stopImmediatePropagation(); };
  document.addEventListener('submit', onSubmit, { capture: true });
  try {
    const button = document.querySelector('button[name="B020"]');
    if (button) button.click();
    if (!submits.length && typeof window.downcsv === 'function') window.downcsv({ isTrusted: false });
  } finally {
    HTMLFormElement.prototype.submit = origSubmit;
    window.open = origOpen;
    document.removeEventListener('submit', onSubmit, { capture: true });
  }
  if (!submits.length) return { ok: false, error: '出力のフォーム送信が起きませんでした', checked, option };
  const submit = submits[submits.length - 1];
  const init = { method: submit.method, credentials: 'same-origin' };
  let url = submit.action;
  if (submit.method === 'POST') { init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; init.body = submit.body; }
  else if (submit.body) url += (url.includes('?') ? '&' : '?') + submit.body;
  let response = await fetch(url, init);
  let type = response.headers.get('content-type') || '';
  if (/text\\/html/i.test(type)) {
    const html = await response.text();
    const links = Array.from(html.matchAll(/infile\\.php\\?fname=([^"')\\s]+)/g)).filter(m => {
      const lineStart = html.lastIndexOf('\\n', m.index) + 1;
      return !html.slice(lineStart, m.index).includes('//');
    });
    if (!links.length) return { ok: false, error: 'CSVへのリンクが見つかりません', html: html.slice(0, 400) };
    response = await fetch('/goq21/infile.php?fname=' + links[links.length - 1][1], { credentials: 'same-origin' });
    type = response.headers.get('content-type') || '';
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  // チェックは元に戻す（画面の状態を残さない）
  for (const box of document.getElementsByName('order_number[]')) if (box.checked) box.click();
  return { ok: response.ok, checked, option, action: submit.action.split('?')[0], type, size: bytes.length, base64: btoa(binary) };
})()`);
page.close?.();
if (!captured.ok || !captured.size) {
  console.error(JSON.stringify({ ok: false, ...captured, base64: undefined }, null, 2));
  process.exit(1);
}

const outDir = path.join('.o11y', 'goq-unified-print-flow', 'downloads');
fs.mkdirSync(outDir, { recursive: true });
const file = path.resolve(outDir, `b2-stat${stat}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
const bytes = Buffer.from(captured.base64, 'base64');
fs.writeFileSync(file, Buffer.from(bytes)); // Shift_JIS のバイト列のまま保存
const { text, encoding } = decodeCsvBuffer(bytes);
const rows = parseCsv(text).filter(r => r.some(c => String(c).trim() !== ''));
console.log(JSON.stringify({
  ok: true, stat, orders: captured.checked, format: captured.option, action: captured.action,
  csv: file, bytes: captured.size, encoding, rows: rows.length, columns: [...new Set(rows.map(r => r.length))],
}, null, 2));
