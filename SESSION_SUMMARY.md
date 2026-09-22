# Session Summary — what was built, in order

This tracks everything done across this session's tasks, so a future
session (or you) can pick up context fast. Paste this into a new chat along
with `HANDOFF.md` for full context. Each task was implemented, tested against
disposable backend/frontend copies (never the real running server/DB unless
explicitly noted), and left in a working state.

---

## Task 1 — Tour Catalogue & Discovery Filters

**Ask:** `GET /api/tours` had no working filters (frontend filtered a
fully-fetched list client-side); add destination/season/budget/group-type/
max-altitude filters, all server-side, plus richer tour cards.

### Backend
- **`backend/routes/tours.js`** — rewritten. `GET /api/tours` now accepts:
  - `difficulty=1,2` (was single-value) · `style=Trail,Enduro` (was single) ·
    `destination=Mustang,Pokhara` (alias: `region=`, kept for back-compat) ·
    `duration=1-3,8-14` (bucketed ranges; `minDuration=`/`maxDuration=` still work) ·
    `minBudget=`/`maxBudget=` (alias: `maxPrice=`) ·
    `season=spring,summer,autumn,winter` ·
    `groupType=2-4,5-8` (bucketed group-size ranges) ·
    `maxAltitude=<metres>`
  - All filters combine with AND; multi-value filters OR within themselves.
  - Season matching **expands month ranges properly** (handles wraparound
    like "Oct – Apr" spanning the year-end) rather than naive substring match.
  - Every tour in the response now also carries `upcoming_departures[]`,
    `next_departure` (or `null`), `has_departures` (true even if none are
    upcoming — distinguishes "sold out" from "never scheduled"), and
    `riding_hours_summary` (derived from `tour_days`, `null` if none entered).
  - Full input validation — bad values return `400`, never silently ignored
    or crash.

### Frontend
- **`frontend/tours.html`** — added filter UI: Destination, Best season,
  Group type (checkboxes), Budget min/max, Max altitude (select). Added a
  mobile-only "Hide/Show filters" collapse toggle.
- **`frontend/main.js`** — the tour-grid IIFE was rewritten so filter changes
  build real query params and **re-fetch from the API** (not client-side
  filtering), sync into the URL (`history.replaceState`), and show
  loading/empty/error states. The very first page load still falls back to
  the static HTML cards if the API is unreachable (preserved existing
  behaviour). Cards now show riding hours, best season, and next departure
  date, with accurate "No upcoming dates" vs "Dates on request" text.
- **`frontend/style.css`** — new filter-panel styles, `.ride-grid-2col`,
  mobile filter-toggle styles.

### DB
No new tables/columns — everything reused existing `tours`/`departures`/
`tour_days` columns.

---

## Task 2 — Individual Tour Detail Page

**Ask:** add route map, tour-specific gallery, full guide profile,
inclusions/exclusions, required equipment, safety info, and cancellation
policy to `tour-detail.html` — all backed by real (not fabricated) data.

### Database (`backend/schema.sql`, `backend/db.js`, `backend/seed.js`)
- **`tours`** — new columns: `inclusions_json`, `exclusions_json`,
  `equipment_essential_json`, `equipment_recommended_json` (JSON arrays,
  default `[]`), `safety_hazards`, `safety_preparation`, `safety_emergency`,
  `cancellation_policy` (free text, nullable — no fabricated defaults).
- **`guides`** — new column `qualifications_json` (array of
  `{title, verified}`). **Only `verified:true` entries are ever shown
  publicly** — an admin can record a claim without it appearing until checked.
- All migrated via `db.js`'s existing idempotent `ALTER TABLE` pattern —
  safe on pre-existing databases.
- `gallery_images` table (already existed) reused via `category='tour'` +
  `tour_id` — no schema change needed there.

### Backend
- **`backend/routes/tours.js`** — `GET /api/tours/:slug` now also returns:
  `gallery[]` (this tour's images), `guides[]` (distinct guides who've ever
  led one of its departures, each with `qualifications[]`),
  `inclusions`/`exclusions`/`equipment_essential`/`equipment_recommended`
  (parsed arrays), and the safety/cancellation text fields.
