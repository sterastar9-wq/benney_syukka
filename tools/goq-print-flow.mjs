#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { cdpHttpUrl, cdpWebSocketUrl, fileUrlForBrowser, pathForBrowser } from './cdp-connection.mjs';
import { buildLocalPickingPdf } from './local-picking/build.mjs';
import { loadEnv, envNumber } from './lib/env.mjs';
import { PICKING_PRINTER, LABEL_PRINTER_BY_STATUS } from './lib/printers.mjs';
import { ensureGoqLogin } from './goq-login.mjs';
import { verifyLabelCsvFile } from './lib/label-csv.mjs';

const execFile = promisify(execFileCallback);
loadEnv();

// 送り状の出し方
//   goq-api : GoQ の発行ボタン（Smart API / B2クラウドAPI）でPDFを作る（元版の方式。佐川で使用）
//   b2-csv  : GoQ から B2クラウド用の送り状データCSVを出力し、ヤマトビジネスメンバーズ（B2クラウド）に取り込んで印刷する（ベニー様版のヤマト系）
const LABEL_MODE_GOQ_API = 'goq-api';
const LABEL_MODE_B2_CSV = 'b2-csv';
// GoQ の送り状データ出力 <select id="trader_s"> の B2クラウド用 option の value。
// 実画面で違う場合は .env の GOQ_B2_CSV_FORMAT_VALUE で上書きする（option の表示文言でも照合する）。
const B2_CSV_FORMAT_VALUE = process.env.GOQ_B2_CSV_FORMAT_VALUE || 'b2_cloud';
const B2_CSV_FORMAT_TEXT = /B2|Ｂ２|ヤマト/;
const B2_HANDOFF_DIR = path.join('.o11y', 'goq-unified-print-flow', 'b2-handoff');
// ピッキング用CSV（カスタムCSV）の番号。ベニー様の GoQ では custom_id=1「カスタムCSV全項目(サンプル)」に
// 商品名・個数・商品SKU・商品コード・JANコード・GoQ管理番号・送付先氏名・配送方法(複数配送先)・チェック項目 が揃っている（2026-09-30 確認）
const PICKING_CSV_CUSTOM_ID = String(process.env.GOQ_PICKING_CSV_CUSTOM_ID || '1');

// ベニー様の GoQ ステータス（2026-09-30 に実画面で確認。元版の 佐川28/ヤマト30/コンパクト29/ネコポス徳島31 とは別物）
//   30 ★ネコポス・クリックポスト / 26 ★宅急便 / 27 ★クール便 / 29 ★発送済み / 32 ★出荷通知 / 17 メール待機 / 33 ★処理済み / 24 出荷日記入 / 3 発送前入金待ち / 6 発送後入金待ち
// 配送業者の選択肢は 日本郵便 / ヤマト運輸 / 佐川急便。送り状はすべて B2クラウドCSV経路（GoQ の発行ボタンは使わない）。
const STATUS = {
  nekoposu: {
    label: '★ネコポス・クリックポスト',
    stat: 30,
    carrierText: 'ヤマト運輸',
    carrierChangeFrom: ['日本郵便'],
    manageShipDate: false,
    labelMode: 'b2-csv',
    labelCsvFormat: 'b2_cloud',
    labelButton: '#B2CloudGeneratePdfApi',
    labelButtonText: 'ヤマト運輸送り状発行',
    labelPrinter: LABEL_PRINTER_BY_STATUS.nekoposu,
  },
  takkyubin: {
    label: '★宅急便',
    stat: 26,
    carrierText: 'ヤマト運輸',
    carrierChangeFrom: ['日本郵便'],
    manageShipDate: false,
    labelMode: 'b2-csv',
    labelCsvFormat: 'b2_cloud',
    labelButton: '#B2CloudGeneratePdfApi',
    labelButtonText: 'ヤマト運輸送り状発行',
    labelPrinter: LABEL_PRINTER_BY_STATUS.takkyubin,
  },
  cool: {
    label: '★クール便',
    stat: 27,
    carrierText: 'ヤマト運輸',
    carrierChangeFrom: ['日本郵便'],
    manageShipDate: false,
    labelMode: 'b2-csv',
    labelCsvFormat: 'b2_cloud',
    labelButton: '#B2CloudGeneratePdfApi',
    labelButtonText: 'ヤマト運輸送り状発行',
    labelPrinter: LABEL_PRINTER_BY_STATUS.cool,
  },
};

// ベニー様の GoQ には店舗タブ（#st）が無いため、Amazon 限定キーは通常使わない（互換のため残す）
const AMAZON_STATUS_ALIASES = new Map([
  ['nekoposu-amazon', 'nekoposu'],
  ['takkyubin-amazon', 'takkyubin'],
  ['cool-amazon', 'cool'],
]);

const GOQ_ORIGIN = 'https://order.goqsystem.com';
const GOQ_LIST_URL = `${GOQ_ORIGIN}/goq21/index_beta.php`;
const GOQ_ORDER_INDEX_URL = 'https://order.goqsystem.com/goq21/index.php';
const GOQ_DOWNLOAD_URL = 'https://order.goqsystem.com/goq21/downloadpage.php';
const LOCAL_PICKING_DIR = path.join('.o11y', 'goq-unified-print-flow', 'picking');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const RUN_DIR = path.join('.o11y', 'goq-unified-print-flow', 'runs');
// 必須ルール。ベニー様版はすべてリポジトリ内に置く（~/.codex には依存しない）。
// 別の場所を使う場合は .env の GOQ_RULE_SKILL_FILE / GOQ_RULE_MEMORY_FILE で上書きする。
const REQUIRED_RULE_SOURCES = [
  { key: 'agents', file: path.resolve('AGENTS.md'), required: ['GoQ', '送り状未発行', 'destination', '送り状発行ダイアログ', 'ダッシュボードお知らせモーダル', 'B2クラウド'] },
  { key: 'readme', file: path.resolve('tools', 'goq-print-flow.README.md'), required: ['Address Warning Handling', 'Chrome Print Preview DOM', 'Shipping Label Download Wait', 'Label Generation Dialog Handling', 'Dashboard Notice Modal', 'post-label difference check', 'actual Chrome print-preview destination', 'RequestB2CloudDeliveryInvoice.php', 'b2CloudDeliveryInvoiceExportRequest', 'B2 Cloud CSV Route'] },
  { key: 'checklist', file: path.resolve('tools', 'goq-print-flow.CHECKLIST.md'), required: ['Common Flow', 'Status Differences', 'Completion Standard', 'run.goal', '住所不正', '普通紙', 'RequestB2CloudDeliveryInvoice.php', 'b2CloudDeliveryInvoiceExportRequest', 'exported shipping label csv'] },
  { key: 'skill', file: path.resolve(process.env.GOQ_RULE_SKILL_FILE || path.join('.claude', 'skills', 'goq-shipping-label-print-flow', 'SKILL.md')), required: ['Address Warning', 'Split address fields', 'Print Preview Checks', 'Label Generation Dialog Handling', 'Dashboard Notice Modal', 'target snapshot', 'actual Chrome print-preview destination', 'Yamato B2 Cloud Request Evidence', 'b2CloudDeliveryInvoiceExportRequest', 'B2 Cloud CSV Route'] },
  { key: 'memory', file: path.resolve(process.env.GOQ_RULE_MEMORY_FILE || path.join('codex', 'memories', 'goq-print-flow-rules.md')), required: ['Address Warning Detection And Normalization', 'Label-Issuance Difference Check', 'Printer Destination Review Guard', 'Label Generation Dialog Handling', 'Dashboard Notice Modal', 'Yamato B2 Cloud Request Evidence', 'b2CloudDeliveryInvoiceExportRequest', 'B2 Cloud CSV Route'] },
];

let args;
let config;
let execute;
let port;
let onlyOrder;
let excludeOrders;
let skipPrint;
let skipPicking;
let skipLabels;
let labelFirst;
let stopAfterDate;
let previewOnlyPicking;
let stopBeforeLabelPrint;
let inspectLabelDialog;
let resume;
let maxWaitMs;
let downloadRefreshAttempts;
let today;
let run;
let storeTab;
let addressFixedGoqIds;
let addressUnresolvedGoqIds;
const openCdpPages = new Set();

function statusListUrl(stat) {
  return `${GOQ_LIST_URL}?stat=${encodeURIComponent(stat)}&s_day_type=&page=1`;
}

function allStatusListUrl() {
  return `${GOQ_LIST_URL}?s_day_type=&page=1`;
}

