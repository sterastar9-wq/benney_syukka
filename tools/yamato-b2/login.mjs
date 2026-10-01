#!/usr/bin/env node
// ヤマトビジネスメンバーズ ログイン（ベニー様フロー 4 の入口）。
// 認証情報は .env の YAMATO_BENY_CODE（必須コード）/ YAMATO_BENY_EDABAN（任意コード）/ YAMATO_BENY_PASSWORD を使う。
//
//   node tools/yamato-b2/login.mjs [--port 9223] [--check]
//
// ログイン後、ホーム画面に会社名（既定: 合同会社Ｂｅｎｙ、.env の YAMATO_EXPECTED_COMPANY で変更可）が
// 表示されていることを確認する。表示されなければ失敗扱いにする。
// パスワードそのものは出力・ログに出さない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireEnv, envStatus, envNumber } from '../lib/env.mjs';
import { CdpPage, connectOrOpen, listTargets, wait, waitUntil } from '../lib/cdp.mjs';

export const YAMATO_HOST = 'bmypage.kuronekoyamato.co.jp';
export const YAMATO_LOGIN_URL = process.env.YAMATO_LOGIN_URL
  || 'https://bmypage.kuronekoyamato.co.jp/bmypage/servlet/jp.co.kuronekoyamato.wur.hmp.servlet.user.HMPLGI0010JspServlet';
const ENV_KEYS = ['YAMATO_BENY_CODE', 'YAMATO_BENY_PASSWORD'];
const OPTIONAL_ENV_KEYS = ['YAMATO_BENY_EDABAN'];
const LOG_DIR = path.join('.o11y', 'yamato-b2', 'login');

export function yamatoEnvStatus() {
  return envStatus([...ENV_KEYS, ...OPTIONAL_ENV_KEYS]);
}

export function expectedCompany() {
  loadEnv();
  return process.env.YAMATO_EXPECTED_COMPANY || '合同会社Ｂｅｎｙ';
}