- **`backend/routes/admin.js`** — `PATCH /api/admin/tours/:id` accepts the
  new array fields (`inclusions`, `exclusions`, `equipmentEssential`,
  `equipmentRecommended`) and text fields (`safetyHazards`,
  `safetyPreparation`, `safetyEmergency`, `cancellationPolicy`).
- **`backend/routes/guides.js`** — `POST`/`PATCH` accept a `qualifications`
  array; exports `PUBLIC_FIELDS`/`toPublicGuide` (reused by `tours.js`).
- **`backend/routes/gallery.js`** — added `PATCH /api/admin/gallery/:id`
  (previously only create/delete existed) so captions/category/tour-link
  can be edited without delete-and-recreate.

### Frontend
- **`frontend/tour-detail.html`** — new sections: **Gallery** (with a
  from-scratch lightbox viewer — click to open, arrow keys/Escape/backdrop
  to navigate/close), **Route map** (inline SVG, reuses the homepage's
  fixed-bounding-box lat/lng projection technique but rescaled to the
  tour's own coordinates — plots only real `overnight_lat/lng` values,
  never invents them, and calls out which days have no GPS data), **Your
  guides** (full profile cards: photo/bio/experience/languages/verified
  qualifications/rating), **Inclusions & exclusions**, **Required
  equipment** (essential/recommended), **Safety information**, and
  **Cancellation policy** — every section shows an honest empty state
  ("not yet specified") instead of placeholder copy when the admin hasn't
  filled it in.
- **`frontend/main.js`** — new render functions: `renderRouteMap`,
  `renderTourGallery`, `renderTourGuides`, `renderInclusionsExclusions`,
  `renderTourEquipment`, `renderTourSafety`, `renderTourCancellation`, plus
  the shared `openLightbox()` component.
- **`frontend/safety-policy.html`** and **`frontend/cancellation-policy.html`**
  (new pages) — genuine site-wide policy content describing what the system
  actually does (later updated in Task 3 once real refund calculation
  shipped — see below).
- **`frontend/style.css`** — `.route-map`/`.route-pin`/`.route-map-line`,
  `.lightbox-*`, `.ride-grid-2col`.

### Admin panel (`backend/public/admin.html`)
- Tours tab: new "Tour-detail-page content" card (inclusions/exclusions/
  equipment as line-per-textarea, safety fields, cancellation policy).
- Guides tab: verified/unverified qualifications editor (two textareas).
- Gallery tab: inline edit (caption/category/tour link) via the new PATCH.

---

## Task 3 — Booking & Checkout System

**Ask:** replace the hardcoded single-rider instant-book stub with a real
multi-step checkout (rider selection → rider info → add-ons → review →
confirm), plus invoices, promo codes, and cancellation/refunds. **Real
payment gateway integration was explicitly deferred by you** — checkout
still ends at the same "pending booking + 72h deposit hold" state as
before, just reached through a real flow instead of one click.

### Database
New tables: `addon_catalog` (admin-priced, replaces a hardcoded price
object that used to live in `bookings.js`), `booking_addons` (price-
snapshotted line items per booking, so a later catalog price change never
rewrites a past booking), `promo_codes`, `invoices` (sequential numbering,
generated lazily and stable once issued), `cancellation_rules` (admin-
configurable tiers: "N+ days before departure → X% refund"), `refunds`
(audit trail — starts `pending`, only becomes `processed` once an admin
re-enters their own password to confirm the money actually moved). New
columns on `bookings` (`subtotal_cents`, `promo_code_id`, `discount_cents`,
`tax_cents`, `refunded_cents`, `refund_status`) and `booking_riders`
(`country`, `special_requirements`). All additive/migrated — old bookings
still work, `subtotal_cents` backfilled from `total_cents`.
- **`backend/db.js`** — added a `transaction(fn)` helper (raw
  `BEGIN`/`COMMIT`/`ROLLBACK`) for crash-safety on multi-table writes.

