'use strict';

/**
 * Siopao POS — frontend app.
 *
 * Three views (login → sales → close shift), one in-memory state object,
 * event-delegated click handler. No framework. Online-only for now;
 * IndexedDB queue + sync loop comes in build step 4.
 */

const API_URL = 'https://script.google.com/macros/s/AKfycbzj2ZolTmtzMWE_vqdzKUUlpOwndeVlW4K1imhRnM4V0ag78pI4c7j34d5XYp0miY3ktg/exec';

// localStorage keys
const LS_SESSION = 'siopao.session';
const LS_MENU    = 'siopao.menu';
const LS_INV     = 'siopao.inventory';
const LS_TOTALS  = 'siopao.shiftTotals';

const state = {
  view: null,
  menu: null,            // { stores, items, bundles }
  inventory: {},         // { item_id: stock } for the current store
  session: null,         // { seller_id, seller_name, store_id, store_name, shift_id, shift_started_at }
  cart: [],              // [{ type, id, qty, unit_price, name, chosen_siopao? }]
  payment: null,         // 'cash' | 'gcash' | null
  cashReceived: 0,       // integer pesos
  shiftTotals: { expCash: 0, expGcash: 0, count: 0 },
  countedCash: 0,
  countedGcash: 0,
  pinDigits: '',
  pendingStoreId: null,
  pendingStoreName: null,
  pendingBundle: null,
  numpadValue: 0,
  numpadCb: null,
  inflight: false
};

// ---------- Tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const fmtPeso = (n, decimals = 2) => '₱' + (Number(n) || 0).toFixed(decimals);
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Fire-and-forget GET against the API to wake a cold Apps Script
 * instance. Triggered when the seller taps a store button so the
 * inevitable loginAndStartShift POST a few seconds later lands on a warm
 * instance. We ignore the response — getMenu is cached locally anyway.
 */
function preWarm() {
  if (!navigator.onLine) return;
  try {
    fetch(API_URL + '?method=getMenu').catch(function () {});
  } catch (e) {}
}

// ---------- Storage ----------
function saveSession() {
  if (state.session) localStorage.setItem(LS_SESSION, JSON.stringify(state.session));
  else localStorage.removeItem(LS_SESSION);
}
function loadSession() {
  const raw = localStorage.getItem(LS_SESSION);
  if (raw) { try { state.session = JSON.parse(raw); } catch (e) {} }
}
function saveMenu() { if (state.menu) localStorage.setItem(LS_MENU, JSON.stringify(state.menu)); }
function loadMenu() {
  const raw = localStorage.getItem(LS_MENU);
  if (raw) { try { state.menu = JSON.parse(raw); } catch (e) {} }
}
function saveInventory() { localStorage.setItem(LS_INV, JSON.stringify(state.inventory)); }
function loadInventory() {
  const raw = localStorage.getItem(LS_INV);
  if (raw) { try { state.inventory = JSON.parse(raw); } catch (e) {} }
}
function saveTotals() {
  if (!state.session) return;
  localStorage.setItem(LS_TOTALS, JSON.stringify({
    shift_id: state.session.shift_id,
    expCash: state.shiftTotals.expCash,
    expGcash: state.shiftTotals.expGcash,
    count: state.shiftTotals.count
  }));
}
function loadTotals() {
  const raw = localStorage.getItem(LS_TOTALS);
  if (!raw) return;
  try {
    const t = JSON.parse(raw);
    if (state.session && t.shift_id === state.session.shift_id) {
      state.shiftTotals = { expCash: t.expCash || 0, expGcash: t.expGcash || 0, count: t.count || 0 };
    }
  } catch (e) {}
}
function clearTotals() {
  state.shiftTotals = { expCash: 0, expGcash: 0, count: 0 };
  localStorage.removeItem(LS_TOTALS);
}

// ---------- API ----------
async function api(method, params) {
  // text/plain content-type avoids the CORS preflight Apps Script can't answer.
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ method, params: params || {} })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || 'Unknown error');
  return json.data;
}

// ---------- IndexedDB queue (offline-tolerant mutations) ----------
//
// Sales and shift-closes are pushed into this queue immediately, then a
// background loop drains it FIFO whenever online. Server endpoints are
// idempotent on sale_id / shift_id, so a retried POST is a no-op on the
// server side — we can retry as aggressively as we want.

