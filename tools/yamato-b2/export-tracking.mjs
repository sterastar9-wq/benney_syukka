#!/usr/bin/env node
// ベニー様フロー 4 の後半（手順 52〜59）: B2クラウド「発行済データの検索」で出荷予定日＝今日のデータを検索し、
// 引き継ぎファイルの対象注文がすべて発行済み（送り状番号あり）であることを確かめてから、全選択 →「外部ファイルに出力」→
// 「ファイル出力」（見出しなし）で CSV をダウンロードして保存する。GoQ の「送り状番号取込」にそのまま渡す。
//
//   node tools/yamato-b2/export-tracking.mjs --handoffs <引き継ぎJSON>[,<引き継ぎJSON>...] [--port 9223] [--date YYYY/MM/DD] [--allow-extra]
//
// 止まる条件: 対象注文（お客様管理番号 = GoQ番号-枝番）が B2 の一覧に無い／送り状番号が無い、一覧に対象外の注文がある（--allow-extra で続行）、
// ダウンロードした CSV の行数・送り状番号が一覧と合わない。B2 の操作はこのスクリプトでは読み取りと CSV 出力だけ（データは変えない）。

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../lib/env.mjs';
import { CdpPage, listTargets, openTarget, wait, waitUntil } from '../lib/cdp.mjs';
import { decodeCsvBuffer } from '../lib/label-csv.mjs';
import { YAMATO_HOST, ensureYamatoLogin, readYamatoLoginState } from './login.mjs';

loadEnv();

const B2_HOST = 'newb2web.kuronekoyamato.co.jp';
const YBM_HOME = 'https://bmypage.kuronekoyamato.co.jp/bmypage/ME0001.htm';
const OUT_DIR = path.join('.o11y', 'yamato-b2', 'tracking-exports');
const LOG_DIR = path.join('.o11y', 'yamato-b2', 'tracking-export-logs');
const SHOT_DIR = path.join('.o11y', 'yamato-b2', 'screenshots');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

