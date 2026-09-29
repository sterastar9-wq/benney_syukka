#!/usr/bin/env node
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || '9223');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t =>
  t.type === 'page' &&
  t.url.includes('order.goqsystem.com/goq21/index_beta.php')
);
if (!page) throw new Error('GoQ order list page not found');

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
const evalJs = expression => send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
const click = async point => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 90));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.bringToFront');
await send('Input.setIgnoreInputEvents', { ignore: false });

const radioResult = await evalJs(`(() => {
  const radio = Array.from(document.querySelectorAll('input[name="reportnum"][type="radio"]'))
    .find(input => input.value === '3');
  if (!radio) return { ok: false, error: 'reportnum=3 radio not found' };
  radio.scrollIntoView({ block: 'center', inline: 'center' });
  const r = radio.getBoundingClientRect();
  const propsKey = Object.keys(radio).find(key => key.startsWith('__reactProps$'));
  const props = propsKey ? radio[propsKey] : null;
  if (props?.onChange) {
    props.onChange({ currentTarget: radio, target: radio });
  } else {
    radio.checked = true;
    radio.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    radio.dispatchEvent(new Event('input', { bubbles: true }));
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return {
    ok: true,
    usedReactOnChange: !!props?.onChange,
    before: Array.from(document.querySelectorAll('input[name="reportnum"][type="radio"]'))
      .map(input => ({ value: input.value, checked: input.checked, label: input.closest('label')?.innerText?.trim() || '' })),
    point: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    rect: { x: r.x, y: r.y, width: r.width, height: r.height }
  };
})()`);

const radio = radioResult.result?.result?.value;
if (!radio?.ok) {
  console.log(JSON.stringify({ ok: false, step: 'reportnum radio', radio }, null, 2));
  ws.close();
  process.exit(0);
}
await new Promise(r => setTimeout(r, 500));

const searchResult = await evalJs(`(() => {
  const button = document.querySelector('button#search[name="search"]');
  if (!button) return { ok: false, error: 'search button not found' };
  button.scrollIntoView({ block: 'center', inline: 'center' });
  const r = button.getBoundingClientRect();
  const form = button.closest('form');
  return {
    ok: true,
    reportnum: Array.from(document.querySelectorAll('input[name="reportnum"]'))
      .map(input => ({ tag: input.tagName, type: input.type || '', value: input.value, checked: !!input.checked })),
    formData: form ? Array.from(new FormData(form).entries())
      .filter(([key]) => ['reportnum', 'stat', 's_day_type', 'from_year', 'from_month', 'from_day', 'to_year', 'to_month', 'to_day', 'order'].includes(key)) : [],
    point: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    rect: { x: r.x, y: r.y, width: r.width, height: r.height }
  };
})()`);

const search = searchResult.result?.result?.value;
if (!search?.ok) {
  console.log(JSON.stringify({ ok: false, step: 'search', radio, search }, null, 2));
  ws.close();
  process.exit(0);
}
await click(search.point);
await new Promise(r => setTimeout(r, 3500));

const afterResult = await evalJs(`(() => ({
  url: location.href,
  title: document.title,
  reportnum: Array.from(document.querySelectorAll('input[name="reportnum"]'))
    .map(input => ({ tag: input.tagName, type: input.type || '', value: input.value, checked: !!input.checked })),
  condition: document.querySelector('#conditiontext')?.value || document.body?.innerText?.match(/\\d+〜\\d+件 \\/ \\d+件/)?.[0] || ''
}))()`);

console.log(JSON.stringify({
  ok: true,
  radio,
  search,
  after: afterResult.result?.result?.value || null
}, null, 2));

ws.close();
