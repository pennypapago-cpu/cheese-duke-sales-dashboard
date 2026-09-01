/**
 * SHOPLINE 官網訂單 -> Google Sheet 自動化週報
 *
 * 資料來源：同一份試算表的「官網訂單」工作表（由 shopline-order-import 流程每日匯入，A~CQ 共 95 欄）
 * 產出：
 *   1. 「SHOPLINE週報」工作表 — 每次執行整份重建，含 KPI／商品排行／來源與 UTM 分析
 *   2. 「SHOPLINE週報歷史」工作表 — 每週一列，累積供儀表板拉趨勢用（同一週重跑會覆蓋該列）
 *
 * 入口函式：
 *   generateWeeklyReport()            產生「上一個完整週」的週報（排程用）
 *   generateWeeklyReportForDate(s)    產生指定日期所屬那一週的週報，例如 '2026/08/24'
 *   installWeeklyTrigger()            安裝每週一早上 9 點自動執行的觸發器
 *   removeWeeklyTriggers()            移除本腳本安裝的週報觸發器
 *
 * 註：本檔刻意使用 ES5 語法且不含反引號，以符合 gas-inject-and-run 的注入限制。
 */

var CONFIG = {
  SPREADSHEET_ID: '14C5m2F05fGC7EcsmmPxbL0Ks4WU-ZHTP3LD4Fs_KZp0',
  SOURCE_SHEET_NAME: '官網訂單',
  REPORT_SHEET_NAME: 'SHOPLINE週報',
  HISTORY_SHEET_NAME: 'SHOPLINE週報歷史',
  TIMEZONE: 'Asia/Taipei',
  HEADER_ROW: 1,
  DATA_START_ROW: 2,
  TOP_N_PRODUCTS: 15,
  TOP_N_UTM: 10,
  /** 訂單狀態含這些關鍵字者不計入營收 */
  EXCLUDED_STATUS_KEYWORDS: ['取消', 'cancel'],
  /** 去年同期採「對齊星期」的 364 天前，而非同一日曆日期 */
  YOY_OFFSET_DAYS: 364,
  TRIGGER_WEEKDAY_HOUR: 9
};

/** 欄位定位：先用標題列比對名稱，找不到才退回 shopline-order-import 的固定欄序 */
var COLUMN_SPEC = {
  cartNumber:  { names: ['購物車編號'], index: 2 },
  orderNumber: { names: ['訂單號碼'], index: 3 },
  status:      { names: ['訂單狀態'], index: 4 },
  orderTotal:  { names: ['訂單合計'], index: 6 },
  source:      { names: ['訂單來源'], index: 18 },
  orderDate:   { names: ['訂單日期'], index: 20 },
  customerId:  { names: ['顧客ID', '顧客 ID'], index: 54 },
  utmSource:   { names: ['UTM來源', 'UTM 來源'], index: 67 },
  utmMedium:   { names: ['UTM媒介', 'UTM 媒介'], index: 68 },
  utmCampaign: { names: ['UTM活動名稱', 'UTM 活動名稱'], index: 70 },
  sku:         { names: ['商品貨號(SKU)', '商品貨號', 'SKU'], index: 74 },
  productName: { names: ['商品名稱'], index: 75 },
  /**
   * 實際的「官網訂單」沒有整行金額欄位，只有單價（商品結帳價）。
   * 因此商品金額一律用「單價 x 數量」計算；只有在表上真的存在整行金額欄時才直接採用。
   */
  itemLineTotal: { names: ['商品合計'], optional: true },
  itemUnitPrice: { names: ['商品結帳價', '商品單價'], index: 79 },
  quantity:      { names: ['數量'], index: 82 }
};

var REPORT_WIDTH = 8;
var COLOR = {
  title: '#f59e0b',
  sectionBg: '#1e293b',
  sectionText: '#f59e0b',
  headerBg: '#e2e8f0',
  meta: '#64748b'
};

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function generateWeeklyReport() {
  var today = todayInTimezone();
  // 上一個完整的週一~週日
  var weekStart = addDays(startOfWeek(today), -7);
  return buildReport(weekStart);
}

