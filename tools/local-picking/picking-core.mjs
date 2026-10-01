// Smart Pick (https://github.com/ShippingPigFactory/picking-list-app) のピッキング集計をローカルで再現する。
// 対応元: src/app/page.tsx, src/hooks/usePickingLogic.ts, src/utils/itemCalculations.ts,
//         src/utils/janCheckProducts.ts, src/utils/janDisplayHelper.ts, src/components/PickingList.tsx
// 計算結果が Smart Pick と一致することが前提なので、ロジックを変えるときは元コードと突き合わせること。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EXCEPTIONS_FILE = path.join(HERE, 'exceptions.json');
// 送り状の品名コード（短縮名(SET数)JAN下4桁）。商品SKUごと。ベニー様独自の追加機能（Smart Pickには無い）
export const DEFAULT_HINMEI_CODES_FILE = path.join(HERE, '..', '..', 'data', 'hinmei-codes.csv');
// B2クラウドの品名コード欄は2つまでなので、これ以上の商品数の注文はピッキングリストに明細を載せる
export const MANY_ITEM_ORDER_MIN = 3;

// Smart Pick がCSVから取り込む列（page.tsx の validHeaders）
export const ORDER_HEADERS = [
  '注文日時', '配送方法(複数配送先)', 'チェック項目', '販売店舗', 'GoQ管理番号', 'お荷物伝票番号',
  '送付先郵便番号', '送付先住所（全て）', '送付先氏名', '商品名', '個数', 'JANコード',
  '合計金額', '受注番号', '注文者氏名', '商品コード', 'SKU管理番号', '商品URL', '商品SKU',
];

// マスタ(GoQ全データ)の見出し名と、見出しが見つからないときの列番号（usePickingLogic.ts の HEADER_MAP）
const HEADER_MAP = {
  sku: ['商品SKU', 16],
  jan: ['JAN', 5],
  parentAsin: ['親ASIN', 4],
  setCount: ['SET数', 6],
  parentAsin2: ['親ASIN-2', 7],
  parentJan2: ['親JAN-2', 8],
  setCount2: ['SET-2', 9],
  childAsin: ['子ASIN', 10],
  migrationSource: ['引継ぎ元', 21],
  migrationTarget: ['引継ぎ先', 22],
};
const PRODUCT_NAME_HEADER = '親';
const PRODUCT_NAME_DEFAULT_INDEX = 17;
// 有効判定・複数個注文・JAN確認は、見出しに関係なくQ列(16)・G列(6)・F列(5)を見る（page.tsx / itemCalculations.ts）
const FIXED_SKU_INDEX = 16;
const FIXED_SET_INDEX = 6;
const FIXED_JAN_INDEX = 5;

export function loadExceptions(file = DEFAULT_EXCEPTIONS_FILE) {
  if (!file || !fs.existsSync(file)) return { janCheckSkus: {}, janDisplayExceptions: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const janCheckSkus = {};
  for (const sku of raw.janCheckSkus || []) janCheckSkus[String(sku)] = true;
  return { janCheckSkus, janDisplayExceptions: { ...(raw.janDisplayExceptions || {}) } };
}

// GoQのCSVは Shift_JIS なので、文字列ではなくバイト列のまま読んでから decodeCsvBuffer で変換する
export function readCsvBytes(file) {
  return fs.readFileSync(file /* Buffer: Shift_JIS のため utf8 指定しない */);
}

// GoQのCSVは Shift_JIS。BOM付きUTF-8で来た場合だけUTF-8として読む。
export function decodeCsvBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('shift_jis').decode(bytes);
}

// RFC 4180 形式のCSVを2次元配列にする（引用符内の改行・カンマ・"" に対応）
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// papaparse の header:true, skipEmptyLines:true 相当。Smart Pick と同じく ORDER_HEADERS の列だけを残す。
export function parseOrdersCsv(text) {
  const rows = parseCsvRows(text).filter(r => !(r.length === 1 && r[0] === ''));
  if (!rows.length) return { orders: [], headers: [], missingHeaders: ORDER_HEADERS.slice() };
  const headers = rows[0];
  const index = new Map(headers.map((h, i) => [h, i]));
  const orders = rows.slice(1).map(r => {
    const item = {};
    for (const h of ORDER_HEADERS) item[h] = index.has(h) ? (r[index.get(h)] ?? '') : undefined;
    return item;
  });
  return { orders, headers, missingHeaders: ORDER_HEADERS.filter(h => !index.has(h)) };
}