const DB_NAME = 'siopao';
const DB_VERSION = 1;
const STORE_QUEUE = 'queue';

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

function _idbReq(store, mode, op) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = op(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

function enqueue(method, params) {
  return _idbReq(STORE_QUEUE, 'readwrite', (os) =>
    os.add({ method, params, queuedAt: Date.now() }));
}
function listQueue()        { return _idbReq(STORE_QUEUE, 'readonly',  (os) => os.getAll()); }
function removeFromQueue(id){ return _idbReq(STORE_QUEUE, 'readwrite', (os) => os.delete(id)); }
function countQueue()       { return _idbReq(STORE_QUEUE, 'readonly',  (os) => os.count()); }

let _syncing = false;
let _syncTimer = null;

async function drainQueue() {
  if (_syncing) return;
  if (!navigator.onLine) return;
  _syncing = true;
  try {
    const items = await listQueue();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        await api(item.method, item.params);
        await removeFromQueue(item.id);
      } catch (err) {
        // Treat any failure as transient: leave the item at the head of
        // the queue and bail. The next loop tick or 'online' event will
        // retry. Pragmatic v1 trade-off — a tampered payload would block
        // the queue, but UI-built payloads are pre-validated client-side.
        console.warn('sync failed for', item.method, err.message);
        break;
      }
    }
  } finally {
    _syncing = false;
    updateConnDot();
  }
}

function syncNow()        { drainQueue(); }
function startSyncLoop() {
  if (_syncTimer) return;
  _syncTimer = setInterval(drainQueue, 30000);
}

// ---------- View routing ----------
function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
}

async function updateConnDot() {
  const dot = $('#conn-dot');
  if (!navigator.onLine) {
    dot.className = 'conn-dot offline';
    dot.title = 'Offline';
    return;
  }
  let pending = 0;
  try { pending = await countQueue(); } catch (e) {}
  if (pending > 0) {
    dot.className = 'conn-dot syncing';
    dot.title = 'Syncing — ' + pending + ' pending';
  } else {
    dot.className = 'conn-dot online';
    dot.title = 'Online';
  }
}

function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2500);
}

// ---------- View: store picker ----------
function renderStoreView() {
  const stores = (state.menu && state.menu.stores) || [];
  $('#store-buttons').innerHTML = stores.map((s) =>
    `<button class="store-btn" data-action="pick-store" data-store-id="${escHtml(s.store_id)}" data-store-name="${escHtml(s.name)}">${escHtml(s.name)}</button>`
  ).join('');
}

// ---------- View: PIN pad ----------
function renderPinView() {
  $('#pin-store-name').textContent = state.pendingStoreName || '';
  state.pinDigits = '';
  updatePinDots();
  $('#pin-error').innerHTML = '&nbsp;';
  $('#pin-status').hidden = true;
}
function updatePinDots() {
  const dots = document.querySelectorAll('#pin-display .pin-dot');
  dots.forEach((d, i) => d.classList.toggle('filled', i < state.pinDigits.length));
}

