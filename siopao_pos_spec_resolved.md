# Siopao POS System — Resolved Build Spec

> This is the **source-of-truth** spec. It supersedes `siopao_pos_spec.md`.
> Any later changes during the build are patched into this file.
>
> **Last updated**: 2026-05-24 — initial resolution after Q&A round 1.

---

## 0. Resolved Decisions (from Q&A)

| # | Topic | Decision |
|---|---|---|
| D1 | Sheet creation | Apps Script bootstraps the workbook (8 tabs + headers + seed) on first call. Idempotent — safe to re-run. |
| D2 | Deployment | Apps Script web app deployed as **Execute as: Me**, **Who has access: Anyone**. |
| D3 | PIN hashing | **Per-seller salt** stored in the `Sellers` row next to `pin_hash`. Algorithm: `SHA-256(pin + salt)` where salt is 16 random bytes hex-encoded. |
| D4 | PIN uniqueness | Enforced **per store**, not globally. Two sellers in different stores may share a PIN. |
| D5 | Rate limiting | None in v1. |
| D6 | Stores | A dedicated **`Stores`** tab is added (8th tab). All `store` columns elsewhere reference `store_id`. Seed: `loc_a` / `loc_b`. Future stores added via admin UI later (out of scope for v1 — direct sheet edit is fine for now). |
| D7 | Void on closed shift | Voids **never** rewrite a closed shift's `expected_*` or `variance_*`. The historical close stays intact. Voids show in the sales log and are surfaced on the shift detail view as a separate flag. |
| D8 | Bundle flavor validation | Backend **rejects** any bundle sale whose `chosen_siopao` is not an active `category=siopao` item. Clear error returned. |
| D9 | Bundle line grouping | Same bundle + same chosen flavor = qty incremented on one line. Different chosen flavor of the same bundle = separate line. |
| D10 | Hosting | **GitHub Pages, public repo.** No secrets in frontend; the Apps Script `/exec` URL is fine to expose. Admin allowlist lives in Script Properties, not in the repo. |
| D11 | Currency rounding | PHP, **half-up to the centavo** (2 decimal places). |

---

## 1. Project Overview

Mobile-first PWA point-of-sale system for a 2-store siopao business in the Philippines. Backend is Google Apps Script, database is Google Sheets, frontend is a vanilla JS PWA installable on phone. Designed for one phone per store, one active seller at a time, with offline-tolerant sales recording that syncs when internet returns.

---

## 2. Problems It Solves

- End-of-day cash not matching expected sales (because not every transaction got recorded).
- Sellers occasionally giving wrong change — system auto-computes change.
- No real-time visibility into per-store inventory or per-seller performance.
- Owner (sister) has no way to see daily totals without being at the store.

---

## 3. Tech Stack

- **Backend**: Google Apps Script, deployed as a Web App.
- **Database**: Google Sheets (single workbook, 8 tabs — see §6).
- **Frontend**: Vanilla JS/HTML/CSS PWA, hosted on **GitHub Pages (public repo)**. Service worker for installability + app-shell offline cache.
- **Offline queue**: IndexedDB for unsynced sales and shift closes.
- **Auth**:
  - Sellers — 4-digit PIN, hashed with per-seller salt (SHA-256).
  - Admin — Google login. Apps Script reads `Session.getActiveUser().getEmail()` and checks against `ADMIN_EMAILS` in Script Properties.

### 3.1 Repo Layout

```
siopao-pos/
├── apps-script/        # Backend .gs source (mirrored to Apps Script project via clasp or manual copy)
│   ├── Code.gs
│   ├── Schema.gs
│   ├── Auth.gs
│   ├── Sales.gs
│   ├── Shifts.gs
│   ├── Inventory.gs
│   ├── Admin.gs
│   └── appsscript.json
├── web/                # Frontend deployed to GitHub Pages
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── sw.js
│   └── manifest.webmanifest
└── siopao_pos_spec_resolved.md   # This file — source of truth
```

---

## 4. User Roles

| Role | Login | Capabilities |
|------|-------|--------------|
| Seller | Pick store → enter 4-digit PIN | Make sales, void cart items pre-confirm, close own shift |
| Admin (sister) | Google login | Add/edit inventory, restock, edit prices, add/remove/reset sellers, view all sales and shifts, void confirmed sales |

---

## 5. Screen Specifications

### 5.1 Seller — Login
- Two big buttons: store names read from `Stores` tab (so they can be renamed without code change).
- After store pick: 4-digit PIN numpad (custom, not native keyboard).
- On success: creates a new row in `Shifts` (start_time, seller_id, store_id, shift_id), routes to Sales screen.
- If an active (unclosed) shift already exists for the chosen store, prompt: "An active shift is open under [Name]. Close it first?" — only the original seller can close it (with PIN), or admin can force-close from admin panel.

