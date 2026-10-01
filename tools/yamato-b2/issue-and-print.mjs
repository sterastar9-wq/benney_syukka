#!/usr/bin/env node
// B2クラウドの「3.印刷内容の確認」画面で送り状を発行し、送り状プリンタに印刷する（ベニー様フロー 4 の発行・印刷）。
// 発行開始を押すと出荷データは「発行済み」になり送り状番号が確定する（元に戻せない）。そのため押す前に次を確かめる:
//   - 画面が print_check.html（3.印刷内容の確認）であること
//   - 用紙を指定どおりに設定できたこと（--paper multi-a4 | multi-a5 | nekopos）
//   - 「今回発行する送り状と件数 合計 N件」が --expect-count と一致すること
// 発行後は、印刷プレビュー（またはPDFビューア→印刷プレビュー）でプリンタ名・白黒・両面OFFを確かめてから印刷する。
// 想定と違う画面になったら印刷せずに撮影して止まる。結果は .o11y/yamato-b2/issue-logs/ に記録する。
//
//   node tools/yamato-b2/issue-and-print.mjs --expect-count 1 --paper multi-a4 --printer ヤマト [--port 9223] [--preview-only]
//
// 前提: 取込み結果画面で発行する行だけを選び「印刷内容の確認へ」を押した状態（import-and-print.mjs の後）。

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../lib/env.mjs';
import { connectOrOpen, listTargets, wait } from '../lib/cdp.mjs';
import { configurePrintPreview, Session } from '../local-picking/print.mjs';

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

const PAPER = {
  'multi-a4': { paper: '0', multi: '2', label: 'マルチ用紙（A4）' },
  'multi-a5': { paper: '0', multi: '1', label: 'マルチ用紙（A5）' },
  nekopos: { paper: '5', multi: null, label: 'ネコポス用紙' },
};

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || process.env.GOQ_CDP_PORT || 9223);
const expectCount = Number(args['expect-count']);
const paperKey = String(args.paper || '');
const printer = typeof args.printer === 'string' ? args.printer : '';
const press = args['preview-only'] !== true;
const LOG_DIR = path.join('.o11y', 'yamato-b2', 'issue-logs');
const SHOT_DIR = path.join('.o11y', 'yamato-b2', 'screenshots');
const log = { startedAt: new Date().toISOString(), args, steps: [] };
const step = (name, detail = {}) => { log.steps.push({ name, at: new Date().toISOString(), detail }); };
const finish = (code, error) => {
  if (error) log.error = error;
  log.finishedAt = new Date().toISOString();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `${log.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: !error, logFile: path.resolve(file), ...log }, null, 2));
  process.exit(code);
};

if (!Number.isInteger(expectCount) || expectCount < 1 || !PAPER[paperKey] || !printer) {
  console.error('使い方: node tools/yamato-b2/issue-and-print.mjs --expect-count <件数> --paper <multi-a4|multi-a5|nekopos> --printer <プリンタ名の一部> [--preview-only]');
  process.exit(2);
}

const page = await connectOrOpen(port, 'about:blank', t => t.url.includes('newb2web.kuronekoyamato.co.jp'));
const dialogs = [];
// 発行の確認ダイアログだけ進める。それ以外の内容のダイアログは閉じず（キャンセルし）記録する
page.onDialog = d => { dialogs.push(d); return /発行|開始|印刷/.test(d.message || ''); };
await page.send('Page.enable');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = async name => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (!r?.result?.data) return null;
  const file = path.join(SHOT_DIR, `${name}-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
};

