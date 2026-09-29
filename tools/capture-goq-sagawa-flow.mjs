#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const RUN = process.argv[2] || 'goq-sagawa-cdp';
const PORT = Number(process.argv[3] || 9223);
const root = path.join('.o11y', RUN);
const cdp = path.join(root, 'cdp');
const net = path.join(cdp, 'network');
const pageDir = path.join(cdp, 'page');
const bodies = path.join(net, 'bodies');

for (const dir of [root, cdp, net, pageDir, bodies]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  run_id: RUN,
  target: String(PORT),
  domains: 'Network Runtime Page',
  interval_seconds: 0,
  started_at: new Date().toISOString(),
}, null, 2), 'utf8');

const streams = {
  raw: fs.createWriteStream(path.join(cdp, 'raw.ndjson')),
  requests: fs.createWriteStream(path.join(net, 'requests.jsonl')),
  responses: fs.createWriteStream(path.join(net, 'responses.jsonl')),
  finished: fs.createWriteStream(path.join(net, 'finished.jsonl')),
  failed: fs.createWriteStream(path.join(net, 'failed.jsonl')),
  navigations: fs.createWriteStream(path.join(pageDir, 'navigations.jsonl')),
};

const requestsById = new Map();
const responsesById = new Map();

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'))
  || targets.find(t => t.type === 'page');
if (!page) throw new Error(`No page target found on port ${PORT}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

function writeJsonl(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  if (msg.method) {
    writeJsonl(streams.raw, msg);
    if (msg.method === 'Network.requestWillBeSent') {
      requestsById.set(msg.params.requestId, msg.params);
      writeJsonl(streams.requests, msg);
    } else if (msg.method === 'Network.responseReceived') {
      responsesById.set(msg.params.requestId, msg.params);
      writeJsonl(streams.responses, msg);
    } else if (msg.method === 'Network.loadingFinished') {
      writeJsonl(streams.finished, msg);
      void captureBody(msg.params.requestId);
    } else if (msg.method === 'Network.loadingFailed') {
      writeJsonl(streams.failed, msg);
    } else if (msg.method === 'Page.frameNavigated') {
      writeJsonl(streams.navigations, msg);
    }
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

async function captureBody(requestId) {
  const req = requestsById.get(requestId);
  const resp = responsesById.get(requestId);
  if (!req || !resp) return;
  const type = req.type || 'Other';
  if (!['XHR', 'Fetch', 'Document'].includes(type)) return;
  const result = await send('Network.getResponseBody', { requestId });
  if (result.error || !result.result) return;
  const dir = path.join(bodies, safeId(requestId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({
    id: requestId,
    url: req.request.url,
    method: req.request.method,
    headers: req.request.headers,
    body: req.request.postData ?? null,
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'response.json'), JSON.stringify({
    id: requestId,
    url: resp.response.url,
    status: resp.response.status,
    headers: resp.response.headers,
    body: result.result.base64Encoded
      ? Buffer.from(result.result.body, 'base64').toString('utf8')
      : result.result.body,
  }, null, 2), 'utf8');
}

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function evalPage(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.result?.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Page.navigate', { url: 'https://order.goqsystem.com/goq21/index.php?stat=3&page=1' });
await wait(3500);

const moved = await evalPage(`(() => {
  window.confirm = () => true;
  window.alert = (m) => { window.__lastAlert = String(m); };
  const boxes = Array.from(document.getElementsByName('order_number[]'));
  if (!boxes.length) return { moved: false, reason: 'no orders' };
  boxes.forEach(b => { b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); });
  const first = boxes[0];
  first.checked = true;
  first.dispatchEvent(new Event('change', { bubbles: true }));
  const s = document.querySelector('select[name="status_id"]');
  s.value = '28';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  const btn = s.parentElement.querySelector('button');
  btn.click();
  return { moved: true, selected: first.value, status: s.value, alert: window.__lastAlert || '' };
})()`);

await wait(4500);
await send('Page.navigate', { url: 'https://order.goqsystem.com/goq21/index.php?stat=28&page=1' });
await wait(3500);

fs.writeFileSync(path.join(root, 'flow-result.json'), JSON.stringify({
  moved,
  final: await evalPage(`({
    url: location.href,
    stat: document.querySelector('input#stat')?.value || null,
    sagawa: Array.from(document.querySelectorAll('a.order-tabs__link')).find(a => a.innerText.includes('佐川'))?.innerText || null
  })`),
}, null, 2), 'utf8');

for (const [requestId] of responsesById) await captureBody(requestId);
await wait(1000);

fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  run_id: RUN,
  target: String(PORT),
  domains: 'Network Runtime Page',
  interval_seconds: 0,
  started_at: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).started_at,
  stopped_at: new Date().toISOString(),
}, null, 2), 'utf8');

for (const stream of Object.values(streams)) stream.end();
ws.close();
console.log(JSON.stringify({ run: root, moved }, null, 2));