// マスタCSV（GoQ全データを1行目からCSVにしたもの）を Sheets API の values と同じ形にする
export function parseMasterCsv(text) {
  return parseCsvRows(text).map(r => {
    const trimmed = r.slice();
    while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
    return trimmed;
  });
}

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function findBySku(sheet, index, ...keys) {
  for (const key of keys) {
    if (!key) continue;
    const found = sheet.find(r => lower(r[index]) === key.toLowerCase());
    if (found) return found;
  }
  return undefined;
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

export function formatJanDisplay(janCode, exceptions) {
  if (!janCode) return '';
  const normalized = janCode.trim();
  const mapped = exceptions.janDisplayExceptions[normalized];
  if (mapped) return mapped.trim().slice(-4);
  return normalized.slice(-4);
}

function isJanCheckRequired(item, exceptions) {
  const sku = item['商品SKU'];
  if (!sku) return false;
  return exceptions.janCheckSkus[sku] === true;
}

function calculateSetCount(item, sheet) {
  const qRow = findBySku(sheet, FIXED_SKU_INDEX, item['商品SKU'], item['SKU管理番号']);
  return qRow ? toInt(qRow[FIXED_SET_INDEX] || '1', NaN) : 1;
}

function findJanCode(item, sheet) {
  const qRow = findBySku(sheet, FIXED_SKU_INDEX, item['商品SKU'], item['SKU管理番号']);
  return qRow ? (qRow[FIXED_JAN_INDEX] || '') : '';
}

// Smart Pick は1行目を見出しとして探し、無ければ既定の列番号を使う。GoQ全データは1行目がメモなので、実際は常に既定の列番号になる。
function resolveColumns(sheet) {
  const headers = sheet[0] || [];
  const columns = {};
  for (const [key, [name, fallback]] of Object.entries(HEADER_MAP)) {
    const idx = headers.indexOf(name);
    columns[key] = idx === -1 ? fallback : idx;
  }
  const nameIdx = headers.lastIndexOf(PRODUCT_NAME_HEADER);
  columns.productName = nameIdx !== -1 ? nameIdx : PRODUCT_NAME_DEFAULT_INDEX;
  return { columns, warnings: [] };
}

// GoQ全データの3行目（見出し行）で、既定の列番号の位置に想定どおりの見出しがあるかを確かめる。
// 列が挿入・削除されてずれると、数量やJANを別の列から読んで誤ったピッキングになるため、呼び出し側で止める。
const LAYOUT_CHECKS = [
  [FIXED_SKU_INDEX, '商品SKU'], [FIXED_JAN_INDEX, 'JAN'], [4, '親ASIN'], [FIXED_SET_INDEX, 'SET数'],
  [7, '親ASIN-2'], [8, '親JAN-2'], [9, 'SET-2'], [10, '子ASIN'], [PRODUCT_NAME_DEFAULT_INDEX, '親'],
];
export const MASTER_HEADER_ROW_INDEX = 2;

export function checkMasterLayout(sheet) {
  const headerRow = sheet[MASTER_HEADER_ROW_INDEX] || [];
  const mismatches = LAYOUT_CHECKS
    .filter(([idx, name]) => String(headerRow[idx] ?? '').trim() !== name)
    .map(([idx, name]) => ({ column: String.fromCharCode(65 + idx), expected: name, actual: headerRow[idx] ?? '' }));
  return { ok: mismatches.length === 0, mismatches };
}

// usePickingLogic.ts と同じ集計
function buildPickingList(validOrders, sheet) {
  if (!sheet || sheet.length === 0) return { list: [], totalSingleUnits: 0, columns: null, warnings: ['マスタが空です'] };
  const { columns, warnings } = resolveColumns(sheet);
  const map = new Map();
  for (const item of validOrders) {
    const productNameForItem = item['商品名'];
    const csvCount = toInt(item['個数'], 0) || 0;
    if (csvCount === 0) continue;

    let jan = '';
    let parentJan;
    let setCount = 1;
    let productName = productNameForItem;
    let parentQuantity;

    let qRow = findBySku(sheet, columns.sku, item['商品SKU'], item['SKU管理番号']);
    if (qRow) {
      const sourceValue = qRow[columns.migrationSource];
      if (sourceValue && sourceValue.trim() !== '') {
        const targetRow = sheet.find(r => r[columns.migrationTarget] === sourceValue);
        if (targetRow) qRow = targetRow;
      }
    }
    if (qRow) {
      const parentAsin = qRow[columns.parentAsin2];
      if (parentAsin && parentAsin.trim() !== '') {
        parentJan = qRow[columns.parentJan2];
        const parentSetCount = toInt(qRow[columns.setCount2] || '1', NaN);
        parentQuantity = parentSetCount * csvCount;
      }
      jan = qRow[columns.jan];
      setCount = toInt(qRow[columns.setCount] || '1', NaN);
      productName = qRow[columns.productName] || productNameForItem;
    }

    const singleUnits = setCount * csvCount;
    const key = jan || productName;
    if (map.has(key)) {
      const ex = map.get(key);
      ex.個数 += csvCount;
      ex.単品換算数 += singleUnits;
      ex.親数量 = (ex.親数量 || 0) + (parentQuantity || 0);
    } else {
      map.set(key, {
        商品名: productName,
        JANコード: jan,
        親JANコード: parentJan,
        個数: csvCount,
        単品換算数: singleUnits,
        親数量: parentQuantity,
      });
    }
  }
  const list = Array.from(map.values());
  const totalSingleUnits = list.reduce((sum, item) => {
    const isSet = item.親JANコード && item.親JANコード.trim() !== '';
    return isSet ? sum + item.個数 : sum + item.単品換算数;
  }, 0);
  return { list, totalSingleUnits, columns, warnings };
}

// PickingList.tsx の既定ソート（JAN表示4桁 → 商品名）
function sortPickingList(list, exceptions) {
  return [...list].sort((a, b) => {
    const janCompare = formatJanDisplay(a.JANコード, exceptions).localeCompare(
      formatJanDisplay(b.JANコード, exceptions), 'ja', { numeric: true },
    );
    return janCompare || String(a.商品名 ?? '').localeCompare(String(b.商品名 ?? ''), 'ja');
  });
}

// data/hinmei-codes.csv を { 小文字の商品SKU → 品名コード } にする（無ければ空）
export function loadHinmeiCodes(file = DEFAULT_HINMEI_CODES_FILE) {
  const map = new Map();
  if (!file || !fs.existsSync(file)) return map;
  const rows = parseCsvRows(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const header = rows[0] || [];
  const skuIdx = header.indexOf('商品SKU');
  const codeIdx = header.indexOf('品名コード');
  if (skuIdx === -1 || codeIdx === -1) return map;
  for (const r of rows.slice(1)) {
    const sku = (r[skuIdx] || '').trim();
    const code = (r[codeIdx] || '').trim();
    if (sku && code) map.set(sku.toLowerCase(), code);
  }
  return map;
}

// 商品が MANY_ITEM_ORDER_MIN 品以上の注文（B2の品名コード欄に入りきらない）を、注文ごとの明細にする。ベニー様独自。
function buildManyItemOrders(orders, sheet, hinmeiCodes, minItems = MANY_ITEM_ORDER_MIN) {
  const byOrder = new Map();
  for (const item of orders) {
    const id = (item['GoQ管理番号'] || '').trim();
    if (!id) continue;
    if (!byOrder.has(id)) byOrder.set(id, []);
    byOrder.get(id).push(item);
  }
  const lookupCode = item => {
    for (const key of [item['商品SKU'], item['SKU管理番号'], item['商品コード']]) {
      const code = key && hinmeiCodes.get(key.trim().toLowerCase());
      if (code) return code;
    }
    return '';
  };
  const result = [];
  for (const [goqId, items] of byOrder) {
    if (items.length < minItems) continue;
    result.push({
      GoQ管理番号: goqId,
      送付先氏名: items[0]['送付先氏名'] || '',
      受注番号: items[0]['受注番号'] || '',
      items: items.map(item => {
        const count = toInt(item['個数'], 0) || 0;
        const setCount = calculateSetCount(item, sheet);
        return {
          商品SKU: item['商品SKU'] || item['SKU管理番号'] || item['商品コード'] || '',
          商品名: item['商品名'] || '',
          個数: count,
          SET数: setCount,
          単品数: setCount * count,
          JANコード: findJanCode(item, sheet) || '',
          品名コード: lookupCode(item),
        };
      }),
    });
  }
  return result.sort((a, b) => a.GoQ管理番号.localeCompare(b.GoQ管理番号, 'ja', { numeric: true }));
}

export function buildPickingReport(orders, sheet, exceptions = loadExceptions(), { hinmeiCodes = new Map() } = {}) {
  const skuMatches = key => key && sheet.some(r => lower(r[FIXED_SKU_INDEX]) === key.toLowerCase());
  const validOrders = orders.filter(item => skuMatches(item['商品コード']) || skuMatches(item['商品SKU']));
  const anomalyOrders = orders.filter(item => !validOrders.includes(item));

  const withSheetValues = item => ({
    ...item,
    JANコード: findJanCode(item, sheet) || '',
    計算後総個数: calculateSetCount(item, sheet) * (toInt(item['個数'], 0) || 0),
  });

  const multiItemOrders = orders.map(withSheetValues).filter(item => {
    if (isJanCheckRequired(item, exceptions)) return item.計算後総個数 >= 2;
    return (toInt(item['個数'], 0) || 0) >= 2;
  }).map(item => ({
    ...item,
    表示個数: isJanCheckRequired(item, exceptions) ? item.計算後総個数 : item['個数'],
  }));
  const janCheckOrders = orders.filter(item => isJanCheckRequired(item, exceptions)).map(withSheetValues);

  const notes = new Set();
  for (const row of orders) {
    const note = row['チェック項目'];
    if (note && note.trim() !== '') notes.add(note.trim());
  }
  const uniqueOrderCount = new Set(
    orders.map(item => item['GoQ管理番号']).filter(v => v && v.trim() !== ''),
  ).size;

  const picking = buildPickingList(validOrders, sheet);
  return {
    shippingMethod: orders.length ? (orders[0]['配送方法(複数配送先)'] ?? '') : '',
    shippingNotes: Array.from(notes),
    uniqueOrderCount,
    orderRowCount: orders.length,
    pickingList: sortPickingList(picking.list, exceptions),
    totalSingleUnits: picking.totalSingleUnits,
    multiItemOrders,
    janCheckOrders,
    anomalyOrders,
    manyItemOrders: buildManyItemOrders(orders, sheet, hinmeiCodes),
    masterColumns: picking.columns,
    masterWarnings: picking.warnings,
    masterRowCount: sheet.length,
  };
}
