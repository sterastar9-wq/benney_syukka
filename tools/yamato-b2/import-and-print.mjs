#!/usr/bin/env node
// ベニー様フロー 4: ヤマトビジネスメンバーズ（B2クラウド）に GoQ の送り状CSVを取り込み、送り状を印刷し、
// 発行済データを出力して GoQ に送り状番号を取り込み、受注を ★発送済み に移す。
//
//   node tools/yamato-b2/import-and-print.mjs --handoff <引き継ぎJSON> [--port 9223] [--stop-before-issue] [--stop-after-import]
//
// 段階（run log に記録し、途中で止まっても続きから再開できるよう handoff の yamato.* を更新する）
//   1. ログイン確認（.env）→ B2クラウドのメインメニュー
//   2. 外部データから発行: 取込みパターン=基本レイアウト、取込み開始行=1、CSV を選択 → 取込み開始
//   3. 取込み結果表示: エラー行の有無と件数を確認（件数 = 引き継ぎの対象件数でなければ停止）
//   4. 印刷内容の確認へ → 発行開始 → PDF を送り状プリンタへ印刷（白黒・両面OFF・印刷プレビューで送信先確認）
//   5. 発行済データの検索（出荷予定日=今日）→ 全選択 → 外部ファイルに出力 → CSV 保存
//   6. GoQ 送り状番号取込（B2クラウド欄）→ 取込結果確認 → 対象行に伝票番号が入ったことを検証 → ★発送済み へ変更
//
// 現時点では 1〜3 を実装済み。4 以降は取込み結果画面の構造を確認してから実装する（--stop-after-import が既定）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, envNumber } from '../lib/env.mjs';
import { CdpPage, listTargets, openTarget, wait, waitUntil } from '../lib/cdp.mjs';
import { YAMATO_HOST, ensureYamatoLogin, readYamatoLoginState } from './login.mjs';

const B2_HOST = 'newb2web.kuronekoyamato.co.jp';
const B2_MAIN_MENU = `https://${B2_HOST}/main_menu.html`;
const B2_IMPORT = `https://${B2_HOST}/ex_data_import.html`;
const YBM_HOME = 'https://bmypage.kuronekoyamato.co.jp/bmypage/ME0001.htm';
const RUN_DIR = path.join('.o11y', 'yamato-b2', 'runs');
const SHOT_DIR = path.join('.o11y', 'yamato-b2', 'screenshots');