function generateWeeklyReportForDate(dateString) {
  var d = parseOrderDate(dateString);
  if (!d) {
    throw new Error('無法解析日期：' + dateString + '（請用 YYYY/MM/DD）');
  }
  return buildReport(startOfWeek(d));
}

function buildReport(weekStart) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var source = ss.getSheetByName(CONFIG.SOURCE_SHEET_NAME);
  if (!source) {
    throw new Error('找不到工作表：' + CONFIG.SOURCE_SHEET_NAME);
  }

  var values = source.getDataRange().getValues();
  if (values.length < CONFIG.DATA_START_ROW) {
    throw new Error(CONFIG.SOURCE_SHEET_NAME + ' 沒有資料列');
  }

  var cols = resolveColumns(values[CONFIG.HEADER_ROW - 1]);
  var orders = buildOrders(values, cols);

  var weekEnd = addDays(weekStart, 6);
  var prevStart = addDays(weekStart, -7);
  var prevEnd = addDays(weekEnd, -7);
  var yoyStart = addDays(weekStart, -CONFIG.YOY_OFFSET_DAYS);
  var yoyEnd = addDays(weekEnd, -CONFIG.YOY_OFFSET_DAYS);

  var cur = summarize(orders, weekStart, weekEnd);
  var prev = summarize(orders, prevStart, prevEnd);
  var yoy = summarize(orders, yoyStart, yoyEnd);

  var period = {
    weekStart: weekStart, weekEnd: weekEnd,
    prevStart: prevStart, prevEnd: prevEnd,
    yoyStart: yoyStart, yoyEnd: yoyEnd
  };

  writeReportSheet(ss, period, cur, prev, yoy);
  updateHistorySheet(ss, period, cur, prev, yoy);

  var msg = '週報完成 ' + fmtDate(weekStart) + '~' + fmtDate(weekEnd) +
            '｜營收 ' + Math.round(cur.revenue) +
            '｜訂單 ' + cur.orderCount +
            '｜件數 ' + cur.units;
  Logger.log(msg);
  return msg;
}

/* ------------------------------------------------------------------ */
/* 資料整理                                                            */
/* ------------------------------------------------------------------ */

function resolveColumns(headerRow) {
  var normalized = [];
  var i;
  for (i = 0; i < headerRow.length; i++) {
    normalized.push(normalizeHeader(headerRow[i]));
  }

  var cols = {};
  for (var key in COLUMN_SPEC) {
    if (!COLUMN_SPEC.hasOwnProperty(key)) continue;
    var spec = COLUMN_SPEC[key];
    var found = -1;
    for (var n = 0; n < spec.names.length && found < 0; n++) {
      var want = normalizeHeader(spec.names[n]);
      for (i = 0; i < normalized.length; i++) {
        if (normalized[i] === want) { found = i; break; }
      }
    }
    if (found >= 0) {
      cols[key] = found;
    } else if (spec.optional) {
      cols[key] = -1;
    } else {
      cols[key] = spec.index;
    }
  }
  return cols;
}

function normalizeHeader(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\s+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .toUpperCase();
}

