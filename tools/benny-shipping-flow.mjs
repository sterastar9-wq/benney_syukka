#!/usr/bin/env node
// ベニー様の出荷フローを 1 コマンドで通す（2026-10-01 に実運用で確認した手順をそのまま並べたもの）。
//
//   npm run ship -- [--statuses nekoposu,takkyubin] [--air-notice-approved] [--allow-extra] [--skip-goq] [--skip-labels] [--port 9223]
//
//   1. GoQ 側（ステータスごと）: npm run goq:print -- --status <status> --execute
//        ピッキングリスト印刷（C5240 普通紙）→ B2用CSV出力・突合・書き換え（出荷予定日=今日、品名コード/品名）→ 引き継ぎファイル
//        対象行が無いステータスは「0件」として飛ばす
//   2. ヤマト側（ステータスごと）: tools/yamato-b2/print-labels.mjs --handoff <引き継ぎ>
//        取込み（ピッキング印刷の証跡ゲート）→ 印刷内容の確認へ（航空危険物の確認は --air-notice-approved が無ければ止まる）→ 発行・印刷
//   3. 送り状番号: tools/yamato-b2/export-tracking.mjs --handoffs <全部>   （B2 発行済データ → CSV。対象外の注文があれば止まる。--allow-extra で含める）
//   4. GoQ へ戻す: tools/yamato-b2/import-tracking-to-goq.mjs --set-ship-date today --handoffs <全部>
//        送り状番号取込 → 注文詳細で検証 → 出荷日を今日に → 送り状番号と出荷日の両方がある注文だけ ★発送済み → 当日の出荷件数を報告
//   どこかで止まったら、そこで終了して理由と再開コマンドを出す。実行記録は .o11y/benny-shipping-flow/ に残す。
//
// 承認が要る判断（航空危険物の確認、引き継ぎに無い注文の扱い）は、オプションで明示されたときだけ進める。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const ROOT = process.cwd();
const HANDOFF_DIR = path.join('.o11y', 'goq-unified-print-flow', 'b2-handoff');
const LOG_DIR = path.join('.o11y', 'benny-shipping-flow');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const statuses = String(args.statuses || 'nekoposu,takkyubin').split(',').map(s => s.trim()).filter(Boolean);
const port = String(args.port || process.env.GOQ_CDP_PORT || 9223);
const run = { startedAt: new Date().toISOString(), args, statuses, steps: [], handoffs: {} };
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `${run.startedAt.replace(/[:.]/g, '-')}.json`);
const save = () => fs.writeFileSync(logFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
const step = (name, detail = {}) => { run.steps.push({ name, at: new Date().toISOString(), detail }); save(); console.error(`[benny-shipping-flow] ${name}`); };
const finish = (code, error) => {
  if (error) run.error = error;
  run.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ ok: !error, logFile: path.resolve(logFile), ...run }, null, 2));
  process.exit(code);
};

function runNode(script, childArgs) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...childArgs], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const stdout = result.stdout || '';
  let json = null;
  const start = stdout.indexOf('{');
  if (start >= 0) { try { json = JSON.parse(stdout.slice(start, stdout.lastIndexOf('}') + 1)); } catch { json = null; } }
  return { status: result.status, json, stdout, stderrTail: (result.stderr || '').slice(-3000) };
}

const listHandoffs = () => fs.existsSync(HANDOFF_DIR) ? fs.readdirSync(HANDOFF_DIR).filter(f => f.endsWith('.json')).map(f => path.join(HANDOFF_DIR, f)) : [];