async function onPinComplete() {
  if (state.pinDigits.length !== 4 || state.inflight) return;
  state.inflight = true;
  $('#pin-status').hidden = false;
  $('#pin-error').innerHTML = '&nbsp;';
  try {
    if (!navigator.onLine) {
      state.pinDigits = '';
      updatePinDots();
      $('#pin-error').textContent = 'No internet — connect to log in';
      return;
    }
    // Drain any pending sales/closes from a previous offline session first,
    // so the server has a coherent view before we ask it about active shifts.
    if ((await countQueue()) > 0) {
      await drainQueue();
      if ((await countQueue()) > 0) {
        state.pinDigits = '';
        updatePinDots();
        $('#pin-error').textContent = 'Pending data not synced — try again in a moment';
        return;
      }
    }

    // ONE round-trip: verify PIN + check active shift + start (or resume)
    // + return inventory snapshot. Apps Script web apps are slow per call,
    // so collapsing the seller-login flow is a meaningful UX win.
    const shift_id = uuid();
    const resp = await api('loginAndStartShift', {
      store_id: state.pendingStoreId,
      pin: state.pinDigits,
      shift_id: shift_id
    });

    if (!resp.verified) {
      state.pinDigits = '';
      updatePinDots();
      $('#pin-error').textContent = 'Wrong PIN — try again';
      return;
    }
    if (resp.conflict) {
      state.pinDigits = '';
      updatePinDots();
      $('#pin-error').textContent = 'Active shift open under ' + (resp.active_seller_name || '?');
      return;
    }

    state.session = {
      seller_id:        resp.seller.seller_id,
      seller_name:      resp.seller.seller_name,
      store_id:         state.pendingStoreId,
      store_name:       state.pendingStoreName,
      shift_id:         resp.shift.shift_id,
      shift_started_at: resp.shift.start_time
    };
    saveSession();
    if (!resp.resumed) clearTotals();
    state.cart = [];
    state.payment = null;
    state.cashReceived = 0;

    state.inventory = {};
    (resp.inventory || []).forEach(function (r) { state.inventory[r.item_id] = r.stock; });
    saveInventory();

    renderSalesView();
    showView('sales');
  } catch (err) {
    toast(err.message, 'err');
    state.pinDigits = '';
    updatePinDots();
  } finally {
    state.inflight = false;
    $('#pin-status').hidden = true;
  }
}

// ---------- View: sales ----------
async function enterSalesView() {
  if (navigator.onLine) {
    try {
      const inv = await api('getInventory', { store_id: state.session.store_id });
      state.inventory = {};
      inv.forEach((r) => { state.inventory[r.item_id] = r.stock; });
      saveInventory();
    } catch (err) {
      toast('Inventory refresh failed: ' + err.message, 'warn');
    }
  }
  renderSalesView();
  showView('sales');
}

function renderSalesView() {
  $('#sales-store').textContent  = state.session.store_name;
  $('#sales-seller').textContent = state.session.seller_name;
  renderTiles();
  renderCart();
}

function renderTiles() {
  const items   = (state.menu && state.menu.items)   || [];
  const bundles = (state.menu && state.menu.bundles) || [];
  const html = [];

  items.forEach((it) => {
    const stock = state.inventory[it.item_id] != null ? state.inventory[it.item_id] : 0;
    const badge = stock <= 0 ? '<span class="tile-badge out">Out</span>'
                : stock <= 5 ? '<span class="tile-badge low">Low</span>'
                : '';
    html.push(
      `<button class="tile" data-action="add-item"
         data-id="${escHtml(it.item_id)}"
         data-name="${escHtml(it.name)}"
         data-price="${it.retail_price}">
        ${badge}
        <div class="tile-name">${escHtml(it.name)}</div>
        <div class="tile-price">${fmtPeso(it.retail_price, 0)}</div>
      </button>`
    );
  });

  bundles.forEach((b) => {
    html.push(
      `<button class="tile bundle" data-action="add-bundle"
         data-id="${escHtml(b.bundle_id)}"
         data-name="${escHtml(b.name)}"
         data-price="${b.price}"
         data-siopao-qty="${b.includes_siopao_qty}"
         data-gulaman-qty="${b.includes_gulaman_qty}">
        <div class="tile-name">${escHtml(b.name)}</div>
        <div class="tile-price">${fmtPeso(b.price, 0)}</div>
      </button>`
    );
  });

  $('#tile-grid').innerHTML = html.join('');
}

function flavorName(item_id) {
  const f = ((state.menu && state.menu.items) || []).find((i) => i.item_id === item_id);
  return f ? f.name : item_id;
}

function cartKey(line) {
  return line.type === 'item'
    ? 'item:' + line.id
    : 'bundle:' + line.id + ':' + (line.chosen_siopao || '');
}

function addItemToCart(id, name, unit_price) {
  const existing = state.cart.find((l) => l.type === 'item' && l.id === id);
  if (existing) existing.qty += 1;
  else state.cart.push({ type: 'item', id, qty: 1, unit_price, name });
  renderCart();
}

function addBundleToCart(id, name, unit_price, chosen_siopao) {
  const existing = state.cart.find((l) =>
    l.type === 'bundle' && l.id === id && (l.chosen_siopao || null) === (chosen_siopao || null)
  );
  if (existing) existing.qty += 1;
  else state.cart.push({ type: 'bundle', id, qty: 1, unit_price, name, chosen_siopao });
  renderCart();
}

