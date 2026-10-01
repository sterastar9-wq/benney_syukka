#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { PICKING_PRINTER, LABEL_PRINTER_BY_STATUS } from './lib/printers.mjs';

const RUN_DIR = path.join('.o11y', 'goq-unified-print-flow', 'runs');
// 元版のGoQ全データ（データ管理②）。ベニー様版のピッキングがこれを読んでいたら違反にする
const ORIGINAL_GOQ_MASTER_SHEET_ID = '1V_y-3QNZ0DLLdAG9NSgdn4S-934hhRUcQgNVc7Pxc4I';
// ベニー様版ヤマト系: GoQ から B2クラウド用CSVを出力し、ヤマトビジネスメンバーズで印刷する
const LABEL_MODE_B2_CSV = 'b2-csv';

const args = parseArgs(process.argv.slice(2));
const file = args.latest ? latestRunFile() : args.file;
if (!file) {
  console.error('Usage: node tools/goq-run-review.mjs --latest OR --file <run.json>');
  process.exit(2);
}

const run = JSON.parse(fs.readFileSync(file, 'utf8'));
const review = reviewRun(run, file);
console.log(JSON.stringify(review, null, 2));
if (!review.ok) process.exit(1);

function reviewRun(run, file) {
  const violations = [];
  const warnings = [];
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const stepNames = steps.map(step => step.name);
  const hasStep = needle => stepNames.some(name => name.includes(needle));
  const firstIndex = needle => stepNames.findIndex(name => name.includes(needle));
  const printedPicking = hasStep('printed picking list') || hasStep('verified picking print preview without pressing print') || hasStep('reused previous picking list print for resume');
  const requestedLabel = hasStep('requested shipping label generation');
  const downloadedLabel = hasStep('downloaded shipping label pdf') || hasStep('downloaded existing shipping label pdf');
  const downloadedExistingLabel = hasStep('downloaded existing shipping label pdf');
  const printedLabel = hasStep('printed shipping label') || hasStep('stopped before shipping label print button') || hasStep('printed existing shipping label');
  const exportedLabelCsv = hasStep('exported shipping label csv');

  for (const issue of collectGoalIssues(run, { printedPicking, requestedLabel, downloadedLabel, printedLabel, exportedLabelCsv, hasStep })) {
    violations.push(issue);
  }
  if (exportedLabelCsv && !hasStep('recorded shipping-label target snapshot')) {
    violations.push({ code: 'LABEL_TARGET_SNAPSHOT_MISSING', message: 'B2 Cloud CSV export occurred without recording the exact target snapshot.' });
  }
  if (exportedLabelCsv && !printedPicking && run.args?.['skip-picking'] !== true && !run.error) {
    violations.push({ code: 'LABEL_BEFORE_PICKING', message: 'B2 Cloud CSV export occurred without a picking-list output step in the same run.' });
  }
  // ベニー様版: B2用CSVの出力は読み取りなので点検のためピッキングより前でよい。引き継ぎ（取込み・発行へ渡す）はピッキングの後
  if (hasStep('wrote b2 cloud handoff') && printedPicking && firstIndex('wrote b2 cloud handoff') < firstIndex('picking list') && run.args?.['label-first'] !== true) {
    violations.push({ code: 'ORDERING_VIOLATION', message: 'B2 Cloud handoff (label import) was written before picking-list output.' });
  }
  if (exportedLabelCsv && !hasStep('verified shipping label csv against target snapshot')) {
    violations.push({ code: 'LABEL_CSV_NOT_VERIFIED', message: 'B2 Cloud CSV was exported without verification against the target snapshot.' });
  }
  if (run.labelIssuanceVerification?.mode === LABEL_MODE_B2_CSV && run.labelIssuanceVerification.unmatchedRows?.length) {
    violations.push({ code: 'LABEL_CSV_EXTRA_ROWS', message: 'The exported B2 Cloud CSV contains rows that are not in the target snapshot.', rows: run.labelIssuanceVerification.unmatchedRows });
  }

  if (!run.ruleMaterial || run.ruleMaterial.ok !== true) {
    violations.push({
      code: 'RULE_MATERIAL_NOT_LOADED',
      message: 'Required rule material was not loaded and recorded at run startup.',
      detail: run.ruleMaterial || null,
    });
  }

  const unreviewedWarnings = collectUnreviewedAddressWarnings(run);
  if (unreviewedWarnings.length && (printedPicking || requestedLabel || printedLabel || exportedLabelCsv)) {
    violations.push({
      code: 'ADDRESS_WARNING_REVIEW_BYPASS',
      message: 'Output flow continued while address warnings were not reviewed/fixed.',
      rows: unreviewedWarnings,
    });
  }

  const excludedWarnings = collectManualExcludedAddressWarnings(run);
  if (excludedWarnings.length && (printedPicking || requestedLabel || printedLabel || exportedLabelCsv)) {
    violations.push({
      code: 'ADDRESS_WARNING_MANUAL_EXCLUDE_BYPASS',
      message: 'Address-warning rows were manually excluded without being marked fixed.',
      rows: excludedWarnings,
    });
  }

  const unvalidatedFixedWarnings = collectUnvalidatedFixedAddressWarnings(run);
  if (unvalidatedFixedWarnings.length && (printedPicking || requestedLabel || printedLabel || exportedLabelCsv)) {
    violations.push({
      code: 'ADDRESS_WARNING_UNVALIDATED_FIXED',
      message: 'Address-warning rows were treated as fixed even though no safe change or external validation was recorded.',
      rows: unvalidatedFixedWarnings,
    });
  }

  const unresolvedWithoutMemo = collectUnresolvedAddressWarningsWithoutMemo(run);
  if (unresolvedWithoutMemo.length && (printedPicking || requestedLabel || printedLabel || exportedLabelCsv)) {
    violations.push({
      code: 'ADDRESS_UNRESOLVED_MEMO_MISSING',
      message: 'Unresolved address-warning rows were excluded without a recorded one-line memo marker.',
      rows: unresolvedWithoutMemo,
    });
  }

  if (requestedLabel && !printedPicking && run.args?.['skip-picking'] !== true && run.args?.['print-existing-label-at'] !== true && !run.error) {
    violations.push({
      code: 'LABEL_BEFORE_PICKING',
      message: 'Shipping-label generation occurred without a picking-list output step in the same run.',
    });
  }

  if (requestedLabel && printedPicking && firstIndex('requested shipping label generation') < firstIndex('picking') && run.args?.['label-first'] !== true) {
    violations.push({
      code: 'ORDERING_VIOLATION',
      message: 'Shipping-label generation occurred before picking-list output.',
    });
  }

  if (requestedLabel && !hasStep('recorded shipping-label target snapshot')) {
    violations.push({
      code: 'LABEL_TARGET_SNAPSHOT_MISSING',
      message: 'Shipping-label generation occurred without recording the exact target snapshot.',
    });
  }

  if (downloadedLabel && !downloadedExistingLabel && !hasStep('verified shipping-label issuance after generation')) {
    violations.push({
      code: 'LABEL_ISSUANCE_DIFFERENCE_CHECK_MISSING',
      message: 'Shipping-label PDF was downloaded without post-generation issuance verification.',
    });
  }
  if (hasLabelGenerationDialog(run, steps) && (downloadedLabel || printedLabel)) {
    violations.push({
      code: 'LABEL_DIALOG_BYPASS',
      message: 'Flow continued after a shipping-label generation dialog/modal instead of stopping for review.',
      detail: {
        blockingLabelDialog: run.blockingLabelDialog || null,
        requestedStep: steps.find(step => step.name === 'requested shipping label generation') || null,
      },
    });
  }

  if (printedLabel && !downloadedLabel) {
    violations.push({
      code: 'LABEL_PRINT_WITHOUT_DOWNLOAD_RECORD',
      message: 'Label print step exists without a matching downloaded label record.',
    });
  }

  for (const step of steps.filter(item => /printed picking list|verified picking print preview without pressing print|printed shipping label|printed existing shipping label|stopped before shipping label print button|stopped before existing shipping label print button/.test(item.name))) {
    if (!step.detail?.screenshot) {
      violations.push({
        code: 'MISSING_PRINT_PREVIEW_SCREENSHOT',
        message: `Printed output step lacks print-preview screenshot evidence: ${step.name}`,
        step,
      });
    }
  }

  for (const issue of collectPrinterDestinationIssues(run, steps)) {
    violations.push(issue);
  }

  const localPicking = collectLocalPickingIssues(steps);
  violations.push(...localPicking.violations);
  warnings.push(...localPicking.warnings);

  if (run.error && !violations.length) {
    warnings.push({ code: 'RUN_ERROR', message: 'Run ended with an error.', error: run.error });
  }
  if (run.args?.['label-first'] === true) {
    warnings.push({ code: 'LABEL_FIRST_EXCEPTION_USED', message: '`--label-first` was used; confirm this was explicitly requested.' });
  }
  const trulyUnissued = (run.labelIssuanceVerification?.unissued || [])
    .filter(row => !String(row.carrier || row.text || '').includes('[伝票入力済]') && !row.invoiceIssued && !row.tracking);
  if (trulyUnissued.length) {
    warnings.push({
      code: 'UNISSUED_LABEL_TARGETS',
      message: 'Some target rows did not have a tracking number or label-issued marker after generation.',
      rows: trulyUnissued,
    });
  }

  return {
    ok: violations.length === 0,
    file: path.resolve(file),
    goal: run.goal || null,
    goalStatus: violations.length === 0 && !warnings.length ? 'achieved' : violations.length ? 'failed' : 'warning',
    statusKey: run.statusKey,
    mode: run.mode,
    reviewedAt: new Date().toISOString(),
    violations,
    warnings,
  };
}