try {
  // 1. 画面と件数・用紙の確認
  const url = await page.url();
  if (!url.includes('/print_check.html')) finish(3, `「3.印刷内容の確認」の画面ではありません: ${url}`);
  const want = PAPER[paperKey];
  const set = await page.eval(`(() => {
    const pick = (name, value) => {
      const el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
      if (!el) return false;
      if (!el.checked) el.click();
      return el.checked;
    };
    const paperOk = pick('ink_laser_printPaper', ${JSON.stringify(want.paper)});
    const multiOk = ${want.multi === null ? 'true' : `pick('multi_paper_flg', ${JSON.stringify(want.multi)})`};
    const text = String(document.body.innerText).replace(/[\\s]+/g, ' ');
    const total = (text.match(/合計\\s*(\\d+)\\s*件/) || [])[1];
    return { paperOk, multiOk, total: total === undefined ? null : Number(total) };
  })()`);
  await wait(1000);
  const recheck = await page.eval(`(() => {
    const text = String(document.body.innerText).replace(/[\\s]+/g, ' ');
    return { total: Number((text.match(/合計\\s*(\\d+)\\s*件/) || [])[1] ?? NaN), paper: document.querySelector('input[name=ink_laser_printPaper]:checked')?.value, multi: document.querySelector('input[name=multi_paper_flg]:checked')?.value };
  })()`);
  step('checked print confirmation', { paper: want.label, set, recheck, expectCount });
  if (!set.paperOk || !set.multiOk || recheck.paper !== want.paper) finish(3, `用紙を「${want.label}」にできませんでした`);
  if (recheck.total !== expectCount) finish(3, `発行件数が想定と違います（画面 ${recheck.total}件 / 想定 ${expectCount}件）。発行しません。`);
  step('screenshot before issue', { file: await shot('before-issue') });

  // 2. 発行開始
  const beforeIds = new Set((await listTargets(port)).map(t => t.id));
  await page.clickSelector('#start_print');
  step('clicked issue start', {});

  // 3. 発行後に出てくるもの（印刷プレビュー / PDFビューア / 画面遷移）を待つ
  let found = null;
  for (let i = 0; i < 90 && !found; i++) {
    await wait(1000);
    const targets = await listTargets(port);
    const fresh = targets.filter(t => !beforeIds.has(t.id));
    const preview = targets.find(t => t.type === 'page' && t.url.startsWith('chrome://print/'));
    const viewer = fresh.find(t => t.type === 'iframe' && t.url.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai'));
    if (preview) found = { kind: 'print-preview', target: preview };
    else if (viewer) found = { kind: 'pdf-viewer', target: viewer };
    if (i % 10 === 9) step('waiting after issue', { seconds: i + 1, url: await page.url().catch(() => ''), fresh: fresh.map(t => t.type + ' ' + t.url.slice(0, 100)) });
  }
  step('after issue', { dialogs, found: found ? { kind: found.kind, url: found.target.url.slice(0, 160) } : null, url: await page.url().catch(() => '') });
  if (!found) finish(4, '発行後に印刷プレビューもPDFも見つかりませんでした。画面を確認してください（発行は済んでいる可能性があります）。', step('screenshot after issue', { file: await shot('after-issue') }));

  // 4. 印刷（PDFビューアならツールバーの印刷ボタンから印刷プレビューを開く）
  if (found.kind === 'pdf-viewer') {
    const viewer = await Session.connect(found.target.webSocketDebuggerUrl);
    await viewer.send('Runtime.enable', {}, 10000);
    await wait(2000);
    const clicked = await viewer.eval(`(() => {
      const b = document.querySelector('pdf-viewer')?.shadowRoot?.querySelector('viewer-toolbar#toolbar, viewer-toolbar, #toolbar')?.shadowRoot?.querySelector('cr-icon-button#print, #print');
      if (!b) return false; b.click(); return true;
    })()`);
    viewer.close();
    step('clicked pdf viewer print', { clicked });
    if (!clicked) finish(4, 'PDFビューアの印刷ボタンが見つかりません（発行は済んでいます）。');
  }
  const printed = await configurePrintPreview(port, { printer, color: 'bw', duplex: false, press, screenshotDir: SHOT_DIR });
  step(press ? 'printed shipping labels' : 'verified label print preview without printing', printed);
  step('screenshot after print', { file: await shot('after-print') });
  finish(0);
} catch (error) {
  step('screenshot on error', { file: await shot('error') });
  finish(1, String(error?.stack || error));
}
