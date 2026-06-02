/**
 * AdminUI.gs
 * ----------
 * google.script.run wrappers for the admin HtmlService page.
 *
 * The admin UI calls these instead of the JSON /exec POST endpoints.
 * google.script.run is internal RPC — no HTTP, no CORS, faster than
 * the public POST endpoint, and the auth gate doesn't need to negotiate
 * cross-origin Google identity.
 *
 * Auth model: every admin-only function expects a params object with an
 * `_auth` field of shape { username, password }. _adminCall_ unpacks it,
 * runs requireAdmin_, and forwards the remaining params to the handler.
 * adminEmail (the audit-stamp value) is the admin username.
 *
 * Returns pass through google.script.run.withSuccessHandler verbatim.
 * Throws surface to .withFailureHandler with err.message.
 */

/**
 * Tells the page whether the supplied credentials are valid. Used by the
 * admin frontend on boot to verify stored creds before rendering the app.
 * Does NOT throw — returns the auth state as data.
 *
 * Also reports whether ADMIN_USERNAME/ADMIN_PASS_HASH are configured at
 * all so the login form can surface a "not configured" message instead
 * of "wrong password" when the script properties are blank.
 */
function ui_whoami(params) {
  var props = PropertiesService.getScriptProperties();
  var configured = !!(props.getProperty('ADMIN_USERNAME')
                      && props.getProperty('ADMIN_PASS_HASH')
                      && props.getProperty('ADMIN_PASS_SALT'));
  var auth = (params && params._auth) || null;
  if (!auth) return { configured: configured, ok: false, error: null };
  try {
    var username = requireAdmin_(auth);
    return { configured: configured, ok: true, username: username };
  } catch (e) {
    return { configured: configured, ok: false, error: e.message };
  }
}

/**
 * Explicit login call. Throws on failure (so the page's withFailureHandler
 * fires with the reason). Returns { username } on success — callers can
 * use this to confirm the credentials before persisting them.
 */
function ui_login(params) {
  var auth = (params && params._auth) || null;
  var username = requireAdmin_(auth);
  return { ok: true, username: username };
}

// ---------- Dashboard / lookups ----------
function ui_getDashboard(params)        { return _adminCall_(getDashboard, params); }
function ui_getMenu(params)             { return _adminCall_(getMenu, params); }
function ui_getInventory(params)        { return _adminCall_(getInventory, params); }
function ui_getInventoryDetail(params)  { return _adminCall_(getInventoryDetail, params); }
function ui_listSellers(params)         { _adminGate_(params); return _serializeDates_(_readSellersWithStats_()); }
function ui_listStores(params)          { _adminGate_(params); return _serializeDates_(_readStores_()); }
function ui_getCatalog(params)          { _adminGate_(params); return _serializeDates_(_readCatalog_()); }

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
  var auth = (params && params._auth) || null;
  var clean = _stripAuth_(params);
  var username = requireAdmin_(auth);
  return _serializeDates_(fn(clean, { adminEmail: username }));
}

function _adminGate_(params) {
  var auth = (params && params._auth) || null;
  requireAdmin_(auth);
}

function _stripAuth_(params) {
  if (!params || typeof params !== 'object') return {};
  var out = {};
  Object.keys(params).forEach(function (k) {
    if (k !== '_auth') out[k] = params[k];
  });
  return out;
}

/**
 * google.script.run cannot serialize Date objects — if any leaf in the
 * returned tree is a Date, the entire response arrives at the browser
 * as null (per Apps Script docs). Sheet reads naturally produce Date
 * objects in date-typed columns, so we walk every admin response and
 * convert Dates to ISO strings. The admin frontend already does
 * `new Date(value)` to format them, so ISO strings are a drop-in.
 *
 * Invalid Dates (Date object that wraps NaN) become null rather than
 * the string "Invalid Date", which would otherwise round-trip as
 * something the client couldn't parse.
 */
function _serializeDates_(obj) {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) {
    return isNaN(obj.getTime()) ? null : obj.toISOString();
  }
  if (Array.isArray(obj)) {
    return obj.map(_serializeDates_);
  }
  if (typeof obj === 'object') {
    var out = {};
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = _serializeDates_(obj[keys[i]]);
    }
    return out;
  }
  return obj;
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
