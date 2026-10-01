// プリンタ振り分け（ベニー様の現環境）。
// 実際に使うPCのプリンタ名は「C5240 普通紙 / C5240 ヤマト/コンパクト / C5240 ネコポス / C5240 佐川」（2026-10-01 決定。Apeos C5240 用）。
// 接頭辞なしの「普通紙 / ヤマト/コンパクト / ネコポス」は旧機 C3530 用なので使わない。
// Chrome印刷プレビューの送信先名にこの文字列が「含まれる」ことで判定する。
// 別のPCで名前が違う場合は .env の PRINTER_* で上書きする。
import { loadEnv } from './env.mjs';

loadEnv();

export const PICKING_PRINTER = process.env.PRINTER_PICKING || 'C5240 普通紙';

// キーはベニー様の GoQ ステータス（tools/goq-print-flow.mjs の STATUS と同じ）
export const LABEL_PRINTER_BY_STATUS = Object.freeze({
  nekoposu: process.env.PRINTER_NEKOPOSU || 'C5240 ネコポス',   // ★ネコポス・クリックポスト
  takkyubin: process.env.PRINTER_YAMATO || 'C5240 ヤマト/コンパクト',      // ★宅急便
  compact: process.env.PRINTER_COMPACT || 'C5240 ヤマト/コンパクト',   // コンパクト（GOQ_COMPACT_STAT を設定したとき）
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
