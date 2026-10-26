# High Route MTB — full stack

This is the customer website, backend API, database, and a GPS/emergency
simulation for a Nepal mountain-bike tour platform, built from the original
product brief. It's split into two folders:

```
frontend/   Static site — HTML/CSS/JS, no build step. Open it via any web server.
backend/    Node.js API + SQLite database + admin CMS + GPS simulator.
```

Everything in `frontend/` talks to `backend/` over HTTP (`fetch`). Neither
needs a build step or `npm install` — the backend uses **zero external
dependencies** (Node 22's built-in `node:sqlite`), and the frontend is plain
HTML/CSS/JS.



http://127.0.0.1:4000/admin.html
this and
http://127.0.0.1:8080/index.html
i wanna use these two 

---

## 1. Run the backend

Requires **Node.js 22.5+** (for built-in SQLite). Check with `node --version`.

```bash
cd backend
node server.js
```

That's it — no `npm install` needed. On first run it creates
`backend/data/highroute.db`, applies `schema.sql`, and seeds it with demo
tours, guides, departures, destinations and gallery images. It also creates
one admin account and prints its login **once**:

```
Created admin account — sign in at /admin.html
  email:    admin@highroutemtb.demo
  password: pNiOc4jlT63j   <-- generated, save it now, it will not be shown again
High Route MTB backend running at http://localhost:4000
Demo dashboards: /tracker.html  /admin.html  /guide.html
```

Save that password now — only its hash is stored, so it can't be recovered
later (delete `backend/data/highroute.db*` and restart to generate a new one).
To use a known email/password instead of a random one, set `ADMIN_EMAIL` and
`ADMIN_PASSWORD` before first run:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a strong password' node server.js
```

Three browser dashboards are served directly by the backend:
- **http://localhost:4000/admin.html** — operations CMS (sign in with the admin account above)
- **http://localhost:4000/guide.html** — guide app (login: `tashi@highroutemtb.demo` / `ride-nepal-2026`)
- **http://localhost:4000/tracker.html** — live GPS map

To reseed from scratch, stop the server and delete `backend/data/highroute.db*`
(this also drops the admin account, so a fresh one gets generated).

## 2. Run the frontend

The frontend is static files, but **serve it with a real HTTP server** rather
than opening `index.html` directly with `file://` — some browsers block
`fetch()` calls from `file://` pages, and you'll see the offline-fallback
content instead of live data. Any static server works:

```bash
cd frontend
node serve.js          # or: node serve.js 5500 for a different port
```

`serve.js` is a ~40-line zero-dependency static server. Use it in preference
to `python3 -m http.server 8080` or `npx serve .`, which both work but send
no `Cache-Control`. With no build step and no hashed filenames, a browser
then applies heuristic caching to `main.js`, `style.css` and the pages
themselves — so you edit a file, reload, and are served the previous version
with nothing to tell you it's stale. `serve.js` sends `no-store`, so a plain
reload always shows what's on disk. (The backend does the same for
`admin.html` and the other dashboards it serves.)

If you do see a stale page, hard-reload: **Ctrl+Shift+R** (Cmd+Shift+R on a
Mac), or open devtools and tick *Disable cache* on the Network tab.

Then open **http://localhost:8080**. By default the frontend calls the
backend at `http://localhost:4000`. If your backend runs somewhere else, set
this before `main.js` loads, e.g. add to the `<head>` of any page:

```html
<script>window.HIGHROUTE_API_BASE = 'https://your-backend.example.com';</script>
<script src="main.js"></script>
```

## 3. How the connection actually works

`frontend/main.js` defines a small `apiGet()` / `apiPost()` client at the top
of the file, pointed at `window.HIGHROUTE_API_BASE || 'http://localhost:4000'`.
Each page fetches on load and swaps in live content:

| Page | What it fetches | Fallback if the backend is down |
|---|---|---|
| `index.html` | `/api/tours`, `/api/guides`, `/api/gallery`, `/api/destinations` | Keeps the static cards/pins already in the HTML |
| `tours.html` | `/api/tours` | Same — static cards stay |
| `tour-detail.html?slug=<slug>` | `/api/tours/<slug>` (days, reviews, departure/price) | Upper Mustang (the default when no `?slug=` is given) uses a hardcoded `FALLBACK_ROUTE_DAYS` array in `main.js`; any other tour shows a "couldn't load" state with a link back to `tours.html` |
| `calendar.html` | `/api/departures?month=<current>` (Prev/Next re-fetch each month) | Shows "couldn't load live departures" in the console; the grid shell still renders |
| `build-adventure.html` | `POST /api/custom-requests` on final submit | Shows an inline error if the request fails |

This resilient-fallback pattern is deliberate: the site still looks complete
if someone opens it without the backend running, but the moment the backend
is reachable, the database becomes the source of truth. Open the browser
console to see a warning if any page fell back to offline data.

**Rider accounts.** Every frontend page mounts a "Sign in" control in the
header (`Auth` in `main.js`) — sign up or sign in opens a modal, no separate
page. Booking a tour (the "Book this adventure" button on `tour-detail.html`)
requires an account: clicking it while signed out opens the sign-in modal and
the booking resumes automatically the moment sign-in/sign-up succeeds. The
Build Your Adventure wizard (`build-adventure.html`) is freely browsable, but
**submitting** it requires an account, gated the same way: the modal opens on
click and the wizard resumes with everything already filled in. The name and
email on the request always come from the signed-in account server-side —
never from the request body — so a request can't be filed under someone
else's address. `apiGet()`/`apiPost()`/
`apiPatch()` attach the signed-in rider's session to every request
automatically, so individual call sites don't need to remember an
`Authorization` header.

