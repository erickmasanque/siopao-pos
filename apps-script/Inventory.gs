/**
 * Inventory.gs
 * ------------
 * Per-store stock read endpoint + the shared delta applier used by Sales
 * (decrement on sale) and Admin (increment on restock, restore on void).
 *
 * §7.7: inventory may go negative. We never reject a write on under-stock,
 * we just record the new (possibly negative) value. The UI badges
 * "Out" / "Low stock" but stays tappable.
 */

/** Public read endpoint — returns [{item_id, stock}, ...] for one store. */
function getInventory(params) {
  var store_id = params && params.store_id;
  if (!store_id) throw new Error('store_id required');
  return readTable_(TABS.INVENTORY)
    .filter(function (r) { return r.store_id === store_id; })
    .map(function (r) { return { item_id: r.item_id, stock: Number(r.stock) || 0 }; });
}

/**
 * Apply signed deltas to (store_id, item_id) rows in one batch.
 * deltas: { item_id: signed_change } — negative on sale, positive on
 * restock or void-restore.
 *
 * Reads the whole Inventory tab once, mutates in memory, writes back in a
 * single setValues. Cheap and lock-safe. If a (store, item) row doesn't
 * exist yet (e.g. a new item was added but inventory wasn't seeded for it),
 * we append a new row carrying the delta as its initial stock.
 */
function applyInventoryDeltas_(store_id, deltas) {
  var keys = Object.keys(deltas).filter(function (k) { return deltas[k]; });
  if (keys.length === 0) return;

  var sheet = getSheet_(TABS.INVENTORY);
  var cols = SCHEMA[TABS.INVENTORY];
  var lastRow = sheet.getLastRow();

  var storeIdx = colIndex_(cols, 'store_id');
  var itemIdx  = colIndex_(cols, 'item_id');
  var stockIdx = colIndex_(cols, 'stock');
  var updIdx   = colIndex_(cols, 'updated_at');

  var values = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, cols.length).getValues()
    : [];
  var now = new Date();
  var changed = false;
  var toAppend = [];

  keys.forEach(function (item_id) {
    var delta = Number(deltas[item_id]) || 0;
    var found = false;
    for (var i = 0; i < values.length; i++) {
      if (values[i][storeIdx] === store_id && values[i][itemIdx] === item_id) {
        values[i][stockIdx] = (Number(values[i][stockIdx]) || 0) + delta;
        values[i][updIdx] = now;
        found = true;
        changed = true;
        break;
      }
    }
    if (!found) {
      toAppend.push({ store_id: store_id, item_id: item_id, stock: delta, updated_at: now });
    }
  });

  if (changed) {
    sheet.getRange(2, 1, values.length, cols.length).setValues(values);
  }
  if (toAppend.length) {
    appendRows_(TABS.INVENTORY, toAppend);
  }
}

function colIndex_(cols, name) {
  for (var i = 0; i < cols.length; i++) {
    if (cols[i].name === name) return i;
  }
  throw new Error('Unknown column: ' + name);
}
