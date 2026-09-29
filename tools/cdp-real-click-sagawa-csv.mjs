#!/usr/bin/env node
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || '9223');

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t =>
  t.type === 'page' &&
  t.url.includes('order.goqsystem.com/goq21/index_beta.php')
);

if (!page) {
  throw new Error(`GoQ page not found on port ${port}`);
}

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
await send('Input.setIgnoreInputEvents', { ignore: false });

const beforeResult = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    const select = document.querySelector('#trader_s3');
    if (!select) return { ok: false, error: 'select not found' };

    const option = Array.from(select.options).find(o =>
      o.value === 'customize_csv_6' || o.textContent.trim() === '出荷担当者用'
    );
    if (!option) return { ok: false, error: 'option not found' };

    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const button = select.nextElementSibling?.tagName === 'BUTTON'
      ? select.nextElementSibling
      : null;
    if (!button) {
      return {
        ok: false,
        error: 'button not found',
        next: select.nextElementSibling?.outerHTML || null
      };
    }

    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return {
      ok: true,
      url: location.href,
      selectedCsv: {
        value: select.value,
        text: select.selectedOptions[0]?.textContent.trim() || ''
      },
      button: {
        selector: '#trader_s3 + button',
        text: button.innerText.trim(),
        html: button.outerHTML,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height
      },
      checkedOrders: Array.from(document.querySelectorAll('input[type=checkbox]:checked'))
        .map(cb => cb.value || cb.name || cb.id)
        .filter(Boolean)
        .slice(0, 20)
    };
  })()`
});

const before = beforeResult.result?.result?.value;
if (!before?.ok) {
  console.log(JSON.stringify(before || beforeResult, null, 2));
  ws.close();
  process.exit(before ? 0 : 1);
}

const { x, y } = before.button;
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x,
  y,
  button: 'left',
  buttons: 1,
  clickCount: 1
});
await new Promise(resolve => setTimeout(resolve, 120));
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x,
  y,
  button: 'left',
  buttons: 0,
  clickCount: 1
});
await new Promise(resolve => setTimeout(resolve, 3000));

const afterResult = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => ({
    url: location.href,
    title: document.title,
    selectedCsv: document.querySelector('#trader_s3')
      ? {
          value: document.querySelector('#trader_s3').value,
          text: document.querySelector('#trader_s3').selectedOptions[0]?.textContent.trim() || ''
        }
      : null,
    checkedOrders: Array.from(document.querySelectorAll('input[type=checkbox]:checked'))
      .map(cb => cb.value || cb.name || cb.id)
      .filter(Boolean)
      .slice(0, 20),
    bodyTextStart: document.body?.innerText?.slice(0, 500) || ''
  }))()`
});

console.log(JSON.stringify({
  ok: true,
  target: before,
  after: afterResult.result?.result?.value || null
}, null, 2));

ws.close();
