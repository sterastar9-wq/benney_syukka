#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || 9223);
const printer = process.argv[3] || '普通紙';
const color = process.argv[4] || 'bw';
const duplex = false;

async function connectToOpenPrintPreview(port) {
  const target = await waitUntil(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    return targets.find(t => t.type === 'page' && t.url.startsWith('chrome://print/') && t.webSocketDebuggerUrl);
  }, 30000, 500);
  return new CdpPage(target.webSocketDebuggerUrl);
}

class CdpPage {
  constructor(wsUrl) {
    this.seq = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
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
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // best effort
    }
  }
}

async function waitUntil(fn, timeoutMs, intervalMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await wait(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

async function main() {
  const preview = await connectToOpenPrintPreview(port);
  await preview.enable();
  await waitUntil(() => preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app?.shadowRoot?.querySelector('print-preview-sidebar')?.shadowRoot;
    const destSelect = side?.querySelector('print-preview-destination-settings')?.shadowRoot
      ?.querySelector('print-preview-destination-select')?.shadowRoot?.querySelector('select');
    const button = side?.querySelector('print-preview-button-strip')?.shadowRoot?.querySelector('cr-button.action-button');
    return !!destSelect && !!button;
  })()`), 30000, 500);

  const selected = await preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
    const destSettings = side.querySelector('print-preview-destination-settings');
    const destSelect = destSettings.shadowRoot.querySelector('print-preview-destination-select').shadowRoot.querySelector('select');
    const direct = Array.from(destSelect.options).find(opt => (opt.textContent || opt.value || '').includes(${JSON.stringify(printer)}));
    if (direct) {
      destSelect.value = direct.value;
      destSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, method: 'direct', value: direct.value, text: direct.textContent };
    }
    return { ok: false, options: Array.from(destSelect.options).map(opt => ({ value: opt.value, text: opt.textContent })) };
  })()`);
  if (!selected.ok) throw new Error(`Target printer not in direct options: ${JSON.stringify(selected)}`);
  await wait(1000);

  await preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
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
    const destSelect = side.querySelector('print-preview-destination-settings').shadowRoot
      .querySelector('print-preview-destination-select').shadowRoot.querySelector('select');
    const selectedOption = destSelect?.selectedOptions?.[0];
    const destination = [destSelect?.value || '', selectedOption?.textContent || ''].join(' ');
    const colorValue = side.querySelector('print-preview-color-settings')?.shadowRoot?.querySelector('select')?.value || '';
    const duplexBox = side.querySelector('print-preview-duplex-settings')?.shadowRoot?.querySelector('cr-checkbox#duplex');
    const pages = app.shadowRoot.querySelector('print-preview-preview-area')?.shadowRoot?.innerText || '';
    const actionButton = side.querySelector('print-preview-button-strip')?.shadowRoot?.querySelector('cr-button.action-button');
    return { destination, color: colorValue, duplex: duplexBox ? duplexBox.checked : false, pages, printEnabled: actionButton?.getAttribute('aria-disabled') !== 'true' };
  })()`);
  if (!normalizeText(verified.destination).includes(normalizeText(printer))) {
    throw new Error(`Print destination mismatch: ${verified.destination}`);
  }
  if (verified.color && verified.color !== color) throw new Error(`Print color mismatch: ${verified.color}`);
  if (verified.duplex !== duplex) throw new Error(`Print duplex mismatch: ${verified.duplex}`);
  if (!verified.printEnabled) throw new Error('Print button is disabled');

  const shot = await preview.send('Page.captureScreenshot', { format: 'png' });
  const screenshotDir = path.join('.o11y', 'goq-unified-print-flow', 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `print-preview-${Date.now()}.png`);
  fs.writeFileSync(screenshotPath, Buffer.from(shot.result.data, 'base64'));

  await preview.eval(`(() => {
    document.querySelector('print-preview-app')
      .shadowRoot.querySelector('print-preview-sidebar')
      .shadowRoot.querySelector('print-preview-button-strip')
      .shadowRoot.querySelector('cr-button.action-button')
      .click();
    return true;
  })()`);
  await wait(2000);
  console.log(JSON.stringify({ printer, screenshotPath, verified }, null, 2));
  preview.close();
}

await main();
