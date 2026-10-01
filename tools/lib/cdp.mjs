// 小さな CDP クライアント。goq-login / yamato-b2 など、印刷フロー本体以外のツールで共有する。
// （tools/goq-print-flow.mjs は独自の CdpPage を持つ。ここでは同じ最小インターフェース eval/navigate/click/screenshot を提供する）
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { cdpHttpUrl, cdpWebSocketUrl } from '../cdp-connection.mjs';

export function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitUntil(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await wait(intervalMs);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

export async function listTargets(port) {
  const response = await fetch(cdpHttpUrl(port, '/json/list')).catch(error => {
    throw new Error(`Chrome (port ${port}) に接続できません。scripts\\start-chrome-cdp.ps1 で起動してください: ${error.message}`);
  });
  return response.json();
}

export async function openTarget(port, url) {
  return fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent(url)}`), { method: 'PUT' }).then(r => r.json());
}

export async function closeTarget(port, id) {
  return fetch(cdpHttpUrl(port, `/json/close/${id}`)).catch(() => null);
}

export async function connectOrOpen(port, url, predicate) {
  const targets = await listTargets(port);
  let target = targets.find(t => t.type === 'page' && predicate(t));
  if (!target) target = await openTarget(port, url);
  const page = new CdpPage(target.webSocketDebuggerUrl, port, target.id);
  await page.enable();
  return page;
}

export class CdpPage {
  constructor(wsUrl, port, targetId = '') {
    this.port = port;
    this.targetId = targetId;
    this.seq = 0;
    this.pending = new Map();
    this.dialogs = [];
    this.onDialog = null;
    this.onEvent = null; // (method, params) => void: ダウンロード進捗などのイベントを受け取りたいときに設定する
    this.ws = new WebSocket(cdpWebSocketUrl(wsUrl));
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
        return;
      }
      if (msg.method && this.onEvent) { try { this.onEvent(msg.method, msg.params || {}); } catch {} }
      if (msg.method === 'Page.javascriptDialogOpening') {
        const detail = { type: msg.params?.type || '', message: msg.params?.message || '', at: new Date().toISOString() };
        this.dialogs.push(detail);
        const accept = this.onDialog ? this.onDialog(detail) !== false : true;
        this.send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
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
    await this.send('Input.setIgnoreInputEvents', { ignore: false });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // best effort
    }
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }

  async url() {
    return this.eval('location.href');
  }

  async bringToFront() {
    await this.send('Page.bringToFront');
  }

  async navigate(url, settleMs = 2500) {
    await this.bringToFront();
    await this.send('Page.navigate', { url });
    await wait(settleMs);
  }

  async click(point) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await wait(80);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // 値をJSの文字列リテラルとして埋め込む（パスワード等をログに出さないため、呼び出し側は結果だけ記録する）
  async fillSelector(selector, value) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'not found: ' + ${JSON.stringify(selector)} };
      el.focus();
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, length: el.value.length };
    })()`);
  }

  async clickSelector(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true, text: (el.innerText || el.value || '').trim() };
    })()`);
  }

  async clickByText(text, { exact = true, tags = 'button, input[type="submit"], input[type="button"], a' } = {}) {
    return this.eval(`(() => {
      const norm = v => String(v || '').replace(/\\s+/g, '').trim();
      const want = norm(${JSON.stringify(text)});
      const els = Array.from(document.querySelectorAll(${JSON.stringify(tags)}));
      const el = els.find(e => {
        const label = norm(e.innerText || e.textContent || e.value || e.getAttribute('alt') || e.title);
        return ${exact ? 'label === want' : 'label.includes(want)'};
      });
      if (!el) return { ok: false, error: 'not found by text: ' + ${JSON.stringify(text)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: (el.innerText || el.value || '').trim() };
    })()`);
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result?.data) return '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    return file;
  }

  async pageText(limit = 4000) {
    return this.eval(`(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${limit})`);
  }
}
