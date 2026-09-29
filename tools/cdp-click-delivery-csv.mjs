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

const prep = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    window.__deliveryCsvLog = { submit: [], downcsv: [] };
    if (!window.__origSubmitForDeliveryCsv) window.__origSubmitForDeliveryCsv = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function() {
      window.__deliveryCsvLog.submit.push({
        id: this.id,
        action: this.action,
        target: this.target,
        method: this.method,
        trader_s: document.querySelector('#trader_s')?.value,
        checked: Array.from(document.getElementsByName('order_number[]')).filter(i => i.checked).map(i => i.value)
      });
      return window.__origSubmitForDeliveryCsv.apply(this, arguments);
    };

    const select = document.querySelector('#trader_s');
    if (!select) return { ok: false, error: 'select #trader_s not found' };
    const option = Array.from(select.options).find(o => o.value === 'ehiden_ver3' || o.textContent.trim() === 'e-飛伝Ⅲ');
    if (!option) return { ok: false, error: 'e-飛伝Ⅲ option not found' };
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const button = select.nextElementSibling?.tagName === 'BUTTON'
      ? select.nextElementSibling
      : document.querySelector('#trader_s + button');
    if (!button) return { ok: false, error: 'output button not found' };
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const r = button.getBoundingClientRect();
    return {
      ok: true,
      url: location.href,
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
await new Promise(r => setTimeout(r, 4000));

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
    log: window.__deliveryCsvLog || null
  }))()`
});

console.log(JSON.stringify({
  ok: true,
  target,
  after: after.result?.result?.value || null,
  pages: afterTargets.filter(t => t.type === 'page').map(t => ({ title: t.title, url: t.url })),
  network: events.filter(e => e.method?.startsWith('Network.') || e.method?.startsWith('Page.download'))
    .map(e => ({ method: e.method, params: e.params }))
    .slice(-60)
}, null, 2));

ws.close();
