#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { cdpHttpUrl, cdpWebSocketUrl, fileUrlForBrowser } from './cdp-connection.mjs';
import { buildLocalPickingPdf } from './local-picking/build.mjs';

const port = Number(process.argv[2] || 9223);
const status = Number(process.argv[3] || 31);
const ids = (process.argv[4] || '').split(',').map(v => v.trim()).filter(Boolean);
if (!ids.length) {
  console.error('usage: node tools/goq-print-picking-for-orders.mjs <port> <stat> <goqId,goqId,...>');
  process.exit(2);
}

const GOQ_LIST_URL = 'https://order.goqsystem.com/goq21/index_beta.php';
const GOQ_LIST_FALLBACK_URL = 'https://order.goqsystem.com/goq21/index.php';
const LOCAL_PICKING_DIR = path.join('.o11y', 'goq-unified-print-flow', 'picking');
const PICKING_PRINTER = '普通紙';
const run = { ids, status, steps: [], startedAt: new Date().toISOString() };

function step(name, detail) {
  run.steps.push({ name, detail, at: new Date().toISOString() });
}

async function connectOrOpen(port, url, predicate) {
  let targets = await listTargets(port);
  let target = targets.find(t => t.type === 'page' && predicate(t));
  if (!target) {
    target = await fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent(url)}`), { method: 'PUT' }).then(r => r.json());
  }
  return new CdpPage(target.webSocketDebuggerUrl, port);
}

async function listTargets(port) {
  return fetch(cdpHttpUrl(port, '/json/list')).then(r => r.json());
}

class CdpPage {
  constructor(wsUrl, port) {
    this.wsUrl = cdpWebSocketUrl(wsUrl);
    this.port = port;
    this.seq = 0;
    this.pending = new Map();
    this.ws = new WebSocket(this.wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    return new Promise(resolve => {
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await waitUntil(() => this.eval('document.readyState === "complete"'), 30000, 300);
    await wait(800);
  }

  async waitForOrderList() {
    const found = await waitUntil(
      () => this.eval(`document.querySelectorAll('tr[data-order-number], input[name="order_number[]"]').length > 0`),
      15000,
      500,
    ).then(() => true).catch(() => false);
    if (found) return;
    await this.navigate(`${GOQ_LIST_FALLBACK_URL}?stat=${status}&page=1`);
    await waitUntil(() => this.eval(`document.querySelectorAll('tr[data-order-number], input[name="order_number[]"]').length > 0`), 30000, 500);
  }

  selectIds(ids) {
    return this.eval(`(() => {
      const ids = new Set(${JSON.stringify(ids)});
      const boxes = Array.from(document.querySelectorAll('input[name="order_number[]"]'));
      const visible = boxes.map(box => box.value);
      for (const box of boxes) {
        const should = ids.has(box.value);
        if (box.checked !== should) {
          box.checked = should;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const selected = boxes.filter(box => box.checked).map(box => box.value);
      const missing = [...ids].filter(id => !selected.includes(id));
      return { ok: missing.length === 0, selected, visible, missing };
    })()`);
  }

  async exportPickingCsvToFile() {
    const result = await this.eval(`(async () => {
      const select = document.querySelector('#trader_s3');
      if (!select) return { ok: false, error: '#trader_s3 not found' };
      select.value = 'customize_csv_6';
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const checked = Array.from(document.querySelectorAll('input[name="order_number[]"]')).filter(b => b.checked).map(b => b.value);
      if (!checked.length) return { ok: false, error: 'no selected rows' };
      const form = document.querySelector('#pro_form') || select.closest('form') || document.querySelector('form');
      if (!form) return { ok: false, error: 'export form not found' };
      const data = new URLSearchParams(new FormData(form));
      data.set('trader_s3', 'customize_csv_6');
      const existing = new Set(data.getAll('order_number[]'));
      for (const id of checked) {
        if (!existing.has(id)) data.append('order_number[]', id);
      }
      const createResponse = await fetch('/goq21/export/create_custom_csv.php?custom_id=6', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data.toString()
      });
      const html = await createResponse.text();
      const marker = 'infile.php?fname=';
      const markerIndex = html.indexOf(marker);
      if (!createResponse.ok || markerIndex < 0) return { ok: false, step: 'create', status: createResponse.status, html: html.slice(0, 500), checked };
      const fname = html.slice(markerIndex + marker.length).split('"')[0].split("'")[0].split(')')[0].trim();
      const csvResponse = await fetch('/goq21/infile.php?fname=' + encodeURIComponent(fname), { credentials: 'same-origin' });
      const buffer = await csvResponse.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { ok: csvResponse.ok, status: csvResponse.status, type: csvResponse.headers.get('content-type') || '', disposition: csvResponse.headers.get('content-disposition') || '', fname, checked, base64: btoa(binary), size: bytes.length };
    })()`);
    if (!result.ok || !result.base64 || result.size < 1) throw new Error(`CSV export failed: ${JSON.stringify(result)}`);
    const outDir = path.join('.o11y', 'goq-unified-print-flow', 'downloads');
    fs.mkdirSync(outDir, { recursive: true });
    const filename = filenameFromDisposition(result.disposition) || safeBasename(result.fname) || `picking-${Date.now()}.csv`;
    const fullName = path.resolve(outDir, filename);
    fs.writeFileSync(fullName, Buffer.from(result.base64, 'base64'));
    return { fullName, size: result.size, checked: result.checked, fname: result.fname, type: result.type };
  }

  async exportPickingCsvForIds(ids) {
    const result = await this.eval(`(async () => {
      const ids = ${JSON.stringify(ids)};
      const data = new URLSearchParams();
      data.set('trader_s3', 'customize_csv_6');
      for (const id of ids) data.append('order_number[]', id);
      const createResponse = await fetch('/goq21/export/create_custom_csv.php?custom_id=6', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data.toString()
      });
      const html = await createResponse.text();
      const marker = 'infile.php?fname=';
      const markerIndex = html.indexOf(marker);
      if (!createResponse.ok || markerIndex < 0) return { ok: false, step: 'create', status: createResponse.status, html: html.slice(0, 500), checked: ids };
      const fname = html.slice(markerIndex + marker.length).split('"')[0].split("'")[0].split(')')[0].trim();
      const csvResponse = await fetch('/goq21/infile.php?fname=' + encodeURIComponent(fname), { credentials: 'same-origin' });
      const buffer = await csvResponse.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { ok: csvResponse.ok, status: csvResponse.status, type: csvResponse.headers.get('content-type') || '', disposition: csvResponse.headers.get('content-disposition') || '', fname, checked: ids, base64: btoa(binary), size: bytes.length };
    })()`);
    if (!result.ok || !result.base64 || result.size < 1) throw new Error(`CSV export failed: ${JSON.stringify(result)}`);
    const outDir = path.join('.o11y', 'goq-unified-print-flow', 'downloads');
    fs.mkdirSync(outDir, { recursive: true });
    const filename = filenameFromDisposition(result.disposition) || safeBasename(result.fname) || `picking-${Date.now()}.csv`;
    const fullName = path.resolve(outDir, filename);
    fs.writeFileSync(fullName, Buffer.from(result.base64, 'base64'));
    return { fullName, size: result.size, checked: result.checked, fname: result.fname, type: result.type };
  }

  // PDFビューアのツールバーの印刷ボタンを押して、Chromeの印刷プレビューを開く
  async printPdf(printer) {
    await waitUntil(() => this.eval(`Boolean(document.querySelector('pdf-viewer'))`), 30000, 500);
    await this.eval(`(() => {
      document.querySelector('pdf-viewer')
        .shadowRoot
        .querySelector('viewer-toolbar#toolbar, viewer-toolbar, #toolbar')
        .shadowRoot
        .querySelector('cr-icon-button#print, #print')
        .click();
      return true;
    })()`);
    await wait(2500);
    return configureAndPressPrintPreview(this.port, { printer, color: 'bw', duplex: false });
  }
}

// ローカルで作ったピッキングPDFを新しいタブで開き、PDFビューアに接続する
async function openPdfInNewTab(port, pdfPath) {
  const created = await fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent(fileUrlForBrowser(pdfPath))}`), { method: 'PUT' }).then(r => r.json());
  let viewerTarget;
  await waitUntil(async () => {
    const current = await listTargets(port);
    viewerTarget = current.find(t => t.type === 'iframe' && t.parentId === created.id && t.url.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai'));
    return Boolean(viewerTarget);
  }, 30000, 500);
  return {
    viewer: new CdpPage(viewerTarget.webSocketDebuggerUrl, port),
    async close() {
      await fetch(cdpHttpUrl(port, `/json/close/${created.id}`)).catch(() => {});
    },
  };
}