// 全角・半角の違いを吸収して会社名を比較する
export function normalizeCompany(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// ログイン画面の入力欄を推定する。
// 走査（survey.mjs）で確定したセレクタは .env の YAMATO_SELECTOR_HISSU / _NINNI / _PASSWORD / _SUBMIT で固定できる。
export async function readYamatoLoginState(page) {
  return page.eval(`(() => {
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const labelFor = el => {
      const byId = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
      const near = el.closest('tr, li, div, p, dl');
      const text = (byId?.innerText || near?.innerText || '').replace(/\\s+/g, ' ').trim();
      return text.slice(0, 80);
    };
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible).map(el => ({
      type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, maxLength: el.maxLength, label: labelFor(el),
      selector: el.id ? '#' + CSS.escape(el.id) : (el.name ? 'input[name="' + el.name + '"]' : ''),
    }));
    const texts = inputs.filter(i => i.type === 'text' || i.type === 'tel' || i.type === 'number');
    const passwords = inputs.filter(i => i.type === 'password');
    const hissu = texts.find(i => /必須/.test(i.label) || /hissu|hisu|custcd|kokyaku|customer/i.test(i.name + i.id)) || texts[0] || null;
    const ninni = texts.find(i => i !== hissu && (/任意/.test(i.label) || /ninni|nini|optional|sub|edaban/i.test(i.name + i.id))) || texts.find(i => i !== hissu) || null;
    const password = passwords[0] || null;
    const submit = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="image"], input[type="button"], a'))
      .filter(visible)
      .map(el => ({ tag: el.tagName, text: (el.innerText || el.value || el.alt || el.title || '').replace(/\\s+/g, '').trim(), name: el.name || '', id: el.id || '' }))
      .find(b => /ログイン/.test(b.text) || /login/i.test(b.name + b.id)) || null;
    const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      url: location.href,
      title: document.title,
      isLoginPage: !!(password && (hissu || texts.length)),
      fields: { hissu, ninni, password: password ? { ...password } : null, submit },
      textHead: bodyText.slice(0, 300),
      hasLogout: /ログアウト/.test(bodyText),
    };
  })()`);
}

export async function verifyCompanyOnPage(page, company = expectedCompany()) {
  const text = await page.eval(`(document.body?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const ok = normalizeCompany(text).includes(normalizeCompany(company));
  return { ok, company, url: await page.url(), sample: text.slice(0, 300) };
}

export async function ensureYamatoLogin(page, { step = () => {}, allowLogin = true } = {}) {
  loadEnv();
  const record = { startedAt: new Date().toISOString(), actions: [], expectedCompany: expectedCompany() };
  let state = await readYamatoLoginState(page);
  record.initial = { url: state.url, title: state.title, isLoginPage: state.isLoginPage, hasLogout: state.hasLogout };
  if (!state.isLoginPage && String(state.url).includes(YAMATO_HOST)) {
    const company = await verifyCompanyOnPage(page);
    if (company.ok) {
      record.result = 'already-logged-in';
      record.company = company;
      step('yamato login state verified', { url: state.url, result: record.result, company: company.company });
      return record;
    }
  }
  if (!allowLogin) {
    record.result = 'not-logged-in';
    return record;
  }
  const env = requireEnv(ENV_KEYS);
  if (!state.isLoginPage) {
    await page.navigate(YAMATO_LOGIN_URL, 3500);
    state = await readYamatoLoginState(page);
    record.actions.push({ action: 'navigate login url', url: YAMATO_LOGIN_URL, isLoginPage: state.isLoginPage });
  }
  if (!state.isLoginPage) {
    // ヤマトビジネスメンバーズは 7:00〜25:00（B2クラウドのみ 4:00〜）しか使えない。時間外はログイン欄が出ない
    if (/ご利用時間外/.test(state.textHead || '')) {
      throw new Error('ヤマトビジネスメンバーズの利用時間外です（ご利用可能時間 7:00〜25:00、B2クラウドのみ 4:00から）。時間内に再実行してください。');
    }
    throw new Error(`ヤマトのログイン画面を認識できません: ${JSON.stringify({ url: state.url, title: state.title, text: state.textHead })}`);
  }
  // 2026-09-30 の走査で確定したログイン画面（HMPLGI0010）の構造:
  //   #code1 (name=username, 12桁)      … お客様コード（必須コード）
  //   #code2 (name=CSTMR_CLS_CD, 3桁)   … お客様コードのハイフン以降（任意コード。持っている場合のみ）
  //   #password (name=CSTMR_PSWD)       … パスワード
  //   #kojin (name=KOJIN)               … 個人ユーザーID（使わない）
  //   a.login  onclick=func_request_Link('LOGIN') … ログイン
  const selectors = {
    hissu: process.env.YAMATO_SELECTOR_CODE || (await page.eval(`!!document.querySelector('#code1')`) ? '#code1' : state.fields.hissu?.selector),
    ninni: process.env.YAMATO_SELECTOR_EDABAN || (await page.eval(`!!document.querySelector('#code2')`) ? '#code2' : state.fields.ninni?.selector),
    password: process.env.YAMATO_SELECTOR_PASSWORD || (await page.eval(`!!document.querySelector('#password')`) ? '#password' : state.fields.password?.selector),
  };
  record.selectors = selectors;
  if (!selectors.hissu || !selectors.password) {
    throw new Error(`ログイン欄のセレクタを決められません: ${JSON.stringify(state.fields)}`);
  }
  const filled = {
    hissu: await page.fillSelector(selectors.hissu, env.YAMATO_BENY_CODE),
    ninni: selectors.ninni && process.env.YAMATO_BENY_EDABAN ? await page.fillSelector(selectors.ninni, process.env.YAMATO_BENY_EDABAN) : { ok: true, skipped: true },
    password: await page.fillSelector(selectors.password, env.YAMATO_BENY_PASSWORD),
  };
  record.actions.push({ action: 'filled login fields', hissu: filled.hissu.ok, ninni: filled.ninni.ok, password: filled.password.ok });
  if (!filled.hissu.ok || !filled.password.ok) throw new Error(`ログイン欄に入力できません: ${JSON.stringify(filled)}`);

  const submitSelector = process.env.YAMATO_SELECTOR_SUBMIT || (await page.eval(`!!document.querySelector('a.login')`) ? 'a.login' : '');
  const clicked = submitSelector
    ? await page.clickSelector(submitSelector)
    : await page.clickByText('ログイン', { exact: true, tags: 'button, input[type="submit"], input[type="image"], input[type="button"], a' });
  record.actions.push({ action: 'submitted', ok: clicked.ok, via: submitSelector || 'text:ログイン' });
  if (!clicked.ok) throw new Error(`ログインボタンが見つかりません: ${clicked.error}`);
  await wait(3500);

  let company;
  try {
    company = await waitUntil(async () => {
      const current = await readYamatoLoginState(page);
      if (current.isLoginPage) return null;
      const check = await verifyCompanyOnPage(page);
      return check.ok ? check : null;
    }, 25000, 1000);
  } catch {
    company = await verifyCompanyOnPage(page);
  }
  const finalState = await readYamatoLoginState(page);
  // ログイン失敗時のURLにはお客様コードがクエリで入るため、記録・エラー文にはパスとエラーコードだけ残す
  const finalUrl = (() => {
    try {
      const u = new URL(finalState.url);
      const err = [u.searchParams.get('errCode'), u.searchParams.get('exceptionCode')].filter(Boolean).join('/');
      return `${u.origin}${u.pathname}${err ? `?err=${err}` : ''}`;
    } catch {
      return String(finalState.url || '').split('?')[0];
    }
  })();
  const loginError = (finalState.textHead.match(/ログイン情報が正しくありません|ロック|利用可能時間|仮パスワード[^。]*。/) || [])[0] || '';
  record.final = { url: finalUrl, title: finalState.title, isLoginPage: finalState.isLoginPage, hasLogout: finalState.hasLogout, loginError };
  record.company = company;
  record.result = !finalState.isLoginPage && company.ok ? 'logged-in' : 'failed';
  step('yamato login attempted', { result: record.result, url: finalState.url, companyVerified: company.ok });
  if (record.result !== 'logged-in') {
    throw new Error(`ヤマトのログイン後に「${record.expectedCompany}」を確認できませんでした: ${JSON.stringify(record.final)}`);
  }
  return record;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : envNumber('GOQ_CDP_PORT', 9223);
  const targets = await listTargets(port);
  const existing = targets.find(t => t.type === 'page' && t.url.includes(YAMATO_HOST));
  const page = existing
    ? new CdpPage(existing.webSocketDebuggerUrl, port, existing.id)
    : await connectOrOpen(port, YAMATO_LOGIN_URL, () => false);
  if (existing) await page.enable();
  const out = { port, env: yamatoEnvStatus(), mode: check ? 'check' : 'login' };
  try {
    out.login = await ensureYamatoLogin(page, { allowLogin: !check });
    out.ok = out.login.result === 'logged-in' || out.login.result === 'already-logged-in';
    fs.mkdirSync(LOG_DIR, { recursive: true });
    out.screenshot = await page.screenshot(path.join(LOG_DIR, `home-${Date.now()}.png`));
  } catch (error) {
    out.ok = false;
    out.error = error.message;
  } finally {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
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