### 5.2 Seller — Sales (the main screen)
- **Top bar**: store name, seller name, online/offline dot, "End Shift" button.
- **Tile grid**: one tile per active `Item` and one tile per active `Bundle`.
- Tapping an Item tile → adds 1 to cart at its retail price.
- Tapping a Bundle tile → if `includes_siopao_qty > 0`, popup asks "Which flavor?" (active `category=siopao` items only); after selection, bundle is added to cart with the chosen flavor recorded. Same bundle+flavor combo increments qty on the existing line; different flavor creates a new line (D9).
- **Cart panel**: each line with qty `−` / `+` / remove. Running subtotal in large text.
- **Payment selector**: **Cash** / **GCash**.
  - Cash: numpad for "Cash received". Below it, "Change: ₱X" — green if ≥ 0, red if insufficient (confirm disabled).
  - GCash: no cash input, just confirm.
- **Confirm Sale**: writes Sale row, decrements Inventory, clears cart, brief toast "Saved" (or "Saved offline — will sync").
- **Low stock badge** on tiles when stock ≤ 5; **Out badge** when stock ≤ 0 (still tappable; inventory can go negative per §7.7).

### 5.3 Seller — Close Shift
- Shift duration + sale count.
- **Cash section**: Expected ₱X (sum of non-voided cash sales this shift, computed at close time per D7) | input "Counted cash" | Variance.
- **GCash section**: Expected ₱X | input "Counted GCash" | Variance.
- Optional notes field.
- **Submit Close**: updates the Shift row with end_time, counted_*, variance_*; logs seller out.

### 5.4 Admin — Dashboard
- Today's totals: revenue per store, split cash vs GCash, sale count.
- Items sold today (best-sellers list).
- Active shifts right now (with seller name and store).
- Recent variance alerts (any shift closed today with `|variance| > ₱20`).
- Quick links to other admin screens.

### 5.5 Admin — Inventory
- Table: Store | Item | Stock | Last restocked.
- Per row: **+ Restock** button → modal (qty, optional notes). On submit: writes Restock row, increments Inventory.
- Filter by store.

### 5.6 Admin — Menu & Prices
- **Items** list: name, price, category, active toggle. Edit price inline. Add new Item.
- **Bundles** list: name, price, includes_siopao_qty, includes_gulaman_qty, active toggle. Edit. Add new Bundle.
- Price edits affect future sales only; historical sales retain the price stored on the sale row.

### 5.7 Admin — Sellers
- List: name, default store, active, last shift date.
- **Add seller**: name, store, set 4-digit PIN (hashed with per-seller salt before storing).
- **Reset PIN**, **Deactivate**.

