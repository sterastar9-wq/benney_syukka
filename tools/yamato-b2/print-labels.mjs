#!/usr/bin/env node
// ベニー様フロー 4 の送り状印刷を、間を空けずに一気に行う統合スクリプト。
//   取込み（import-and-print.mjs）→ 取込み結果の確認 → 「印刷内容の確認へ」→ 発行・印刷（issue-and-print.mjs）
//
//   node tools/yamato-b2/print-labels.mjs --handoff <引き継ぎJSON> [--port 9223] [--air-notice-approved] [--preview-only] [--reimport] [--picking-confirmed]
//
// 分けて実行していた 2026-10-01 に、取込み結果画面を 30 分ほど放置して B2 がシステムエラー（スクリプトエラー）になったため、
// 送り状が作られる一連の操作はこの 1 本で行う。ゲート:
//   - ピッキングリスト → 送り状 の順序（import-and-print.mjs の checkPickingEvidence。GoQ 側 run log の printed picking list が必要）
//   - 取込み結果が「対象件数 / 対象件数」でエラー行なし
//   - 「印刷内容の確認へ」で出る「重要なお知らせ」（航空危険物の確認 air_shipment_notice.html）は、--air-notice-approved が無ければ
//     内容を記録して止まる。続行の判断はオペレーター（リチウム電池・エアゾール等が無いことの確認）
//   - 確認画面の件数・用紙・送信先は issue-and-print.mjs が検証する
// 結果は引き継ぎファイルの yamato.* と .o11y/yamato-b2/label-runs/ に記録する。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { connectOrOpen, wait } from '../lib/cdp.mjs';
import { labelPrinterForStatus } from '../lib/printers.mjs';

loadEnv();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join('.o11y', 'yamato-b2', 'label-runs');
const SHOT_DIR = path.join('.o11y', 'yamato-b2', 'screenshots');
// ステータスごとの B2 用紙（issue-and-print.mjs の --paper）
const PAPER_BY_STATUS = { nekoposu: 'nekopos', takkyubin: 'multi-a4', compact: 'multi-a4' };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const port = String(args.port || process.env.GOQ_CDP_PORT || 9223);
const run = { startedAt: new Date().toISOString(), args, steps: [] };
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `${run.startedAt.replace(/[:.]/g, '-')}.json`);
const save = () => fs.writeFileSync(logFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
const step = (name, detail = {}) => { run.steps.push({ name, at: new Date().toISOString(), detail }); save(); console.error(`[yamato-b2/print-labels] ${name}`); };
const finish = (code, error) => {
  if (error) run.error = error;
  run.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ ok: !error, logFile: path.resolve(logFile), ...run }, null, 2));
  process.exit(code);
};

if (typeof args.handoff !== 'string') {
  console.error('使い方: node tools/yamato-b2/print-labels.mjs --handoff <引き継ぎJSON> [--port 9223] [--air-notice-approved] [--preview-only] [--reimport] [--picking-confirmed]');
  process.exit(2);
}

const handoffPath = path.resolve(args.handoff);
const readHandoff = () => JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
const updateHandoff = patch => {
  const h = readHandoff();
  h.yamato = { ...(h.yamato || {}), ...patch };
  fs.writeFileSync(handoffPath, `${JSON.stringify(h, null, 2)}\n`, 'utf8');
  return h;
};

