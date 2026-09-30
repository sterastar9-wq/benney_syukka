// プリンタ振り分け（ベニー様の現環境）。
// このPCに登録されているプリンタ:
//   FUJIFILM Apeos C5240普通紙 / FUJIFILM Apeos C5240ヤマト / FUJIFILM Apeos C5240佐川 / FUJIFILM Apeos C5240ネコポス（手差し）
// Chrome印刷プレビューの送信先名にこの文字列が「含まれる」ことで判定する。
// 別のPCで名前が違う場合は .env の PRINTER_* で上書きする。
import { loadEnv } from './env.mjs';

loadEnv();

export const PICKING_PRINTER = process.env.PRINTER_PICKING || '普通紙';

export const LABEL_PRINTER_BY_STATUS = Object.freeze({
  sagawa: process.env.PRINTER_SAGAWA || '佐川',
  'hold-sagawa': process.env.PRINTER_SAGAWA || '佐川',
  yamato: process.env.PRINTER_YAMATO || 'ヤマト',
  compact: process.env.PRINTER_YAMATO || 'ヤマト',
  nekoposu: process.env.PRINTER_NEKOPOSU || 'ネコポス',
});

export function labelPrinterForStatus(statusKey) {
  const base = String(statusKey || '').replace(/-amazon$/, '');
  return LABEL_PRINTER_BY_STATUS[base] || '';
}

export function normalizePrinter(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

export function destinationIncludesPrinter(destination, expected) {
  return normalizePrinter(destination).includes(normalizePrinter(expected));
}