function buildOrders(values, cols) {
  var map = {};
  var list = [];

  for (var i = CONFIG.DATA_START_ROW - 1; i < values.length; i++) {
    var row = values[i];
    var orderNumber = cellText(row, cols.orderNumber);
    var cartNumber = cellText(row, cols.cartNumber);
    var sku = cellText(row, cols.sku);
    var productName = cellText(row, cols.productName);
    var dateValue = parseOrderDate(row[cols.orderDate]);

    if (!orderNumber && !cartNumber && !sku && !productName && !dateValue) continue;

    var key = orderNumber || cartNumber || ('__row_' + i);
    var order = map[key];
    if (!order) {
      order = {
        key: key,
        orderNumber: orderNumber || cartNumber || key,
        date: dateValue,
        status: cellText(row, cols.status),
        source: cellText(row, cols.source),
        utmSource: cellText(row, cols.utmSource),
        utmMedium: cellText(row, cols.utmMedium),
        utmCampaign: cellText(row, cols.utmCampaign),
        customerId: cellText(row, cols.customerId),
        total: 0,
        hasTotal: false,
        itemAmount: 0,
        units: 0,
        items: []
      };
      map[key] = order;
      list.push(order);
    }

    if (!order.date && dateValue) order.date = dateValue;
    if (!order.status) order.status = cellText(row, cols.status);
    if (!order.source) order.source = cellText(row, cols.source);
    if (!order.utmSource) order.utmSource = cellText(row, cols.utmSource);
    if (!order.utmMedium) order.utmMedium = cellText(row, cols.utmMedium);
    if (!order.utmCampaign) order.utmCampaign = cellText(row, cols.utmCampaign);
    if (!order.customerId) order.customerId = cellText(row, cols.customerId);

    // 訂單合計只填在每筆訂單的第一行，續行留空
    if (!order.hasTotal && cellText(row, cols.orderTotal) !== '') {
      order.total = toNumber(row[cols.orderTotal]);
      order.hasTotal = true;
    }

    if (sku || productName) {
      var qty = toNumber(row[cols.quantity]);
      var amount = itemAmount(row, cols, qty);
      order.units += qty;
      order.itemAmount += amount;
      order.items.push({ sku: sku, name: productName, qty: qty, amount: amount });
    }
  }

  return list;
}

/**
 * 單一商品列的金額。
 * 有整行金額欄（商品合計）就直接用；否則用「商品結帳價 x 數量」。
 * 結帳價已是折後價（見結帳價類型欄），不再另外扣商品折扣金額。
 */
function itemAmount(row, cols, qty) {
  if (cols.itemLineTotal >= 0 && cellText(row, cols.itemLineTotal) !== '') {
    return toNumber(row[cols.itemLineTotal]);
  }
  return toNumber(row[cols.itemUnitPrice]) * qty;
}

function summarize(orders, start, end) {
  var s = {
    revenue: 0,
    orderCount: 0,
    units: 0,
    customerCount: 0,
    products: {},
    sources: {},
    utmPairs: {},
    campaigns: {}
  };
  var customers = {};

  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    if (!o.date) continue;
    if (o.date.getTime() < start.getTime() || o.date.getTime() > end.getTime()) continue;
    if (isCancelled(o.status)) continue;

    var revenue = o.hasTotal ? o.total : o.itemAmount;

    s.revenue += revenue;
    s.orderCount += 1;
    s.units += o.units;

    if (o.customerId) {
      if (!customers[o.customerId]) { customers[o.customerId] = true; s.customerCount += 1; }
    } else {
      s.customerCount += 1;
    }

    bump(s.sources, o.source || '(未標記)', revenue);
    bump(s.utmPairs, (o.utmSource || '(未標記)') + ' / ' + (o.utmMedium || '(未標記)'), revenue);
    bump(s.campaigns, o.utmCampaign || '(未標記)', revenue);

    for (var j = 0; j < o.items.length; j++) {
      var it = o.items[j];
      var pKey = (it.sku || '') + '||' + (it.name || '');
      if (pKey === '||') continue;
      var p = s.products[pKey];
      if (!p) {
        p = { sku: it.sku, name: it.name, units: 0, amount: 0 };
        s.products[pKey] = p;
      }
      p.units += it.qty;
      p.amount += it.amount;
    }
  }

  s.avgOrderValue = s.orderCount ? s.revenue / s.orderCount : 0;
  s.unitsPerOrder = s.orderCount ? s.units / s.orderCount : 0;
  return s;
}

