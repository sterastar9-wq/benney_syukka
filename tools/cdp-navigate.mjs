#!/usr/bin/env node
import { WebSocket } from 'ws';

const [portArg = '9223', url] = process.argv.slice(2);
const port = Number(portArg);

if (!url) {
  console.error('usage: node tools/cdp-navigate.mjs <port> <url>');
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'))
  || targets.find(t => t.type === 'page');

if (!page) {
  throw new Error(`No page target found on port ${port}`);
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
await send('Page.navigate', { url });
console.log(`navigated ${url}`);
ws.close();