### Backend
- **`backend/routes/bookings.js`** — rewritten. `POST /api/bookings` now:
  validates every rider field server-side (name, age 1–120, country, riding
  experience, bike info, emergency contact name+phone, optional special
  requirements), prices add-ons from the live catalog (`per_rider` scales
  with group size, `per_booking` — e.g. a private guide — doesn't), applies
  and re-validates a promo code from scratch (never trusts a client-echoed
  discount), computes tax as `0` (no rate configured — never fabricated),
  and does the whole multi-row write (booking + riders + addon lines +
  promo redemption + departure seat count) inside one `transaction()`.
  Also added: `GET /api/bookings/:id/invoice` (lazy, sequential numbering),
  and reworked `POST /api/bookings/:id/cancel` to compute a refund
  entitlement from the configured tiers and record a `pending` `refunds`
  row (never marks anything refunded itself).
- **`backend/routes/addons.js`** (new) — `GET /api/addons` (public, active
  only), admin CRUD (`DELETE` blocked once an add-on's been used — use
  `PATCH {active:false}` to retire it instead).
- **`backend/routes/promo.js`** (new) — `POST /api/promo/validate` (public
  preview, doesn't redeem), admin CRUD for promo codes (expiry, usage
  limits, min-riders/tour eligibility all enforced server-side).
- **`backend/routes/admin.js`** — `GET /api/admin/bookings` now includes
  `addon_items`, `booking_reference`.
- Admin refund endpoints (in `bookings.js`): `GET/PATCH
  /api/admin/refunds/:id` (step-up password required to mark `processed`),
  `GET/POST/PATCH/DELETE /api/admin/cancellation-rules`.

### Frontend
- **`frontend/checkout.html`** (new) — 5-step wizard: departure summary +
  availability → rider count (capped by real remaining capacity) → full
  rider-details forms (one per rider, rider 1 pre-filled from the signed-in
  profile but editable) → add-ons (loaded from `GET /api/addons`, never
  hardcoded) + promo code → review (full price breakdown: base, each
  add-on, discount, tax, total, deposit, balance, cancellation terms) →
  confirm. The old one-click "book with a hardcoded single rider" buttons
  on `tour-detail.html` and `trip.html` now redirect here instead.
- **`frontend/invoice.html`** (new) — fetches the invoice endpoint, renders
  a printable sheet ("download" = `window.print()` → Save as PDF, since
  this project ships no PDF library), accessible via session or the
  booking's `?token=` (guest link).
- **`frontend/main.js`** — new checkout IIFE (the bulk of the new logic),
  new invoice IIFE, dashboard booking cards now show the booking reference,
  an Invoice link, and refund status; cancelling from the dashboard now
  surfaces the computed refund amount in the toast.
- **`frontend/cancellation-policy.html`** — updated (was written in Task 2
  saying refunds are "reviewed and processed manually, not calculated
  automatically" — that's no longer true now that automatic tiered refund
  calculation shipped, so the copy was corrected to describe the real
  behaviour: refund *amount* is automatic, but a refund only becomes
  final once an admin confirms the money actually moved).
- **`frontend/style.css`** — new `.checkout-*` classes (kept visually
  identical to the existing `.wizard-*` classes from Build Your Adventure,
  but under different class names so the two pages' step-navigation scripts
  never collide), rider-card/addon-row/review-block styles, invoice sheet
  styles (incl. `@media print`).

### Admin panel (`backend/public/admin.html`)
- New tabs: **Add-ons** (price/unit/active editor), **Promo codes** (full
  CRUD with usage stats), **Refunds** (process/deny queue with password
  step-up, plus the cancellation-rule tiers editor).
- Bookings tab: now shows booking reference and add-on/discount summary
  per row.

### Bug found & fixed during testing
Checkout only checked `spacesLeft <= 0` for "fully booked" — a departure an
admin had manually marked `status: 'full'` (independent of seat count)
wasn't caught client-side, so a rider could walk through the whole wizard
before the backend rejected it at the last step. Fixed to also check
`dep.status === 'full'` (and added a `request_only` message) upfront.

### Explicitly deferred (your instruction)
**Real payment gateway integration.** Confirming checkout still creates a
`pending` booking with the existing 72-hour deposit hold — no card is
actually charged. `POST /api/bookings/:id/pay` (rider self-pay) and `PATCH
/api/bookings/:id/payment` (admin-recorded) are unchanged from before this
session and still treat any well-formed card/amount as approved. This is
the next piece to build when you're ready.

---

## Quick reference: everything new an admin can now manage

| What | Where |
|---|---|
| Tour inclusions/exclusions/equipment/safety/cancellation text | Admin → Tours → edit a tour |
| Guide qualifications (verified/unverified) | Admin → Guides → edit a guide |
| Tour-specific gallery images | Admin → Gallery → category "Tour" + link a tour |
| Destination/season/budget/altitude filters | Nothing to manage — reads existing tour fields |
| Add-on catalog (price, per-rider vs per-booking) | Admin → Add-ons |
| Promo codes | Admin → Promo codes |
| Refund requests (approve/deny) | Admin → Refunds |
| Cancellation refund tiers | Admin → Refunds (bottom section) |
| Custom tour requests / proposals (CRM pipeline) | Admin → CRM → "Proposal" button → `custom-request.html?id=` |

## Quick reference: new frontend pages

| Page | Purpose |
|---|---|
| `checkout.html?departureId=<id>` | The real booking flow |
| `invoice.html?booking=<id>[&token=]` | Printable invoice |
| `safety-policy.html` | Site-wide safety policy |
| `cancellation-policy.html` | Site-wide cancellation policy |
| `custom-request.html?id=<requestId>` | Admin's dedicated proposal builder for one custom request |
| `tour-detail.html?request=<requestId>` | A rider's own custom-trip detail page (real tour content + their proposal's actual terms) |