async function main() {
  args = parseArgs(process.argv.slice(2));
  const statusResolution = resolveStatus(args.status);
  config = statusResolution.config;
  if (!config) fail(`Unknown status "${args.status}". Use one of: ${[...Object.keys(STATUS), ...AMAZON_STATUS_ALIASES.keys()].join(', ')}`);

  execute = args.execute === true;
  port = Number(args.port || envNumber('GOQ_CDP_PORT', 9223));
  onlyOrder = args.order || '';
  excludeOrders = new Set(splitList(args.exclude));
  skipPrint = args['skip-print'] === true;
  skipPicking = args['skip-picking'] === true;
  skipLabels = args['skip-labels'] === true;
  labelFirst = args['label-first'] === true;
  stopAfterDate = args['stop-after-date'] === true;
  previewOnlyPicking = args['preview-only-picking'] === true;
  stopBeforeLabelPrint = args['stop-before-label-print'] === true;
  inspectLabelDialog = args['inspect-label-dialog'] === true;
  resume = args.resume === true;
  maxWaitMs = Number(args['wait-ms'] || 180000);
  downloadRefreshAttempts = Number(args['download-refresh-attempts'] || 20);
  today = args.date || formatDate(new Date());
  addressFixedGoqIds = new Set(splitList(args['address-fixed']));
  addressUnresolvedGoqIds = new Set(splitList(args['address-unresolved']));
  storeTab = statusResolution.storeTab || (args['amazon-only'] === true ? 'Amazon' : (args['store-tab'] || ''));

  run = {
    mode: execute ? 'execute' : 'dry-run',
    statusKey: args.status,
    baseStatusKey: statusResolution.baseStatus,
    status: config.label,
    stat: config.stat,
    labelMode: config.labelMode || LABEL_MODE_GOQ_API,
    labelPrinter: config.labelPrinter,
    date: today,
    onlyOrder,
    excludeOrders: [...excludeOrders],
    addressFixedGoqIds: [...addressFixedGoqIds],
    addressUnresolvedGoqIds: [...addressUnresolvedGoqIds],
    storeTab,
    resume,
    inspectLabelDialog,
    args: { ...args },
    goal: buildRunGoal({ args, statusResolution, config, execute, today, onlyOrder, excludeOrders, storeTab }),
    steps: [],
  };
  fs.mkdirSync(RUN_DIR, { recursive: true });
  run.logFile = path.join(RUN_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.status}.json`);
  run.ruleMaterial = loadRuleMaterial();
  saveRun();
  if (!run.ruleMaterial.ok) {
    failWithRun('Stopped before side effects because required rule material was not loaded.', 2);
  }
  if (execute && addressFixedGoqIds.size && args['address-fixed-confirmed'] !== true) {
    run.blockers = [{
      reason: '--address-fixed requires --address-fixed-confirmed so fixed address warnings are an auditable external/operator assertion',
      addressFixedGoqIds: [...addressFixedGoqIds],
    }];
    failWithRun('Stopped before side effects because address-fixed assertions were not explicitly confirmed.', 2);
  }
  if (execute && addressUnresolvedGoqIds.size && args['address-unresolved-confirmed'] !== true) {
    run.blockers = [{
      reason: '--address-unresolved requires --address-unresolved-confirmed so unresolved address exclusions are backed by a memo/operator assertion',
      addressUnresolvedGoqIds: [...addressUnresolvedGoqIds],
    }];
    failWithRun('Stopped before side effects because address-unresolved assertions were not explicitly confirmed.', 2);
  }

  try {
  const goq = await connectToGoq(port);
  await goq.enable();
  // ベニー様フロー 1: GoQ ログイン。ログイン画面なら .env の情報でログインしてから先へ進む。
  run.login = await ensureGoqLogin(goq, { step, allowLogin: args['no-auto-login'] !== true });
  if (run.login.result === 'not-logged-in') {
    failWithRun('Stopped because GoQ is not logged in (auto-login disabled by --no-auto-login).', 2);
  }
  if (args['print-existing-label-at']) {
    if (!execute) failWithRun('print-existing-label-at requires --execute.', 2);
    const requestedAt = parseLocalDateTime(args['print-existing-label-at']);
    await goq.navigate(GOQ_DOWNLOAD_URL);
    const labelPdf = await goq.downloadLatestLabelPdf({ requestedAt, config });
    step('downloaded existing shipping label pdf', { file: labelPdf.fullName, bytes: labelPdf.size, printer: config.labelPrinter, sourceUrl: labelPdf.url, requestedAt: args['print-existing-label-at'] });
    if (!skipPrint) {
      const pdf = labelPdf.directResource
        ? await connectToPdfResource(port, labelPdf.url)
        : await connectToPdfViewer(port, labelPdf.fullName);
      await pdf.enable();
      const labelPreview = await pdf.printPdf(config.labelPrinter, { press: !stopBeforeLabelPrint, closeWithoutPrinting: false });
      step(stopBeforeLabelPrint ? 'stopped before existing shipping label print button' : 'printed existing shipping label', {
        printer: config.labelPrinter,
        destination: labelPreview.destination,
        expectedPrinter: config.labelPrinter,
        screenshot: labelPreview.screenshotPath,
        pages: labelPreview.pages,
        color: '白黒',
        duplex: false,
      });
    }
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  await goq.enterOrderManagement();
  await goq.navigate(statusListUrl(config.stat));
  await goq.waitForOrderList();
  const initialPageSize = await goq.ensureDisplayCount500();
  step('ensured GoQ display count is 500', initialPageSize);
  if (storeTab) {
    const storeFilter = await goq.applyStoreTabFilter(storeTab);
    step('applied store tab before side effects', storeFilter);
  }

  let initialRows = await goq.readRows();
  if (!initialRows.length) {
    const diagnostics = await goq.readOrderListDiagnostics();
    step('initial row read returned zero; retrying with diagnostics', diagnostics);
    if (diagnostics.looksLikeDashboard) {
      const recovered = await goq.enterOrderManagementFromDashboardLikePage();
      step('re-entered order management after dashboard-like page at status url', recovered);
      await goq.navigate(statusListUrl(config.stat));
      await goq.waitForOrderList();
      const recoveredPageSize = await goq.ensureDisplayCount500();
      step('ensured GoQ display count is 500 after dashboard recovery', recoveredPageSize);
    }
    await wait(1500);
    await goq.waitForOrderList();
    initialRows = await goq.readRows();
    if (!initialRows.length) {
      run.orderListDiagnostics = await goq.readOrderListDiagnostics();
    }
  }
  if (execute) {
    const warningRows = initialRows.filter(row => row.addressWarning && !addressFixedGoqIds.has(row.goqId) && !addressUnresolvedGoqIds.has(row.goqId));
    if (warningRows.length) {
      const addressFixResult = await goq.fixAddressWarnings(warningRows);
      run.addressFixes = addressFixResult;
      step('processed address warnings', addressFixResult);
      await goq.navigate(statusListUrl(config.stat));
      await goq.waitForOrderList();
      await goq.ensureStatusListContext(config.stat);
      if (storeTab) {
        const storeFilter = await goq.applyStoreTabFilter(storeTab);
        step('reapplied store tab after address warning handling', storeFilter);
      }
      initialRows = await goq.readRows();
    }
  }
  const unreviewedAddressWarnings = targetScopeRows(initialRows)
    .filter(row => row.addressWarning && !addressFixedGoqIds.has(row.goqId) && !addressUnresolvedGoqIds.has(row.goqId));
  run.addressWarningReviewGuard = {
    checkedAt: new Date().toISOString(),
    definition: 'surface warning is not unresolved; warning rows must be reviewed/fixed or explicitly marked address-unresolved before side effects',
    unreviewed: unreviewedAddressWarnings.map(row => pickRowSummary(row)),
    fixed: [...addressFixedGoqIds],
    unresolvedAfterValidation: [...addressUnresolvedGoqIds],
  };
  saveRun();
  if (execute && unreviewedAddressWarnings.length) {
    run.blockers = unreviewedAddressWarnings.map(row => ({
      reason: 'address warning has not been reviewed/fixed; surface warning alone is not the unresolved definition',
      row: pickRowSummary(row),
    }));
    failWithRun('Stopped before side effects because address warnings still need review.', 2);
  }
  // ベニー様: 取り込み直後の行は配送業者が 日本郵便 なので、出荷日入力より前に ヤマト運輸 へ変更する（--no-carrier-change で無効化）
  if (config.carrierChangeFrom?.length && args['no-carrier-change'] !== true) {
    const changeCandidates = targetScopeRows(initialRows).filter(row =>
      !excludeOrders.has(row.orderNumber) && !excludeOrders.has(row.goqId)
      && !row.tracking && (!row.shipDate || (resume && row.shipDate === today))
      && !carrierMatches(row.carrier, config.carrierText)
      && config.carrierChangeFrom.some(from => normalizeText(row.carrier).includes(normalizeText(from))));
    if (changeCandidates.length) {
      const summary = { to: config.carrierText, rows: changeCandidates.map(pickRowSummary) };
      if (execute) {
        const changed = await goq.changeCarrierForGoqIds(changeCandidates.map(row => row.goqId), config.carrierText);
        step('changed carrier for target rows', { ...summary, result: changed });
        await goq.navigate(statusListUrl(config.stat));
        await goq.waitForOrderList();
        await goq.ensureStatusListContext(config.stat);
        initialRows = await goq.readRows();
      } else {
        step('would change carrier for target rows (dry-run)', summary);
      }
    }
  }
  let plan = buildEligiblePlan(initialRows, { config, onlyOrder, excludeOrders, allowShipDateToday: resume, requireShipDateToday: resume });
  let resumeRecoveryTargets = [];
  if (resume && !plan.eligible.length) {
    resumeRecoveryTargets = loadResumeTargetsFromRecentRun(args.status, today);
    if (resumeRecoveryTargets.length) {
      step('resume source status empty; searching all statuses for previous targets', {
        targetCount: resumeRecoveryTargets.length,
        targets: resumeRecoveryTargets.map(pickRowSummary),
      });
      await goq.navigate(allStatusListUrl());
      await goq.waitForOrderList();
      const recoveryPageSize = await goq.ensureDisplayCount500();
      step('ensured GoQ display count is 500 for all-status recovery', recoveryPageSize);
      const recoveryFilter = await goq.filterShippingDateTodayAndTargetOrders(today, resumeRecoveryTargets);
      const recoveredRows = await goq.readRows();
      const recoveredPlan = buildEligiblePlan(recoveredRows, { config, onlyOrder, excludeOrders, allowShipDateToday: true, requireShipDateToday: true });
      run.resumeRecovery = {
        filter: recoveryFilter,
        rows: recoveredRows.map(pickRowSummary),
        plan: summarizePlan(recoveredPlan),
      };
      if (recoveredPlan.eligible.length) {
        initialRows = recoveredRows;
        plan = recoveredPlan;
        step('recovered resume targets from all-status search', run.resumeRecovery);
      }
    }
  }
  run.initial = summarizePlan(plan);
  step('checked initial rows', run.initial);

  if (plan.blockers.length) {
    run.blockers = plan.blockers;
    failWithRun('Stopped before side effects because blockers were found.', 2);
  }
  if (!plan.eligible.length) {
    run.orderListDiagnostics = await goq.readOrderListDiagnostics();
    failWithRun('No eligible rows found for this status.', 2);
  }
  if (!execute) {
    const storeArg = AMAZON_STATUS_ALIASES.has(args.status)
      ? ''
      : storeTab === 'Amazon'
        ? ' --amazon-only'
        : storeTab
          ? ` --store-tab ${JSON.stringify(storeTab)}`
          : '';
    run.nextCommand = `node tools/goq-print-flow.mjs --status ${args.status} --execute${onlyOrder ? ` --order ${onlyOrder}` : ''}${excludeOrders.size ? ` --exclude ${[...excludeOrders].join(',')}` : ''}${storeArg}`;
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  if (config.manageShipDate === false) {
    step('skipped shipping date overwrite (status does not manage ship date)', { status: config.label, targets: plan.eligible.map(pickRowSummary) });
  } else if (!resume) {
    await goq.selectGoqIds(plan.eligible.map(row => row.goqId));
    step('selected rows for shipping-date overwrite', { goqIds: plan.eligible.map(row => row.goqId), orderNumbers: plan.eligible.map(row => row.orderNumber) });
    const verifiedShippingDate = await goq.overwriteShippingDate(today);
    step('verified shipping date overwrite', verifiedShippingDate);
    await goq.navigate(statusListUrl(config.stat));
    await goq.waitForOrderList();
    await goq.ensureStatusListContext(config.stat);
    const dateAfterReturn = await goq.verifyShippingDate(plan.eligible.map(row => row.goqId), today);
    if (!dateAfterReturn.ok) {
      run.afterShippingDateReturn = dateAfterReturn;
      failWithRun('Stopped because shipping date was not verified after returning to the status list.', 4);
    }
    step('verified shipping date after returning to status list', dateAfterReturn);
  } else {
    step('skipped shipping date overwrite for resume', { date: today });
  }
  if (stopAfterDate) {
    step('stopped after shipping date verification by option', { date: today });
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  if (resumeRecoveryTargets.length) {
    const recoveryFilter = await goq.filterShippingDateTodayAndTargetOrders(today, resumeRecoveryTargets);
    step('filtered by shipping date today and recovered target orders', { date: today, filter: recoveryFilter });
  } else if (config.manageShipDate === false) {
    await goq.filterReportNumberEmpty();
    step('filtered by empty tracking number (ship date not managed)', {});
  } else {
    await goq.filterShippingDateTodayAndReportNumberEmpty(today);
    step('filtered by shipping date today and empty tracking number', { date: today });
  }
  const filteredPageSize = await goq.ensureDisplayCount500();
  step('ensured GoQ display count is 500 after filtering', filteredPageSize);
  if (storeTab) {
    const storeFilter = await goq.applyStoreTabFilter(storeTab);
    step('reapplied store tab immediately after shipping/tracking filter', storeFilter);
  }

  const productSortVerification = await goq.sortByProductName();
  step('verified GoQ product-name sort action', productSortVerification);

  const filteredRows = await goq.readRows();
  let afterFilter = buildEligiblePlan(filteredRows, { config, onlyOrder, excludeOrders, allowShipDateToday: true, requireShipDateToday: true });
  if (!afterFilter.eligible.length && onlyOrder && productSortVerification?.after?.includes(onlyOrder)) {
    const fallbackRows = plan.eligible.filter(row => row.goqId === onlyOrder || row.orderNumber === onlyOrder);
    afterFilter = buildEligiblePlan(fallbackRows, { config, onlyOrder, excludeOrders, allowShipDateToday: true, requireShipDateToday: true });
    if (afterFilter.eligible.length) {
      step('used single-order fallback after filtered row read returned empty', { onlyOrder, filteredRows: filteredRows.length });
    }
  }
  if (afterFilter.blockers.length) {
    run.blockers = afterFilter.blockers;
    failWithRun('Stopped after filtering because blockers were found.', 3);
  }
  if (!afterFilter.eligible.length) {
    run.afterFilter = summarizePlan(afterFilter);
    failWithRun('No eligible rows remained after shipping-date/tracking filters.', 3);
  }
  const selectedAfterFilter = await goq.selectAllThenKeepGoqIds(afterFilter.eligible.map(row => row.goqId));
  step('selected all visible rows then excluded non-target rows after filter/sort', { ...summarizePlan(afterFilter), selection: selectedAfterFilter });
  if (config.manageShipDate === false) {
    step('verified selected rows before CSV export (ship date not managed)', { goqIds: afterFilter.eligible.map(row => row.goqId) });
  } else {
    const csvDateVerification = await goq.verifyShippingDate(afterFilter.eligible.map(row => row.goqId), today);
    if (!csvDateVerification.ok) {
      run.beforeCsv = csvDateVerification;
      failWithRun('Stopped before CSV export because selected rows do not have today shipping date.', 4);
    }
    step('verified selected rows before CSV export', csvDateVerification);
  }
  if (resume && !skipPicking) {
    const previousPicking = findPreviousPickingPrint(args.status, today, afterFilter.eligible.map(row => row.goqId));
    if (previousPicking) {
      skipPicking = true;
      run.args['skip-picking'] = 'auto-resume';
      step('reused previous picking list print for resume', previousPicking);
    }
  }

  let deferredPickingCsv = null;
  const outputPicking = async () => {
  if (!skipPicking) {
    const pickingCsv = deferredPickingCsv || await goq.exportPickingCsvToFile();
    if (!deferredPickingCsv) step('exported picking csv', { file: pickingCsv.fullName, bytes: pickingCsv.size });

    if (!skipPrint) {
    // ベニー様版: Smart Pick を使わず、ローカルで集計してPDFを作り、送り状と同じPDF印刷の手順で印刷する
    const localPicking = await buildLocalPickingPdf({
      csvPath: pickingCsv.fullName,
      outDir: LOCAL_PICKING_DIR,
      port,
    });
    step('generated local picking pdf', localPicking.summary);
    if (localPicking.summary.anomalyOrders > 0) {
      step('local picking pdf has orders missing from master', {
        count: localPicking.summary.anomalyOrders,
        skus: localPicking.summary.anomalySkus,
        note: 'PDF末尾の異常検知リストに記載。マスタ(ベニー様_ピッキング参照)への登録漏れを確認する',
      });
    }
    const pickingPdf = await openPdfInNewTab(port, localPicking.files.pdf);
    let pickingPreview;
    try {
      await pickingPdf.viewer.enable();
      pickingPreview = await pickingPdf.viewer.printPdf(PICKING_PRINTER, { press: !previewOnlyPicking, closeWithoutPrinting: previewOnlyPicking });
    } finally {
      await pickingPdf.close();
    }
    step(previewOnlyPicking ? 'verified picking print preview without pressing print' : 'printed picking list', {
      printer: PICKING_PRINTER,
      destination: pickingPreview.destination,
      expectedPrinter: PICKING_PRINTER,
      screenshot: pickingPreview.screenshotPath,
      pages: pickingPreview.pages,
      color: '白黒',
      duplex: false,
      source: 'local-picking-pdf',
      pdf: localPicking.files.pdf,
    });
    }
  } else {
    step('skipped picking list by option', {});
  }
  return { stopped: false };
  };

  const outputLabels = async () => {
  if (!skipLabels) {
    await goq.bringToFront();
    const selectedBeforeLabel = await goq.selectAllThenKeepGoqIds(afterFilter.eligible.map(row => row.goqId));
    step('reselected all visible rows then excluded non-target rows before label generation', selectedBeforeLabel);
    const beforeLabelRows = await goq.readRows();
    let beforeLabelPlan = buildEligiblePlan(beforeLabelRows, { config, onlyOrder, excludeOrders, allowShipDateToday: true, requireShipDateToday: true });
    if (beforeLabelPlan.blockers.length || !beforeLabelPlan.eligible.length) {
      run.beforeLabel = summarizePlan(beforeLabelPlan);
      failWithRun('Stopped before label generation because selected rows are not print-ready.', 4);
    }
    step('verified rows before label generation', summarizePlan(beforeLabelPlan));
    const phoneNormalization = await goq.normalizePhoneNumbersForRows(beforeLabelPlan.eligible);
    if (phoneNormalization.fixed.length || phoneNormalization.blockers.length) {
      step('checked phone normalization before label generation', phoneNormalization);
    }
    if (phoneNormalization.blockers.length) {
      run.blockers = phoneNormalization.blockers;
      failWithRun('Stopped before label generation because phone normalization was unsafe.', 4);
    }
    if (phoneNormalization.fixed.length) {
      await goq.navigate(statusListUrl(config.stat));
      await goq.waitForOrderList();
      await goq.ensureStatusListContext(config.stat);
      if (config.manageShipDate === false) await goq.filterReportNumberEmpty();
      else await goq.filterShippingDateTodayAndReportNumberEmpty(today);
      if (storeTab) {
        const storeFilterAfterPhoneFix = await goq.applyStoreTabFilter(storeTab);
        step('reapplied store tab after phone normalization filter', storeFilterAfterPhoneFix);
      }
      const productSortAfterPhoneFix = await goq.sortByProductName();
      step('re-verified GoQ product-name sort after phone normalization', productSortAfterPhoneFix);
      const rowsAfterPhoneFix = await goq.readRows();
      beforeLabelPlan = buildEligiblePlan(rowsAfterPhoneFix, { config, onlyOrder, excludeOrders, allowShipDateToday: true, requireShipDateToday: true });
      if (beforeLabelPlan.blockers.length || !beforeLabelPlan.eligible.length) {
        run.beforeLabel = summarizePlan(beforeLabelPlan);
        failWithRun('Stopped after phone normalization because rows are not print-ready.', 4);
      }
      const selectedAfterPhoneFix = await goq.selectAllThenKeepGoqIds(beforeLabelPlan.eligible.map(row => row.goqId));
      step('reselected rows after phone normalization', selectedAfterPhoneFix);
    }
    const labelRequestTime = new Date();
    const labelTargetSnapshot = createLabelTargetSnapshot(beforeLabelPlan.eligible, {
      requestedAt: labelRequestTime,
      statusKey: args.status,
      stat: config.stat,
      carrier: config.carrierText,
      shipDate: today,
    });
    run.labelTargetSnapshot = labelTargetSnapshot;
    step('recorded shipping-label target snapshot', labelTargetSnapshot);
    if ((config.labelMode || LABEL_MODE_GOQ_API) === LABEL_MODE_B2_CSV) {
      // ベニー様フロー 3: GoQ から B2クラウド用の送り状データCSVを出力する。GoQ側の発行ボタン（B2クラウドAPI）は押さない。
      const labelCsv = await goq.exportLabelCsvToFile(config);
      step('exported shipping label csv', { ...labelCsv, requestedAt: labelRequestTime.toISOString(), mode: LABEL_MODE_B2_CSV });
      const csvVerification = verifyLabelCsvAgainstTargets(labelCsv, labelTargetSnapshot.targets);
      run.labelIssuanceVerification = csvVerification;
      step('verified shipping label csv against target snapshot', csvVerification);
      if (!csvVerification.ok) {
        failWithRun('Stopped because the exported B2 Cloud CSV does not match the shipping-label target snapshot.', 4);
      }
      const handoff = writeB2Handoff({ labelCsv, snapshot: labelTargetSnapshot, verification: csvVerification });
      run.b2Handoff = handoff;
      step('wrote b2 cloud handoff', handoff);
      step('shipping label print is delegated to yamato business members', {
        next: `node tools/yamato-b2/import-and-print.mjs --handoff ${JSON.stringify(handoff.file)} --port ${port}`,
        labelPrinter: config.labelPrinter,
        note: 'ヤマトビジネスメンバーズ（B2クラウド）にCSVを取り込み、送り状を印刷し、送り状番号をGoQへ戻す',
      });
      return { stopped: false, handoff };
    }
    const labelClick = await goq.clickLabelButton(config);
    step('requested shipping label generation', { button: config.labelButtonText, requestedAt: labelRequestTime.toISOString(), click: labelClick });
    if (inspectLabelDialog) {
      step('stopped after shipping label dialog inspection', {
        labelDialog: run.labelDialog || null,
        domDialogs: labelClick.domDialogs || [],
      });
      console.log(JSON.stringify(run, null, 2));
      return;
    }

    await goq.navigate(GOQ_DOWNLOAD_URL);
    const labelPdf = await goq.downloadLatestLabelPdf({ requestedAt: labelRequestTime, config });
    step('downloaded shipping label pdf', { file: labelPdf.fullName, bytes: labelPdf.size, printer: config.labelPrinter, sourceUrl: labelPdf.url });
    const issuanceVerification = await goq.verifyLabelIssuanceAfterGeneration(labelTargetSnapshot.targets, today);
    run.labelIssuanceVerification = issuanceVerification;
    step('verified shipping-label issuance after generation', issuanceVerification);
    if (issuanceVerification.unissued.length) {
      step('detected shipping-label unissued targets', {
        count: issuanceVerification.unissued.length,
        rows: issuanceVerification.unissued,
      });
      failWithRun('Stopped before shipping-label print because issuance verification found unissued targets.', 4);
    }

    if (!skipPrint) {
      const pdf = labelPdf.directResource
        ? await connectToPdfResource(port, labelPdf.url)
        : await connectToPdfViewer(port, labelPdf.fullName);
      await pdf.enable();
      const labelPreview = await pdf.printPdf(config.labelPrinter, { press: !stopBeforeLabelPrint, closeWithoutPrinting: false });
      step(stopBeforeLabelPrint ? 'stopped before shipping label print button' : 'printed shipping label', {
        printer: config.labelPrinter,
        destination: labelPreview.destination,
        expectedPrinter: config.labelPrinter,
        screenshot: labelPreview.screenshotPath,
        pages: labelPreview.pages,
        color: '白黒',
        duplex: false,
      });
      if (stopBeforeLabelPrint) {
        return { stopped: true };
      }
    }
  } else {
    step('skipped shipping labels by option', {});
  }
  return { stopped: false };
  };

  if (labelFirst) {
    step('using label-first output order', { reason: 'avoid picking-list reprint when label generation may exclude rows' });
    if (!skipPicking) {
      deferredPickingCsv = await goq.exportPickingCsvToFile();
      step('exported picking csv before label-first output', { file: deferredPickingCsv.fullName, bytes: deferredPickingCsv.size });
    }
    const labels = await outputLabels();
    if (labels.stopped) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    await outputPicking();
  } else {
    await outputPicking();
    const labels = await outputLabels();
    if (labels.stopped) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }
  }

  console.log(JSON.stringify(run, null, 2));
  } catch (error) {
    run.error = error?.stack || String(error);
    console.error(JSON.stringify(run, null, 2));
    process.exitCode = process.exitCode || 1;
  } finally {
    if (run) {
      run.guardReview = reviewRunInProcess(run);
      saveRun();
      if (!run.guardReview.ok) {
        console.error(JSON.stringify({ guardReview: run.guardReview }, null, 2));
        process.exitCode = process.exitCode || 1;
      }
    }
    closeAllCdpPages();
  }
}

function parseArgs(argv) {
  const out = { status: 'sagawa' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (['execute', 'skip-print', 'skip-picking', 'skip-labels', 'label-first', 'stop-after-date', 'preview-only-picking', 'stop-before-label-print', 'resume', 'amazon-only', 'approve-address-normalization', 'address-fixed-confirmed', 'address-unresolved-confirmed', 'no-auto-login', 'inspect-label-dialog', 'no-carrier-change'].includes(key)) {
      out[key] = true;
    } else {
      out[key] = argv[++i];
    }
  }
  return out;
}

function resolveStatus(statusKey) {
  if (STATUS[statusKey]) return { config: STATUS[statusKey], baseStatus: statusKey, storeTab: '' };
  const baseStatus = AMAZON_STATUS_ALIASES.get(statusKey);
  if (baseStatus) return { config: STATUS[baseStatus], baseStatus, storeTab: 'Amazon' };
  return { config: null, baseStatus: statusKey, storeTab: '' };
}

function filenameFromDisposition(disposition) {
  if (!disposition) return '';
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return safeBasename(decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, '')));
  const asciiMatch = disposition.match(/filename="?([^";]+)"?/i);
  if (asciiMatch) return safeBasename(asciiMatch[1].trim());
  return '';
}

function safeBasename(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

async function downloadPdfFromUrl(url, { label, prefix }) {
  if (!url || !/^https:\/\//i.test(url)) throw new Error(`Invalid PDF download URL: ${url || ''}`);
  if (!/smart-api-shipping\.sagawa-exp\.co\.jp\/api\/resource|\/api\/resource\/|\.pdf(?:$|[?#])/i.test(url)) {
    throw new Error(`Refusing to download non-label URL as PDF: ${url}`);
  }
  step('downloading shipping label pdf', { url, label });
  const outDir = path.join('.o11y', 'goq-unified-print-flow', 'downloads');
  fs.mkdirSync(outDir, { recursive: true });
  const fallbackBase = safeBasename(`${prefix}-${label || Date.now()}.pdf`);
  const fallbackFilename = /\.pdf$/i.test(fallbackBase) ? fallbackBase : `${fallbackBase}.pdf`;
  let buffer;
  let type = '';
  let disposition = '';
  let filename = fallbackFilename;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('PDF download timed out')), 30000);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    disposition = response.headers.get('content-disposition') || '';
    type = response.headers.get('content-type') || '';
    const fromHeader = filenameFromDisposition(disposition);
    filename = /\.pdf$/i.test(fromHeader) ? fromHeader : fallbackFilename;
    if (!response.ok) {
      throw new Error(`PDF download failed: ${JSON.stringify({ status: response.status, type, url, size: buffer.length })}`);
    }
  } catch (error) {
    step('direct pdf download failed; retrying with powershell', { url, error: String(error?.message || error) });
    const fullName = path.resolve(outDir, filename);
    await downloadPdfWithPowerShell(url, fullName);
    buffer = fs.readFileSync(fullName);
  }
  if (buffer.length < 1 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(`Downloaded label is not a PDF: ${JSON.stringify({ type, url, size: buffer.length, head: buffer.subarray(0, 16).toString('hex') })}`);
  }
  const fullName = path.resolve(outDir, filename);
  fs.writeFileSync(fullName, buffer);
  return { fullName, size: buffer.length, type, disposition, url };
}

async function downloadPdfWithPowerShell(url, fullName) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$url = ${JSON.stringify(url)}`,
    `$out = ${JSON.stringify(fullName)}`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $out) | Out-Null',
    'Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 45',
  ].join('; ');
  await execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 60000 });
}

function splitList(value) {
  if (!value) return [];
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalDateTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`Invalid local datetime: ${value}`);
  const [, y, mo, d, h, mi, s = '00'] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function buildRunGoal({ args, statusResolution, config, execute, today, onlyOrder, excludeOrders, storeTab }) {
  const b2Csv = (config.labelMode || LABEL_MODE_GOQ_API) === LABEL_MODE_B2_CSV;
  const outputMode = args['skip-print'] === true
    ? 'generate-and-verify-without-print'
    : args['stop-before-label-print'] === true
      ? 'stop-before-label-print'
      : b2Csv
        ? 'picking-print-and-b2-csv-handoff'
        : 'print';
  const labelCriteria = b2Csv
    ? [
      'Shipping-label CSV export records an exact target snapshot before the export.',
      'The exported B2 Cloud CSV is verified against the target snapshot (every target present, no extra rows).',
      'A B2 Cloud handoff file is written for the Yamato Business Members import/print step; GoQ-side label generation buttons are not pressed.',
    ]
    : [
      'Shipping-label generation records an exact target snapshot before the request.',
      'Shipping-label issuance is verified against the target snapshot after generation.',
      'Shipping label is printed to the status-specific printer unless explicitly skipped or stopped before print.',
    ];
  return {
    objective: execute
      ? `Complete GoQ ${config.label} shipping set for ${today}`
      : `Inspect GoQ ${config.label} shipping candidates for ${today}`,
    ownerRoles: {
      executor: 'Run the GoQ flow, make only rule-backed decisions, and record evidence.',
      reviewer: 'Start from this goal, compare run evidence to success criteria, and fail the run when it drifts from the goal.',
    },
    requested: {
      statusKey: args.status,
      baseStatusKey: statusResolution.baseStatus,
      statusLabel: config.label,
      stat: config.stat,
      date: today,
      mode: execute ? 'execute' : 'dry-run',
      outputMode,
      labelMode: config.labelMode || LABEL_MODE_GOQ_API,
      onlyOrder: onlyOrder || '',
      excludedByRequest: [...excludeOrders],
      storeTab: storeTab || '',
    },
    successCriteria: [
      'GoQ login state is verified (or auto-login from .env succeeds) before side effects.',
      'Required rule material is loaded before side effects.',
      'Address warnings are safely fixed, externally/operator confirmed, or memo-marked as 住所不正 and excluded before output.',
      'Eligible target rows have the expected carrier, today shipping date before output, and no prior tracking/invoice marker.',
      'Picking list is printed or explicitly preview-only/skipped according to requested options.',
      ...labelCriteria,
      'The review gate reports no violations and no unaccepted warnings.',
    ],
  };
}

// B2クラウド用CSV（Shift_JIS）を対象スナップショットと突合する（tools/lib/label-csv.mjs）
function verifyLabelCsvAgainstTargets(labelCsv, targets) {
  return verifyLabelCsvFile(labelCsv.fullName, targets);
}