function collectGoalIssues(run, observed) {
  const issues = [];
  const goal = run.goal;
  if (!goal) {
    issues.push({
      code: 'GOAL_MISSING',
      message: 'Run log does not declare the goal before execution, so the reviewer cannot evaluate drift from the objective.',
    });
    return issues;
  }

  const requested = goal.requested || {};
  if (requested.statusKey && requested.statusKey !== run.statusKey) {
    issues.push({ code: 'GOAL_STATUS_MISMATCH', message: 'Run status does not match the declared goal status.', goalStatus: requested.statusKey, runStatus: run.statusKey });
  }
  if (requested.date && requested.date !== run.date) {
    issues.push({ code: 'GOAL_DATE_MISMATCH', message: 'Run date does not match the declared goal date.', goalDate: requested.date, runDate: run.date });
  }
  if (requested.mode && requested.mode !== run.mode) {
    issues.push({ code: 'GOAL_MODE_MISMATCH', message: 'Run mode does not match the declared goal mode.', goalMode: requested.mode, runMode: run.mode });
  }

  if (run.mode !== 'execute') return issues;

  const args = run.args || {};
  const outputMode = requested.outputMode || '';
  const skipPicking = args['skip-picking'] === true;
  const skipLabels = args['skip-labels'] === true;
  const skipPrint = args['skip-print'] === true;
  const previewOnlyPicking = args['preview-only-picking'] === true;
  const stopBeforeLabelPrint = args['stop-before-label-print'] === true || outputMode === 'stop-before-label-print';

  if (!skipPicking && !observed.printedPicking && !previewOnlyPicking) {
    issues.push({ code: 'GOAL_PICKING_OUTPUT_MISSING', message: 'Goal requires a picking-list output, but no picking print/preview step was recorded.' });
  }

  if (!skipLabels && (run.labelMode || requested.labelMode) === LABEL_MODE_B2_CSV) {
    if (!observed.exportedLabelCsv) {
      issues.push({ code: 'GOAL_LABEL_CSV_EXPORT_MISSING', message: 'Goal requires the B2 Cloud shipping-label CSV export, but no export step was recorded.' });
    }
    if (!run.labelIssuanceVerification?.ok) {
      issues.push({ code: 'GOAL_LABEL_CSV_NOT_VERIFIED', message: 'Goal requires the exported CSV to match the target snapshot, but verification is missing or failed.', detail: run.labelIssuanceVerification || null });
    }
    if (!observed.hasStep('wrote b2 cloud handoff') && !observed.hasStep('all b2 targets blocked by precheck')) {
      issues.push({ code: 'GOAL_B2_HANDOFF_MISSING', message: 'Goal requires a B2 Cloud handoff file for the Yamato Business Members step, but none was written.' });
    }
    if (observed.requestedLabel || observed.downloadedLabel) {
      issues.push({ code: 'GOQ_LABEL_API_USED_IN_B2_CSV_MODE', message: 'GoQ-side label generation was used although this status must export the B2 Cloud CSV instead.' });
    }
    return issues;
  }

  if (!skipLabels) {
    if (!observed.requestedLabel) {
      issues.push({ code: 'GOAL_LABEL_REQUEST_MISSING', message: 'Goal requires shipping-label generation, but no label request was recorded.' });
    }
    if (!observed.downloadedLabel) {
      issues.push({ code: 'GOAL_LABEL_DOWNLOAD_MISSING', message: 'Goal requires shipping-label PDF/resource evidence, but no label download/resource step was recorded.' });
    }
    if (!run.labelIssuanceVerification?.ok) {
      issues.push({ code: 'GOAL_LABEL_ISSUANCE_NOT_VERIFIED', message: 'Goal requires post-generation label issuance verification, but it is missing or failed.', detail: run.labelIssuanceVerification || null });
    }
    if (!skipPrint && !stopBeforeLabelPrint && !observed.printedLabel) {
      issues.push({ code: 'GOAL_LABEL_PRINT_MISSING', message: 'Goal requires shipping-label print output, but no label print step was recorded.' });
    }
  }

  return issues;
}

