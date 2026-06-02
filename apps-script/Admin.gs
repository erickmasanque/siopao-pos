/**
 * Admin.gs
 * --------
 * Sister-only endpoints. Every handler here is dispatched ONLY through
 * ADMIN_METHODS in Code.gs, which calls requireAdmin_() and passes the
 * verified caller email in ctx.adminEmail. Handlers must not be invoked
 * from public routes.
 *
 * Audit fields (added_by on Restocks, voided_by on Sales) are stamped
 * from ctx.adminEmail — the sheet preserves who did what.
 *
 * Per D7 voids never rewrite an already-closed shift's stored expected/
 * variance numbers. The shift history surfaces post-close voids as a
 * separate flag, computed at read time.
 */

const ADMIN_TZ = 'Asia/Manila';

// ---------- Dashboard ----------

function getDashboard() {
  const today = Utilities.formatDate(new Date(), ADMIN_TZ, 'yyyy-MM-dd');

  const storeNameMap  = _nameMap_(TABS.STORES,  'store_id',  'name');
  const itemNameMap   = _nameMap_(TABS.ITEMS,   'item_id',   'name');
  const sellerNameMap = _nameMap_(TABS.SELLERS, 'seller_id', 'name');

  const bundleMap = {};
  readTable_(TABS.BUNDLES).forEach(function (b) { bundleMap[b.bundle_id] = b; });

  const byStore = {};
  const total = { cash: 0, gcash: 0, count: 0 };
  const bestMap = {};

  readTable_(TABS.SALES).forEach(function (sale) {
    if (sale.voided || !sale.timestamp) return;
    const day = Utilities.formatDate(new Date(sale.timestamp), ADMIN_TZ, 'yyyy-MM-dd');
    if (day !== today) return;

    const sub = Number(sale.subtotal) || 0;
    if (!byStore[sale.store_id]) byStore[sale.store_id] = { cash: 0, gcash: 0, count: 0 };
    if (sale.payment_method === 'cash')  { byStore[sale.store_id].cash  += sub; total.cash  += sub; }
    if (sale.payment_method === 'gcash') { byStore[sale.store_id].gcash += sub; total.gcash += sub; }
    byStore[sale.store_id].count += 1;
    total.count += 1;

    // Expand bundle lines into the underlying items they consume — best-
    // sellers should reflect what actually came off the shelf.
    let lines = [];
    try { lines = JSON.parse(sale.items_json || '[]'); } catch (e) {}
    lines.forEach(function (line) {
      const q = Number(line.qty) || 0;
      if (line.type === 'item') {
        bestMap[line.id] = (bestMap[line.id] || 0) + q;
      } else if (line.type === 'bundle') {
        const b = bundleMap[line.id];
        if (!b) return;
        if (b.includes_siopao_qty > 0 && line.chosen_siopao) {
          bestMap[line.chosen_siopao] = (bestMap[line.chosen_siopao] || 0) + b.includes_siopao_qty * q;
        }
        if (b.includes_gulaman_qty > 0) {
          bestMap['gulaman'] = (bestMap['gulaman'] || 0) + b.includes_gulaman_qty * q;
        }
      }
    });
  });

  Object.keys(byStore).forEach(function (sid) {
    byStore[sid].cash  = roundCentavo_(byStore[sid].cash);
    byStore[sid].gcash = roundCentavo_(byStore[sid].gcash);
  });
  total.cash  = roundCentavo_(total.cash);
  total.gcash = roundCentavo_(total.gcash);

  const bestSellers = Object.keys(bestMap)
    .map(function (id) { return { item_id: id, name: itemNameMap[id] || id, qty_sold: bestMap[id] }; })
    .sort(function (a, b) { return b.qty_sold - a.qty_sold; });

  const shifts = readTable_(TABS.SHIFTS);
  const activeShifts = shifts
    .filter(function (s) { return s.start_time && !s.end_time; })
    .map(function (s) { return {
      shift_id: s.shift_id,
      store_id: s.store_id,
      store_name: storeNameMap[s.store_id] || s.store_id,
      seller_id: s.seller_id,
      seller_name: sellerNameMap[s.seller_id] || s.seller_id,
      start_time: s.start_time
    }; });

  const VARIANCE_THRESHOLD = 20;
  const varianceAlerts = shifts
    .filter(function (s) {
      if (!s.end_time) return false;
      const day = Utilities.formatDate(new Date(s.end_time), ADMIN_TZ, 'yyyy-MM-dd');
      if (day !== today) return false;
      const vc = Number(s.variance_cash)  || 0;
      const vg = Number(s.variance_gcash) || 0;
      return Math.abs(vc) > VARIANCE_THRESHOLD || Math.abs(vg) > VARIANCE_THRESHOLD;
    })
    .map(function (s) { return {
      shift_id: s.shift_id,
      store_id: s.store_id,
      store_name: storeNameMap[s.store_id] || s.store_id,
      seller_name: sellerNameMap[s.seller_id] || s.seller_id,
      end_time: s.end_time,
      variance_cash:  Number(s.variance_cash)  || 0,
      variance_gcash: Number(s.variance_gcash) || 0
    }; });

  return {
    today_iso: today,
    today: { by_store: byStore, total: total },
    best_sellers: bestSellers,
    active_shifts: activeShifts,
    variance_alerts: varianceAlerts
  };
}