export function todayJst(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}/${get('month')}/${get('day')}`;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || process.env.GOQ_CDP_PORT || 9223);
const run = { startedAt: new Date().toISOString(), args, steps: [] };
for (const d of [OUT_DIR, LOG_DIR, SHOT_DIR]) fs.mkdirSync(d, { recursive: true });
const logFile = path.join(LOG_DIR, `${run.startedAt.replace(/[:.]/g, '-')}.json`);
const save = () => fs.writeFileSync(logFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
const step = (name, detail = {}) => { run.steps.push({ name, at: new Date().toISOString(), detail }); save(); console.error(`[yamato-b2/export-tracking] ${name}`); };
const finish = (code, error) => {
  if (error) run.error = error;
  run.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ ok: !error, logFile: path.resolve(logFile), ...run }, null, 2));
  process.exit(code);
};

if (typeof args.handoffs !== 'string') {
  console.error('使い方: node tools/yamato-b2/export-tracking.mjs --handoffs <引き継ぎJSON>[,<引き継ぎJSON>...] [--port 9223] [--date YYYY/MM/DD] [--allow-extra]');
  process.exit(2);
}
const handoffFiles = args.handoffs.split(',').map(f => path.resolve(f.trim())).filter(Boolean);
const handoffs = handoffFiles.map(f => ({ file: f, data: JSON.parse(fs.readFileSync(f, 'utf8')) }));
// 対象: 引き継ぎの targets（blockedOrders は送り状を発行していないので含めない）
const expected = new Map(); // customerNo prefix (GoQ番号) → { goqId, orderNumber, statusKey, file }
for (const h of handoffs) {
  if (h.data.yamato?.printed !== true) finish(2, `送り状が印刷済みになっていない引き継ぎファイルです: ${h.file}`);
  for (const t of h.data.targets || []) expected.set(String(t.goqId), { goqId: String(t.goqId), orderNumber: t.orderNumber, statusKey: h.data.statusKey, file: h.file });
}
run.expectedCount = expected.size;
const date = typeof args.date === 'string' ? args.date : todayJst();
if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) finish(2, `日付の形式が違います: ${date}`);

async function connectB2() {
  const targets = await listTargets(port);
  let target = targets.find(t => t.type === 'page' && t.url.includes(B2_HOST)) || targets.find(t => t.type === 'page' && t.url.includes(YAMATO_HOST));
  if (!target) target = await openTarget(port, YBM_HOME);
  const page = new CdpPage(target.webSocketDebuggerUrl, port, target.id);
  await page.enable();
  page.onDialog = d => { step('javascript dialog', d); return /TOPに戻ります|メインメニューに戻ります/.test(d.message); };
  return page;
}

async function ensureB2MainMenu(page) {
  const url = await page.url();
  if (url.includes(B2_HOST) && !/system_error|login/i.test(url)) {
    const text = await page.pageText(1500);
    if (!/システムエラー|ログイン画面へ/.test(text) && (!/ログイン/.test(text) || /ログアウト/.test(text))) {
      if (url.includes('main_menu.html')) return { via: 'already-main-menu' };
      // B2 内の別画面 → 「B2クラウド」リンクで TOP へ（確認ダイアログは onDialog が進める）
      await page.eval(`(() => { try { if (window.jQuery && jQuery.fancybox) jQuery.fancybox.close(); } catch {} return true; })()`);
      await wait(500);
      await page.clickSelector('#B2WebmenuEtc_href');
      const ok = await waitUntil(async () => (await page.url()).includes('main_menu.html'), 60000, 1000).catch(() => false);
      if (ok) { await wait(2500); return { via: 'b2-top-link' }; }
    }
  }
  const state = await readYamatoLoginState(page);
  if (!String(state.url).includes('bmypage.kuronekoyamato')) await page.navigate(YBM_HOME, 3000);
  run.login = await ensureYamatoLogin(page, { step });
  await page.navigate(YBM_HOME, 3000);
  const called = await page.eval(`(() => { try { ybmCommonJs.useService('06', '2'); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; } })()`);
  if (!called.ok) throw new Error(`B2クラウドを開けません: ${called.error}`);
  await waitUntil(async () => (await page.url()).includes('main_menu.html'), 90000, 1000);
  await wait(3000);
  return { via: 'useService(06)' };
}

const shot = async (page, name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (!r?.result?.data) return null;
  const file = path.join(SHOT_DIR, `${name}-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
};

