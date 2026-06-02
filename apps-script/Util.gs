/**
 * Util.gs
 * --------
 * Shared helpers used by every endpoint module: sheet IO keyed by SCHEMA,
 * script-lock wrapper for mutations, JSON response builders, and currency
 * rounding per D11 (half-up to the centavo).
 *
 * All read/write helpers operate on the active spreadsheet (the script is
 * container-bound). Never call SpreadsheetApp.openById — that would break
 * the bound-script contract and force an extra OAuth scope.
 */

function getSheet_(tabName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sheet) {
    throw new Error('Tab not found: ' + tabName + '. Run setupWorkbook first.');
  }
  return sheet;
}

/**
 * Read a whole tab as an array of objects keyed by SCHEMA column names.
 * Returns [] for an empty tab (header-only).
 */
function readTable_(tabName) {
  var sheet = getSheet_(tabName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var cols = SCHEMA[tabName];
  var values = sheet.getRange(2, 1, lastRow - 1, cols.length).getValues();
  return values.map(function (row) {
    var obj = {};
    cols.forEach(function (c, i) { obj[c.name] = row[i]; });
    return obj;
  });
}

/**
 * Find the 1-indexed sheet row where `key` column equals `value`,
 * or -1 if not found. Header row is row 1; data starts at row 2.
 */
function findRowIndex_(tabName, key, value) {
  var sheet = getSheet_(tabName);
  var cols = SCHEMA[tabName];
  var keyColIdx = -1;
  for (var i = 0; i < cols.length; i++) {
    if (cols[i].name === key) { keyColIdx = i; break; }
  }
  if (keyColIdx < 0) throw new Error('Unknown column ' + key + ' on ' + tabName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var colValues = sheet.getRange(2, keyColIdx + 1, lastRow - 1, 1).getValues();
  for (var r = 0; r < colValues.length; r++) {
    if (colValues[r][0] === value) return r + 2;
  }
  return -1;
}

/**
 * Look up a single row by key. Returns the row as an object (with a
 * non-column `_row` field carrying the 1-indexed sheet row, useful for
 * subsequent updateRow_ calls), or null if not found.
 */
function getRowByKey_(tabName, key, value) {
  var rowIdx = findRowIndex_(tabName, key, value);
  if (rowIdx < 0) return null;
  var sheet = getSheet_(tabName);
  var cols = SCHEMA[tabName];
  var values = sheet.getRange(rowIdx, 1, 1, cols.length).getValues()[0];
  var obj = { _row: rowIdx };
  cols.forEach(function (c, i) { obj[c.name] = values[i]; });
  return obj;
}

/** Append a single object as a row, in SCHEMA column order. */
function appendRow_(tabName, obj) {
  var sheet = getSheet_(tabName);
  var cols = SCHEMA[tabName];
  var row = cols.map(function (c) {
    var v = obj[c.name];
    return (v === undefined || v === null) ? '' : v;
  });
  sheet.appendRow(row);
}

/** Append many objects at once — much cheaper than N appendRow_ calls. */
function appendRows_(tabName, objects) {
  if (!objects || !objects.length) return;
  var sheet = getSheet_(tabName);
  var cols = SCHEMA[tabName];
  var values = objects.map(function (obj) {
    return cols.map(function (c) {
      var v = obj[c.name];
      return (v === undefined || v === null) ? '' : v;
    });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, cols.length).setValues(values);
}

/**
 * Patch select fields on the row at `rowIdx`. Unspecified fields are left
 * untouched. Pass-through for values; do any type coercion (Date, Number)
 * at the callsite so the stored type is explicit.
 */
function updateRow_(tabName, rowIdx, updates) {
  var sheet = getSheet_(tabName);
  var cols = SCHEMA[tabName];
  var current = sheet.getRange(rowIdx, 1, 1, cols.length).getValues()[0];
  cols.forEach(function (c, i) {
    if (Object.prototype.hasOwnProperty.call(updates, c.name)) {
      var v = updates[c.name];
      current[i] = (v === undefined || v === null) ? '' : v;
    }
  });
  sheet.getRange(rowIdx, 1, 1, cols.length).setValues([current]);
}

/**
 * Wrap a mutation in a script-wide lock. Required for anything that
 * reads-then-writes (idempotency checks, inventory deltas, active-shift
 * gating) so concurrent calls don't race on the sheet.
 */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Half-up to the centavo per spec D11. */
function roundCentavo_(n) {
  var num = Number(n);
  if (!isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

/** JSON success response. */
function jsonOk_(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** JSON error response. `code` is an optional short tag for client routing. */
function jsonErr_(msg, code) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: String(msg), code: code || 'ERROR' }))
    .setMimeType(ContentService.MimeType.JSON);
}
