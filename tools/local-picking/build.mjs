// ピッキングCSV + マスタ → 集計 → HTML → PDF をまとめて行う。
// 作ったファイル（HTML・PDF・集計結果JSON・マスタのスナップショット）はすべて outDir に残し、実行ログから辿れるようにする。

import fs from 'node:fs';
import path from 'node:path';
import { buildPickingReport, checkMasterLayout, decodeCsvBuffer, loadExceptions, parseOrdersCsv, readCsvBytes } from './picking-core.mjs';
import { loadMaster, masterConfigFromEnv } from './master-sheet.mjs';
import { loadEnv } from '../lib/env.mjs';

loadEnv();
import { renderPickingHtml } from './render.mjs';
import { htmlToPdfViaCdp, htmlToPdfViaHeadlessChrome, isPdfFile } from './pdf.mjs';

// 最低限これが無いとピッキングできない列
const REQUIRED_ORDER_HEADERS = ['商品名', '個数', '商品SKU'];

function stamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function buildLocalPickingPdf({
  csvPath,
  outDir,
  port = null,
  masterConfig = masterConfigFromEnv(),
  exceptionsFile,
  now = new Date(),
}) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = `picking-${stamp(now)}`;
  const files = {
    html: path.join(outDir, `${base}.html`),
    pdf: path.join(outDir, `${base}.pdf`),
    report: path.join(outDir, `${base}.report.json`),
    master: path.join(outDir, `${base}.master.json`),
  };

  const { orders, missingHeaders } = parseOrdersCsv(decodeCsvBuffer(readCsvBytes(csvPath)));
  const missingRequired = REQUIRED_ORDER_HEADERS.filter(h => missingHeaders.includes(h));
  if (missingRequired.length) {
    throw new Error(`ピッキングCSVに必要な列がありません: ${missingRequired.join(', ')}`);
  }
  if (!orders.length) throw new Error(`ピッキングCSVに注文行がありません: ${csvPath}`);

  const master = await loadMaster(masterConfig);
  if (master.values.length < 4) {
    throw new Error(`マスタの行数が少なすぎます（${master.values.length}行）。読み先を確認してください: ${JSON.stringify(master.source)}`);
  }
  fs.writeFileSync(files.master, `${JSON.stringify({ source: master.source, values: master.values }, null, 2)}\n`, 'utf8');
  const layout = checkMasterLayout(master.values);
  if (!layout.ok) {
    const detail = layout.mismatches.map(m => `${m.column}列: 想定「${m.expected}」/ 実際「${m.actual}」`).join('、');
    throw new Error(`マスタの3行目の見出しがGoQ全データの仕様と一致しません（列がずれている可能性があります）: ${detail}`);
  }

  const exceptions = loadExceptions(exceptionsFile);
  const report = buildPickingReport(orders, master.values, exceptions);
  const createdAt = now.toLocaleString('ja-JP');
  fs.writeFileSync(files.html, renderPickingHtml(report, { createdAt, exceptions }), 'utf8');

  if (port) await htmlToPdfViaCdp(port, files.html, files.pdf);
  else await htmlToPdfViaHeadlessChrome(files.html, files.pdf);
  if (!isPdfFile(files.pdf)) throw new Error(`作成したファイルがPDFではありません: ${files.pdf}`);

  const summary = {
    csv: csvPath,
    master: master.source,
    orderRows: report.orderRowCount,
    uniqueOrders: report.uniqueOrderCount,
    pickingLines: report.pickingList.length,
    totalSingleUnits: report.totalSingleUnits,
    multiItemOrders: report.multiItemOrders.length,
    janCheckOrders: report.janCheckOrders.length,
    anomalyOrders: report.anomalyOrders.length,
    anomalySkus: report.anomalyOrders.map(o => o['商品SKU'] || o['商品コード'] || ''),
    emptyJanLines: report.pickingList.filter(l => !l.JANコード).length,
    missingOptionalHeaders: missingHeaders,
    masterRows: master.values.length,
    masterLayoutOk: layout.ok,
    files: { ...files, pdfBytes: fs.statSync(files.pdf).size },
  };
  // 集計結果JSONにはお客様の氏名を含む行が入るため、runs配下にだけ置く（.gitignore対象）
  fs.writeFileSync(files.report, `${JSON.stringify({ summary, report }, null, 2)}\n`, 'utf8');
  return { summary, report, files };
}
