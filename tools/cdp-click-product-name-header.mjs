#!/usr/bin/env node
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || '9223');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t =>
  t.type === 'page' &&
  t.url.includes('order.goqsystem.com/goq21/index_beta.php')
);
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
await send('Input.setIgnoreInputEvents', { ignore: false });

const prep = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    const links = Array.from(document.querySelectorAll('#order-list-table thead a'));
    const link = links.find(el => (el.innerText || el.textContent || '').trim() === '商品名');
    if (!link) {
      return {
        ok: false,
        error: '商品名 header link not found',
        links: links.map(el => (el.innerText || el.textContent || '').trim())
      };
    }
    link.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = link.getBoundingClientRect();
    return {
      ok: true,
      url: location.href,
      selector: '#order-list-table thead a[text="商品名"]',
      text: link.innerText.trim(),
      href: link.href,
      point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
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
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x,
  y,
  button: 'left',
  buttons: 1,
  clickCount: 1
});
await new Promise(resolve => setTimeout(resolve, 100));
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x,
  y,
  button: 'left',
  buttons: 0,
  clickCount: 1
});
await new Promise(resolve => setTimeout(resolve, 1500));

const after = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => ({
    url: location.href,
    title: document.title,
    checkedOrders: Array.from(document.getElementsByName('order_number[]'))
      .filter(input => input.checked)
      .map(input => input.value)
  }))()`
});

console.log(JSON.stringify({
  ok: true,
  target,
  after: after.result?.result?.value || null
}, null, 2));

ws.close();