function renderCart() {
  const ul = $('#cart-lines');
  ul.innerHTML = state.cart.map((l, i) => {
    const flavor = (l.type === 'bundle' && l.chosen_siopao)
      ? `<small>flavor: ${escHtml(flavorName(l.chosen_siopao))}</small>`
      : '';
    return `<li class="cart-line">
      <div class="cl-name">${escHtml(l.name)}${flavor}</div>
      <div class="cl-qty">
        <button data-action="qty-down" data-i="${i}">−</button>
        <span class="qty-num">${l.qty}</span>
        <button data-action="qty-up" data-i="${i}">+</button>
      </div>
      <div class="cl-total">${fmtPeso(l.qty * l.unit_price, 0)}</div>
      <button class="cl-rm" data-action="rm-line" data-i="${i}">×</button>
    </li>`;
  }).join('');

  const subtotal = state.cart.reduce((s, l) => s + l.qty * l.unit_price, 0);
  $('#cart-subtotal').textContent = fmtPeso(subtotal);
  updatePaymentUI(subtotal);
}

function updatePaymentUI(subtotal) {
  document.querySelectorAll('.pay-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.pay === state.payment);
  });

  const cashBlock = $('#cash-block');
  if (state.payment === 'cash') {
    cashBlock.classList.remove('hidden');
    $('#cash-received').textContent = fmtPeso(state.cashReceived, 0);
    const change = state.cashReceived - subtotal;
    const cd = $('#change-due');
    cd.textContent = fmtPeso(change);
    cd.className = 'change-due ' + (change >= 0 ? 'ok' : 'bad');
  } else {
    cashBlock.classList.add('hidden');
  }

  const valid = state.cart.length > 0 && (
    state.payment === 'gcash' ||
    (state.payment === 'cash' && state.cashReceived >= subtotal)
  );
  $('#confirm-sale').disabled = !valid;
}

async function confirmSale() {
  if (state.inflight) return;
  const subtotal = state.cart.reduce((s, l) => s + l.qty * l.unit_price, 0);
  if (subtotal <= 0 || !state.payment) return;
  if (state.payment === 'cash' && state.cashReceived < subtotal) return;

  const sale_id = uuid();
  const itemsArr = state.cart.map((l) => {
    const o = { type: l.type, id: l.id, qty: l.qty, unit_price: l.unit_price };
    if (l.type === 'bundle' && l.chosen_siopao) o.chosen_siopao = l.chosen_siopao;
    return o;
  });

  const payload = {
    sale_id: sale_id,
    timestamp: new Date().toISOString(),
    store_id: state.session.store_id,
    seller_id: state.session.seller_id,
    shift_id: state.session.shift_id,
    items_json: JSON.stringify(itemsArr),
    subtotal: subtotal,
    payment_method: state.payment
  };
  if (state.payment === 'cash') {
    payload.cash_received = state.cashReceived;
    payload.change_given  = state.cashReceived - subtotal;
  }

  state.inflight = true;
  var confirmBtn = $('#confirm-sale');
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = '<span class="spinner"></span> Saving…';
  try {
    // Persist to local queue first — the actual POST happens in the sync
    // loop. This is what makes offline sales work: the seller's screen
    // confirms "Saved" instantly regardless of connection.
    await enqueue('submitSale', payload);
    applyDeltasLocal(itemsArr);
    if (state.payment === 'cash')  state.shiftTotals.expCash  += subtotal;
    if (state.payment === 'gcash') state.shiftTotals.expGcash += subtotal;
    state.shiftTotals.count += 1;
    saveTotals();
    saveInventory();
    state.cart = [];
    state.payment = null;
    state.cashReceived = 0;
    renderSalesView();
    toast(navigator.onLine ? 'Saved' : 'Saved offline — will sync', 'ok');
    syncNow();
    updateConnDot();
  } catch (err) {
    toast('Could not queue: ' + err.message, 'err');
  } finally {
    state.inflight = false;
    // renderSalesView (on success) rebuilds the button via updatePaymentUI,
    // but on failure we need to restore the label manually.
    confirmBtn.textContent = 'Confirm Sale';
  }
}

