// ピッキングのマスタ（GoQ全データ）を読む。
// Smart Pick の /api/sheet-data と同じく、指定タブを1行目から全行、表示値の文字列で取得する。
// 読み取り専用スコープのサービスアカウントで読むので、マスタに書き込むことはない。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseMasterCsv } from './picking-core.mjs';

// ベニー様_ピッキング参照（GoQ全データ仕様）。元版のGoQ全データのIDをここに入れないこと。
export const DEFAULT_MASTER_SHEET_ID = '1XjamST5FsXEP1-SnPZUotp3naU-KFSgOU57YKmbEwo8'; // 2026-09-30 に参照先を変更（旧: 1ymVLW4eAf95RzBAjFWbrrvjZxOM6onKdRqcllfT5z0s）
export const DEFAULT_MASTER_RANGE = 'GoQ全データ';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export function masterConfigFromEnv(env = process.env, cwd = process.cwd()) {
  return {
    spreadsheetId: env.PICKING_MASTER_SHEET_ID || DEFAULT_MASTER_SHEET_ID,
    range: env.PICKING_MASTER_RANGE || DEFAULT_MASTER_RANGE,
    credentialsFile: path.resolve(cwd, env.PICKING_CREDENTIALS_FILE || env.CREDENTIALS_FILE || 'credentials.json'),
    masterCsv: env.PICKING_MASTER_CSV ? path.resolve(cwd, env.PICKING_MASTER_CSV) : '',
  };
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function fetchAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: SCOPE,
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(credentials.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const response = await fetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`サービスアカウントのトークン取得に失敗しました (HTTP ${response.status}): ${body.error_description || body.error || 'unknown'}`);
  }
  return body.access_token;
}

// 元版のGoQ全データ（データ管理②）。ベニー様版では読み先にしない
export const ORIGINAL_GOQ_MASTER_SHEET_ID = '1V_y-3QNZ0DLLdAG9NSgdn4S-934hhRUcQgNVc7Pxc4I';

export async function fetchMasterSheet({ spreadsheetId, range, gid, credentialsFile }) {
  if (spreadsheetId === ORIGINAL_GOQ_MASTER_SHEET_ID) {
    throw new Error('ピッキングのマスタに元版のGoQ全データ（データ管理②）が指定されています。ベニー様シートのIDを指定してください。');
  }
  if (!fs.existsSync(credentialsFile)) {
    throw new Error(`サービスアカウント鍵が見つかりません: ${credentialsFile}`);
  }
  const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  const token = await fetchAccessToken(credentials);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint = response.status === 403 || response.status === 404
      ? `（シートを ${credentials.client_email} に閲覧者で共有しているか確認してください）`
      : '';
    throw new Error(`マスタの取得に失敗しました (HTTP ${response.status}): ${body.error?.message || 'unknown'}${hint}`);
  }
  return {
    values: body.values || [],
    source: { kind: 'sheets-api', spreadsheetId, range: body.range || range, serviceAccount: credentials.client_email },
  };
}

// Googleスプレッドシートの「CSV形式でダウンロード」はBOMなしUTF-8なので、UTF-8として読む
export function loadMasterCsv(file) {
  const values = parseMasterCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  return { values, source: { kind: 'csv', file } };
}

export async function loadMaster(config) {
  if (config.masterCsv) return loadMasterCsv(config.masterCsv);
  return fetchMasterSheet(config);
}

// スプレッドシートURLの gid（sheetId）からタブ名を解決する
export async function resolveSheetTitleByGid({ spreadsheetId, gid, token }) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`マスタのタブ一覧の取得に失敗しました (HTTP ${response.status}): ${body.error?.message || 'unknown'}`);
  }
  const sheet = (body.sheets || []).map(s => s.properties).find(p => String(p.sheetId) === String(gid));
  if (!sheet) {
    throw new Error(`gid=${gid} のタブが見つかりません。存在するタブ: ${(body.sheets || []).map(s => `${s.properties.title}(${s.properties.sheetId})`).join(', ')}`);
  }
  return sheet.title;
}