async function configureAndPressPrintPreview(port, { printer, color, duplex }) {
  const preview = await waitForPrintPreview(port);
  await preview.enable();
  await waitUntil(() => preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app?.shadowRoot?.querySelector('print-preview-sidebar')?.shadowRoot;
    const destSelect = side?.querySelector('print-preview-destination-settings')?.shadowRoot?.querySelector('print-preview-destination-select')?.shadowRoot?.querySelector('select');
    const button = side?.querySelector('print-preview-button-strip')?.shadowRoot?.querySelector('cr-button.action-button');
    return !!destSelect && !!button;
  })()`), 30000, 500);
  await preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
    const destSelect = side.querySelector('print-preview-destination-settings').shadowRoot.querySelector('print-preview-destination-select').shadowRoot.querySelector('select');
    const option = Array.from(destSelect.options).find(opt => (opt.textContent || opt.value || '').includes(${JSON.stringify(printer)}));
    if (option) {
      destSelect.value = option.value;
      destSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const colorSelect = side.querySelector('print-preview-color-settings')?.shadowRoot?.querySelector('select');
    if (colorSelect) {
      colorSelect.value = ${JSON.stringify(color)};
      colorSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const more = side.querySelector('print-preview-more-settings')?.shadowRoot?.querySelector('cr-expand-button');
    if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
    const duplexBox = side.querySelector('print-preview-duplex-settings')?.shadowRoot?.querySelector('cr-checkbox#duplex');
    if (duplexBox && duplexBox.checked !== ${JSON.stringify(duplex)}) duplexBox.click();
    return true;
  })()`);
  await wait(1000);
  const verified = await preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
    const destination = side.querySelector('print-preview-destination-settings').shadowRoot.querySelector('print-preview-destination-select').shadowRoot.querySelector('.md-select, select')?.innerText || '';
    const colorValue = side.querySelector('print-preview-color-settings')?.shadowRoot?.querySelector('select')?.value || '';
    const duplexBox = side.querySelector('print-preview-duplex-settings')?.shadowRoot?.querySelector('cr-checkbox#duplex');
    const pages = app.shadowRoot.querySelector('print-preview-preview-area')?.shadowRoot?.innerText || '';
    return { destination, color: colorValue, duplex: duplexBox ? duplexBox.checked : false, pages };
  })()`);
  if (!normalizeText(verified.destination).includes(normalizeText(printer))) throw new Error(`Print destination mismatch: ${verified.destination}`);
  if (verified.color && verified.color !== color) throw new Error(`Print color mismatch: ${verified.color}`);
  if (verified.duplex !== duplex) throw new Error(`Print duplex mismatch: ${verified.duplex}`);
  const shot = await preview.send('Page.captureScreenshot', { format: 'png' });
  const screenshotDir = path.join('.o11y', 'goq-unified-print-flow', 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `print-preview-${Date.now()}.png`);
  fs.writeFileSync(screenshotPath, Buffer.from(shot.result.data, 'base64'));
  await preview.eval(`(() => {
    document.querySelector('print-preview-app').shadowRoot.querySelector('print-preview-sidebar').shadowRoot.querySelector('print-preview-button-strip').shadowRoot.querySelector('cr-button.action-button').click();
    return true;
  })()`);
  await wait(2000);
  return { printer, screenshot: screenshotPath, pages: verified.pages, color, duplex };
}

async function waitForPrintPreview(port) {
  const target = await waitUntil(async () => {
    const targets = await listTargets(port);
    return targets.find(t => t.type === 'page' && t.url.startsWith('chrome://print/'));
  }, 30000, 1000);
  return new CdpPage(target.webSocketDebuggerUrl, port);
}

function filenameFromDisposition(disposition) {
  const utf8Match = String(disposition || '').match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return safeBasename(decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, '')));
  const asciiMatch = String(disposition || '').match(/filename="?([^";]+)"?/i);
  return asciiMatch ? safeBasename(asciiMatch[1].trim()) : '';
}

function safeBasename(name) {
  return path.basename(String(name || '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

async function waitUntil(fn, timeoutMs, intervalMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return true;
    await wait(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const goq = await connectOrOpen(port, `${GOQ_LIST_URL}?stat=${status}&page=1`, page => page.url.includes('order.goqsystem.com/goq21'));
  await goq.enable();
  const currentUrl = await goq.eval('location.href');
  if (!String(currentUrl).includes('order.goqsystem.com')) {
    await goq.navigate(`${GOQ_LIST_URL}?stat=${status}&page=1`);
  }
  const csv = await goq.exportPickingCsvForIds(ids);
  step('exported picking csv', { file: csv.fullName, bytes: csv.size, checked: csv.checked });

  // ベニー様版: Smart Pick を使わず、ローカルで集計したPDFを印刷する
  const localPicking = await buildLocalPickingPdf({ csvPath: csv.fullName, outDir: LOCAL_PICKING_DIR, port });
  step('generated local picking pdf', localPicking.summary);
  const pdf = await openPdfInNewTab(port, localPicking.files.pdf);
  let preview;
  try {
    await pdf.viewer.enable();
    preview = await pdf.viewer.printPdf(PICKING_PRINTER);
  } finally {
    await pdf.close();
  }
  step('printed picking list', { ...preview, source: 'local-picking-pdf', pdf: localPicking.files.pdf });

  run.finishedAt = new Date().toISOString();
  const logFile = path.join('.o11y', 'goq-unified-print-flow', 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-picking-only.json`);
  fs.writeFileSync(logFile, JSON.stringify(run, null, 2), 'utf8');
  console.log(JSON.stringify({ logFile: path.resolve(logFile), csv, pdf: localPicking.files.pdf, preview }, null, 2));
}

await main();