function runChild(script, childArgs) {
  const result = spawnSync(process.execPath, [path.join(HERE, script), ...childArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout || '';
  const start = stdout.indexOf('{');
  let json = null;
  if (start >= 0) { try { json = JSON.parse(stdout.slice(start)); } catch { json = null; } }
  return { status: result.status, json, stdoutTail: stdout.slice(-2000), stderrTail: (result.stderr || '').slice(-2000) };
}

async function mouseClick(page, selector, { inIframe = null } = {}) {
  const point = await page.eval(`(() => {
    const root = ${inIframe ? `document.querySelector(${JSON.stringify(inIframe)})?.contentDocument` : 'document'};
    const el = root?.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const base = ${inIframe ? `document.querySelector(${JSON.stringify(inIframe)}).getBoundingClientRect()` : '{ x: 0, y: 0 }'};
    return { x: base.x + r.x + r.width / 2, y: base.y + r.y + r.height / 2 };
  })()`);
  if (!point) throw new Error(`要素が見つかりません: ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return point;
}

const shot = async (page, name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (!r?.result?.data) return null;
  const file = path.join(SHOT_DIR, `${name}-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
};

const handoff = readHandoff();
const baseStatus = String(handoff.statusKey || '').replace(/-amazon$/, '');
const paper = PAPER_BY_STATUS[baseStatus];
const printer = labelPrinterForStatus(baseStatus) || handoff.labelPrinter;
const expectCount = (handoff.targets || []).length;
run.handoff = { file: handoffPath, statusKey: handoff.statusKey, csv: handoff.csv, targets: expectCount, blocked: (handoff.blockedOrders || []).length, paper, printer };
if (!paper || !printer || expectCount < 1) finish(2, `引き継ぎファイルからステータス・用紙・プリンタ・件数を決められません: ${JSON.stringify(run.handoff)}`);

// 1. 取込み（ピッキング証跡・再取込みのゲートは import-and-print.mjs 側）
const importArgs = ['--handoff', handoffPath, '--port', port];
if (args.reimport === true) importArgs.push('--reimport');
if (args['picking-confirmed'] === true) importArgs.push('--picking-confirmed');
const imported = runChild('import-and-print.mjs', importArgs);
const importRun = imported.json || {};
step('import finished', { status: imported.status, error: importRun.error, pickingEvidence: importRun.pickingEvidence, counts: importRun.importResult?.counts, errorRows: importRun.importResult?.errorRows, logFile: importRun.logFile, stderrTail: imported.status === 0 ? undefined : imported.stderrTail });
if (imported.status !== 0 || importRun.error) finish(3, `取込みで止まりました: ${importRun.error || imported.stderrTail || imported.stdoutTail}`);
const counts = importRun.importResult?.counts?.[0];
if (!counts || counts.selected !== expectCount || counts.total !== expectCount) finish(3, `取込み結果の件数が対象と違います（画面 ${JSON.stringify(counts)} / 対象 ${expectCount}件）。発行しません。`);
if (importRun.importResult?.errorRows?.length) finish(3, `取込み結果にエラー行があります: ${JSON.stringify(importRun.importResult.errorRows)}`);

// 2. 取込み結果 → 印刷内容の確認へ（間を空けない）
const page = await connectOrOpen(Number(port), 'about:blank', t => t.url.includes('newb2web.kuronekoyamato.co.jp'));
const dialogs = [];
page.onDialog = d => { dialogs.push(d); step('javascript dialog', d); return false; };
await page.send('Page.enable');
try {
  const state = await page.eval(String.raw`(() => { const t = document.body.innerText.replace(/\s+/g, ' '); return { url: location.href, selected: (t.match(/現在選択中のデータ：(\d+) \/ (\d+) 件/) || []).slice(1).map(Number) }; })()`);
  step('import result screen', state);
  if (!state.url.includes('ex_import_result_display.html')) finish(3, `取込み結果の画面ではありません: ${state.url}`);
  if (state.selected[0] !== expectCount || state.selected[1] !== expectCount) finish(3, `取込み結果の選択件数が対象と違います: ${state.selected.join('/')} / 対象 ${expectCount}`);

  await mouseClick(page, '#confirm_issue_btn2');
  step('clicked confirm issue', {});
  let outcome = null;
  for (let i = 0; i < 30 && !outcome; i++) {
    await wait(1000);
    const now = await page.eval(String.raw`(() => {
      const fr = document.querySelector('.fancybox-wrap iframe');
      let notice = null;
      try {
        const d = fr?.contentDocument;
        if (d && d.querySelector('#airline_equipped_sub')) notice = { src: fr.src, text: d.body.innerText.replace(/\s+/g, ' ').slice(0, 600), buttons: Array.from(d.querySelectorAll('a[id], button')).map(b => b.id + ':' + (b.innerText || '').trim()).filter(Boolean) };
      } catch {}
      return { url: location.href, notice };
    })()`);
    if (now.url.includes('print_check.html')) outcome = { kind: 'print-check' };
    else if (now.url.includes('system_error')) outcome = { kind: 'system-error', url: now.url };
    else if (now.notice) outcome = { kind: 'air-notice', notice: now.notice };
  }
  step('after confirm click', { outcome, dialogs });
  if (!outcome) finish(4, '「印刷内容の確認へ」を押しても画面が変わりませんでした。', step('screenshot', { file: await shot(page, 'confirm-no-change') }));
  if (outcome.kind === 'system-error') finish(4, 'B2 がシステムエラーになりました。取込みからやり直してください。');

  if (outcome.kind === 'air-notice') {
    updateHandoff({ airNotice: { seenAt: new Date().toISOString(), text: outcome.notice.text, approved: args['air-notice-approved'] === true } });
    if (args['air-notice-approved'] !== true) {
      step('screenshot', { file: await shot(page, 'air-notice') });
      finish(5, '「重要なお知らせ」（航空危険物の確認）が出ました。品目にリチウム電池・エアゾール等が含まれないことをオペレーターが確認し、続行するなら --air-notice-approved を付けて取込みからやり直してください（放置すると B2 がエラーになります）。');
    }
    await mouseClick(page, '#airline_equipped_sub', { inIframe: '.fancybox-wrap iframe' });
    step('accepted air shipment notice by operator approval', { text: outcome.notice.text.slice(0, 200) });
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) { await wait(1000); ok = (await page.url()).includes('print_check.html'); }
    if (!ok) finish(4, '「伝票発行」を押しても印刷内容の確認画面になりませんでした。', step('screenshot', { file: await shot(page, 'after-air-notice') }));
  }
  updateHandoff({ confirmedAt: new Date().toISOString() });
} catch (error) {
  step('screenshot', { file: await shot(page, 'error') });
  finish(1, String(error?.stack || error));
}

// 3. 発行・印刷（件数・用紙・送信先の検証は issue-and-print.mjs）
const issueArgs = ['--expect-count', String(expectCount), '--paper', paper, '--printer', printer, '--port', port];
if (args['preview-only'] === true) issueArgs.push('--preview-only');
const issued = runChild('issue-and-print.mjs', issueArgs);
const issueRun = issued.json || {};
const printedStep = (issueRun.steps || []).find(s => /printed shipping labels|verified label print preview/.test(s.name));
step('issue finished', { status: issued.status, ok: issueRun.ok, error: issueRun.error, logFile: issueRun.logFile, printed: printedStep?.detail, stderrTail: issued.status === 0 ? undefined : issued.stderrTail });
if (issued.status !== 0 || !issueRun.ok) finish(6, `発行・印刷で止まりました: ${issueRun.error || issued.stderrTail || issued.stdoutTail}`);
updateHandoff({
  printed: args['preview-only'] !== true,
  printedAt: new Date().toISOString(),
  issueLog: issueRun.logFile,
  issuedCount: expectCount,
  issuedPrinter: printedStep?.detail?.destination,
  labelRunLog: path.resolve(logFile),
});
finish(0);