loadEnv();
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || envNumber('GOQ_CDP_PORT', 9223));
const run = { startedAt: new Date().toISOString(), args: { ...args }, steps: [] };
fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
run.logFile = path.join(RUN_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

function step(name, detail) {
  run.steps.push({ name, detail, at: new Date().toISOString() });
  fs.writeFileSync(run.logFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  console.error(`[yamato-b2] ${name}`);
}

function fail(message, code = 1) {
  run.error = message;
  fs.writeFileSync(run.logFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(run, null, 2));
  process.exit(code);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (['stop-before-issue', 'stop-after-import', 'skip-print', 'execute'].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

async function connectB2(port) {
  const targets = await listTargets(port);
  let target = targets.find(t => t.type === 'page' && t.url.includes(B2_HOST))
    || targets.find(t => t.type === 'page' && t.url.includes(YAMATO_HOST));
  if (!target) target = await openTarget(port, YBM_HOME);
  const page = new CdpPage(target.webSocketDebuggerUrl, port, target.id);
  await page.enable();
  page.onDialog = detail => {
    run.dialogs = run.dialogs || [];
    run.dialogs.push(detail);
    step('javascript dialog opened', detail);
    // 取込みの確認ダイアログは進める。それ以外は閉じずに止める側に倒す（alert は閉じないと進めないので閉じる）
    return detail.type === 'alert' || /取込|取り込み|開始|よろしい|OK/.test(detail.message);
  };
  return page;
}

async function ensureB2MainMenu(page) {
  const url = await page.url();
  if (url.includes(B2_HOST)) {
    const text = await page.pageText(300);
    if (!/ログイン/.test(text) || /ログアウト/.test(text)) return { via: 'already-in-b2', url };
  }
  const state = await readYamatoLoginState(page);
  if (!String(state.url).includes('bmypage.kuronekoyamato')) await page.navigate(YBM_HOME, 3000);
  run.login = await ensureYamatoLogin(page, { step });
  await page.navigate(YBM_HOME, 3000);
  const called = await page.eval(`(() => { try { ybmCommonJs.useService('06', '2'); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; } })()`);
  if (!called.ok) throw new Error(`B2クラウドを開けません: ${called.error}`);
  await waitUntil(async () => (await page.url()).includes(B2_HOST), 20000, 500);
  await wait(2500);
  return { via: 'useService(06)', url: await page.url() };
}

async function setFileInput(page, selector, filePath) {
  const doc = await page.send('DOM.getDocument', { depth: 1 });
  const node = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
  if (!node.result?.nodeId) throw new Error(`file input not found: ${selector}`);
  const set = await page.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [path.resolve(filePath)] });
  if (set.error) throw new Error(`setFileInputFiles failed: ${JSON.stringify(set.error)}`);
  await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
}

async function describeImportResult(page) {
  return page.eval(`(() => {
    const norm = v => String(v || '').replace(/\\s+/g, ' ').trim();
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const text = norm(document.body.innerText);
    const counts = Array.from(text.matchAll(/(\\d+)\\s*\\/\\s*(\\d+)\\s*件/g)).map(m => ({ selected: Number(m[1]), total: Number(m[2]) }));
    const tables = Array.from(document.querySelectorAll('table')).filter(visible).map(tb => ({
      id: tb.id, cls: (tb.className || '').toString().slice(0, 40), rows: tb.rows.length,
      header: Array.from(tb.rows[0]?.cells || []).map(c => norm(c.innerText).slice(0, 16)).slice(0, 30),
    })).filter(t => t.rows > 1);
    const errorRows = Array.from(document.querySelectorAll('tr')).filter(visible).filter(tr => {
      const style = getComputedStyle(tr);
      const firstCell = tr.cells?.[0];
      const cellStyle = firstCell ? getComputedStyle(firstCell) : null;
      return /error|err|red|ng/i.test(tr.className) || (cellStyle && /rgb\\(2\\d\\d, ?\\d{1,2}, ?\\d{1,2}\\)/.test(cellStyle.color)) || /rgb\\(2\\d\\d, ?\\d{1,2}, ?\\d{1,2}\\)/.test(style.color);
    }).map(tr => ({ cls: tr.className, no: norm(tr.cells?.[0]?.innerText).slice(0, 10), cells: tr.cells.length }));
    const buttons = Array.from(document.querySelectorAll('a[id], button, input[type=button], input[type=image]')).filter(visible).map(el => ({ id: el.id, text: norm(el.innerText || el.value || el.alt).slice(0, 30), cls: (el.className || '').toString().slice(0, 40) })).filter(b => b.text || b.id);
    const checks = Array.from(document.querySelectorAll('input[type=checkbox]')).filter(visible).map(el => ({ id: el.id, cls: (el.className || '').toString().slice(0, 30), checked: el.checked, name: el.name }));
    return { url: location.href, title: document.title, counts, tables, errorRows: errorRows.slice(0, 20), buttons: buttons.slice(0, 40), checkboxCount: checks.length, allCheck: checks.filter(c => /all/i.test(c.cls + c.id)).slice(0, 3), textHead: text.slice(0, 900) };
  })()`);
}

async function main() {
  if (!args.handoff) fail('usage: node tools/yamato-b2/import-and-print.mjs --handoff <file> [--port 9223]', 2);
  const handoff = JSON.parse(fs.readFileSync(args.handoff, 'utf8'));
  run.handoff = { file: path.resolve(args.handoff), csv: handoff.csv, targetCount: handoff.targets?.length, labelPrinter: handoff.labelPrinter, statusKey: handoff.statusKey, date: handoff.date };
  if (!fs.existsSync(handoff.csv)) fail(`CSV が見つかりません: ${handoff.csv}`, 2);
  const stopAfterImport = args['stop-after-import'] === true || args['stop-before-issue'] === true || args.execute !== true;
  run.mode = stopAfterImport ? 'import-only' : 'execute';

  const page = await connectB2(port);
  try {
    const entered = await ensureB2MainMenu(page);
    step('entered b2 cloud', entered);

    await page.navigate(B2_IMPORT, 5000);
    const before = await page.eval(`(() => ({
      url: location.href,
      pattern: document.querySelector('#torikomi_pattern')?.value,
      patterns: Array.from(document.querySelector('#torikomi_pattern')?.options || []).map(o => o.value + ':' + o.textContent.trim()),
      startRow: document.querySelector('#torikomi_strat_row')?.value,
      importDisabled: /disable/.test(document.querySelector('#import_start')?.className || ''),
    }))()`);
    step('opened external data import', before);
    if (!before.patterns?.length) fail('外部データから発行の画面を認識できません。', 3);

    const patternValue = process.env.YAMATO_B2_IMPORT_PATTERN || '1';
    const patternSet = await page.eval(`(() => {
      const select = document.querySelector('#torikomi_pattern');
      const option = Array.from(select.options).find(o => o.value === ${JSON.stringify(patternValue)});
      if (!option) return { ok: false, error: 'pattern not found' };
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: select.value, text: option.textContent.trim() };
    })()`);
    if (!patternSet.ok) fail(`取込みパターンを選べません: ${JSON.stringify(patternSet)}`, 3);
    await wait(1500);
    step('selected import pattern', patternSet);

    await setFileInput(page, '#filename', handoff.csv);
    await wait(1500);
    const fileState = await page.eval(`(() => ({ display: document.querySelector('#file')?.value || '', files: document.querySelector('#filename')?.files?.length || 0, name: document.querySelector('#filename')?.files?.[0]?.name || '' }))()`);
    step('selected csv file', fileState);
    if (!fileState.files) fail('CSV ファイルを選択できませんでした。', 3);

    const rowSet = await page.eval(`(() => {
      const el = document.querySelector('#torikomi_strat_row');
      el.focus();
      el.value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return { value: el.value };
    })()`);
    step('set import start row', rowSet);

    const enabled = await waitUntil(async () => page.eval(`!/disable/.test(document.querySelector('#import_start')?.className || '')`), 15000, 500).catch(() => false);
    const importBtn = await page.eval(`(() => { const el = document.querySelector('#import_start'); return { text: el?.innerText?.trim(), cls: el?.className }; })()`);
    step('import start button state', { enabled, ...importBtn });
    if (!enabled) fail('「取込み開始」が有効になりません。ファイル選択か開始行を確認してください。', 3);
    await page.screenshot(path.join(SHOT_DIR, `before-import-${Date.now()}.png`));

    const beforeUrl = await page.url();
    await page.clickSelector('#import_start');
    step('clicked import start', { beforeUrl });
    await waitUntil(async () => {
      const url = await page.url();
      const text = await page.pageText(600);
      return url !== beforeUrl || /取込み結果|取込結果|件/.test(text) && !/取込み開始行/.test(text);
    }, 60000, 1000).catch(() => null);
    await wait(2500);
    const result = await describeImportResult(page);
    result.screenshot = await page.screenshot(path.join(SHOT_DIR, `import-result-${Date.now()}.png`));
    run.importResult = result;
    step('import result page', result);
    handoff.yamato = { ...(handoff.yamato || {}), imported: true, importedAt: new Date().toISOString(), importResultUrl: result.url, importRunLog: path.resolve(run.logFile) };
    fs.writeFileSync(args.handoff, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

    if (stopAfterImport) {
      step('stopped after import by mode', { mode: run.mode, note: '発行・印刷は行っていません。取込み結果を確認してから --execute で続行します。' });
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    fail('発行・印刷の工程は未実装です（取込み結果画面の確認後に実装）。', 4);
  } catch (error) {
    fail(error.stack || String(error), 1);
  } finally {
    page.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
