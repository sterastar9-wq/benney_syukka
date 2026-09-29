#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const [run = 'goq-status-view', portArg = '9223', statusArg = '30', pageArg = '1', statusLabelArg = 'ヤマト'] = process.argv.slice(2);
const port = Number(portArg);
const status = String(statusArg);
const pageNo = String(pageArg);
const statusLabel = String(statusLabelArg);

const root = path.join('.o11y', run);
const cdp = path.join(root, 'cdp');
const net = path.join(cdp, 'network');
const pageDir = path.join(cdp, 'page');
const bodies = path.join(net, 'bodies');

for (const dir of [root, cdp, net, pageDir, bodies]) fs.mkdirSync(dir, { recursive: true });

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

const requestsById = new Map();
const responsesById = new Map();

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

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

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

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const targetUrl = `https://order.goqsystem.com/goq21/index.php?stat=${encodeURIComponent(status)}&page=${encodeURIComponent(pageNo)}`;
await send('Page.navigate', { url: targetUrl });
await new Promise(resolve => setTimeout(resolve, 4000));

const final = await send('Runtime.evaluate', {
  expression: `({
    url: location.href,
    stat: document.querySelector('input#stat')?.value || null,
    statusLabel: Array.from(document.querySelectorAll('a.order-tabs__link')).find(a => a.innerText.includes(${JSON.stringify(statusLabel)}))?.innerText || null
  })`,
  awaitPromise: true,
  returnByValue: true,
});

for (const requestId of responsesById.keys()) await captureBody(requestId);
await new Promise(resolve => setTimeout(resolve, 500));

fs.writeFileSync(path.join(root, 'flow-result.json'), JSON.stringify({
  targetUrl,
  final: final.result?.result?.value || null,
}, null, 2), 'utf8');

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
console.log(JSON.stringify({ run: root, targetUrl, final: final.result?.result?.value || null }, null, 2));
