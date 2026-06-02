/**
 * AdminUI.gs
 * ----------
 * google.script.run wrappers for the admin HtmlService page.
 *
 * The admin UI calls these instead of the JSON /exec POST endpoints.
 * Why: google.script.run is internal RPC — no HTTP, no CORS, automatic
 * caller identity via Session.getActiveUser(). It's also faster (no
 * /exec routing overhead) and the auth gate doesn't need to hash a
 * password or pass tokens.
 *
 * Each wrapper:
 *   - calls requireAdmin_() (throws if caller isn't in ADMIN_EMAILS)
 *   - forwards to the matching Admin.gs / Inventory.gs / etc. handler
 *   - passes ctx.adminEmail so audit fields (added_by, voided_by) stamp
 *
 * Returns are passed back through google.script.run.withSuccessHandler
 * verbatim. Throws surface to .withFailureHandler with err.message.
 */

/**
 * Tells the page who's logged in and whether they're allowed. Used by
 * the page's auth gate before showing any UI. NOT gated by requireAdmin_
 * (that would always 401 and the page could never render its rejection
 * message).
 */
function ui_whoami() {
  var email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var raw   = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '';
  var allow = raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return {
    email: email,
    allowed: !!email && allow.indexOf(email) >= 0,
    allowlist_configured: allow.length > 0
  };
}

// ---------- Dashboard / lookups ----------
function ui_getDashboard()        { return _adminCall_(getDashboard); }
function ui_getMenu()             { return _adminCall_(getMenu); }            // catalog for filters/dropdowns
function ui_getInventory(params)  { return _adminCall_(getInventory, params); }
function ui_getInventoryDetail(params) { return _adminCall_(getInventoryDetail, params); }
function ui_listSellers()         { _adminGate_(); return _readSellersWithStats_(); }
function ui_listStores()          { _adminGate_(); return _readStores_(); }
function ui_getCatalog()          { _adminGate_(); return _readCatalog_(); }

// ---------- Mutations ----------
function ui_restock(params)          { return _adminCall_(restock, params); }
function ui_addItem(params)          { return _adminCall_(addItem, params); }
function ui_addBundle(params)        { return _adminCall_(addBundle, params); }
function ui_updateItem(params)       { return _adminCall_(updateItem, params); }
function ui_updateBundle(params)     { return _adminCall_(updateBundle, params); }
function ui_addSeller(params)        { return _adminCall_(addSeller, params); }
function ui_resetPin(params)         { return _adminCall_(resetPin, params); }
function ui_deactivateSeller(params) { return _adminCall_(deactivateSeller, params); }
function ui_setSellerActive(params)  { return _adminCall_(setSellerActive, params); }
function ui_forceCloseShift(params)  { return _adminCall_(forceCloseShift, params); }
function ui_voidSale(params)         { return _adminCall_(voidSale, params); }

// ---------- Logs ----------
function ui_getSalesLog(params)     { return _adminCall_(getSalesLog, params); }
function ui_getShiftHistory(params) { return _adminCall_(getShiftHistory, params); }

// ---------- Internals ----------

function _adminCall_(fn, params) {
  var email = requireAdmin_();
  return fn(params || {}, { adminEmail: email });
}

function _adminGate_() {
  requireAdmin_();
}

/** Sellers list with sensitive columns (pin_hash, pin_salt) stripped. */
function _readSellers_() {
  return readTable_(TABS.SELLERS).map(function (s) {
    return {
      seller_id: s.seller_id,
      name: s.name,
      store_id: s.store_id,
      active: Boolean(s.active)
    };
  });
}

/** Sellers list with last-shift timestamp joined from Shifts tab. */
function _readSellersWithStats_() {
  const lastShift = {};
  readTable_(TABS.SHIFTS).forEach(function (sh) {
    if (!sh.seller_id || !sh.start_time) return;
    const ts = new Date(sh.start_time).getTime();
    if (!lastShift[sh.seller_id] || ts > lastShift[sh.seller_id]) {
      lastShift[sh.seller_id] = ts;
    }
  });
  return _readSellers_().map(function (s) {
    return Object.assign(s, {
      last_shift_at: lastShift[s.seller_id] ? new Date(lastShift[s.seller_id]) : null
    });
  });
}

function _readStores_() {
  return readTable_(TABS.STORES).map(function (s) {
    return { store_id: s.store_id, name: s.name, active: Boolean(s.active) };
  });
}

/**
 * Full catalog including INACTIVE items/bundles. The admin menu view
 * needs this so an admin can see — and reactivate — items the seller
 * frontend has been hiding. Public getMenu() filters to active only
 * and is unsuitable for admin purposes.
 */
function _readCatalog_() {
  return {
    stores: _readStores_(),
    items: readTable_(TABS.ITEMS).map(function (i) {
      return {
        item_id: i.item_id,
        name: i.name,
        retail_price: roundCentavo_(Number(i.retail_price) || 0),
        category: i.category || '',
        active: Boolean(i.active)
      };
    }),
    bundles: readTable_(TABS.BUNDLES).map(function (b) {
      return {
        bundle_id: b.bundle_id,
        name: b.name,
        price: roundCentavo_(Number(b.price) || 0),
        includes_siopao_qty: Number(b.includes_siopao_qty) || 0,
        includes_gulaman_qty: Number(b.includes_gulaman_qty) || 0,
        active: Boolean(b.active)
      };
    })
  };
}
