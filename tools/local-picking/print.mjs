// ピッキングPDFを Chrome の印刷プレビュー経由で印刷する（送り状PDFと同じ確認手順）。
// 印刷プレビューで送信先プリンタ・白黒・両面OFFを設定して確かめ、スクリーンショットを残してから印刷ボタンを押す。
// 操作は goq-print-flow.mjs の configureAndPressPrintPreview と同じ（Shadow DOM の構造も同じ前提）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { cdpHttpUrl, cdpWebSocketUrl, fileUrlForBrowser } from '../cdp-connection.mjs';
import { findChrome } from './pdf.mjs';

const PDF_VIEWER_EXTENSION = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(fn, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

const listTargets = port => fetch(cdpHttpUrl(port, '/json/list')).then(r => r.json());

export class Session {
  static async connect(wsUrl) {
    const ws = new WebSocket(cdpWebSocketUrl(wsUrl), { perMessageDeflate: false });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return new Session(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  // 応答が返らない命令で止まり続けないよう、命令ごとに制限時間を設ける
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} が ${timeoutMs}ms 以内に応答しませんでした`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    try { this.ws.close(); } catch { /* best effort */ }
  }
}

// 使い捨てのプロファイルでChromeを起動する（普段使いのChromeやGoQのログインには触れない）
export async function launchIsolatedChrome({ port = 9334, chromePath = findChrome() } = {}) {
  if (!chromePath) throw new Error('Chromeが見つかりません。PICKING_CHROME_PATH にchrome.exeのパスを設定してください。');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-picking-print-'));
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900',
    'about:blank',
  ], { stdio: 'ignore' });
  await waitUntil(async () => listTargets(port).then(() => true).catch(() => false), 20000, 250);
  return {
    port,
    async close() {
      child.kill();
      await wait(1000);
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

export async function configurePrintPreview(port, { printer, color, duplex, press, screenshotDir }) {
  const target = await waitUntil(async () => (await listTargets(port)).find(t => t.type === 'page' && t.url.startsWith('chrome://print/')), 30000, 500);
  const preview = await Session.connect(target.webSocketDebuggerUrl);
  try {
    await preview.send('Runtime.enable');
    await waitUntil(() => preview.eval(`(() => {
      const app = document.querySelector('print-preview-app');
      const side = app?.shadowRoot?.querySelector('print-preview-sidebar')?.shadowRoot;
      const destSelect = side?.querySelector('print-preview-destination-settings')?.shadowRoot
        ?.querySelector('print-preview-destination-select')?.shadowRoot?.querySelector('select');
      const colorSelect = side?.querySelector('print-preview-color-settings')?.shadowRoot?.querySelector('select');
      const button = side?.querySelector('print-preview-button-strip')?.shadowRoot?.querySelector('cr-button.action-button');
      return Boolean(destSelect && colorSelect && button);
    })()`), 30000, 500);

    const selected = await preview.eval(`(() => {
      const side = document.querySelector('print-preview-app').shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
      const select = side.querySelector('print-preview-destination-settings').shadowRoot
        .querySelector('print-preview-destination-select').shadowRoot.querySelector('select');
      const options = Array.from(select.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
      const direct = options.find(o => o.text.includes(${JSON.stringify(printer)}));
      if (direct) {
        select.value = direct.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { method: 'select', printers: options.map(o => o.text) };
      }
      select.value = 'seeMore';
      select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { method: 'dialog', printers: options.map(o => o.text) };
    })()`);
    if (selected.method === 'dialog') {
      // 「もっと見る」のダイアログはプリンタ一覧を後から読み込むので、見つかるまで待つ。
      // 一覧の項目名は入れ子のShadow DOMにあって読めないことがあるため、goq-print-flow.mjs と同じく destinationStore_ から選ぶ。
      const pickScript = `(() => {
        const side = document.querySelector('print-preview-app').shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
        const destSettings = side.querySelector('print-preview-destination-settings');
        const store = destSettings.destinationStore_;
        const keys = store?.destinationMap_ ? Array.from(store.destinationMap_.keys()) : [];
        const key = keys.find(k => k.split('/')[0] === ${JSON.stringify(printer)}) || keys.find(k => k.includes(${JSON.stringify(printer)}));
        if (!key) return { ok: false, printers: keys };
        const destination = store.destinationMap_.get(key);
        if (typeof store.selectDestination === 'function') store.selectDestination(destination);
        else if (typeof store.selectDestinationByKey === 'function') store.selectDestinationByKey(key);
        else return { ok: false, printers: keys, error: 'no select method' };
        const dialog = destSettings.shadowRoot.querySelector('print-preview-destination-dialog');
        const cancel = Array.from(dialog?.shadowRoot?.querySelectorAll('cr-button, button') || [])
          .find(button => /キャンセル|Cancel/i.test(button.innerText || button.textContent || ''));
        if (destSettings.isDialogOpen_ && cancel) cancel.click();
        return { ok: true, key };
      })()`;
      let picked = { ok: false, printers: [] };
      const started = Date.now();
      while (!picked.ok && Date.now() - started < 20000) {
        await wait(1000);
        picked = await preview.eval(pickScript);
      }
      if (!picked.ok) throw new Error(`プリンタ「${printer}」が見つかりません: ${JSON.stringify([...selected.printers, ...picked.printers])}`);
    }
    await wait(1500);

    const verified = await preview.eval(`(() => {
      const app = document.querySelector('print-preview-app');
      const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
      const destSettings = side.querySelector('print-preview-destination-settings');
      const select = destSettings.shadowRoot.querySelector('print-preview-destination-select').shadowRoot.querySelector('select');
      const destination = destSettings.destination?.displayName
        || destSettings.destinationStore_?.selectedDestination_?.displayName
        || select.options[select.selectedIndex]?.textContent.trim() || '';
      const colorSelect = side.querySelector('print-preview-color-settings')?.shadowRoot.querySelector('select');
      if (colorSelect) { colorSelect.value = ${JSON.stringify(color)}; colorSelect.dispatchEvent(new Event('change', { bubbles: true })); }
      const more = side.querySelector('print-preview-more-settings');
      const moreSettings = side.querySelector('cr-collapse#moreSettings');
      if (more && moreSettings?.classList.contains('collapse-closed')) more.shadowRoot.querySelector('cr-expand-button')?.click();
      const duplexBox = side.querySelector('print-preview-duplex-settings')?.shadowRoot.querySelector('cr-checkbox#duplex');
      if (duplexBox && duplexBox.checked !== ${JSON.stringify(duplex)}) duplexBox.click();
      const pages = app.shadowRoot.querySelector('print-preview-preview-area')?.shadowRoot.innerText || '';
      return { destination, color: colorSelect?.value || '', duplex: duplexBox ? duplexBox.checked : false, pages };
    })()`);
    if (!normalizeText(verified.destination).includes(normalizeText(printer))) throw new Error(`送信先プリンタが違います: ${verified.destination}`);
    if (verified.color && verified.color !== color) throw new Error(`カラー設定が違います: ${verified.color}`);
    if (verified.duplex !== duplex) throw new Error(`両面設定が違います: ${verified.duplex}`);

    fs.mkdirSync(screenshotDir, { recursive: true });
    const shot = await preview.send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.join(screenshotDir, `print-preview-${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));

    const buttonScript = kind => `(() => {
      const strip = document.querySelector('print-preview-app').shadowRoot.querySelector('print-preview-sidebar')
        .shadowRoot.querySelector('print-preview-button-strip').shadowRoot;
      const button = ${kind === 'print'
        ? `strip.querySelector('cr-button.action-button')`
        : `strip.querySelector('cr-button.cancel-button') || Array.from(strip.querySelectorAll('cr-button, button')).find(b => /キャンセル|Cancel/i.test(b.innerText || b.textContent || ''))`};
      if (!button) return false;
      button.click();
      return true;
    })()`;
    if (press) {
      await preview.eval(buttonScript('print'));
      const closed = await waitUntil(async () => !(await listTargets(port)).some(t => t.type === 'page' && t.url.startsWith('chrome://print/')), 10000, 500)
        .then(() => true).catch(() => false);
      if (!closed) throw new Error('印刷ボタンを押した後も印刷プレビューが閉じません（印刷されたか未確認）');
    } else {
      await preview.eval(buttonScript('cancel')).catch(() => false);
    }
    return { ...verified, printer, screenshotPath, printed: Boolean(press) };
  } finally {
    preview.close();
  }
}

// PDFを新しいタブで開き、PDFビューアの印刷ボタン → 印刷プレビューの設定・確認 → 印刷（press=false なら確認だけ）
export async function printPdfViaChrome(port, pdfPath, {
  printer = '普通紙',
  color = 'bw',
  duplex = false,
  press = true,
  screenshotDir = path.join('.o11y', 'goq-unified-print-flow', 'screenshots'),
} = {}) {
  const created = await fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent(fileUrlForBrowser(path.resolve(pdfPath)))}`), { method: 'PUT' }).then(r => r.json());
  let viewer;
  try {
    // PDFビューアの読み込み直後は命令に応答しないことがあるので、応答するまで最大3回つなぎ直す
    for (let attempt = 1; attempt <= 3; attempt++) {
      const viewerTarget = await waitUntil(async () => (await listTargets(port))
        .find(t => t.type === 'iframe' && t.parentId === created.id && t.url.includes(PDF_VIEWER_EXTENSION)), 30000, 500);
      await wait(1000);
      viewer = await Session.connect(viewerTarget.webSocketDebuggerUrl);
      try {
        await viewer.send('Runtime.enable', {}, 10000);
        await waitUntil(() => viewer.eval(`Boolean(document.querySelector('pdf-viewer'))`), 30000, 500);
        break;
      } catch (error) {
        viewer.close();
        viewer = null;
        if (attempt === 3) throw new Error(`PDFビューアに接続できませんでした: ${error.message}`);
      }
    }
    await wait(1500);
    const clicked = await viewer.eval(`(() => {
      const button = document.querySelector('pdf-viewer')?.shadowRoot
        ?.querySelector('viewer-toolbar#toolbar, viewer-toolbar, #toolbar')?.shadowRoot
        ?.querySelector('cr-icon-button#print, #print');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error('PDFビューアの印刷ボタンが見つかりません');
    return await configurePrintPreview(port, { printer, color, duplex, press, screenshotDir });
  } finally {
    viewer?.close();
    for (const t of (await listTargets(port).catch(() => [])).filter(t => t.type === 'page' && t.url.startsWith('chrome://print/'))) {
      await fetch(cdpHttpUrl(port, `/json/close/${t.id}`)).catch(() => {});
    }
    await fetch(cdpHttpUrl(port, `/json/close/${created.id}`)).catch(() => {});
  }
}