function bump(bucket, key, revenue) {
  var b = bucket[key];
  if (!b) { b = { key: key, orders: 0, revenue: 0 }; bucket[key] = b; }
  b.orders += 1;
  b.revenue += revenue;
}

function isCancelled(status) {
  var s = String(status || '').toLowerCase();
  for (var i = 0; i < CONFIG.EXCLUDED_STATUS_KEYWORDS.length; i++) {
    if (s.indexOf(String(CONFIG.EXCLUDED_STATUS_KEYWORDS[i]).toLowerCase()) >= 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 報表輸出                                                            */
/* ------------------------------------------------------------------ */

function writeReportSheet(ss, period, cur, prev, yoy) {
  var sheet = ss.getSheetByName(CONFIG.REPORT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.REPORT_SHEET_NAME);
  } else {
    sheet.clear();
    clearBandings(sheet);
  }

  var rows = [];
  var ops = { sections: [], tableHeaders: [], money: [], percent: [], integer: [], decimal: [], signedInt: [] };

  var weekLabel = isoWeekYear(period.weekStart) + ' 年第 ' + isoWeekNumber(period.weekStart) + ' 週';

  rows.push(padRow(['SHOPLINE 官網週報']));
  rows.push(padRow(['報表區間', fmtDate(period.weekStart) + ' ~ ' + fmtDate(period.weekEnd), weekLabel]));
  rows.push(padRow(['比較基準',
    '上週 ' + fmtDate(period.prevStart) + '~' + fmtDate(period.prevEnd),
    '去年同期 ' + fmtDate(period.yoyStart) + '~' + fmtDate(period.yoyEnd) + '（對齊星期）']));
  rows.push(padRow(['資料來源', CONFIG.SOURCE_SHEET_NAME + ' 工作表（已排除取消訂單）',
    '產生時間 ' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm')]));
  rows.push(padRow([]));

  /* --- 1. 整體 KPI --- */
  ops.sections.push(rows.length + 1);
  rows.push(padRow(['1. 整體 KPI 與週對週比較']));
  ops.tableHeaders.push(rows.length + 1);
  rows.push(padRow(['指標', '本週', '上週', '週對週', '去年同期', '年對年']));

  var kpis = [
    { label: '營收（訂單合計）', cur: cur.revenue, prev: prev.revenue, yoy: yoy.revenue, fmt: 'money' },
    { label: '訂單數', cur: cur.orderCount, prev: prev.orderCount, yoy: yoy.orderCount, fmt: 'integer' },
    { label: '客單價', cur: cur.avgOrderValue, prev: prev.avgOrderValue, yoy: yoy.avgOrderValue, fmt: 'money' },
    { label: '商品件數', cur: cur.units, prev: prev.units, yoy: yoy.units, fmt: 'integer' },
    { label: '每單件數', cur: cur.unitsPerOrder, prev: prev.unitsPerOrder, yoy: yoy.unitsPerOrder, fmt: 'decimal' },
    { label: '下單顧客數', cur: cur.customerCount, prev: prev.customerCount, yoy: yoy.customerCount, fmt: 'integer' }
  ];

  for (var k = 0; k < kpis.length; k++) {
    var m = kpis[k];
    var r = rows.length + 1;
    rows.push(padRow([m.label, m.cur, m.prev, growth(m.cur, m.prev), m.yoy, growth(m.cur, m.yoy)]));
    ops[m.fmt].push({ row: r, col: 2, numCols: 1 });
    ops[m.fmt].push({ row: r, col: 3, numCols: 1 });
    ops[m.fmt].push({ row: r, col: 5, numCols: 1 });
    ops.percent.push({ row: r, col: 4, numCols: 1 });
    ops.percent.push({ row: r, col: 6, numCols: 1 });
  }
  rows.push(padRow([]));

  /* --- 2. 商品銷售排行 --- */
  ops.sections.push(rows.length + 1);
  rows.push(padRow(['2. 商品銷售排行 Top ' + CONFIG.TOP_N_PRODUCTS + '（依銷售額）']));
  ops.tableHeaders.push(rows.length + 1);
  rows.push(padRow(['排名', '商品貨號', '商品名稱', '本週件數', '本週銷售額', '銷售額佔比', '上週件數', '件數增減']));

  var allProducts = toList(cur.products);
  var products = sortByAmount(allProducts).slice(0, CONFIG.TOP_N_PRODUCTS);
  var productTotal = sumAmount(allProducts);
  if (!products.length) {
    rows.push(padRow(['', '本週無商品銷售資料']));
  }
  for (var p = 0; p < products.length; p++) {
    var item = products[p];
    var prevItem = prev.products[(item.sku || '') + '||' + (item.name || '')];
    var prevUnits = prevItem ? prevItem.units : 0;
    var pr = rows.length + 1;
    rows.push(padRow([
      p + 1, item.sku, item.name, item.units, item.amount,
      productTotal ? item.amount / productTotal : 0,
      prevUnits, item.units - prevUnits
    ]));
    ops.integer.push({ row: pr, col: 4, numCols: 1 });
    ops.money.push({ row: pr, col: 5, numCols: 1 });
    ops.percent.push({ row: pr, col: 6, numCols: 1 });
    ops.integer.push({ row: pr, col: 7, numCols: 1 });
    ops.signedInt.push({ row: pr, col: 8, numCols: 1 });
  }
  rows.push(padRow([]));

  /* --- 3. 訂單來源 --- */
  ops.sections.push(rows.length + 1);
  rows.push(padRow(['3. 訂單來源分析']));
  appendBreakdown(rows, ops, '訂單來源', cur.sources, prev.sources, cur.revenue, 0);
  rows.push(padRow([]));

  /* --- 4. UTM 來源 / 媒介 --- */
  ops.sections.push(rows.length + 1);
  rows.push(padRow(['4. UTM 來源 / 媒介分析（Top ' + CONFIG.TOP_N_UTM + '）']));
  appendBreakdown(rows, ops, 'UTM 來源 / 媒介', cur.utmPairs, prev.utmPairs, cur.revenue, CONFIG.TOP_N_UTM);
  rows.push(padRow([]));

  /* --- 5. UTM 活動 --- */
  ops.sections.push(rows.length + 1);
  rows.push(padRow(['5. UTM 活動 Top ' + CONFIG.TOP_N_UTM]));
  appendBreakdown(rows, ops, 'UTM 活動名稱', cur.campaigns, prev.campaigns, cur.revenue, CONFIG.TOP_N_UTM);

  sheet.getRange(1, 1, rows.length, REPORT_WIDTH).setValues(rows);
  applyReportFormatting(sheet, rows.length, ops);
}

function appendBreakdown(rows, ops, label, curMap, prevMap, curRevenue, limit) {
  ops.tableHeaders.push(rows.length + 1);
  rows.push(padRow([label, '訂單數', '營收', '營收佔比', '上週營收', '週對週']));

  var list = sortByRevenue(toList(curMap));
  if (limit > 0) list = list.slice(0, limit);
  if (!list.length) {
    rows.push(padRow(['', '本週無資料']));
    return;
  }

  for (var i = 0; i < list.length; i++) {
    var b = list[i];
    var prevBucket = prevMap[b.key];
    var prevRevenue = prevBucket ? prevBucket.revenue : 0;
    var r = rows.length + 1;
    rows.push(padRow([
      b.key, b.orders, b.revenue,
      curRevenue ? b.revenue / curRevenue : 0,
      prevRevenue, growth(b.revenue, prevRevenue)
    ]));
    ops.integer.push({ row: r, col: 2, numCols: 1 });
    ops.money.push({ row: r, col: 3, numCols: 1 });
    ops.percent.push({ row: r, col: 4, numCols: 1 });
    ops.money.push({ row: r, col: 5, numCols: 1 });
    ops.percent.push({ row: r, col: 6, numCols: 1 });
  }
}

function applyReportFormatting(sheet, totalRows, ops) {
  sheet.getRange(1, 1, 1, REPORT_WIDTH).merge()
    .setFontSize(16).setFontWeight('bold').setFontColor(COLOR.title);
  sheet.getRange(2, 1, 3, 1).setFontWeight('bold');
  sheet.getRange(2, 1, 3, REPORT_WIDTH).setFontColor(COLOR.meta);

  var i;
  for (i = 0; i < ops.sections.length; i++) {
    sheet.getRange(ops.sections[i], 1, 1, REPORT_WIDTH)
      .setBackground(COLOR.sectionBg).setFontColor(COLOR.sectionText).setFontWeight('bold');
  }
  for (i = 0; i < ops.tableHeaders.length; i++) {
    sheet.getRange(ops.tableHeaders[i], 1, 1, REPORT_WIDTH)
      .setBackground(COLOR.headerBg).setFontWeight('bold');
  }

  applyFormat(sheet, ops.money, '$#,##0');
  applyFormat(sheet, ops.integer, '#,##0');
  applyFormat(sheet, ops.decimal, '0.00');
  applyFormat(sheet, ops.signedInt, '+#,##0;-#,##0;0');
  applyFormat(sheet, ops.percent, '0.0%;[Red]-0.0%;0.0%');

  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 130);
  sheet.setColumnWidth(3, 260);
  for (i = 4; i <= REPORT_WIDTH; i++) sheet.setColumnWidth(i, 110);
  sheet.setFrozenRows(1);
  if (totalRows > 0) sheet.getRange(1, 1, totalRows, REPORT_WIDTH).setVerticalAlignment('middle');
}

function applyFormat(sheet, list, format) {
  for (var i = 0; i < list.length; i++) {
    var op = list[i];
    sheet.getRange(op.row, op.col, 1, op.numCols).setNumberFormat(format);
  }
}

function clearBandings(sheet) {
  var bandings = sheet.getBandings();
  for (var i = 0; i < bandings.length; i++) bandings[i].remove();
}

/* ------------------------------------------------------------------ */
/* 歷史彙總（供儀表板拉趨勢）                                          */
/* ------------------------------------------------------------------ */

function updateHistorySheet(ss, period, cur, prev, yoy) {
  var sheet = ss.getSheetByName(CONFIG.HISTORY_SHEET_NAME);
  var header = ['週別', '起', '迄', '營收', '訂單數', '客單價', '商品件數',
                '下單顧客數', '上週營收', '週對週', '去年同期營收', '年對年', '更新時間'];
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.HISTORY_SHEET_NAME);
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  var weekKey = isoWeekYear(period.weekStart) + '-W' + pad2(isoWeekNumber(period.weekStart));
  var row = [
    weekKey, period.weekStart, period.weekEnd,
    cur.revenue, cur.orderCount, cur.avgOrderValue, cur.units, cur.customerCount,
    prev.revenue, growth(cur.revenue, prev.revenue),
    yoy.revenue, growth(cur.revenue, yoy.revenue),
    new Date()
  ];

  var lastRow = sheet.getLastRow();
  var isNewRow = true;
  var target = lastRow + 1;
  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === weekKey) { target = i + 2; isNewRow = false; break; }
    }
  }

  sheet.getRange(target, 1, 1, row.length).setValues([row]);
  sheet.getRange(target, 2, 1, 2).setNumberFormat('yyyy/mm/dd');
  sheet.getRange(target, 4, 1, 1).setNumberFormat('$#,##0');
  sheet.getRange(target, 5, 1, 1).setNumberFormat('#,##0');
  sheet.getRange(target, 6, 1, 1).setNumberFormat('$#,##0');
  sheet.getRange(target, 7, 1, 2).setNumberFormat('#,##0');
  sheet.getRange(target, 9, 1, 1).setNumberFormat('$#,##0');
  sheet.getRange(target, 10, 1, 1).setNumberFormat('0.0%;[Red]-0.0%;0.0%');
  sheet.getRange(target, 11, 1, 1).setNumberFormat('$#,##0');
  sheet.getRange(target, 12, 1, 1).setNumberFormat('0.0%;[Red]-0.0%;0.0%');
  sheet.getRange(target, 13, 1, 1).setNumberFormat('yyyy/mm/dd hh:mm');

  if (isNewRow && sheet.getLastRow() > 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).sort({ column: 2, ascending: true });
  }
}

