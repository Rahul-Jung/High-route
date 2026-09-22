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
python3 -m http.server 8080
# or: npx serve .
```

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
Build Your Adventure wizard (`build-adventure.html`) stays open to anonymous
visitors — it's a lead form — but auto-links the request to your account, and
prefills name/email, if you happen to be signed in. `apiGet()`/`apiPost()`/
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
  amount paid vs. total) and a **Cancel booking** button, shown only while
  it's still cancellable (not already cancelled/completed, and the departure
  hasn't happened yet — `can_cancel` computed server-side, not just hidden by CSS).
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
`tour_days` rows yet (every seeded tour except Upper Mustang) shows a "not
published yet" message in place of the day-by-day itinerary instead of a
broken chart — add days for a tour directly in `schema.sql`'s `tour_days`
table (there's no admin-CMS itinerary editor yet) if you want the full
day-tabs/elevation-chart experience on another tour. A nonexistent slug, or
the backend being unreachable for a tour other than Upper Mustang, shows a
clear "couldn't load this tour" state with a link back to `tours.html` rather
than fabricated content.

## 4. The admin CMS — what you can manage

Everything editable lives in `backend/public/admin.html`. Sign in with the
admin email/password printed on first server startup (see section 1), then:

- **Tours** — add/edit/delete: name, region, summary, duration, difficulty,
  riding style, distance/elevation/altitude stats, price, best season, cover
  image URL. Changes appear on `index.html`/`tours.html` on next page load.
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
- **Email/SMS** — the automated-communication sequence from the brief
  (booking confirmed, 30-days-out reminder, etc.) isn't implemented beyond the
  newsletter signup table; there's no email provider connected.
- **Photography** — every image is a seeded `picsum.photos` placeholder;
  swap URLs via the admin Gallery/Tours tabs.

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

Still worth doing before this holds real customer data: TLS termination in
front of the server, a real secrets manager instead of env vars, dependency
and SAST scanning in CI, and a shared (not in-memory) rate limiter if you
scale past one process.