**Rider dashboard** (`dashboard.html`, linked from the "My account" item in
the header's account menu once signed in) is where a rider manages their own
data — nothing here needs the admin panel:
- **Profile** — edit name, phone, country, riding experience, preferred
  style, bike info, emergency contact, and change password (current password
  required). Email isn't editable — it's the login identifier.
- **Bookings** — every booking with live payment progress (a bar showing
  amount paid vs. total) and a **Cancel booking** button, shown while it's
  still cancellable: not already cancelled, and the departure hasn't started
  yet (`can_cancel` computed server-side, not just hidden by CSS). A booking
  that's been **paid in full is still cancellable** — `completed` means "paid
  in full", not "the trip happened", so it must not block cancellation or the
  refund tiers below would be unreachable for exactly the riders who've paid
  the most. The confirmation dialog states the refund you'd get first
  (`refund_preview_cents`, from the same tier calculation the cancel itself
  applies), so the number is never a surprise after the fact.
- **Custom requests** — every Build Your Adventure submission with its
  pipeline status, and a **Cancel request** button while it's still in an
  early stage (`new`/`contacted`/`proposal_sent`/`deposit` — once an admin
  moves it to `confirmed`, only staff can change it further).

**Booking lifecycle.** A booking starts `pending` with a 72-hour payment
hold — if the admin panel doesn't record any payment against it in that
window, a background sweep (`expireOverdueBookings()`, runs every 5 minutes
from `server.js`, and also inline whenever a booking list loads) auto-cancels
it and releases its seats back to the departure. Recording a payment in the
admin panel moves it to `deposit_paid`, and reaching the full total moves it
straight to `completed` — there's no separate "paid" holding state before that.

**Checkout flow (`frontend/checkout.html`).** Replaces the old one-click
"book with a hardcoded single rider" stub. A real multi-step flow: departure
summary + availability -> rider count (capped by real remaining capacity) ->
full rider details for every rider (name, age, country, riding experience,
bike info, emergency contact, optional special requirements — all validated
both client- and server-side) -> add-ons (loaded from `GET /api/addons`,
never hardcoded in the frontend) with an optional promo code -> a full price
review (base fare, each add-on line, discount, tax, total, deposit, balance,
cancellation terms) -> confirm. Confirming still creates the same `pending` +
72-hour-hold booking described above — no payment is taken at this step (see
"What's real" below). The whole multi-row write (booking + riders + addon
line items + promo redemption + departure seat count) runs inside a single
SQLite transaction (`transaction()` in `db.js`) so a mid-write failure can't
leave a half-created booking behind.

**Add-ons** live in an admin-managed `addon_catalog` table (admin panel's
Add-ons tab), each priced `per_rider` (scales with group size) or
`per_booking` (charged once — e.g. a private guide). Every booking's actual
add-ons are stored as `booking_addons` rows with a price *snapshot*, so a
later catalog price change never rewrites a past booking's numbers.

**Promo codes** (admin panel's Promo codes tab) support percent or fixed-
amount discounts, an optional max-use count, an optional minimum rider
count, an optional single-tour restriction, and optional valid-from/until
dates. `POST /api/promo/validate` is a read-only preview a rider can call
before checking out; the actual discount is always recalculated from
scratch, server-side, at booking creation (`routes/promo.js`'s
`evaluatePromoCode()`, shared by both) — a client can never supply its own
discount amount.

**Cancellation & refunds.** Cancelling a booking (`POST
/api/bookings/:id/cancel`) computes a refund *entitlement* server-side from
the admin-configurable `cancellation_rules` tiers (admin panel's Refunds
tab — "at least N days before departure, refund X%") against whatever's
actually been paid, and records it as a `refunds` row with status
`pending`. It only becomes `processed` once an admin explicitly re-enters
their own password to confirm the money has actually been sent back
(`PATCH /api/admin/refunds/:id`) — there's no live payment gateway to
confirm that automatically, so the app never claims a refund has been
issued before a human attests to it.

**Invoices** are generated lazily the first time `GET
/api/bookings/:id/invoice` is called for a booking, and reused after that
(sequential `HR-<year>-<seq>` numbering, stored in the `invoices` table so
the number never changes once issued). `frontend/invoice.html` renders it as
a printable sheet — "download" is `window.print()` -> Save as PDF, since
this project ships no PDF-generation library.

**Known limitation:** the homepage map re-projects real lat/lng from
`/api/destinations` onto the hand-drawn SVG illustration using a simple
linear projection (not a real map projection) — it's a good approximation at
Nepal's scale but isn't survey-accurate.

`tour-detail.html` is now fully templated from `/api/tours/:slug` — every
tour card's "View adventure" link points at `tour-detail.html?slug=<slug>`,
and the hero, quickbar, overview paragraph, trip-highlights grid, difficulty
badge and booking sidebar are all built from that tour's live fields
(`renderTourHeader()` in `main.js`), not hand-written per tour. A tour with no
`tour_days` rows yet shows a "not published yet" message in place of the
day-by-day itinerary instead of a broken chart. Days are edited in the admin
panel under **Tours -> (edit a tour) -> Route, day by day**, and the route
map's pins under **Route map** right below it — no hand-editing of
`schema.sql` required. A nonexistent slug, or
the backend being unreachable for a tour other than Upper Mustang, shows a
clear "couldn't load this tour" state with a link back to `tours.html` rather
than fabricated content.

## 4. The admin CMS — what you can manage

Everything editable lives in `backend/public/admin.html`. Sign in with the
admin email/password printed on first server startup (see section 1), then:

- **Tours** — add/edit/delete: name, region, summary, duration, difficulty,
  riding style, distance/elevation/altitude stats, price, best season, cover
  image URL. Changes appear on `index.html`/`tours.html` on next page load.
- **Route, day by day** (nested under the tour being edited) — the
  itinerary: per-day title, distance, elevation gain/loss, high point,
  riding hours, terrain and overnight stop. Feeds the day tabs and the
  elevation chart on the tour page.
  Built for entering a long itinerary in one sitting: **Save & next day**
  saves the day and immediately clears the form with the next free day
  number already filled in, so a twelve-day trip is twelve passes through
  one form rather than twelve save-then-clear round trips. A header line
  tracks progress against the duration the tour is actually sold as (and
  warns when they disagree, or when a day number is missing), and a totals
  line underneath adds up riding distance, climb, descent and highest point
  so the itinerary can be sanity-checked against the tour's own headline
  figures. **0 km is a valid distance** and is shown as a rest day rather
  than a blank. Up/down arrows renumber days — needed because
  `tour_days` has `UNIQUE(tour_id, day_number)`, so swapping two days by
  editing their numbers one at a time would collide halfway through; the
  reorder endpoint renumbers through a temporary range instead.
- **Departures / dates** — add a new date for any tour (start/end, capacity,
  guide, status), change status (open/few spaces/full/request-only/cancelled),
  or delete an unbooked date. Appears on `calendar.html` immediately.
- **Guides** — add/edit/delete profiles (bio, photo, languages, years,
  rating), and set a login password so they can use `guide.html`.
- **Gallery** — add/delete images by URL, tag them `hero`/`gallery`/`tour`/
  `guide`, optionally link to a specific tour.
- **Destinations** — add/delete the regions pinned on the homepage map
  (name, lat/lng, description, hero image).
- **Custom requests** — the CRM pipeline fed by `build-adventure.html`. Shows
  whether the request came from a registered account or a guest, plus the
  granular status dropdown (new → contacted → proposal sent → deposit →
  confirmed/completed) and quick **Accept**/**Decline** buttons for the two
  common outcomes (accept → `confirmed`, decline → `declined`). A rider can
  also withdraw their own request from `dashboard.html` (→ `cancelled`,
  tracked separately from an admin `declined` so the CRM can tell them apart).
- **Bookings** — shows who booked (the rider's name/email, or "Deleted
  account" if that user was since removed) and live payment progress.
  **Record payment** prompts for an amount and applies it — reaching the full
  total moves the booking straight to `completed`. **Cancel** releases the
  seats back to the departure. Both actions disappear once a booking is
  already `completed`/`cancelled`. An unpaid booking left untouched
  auto-cancels after 72 hours — see "Booking lifecycle" in section 3.
- **Users** — every rider account created via sign-up on the public site
  (name, email, country, join date, booking/request counts). Deleting a user
  requires typing **your own admin password** to confirm — it permanently
  removes the account but keeps their past bookings/requests for the
  business's records, just unlinked from any account.
- **Emergency alerts** — read-only view plus alert resolution.

All of this is real: it writes to `backend/data/highroute.db` through the
same API the public site reads from — there's no separate "content" layer.

## 5. GPS — how it works, and what it doesn't do

```bash
cd backend
node simulate-gps.js
```

This moves two simulated riders along Upper Mustang's real departure
(interpolating between each day's village) and posts pings to
`POST /api/gps/ping` roughly once a second. Open `tracker.html` while it runs
to watch a live Leaflet map update, or hit **"Send test SOS"** there to walk
through the `/api/emergency` flow end-to-end.

**Read this before using any of it for real:** everything GPS/emergency-
related in this project is a *simulation of the data flow*, not a safety
system. Specifically:

- The coordinates seeded for each village are approximate, hand-typed
  placements — not surveyed GPX waypoints. Do not navigate with them.
- Nepal's high routes have no cellular signal. A real deployment needs
  satellite hardware (Garmin inReach, Iridium, etc.) reporting into an
  endpoint shaped like `/api/gps/ping` — a phone's GPS alone won't transmit
  anywhere once riders are out of signal.
- `POST /api/emergency` only writes a database row and returns a guide's
  *name* — it does not contact any real person, satellite network, or
  emergency service. The brief that shaped this project says it directly:
  the real evacuation/emergency procedure needs to be designed with
  qualified local safety and medical professionals, not shipped as software
  alone. Treat this as the data plumbing that a real system would sit behind,
  not the system itself.

## 6. API reference

All endpoints are under `http://localhost:4000`. Admin endpoints require a
real admin session (`Authorization: Bearer <token>` from `POST
/api/admin/login` — see section 4). Rider/guide endpoints use a session token
from their own login the same way. Any session — rider, guide or admin — can
be revoked immediately with `DELETE /api/auth/session`.

**Public**
- `GET /api/tours` `?difficulty=&style=&destination=&duration=&minDuration=&maxDuration=&minBudget=&maxBudget=&season=&groupType=&maxAltitude=`
  — every filter is optional and they combine with AND; difficulty/style/
  destination/season and the bucketed duration/groupType each take a
  comma-separated list of values/ranges and OR within themselves (e.g.
  `difficulty=2,3&duration=1-3,8-14`). `region=` and `maxPrice=` still work
  as legacy aliases for `destination=`/`maxBudget=`. `season=` is one or more
  of `spring,summer,autumn,winter`; `duration=`/`groupType=` take `lo-hi`
  range tokens (days / group size). Each tour in the response also carries
  `upcoming_departures[]`, `next_departure` (or `null`), `has_departures`
  (whether it has ever had a departure scheduled, even if none are upcoming)
  and `riding_hours_summary` (derived from its `tour_days`, `null` if none entered).
- `GET /api/tours/:slug` — includes `days[]` (with `overnight_lat/lng` where
  the admin has actually entered them — never fabricated), `departures[]`,
  `reviews[]`, `gallery[]` (this tour's `category='tour'` images),
  `guides[]` (the distinct guides who've ever led one of its departures,
  each with a `qualifications[]` array — only `verified:true` entries are
  meant to be shown publicly, see main.js), `inclusions[]`, `exclusions[]`,
  `equipment_essential[]`, `equipment_recommended[]` (all `[]` if unset),
  and `safety_hazards`/`safety_preparation`/`safety_emergency`/
  `cancellation_policy` (all `null` if unset — the frontend shows an honest
  empty state rather than placeholder copy when these are null/empty)
- `GET /api/admin/tours/:id/days` — the itinerary plus server-computed
  totals: `total_distance_km`, `total_climb_m`, `total_descent_m`,
  `highest_point_m`, `rest_days`, `days_entered` vs the tour's
  `duration_days` (`matches_duration`), `climb_complete` (false when some
  riding day has no climb figure, so the panel can say "at least") and
  `numbering_gaps`. This is what the admin day editor reloads after each
  save — it used to fetch every tour just to resolve a slug, then that
  tour's entire public payload, to read one array off it.
- `POST /api/admin/tours/:id/days` · `PATCH /api/admin/tours/:tourId/days/:dayId`
  · `DELETE /api/admin/tours/:tourId/days/:dayId` — all numeric fields are
  range-checked (`distanceKm` 0–500 so a rest day is valid, gain/loss
  0–20000, `highPointM` 0–9000) and a `PATCH` validates only the fields it
  was sent. Moving a day onto an occupied number is refused with a message
  rather than hitting the unique constraint as a 500.
- `POST /api/admin/tours/:id/days/reorder` — `{ ids: [...] }` in the new
  order; must list every day on the tour. Renumbers via a temporary negative
  range so the table is never in a state where two days share a number.
- `GET /api/tours/:slug/reviews` · `POST /api/tours/:slug/reviews`
- `GET /api/departures` `?month=YYYY-MM&tourId=&upcoming=1&limit=` — bare, this
  returns every departure (past/cancelled included) for the admin panel and
  calendar.html; `?upcoming=1` restricts to future, non-cancelled ones,
  sorted soonest-first, for public "what can I book" views like the homepage.
- `GET /api/departures/:id`
- `GET /api/reviews` `?limit=` — most recent reviews site-wide (with a quote),
  for the homepage's "Rider stories" section
- `GET /api/addons` — the active, priced add-on catalog checkout reads from
  (never hardcoded in the frontend) · `POST /api/promo/validate` `{ code,
  tourId, riderCount, subtotalCents }` — a read-only discount preview; the
  real, binding calculation happens again from scratch at booking creation
- `GET /api/guides` · `GET /api/destinations` · `GET /api/gallery` `?category=&tourId=`
- `GET /api/departures/:id/updates` — public guide status feed
- `POST /api/custom-requests` — links to the caller's account (`rider_id`) if
  signed in, otherwise anonymous · `POST /api/newsletter`
- `POST /api/auth/register` · `POST /api/auth/login`
- `POST /api/guide/login` · `POST /api/admin/login` · `DELETE /api/auth/session`
- `POST /api/gps/ping` · `GET /api/gps/latest?departureId=` · `GET /api/gps/track?departureId=&label=`
- `POST /api/emergency`

**Rider (session auth)**
- `GET /api/riders/me` · `PATCH /api/riders/me` (profile fields, not
  email/password) · `PATCH /api/riders/me/password` `{ currentPassword, newPassword }`
- `GET /api/riders/me/bookings` — own booking history, each with a
  server-computed `can_cancel` · `GET /api/riders/me/requests` — same, for
  custom requests, with `can_cancel`
- `POST /api/bookings` — the lead rider is always the signed-in account (never
  a client-supplied email); full per-rider details (name/age/country/riding
  experience/bike info/emergency contact/optional special requirements),
  addon keys, and an optional `promoCode` — every price is computed
  server-side (base fare × riders, addon catalog lookups, promo discount,
  tax) inside one SQLite transaction. Returns a one-time `access_token` for
  the new booking, which starts a 72-hour payment hold (see section 3).
  Rejected if the rider already holds a non-cancelled booking on that exact
  departure, or one whose date range overlaps it (a rider can't be on two
  tours at once), or if there isn't enough remaining capacity.
- `GET /api/bookings/:id` — requires the booking's `access_token` (as
  `?token=` or an `X-Booking-Token` header), the owning rider's session, or an
  admin session. Booking IDs are sequential and are **not** a secret. Response
  includes the departure joined with its tour (`tour_slug`, to link to the
  full tour-detail page), its assigned guide's full public profile
  (`guide_name`/`guide_bio`/`guide_photo_url`/etc.), its priced `addon_items`,
  and any `refunds` — this is what powers `trip.html`, the rider-facing "my
  trip" page.
- `GET /api/bookings/:id/invoice` — same access rule as above; generates (once,
  lazily) and returns a sequentially-numbered invoice (line items, minimal
  customer name/email, payment status) for `frontend/invoice.html` to render
  as a printable sheet.
- `POST /api/bookings/:id/cancel` — the owning rider (if the departure hasn't
  happened yet) or an admin (any time). Computes a refund entitlement from
  the admin-configured cancellation tiers against whatever's been paid and
  records it as a `pending` `refunds` row (see section 3) — never marks
  anything refunded itself.
- `POST /api/bookings/:id/pay` `{ amountCents, card: { number, expiry, cvv } }`
  — the owning rider only, from their dashboard; see the payments note below.
- `POST /api/custom-requests/:id/cancel` — the requester, while still in an
  early pipeline stage, or an admin

**Guide (session auth)**
- `GET /api/guide/today` · `POST /api/guide/checkin` · `POST /api/guide/incident` · `POST /api/guide/status`

**Admin (session auth)**
- `GET /api/admin/summary` · `GET /api/admin/analytics`
- `POST /api/admin/tours` · `PATCH /api/admin/tours/:id` · `DELETE /api/admin/tours/:id` —
  the optional `district` field (separate from `region`, which stays a
  free-text display/filter label) is matched against Nepal's 77 districts in
  `lib/geo.js` (typos tolerated via edit-distance) to auto-create a homepage
  map pin the first time that district is used. Recognised → a real pin with
  real coordinates; not recognised → still added to Destinations (visible,
  editable), just without coordinates until an admin fills them in. The
  response's `map_pin` field reports what happened, or `null` if that
  district already had a pin. `PATCH` also accepts `inclusions`/`exclusions`/
  `equipmentEssential`/`equipmentRecommended` (arrays of strings) and
  `safetyHazards`/`safetyPreparation`/`safetyEmergency`/`cancellationPolicy`
  (plain text) for the tour-detail page's structured content sections.
- `POST /api/admin/tours/:id/days` · `PATCH /api/admin/tours/:tourId/days/:dayId` · `DELETE /api/admin/tours/:tourId/days/:dayId`
  — `overnightLat`/`overnightLng` are optional; leave them unset rather than
  guessing, since the frontend route map only ever plots real entered coordinates.
- `POST /api/admin/departures` · `PATCH /api/admin/departures/:id` · `DELETE /api/admin/departures/:id`
- `PATCH /api/departures/:id/availability`
- `POST /api/admin/guides` · `PATCH /api/admin/guides/:id` · `DELETE /api/admin/guides/:id` —
  accepts a `qualifications` array of `{ title, verified }` objects; only
  `verified:true` entries are shown on public guide profiles/tour pages.
- `POST /api/admin/destinations` · `PATCH /api/admin/destinations/:id` · `DELETE /api/admin/destinations/:id`
- `POST /api/admin/gallery` · `PATCH /api/admin/gallery/:id` · `DELETE /api/admin/gallery/:id` —
  `category:'tour'` + `tourId` is how an image is associated with a specific
  tour's gallery section (`GET /api/gallery?category=tour&tourId=`).
- `GET /api/admin/custom-requests` `?status=` · `PATCH /api/admin/custom-requests/:id`
- `GET /api/admin/bookings` — includes each booking's requester (`requester_name`/`requester_email`),
  priced `addon_items`, and derived `booking_reference`
- `PATCH /api/bookings/:id/payment` `{ amountCents }` — admin-only; in
  production this is what a payment-provider webhook confirms, not something
  a browser should trigger. Reaching the full total sets status `completed` directly.
- `POST /api/admin/addons` · `PATCH /api/admin/addons/:id` · `DELETE /api/admin/addons/:id`
  (blocked once used on a booking — deactivate with `PATCH { active: false }` instead)
  · `GET /api/admin/addons` — every add-on including inactive ones
- `POST /api/admin/promo-codes` · `PATCH /api/admin/promo-codes/:id` ·
  `DELETE /api/admin/promo-codes/:id` (blocked once redeemed) · `GET /api/admin/promo-codes`
- `GET /api/admin/refunds` — every refund request · `PATCH /api/admin/refunds/:id`
  `{ status: 'processed'|'denied', password?, adminNotes? }` — marking
  `processed` requires the acting admin's own password as step-up
  confirmation (no live payment gateway confirms it automatically)
- `GET /api/admin/cancellation-rules` · `POST /api/admin/cancellation-rules`
  `{ minDaysBeforeDeparture, refundPercent }` · `PATCH`/`DELETE .../:id` —
  the tiered refund policy `POST /api/bookings/:id/cancel` computes against
- `GET /api/admin/riders` — every rider account, with booking/request counts
- `DELETE /api/admin/riders/:id` `{ password }` — **`password` is the acting
  admin's own login password**, re-verified server-side as step-up
  confirmation before the account is deleted
- `GET /api/emergency` `?status=` · `PATCH /api/emergency/:id`

## 7. What's real vs. what's a placeholder

**Real:** the database and schema, every CRUD endpoint, session auth with
hashed passwords (riders, guides, *and* admins), the booking→availability→pricing
logic, the CRM pipeline, the admin CMS actually editing the same data the
public site reads, GPS data flow (ingestion → storage → live query), and the
full frontend↔backend wiring described in section 3.

**Placeholder / explicitly simulated:**
- **Payments** — `POST /api/bookings` computes a real deposit/balance but no
  payment gateway is wired up (brief section 39 calls for Stripe or similar).
  `POST /api/bookings/:id/pay` is the rider-facing "Pay now" flow in the
  dashboard: it validates card-shape fields (number/expiry/CVV) and, since
  there's no real processor behind it, treats any well-formed card as an
  approved charge — `amount_paid_cents`/`status` update immediately, no admin
  step involved. `PATCH /api/bookings/:id/payment` remains for admin-recorded
  payments (cash, bank transfer). A production build would replace the rider
  endpoint's "approve immediately" logic with a real gateway call and only
  update state from its webhook.
- **GPS/emergency** — see section 5. Data flow is real, hardware and human
  response are not.
- **Email** — one real transactional email is sent: the 6-digit signup
  verification code, via Resend's HTTP API (`backend/lib/email.js`, using
  Node's built-in `fetch` — no SDK). Set `RESEND_API_KEY` to send for real;
  without it the code is logged to the server console instead, so local
  development needs no account. The rest of the brief's automated sequence
  (booking confirmed, 30-days-out reminder, etc.) is **not** implemented —
  the newsletter table stores signups but nothing mails them.
- **SMS** — not implemented at all.
- **Day-by-day cards — tried and removed.** A list rendering every day at
  once (distance, climb, descent, high point, hours, terrain, overnight) was
  added below the elevation chart and then removed at the owner's request for
  making the page read oddly. The tour page is back to the original day tabs
  plus elevation panel. Removing it also turned up a real bug worth recording:
  the earlier route-map removal had left an **orphaned `</div>`** in
  `tour-detail.html` and `trip.html` (the regex matched only as far as the
  legend's closing tag, not the wrapper's), which prematurely closed the
  route section's parent and threw every section below it out of its layout
  column. Both pages are now div-balanced, and `python /tmp/divcheck.py`-style
  tag counting is worth doing after any block removal from these templates.
- **Route map — built, then taken off the site.** A tile map with
  admin-placed pins and routes snapped to real roads was built and then
  removed from the UI at the owner's request; the day-by-day itinerary is
  the route presentation now. Nothing was deleted: the `tour_waypoints` and
  `tour_route_legs` tables, their 50 pins and snapped geometry,
  `backend/routes/waypoints.js`, `backend/lib/routing.js` and
  `frontend/routemap.js` are all still in the repo and still working, and
  `GET /api/tours/:slug/waypoints` still serves them. What was removed is
  the section on `tour-detail.html`/`trip.html`, the editor card in
  `admin.html`, and `waypoints`/`route_map` from the public
  `GET /api/tours/:slug` payload — that last one mattered, because a
  snapped leg's geometry is a few KB and several tens of KB were being sent
  on every tour page view for something nothing rendered. Putting it back is
  a matter of restoring those sections, not a migration.

  The two guards in `routing.js` are worth keeping in mind if it ever comes
  back, because the routing engine fails confidently rather than loudly: it
  snaps endpoints to the nearest road **however far away** (two pins in the
  Pacific returned a "successful" 0 km route with the ends moved ~1,500 km),
  and with no through route it goes the long way round (a 6 km gap in
  Langtang came back as 153 km). `ROUTING_MAX_SNAP_M` and
  `ROUTING_MAX_DETOUR_RATIO`/`_EXCESS_KM` reject both.
- **Itinerary figures for the six tours seeded in October 2026** — the
  day-by-day rows for every tour except Upper Mustang were generated from
  data rather than typed, and it is worth knowing which parts are which.
  Place coordinates were resolved from OpenStreetMap (Nominatim) and then
  cross-checked against SRTM elevation, so two independent datasets agree on
  both where each village is and how high it is. `distance_km` is real OSRM
  road distance, `riding_hours` comes from OSRM's own duration. Day titles
  and terrain descriptions are written by hand. Upper Mustang's ten days are
  the original hand-authored seed data and are untouched.

  **Elevation gain/loss is derived from a SMOOTHED SRTM profile** (7-sample
  moving average, only counting changes over 25 m) sampled along the routed
  line. This matters: the first attempt summed every rise over 5 m along the
  raw profile, and because SRTM90 carries ~16 m vertical error on 90 m cells,
  neighbouring samples along a switchbacking gorge road wobble by more than
  the road climbs. Annapurna day 2 came out at 2,773 m over 15.4 km — 180
  m/km, an 18% average gradient for a whole day. Smoothing brought
  Annapurna's total from 10,813 m to 6,436 m against the 6,400 m the tour
  itself states. Treat per-day climb as indicative, not surveyed.

  Where a leg has **no mapped trail**, the distance is straight-line and the
  elevation figures are deliberately conservative **lower bounds**: the net
  climb between the two stops, high point being the higher of the two. They
  cannot mislead, but they do not include intermediate climbs or a pass
  crossing — so Manaslu day 10 does not reflect Larkya La (5,106 m) and
  Annapurna day 6 does not reflect Thorong La (5,416 m). Three rest days sit
  at 0 km. Those all need the operator's own figures.

  The admin day editor now cross-checks the itinerary against the tour's own
  `distance_km` / `elevation_gain_m` / `max_altitude_m` fields and warns when
  they disagree, because the tour page prints both — it can otherwise say
  "max altitude 3,800 m" above an itinerary whose high point is 4,527 m.
  Several such disagreements are outstanding and are listed in
  `SESSION_SUMMARY.md`; some are the tour's own fields being wrong (Dharan is
  recorded with a 61 m maximum altitude, when the town itself is at 370 m and
  the ride tops out near 1,400 m).

## 8. Production upgrade path

If this goes further: swap SQLite for PostgreSQL (`schema.sql` was written
close enough to Postgres syntax to port directly — mainly `INTEGER PRIMARY
KEY` → `SERIAL`/`IDENTITY` and `TEXT` timestamps → `TIMESTAMPTZ`), add a real
payment provider, add real satellite GPS ingestion, move the in-memory login
rate limiter (section 9) to a shared store if you run more than one backend
instance, and add broader input-validation hardening before this touches real
customer payments or real riders on a real mountain.

## 9. Security notes

This started as a demo with a single shared `ADMIN_TOKEN` and a couple of
XSS holes (any site visitor's review/custom-request/SOS text was rendered
into admin.html and tour-detail.html via unescaped `innerHTML`). Since fixed:

- **Real admin accounts.** `admins` table with scrypt-hashed passwords,
  `POST /api/admin/login`, and short-lived (12h) sessions — see section 4.
  No more permanent shared secret.
- **Hashed session tokens at rest.** `sessions.token_hash` stores SHA-256 of
  the bearer token, never the token itself — a leaked database dump alone
  isn't enough to sign in as anyone.
- **Login rate limiting.** 8 attempts / 5 minutes per IP+email on every login
  endpoint (rider, guide, admin) — in-memory, fine for one process, swap for
  a shared store (Redis etc.) before running multiple instances.
- **Output escaping.** Every place user- or visitor-submitted text (reviews,
  custom requests, emergency messages, GPS labels, booking rider names) gets
  rendered via `innerHTML` now runs through an `escapeHtml`/`esc()` helper
  first, in `frontend/main.js` and in each `backend/public/*.html` dashboard.
- **Booking IDOR closed.** Bookings are no longer readable/payable by anyone
  who can guess a sequential ID — see the `access_token` note in section 6.
- **Data-at-rest hardening.** The SQLite file and its directory are chmod'd
  to owner-only (`0600`/`0700`, best-effort — a no-op on filesystems without
  POSIX permission bits, e.g. most Windows setups) and `backend/data/*.db*`
  is git-ignored.
- **Basic response headers.** `X-Content-Type-Options: nosniff` and
  `X-Frame-Options: DENY` on every response.
- **No session without proof.** `POST /api/auth/verify-email` used to hand out
  a full rider session for an account that was *already* verified without
  checking the code at all (the branch existed so verifying twice wasn't an
  error). Knowing someone's email address was therefore enough to sign in as
  them. It now returns `409 { already_verified }` and the sign-in modal moves
  the person to the password form instead.
- **Only guides and admins can write to the GPS feed.** `POST /api/gps/ping`
  was unauthenticated, so anyone could inject positions for any departure into
  what `tracker.html` presents as a live rider location. `POST /api/emergency`
  is *deliberately* still open — an SOS has to work when the person pressing it
  can't sign in — but is throttled per IP so real alerts can't be buried under
  fake ones, and records whether the reporter was signed in.
- **Guide emails are not public.** `GET /api/guides` no longer returns each
  guide's email (also the identifier half of their login) to anonymous
  callers, and strips unverified qualifications server-side rather than
  relying on the frontend to hide them. An admin session gets the full shape
  from the same URL.
- **401 vs 403 kept distinct.** "Not signed in" and "signed in as the wrong
  account" used to return the same 401 and the same "Sign in required", which
  told people to do something that couldn't help and risked dashboards
  treating a permission error as an expired session.
- **Validated before bound.** Numbers, dates and slugs from query strings and
  request bodies go through `lib/util.js`'s validators first. Previously a
  non-numeric `?limit=` on the public `GET /api/departures` reached SQLite as
  `NaN` and returned a bare 500, and several admin fields could violate schema
  CHECK/FOREIGN KEY constraints the same way.

Still worth doing before this holds real customer data: TLS termination in
front of the server, a real secrets manager instead of env vars, dependency
and SAST scanning in CI, and a shared (not in-memory) rate limiter if you
scale past one process.

---

## 10. The universal adventure model

The site launched mountain-bike-only and `tours` was shaped around that:
`riding_style`, `distance_km` and `elevation_gain_m` as NOT NULL columns, and
no column anywhere saying what kind of activity a trip even was. Adding
trekking by copying that table would have produced two tables, two detail
templates and two of every query.

**Every adventure is one row in `tours`, whatever the activity.** The
universal fields are real columns because every adventure has them and they
get filtered and sorted on. Anything that only makes sense for one activity
lives in `activity_data_json`, validated per activity.

### Adding an activity — the whole procedure

1. Insert a row in `activity_types`, or flip an existing row's `enabled` to 1
   (admin panel → **Activities**).
2. Add an entry to `ACTIVITY_FIELDS` in `backend/lib/adventures.js` describing
   its own fields.
3. Add an entry to `DIFFICULTY_DIMENSIONS` saying how it is graded.

That is all. No migration, no new table, no second detail page, no duplicated
card component, and no change to the filters, the Adventure Finder or the
navigation — they all read `activity_types` and those two maps. Step 1 alone
is enough to launch a category: an activity with no field definitions still
works, it just gets the universal fields and the three default difficulty
dimensions, and the admin panel says so rather than leaving you wondering.

`rafting` and `trail-running` are already in `activity_types` with full field
definitions and `enabled = 0`. They are the worked example: enable either one
and its category page, filters, finder option and admin fields all appear.

### Why `activity_data_json` and not more columns

Walking hours matter to a trek, rapid grade to a rafting trip, and neither to
the other. Twenty nullable columns where eighteen are always NULL is a table
nobody can read, and every new activity would mean another migration. The
split is: columns for what is queried, a validated JSON object for what is
only ever read as a complete set for one adventure at a time.

`backend/lib/adventures.js` holds `ACTIVITY_FIELDS`, so a field that does not
belong to the adventure's activity is **dropped on write** rather than
stored. Sending `riding_style` to a trekking adventure is not an error — it
is simply not that activity's field, and it does not end up in the database.

### The universal difficulty framework

Five levels, 1 (Relaxed) to 5 (Tough), shared across every activity so that
"Moderate" means the same amount of commitment on a trek as on a ride. Each
level carries a `meaning` and a `commitment` sentence; the commitment
sentence is the part that makes a level self-assessable and the part most
difficulty scales leave out.

On top of that, **per-activity dimensions**, because a single number tells
you how hard a trip is but not why, and the why is what decides whether you
should book it. Mountain biking is graded on fitness / technical / altitude;
trekking on fitness / terrain / altitude; rafting on physical demand / rapid
grade / swimming. Declared per activity in `DIFFICULTY_DIMENSIONS`, so the
frontend renders "Terrain" for a trek and "Technical" for a ride without
knowing that either exists.

The first three dimensions are real columns (`difficulty_fitness`,
`difficulty_technical`, `difficulty_altitude`) because they are filterable;
any fourth an activity declares — rafting's `swimming` — is carried in
`activity_data_json` under the same key.

**`difficulty_assessed`** is worth knowing about. The migration had to get
three dimensions from the old single level, and the only honest conversion
was to seed all three from it. So a trip whose three scores all equal its
overall level has not actually been assessed, and both the public trip page
and the admin panel say so in words rather than presenting three identical
bars as a judgement somebody made. The notice disappears per trip once the
scores are set properly.

### What is new in the schema

Added to `tours` by `backend/migrations/001-universal-adventure.js`, all
additive and idempotent:

`activity`, `destination_slug`, `description_full`, `trip_format`,
`accommodation_type`, `accommodation_notes`, `elevation_loss_m`,
`deposit_cents`, `mandatory_charges_json`, `optional_extras_json`,
`difficulty_fitness`, `difficulty_technical`, `difficulty_altitude`,
`highlights_json`, `suitability_*` (5), `booking_*` (4), `faqs_json`,
`activity_data_json`, `impact_json`, `published`, `updated_at`.

New tables (`backend/schema.sql`):

| Table | What it is for |
|---|---|
| `activity_types` | Which adventure categories exist and which are switched on. This is what makes "enable trekking" a content change. |
| `faqs` | Site-wide, per-activity and per-destination questions. Distinct from `tours.faqs_json`, which is one trip's own. |
| `impact_records` | What a departure actually spent and where — per departure, not estimated. |
| `impact_metrics` | The annual figures the Our Impact page publishes, each with an `evidenced` flag. |
| `finder_leads` | Written only when a visitor explicitly asks for their Adventure Finder results by email. |

Also: `destinations` gained page content (`intro`, `best_time`,
`practical_json`, `activities_json`, `related_json`, `elevation_range`,
`getting_there`, `published`); `guides` gained `activities_json`;
`custom_requests` gained the Private Trips fields (`activity`,
`difficulty_pref`, `accommodation_pref`, `special_requirements`, `date_from`,
`date_to`, `phone`, `contact_preference`, `source`).

### The API

`/api/tours` is **untouched** and still serves the mountain-bike catalogue
the booking flow is built on. The universal endpoints are additions, not
replacements:

| Endpoint | What it does |
|---|---|
| `GET /api/activities` | The categories, with public adventure counts and each one's field and dimension definitions. |
| `GET /api/meta/filters` | Everything the filter UI, the finder and the difficulty guide need to render themselves. This is why the frontend has no hardcoded list of activities, difficulty levels, destinations or duration bands. |
| `GET /api/adventures` | One listing endpoint for every activity. Filters: `activity`, `destination`, `region`, `difficulty`, `duration` (band keys), `minDuration`/`maxDuration`, `format`, `accommodation`, `month`, `minPrice`/`maxPrice`, `maxAltitude`, `q`, `sort`, `limit`/`offset`. |
| `GET /api/adventures/:slug` | The full detail payload — days, departures, reviews with a computed rating, gallery, guides filtered to the activity, destination, site FAQs and the live cancellation tiers. |
| `GET /api/finder` | The four-question finder, resolved to adventures. Anonymous and stateless. |
| `POST /api/finder/save` | The optional email capture under the results. Stores; does **not** send. |
| `GET /api/destination-pages` | The Destinations index. |
| `GET /api/destinations/:slug` | A destination page. |
| `GET /api/faqs` | Site FAQs, filterable and grouped by category. |
| `GET /api/impact` | The impact report, split into `published` / `pending` / `derived`. |
| `GET /api/when-to-visit` | Month-by-month conditions with the trips that run then. |

Admin: `/api/admin/activities` (CRUD), `/api/admin/faqs` (CRUD),
`/api/admin/impact/metrics` (CRUD), `/api/admin/impact/records` (CRUD),
`/api/admin/destinations/:id/content`, `/api/admin/finder-leads` (read-only).
`POST`/`PATCH /api/admin/tours` accept every new field.

### Two API design decisions worth knowing

**`seasonCoversMonth()` parses free text.** `best_season` is something an
admin types — "Sep – Nov", "Mar – May, Sep – Nov", "Year-round" — which is
right for display and useless for filtering. It is parsed in JS after the SQL
filters have cut the set down. An unparseable value returns **true** rather
than false: showing one trip too many under a month filter is a smaller
failure than silently hiding one that was available. (Tour 7's season is
currently typed as "autom", which is why it appears under every month.)

**`publicWhere()` is centralised.** Every public query goes through it, so
`published = 1 AND activity IN (enabled)` is written once. Getting that wrong
in one place is how a disabled category leaks onto the site.

---

## 11. Honesty rules this build follows

The brief is emphatic that nothing may be fabricated, and several of these
cost something to honour. They are listed because each one is a decision that
could silently be undone later.

| Rule | How it is enforced |
|---|---|
| **No invented availability** | Departures and remaining spaces come from the `departures` table. A trip with no dates says "No dates currently open" and offers a private enquiry. There is no "selling fast" copy anywhere, and a seats figure is only ever the real `capacity - seats_booked`. |
| **No fabricated prices** | `tours.html` previously shipped nine hand-written cards with prices (€1,120, €2,890, €95) and three trips — Rara Lake Wilderness among them — that do not exist, as a no-JavaScript fallback. They were overwritten a moment after load, which is why they survived. The page is now a redirect to `adventures.html`. |
| **No borrowed reviews** | Reviews come from the `reviews` table, written by riders from their own dashboard. A trip with none says so; the rating is the mean of whichever of the five score dimensions the rider actually filled in, and is `null` rather than 0 if none were. |
| **No unverified qualifications** | `GET /api/adventures/:slug` filters guide qualifications to `verified: true`. The Guides page states that a short list is a verified list rather than a complete one. |
| **No sustainability figures nobody measured** | `impact_metrics` ships with 11 labelled rows, every one with `value = NULL` and `evidenced = 0`. The Our Impact page renders each as "not published for 2026" with the note saying what must be supplied. The API refuses to let an admin set `evidenced` on a metric with no value. |
| **No safety procedure we were not given** | The Safety page has a "What is not documented yet" section listing six things — emergency procedure, guide medical qualifications, liability insurance, accreditation, the 24-hour contact, named evacuation providers — and tells the reader to get them in writing before paying a deposit. |
| **No fake email confirmations** | `POST /api/finder/save` returns `email_sent: false` and a message saying so in words the UI prints verbatim. The newsletter form's old message ("we'll email you when new departures open") promised something nothing sends and now says the address is stored and no email was sent. |
| **No fake consent UI** | There is no cookie banner, because there is nothing non-essential to consent to: no analytics, no advertising cookies, no pixels. The Cookies page says that outright and lists the two things actually stored (session token; finder answers in `sessionStorage`). |
| **No legal pages pretending to be reviewed** | Booking Conditions, Privacy and Accessibility each open with a note saying they are not professionally drafted, describe only what the code actually does, and list what is outstanding. Booking Conditions reads the refund tiers **live from `cancellation_rules`**, so the page cannot quote a different number from the one the refund calculation uses. |
| **No placeholder URLs** | `href="#"` is gone from the site. The gallery triggers that used it became `<button>` (they open a lightbox — they were never links), the homepage grid became `<figure>` (nothing was wired to it), and the booking CTA became a `<button>` with its destination on a data attribute. A check over every rendered page counts real anchors and fails the build on any that remain. |
| **Deposits flagged** | The deposit figures were set at 20% of price by the migration. Every trip page and the admin pricing section say they are placeholders pending confirmation, and the checkout amount is named as the authority. |

### Where the site deliberately shows a gap

Four places where an empty state was the correct answer:

- **The trekking and multi-activity category pages.** Both are in the
  navigation, as the brief requires, and both are genuinely empty. They say
  so, explain that the guides and logistics are the same ones already
  running, and link to Private Trips — rather than listing an invented
  itinerary.
- **The Everest destination page** carries no mountain-bike trips and says
  why: the main Khumbu trails are stone staircases shared with a very large
  number of walkers and porters. That is a better answer than listing nothing
  silently.
- **Unassessed difficulty dimensions**, described above.
- **The whole Our Impact page**, which is mostly gaps on purpose.

---

## 12. Frontend structure after the rebuild

### `shell.js` — the header and footer, defined once

Every page previously carried its own copy of the header markup. Twelve
copies of a four-item dropdown nav meant adding "Destinations" was twelve
edits, and the copies had already drifted: some pointed at `#why`, some at
`index.html#why`, and several menu entries went to `href="#"`.

A page now writes `<div data-site-header></div>` and
`<div data-site-footer></div>` and gets the real thing, plus a skip link
that no page had before. Script order matters: `shell.js` runs before
`main.js`, because `main.js` builds the mobile nav from `.main-nav` and
mounts the account control into `.header-actions`.

The nav renders from a static list first — a header must not wait on a
network request — and is then reconciled against `/api/meta/filters`, which
removes a disabled activity or unpublished destination and adds a newly
enabled one. That is what keeps "enable an activity in the admin panel" from
needing a frontend change.

### `adventures.js` — the universal components

`advCard()`, `difficultyBlock()`, `glanceBlock()` and `accordion()`, plus the
page controllers. Every listing on the site — homepage, adventures listing,
search, destination page, finder results, when-to-visit — renders through
`advCard()`. That is what "reusable components" and "single source of truth"
come down to in practice: there is one of them.

`main.js` is untouched apart from four targeted fixes. It is 3,300 lines that
a working checkout depends on, and making it activity-agnostic would have
meant re-testing payment. Everything new is in `adventures.js`, and the two
meet only through the globals `main.js` already exposes.

**The cost of that split, stated plainly:** `tour-detail.html` makes two API
calls for the same adventure — `/api/tours/:slug` for `main.js`'s sections
and `/api/adventures/:slug` for the new ones. One extra local request was a
smaller price than rewriting the renderers the booking flow feeds.

### What is NOT on the tour detail page, and why

`adventures.js` can render an accordion itinerary (`#adv-itinerary`) and a
review list (`#adv-reviews`). Neither is mounted on `tour-detail.html`:

- The **day tabs and elevation panel already there** are that page's
  day-by-day — one day at a time with distance, ascent, descent, high point,
  hours, terrain and the overnight stop, plus the profile chart. A second
  full day-by-day block was built there earlier and removed at the owner's
  request for making the layout unusual; it is not returning as a duplicate
  of a section that already works.
- `main.js` already renders reviews with the five-dimension breakdown this
  schema stores. One review list, not two.

Both renderers stay in `adventures.js` and mount automatically on any page
that declares those ids — which is what makes them reusable rather than dead.

### Design system

The brief's palette, applied as a token swap so every component already
written against the old variable names kept working: `--forest` #1F3A32
(primary — header, dark sections, footer), `--ink` #F5F1E8 (warm sand
background), `--signal` #D86432 (saffron accent), `--paper` #222522
(charcoal text).

Three changes worth noting:

- **`--glacier` and `--moss` were a teal and a separate green**, which read
  as two more brand colours. Both are now forest-family, so data and
  sustainability accents belong to the same system instead of competing with
  it. No rainbow palette per activity — activities are told apart by
  photography, labels and content.
- **Three font families, not two.** Fraunces for display, Inter for body
  copy, IBM Plex Mono for label and metric type. The mono was briefly folded
  into Inter to get under the brief's two-family cap; the label type lost its
  character and the owner asked for the original typography back, so
  `--f-mono` points at IBM Plex Mono again. The brief's cap is the one
  requirement in it that is deliberately not met, and this is why.
- **`--signal-btn` #BC4F23 exists for a measurable reason.** White on the
  brand saffron is 3.63:1. That clears AA for large text and for non-text UI,
  but a button label here is 14px at weight 700 — under the 18.66px bold that
  counts as large — so it needs 4.5:1 and the brand colour does not reach it.
  Solid buttons, the header CTA, the activity badge and the notification
  badge use the darkened saffron (4.91:1); every non-text use of the accent
  keeps `--signal` exactly as specified. `--paper-dim` moved from #6E644F
  (4.3:1, large text only) to #5E6459 (5.41:1) for the same reason.

---

## 13. Pages

| Page | What it is |
|---|---|
| `index.html` | Homepage, rebuilt to the brief's eight sections. Hero → Adventure Finder → Featured adventures → Why High Route → Destinations → Impact → Traveller stories → Final CTA. Twelve sections became eight; the hardcoded tour cards, the riding-styles grid, the SVG map (whose pins linked to those cards' anchors), the fake journal and the decorative gallery are gone. |
| `adventures.html` | The single listing template. Also serves the Mountain Biking / Trekking / Multi-Activity category pages via `?activity=`, with its own heading, lede and meta per category — one template rather than four near-identical files. Filter state lives in the URL. |
| `destinations.html`, `destination.html` | Index and detail. Seven destinations with real geography, permits and seasons. |
| `finder.html` | The four-question Adventure Finder. Anonymous; answers in the URL and `sessionStorage`. |
| `when-to-visit.html` | Month by month, built from each adventure's own `best_season` so it cannot contradict a trip page. |
| `difficulty-guide.html` | The five levels with live examples, and each activity's own dimensions rendered from the API. |
| `faqs.html` | Grouped and searchable, from the `faqs` table. |
| `guides.html`, `about.html`, `safety.html`, `our-impact.html`, `responsible-travel.html` | The About section. |
| `private-trips.html` | The custom enquiry, posting to the real `POST /api/custom-requests`. |
| `search.html`, `contact.html` | Utility. |
| `booking-conditions.html`, `privacy.html`, `cookies.html`, `accessibility.html` | Legal, each stating its own status. |
| `tours.html` | Now a redirect to `adventures.html`, translating the old filter params. See the comment at the top of the file. |

---

## 14. Testing

Four suites, all runnable against the dev servers:

- **`test-universal.js` — 101 assertions.** Creates its own scratch
  adventure, exercises every new field, every validation bound, the publish
  flag, all eight filters, both sorts, the finder's relaxation order, the
  finder lead's honesty flags, impact publication rules and the activity
  registry's delete guard — then deletes the scratch row and asserts the
  seven real adventures are unchanged. Includes the cross-activity test that
  matters most: a mountain-bike field sent to a trekking adventure must be
  dropped, not stored.
- **`regress.js` — 51 assertions.** The pre-existing suite: public
  endpoints, payload shapes, auth and privacy, and row counts across
  bookings / custom requests / departures / tours.
- **`render.js` — 27 pages.** Renders every page in headless Edge against
  the live API and checks the header and footer mounted, exactly one `<h1>`,
  no dead anchors, no `undefined` / `NaN` / `[object Object]` in visible
  text, the page's own content marker, and **tag balance of the rendered
  DOM**.
- **`a11y.js`.** Computes the real WCAG ratio for 20 colour pairs. Two
  failed and were fixed — see the `--signal-btn` note in section 12.

Not done, and said so on the Accessibility page rather than glossed: reflow
at 320px has not been measured in a browser. `body { overflow-x: hidden }`
makes that worth stating, because it means overflow is **clipped rather than
prevented** — the page will never scroll sideways, but anything too wide at
320px has its right edge cut off and unreachable, which is worse than a
scrollbar. The layout is mobile-first and should reflow; "should" is not
"does". The overflow probe is written (`overflow320.js`, which correctly
fails on elements extending past the viewport rather than on `scrollWidth`,
precisely because of the clipping) and needs a machine that is not saturated
with orphaned headless browser processes to finish.

**Tag balance is checked on every structural edit**, by `checktags.js`. That
is a direct response to a bug earlier in this project: a block-removal regex
whose non-greedy `.*?` stopped at the first inner `</div>`, leaving an
orphaned closing tag that closed a section's parent early and threw every
section below it out of the layout column. None of the checks being run at
the time — pin counts, NaN scans, row counts — could see it.

Two false positives in these tools are worth recording, because both wasted a
cycle. The dead-link check first matched the *string* `href="#"`, so it
flagged the accessibility page (which discusses it inside `<code>`) and an
HTML comment explaining why a button replaced one. It now counts anchor
elements after stripping comments and code blocks. **Count the thing, not the
text that describes it** — the same lesson as an earlier false XSS report in
this project.

---

## 15. The design pass (dropdowns, cards, destination pages)

A round of design fixes. Most of the complaints turned out to be **bugs**, not
taste — that matters, because a bug should stay fixed and a taste choice can
be changed back.

### Fonts

| Token | Value | Why |
|---|---|---|
| `--f-display` | `DM Sans` | Headings. Changed a few times; see note below. |
| `--f-body` | `Inter` | All body copy. Unchanged. |
| `--f-mono` | `IBM Plex Mono` | Labels, kickers, stat captions, table headers. |

**The display font must have a real italic.** This site sets
`font-style: italic` on headings in **20 places** — the hero, every section
heading, the logo, card titles, review quotes. A font without an italic (we
tried Big Shoulders Display) makes the browser fake a slant, and it looks
broken at hero size. If you swap `--f-display`, pick something with a true
italic and weights 400–700.

Heading sizes were increased about 8% afterwards (`.hero h1`,
`.dest-hero h1`, `.page-hero h1`, `.page-head h1`, `.section-head h2`,
`.detail-main h2`). Each `clamp()` was scaled whole, so phones grow too.

### Dropdowns

Every `<select>` on the site now shares one look: brand border, site radius,
a drawn chevron, forest focus ring.

Two limits, stated rather than hidden:

- **The open option list is drawn by the operating system.** It cannot be
  styled. Only the closed control is.
- The control is still a real `<select>`. A fake dropdown built from `<div>`s
  would look slightly better open and would lose keyboard support,
  type-ahead, screen readers and the native phone picker.

### Bugs found and fixed

| What looked wrong | What was actually wrong |
|---|---|
| Cards in a row were different sizes | `.adv-media` is a flex item, and flex items default to `min-height:auto`. Any photo **taller than 3:2** beat the aspect ratio and stretched the box — one portrait photo gave a 410px image next to two 180px ones. Fixed with `min-height:0` and taking the image out of flow. |
| Spacing "off" everywhere | `.section-head` was a flex **row** over three children, so the kicker sat *beside* the heading instead of above it, and the intro was squeezed into 360px. Now a grid. |
| Filter panel looked unstyled | It **was**. Each group is a `<fieldset>` and only `border-bottom` was set — the browser's `2px groove` stayed on the other three sides. The `<legend>` titles had no styling. And `.filter-count` was *both* the little count badge *and* a dead layout rule (`display:flex; margin-bottom:24px`) left over from the old tours page, which is what pushed the rows apart. |
| "Four things" section | Four items in a 3-column grid, so one orphaned onto a second row. Paragraphs also had no bottom margin, so text touched the link under it. |
| "Adventure that gives back" | Reused `.why-item` inside a 2-column grid built for text + photo, and a mobile rule moved the **last** item to the front — it was silently reordering your content on phones. |
| Destination card intro invisible | `.dest-card p { color: rgba(245,241,232,0.86) }` (near-white) beat `.dest-card-intro` on specificity. The old card's full-card dark scrim was also still painting over the new white card. Both removed. |

### Destination pages

Each region page now has: hero, at-a-glance bar, about, highlights, photo
gallery, trips, season table, permit/transport/health panels, culture,
free-form sections, FAQs, related regions.

**New DB columns** on `destinations`: `best_months`, `altitude_summary`,
`at_a_glance_json`, `highlights_json`, `seasons_json`, `sections_json`,
`permits`, `getting_around`, `health_notes`, `culture`.
**New table**: `destination_images`.

The gallery comes from two places: photos you add in the admin panel, and
photos already attached to the trips that run in that region (each labelled
with which trip it came from). That is why six of seven regions have a
gallery without anyone uploading anything. **No stock photos are pulled in to
fill it** — Everest has no trips, so its gallery is just the hero image and
the page says photographs are missing.

A region with no `intro` is **not a page at all** — `/api/destinations/:slug`
now returns 404 for it, same rule the index already used. Before, a bare map
pin like `chitwan` rendered a heading above a list of everything it lacked.

**What was written into the pages, and what was not.** The seeded text is
geography, logistics, seasons and culture — facts that are true whether or
not anyone books. Left out on purpose: permit **fees** (which permits you
need is a fact; what they cost changes by nationality and year), flight and
transfer prices, claims about named lodges, and anything that would need
measuring rather than knowing. Migration 004 only fills a field that is still
**empty**, so your edits in the admin panel survive every restart.

### Admin panel

The destination content API existed with **no interface onto it**, so those
fields could only be set by a migration, and there was no way to add a
destination photo at all. Both exist now on the Destinations tab:

- **Page content editor** — every block the public page shows. The table has
  a completeness column (`4/9 blocks — missing: seasons, permits`) so you can
  see what the live page is currently admitting it lacks.
- **Gallery manager** — photos you can edit, plus a count of the ones
  inherited from that region's trips and where they came from.

Blocks with a heading *and* a multi-paragraph body use a small syntax,
because a one-per-line textarea cannot hold a blank line:

```
## Autumn | Oct - Nov | best
The clearest window of the year.

Also the busiest, which is the trade.
```

`parseBlocks` / `formatBlocks` round-trip this exactly. There is a test for
it (`test-admin-dest.js`) because a lossy round-trip would quietly delete a
paragraph every time someone opened a page and saved it.

### Accessibility

The destination hero puts text over a photo, so its contrast is only as good
as the lightest photo someone uploads. Measured against that worst case the
eyebrow line was **2.99:1**, where small text needs 4.5:1. Scrim darkened
from 0.74 to 0.82 and two text colours raised — now 5.78:1 and 4.89:1.
All **50** new colour pairs pass.

### Also fixed

- Calendar filters had **no accessible name** at all, and the difficulty list
  still used the old Beginner/Intermediate/Advanced/Expert wording against a
  5-level database. Both now load from `/api/meta/filters`.
- Nav dropdown is now a forest panel with a one-line description per entry.
- The filter rail collapses behind one button under 980px.
- Guide cards were a 200px photo squeezed into a 180px column.

### Tests

| Suite | Result |
|---|---|
| `check-design.js` — this pass, in a browser | 82/82 |
| `test-admin-dest.js` — destination editor + gallery | 37/37 |
| `contrast-new.js` — new colour pairs | 50/50 |
| `render.js` — all pages render clean | 27/27 |
| `test-universal.js` — adventure model | 101/101 |
| `regress.js` — pre-existing regression | 51/51 |
| `test-admin-ui.js` — pre-existing admin panel | 34/34 |

Database verified unchanged afterwards: 7 tours, 23 departures, 17 bookings,
8 custom requests, 8 destinations, 0 test rows left behind.

**Not done:** horizontal overflow at 320px was never finished — the browser
sweep is too slow in this environment. It is the one unverified item.

> The regression suite failed 5 checks on its first run ("0 bookings",
> "0 custom requests"). The database was checked directly first — all intact —
> and the real cause was an expired 12-hour admin token. **Check a test
> failure before believing it.**

---

## 16. Finishing the v2 brief, and user testing

The v2 brief was checked section by section. The full table is in
**`V2_AUDIT.md`**. This section is the short version.

### What was missing from v2, and is now done

| Brief § | Was | Now |
|---|---|---|
| 13, 25 | **Payments were simulated.** Any card was "approved", and the full card number and CVV were sent to our own server | Both pay endpoints refuse (HTTP 503) before reading anything. No card form is shown. Customers are told how to pay. See `backend/lib/payments.js` |
| 13 | Checkout said **"You're booked!"** when nothing had been paid | Says **"Place held"** — which is the booking's real status |
| 13, 19 | **No enquiry form.** Asking anything meant creating an account | Contact page form, no account needed. New admin **Enquiries** tab |
| 8.5 | Itinerary days had no **description, accommodation, meals or notes** | Added end to end: database, admin day editor, trip page |
| 8.14 | No final booking button on the trip page | Added |
| 15 | Region filter existed in the API but never on the page | Added |
| 17 | When to Visit had no activity or destination choice | Added |
| 10 | Destination pages didn't connect to the filters | Added |
| 18 | Difficulty Guide had no filtered listing link | Added |
| 22 | Canonical URL missing on most pages | On every page |

### Payments — how it works now

| Setting | What happens |
|---|---|
| Default | No card form anywhere. Bookings are **held** for 72 hours. An admin records the payment when the money actually arrives (Bookings tab → record payment) |
| `ALLOW_SIMULATED_PAYMENTS=1` | The old fake card form comes back, clearly labelled **SIMULATED**. Demos only — never on a site real customers use |

To take real money, connect a provider (e.g. Stripe) using **hosted card
fields and a webhook**. Card numbers must never reach this server.

### Pages removed

Moved to `_archive/removed-pre-v2-pages-2026-10-26/` (not deleted — the
project isn't in git):

| Removed | Use instead |
|---|---|
| `build-adventure.html` | `private-trips.html` |
| `cancellation-policy.html` | `booking-conditions.html#cancel-you` |
| `safety-policy.html` | `safety.html` |
| `tours.html` | `adventures.html` |

Anything only those pages did was moved over first. About 270 lines of
JavaScript that only served them were removed too.

### Bugs that testing found

| Bug | Cause |
|---|---|
| **Rider dashboard never loaded** | `shell.js` renamed a page element's id to `main` while adding the skip link. Every page now has a real `<main>` |
| **Private Trips could never be sent by a signed-in rider** | The form looked for the login token under the wrong name |
| Contact form's adventure list never loaded | It asked the API for 200 results; the limit is 100 |
| Trip page **339px too wide on phones**, booking box pushed off-screen at 1024px | A grid column couldn't shrink. `1fr` → `minmax(0, 1fr)` |
| `guide.html` **shipped with the demo guide's password filled in** on the live backend | Removed; fields now labelled |
| Missing labels, a missing heading, a thin search description | Fixed |

### How it was tested

Three new suites, run in a real browser against the real servers. Each
creates its own test account and data, and deletes all of it afterwards.

| Suite | Covers |
|---|---|
| `uat-pages.js` | All 27 pages × 5 screen widths (375 – 1440px): loads, no errors, no broken images or links, labels, one heading, no sideways scrolling |
| `uat-journeys.js` (visitor + rider) | Home, menus, filters, sorting, finder, trip page, gallery, contact form, private trips, **full checkout**, dashboard, invoice, custom-trip checkout |
| `uat-journeys.js` (admin) | Every admin tab, enquiries, CRM, bookings, day editor, guide sign-in |

Results are at the end of `SESSION_SUMMARY.md` (Task 18).