// ---------- Inventory ----------

/**
 * Admin-side inventory snapshot for ONE store. Unlike public getInventory,
 * this joins the Restocks tab to expose true "last restocked at" per item
 * (the Inventory row's updated_at also moves on sales — useless for the
 * "last restock" column).
 */
function getInventoryDetail(params) {
  const store_id = params && params.store_id;
  if (!store_id) throw new Error('store_id required');

  const lastRestock = {};
  readTable_(TABS.RESTOCKS).forEach(function (r) {
    if (r.store_id !== store_id) return;
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if (!lastRestock[r.item_id] || ts > lastRestock[r.item_id].ts) {
      lastRestock[r.item_id] = { ts: ts, qty: Number(r.qty_added) || 0 };
    }
  });

  const itemNameMap = _nameMap_(TABS.ITEMS, 'item_id', 'name');
  const itemActiveMap = {};
  readTable_(TABS.ITEMS).forEach(function (i) { itemActiveMap[i.item_id] = Boolean(i.active); });

  return readTable_(TABS.INVENTORY)
    .filter(function (r) { return r.store_id === store_id; })
    .map(function (r) {
      const lr = lastRestock[r.item_id];
      return {
        item_id: r.item_id,
        name: itemNameMap[r.item_id] || r.item_id,
        active: itemActiveMap[r.item_id] !== false,
        stock: Number(r.stock) || 0,
        last_restocked_at: lr ? new Date(lr.ts) : null,
        last_restocked_qty: lr ? lr.qty : null
      };
    });
}

function restock(params, ctx) {
  return withLock_(function () {
    const store_id = params && params.store_id;
    const item_id  = params && params.item_id;
    const qty      = Number(params && params.qty);
    if (!store_id || !item_id) throw new Error('store_id and item_id required');
    if (!isFinite(qty) || qty <= 0) throw new Error('qty must be positive');

    appendRow_(TABS.RESTOCKS, {
      restock_id: Utilities.getUuid(),
      timestamp: new Date(),
      store_id: store_id,
      item_id: item_id,
      qty_added: qty,
      added_by: (ctx && ctx.adminEmail) || '',
      notes: (params && params.notes) || ''
    });

    const deltas = {};
    deltas[item_id] = qty;
    applyInventoryDeltas_(store_id, deltas);

    return { ok: true };
  });
}

// ---------- Menu (items + bundles) ----------

