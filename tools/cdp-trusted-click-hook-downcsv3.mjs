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
    window.__downcsv3Log = [];
    window.__submitLog = [];
    if (!window.__origDowncsv3) window.__origDowncsv3 = window.downcsv3;
    if (!window.__origSubmit) window.__origSubmit = HTMLFormElement.prototype.submit;
    window.downcsv3 = function(e) {
      window.__downcsv3Log.push({
        trusted: e?.nativeEvent?.isTrusted ?? e?.isTrusted ?? null,
        currentTarget: e?.currentTarget?.tagName || null,
        selected: document.querySelector('#trader_s3')?.value,
        checked: Array.from(document.getElementsByName('order_number[]')).filter(i => i.checked).map(i => i.value)
      });
      return window.__origDowncsv3.apply(this, arguments);
    };
    HTMLFormElement.prototype.submit = function() {
      window.__submitLog.push({
        id: this.id,
        action: this.action,
        target: this.target,
        method: this.method,
        selected: document.querySelector('#trader_s3')?.value,
        checked: Array.from(document.getElementsByName('order_number[]')).filter(i => i.checked).map(i => i.value)
      });
      return window.__origSubmit.apply(this, arguments);
    };
    const select = document.querySelector('#trader_s3');
    select.value = 'customize_csv_6';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const button = document.querySelector('#trader_s3 + button');
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const r = button.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, rect: {x:r.x,y:r.y,w:r.width,h:r.height}, focus: document.hasFocus() };
  })()`
});

const p = prep.result.result.value;
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
await new Promise(r => setTimeout(r, 100));
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
await new Promise(r => setTimeout(r, 3000));

const result = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => ({ downcsv3: window.__downcsv3Log || [], submit: window.__submitLog || [], url: location.href }))()`
});

console.log(JSON.stringify({
  point: p,
  result: result.result.result.value,
  network: events.filter(e => e.method?.startsWith('Network.')).map(e => ({ method:e.method, params:e.params })).slice(-40)
}, null, 2));
ws.close();
