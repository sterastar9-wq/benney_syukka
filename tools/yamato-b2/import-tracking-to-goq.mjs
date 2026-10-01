#!/usr/bin/env node
// ベニー様フロー 4 の最後（手順 60〜70）: B2クラウドから出力した送り状番号CSVを GoQ の「送り状番号取込」（B2クラウド欄）に取り込み、
// 対象注文の行に送り状番号が入ったことを確かめてから、元ステータスで対象を選択して受注ステータスを「★発送済み」に変更する。
//
//   node tools/yamato-b2/import-tracking-to-goq.mjs --handoffs <引き継ぎJSON>[,<引き継ぎJSON>...] [--port 9223] [--skip-status-change] [--status-only] [--ship-date-optional] [--set-ship-date today|YYYY-MM-DD]
// ★発送済み に移すのは「送り状番号が確認でき、かつ出荷日が入っている」注文だけ（2026-10-01 オペレーター指示）。--ship-date-optional で出荷日なしも移す
//
// 引き継ぎファイルには export-tracking.mjs が書いた yamato.trackingCsv / yamato.trackingNumbers が必要。
// 検証は 3 段: 取込み結果のメッセージ → 元ステータスの一覧で対象行に送り状番号（[伝票入力済]）→ ★発送済み へ移ったこと。
// 送り状番号が確認できない対象は「送り状未発行/除外された可能性あり」として報告し、その注文のステータスは変更しない。

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../lib/env.mjs';
import { CdpPage, listTargets, openTarget, wait, waitUntil } from '../lib/cdp.mjs';
import { GOQ_ORIGIN, GOQ_DASHBOARD_URL, ensureGoqLogin } from '../goq-login.mjs';

loadEnv();

const SLIP_URL = `${GOQ_ORIGIN}/goq21/input/deliveryslip.php`;
const LIST_URL = stat => `${GOQ_ORIGIN}/goq21/index_beta.php?stat=${stat}`;
const SHIPPED_STAT = Number(process.env.GOQ_SHIPPED_STAT || 29); // ★発送済み
const SHIPPED_LABEL = process.env.GOQ_SHIPPED_LABEL || '★発送済み';
const LOG_DIR = path.join('.o11y', 'yamato-b2', 'goq-tracking-import-logs');
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

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || process.env.GOQ_CDP_PORT || 9223);
const run = { startedAt: new Date().toISOString(), args, steps: [] };
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `${run.startedAt.replace(/[:.]/g, '-')}.json`);
const save = () => fs.writeFileSync(logFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
const step = (name, detail = {}) => { run.steps.push({ name, at: new Date().toISOString(), detail }); save(); console.error(`[yamato-b2/import-tracking] ${name}`); };
const finish = (code, error) => {
  if (error) run.error = error;
  run.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ ok: !error, logFile: path.resolve(logFile), ...run }, null, 2));
  process.exit(code);
};

if (typeof args.handoffs !== 'string') {
  console.error('使い方: node tools/yamato-b2/import-tracking-to-goq.mjs --handoffs <引き継ぎJSON>[,...] [--port 9223] [--skip-status-change] [--status-only]');
  process.exit(2);
}
const handoffs = args.handoffs.split(',').map(f => path.resolve(f.trim())).filter(Boolean).map(file => ({ file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }));
const csvFiles = new Set(handoffs.map(h => h.data.yamato?.trackingCsv).filter(Boolean));
if (csvFiles.size !== 1) finish(2, `引き継ぎファイルの yamato.trackingCsv が 1 つに決まりません: ${[...csvFiles].join(', ') || '(なし)'}。先に export-tracking.mjs を実行してください。`);
const csvFile = [...csvFiles][0];
if (!fs.existsSync(csvFile)) finish(2, `送り状番号CSVがありません: ${csvFile}`);
// 対象: statusKey/stat ごとに GoQ番号 → 期待する送り状番号（B2 の一覧から）
const groups = new Map();
for (const h of handoffs) {
  const stat = Number(h.data.stat);
  if (!groups.has(stat)) groups.set(stat, { stat, status: h.data.status, statusKey: h.data.statusKey, targets: new Map(), files: [] });
  const g = groups.get(stat);
  g.files.push(h.file);
  for (const t of h.data.targets || []) {
    const nums = (h.data.yamato?.trackingNumbers?.[String(t.goqId)] || []).map(x => x.tracking);
    g.targets.set(String(t.goqId), { goqId: String(t.goqId), orderNumber: t.orderNumber, expectedTracking: nums });
  }
}
run.plan = [...groups.values()].map(g => ({ stat: g.stat, status: g.status, targets: [...g.targets.keys()] }));
const totalTargets = run.plan.reduce((n, g) => n + g.targets.length, 0);
if (!totalTargets) finish(2, '対象注文がありません。');