function applyDeltasLocal(itemsArr) {
  const bundles = ((state.menu && state.menu.bundles) || []);
  const bundleMap = {};
  bundles.forEach((b) => { bundleMap[b.bundle_id] = b; });

  itemsArr.forEach((line) => {
    if (line.type === 'item') {
      state.inventory[line.id] = (state.inventory[line.id] || 0) - line.qty;
    } else if (line.type === 'bundle') {
      const b = bundleMap[line.id];
      if (!b) return;
      if (b.includes_siopao_qty > 0 && line.chosen_siopao) {
        state.inventory[line.chosen_siopao] =
          (state.inventory[line.chosen_siopao] || 0) - b.includes_siopao_qty * line.qty;
      }
      if (b.includes_gulaman_qty > 0) {
        state.inventory['gulaman'] = (state.inventory['gulaman'] || 0) - b.includes_gulaman_qty * line.qty;
      }
    }
  });
}

// ---------- View: close shift ----------
function renderCloseView() {
  $('#close-duration').textContent = formatDuration(state.session.shift_started_at);
  $('#close-count').textContent    = String(state.shiftTotals.count);
  $('#exp-cash').textContent       = fmtPeso(state.shiftTotals.expCash);
  $('#exp-gcash').textContent      = fmtPeso(state.shiftTotals.expGcash);
  state.countedCash  = 0;
  state.countedGcash = 0;
  $('#counted-cash').textContent  = fmtPeso(0, 0);
  $('#counted-gcash').textContent = fmtPeso(0, 0);
  $('#close-notes').value = '';
  updateVariance();
}

function updateVariance() {
  paintVariance($('#var-cash'),  state.countedCash  - state.shiftTotals.expCash);
  paintVariance($('#var-gcash'), state.countedGcash - state.shiftTotals.expGcash);
}

function paintVariance(el, n) {
  const sign = n > 0 ? '+' : '';
  el.textContent = sign + fmtPeso(n);
  el.className = 'var ' + (Math.abs(n) < 0.005 ? 'good' : 'bad');
}