// ヤマトビジネスメンバーズ側（tools/yamato-b2/）へ渡す引き継ぎファイルを書く
function writeB2Handoff({ labelCsv, snapshot, verification }) {
  fs.mkdirSync(B2_HANDOFF_DIR, { recursive: true });
  const file = path.join(B2_HANDOFF_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.status}.json`);
  const handoff = {
    createdAt: new Date().toISOString(),
    statusKey: args.status,
    baseStatusKey: run.baseStatusKey,
    status: config.label,
    stat: config.stat,
    date: today,
    labelMode: LABEL_MODE_B2_CSV,
    labelPrinter: config.labelPrinter,
    csv: path.resolve(labelCsv.fullName),
    csvBytes: labelCsv.size,
    csvFormat: labelCsv.format,
    dataRowCount: verification.dataRowCount,
    targets: snapshot.targets.map(target => ({ goqId: target.goqId, orderNumber: target.orderNumber, carrier: target.carrier, shipDate: target.shipDate })),
    runLog: path.resolve(run.logFile),
    yamato: { imported: false, printed: false, trackingImportedToGoq: false },
  };
  fs.writeFileSync(file, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
  return { file: path.resolve(file), targetCount: handoff.targets.length, csv: handoff.csv, labelPrinter: handoff.labelPrinter };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function failWithRun(message, code) {
  run.error = message;
  run.guardReview = reviewRunInProcess(run);
  saveRun();
  console.error(JSON.stringify(run, null, 2));
  closeAllCdpPages();
  process.exit(code);
}

function closeAllCdpPages() {
  for (const page of [...openCdpPages]) {
    page.close();
  }
}

function step(name, detail) {
  run.steps.push({ name, detail, at: new Date().toISOString() });
  saveRun();
}

function saveRun() {
  if (!run?.logFile) return;
  fs.writeFileSync(run.logFile, JSON.stringify(run, null, 2), 'utf8');
}

function loadRuleMaterial() {
  const sources = REQUIRED_RULE_SOURCES.map(source => {
    const result = {
      key: source.key,
      file: source.file,
      exists: fs.existsSync(source.file),
      required: source.required,
      missingRequired: [],
      bytes: 0,
      mtimeMs: null,
    };
    if (!result.exists) {
      result.missingRequired = [...source.required];
      return result;
    }
    const stat = fs.statSync(source.file);
    const text = fs.readFileSync(source.file, 'utf8');
    result.bytes = stat.size;
    result.mtimeMs = stat.mtimeMs;
    result.missingRequired = source.required.filter(needle => !text.includes(needle));
    return result;
  });
  return {
    ok: sources.every(source => source.exists && source.missingRequired.length === 0),
    loadedAt: new Date().toISOString(),
    sources,
  };
}

function targetScopeRows(rows) {
  if (!onlyOrder) return rows;
  return rows.filter(row => row.orderNumber === onlyOrder || row.goqId === onlyOrder);
}

function createLabelTargetSnapshot(rows, meta) {
  return {
    createdAt: new Date().toISOString(),
    requestedAt: meta.requestedAt.toISOString(),
    statusKey: meta.statusKey,
    stat: meta.stat,
    expectedCarrier: meta.carrier,
    shipDate: meta.shipDate,
    targetCount: rows.length,
    targets: rows.map(row => ({
      goqId: row.goqId,
      orderNumber: row.orderNumber,
      statusKey: meta.statusKey,
      stat: meta.stat,
      carrier: row.carrier,
      shipDate: row.shipDate,
      tracking: row.tracking,
      invoiceIssued: row.invoiceIssued,
    })),
  };
}

function compareLabelIssuance(targets, rows) {
  const byGoqId = new Map();
  const byOrderNumber = new Map();
  for (const row of rows) {
    if (row.goqId && shouldPreferLabelRow(row, byGoqId.get(row.goqId))) byGoqId.set(row.goqId, row);
    if (row.orderNumber && shouldPreferLabelRow(row, byOrderNumber.get(row.orderNumber))) byOrderNumber.set(row.orderNumber, row);
  }
  const issued = [];
  const unissued = [];
  const matchedRows = [];
  for (const target of targets) {
    const row = byGoqId.get(target.goqId) || byOrderNumber.get(target.orderNumber) || null;
    if (row) matchedRows.push(row);
    const hasLabel = Boolean(row?.invoiceIssued || row?.tracking || String(row?.carrier || row?.text || '').includes('[伝票入力済]'));
    const summary = {
      goqId: target.goqId,
      orderNumber: target.orderNumber,
      statusKey: target.statusKey,
      expectedShipDate: target.shipDate,
      found: Boolean(row),
      tracking: row?.tracking || '',
      invoiceIssued: Boolean(row?.invoiceIssued),
      currentShipDate: row?.shipDate || '',
      carrier: row?.carrier || target.carrier || '',
    };
    if (hasLabel) issued.push(summary);
    else unissued.push({
      ...summary,
      reason: row ? 'tracking number or label-issued marker not found after generation' : 'target row not found after generation',
    });
  }
  return {
    foundCount: uniqueValues(matchedRows.map(row => row.goqId || row.orderNumber)).length,
    issued,
    unissued,
    matchedRows,
  };
}

function shouldPreferLabelRow(candidate, current) {
  if (!current) return true;
  const candidateIssued = Boolean(candidate.invoiceIssued || candidate.tracking);
  const currentIssued = Boolean(current.invoiceIssued || current.tracking);
  return candidateIssued && !currentIssued;
}

function uniqueValues(values) {
  return [...new Set(values.filter(value => value !== undefined && value !== null && String(value).trim() !== '').map(value => String(value)))];
}

function loadResumeTargetsFromRecentRun(statusKey, date) {
  if (!fs.existsSync(RUN_DIR)) return [];
  const currentLog = run?.logFile ? path.resolve(run.logFile) : '';
  const files = fs.readdirSync(RUN_DIR)
    .filter(name => name.endsWith(`-${statusKey}.json`))
    .map(name => path.join(RUN_DIR, name))
    .filter(file => path.resolve(file) !== currentLog)
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of files) {
    try {
      const previous = JSON.parse(fs.readFileSync(item.file, 'utf8'));
      if (previous.statusKey !== statusKey || previous.date !== date) continue;
      const rows = previous.initial?.eligible || previous.afterShippingDateReturn?.rows || [];
      const targets = rows
        .map(row => ({
          goqId: row.goqId || row.id || '',
          orderNumber: row.orderNumber || '',
          carrier: row.carrier || config.carrierText || '',
          shipDate: date,
          tracking: '',
          addressWarning: Boolean(row.addressWarning),
        }))
        .filter(row => row.goqId || row.orderNumber);
      if (targets.length) return targets;
    } catch {
      // Ignore unreadable stale logs and keep looking for a usable recovery source.
    }
  }
  return [];
}

function findPreviousPickingPrint(statusKey, date, targetGoqIds) {
  if (!fs.existsSync(RUN_DIR) || !targetGoqIds.length) return null;
  const currentLog = run?.logFile ? path.resolve(run.logFile) : '';
  const targetSet = new Set(targetGoqIds.map(id => String(id)).filter(Boolean));
  const files = fs.readdirSync(RUN_DIR)
    .filter(name => name.endsWith(`-${statusKey}.json`))
    .map(name => path.join(RUN_DIR, name))
    .filter(file => path.resolve(file) !== currentLog)
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of files) {
    try {
      const previous = JSON.parse(fs.readFileSync(item.file, 'utf8'));
      if (previous.statusKey !== statusKey || previous.date !== date) continue;
      const printedStep = (previous.steps || []).find(step => step.name === 'printed picking list');
      if (!printedStep) continue;
      const previousIds = collectPreviousRunTargetIds(previous);
      if (!targetGoqIds.every(id => previousIds.has(String(id)))) continue;
      return {
        sourceLog: item.file,
        printedAt: printedStep.at || '',
        targetCount: targetSet.size,
        previousTargetCount: previousIds.size,
        printer: printedStep.detail?.printer || PICKING_PRINTER,
        destination: printedStep.detail?.destination || '',
      };
    } catch {
      // Ignore unreadable stale logs.
    }
  }
  return null;
}

function collectPreviousRunTargetIds(previous) {
  const ids = new Set();
  const addRows = rows => {
    for (const row of rows || []) {
      const id = row?.goqId || row?.id || '';
      if (id) ids.add(String(id));
    }
  };
  addRows(previous.labelTargetSnapshot?.targets || []);
  for (const step of [...(previous.steps || [])].reverse()) {
    addRows(step.detail?.eligible || []);
    addRows(step.detail?.verified?.rows || []);
    if (ids.size) break;
  }
  addRows(previous.initial?.eligible || []);
  return ids;
}

function reviewRunInProcess(candidate) {
  const violations = [];
  const steps = Array.isArray(candidate.steps) ? candidate.steps : [];
  const stepNames = steps.map(step => step.name);
  const hasStep = needle => stepNames.some(name => name.includes(needle));
  const firstIndex = needle => stepNames.findIndex(name => name.includes(needle));
  const printedPicking = hasStep('printed picking list') || hasStep('verified picking print preview without pressing print') || hasStep('reused previous picking list print for resume');
  const requestedLabel = hasStep('requested shipping label generation');
  const downloadedLabel = hasStep('downloaded shipping label pdf') || hasStep('downloaded existing shipping label pdf');
  const downloadedExistingLabel = hasStep('downloaded existing shipping label pdf');
  const printedLabel = hasStep('printed shipping label') || hasStep('stopped before shipping label print button') || hasStep('printed existing shipping label');
  const exportedLabelCsv = hasStep('exported shipping label csv');

  for (const issue of collectGoalIssues(candidate, { printedPicking, requestedLabel, downloadedLabel, printedLabel, exportedLabelCsv, hasStep })) {
    violations.push(issue);
  }
  if (exportedLabelCsv && !hasStep('recorded shipping-label target snapshot')) {
    violations.push({ code: 'LABEL_TARGET_SNAPSHOT_MISSING', message: 'B2 Cloud CSV export occurred without recording the exact target snapshot.' });
  }
  if (exportedLabelCsv && !printedPicking && candidate.args?.['skip-picking'] !== true && !candidate.error) {
    violations.push({ code: 'LABEL_BEFORE_PICKING', message: 'B2 Cloud CSV export occurred without picking-list output in the same run.' });
  }
  if (exportedLabelCsv && printedPicking && firstIndex('exported shipping label csv') < firstIndex('picking') && candidate.args?.['label-first'] !== true) {
    violations.push({ code: 'ORDERING_VIOLATION', message: 'B2 Cloud CSV export occurred before picking-list output.' });
  }

  if (!candidate.ruleMaterial?.ok) {
    violations.push({ code: 'RULE_MATERIAL_NOT_LOADED', message: 'Required GoQ rule material was not loaded at startup.' });
  }
  const unreviewed = candidate.addressWarningReviewGuard?.unreviewed || [];
  if (unreviewed.length && (printedPicking || requestedLabel || printedLabel || exportedLabelCsv)) {
    violations.push({ code: 'ADDRESS_WARNING_REVIEW_BYPASS', message: 'Output flow continued with address warnings that were not reviewed/fixed.', rows: unreviewed });
  }
  const excludedWarnings = collectManualExcludedAddressWarnings(candidate);
  if (excludedWarnings.length && (printedPicking || requestedLabel || printedLabel || exportedLabelCsv)) {
    violations.push({ code: 'ADDRESS_WARNING_MANUAL_EXCLUDE_BYPASS', message: 'Address-warning rows were manually excluded without being marked fixed.', rows: excludedWarnings });
  }
  const unvalidatedFixedWarnings = collectUnvalidatedFixedAddressWarnings(candidate);
  if (unvalidatedFixedWarnings.length && (printedPicking || requestedLabel || printedLabel || exportedLabelCsv)) {
    violations.push({ code: 'ADDRESS_WARNING_UNVALIDATED_FIXED', message: 'Address-warning rows were treated as fixed even though no safe change or external validation was recorded.', rows: unvalidatedFixedWarnings });
  }
  const unresolvedWithoutMemo = collectUnresolvedAddressWarningsWithoutMemo(candidate);
  if (unresolvedWithoutMemo.length && (printedPicking || requestedLabel || printedLabel || exportedLabelCsv)) {
    violations.push({ code: 'ADDRESS_UNRESOLVED_MEMO_MISSING', message: 'Unresolved address-warning rows were excluded without a recorded one-line memo marker.', rows: unresolvedWithoutMemo });
  }
  if (requestedLabel && !printedPicking && candidate.args?.['skip-picking'] !== true && candidate.args?.['print-existing-label-at'] !== true && !candidate.error) {
    violations.push({ code: 'LABEL_BEFORE_PICKING', message: 'Shipping-label generation occurred without picking-list output in the same run.' });
  }
  if (requestedLabel && printedPicking && firstIndex('requested shipping label generation') < firstIndex('picking') && candidate.args?.['label-first'] !== true) {
    violations.push({ code: 'ORDERING_VIOLATION', message: 'Shipping-label generation occurred before picking-list output.' });
  }
  if (requestedLabel && !hasStep('recorded shipping-label target snapshot')) {
    violations.push({ code: 'LABEL_TARGET_SNAPSHOT_MISSING', message: 'Shipping-label generation occurred without recording the exact target snapshot.' });
  }
  if (downloadedLabel && !downloadedExistingLabel && !hasStep('verified shipping-label issuance after generation')) {
    violations.push({ code: 'LABEL_ISSUANCE_DIFFERENCE_CHECK_MISSING', message: 'Shipping-label PDF was downloaded without post-generation issuance verification.' });
  }
  if (hasLabelGenerationDialog(candidate, steps) && (downloadedLabel || printedLabel)) {
    violations.push({ code: 'LABEL_DIALOG_BYPASS', message: 'Flow continued after a shipping-label generation dialog/modal instead of stopping for review.', detail: candidate.blockingLabelDialog || null });
  }
  if (printedLabel && !downloadedLabel) {
    violations.push({ code: 'LABEL_PRINT_WITHOUT_DOWNLOAD_RECORD', message: 'Label print step exists without a downloaded-label record.' });
  }
  for (const step of steps.filter(item => /printed picking list|verified picking print preview without pressing print|printed shipping label|printed existing shipping label|stopped before shipping label print button|stopped before existing shipping label print button/.test(item.name))) {
    if (!step.detail?.screenshot) {
      violations.push({ code: 'MISSING_PRINT_PREVIEW_SCREENSHOT', message: `Printed output step lacks screenshot evidence: ${step.name}` });
    }
  }
  for (const issue of collectPrinterDestinationIssues(candidate, steps)) {
    violations.push(issue);
  }
  return { ok: violations.length === 0, reviewedAt: new Date().toISOString(), violations };
}

function hasLabelGenerationDialog(candidate, steps) {
  const handledNonBlocking = steps.some(step => step.name === 'handled non-blocking shipping label generation notice');
  if (handledNonBlocking && (candidate.javascriptDialogs || []).every(dialog => dialog.context !== 'shipping-label-generation' || classifyShippingLabelDialog(dialog.message, dialog.type).nonBlocking)) {
    return false;
  }
  if (candidate.blockingLabelDialog) return true;
  if ((candidate.javascriptDialogs || []).some(dialog => dialog.context === 'shipping-label-generation')) return true;
  return steps.some(step => {
    if (step.name !== 'requested shipping label generation') return false;
    const detail = step.detail?.click || {};
    const dialogs = [...(detail.javascriptDialogs || []), ...(detail.domDialogs || [])];
    return dialogs.some(dialog => !classifyShippingLabelDialog(dialog.message || dialog.text || '', dialog.type).nonBlocking);
  });
}

function classifyShippingLabelDialog(message, type = '') {
  const text = String(message || '');
  const hasError = /エラー|警告|住所不正|不正|失敗|できません|出来ません|対象外|除外|修正|未入力|error|failed/i.test(text)
    || /繧ｨ繝ｩ繝ｼ|隴ｦ蜻|菴乗園|荳榊ｙ|螟ｱ謨|譛ｪ蜈･蜉|蟇ｾ雎｡螟|菫ｮ豁｣/.test(text);
  const isSuccess = /成功しました|完了しました|受け付けました|受付|リクエスト.*完了/.test(text)
    || /螳御ｺ|蜿励￠|蜿嶺ｻ|繝ｪ繧ｯ繧ｨ繧ｹ繝/.test(text);
  const isConfirmation = /送り状|伝票|発行|出力|印刷|実行|よろしいですか|しますか/.test(text)
    || /騾√ｊ迥ｶ|莨晉･ｨ|逋ｺ陦|蜃ｺ蜉|蜊ｰ蛻|螳溯｡|繧医ｍ縺励＞/.test(text);
  if (hasError) return { kind: 'error', accept: type === 'alert', nonBlocking: false };
  if (isSuccess) return { kind: 'success', accept: true, nonBlocking: true };
  if (isConfirmation) return { kind: 'confirmation', accept: true, nonBlocking: true };
  return { kind: 'unknown', accept: type === 'alert', nonBlocking: false };
}

function collectPrinterDestinationIssues(candidate, steps) {
  const issues = [];
  const baseStatus = candidate.baseStatusKey || String(candidate.statusKey || '').replace(/-amazon$/, '');
  const expectedLabelPrinter = LABEL_PRINTER_BY_STATUS[baseStatus];
  for (const step of steps) {
    const name = String(step.name || '');
    const detail = step.detail || {};
    const isPicking = /printed picking list|verified picking print preview without pressing print/.test(name);
    const isLabel = /printed shipping label|printed existing shipping label|stopped before shipping label print button|stopped before existing shipping label print button/.test(name);
    if (!isPicking && !isLabel) continue;
    const expected = isPicking ? PICKING_PRINTER : expectedLabelPrinter;
    if (!expected) {
      issues.push({ code: 'UNKNOWN_EXPECTED_PRINTER', message: `Cannot determine expected printer for status: ${candidate.statusKey || ''}`, step });
      continue;
    }
    const declared = detail.expectedPrinter || detail.printer || '';
    const actual = detail.destination || '';
    if (!actual) {
      issues.push({ code: 'PRINT_DESTINATION_NOT_RECORDED', message: `Print output step does not record the actual Chrome print-preview destination: ${name}`, expectedPrinter: expected, step });
      continue;
    }
    if (normalizeText(declared) !== normalizeText(expected)) {
      issues.push({ code: 'EXPECTED_PRINTER_MISMATCH', message: `Logged expected printer does not match status routing for ${name}.`, expectedPrinter: expected, loggedPrinter: declared, step });
    }
    if (!normalizeText(actual).includes(normalizeText(expected))) {
      issues.push({ code: 'PRINT_DESTINATION_MISMATCH', message: `Actual Chrome print-preview destination does not match expected printer for ${name}.`, expectedPrinter: expected, actualDestination: actual, step });
    }
  }
  return issues;
}

function collectManualExcludedAddressWarnings(candidate) {
  const fixed = new Set(candidate.addressFixedGoqIds || []);
  const unresolved = new Set(candidate.addressUnresolvedGoqIds || []);
  for (const item of candidate.addressFixes?.fixed || []) {
    if (item.row?.goqId) fixed.add(item.row.goqId);
  }
  const rows = [];
  for (const section of [candidate.initial, candidate.afterFilter, candidate.beforeLabel]) {
    for (const excluded of section?.excluded || []) {
      const row = excluded.row || {};
      if (excluded.reason === 'manual exclude' && row.addressWarning && !fixed.has(row.goqId) && !unresolved.has(row.goqId)) rows.push(row);
    }
  }
  const seen = new Set();
  return rows.filter(row => {
    const key = row.goqId || row.orderNumber || JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectGoalIssues(candidate, observed) {
  const issues = [];
  const goal = candidate.goal;
  if (!goal) {
    issues.push({
      code: 'GOAL_MISSING',
      message: 'Run log does not declare the goal before execution, so the reviewer cannot evaluate drift from the objective.',
    });
    return issues;
  }
  const requested = goal.requested || {};
  if (requested.statusKey && requested.statusKey !== candidate.statusKey) {
    issues.push({ code: 'GOAL_STATUS_MISMATCH', message: 'Run status does not match the declared goal status.', goalStatus: requested.statusKey, runStatus: candidate.statusKey });
  }
  if (requested.date && requested.date !== candidate.date) {
    issues.push({ code: 'GOAL_DATE_MISMATCH', message: 'Run date does not match the declared goal date.', goalDate: requested.date, runDate: candidate.date });
  }
  if (requested.mode && requested.mode !== candidate.mode) {
    issues.push({ code: 'GOAL_MODE_MISMATCH', message: 'Run mode does not match the declared goal mode.', goalMode: requested.mode, runMode: candidate.mode });
  }
  if (candidate.mode !== 'execute') return issues;

  const runArgs = candidate.args || {};
  const outputMode = requested.outputMode || '';
  const skipPicking = runArgs['skip-picking'] === true;
  const skipLabels = runArgs['skip-labels'] === true;
  const skipPrint = runArgs['skip-print'] === true;
  const previewOnlyPicking = runArgs['preview-only-picking'] === true;
  const stopBeforeLabelPrint = runArgs['stop-before-label-print'] === true || outputMode === 'stop-before-label-print';

  if (!skipPicking && !observed.printedPicking && !previewOnlyPicking) {
    issues.push({ code: 'GOAL_PICKING_OUTPUT_MISSING', message: 'Goal requires a picking-list output, but no picking print/preview step was recorded.' });
  }
  if (!skipLabels && (candidate.labelMode || requested.labelMode) === LABEL_MODE_B2_CSV) {
    // ベニー様版ヤマト系: GoQ側の発行ではなく、CSV出力 → 突合 → 引き継ぎファイルまでがこの run のゴール
    if (!observed.hasStep('exported shipping label csv')) issues.push({ code: 'GOAL_LABEL_CSV_EXPORT_MISSING', message: 'Goal requires the B2 Cloud shipping-label CSV export, but no export step was recorded.' });
    if (!candidate.labelIssuanceVerification?.ok) issues.push({ code: 'GOAL_LABEL_CSV_NOT_VERIFIED', message: 'Goal requires the exported CSV to match the target snapshot, but verification is missing or failed.', detail: candidate.labelIssuanceVerification || null });
    if (!observed.hasStep('wrote b2 cloud handoff')) issues.push({ code: 'GOAL_B2_HANDOFF_MISSING', message: 'Goal requires a B2 Cloud handoff file for the Yamato Business Members step, but none was written.' });
    if (observed.requestedLabel || observed.downloadedLabel) issues.push({ code: 'GOQ_LABEL_API_USED_IN_B2_CSV_MODE', message: 'GoQ-side label generation was used although this status must export the B2 Cloud CSV instead.' });
    return issues;
  }
  if (!skipLabels) {
    if (!observed.requestedLabel) issues.push({ code: 'GOAL_LABEL_REQUEST_MISSING', message: 'Goal requires shipping-label generation, but no label request was recorded.' });
    if (!observed.downloadedLabel) issues.push({ code: 'GOAL_LABEL_DOWNLOAD_MISSING', message: 'Goal requires shipping-label PDF/resource evidence, but no label download/resource step was recorded.' });
    if (!candidate.labelIssuanceVerification?.ok) issues.push({ code: 'GOAL_LABEL_ISSUANCE_NOT_VERIFIED', message: 'Goal requires post-generation label issuance verification, but it is missing or failed.', detail: candidate.labelIssuanceVerification || null });
    if (!skipPrint && !stopBeforeLabelPrint && !observed.printedLabel) issues.push({ code: 'GOAL_LABEL_PRINT_MISSING', message: 'Goal requires shipping-label print output, but no label print step was recorded.' });
  }
  return issues;
}

function collectUnvalidatedFixedAddressWarnings(candidate) {
  const rows = [];
  for (const item of candidate.addressFixes?.fixed || []) {
    if (!item.row?.addressWarning) continue;
    const changed = item.changed === true || (Array.isArray(item.changes) && item.changes.length > 0);
    const externallyValidated = item.externallyValidated === true || item.validation?.external === true;
    if (!changed && !externallyValidated) rows.push({ row: item.row, before: item.before, after: item.after, note: item.note });
  }
  return rows;
}

function collectUnresolvedAddressWarningsWithoutMemo(candidate) {
  const memoMarked = new Set((candidate.addressFixes?.unresolved || [])
    .filter(item => item.ok && String(item.afterMemo || '').includes('住所不正'))
    .map(item => item.row?.goqId)
    .filter(Boolean));
  const missing = [];
  for (const goqId of candidate.addressUnresolvedGoqIds || []) {
    if (!memoMarked.has(goqId) && candidate.args?.['address-unresolved-confirmed'] !== true) {
      missing.push({ goqId, reason: 'address unresolved exclusion lacks recorded 住所不正 memo' });
    }
  }
  return missing;
}

function summarizePlan(plan) {
  return {
    eligible: plan.eligible.map(row => pickRowSummary(row)),
    excluded: plan.excluded.map(item => ({ reason: item.reason, row: pickRowSummary(item.row) })),
    blockers: plan.blockers,
  };
}

function pickRowSummary(row) {
  return {
    goqId: row.goqId,
    orderNumber: row.orderNumber,
    carrier: row.carrier,
    shipDate: row.shipDate,
    tracking: row.tracking,
    addressWarning: row.addressWarning,
  };
}

function buildEligiblePlan(rows, { config, onlyOrder, excludeOrders, allowShipDateToday = false, requireShipDateToday = false }) {
  const eligible = [];
  const excluded = [];
  const blockers = [];
  for (const row of rows) {
    if (onlyOrder && row.orderNumber !== onlyOrder && row.goqId !== onlyOrder) continue;
    if (excludeOrders.has(row.orderNumber) || excludeOrders.has(row.goqId)) {
      excluded.push({ reason: 'manual exclude', row });
      continue;
    }
    if (addressUnresolvedGoqIds.has(row.goqId)) {
      excluded.push({ reason: 'address unresolved after validation and memo marked', row });
      continue;
    }
    if (row.addressWarning && !row.addressFixed && !addressFixedGoqIds.has(row.goqId)) {
      blockers.push({ reason: 'address warning must be reviewed/fixed first', row: pickRowSummary(row) });
      continue;
    }
    // ベニー様の GoQ には処理パネルの「一括入力（出荷日 上書き）」が無く、出荷日は扱わない（manageShipDate: false）
    const manageShipDate = config.manageShipDate !== false;
    if (manageShipDate && row.shipDate && !(allowShipDateToday && row.shipDate === today)) {
      excluded.push({ reason: 'ship date already set', row });
      continue;
    }
    if (manageShipDate && requireShipDateToday && row.shipDate !== today) {
      blockers.push({ reason: `ship date must be today before output: expected ${today}`, row: pickRowSummary(row) });
      continue;
    }
    if (row.tracking || row.invoiceIssued) {
      excluded.push({ reason: 'tracking number or invoice already present', row });
      continue;
    }
    if (!carrierMatches(row.carrier, config.carrierText)) {
      excluded.push({ reason: `carrier mismatch: expected ${config.carrierText}`, row });
      continue;
    }
    eligible.push(row);
  }
  return { eligible, excluded, blockers };
}

function carrierMatches(actual, expected) {
  const a = normalizeText(actual);
  const e = normalizeText(expected);
  if (!a || !e) return false;
  if (e.includes('コンパクト')) return a.includes('ヤマト') && a.includes('コンパクト');
  if (e.includes('ネコポス')) return a.includes('ヤマト') && a.includes('ネコポス');
  return a.includes(e) || e.includes(a);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function phoneCandidateBeforeCarrier(row) {
  const text = String(row?.text || '');
  const carrier = String(row?.carrier || '').trim();
  const carrierIndex = carrier ? text.indexOf(carrier) : -1;
  if (carrierIndex < 0) return '';
  const beforeCarrier = text.slice(Math.max(0, carrierIndex - 80), carrierIndex);
  const candidates = beforeCarrier.match(/\+?0[0-9０-９\s　()（）‐‑‒–—―−ーｰ－-]{8,}[0-9０-９]/g) || [];
  return candidates.find(candidate => {
    const digits = candidate.normalize('NFKC').replace(/[^0-9]/g, '');
    return digits.length >= 10 && digits.length <= 11;
  }) || '';
}

function hasPhoneNormalizationIssue(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[‐‑‒–—―−ーｰ－]/g, '-');
  return /[^0-9-]/.test(normalized);
}

async function connectToGoq(port) {
  return connectOrOpen(port, statusListUrl(config.stat), page => page.url.includes('order.goqsystem.com/goq21/index_beta.php'));
}

async function connectOrOpen(port, url, predicate) {
  let targets = await listTargets(port);
  let page = targets.find(t => t.type === 'page' && predicate(t));
  if (!page) {
    const created = await fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent(url)}`), { method: 'PUT' }).then(r => r.json());
    page = created;
  }
  return new CdpPage(page.webSocketDebuggerUrl, port);
}

