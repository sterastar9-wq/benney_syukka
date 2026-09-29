#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const [run = 'goq-sagawa-select-all', portArg = '9223'] = process.argv.slice(2);
const port = Number(portArg);
const root = path.join('.o11y', run);
const cdp = path.join(root, 'cdp');
const net = path.join(cdp, 'network');
const pageDir = path.join(cdp, 'page');
for (const dir of [root, cdp, net, pageDir]) fs.mkdirSync(dir, { recursive: true });

const startedAt = new Date().toISOString();
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  run_id: run,
  target: String(port),
  domains: 'Network Runtime Page',
  interval_seconds: 0,
  started_at: startedAt,
}, null, 2), 'utf8');

const streams = {
  raw: fs.createWriteStream(path.join(cdp, 'raw.ndjson')),
  requests: fs.createWriteStream(path.join(net, 'requests.jsonl')),
  responses: fs.createWriteStream(path.join(net, 'responses.jsonl')),
  finished: fs.createWriteStream(path.join(net, 'finished.jsonl')),
  failed: fs.createWriteStream(path.join(net, 'failed.jsonl')),
  navigations: fs.createWriteStream(path.join(pageDir, 'navigations.jsonl')),
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'))
  || targets.find(t => t.type === 'page');
if (!page) throw new Error(`No page target found on port ${port}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

function writeJsonl(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  if (msg.method) {
    writeJsonl(streams.raw, msg);
    if (msg.method === 'Network.requestWillBeSent') writeJsonl(streams.requests, msg);
    else if (msg.method === 'Network.responseReceived') writeJsonl(streams.responses, msg);
    else if (msg.method === 'Network.loadingFinished') writeJsonl(streams.finished, msg);
    else if (msg.method === 'Network.loadingFailed') writeJsonl(streams.failed, msg);
    else if (msg.method === 'Page.frameNavigated') writeJsonl(streams.navigations, msg);
  }
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
await send('Network.enable');

const result = await send('Runtime.evaluate', {
  expression: `(() => {
    const orders = Array.from(document.getElementsByName('order_number[]'));
    const boxes = Array.from(document.querySelectorAll('input[type=checkbox]'));
    const before = orders.filter(b => b.checked).length;
    const header = boxes.find(e =>
      !e.name &&
      e.value === 'on' &&
      orders.length &&
      Math.abs(e.getBoundingClientRect().left - orders[0].getBoundingClientRect().left) < 3
    );
    if (!header) return { clicked: false, reason: 'header checkbox not found', before, total: orders.length };
    if (before > 0 && before === orders.length) return { clicked: false, reason: 'already selected', before, total: orders.length };
    header.scrollIntoView({ block: 'center' });
    header.click();
    return {
      clicked: true,
      before,
      after: orders.filter(b => b.checked).length,
      total: orders.length,
      headerChecked: header.checked,
      url: location.href,
      stat: document.querySelector('input#stat')?.value || null
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});

await new Promise(resolve => setTimeout(resolve, 1000));
const value = result.result?.result?.value || null;
fs.writeFileSync(path.join(root, 'flow-result.json'), JSON.stringify(value, null, 2), 'utf8');
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  run_id: run,
  target: String(port),
  domains: 'Network Runtime Page',
  interval_seconds: 0,
  started_at: startedAt,
  stopped_at: new Date().toISOString(),
}, null, 2), 'utf8');

for (const stream of Object.values(streams)) stream.end();
ws.close();
console.log(JSON.stringify(value, null, 2));
