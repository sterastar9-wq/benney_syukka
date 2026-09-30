// リポジトリ直下の .env を読む（依存パッケージなし）。
// 認証情報は Windows 資格情報マネージャーではなく .env に統一する（ベニー様版の方針）。
// 既に process.env にある値は上書きしない。
import fs from 'node:fs';
import path from 'node:path';

let loaded = false;

export function repoRoot() {
  return path.resolve(process.env.GOQ_REPO_ROOT || process.cwd());
}

export function envFilePath() {
  return process.env.GOQ_ENV_FILE ? path.resolve(process.env.GOQ_ENV_FILE) : path.join(repoRoot(), '.env');
}

export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv({ force = false } = {}) {
  if (loaded && !force) return { file: envFilePath(), loaded: true };
  const file = envFilePath();
  if (!fs.existsSync(file)) {
    loaded = true;
    return { file, loaded: false, reason: '.env not found' };
  }
  const values = parseEnv(fs.readFileSync(file, 'utf8'));
  const applied = [];
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      applied.push(key);
    }
  }
  loaded = true;
  return { file, loaded: true, keys: Object.keys(values), applied };
}

// 値を返さずに「設定されているか」だけを確認する（ログや報告にパスワードを出さないため）
export function requireEnv(keys) {
  loadEnv();
  const missing = keys.filter(key => !process.env[key]);
  if (missing.length) {
    throw new Error(`.env に次のキーがありません: ${missing.join(', ')} (${envFilePath()})`);
  }
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

export function envStatus(keys) {
  loadEnv();
  return Object.fromEntries(keys.map(key => [key, process.env[key] ? 'set' : 'missing']));
}

export function envNumber(key, fallback) {
  loadEnv();
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
