/**
 * Code.gs
 * --------
 * HTTP entry point. Apps Script web apps only expose two functions to
 * the outside world: doGet (browser navigation, no body) and doPost
 * (XHR/fetch with a body).
 *
 * Wire protocol:
 *   POST  application/json (or text/plain to skip CORS preflight)
 *   body  { "method": "<name>", "params": { ... } }
 *   ←     { "ok": true,  "data": ... }
 *   ←     { "ok": false, "error": "...", "code": "..." }
 *
 * Admin methods will be added in a later module (Admin.gs). For now only
 * the seller-facing public methods are routed — enough to get the online
 * seller flow flowing end-to-end before we build the PWA.
 *
 * CORS note: Apps Script returns Access-Control-Allow-Origin:* for web
 * app responses. Browsers will only preflight (OPTIONS) when the request
 * uses non-simple headers — POSTing with Content-Type: text/plain avoids
 * preflight entirely, which is what the frontend will do.
 */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonErr_('Empty request body', 'BAD_REQUEST');
    }
    var body = JSON.parse(e.postData.contents);
    return route_(body.method, body.params || {});
  } catch (err) {
    return jsonErr_(err.message || String(err));
  }
}

/**
 * doGet serves three things:
 *   1. ?page=admin     → the admin HtmlService UI (same-origin, Google auth)
 *   2. ?method=X[&params=...] → read-only API hit from a browser address bar
 *   3. (no params)     → plain text health check
 *
 * The admin UI must live HERE (not on GitHub Pages) because spec D2's
 * `Session.getActiveUser().getEmail()` only populates for same-origin
 * callers with a valid Google session — a cross-origin fetch can't
 * carry the cookie under Apps Script's CORS posture.
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'admin') {
    return HtmlService.createHtmlOutputFromFile('admin')
      .setTitle('Siopao POS — Admin')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  if (!e || !e.parameter || !e.parameter.method) {
    return ContentService
      .createTextOutput('Siopao POS API — POST { method, params } to use.')
      .setMimeType(ContentService.MimeType.TEXT);
  }
  try {
    var params = e.parameter.params ? JSON.parse(e.parameter.params) : {};
    return route_(e.parameter.method, params);
  } catch (err) {
    return jsonErr_(err.message || String(err));
  }
}

// Method registry. Keep names stable — they're the wire contract.
var PUBLIC_METHODS = {
  verifyPin:          verifyPin,
  startShift:         startShift,
  loginAndStartShift: loginAndStartShift,
  getActiveShift:     getActiveShift,
  closeShift:         closeShift,
  getMenu:            getMenu,
  getInventory:       getInventory,
  submitSale:         submitSale
};

var ADMIN_METHODS = {
  getDashboard:        getDashboard,
  getInventoryDetail:  getInventoryDetail,
  restock:             restock,
  addItem:             addItem,
  addBundle:           addBundle,
  updateItem:          updateItem,
  updateBundle:        updateBundle,
  addSeller:           addSeller,
  resetPin:            resetPin,
  deactivateSeller:    deactivateSeller,
  setSellerActive:     setSellerActive,
  forceCloseShift:     forceCloseShift,
  voidSale:            voidSale,
  getSalesLog:         getSalesLog,
  getShiftHistory:     getShiftHistory
};

function route_(method, params) {
  if (!method) return jsonErr_('method required', 'BAD_REQUEST');
  if (PUBLIC_METHODS[method]) {
    return jsonOk_(PUBLIC_METHODS[method](params));
  }
  if (ADMIN_METHODS[method]) {
    // Verify caller and stash the email so handlers can stamp audit fields
    // (voided_by, added_by) without each one repeating the auth call.
    const adminEmail = requireAdmin_();
    return jsonOk_(ADMIN_METHODS[method](params, { adminEmail: adminEmail }));
  }
  return jsonErr_('Unknown method: ' + method, 'NOT_FOUND');
}

/**
 * Returns the catalog snapshot the PWA caches in localStorage on every
 * successful online load (per §8). Filters to active rows only — inactive
 * items/bundles/stores must not show as tiles. Prices are rounded to the
 * centavo so the client never has to think about precision.
 */
function getMenu() {
  var stores = readTable_(TABS.STORES).filter(function (s) { return s.active; });
  var items  = readTable_(TABS.ITEMS).filter(function (i) { return i.active; });
  var bundles = readTable_(TABS.BUNDLES).filter(function (b) { return b.active; });

  return {
    stores: stores.map(function (s) {
      return { store_id: s.store_id, name: s.name };
    }),
    items: items.map(function (i) {
      return {
        item_id: i.item_id,
        name: i.name,
        retail_price: roundCentavo_(i.retail_price),
        category: i.category
      };
    }),
    bundles: bundles.map(function (b) {
      return {
        bundle_id: b.bundle_id,
        name: b.name,
        price: roundCentavo_(b.price),
        includes_siopao_qty: Number(b.includes_siopao_qty) || 0,
        includes_gulaman_qty: Number(b.includes_gulaman_qty) || 0
      };
    })
  };
}
