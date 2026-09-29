#!/usr/bin/env node
// マスタ（ベニー様_ピッキング参照の GoQ全データ）をCSVファイルとして取り込み、中身を検証する。
// credentials.json が無くSheets APIで読めないときの代わりの経路。
//
//   node tools/local-picking/import-master.mjs --b64 <Driveのエクスポート結果(base64)を保存したファイル> [--out <CSV>]
//   node tools/local-picking/import-master.mjs --csv <「CSV形式でダウンロード」したファイル> [--out <CSV>]
//
// 検証内容: UTF-8として読めるか / 3行目の見出しと列の位置 / JANのチェックデジット / SET数が数字か / SKUの重複
// 1つでも問題があれば終了コード1（--out には書き出さない）。

import fs from 'node:fs';
import path from 'node:path';
import { checkMasterLayout, MASTER_HEADER_ROW_INDEX, parseMasterCsv } from './picking-core.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
  }
  return args;
}

function eanOk(code) {
  if (!/^\d+$/.test(code) || ![8, 13].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const args = parseArgs(process.argv.slice(2));
let text;
try {
  if (typeof args.b64 === 'string') {
    const b64 = fs.readFileSync(args.b64, 'utf8').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new Error('base64として不正な文字が含まれています');
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(b64, 'base64'));
  } else if (typeof args.csv === 'string') {
    text = fs.readFileSync(args.csv, 'utf8');
  } else {
    console.error('使い方: node tools/local-picking/import-master.mjs (--b64 <file> | --csv <file>) [--out <CSV>]');
    process.exit(2);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: `読み込みに失敗しました: ${error.message}` }, null, 2));
  process.exit(1);
}

text = text.replace(/^﻿/, '');
const rows = parseMasterCsv(text);
const layout = checkMasterLayout(rows);
const data = rows.slice(MASTER_HEADER_ROW_INDEX + 1).filter(r => (r[16] || '').trim() !== '');
const problems = [];
if (!layout.ok) problems.push({ kind: '列の位置', detail: layout.mismatches });
const badJan = data.filter(r => r[5] && !eanOk(r[5])).map(r => ({ sku: r[16], jan: r[5] }));
if (badJan.length) problems.push({ kind: 'JANのチェックデジット不一致', detail: badJan });
const badSet = data.filter(r => r[6] && !/^\d+$/.test(r[6])).map(r => ({ sku: r[16], set: r[6] }));
if (badSet.length) problems.push({ kind: 'SET数が数字ではない', detail: badSet });
const seen = new Map();
for (const r of data) seen.set(r[16].toLowerCase(), (seen.get(r[16].toLowerCase()) || 0) + 1);
const dupSku = [...seen].filter(([, n]) => n > 1).map(([sku, n]) => ({ sku, count: n }));
if (dupSku.length) problems.push({ kind: '商品SKUの重複（先に出てくる行が使われる）', detail: dupSku });

const summary = {
  ok: problems.length === 0,
  rows: rows.length,
  products: data.length,
  withJan: data.filter(r => r[5]).length,
  withoutJan: data.filter(r => !r[5]).map(r => r[16]),
  withoutSet: data.filter(r => !r[6]).length,
  problems,
};
if (summary.ok && typeof args.out === 'string') {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${text.endsWith('\n') ? text : `${text}\n`}`, 'utf8');
  summary.out = path.resolve(args.out);
}
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exit(1);