---

## Task 4 — Custom Tour Proposal & Approval Workflow

**Ask (Round 1):** a full pipeline for riders requesting a bespoke trip:
`Request → Contacted → Proposal Sent → Customer Review → Approved → Deposit →
Confirmed → Completed`. Admin builds a proposed itinerary (destination, dates,
duration, riding details, accommodation, transport, pricing, inclusions/
exclusions, expiry, notes), saves a draft or sends it. Customer views it,
approves/declines/requests changes, pays a deposit. Every status change
auditable; existing CRM preserved.

This task went through five rounds of real usage-driven feedback (quoted
verbatim below each time) rather than being built once — each round fixed a
concrete "this doesn't actually work / doesn't make sense" problem the
previous round left behind. Read in order; later rounds fix earlier ones.

### Database (`backend/schema.sql`, `backend/db.js`)
- **`custom_requests`** — new columns added across rounds: `tour_id` (FK to
  `tours` — the request is always based on a real catalogue tour, never free
  text), `preferred_date` (the customer's own free date choice, independent
  of the tour's fixed departures), `active_proposal_id` (which proposal
  version is "current"), `amount_paid_cents` (renamed from
  `deposit_paid_cents` — see the migration note below), `booking_id` (set the
  moment a deposit is paid — see "booking auto-creation" below). `status`
  CHECK constraint extended to include `'approved'`.
- **`custom_proposals`** (new table) — one row per *version* — editing a sent
  proposal never mutates it in place; it creates a new version and supersedes
  the old one, so the audit trail always shows exactly what was offered and
  when. Columns: `tour_id` (dropdown-selected, real catalogue tour — see
  Round 3), `version`, `destination`/`start_date`/`duration_days`/
  `riding_details`/`accommodation`/`transport`/`price_cents`/`currency`/
  `deposit_percent`/`inclusions_json`/`exclusions_json`/`expires_at`/`notes`,
  `status` (`draft`/`sent`/`approved`/`declined`/`changes_requested`/
  `expired`/`withdrawn`/`superseded`).
- **`custom_request_events`** (new table) — full audit trail: every status
  change and proposal lifecycle event, who did it, when, and why.
- **`custom_request_payments`** (new table) — one row per payment made
  against a proposal (deposit or balance instalments).
- **`notifications`** (new table) — backs the site-wide notification bell
  (admin: new requests/approvals/declines/payments; rider: proposal
  sent/withdrawn, payment recorded).
- **`departures`** — new columns `is_custom` and `custom_request_id` (see
  "booking auto-creation" below).
