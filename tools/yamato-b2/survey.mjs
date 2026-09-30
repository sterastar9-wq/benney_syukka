#!/usr/bin/env node
// ヤマトビジネスメンバーズ / B2クラウド の画面構造を走査して記録する（読み取り専用）。
//
//   node tools/yamato-b2/survey.mjs [--port 9223] [--max-pages 40] [--depth 2] [--screenshots]
//
// ログイン済みのタブから始めて、同一ドメイン（*.kuronekoyamato.co.jp）のリンクを幅優先でたどり、
// 各ページの見出し・リンク・フォーム・ボタン・フレームを .o11y/yamato-b2/survey/<日時>/ に保存する。
// 副作用のあるリンク（ログアウト・発行・印刷・登録・削除・送信 など）はたどらず、存在だけ記録する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envNumber } from '../lib/env.mjs';
import { CdpPage, listTargets, wait } from '../lib/cdp.mjs';
import { YAMATO_HOST, readYamatoLoginState, verifyCompanyOnPage } from './login.mjs';

const SIDE_EFFECT_TEXT = /ログアウト|発行|印刷|登録|削除|送信|確定|取消|申込|申し込み|購入|決済|更新|保存|実行|出力|取込|アップロード|変更/;
const SIDE_EFFECT_URL = /logout|logoff|delete|remove|print|issue|regist|submit|confirm|exec|export|import|upload/i;

export async function describePage(page) {
  return page.eval(`(() => {
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const norm = v => String(v || '').replace(/\\s+/g, ' ').trim();
    const sel = el => el.id ? '#' + CSS.escape(el.id) : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : '');
    const labelFor = el => {
      const byId = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
      if (byId) return norm(byId.innerText).slice(0, 60);
      const cell = el.closest('td, th, li, dd, div');
      const prev = cell?.previousElementSibling;
      return norm(prev?.innerText || cell?.innerText || '').slice(0, 60);
    };
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, .title, .ttl, [class*="title"], [class*="heading"]'))
      .filter(visible).map(el => norm(el.innerText)).filter(Boolean).slice(0, 40);
    const links = Array.from(document.querySelectorAll('a')).filter(visible).map(a => ({
      text: norm(a.innerText || a.title || a.querySelector('img')?.alt).slice(0, 80),
      href: a.href || '',
      onclick: (a.getAttribute('onclick') || '').slice(0, 160),
      target: a.target || '',
    })).filter(l => l.text || l.href).slice(0, 300);
    const forms = Array.from(document.querySelectorAll('form')).map((form, index) => ({
      index,
      id: form.id || '', name: form.name || '', action: form.action || '', method: (form.method || 'get').toUpperCase(), target: form.target || '',
      fields: Array.from(form.querySelectorAll('input, select, textarea')).map(el => ({
        tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '', value: el.type === 'password' ? '***' : String(el.value || '').slice(0, 60),
        visible: visible(el), label: visible(el) ? labelFor(el) : '', selector: sel(el),
        options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 40).map(o => ({ value: o.value, text: norm(o.textContent) })) : undefined,
        accept: el.accept || undefined,
      })).slice(0, 120),
    }));
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"]')).filter(visible).map(el => ({
      tag: el.tagName.toLowerCase(), type: el.type || '', text: norm(el.innerText || el.value || el.alt || el.title).slice(0, 60), name: el.name || '', id: el.id || '',
      onclick: (el.getAttribute('onclick') || '').slice(0, 160), form: el.form?.id || el.form?.name || '',
    })).slice(0, 120);
    const frames = Array.from(document.querySelectorAll('iframe, frame')).map(f => ({ name: f.name || '', id: f.id || '', src: f.src || '' }));
    const tables = Array.from(document.querySelectorAll('table')).filter(visible).slice(0, 20).map(t => ({
      id: t.id || '', className: (t.className || '').slice(0, 60), rows: t.rows.length,
      header: Array.from(t.rows[0]?.cells || []).map(c => norm(c.innerText).slice(0, 30)).slice(0, 20),
    }));
    const scripts = Array.from(document.scripts).map(s => s.src).filter(Boolean).slice(0, 40);
    return {
      url: location.href, title: document.title, headings, links, forms, buttons, frames, tables, scripts,
      text: norm(document.body?.innerText).slice(0, 3000),
    };
  })()`);
}

function isCrawlableHost(href) {
  try {
    const u = new URL(href);
    return /^https?:$/.test(u.protocol) && /kuronekoyamato\.co\.jp$/.test(u.hostname);
  } catch {
    return false;
  }
}