async function connectToPdfViewer(port, pdfPath) {
  const url = fileUrl(pdfPath);
  const basename = path.basename(pdfPath);
  let targets = await listTargets(port);
  let page = targets.find(t => t.type === 'page' && t.url.startsWith('file:///') && decodeURIComponent(t.url).includes(basename));
  if (!page) {
    const currentGoq = targets.find(t => t.type === 'page' && t.url.includes('order.goqsystem.com/goq21'));
    if (currentGoq) {
      const existing = new CdpPage(currentGoq.webSocketDebuggerUrl, port);
      await existing.enable();
      await existing.navigate(url);
      existing.close();
    } else {
      await fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent(url)}`), { method: 'PUT' }).then(r => r.json());
    }
  }
  page = await waitUntil(async () => {
    const current = await listTargets(port);
    return current.find(t => t.type === 'page' && t.url.startsWith('file:///') && decodeURIComponent(t.url).includes(basename));
  }, 30000, 500);
  const viewer = await waitUntil(async () => {
    const current = await listTargets(port);
    return current.find(t => t.type === 'iframe' && t.parentId === page.id && t.url.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai'));
  }, 30000, 500);
  return new CdpPage(viewer.webSocketDebuggerUrl, port);
}

// ローカルで作ったピッキングPDFを、GoQのタブを動かさずに新しいタブで開く。
// connectToPdfViewer は既存のGoQタブをPDFへ遷移させるため、送り状発行の前に行うピッキング印刷では使わない。
async function openPdfInNewTab(port, pdfPath) {
  const url = fileUrl(pdfPath);
  const created = await fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent(url)}`), { method: 'PUT' }).then(r => r.json());
  const viewerTarget = await waitUntil(async () => {
    const current = await listTargets(port);
    return current.find(t => t.type === 'iframe' && t.parentId === created.id && t.url.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai'));
  }, 30000, 500);
  const viewer = new CdpPage(viewerTarget.webSocketDebuggerUrl, port);
  return {
    viewer,
    targetId: created.id,
    async close() {
      viewer.close();
      await fetch(cdpHttpUrl(port, `/json/close/${created.id}`)).catch(() => {});
    },
  };
}

