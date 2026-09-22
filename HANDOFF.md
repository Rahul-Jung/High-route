# Handoff: High Route MTB — Nepal mountain-bike tour platform

Paste this whole document into a new chat to continue work with full context. It summarizes everything built, decided, and still open across the prior session(s).

## Project

`E:\Route\high-route-mtb` — a full-stack demo site for a Nepal mountain-bike tour company.

- **Backend**: Node.js, zero npm dependencies. Built-in `http` module + a small custom `Router` class (no Express). Uses `node:sqlite` (`DatabaseSync`) — requires **Node 22.5+ / Node 24**. No `npm install` needed.
- **Frontend**: vanilla HTML/CSS/JS, no build step, no framework, no CDN libraries (three.js was removed — see below).
- **Windows/Git-Bash environment**: `python3` is a broken Windows Store alias — use `python` instead. `/tmp` doesn't map correctly for Node's `require()`; use the session scratchpad directory for temp files. Windows-style paths (`C:/Users/...`) are needed for Node's own `fs` calls even from Git Bash — a bare `/c/Users/...` path gets misinterpreted as relative to the current drive root.

### How to run it

```bash
# Terminal 1 — backend (API + admin panel)
cd E:/Route/high-route-mtb/backend
node server.js
# serves API on http://localhost:4000, admin panel at http://localhost:4000/admin.html

# Terminal 2 — frontend (public site)
cd E:/Route/high-route-mtb/frontend
python -m http.server 8080
# open http://localhost:8080
```

Current admin login (may need a fresh reseed if the DB was deleted since):
```
email:    admin@highroutemtb.demo
password: 4ww-uH6dBLgj
```
If `backend/data/highroute.db*` doesn't exist or is stale after a schema change, delete it and restart `node server.js` — it reseeds automatically and prints fresh admin credentials once. Existing DBs are migrated in place instead (see `db.js`'s idempotent `ALTER TABLE` blocks) — a reseed is only needed if you actually want fresh demo data.

**Important**: any backend file edit needs `node server.js` restarted to take effect — Node caches modules at require-time. A "this still doesn't work" report is sometimes just a stale running process; check `Get-NetTCPConnection -LocalPort 4000` and compare the process start time to the file's last-write time before assuming the code is wrong.

## What's been built, in order