// ベニー様版: ピッキングリストは Smart Pick ではなく、ベニー様シートを読んでローカルで作ったPDFから印刷していること

function collectLocalPickingIssues(steps) {
  const violations = [];
  const warnings = [];
  steps.forEach((step, index) => {
    const name = String(step.name || '');
    if (name.includes('into Smart Pick')) {
      violations.push({ code: 'SMART_PICK_USED', message: 'ベニー様版で Smart Pick が使われました（元版のマスタを読むため使用禁止）。', step });
    }
    if (!/printed picking list|verified picking print preview without pressing print/.test(name)) return;
    const detail = step.detail || {};
    if (detail.source === 'goq-report') {
      // ベニー様の手順書どおり、GoQ の帳票「商品リスト（数量順）」（print_type 16）を印刷した場合
      const created = steps.slice(0, index).reverse().find(item => item.name === 'created goq product list report' && item.detail?.file === detail.pdf);
      if (!detail.pdf || !created) {
        violations.push({ code: 'GOQ_REPORT_NOT_RECORDED', message: '印刷したピッキングPDFの作成記録（created goq product list report）がありません。', step });
      } else if (String(created.detail.printType) !== '16') {
        violations.push({ code: 'GOQ_REPORT_WRONG_TYPE', message: `ピッキングリストの帳票種別が「商品リスト（数量順）」(16) ではありません: ${created.detail.printType}`, step });
      }
      return;
    }
    if (detail.source !== 'local-picking-pdf' || !detail.pdf) {
      violations.push({ code: 'PICKING_NOT_FROM_LOCAL_PDF', message: 'ピッキング印刷がローカルで作成したPDFからではありません。', step });
      return;
    }
    const generated = steps.slice(0, index).reverse().find(item => item.name === 'generated local picking pdf' && item.detail?.files?.pdf === detail.pdf);
    if (!generated) {
      violations.push({ code: 'LOCAL_PICKING_PDF_NOT_RECORDED', message: '印刷したピッキングPDFの作成記録（generated local picking pdf）がありません。', step });
      return;
    }
    const summary = generated.detail;
    if (summary.master?.spreadsheetId === ORIGINAL_GOQ_MASTER_SHEET_ID) {
      violations.push({ code: 'PICKING_MASTER_IS_ORIGINAL', message: 'ピッキングのマスタが元版のGoQ全データになっています。ベニー様シートを読む設定にしてください。', master: summary.master });
    }
    if (summary.masterLayoutOk !== true) {
      violations.push({ code: 'PICKING_MASTER_LAYOUT_UNVERIFIED', message: 'マスタの列の並びが確認されていません。', master: summary.master });
    }
    if (summary.anomalyOrders > 0) {
      warnings.push({ code: 'PICKING_ORDERS_MISSING_FROM_MASTER', message: `マスタに無い注文が ${summary.anomalyOrders} 件あります（PDF末尾の異常検知リスト）。`, skus: summary.anomalySkus });
    }
    if (summary.emptyJanLines > 0) {
      warnings.push({ code: 'PICKING_LINES_WITHOUT_JAN', message: `JANが空のピッキング行が ${summary.emptyJanLines} 行あります。`, pdf: detail.pdf });
    }
  });
  return { violations, warnings };
}

