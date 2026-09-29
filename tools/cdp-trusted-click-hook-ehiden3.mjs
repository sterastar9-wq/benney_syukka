#!/usr/bin/env node
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || '9223');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('order.goqsystem.com/goq21/index_beta.php'));
if (!page) throw new Error('GoQ page not found');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push(msg);
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
await send('Network.enable');
await send('Page.bringToFront');
await send('Input.setIgnoreInputEvents', { ignore: false });

const prep = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    window.__ehiden3Log = { downcsv: [], submit: [], click: [] };
    if (!window.__origDowncsvForEhiden3) window.__origDowncsvForEhiden3 = window.downcsv;
    if (!window.__origSubmitForEhiden3) window.__origSubmitForEhiden3 = HTMLFormElement.prototype.submit;

    window.downcsv = function(e) {
      window.__ehiden3Log.downcsv.push({
        trusted: e?.nativeEvent?.isTrusted ?? e?.isTrusted ?? null,
        currentTarget: e?.currentTarget?.tagName || null,
        trader_s: document.querySelector('#trader_s')?.value,
        checked: Array.from(document.getElementsByName('order_number[]')).filter(i => i.checked).map(i => i.value)
      });
      return window.__origDowncsvForEhiden3.apply(this, arguments);
    };

    HTMLFormElement.prototype.submit = function() {
      window.__ehiden3Log.submit.push({
        id: this.id,
        action: this.action,
        target: this.target,
        method: this.method,
        trader_s: document.querySelector('#trader_s')?.value,
        checked: Array.from(document.getElementsByName('order_number[]')).filter(i => i.checked).map(i => i.value)
      });
      return window.__origSubmitForEhiden3.apply(this, arguments);
    };

    const select = document.querySelector('#trader_s');
    if (!select) return { ok: false, error: '#trader_s not found' };
    select.value = 'ehiden_ver3';
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const button = document.querySelector('#trader_s + button');
    if (!button) return { ok: false, error: '#trader_s + button not found' };
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      button.addEventListener(type, e => window.__ehiden3Log.click.push({
        type,
        trusted: e.isTrusted,
        text: (e.target?.innerText || e.target?.value || '').trim(),
        trader_s: document.querySelector('#trader_s')?.value
      }), true);
    });

    button.scrollIntoView({ block: 'center', inline: 'center' });
    const r = button.getBoundingClientRect();
    return {
      ok: true,
      selected: { value: select.value, text: select.selectedOptions[0]?.textContent.trim() || '' },
      checked: Array.from(document.getElementsByName('order_number[]')).filter(i => i.checked).map(i => i.value),
      button: { text: button.innerText.trim(), name: button.name || '', selector: '#trader_s + button' },
      point: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
      rect: { x: r.x, y: r.y, width: r.width, height: r.height }
    };
  })()`
});

const target = prep.result?.result?.value;
if (!target?.ok) {
  console.log(JSON.stringify({ ok: false, target }, null, 2));
  ws.close();
  process.exit(0);
}

const { x, y } = target.point;
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
await new Promise(r => setTimeout(r, 100));
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
await new Promise(r => setTimeout(r, 5000));

const afterTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const after = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => ({
    url: location.href,
    selected: document.querySelector('#trader_s')
      ? {
          value: document.querySelector('#trader_s').value,
          text: document.querySelector('#trader_s').selectedOptions[0]?.textContent.trim() || ''
        }
      : null,
    checked: Array.from(document.getElementsByName('order_number[]')).filter(i => i.checked).map(i => i.value),
    log: window.__ehiden3Log || null
  }))()`
});

console.log(JSON.stringify({
  ok: true,
  target,
  after: after.result?.result?.value || null,
  pages: afterTargets.filter(t => t.type === 'page').map(t => ({ title: t.title, url: t.url })),
  network: events.filter(e => e.method?.startsWith('Network.') || e.method?.startsWith('Page.download'))
    .map(e => ({ method: e.method, params: e.params }))
    .slice(-80)
}, null, 2));

ws.close();