### 5.8 Admin — Sales Log
- Filters: date range, store, seller, payment method, voided y/n.
- Each row: timestamp, store, seller, items summary, total, payment method, cash received, change.
- **Void** button → confirmation + reason input → marks `voided=true`, restores inventory, excludes from *future* shift totals (a closed shift's stored numbers are NOT rewritten per D7; the voided sale is flagged on the shift detail view).

### 5.9 Admin — Shift History
- Filters: date range, store, seller.
- Each row: shift start/end, total sales (cash + gcash), counted cash + variance, counted gcash + variance.
- Rows with notable variance highlighted.
- Voids that occurred *after* a shift was closed are shown as separate flags on the shift detail view (per D7).

---

## 6. Data Schema (Google Sheets)

One workbook, one tab per table. Header row in row 1.

### `Stores` *(new — per D6)*
| Column | Type | Notes |
|---|---|---|
| store_id | string | Unique slug, e.g. `loc_a` |
| name | string | Display name, editable |
| active | boolean | |

### `Items`
| Column | Type | Notes |
|---|---|---|
| item_id | string | Unique slug, e.g. `asado` |
| name | string | Display name |
| retail_price | number | Per-piece price (PHP) |
| category | string | `siopao`, `drink`, etc. |
| active | boolean | Hide from tile grid if false |

### `Bundles`
| Column | Type | Notes |
|---|---|---|
| bundle_id | string | Unique slug |
| name | string | Display name |
| price | number | Total bundle price |
| includes_siopao_qty | number | Pieces of chosen siopao to deduct |
| includes_gulaman_qty | number | Gulaman to deduct |
| active | boolean | |

### `Inventory`
| Column | Type | Notes |
|---|---|---|
| store_id | string | FK → Stores.store_id |
| item_id | string | FK → Items.item_id |
| stock | number | Current count (may be negative — see §7.7) |
| updated_at | datetime | |

### `Sellers`
| Column | Type | Notes |
|---|---|---|
| seller_id | string | Unique slug |
| name | string | |
| store_id | string | Default store (FK) |
| pin_hash | string | SHA-256(pin + salt) hex |
| pin_salt | string | 16 random bytes hex, per-seller (D3) |
| active | boolean | |

### `Shifts`
| Column | Type | Notes |
|---|---|---|
| shift_id | string | UUID, client-generated |
| seller_id | string | FK |
| store_id | string | FK |
| start_time | datetime | |
| end_time | datetime | Null until closed |
| expected_cash | number | Frozen at close (D7) |
| counted_cash | number | Seller-entered |
| variance_cash | number | counted − expected |
| expected_gcash | number | Frozen at close (D7) |
| counted_gcash | number | Seller-entered |
| variance_gcash | number | |
| notes | string | Optional |

### `Sales`
| Column | Type | Notes |
|---|---|---|
| sale_id | string | UUID, generated client-side (offline-safe) |
| timestamp | datetime | Client time at sale |
| store_id | string | FK |
| seller_id | string | FK |
| shift_id | string | FK |
| items_json | string | JSON array — see structure below |
| subtotal | number | |
| payment_method | string | `cash` or `gcash` |
| cash_received | number | Null if gcash |
| change_given | number | Null if gcash |
| voided | boolean | Default false |
| void_reason | string | |
| voided_by | string | Admin email |
| voided_at | datetime | |
| synced_at | datetime | When server received it |

**`items_json` structure**:
```json
[
  {"type":"item", "id":"asado", "qty":2, "unit_price":28},
  {"type":"bundle", "id":"combo", "qty":1, "unit_price":39, "chosen_siopao":"bola_bola"},
  {"type":"bundle", "id":"pack", "qty":1, "unit_price":250, "chosen_siopao":"asado"}
]
```

### `Restocks`
| Column | Type | Notes |
|---|---|---|
| restock_id | string | UUID |
| timestamp | datetime | |
| store_id | string | FK |
| item_id | string | FK |
| qty_added | number | |
| added_by | string | Admin email |
| notes | string | |

---

## 7. Business Rules

1. **Single Item sale** — decrement stock of that item by qty in `Inventory` for that store.
2. **Combo** (`includes_siopao_qty=1`, `includes_gulaman_qty=1`) — decrement 1 of chosen siopao flavor + 1 gulaman per qty.
3. **Pack** (`includes_siopao_qty=10`) — decrement 10 of chosen siopao flavor per qty.
4. **Voids** never delete a row. Setting `voided=true`:
   - Restores inventory (re-adds the deducted quantities).
   - Excludes the sale from future shift-total computations.
   - Does **not** rewrite a closed shift's stored `expected_*` / `variance_*` numbers (D7) — that history is preserved.
5. **Shift = login session.** Starts at PIN login, ends at "End Shift". Multiple shifts per store per day allowed sequentially, but only one *active* (unclosed) shift per store at a time.
6. **Expected cash at close** = sum of non-voided cash sales where `shift_id = current shift`, computed *at the moment of close*. Stored on the Shift row and never recomputed.
7. **Inventory can go negative** with a warning. Show "⚠ Low stock" badge on tiles when stock ≤ 5, and "Out" badge when stock ≤ 0 (still tappable, warned).
8. **Prices on a sale row are frozen** at sale time (stored in `items_json`). Editing prices in `Items` / `Bundles` affects future sales only.
9. **PINs**: 4 digits, unique within a store (D4). Hashed with per-seller salt (D3).
10. **Bundle line grouping** (D9): same bundle + same chosen flavor = qty++ on existing line. Different chosen flavor = new line.
11. **Bundle flavor validation** (D8): backend rejects bundle sales with invalid/inactive `chosen_siopao`. Frontend already restricts the picker to active siopaos, so this guards against tampered offline-queue payloads.
12. **Currency rounding** (D11): half-up to the centavo. Apply at display time and at any computation that produces a stored monetary value.

---

## 8. Offline Behavior

- Service worker caches the app shell so it loads when offline.
- On successful online load, app fetches `Stores`, `Items`, `Bundles`, and `Inventory` snapshot → stores in localStorage.
- **Making a sale offline**:
  1. Generate `sale_id` (UUID) client-side.
  2. Decrement local Inventory cache.
  3. Push the sale into the IndexedDB sync queue.
  4. Show "Saved offline — will sync".
- **Sync loop**: every 30 seconds when online, POST queued items to Apps Script `submitSale` endpoint in FIFO order; on 200 (or "duplicate, already exists" — see idempotency below), remove from queue.
- **Close shift offline**: writes to local queue too; syncs identically.
- **On reconnect**: refetch server inventory after queue drains.
- **Connection indicator** (top of app): 🟢 online & synced · 🟡 online, syncing · 🔴 offline.

### 8.1 Idempotency contract
`submitSale` is idempotent on `sale_id`. If the Sheet already has a row with that `sale_id`, the endpoint returns `{ok: true, duplicate: true}` without inserting. Client treats both `duplicate: true` and a fresh insert as success and removes the item from the queue. Same contract for `closeShift` on `shift_id`.

---

## 9. Initial Seed Data

### `Stores` rows
| store_id | name | active |
|---|---|---|
| loc_a | Location A | true |
| loc_b | Location B | true |

### `Items` rows
| item_id | name | retail_price | category | active |
|---|---|---|---|---|
| asado | Asado | 28 | siopao | true |
| bola_bola | Bola Bola | 28 | siopao | true |
| supreme_mix | Supreme Mix | 28 | siopao | true |
| chocolate | Chocolate | 28 | siopao | true |
| gulaman | Gulaman | 15 | drink | true |

### `Bundles` rows
| bundle_id | name | price | includes_siopao_qty | includes_gulaman_qty | active |
|---|---|---|---|---|---|
| combo | Combo (Siopao + Gulaman) | 39 | 1 | 1 | true |
| pack | Pack of 10 | 250 | 10 | 0 | true |

### `Inventory` rows
Seed 0 stock per item per store; admin restocks from UI once deployed.

### Admin allowlist
`ADMIN_EMAILS` set in **Script Properties** (NOT in source). User to provide sister's Gmail when ready.

---

## 10. Out of Scope (v1)

Discounts/promos, GCash reference tracking, receipts, customer accounts, split payments, multiple devices per store concurrently, tax/VAT, CSV exports beyond Sheets-native, push notifications, multi-currency, in-app store management UI (add new stores via direct sheet edit for now).

---

## 11. Build Order (strict)

1. **Apps Script backend** — all endpoints below, with idempotent bootstrap.
2. **PWA shell** — manifest, service worker, routing, GitHub Pages deploy.
3. **Seller flow ONLINE-ONLY first** — login → sales → close shift. Get one full sale flowing end-to-end before moving on.
4. **IndexedDB queue + sync loop + connection indicator.**
5. **Admin app** — dashboard, inventory, menu, sellers, sales log, shift history.
6. **Polish** — large tap targets, loading states, error toasts, install prompt.

### 11.1 Endpoint Inventory

Public (no auth):
- `verifyPin(store_id, pin) → {seller_id, seller_name} | null`
- `startShift(seller_id, store_id, shift_id) → {ok}` *(shift_id provided by client)*
- `getMenu() → {stores, items, bundles}`
- `getInventory(store_id) → [{item_id, stock}, ...]`
- `submitSale(sale)` — idempotent on `sale_id`
- `closeShift(shift_id, counted_cash, counted_gcash, notes)` — idempotent on `shift_id` end
- `getActiveShift(store_id) → {shift_id, seller_id, seller_name, start_time} | null`

Admin (gated by `ADMIN_EMAILS` check):
- `getDashboard()`
- `restock(store_id, item_id, qty, notes)`
- `updateItem(item_id, fields)`
- `updateBundle(bundle_id, fields)`
- `addSeller(name, store_id, pin)` — server hashes
- `resetPin(seller_id, pin)`
- `deactivateSeller(seller_id)`
- `forceCloseShift(shift_id)` — admin override
- `voidSale(sale_id, reason)`
- `getSalesLog(filters)`
- `getShiftHistory(filters)`

---

## 12. UX Constraints

- 6"–6.5" phone, test at 375×812 minimum.
- Buttons ≥ 48×48 pt; primary action buttons larger.
- Prices and totals always large and high-contrast. Change due in extra-large type.
- Custom numpads inline — no native keyboard during sales.
- ≤ 3 items + payment fits one screen without scrolling.

---

## 13. Change Log

- **2026-05-24** — initial resolved spec. Decisions D1–D11 locked in. Added `Stores` tab. Added `pin_salt` column to `Sellers`. Renamed all `store` FKs to `store_id`. Hosting set to GitHub Pages public. Added §8.1 idempotency contract. Added `getActiveShift` + `forceCloseShift` to endpoint inventory.