### 1. Security hardening (SQLite kept, not migrated)
- File permission hardening on the DB directory/files (best-effort `chmodSync`, no-op on Windows).
- Session tokens hashed (SHA-256) before storage, never stored plaintext (`sessions.token_hash`).
- Password hashing via `crypto.scryptSync` + per-user salt, `timingSafeEqual` verification.
- In-memory rate limiting on login endpoints (8 attempts/5min per IP+email) — noted as needing a shared store (Redis) for multi-instance deployments.
- Fixed 2 stored-XSS bugs and 1 IDOR bug (booking access via unguessable `access_token` + session ownership checks) and replaced the old static shared admin token with real admin accounts (12h sessions) with login/logout.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`), `.gitignore` for DB files.
- Escaping convention: **raw data is stored as-is; every render site escapes on output** via `esc()`/`escapeHtml()` helpers (not escaped at write time). Applied consistently across `admin.html`, `guide.html`, `tracker.html`, and `frontend/main.js`.
- Known pitfall already fixed once: don't interpolate `esc()`-escaped text into an inline `onclick="fn('...')"` string — the browser HTML-decodes entities before parsing the JS, breaking the string. Use `data-*` attributes + `element.dataset.x` instead.

### 2. Admin panel redesign
Full vanilla HTML/CSS/JS rebuild of `backend/public/admin.html` — real login gate, sidebar navigation, tabs for Overview / Tours / Departures / Guides / Gallery / Destinations / Custom requests / Bookings / Users / Emergency alerts.

### 3. Templated tour detail pages
`frontend/tour-detail.html` is now fully data-driven (was hardcoded for one tour). Works for **every** tour created via the admin panel, with graceful fallback messaging for tours missing itinerary/departure data.

### 4. Rider accounts + booking/request ↔ account linking
- Login/signup UI added to the frontend (backend support existed but had no UI).
- Bookings and custom requests are now tied to authenticated rider accounts (fixed a spoofable client-supplied-email bug in the process — lead rider is now taken from the session, not client input).
- Admin panel shows who booked/requested (with guest vs. registered-account distinction).
- Admin **Users** tab: list riders, delete with **step-up auth** (admin must re-enter their own password; verified server-side). Deleting a rider preserves their booking/request history via `ON DELETE SET NULL` — unlinked, not destroyed.

### 5. Rider dashboard + full booking lifecycle
- `frontend/dashboard.html` — profile editing (name/phone/country/riding experience/style/bike info/emergency contact), password change, bookings list with cancel, custom-requests list with cancel, live payment-progress display, and (added later, see §10) a "Pay now" button + a "View trip & guide" link per booking.
- **Booking lifecycle**: new booking → 72-hour payment hold (`payment_due_at`) → if unpaid, auto-cancelled (background sweep every 5 min via `setInterval(...).unref()` in `server.js`, plus lazy sweep on every booking-list load) and seats released. Admin can **Record payment** (partial → `deposit_paid`, full → `completed` directly) or **Cancel**; riders can now also pay themselves (§10).
- Admin CRM tab: quick **Accept**/**Decline** buttons on custom requests.
- Departure seat counts/status (`open`/`few_spaces`/`full`) recalculate live via a shared `recalcDepartureStatus()` helper on every booking, cancellation, and auto-expiry.
- **Important nuance**: the admin **Tours** tab shows tour metadata only (no live seat count — a tour can have many departure dates). Live availability status lives on the **Departures / dates** tab and is what powers `calendar.html`/`tours.html` availability pips on the public site — same underlying `departures.status` field, no separate/stale copy. The status is now **purely computed, never admin-editable** (§11).

### 6. Visual redesign (UI-only, no functionality touched)
- Admin panel (`admin.html`) and rider dashboard (`dashboard.html`/`style.css`): gradient backgrounds, card elevation/shadows, rounded corners, icon accents on KPI cards and sidebar, filled-pill status badges, polished login/confirm-password modals. All done by restyling existing class/ID selectors — no HTML structure or JS logic changed.

### 7. Lightweight parallax + hero rebuild
- Added a generic `[data-parallax]` engine in `frontend/main.js`: each element declares `data-parallax-speed` / `-max` / `-mouse` / `-scale` / `-scale-amount` / `-entrance` attributes; offset is computed from the element's own distance from viewport-center, eased toward target every frame (lerp), with an optional scroll-tied zoom and a desktop-only cursor-parallax layer.
- **Performance shape**: transform-only, `IntersectionObserver`-gated, single passive scroll/pointermove listener, rAF loop that stops itself once settled. Off under `prefers-reduced-motion: reduce` and under 560px width.
- **Removed the three.js hero terrain entirely** (was found already broken — dead CDN script, empty canvas, but a real continuous-render-loop lag source). Replaced with pure CSS gradients + 3 inline SVG ridgeline layers, motion driven entirely by the parallax engine.
- **Verified, not just claimed**: this environment has headless Microsoft Edge (`"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --screenshot=...` or `--dump-dom`), used repeatedly this session for real visual/DOM verification since the `mcp__Claude_Browser__*` tools are not reliably available here. **Use this technique in the new chat if visual verification is needed** — see §16 below for the specific recipe that worked well this session (serve a scratch copy via `python -m http.server` on a spare port, screenshot or dump-dom it).

### 8. Visual polish round 2: hero photo, card spacing, Nepal map
- Removed the broken hero video, replaced with a real Pexels trail photo.
- Added a large, geographically accurate Nepal map ("Where you'll ride") from amCharts' `nepal2020Low` GeoJSON, converted to inline SVG via a fixed-bounding-box linear lng/lat→x/y projection. This is the same projection §15 reuses for the auto-pin feature's pins.
- Fixed spacing/alignment on "Rider stories" and "Gallery".

### 9. Tour day-by-day itinerary admin CRUD + rider review system
- Added a full admin UI for `tour_days` (previously schema-only): `POST/PATCH/DELETE /api/admin/tours/:id/days[/:dayId]`, a "Tour days" editor card in `admin.html` under the tour form, no public frontend changes needed (already rendered live).
- `POST /api/tours/:slug/reviews` was previously **fully unauthenticated** — rewrote it to require rider auth, verify a non-cancelled booking on that exact departure whose `end_date` has passed (not `booking.status === 'completed'`, which means "paid in full", a different concept), block duplicate reviews, derive `rider_name` server-side.
- Dashboard shows "Leave a review" / "✓ Reviewed" per eligible booking; admin **Reviews** tab moderates (`GET/DELETE /api/admin/reviews[/:id]`).
- Fixed a real dark-theme bug (review modal `<textarea>` had no dark styling) found while demoing.

