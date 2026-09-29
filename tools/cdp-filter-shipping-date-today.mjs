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

const realClick = async point => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 90));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.bringToFront');
await send('Input.setIgnoreInputEvents', { ignore: false });

const selectResult = await evalJs(`(() => {
  const selects = Array.from(document.querySelectorAll('select#s_day_type'));
  const select = selects.find(s => (s.parentElement?.innerText || '').includes('今日')) || selects[0];
  if (!select) return { ok: false, error: 'period select not found' };

  select.scrollIntoView({ block: 'center', inline: 'center' });
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(select, 'a59');
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));

  return {
    ok: true,
    url: location.href,
    selected: { value: select.value, text: select.selectedOptions[0]?.textContent.trim() || '' },
    selectIndex: selects.indexOf(select)
  };
})()`);

const selected = selectResult.result?.result?.value;
if (!selected?.ok) {
  console.log(JSON.stringify({ ok: false, step: 'select 出荷日', result: selected }, null, 2));
  ws.close();
  process.exit(0);
}

await new Promise(r => setTimeout(r, 700));

const todayResult = await evalJs(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const today = buttons.find(b => (b.innerText || b.textContent || '').trim() === '今日');
  if (!today) return { ok: false, error: '今日 button not found' };
  today.scrollIntoView({ block: 'center', inline: 'center' });
  const r = today.getBoundingClientRect();
  return {
    ok: true,
    disabled: today.disabled,
    text: today.innerText.trim(),
    point: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    rect: { x: r.x, y: r.y, width: r.width, height: r.height }
  };
})()`);

const today = todayResult.result?.result?.value;
if (!today?.ok || today.disabled) {
  console.log(JSON.stringify({ ok: false, step: 'today button', selected, today }, null, 2));
  ws.close();
  process.exit(0);
}
await realClick(today.point);
await new Promise(r => setTimeout(r, 700));

const searchResult = await evalJs(`(() => {
  const button = document.querySelector('button#search[name="search"]');
  if (!button) return { ok: false, error: '絞り込む button not found' };
  button.scrollIntoView({ block: 'center', inline: 'center' });
  const r = button.getBoundingClientRect();
  const data = {
    s_day_type: Array.from(document.querySelectorAll('[name="s_day_type"]')).map(e => ({ tag: e.tagName, type: e.type || '', value: e.value })),
    s_day_today: Array.from(document.querySelectorAll('[name="s_day_today"]')).map(e => ({ tag: e.tagName, type: e.type || '', checked: !!e.checked, value: e.value })),
    from: {
      year: document.querySelector('[name="from_year"]')?.value || '',
      month: document.querySelector('[name="from_month"]')?.value || '',
      day: document.querySelector('[name="from_day"]')?.value || ''
    },
    to: {
      year: document.querySelector('[name="to_year"]')?.value || '',
      month: document.querySelector('[name="to_month"]')?.value || '',
      day: document.querySelector('[name="to_day"]')?.value || ''
    }
  };
  return {
    ok: true,
    disabled: button.disabled,
    point: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    data
  };
})()`);

const search = searchResult.result?.result?.value;
if (!search?.ok || search.disabled) {
  console.log(JSON.stringify({ ok: false, step: 'search button', selected, today, search }, null, 2));
  ws.close();
  process.exit(0);
}

await realClick(search.point);
await new Promise(r => setTimeout(r, 3500));

const afterResult = await evalJs(`(() => ({
  url: location.href,
  title: document.title,
  s_day_type: Array.from(document.querySelectorAll('[name="s_day_type"]')).map(e => ({ tag: e.tagName, type: e.type || '', value: e.value, text: e.selectedOptions?.[0]?.textContent?.trim?.() || '' })),
  s_day_today: Array.from(document.querySelectorAll('[name="s_day_today"]')).map(e => ({ tag: e.tagName, type: e.type || '', checked: !!e.checked, value: e.value })),
  resultText: document.querySelector('#conditiontext')?.value || document.body?.innerText?.match(/\\d+〜\\d+件 \\/ \\d+件/)?.[0] || ''
}))()`);

console.log(JSON.stringify({
  ok: true,
  selected,
  today,
  search,
  after: afterResult.result?.result?.value || null
}, null, 2));

ws.close();
