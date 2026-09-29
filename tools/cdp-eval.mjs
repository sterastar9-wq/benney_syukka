#!/usr/bin/env node
import { WebSocket } from 'ws';
import { cdpHttpUrl, cdpWebSocketUrl } from './cdp-connection.mjs';

const [portArg = '9223', ...exprParts] = process.argv.slice(2);
const port = Number(portArg);
const expr = exprParts.join(' ');

if (!expr) {
  console.error('usage: node tools/cdp-eval.mjs <port> <javascript>');
  process.exit(2);
}

const targets = await (await fetch(cdpHttpUrl(port, '/json/list'))).json();
const page = targets.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'))
  || targets.find(t => t.type === 'page');

if (!page) {
  throw new Error(`No page target found on port ${port}`);
}

const ws = new WebSocket(cdpWebSocketUrl(page.webSocketDebuggerUrl));
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

const result = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
});

if (result.exceptionDetails) {
  console.error(JSON.stringify(result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else if (result.result?.result) {
  const value = result.result.result.value ?? result.result.result.description ?? null;
  if (value !== undefined) {
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
}

ws.close();
