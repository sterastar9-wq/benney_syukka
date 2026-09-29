#!/usr/bin/env node
import { WebSocket } from 'ws';
import { cdpHttpUrl, cdpWebSocketUrl } from './cdp-connection.mjs';

const [portArg = '9223'] = process.argv.slice(2);
const port = Number(portArg);

const targets = await (await fetch(cdpHttpUrl(port, '/json/list'))).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('/goq21/dashboard/'));
if (!page) {
  console.log(JSON.stringify({ handled: false, error: 'dashboard target not found' }, null, 2));
  process.exit(1);
}

const ws = new WebSocket(cdpWebSocketUrl(page.webSocketDebuggerUrl));
let seq = 0;
const pending = new Map();
ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

const send = (method, params = {}) => new Promise(resolve => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Page.bringToFront');

const expression = `(async () => {
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const textOf = el => (el?.innerText || el?.textContent || el?.value || '').replace(/\\s+/g, ' ').trim();
  const compactTextOf = el => textOf(el).replace(/\\s+/g, '');
  const scrollIntoNoticeView = el => {
    for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        const box = el.getBoundingClientRect();
        const parent = node.getBoundingClientRect();
        node.scrollTop += box.top - parent.top - Math.max(20, parent.height / 3);
      }
    }
    el?.scrollIntoView?.({ block: 'center', inline: 'center' });
  };
  const candidates = Array.from(document.querySelectorAll('[role="dialog"], .modal, .ui-dialog, form, div'))
    .filter(visible)
    .map(el => {
      const text = textOf(el);
      const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]')).filter(input => !input.disabled);
      const submit = Array.from(el.querySelectorAll('button, input[type="submit"], input[type="button"]')).find(btn => {
        const label = compactTextOf(btn);
        return /上記について確認しました|確認しました|submit|送信|確認|同意|OK|保存|次へ/i.test(label + ' ' + (btn.type || ''));
      });
      return { el, text, boxes, submit };
    })
    .filter(item => item.boxes.length > 0 && item.submit && /通知|お知らせ|確認|同意|重要|チェック|上記について確認しました/.test(item.text));
  const modal = candidates.sort((a, b) => {
    const aExact = /上記について確認しました|確認しました/.test(compactTextOf(a.submit)) ? 1 : 0;
    const bExact = /上記について確認しました|確認しました/.test(compactTextOf(b.submit)) ? 1 : 0;
    return bExact - aExact || b.boxes.length - a.boxes.length;
  })[0];
  if (!modal) return { handled: false, url: location.href, candidateCount: candidates.length };
  const checkedLabels = [];
  for (const box of modal.boxes) {
    scrollIntoNoticeView(box);
    await new Promise(resolve => setTimeout(resolve, 80));
    if (!box.checked) {
      box.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const label = box.id ? document.querySelector('label[for="' + CSS.escape(box.id) + '"]') : null;
    checkedLabels.push(textOf(label) || textOf(box.closest('label')) || box.name || box.id || '');
  }
  scrollIntoNoticeView(modal.submit);
  await new Promise(resolve => setTimeout(resolve, 150));
  if (modal.submit.disabled || modal.submit.getAttribute('aria-disabled') === 'true') {
    modal.el.scrollTop = modal.el.scrollHeight;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const submitText = textOf(modal.submit);
  const disabled = modal.submit.disabled || modal.submit.getAttribute('aria-disabled') === 'true';
  if (disabled) {
    return {
      handled: false,
      found: true,
      error: 'submit disabled',
      checkboxCount: modal.boxes.length,
      checkedCount: modal.boxes.filter(box => box.checked).length,
      submitText
    };
  }
  modal.submit.click();
  return {
    handled: true,
    checkboxCount: modal.boxes.length,
    checkedCount: modal.boxes.filter(box => box.checked).length,
    checkedLabels: checkedLabels.filter(Boolean).slice(0, 20),
    submitText
  };
})()`;

const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
});

ws.close();

if (result.exceptionDetails) {
  console.error(JSON.stringify(result.exceptionDetails, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(result.result?.result?.value ?? null, null, 2));