async function connectGoq() {
  const targets = await listTargets(port);
  let target = targets.find(t => t.type === 'page' && t.url.includes('order.goqsystem.com'));
  if (!target) target = await openTarget(port, GOQ_DASHBOARD_URL);
  const page = new CdpPage(target.webSocketDebuggerUrl, port, target.id);
  await page.enable();
  page.onDialog = d => { step('javascript dialog', d); return /ステータス|変更|よろしい|取込|取り込/.test(d.message) || d.type === 'alert'; };
  return page;
}

const shot = async (page, name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (!r?.result?.data) return null;
  const file = path.join(SHOT_DIR, `${name}-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
};

const normalizeTracking = s => String(s || '').replace(/\D/g, '');

// 一覧で対象行の送り状番号を読む。行が無ければ null
async function readRows(page, goqIds) {
  return page.eval(`(() => {
    const ids = ${JSON.stringify(goqIds)};
    return ids.map(id => {
      const row = document.querySelector('tr[data-order-number="' + id + '"]');
      if (!row) return { goqId: id, found: false };
      const text = (row.innerText || '').replace(/\\s+/g, ' ');
      const nums = Array.from(text.matchAll(/\\b(\\d{4}-\\d{4}-\\d{4}|\\d{12})\\b/g)).map(m => m[1].replace(/-/g, ''));
      const detail = Array.from(row.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).find(h => /order_details_beta\\.php\\?oid=/.test(h)) || null;
      // 出荷日: 一覧の出荷日入力欄（ship_send_date_<GoQ番号>）か 17列目
      const shipRaw = document.querySelector('#ship_send_date_' + id)?.value || row.cells[16]?.innerText || '';
      const shipDate = (String(shipRaw).match(/\\d{4}[-\\/]\\d{2}[-\\/]\\d{2}/) || [''])[0];
      return { goqId: id, found: true, slipEntered: /伝票入力済/.test(text), trackingDigits: nums, shipDate, text: text.slice(0, 200), detail };
    });
  })()`);
}

// 一覧の行には送り状番号が出ない（2026-10-01 確認。取込み後も [伝票入力済] が付かない）ので、注文詳細の伝票番号欄 da19[*] を読む
async function readDetailTracking(page, detailHref, stat, goqId) {
  const href = detailHref ? new URL(detailHref, `${GOQ_ORIGIN}/goq21/`).href : `${GOQ_ORIGIN}/goq21/order_details_beta.php?oid=${goqId}&stat=${stat}`;
  await page.navigate(href, 3500);
  return page.eval(`(() => ({ url: location.href, oid: new URLSearchParams(location.search).get('oid'), tracking: Array.from(document.querySelectorAll('input[name^="da19["]')).map(e => String(e.value || '').replace(/\\D/g, '')).filter(Boolean) }))()`);
}

async function ensureDisplayCount(page) {
  // 500件表示（goq-print-flow.mjs と同じ趣旨。既に 500 なら何もしない）
  return page.eval(`(() => {
    const selects = Array.from(document.querySelectorAll('select')).filter(s => Array.from(s.options).some(o => o.value === '500'));
    const changed = [];
    for (const s of selects) { if (s.value !== '500') { s.value = '500'; s.dispatchEvent(new Event('change', { bubbles: true })); changed.push(s.name || s.id); } }
    return { found: selects.length, changed };
  })()`);
}

const page = await connectGoq();
try {
  run.login = await ensureGoqLogin(page, { step });

  // 1. 送り状番号取込（B2クラウド欄）
  if (args['status-only'] !== true) {
    await page.navigate(SLIP_URL, 4000);
    const doc = await page.send('DOM.getDocument', { depth: 1 });
    const node = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file][name="yamatob2webfile"]' });
    if (!node.result?.nodeId) finish(3, '送り状番号取込の B2クラウド欄（yamatob2webfile）が見つかりません。');
    const set = await page.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [csvFile] });
    if (set.error) finish(3, `CSV を選択できません: ${JSON.stringify(set.error)}`);
    const fileState = await page.eval(`(() => { const el = document.querySelector('input[type=file][name="yamatob2webfile"]'); return { files: el.files.length, name: el.files[0]?.name, size: el.files[0]?.size }; })()`);
    step('selected tracking csv on goq import form', { csvFile, fileState });
    if (!fileState.files) finish(3, 'CSV がフォームに載っていません。');
    const beforeText = await page.pageText(2000);
    await page.eval(`(() => { submitdata('YamatoB2WEB'); return true; })()`);
    step('submitted goq tracking import', { target: 'YamatoB2WEB' });
    await wait(4000);
    await waitUntil(async () => (await page.url()).includes('deliveryslip.php') && (await page.eval(`document.readyState`)) === 'complete', 60000, 500).catch(() => null);
    await wait(1500);
    const result = await page.eval(`(() => {
      const t = document.body.innerText.replace(/\\s+/g, ' ');
      const msgs = Array.from(document.querySelectorAll('div, p, span, td, font, b')).map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(s => s && s.length < 200 && /件|取込|取り込|エラー|失敗|完了|しました/.test(s));
      const i = t.indexOf('B2クラウド');
      return { url: location.href, messages: Array.from(new Set(msgs)).slice(0, 12), aroundB2: t.slice(Math.max(0, i - 400), i + 200) };
    })()`);
    result.screenshot = await shot(page, 'goq-tracking-import-result');
    run.importResult = result;
    step('goq tracking import result', result);
    const okMsg = result.messages.find(m => /(\d+)\s*件.*(取り?込|登録)/.test(m) || /(取り?込|登録).*(\d+)\s*件/.test(m));
    const ngMsg = result.messages.find(m => /エラー|失敗|できません|ありません/.test(m));
    if (ngMsg && !okMsg) finish(4, `送り状番号取込でエラー表示: ${ngMsg}`);
    const count = okMsg ? Number((okMsg.match(/(\d+)\s*件/) || [])[1]) : null;
    run.importedCount = count;
    if (count !== null && count !== totalTargets) step('import count differs from targets', { count, totalTargets, note: '一覧で行ごとに検証する' });
    for (const h of handoffs) { h.data.yamato = { ...(h.data.yamato || {}), goqTrackingImportedAt: new Date().toISOString(), goqTrackingImportMessage: okMsg || result.messages.slice(0, 3), goqTrackingImportLog: path.resolve(logFile) }; fs.writeFileSync(h.file, `${JSON.stringify(h.data, null, 2)}\n`, 'utf8'); }
  }

  // 2. 元ステータスの一覧で対象行に送り状番号が入ったことを検証（無ければ ★発送済み / 全て も見る）
  const verified = []; const unverified = [];
  for (const g of groups.values()) {
    await page.navigate(LIST_URL(g.stat), 4000);
    const display = await ensureDisplayCount(page);
    if (display.changed.length) await wait(4000);
    let rows = await readRows(page, [...g.targets.keys()]);
    g.rowsInSource = rows;
    const pendingDetail = [];
    for (const r of rows) {
      const t = g.targets.get(r.goqId);
      const expectedDigits = (t.expectedTracking || []).map(normalizeTracking);
      const ok = r.found && (r.trackingDigits.some(d => expectedDigits.includes(d)) || (r.slipEntered && !expectedDigits.length));
      if (ok) verified.push({ ...t, stat: g.stat, foundIn: g.stat, trackingDigits: r.trackingDigits, shipDate: r.shipDate });
      else if (r.found) pendingDetail.push({ t, r, expectedDigits });
      else unverified.push({ ...t, stat: g.stat, row: r });
    }
    step('verified tracking numbers on source status list', { stat: g.stat, status: g.status, rows: rows.map(r => ({ goqId: r.goqId, found: r.found, slipEntered: r.slipEntered, trackingDigits: r.trackingDigits })) });
    // 一覧に出ない分は注文詳細の伝票番号欄で確認する
    const details = [];
    for (const { t, r, expectedDigits } of pendingDetail) {
      const d = await readDetailTracking(page, r.detail, g.stat, r.goqId);
      const ok = String(d.oid) === String(r.goqId) && d.tracking.some(x => expectedDigits.includes(x));
      details.push({ goqId: r.goqId, oid: d.oid, tracking: d.tracking, expected: expectedDigits, ok });
      if (ok) verified.push({ ...t, stat: g.stat, foundIn: g.stat, trackingDigits: d.tracking, shipDate: r.shipDate, via: 'order-detail' });
      else unverified.push({ ...t, stat: g.stat, row: { ...r, detailTracking: d.tracking } });
    }
    if (details.length) step('verified tracking numbers on order detail pages', { stat: g.stat, details });
  }
  // 元ステータスに無い対象は、すでに移動した可能性があるので ★発送済み と 全て(12) で探す
  if (unverified.some(u => !u.row.found)) {
    for (const stat of [SHIPPED_STAT, 12]) {
      const ids = unverified.filter(u => !u.row.found).map(u => u.goqId);
      if (!ids.length) break;
      await page.navigate(LIST_URL(stat), 4000);
      await ensureDisplayCount(page);
      await wait(1500);
      const rows = await readRows(page, ids);
      step('looked for moved rows', { stat, rows });
      for (const r of rows) {
        if (!r.found) continue;
        const idx = unverified.findIndex(u => u.goqId === r.goqId);
        const u = unverified[idx];
        const expectedDigits = (u.expectedTracking || []).map(normalizeTracking);
        if (r.trackingDigits.some(d => expectedDigits.includes(d))) { verified.push({ ...u, foundIn: stat, trackingDigits: r.trackingDigits, alreadyMoved: true }); unverified.splice(idx, 1); }
        else u.row = r;
      }
    }
  }
  run.verified = verified; run.unverified = unverified;
  step('tracking verification summary', { verified: verified.length, unverified: unverified.map(u => ({ goqId: u.goqId, expected: u.expectedTracking, row: u.row })) });
  if (unverified.length) step('送り状未発行/除外された可能性あり', { count: unverified.length, goqIds: unverified.map(u => u.goqId) });

  // 3. 受注ステータスを ★発送済み に変更。条件: 送り状番号が確認できて、かつ出荷日が入っている注文だけ（2026-10-01 オペレーター指示）。
  //    --ship-date-optional を付けたときだけ出荷日なしも移動する
  const needShipDate = args['ship-date-optional'] !== true;
  // --set-ship-date [YYYY-MM-DD|today]: 送り状番号が確認できて出荷日が空の注文に、注文詳細の出荷日（hidden a59）を入れて「入力内容を反映する」で保存する
  //（一覧に出荷日の一括入力欄が無いベニー様の GoQ 向け。2026-10-01 に 17226 で確認: 保存後「更新しました」、再読込で a59 と一覧の出荷日欄に反映）
  if (args['set-ship-date']) {
    const wanted = args['set-ship-date'] === true || args['set-ship-date'] === 'today' ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()) : String(args['set-ship-date']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wanted)) finish(2, `出荷日の形式が違います: ${wanted}`);
    const results = [];
    for (const v of verified.filter(v => !v.shipDate)) {
      const url = `${GOQ_ORIGIN}/goq21/order_details_beta.php?oid=${v.goqId}&stat=${v.stat}`;
      await page.navigate(url, 3500);
      const set = await page.eval(`(() => {
        const el = document.querySelector('input[name="a59"]');
        const oid = new URLSearchParams(location.search).get('oid');
        if (!el || oid !== ${JSON.stringify(String(v.goqId))}) return { ok: false, error: 'a59 not found or wrong order', oid };
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        d.set.call(el, ${JSON.stringify(wanted)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const btn = Array.from(document.querySelectorAll('button')).find(b => /入力内容を反映する/.test(b.innerText));
        if (!btn) return { ok: false, error: 'save button not found' };
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return { ok: true };
      })()`);
      if (!set.ok) { results.push({ goqId: v.goqId, ok: false, set }); continue; }
      await wait(4000);
      await waitUntil(async () => (await page.eval('document.readyState')) === 'complete', 30000, 500).catch(() => null);
      const saidUpdated = await page.eval(`/更新しました/.test(document.body.innerText)`);
      await page.navigate(url, 3500);
      const after = await page.eval(`({ a59: document.querySelector('input[name="a59"]')?.value, da19: Array.from(document.querySelectorAll('input[name^="da19["]')).map(e => String(e.value || '').replace(/\\D/g, '')).filter(Boolean) })`);
      const ok = after.a59 === wanted && after.da19.some(x => (v.trackingDigits || []).includes(x));
      results.push({ goqId: v.goqId, ok, saidUpdated, after });
      if (ok) v.shipDate = wanted;
    }
    run.shipDateSet = { wanted, results };
    step('set shipping date on order detail pages', run.shipDateSet);
    const failed = results.filter(r => !r.ok);
    if (failed.length) finish(5, `出荷日を保存できない注文があります: ${failed.map(f => f.goqId).join(', ')}`);
  }
  const movable = verified.filter(v => !needShipDate || v.shipDate);
  const noShipDate = verified.filter(v => needShipDate && !v.shipDate);
  run.statusChangePlan = { needShipDate, movable: movable.map(v => v.goqId), noShipDate: noShipDate.map(v => v.goqId) };
  step('status change plan', run.statusChangePlan);
  if (noShipDate.length) step('送り状番号はあるが出荷日が未記入のため ★発送済み にしない', { goqIds: noShipDate.map(v => v.goqId) });
  const report = () => {
    run.shippedToday = { movedToShipped: movable.filter(v => v.foundIn === v.stat).length, alreadyMoved: verified.filter(v => v.alreadyMoved).length, trackingOnlyNoShipDate: noShipDate.length, unverified: unverified.length, byStatus: [...groups.values()].map(g => ({ status: g.status, targets: g.targets.size, moved: movable.filter(v => v.stat === g.stat && v.foundIn === g.stat).length })) };
    step('today shipping report', run.shippedToday);
  };
  if (args['skip-status-change'] === true) { step('skipped status change by option', {}); report(); finish(unverified.length ? 6 : 0, unverified.length ? `送り状番号を確認できない注文があります: ${unverified.map(u => u.goqId).join(', ')}` : undefined); }
  for (const g of groups.values()) {
    const ids = movable.filter(v => v.stat === g.stat && v.foundIn === g.stat).map(v => v.goqId);
    if (!ids.length) { step('no rows to move for status', { stat: g.stat }); continue; }
    await page.navigate(LIST_URL(g.stat), 4000);
    await ensureDisplayCount(page);
    await wait(1500);
    const selected = await page.eval(`(() => {
      const ids = new Set(${JSON.stringify(ids)});
      const boxes = Array.from(document.getElementsByName('order_number[]'));
      for (const box of boxes) { const should = ids.has(box.value); if (box.checked !== should) { box.scrollIntoView?.({ block: 'center' }); box.click(); } }
      return Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
    })()`);
    const selSet = new Set(selected);
    if (selected.length !== ids.length || ids.some(id => !selSet.has(id))) finish(5, `ステータス変更の選択が一致しません（stat ${g.stat}）: expected ${ids.join(',')} got ${selected.join(',')}`);
    step('selected rows for status change', { stat: g.stat, selected });
    const dialogCount = page.dialogs.length;
    const requested = await page.eval(`(() => {
      const select = document.querySelector('select[name="status_id"]');
      if (!select) return { ok: false, error: 'status select not found' };
      const option = Array.from(select.options).find(o => o.value === ${JSON.stringify(String(SHIPPED_STAT))} || o.textContent.trim() === ${JSON.stringify(SHIPPED_LABEL)});
      if (!option) return { ok: false, error: 'shipped option not found', options: Array.from(select.options).map(o => o.value + ':' + o.textContent.trim()) };
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value');
      if (descriptor?.set) descriptor.set.call(select, option.value); else select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const button = Array.from(select.parentElement.querySelectorAll('button, input[type=button], input[type=submit]')).find(b => /変更/.test(b.value || b.textContent || ''));
      if (!button || button.disabled) return { ok: false, error: 'change button not found or disabled' };
      button.scrollIntoView({ block: 'center' });
      button.click();
      return { ok: true, value: select.value, label: option.textContent.trim(), buttonText: (button.value || button.textContent || '').trim() };
    })()`);
    if (!requested.ok) finish(5, `ステータス変更を要求できません: ${JSON.stringify(requested)}`);
    step('requested status change', { stat: g.stat, to: SHIPPED_STAT, requested, dialogs: page.dialogs.slice(dialogCount) });
    // 検証: 元ステータスから消える（または ★発送済み に現れる）
    const gone = await waitUntil(async () => {
      const rows = await readRows(page, ids);
      return rows.every(r => !r.found) ? rows : false;
    }, 30000, 1000).catch(() => null);
    if (!gone) {
      await page.navigate(LIST_URL(g.stat), 4000); await ensureDisplayCount(page); await wait(1500);
      const rows = await readRows(page, ids);
      if (!rows.every(r => !r.found)) finish(5, `ステータス変更後も元ステータスに残っている注文があります（stat ${g.stat}）: ${rows.filter(r => r.found).map(r => r.goqId).join(', ')}`);
    }
    await page.navigate(LIST_URL(SHIPPED_STAT), 4000); await ensureDisplayCount(page); await wait(1500);
    const inShipped = await readRows(page, ids);
    const missing = inShipped.filter(r => !r.found).map(r => r.goqId);
    step('verified rows moved to shipped status', { stat: g.stat, inShipped: inShipped.map(r => ({ goqId: r.goqId, found: r.found, trackingDigits: r.trackingDigits })), missing });
    if (missing.length) finish(5, `★発送済み に見つからない注文があります: ${missing.join(', ')}`);
    for (const h of handoffs.filter(h => Number(h.data.stat) === g.stat)) { h.data.yamato = { ...(h.data.yamato || {}), trackingImportedToGoq: true, movedToShippedAt: new Date().toISOString(), movedGoqIds: ids }; fs.writeFileSync(h.file, `${JSON.stringify(h.data, null, 2)}\n`, 'utf8'); }
  }
  report();
  finish(unverified.length ? 6 : 0, unverified.length ? `送り状番号を確認できない注文があります（ステータスは変えていません）: ${unverified.map(u => u.goqId).join(', ')}` : undefined);
} catch (error) {
  step('screenshot on error', { file: await shot(page, 'goq-tracking-import-error') });
  finish(1, String(error?.stack || error));
}