function collectPrinterDestinationIssues(run, steps) {
  const issues = [];
  const baseStatus = run.baseStatusKey || String(run.statusKey || '').replace(/-amazon$/, '');
  const expectedLabelPrinter = LABEL_PRINTER_BY_STATUS[baseStatus];
  for (const step of steps) {
    const name = String(step.name || '');
    const detail = step.detail || {};
    const isPicking = /printed picking list|verified picking print preview without pressing print/.test(name);
    const isLabel = /printed shipping label|printed existing shipping label|stopped before shipping label print button|stopped before existing shipping label print button/.test(name);
    if (!isPicking && !isLabel) continue;
    const expected = isPicking ? PICKING_PRINTER : expectedLabelPrinter;
    if (!expected) {
      issues.push({
        code: 'UNKNOWN_EXPECTED_PRINTER',
        message: `Cannot determine expected printer for status: ${run.statusKey || ''}`,
        step,
      });
      continue;
    }
    const declared = detail.expectedPrinter || detail.printer || '';
    const actual = detail.destination || '';
    if (!actual) {
      issues.push({
        code: 'PRINT_DESTINATION_NOT_RECORDED',
        message: `Print output step does not record the actual Chrome print-preview destination: ${name}`,
        expectedPrinter: expected,
        step,
      });
      continue;
    }
    if (!samePrinter(declared, expected)) {
      issues.push({
        code: 'EXPECTED_PRINTER_MISMATCH',
        message: `Logged expected printer does not match status routing for ${name}.`,
        expectedPrinter: expected,
        loggedPrinter: declared,
        step,
      });
    }
    if (!destinationIncludesPrinter(actual, expected)) {
      issues.push({
        code: 'PRINT_DESTINATION_MISMATCH',
        message: `Actual Chrome print-preview destination does not match expected printer for ${name}.`,
        expectedPrinter: expected,
        actualDestination: actual,
        step,
      });
    }
  }
  return issues;
}

