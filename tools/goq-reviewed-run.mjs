#!/usr/bin/env node
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const RUN_DIR = path.join('.o11y', 'goq-unified-print-flow', 'runs');
const REVIEW_DIR = path.join('.o11y', 'goq-unified-print-flow', 'reviews');

const rawArgs = process.argv.slice(2);
const { flowArgs, allowReviewWarnings } = parseWrapperArgs(rawArgs);

if (!flowArgs.length || flowArgs.includes('--help')) {
  console.log('usage: node tools/goq-reviewed-run.mjs --status <status> [goq-print-flow options]');
  console.log('');
  console.log('Runs goq-print-flow, then always runs goq-run-review against the new run log.');
  console.log('Use --allow-review-warnings only for an explicitly accepted exceptional run.');
  process.exit(flowArgs.includes('--help') ? 0 : 2);
}

const status = argValue(flowArgs, '--status') || 'sagawa';
const beforeRuns = snapshotRuns();
const env = { ...process.env };
env.GOQ_CDP_HOST = await resolvedCdpHost(env.GOQ_CDP_HOST || 'host.docker.internal');

console.log(`[goq-reviewed-run] CDP host: ${env.GOQ_CDP_HOST}`);
console.log(`[goq-reviewed-run] flow: node tools/goq-print-flow.mjs ${flowArgs.join(' ')}`);

const flowResult = await runCommand(process.execPath, ['tools/goq-print-flow.mjs', ...flowArgs], { env, stdio: 'inherit' });
const runFile = newestRunAfter(beforeRuns, status) || latestRunFile(status) || latestRunFile('');

if (!runFile) {
  console.error('[goq-reviewed-run] No run log was produced; review cannot run.');
  process.exit(flowResult.code || 1);
}

console.log(`[goq-reviewed-run] reviewing: ${runFile}`);
const reviewResult = await runCommand(process.execPath, ['tools/goq-run-review.mjs', '--file', runFile], { env, stdio: 'pipe' });
if (reviewResult.stdout) process.stdout.write(reviewResult.stdout);
if (reviewResult.stderr) process.stderr.write(reviewResult.stderr);

const review = parseReview(reviewResult.stdout);
if (review) {
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  const reviewFile = path.join(REVIEW_DIR, `${path.basename(runFile, '.json')}.review.json`);
  fs.writeFileSync(reviewFile, `${JSON.stringify({
    reviewedRun: path.resolve(runFile),
    flowExitCode: flowResult.code,
    reviewExitCode: reviewResult.code,
    allowReviewWarnings,
    review,
  }, null, 2)}\n`, 'utf8');
  console.log(`[goq-reviewed-run] review report: ${reviewFile}`);
}

const hasReviewWarnings = Boolean(review?.warnings?.length);
if (flowResult.code !== 0) {
  console.error(`[goq-reviewed-run] flow failed with exit code ${flowResult.code}.`);
  process.exit(flowResult.code);
}
if (reviewResult.code !== 0 || review?.ok === false) {
  console.error('[goq-reviewed-run] review failed.');
  process.exit(reviewResult.code || 1);
}
if (hasReviewWarnings && !allowReviewWarnings) {
  console.error('[goq-reviewed-run] review produced warnings; treating as failure in autonomous mode.');
  process.exit(1);
}

console.log('[goq-reviewed-run] flow and review passed.');

function parseWrapperArgs(args) {
  const flowArgs = [];
  let allowReviewWarnings = false;
  for (const arg of args) {
    if (arg === '--allow-review-warnings') {
      allowReviewWarnings = true;
      continue;
    }
    flowArgs.push(arg);
  }
  return { flowArgs, allowReviewWarnings };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  return args[index + 1] || '';
}

async function resolvedCdpHost(host) {
  if (!host || host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^\[?[0-9a-f:]+\]?$/i.test(host)) {
    return host || '127.0.0.1';
  }
  const result = await dns.lookup(host, { family: 4 });
  return result.address;
}

function runCommand(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env,
      stdio: options.stdio,
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk; });
    if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}${error.stack || error.message}\n` }));
  });
}

function parseReview(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stdout.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function snapshotRuns() {
  if (!fs.existsSync(RUN_DIR)) return new Set();
  return new Set(fs.readdirSync(RUN_DIR).filter(name => name.endsWith('.json')));
}

function newestRunAfter(before, status) {
  if (!fs.existsSync(RUN_DIR)) return '';
  return fs.readdirSync(RUN_DIR)
    .filter(name => name.endsWith('.json'))
    .filter(name => !before.has(name))
    .filter(name => !status || name.endsWith(`-${status}.json`))
    .map(name => runEntry(name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || '';
}

function latestRunFile(status) {
  if (!fs.existsSync(RUN_DIR)) return '';
  return fs.readdirSync(RUN_DIR)
    .filter(name => name.endsWith('.json'))
    .filter(name => !status || name.endsWith(`-${status}.json`))
    .map(name => runEntry(name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || '';
}

function runEntry(name) {
  const file = path.join(RUN_DIR, name);
  return { file, mtimeMs: fs.statSync(file).mtimeMs };
}