const page = await connectB2();
try {
  step('entered b2 main menu', await ensureB2MainMenu(page));
  await page.clickSelector('#issue_search');
  await waitUntil(async () => (await page.url()).includes('issue_search.html'), 90000, 1000);
  await wait(2500);
  await page.eval(`(() => { for (const id of ['#shipment_plan_from', '#shipment_plan_to']) { const el = document.querySelector(id); el.value = ${JSON.stringify(date)}; el.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await page.clickSelector('#Search');
  await waitUntil(async () => page.eval(`typeof dataView !== 'undefined' && dataView.getItems().length > 0`), 30000, 500).catch(() => false);
  await wait(1500);
  // 1. 一覧（SlickGrid の dataView から全件。画面に描画されていない行も含む）
  const items = await page.eval(`dataView.getItems().map(it => ({ num: it.num, tracking: String(it.tracking_number || ''), type: String(it.service_type || ''), customerNo: String(it.shipment_number || ''), shipDate: String(it.shipment_date || '') }))`);
  const resultText = await page.eval(`document.body.innerText.replace(/\\s+/g, ' ').match(/検索結果：[^ ]+ 件/)?.[0] || null`);
  step('searched issued data', { date, resultText, items });
  const byGoq = new Map();
  for (const it of items) { const goqId = it.customerNo.split('-')[0]; if (!byGoq.has(goqId)) byGoq.set(goqId, []); byGoq.get(goqId).push(it); }
  const missing = [...expected.values()].filter(e => !byGoq.has(e.goqId));
  const noTracking = items.filter(it => !/^\d{4}-\d{4}-\d{4}$/.test(it.tracking));
  const extra = [...byGoq.keys()].filter(id => !expected.has(id));
  run.verification = { expected: expected.size, found: items.length, missing: missing.map(m => m.goqId), noTracking: noTracking.map(i => i.customerNo), extra };
  step('verified issued list against handoff targets', run.verification);
  if (missing.length) finish(3, `対象注文が B2 の発行済み一覧にありません（送り状未発行/除外された可能性あり）: ${missing.map(m => m.goqId).join(', ')}`);
  if (noTracking.length) finish(3, `送り状番号が無い行があります: ${noTracking.map(i => i.customerNo).join(', ')}`);
  if (extra.length && args['allow-extra'] !== true) finish(3, `引き継ぎファイルに無い注文が一覧にあります（--allow-extra で含めて出力できます）: ${extra.join(', ')}`);

  // 2. 全選択 → 外部ファイルに出力
  await page.eval(`(() => { const el = document.querySelector('input.allCheck'); if (!el.checked) el.click(); return true; })()`);
  await wait(800);
  const selectedRows = await page.eval(`grid.getSelectedRows().length`);
  step('selected all rows', { selectedRows });
  if (selectedRows !== items.length) finish(3, `全選択できていません（${selectedRows}/${items.length}）`);
  await page.clickSelector('#issue_data_btn');
  const popupOk = await waitUntil(async () => page.eval(`(() => { try { return !!document.querySelector('.fancybox-wrap iframe')?.contentDocument?.querySelector('#output_file'); } catch { return false; } })()`), 20000, 500).catch(() => false);
  if (!popupOk) finish(4, '「発行済データ外部出力」のポップアップが開きません。', step('screenshot', { file: await shot(page, 'export-popup-missing') }));
  const headerChecked = await page.eval(`(() => { const d = document.querySelector('.fancybox-wrap iframe').contentDocument; const cb = d.querySelector('#check_title'); if (cb.checked) cb.click(); return cb.checked; })()`);
  step('export popup ready', { headerChecked, note: '手順 58: 何も選択せず（見出しなし）ファイル出力' });

  // 3. ダウンロードを捕まえる（Browser.setDownloadBehavior で保存先を固定）
  const downloadDir = path.resolve(OUT_DIR);
  const events = [];
  page.onEvent = (method, params) => { if (/^Browser\.download/.test(method) || method === 'Page.downloadWillBegin') events.push({ method, params }); };
  const beh = await page.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true });
  if (beh.error) finish(4, `ダウンロード先を設定できません: ${JSON.stringify(beh.error)}`);
  const beforeFiles = new Set(fs.readdirSync(downloadDir));
  await page.eval(`(() => { const d = document.querySelector('.fancybox-wrap iframe').contentDocument; d.querySelector('#output_file').click(); return true; })()`);
  step('clicked file output', {});
  // 「ファイルダウンロード」ダイアログ（jQuery UI）: 「N件出力しました。」を確かめてから「ダウンロード」を押す（手順 59）
  const READ_DIALOG = `(() => { try { const d = document.querySelector('.fancybox-wrap iframe').contentDocument; const dlg = d.querySelector('.ui-dialog'); if (!dlg || !dlg.offsetHeight) return null; const btn = Array.from(dlg.querySelectorAll('button')).find(b => /ダウンロード/.test(b.innerText || '')); return { text: dlg.innerText.replace(/\s+/g, ' ').trim(), hasButton: !!btn }; } catch { return null; } })()`;
  const dialog = await waitUntil(async () => { const r = await page.eval(READ_DIALOG); return r && r.hasButton ? r : false; }, 60000, 500).catch(() => null);
  if (!dialog) finish(4, '「ファイルダウンロード」ダイアログが出ません。', step('screenshot', { file: await shot(page, 'export-no-dialog') }));
  const outputCount = Number((dialog.text.match(/(\d+)\s*件出力/) || [])[1]);
  step('file download dialog', { text: dialog.text, outputCount });
  if (outputCount !== items.length) finish(4, `出力件数（${outputCount}）が一覧（${items.length}）と違います。ダウンロードしません。`);
  await page.eval(`(() => { const d = document.querySelector('.fancybox-wrap iframe').contentDocument; const btn = Array.from(d.querySelectorAll('.ui-dialog button')).find(b => /ダウンロード/.test(b.innerText || '')); btn.click(); return true; })()`);
  step('clicked download', {});
  let done = null;
  for (let i = 0; i < 60 && !done; i++) {
    await wait(1000);
    done = events.find(e => e.method === 'Browser.downloadProgress' && e.params.state === 'completed') || null;
    if (events.find(e => e.method === 'Browser.downloadProgress' && e.params.state === 'canceled')) finish(4, 'ダウンロードがキャンセルされました。');
  }
  const began = events.find(e => e.method === 'Browser.downloadWillBegin' || e.method === 'Page.downloadWillBegin');
  if (!done) finish(4, `ダウンロードが完了しませんでした: ${JSON.stringify(events.slice(0, 5))}`, step('screenshot', { file: await shot(page, 'export-no-download') }));
  const guid = done.params.guid;
  const saved = path.join(downloadDir, guid);
  if (!fs.existsSync(saved)) {
    const fresh = fs.readdirSync(downloadDir).filter(f => !beforeFiles.has(f));
    finish(4, `ダウンロードしたファイルが見つかりません: ${saved} (new: ${fresh.join(', ')})`);
  }
  const suggested = began?.params?.suggestedFilename || 'b2-issued.csv';
  const outFile = path.join(downloadDir, `${run.startedAt.replace(/[:.]/g, '-')}-${suggested.replace(/[^\w.\-]/g, '_')}`);
  fs.renameSync(saved, outFile);
  step('saved tracking csv', { file: path.resolve(outFile), suggested, bytes: fs.statSync(outFile).size });

  // 4. CSV の検証: 行数と送り状番号が一覧と一致
  const decoded = decodeCsvBuffer(fs.readFileSync(outFile /* Buffer: Shift_JIS のまま扱う */));
  const lines = decoded.text.split(/\r?\n/).filter(l => l.trim());
  const csvTrackings = new Set();
  for (const l of lines) for (const m of l.matchAll(/\b(\d{4}-\d{4}-\d{4}|\d{12})\b/g)) csvTrackings.add(m[1].includes('-') ? m[1] : m[1].replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3'));
  const listTrackings = items.map(i => i.tracking);
  const missingInCsv = listTrackings.filter(t => !csvTrackings.has(t));
  run.csv = { file: path.resolve(outFile), encoding: decoded.encoding, lines: lines.length, firstLine: lines[0]?.slice(0, 200), missingInCsv };
  step('verified tracking csv', run.csv);
  if (lines.length !== items.length) finish(5, `CSV の行数（${lines.length}）が一覧（${items.length}）と違います。`);
  if (missingInCsv.length) finish(5, `CSV に無い送り状番号があります: ${missingInCsv.join(', ')}`);

  // 5. 引き継ぎファイルに記録
  const trackingByGoq = Object.fromEntries([...byGoq.entries()].map(([id, its]) => [id, its.map(i => ({ customerNo: i.customerNo, tracking: i.tracking, type: i.type }))]));
  for (const h of handoffs) {
    const mine = Object.fromEntries((h.data.targets || []).map(t => [String(t.goqId), trackingByGoq[String(t.goqId)] || []]));
    h.data.yamato = { ...(h.data.yamato || {}), trackingCsv: path.resolve(outFile), trackingExportedAt: new Date().toISOString(), trackingNumbers: mine, trackingExportLog: path.resolve(logFile) };
    fs.writeFileSync(h.file, `${JSON.stringify(h.data, null, 2)}\n`, 'utf8');
  }
  step('updated handoff files', { files: handoffFiles });
  await page.eval(`(() => { try { jQuery.fancybox.close(); } catch {} return true; })()`).catch(() => {});
  run.trackingByGoq = trackingByGoq;
  finish(0);
} catch (error) {
  step('screenshot on error', { file: await shot(page, 'export-tracking-error') });
  finish(1, String(error?.stack || error));
}
