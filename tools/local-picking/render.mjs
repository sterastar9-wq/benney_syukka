// Smart Pick の印刷レイアウト（src/components/PrintablePickingList.tsx と src/app/page.css の @media print）を
// 1枚のHTMLで再現する。Chrome の printToPDF / --print-to-pdf で A4 のPDFにする前提。

import { formatJanDisplay } from './picking-core.mjs';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
@page { size: A4; margin: 60px 0 40px 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; background: #fff; color: #000; }
body { padding: 0 40px; font-family: "Yu Gothic", "YuGothic", "Meiryo", "Hiragino Sans", sans-serif; font-size: 8px; font-weight: bold; line-height: 1.5; }
h2 { text-align: center; font-size: 16px; margin: 0; }
.printable-container span { font-size: 16px; }
.picking-header .row { display: flex; justify-content: space-between; }
.work-log-grid { width: 100%; display: grid; grid-template-columns: repeat(24, 1fr); border: 1px solid #333; margin: 25px 0; }
.work-log-grid > * { border: 1px solid #666; padding: 2px; text-align: center; font-size: 1.1em; display: flex; justify-content: center; align-items: center; }
.work-log-grid .grid-header { grid-column: span 8; background: #f2f2f2; font-size: 1.2em; }
.work-log-grid .grid-label { padding: .5rem; background: #fafafa; white-space: nowrap; }
.work-log-grid .grid-input { padding: .25rem; }
.col-span1 { grid-column: span 1 !important; }
.col-span2 { grid-column: span 2 !important; }
.col-span4 { grid-column: span 4 !important; }
.fs16 { font-size: 1.5rem !important; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; page-break-inside: auto; margin: 0; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; break-inside: avoid; background: #f2f2f2; }
th, td { padding: 8px; border: 1px solid #999; }
thead tr, .footer-row { background: #ddd; }
.body-table tbody tr { background: #fff; }
.body-table tbody tr:nth-child(even) { background: #e0e0e0; }
.check, .count, .case, .box, .other { text-align: center; }
.picking, .selfCheck, .doubleCheck, .assort { writing-mode: vertical-rl; }
.assort, .doubleCheck, .case, .other { writing-mode: vertical-rl; text-orientation: upright; }
thead .assort, thead .doubleCheck, thead .case, thead .other { background: #e6e6e6; }
.breakdown-header { writing-mode: horizontal-tb; text-align: center; background: #e6e6e6; }
td.itemName { padding: 8px 12px; font-size: 11px; line-height: 1.5; white-space: normal; word-break: break-all; }
td.jan, td.count { text-align: center; }
.jan-value, .parent-jan, .count-value, .parent-quantity { font-size: 14px !important; font-weight: bold; }
td.assort, td.picking, td.selfCheck, td.doubleCheck, td.case, td.other { writing-mode: horizontal-tb; }
hr { margin: 16px 0; }
.sub-list { margin-top: 40px; }
.sub-list td.qty, .sub-list td.janc { font-size: 16px; text-align: center; font-weight: bold; }
.sub-list td.sku { font-size: 0.75rem; }
.warnings { border: 2px solid #c00; padding: 6px 10px; margin: 10px 0; font-size: 12px; }
`;

function colGroup() {
  const widths = ['3%', '3%', '3%', '3%', '40%', '7%', '5%', '5%', '5%', '5%'];
  return `<colgroup>${widths.map(w => `<col style="width:${w}">`).join('')}</colgroup>`;
}

function subListTable(title, rows, { quantity, lastHeader, fifthHeader, fifthCell }) {
  if (!rows.length) return '';
  const body = rows.map(item => `
      <tr>
        <td>${esc(item['GoQ管理番号'])}</td>
        <td>${esc(item['送付先氏名'])}</td>
        <td>${esc(item['商品名'])}</td>
        <td class="qty">${esc(quantity(item))}</td>
        ${fifthCell(item)}
        <td class="other"></td>
      </tr>`).join('');
  return `
  <div class="sub-list">
    <h2>${esc(title)}</h2>
    <table class="print-table">
      <thead><tr>
        <th style="width:9%">GoQ管理番号</th>
        <th style="width:15%">送付先氏名</th>
        <th>商品名</th>
        <th style="width:6%">個数</th>
        ${fifthHeader}
        <th class="other" style="width:6%">${esc(lastHeader)}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

export function renderPickingHtml(report, { createdAt, exceptions, sourceLabel } = {}) {
  const janCell = jan => formatJanDisplay(jan, exceptions);
  const rows = report.pickingList.map(item => `
      <tr>
        <td class="assort"></td>
        <td class="picking"></td>
        <td class="selfCheck"></td>
        <td class="doubleCheck"></td>
        <td class="itemName">${esc(item.商品名)}</td>
        <td class="jan"><span class="jan-value">${esc(janCell(item.JANコード))}</span>${item.親JANコード ? `<br><span class="parent-jan">(${esc(janCell(item.親JANコード))})</span>` : ''}</td>
        <td class="count"><span class="count-value">${esc(item.単品換算数)}</span>${item.親数量 && item.親数量 > 0 ? `<br><span class="parent-quantity">(${esc(item.親数量)})</span>` : ''}</td>
        <td class="case"></td>
        <td class="case"></td>
        <td class="other"></td>
      </tr>`).join('');

  const notes = report.shippingNotes.length ? `<span class="shipping-notes"> - ${esc(report.shippingNotes.join(', '))} - </span>` : '';
  const warning = report.anomalyOrders.length
    ? `<div class="warnings">注意：マスタに無い（リストアップ対象外の）注文が ${report.anomalyOrders.length} 件あります。末尾の異常検知リストを確認してください。</div>`
    : '';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>picking-list</title>
<style>${CSS}</style>
</head>
<body>
<div class="printable-container">
  <div class="picking-header">
    <h2>ピッキングリスト</h2>
    <div class="row">
      <div>
        <span><strong>配送方法: </strong>${esc(report.shippingMethod)}</span>${notes}<br>
        <span><strong>作成日時: </strong>${esc(createdAt)}</span>
      </div>
      <div>
        <span>実施者：　　　　　　<br></span>
        <span>確認者：</span>
      </div>
    </div>
  </div>
  ${warning}
  <div class="work-log-grid">
    <div class="grid-header">ピッキング</div>
    <div class="grid-header">箱出し</div>
    <div class="grid-header"></div>
    <div class="grid-label col-span1">時間</div>
    <div class="grid-input col-span4 fs16"></div>
    <div class="grid-label col-span1">個数</div>
    <div class="grid-input col-span2 fs16">${esc(report.totalSingleUnits)}</div>
    <div class="grid-label col-span1">時間</div>
    <div class="grid-input col-span4 fs16"></div>
    <div class="grid-label col-span1">個数</div>
    <div class="grid-input col-span2 fs16">${esc(report.uniqueOrderCount)}</div>
    <div class="grid-label col-span1"></div>
    <div class="grid-input col-span4 fs16"></div>
    <div class="grid-label col-span1"></div>
    <div class="grid-input col-span2 fs16"></div>
  </div>

  <table class="print-table">
    ${colGroup()}
    <thead>
      <tr>
        <th class="assort"></th><th class="picking"></th><th class="selfCheck"></th><th class="doubleCheck"></th>
        <th class="itemName"></th><th class="jan"></th><th class="count"></th>
        <th class="breakdown-header" colspan="3">内訳</th>
      </tr>
      <tr>
        <th class="assort">仕分け</th><th class="picking">ピッキング</th><th class="selfCheck">セルフ</th><th class="doubleCheck">ダブル</th>
        <th class="itemName">商品名</th><th class="jan">JAN</th><th class="count" style="writing-mode:vertical-rl">総個数</th>
        <th class="case">メーカー箱</th><th class="case">1個箱</th><th class="other">バラ</th>
      </tr>
    </thead>
  </table>
  <table class="print-table body-table">
    ${colGroup()}
    <tbody>${rows}</tbody>
  </table>
  <table class="print-table">
    ${colGroup()}
    <tbody><tr>${'<td>&nbsp;</td>'.repeat(10)}</tr></tbody>
  </table>
  <table class="print-table">
    ${colGroup()}
    <tfoot><tr class="footer-row">
      <td class="other">合計</td><td></td><td></td><td></td><td></td><td></td>
      <td class="count"><span class="count-value">${esc(report.totalSingleUnits)}</span></td><td></td><td></td><td></td>
    </tr></tfoot>
  </table>
  <hr>
  ${subListTable('複数個注文リスト', report.multiItemOrders, {
    quantity: item => item.表示個数,
    lastHeader: 'チェック',
    fifthHeader: '<th style="width:10%">JANコード</th>',
    fifthCell: item => `<td class="janc">${esc(janCell(item.JANコード))}</td>`,
  })}
  ${subListTable('JAN確認用リスト', report.janCheckOrders, {
    quantity: item => item.計算後総個数,
    lastHeader: 'チェック',
    fifthHeader: '<th style="width:10%">JANコード</th>',
    fifthCell: item => `<td class="janc">${esc(janCell(item.JANコード))}</td>`,
  })}
  ${subListTable('⚠ 異常検知リスト（マスタ未登録）', report.anomalyOrders, {
    quantity: item => item['個数'],
    lastHeader: '対応',
    fifthHeader: '<th style="width:18%">商品SKU</th>',
    fifthCell: item => `<td class="sku">${esc(item['商品SKU'] || item['商品コード'] || '—')}</td>`,
  })}
  ${sourceLabel ? `<div style="margin-top:16px;font-size:8px;color:#555">${esc(sourceLabel)}</div>` : ''}
</div>
</body>
</html>
`;
}