// 1. GoQ 側
if (args['skip-goq'] !== true) {
  for (const status of statuses) {
    const before = new Set(listHandoffs());
    const r = runNode('tools/goq-reviewed-run.mjs', ['--status', status, '--execute', '--port', port]);
    const noRows = /No eligible rows/.test(r.stdout + r.stderrTail);
    const handoff = (r.stdout.match(/"b2Handoff":\s*\{\s*"file":\s*"([^"]+)"/) || [])[1]?.replace(/\\\\/g, '\\');
    const fresh = listHandoffs().filter(f => !before.has(f));
    const file = handoff && fs.existsSync(handoff) ? handoff : fresh.sort().pop();
    step('goq print flow finished', { status, exit: r.status, noRows, handoff: file || null, stderrTail: r.status === 0 ? undefined : r.stderrTail.slice(-1200) });
    if (noRows) { run.handoffs[status] = null; continue; }
    if (r.status !== 0 || !file) finish(3, `GoQ 側のフロー（${status}）で止まりました。.o11y/goq-unified-print-flow/reviews/ の最新レビューを確認してください。`);
    run.handoffs[status] = path.resolve(file);
  }
} else {
  // 直近の引き継ぎ（ステータスごとに最新）を使う
  for (const status of statuses) {
    const file = listHandoffs().filter(f => f.endsWith(`-${status}.json`)).sort().pop();
    run.handoffs[status] = file ? path.resolve(file) : null;
  }
  step('reused latest handoffs', run.handoffs);
}
const handoffFiles = Object.values(run.handoffs).filter(Boolean);
if (!handoffFiles.length) finish(0, undefined);

// 2. ヤマト側（発行・印刷）
if (args['skip-labels'] !== true) {
  for (const [status, file] of Object.entries(run.handoffs)) {
    if (!file) continue;
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (h.yamato?.printed === true) { step('labels already printed for handoff', { status, file }); continue; }
    const childArgs = ['--handoff', file, '--port', port];
    if (args['air-notice-approved'] === true) childArgs.push('--air-notice-approved');
    const r = runNode('tools/yamato-b2/print-labels.mjs', childArgs);
    const printed = (r.json?.steps || []).find(s => s.name === 'issue finished')?.detail?.printed;
    step('yamato label print finished', { status, exit: r.status, error: r.json?.error, printed, logFile: r.json?.logFile });
    if (r.status !== 0 || !r.json?.ok) {
      const hint = /重要なお知らせ/.test(String(r.json?.error)) ? ' 品目を確認して問題なければ --air-notice-approved を付けて再実行してください。' : '';
      finish(4, `ヤマト側の発行・印刷（${status}）で止まりました: ${r.json?.error || r.stderrTail}${hint}`);
    }
  }
}

// 3. 送り状番号の出力
{
  const childArgs = ['--handoffs', handoffFiles.join(','), '--port', port];
  if (args['allow-extra'] === true) childArgs.push('--allow-extra');
  const r = runNode('tools/yamato-b2/export-tracking.mjs', childArgs);
  step('tracking export finished', { exit: r.status, error: r.json?.error, verification: r.json?.verification, csv: r.json?.csv?.file, lines: r.json?.csv?.lines });
  if (r.status !== 0 || !r.json?.ok) {
    const hint = /引き継ぎファイルに無い注文/.test(String(r.json?.error)) ? ' その注文が自社の手動発行分なら --allow-extra を付けて再実行してください（送り状番号だけ GoQ に戻し、ステータスは変えません）。' : '';
    finish(5, `送り状番号の出力で止まりました: ${r.json?.error || r.stderrTail}${hint}`);
  }
}

// 4. GoQ へ取込み → 出荷日 → ★発送済み
{
  const r = runNode('tools/yamato-b2/import-tracking-to-goq.mjs', ['--handoffs', handoffFiles.join(','), '--set-ship-date', 'today', '--port', port]);
  run.shippedToday = r.json?.shippedToday || null;
  step('goq tracking import finished', { exit: r.status, error: r.json?.error, importedCount: r.json?.importedCount, verified: r.json?.verified?.length, unverified: r.json?.unverified?.map(u => u.goqId), shippedToday: run.shippedToday });
  if (r.status !== 0 || !r.json?.ok) finish(6, `GoQ への送り状番号取込／★発送済み で止まりました: ${r.json?.error || r.stderrTail}`);
}

// 5. 当日の出荷件数（報告）
const byStatus = (run.shippedToday?.byStatus || []).map(s => `${s.status}: ${s.moved}件`).join(' / ');
run.report = `本日の出荷件数: ${run.shippedToday?.movedToShipped ?? '?'}件（${byStatus}）`;
step('report', { text: run.report });
console.error(run.report);
finish(0);