function addItem(params) {
  return withLock_(function () {
    const item_id      = params && params.item_id;
    const name         = (params && params.name || '').trim();
    const retail_price = params && params.retail_price;
    const category     = (params && params.category || '').trim();
    const active       = params && params.active;

    if (!item_id || !name) throw new Error('item_id and name required');
    if (retail_price == null || retail_price === '') throw new Error('retail_price required');
    if (!/^[a-z0-9_]+$/.test(item_id)) throw new Error('item_id must be lowercase a-z, 0-9, or underscore only');
    if (getRowByKey_(TABS.ITEMS, 'item_id', item_id)) throw new Error('item_id already exists');

    appendRow_(TABS.ITEMS, {
      item_id: item_id,
      name: name,
      retail_price: roundCentavo_(Number(retail_price)),
      category: category,
      active: active !== false
    });

    // Seed an Inventory row at stock=0 for every active store so this item
    // shows up in the seller tile grid as "Out" immediately rather than
    // silently missing.
    const stores = readTable_(TABS.STORES).filter(function (s) { return s.active; });
    const now = new Date();
    appendRows_(TABS.INVENTORY, stores.map(function (s) {
      return { store_id: s.store_id, item_id: item_id, stock: 0, updated_at: now };
    }));

    return { ok: true, item_id: item_id };
  });
}

function addBundle(params) {
  return withLock_(function () {
    const bundle_id            = params && params.bundle_id;
    const name                 = (params && params.name || '').trim();
    const price                = params && params.price;
    const includes_siopao_qty  = Math.max(0, Number(params && params.includes_siopao_qty) || 0);
    const includes_gulaman_qty = Math.max(0, Number(params && params.includes_gulaman_qty) || 0);
    const active               = params && params.active;

    if (!bundle_id || !name) throw new Error('bundle_id and name required');
    if (price == null || price === '') throw new Error('price required');
    if (!/^[a-z0-9_]+$/.test(bundle_id)) throw new Error('bundle_id must be lowercase a-z, 0-9, or underscore only');
    if (getRowByKey_(TABS.BUNDLES, 'bundle_id', bundle_id)) throw new Error('bundle_id already exists');

    appendRow_(TABS.BUNDLES, {
      bundle_id: bundle_id,
      name: name,
      price: roundCentavo_(Number(price)),
      includes_siopao_qty: includes_siopao_qty,
      includes_gulaman_qty: includes_gulaman_qty,
      active: active !== false
    });

    return { ok: true, bundle_id: bundle_id };
  });
}

function updateItem(params) {
  return withLock_(function () {
    const item_id = params && params.item_id;
    const fields  = (params && params.fields) || {};
    if (!item_id) throw new Error('item_id required');

    const row = getRowByKey_(TABS.ITEMS, 'item_id', item_id);
    if (!row) throw new Error('Item not found');

    const allowed = ['name', 'retail_price', 'category', 'active'];
    const updates = _filteredUpdates_(fields, allowed, {
      retail_price: function (v) { return roundCentavo_(Number(v)); },
      active:       function (v) { return Boolean(v); }
    });
    if (Object.keys(updates).length === 0) throw new Error('No allowed fields to update');

    updateRow_(TABS.ITEMS, row._row, updates);
    return { ok: true };
  });
}

function updateBundle(params) {
  return withLock_(function () {
    const bundle_id = params && params.bundle_id;
    const fields    = (params && params.fields) || {};
    if (!bundle_id) throw new Error('bundle_id required');

    const row = getRowByKey_(TABS.BUNDLES, 'bundle_id', bundle_id);
    if (!row) throw new Error('Bundle not found');

    const allowed = ['name', 'price', 'includes_siopao_qty', 'includes_gulaman_qty', 'active'];
    const updates = _filteredUpdates_(fields, allowed, {
      price:                function (v) { return roundCentavo_(Number(v)); },
      includes_siopao_qty:  function (v) { return Math.max(0, Number(v) || 0); },
      includes_gulaman_qty: function (v) { return Math.max(0, Number(v) || 0); },
      active:               function (v) { return Boolean(v); }
    });
    if (Object.keys(updates).length === 0) throw new Error('No allowed fields to update');

    updateRow_(TABS.BUNDLES, row._row, updates);
    return { ok: true };
  });
}