function hasLabelGenerationDialog(run, steps) {
  const handledNonBlocking = steps.some(step => step.name === 'handled non-blocking shipping label generation notice');
  if (handledNonBlocking && (run.javascriptDialogs || []).every(dialog => dialog.context !== 'shipping-label-generation' || classifyShippingLabelDialog(dialog.message, dialog.type).nonBlocking)) {
    return false;
  }
  if (run.blockingLabelDialog) return true;
  if ((run.javascriptDialogs || []).some(dialog => dialog.context === 'shipping-label-generation')) return true;
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

function isShippingLabelSuccessNotice(message) {
  const text = String(message || '');
  return /完了しました|完了|受け付けました|受付|リクエスト/.test(text)
    && !/エラー|警告|住所|不備|失敗|できません|できませんでした|未入力|対象外|除外|修正/.test(text);
}

function samePrinter(actual, expected) {
  return normalizePrinter(actual) === normalizePrinter(expected);
}

function destinationIncludesPrinter(destination, expected) {
  return normalizePrinter(destination).includes(normalizePrinter(expected));
}

function normalizePrinter(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function collectUnreviewedAddressWarnings(run) {
  const rows = [];
  for (const row of run.addressWarningReviewGuard?.unreviewed || []) {
    rows.push(row);
  }
  for (const section of [run.initial, run.afterFilter, run.beforeLabel]) {
    for (const blocker of section?.blockers || []) {
      if (/address warning/i.test(String(blocker.reason || ''))) rows.push(blocker.row || blocker);
    }
  }
  for (const blocker of run.blockers || []) {
    if (/address warning|address/i.test(String(blocker.reason || blocker.error || ''))) rows.push(blocker.row || blocker);
  }
  for (const blocker of run.addressFixes?.blockers || []) {
    rows.push(blocker.row || blocker);
  }
  return uniqueRows(rows);
}

function collectManualExcludedAddressWarnings(run) {
  const fixed = new Set(run.addressFixedGoqIds || []);
  const unresolved = new Set(run.addressUnresolvedGoqIds || []);
  for (const item of run.addressFixes?.fixed || []) {
    if (item.row?.goqId) fixed.add(item.row.goqId);
  }
  const rows = [];
  for (const section of [run.initial, run.afterFilter, run.beforeLabel]) {
    for (const excluded of section?.excluded || []) {
      const row = excluded.row || {};
      if (excluded.reason === 'manual exclude' && row.addressWarning && !fixed.has(row.goqId) && !unresolved.has(row.goqId)) rows.push(row);
    }
  }
  return uniqueRows(rows);
}

function collectUnvalidatedFixedAddressWarnings(run) {
  const rows = [];
  for (const item of run.addressFixes?.fixed || []) {
    if (!item.row?.addressWarning) continue;
    const changed = item.changed === true || (Array.isArray(item.changes) && item.changes.length > 0);
    const externallyValidated = item.externallyValidated === true || item.validation?.external === true;
    if (!changed && !externallyValidated) rows.push({ row: item.row, before: item.before, after: item.after, note: item.note });
  }
  return rows;
}

function collectUnresolvedAddressWarningsWithoutMemo(run) {
  const memoMarked = new Set((run.addressFixes?.unresolved || [])
    .filter(item => item.ok && String(item.afterMemo || '').includes('住所不正'))
    .map(item => item.row?.goqId)
    .filter(Boolean));
  const missing = [];
  for (const goqId of run.addressUnresolvedGoqIds || []) {
    if (!memoMarked.has(goqId) && run.args?.['address-unresolved-confirmed'] !== true) {
      missing.push({ goqId, reason: 'address unresolved exclusion lacks recorded 住所不正 memo' });
    }
  }
  return missing;
}

function uniqueRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row?.goqId || row?.orderNumber || JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function latestRunFile() {
  if (!fs.existsSync(RUN_DIR)) return '';
  const files = fs.readdirSync(RUN_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(RUN_DIR, name))
    .map(fullName => ({ fullName, mtimeMs: fs.statSync(fullName).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.fullName || '';
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--latest') out.latest = true;
    else if (arg === '--file') out.file = argv[++i];
  }
  return out;
}
