#!/usr/bin/env node
import { WebSocket } from 'ws';

const [portArg = '9223', ...exprParts] = process.argv.slice(2);
const port = Number(portArg);
const expression = exprParts.join(' ');

if (!expression) {
  console.error('usage: node tools/cdp-eval-all-goq.mjs <port> <javascript>');
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = targets.filter(t =>
  t.type === 'page' &&
  t.url.includes('order.goqsystem.com/goq21/')
);

const evalTarget = async target => {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  ws.close();
  return {
    id: target.id,
    title: target.title,
    url: target.url,
    result: result.result?.result?.value ?? result.result?.result?.description ?? null,
    exception: result.exceptionDetails || null
  };
};

const out = [];
for (const page of pages) {
  out.push(await evalTarget(page));
}

console.log(JSON.stringify(out, null, 2));