// ---------- Sellers ----------

function addSeller(params) {
  return withLock_(function () {
    const name     = (params && params.name || '').trim();
    const store_id = params && params.store_id;
    const pin      = params && params.pin;
    if (!name || !store_id || pin === undefined) throw new Error('name, store_id, pin required');
    if (!/^\d{4}$/.test(String(pin))) throw new Error('PIN must be 4 digits');

    if (!getRowByKey_(TABS.STORES, 'store_id', store_id)) {
      throw new Error('Unknown store_id: ' + store_id);
    }

    // PIN uniqueness within store (D4).
    _pinCollidesAtStore_(store_id, pin, null);

    const seller_id = 'sel_' + Utilities.getUuid().slice(0, 8);
    const salt = generateSalt_();
    const hash = hashPin_(pin, salt);

    appendRow_(TABS.SELLERS, {
      seller_id: seller_id,
      name: name,
      store_id: store_id,
      pin_hash: hash,
      pin_salt: salt,
      active: true
    });

    return { ok: true, seller_id: seller_id };
  });
}

function resetPin(params) {
  return withLock_(function () {
    const seller_id = params && params.seller_id;
    const pin       = params && params.pin;
    if (!seller_id || pin === undefined) throw new Error('seller_id and pin required');
    if (!/^\d{4}$/.test(String(pin))) throw new Error('PIN must be 4 digits');

    const seller = getRowByKey_(TABS.SELLERS, 'seller_id', seller_id);
    if (!seller) throw new Error('Seller not found');

    _pinCollidesAtStore_(seller.store_id, pin, seller_id);

    const salt = generateSalt_();
    const hash = hashPin_(pin, salt);
    updateRow_(TABS.SELLERS, seller._row, { pin_hash: hash, pin_salt: salt });
    return { ok: true };
  });
}

function deactivateSeller(params) {
  return withLock_(function () {
    const seller_id = params && params.seller_id;
    if (!seller_id) throw new Error('seller_id required');
    const seller = getRowByKey_(TABS.SELLERS, 'seller_id', seller_id);
    if (!seller) throw new Error('Seller not found');
    updateRow_(TABS.SELLERS, seller._row, { active: false });
    return { ok: true };
  });
}

// ---------- Shift admin overrides ----------

function forceCloseShift(params) {
  return withLock_(function () {
    const shift_id = params && params.shift_id;
    if (!shift_id) throw new Error('shift_id required');

    const shift = getRowByKey_(TABS.SHIFTS, 'shift_id', shift_id);
    if (!shift) throw new Error('Shift not found');
    if (shift.end_time) throw new Error('Shift already closed');

    let expCash = 0, expGcash = 0;
    readTable_(TABS.SALES).forEach(function (s) {
      if (s.shift_id !== shift_id || s.voided) return;
      const sub = Number(s.subtotal) || 0;
      if (s.payment_method === 'cash')  expCash  += sub;
      if (s.payment_method === 'gcash') expGcash += sub;
    });
    expCash  = roundCentavo_(expCash);
    expGcash = roundCentavo_(expGcash);

    // Counted is optional on a force-close — the seller may not be present.
    const ccRaw = params && params.counted_cash;
    const cgRaw = params && params.counted_gcash;
    const cc = (ccRaw !== undefined && ccRaw !== null && ccRaw !== '')
      ? roundCentavo_(Number(ccRaw)) : '';
    const cg = (cgRaw !== undefined && cgRaw !== null && cgRaw !== '')
      ? roundCentavo_(Number(cgRaw)) : '';
    const vc = cc === '' ? '' : roundCentavo_(cc - expCash);
    const vg = cg === '' ? '' : roundCentavo_(cg - expGcash);

    const adminNote = '[FORCE CLOSED BY ADMIN]';
    const userNotes = (params && params.notes) || '';
    updateRow_(TABS.SHIFTS, shift._row, {
      end_time: new Date(),
      expected_cash: expCash,
      counted_cash: cc,
      variance_cash: vc,
      expected_gcash: expGcash,
      counted_gcash: cg,
      variance_gcash: vg,
      notes: userNotes ? (userNotes + ' ' + adminNote) : adminNote
    });

    return { ok: true, expected_cash: expCash, expected_gcash: expGcash };
  });
}

