#!/usr/bin/env node
// ピッキングPDFを印刷する。
//
//   node tools/local-picking/print-picking-pdf.mjs --pdf <PDF> [--preview-only] [--printer 普通紙] [--port <n>]
//
// --port を省略すると、使い捨てのプロファイルでChromeを起動して印刷する（普段使いのChromeやGoQのログインには触れない）。
// --port を指定すると、そのポートのリモートデバッグ付きChromeを使う（GoQ印刷フロー実行中のChromeなど）。
// --preview-only は印刷プレビューで設定を確かめてスクリーンショットを残し、印刷せずに閉じる。

import fs from 'node:fs';
import path from 'node:path';
import { isPdfFile } from './pdf.mjs';
import { launchIsolatedChrome, printPdfViaChrome } from './print.mjs';

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

const args = parseArgs(process.argv.slice(2));
if (!args.pdf || args.pdf === true) {
  console.error('使い方: node tools/local-picking/print-picking-pdf.mjs --pdf <PDF> [--preview-only] [--printer 普通紙] [--port <n>]');
  process.exit(2);
}
const pdfPath = path.resolve(String(args.pdf));
if (!isPdfFile(pdfPath)) {
  console.error(JSON.stringify({ ok: false, error: `PDFではないか、見つかりません: ${pdfPath}` }));
  process.exit(1);
}

const printer = typeof args.printer === 'string' ? args.printer : '普通紙';
const press = args['preview-only'] !== true;
let chrome = null;
try {
  const port = args.port ? Number(args.port) : (chrome = await launchIsolatedChrome()).port;
  const result = await printPdfViaChrome(port, pdfPath, { printer, press });
  const log = {
    ok: true,
    printed: result.printed,
    pdf: pdfPath,
    printer,
    destination: result.destination,
    color: result.color,
    duplex: result.duplex,
    pages: result.pages,
    screenshot: path.resolve(result.screenshotPath),
    at: new Date().toISOString(),
  };
  const logDir = path.join('.o11y', 'local-picking', 'print-logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${Date.now()}.json`), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(log, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (chrome) await chrome.close();
}
