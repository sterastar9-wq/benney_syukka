#!/usr/bin/env node
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || '9223');

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t =>
  t.type === 'page' &&
  t.url.includes('order.goqsystem.com/goq21/index_beta.php')
);
if (!page) throw new Error('GoQ page not found');

const connect = async wsUrl => {
  const ws = new WebSocket(wsUrl);
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
  return { ws, send, events };
};

const pageConn = await connect(page.webSocketDebuggerUrl);
await pageConn.send('Page.enable');
await pageConn.send('Runtime.enable');
await pageConn.send('Network.enable');
await pageConn.send('Page.bringToFront');
await pageConn.send('Input.setIgnoreInputEvents', { ignore: false });

const before = await pageConn.send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    const select = document.querySelector('#trader_s3');
    if (!select) return { ok: false, error: 'select not found' };
    const option = Array.from(select.options).find(o => o.value === 'customize_csv_6');
    if (!option) return { ok: false, error: 'csv option not found' };
    select.focus();
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const checked = Array.from(document.getElementsByName('order_number[]'))
      .filter(e => e.checked)
      .map(e => e.value);
    const button = document.querySelector('#trader_s3 + button');
    if (!button) return { ok: false, error: 'button not found' };
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return {
      ok: true,
      url: location.href,
      hasFocus: document.hasFocus(),
      selectedCsv: { value: select.value, text: select.selectedOptions[0]?.textContent.trim() || '' },
      checked,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    };
  })()`
});

const target = before.result?.result?.value;
if (!target?.ok) {
  console.log(JSON.stringify({ ok: false, target }, null, 2));
  pageConn.ws.close();
  process.exit(0);
}

const { x, y } = target.point;
await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
await pageConn.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x,
  y,
  button: 'left',
  buttons: 1,
  clickCount: 1
});
await new Promise(resolve => setTimeout(resolve, 80));
await pageConn.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x,
  y,
  button: 'left',
  buttons: 0,
  clickCount: 1
});

await new Promise(resolve => setTimeout(resolve, 5000));

const afterTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const after = await pageConn.send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => ({
    url: location.href,
    title: document.title,
    hasFocus: document.hasFocus(),
    selectedCsv: document.querySelector('#trader_s3')
      ? {
          value: document.querySelector('#trader_s3').value,
          text: document.querySelector('#trader_s3').selectedOptions[0]?.textContent.trim() || ''
        }
      : null,
    checked: Array.from(document.getElementsByName('order_number[]'))
      .filter(e => e.checked)
      .map(e => e.value)
  }))()`
});

console.log(JSON.stringify({
  ok: true,
  target,
  after: after.result?.result?.value || null,
  pages: afterTargets
    .filter(t => t.type === 'page')
    .map(t => ({ title: t.title, url: t.url })),
  network: pageConn.events
    .filter(e =>
      e.method?.startsWith('Network.') ||
      e.method === 'Page.downloadWillBegin' ||
      e.method === 'Page.downloadProgress'
    )
    .map(e => ({ method: e.method, params: e.params }))
    .slice(-80)
}, null, 2));

pageConn.ws.close();