- **Migration notes:**
  - The `custom_requests.status` CHECK constraint needed a full table rebuild
    (SQLite can't `ALTER` a CHECK constraint) — done via the
    create-under-a-new-name → copy data → drop old → rename-new-to-original
    pattern, with `PRAGMA foreign_keys = OFF` around it to dodge SQLite's
    FK-rewrite-on-RENAME behaviour.
  - `deposit_paid_cents` → `amount_paid_cents` rename was **verified safe
    against a real copy of the production `highroute.db`** before being
    applied to the real schema — confirmed a real paid-deposit row (request
    #2, a 20% deposit on a €1,300 proposal) migrated correctly.
  - Every migration is guarded by `PRAGMA table_info()` checks, so re-running
    `db.js` on an already-migrated database is a safe no-op.

### Backend — core files
- **`backend/routes/proposals.js`** (the heart of this feature):
  - Admin: `POST .../proposals` (new draft version, supersedes any prior
    sent/approved/changes-requested one), `PATCH /api/admin/proposals/:id`
    (edit a still-draft version only — a sent proposal is frozen), `POST
    .../send` (requires a `start_date` — it becomes the real departure date
    the moment a deposit lands), `POST .../withdraw`.
  - Customer (all `requireAuth('rider')`, ownership-checked): `POST
    /api/proposals/:id/approve|decline|request-changes`, `POST
    /api/proposals/:id/pay` (deposit, then — once the deposit's met — the
    remaining balance, capped by the full price).
  - **`lockedMessage(reqRow)`** — once a request has a `booking_id`, its
    proposal is frozen: create/edit/send/withdraw all reject with a message
    pointing the admin at the Departures/Bookings tabs instead. This closed a
    real bug (Round 4) where an admin could withdraw a proposal *after* the
    customer had already paid a deposit against it, orphaning the payment
    with no live offer behind it.
  - **`createBookingForConfirmedProposal(reqRow, proposal, amountPaidCents)`**
    — "booking auto-creation": the instant a deposit payment meets the
    deposit threshold, this creates a *real* `departures` row (flagged
    `is_custom=1`, privately linked via `custom_request_id`) and a *real*
    `bookings` row, reusing 100% of the existing booking infrastructure
    (`trip.html`, `invoice.html`, dashboard booking cards, admin
    Bookings/Departures tabs) instead of building a parallel custom-trip UI.
    From that point on, the booking's own `amount_paid_cents`/`status` is the
    single source of truth for payment — both the rider-facing and
    admin-facing pay endpoints refuse further payment through the proposal
    once `booking_id` is set (Round 4 fix — see bugs below) and redirect to
    the booking's own pay path instead.
  - `expireOverdueProposals()` — flips any `sent`/`approved` proposal past
    its `expires_at` to `expired`, called at the top of every
    proposal-touching endpoint and on a timer.
- **`backend/routes/customRequests.js`**:
  - `POST /api/custom-requests` (public wizard submission) validates
    `tourId` against the real catalogue and stores `preferredDate`
    separately from the tour's own fixed dates.
  - `GET /api/admin/custom-requests` (CRM list) / `GET
    /api/admin/custom-requests/:id` (single item, backs `custom-request.html`)
    / `GET /api/riders/me/requests` (a rider's own list) / **`GET
    /api/riders/me/requests/:id`** (new in the final round — a rider's own
    single request, owner-checked, backs `tour-detail.html?request=`).
  - `attachTourInfo()` / `attachBookingRef()` — every one of the above
    enriches its rows with the linked catalogue tour and (once one exists)
    the human-readable booking reference, so admin and rider views never
    show inconsistent data.
- **`backend/routes/departures.js`** — `GET /api/departures` (used by both
  `calendar.html` and the admin panel) hides `is_custom=1` rows from
  everyone **except** an admin and the one rider it actually belongs to
  (matched via `custom_request_id IN (SELECT id FROM custom_requests WHERE
  rider_id = ?)`) — a private trip never leaks into the public calendar or
  another customer's view, but the owning rider still sees their own
  confirmed date on their own calendar.
- **`backend/routes/tours.js`** — every public tour-listing query
  (`upcomingDepartures`, `hasDepartures`, `GET /api/tours/:slug`'s
  departures, the guides-who-led-departures query) filters out
  `is_custom=1` rows, so a private custom departure never appears on a
  public tour's page either.
- **`backend/routes/bookings.js`** — invoice line items use the booking's
  own `subtotal_cents` instead of recomputing `tour.price_from_cents ×
  riders.length` — critical for a custom booking, whose negotiated price
  almost always differs from the tour's public list price (bug found during
  Task 3-era testing, but only actually matters once custom bookings exist).

### Frontend — admin side
- **`backend/public/custom-request.html`** (new page, Round 3) — the
  dedicated proposal-builder the old in-page admin.html modal was replaced
  with. Request summary, a **required tour dropdown** (populated from the
  real catalogue — never free text) with a live "base tour reference" panel
  fetched from `GET /api/tours/:slug` on change, the proposal form (start
  date required, flagged with a red asterisk since it becomes the real
  departure date), version history, and the full audit trail. Once the
  request has a `booking_id`, the form is replaced with a locked banner
  naming the booking reference instead of letting the admin edit a frozen
  proposal.
- **`backend/public/admin.html`** — the old in-page proposal modal was
  deleted entirely; the CRM table's "Proposal" button now navigates to
  `custom-request.html?id=`. The CRM table itself gained a based-on-tour
  link, the preferred date, and a "✓ Booked HR-…" hint. The Departures tab
  switched to an authenticated fetch so admins can see (and manage) private
  `is_custom` departures, tagged with a "Custom trip" badge.

### Frontend — rider side
- **`frontend/build-adventure.html`** (Round 2) — Step 1 rewritten: a
  **tour `<select>` dropdown** (populated from `GET /api/tours`, matching
  what's actually on the tours page) with a live preview card, plus a
  separate `<input type="date">` for the rider's own preferred date —
  independent of whatever dates that tour already has scheduled.
- **`frontend/main.js`** — dashboard "Your custom requests" list
  (`loadRequests`/`renderProposalBox`/`requestCardHeader`):
  - Approve/decline/request-changes/pay-deposit-or-balance actions, with a
    dual deposit/balance payment modal (`ensureProposalPayModal`) — Round 2
    fixed a bug where the balance payment was capped at the deposit amount,
    making it impossible to ever pay off the remaining balance once the
    deposit was met.
  - **`requestCardHeader()`** (Round 4 fix) — the card used to always show
    the customer's *original wizard answers* (e.g. "Not sure yet" / "15+
    days") forever, even after a proposal was accepted with concrete terms.
    Now it prefers the active proposal's real destination/duration/date the
    moment one exists, and once `booking_id` is set, labels the date
    "Confirmed date" instead of "Proposed date".
  - Once `booking_id` is set, the card shows a "Trip confirmed — HR-…" box
    pointing the rider at "Your bookings" above for guide/payment/invoice —
    never a second, stale copy of that same information.
  - **"View trip & guide" / "Invoice" buttons** (final round) — added to
    every custom-request card once a proposal exists, mirroring exactly what
    a real booking card already offers. "View trip & guide" links to
    `tour-detail.html?request=<id>`; "Invoice" (once booked) links to
    `invoice.html?booking=<id>`.
- **`frontend/tour-detail.html` + `main.js`** (final round) — **the
  dedicated custom-trip detail page.** Rather than building a second,
  divergent copy of the tour page (a real risk of the exact "plot hole"
  problem this whole task kept running into), `tour-detail.html` itself now
  accepts `?request=<id>` as an alternative to `?slug=`:
  - Gated on sign-in (a `#detail-signin-gate`, same pattern as `trip.html`'s
    booking gate) — a stranger can't view someone else's proposal.
  - Fetches the rider's own request (`GET /api/riders/me/requests/:id`) and
    its active proposal, then the real base tour it was built from — so
    gallery, day-by-day route/elevation profile, guide roster, equipment,
    safety and cancellation sections are all genuine, live tour content.
  - **Overrides** duration, price, dates, deposit and inclusions/exclusions
    with the proposal's actual agreed terms — never the tour's default
    listing (verified live: a proposal priced at €1,800/9 days rendered as
    €1,800/9 days, not the base tour's own €2,000/10-day listing).
  - Once a deposit's paid, shows the *real* assigned guide from the created
    booking/departure instead of "guides who've led this tour before"; falls
    back to the generic roster until a guide is actually assigned.
  - The sticky sidebar becomes a proposal-status card (price, status,
    date, duration, deposit, amount paid, invoice/dashboard links) instead
    of the normal "pick a date and book" widget, since a custom trip isn't
    something you book from a date picker — the terms are already fixed.
- **`frontend/calendar.html`** (two fixes, final round):
  1. The month-filtering API call already correctly showed a signed-in
     rider's own confirmed custom trip and hid it from everyone else — but
     that trip is often months out, and reaching it required manually
     clicking "next" however many times. Calendar now **auto-jumps a
     signed-in rider straight to their nearest upcoming custom trip's month**
     on first load (verified: lands directly on December 2026 with the event
     visible, zero clicks) — anonymous visitors and every later prev/next
     click still behave exactly as before.

### Bugs found & fixed during this task's testing
1. **Balance-payment-after-deposit** (Round 2) — `/api/proposals/:id/pay`
   capped the payable amount at `depositCents − alreadyPaid`, so once the
   deposit was met there was no way to ever pay the rest. Fixed to
   `price_cents − alreadyPaid`.
2. **Invoice showed the wrong price** — `GET /api/bookings/:id/invoice`
   recomputed "base fare" from `tour.price_from_cents × riders.length`
   instead of the booking's own `subtotal_cents`, which is wrong the moment
   a booking's negotiated price differs from the tour's list price (always
   true for a custom trip). Fixed to use `subtotal_cents` directly.
3. **Withdraw-after-payment** (Round 4) — an admin could withdraw a
   proposal that already had a paid deposit/real booking against it,
   orphaning the payment with no live offer left. Fixed by adding the same
   `lockedMessage(reqRow)` guard the create/edit/send endpoints already had.
4. **Dual-payment-path staleness** (Round 4) — once a booking existed, paying
   the remaining balance through the booking's own `/api/bookings/:id/pay`
   never updated `custom_requests.amount_paid_cents` (tracked independently).
   Fixed by blocking further payment through the proposal-pay endpoints once
   `booking_id` is set, making the booking's own figures the sole source of
   truth from that point on.
5. **Stale dashboard card** (Round 4) — the card always showed the
   customer's original wizard answers, never the accepted proposal's actual
   terms (see `requestCardHeader()` above).
6. **Calendar invisibility, part 1** (Round 4) — a rider's own confirmed
   custom trip was filtered out of `GET /api/departures` for *everyone*
   except admins, including its own owner. Fixed to also allow the owning
   rider.
7. **Calendar invisibility, part 2 / discoverability** (final round) — the
   API-level fix above was already correct and verified, but the trip was
   still effectively invisible in practice, buried several months of
   clicking away from "today". Fixed with the auto-jump described above.
8. **TDZ `ReferenceError` in `main.js`** — `let notifBellPollStarted` was
   referenced before its declaration ran (a page-load-time call chain hit it
   first). Only caught by a real headless-browser run, not `node -c`. Fixed
   by changing to `var`.
9. **A long-running dev server masked every fix** — discovered at the very
   end of this task: a `node` process had been listening on port 4000
   (the real backend/DB) continuously throughout this whole task, started
   before any of these changes were made. Since Node doesn't hot-reload
   route files, **none of the backend fixes across any round were actually
   live** in a browser pointed at `localhost:4000` until that process is
   restarted. This was never touched or restarted automatically — flagged
   for you to restart it yourself once ready.

### Explicitly deferred / not yet acted on
- Two pre-existing custom-request rows in the real production DB (`id: 2`
  and `id: 3`) are left in an inconsistent state from *before* some of these
  fixes existed (e.g. a proposal version that was paid against, then
  superseded, orphaning that payment under the old logic). Offered to help
  clean these up; not yet requested.

---
*Generated at the end of this session — see `HANDOFF.md` for the fuller
project history/conventions from earlier sessions.*
