/**
 * Schema.gs
 * ----------
 * Single source of truth for tab names, header layouts, and seed data.
 * Used by Bootstrap.setupWorkbook() to create or repair the workbook,
 * and by every read/write helper to translate between row arrays and
 * named objects.
 *
 * Order of columns here IS the order in the Sheet. Do not reorder casually —
 * existing rows are positional. If a column must be added, append to the end.
 */

// ----- Tab names (kept short; column order below is authoritative) -----
const TABS = {
  STORES:    'Stores',
  ITEMS:     'Items',
  BUNDLES:   'Bundles',
  INVENTORY: 'Inventory',
  SELLERS:   'Sellers',
  SHIFTS:    'Shifts',
  SALES:     'Sales',
  RESTOCKS:  'Restocks'
};

// ----- Column layouts. Each entry: [{name, type}] in sheet column order. -----
const SCHEMA = {
  [TABS.STORES]: [
    { name: 'store_id', type: 'string' },
    { name: 'name',     type: 'string' },
    { name: 'active',   type: 'boolean' }
  ],
  [TABS.ITEMS]: [
    { name: 'item_id',      type: 'string' },
    { name: 'name',         type: 'string' },
    { name: 'retail_price', type: 'number' },
    { name: 'category',     type: 'string' },
    { name: 'active',       type: 'boolean' }
  ],
  [TABS.BUNDLES]: [
    { name: 'bundle_id',            type: 'string' },
    { name: 'name',                 type: 'string' },
    { name: 'price',                type: 'number' },
    { name: 'includes_siopao_qty',  type: 'number' },
    { name: 'includes_gulaman_qty', type: 'number' },
    { name: 'active',               type: 'boolean' }
  ],
  [TABS.INVENTORY]: [
    { name: 'store_id',   type: 'string' },
    { name: 'item_id',    type: 'string' },
    { name: 'stock',      type: 'number' },
    { name: 'updated_at', type: 'datetime' }
  ],
  [TABS.SELLERS]: [
    { name: 'seller_id', type: 'string' },
    { name: 'name',      type: 'string' },
    { name: 'store_id',  type: 'string' },
    { name: 'pin_hash',  type: 'string' },
    { name: 'pin_salt',  type: 'string' },
    { name: 'active',    type: 'boolean' }
  ],
  [TABS.SHIFTS]: [
    { name: 'shift_id',        type: 'string' },
    { name: 'seller_id',       type: 'string' },
    { name: 'store_id',        type: 'string' },
    { name: 'start_time',      type: 'datetime' },
    { name: 'end_time',        type: 'datetime' },
    { name: 'expected_cash',   type: 'number' },
    { name: 'counted_cash',    type: 'number' },
    { name: 'variance_cash',   type: 'number' },
    { name: 'expected_gcash',  type: 'number' },
    { name: 'counted_gcash',   type: 'number' },
    { name: 'variance_gcash',  type: 'number' },
    { name: 'notes',           type: 'string' }
  ],
  [TABS.SALES]: [
    { name: 'sale_id',        type: 'string' },
    { name: 'timestamp',      type: 'datetime' },
    { name: 'store_id',       type: 'string' },
    { name: 'seller_id',      type: 'string' },
    { name: 'shift_id',       type: 'string' },
    { name: 'items_json',     type: 'string' },
    { name: 'subtotal',       type: 'number' },
    { name: 'payment_method', type: 'string' },
    { name: 'cash_received',  type: 'number' },
    { name: 'change_given',   type: 'number' },
    { name: 'voided',         type: 'boolean' },
    { name: 'void_reason',    type: 'string' },
    { name: 'voided_by',      type: 'string' },
    { name: 'voided_at',      type: 'datetime' },
    { name: 'synced_at',      type: 'datetime' }
  ],
  [TABS.RESTOCKS]: [
    { name: 'restock_id', type: 'string' },
    { name: 'timestamp',  type: 'datetime' },
    { name: 'store_id',   type: 'string' },
    { name: 'item_id',    type: 'string' },
    { name: 'qty_added',  type: 'number' },
    { name: 'added_by',   type: 'string' },
    { name: 'notes',      type: 'string' }
  ]
};

// ----- Seed data per spec §9. Only applied to a freshly-created tab. -----
const SEED = {
  [TABS.STORES]: [
    { store_id: 'loc_a', name: 'Location A', active: true },
    { store_id: 'loc_b', name: 'Location B', active: true }
  ],
  [TABS.ITEMS]: [
    { item_id: 'asado',       name: 'Asado',       retail_price: 28, category: 'siopao', active: true },
    { item_id: 'bola_bola',   name: 'Bola Bola',   retail_price: 28, category: 'siopao', active: true },
    { item_id: 'supreme_mix', name: 'Supreme Mix', retail_price: 28, category: 'siopao', active: true },
    { item_id: 'chocolate',   name: 'Chocolate',   retail_price: 28, category: 'siopao', active: true },
    { item_id: 'gulaman',     name: 'Gulaman',     retail_price: 15, category: 'drink',  active: true }
  ],
  [TABS.BUNDLES]: [
    { bundle_id: 'combo', name: 'Combo (Siopao + Gulaman)', price: 39,  includes_siopao_qty: 1,  includes_gulaman_qty: 1, active: true },
    { bundle_id: 'pack',  name: 'Pack of 10',                price: 250, includes_siopao_qty: 10, includes_gulaman_qty: 0, active: true }
  ]
  // Inventory is seeded *after* Stores+Items exist — see Bootstrap.seedInventory_().
  // Sellers, Shifts, Sales, Restocks start empty.
};

/** Returns the array of column names for a tab, in sheet order. */
function headersFor_(tabName) {
  return SCHEMA[tabName].map(function (c) { return c.name; });
}
