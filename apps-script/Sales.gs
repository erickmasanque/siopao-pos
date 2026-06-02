/**
 * Sales.gs
 * --------
 * The single mutating endpoint sellers hit on every transaction.
 *
 * Contract (per §8.1 and D8/D9):
 *   - Idempotent on sale_id. A duplicate POST returns {duplicate:true}
 *     and does NOT re-deduct inventory. This lets the offline queue
 *     retry safely without the server tracking client retries.
 *   - Bundle validation: every line of type=bundle whose includes_siopao_qty>0
 *     MUST carry a chosen_siopao referencing an ACTIVE category=siopao item.
 *     Rejected with an error if not — defends against tampered offline payloads.
 *   - Inventory deltas are computed from the items_json (expanding bundles to
 *     their per-piece costs) and applied AFTER the sale row is written.
 *     Ordering matters: see comment below.
 */

function submitSale(params) {
  return withLock_(function () {
    var sale = params || {};
    if (!sale.sale_id) throw new Error('sale_id required');

    // Idempotency: a second call with the same sale_id is a no-op.
    var existing = getRowByKey_(TABS.SALES, 'sale_id', sale.sale_id);
    if (existing) {
      return { ok: true, duplicate: true, sale_id: sale.sale_id };
    }

    // Required-field check before any work.
    ['timestamp', 'store_id', 'seller_id', 'shift_id', 'items_json', 'subtotal', 'payment_method']
      .forEach(function (f) {
        if (sale[f] === undefined || sale[f] === null || sale[f] === '') {
          throw new Error('Missing field: ' + f);
        }
      });
    if (sale.payment_method !== 'cash' && sale.payment_method !== 'gcash') {
      throw new Error('payment_method must be cash or gcash');
    }

    // Accept items_json as either a JSON string (offline-queue payload) or
    // an already-parsed array (direct server caller).
    var items = (typeof sale.items_json === 'string')
      ? JSON.parse(sale.items_json)
      : sale.items_json;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('items_json must be a non-empty array');
    }

    // Bundle flavor validation (D8) — guard against tampered payloads.
    var activeSiopaoIds = readTable_(TABS.ITEMS)
      .filter(function (i) { return i.active && i.category === 'siopao'; })
      .map(function (i) { return i.item_id; });

    var bundleMap = {};
    readTable_(TABS.BUNDLES).forEach(function (b) { bundleMap[b.bundle_id] = b; });

    var deltas = {};
    items.forEach(function (line) {
      var qty = Number(line.qty) || 0;
      if (qty <= 0) throw new Error('Line qty must be positive: ' + JSON.stringify(line));

      if (line.type === 'item') {
        if (!line.id) throw new Error('Item line missing id');
        deltas[line.id] = (deltas[line.id] || 0) - qty;

      } else if (line.type === 'bundle') {
        var b = bundleMap[line.id];
        if (!b) throw new Error('Unknown bundle: ' + line.id);
        var sQty = Number(b.includes_siopao_qty) || 0;
        var gQty = Number(b.includes_gulaman_qty) || 0;

        if (sQty > 0) {
          if (!line.chosen_siopao) {
            throw new Error('Bundle ' + line.id + ' requires chosen_siopao');
          }
          if (activeSiopaoIds.indexOf(line.chosen_siopao) < 0) {
            throw new Error('Invalid chosen_siopao: ' + line.chosen_siopao);
          }
          deltas[line.chosen_siopao] = (deltas[line.chosen_siopao] || 0) - (sQty * qty);
        }
        if (gQty > 0) {
          deltas['gulaman'] = (deltas['gulaman'] || 0) - (gQty * qty);
        }

      } else {
        throw new Error('Unknown line type: ' + line.type);
      }
    });

    // Order: write the sale row FIRST, THEN apply inventory deltas.
    // Rationale: if the inventory write fails after the sale write,
    // idempotency on retry returns duplicate=true and skips the second
    // delta apply — so we'd be left with an under-deducted inventory
    // (detectable by admin). The reverse order would risk a double-
    // deduction on retry, which is the harder failure to recover from.
    var itemsJsonStr = (typeof sale.items_json === 'string')
      ? sale.items_json
      : JSON.stringify(items);

    appendRow_(TABS.SALES, {
      sale_id: sale.sale_id,
      timestamp: parseTimestamp_(sale.timestamp),
      store_id: sale.store_id,
      seller_id: sale.seller_id,
      shift_id: sale.shift_id,
      items_json: itemsJsonStr,
      subtotal: roundCentavo_(Number(sale.subtotal)),
      payment_method: sale.payment_method,
      cash_received: sale.payment_method === 'cash'
        ? roundCentavo_(Number(sale.cash_received) || 0)
        : '',
      change_given: sale.payment_method === 'cash'
        ? roundCentavo_(Number(sale.change_given) || 0)
        : '',
      voided: false,
      void_reason: '',
      voided_by: '',
      voided_at: '',
      synced_at: new Date()
    });

    applyInventoryDeltas_(sale.store_id, deltas);

    return { ok: true, sale_id: sale.sale_id };
  });
}

/** Accept ISO strings, epoch ms numbers, or Date objects. */
function parseTimestamp_(t) {
  if (t instanceof Date) return t;
  if (typeof t === 'number') return new Date(t);
  return new Date(String(t));
}
