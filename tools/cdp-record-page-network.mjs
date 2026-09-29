#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const [wsUrl, runId = `cdp-page-${Date.now()}`] = process.argv.slice(2);
if (!wsUrl) {
  console.error('usage: node tools/cdp-record-page-network.mjs <page-ws-url> [run-id]');
  process.exit(2);
}

const runDir = path.join('.o11y', runId);
fs.mkdirSync(path.join(runDir, 'cdp', 'network'), { recursive: true });
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
  run_id: runId,
  target: wsUrl,
  started_at: new Date().toISOString(),
  recorder: 'tools/cdp-record-page-network.mjs',
}, null, 2), 'utf8');
fs.writeFileSync(path.join(runDir, '.pid'), String(process.pid), 'utf8');

const raw = fs.createWriteStream(path.join(runDir, 'cdp', 'raw.ndjson'), { flags: 'a' });
const requests = fs.createWriteStream(path.join(runDir, 'cdp', 'network', 'requests.jsonl'), { flags: 'a' });
const responses = fs.createWriteStream(path.join(runDir, 'cdp', 'network', 'responses.jsonl'), { flags: 'a' });
const finished = fs.createWriteStream(path.join(runDir, 'cdp', 'network', 'finished.jsonl'), { flags: 'a' });
const failed = fs.createWriteStream(path.join(runDir, 'cdp', 'network', 'failed.jsonl'), { flags: 'a' });

const ws = new WebSocket(wsUrl);
let seq = 0;
const pending = new Map();
const requestIds = new Set();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function write(stream, msg) {
  stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...msg })}\n`);
}

ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
    return;
  }
  if (!msg.method) return;
  write(raw, msg);
  if (msg.method === 'Network.requestWillBeSent') {
    requestIds.add(msg.params.requestId);
    write(requests, msg);
  } else if (msg.method === 'Network.responseReceived') {
    write(responses, msg);
  } else if (msg.method === 'Network.loadingFinished') {
    write(finished, msg);
    captureBody(msg.params.requestId).catch(() => {});
  } else if (msg.method === 'Network.loadingFailed') {
    write(failed, msg);
  }
});

ws.on('open', async () => {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable', { maxTotalBufferSize: 100000000, maxResourceBufferSize: 50000000 });
  console.log(`recording ${runId}`);
});

async function captureBody(requestId) {
  if (!requestIds.has(requestId)) return;
  const bodyDir = path.join(runDir, 'cdp', 'network', 'bodies', sanitize(requestId));
  fs.mkdirSync(bodyDir, { recursive: true });
  const result = await send('Network.getResponseBody', { requestId });
  fs.writeFileSync(path.join(bodyDir, 'response.json'), JSON.stringify(result, null, 2), 'utf8');
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function shutdown() {
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.stopped_at = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  raw.end(); requests.end(); responses.end(); finished.end(); failed.end();
  try { ws.close(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);