// ---------- Voids ----------

function voidSale(params, ctx) {
  return withLock_(function () {
    const sale_id = params && params.sale_id;
    const reason  = (params && params.reason || '').trim();
    if (!sale_id) throw new Error('sale_id required');
    if (!reason)  throw new Error('reason required');

    const sale = getRowByKey_(TABS.SALES, 'sale_id', sale_id);
    if (!sale) throw new Error('Sale not found');
    if (sale.voided) throw new Error('Sale already voided');

    // Reverse the inventory deltas this sale originally applied.
    const bundleMap = {};
    readTable_(TABS.BUNDLES).forEach(function (b) { bundleMap[b.bundle_id] = b; });
    let items = [];
    try { items = JSON.parse(sale.items_json || '[]'); } catch (e) {}

    const deltas = {};
    items.forEach(function (line) {
      const q = Number(line.qty) || 0;
      if (line.type === 'item') {
        deltas[line.id] = (deltas[line.id] || 0) + q;
      } else if (line.type === 'bundle') {
        const b = bundleMap[line.id];
        if (!b) return;
        if (b.includes_siopao_qty > 0 && line.chosen_siopao) {
          deltas[line.chosen_siopao] = (deltas[line.chosen_siopao] || 0) + b.includes_siopao_qty * q;
        }
        if (b.includes_gulaman_qty > 0) {
          deltas['gulaman'] = (deltas['gulaman'] || 0) + b.includes_gulaman_qty * q;
        }
      }
    });

    updateRow_(TABS.SALES, sale._row, {
      voided: true,
      void_reason: reason,
      voided_by: (ctx && ctx.adminEmail) || '',
      voided_at: new Date()
    });
    applyInventoryDeltas_(sale.store_id, deltas);

    return { ok: true };
  });
}

// ---------- Logs ----------

function getSalesLog(params) {
  const f = params || {};
  const fromTs = f.from ? new Date(f.from).getTime() : -Infinity;
  const toTs   = f.to   ? new Date(f.to).getTime()   : Infinity;

  const storeNameMap  = _nameMap_(TABS.STORES,  'store_id',  'name');
  const sellerNameMap = _nameMap_(TABS.SELLERS, 'seller_id', 'name');

  const rows = readTable_(TABS.SALES).filter(function (s) {
    const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
    if (ts < fromTs || ts > toTs) return false;
    if (f.store_id       && s.store_id       !== f.store_id)       return false;
    if (f.seller_id      && s.seller_id      !== f.seller_id)      return false;
    if (f.payment_method && s.payment_method !== f.payment_method) return false;
    if (f.voided !== undefined && f.voided !== null) {
      if (Boolean(s.voided) !== Boolean(f.voided)) return false;
    }
    return true;
  }).map(function (s) {
    return {
      sale_id: s.sale_id,
      timestamp: s.timestamp,
      store_id: s.store_id,
      store_name: storeNameMap[s.store_id] || s.store_id,
      seller_id: s.seller_id,
      seller_name: sellerNameMap[s.seller_id] || s.seller_id,
      shift_id: s.shift_id,
      items_json: s.items_json,
      subtotal: Number(s.subtotal) || 0,
      payment_method: s.payment_method,
      cash_received: (s.cash_received === '' || s.cash_received == null) ? null : Number(s.cash_received),
      change_given:  (s.change_given  === '' || s.change_given  == null) ? null : Number(s.change_given),
      voided: Boolean(s.voided),
      void_reason: s.void_reason || '',
      voided_by: s.voided_by || '',
      voided_at: s.voided_at || null
    };
  });

  rows.sort(function (a, b) {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });
  return rows;
}