function pageKey(href) {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return href;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const port = Number(opt('--port', envNumber('GOQ_CDP_PORT', 9223)));
  const maxPages = Number(opt('--max-pages', 40));
  const maxDepth = Number(opt('--depth', 2));
  const screenshots = args.includes('--screenshots');
  const outDir = path.join('.o11y', 'yamato-b2', 'survey', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });

  const targets = await listTargets(port);
  const existing = targets.find(t => t.type === 'page' && t.url.includes(YAMATO_HOST));
  if (!existing) throw new Error(`ヤマトビジネスメンバーズのタブがありません。先に node tools/yamato-b2/login.mjs --port ${port} でログインしてください。`);
  const page = new CdpPage(existing.webSocketDebuggerUrl, port, existing.id);
  await page.enable();
  page.onDialog = () => false; // 走査中の confirm は常にキャンセル（副作用防止）

  const state = await readYamatoLoginState(page);
  if (state.isLoginPage) throw new Error('ログイン画面のままです。先にログインしてください。');
  const company = await verifyCompanyOnPage(page);

  const startUrl = state.url;
  const queue = [{ url: startUrl, depth: 0, via: 'start' }];
  const seen = new Set([pageKey(startUrl)]);
  const pages = [];
  const skipped = [];
  while (queue.length && pages.length < maxPages) {
    const item = queue.shift();
    if (item.via !== 'start') {
      await page.navigate(item.url, 2500);
    }
    let described;
    try {
      described = await describePage(page);
    } catch (error) {
      pages.push({ ...item, error: error.message });
      continue;
    }
    const entry = { ...item, ...described, dialogs: page.dialogs.splice(0) };
    if (screenshots) entry.screenshot = await page.screenshot(path.join(outDir, `page-${pages.length + 1}.png`));
    pages.push(entry);
    fs.writeFileSync(path.join(outDir, `page-${pages.length}.json`), `${JSON.stringify(entry, null, 2)}\n`);
    if (item.depth >= maxDepth) continue;
    for (const link of described.links) {
      if (!link.href || !isCrawlableHost(link.href)) continue;
      if (SIDE_EFFECT_TEXT.test(link.text) || SIDE_EFFECT_URL.test(link.href) || /javascript:/i.test(link.href)) {
        skipped.push({ from: described.url, text: link.text, href: link.href, onclick: link.onclick });
        continue;
      }
      const key = pageKey(link.href);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ url: link.href, depth: item.depth + 1, via: `${described.url} :: ${link.text}` });
    }
  }
  // 走査の終わりに開始ページへ戻す
  await page.navigate(startUrl, 2000).catch(() => {});
  page.close();

  const summary = {
    generatedAt: new Date().toISOString(),
    port,
    startUrl,
    company,
    pageCount: pages.length,
    skippedSideEffectLinks: skipped.length,
    pages: pages.map(p => ({ url: p.url, title: p.title, depth: p.depth, headings: p.headings?.slice(0, 5), forms: p.forms?.length || 0, buttons: p.buttons?.length || 0, links: p.links?.length || 0, frames: p.frames?.length || 0, error: p.error })),
    skipped,
  };
  fs.writeFileSync(path.join(outDir, 'pages.json'), `${JSON.stringify(pages, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'summary.md'), renderMarkdown(summary, pages));
  console.log(JSON.stringify({ ok: true, outDir, pageCount: pages.length, company, skipped: skipped.length }, null, 2));
}

function renderMarkdown(summary, pages) {
  const lines = [`# ヤマトビジネスメンバーズ 走査結果`, '', `- 生成: ${summary.generatedAt}`, `- 開始: ${summary.startUrl}`, `- 会社名確認: ${summary.company.ok ? 'OK' : 'NG'} (${summary.company.company})`, `- ページ数: ${summary.pageCount}`, ''];
  for (const p of pages) {
    lines.push(`## ${p.title || '(無題)'}`, '', `- URL: ${p.url}`, `- 深さ: ${p.depth} / 経路: ${p.via}`);
    if (p.error) {
      lines.push(`- エラー: ${p.error}`, '');
      continue;
    }
    if (p.headings?.length) lines.push(`- 見出し: ${p.headings.slice(0, 8).join(' / ')}`);
    if (p.frames?.length) lines.push(`- フレーム: ${p.frames.map(f => f.src || f.name).join(', ')}`);
    for (const form of p.forms || []) {
      lines.push(`- フォーム ${form.index} ${form.method} ${form.action} ${form.name || form.id}`);
      for (const f of form.fields.filter(f => f.visible || f.tag === 'select').slice(0, 40)) {
        lines.push(`  - ${f.tag}/${f.type} name=${f.name} id=${f.id} label=${f.label}${f.options ? ` options=${f.options.map(o => o.text).join('|')}` : ''}${f.accept ? ` accept=${f.accept}` : ''}`);
      }
    }
    if (p.buttons?.length) lines.push(`- ボタン: ${p.buttons.map(b => `${b.text || b.name || b.id}${b.onclick ? ` (${b.onclick})` : ''}`).join(' / ')}`);
    const menuLinks = (p.links || []).filter(l => l.text).slice(0, 60);
    if (menuLinks.length) lines.push(`- リンク: ${menuLinks.map(l => `${l.text} -> ${l.href}${l.onclick ? ` (${l.onclick})` : ''}`).join('\n  - ')}`);
    lines.push('');
  }
  if (summary.skipped.length) {
    lines.push('## たどらなかった副作用リンク', '');
    for (const s of summary.skipped) lines.push(`- ${s.text} -> ${s.href}${s.onclick ? ` (${s.onclick})` : ''} [from ${s.from}]`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}
