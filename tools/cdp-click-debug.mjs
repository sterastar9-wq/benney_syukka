#!/usr/bin/env node
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || '9223');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('order.goqsystem.com/goq21/index_beta.php'));
if (!page) throw new Error('GoQ page not found');

const ws = new WebSocket(page.webSocketDebuggerUrl);
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

const prep = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    window.__csvClickDebug = [];
    const select = document.querySelector('#trader_s3');
    select.value = 'customize_csv_6';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const button = document.querySelector('#trader_s3 + button');
    const listener = e => {
      const r = button.getBoundingClientRect();
      window.__csvClickDebug.push({
        type: e.type,
        trusted: e.isTrusted,
        target: e.target?.tagName,
        targetText: (e.target?.innerText || e.target?.value || '').trim(),
        clientX: e.clientX,
        clientY: e.clientY,
        buttonRect: { x: r.x, y: r.y, w: r.width, h: r.height },
        selected: select.value,
        checked: Array.from(document.getElementsByName('order_number[]')).filter(i => i.checked).map(i => i.value)
      });
    };
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      document.addEventListener(type, listener, true);
      button.addEventListener(type, listener, true);
    });
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const r = button.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, rect: { x:r.x, y:r.y, w:r.width, h:r.height }, inner: { w: innerWidth, h: innerHeight }, focus: document.hasFocus() };
  })()`
});

const point = prep.result.result.value;
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
await new Promise(r => setTimeout(r, 100));
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
await new Promise(r => setTimeout(r, 1000));

const result = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => ({ point: ${JSON.stringify(point)}, log: window.__csvClickDebug || [], url: location.href }))()`
});
console.log(JSON.stringify(result.result.result.value, null, 2));
ws.close();
