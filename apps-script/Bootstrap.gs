/**
 * Bootstrap.gs
 * ------------
 * Idempotent workbook setup + one-off dev seed helpers.
 *
 * Behavior:
 *   - For each tab in SCHEMA: create if missing, write header row if missing,
 *     and apply seed rows only when the tab was just created (so re-running
 *     never duplicates seed data or overwrites real data).
 *   - For Inventory: seed one row per (active store × every item) at stock=0
 *     ONLY if the Inventory tab was freshly created.
 *
 * How to run:
 *   Open the Apps Script editor → select function setupWorkbook → Run.
 *   First run prompts for permissions. Subsequent runs are no-ops on
 *   existing tabs.
 */

function setupWorkbook() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('No active spreadsheet. Open the Sheet, then run setupWorkbook from its bound script.');
  }

  var created = {};
  Object.keys(SCHEMA).forEach(function (tabName) {
    created[tabName] = ensureTab_(ss, tabName);
  });

  Object.keys(SEED).forEach(function (tabName) {
    if (created[tabName]) {
      appendRows_(tabName, SEED[tabName]);
    }
  });

  if (created[TABS.INVENTORY]) {
    seedInventory_();
  }

  removeDefaultSheetIfEmpty_(ss);

  if (SpreadsheetApp.getUi) {
    try { SpreadsheetApp.getUi().alert('Workbook setup complete.'); return; } catch (e) {}
  }
  Logger.log('Workbook setup complete.');
}

/**
 * Ensure a tab exists with the correct header row.
 * Returns true if the tab was created this call (i.e. it's brand new and
 * therefore eligible for seeding), false if it already existed.
 */
function ensureTab_(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  var isNew = !sheet;
  if (isNew) {
    sheet = ss.insertSheet(tabName);
  }
  var headers = headersFor_(tabName);
  var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var headersMatch = headers.every(function (h, i) { return firstRow[i] === h; });
  if (!headersMatch) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return isNew;
}

/**
 * Seed Inventory with (store × item) rows at stock=0.
 * Only called when Inventory tab is freshly created — Stores + Items may
 * already have data from prior partial setup, so we read them live.
 */
function seedInventory_() {
  var stores = readTable_(TABS.STORES).filter(function (s) { return s.active; });
  var items  = readTable_(TABS.ITEMS);
  var now = new Date();
  var rows = [];
  stores.forEach(function (s) {
    items.forEach(function (it) {
      rows.push({ store_id: s.store_id, item_id: it.item_id, stock: 0, updated_at: now });
    });
  });
  appendRows_(TABS.INVENTORY, rows);
}

function removeDefaultSheetIfEmpty_(ss) {
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() <= 1 && def.getLastColumn() <= 1 && ss.getSheets().length > 1) {
    ss.deleteSheet(def);
  }
}

/**
 * One-time bootstrap: write the admin username + password hash into
 * Script Properties. Edit USERNAME / PASSWORD below, then Run.
 *
 * Re-run any time to change the password. The function name carries _dev
 * because in a hardened deploy you'd remove it after first use — it
 * exists only because the admin UI itself needs valid credentials before
 * it can change them.
 */
function setupAdminPassword_dev() {
  var USERNAME = 'admin';        // change before running if you want
  var PASSWORD = 'changeme123';  // ALWAYS change before running

  if (!PASSWORD || PASSWORD === 'changeme123') {
    throw new Error('Edit PASSWORD inside setupAdminPassword_dev to a real value before running.');
  }

  var salt = generateSalt_();
  var hash = hashPin_(PASSWORD, salt);
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_USERNAME', USERNAME);
  props.setProperty('ADMIN_PASS_HASH', hash);
  props.setProperty('ADMIN_PASS_SALT', salt);
  Logger.log('Admin credentials saved. username=' + USERNAME + '. The hash & salt are stored in Script Properties; clear the editor logs so the plaintext password does not linger.');
}
