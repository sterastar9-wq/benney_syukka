#!/usr/bin/env node
// GoQ ログイン（ベニー様フロー 1）。
// 認証情報は .env の GOQ_LOGIN_URL / GOQ_USER_ID / GOQ_PASSWORD / GOQ_SEQ_ID / GOQ_SEQ_PW を使う。
//
//   node tools/goq-login.mjs [--port 9223] [--check]
//
// --check: ログイン状態を確認するだけ（入力しない）。
// 既にログイン済みのGoQタブがあれば何もしない。ログイン画面ならIDを入力してダッシュボードまで進める。
// パスワードそのものは出力・ログに出さない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireEnv, envStatus, envNumber } from './lib/env.mjs';
import { CdpPage, connectOrOpen, listTargets, wait, waitUntil } from './lib/cdp.mjs';

export const GOQ_ORIGIN = 'https://order.goqsystem.com';
export const GOQ_DASHBOARD_URL = `${GOQ_ORIGIN}/goq21/dashboard/`;
// 2026-09-30 に実画面で確認したログインURL（未ログインでダッシュボードを開くとここへ飛ぶ）。.env の GOQ_LOGIN_URL で上書き可
export const GOQ_DEFAULT_LOGIN_URL = `${GOQ_ORIGIN}/goq21/form/goqsystem_new/systemlogin.php`;
const GOQ_ENV_KEYS = ['GOQ_USER_ID', 'GOQ_PASSWORD', 'GOQ_SEQ_ID', 'GOQ_SEQ_PW'];
const LOG_DIR = path.join('.o11y', 'goq-login');

export function goqEnvStatus() {
  return envStatus(GOQ_ENV_KEYS);
}

// ページの状態を判定する（page は eval(expr) を持つ任意のCDPページ）
export async function readGoqLoginState(page) {
  return page.eval(`(() => {
    const q = s => document.querySelector(s);
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      url: location.href,
      title: document.title,
      step1: visible(q('#login_id')) && visible(q('#login_pw')),
      step2: visible(q('#seq_id')) && visible(q('#seq_pw')),
      agreeButton: Array.from(document.querySelectorAll('button, input[type="submit"], a'))
        .some(el => /同意してGoQSystemを利用します/.test((el.innerText || el.value || '').replace(/\\s+/g, ''))),
      loggedIn: /\\/goq21\\//.test(location.pathname) && !visible(q('#login_id')) && !visible(q('#seq_id')) && !/ログイン/.test(document.title),
      textHead: text.slice(0, 200),
    };
  })()`);
}

// ログイン済みでなければ .env の情報でログインする。戻り値はパスワードを含まない記録。
export async function ensureGoqLogin(page, { step = () => {}, allowLogin = true } = {}) {
  loadEnv();
  const record = { startedAt: new Date().toISOString(), actions: [] };
  let state = await readGoqLoginState(page);
  record.initial = state;
  if (state.loggedIn) {
    record.result = 'already-logged-in';
    step('goq login state verified', { url: state.url, result: record.result });
    return record;
  }
  if (!allowLogin) {
    record.result = 'not-logged-in';
    return record;
  }
  const env = requireEnv(GOQ_ENV_KEYS);
  const loginUrl = process.env.GOQ_LOGIN_URL || GOQ_DEFAULT_LOGIN_URL;
  if (!state.step1 && !state.step2) {
    await page.navigate(loginUrl, 3000);
    state = await readGoqLoginState(page);
    record.actions.push({ action: 'navigate login url', url: loginUrl, state: { step1: state.step1, step2: state.step2 } });
  }
  if (state.step1) {
    const id = await page.fillSelector('#login_id', env.GOQ_USER_ID);
    const pw = await page.fillSelector('#login_pw', env.GOQ_PASSWORD);
    if (!id.ok || !pw.ok) throw new Error(`GoQ login step1 fields not found: ${JSON.stringify({ id, pw: { ok: pw.ok } })}`);
    const clicked = await page.clickByText('認証する');
    if (!clicked.ok) throw new Error(`GoQ login step1 button not found: ${clicked.error}`);
    record.actions.push({ action: 'step1 submitted', idLength: id.length });
    await wait(2500);
    state = await readGoqLoginState(page);
  }
  if (state.step2) {
    const id = await page.fillSelector('#seq_id', env.GOQ_SEQ_ID);
    const pw = await page.fillSelector('#seq_pw', env.GOQ_SEQ_PW);
    if (!id.ok || !pw.ok) throw new Error(`GoQ login step2 fields not found: ${JSON.stringify({ id, pw: { ok: pw.ok } })}`);
    const clicked = await page.clickByText('ログイン');
    if (!clicked.ok) throw new Error(`GoQ login step2 button not found: ${clicked.error}`);
    record.actions.push({ action: 'step2 submitted', idLength: id.length });
    await wait(3000);
    state = await readGoqLoginState(page);
  }
  if (state.agreeButton) {
    const agreed = await page.clickByText('同意してGoQSystemを利用します', { exact: false });
    record.actions.push({ action: 'agreement accepted', ok: agreed.ok });
    await wait(2500);
    state = await readGoqLoginState(page);
  }
  try {
    state = await waitUntil(async () => {
      const current = await readGoqLoginState(page);
      return current.loggedIn ? current : null;
    }, 20000, 1000);
  } catch {
    state = await readGoqLoginState(page);
  }
  record.final = state;
  record.result = state.loggedIn ? 'logged-in' : 'failed';
  step('goq login attempted', { result: record.result, url: state.url, actions: record.actions });
  if (!state.loggedIn) {
    throw new Error(`GoQ login failed. url=${state.url} title=${state.title} text=${state.textHead}`);
  }
  return record;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : envNumber('GOQ_CDP_PORT', 9223);
  const targets = await listTargets(port);
  const existing = targets.find(t => t.type === 'page' && t.url.includes('order.goqsystem.com'));
  const page = existing
    ? new CdpPage(existing.webSocketDebuggerUrl, port, existing.id)
    : await connectOrOpen(port, GOQ_DASHBOARD_URL, () => false);
  if (existing) await page.enable();
  const out = { port, env: goqEnvStatus(), mode: check ? 'check' : 'login' };
  try {
    out.login = await ensureGoqLogin(page, { allowLogin: !check });
    out.ok = out.login.result !== 'failed' && out.login.result !== 'not-logged-in';
  } catch (error) {
    out.ok = false;
    out.error = error.message;
  } finally {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify(out, null, 2)}\n`);
    page.close();
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}
