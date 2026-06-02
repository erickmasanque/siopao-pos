/**
 * Shifts.gs
 * ---------
 * Shift lifecycle: open → make sales → close.
 *
 * Invariants (per §7.5, §7.6, D7):
 *   - Exactly one ACTIVE (start_time set, end_time blank) shift per store.
 *   - shift_id is generated CLIENT-SIDE so an offline startShift can still
 *     persist later. startShift is idempotent on shift_id.
 *   - closeShift freezes expected_cash / expected_gcash at close time;
 *     later voids never rewrite these numbers (the shift detail view
 *     surfaces post-close voids as flags instead).
 */

/**
 * Return the currently active shift for a store, or null. "Active" =
 * start_time present, end_time blank. We iterate newest-to-oldest because
 * the active one (if any) is almost certainly recent.
 */
function getActiveShift(params) {
  var store_id = params && params.store_id;
  if (!store_id) throw new Error('store_id required');
  var shifts = readTable_(TABS.SHIFTS);
  for (var i = shifts.length - 1; i >= 0; i--) {
    var s = shifts[i];
    if (s.store_id === store_id && s.start_time && !s.end_time) {
      var seller = getRowByKey_(TABS.SELLERS, 'seller_id', s.seller_id);
      return {
        shift_id: s.shift_id,
        seller_id: s.seller_id,
        seller_name: seller ? seller.name : null,
        start_time: s.start_time
      };
    }
  }
  return null;
}

/**
 * Open a new shift. Client provides shift_id (UUID) so retries after a
 * flaky connection don't double-open.
 *   Rejects if: seller missing/inactive, seller's store_id mismatches,
 *   or another active shift already exists in this store.
 */
function startShift(params) {
  return withLock_(function () {
    var seller_id = params && params.seller_id;
    var store_id  = params && params.store_id;
    var shift_id  = params && params.shift_id;
    if (!seller_id || !store_id || !shift_id) {
      throw new Error('seller_id, store_id, shift_id required');
    }

    var existing = getRowByKey_(TABS.SHIFTS, 'shift_id', shift_id);
    if (existing) {
      return { ok: true, duplicate: true, shift_id: shift_id };
    }

    var seller = getRowByKey_(TABS.SELLERS, 'seller_id', seller_id);
    if (!seller || !seller.active) throw new Error('Seller not found or inactive');
    if (seller.store_id !== store_id) throw new Error('Seller does not belong to this store');

    var active = getActiveShift({ store_id: store_id });
    if (active) {
      throw new Error('An active shift is already open in this store under ' + (active.seller_name || active.seller_id));
    }

    appendRow_(TABS.SHIFTS, {
      shift_id: shift_id,
      seller_id: seller_id,
      store_id: store_id,
      start_time: new Date(),
      end_time: '',
      expected_cash: '',
      counted_cash: '',
      variance_cash: '',
      expected_gcash: '',
      counted_gcash: '',
      variance_gcash: '',
      notes: ''
    });

    return { ok: true, shift_id: shift_id };
  });
}

/**
 * Close a shift. Idempotent on shift_id: a second call against an
 * already-closed shift returns the stored numbers without rewriting them
 * (preserves the audit trail per D7).
 *
 * expected_* is computed at the moment of close from non-voided sales
 * whose shift_id matches, then stored on the row. Voids that arrive
 * AFTER close do not retroactively change these numbers.
 */
function closeShift(params) {
  return withLock_(function () {
    var shift_id      = params && params.shift_id;
    var counted_cash  = params && params.counted_cash;
    var counted_gcash = params && params.counted_gcash;
    var notes         = (params && params.notes) || '';

    if (!shift_id) throw new Error('shift_id required');

    var shift = getRowByKey_(TABS.SHIFTS, 'shift_id', shift_id);
    if (!shift) throw new Error('Shift not found');

    if (shift.end_time) {
      return {
        ok: true,
        duplicate: true,
        expected_cash: Number(shift.expected_cash) || 0,
        variance_cash: Number(shift.variance_cash) || 0,
        expected_gcash: Number(shift.expected_gcash) || 0,
        variance_gcash: Number(shift.variance_gcash) || 0
      };
    }

    var expCash = 0, expGcash = 0;
    readTable_(TABS.SALES).forEach(function (sale) {
      if (sale.shift_id !== shift_id || sale.voided) return;
      var sub = Number(sale.subtotal) || 0;
      if (sale.payment_method === 'cash') expCash += sub;
      else if (sale.payment_method === 'gcash') expGcash += sub;
    });
    expCash  = roundCentavo_(expCash);
    expGcash = roundCentavo_(expGcash);

    var cc = roundCentavo_(Number(counted_cash)  || 0);
    var cg = roundCentavo_(Number(counted_gcash) || 0);
    var varCash  = roundCentavo_(cc - expCash);
    var varGcash = roundCentavo_(cg - expGcash);

    updateRow_(TABS.SHIFTS, shift._row, {
      end_time: new Date(),
      expected_cash: expCash,
      counted_cash: cc,
      variance_cash: varCash,
      expected_gcash: expGcash,
      counted_gcash: cg,
      variance_gcash: varGcash,
      notes: notes
    });

    return {
      ok: true,
      expected_cash: expCash,
      variance_cash: varCash,
      expected_gcash: expGcash,
      variance_gcash: varGcash
    };
  });
}
