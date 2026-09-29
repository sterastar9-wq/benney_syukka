#!/usr/bin/env node
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || '9223');
const selector = process.argv[3] || '#trader_s3 + button';

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

await send('Runtime.enable');
await send('DOMDebugger.enable');

const resolve = await send('Runtime.evaluate', {
  expression: selector.startsWith('expr:')
    ? selector.slice('expr:'.length)
    : `document.querySelector(${JSON.stringify(selector)})`,
  objectGroup: 'listeners'
});
const objectId = resolve.result?.result?.objectId;
if (!objectId) {
  console.log(JSON.stringify({ ok: false, error: 'selector not found', selector }, null, 2));
  ws.close();
  process.exit(0);
}

const listeners = await send('DOMDebugger.getEventListeners', {
  objectId,
  depth: 5,
  pierce: true
});

console.log(JSON.stringify({
  ok: true,
  selector,
  listeners: (listeners.result?.listeners || []).map(l => ({
    type: l.type,
    useCapture: l.useCapture,
    passive: l.passive,
    once: l.once,
    scriptId: l.scriptId,
    lineNumber: l.lineNumber,
    columnNumber: l.columnNumber,
    handler: l.handler?.description || null,
    originalHandler: l.originalHandler?.description || null,
    backendNodeId: l.backendNodeId
  }))
}, null, 2));

ws.close();