async function connectToPdfResource(port, resourceUrl) {
  const samePdfResource = (candidateUrl) => {
    const candidate = String(candidateUrl || '');
    const expected = String(resourceUrl || '');
    if (candidate === expected) return true;
    try {
      if (decodeURIComponent(candidate) === decodeURIComponent(expected)) return true;
    } catch {
      // Ignore malformed escape sequences and fall back to suffix checks.
    }
    const expectedName = safeBasename(expected);
    return Boolean(expectedName && decodeURIComponent(candidate).includes(expectedName));
  };
  let targets = await listTargets(port);
  let page = targets.find(t => t.type === 'page' && samePdfResource(t.url));
  if (!page) {
    const currentGoq = targets.find(t => t.type === 'page' && t.url.includes('order.goqsystem.com/goq21')) || targets.find(t => t.type === 'page');
    if (currentGoq) {
      const existing = new CdpPage(currentGoq.webSocketDebuggerUrl, port);
      await existing.enable();
      await existing.navigate(resourceUrl);
      existing.close();
    } else {
      await fetch(cdpHttpUrl(port, `/json/new?${encodeURIComponent(resourceUrl)}`), { method: 'PUT' }).then(r => r.json());
    }
  }
  page = await waitUntil(async () => {
    const current = await listTargets(port);
    return current.find(t => t.type === 'page' && samePdfResource(t.url));
  }, 30000, 500);
  const viewer = await waitUntil(async () => {
    const current = await listTargets(port);
    return current.find(t => t.type === 'iframe' && t.parentId === page.id && t.url.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai'));
  }, 30000, 500);
  return new CdpPage(viewer.webSocketDebuggerUrl, port);
}

async function listTargets(port) {
  return fetch(cdpHttpUrl(port, '/json/list')).then(r => r.json());
}

class CdpPage {
  constructor(wsUrl, port) {
    this.wsUrl = cdpWebSocketUrl(wsUrl);
    this.port = port;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.dialogContext = '';
    this.ws = new WebSocket(this.wsUrl);
    openCdpPages.add(this);
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.events.push(msg);
        if (msg.method === 'Page.javascriptDialogOpening') {
          const detail = {
            type: msg.params?.type || '',
            message: msg.params?.message || '',
            defaultPrompt: msg.params?.defaultPrompt || '',
            url: msg.params?.url || '',
            context: this.dialogContext || '',
            at: new Date().toISOString(),
          };
          const labelDialogDecision = detail.context === 'shipping-label-generation'
            ? classifyShippingLabelDialog(detail.message, detail.type)
            : null;
          if (labelDialogDecision) {
            detail.decision = labelDialogDecision.kind;
            detail.accepted = labelDialogDecision.accept;
          }
          if (run) {
            run.javascriptDialogs = run.javascriptDialogs || [];
            run.javascriptDialogs.push(detail);
            if (detail.context === 'shipping-label-generation' && !labelDialogDecision?.nonBlocking) run.blockingLabelDialog = detail;
            step('javascript dialog opened', detail);
          }
          if (inspectLabelDialog) {
            run.labelDialog = { ...detail, cancelledForInspection: msg.params?.type !== 'alert' };
            const accept = msg.params?.type === 'alert';
            this.send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
            return;
          }
          if (detail.context === 'shipping-label-generation') {
            this.send('Page.handleJavaScriptDialog', { accept: labelDialogDecision?.accept === true }).catch(() => {});
            return;
          }
          this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        }
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    return new Promise(resolve => {
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    openCdpPages.delete(this);
    try {
      this.ws.close();
    } catch {
      // Best-effort cleanup only.
    }
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Input.setIgnoreInputEvents', { ignore: false });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }

  async click(point) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await wait(100);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async bringToFront() {
    await this.send('Page.bringToFront');
  }

  async navigate(url) {
    await this.bringToFront();
    await this.send('Page.navigate', { url });
    await wait(2500);
  }

  async enterOrderManagement() {
    await this.handleDashboardNoticeModal();
    const url = await this.eval('location.href');
    if (!String(url).includes('/dashboard/')) return;
    const target = await this.eval(`(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(a => (a.innerText || a.textContent || '').replace(/\\s+/g, '').trim() === '受注一覧')
        || links.find(a => (a.innerText || a.textContent || '').replace(/\\s+/g, '').trim() === '受注管理' && (a.href || '').includes('/goq21/index.php'));
      if (!link) return { ok: false, error: 'order management link not found' };
      link.scrollIntoView({ block: 'center', inline: 'center' });
      link.click();
      return { ok: true, text: link.innerText.trim(), href: link.href };
    })()`);
    if (target.ok) {
      await wait(2500);
      await this.handleDashboardNoticeModal();
      step('entered order management from dashboard', { clicked: target.text, href: target.href });
      return;
    }
    await this.navigate(GOQ_ORDER_INDEX_URL);
    await this.handleDashboardNoticeModal();
    step('entered order management by direct fallback url', { url: GOQ_ORDER_INDEX_URL });
  }

  async handleDashboardNoticeModal() {
    const handled = await this.eval(`(async () => {
      const visible = el => {
        if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const textOf = el => (el?.innerText || el?.textContent || el?.value || '').replace(/\\s+/g, ' ').trim();
      const compactTextOf = el => textOf(el).replace(/\\s+/g, '');
      const scrollIntoNoticeView = el => {
        for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
            const box = el.getBoundingClientRect();
            const parent = node.getBoundingClientRect();
            node.scrollTop += box.top - parent.top - Math.max(20, parent.height / 3);
          }
        }
        el?.scrollIntoView?.({ block: 'center', inline: 'center' });
      };
      const candidates = Array.from(document.querySelectorAll('[role="dialog"], dialog, .modal, .ui-dialog, [class*="modal"], [id*="modal"]'))
        .filter(visible)
        .map(el => {
          const text = textOf(el);
          const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]')).filter(input => !input.disabled);
          const submit = Array.from(el.querySelectorAll('button, input[type="submit"], input[type="button"]')).find(btn => {
            const label = compactTextOf(btn);
            return /上記について確認しました|確認しました|submit|送信|確認|同意|OK|保存|次へ/i.test(label + ' ' + (btn.type || ''));
          });
          return { el, text, boxes, submit };
        })
        .filter(item => item.boxes.length > 0 && item.submit && /通知|お知らせ|確認|同意|重要|チェック|上記について確認しました/.test(item.text + ' ' + compactTextOf(item.submit)));
      const modal = candidates.sort((a, b) => {
        const aExact = /上記について確認しました|確認しました/.test(compactTextOf(a.submit)) ? 1 : 0;
        const bExact = /上記について確認しました|確認しました/.test(compactTextOf(b.submit)) ? 1 : 0;
        return bExact - aExact || b.boxes.length - a.boxes.length;
      })[0];
      if (!modal) return { handled: false };
      const checkedLabels = [];
      for (const box of modal.boxes) {
        scrollIntoNoticeView(box);
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!box.checked) {
          box.click();
          await new Promise(resolve => setTimeout(resolve, 50));
          if (!box.checked) {
            box.checked = true;
            box.dispatchEvent(new Event('input', { bubbles: true }));
            box.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        const label = document.querySelector('label[for="' + CSS.escape(box.id || '') + '"]');
        checkedLabels.push(textOf(label) || textOf(box.closest('label')) || box.name || box.id || '');
      }
      scrollIntoNoticeView(modal.submit);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (modal.submit.disabled || modal.submit.getAttribute('aria-disabled') === 'true') {
        modal.el.scrollTop = modal.el.scrollHeight;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (modal.submit.disabled || modal.submit.getAttribute('aria-disabled') === 'true') {
        return {
          handled: false,
          found: true,
          error: 'dashboard notice submit button remained disabled after checking boxes',
          checkboxCount: modal.boxes.length,
          checkedCount: modal.boxes.filter(box => box.checked).length,
          submitText: textOf(modal.submit)
        };
      }
      modal.submit.click();
      return {
        handled: true,
        checkboxCount: modal.boxes.length,
        checkedCount: modal.boxes.filter(box => box.checked).length,
        checkedLabels: checkedLabels.filter(Boolean).slice(0, 20),
        submitText: textOf(modal.submit)
      };
    })()`);
    if (handled?.handled) {
      step('handled dashboard notice modal', handled);
      await wait(2500);
    } else if (handled?.found) {
      step('dashboard notice modal handling failed', handled);
    }
    return handled;
  }

  async waitForOrderList() {
    await waitUntil(async () => this.eval(`(() => {
      if (document.readyState !== 'complete') return false;
      const rowCount = document.querySelectorAll('tr[data-order-number]').length + document.getElementsByName('order_number[]').length;
      if (rowCount > 0) return true;
      const text = document.body?.innerText || '';
      const itemUnit = String.fromCharCode(20214);
      return text.includes('0' + itemUnit) || text.includes('0 / 0' + itemUnit);
    })()`), 30000, 250);
  }

  async ensureDisplayCount500() {
    const before = await this.eval(`(() => {
      const selects = Array.from(document.querySelectorAll('select')).filter(select => {
        const optionText = Array.from(select.options).map(option => option.textContent.trim()).join('|');
        return ['25件', '50件', '100件', '200件', '500件'].every(label => optionText.includes(label));
      });
      return {
        found: selects.length,
        values: selects.map(select => select.value),
        rowCount: document.querySelectorAll('tr[data-order-number]').length,
      };
    })()`);
    const changed = await this.eval(`(() => {
      const selects = Array.from(document.querySelectorAll('select')).filter(select => {
        const optionText = Array.from(select.options).map(option => option.textContent.trim()).join('|');
        return ['25件', '50件', '100件', '200件', '500件'].every(label => optionText.includes(label));
      });
      const changed = [];
      for (const select of selects) {
        if (select.value !== '500') {
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value');
          if (descriptor?.set) descriptor.set.call(select, '500');
          else select.value = '500';
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          changed.push({ value: select.value, text: Array.from(select.options).find(option => option.value === select.value)?.textContent.trim() || '' });
        }
      }
      return { changed, found: selects.length, values: selects.map(select => select.value) };
    })()`);
    if (changed.changed.length) {
      await wait(2500);
      await this.waitForOrderList();
    }
    const after = await this.eval(`(() => {
      const selects = Array.from(document.querySelectorAll('select')).filter(select => {
        const optionText = Array.from(select.options).map(option => option.textContent.trim()).join('|');
        return ['25件', '50件', '100件', '200件', '500件'].every(label => optionText.includes(label));
      });
      return {
        found: selects.length,
        values: selects.map(select => select.value),
        rowCount: document.querySelectorAll('tr[data-order-number]').length,
      };
    })()`);
    if (after.found && after.values.some(value => value !== '500')) {
      throw new Error(`Display count is not 500: ${JSON.stringify(after)}`);
    }
    return { before, changed, after };
  }

  async readRows() {
    return this.eval(`(() => {
      return Array.from(document.querySelectorAll('tr[data-order-number]')).map(tr => {
        const cells = Array.from(tr.children);
        const text = (tr.innerText || '').replace(/\\s+/g, ' ').trim();
        const box = Array.from(tr.getElementsByTagName('input')).find(input => input.name === 'order_number[]');
        const orderLink = Array.from(tr.querySelectorAll('a')).map(a => (a.innerText || a.textContent || '').trim()).find(t => /\\d{3,}-/.test(t))
          || (text.match(/\\b\\d{3}-\\d{7,}-\\d{7,}\\b/) || [''])[0]
          || '';
        const goqId = box?.value || tr.dataset.orderNumber || '';
        const carrierCell = (cells[11]?.innerText || '') || (text.match(/佐川急便|ヤマト運輸\\s*コンパクト|ヤマト運輸\\s*ネコポス|ヤマト運輸/) || [''])[0];
        const shipCell = document.querySelector('#ship_send_date_' + goqId)?.value || cells[16]?.innerText || '';
        const invoiceCell = (cells[18]?.innerText || '').replace(/\\s+/g, ' ').trim();
        const invoiceIssued = invoiceCell.includes('伝票入力済') || text.includes('[伝票入力済]');
        const tracking = invoiceIssued ? '伝票入力済' : invoiceCell;
        return {
          goqId,
          orderNumber: orderLink,
          text,
          carrier: carrierCell.replace(/\\s+/g, ' ').trim(),
          shipDate: extractDate(shipCell),
          tracking: invoiceCell.includes('伝票入力済') ? (tracking || '伝票入力済') : '',
          invoiceIssued,
          addressWarning: text.includes('【住】') || text.includes('[住]'),
          addressFixed: tr.dataset.addressFixed === 'true',
          checked: !!box?.checked
        };
      });
      function extractDate(value) {
        const m = String(value || '').match(/\\d{4}-\\d{2}-\\d{2}/);
        return m ? m[0] : '';
      }
    })()`);
  }

  async readOrderListDiagnostics() {
    return this.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('tr[data-order-number]'));
      const boxes = Array.from(document.getElementsByName('order_number[]'));
      const url = location.href;
      const readyState = document.readyState;
      const title = document.title;
      const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      const sampleRows = rows.slice(0, 5).map(tr => {
        const cells = Array.from(tr.children).map(cell => (cell.innerText || cell.textContent || '').replace(/\\s+/g, ' ').trim());
        const box = Array.from(tr.getElementsByTagName('input')).find(input => input.name === 'order_number[]');
        return {
          goqId: box?.value || tr.dataset.orderNumber || '',
          cellCount: cells.length,
          orderNumber: (tr.innerText || '').match(/\\b\\d{3,}-\\d{7,}-\\d{7,}\\b/)?.[0] || '',
          carrierCell: cells[11] || '',
          shipCell: cells[16] || '',
          invoiceCell: cells[18] || '',
        };
      });
      return {
        url,
        readyState,
        title,
        rowCount: rows.length,
        orderCheckboxCount: boxes.length,
        checkedCount: boxes.filter(box => box.checked).length,
        sampleRows,
        looksLikeDashboard: rows.length === 0 && /お知らせ|重要|受注一覧|GoQSystem/.test(bodyText),
        bodyTextStart: bodyText.slice(0, 800),
      };
    })()`);
  }

  async enterOrderManagementFromDashboardLikePage() {
    const target = await this.eval(`(() => {
      const normalized = value => (value || '').replace(/\\s+/g, '').trim();
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(a => normalized(a.innerText || a.textContent) === '受注一覧')
        || links.find(a => normalized(a.innerText || a.textContent) === '受注管理' && (a.href || '').includes('/goq21/index.php'));
      if (!link) return { ok: false, error: 'order management link not found on dashboard-like page', url: location.href };
      link.scrollIntoView({ block: 'center', inline: 'center' });
      link.click();
      return { ok: true, text: (link.innerText || link.textContent || '').trim(), href: link.href, fromUrl: location.href };
    })()`);
    if (!target.ok) {
      await this.navigate(GOQ_ORDER_INDEX_URL);
      return { ...target, fallbackUrl: GOQ_ORDER_INDEX_URL };
    }
    await wait(2500);
    await this.handleDashboardNoticeModal();
    return target;
  }

  async ensureStatusListContext(stat) {
    let diagnostics = await this.readOrderListDiagnostics();
    if (!diagnostics.looksLikeDashboard) return { ok: true, recovered: false, diagnostics };
    const entry = await this.enterOrderManagementFromDashboardLikePage();
    await this.navigate(statusListUrl(stat));
    await this.waitForOrderList();
    await this.ensureDisplayCount500();
    diagnostics = await this.readOrderListDiagnostics();
    if (diagnostics.looksLikeDashboard) {
      await this.navigate(statusListUrl(stat));
      await this.waitForOrderList();
      await this.ensureDisplayCount500();
      diagnostics = await this.readOrderListDiagnostics();
    }
    const recovered = !diagnostics.looksLikeDashboard;
    step('ensured status list context', { recovered, entry, diagnostics });
    return { ok: recovered, recovered, entry, diagnostics };
  }

  async fixAddressWarnings(rows) {
    const fixed = [];
    const unresolved = [];
    const blockers = [];
    for (const row of rows) {
      const result = await this.fixAddressWarning(row);
      if (result.ok) {
        addressFixedGoqIds.add(row.goqId);
        fixed.push(result);
      } else {
        const unresolvedResult = await this.markAddressUnresolved(row, result);
        if (unresolvedResult.ok) {
          addressUnresolvedGoqIds.add(row.goqId);
          unresolved.push(unresolvedResult);
        } else {
          blockers.push({ ...result, unresolvedMemo: unresolvedResult });
        }
      }
    }
    run.addressFixedGoqIds = [...addressFixedGoqIds];
    run.addressUnresolvedGoqIds = [...addressUnresolvedGoqIds];
    if (blockers.length) {
      const reportedBlockers = blockers.map(item => ({
        reason: item.error || 'address warning could not be fixed automatically',
        required: item.required || 'manual address confirmation',
        row: item.row,
        before: item.before,
        after: item.after,
        changes: item.changes || [],
        unresolvedMemo: item.unresolvedMemo || null,
      }));
      run.addressFixes = { fixed, unresolved, blockers: reportedBlockers };
      run.blockers = reportedBlockers;
      failWithRun('Stopped because one or more unresolved address warnings could not be marked in memo.', 2);
    }
    return { fixed, unresolved, blockers };
  }

  async markAddressUnresolved(row, failure) {
    const result = await this.eval(`(() => {
      const marker = '住所不正';
      const fields = Array.from(document.querySelectorAll('textarea, input[type="text"], input:not([type])'))
        .filter(el => !el.disabled && !el.readOnly && el.offsetParent !== null)
        .map(el => {
          const context = [
            el.name || '',
            el.id || '',
            el.placeholder || '',
            el.getAttribute('aria-label') || '',
            el.closest('tr, li, div, section')?.innerText || ''
          ].join(' ');
          return { el, context };
        });
      const candidate = fields.find(item => /一言\\s*メモ|ひとこと\\s*メモ|メモ|備考|memo|note|comment|remark/i.test(item.context));
      if (!candidate) {
        return {
          ok: false,
          error: 'unresolved address memo field not found',
          required: 'selector update for GoQ one-line memo field',
          visibleFields: fields.slice(0, 30).map(item => ({
            name: item.el.name || '',
            id: item.el.id || '',
            placeholder: item.el.placeholder || '',
            context: item.context.slice(0, 160)
          }))
        };
      }
      const el = candidate.el;
      const beforeMemo = el.value || '';
      const afterMemo = beforeMemo.includes(marker)
        ? beforeMemo
        : (beforeMemo ? beforeMemo + ' ' + marker : marker);
      if (el.value !== afterMemo) {
        el.value = afterMemo;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const saveButton = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button'))
        .find(button => /保存|この内容|更新|登録|save|submit/i.test((button.value || '') + ' ' + (button.innerText || button.textContent || '')));
      if (!saveButton) {
        return {
          ok: false,
          error: 'unresolved address memo save button not found',
          required: 'selector update for GoQ memo save action',
          memoField: {
            name: el.name || '',
            id: el.id || '',
            context: candidate.context.slice(0, 160),
            beforeMemo,
            afterMemo
          }
        };
      }
      saveButton.click();
      return {
        ok: true,
        memo: marker,
        beforeMemo,
        afterMemo,
        memoField: {
          name: el.name || '',
          id: el.id || '',
          context: candidate.context.slice(0, 160)
        }
      };
    })()`);
    await waitUntil(async () => this.eval(`document.readyState === 'complete'`), 15000, 500).catch(() => true);
    return {
      ...result,
      row: pickRowSummary(row),
      reason: failure.error || 'address warning could not be fixed automatically',
      required: failure.required || 'manual/external address confirmation',
      before: failure.before,
      after: failure.after,
      changes: failure.changes || [],
    };
  }

  async normalizePhoneNumbersForRows(rows) {
    const fixed = [];
    const skipped = [];
    const blockers = [];
    for (const row of rows) {
      const phoneCandidate = phoneCandidateBeforeCarrier(row);
      if (!phoneCandidate || !hasPhoneNormalizationIssue(phoneCandidate)) {
        skipped.push({ row: pickRowSummary(row), reason: 'no phone width issue detected in list row' });
        continue;
      }
      const result = await this.normalizePhoneNumberForRow(row);
      if (result.ok && result.changed) fixed.push(result);
      else if (result.ok) skipped.push(result);
      else blockers.push(result);
    }
    return { fixed, skipped, blockers };
  }

  async normalizePhoneNumberForRow(row) {
    await this.navigate(`${GOQ_ORIGIN}/goq21/order_derivery2_1_4.php?oid=${encodeURIComponent(row.goqId)}&st=&stat=${encodeURIComponent(config.stat)}`);
    const result = await this.eval(`(() => {
      const input = document.getElementsByName('a6[0]')[0];
      if (!input) {
        return { ok: false, error: 'phone input not found', required: 'selector update' };
      }
      const before = input.value || '';
      const after = normalizePhoneStrict(before);
      const beforeDigits = digitsOnly(before);
      const afterDigits = digitsOnly(after);
      const changes = before === after ? [] : [{ field: 'tel', before, after }];
      if (beforeDigits !== afterDigits) {
        return {
          ok: false,
          error: 'unsafe phone normalization: digit sequence changed',
          required: 'manual phone confirmation',
          before,
          after,
          beforeDigits,
          afterDigits,
          changes
        };
      }
      if (!changes.length) {
        return { ok: true, changed: false, before, after, beforeDigits, afterDigits, changes };
      }
      input.value = after;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const button = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button'))
        .find(el => /保存|この内容|save|submit/i.test((el.value || '') + ' ' + (el.innerText || el.textContent || '')));
      if (!button) {
        return {
          ok: false,
          error: 'phone save button not found',
          required: 'save button selector update',
          before,
          after,
          beforeDigits,
          afterDigits,
          changes
        };
      }
      button.click();
      return { ok: true, changed: true, before, after, beforeDigits, afterDigits, changes };

      function normalizePhoneStrict(value) {
        return String(value || '')
          .normalize('NFKC')
          .replace(/[‐‑‒–—―−ーｰ－]/g, '-')
          .replace(/[^0-9-]/g, '');
      }
      function digitsOnly(value) {
        return String(value || '')
          .normalize('NFKC')
          .replace(/[^0-9]/g, '');
      }
    })()`);
    await waitUntil(async () => this.eval(`!location.href.includes('order_derivery2_1_4.php') || document.readyState === 'complete'`), 15000, 500).catch(() => true);
    return { ...result, row: pickRowSummary(row) };
  }

  async fixAddressWarning(row) {
    await this.navigate(`${GOQ_ORIGIN}/goq21/order_derivery2_1_4.php?oid=${encodeURIComponent(row.goqId)}&st=&stat=${encodeURIComponent(config.stat)}`);
    const result = await this.eval(`(() => {
      const get = name => document.querySelector('[name="' + name + '"]');
      const before = {
        zip: get('a8[0]')?.value || '',
        pref: get('a9[0]')?.value || '',
        addr1: get('a10[0]')?.value || '',
        addr2: get('a11[0]')?.value || '',
        company: get('a12[0]')?.value || '',
        dept: get('a13[0]')?.value || '',
        tel: get('a6[0]')?.value || ''
      };
      const normalized = normalizeAddress(before);
      const afterWithTel = { ...normalized.after, zip: before.zip, tel: before.tel };
      const changes = diffAddress(before, afterWithTel);
      if (!normalized.safe) {
        return {
          ok: false,
          error: normalized.error,
          required: normalized.required || 'external address validation',
          before,
          after: afterWithTel,
          changes
        };
      }
      if (!changes.length) {
        return {
          ok: false,
          error: 'address warning has no safe mechanical fix recorded',
          required: 'external address validation or explicit address-fixed confirmation',
          noSafeChange: true,
          reviewed: false,
          note: 'surface address warning cannot be treated as fixed without a saved correction or external validation',
          before,
          after: afterWithTel,
          changes
        };
      }
      if (${JSON.stringify(args['approve-address-normalization'] === true)} !== true) {
        return {
          ok: false,
          error: 'address normalization requires explicit approval; automatic width/dash normalization is limited to phone numbers',
          required: 'manual address confirmation',
          before,
          after: afterWithTel,
          changes
        };
      }
      for (const [name, value] of Object.entries({
        'a9[0]': normalized.after.pref,
        'a10[0]': normalized.after.addr1,
        'a11[0]': normalized.after.addr2,
        'a12[0]': normalized.after.company,
        'a13[0]': normalized.after.dept
      })) {
        const el = get(name);
        if (el && el.value !== value) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const changed = changes.length > 0;
      const button = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button'))
        .find(el => /保存|この内容|save|submit/i.test((el.value || '') + ' ' + (el.innerText || el.textContent || '')));
      if (!button) {
        return {
          ok: false,
          error: 'address save button not found',
          required: 'address save button selector update',
          before,
          after: afterWithTel,
          changes
        };
      }
      button.click();
      return { ok: true, changed, before, after: afterWithTel, changes };

      function normalizeAddress(input) {
        const prefs = {
          'Hokkaido': '北海道',
          'Gunma-ken': '群馬県',
          'Gunma': '群馬県',
          'Aichi': '愛知県',
          'Aichi-ken': '愛知県',
          'JP-13': '東京都'
        };
        const after = {
          pref: normalizeText(input.pref),
          addr1: normalizeText(input.addr1),
          addr2: normalizeText(input.addr2),
          company: normalizeText(input.company),
          dept: normalizeText(input.dept)
        };
        if (prefs[after.pref]) after.pref = prefs[after.pref];
        if (input.zip === '332-0004' && after.pref === '埼玉県' && /^領家/.test(after.addr1)) {
          after.addr1 = '川口市' + after.addr1;
        }
        if (input.zip === '510-0962' && after.pref === '三重県' && /^四日市市波木が丘(\\d)/.test(after.addr1)) {
          after.addr1 = after.addr1.replace(/^四日市市波木が丘/, '四日市市波木が丘町');
        }
        after.addr1 = after.addr1.replace(/(\\d+)F\\b/gi, '$1階');
        after.addr2 = after.addr2.replace(/(\\d+)F\\b/gi, '$1階');
        const prefWasKnownRomanized = Boolean(prefs[normalizeText(input.pref)]);
        const romanizedOutsideKnownPref = /[A-Za-z]/.test((prefWasKnownRomanized ? '' : after.pref) + after.addr1 + after.addr2);
        if (romanizedOutsideKnownPref) {
          return {
            safe: false,
            error: 'romanized address requires external normalization',
            required: 'web search or Post-kun API validation',
            after
          };
        }
        if (after.pref && after.addr1.startsWith(after.pref)) {
          after.addr1 = after.addr1.slice(after.pref.length).trim();
        }
        return { safe: true, after };
      }
      function diffAddress(before, after) {
        return ['zip', 'pref', 'addr1', 'addr2', 'company', 'dept', 'tel']
          .filter(field => String(before[field] || '') !== String(after[field] || ''))
          .map(field => ({ field, before: before[field] || '', after: after[field] || '' }));
      }
      function normalizeText(value) {
        return String(value || '')
          .normalize('NFKC')
          .replace(/[‐‑‒–—―−－]/g, '-')
          .replace(/\\s+/g, ' ')
          .trim();
      }
    })()`);
    await waitUntil(async () => this.eval(`!location.href.includes('order_derivery2_1_4.php') || document.readyState === 'complete'`), 15000, 500).catch(() => true);
    return { ...result, row: pickRowSummary(row) };
  }

  // ベニー様: 受注取り込み時点の配送業者は 日本郵便 なので、処理パネルの「配送業者」を ヤマト運輸 に変更してから出荷処理へ進む。
  // 対象行だけを選択 → select[name="trader_type"] を設定 → 隣の「変更」(button[name="Btrader"]) → 画面更新後に配送業者欄で検証。
  async changeCarrierForGoqIds(goqIds, carrier) {
    await this.selectGoqIds(goqIds);
    const previousDialogCount = run.javascriptDialogs?.length || 0;
    const target = await this.eval(`(() => {
      const checked = Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
      if (!checked.length) return { ok: false, error: 'no selected rows' };
      const select = document.querySelector('select[name="trader_type"]');
      if (!select) return { ok: false, error: 'trader_type select not found' };
      const option = Array.from(select.options).find(o => o.value === ${JSON.stringify(carrier)} || o.textContent.trim() === ${JSON.stringify(carrier)});
      if (!option) return { ok: false, error: 'carrier option not found', options: Array.from(select.options).map(o => o.value) };
      const proto = Object.getPrototypeOf(select);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(select, option.value);
      else select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const button = select.parentElement?.querySelector('button[name="Btrader"]') || document.querySelector('button[name="Btrader"]');
      if (!button || button.disabled) return { ok: false, error: 'carrier change button not found or disabled' };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true, checked, carrier: select.value, buttonText: button.textContent.trim() };
    })()`);
    if (!target.ok) throw new Error(`Carrier change was not requested: ${JSON.stringify(target)}`);
    let last = null;
    const verified = await waitUntil(async () => {
      last = await this.eval(`(() => {
        const ids = ${JSON.stringify(goqIds)};
        const rows = ids.map(id => {
          const row = document.querySelector('tr[data-order-number="' + id + '"]');
          const cells = row ? Array.from(row.children) : [];
          return { id, found: !!row, carrier: (cells[11]?.innerText || '').replace(/\\s+/g, ' ').trim() };
        });
        return { rows, ok: rows.every(r => r.found && r.carrier.includes(${JSON.stringify(carrier)})) };
      })()`);
      return last.ok ? last : false;
    }, 20000, 1000).catch(error => ({ ok: false, error: error.message, last }));
    const dialogs = (run.javascriptDialogs || []).slice(previousDialogCount);
    if (!verified.ok) throw new Error(`Carrier change was not verified: ${JSON.stringify({ verified, dialogs })}`);
    return { requested: target, verified, dialogs };
  }

  async selectGoqIds(goqIds) {
    const result = await this.eval(`(() => {
      const ids = new Set(${JSON.stringify(goqIds)});
      const boxes = Array.from(document.getElementsByName('order_number[]'));
      for (const box of boxes) {
        const should = ids.has(box.value);
        if (box.checked !== should) {
          box.scrollIntoView?.({ block: 'center', inline: 'center' });
          box.click();
        }
      }
      return Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
    })()`);
    const got = new Set(result);
    if (result.length !== goqIds.length || goqIds.some(id => !got.has(id))) {
      throw new Error(`Selection mismatch: expected ${goqIds.join(',')}, got ${result.join(',')}`);
    }
  }

  async selectAllThenKeepGoqIds(goqIds) {
    await waitUntil(
      async () => this.eval(`document.getElementsByName('order_number[]').length > 0`),
      10000,
      250
    ).catch(() => {});
    const result = await this.eval(`(() => {
      const keep = new Set(${JSON.stringify(goqIds)});
      const boxes = Array.from(document.getElementsByName('order_number[]'));
      if (!boxes.length) return { ok: false, error: 'no order checkboxes found' };
      const selectAll = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .find(input => input !== boxes[0] && /all|check.?all|select.?all|すべて|全て/i.test((input.id || '') + ' ' + (input.name || '') + ' ' + (input.className || '')))
        || Array.from(document.querySelectorAll('thead input[type="checkbox"], #order-list-table input[type="checkbox"]')).find(input => !input.name || input.name !== 'order_number[]');
      if (selectAll && !selectAll.checked) {
        selectAll.click();
      }
      for (const box of boxes) {
        if (!box.checked) {
          box.scrollIntoView?.({ block: 'center', inline: 'center' });
          box.click();
        }
      }
      const deselected = [];
      for (const box of boxes) {
        if (!keep.has(box.value)) {
          if (box.checked) {
            box.scrollIntoView?.({ block: 'center', inline: 'center' });
            box.click();
          }
          deselected.push(box.value);
        }
      }
      const selected = boxes.filter(box => box.checked).map(box => box.value);
      return { ok: true, selected, deselected, visible: boxes.map(box => box.value) };
    })()`);
    if (!result.ok) throw new Error(result.error);
    const got = new Set(result.selected);
    if (result.selected.length !== goqIds.length || goqIds.some(id => !got.has(id))) {
      throw new Error(`Selection mismatch after select-all/exclude: expected ${goqIds.join(',')}, got ${result.selected.join(',')}`);
    }
    return result;
  }

  async overwriteShippingDate(date) {
    const target = await this.eval(`(async () => {
      const checked = Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
      if (!checked.length) return { ok: false, error: 'no selected rows' };
      const field = document.querySelector('#inputstype');
      if (!field) return { ok: false, error: 'bulk input type control not found' };
      setNativeValue(field, '3');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 250));
      const word = document.querySelector('#input_word');
      if (!word) return { ok: false, error: 'bulk input date control not found after field change' };
      setNativeValue(word, ${JSON.stringify(date)});
      word.dispatchEvent(new Event('input', { bubbles: true }));
      word.dispatchEvent(new Event('change', { bubbles: true }));
      word.dispatchEvent(new Event('blur', { bubbles: true }));
      if (word.value !== ${JSON.stringify(date)}) {
        return { ok: false, error: 'date input value was not retained', actual: word.value };
      }
      const button = Array.from(document.querySelectorAll('button#B012, button[name="B012"]')).find(b => b.textContent.trim() === '上書き' && !b.disabled)
        || Array.from(document.querySelectorAll('button#B012, button[name="B012"]')).find(b => !b.disabled);
      if (!button) return { ok: false, error: 'overwrite button not found' };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true, checked, fieldValue: field.value, dateValue: word.value, buttonText: button.textContent.trim() };
      function setNativeValue(el, value) {
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor?.set) descriptor.set.call(el, value);
        else el.value = value;
      }
    })()`);
    if (!target.ok) throw new Error(target.error);
    let lastVerification = null;
    const verified = await waitUntil(async () => {
      lastVerification = await this.verifyShippingDate(target.checked, date);
      return lastVerification.ok ? lastVerification : false;
    }, 20000, 1000).catch(error => ({
      ok: false,
      error: error.message,
      last: lastVerification,
    }));
    if (!verified.ok) throw new Error(`Shipping date overwrite was not verified: ${JSON.stringify(verified)}`);
    return { input: target, verified };
  }

  async verifyShippingDate(goqIds, date) {
    return this.eval(`(() => {
      const ids = ${JSON.stringify(goqIds)};
      const expected = ${JSON.stringify(date)};
      const rows = ids.map(id => {
        const row = document.querySelector('tr[data-order-number="' + id + '"]');
        const cells = row ? Array.from(row.children) : [];
        const hidden = document.querySelector('#ship_send_date_' + id)?.value || '';
        const shipCell = (cells[16]?.innerText || '').replace(/\\s+/g, ' ').trim();
        const shipCellDate = (shipCell.match(/\\d{4}-\\d{2}-\\d{2}/) || [''])[0] || '';
        const text = row?.innerText || '';
        return {
          id,
          hidden,
          shipCell,
          shipCellDate,
          ok: hidden === expected || shipCellDate === expected,
          text: text.replace(/\\s+/g, ' ').trim().slice(0, 500)
        };
      });
      return { ok: rows.every(row => row.ok), expected, rows };
    })()`);
  }

  async filterShippingDateToday(date) {
    const target = await this.eval(`(() => {
      const select = Array.from(document.querySelectorAll('select#s_day_type[name="s_day_type"]')).find(s => s.offsetParent !== null) || document.querySelector('select#s_day_type[name="s_day_type"]');
      if (!select) return { ok: false, error: 's_day_type select not found' };
      select.value = 'a59';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      for (const [id, value] of [['from_year', ${JSON.stringify(date.slice(0, 4))}], ['from_month', ${JSON.stringify(String(Number(date.slice(5, 7))))}], ['from_day', ${JSON.stringify(String(Number(date.slice(8, 10))))}], ['to_year', ${JSON.stringify(date.slice(0, 4))}], ['to_month', ${JSON.stringify(String(Number(date.slice(5, 7))))}], ['to_day', ${JSON.stringify(String(Number(date.slice(8, 10))))}]]) {
        const el = document.querySelector('#' + id + ', [name="' + id + '"]');
        if (el) el.value = value;
      }
      const today = document.querySelector('#s_day_today[name="s_day_today"]');
      if (today) {
        today.checked = true;
        today.value = '1';
        today.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const button = document.querySelector('button#search[name="search"]');
      if (!button) return { ok: false, error: 'search button not found' };
      const form = button.closest('form');
      if (form?.requestSubmit) form.requestSubmit(button);
      else button.click();
      return { ok: true };
    })()`);
    if (!target.ok) throw new Error(target.error);
    await wait(3500);
  }

  async filterShippingDateTodayAndTargetOrders(date, targets) {
    const terms = uniqueValues([
      ...targets.map(row => row.orderNumber),
      ...targets.map(row => row.goqId),
    ]);
    const target = await this.eval(`(() => {
      const date = ${JSON.stringify(date)};
      const terms = ${JSON.stringify(terms)};
      const select = Array.from(document.querySelectorAll('select#s_day_type[name="s_day_type"]')).find(s => s.offsetParent !== null) || document.querySelector('select#s_day_type[name="s_day_type"]');
      if (!select) return { ok: false, error: 's_day_type select not found' };
      select.value = 'a59';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      for (const [id, value] of [['from_year', date.slice(0, 4)], ['from_month', String(Number(date.slice(5, 7)))], ['from_day', String(Number(date.slice(8, 10)))], ['to_year', date.slice(0, 4)], ['to_month', String(Number(date.slice(5, 7)))], ['to_day', String(Number(date.slice(8, 10)))]] ) {
        const el = document.querySelector('#' + id + ', [name="' + id + '"]');
        if (el) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const orderField = document.querySelector('[name="order"], #order, textarea[name="order"], input[name="order"]');
      if (orderField && terms.length) {
        orderField.value = terms.join('\\n');
        orderField.dispatchEvent(new Event('input', { bubbles: true }));
        orderField.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const button = document.querySelector('button#search[name="search"]');
      if (!button) return { ok: false, error: 'search button not found' };
      const form = button.closest('form');
      if (form?.requestSubmit) form.requestSubmit(button);
      else button.click();
      return { ok: true, shipDateType: select.value, usedOrderField: Boolean(orderField), terms };
    })()`);
    if (!target.ok) throw new Error(target.error);
    await wait(3500);
    return target;
  }

  async verifyLabelIssuanceAfterGeneration(targets, date) {
    const attempts = [];
    const mergedRows = [];
    const routes = [
      { name: 'all-status', url: allStatusListUrl() },
      { name: 'all-status-zero', url: `${GOQ_LIST_URL}?stat=0&s_day_type=&page=1` },
      { name: 'source-status', url: statusListUrl(config.stat) },
    ];
    for (const route of routes) {
      try {
        await this.navigate(route.url);
        await this.waitForOrderList();
        const filter = await this.filterShippingDateTodayAndTargetOrders(date, targets);
        const rows = await this.readRows();
        const comparison = compareLabelIssuance(targets, rows);
        for (const row of comparison.matchedRows || []) mergedRows.push(row);
        const { matchedRows, ...publicComparison } = comparison;
        attempts.push({ route: route.name, url: route.url, filter, rowCount: rows.length, ...publicComparison, matchedRows: matchedRows.map(pickRowSummary) });
        if (comparison.foundCount === targets.length || comparison.unissued.length === 0) break;
      } catch (error) {
        attempts.push({ route: route.name, url: route.url, error: String(error?.message || error) });
      }
    }
    const finalComparison = compareLabelIssuance(targets, mergedRows);
    return {
      ok: finalComparison.unissued.length === 0,
      checkedAt: new Date().toISOString(),
      date,
      targetCount: targets.length,
      issuedCount: finalComparison.issued.length,
      foundCount: finalComparison.foundCount,
      issued: finalComparison.issued,
      unissued: finalComparison.unissued,
      attempts,
    };
  }

  async filterReportNumberEmpty() {
    const target = await this.eval(`(() => {
      const radio = Array.from(document.querySelectorAll('input[name="reportnum"][type="radio"]')).find(input => input.value === '3');
      if (!radio) return { ok: false, error: 'reportnum=3 radio not found' };
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      const button = document.querySelector('button#search[name="search"]');
      if (!button) return { ok: false, error: 'search button not found' };
      const form = button.closest('form');
      if (form?.requestSubmit) form.requestSubmit(button);
      else button.click();
      return { ok: true };
    })()`);
    if (!target.ok) throw new Error(target.error);
    await wait(3500);
  }

  async filterShippingDateTodayAndReportNumberEmpty(date) {
    const target = await this.eval(`(() => {
      const select = Array.from(document.querySelectorAll('select#s_day_type[name="s_day_type"]')).find(s => s.offsetParent !== null) || document.querySelector('select#s_day_type[name="s_day_type"]');
      if (!select) return { ok: false, error: 's_day_type select not found' };
      select.value = 'a59';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      for (const [id, value] of [['from_year', ${JSON.stringify(date.slice(0, 4))}], ['from_month', ${JSON.stringify(String(Number(date.slice(5, 7))))}], ['from_day', ${JSON.stringify(String(Number(date.slice(8, 10))))}], ['to_year', ${JSON.stringify(date.slice(0, 4))}], ['to_month', ${JSON.stringify(String(Number(date.slice(5, 7))))}], ['to_day', ${JSON.stringify(String(Number(date.slice(8, 10))))}]]) {
        const el = document.querySelector('#' + id + ', [name="' + id + '"]');
        if (el) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const today = document.querySelector('#s_day_today[name="s_day_today"]');
      if (today) {
        today.checked = true;
        today.value = '1';
        today.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const radio = Array.from(document.querySelectorAll('input[name="reportnum"][type="radio"]')).find(input => input.value === '3');
      if (!radio) return { ok: false, error: 'reportnum=3 radio not found' };
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      const button = document.querySelector('button#search[name="search"]');
      if (!button) return { ok: false, error: 'search button not found' };
      const form = button.closest('form');
      if (form?.requestSubmit) form.requestSubmit(button);
      else button.click();
      return { ok: true, shipDateType: select.value, reportnum: radio.value };
    })()`);
    if (!target.ok) throw new Error(target.error);
    await wait(3500);
    return target;
  }

  async applyStoreTabFilter(storeName) {
    const target = await this.eval(`(() => {
      const storeName = ${JSON.stringify(storeName)};
      const current = document.querySelector('#st')?.value || '';
      if (current === storeName) {
        return { ok: true, storeName, alreadyApplied: true, st: current };
      }
      const links = Array.from(document.querySelectorAll('a.order-tabs__link, a'));
      const linkMeta = links.map(a => {
        const text = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
        const onclick = a.getAttribute('onclick') || '';
        const onclickStore = (onclick.match(/getElementById\\('st'\\)\\.value='([^']*)'/) || [])[1] || '';
        return { a, text, onclick, onclickStore };
      });
      const match = linkMeta.find(meta => meta.text === storeName || meta.onclickStore === storeName);
      const link = match?.a || null;
      if (!link) {
        return {
          ok: false,
          error: 'store tab not found',
          storeName,
          candidates: linkMeta
            .filter(meta => meta.text.includes(storeName) || meta.onclickStore.includes(storeName) || meta.text.includes('Amazon'))
            .map(meta => ({ text: meta.text, onclickStore: meta.onclickStore }))
            .slice(0, 20)
        };
      }
      link.scrollIntoView({ block: 'center', inline: 'center' });
      link.click();
      return {
        ok: true,
        storeName,
        alreadyApplied: false,
        text: (link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim(),
        onclickStore: match?.onclickStore || '',
        href: link.href || '',
        onclick: link.getAttribute('onclick') || ''
      };
    })()`);
    if (!target.ok) throw new Error(`${target.error}: ${JSON.stringify(target)}`);
    await wait(2500);
    const verified = await this.eval(`(() => {
      const expected = ${JSON.stringify(storeName)};
      const st = document.querySelector('#st')?.value || '';
      const rows = Array.from(document.querySelectorAll('tr[data-order-number]')).map(tr => {
        const text = (tr.innerText || '').replace(/\\s+/g, ' ').trim();
        const box = Array.from(tr.getElementsByTagName('input')).find(input => input.name === 'order_number[]');
        return {
          goqId: box?.value || tr.dataset.orderNumber || '',
          orderNumber: (text.match(/\\b\\d{3}-\\d{7,}-\\d{7,}\\b/) || [''])[0] || '',
          text: text.slice(0, 240),
          matches: text.includes(expected)
        };
      }).filter(row => row.goqId);
      const nonMatchingRows = rows.filter(row => !row.matches).slice(0, 10);
      return {
        ok: st === expected && nonMatchingRows.length === 0,
        st,
        expected,
        rowCount: rows.length,
        nonMatchingRows,
      };
    })()`);
    if (!verified.ok) throw new Error(`Store tab filter was not verified: ${JSON.stringify(verified)}`);
    return { ...target, verification: verified };
  }

  async sortByProductName() {
    const target = await this.eval(`(async () => {
      const table = document.querySelector('#order-list-table') || Array.from(document.querySelectorAll('table')).find(t => t.querySelector('tr[data-order-number]'));
      const before = Array.from(document.querySelectorAll('tr[data-order-number]')).map(tr => Array.from(tr.getElementsByTagName('input')).find(input => input.name === 'order_number[]')?.value || tr.dataset.orderNumber || '').filter(Boolean);
      const beforeUrl = location.href;
      const headerCandidates = Array.from((table || document).querySelectorAll('thead a, th a'));
      const candidates = headerCandidates.length ? headerCandidates : Array.from((table || document).querySelectorAll('a'));
      const textOf = el => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
      let link = candidates.find(el => textOf(el) === '商品名')
        || candidates.find(el => textOf(el).includes('商品名') && (el.closest('th') || el.closest('thead')));
      let cell = null;
      if (!link && table) {
        cell = Array.from(table.querySelectorAll('th, td')).find(el => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim().includes('商品名'));
        link = cell?.querySelector('a') || cell || null;
      }
      if (!link) {
        cell = Array.from(document.querySelectorAll('th, td, [role=columnheader]')).find(el => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim().includes('商品名'));
        link = cell?.querySelector('a') || cell || null;
      }
      if (!link) {
        const headers = Array.from((table || document).querySelectorAll('th, thead td, [role=columnheader]'))
          .map(el => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 120);
        return { ok: false, error: 'product name header not found', headers };
      }
      link.scrollIntoView({ block: 'center', inline: 'center' });
      link.click();
      let directSortFallback = false;
      if (location.href === beforeUrl && !location.href.includes('order_item.a6')) {
        const url = new URL(location.href);
        url.searchParams.set('order', 'order_item.a6 desc NULLS LAST');
        directSortFallback = true;
        setTimeout(() => { location.href = url.toString(); }, 50);
      }
      return { ok: true, href: link.href || '', text: link.innerText || link.textContent || '', before, beforeUrl, directSortFallback };
    })()`);
    if (!target) throw new Error('Product-name sort action returned no result from the page.');
    if (!target.ok) throw new Error(`${target.error}: ${JSON.stringify(target.headers || [])}`);
    let lastResult = null;
    const started = Date.now();
    const result = await waitUntil(async () => {
      lastResult = await this.eval(`(() => {
      const table = document.querySelector('#order-list-table') || Array.from(document.querySelectorAll('table')).find(t => t.querySelector('tr[data-order-number]'));
      if (!table) return { ok: false, error: 'order table not found' };
      let headerCells = Array.from(table.querySelectorAll('thead tr:last-child th, thead tr:last-child td'));
      if (!headerCells.length || !headerCells.some(cell => (cell.innerText || cell.textContent || '').replace(/\\s+/g, '').includes('商品名'))) {
        headerCells = Array.from(table.querySelectorAll('th, thead td, [role=columnheader]'));
      }
      const productIndex = headerCells.findIndex(cell => (cell.innerText || cell.textContent || '').replace(/\\s+/g, '').trim().includes('商品名'));
      if (productIndex < 0) {
        return {
          ok: false,
          error: 'product name column not found',
          headers: headerCells.map(cell => (cell.innerText || cell.textContent || '').replace(/\\s+/g, ' ').trim())
        };
      }
      const rows = Array.from(table.querySelectorAll('tr[data-order-number]')).map((tr, index) => {
        const box = Array.from(tr.getElementsByTagName('input')).find(input => input.name === 'order_number[]');
        const cells = Array.from(tr.children);
        const rawProductCell = cells[productIndex]?.innerText || cells[productIndex]?.textContent || '';
        const productName = extractProductName(rawProductCell);
        return {
          index,
          goqId: box?.value || tr.dataset.orderNumber || '',
          productName,
          checked: Boolean(box?.checked)
        };
      }).filter(row => row.goqId);
      const before = ${JSON.stringify(target.before || [])};
      const beforeUrl = ${JSON.stringify(target.beforeUrl || '')};
      const after = rows.map(row => row.goqId);
      const changed = before.length === after.length && before.some((id, index) => id !== after[index]);
      const urlChanged = Boolean(beforeUrl) && location.href !== beforeUrl && location.href.includes('order_item.a6');
      return {
        ok: rows.length > 0 && (changed || urlChanged || rows.length <= 1),
        productColumnIndex: productIndex,
        rowCount: rows.length,
        changed,
        urlChanged,
        url: location.href,
        beforeUrl,
        before,
        after,
        firstRows: rows.slice(0, 10),
      };
      function extractProductName(value) {
        return String(value || '')
          .split(/\\n\\s*〒\\d{3}-\\d{4}/)[0]
          .replace(/\\n\\s*[0-9,]+円\\s*x\\s*\\d+個[\\s\\S]*$/u, '')
          .replace(/\\s+/g, ' ')
          .trim();
      }
    })()`);
      return lastResult.ok ? { ...lastResult, elapsedMs: Date.now() - started } : false;
    }, 8000, 100).catch(error => ({
      ...(lastResult || {}),
      ok: false,
      error: error.message,
      elapsedMs: Date.now() - started,
    }));
    if (!result.ok && onlyOrder && result.after?.includes(onlyOrder)) {
      return { ...result, ok: true, singleOrderOverride: onlyOrder };
    }
    if (!result.ok) throw new Error(`GoQ product-name sort action was not verified: ${JSON.stringify(result)}`);
    return result;
  }

  async exportPickingCsv() {
    const target = await this.eval(`(() => {
      const select = document.querySelector('#trader_s3');
      if (!select) return { ok: false, error: '#trader_s3 not found' };
      select.value = 'customize_csv_${PICKING_CSV_CUSTOM_ID}';
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const button = document.querySelector('#trader_s3 + button');
      if (!button) return { ok: false, error: '#trader_s3 + button not found' };
      const checked = Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
      if (!checked.length) return { ok: false, error: 'no selected rows' };
      button.click();
      return { ok: true, selected: select.value, checked };
    })()`);
    if (!target.ok) throw new Error(target.error);
    await wait(1500);
  }

  // goq-login.mjs の ensureGoqLogin が使う最小インターフェース
  async fillSelector(selector, value) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'not found: ' + ${JSON.stringify(selector)} };
      el.focus();
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, length: el.value.length };
    })()`);
  }

  async clickByText(text, { exact = true, tags = 'button, input[type="submit"], input[type="button"], a' } = {}) {
    return this.eval(`(() => {
      const norm = v => String(v || '').replace(/\\s+/g, '').trim();
      const want = norm(${JSON.stringify(text)});
      const els = Array.from(document.querySelectorAll(${JSON.stringify(tags)}));
      const el = els.find(e => {
        const label = norm(e.innerText || e.textContent || e.value || e.getAttribute('alt') || e.title);
        return ${exact ? 'label === want' : 'label.includes(want)'};
      });
      if (!el) return { ok: false, error: 'not found by text: ' + ${JSON.stringify(text)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: (el.innerText || el.value || '').trim() };
    })()`);
  }

  // ベニー様版: 送り状データ（B2クラウド形式）CSVを GoQ から出力して .o11y に保存する。
  // 画面の「送り状データ出力」<select id="trader_s"> で B2クラウド形式を選び、隣の出力ボタン（name="B020"）を押す。
  // ボタンは新しいウィンドウへフォーム送信するので、送信をフックして同じ内容を fetch で取り、ファイルに保存する。
  async exportLabelCsvToFile(config) {
    const previousDialogCount = run.javascriptDialogs?.length || 0;
    const prepared = await this.eval(`(() => {
      const select = document.querySelector('#trader_s');
      if (!select) return { ok: false, error: '#trader_s (送り状データ出力の形式選択) not found' };
      const options = Array.from(select.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
      const wantValue = ${JSON.stringify(B2_CSV_FORMAT_VALUE)};
      const option = options.find(o => o.value === wantValue)
        || options.find(o => ${B2_CSV_FORMAT_TEXT.toString()}.test(o.text) && !/e-?飛伝|ehiden|佐川/i.test(o.text + o.value));
      if (!option) return { ok: false, error: 'B2 cloud csv format option not found', options };
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const checked = Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
      if (!checked.length) return { ok: false, error: 'no selected rows' };
      const button = document.querySelector('button[name="B020"]') || (select.nextElementSibling?.tagName === 'BUTTON' ? select.nextElementSibling : document.querySelector('#trader_s + button'));
      if (!button) return { ok: false, error: 'label csv output button not found' };

      window.__goqLabelCsvCapture = { submits: [], opens: [], installedAt: new Date().toISOString() };
      if (!window.__goqOrigFormSubmitForLabelCsv) window.__goqOrigFormSubmitForLabelCsv = HTMLFormElement.prototype.submit;
      const serialize = form => {
        const data = new URLSearchParams(new FormData(form));
        return { action: form.action, method: (form.method || 'get').toUpperCase(), target: form.target || '', id: form.id || '', body: data.toString() };
      };
      HTMLFormElement.prototype.submit = function () {
        window.__goqLabelCsvCapture.submits.push({ via: 'form.submit()', ...serialize(this) });
        // 実際の送信（新しいウィンドウ）は行わない。fetch で同じ内容を取得する。
      };
      document.addEventListener('submit', event => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        window.__goqLabelCsvCapture.submits.push({ via: 'submit event', ...serialize(form) });
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true, once: true });
      if (!window.__goqOrigOpenForLabelCsv) window.__goqOrigOpenForLabelCsv = window.open;
      window.open = function (url, name) {
        window.__goqLabelCsvCapture.opens.push({ url: String(url || ''), name: String(name || '') });
        return null;
      };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = button.getBoundingClientRect();
      return {
        ok: true,
        option,
        options,
        checked,
        buttonText: button.textContent.trim(),
        clickPoint: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
      };
    })()`);
    if (!prepared.ok) throw new Error(`Label CSV export was not started: ${JSON.stringify(prepared)}`);

    this.dialogContext = 'label-csv-export';
    let capture;
    try {
      await this.click(prepared.clickPoint);
      capture = await waitUntil(async () => {
        const current = await this.eval('window.__goqLabelCsvCapture');
        return current?.submits?.length ? current : null;
      }, 8000, 250).catch(() => null);
      if (!capture) {
        // ボタンが submit を起こさなかった場合は、GoQ の downcsv() を直接呼ぶ（同じ選択・同じ形式）
        const invoked = await this.eval(`(() => {
          if (typeof window.downcsv !== 'function') return { ok: false, error: 'downcsv not defined' };
          try { window.downcsv({ isTrusted: false }); } catch (error) { return { ok: false, error: String(error) }; }
          return { ok: true };
        })()`);
        capture = await waitUntil(async () => {
          const current = await this.eval('window.__goqLabelCsvCapture');
          return current?.submits?.length ? current : null;
        }, 5000, 250).catch(() => null);
        if (!capture) throw new Error(`Label CSV export did not submit a form: ${JSON.stringify({ invoked, opens: (await this.eval('window.__goqLabelCsvCapture'))?.opens })}`);
        capture.fallback = 'downcsv()';
      }
    } finally {
      this.dialogContext = '';
      await this.eval(`(() => {
        if (window.__goqOrigFormSubmitForLabelCsv) HTMLFormElement.prototype.submit = window.__goqOrigFormSubmitForLabelCsv;
        if (window.__goqOrigOpenForLabelCsv) window.open = window.__goqOrigOpenForLabelCsv;
        return true;
      })()`).catch(() => {});
    }
    const submit = capture.submits[capture.submits.length - 1];
    const dialogs = (run.javascriptDialogs || []).slice(previousDialogCount);
    const result = await this.eval(`(async () => {
      const submit = ${JSON.stringify(submit)};
      const init = { method: submit.method, credentials: 'same-origin' };
      let url = submit.action;
      if (submit.method === 'POST') {
        init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        init.body = submit.body;
      } else if (submit.body) {
        url += (url.includes('?') ? '&' : '?') + submit.body;
      }
      const toBase64 = buffer => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      };
      let response = await fetch(url, init);
      let type = response.headers.get('content-type') || '';
      let disposition = response.headers.get('content-disposition') || '';
      if (/text\\/html/i.test(type)) {
        const html = await response.text();
        // 応答例: <script>//location.replace("../infile.php?fname=/tmp/.../ehiden/....csv")</script>
        //         <script>location.replace("../infile.php?fname=/tmp/.../b2/....csv")</script>
        // コメントアウトされた行（e-飛伝用）を除き、有効な最後のリンクを使う
        const matches = Array.from(html.matchAll(/infile\\.php\\?fname=([^"')\\s]+)/g)).map(m => {
          const lineStart = html.lastIndexOf('\\n', m.index) + 1;
          const linePrefix = html.slice(lineStart, m.index).replace(/^.*<script[^>]*>/i, '').trim();
          return { fname: m[1], commented: linePrefix.startsWith('//') };
        });
        const active = matches.filter(m => !m.commented);
        const chosen = (active.length ? active : matches).at(-1);
        if (!chosen) return { ok: false, step: 'export', status: response.status, type, html: html.slice(0, 600), url };
        const fname = chosen.fname.trim();
        response = await fetch('/goq21/infile.php?fname=' + encodeURIComponent(fname), { credentials: 'same-origin' });
        type = response.headers.get('content-type') || '';
        disposition = response.headers.get('content-disposition') || '';
        const buffer = await response.arrayBuffer();
        return { ok: response.ok, status: response.status, type, disposition, fname, url, base64: toBase64(buffer), size: buffer.byteLength };
      }
      const buffer = await response.arrayBuffer();
      return { ok: response.ok, status: response.status, type, disposition, url, base64: toBase64(buffer), size: buffer.byteLength };
    })()`);
    if (!result.ok || !result.base64 || result.size < 1) {
      throw new Error(`Label CSV export failed: ${JSON.stringify({ step: result.step, status: result.status, type: result.type, url: result.url, html: result.html, dialogs })}`);
    }
    if (!/csv|octet-stream|text\/plain|application\/download|vnd\.ms-excel/i.test(result.type)) {
      throw new Error(`Label CSV export returned unexpected content type: ${JSON.stringify({ status: result.status, type: result.type, size: result.size, url: result.url })}`);
    }
    const outDir = path.join('.o11y', 'goq-unified-print-flow', 'downloads');
    fs.mkdirSync(outDir, { recursive: true });
    const filename = filenameFromDisposition(result.disposition) || safeBasename(result.fname) || `label-b2-${args.status}-${Date.now()}.csv`;
    const fullName = path.resolve(outDir, filename);
    fs.writeFileSync(fullName, Buffer.from(result.base64, 'base64'));
    return {
      fullName,
      size: result.size,
      format: prepared.option,
      formatOptions: prepared.options,
      checked: prepared.checked,
      buttonText: prepared.buttonText,
      submit: { via: submit.via, action: submit.action, method: submit.method, target: submit.target, fallback: capture.fallback || '' },
      response: { status: result.status, type: result.type, disposition: result.disposition, url: result.url },
      dialogs,
    };
  }

  async exportPickingCsvToFile() {
    const result = await this.eval(`(async () => {
      const select = document.querySelector('#trader_s3');
      if (!select) return { ok: false, error: '#trader_s3 not found' };
      select.value = 'customize_csv_${PICKING_CSV_CUSTOM_ID}';
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));

      const checked = Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
      if (!checked.length) return { ok: false, error: 'no selected rows' };

      const form = document.querySelector('#pro_form') || select.closest('form') || document.querySelector('form');
      if (!form) return { ok: false, error: 'export form not found' };
      const data = new URLSearchParams(new FormData(form));
      data.set('trader_s3', 'customize_csv_${PICKING_CSV_CUSTOM_ID}');
      const existingOrderIds = new Set(data.getAll('order_number[]'));
      for (const id of checked) {
        if (!existingOrderIds.has(id)) data.append('order_number[]', id);
      }

      const createResponse = await fetch('/goq21/export/create_custom_csv.php?custom_id=${PICKING_CSV_CUSTOM_ID}', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data.toString()
      });
      const html = await createResponse.text();
      const marker = 'infile.php?fname=';
      const markerIndex = html.indexOf(marker);
      if (!createResponse.ok || markerIndex < 0) {
        return {
          ok: false,
          step: 'create',
          status: createResponse.status,
          type: createResponse.headers.get('content-type') || '',
          size: html.length,
          html: html.slice(0, 500),
          checked
        };
      }

      const fname = html
        .slice(markerIndex + marker.length)
        .split('"')[0]
        .split("'")[0]
        .split(')')[0]
        .trim();
      if (!fname) return { ok: false, step: 'parse-fname', html: html.slice(0, 500), checked };

      const csvResponse = await fetch('/goq21/infile.php?fname=' + encodeURIComponent(fname), {
        credentials: 'same-origin'
      });
      const buffer = await csvResponse.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const disposition = csvResponse.headers.get('content-disposition') || '';
      const type = csvResponse.headers.get('content-type') || '';
      return {
        ok: csvResponse.ok,
        createStatus: createResponse.status,
        status: csvResponse.status,
        type,
        disposition,
        fname,
        checked,
        base64: btoa(binary),
        size: bytes.length
      };
    })()`);
    if (!result.ok || !result.base64 || result.size < 1) {
      throw new Error(`CSV export failed: ${JSON.stringify({ step: result.step, createStatus: result.createStatus, status: result.status, type: result.type, error: result.error, size: result.size, html: result.html })}`);
    }
    if (!/csv|octet-stream|text\/plain/i.test(result.type)) {
      throw new Error(`CSV export returned unexpected content type: ${JSON.stringify({ status: result.status, type: result.type, size: result.size, fname: result.fname })}`);
    }
    const outDir = path.join('.o11y', 'goq-unified-print-flow', 'downloads');
    fs.mkdirSync(outDir, { recursive: true });
    const filename = filenameFromDisposition(result.disposition) || safeBasename(result.fname) || `picking-${args.status}-${Date.now()}.csv`;
    const fullName = path.resolve(outDir, filename);
    fs.writeFileSync(fullName, Buffer.from(result.base64, 'base64'));
    return { fullName, size: result.size, checked: result.checked, fname: result.fname, type: result.type, disposition: result.disposition };
  }

  async clickLabelButton(config) {
    const previousDialogCount = run.javascriptDialogs?.length || 0;
    this.dialogContext = 'shipping-label-generation';
    let target;
    try {
      target = await this.eval(`(() => {
      const button = document.querySelector(${JSON.stringify(config.labelButton)});
      if (!button) return { ok: false, error: 'label button not found' };
      const checked = Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value);
      if (!checked.length) return { ok: false, error: 'no selected rows' };
      const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true' || button.classList.contains('disabled');
      if (disabled) {
        return {
          ok: false,
          error: 'label button is disabled',
          text: button.textContent.trim(),
          checked,
          disabled: button.disabled,
          ariaDisabled: button.getAttribute('aria-disabled') || '',
          className: button.className || ''
        };
      }
      button.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = button.getBoundingClientRect();
      return {
        ok: true,
        text: button.textContent.trim(),
        checked,
        clickPoint: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    })()`);
      if (!target.ok) throw new Error(`Label generation was not requested: ${JSON.stringify(target)}`);
      if (config.labelButton === '#B2CloudGeneratePdfApi') {
        target.b2CloudRequestMonitor = await this.installB2CloudRequestMonitor();
      }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.clickPoint.x, y: target.clickPoint.y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.clickPoint.x, y: target.clickPoint.y, button: 'left', buttons: 1, clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.clickPoint.x, y: target.clickPoint.y, button: 'left', buttons: 0, clickCount: 1 });
      await wait(3000);
    } finally {
      this.dialogContext = '';
    }
    target.javascriptDialogs = (run.javascriptDialogs || []).slice(previousDialogCount);
    if (config.labelButton === '#smartAPI' && target.javascriptDialogs.length === 0) {
      const canInvokeSagawaSmartApi = await this.eval(`(() => ({
        hasFunction: typeof window.sagawaSmartAPI === 'function',
        smartAPIData: document.querySelector('#smartAPIData')?.value || '',
        allCheck: !!document.getElementById('seachselect2')?.checked,
        orderBySql: new URL(location.href).searchParams.get('order') || '',
        checked: Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value),
      }))()`);
      if (canInvokeSagawaSmartApi.hasFunction && (canInvokeSagawaSmartApi.smartAPIData || canInvokeSagawaSmartApi.checked.length)) {
        target.sagawaSmartApiFallback = {
          reason: 'DOM click produced no shipping-label dialog; invoking page-defined sagawaSmartAPI directly',
          allCheck: canInvokeSagawaSmartApi.allCheck,
          orderBySql: canInvokeSagawaSmartApi.orderBySql,
          smartAPIDataCount: canInvokeSagawaSmartApi.smartAPIData ? canInvokeSagawaSmartApi.smartAPIData.split(',').filter(Boolean).length : 0,
          checked: canInvokeSagawaSmartApi.checked,
        };
        step('invoking Sagawa Smart API fallback', target.sagawaSmartApiFallback);
        this.dialogContext = 'shipping-label-generation';
        try {
          await this.eval(`window.sagawaSmartAPI(${JSON.stringify(canInvokeSagawaSmartApi.orderBySql)})`);
          await wait(3000);
        } finally {
          this.dialogContext = '';
        }
        target.javascriptDialogs = (run.javascriptDialogs || []).slice(previousDialogCount);
      }
    }
    if (config.labelButton === '#B2CloudGeneratePdfApi' && target.javascriptDialogs.length === 0) {
      const b2CloudRequestMonitor = await this.readB2CloudRequestMonitor();
      target.b2CloudRequestMonitor = b2CloudRequestMonitor;
      if (!b2CloudRequestMonitor.calls.length) {
        const canInvokeB2CloudApi = await this.eval(`(() => ({
          hasFunction: typeof window.b2CloudDeliveryInvoiceExportRequest === 'function',
          hasSendFunction: typeof window.sendDeliveryInvoiceExportRequest === 'function',
          buttonDisabled: !!document.querySelector('#B2CloudGeneratePdfApi')?.disabled,
          printStartLocation: document.querySelector('#b2_cloud_api_printStartLocation')?.value || document.querySelector('#printStartLocation')?.value || '',
          allCheck: !!document.getElementById('seachselect2')?.checked,
          smartAPIData: document.querySelector('#smartAPIData')?.value || '',
          orderBySql: new URL(location.href).searchParams.get('order') || '',
          checked: Array.from(document.getElementsByName('order_number[]')).filter(b => b.checked).map(b => b.value),
        }))()`);
        if (canInvokeB2CloudApi.hasFunction && (canInvokeB2CloudApi.smartAPIData || canInvokeB2CloudApi.checked.length)) {
          target.b2CloudApiFallback = {
            reason: 'DOM click produced no B2 Cloud request; invoking page-defined b2CloudDeliveryInvoiceExportRequest directly',
            allCheck: canInvokeB2CloudApi.allCheck,
            orderBySql: canInvokeB2CloudApi.orderBySql,
            smartAPIDataCount: canInvokeB2CloudApi.smartAPIData ? canInvokeB2CloudApi.smartAPIData.split(',').filter(Boolean).length : 0,
            checked: canInvokeB2CloudApi.checked,
            printStartLocation: canInvokeB2CloudApi.printStartLocation,
          };
          step('invoking B2 Cloud API fallback', target.b2CloudApiFallback);
          this.dialogContext = 'shipping-label-generation';
          try {
            await this.eval(`window.b2CloudDeliveryInvoiceExportRequest('B2CloudGeneratePdfApi', 'b2_cloud_api_printStartLocation', 'ヤマト運輸', ${JSON.stringify(canInvokeB2CloudApi.orderBySql)})`);
            await wait(3000);
          } finally {
            this.dialogContext = '';
          }
          target.b2CloudRequestMonitorAfterFallback = await this.readB2CloudRequestMonitor();
          target.javascriptDialogs = (run.javascriptDialogs || []).slice(previousDialogCount);
        }
      }
    }
    target.domDialogs = await this.eval(`(() => {
        const visible = el => {
          if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        return Array.from(document.querySelectorAll('[role="dialog"], .modal, .ui-dialog, .swal2-popup, [class*="modal"], [id*="modal"]'))
          .filter(visible)
          .map((el, index) => ({
            index,
            text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1200),
            buttons: Array.from(el.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
              .map(button => (button.innerText || button.textContent || button.value || '').replace(/\\s+/g, ' ').trim())
              .filter(Boolean)
          }))
          .filter(item => item.text || item.buttons.length);
      })()`);
    const domDialogActions = await this.handleShippingLabelDomDialogs();
    if (domDialogActions.length) target.domDialogActions = domDialogActions;
    const dialogMessages = [
      ...target.javascriptDialogs.map(dialog => dialog.message || ''),
      ...target.domDialogs.map(dialog => dialog.text || ''),
    ].filter(Boolean);
    const allDialogsAreSuccessNotices = dialogMessages.length > 0 && dialogMessages.every(message => {
      const text = String(message || '');
      return /完了しました|完了|受け付けました|受付|リクエスト/.test(text)
        && !/エラー|警告|住所|不備|失敗|できません|できませんでした|未入力|対象外|除外|修正/.test(text);
    });
    const allDialogsAreNonBlocking = dialogMessages.length > 0
      && dialogMessages.every(message => classifyShippingLabelDialog(message).nonBlocking);
    if (allDialogsAreNonBlocking) {
      if (run.blockingLabelDialog && target.javascriptDialogs.some(dialog => dialog.at === run.blockingLabelDialog.at && dialog.message === run.blockingLabelDialog.message)) {
        delete run.blockingLabelDialog;
      }
      step('handled non-blocking shipping label generation notice', {
        javascriptDialogs: target.javascriptDialogs,
        domDialogs: target.domDialogs,
        domDialogActions,
      });
    }
    if (!inspectLabelDialog && !allDialogsAreNonBlocking && (target.javascriptDialogs.length || target.domDialogs.length)) {
      run.blockers = run.blockers || [];
      run.blockers.push({
        reason: 'shipping label generation opened a dialog/modal; content must be reviewed before continuing',
        javascriptDialogs: target.javascriptDialogs,
        domDialogs: target.domDialogs,
      });
      throw new Error(`Shipping label generation opened a dialog/modal; stopped for review: ${JSON.stringify({ javascriptDialogs: target.javascriptDialogs, domDialogs: target.domDialogs })}`);
    }
    return target;
  }

  async installB2CloudRequestMonitor() {
    return this.eval(`(() => {
      window.__goqB2CloudRequestMonitor = { calls: [], installedAt: new Date().toISOString() };
      if (!window.axios || typeof window.axios.post !== 'function') return { installed: false, reason: 'axios.post unavailable' };
      if (!window.__goqOriginalAxiosPost) {
        window.__goqOriginalAxiosPost = window.axios.post.bind(window.axios);
      }
      window.axios.post = async (...args) => {
        const [url, data] = args;
        if (/B2CloudDeliveryInvoice|RequestB2CloudDeliveryInvoice|b2cloud/i.test(String(url || ''))) {
          window.__goqB2CloudRequestMonitor.calls.push({
            at: new Date().toISOString(),
            url: String(url || ''),
            orderIds: Array.isArray(data?.orderIds) ? data.orderIds.slice() : [],
            printStartLocation: data?.printStartLocation || '',
            orderBySql: data?.orderBySql || '',
          });
        }
        return window.__goqOriginalAxiosPost(...args);
      };
      return { installed: true };
    })()`);
  }

  async readB2CloudRequestMonitor() {
    return this.eval(`(() => {
      const monitor = window.__goqB2CloudRequestMonitor || { calls: [] };
      return {
        installedAt: monitor.installedAt || '',
        calls: Array.isArray(monitor.calls) ? monitor.calls.slice() : [],
      };
    })()`);
  }

  async handleShippingLabelDomDialogs() {
    return this.eval(`(() => {
      const visible = el => {
        if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const hasError = text => /エラー|警告|不正|失敗|できません|出来ません|対象外|除外|修正|未入力|error|failed/i.test(text);
      const isSuccess = text => /成功しました|完了しました|受け付けました|受付|リクエスト.*完了/.test(text) && !hasError(text);
      const isConfirmation = text => /送り状|伝票|発行|出力|印刷|実行|よろしいですか|しますか/.test(text) && !hasError(text);
      const positive = text => /^(OK|Ok|ok|はい|発行|出力|実行|確認|上記について確認しました|登録|送信)/.test(text)
        || /発行する|出力する|実行する|確認しました/.test(text);
      const negative = text => /キャンセル|取消|いいえ|閉じる|辞退|中止/.test(text);
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .ui-dialog, .swal2-popup, [class*="modal"], [id*="modal"]'))
        .filter(visible);
      const actions = [];
      for (const dialog of dialogs) {
        const text = (dialog.innerText || dialog.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!text) continue;
        const kind = hasError(text) ? 'error' : isSuccess(text) ? 'success' : isConfirmation(text) ? 'confirmation' : 'unknown';
        if (kind !== 'success' && kind !== 'confirmation') {
          actions.push({ kind, text: text.slice(0, 500), clicked: false });
          continue;
        }
        const buttons = Array.from(dialog.querySelectorAll('button, input[type="button"], input[type="submit"], a'));
        const button = buttons.find(el => {
          const label = (el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim();
          return label && positive(label) && !negative(label);
        }) || buttons.find(el => {
          const label = (el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim();
          return kind === 'success' && /^閉じる$|^OK$|確認/.test(label) && !negative(label);
        });
        if (button) {
          const label = (button.innerText || button.textContent || button.value || '').replace(/\\s+/g, ' ').trim();
          button.click();
          actions.push({ kind, text: text.slice(0, 500), clicked: true, button: label });
        } else {
          actions.push({ kind, text: text.slice(0, 500), clicked: false, reason: 'positive button not found' });
        }
      }
      return actions;
    })()`);
  }

  async downloadLatestLabelPdf({ requestedAt, config }) {
    let lastCard;
    for (let attempt = 1; attempt <= downloadRefreshAttempts; attempt++) {
      let card = await this.findDownloadCard(requestedAt, config);
      if (!card?.ok && !card?.failed) {
        card = await this.findDownloadCardByScrolling(requestedAt, config, card);
      }
      if (card?.failed) {
        const report = card.errorReportHref ? await this.fetchText(card.errorReportHref) : null;
        step('shipping label generation failed', {
          attempt,
          timeText: card.timeText,
          text: card.text,
          errorReportHref: card.errorReportHref,
          errorReport: report?.text || '',
        });
        throw new Error(`Shipping label generation failed: ${report?.text || card.text || card.error || 'error report unavailable'}`);
      }
      if (card?.ok) {
        lastCard = card;
        step('found shipping label download card', { attempt, timeText: card.timeText, text: card.text });
        break;
      }
      lastCard = card;
        step('shipping label download card not found yet', {
          attempt,
          attempts: downloadRefreshAttempts,
          waitMs: 2000,
          visibleCards: card?.cards || [],
        });
      await wait(2000);
      await this.send('Page.reload', { ignoreCache: true });
      await wait(800);
    }
    const target = lastCard?.ok ? lastCard : await this.findDownloadCardByScrolling(requestedAt, config, await this.findDownloadCard(requestedAt, config));
    if (!target.ok) throw new Error(target.error || 'label download card not found');
    const url = target.href || target.signature;
    if (/smart-api-shipping\.sagawa-exp\.co\.jp\/api\/resource|\/api\/resource\/|\.pdf(?:$|[?#])/i.test(url)) {
      step('using shipping label resource directly in chrome', { url, label: target.linkText || target.timeText || '' });
      return {
        directResource: true,
        fullName: '',
        size: 0,
        type: '',
        disposition: '',
        url,
        label: target.linkText || target.timeText || '',
      };
    }
    return downloadPdfFromUrl(url, {
      label: target.linkText || target.timeText || `label-${Date.now()}`,
      prefix: `${args.status}-label`,
    });
  }

  async fetchText(url) {
    if (!/invoice_error_report|error_report|\\.txt(?:$|[?#])/i.test(url)) {
      throw new Error(`Refusing to fetch non-error-report URL as text: ${url}`);
    }
    return this.eval(`(async () => {
      const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      return {
        ok: response.ok,
        status: response.status,
        type: response.headers.get('content-type') || '',
        text: await response.text()
      };
    })()`);
  }

  async findDownloadCardByScrolling(requestedAt, config, initialCard = null) {
    let lastCard = initialCard;
    const metrics = await this.eval(`(() => ({
      scrollHeight: Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0),
      innerHeight: window.innerHeight || document.documentElement.clientHeight || 800,
      initialY: window.scrollY || 0,
    }))()`);
    const maxY = Math.max(0, metrics.scrollHeight - metrics.innerHeight);
    const step = Math.max(500, Math.floor(metrics.innerHeight * 0.75));
    const positions = [];
    for (let y = 0; y <= maxY; y += step) positions.push(y);
    if (!positions.includes(maxY)) positions.push(maxY);
    for (const y of positions) {
      await this.eval(`window.scrollTo(0, ${JSON.stringify(y)})`);
      await wait(250);
      const card = await this.findDownloadCard(requestedAt, config);
      if (card?.ok || card?.failed) {
        return { ...card, scrollSearch: { y, maxY, positions: positions.length } };
      }
      lastCard = card || lastCard;
    }
    await this.eval(`window.scrollTo(0, ${JSON.stringify(metrics.initialY || 0)})`).catch(() => {});
    return {
      ...(lastCard || { ok: false, error: 'label card not found while scrolling' }),
      scrollSearch: { searched: true, maxY, positions: positions.length },
    };
  }

  async findDownloadCard(requestedAt, config) {
    return this.eval(`(() => {
      const requested = ${requestedAt.getTime()};
      const earliest = requested - 10000;
      const expectedPrinter = ${JSON.stringify(config.labelPrinter)};
      const exactErrorCards = Array.from(document.querySelectorAll('a'))
        .filter(link => /invoice_error_report|error_report/i.test(link.href || '') || /エラーレポート|エラー.?レポート/i.test((link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim()))
        .map((link, index) => {
          const href = link.href || '';
          const linkText = (link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim();
          let el = link.closest('.js-exportPdfListItem, .information__item-export-pdf, table tr, .card');
          if (!el) {
            const details = link.closest('.information__details-export-pdf');
            el = details?.closest('.js-exportPdfListItem, .information__item-export-pdf') || details || null;
          }
          if (!el) return { index, text: linkText, timeText: '', at: 0, href, linkText, diff: Infinity };
          while (el && !/\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}/.test(el.innerText || '') && el.parentElement && el.parentElement !== document.body) {
            el = el.parentElement;
          }
          const text = (el?.innerText || linkText).replace(/\\s+/g, ' ').trim();
          const timeText = (text.match(/\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}/) || [])[0] || '';
          const at = timeText ? new Date(timeText.replace(' ', 'T') + '+09:00').getTime() : 0;
          return { index, text, timeText, at, href, linkText, diff: Math.abs(at - requested) };
        })
        .filter(card => card.timeText && card.diff <= 5 * 60 * 1000 && card.at >= earliest)
        .sort((a, b) => a.diff - b.diff);
      if (exactErrorCards[0]) {
        const card = exactErrorCards[0];
        return {
          ok: false,
          failed: true,
          expectedPrinter,
          text: card.text.slice(0, 300),
          timeText: card.timeText,
          errorReportHref: card.href || '',
          linkText: card.linkText || '',
        };
      }
      const anchorCards = Array.from(document.querySelectorAll('a')).map((link, index) => {
        const rawHref = link.href || '';
        const onclick = link.getAttribute('onclick') || '';
        const onclickUrl = (onclick.match(/downloadFromUrl\\(["']([^"']+)["']/) || [])[1] || '';
        const href = rawHref || onclickUrl;
        const linkText = (link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim();
        let el = link.closest('.js-exportPdfListItem, .information__item-export-pdf, table tr, .card');
        if (!el) {
          const details = link.closest('.information__details-export-pdf');
          el = details?.closest('.js-exportPdfListItem, .information__item-export-pdf') || details || null;
        }
        if (!el) return { index, text: linkText, timeText: '', at: 0, href, linkText };
        while (el && !/\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}/.test(el.innerText || '') && el.parentElement && el.parentElement !== document.body) {
          el = el.parentElement;
        }
        const text = (el?.innerText || linkText).replace(/\\s+/g, ' ').trim();
        const timeText = (text.match(/\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}/) || [])[0] || '';
        const at = timeText ? new Date(timeText.replace(' ', 'T') + '+09:00').getTime() : 0;
        return { index, text, timeText, at, href, rawHref, onclick, linkText };
      }).filter(card => card.timeText)
        .filter(card => /smart-api-shipping\\.sagawa-exp\\.co\\.jp\\/api\\/resource|api\\/resource|download|\\.pdf|佐川_|ヤマト_|B2|送り状|伝票|エラーレポート|エラー|失敗|error/i.test(card.href + ' ' + card.linkText + ' ' + card.text));
      const broadErrorCards = anchorCards
        .filter(card => /エラーレポート|エラー|失敗|error/i.test(card.href + ' ' + card.linkText + ' ' + card.text))
        .map(card => ({ ...card, diff: Math.abs(card.at - requested) }))
        .filter(card => card.diff <= 5 * 60 * 1000 && card.at >= earliest)
        .sort((a, b) => a.diff - b.diff);
      if (false && broadErrorCards[0]) {
        const card = broadErrorCards[0];
        return {
          ok: false,
          failed: true,
          expectedPrinter,
          text: card.text.slice(0, 300),
          timeText: card.timeText,
          errorReportHref: card.href || '',
          linkText: card.linkText || '',
        };
      }
      const resourceAnchorCards = anchorCards.filter(card => /smart-api-shipping\\.sagawa-exp\\.co\\.jp\\/api\\/resource|storage\\.goqsystem\\.net\\/.*\\.pdf|\\/api\\/resource\\/|\\.pdf(?:$|[?#])/i.test(card.href));
      const anchorCandidates = resourceAnchorCards
        .filter(card => !/error|失敗|エラー/.test(card.text))
        .map(card => ({ ...card, diff: Math.abs(card.at - requested) }))
        .filter(card => card.diff <= 5 * 60 * 1000 && card.at >= earliest)
        .sort((a, b) => a.diff - b.diff);
      if (anchorCandidates[0]) {
        const card = anchorCandidates[0];
        return { ok: true, expectedPrinter, text: card.text.slice(0, 300), timeText: card.timeText, signature: card.href || card.linkText || card.timeText, href: card.href || '', linkText: card.linkText || '' };
      }
      if (resourceAnchorCards.length) {
        return { ok: false, error: 'matching label resource link not found near requested time', cards: resourceAnchorCards.slice(0, 20).map(c => ({ text: c.text.slice(0, 160), timeText: c.timeText, href: c.href, linkText: c.linkText })) };
      }
      return { ok: false, error: 'label resource link not found', cards: [] };
      const cards = Array.from(document.querySelectorAll('table tr, .card, div')).map((el, index) => {
        const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        const timeText = (text.match(/\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}/) || [])[0] || '';
        const at = timeText ? new Date(timeText.replace(' ', 'T') + '+09:00').getTime() : 0;
        const link = Array.from(el.querySelectorAll('a')).find(a => /download|\\.pdf|出力|送り状|ダウンロード/i.test((a.href || '') + ' ' + (a.innerText || '')));
        return { index, text, timeText, at, link };
      }).filter(card => card.link && card.timeText);
      const candidates = cards
        .filter(card => !/失敗|エラー|error/i.test(card.text))
        .filter(card => /送り状|伝票|B2|佐川|ヤマト|発行/.test(card.text))
        .map(card => ({ ...card, diff: Math.abs(card.at - requested) }))
        .filter(card => card.diff <= 5 * 60 * 1000 && card.at >= earliest)
        .sort((a, b) => a.diff - b.diff);
      const card = candidates[0];
      if (!card) return { ok: false, error: 'matching card not found', cards: cards.slice(0, 20).map(c => ({ text: c.text.slice(0, 160), timeText: c.timeText })) };
      const signature = card.link.href || card.link.innerText || card.timeText;
      return { ok: true, expectedPrinter, text: card.text.slice(0, 300), timeText: card.timeText, signature, href: card.link.href || '', linkText: (card.link.innerText || card.link.textContent || '').trim() };
    })()`);
  }

  async printPdf(printer, options = {}) {
    await waitUntil(async () => this.eval(`Boolean(document.querySelector('pdf-viewer'))`), 30000);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await closePrintPreviews(this.port);
      await this.eval(`(() => {
        document.querySelector('pdf-viewer')
          .shadowRoot
          .querySelector('viewer-toolbar#toolbar, viewer-toolbar, #toolbar')
          .shadowRoot
          .querySelector('cr-icon-button#print, #print')
          .click();
        return true;
      })()`);
      await wait(2500);
      try {
        return await configureAndPressPrintPreview(this.port, { printer, color: 'bw', duplex: false, ...options });
      } catch (error) {
        if (attempt === 2 || !/print preview remained open/i.test(String(error?.message || error)) || options.press === false) throw error;
        step('retrying pdf print after stale preview', { reason: String(error?.message || error) });
      }
    }
  }
}

async function configureAndPressPrintPreview(port, { printer, color, duplex, press = true, closeWithoutPrinting = false }) {
  const preview = await waitForPrintPreview(port);
  await preview.enable();
  await waitUntil(async () => preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app?.shadowRoot?.querySelector('print-preview-sidebar')?.shadowRoot;
    const destSelect = side?.querySelector('print-preview-destination-settings')?.shadowRoot
      ?.querySelector('print-preview-destination-select')?.shadowRoot?.querySelector('select');
    const colorSelect = side?.querySelector('print-preview-color-settings')?.shadowRoot?.querySelector('select');
    const button = side?.querySelector('print-preview-button-strip')?.shadowRoot?.querySelector('cr-button.action-button');
    return Boolean(destSelect && colorSelect && button);
  })()`), 30000, 500);
  const selected = await preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
    const destSettings = side.querySelector('print-preview-destination-settings');
    const select = destSettings.shadowRoot
      .querySelector('print-preview-destination-select')
      .shadowRoot.querySelector('select');
    const options = Array.from(select.options).map(option => ({ value: option.value, text: option.textContent.trim() }));
    const direct = options.find(option => option.text.includes(${JSON.stringify(printer)}));
    if (direct) {
      select.value = direct.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, method: 'select', value: direct.value, printers: options.map(option => option.text) };
    }
    select.value = 'seeMore';
    select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true, method: 'dialog', printers: options.map(option => option.text) };
  })()`);
  if (!selected.ok) throw new Error(`${selected.error}: ${JSON.stringify(selected.printers)}`);
  if (selected.method === 'dialog') {
    await wait(1000);
    const dialogSelected = await preview.eval(`(() => {
      const app = document.querySelector('print-preview-app');
      const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
      const destSettings = side.querySelector('print-preview-destination-settings');
      const dialog = destSettings.shadowRoot.querySelector('print-preview-destination-dialog');
      const items = Array.from(dialog?.shadowRoot?.querySelectorAll('print-preview-destination-list-item') || []);
      const item = items.find(i => (i.shadowRoot?.innerText || i.innerText || '').includes(${JSON.stringify(printer)}));
      if (item) {
        item.click();
        return { ok: true, method: 'dialog-item' };
      }
      const store = destSettings.destinationStore_;
      const key = store?.destinationMap_ ? Array.from(store.destinationMap_.keys()).find(k => k.includes(${JSON.stringify(printer)})) : null;
      if (!key) return {
        ok: false,
        error: 'printer not found',
        printers: [
          ...items.map(i => i.shadowRoot?.innerText || i.innerText || ''),
          ...(store?.destinationMap_ ? Array.from(store.destinationMap_.keys()) : [])
        ]
      };
      const destination = store.destinationMap_.get(key);
      if (typeof store.selectDestination === 'function') store.selectDestination(destination);
      else if (typeof store.selectDestinationByKey === 'function') store.selectDestinationByKey(key);
      else return { ok: false, error: 'destination store has no select method', printers: Array.from(store.destinationMap_.keys()) };
      return { ok: true, method: 'destination-store', key };
    })()`);
    if (!dialogSelected.ok) throw new Error(`${dialogSelected.error}: ${JSON.stringify(dialogSelected.printers)}`);
    await preview.eval(`(() => {
      const app = document.querySelector('print-preview-app');
      const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
      const destSettings = side.querySelector('print-preview-destination-settings');
      if (!destSettings.isDialogOpen_) return true;
      if (!String(destSettings.destination?.displayName || '').includes(${JSON.stringify(printer)})) return false;
      const dialog = destSettings.shadowRoot.querySelector('print-preview-destination-dialog');
      const cancel = Array.from(dialog?.shadowRoot?.querySelectorAll('cr-button, button') || [])
        .find(button => /キャンセル|Cancel/i.test(button.innerText || button.textContent || ''));
      if (cancel) cancel.click();
      return true;
    })()`);
  }
  await wait(1500);
  const verified = await preview.eval(`(() => {
    const app = document.querySelector('print-preview-app');
    const side = app.shadowRoot.querySelector('print-preview-sidebar').shadowRoot;
    const destinationSettings = side.querySelector('print-preview-destination-settings');
    const destinationSelect = destinationSettings.shadowRoot
      .querySelector('print-preview-destination-select')
      .shadowRoot.querySelector('select');
    const selectedDestination = destinationSettings.destinationStore_?.selectedDestination_?.displayName || '';
    const activeDestination = destinationSettings.destination?.displayName || '';
    const selectDestination = destinationSelect.options[destinationSelect.selectedIndex]?.textContent.trim() || '';
    const destination = activeDestination || selectedDestination || selectDestination || destinationSettings.shadowRoot.innerText || '';
    const colorSettings = side.querySelector('print-preview-color-settings');
    const colorSelect = colorSettings?.shadowRoot.querySelector('select');
    if (colorSelect) {
      colorSelect.value = ${JSON.stringify(color)};
      colorSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const more = side.querySelector('print-preview-more-settings');
    const moreSettings = side.querySelector('cr-collapse#moreSettings');
    if (more && moreSettings?.classList.contains('collapse-closed')) more.shadowRoot.querySelector('cr-expand-button')?.click();
    const duplexBox = side.querySelector('print-preview-duplex-settings')?.shadowRoot.querySelector('cr-checkbox#duplex');
    if (duplexBox && duplexBox.checked !== ${JSON.stringify(duplex)}) duplexBox.click();
    const pages = app.shadowRoot.querySelector('print-preview-preview-area')?.shadowRoot.innerText || '';
    const actionButton = side.querySelector('print-preview-button-strip')?.shadowRoot.querySelector('cr-button.action-button');
    return {
      destination,
      activeDestination,
      selectedDestination,
      selectDestination,
      color: colorSelect?.value || '',
      duplex: duplexBox ? duplexBox.checked : false,
      pages,
      printEnabled: actionButton?.getAttribute('aria-disabled') !== 'true'
    };
  })()`);
  if (!normalizeText(verified.destination).includes(normalizeText(printer))) throw new Error(`Print destination mismatch: ${verified.destination}`);
  if (verified.color && verified.color !== color) throw new Error(`Print color mismatch: ${verified.color}`);
  if (verified.duplex !== duplex) throw new Error(`Print duplex mismatch: ${verified.duplex}`);
  const shot = await preview.send('Page.captureScreenshot', { format: 'png' });
  const screenshotDir = path.join('.o11y', 'goq-unified-print-flow', 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `print-preview-${Date.now()}.png`);
  fs.writeFileSync(screenshotPath, Buffer.from(shot.result.data, 'base64'));
  if (run?.steps) {
    step('captured print preview', {
      file: screenshotPath,
      expectedPrinter: printer,
      destination: verified.destination,
      color: verified.color,
      duplex: verified.duplex,
      pages: verified.pages,
    });
  }
  if (press) {
    await preview.eval(`(() => {
      document.querySelector('print-preview-app')
        .shadowRoot.querySelector('print-preview-sidebar')
        .shadowRoot.querySelector('print-preview-button-strip')
        .shadowRoot.querySelector('cr-button.action-button')
        .click();
      return true;
    })()`);
    await wait(2000);
    const closed = await waitUntil(async () => {
      const targets = await listTargets(port);
      return !targets.some(t => t.type === 'page' && t.url.startsWith('chrome://print/'));
    }, 5000, 500).then(() => true).catch(() => false);
    if (!closed) {
      await cancelPrintPreview(preview).catch(() => {});
      await closePrintPreviews(port);
      throw new Error('print preview remained open after pressing print');
    }
  } else if (closeWithoutPrinting) {
    await cancelPrintPreview(preview);
    await wait(1000);
  }
  return { ...verified, screenshotPath };
}

async function cancelPrintPreview(preview) {
  return preview.eval(`(() => {
    const sidebar = document.querySelector('print-preview-app')
      ?.shadowRoot?.querySelector('print-preview-sidebar')
      ?.shadowRoot;
    const strip = sidebar?.querySelector('print-preview-button-strip')?.shadowRoot;
    const cancel = strip?.querySelector('cr-button.cancel-button') || Array.from(strip?.querySelectorAll('cr-button, button') || []).find(button => /キャンセル|Cancel/i.test(button.innerText || button.textContent || ''));
    if (!cancel) return false;
    cancel.click();
    return true;
  })()`);
}

async function closePrintPreviews(port) {
  const targets = await listTargets(port).catch(() => []);
  for (const target of targets.filter(t => t.type === 'page' && t.url.startsWith('chrome://print/'))) {
    await fetch(cdpHttpUrl(port, `/json/close/${target.id}`)).catch(() => null);
  }
  await wait(500);
}

async function waitForPrintPreview(port) {
  const target = await waitUntil(async () => {
    const targets = await listTargets(port);
    return targets.find(t => t.type === 'page' && t.url.startsWith('chrome://print/'));
  }, 30000, 1000);
  return new CdpPage(target.webSocketDebuggerUrl, port);
}

function listDownloadFiles() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return new Map();
  return new Map(fs.readdirSync(DOWNLOADS_DIR).map(name => {
    const fullName = path.join(DOWNLOADS_DIR, name);
    const stat = fs.statSync(fullName);
    return [fullName, { name, fullName, mtimeMs: stat.mtimeMs, size: stat.size }];
  }));
}

async function waitForNewFile(before, predicate, timeoutMs) {
  return waitUntil(async () => {
    const current = listDownloadFiles();
    const files = [...current.values()]
      .filter(file => !before.has(file.fullName) || file.mtimeMs > before.get(file.fullName).mtimeMs || file.size !== before.get(file.fullName).size)
      .filter(predicate)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0] || false;
  }, timeoutMs, 1000);
}

async function waitUntil(fn, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await wait(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fileUrl(filePath) {
  return fileUrlForBrowser(filePath);
}

await main();