function getShiftHistory(params) {
  const f = params || {};
  const fromTs = f.from ? new Date(f.from).getTime() : -Infinity;
  const toTs   = f.to   ? new Date(f.to).getTime()   : Infinity;

  const storeNameMap  = _nameMap_(TABS.STORES,  'store_id',  'name');
  const sellerNameMap = _nameMap_(TABS.SELLERS, 'seller_id', 'name');

  // Pre-compute post-close voids per shift_id so the admin can see the D7
  // "voids landed after shift was closed" flag without a second query.
  const postCloseVoidCount = {};
  const shifts = readTable_(TABS.SHIFTS);
  const shiftEndMap = {};
  shifts.forEach(function (s) {
    if (s.end_time) shiftEndMap[s.shift_id] = new Date(s.end_time).getTime();
  });
  readTable_(TABS.SALES).forEach(function (sale) {
    if (!sale.voided || !sale.voided_at) return;
    const closedAt = shiftEndMap[sale.shift_id];
    if (closedAt && new Date(sale.voided_at).getTime() > closedAt) {
      postCloseVoidCount[sale.shift_id] = (postCloseVoidCount[sale.shift_id] || 0) + 1;
    }
  });

  const rows = shifts.filter(function (s) {
    const ts = s.start_time ? new Date(s.start_time).getTime() : 0;
    if (ts < fromTs || ts > toTs) return false;
    if (f.store_id  && s.store_id  !== f.store_id)  return false;
    if (f.seller_id && s.seller_id !== f.seller_id) return false;
    return true;
  }).map(function (s) {
    return {
      shift_id: s.shift_id,
      store_id: s.store_id,
      store_name: storeNameMap[s.store_id] || s.store_id,
      seller_id: s.seller_id,
      seller_name: sellerNameMap[s.seller_id] || s.seller_id,
      start_time: s.start_time,
      end_time:   s.end_time || null,
      expected_cash:  (s.expected_cash  === '' || s.expected_cash  == null) ? null : Number(s.expected_cash),
      counted_cash:   (s.counted_cash   === '' || s.counted_cash   == null) ? null : Number(s.counted_cash),
      variance_cash:  (s.variance_cash  === '' || s.variance_cash  == null) ? null : Number(s.variance_cash),
      expected_gcash: (s.expected_gcash === '' || s.expected_gcash == null) ? null : Number(s.expected_gcash),
      counted_gcash:  (s.counted_gcash  === '' || s.counted_gcash  == null) ? null : Number(s.counted_gcash),
      variance_gcash: (s.variance_gcash === '' || s.variance_gcash == null) ? null : Number(s.variance_gcash),
      notes: s.notes || '',
      post_close_voids: postCloseVoidCount[s.shift_id] || 0
    };
  });

  rows.sort(function (a, b) {
    return new Date(b.start_time).getTime() - new Date(a.start_time).getTime();
  });
  return rows;
}

// ---------- Internal helpers ----------

function _nameMap_(tab, keyCol, nameCol) {
  const map = {};
  readTable_(tab).forEach(function (r) { map[r[keyCol]] = r[nameCol]; });
  return map;
}

/**
 * Throws if `pin` collides with an active seller in the same store
 * (excluding `excludeSellerId` so resetPin doesn't trip on the seller
 * being updated).
 */
function _pinCollidesAtStore_(store_id, pin, excludeSellerId) {
  const others = readTable_(TABS.SELLERS).filter(function (s) {
    return s.active && s.store_id === store_id && s.seller_id !== excludeSellerId;
  });
  for (let i = 0; i < others.length; i++) {
    const s = others[i];
    if (s.pin_salt && hashPin_(pin, s.pin_salt) === s.pin_hash) {
      throw new Error('That PIN is already in use by another seller at this store');
    }
  }
}

function _filteredUpdates_(fields, allowedKeys, coercers) {
  const out = {};
  Object.keys(fields).forEach(function (k) {
    if (allowedKeys.indexOf(k) < 0) return;
    out[k] = coercers && coercers[k] ? coercers[k](fields[k]) : fields[k];
  });
  return out;
}