---

## Session 2 additions (this handoff was regenerated after this session)

### 10. Booking integrity + rider self-service payments
- `POST /api/bookings` now rejects: the same rider booking the same departure twice (non-cancelled), a departure whose dates overlap another active booking of theirs (a rider can't be on two tours at once — this was the original ask that started this session), a cancelled departure, and a departure whose `end_date` has already passed.
- New `POST /api/bookings/:id/pay` (owning rider only) — a rider-facing "Pay now" flow in the dashboard. No real payment gateway exists in this demo; any well-formed card (number/expiry/CVV shape-validated) is treated as an approved charge, and `amount_paid_cents`/`status` update **immediately**, no admin step. `PATCH /api/bookings/:id/payment` (admin-only, for cash/bank-transfer) still exists separately.
- Dashboard: "Pay now" button + modal (deposit vs. full-balance choice) on any not-fully-paid, not-cancelled booking.

### 11. Admin departure date editing + guide assignment
- `computeEndDate()` in `routes/departures.js`: a departure's `end_date` is **always derived** from its tour's `duration_days` — never accepted from the client, even via a smuggled `endDate` field. Admin can only ever set the *start* date; the UI reflects this (no end-date input anywhere in the departures table).
- `findGuideConflict()`: a guide can't be assigned to two departures with overlapping dates. **Bug found and fixed**: this check originally re-ran on *any* PATCH to a departure (even ones not touching the guide or dates), which meant a departure with some pre-existing unrelated conflict became permanently stuck — you couldn't even cancel it. Fixed to only re-check when the request actually changes `guideId` or `startDate`.
- Admin Departures table: Edit → Save/Cancel flow (not auto-save-on-change) for start date + guide. Status is a **read-only, color-coded pip** (green=open, amber=few_spaces, red=full, blue=request_only) — never admin-editable directly, purely computed from seats booked vs. capacity.
- **Open item**: removing the old free-form status dropdown means there's currently no UI path to manually mark a departure `cancelled` or `request_only` after it's created (only at creation time, via the Add-date form's trimmed Open/Request-only choice). Ask the user if they want a dedicated "Cancel this departure" button added back.

### 12. Toast notification system (admin panel, then ported site-wide)
- Built a shared `showToast(message, type)` component — `type` is `success`/`error`/`warning`/`info`, each with its own accent color, a circular icon badge, a spring-in entrance animation, a depleting progress bar, 6-second auto-dismiss that **pauses on hover**, and click-to-dismiss.
- First replaced every scattered inline "toast div" and every blocking `alert()` in `admin.html` with this.
- Then **ported the identical component to the public site**: JS lives in `frontend/main.js` (lazily creates its own `#toast-stack` container, so no HTML page needed editing), CSS in `frontend/style.css` under a `TOAST NOTIFICATIONS` section using the site's own Ink/Stone/Paper palette (not the admin panel's separate theme). These are two independent copies of the same design — the admin panel and public site don't share a JS/CSS bundle.
- Wired into: booking (success + failure), cancelling a booking/request, submitting a review, recording a payment, saving profile/password, newsletter signup, sign-in/sign-up.
- **Deliberately left alone** (by design, not oversight): login/signup modal field errors, review/payment modal field errors — these stay inline next to the field that caused them; the custom-request wizard's success state is a full-screen confirmation screen already stronger than a toast. If asked "why is there no toast here", this is why.
- **A "toast doesn't show" report was diagnosed as browser cache**, not a real bug — verified by copying the actual live files fresh and running a real end-to-end test (see §16) that fired correctly. First thing to check for a repeat report: hard refresh (`Ctrl+Shift+R`), since `main.js`/`style.css` have no cache-busting.

### 13. Site-wide data connectivity audit ("don't leave blank spots")
Several places were quietly disconnected from real admin-entered data:
- **`tour-detail.html`'s booking sidebar** picked the *first* departure in a list with no check for whether it had already passed — replaced with a real `<select>` of every future, non-cancelled departure for that tour, live availability per option, booking always uses whichever is actually selected. Backend now also rejects booking a past/cancelled departure (defense in depth, see §10).
- **Homepage "Upcoming departures" table was 100% hardcoded**, including a tour ("Mustang Enduro") that doesn't exist in the DB and dead `href="#"` links. Now wired to a new `GET /api/departures?upcoming=1&limit=N` (additive query params — the bare endpoint's existing behavior, relied on by `admin.html` and `calendar.html` to see *everything* including past/cancelled, is unchanged).
- **Homepage "Rider stories" was 3 hardcoded fake testimonials.** Now wired to a new public `GET /api/reviews?limit=N` (site-wide, most recent first, requires a non-empty quote, joins tour name/slug).
- **`calendar.html`'s own color legend didn't match its code** — `open` and `few_spaces` rendered identically, `full` was grey instead of red, and cancelled departures weren't filtered off the public calendar. Fixed to match the legend; cancelled dates are now hidden from the public calendar entirely.
- **The assigned guide was never shown anywhere on the public site** despite the admin feature existing — added a live "Guide" row to the tour-detail booking sidebar.
- **Found a real, pre-existing bug** (predates this session): the bare `GET /api/departures` list — what admin's Departures tab actually renders — never joined the `guides` table, so the guide-name column always showed "—" regardless of the real assignment, even though the guide-*select* dropdown (which reads `guide_id` directly) worked fine. One-line fix: added the missing `LEFT JOIN guides`.

