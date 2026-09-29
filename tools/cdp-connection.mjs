import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CONTAINER_WORKSPACE = '/workspace';

export function cdpHost() {
  return process.env.GOQ_CDP_HOST || process.env.CDP_HOST || DEFAULT_CDP_HOST;
}

export function cdpHttpUrl(port, path) {
  const normalizedPath = String(path || '').startsWith('/') ? path : `/${path || ''}`;
  return `http://${cdpHost()}:${port}${normalizedPath}`;
}

export function cdpWebSocketUrl(url) {
  const host = cdpHost();
  if (host === DEFAULT_CDP_HOST) return url;

  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.toString();
}

export function pathForBrowser(filePath) {
  const hostWorkspace = process.env.GOQ_HOST_WORKSPACE;
  if (!hostWorkspace) return filePath;

  const containerWorkspace = path.resolve(process.env.GOQ_CONTAINER_WORKSPACE || DEFAULT_CONTAINER_WORKSPACE);
  const resolved = path.resolve(filePath);
  if (resolved !== containerWorkspace && !resolved.startsWith(`${containerWorkspace}${path.sep}`)) {
    return filePath;
  }

  const relativePath = path.relative(containerWorkspace, resolved);
  return path.win32.join(hostWorkspace, ...relativePath.split(path.sep));
}

export function fileUrlForBrowser(filePath) {
  const browserPath = pathForBrowser(filePath);
  if (/^[A-Za-z]:[\\/]/.test(browserPath)) {
    const normalized = browserPath.replace(/\\/g, '/');
    const drive = normalized[0].toUpperCase();
    const rest = normalized.slice(2).split('/').map(encodeURIComponent).join('/');
    return `file:///${drive}:${rest}`;
  }
  return pathToFileURL(path.resolve(browserPath)).href;
}