function formatDuration(startedAt) {
  if (!startedAt) return '—';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

async function submitClose() {
  if (state.inflight) return;
  state.inflight = true;
  var closeBtn = $('#submit-close');
  closeBtn.disabled = true;
  closeBtn.innerHTML = '<span class="spinner"></span> Closing…';
  try {
    await enqueue('closeShift', {
      shift_id: state.session.shift_id,
      counted_cash:  state.countedCash,
      counted_gcash: state.countedGcash,
      notes: $('#close-notes').value || ''
    });
    toast(navigator.onLine ? 'Shift closed' : 'Close queued — will sync', 'ok');
    state.session = null;
    state.cart = [];
    state.payment = null;
    state.cashReceived = 0;
    state.countedCash = 0;
    state.countedGcash = 0;
    saveSession();
    clearTotals();
    showView('store');
    syncNow();
    updateConnDot();
  } catch (err) {
    toast('Could not queue close: ' + err.message, 'err');
  } finally {
    state.inflight = false;
    closeBtn.disabled = false;
    closeBtn.textContent = 'Submit Close';
  }
}

// ---------- Modal: flavor picker ----------
function openFlavorModal(bundleId, bundleName, unitPrice) {
  state.pendingBundle = { id: bundleId, name: bundleName, unit_price: unitPrice };
  $('#flavor-title').textContent = 'Which flavor for ' + bundleName + '?';
  const siopaos = ((state.menu && state.menu.items) || []).filter((i) => i.category === 'siopao');
  $('#flavor-options').innerHTML = siopaos.map((s) =>
    `<button data-action="pick-flavor" data-id="${escHtml(s.item_id)}">${escHtml(s.name)}</button>`
  ).join('');
  $('#flavor-modal').classList.remove('hidden');
}
function closeFlavorModal() {
  state.pendingBundle = null;
  $('#flavor-modal').classList.add('hidden');
}

// ---------- Modal: numpad ----------
function openNumpad(title, initial, cb) {
  state.numpadValue = Number(initial) || 0;
  state.numpadCb = cb;
  $('#numpad-title').textContent = title;
  $('#numpad-value').textContent = fmtPeso(state.numpadValue, 0);
  $('#numpad-modal').classList.remove('hidden');
}
function closeNumpad() {
  state.numpadCb = null;
  $('#numpad-modal').classList.add('hidden');
}

// ---------- Event delegation ----------
document.addEventListener('click', (e) => {
  const tEl = e.target.closest('[data-action], [data-digit], [data-cashdigit], [data-modaldigit], [data-pay], [data-counted]');
  if (!tEl) return;

  // PIN pad digit
  if (tEl.dataset.digit !== undefined) {
    if (state.pinDigits.length < 4) {
      state.pinDigits += tEl.dataset.digit;
      $('#pin-error').innerHTML = '&nbsp;';
      updatePinDots();
      if (state.pinDigits.length === 4) onPinComplete();
    }
    return;
  }

  // Inline cash-received numpad
  if (tEl.dataset.cashdigit !== undefined) {
    state.cashReceived = state.cashReceived * 10 + Number(tEl.dataset.cashdigit);
    if (state.cashReceived > 1000000) state.cashReceived = 1000000;
    renderCart();
    return;
  }

  // Modal numpad digit
  if (tEl.dataset.modaldigit !== undefined) {
    state.numpadValue = state.numpadValue * 10 + Number(tEl.dataset.modaldigit);
    if (state.numpadValue > 1000000) state.numpadValue = 1000000;
    $('#numpad-value').textContent = fmtPeso(state.numpadValue, 0);
    return;
  }

  // Payment selector
  if (tEl.dataset.pay) {
    state.payment = tEl.dataset.pay;
    if (state.payment === 'gcash') state.cashReceived = 0;
    renderCart();
    return;
  }

  // Counted-field tap → open modal numpad
  if (tEl.dataset.counted) {
    if (tEl.dataset.counted === 'cash') {
      openNumpad('Counted cash', state.countedCash, (v) => {
        state.countedCash = v;
        $('#counted-cash').textContent = fmtPeso(v, 0);
        updateVariance();
      });
    } else {
      openNumpad('Counted GCash', state.countedGcash, (v) => {
        state.countedGcash = v;
        $('#counted-gcash').textContent = fmtPeso(v, 0);
        updateVariance();
      });
    }
    return;
  }

  const action = tEl.dataset.action;
  switch (action) {
    case 'pick-store':
      // Pre-warm the API instance now so PIN completion (a few seconds out)
      // lands on a warm Apps Script worker instead of paying the 5-10s
      // cold-start tax on its loginAndStartShift call.
      preWarm();
      state.pendingStoreId   = tEl.dataset.storeId;
      state.pendingStoreName = tEl.dataset.storeName;
      renderPinView();
      showView('pin');
      break;
    case 'back-to-stores':
      state.pendingStoreId = null;
      state.pinDigits = '';
      showView('store');
      break;

    case 'pin-back':
      state.pinDigits = state.pinDigits.slice(0, -1);
      updatePinDots();
      break;
    case 'pin-clear':
      state.pinDigits = '';
      updatePinDots();
      break;

    case 'cash-back':
      state.cashReceived = Math.floor(state.cashReceived / 10);
      renderCart();
      break;
    case 'cash-clear':
      state.cashReceived = 0;
      renderCart();
      break;

    case 'numpad-back':
      state.numpadValue = Math.floor(state.numpadValue / 10);
      $('#numpad-value').textContent = fmtPeso(state.numpadValue, 0);
      break;
    case 'numpad-clear':
      state.numpadValue = 0;
      $('#numpad-value').textContent = fmtPeso(0, 0);
      break;
    case 'numpad-cancel':
      closeNumpad();
      break;
    case 'numpad-ok':
      if (state.numpadCb) state.numpadCb(state.numpadValue);
      closeNumpad();
      break;

    case 'add-item':
      addItemToCart(tEl.dataset.id, tEl.dataset.name, Number(tEl.dataset.price));
      break;
    case 'add-bundle': {
      const sQty = Number(tEl.dataset.siopaoQty);
      if (sQty > 0) {
        openFlavorModal(tEl.dataset.id, tEl.dataset.name, Number(tEl.dataset.price));
      } else {
        addBundleToCart(tEl.dataset.id, tEl.dataset.name, Number(tEl.dataset.price), null);
      }
      break;
    }
    case 'pick-flavor': {
      const flavor = tEl.dataset.id;
      const b = state.pendingBundle;
      closeFlavorModal();
      if (b) addBundleToCart(b.id, b.name, b.unit_price, flavor);
      break;
    }
    case 'cancel-flavor':
      closeFlavorModal();
      break;

    case 'qty-up':  state.cart[Number(tEl.dataset.i)].qty += 1; renderCart(); break;
    case 'qty-down': {
      const i = Number(tEl.dataset.i);
      if (state.cart[i].qty > 1) state.cart[i].qty -= 1;
      else state.cart.splice(i, 1);
      renderCart();
      break;
    }
    case 'rm-line':
      state.cart.splice(Number(tEl.dataset.i), 1);
      renderCart();
      break;

    case 'open-close-shift':
      renderCloseView();
      showView('close');
      break;
    case 'cancel-close':
      showView('sales');
      break;
  }
});

// Two singleton buttons — direct binding rather than threading a data-action through.
document.addEventListener('click', (e) => {
  if (e.target.id === 'confirm-sale' && !e.target.disabled) confirmSale();
  if (e.target.id === 'submit-close' && !e.target.disabled) submitClose();
});

window.addEventListener('online',  () => { syncNow(); updateConnDot(); });
window.addEventListener('offline', updateConnDot);

// ---------- Install-to-home-screen ----------
// Chrome/Edge fires beforeinstallprompt when the PWA is installable. We
// stash the event so a user gesture (tap on the install chip) can call
// .prompt() on it later — browsers only honor prompt() during a user
// gesture, not on page load.
let installPromptEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPromptEvent = e;
  const btn = $('#install-btn');
  if (btn) btn.hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPromptEvent = null;
  const btn = $('#install-btn');
  if (btn) btn.hidden = true;
});
document.addEventListener('click', (e) => {
  if (e.target.id !== 'install-btn' || !installPromptEvent) return;
  installPromptEvent.prompt();
  installPromptEvent.userChoice.finally(() => {
    installPromptEvent = null;
    $('#install-btn').hidden = true;
  });
});
// Tab returning to foreground after sleep — most likely time for the queue
// to have stalled (timers pause in the background on mobile).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { syncNow(); updateConnDot(); }
});
// Tapping the connection dot manually retries — handy when something's stuck.
document.addEventListener('click', (e) => {
  if (e.target.id === 'conn-dot') { syncNow(); updateConnDot(); }
});