### 14. New page: `frontend/trip.html` — "My Trip"
A rider-facing page showing a departure's date + assigned guide + full tour details, in one of two auto-resolved modes:
- **`trip.html?booking=<id>`** → "manage" mode for that exact booking: guide profile, full trip stats, riders on the booking, live payment progress, link to the dashboard to pay/cancel.
- **`trip.html?departure=<id>`** → checks whether the signed-in rider already holds a non-cancelled booking on that departure; if yes, **transparently redirects into manage mode** for it; if no, shows the same guide/stats presentation but with a "Book this departure" card (real price, live spaces-left) — booking from here redirects straight into manage mode for the new booking.
- Linked from: dashboard's booking cards ("View trip & guide") and `calendar.html`'s departure links (previously pointed nowhere useful — a generic `tours.html`).
- `GET /api/bookings/:id` and `GET /api/departures/:id` were both enriched to return the full guide public profile (name/role/bio/photo_url/years_experience/languages/trips_led/rating), not just `guide_name`, plus `tour_slug` for linking to the full itinerary page.

### 15. District-based homepage map auto-pinning
The user's actual ask evolved twice here — final behavior:
- New `backend/lib/geo.js`: a gazetteer of **all 77 Nepal districts**, each with known named places/sub-towns under it (e.g. Sunsari district → Dharan, Inaruwa), each with its own lat/lng where it meaningfully differs from the district HQ. `resolveDistrict(input)` tries an exact match first, then a Levenshtein-distance fuzzy match (tolerates typos like "Mustan", "Katmandu", "Dhran") — returns `{ district, name, lat, lng }`, where `name` is the *specific place* matched, not just the parent district (this mattered: typing "Dharan" must pin "Dharan", not silently relabel it "Sunsari").
- New `tours.district` column, **separate from the pre-existing free-text `region` field** — `region` is untouched, still just a display/filter label, and is deliberately **never** used for map placement (the user explicitly asked to stop using `region` for this and use a real district field instead). Migrated via an idempotent `ALTER TABLE` in `db.js`.
- `routes/admin.js`: `ensureDestinationForDistrict(districtText)` runs whenever a tour is created, or updated with a `district` field present in the request body. Skips if a destination already exists for that resolved place; otherwise creates one — with real coordinates if recognized, or a coordinate-less "needs attention" placeholder if not (still visible in the admin Destinations tab, never silently dropped).
- `pruneOrphanedAutoDestinations()` runs after every tour create/update/delete — removes any **auto-created** destination whose district/place no longer matches *any* current tour (so renaming a tour's district, or deleting the tour, takes the old pin off the map too — this was the second correction the user asked for). Guarded by a new `destinations.auto_created` flag (migrated with a backfill that retroactively flags pre-existing auto-created rows by matching their description-text pattern) so this **never** touches the 6 original hand-seeded destinations or anything an admin adds by hand via the Destinations tab.
- Admin Tours form has a "District" text field (separate from Region), with a note that typos are tolerated. Saving surfaces toasts for what happened: pinned / needs coordinates / pin(s) removed.
- Admin Destinations tab: rows missing lat/lng show "Needs coordinates — no pin yet" in amber, with a working Edit → Save flow (same pattern as departures) to fill them in by hand.
- **Verified live on the user's actual running site** (not just a disposable test copy): reproduced and fixed their real "Dharan"/"Dhankuta" case end-to-end, confirmed via a headless-Edge DOM dump of the real homepage that the correct pin text appears and the stale one is gone.

### 16. Verification technique used throughout this session
For anything requiring a real server (not just a syntax check), the pattern that worked reliably:
1. **Disposable backend testing** (safe, never touches the real DB): copy `backend/{lib,routes,public}` + `db.js`/`schema.sql`/`seed.js`/`server.js` into the scratchpad, run with `PORT=4099` and a fresh `data/` dir, hit it with `curl` for API-level assertions, then kill the process (`Get-NetTCPConnection -LocalPort 4099 -State Listen` → `Stop-Process`) and `rm -rf` the scratch copy.
2. **Visual/DOM verification** (for frontend changes, or confirming something is *actually* live): copy the relevant `frontend/*.html` + `main.js` + `style.css` into scratch, optionally append a small autorun test script to `main.js` (e.g. fill a form and submit it, or fire `showToast(...)` calls on a timer) — do **not** edit the real files for this — serve via `python -m http.server <spare-port>` from the scratch dir, then use headless Edge:
   - `--screenshot=<path> --window-size=W,H --virtual-time-budget=<ms>` for a visual PNG (read it back with the Read tool), or
   - `--dump-dom --virtual-time-budget=<ms>` piped to a file, then `grep`/parse it for expected text/attributes (more reliable than a screenshot for confirming exact values, e.g. pin coordinates or a toast's exact text).
   - `main.js`'s `API_BASE` defaults to `http://localhost:4000`, so a scratch-served frontend copy still talks to the **real** backend if it's running — useful for testing real end-to-end behavior (e.g. the newsletter-signup toast test) without needing a full disposable backend too.
3. Always clean up: kill the spare `http.server`/node process, delete the scratch copy, and confirm the real DB's file mtimes are untouched before finishing.
4. When a fix needs to apply to the user's **actual live data** (not just get verified in isolation) — e.g. the Dharan pin fix — after restarting the real backend with the new code, use the *real* admin token via `curl` to make the minimal corrective API call (a re-save/re-trigger), then re-verify live via a DOM dump of the real running site. Ask before deleting/modifying real data that isn't obviously a throwaway artifact.

## Known open items / things flagged but not (yet) acted on

1. **No UI path to manually cancel a departure or mark it request-only** after creation (see §11) — only at creation time. Add a dedicated "Cancel this departure" button if the user wants this back.
2. `tours.region` (free-text display/filter label) and `tours.district` (map-pin source, matched against the 77-district gazetteer) are two **separate** fields now — don't conflate them, and don't let map-pinning logic key off `region` again.
3. The map's coordinate data (`backend/lib/geo.js`) is hand-compiled/approximate — same "not survey accurate" disclaimer as every other coordinate in this app (see README "GPS & safety disclaimer").
4. Tour-detail hero images are random picsum.photos placeholders — cosmetic, tied to whatever `image_url` admins set; not something to "fix" in code.
5. `admin.html` sets `const API = window.HIGHROUTE_API_BASE || 'http://localhost:4000'` — testing against a second throwaway backend on a different port needs this overridden, or it silently points at the real one.
6. Headless Edge screenshot quirk: `--window-size` doesn't reliably control the captured viewport; `--dump-dom` + grep is more trustworthy than a screenshot for confirming exact values. Anchor-scroll screenshots for below-the-fold sections have repeatedly returned blank captures in this environment.
7. No other pending/deferred tasks were stated by the user as of this handoff.

## Conventions to keep following

- **Never break functionality while doing visual work.** Restyle existing selectors/attributes; verify with `node -c` and, when possible, actual rendering.
- **Escape on render, not on write.** Use `esc()`/`escapeHtml()` at every interpolation site.
- **Ownership + step-up checks for destructive actions.** Delete/cancel endpoints check session ownership or admin role; destructive admin actions (deleting a user) require re-entering the admin's own password server-side.
- **`CREATE TABLE IF NOT EXISTS` doesn't ALTER existing tables** — every schema change needs an idempotent migration block in `db.js` (see the `district`/`auto_created` column additions this session for the pattern: check `PRAGMA table_info`, `ALTER TABLE ADD COLUMN` if missing, backfill if needed).
- **Any backend edit needs a server restart** — Node caches modules at require-time. Check the running process's start time vs. the file's last-write time before concluding a fix "didn't work."
- **When adding any new admin-mutation endpoint or editable field, check whether it needs to flow into**: (a) the map/destinations auto-pin system, (b) a toast confirmation, (c) *every* read endpoint that displays it — not just the single-item one (the guide-name-missing bug happened because the *list* endpoint's SELECT was never updated to match the single-item one).
- User's typing style is informal/typo-heavy but instructions are usually clear on intent — read for intent, not literal grammar.
- The user is not deeply technical about implementation details but has clear product/UX taste and will push back hard on things that don't look/feel right, and will correct scope precisely when a first attempt overshoots or undershoots (see: the region→district pivot in §15, done in two corrective passes). Prioritize showing/proving results (screenshots, DOM dumps, curl tests) over just asserting things work.
- Git: this is **not currently a git repository**. Set one up (`git init`) before any commits can happen, if ever asked.
- When testing against the user's own **real** running servers, use throwaway/clearly-fake data and **always clean it up** — or, when the fix needs to land in real data (not just get verified), be explicit that you're doing so and why, and prefer the least-destructive corrective action (a re-save/re-trigger over a manual DB edit).
- Booking `status === 'completed'` means "paid in full," not "the ride happened." Use departure `end_date` vs. today for anything depending on whether a ride has actually occurred.
- Stop/restart both dev servers only when asked; the user has asked for this explicitly multiple times across sessions (usually right after finishing a batch of verified changes).

## Quick file map

| Area | Key files |
|---|---|
| DB schema | `backend/schema.sql` |
| DB connection/hardening/migrations | `backend/db.js` |
| Nepal district gazetteer + fuzzy matcher (map auto-pin) | `backend/lib/geo.js` |
| Auth helpers | `backend/lib/auth.js`, `backend/lib/util.js` |
| Auth/rider routes | `backend/routes/auth.js` |
| Bookings + lifecycle + rider self-pay | `backend/routes/bookings.js` |
| Departures (dates, guide assignment/conflict, availability) | `backend/routes/departures.js` |
| Tours + auto-pin/prune destination logic | `backend/routes/admin.js` |
| Reviews (rider-gated create, public read, site-wide feed) | `backend/routes/reviews.js` |
| Destinations (map pins, admin CRUD) | `backend/routes/destinations.js` |
| Custom requests (CRM) | `backend/routes/customRequests.js` |
| Server entrypoint + sweep timer | `backend/server.js` |
| Seed data + admin bootstrap | `backend/seed.js` |
| Admin panel UI (tabs, toast system, departures/tours/destinations editors) | `backend/public/admin.html` |
| Guide/tracker UIs | `backend/public/guide.html`, `backend/public/tracker.html` |
| Shared frontend JS (Auth, parallax engine, toast system, dashboard, trip page, booking sidebar) | `frontend/main.js` |
| Rider dashboard | `frontend/dashboard.html` |
| My Trip (booking manage / departure view+book) | `frontend/trip.html` |
| Hero + tour detail pages | `frontend/index.html`, `frontend/tour-detail.html` |
| Public calendar (links into trip.html) | `frontend/calendar.html` |
| Shared styles (incl. toast system) | `frontend/style.css` |
| Full project docs | `README.md` (startup, admin CMS, rider accounts/dashboard/booking lifecycle, API reference, security notes, what's real vs. placeholder, production upgrade path) |

---
*Generated as a session handoff — paste into a new chat's first message to resume with full context.*
