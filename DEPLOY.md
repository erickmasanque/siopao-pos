# Deployment guide — Siopao POS

The human checklist for getting this in your sister's hands.

The project has two halves: an **Apps Script backend** bound to a Google Sheet, and a **vanilla PWA frontend** hosted on GitHub Pages. The admin app is served by the Apps Script web app itself (same-origin requirement for `Session.getActiveUser()` to work on a personal Gmail account).

## 1. Backend (Google Apps Script)

### First-time setup

1. Open the bound spreadsheet → **Extensions → Apps Script**.
2. Rename the project (top-left) to `Siopao POS`.
3. **For each `.gs` file** in [apps-script/](apps-script/) (10 files): in the editor sidebar, **+ → Script** with the filename minus the extension (e.g. `Schema`, not `Schema.gs`), then paste in the file contents. The default `Code.gs` already exists — open it and paste in instead of creating a new one.
4. **For the HTML file** [apps-script/admin.html](apps-script/admin.html): **+ → HTML** → name it `admin` → paste contents.
5. **For `appsscript.json`:** click the gear ⚙ (**Project Settings**) → tick **"Show 'appsscript.json' manifest file in editor"** → back to **Editor**, open `appsscript.json` → replace with [apps-script/appsscript.json](apps-script/appsscript.json).
6. Save everything (Ctrl+S).
7. **Run setupWorkbook** — function dropdown → `setupWorkbook` → **Run**. Approve permissions on the prompt (it'll ask for Sheets access). This creates the 8 tabs with seed data.
8. **Set the admin password** — open `Bootstrap.gs` in the editor and find `setupAdminPassword_dev`. Edit the two constants near the top:
   ```js
   var USERNAME = 'admin';           // or whatever you want — sister types this on the login form
   var PASSWORD = 'pick-something';  // strong password, you'll log in with this
   ```
   Save → function dropdown → `setupAdminPassword_dev` → **Run**. This writes `ADMIN_USERNAME` / `ADMIN_PASS_HASH` / `ADMIN_PASS_SALT` into Script Properties. **Clear the editor logs afterward** so the plaintext password doesn't linger there.

   You can re-run this any time to change the password. (Don't put the new password into a commit — it lives only inside the editor.)

### Deploy the web app

1. Top-right → **Deploy → New deployment**.
2. Gear icon → **Web app**.
3. **Execute as: Me**, **Who has access: Anyone**.
4. **Deploy** → authorize → copy the **Web app URL** (ends in `/exec`).
5. Note this URL — it's the seller frontend's `API_URL` and the admin app's base.

### Updating after code changes

- **Deploy → Manage deployments** → pencil on the existing deployment → **Version: New version** → Deploy.
- This keeps the `/exec` URL stable. The frontend doesn't need updating.
- Using **New deployment** instead of New version assigns a fresh URL — only do this if you intentionally want to break the old URL.

## 2. Seller frontend (GitHub Pages)

### Push to GitHub

```
git remote add origin git@github.com:<your-username>/siopao-pos.git
git push -u origin main
```

### Enable Pages

1. Repo on github.com → **Settings → Pages**.
2. **Source: Deploy from a branch**.
3. Branch: `main`, Folder: `/docs`.
4. Save. After ~1 minute the URL appears: `https://<username>.github.io/siopao-pos/`.

### Make sure `API_URL` in app.js matches your deployment

Open [docs/app.js](docs/app.js) — near the top is `const API_URL = '...'`. If you redeployed in a way that changed the URL (only happens if you used **New deployment** instead of **New version**), update this string, commit, and push.

## 3. Install on phone (one per store)

### Android (Chrome)

1. Open `https://<username>.github.io/siopao-pos/` in Chrome.
2. The **"Install app"** chip appears top-left → tap → confirm.
3. App icon appears on the home screen — taps open in standalone mode (no browser chrome).

### iOS (Safari)

iOS doesn't honor `beforeinstallprompt`. Use the manual flow:
1. Open in Safari → Share → **Add to Home Screen**.

## 4. Admin app (sister)

URL: `https://<username>.github.io/siopao-pos/admin.html` — that's a tiny redirect page on the same host as the seller PWA that forwards to the actual admin app on Apps Script. Bookmarkable and easy to remember.

(The underlying admin app is served by Apps Script at `…/exec?page=admin` — it has to live there because `Session.getActiveUser()` / `google.script.run` only work inside Apps Script's own iframe. The redirect just hides that detail.)

If you ever redeploy with a **new** URL (you used "New deployment" instead of "New version"), update [docs/admin.html](docs/admin.html) to point to the new `/exec` URL and push.

The login form takes the username + password you set with `setupAdminPassword_dev`. No Google sign-in required — anyone with the URL + credentials can access. Credentials are saved in the browser's local storage so subsequent visits skip the login form. The **Log out** button in the top-right clears them.

### First-day setup via admin

1. Open the admin URL → log in with the credentials you set in step 1.8.
2. **Sellers tab → + Add seller** — name, store, 4-digit PIN. Repeat for each real seller.
3. **Inventory tab** — restock each item per store to whatever you actually have on hand.
4. **Menu & Prices** — adjust prices if the seed values aren't current.

## 5. End-to-end smoke test on real device

- [ ] Seller PWA loads on the phone
- [ ] Tap a store → enter PIN → land on sales view within ~3s on warm instance
- [ ] Tap items / bundle (pick a flavor) → see cart populate
- [ ] Cash sale → enter received → confirm → toast "Saved"
- [ ] GCash sale → confirm → toast "Saved"
- [ ] End Shift → enter counted cash/GCash → submit → log out
- [ ] Admin app: dashboard shows the sales just made
- [ ] Admin: sales log shows both rows, totals match

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Admin page shows "credentials not configured" | `setupAdminPassword_dev` never ran (or Script Properties got wiped) | Re-run `setupAdminPassword_dev` from the Apps Script editor |
| Admin login shows "Invalid admin credentials" | Wrong username or password typed (or the password was changed since the browser stored it) | Re-enter the current credentials; the new login replaces the saved ones |
| Admin: forgot the password | Recovery path | Edit `setupAdminPassword_dev` constants in the editor → Run again — overwrites with the new password |
| Seller login takes 10+ seconds | Cold-start of Apps Script instance after >6 min idle | Normal; subsequent logins are 2-3s. The pre-warm on store-tap mitigates. |
| `Unknown method: X` on a call | Stale deployment | Manage deployments → New version |
| Sales not appearing in sheet | Offline queue not synced | Connection dot should be green; tap it to force sync |
| Connection dot is yellow indefinitely | Sync stuck on a bad payload | Check browser DevTools console for the error; clear IndexedDB if stuck |
| Install chip never appears on Android | Missing manifest icon or SW not registered | DevTools → Application → Manifest / Service Workers. Must be served over HTTPS or localhost. |

## 7. Backup

The Google Sheet IS the database. Google's version history is your backup.

- Sheet → File → Version history → See version history. Restore from any prior point.
- For real disaster recovery, set up a scheduled `File → Download → CSV` or use Google Takeout periodically.