// ---------- Init ----------
async function init() {
  loadMenu();
  loadSession();
  loadInventory();
  loadTotals();
  startSyncLoop();
  // Kick off an immediate drain in case a prior session left items behind.
  syncNow();
  updateConnDot();

  if (navigator.onLine) {
    try {
      state.menu = await api('getMenu');
      saveMenu();
    } catch (err) {
      console.warn('Menu fetch failed:', err);
    }
  }

  if (!state.menu) {
    document.body.innerHTML =
      '<div style="padding:24px;text-align:center;font-family:sans-serif;">' +
      'No connection and no cached menu. Connect to internet and reload.</div>';
    return;
  }

  renderStoreView();

  // Resume an existing session if the server confirms it's still active.
  if (state.session && state.session.shift_id) {
    if (navigator.onLine) {
      try {
        const active = await api('getActiveShift', { store_id: state.session.store_id });
        if (active && active.shift_id === state.session.shift_id) {
          await enterSalesView();
          maybeRegisterSW();
          return;
        }
        // Shift was closed elsewhere → drop the session.
        state.session = null;
        saveSession();
        clearTotals();
      } catch (err) {
        // Network error on resume — fall through to store picker rather than
        // trapping the seller in a possibly-stale session.
        toast('Could not verify session: ' + err.message, 'warn');
      }
    } else {
      // Offline: trust the local session, work from cached menu+inventory.
      renderSalesView();
      showView('sales');
      maybeRegisterSW();
      return;
    }
  }

  showView('store');
  maybeRegisterSW();
}

function maybeRegisterSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW reg failed:', err));
  }
}

init();
