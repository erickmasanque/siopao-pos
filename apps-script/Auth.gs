/**
 * Auth.gs
 * --------
 * Seller PIN verification (public) and admin allowlist gate.
 *
 * PIN model (per D3 + D4):
 *   - 4-digit numeric PIN
 *   - Per-seller random salt (128-bit), stored alongside pin_hash
 *   - pin_hash = SHA-256(pin + salt), hex-encoded
 *   - Uniqueness enforced per store, not globally — verifyPin scans only
 *     active sellers in the requested store
 *
 * Admin gate (per D2/D10):
 *   - Apps Script web app is deployed "Execute as: Me" so the script's
 *     own identity owns the sheet. The CALLER's identity is read via
 *     Session.getActiveUser().getEmail() — only populated when the caller
 *     is signed in to the same Google Workspace as the script owner.
 *   - ADMIN_EMAILS is a comma-separated list in Script Properties.
 */

/** SHA-256(pin + salt) → lowercase hex. */
function hashPin_(pin, salt) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(pin) + String(salt)
  );
  return bytes.map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

/**
 * 128-bit salt as 32 hex chars. Uses Utilities.getUuid() which is backed
 * by java.util.UUID.randomUUID() — cryptographically secure, unlike
 * Math.random().
 */
function generateSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}

/**
 * Verify a seller's PIN for a given store.
 * Returns { seller_id, seller_name } on match, or null on miss.
 * Throws on malformed input (4-digit numeric required).
 */
function verifyPin(params) {
  var store_id = params && params.store_id;
  var pin = params && params.pin;
  if (!store_id) throw new Error('store_id required');
  if (pin === undefined || pin === null) throw new Error('pin required');
  if (!/^\d{4}$/.test(String(pin))) throw new Error('PIN must be 4 digits');

  var sellers = readTable_(TABS.SELLERS).filter(function (s) {
    return s.active && s.store_id === store_id;
  });

  for (var i = 0; i < sellers.length; i++) {
    var s = sellers[i];
    if (s.pin_salt && hashPin_(pin, s.pin_salt) === s.pin_hash) {
      return { seller_id: s.seller_id, seller_name: s.name };
    }
  }
  return null;
}

/**
 * Throw unless the calling user is in ADMIN_EMAILS (Script Properties,
 * comma-separated). Returns the verified email on success.
 *
 * NOTE: Session.getActiveUser().getEmail() returns '' for callers outside
 * the script owner's Google Workspace. That's the expected behavior — the
 * admin app needs to be opened by the sister while signed in to her
 * Google account, and the script must be deployed as a webapp she can
 * access (typically deployed by her, or shared with her).
 */
/**
 * Compound endpoint — collapses the seller login + shift-start flow into
 * a single HTTP round-trip. Apps Script web apps have ~500ms-3s per call
 * (much worse on a cold instance), so the original 3-call sequence
 * (verifyPin → getActiveShift → startShift) was killing PIN-pad UX.
 *
 * Includes the store's current inventory in the response so the sales
 * view can paint immediately without a 4th call.
 *
 * Response shapes:
 *   - wrong PIN:        { verified: false }
 *   - other seller has active shift:
 *       { verified: true, conflict: true, active_seller_name: "..." }
 *   - same seller resuming an open shift:
 *       { verified: true, seller, shift, resumed: true, inventory }
 *   - fresh shift started:
 *       { verified: true, seller, shift, resumed: false, inventory }
 *
 * Reentrancy: Apps Script's LockService is reentrant on the same thread,
 * so calling startShift() (which takes the lock again) inside withLock_
 * here is a no-op on the inner waitLock and remains safe.
 */
function loginAndStartShift(params) {
  return withLock_(function () {
    const store_id = params && params.store_id;
    const pin      = params && params.pin;
    const shift_id = params && params.shift_id;
    if (!shift_id) throw new Error('shift_id required (client-generated UUID)');

    const seller = verifyPin({ store_id: store_id, pin: pin });
    if (!seller) return { verified: false };

    const active = getActiveShift({ store_id: store_id });
    if (active) {
      if (active.seller_id !== seller.seller_id) {
        return {
          verified: true,
          conflict: true,
          active_seller_name: active.seller_name || active.seller_id
        };
      }
      return {
        verified: true,
        resumed: true,
        seller: seller,
        shift: { shift_id: active.shift_id, start_time: active.start_time },
        inventory: getInventory({ store_id: store_id })
      };
    }

    startShift({ seller_id: seller.seller_id, store_id: store_id, shift_id: shift_id });
    return {
      verified: true,
      resumed: false,
      seller: seller,
      shift: { shift_id: shift_id, start_time: new Date() },
      inventory: getInventory({ store_id: store_id })
    };
  });
}

function requireAdmin_() {
  var email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var raw = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '';
  var allow = raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  if (!email || allow.indexOf(email) < 0) {
    throw new Error('Admin access required');
  }
  return email;
}
