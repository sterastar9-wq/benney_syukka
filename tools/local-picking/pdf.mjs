// ピッキングリストのHTMLをA4のPDFにする。
// - htmlToPdfViaCdp: 印刷フローが使っているリモートデバッグ付きChromeに新しいタブを開いて Page.printToPDF する（Docker実行でも使える）
// - htmlToPdfViaHeadlessChrome: 単体確認用。ローカルのChromeをヘッドレスで起動して --print-to-pdf する

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { cdpHttpUrl, cdpWebSocketUrl, fileUrlForBrowser } from '../cdp-connection.mjs';

const execFile = promisify(execFileCallback);

const CHROME_CANDIDATES = [
  process.env.PICKING_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function openSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cdpWebSocketUrl(wsUrl), { perMessageDeflate: false });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function makeSender(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const waitEvent = (method, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(fn); reject(new Error(`${method} timed out`)); }, timeoutMs);
    const fn = msg => { if (msg.method === method) { clearTimeout(timer); listeners.delete(fn); resolve(msg.params); } };
    listeners.add(fn);
  });
  return { send, waitEvent };
}

// 新しいタブでHTMLを開いてPDFを書き出す。タブはPDF作成後に閉じる。
export async function htmlToPdfViaCdp(port, htmlPath, pdfPath) {
  const target = await fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent('about:blank')}`), { method: 'PUT' }).then(r => r.json());
  const ws = await openSocket(target.webSocketDebuggerUrl);
  const { send, waitEvent } = makeSender(ws);
  try {
    await send('Page.enable');
    const loaded = waitEvent('Page.loadEventFired', 30000);
    await send('Page.navigate', { url: fileUrlForBrowser(htmlPath) });
    await loaded;
    await send('Runtime.evaluate', { expression: 'document.fonts ? document.fonts.ready.then(() => true) : true', awaitPromise: true });
    const result = await send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });
    fs.writeFileSync(pdfPath, Buffer.from(result.data, 'base64'));
  } finally {
    ws.close();
    await fetch(cdpHttpUrl(port, `/json/close/${target.id}`)).catch(() => {});
  }
  return pdfPath;
}

export function findChrome() {
  return CHROME_CANDIDATES.find(p => fs.existsSync(p)) || '';
}

export async function htmlToPdfViaHeadlessChrome(htmlPath, pdfPath, chromePath = findChrome()) {
  if (!chromePath) throw new Error('Chromeが見つかりません。PICKING_CHROME_PATH にchrome.exeのパスを設定してください。');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-picking-chrome-'));
  try {
    await execFile(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${path.resolve(pdfPath)}`,
      fileUrlForBrowser(path.resolve(htmlPath)),
    ], { timeout: 60000 });
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 100) throw new Error(`PDFが作成されませんでした: ${pdfPath}`);
  return pdfPath;
}

export function isPdfFile(file) {
  if (!fs.existsSync(file)) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    return head.toString('latin1') === '%PDF-';
  } finally {
    fs.closeSync(fd);
  }
}
