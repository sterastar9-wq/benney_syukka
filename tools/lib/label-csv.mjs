// GoQ から出力した送り状データCSV（B2クラウド形式・Shift_JIS）を対象注文と突合する。
// 印刷フロー（goq-print-flow.mjs）と回帰テスト（selftest-b2-csv.mjs）で共用する。
import fs from 'node:fs';

export const LABEL_MODE_B2_CSV = 'b2-csv';

export function decodeCsvBuffer(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
  }
  return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      // CRLF の CR は無視
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cellMatches(cell, value) {
  if (!value) return false;
  const c = String(cell || '').trim();
  return c === value || c.startsWith(`${value}-`) || c.endsWith(`-${value}`);
}

// 各データ行は GoQ番号 または 注文番号 をどこかのセルに含む必要がある（お客様管理番号の列位置に依存しない）。
// 対象外の行が混ざっていたら ok=false。複数個口で同じ注文が複数行になるのは許容する。
export function verifyLabelCsvText(text, targets, { encoding = 'unknown', file = '' } = {}) {
  const rows = parseCsv(text).filter(row => row.some(cell => String(cell || '').trim() !== ''));
  const header = rows.length && rows[0].some(cell => /番号|コード|名|住所|電話/.test(cell)) && !rows[0].some(cell => targets.some(t => cellMatches(cell, t.goqId)))
    ? rows[0]
    : null;
  const dataRows = header ? rows.slice(1) : rows;
  const matched = [];
  const unmatchedRows = [];
  const targetHits = new Map(targets.map(target => [target.goqId, 0]));
  dataRows.forEach((row, index) => {
    const target = targets.find(t => row.some(cell => cellMatches(cell, t.goqId) || cellMatches(cell, t.orderNumber)));
    if (!target) {
      unmatchedRows.push({ rowIndex: index + 1, sample: row.slice(0, 6).map(cell => String(cell || '').slice(0, 20)) });
      return;
    }
    targetHits.set(target.goqId, targetHits.get(target.goqId) + 1);
    matched.push({ rowIndex: index + 1, goqId: target.goqId, orderNumber: target.orderNumber });
  });
  const missingTargets = targets.filter(target => !targetHits.get(target.goqId)).map(target => ({ goqId: target.goqId, orderNumber: target.orderNumber }));
  return {
    ok: missingTargets.length === 0 && unmatchedRows.length === 0 && dataRows.length > 0,
    mode: LABEL_MODE_B2_CSV,
    checkedAt: new Date().toISOString(),
    file,
    encoding,
    header: header ? header.map(cell => String(cell || '').trim()).slice(0, 80) : null,
    dataRowCount: dataRows.length,
    targetCount: targets.length,
    issuedCount: targets.length - missingTargets.length,
    foundCount: targets.length - missingTargets.length,
    issued: matched,
    unissued: missingTargets,
    unmatchedRows,
    rowsPerTarget: Object.fromEntries(targetHits),
  };
}

export function verifyLabelCsvFile(file, targets) {
  const bytes = fs.readFileSync(file /* Buffer: Shift_JIS のため utf8 指定しない */);
  const { text, encoding } = decodeCsvBuffer(bytes);
  return verifyLabelCsvText(text, targets, { encoding, file });
}