/* ------------------------------------------------------------------ */
/* 觸發器與選單                                                        */
/* ------------------------------------------------------------------ */

function installWeeklyTrigger() {
  removeWeeklyTriggers();
  ScriptApp.newTrigger('generateWeeklyReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(CONFIG.TRIGGER_WEEKDAY_HOUR)
    .create();
  var msg = '已安裝觸發器：每週一 ' + CONFIG.TRIGGER_WEEKDAY_HOUR + ' 點自動產生上週週報';
  Logger.log(msg);
  return msg;
}

function removeWeeklyTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'generateWeeklyReport') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed += 1;
    }
  }
  Logger.log('已移除 ' + removed + ' 個週報觸發器');
  return removed;
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('SHOPLINE 週報')
      .addItem('產生上週週報', 'generateWeeklyReport')
      .addItem('產生指定週週報…', 'promptWeeklyReport')
      .addSeparator()
      .addItem('安裝每週一自動排程', 'installWeeklyTrigger')
      .addItem('移除自動排程', 'removeWeeklyTriggers')
      .addToUi();
  } catch (e) {
    // 非繫結試算表執行時沒有 UI，忽略
  }
}

function promptWeeklyReport() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('產生指定週週報', '輸入該週任一天（YYYY/MM/DD）：', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  try {
    ui.alert(generateWeeklyReportForDate(res.getResponseText()));
  } catch (e) {
    ui.alert('產生失敗：' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 工具函式                                                            */
/* ------------------------------------------------------------------ */

function cellText(row, index) {
  if (index === null || index === undefined || index < 0 || index >= row.length) return '';
  var v = row[index];
  if (v === null || v === undefined) return '';
  return String(v).replace(/\u0000/g, '').trim();
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  var s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return 0;
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseOrderDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return null;
    return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  var s = String(v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var t = new Date(s);
  if (!isNaN(t.getTime())) return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  return null;
}

function todayInTimezone() {
  return parseOrderDate(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy/MM/dd'));
}

function startOfWeek(d) {
  var offset = (d.getDay() + 6) % 7; // 週一為一週第一天
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function isoThursday(d) {
  var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);
  return t;
}

function isoWeekNumber(d) {
  var t = isoThursday(d);
  var firstThursday = isoThursday(new Date(t.getFullYear(), 0, 4));
  return 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

function isoWeekYear(d) {
  return isoThursday(d).getFullYear();
}

function fmtDate(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy/MM/dd');
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function growth(cur, prev) {
  if (!prev) return '—';
  return (cur - prev) / prev;
}

function padRow(arr) {
  var r = arr.slice();
  while (r.length < REPORT_WIDTH) r.push('');
  return r;
}

function toList(map) {
  var out = [];
  for (var k in map) {
    if (map.hasOwnProperty(k)) out.push(map[k]);
  }
  return out;
}

function sortByRevenue(list) {
  return list.sort(function (a, b) { return b.revenue - a.revenue; });
}

function sortByAmount(list) {
  return list.sort(function (a, b) { return b.amount - a.amount; });
}

function sumAmount(list) {
  var total = 0;
  for (var i = 0; i < list.length; i++) total += list[i].amount;
  return total;
}
