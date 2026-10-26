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

## Task 5 — Performance Pass & Real Photography

**Ask (verbatim):** "remove those effects that makes my webpage laggy its too
laggy and not smooth too / also have a full hd background images / replace
the image with the suitable images of trails cycling mountans and others"

### Performance
Removed every continuous/fixed-position effect judged to be the actual jank
source, keeping only cheap one-time ones:
- **Removed:** `backdrop-filter` blur on the always-visible header, the auth
  modal, the lightbox overlay, and tour-card tag chips (blur on a fixed/
  frequently-repainted element is expensive); the fixed full-viewport grain
  texture (`feTurbulence` SVG filter + `mix-blend-mode`, recomposited every
  scroll frame); the mousemove-tracked hero pointer glow (recalculated a
  gradient on every pointer move); the infinite `box-shadow` "pip-pulse"
  animation on availability dots (`box-shadow` isn't GPU-accelerated); the
  scroll-reveal system (many simultaneous `IntersectionObserver`-triggered
  transitions on grid-heavy pages).
- **Kept:** the one-time page-load fade and the custom scrollbar — both cheap,
  neither runs continuously.
- Files: `frontend/main.js`, `frontend/style.css`.

### Images
Root cause: every tour/guide/gallery/destination image was a random
`picsum.photos/seed/<name>/...` placeholder with **zero thematic control**
— explains mismatches like a water-droplet macro for "Pokhara Lakeside Flow"
or star trails for "Kathmandu Valley Explorer". Sourced ~20 real, verified
(HTTP-200-checked via `curl`, visually confirmed via PIL contact sheets),
correctly-themed Unsplash photos and wired them in at three levels so both
fresh and already-seeded databases end up correct:
1. **`backend/seed.js`** — every `image_url`/`hero_image_url`/`photo_url`
   replaced (6 tour covers, 2 guide portraits, 6 destination heroes, 7
   gallery photos).
2. **Static HTML fallbacks** — `frontend/index.html`, `tours.html`,
   `tour-detail.html`, `trip.html` (shown before the API responds, or if it
   never does).
3. **`backend/db.js`** migration (the piece that actually fixes the **live**
   database, since `seed()` only ever runs once) — idempotent
   `UPDATE ... WHERE <key> = ? AND <col> = ?` swaps that only touch rows
   still holding the *exact* original placeholder, so any image an admin has
   since replaced through the admin panel is never overwritten. Verified
   safe/idempotent against a disposable copy of the real `highroute.db`
   (booted twice, confirmed no duplicate/corrupted updates) before being
   applied live.
- The homepage's own `frontend/assets/img/hero-trail.jpg` was left as-is —
  already a real, correctly-themed trail photo, not a placeholder.

---

## Task 6 — Mandatory Sign-In for Custom-Ride Requests

**Ask:** "why i am able to book custom ride even without signing up or
signing in / look after that" — investigated, found `POST
/api/custom-requests` was *intentionally* public (a lead-capture "get a
quote" form; nothing money-related ever was — approving/paying a proposal
already required sign-in). Given the choice, you asked to lock the request
form itself behind sign-in too.

- **`backend/routes/customRequests.js`** — `POST /api/custom-requests` now
  wrapped in `requireAuth('rider', …)`; `rider_id` comes from the session,
  never an optional client value.
- **`frontend/main.js`** — the Build Your Adventure wizard's submit button no
  longer calls the API directly; it's gated behind `Auth.requireSignIn(
  doSubmit)`, matching the pattern already used elsewhere (e.g. "book this
  tour"). Opens the sign-in modal on click if needed and **resumes
  automatically** with the already-filled-out wizard state the moment
  sign-in succeeds — nothing the visitor typed is lost.
- Verified via `curl` against a disposable backend copy: anonymous POST →
  `401`; POST with a real rider bearer token → `201`.

---

## Task 7 — Per-Tour Photo Galleries

**Ask:** "have a visually appealing gallery section in each tour detail page
as well as custom tour detail page etc / and make a section for admin to add
images for tour detail pages."

Investigation found the infrastructure for this **already existed** end to
end — `gallery_images` table with a `category='tour'` + `tour_id` shape, a
full `GET/POST/PATCH/DELETE /api/admin/gallery` API, a `renderTourGallery()`
call already wired into both `tour-detail.html` and the custom-trip mode of
`trip.html` (they share the same render path via `renderSharedTourSections`),
and a full add/edit/delete UI in the admin Gallery tab. The actual bug: **zero
rows** in the database had ever been seeded with `category='tour'`, so every
tour's gallery section silently rendered "No photos have been added for this
tour yet." forever.

- Sourced 16 new verified, thematically-matched photos per tour region
  (desert/canyon for Mustang, alpine/snow-peak for Annapurna, terraced
  hillside/village for Kathmandu, pine forest for Langtang, remote high-alpine
  for Manaslu, lake/gentle-hills for Pokhara) — screened out two candidates
  that didn't actually fit (a cactus-desert shot, geographically wrong for
  Nepal; an unmistakably-iconic Moraine Lake/Banff shot, too specific a
  foreign landmark for a demo site).
- **`backend/seed.js`** — added ~29 `gal(..., 'tour', <tourId>, …)` calls (5
  photos per tour, 4 for Pokhara) for fresh databases.
- **`backend/db.js`** — matching idempotent migration for the already-seeded
  live database: per tour slug, only inserts its 4–5 photos if that tour
  **currently has zero** `category='tour'` rows — so an admin who's since
  added their own tour photos via the admin panel is never touched. Verified
  against a disposable copy of the real DB (29 rows inserted, matching
  exactly; re-booted a second time to confirm idempotency — still 29, no
  duplicates).
- **`backend/public/admin.html`** — added a **"Photos" quick-link** button on
  every row of the Tours tab table. Jumps straight to the Gallery tab,
  pre-filters its table to that tour's photos, and pre-fills the "Add an
  image" form's category (`tour`) and linked-tour dropdown — so managing one
  tour's photos no longer means hunting through the full unsorted photo list.
- **End-to-end verified** via a headless-Edge screenshot of the live-rendered
  `tour-detail.html?slug=upper-mustang` page: the Gallery section shows 5
  correctly-themed desert/canyon photos in the existing masonry grid layout.

---

## Task 8 — Production Deployment (GitHub, Vercel, Railway)

**Ask:** push the project to a GitHub repo named "High-route", and get a
Vercel link for the frontend only, to show the design to your senior. Later
extended (Task 9) to include a real, working login credential and a live
backend once a demo credential needed to actually function on the public link.

### Tooling set up locally
Installed GitHub CLI (`winget`), Vercel CLI and Railway CLI (`npm i -g`).
Authenticated each via their own browser-based device/OAuth flow (you
completed the browser step each time; GitHub CLI ended up signed in as
`Rahul-Jung`, Railway/Vercel as `kunwarrahul9861@gmail.com`). Had to fix a
stale Windows Credential Manager entry for a *different* GitHub account that
was shadowing `gh`'s own git credential helper for `github.com` — `gh auth
setup-git` resolved it.

### GitHub
- `Rahul-Jung/High-route` (was already created, empty). Added a
  root-level `.gitignore` (excludes `backend/data/*.db*`, `backend/data/
  backups/`, `backend/data/server.log`, `.env`, `node_modules/` — the real
  database and its backups are never committed). Initial commit + push;
  later commits pushed as this task's features landed.

### Vercel (frontend, static)
- **https://high-route-mtb.vercel.app** — deployed via `vercel --prod` from
  `frontend/`. **Not** connected to GitHub for auto-deploy; a frontend
  change needs a manual `vercel --prod` redeploy.
- `frontend/config.js` (new, committed) sets `window.HIGHROUTE_API_BASE` to
  the live Railway backend URL — every HTML page now loads it just before
  `main.js`. Local development is unaffected: without this file (or if it's
  removed), `main.js` falls back to `http://localhost:4000`.

### Railway (backend)
- **https://high-route-backend-production.up.railway.app** — a persistent
  Node service (Vercel's serverless functions don't fit a stateful SQLite
  file well, hence a separate host for the backend).
- A volume (`high-route-backend-volume`) mounted at `/app/data` so the
  SQLite database survives redeploys/restarts.
- **Connected to GitHub** (`railway service source connect --repo
  Rahul-Jung/High-route --branch main`) — every push to `main` now
  auto-deploys the backend within about a minute. The service's **root
  directory** had to be set to `/backend` explicitly (the repo also has a
  `frontend/` folder at the root, and Railway's CLI doesn't expose a root-
  directory flag) — done via a direct `railway api` GraphQL
  `serviceInstanceUpdate` mutation, since the dashboard-only setting isn't
  reachable any other way from the CLI. The first GitHub-triggered deploy
  failed before this was set (built from the repo root, no `package.json`
  there); Railway kept the previous good deployment online throughout, so
  there was no live downtime.
- `backend/.nvmrc` (new, `22`) — pins the Node version Railway's Railpack
  builder picks, since `node:sqlite` needs ≥22.5 and Railpack would
  otherwise default to an older LTS.
- **Env vars** (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `RESEND_API_KEY` — see Task
  9) were set by you directly in the Railway dashboard, not by me: setting
  or reading them via the CLI is blocked for me as a secret-store action.

---

## Task 9 — Mandatory Signup Email Verification

**Ask:** "i want you to make a login credincial and signup verification is a
must." Clarified: verification emails should be sent for real (via a
provider, not faked), and the "login credential" meant a real account you
could hand to your senior on the live link — which is what made deploying a
reachable backend (Task 8) necessary in the first place.

### Database (`backend/schema.sql`, `backend/db.js`)
- **`riders`** — new nullable `email_verified_at` column; login is refused
  while it's `NULL`.
- **`email_verifications`** (new table) — one outstanding code per rider
  (`code_hash` — SHA-256 of the code, same pattern as `sessions.token_hash`;
  raw codes are never stored), `attempts`, `expires_at`. A new code always
  invalidates any prior unused one for that rider.
- **Migration** — `email_verified_at` backfilled to each existing rider's own
  `created_at` for any database that predates this feature, so accounts that
  signed up under the old no-verification flow are never locked out by a
  rule that didn't exist when they registered. Verified against a disposable
  copy of the real production DB: both real pre-existing riders (`Usha`,
  `Rahul Kunwar`) came out auto-verified; re-booted a second time to confirm
  idempotency.

### Backend
- **`backend/lib/email.js`** (new) — sends via Resend's HTTP API using
  Node's built-in `fetch` (no npm dependency, matching this backend's
  zero-dependency rule). Falls back to **logging the code to the console**
  instead of failing signup when `RESEND_API_KEY` isn't set (dev/local
  default) or if the Resend call itself errors — same "demo credential
  printed to console" pattern already used for the admin bootstrap password.
- **`backend/routes/auth.js`**:
  - `POST /api/auth/register` no longer returns a session — creates the
    rider, issues a 6-digit code (15-minute expiry), emails it, and returns
    `{ pending_verification: true, … }`.
  - `POST /api/auth/verify-email` (new) — rate-limited, code-hash compared,
    capped at 5 wrong attempts before requiring a fresh code; on success,
    marks the rider verified and returns a real session (auto-signs-in).
  - `POST /api/auth/resend-verification` (new) — rate-limited (3 per 15
    min), invalidates the previous code.
  - `POST /api/auth/login` now checks `email_verified_at` — an unverified
    account gets `403 { needs_verification: true, email }` instead of a
    session, even with the correct password.

### Frontend
- **`frontend/main.js`** — `apiGet`/`apiPost`/`apiPatch` now attach the full
  error response body as `err.data` (previously only `err.message`), so
  callers can branch on fields like `needs_verification`. The sign-in/sign-up
  modal (`Auth`) gained a third step — a "Check your email" code-entry form
  with a Resend-code button — that appears automatically either right after
  signup, or when a correct-password sign-in attempt reports the account
  still needs verifying. `Auth.requireSignIn`'s existing "resume the pending
  action after sign-in" behaviour (e.g. the Build Your Adventure wizard from
  Task 6) works unchanged through this new step.
- **Verified fully end-to-end**, both via `curl` (register → wrong code
  rejected → correct code accepts → login now works; resend invalidates the
  old code) and via a real headless-Edge browser run that drove the actual
  modal DOM (signup → "Check your email" step renders with the right email
  → submitting a correct-password login on that still-unverified account
  auto-redirects into the same step → entering the code signs in, header
  updates to show the account name).

### Known loose end
A throwaway `deploytest@example.com` account was registered directly against
the **live** Railway backend to confirm the deploy picked up this feature —
it's harmless (unverified, can never receive a real code since Resend's
sandbox mode can only email the account owner's own address) but is sitting
in the live database. Not cleaned up; flagged here in case you want it gone.

You still need to sign up for real (`kunwarrahul9861@gmail.com`, on
https://high-route-mtb.vercel.app) to get yourself a working handoff
credential — Resend's sandbox restriction means I can't create one for you
server-side and hand you a working password without you receiving the code.

---

## Quick reference: live deployment

| What | URL / detail |
|---|---|
| Live site (frontend) | https://high-route-mtb.vercel.app |
| Backend API | https://high-route-backend-production.up.railway.app |
| Admin dashboard | `<backend URL>/admin.html` — **not** on the Vercel domain, it lives on the backend |
| GitHub repo | https://github.com/Rahul-Jung/High-route |
| Backend deploys | automatic on every push to `main` (Railway ← GitHub) |
| Frontend deploys | manual — `vercel --prod` from `frontend/` |
| Admin login | `ADMIN_EMAIL` / `ADMIN_PASSWORD` as set in Railway's Variables tab |

---

## Task 10 — Full QA Pass, Then Every Finding Fixed

**Ask:** "run the website, do everything, use test cases in every scenario and
admin too, do every test and find loose ends" — then, after the report:
"fix all of these issues, don't miss any, no drawback, the user shouldn't feel
lost, and update SESSION_SUMMARY."

### How it was tested

A disposable copy of the whole stack, never the real database: `backend/`
copied to the scratchpad with a fresh `data/` dir on `PORT=4098`, a
`frontend/` copy served by `python -m http.server 8098` with a `config.js`
pointing at it. ~200 `curl` assertions plus real headless-Edge runs of every
public page, all 14 admin tabs (driven through `admin.html#<tab>`), the rider
dashboard, trip, invoice, checkout and custom-trip pages. Tokens were injected
into pages via tiny same-origin seed pages that `localStorage.setItem(...)`
then `location.replace(...)` — see §16 in `HANDOFF.md` for the general recipe.
The real `backend/data/highroute.db` was never touched (mtimes checked after).

### What was already solid (verified, not assumed)

Pricing is exact and forgery-proof — 3 riders + per-rider and per-booking
add-ons + a 20% promo computed to the cent while the request body carried
forged `subtotalCents`/`discountCents`/`totalCents`/`taxCents`. All booking
guards held (double-book, date-overlap, past/cancelled departure,
over-capacity, age bounds). IDOR closed on bookings, invoices, pay, cancel and
custom requests. **Output escaping is airtight** — `<img onerror>` /
`<script>` / `<svg onload>` stored in profile names, emergency messages, CRM
names and GPS labels rendered as inert escaped text on every surface
(dashboard, invoice, tracker, admin CRM/alerts/users, proposal builder).
Sessions revoke on logout; the login limiter engages at 8 attempts on rider,
admin *and* guide. The whole custom-proposal pipeline and all its Round-4
locks hold. Custom-departure privacy is exactly right (anonymous 0, other
rider 0, owning rider 1, admin 1) and the calendar still auto-jumps the owner
to their trip's month. The 72-hour payment-hold sweep cancels, releases seats
and refuses later payment. District auto-pinning, fuzzy typo matching and
orphan pruning all work without touching hand-seeded destinations.

---

### 10.1 CRITICAL — authentication bypass in `POST /api/auth/verify-email`

`backend/routes/auth.js` had an "already verified" short-circuit that issued a
full rider session **without checking the code at all** (it existed so
verifying twice wouldn't error). Knowing an email address was therefore enough
to sign in as that rider: codes `000000`, `123456`, `abc`, `1` each returned a
working token, and `GET /api/riders/me` with it returned the victim's profile.
One request was enough, so the rate limiter was no help. This was live on
Railway.

- Now returns `409 { already_verified: true, email }` and never a session.
- `POST /api/auth/resend-verification` returns the same shape for consistency.
- **So nobody dead-ends:** `showSignInStep()` in `frontend/main.js` moves the
  modal to the password form with the email pre-filled and the line "Your
  email is already verified — just sign in with your password." Both the
  verify-code submit and the Resend button handle it.
- Verified in a browser: junk code → verify form hidden, sign-in form shown,
  email pre-filled, message shown, **no session issued**.

### 10.2 A fully-paid booking could never be cancelled — by anyone

`bookings.status === 'completed'` means *paid in full*, not *the trip
happened*, but the cancel endpoint refused `completed` outright — and there is
no admin booking-status endpoint, so admins couldn't override it either. Every
rider who paid in full was locked out of cancelling and out of the 90% refund
tier `cancellation-policy.html` advertises. The highest-value refund case was
the one case the system could not process.

- The `completed` guard is gone (with a comment explaining why it must stay
  gone). Whether the trip actually ran is decided from the departure's dates,
  which was always the correct signal.
- `can_cancel` on `GET /api/riders/me/bookings` no longer excludes `completed`.
- **New `refund_preview_percent` / `refund_preview_cents`** on that endpoint,
  from the same `computeRefundEntitlement()` the real cancel uses — so the
  dashboard's confirm dialog now states "You've paid €1,850. Cancelling now
  puts you in the 90% refund tier, so you'd be refunded €1,665" *before* they
  commit, instead of revealing it in a toast afterwards.
- Verified end to end: pay in full → `can_cancel: true`, preview 90% / €1,665
  → cancel → seats released → `refunds` row `pending` → admin step-up marks it
  processed.

### 10.3 `POST /api/gps/ping` was unauthenticated

Anyone could write positions for any departure into the feed `tracker.html`
presents as live rider locations — forging a location or burying the real
trail took one anonymous POST.

- Now `requireRoles(['guide','admin'])`, plus lat/lng range and type checks.
- `backend/simulate-gps.js` signs in first (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, or
  `--email=`/`--password=` for a guide) and prints a clear instruction instead
  of silently failing. Verified: no creds → one readable message; with creds →
  "Signed in via /api/admin/login", 181 pings landed.
- **`POST /api/emergency` is deliberately still open.** An SOS has to work when
  the person pressing it can't sign in (wrong phone, dead session, a
  bystander) — putting a login in front of a panic button is a worse failure
  than a false alarm. Instead it is throttled per IP (20 / 5 min, loose enough
  that repeat presses and several riders reporting one incident all get
  through) and records whether the reporter was signed in. Verified: anonymous
  SOS still succeeds; the 20th+ in five minutes gets a 429 that tells the
  caller to phone the guide directly.

### 10.4 A public 500, and four admin ones

Unvalidated values reached bound SQLite parameters and `Date` arithmetic, so
they surfaced as bare `500 Internal server error`:

| Request | Was | Now |
|---|---|---|
| `GET /api/departures?limit=abc` (**public**) | 500 `datatype mismatch` | 400 "limit must be a number" |
| `POST /api/admin/departures` bad `startDate` | 500 `RangeError` from `computeEndDate` | 400 "startDate must be a real date in YYYY-MM-DD form" |
| `POST /api/admin/departures` unknown `guideId` | 500 FK violation | 404 "Guide not found" |
| `POST /api/admin/tours` `difficultyLevel: 99` | 500 CHECK violation | 400 "difficultyLevel must be 5 or less" |
| `POST /api/admin/guides` with no `languages` | 500 NOT NULL violation | 400 "languages is required" |

New shared validators in **`backend/lib/util.js`** — `isEmail`, `isIsoDate`
(rejects `2026-02-31`, not just malformed text), `isSlug`, `numericField`,
`validateNumbers`, `validateCard` — with the standing rule written down: a
number, date or slug from a query string or body is validated *before* it is
bound, never after. Applied across `departures.js`, `admin.js`, `guides.js`,
`customRequests.js` and `reviews.js` (`?limit=abc` no longer silently
defaults to 12).

### 10.5 Validation gaps that produced bad data rather than errors

- **Negative tour price accepted** → the tour was publicly listed and
  bookable for **€0** (`subtotal=-5000, total=0`). Now `priceFromCents` must
  be at least 1.
- **`durationDays: 0`** accepted → a departure whose end date preceded its
  start. Now 1–60.
- **A slug like `bad slug/../x`** accepted → rendered a card whose link
  truncated at the space (`?slug=bad`), a dead page. Now must match
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`, with an error that explains it becomes part of
  the public web address.
- **Departure `capacity: -5`** accepted (`0` was rejected, so the check was
  falsy-based). Now 1–200, and an edit can't drop capacity below seats already
  sold.
- Same checks now run on **PATCH as well as POST** for tours and guides, so a
  record can't be created valid and then edited into a state create would have
  refused. Guide `rating`/`yearsExperience`/`tripsLed` are range-checked and
  guide emails format- and uniqueness-checked.
- **Signup accepted a malformed email** (`notanemail` → 201) and then couldn't
  deliver the code — a typo locked the account out permanently, since login
  requires verification and "resend" posted to the same dead address. Now
  rejected up front with "That email address doesn't look right".
- **An expired card was accepted** — the expiry was shape-checked but never
  compared to today, so `01/20` was treated as an approved charge.
  `validateCard` now rejects it, on both `POST /api/bookings/:id/pay` and the
  custom-proposal deposit path (which had its own duplicated copy of the old
  checks).

### 10.6 Guide emails and unverified qualifications were public

`PUBLIC_FIELDS` in `backend/routes/guides.js` included `email`, so the
completely public `GET /api/guides` handed every visitor each guide's work
address — also the identifier half of their login. The same payload carried
**unverified** qualifications, with filtering left to the frontend, which
defeats the point of a `verified` flag.

- `PUBLIC_FIELDS` no longer includes `email`; `toGuide()` strips unverified
  qualifications server-side.
- A new `ADMIN_FIELDS` plus an admin check on the same URL means the admin
  panel still sees everything — so `admin.html`'s three
  `fetch(API + '/api/guides')` calls (`populateSelectors`, `loadGuides`,
  `editGuide`) were switched to the authenticated `api('/api/guides')`.
  Verified in-browser that the guide edit form still populates the email field.
- Verified: anonymous sees no `email` and only `verified: true` entries; admin
  sees both; no guide email appears anywhere in the public pages' HTML.

### 10.7 Custom-request email was client-supplied and spoofable

`POST /api/custom-requests` *required* `b.email` on an endpoint that already
knew exactly who was calling it, so a signed-in rider could file a request
under anyone else's address — and the CRM then showed that address beside the
real account's with no indication which was true. This is the same bug
`POST /api/bookings` had fixed for its lead rider (§4); this endpoint was
missed.

- `name` and `email` now come from the session's rider row. `email` is no
  longer required or read from the body.
- `frontend/main.js` stops sending them, and the wizard's confirmation screen
  now names the **account's** email ("we'll reply at …") rather than whatever
  was typed, which would otherwise have promised a reply to an address nothing
  was recorded against.
- Verified: posting `victim@someone-else.com` stores the account's own email
  and name.

### 10.8 The custom-trip page contradicted itself

`renderCustomProposalSidebar()` read `custom_requests.amount_paid_cents`, which
only ever records what was paid *through the proposal* (the deposit). On a
fully-paid custom trip the same card said **"Trip confirmed — Fully paid"**
directly above **"Paid so far €500 of €2,000"**.

- It now reads the booking's own `amount_paid_cents`/`total_cents` whenever a
  booking exists — the same "booking is the source of truth once it exists"
  rule `routes/proposals.js` already enforces for payments.
- Verified in-browser: now reads "Paid so far €2,000 of €2,000", matching the
  dashboard.
- The dashboard card and the admin proposal builder were **already correct**
  (both early-return on `booking_id`) — only this one page was affected.

### 10.9 No way to cancel a departure after creating it

`HANDOFF.md` open item #1. The investigation found the backend endpoint
already existed and worked — `PATCH /api/departures/:id/availability`,
admin-only, with a validated status list. It simply had no button.

- Admin Departures tab now has **Cancel date** / **Reopen** per row, beside
  Edit and Delete. Delete stays for an empty date you want gone; Cancel is for
  one people may already be booked on, keeping the departure, its bookings and
  its history while removing it from the public calendar and tour pages.
- The confirm dialog warns when riders are booked and points at the Bookings
  tab for the actual refunds, so cancelling a date is never mistaken for
  cancelling those bookings.
- Two correctness fixes to that endpoint while there: it now **404s** for an
  id that doesn't exist (it previously answered `{updated:true}` after
  updating zero rows), and the three capacity-driven statuses are **derived
  from seats sold** rather than taken on trust — reopening a sold-out date
  lands on `full`, not a briefly-published lie. `capacityStatus()` is now
  exported from `bookings.js` so both places share one definition.

### 10.10 Seeded departure dates had rotted into the past

`seed.js` used fixed calendar dates, all comfortably in the future the day
they were written. By now five of six had passed, so a **fresh install showed
"No upcoming dates" on nearly every tour**, an almost-empty homepage
departures table and nothing bookable — which reads as a broken site, not
aged-out demo data.

- `dep()` now takes a `daysFromNow` offset and derives the end date from the
  tour's own `duration_days`, the same way `computeEndDate()` does. Spread
  across the next ~6 weeks, keeping the original mix of availability states
  (one sold out, one nearly full, one request-only) and keeping each guide
  conflict-free.
- Verified on a fresh seed: all 6 departures upcoming, statuses as intended.
- Only affects brand-new databases; `seed()` still never runs on an existing
  one.

### 10.11 401 vs 403, and step-up confirmations

"Not signed in" and "signed in as the wrong account" both returned `401 Sign
in required`, which tells a signed-in person to do something that cannot help
— and `admin.html`'s `api()` treats 401 as "session died, sign out", so a
permissions mistake could have logged an admin out.

- New `requireRoles()` in `backend/lib/auth.js`: 401 only when there is no
  session, 403 with "You're signed in, but this needs an administrator
  account." when the role is wrong. `requireAuth`/`requireAdmin` are unchanged
  wrappers over it, so no call site needed touching.
- Ownership checks across `bookings.js`, `customRequests.js`, `proposals.js`
  and `notifications.js` now answer 403 with "This booking belongs to a
  different account" when a session exists, and keep 401 for anonymous.
- Step-up password prompts (deleting a rider, marking a refund processed)
  previously returned the same 401 and the same sentence whether the password
  was **missing** or **wrong**. Now 400 "Enter your own admin password to
  confirm…" vs 401 "That admin password is incorrect — this account was not
  deleted."

### 10.12 Smaller items

- **Case-sensitive emails.** Signing up as `Rahul@Example.com` and signing in
  as `rahul@example.com` were two different accounts to the lookup, which read
  as "wrong password" with no way to work out why. Rider, guide and admin
  lookups are now `COLLATE NOCASE`; addresses are still stored exactly as
  typed. Duplicate-signup detection is case-insensitive too.
- **Season filter fails open by design** — a tour with no `best_season`
  matches every season, so it isn't hidden behind a filter. That stays (hiding
  data would be the worse failure), but it's no longer invisible to the admin:
  the Tours tab flags "No best season set" in amber on any such row, and the
  form says so under the field.
- `GET /api/emergency` ran its query twice (once for the count, once for the
  rows) — now once.
- Removed the stray empty directory literally named
  `backend/{lib,routes,public,data}`, a brace-expansion artifact.
- **`README.md` section 7 corrected** — it still claimed every image was a
  `picsum.photos` placeholder (Task 5 replaced them with real Unsplash photos)
  and that "there's no email provider connected" (Resend ships). Section 9
  gained entries for the fixes above, and the rider-dashboard and
  Build-Your-Adventure passages were corrected where this task changed them.

### Re-verification after the fixes

Both servers rebuilt from the edited source and re-run. **Every previously
failing case now passes, and every previously passing case still passes:**

| Suite | Result |
|---|---|
| Critical auth bypass (5 forged codes) | all 409, no token, recovery flag present |
| Seed dates | 6/6 departures upcoming |
| Email + query-param validation | 14/14 |
| Guide privacy + validation | 6/6, public shape confirmed trimmed |
| Departure validation + cancel/reopen | 19/19 |
| Tour validation + auto-pin regression | 21/21 |
| Expired card, fully-paid cancel, refund queue | 9/9 |
| Custom requests + full proposal pipeline | 17/17 |
| Regression sweep (reads, filters, authz, sessions, rate limits, pricing) | 36/36 |
| Browser: XSS escaping on 7 surfaces | 0 executable payloads anywhere |
| Browser: sidebar, dashboard cancel, admin controls, checkout, filters | all correct |
| Server log | **0** `Internal server error`, **0** uncaught exceptions |

### Still deliberately not done

- **No real payment gateway.** Any well-formed, unexpired card is still
  treated as an approved charge (`POST /api/bookings/:id/pay`,
  `POST /api/proposals/:id/pay`). This remains the next substantial piece of
  work; it needs a Stripe account and keys, and the rider endpoint's
  "approve immediately" logic replaced by a webhook.
- **No booking lifecycle emails.** Resend is wired only for signup
  verification; booking-confirmed / deposit-received / hold-expiring /
  30-days-out are still unimplemented.
- **In-memory rate limiting.** Fine on one Railway instance; needs a shared
  store before scaling past one process.
- **Live-database housekeeping** (not touched, still yours to call): the
  throwaway `deploytest@example.com` unverified account, and custom requests
  `id: 2` / `id: 3` left inconsistent from before the Round-4 fixes.
- `README.md` has a few lines of personal scratch notes near the top (the two
  localhost URLs) — left alone deliberately rather than deleting something you
  may have put there on purpose.

---

## Task 11 — Local departures populated, then the route map built

Two pieces of work, in order.

### 11a. Twelve real future departures added to the local database

The previous task fixed `seed.js` to generate departure dates relative to
boot, but that only applies to a **brand-new** database. The existing local
`highroute.db` still held the old hardcoded 2026 dates, so on 2026-10-24
there was exactly **one** publicly bookable upcoming departure (#5 Manaslu,
and it was `request_only`). Upper Mustang #1 was mid-trip; everything else
was in the past or a private `is_custom` booking.

Fixed additively through `POST /api/admin/departures` — no existing row
touched:

| | before | after |
|---|---|---|
| Publicly bookable upcoming dates | 1 | 13 |
| Tours with an upcoming date | 1 of 7 | 7 of 7 |
| Total departure rows | 11 | 23 |

New ids 12–23, spread Nov 2026 → Feb 2027, every tour covered, guides
staggered so the API's own double-booking check passed on all 12 (Tashi was
already committed Oct 18–27 and Nov 3–14). One date is deliberately
`capacity 3 / few_spaces` and one `request_only`, so the UI's non-`open`
states have real data behind them.

Verified after: all 11 original rows byte-identical (dates, statuses,
`seats_booked`, capacities); 17 bookings and 8 custom requests intact;
anonymous `?upcoming=1` returns 13 dates and **zero** `is_custom` rows, so
the four private custom trips still don't leak to the homepage.

### 11b. Route map — admin draws it by clicking, riders hover it

**What already existed** (so this didn't start from nothing): the
`tour_days` table with `overnight_lat`/`overnight_lng`, full admin CRUD for
days, the "Route, day by day" admin form, and a `renderRouteMap()` that drew
pins and a trail as an abstract inline SVG.

**What was missing**, and is what this task built:

- No way to place a pin except typing decimal degrees into two number boxes.
- Pins were labelled "Day 3" — no location name, no distance between them,
  no hover at all.
- **The structural blocker:** `tour_days` allows exactly one position per day
  (where the group sleeps). A pass crossed mid-morning, a trailhead, a
  viewpoint or a hazard can't be stored without inventing a whole fake day
  around it.

#### New table: `tour_waypoints`

```
id, tour_id, seq, day_number, name, kind, lat, lng, elevation_m, notes, created_at
```

`kind` is CHECK-constrained to `start | waypoint | pass | viewpoint |
overnight | hazard | finish`. `seq` is the draw order; `day_number` is
optional and only groups pins under a day. Added via `CREATE TABLE IF NOT
EXISTS` in `schema.sql`, which `db.exec(schema)` runs every boot, so existing
databases pick it up with no ALTER needed.

Deliberately **not** `UNIQUE(tour_id, seq)`: reordering would then need a
two-phase shuffle to dodge the constraint, which is a 500 waiting to happen.
Reads order by `seq, id` so ties are stable rather than fatal.

#### Distance: `haversineKm()` in `backend/lib/geo.js`

Great-circle distance between consecutive pins, attached to every read as
`leg_km_to_next` + `next_name`, so the frontend does no trigonometry and
can't disagree with the admin panel about the numbers.

**This is a straight line, not riding distance.** A real trail switchbacks
and contours, so actual distance is always longer — the per-day riding
distance stays the admin-entered `tour_days.distance_km`. Every surface that
shows the figure says "straight line": the hover tooltip, the note under the
map, the admin summary line, the README and the function's own docstring.
Claiming it as trail distance would have been fabrication.

One real bug caught while testing this: the first guard was
`Number.isFinite(Number(w.lng))`, but `Number(null)` is `0` — which is
finite — so a pin missing its longitude read as longitude 0 (the Gulf of
Guinea) and returned ~8000 km. Now the empty values are rejected *before*
coercion, while a genuine `lat: 0, lng: 0` still works.

#### `backend/routes/waypoints.js`

- `GET /api/tours/:slug/waypoints` — public (the pins are rider-facing).
- `POST /api/admin/tours/:id/waypoints` — what a map click saves.
- `PATCH .../waypoints/:wpId` — any subset; a drag sends only `lat`/`lng`.
  Partial mode validates only what was sent, so nudging a latitude doesn't
  demand the longitude again, but neither can be cleared to null.
- `POST .../waypoints/reorder` — must list **every** pin. A partial list is
  refused outright: renumbering a subset would interleave it with the
  untouched pins' old `seq` values and silently scramble the route.
- `DELETE .../waypoints/:wpId` — removes it and closes the `seq` gap.
- `POST .../waypoints/import-days` — copies the overnight coordinates the
  admin has **already** entered in `tour_days` into pins. Nothing invented;
  skipped days reported by name; refuses to run if pins already exist so it
  can't silently duplicate a route.

`GET /api/tours/:slug` now also carries `waypoints[]` and `route_map`
totals, so the tour page needs no extra request.

#### `frontend/routemap.js` — a dependency-free slippy map (630 lines)

The project has no build step and no bundled libraries, so instead of
reaching for Leaflet this implements the part of it that's actually needed:
Web Mercator tile math, pan/zoom, and an SVG overlay for the trail and pins.
Renders real OpenStreetMap raster tiles (attributed on the map) so a pin is
placed against actual terrain and village names rather than a blank
rectangle.

Lives in **one** place: the public pages load `frontend/routemap.js`, and
`server.js` maps `/routemap.js` to that same file so `admin.html` — served
from `backend/public` on a different origin, with the opposite colour theme —
loads it too. An explicit single-file mapping, not a second served directory,
because `serveStatic`'s traversal guard only covers `PUBLIC_DIR`. The
component injects its own stylesheet, so there's no CSS to keep in sync
between the two hosts either; its chrome is deliberately its own dark
context in both, the same choice the tour gallery's lightbox makes.

Things it handles that the first pass got wrong:

- **Coincident pins.** Upper Mustang's days 6 and 7 are both "Lo Manthang"
  (the rest day) at identical coordinates — genuinely correct data that
  stacked two pins into one unhoverable dot. They now fan out around the
  shared point with a leader line back to the true position, and the trail
  still follows the true positions, so the drawn line is the route as
  entered rather than as decluttered. Verified 30px apart, both reachable.
- **Wheel scroll.** Plain wheel is left alone — a map that swallows the wheel
  traps the reader halfway down a long tour page. Ctrl/Cmd+wheel zooms (also
  what a trackpad pinch sends), plus +/- buttons and double-click.
- **Double-click placing two pins** in edit mode (two `pointerup` events).
  A second placement within 350ms at the same spot is ignored.
- **Inline `onerror=`** on tile images, which a Content-Security-Policy would
  break and which can fire before a later-attached listener exists. Tiles are
  built as real elements with the handler attached before `src` is set.
- **Broken imagery.** If ~all tiles fail (offline, blocked, server down) the
  map says so and still draws pins and the trail on a plain graticule.
- **Keyboard parity.** The tooltip is the only place a pin's name and
  distance appear, so pins are focusable and show it on focus too.

#### Admin editor — `backend/public/admin.html`

New **Route map** card nested under the tour being edited, beside the
existing day-by-day card. Click the map to position a pin (which fills
lat/lng, shows a draft marker and focuses the name field — it does **not**
save a nameless pin), drag any pin to move it (saves immediately), up/down
arrows to reorder, per-row edit/delete, and the import button. After every
write it reloads from the server rather than patching a local copy, because
`seq` renumbering and the leg distances are both computed server-side.

#### Public tour page

`renderRouteMap()` rewritten to take three sources in order, so a tour at any
stage of being filled in still produces a sensible page:

1. `tour_waypoints` — the real drawn route. Named pins, kinds, notes,
   elevations, server-computed legs.
2. No pins yet, but days carry `overnight_lat/lng` → plot those as overnight
   pins, labelled as exactly that. This is what every tour showed before, so
   nothing regressed.
3. Neither → say so plainly. No invented coordinates, ever.

Also fixed: the route section used to require days, which would have hidden a
perfectly good map behind an "itinerary coming soon" empty state. It now
shows if **either** days or pins exist, with `hideDayTabs()` removing the
tabs/stats/chart when there's no itinerary rather than leaving them on
placeholder dashes.

#### Verification

- **45/45** waypoint API assertions — auth, 14 validation cases (all 400/404,
  never 500), import, reorder guards, partial patch, delete renumbering.
- **33/33** admin editor assertions driven in headless Edge against a
  **scratch copy** of `admin.html` (never the real file): map click → draft
  pin → named save → reorder → drag-to-move → rename → delete → tour switch.
  Caught two real bugs — the summary line opened without its distance *and
  without the straight-line caveat*, because `showRouteEditor` rendered the
  table with no totals payload. One "failure" was a headless artifact
  (`focus()` is a no-op in an unfocused window); re-tested with a spy on the
  call and it passes.
- **XSS:** five payloads stored as pin names *and* rider-facing notes, then
  every pin hovered to force the tooltip to build. **0** `alert()` calls, 0
  script/img/onload/onerror nodes injected, and the payload still renders as
  literal text — escaping doesn't eat the admin's content. (An earlier
  "2 VULNERABLE" reading was my own regex matching `onerror=alert` inside an
  already-escaped `aria-label`; the real check counts executions, not text.)
- **53/53** regression assertions — public endpoints, full tour payload shape
  (nothing lost, `waypoints`/`route_map` added), auth/privacy unchanged (guide
  emails still hidden, forged verify code still 409), data intact (17
  bookings / 8 custom requests / 23 departures / 7 tours), and
  `ON DELETE CASCADE` confirmed on a throwaway tour created and removed in
  the test.
- Server log: **0** internal errors, 0 uncaught exceptions, 0 SQLite
  constraint failures.
- All test data cleaned up: probe pins, XSS pins and the temp tour removed;
  the two scratch servers and scratch file copies deleted. Upper Mustang
  holds exactly the 10 pins imported from its own itinerary (100.4 km
  straight-line), nothing else.

#### Still outstanding — needs real content, not code

Four tours (`kathmandu-valley-explorer`, `langtang-forest-flow`,
`manaslu-wilderness-traverse`, `dharran`) have **no day-by-day rows at all**,
and `annapurna-epic` has one day with no coordinates. The plumbing is done
and the editors are there, but writing those itineraries and placing their
pins means real route knowledge — inventing Nepal trail days and coordinates
would be exactly the fabricated content this project avoids everywhere else.
Enter them under **Tours → (edit tour) → Route, day by day**, then
**Route map**.

Minor data nit noticed in passing: tour 7 has slug `dharran` but display name
`dharan` — worth settling on one spelling.

---

## Task 12 — Road-following routes, and an itinerary for every tour

Two requests: make the route map follow actual roads instead of drawing
straight lines between pins, and fill in the day-by-day itinerary and map for
every tour through the admin panel.

### 12a. The route now follows real roads

**Engine:** the public OSRM instance FOSSGIS runs for openstreetmap.org's own
routing tab (`backend/lib/routing.js`). No API key, and it offers a `bike`
profile — a car profile would refuse the jeep tracks and singletrack these
tours are ridden on. `ROUTING_BASE_URL` / `ROUTING_PROFILE` override it;
`ROUTING_DISABLED=1` turns it off entirely.

**New table `tour_route_legs`** caches the snapped geometry per pin-pair,
along with the pin positions it was computed from. That is the cache key: if
a pin is dragged, its legs no longer match and are recomputed, rather than
leaving a line that silently no longer joins its pins. Caching matters for
three reasons — the public tour page must not depend on a third-party service
being up, a tour page would otherwise fire one routing request per leg on
every visit, and the geometry is stable until a pin moves.

**`POST /api/admin/tours/:id/route/snap`** does the work: reuses unchanged
legs (adding an 11th pin to a 10-pin route costs one request, not ten),
issues requests sequentially with a courtesy gap, and returns a per-leg
summary. `DELETE` on the same path goes back to straight lines.

**Two guards, both added because the engine failed confidently rather than
loudly.** This is the part worth remembering:

1. **OSRM snaps each endpoint to the nearest routable way however far away
   that is**, then returns a confident route between the snapped points. Two
   pins in the mid-Pacific came back as a successful 0 km route with the
   endpoints moved ~1,500 km. A pin on Everest's summit snapped 23 km down
   the valley. Nothing in the response distinguishes that from a real
   result. `ROUTING_MAX_SNAP_M` (5 km, deliberately generous — a legitimate
   pin on a Mustang village centroid sits 1–2 km from the nearest mapped
   track and still routes along the right valley) now returns `no_route`
   instead.
2. **With no through route it goes the long way round.** Dhunche to Syabru
   Besi is about 6 km; the engine returned **153 km**, and a 12 km Langtang
   leg came back as **203 km**. `MAX_DETOUR_RATIO` (4x) *and*
   `MAX_DETOUR_EXCESS_KM` (15 km) must both be exceeded to reject — ratio
   alone is too strict because mountain roads routinely double the straight
   line, excess alone is too strict because a long valley road legitimately
   adds 50 km.

**Rendering.** `frontend/routemap.js` now draws each leg separately: a
snapped leg as its real shape in a solid line, an unsnapped one as a dashed
straight line that reads as "we don't have the trail for this stretch". A
faint stub joins a pin to where the mapped road actually starts, so an
off-road pin shows an honest offset rather than a mystery gap. OSRM's full
geometry for one 25 km leg is ~1,350 points, so it is simplified
(Ramer–Douglas–Peucker, 20 m, iterative so a pathological geometry can't blow
the stack) and rounded to 5 decimals: 149 points and 2.9 KB instead of 29 KB.

**The two distances are never interchanged.** A snapped leg's tooltip says
"25.8 km by trail"; an unsnapped one says "16.5 km straight line · no mapped
trail for this stretch, so the real ride is longer". Totals are reported
separately (`total_route_km` vs `total_straight_km`) and never summed,
because a mixed total is neither number. Upper Mustang: 82.4 km of real road
across 6 of 9 legs, vs 100.4 km in straight lines.

### 12b. Day-by-day itinerary + map for all seven tours

Four tours had no itinerary at all and two had a single junk test row. All
seven now have a full itinerary and a pinned, snapped route: **34 day rows,
40 pins, 24 of 34 legs following real roads.**

**Almost nothing here was typed.** Per day: `distance_km` is real OSRM road
distance, `riding_hours` is OSRM's own duration, and gain/loss/high point are
computed from a real SRTM elevation profile (OpenTopoData) sampled along the
routed line. Pin elevations are real SRTM. Only day titles and terrain
descriptions are written by hand.

**The first attempt was wrong and had to be thrown away.** It used
coordinates from recall, and an audit against SRTM found **13 of 30 were off
by 400–1,900 m** — the entire Manaslu chain was on mountainsides rather than
in the villages (Soti Khola 17 km north of the real one, at 2,517 m instead
of 700 m). Every derived number was poisoned. The fix was to stop guessing:
each place is now resolved through OpenStreetMap's geocoder (Nominatim) and
then cross-checked against SRTM, so two independent datasets have to agree on
both position and altitude before a coordinate is used. 25 resolved on the
first pass; the other 5 needed alternate spellings (Syabru Besi, Chandanbari,
Machhakhola, Samagaon, Larke Phedi). Thorong Phedi now resolves to 4,527 m
against a published 4,525 m. The 153 km Langtang detour also turned out to be
caused by the bad coordinates, not by OSRM.

**A second correction.** For the 10 legs with no mapped trail, elevation was
first sampled along the straight line — which crosses ridges the real trail
contours around. That produced **+2,722 m for a day that climbs about 480 m**
(Machha Khola 864 m → Jagat 1,340 m) and a 6,115 m "high point" where the
line clips a peak. A 6x overstatement of climbing is precisely the number a
rider judges fitness by, so those days were replaced with true lower bounds:
net climb between the two stops, high point = the higher of the two. Real
SRTM values that cannot mislead.

**Still needs the operator's own figures** (flagged in the README too):

- 10 days whose distance is straight-line because no trail is mapped — most
  of Manaslu, plus the two Annapurna pass days.
- Manaslu day 10 does not reflect Larkya La (5,106 m) and Annapurna day 6
  does not reflect Thorong La (5,416 m); the lower-bound high point is the
  higher trailhead instead.
- Three rest days left at **0 km** — an acclimatisation day's optional loop
  is a real operational choice, not something to invent.

**Two of the user's own test rows were replaced**, and this is worth stating
plainly: Annapurna day 1 (`"kagbeni _ beni"`, overnight place `"1"`, no
coordinates) and Pokhara day 1, whose overnight `kathmandu` sat at
**28.456, 37.7623** — longitude 37.76 is in the Red Sea, roughly 4,700 km
west of Nepal, and that pin was being plotted there. Also noticed: tour 7
`dharran` is tagged region `bagmati` / district `Chitwan`, but Dharan is in
Sunsari, Koshi province.

### Verification

- **53/53** regression (public endpoints, full tour payload shape, auth and
  privacy unchanged, 17 bookings / 8 custom requests / 23 departures / 7
  tours intact, `ON DELETE CASCADE` on a throwaway tour).
- **37/37** admin editor assertions driven in headless Edge against a scratch
  copy of `admin.html`: map click → draft pin → save → reorder → drag-to-move
  → rename → delete → tour switch, plus the snapped legs showing in the
  editor and road distance exceeding the straight line as it must.
- All seven tour pages render day tabs, pins, road polylines and tiles with
  nothing stuck on "Loading…".
- Upper Mustang verified byte-identical after the probe's add/drag/delete
  cycle: 10 pins, 6/9 routed, 82.4 km — the leg cache invalidated and
  restored correctly.
- Server log: 0 internal errors, 0 uncaught exceptions, 0 SQLite constraint
  failures.
- All scratch servers, scratch file copies and test rows cleaned up.

---

## Task 13 — Route map taken off the site; day-by-day rebuilt instead

Owner's call: the map isn't wanted for now, the day-by-day is the route
presentation, and both entering it and reading it should be easy.

### What was removed

The route map section is gone from `tour-detail.html` and `trip.html`, the
editor card is gone from `admin.html`, and `renderRouteMap()` /
`straightLineKm()` / `hideDayTabs()` are gone from `main.js`. The map CSS was
replaced rather than left dead. `admin.html` dropped from 2,363 to 1,934
lines.

**Nothing was deleted.** The `tour_waypoints` and `tour_route_legs` tables,
their 50 pins and snapped geometry, `backend/routes/waypoints.js`,
`backend/lib/routing.js` and `frontend/routemap.js` all remain and still
work; `GET /api/tours/:slug/waypoints` still serves them. "For now" was taken
literally — restoring the map is a matter of putting those sections back, not
a migration.

One removal that mattered on its own merits: `waypoints` and `route_map` were
taken out of the public `GET /api/tours/:slug` payload. A snapped leg's
geometry is a few KB, so several tens of KB were being sent on every tour
page view for data nothing rendered. Manaslu's payload went to 9 KB.

### Public: the whole trip is now readable at once

The day tabs show one day at a time, which suits the elevation chart but
meant a rider had to click through twelve days to understand the shape of a
trip. `renderItinerary()` now renders every day below the chart — distance,
climb, descent, high point, riding time, terrain and overnight stop — and
clicking or tabbing to a day drives the chart above, with the highlight kept
in step both ways.

A totals line sits above it: days, rest days, riding distance, climbing,
highest point. Two deliberate details:

- **A zero isn't "none" for every field.** 0 km is a real rest day and shows
  as "Rest day"; 0 m of climbing over a Himalayan day means nobody filled it
  in, and shows as "not set". Printing "0 m" and letting a rider believe it
  is the failure mode being avoided.
- The climb total says **"at least"** unless every riding day has a figure,
  because a partial sum presented as a trip total understates the trip.

### Admin: built for entering a twelve-day itinerary

- **Save & next day** saves and immediately clears the form with the next
  free day number filled in. The old flow needed a separate "Clear / new
  day" click between every single day.
- **Progress line** tracks days entered against the duration the tour is
  actually sold as, and warns when they disagree or a day number is missing —
  a 12-day tour with 5 days entered shows a half-written itinerary to riders,
  and that is worth catching in the panel rather than on the live site.
- **Totals line** under the table, computed server-side so the panel and the
  tour page can't disagree.
- **Up/down arrows renumber days.** This needed a backend endpoint:
  `tour_days` has `UNIQUE(tour_id, day_number)`, so swapping two days by
  PATCHing their numbers one at a time collides halfway through and leaves
  the itinerary half-renumbered. `POST /api/admin/tours/:id/days/reorder`
  renumbers through a temporary negative range, so the table is never in a
  state where two days share a number.
- **The two coordinate inputs were dropped** from the form, since the map
  that used them is off the site. The columns and their data stay, and the
  save payload omits them rather than sending null — so an edit preserves
  whatever is stored instead of wiping it. Verified explicitly.

### "A proper fetch"

`GET /api/admin/tours/:id/days` is new and returns the itinerary plus
server-computed totals. The panel previously rebuilt its day list by
fetching `/api/tours` (every tour on the site) purely to turn an id into a
slug, then fetching that tour's entire public payload — departures, reviews,
gallery, guides and all — to read one array off it. After every single save.
`tourSlugFromId()` now reads the `toursCache` that was already in memory,
falling back to a fetch only if it's empty.

### Validation that was missing

Day fields went into SQLite raw, so `distanceKm: "abc"` became NaN and
surfaced as a bare 500, and a negative elevation gain was stored and rendered
as "+-200 m". A shared `validateTourDay()` now range-checks everything
(`distanceKm` 0–500 so a rest day is valid, gain/loss 0–20000, `highPointM`
0–9000 since Everest is 8,849 m), with a `partial` mode so a PATCH validates
only what it was sent. Moving a day onto an occupied number is refused with a
sentence instead of a unique-constraint 500.

### Verification

- **41/41** day-API assertions: auth, 16 validation cases (all 400/404, never
  500), 0 km rest days accepted, partial edit, coordinate preservation across
  an edit that omits them, reorder guards, totals.
- **31/31** admin editor assertions driven in headless Edge against a scratch
  copy of `admin.html`: map editor confirmed gone, Save & next day advancing
  the form, rest day accepted and labelled, incomplete day refused, reorder
  with no constraint failure, edit/rename/delete, scratch tour cleaned up.
- **51/51** regression — public endpoints, tour payload shape (map data
  confirmed absent, itinerary present with its figures intact), auth and
  privacy unchanged, 17 bookings / 8 custom requests / 23 departures / 7
  tours intact.
- All seven tours verified at 1..n day numbering with no gaps after the
  reorder tests, and the itineraries in their correct order.
- Public pages render the itinerary with zero remaining map references; no
  page requests `routemap.js`.
- Server log: 0 internal errors, 0 uncaught exceptions, 0 constraint
  failures.

---

## Task 14 — Annapurna's figures were wrong; root cause was a stale server process

Reported as "what happened to the Annapurna tour page — Manaslu and
Kathmandu are fine". They were right, and the reason they were right is
instructive.

### What was actually wrong

Nothing was broken structurally — the page rendered, fetched fine, no JS
errors. The numbers were wrong, and Annapurna's were the worst:

| | before | after |
|---|---|---|
| Day 1 climb | +5,178 m over 61.3 km (**84 m/km**) | +2,760 m (45 m/km) |
| Day 2 climb | +2,773 m over 15.4 km (**180 m/km**) | +1,317 m (86 m/km) |
| Total climb | 11,981 m (tour states 6,400 m) | **6,436 m** |

180 m/km is an 18% average gradient sustained for a whole day. Kathmandu
Valley sat at 37/26/8 m/km, which is exactly why it looked fine.

### Two root causes

**1. SRTM noise counted as ascent.** Gain was computed by summing every rise
over 5 m along a raw SRTM profile. SRTM90 carries ~16 m vertical RMSE on 90 m
cells, so consecutive samples along a switchbacking gorge road wobble by more
than the road actually climbs, and all of that wobble was being counted.
Fixed by smoothing (7-sample moving average) and only counting changes over
25 m. Validated against the operator's own figure: Annapurna's routed total
went from 10,813 m (69% over their 6,400 m) to 6,436 m (0.5% over).

**2. A stale Node process — the more embarrassing one.** The detour guard was
added to `backend/lib/routing.js`, verified by calling the library directly,
and then the itinerary build was run **against a server that had never been
restarted**. So the live process was still running the pre-guard code and
happily cached a leg for Manaslu day 3 that routed **123 km for a 13.7 km
gap (9x)**, which then produced +2,512 m of "climbing" for that day. A forced
re-snap with the guard actually loaded rejected it correctly, and the day now
carries the same conservative net-change figures as the other unrouted legs
(+476 m, Machha Khola 864 m → Jagat 1,340 m).

Lesson worth keeping: this project's convention is that any backend edit needs
a restart, and verifying a library in isolation does not verify the running
server. The library test passing was what made it look done.

### A mistake I made and had to undo

The elevation recompute treated **Upper Mustang's hand-authored seed data as
generated data and overwrote days 1–5** — replacing figures like +540/−180
with SRTM-derived ones. Those were never mine to touch. Restored verbatim
from `seed.js` and verified byte-identical across all ten days; its totals
are back to 208 km / 8,000 m / 4,200 m, which match the tour's own fields
exactly.

### New: the panel warns when a page contradicts itself

`GET /api/admin/tours/:id/days` now cross-checks the itinerary against the
tour's own `distance_km` / `elevation_gain_m` / `max_altitude_m` — the fields
the tour page prints in its hero and overview paragraph. The Annapurna page
was saying "max altitude 3,800 m" directly above an itinerary whose high
point is 4,527 m. Reported in the day editor with both numbers rather than
auto-corrected, because which number is right is a judgement about the tour,
not arithmetic. Thresholds are loose (20% of distance, 30% of climb, 400 m of
altitude) so they catch contradictions and not rounding.

### Outstanding mismatches, split by whose they are

**The tour's own fields look wrong:**
- `dharran` records a **61 m maximum altitude** and 46 km. Dharan town is at
  370 m and the ride tops out near 1,400 m over 27 km.
- `annapurna-epic` records **3,800 m** max altitude. A real Annapurna circuit
  crosses Thorong La at 5,416 m.
- `upper-mustang` states 320 km against its own seeded itinerary's 208 km —
  a pre-existing inconsistency in the seed data, not introduced here.

**My itinerary doesn't match the product as sold:**
- `langtang-forest-flow` is sold as 95 km; the itinerary I built includes two
  ~90 km Kathmandu transfer days, so it totals 204.5 km. Those transfer days
  probably shouldn't be riding days at all.
- `pokhara-lakeside-flow` is sold as 32 km; my two-day Sarangkot out-and-back
  is 13.4 km.

**Still steep, flagged rather than silently published:** Annapurna day 2 at
86 m/km, Langtang days 3–4 at 191/163 m/km (these two are real — Syabru Besi
1,448 m to Thulo Syabru 2,209 m is genuinely 760 m of climb in 3.6 km), and
Manaslu day 9 at 122 m/km.

### Verification

- **41/41** day-API assertions, **51/51** regression, server log clean.
- All seven tour pages render with no NaN, no stuck sections, no map
  references; day tabs and itinerary rows match day counts everywhere.
- Upper Mustang verified byte-identical to `seed.js` on all ten days.
- Forced re-snap across all seven tours with the guard active: 30 legs
  routed, 13 correctly refused.

---

## Task 15 — Day-by-day cards reverted, and the real cause of the odd layout

Owner: the day-by-day detail cards were making the UI look unusual — take
them out, put it back as it was.

### Reverted

The itinerary card list is gone from `tour-detail.html` and `trip.html`,
`renderItinerary()` and `markItineraryActive()` are gone from `main.js`, the
`.itin-*` / `.itinerary-totals` rules are gone from `style.css`, and the
intro paragraph is back to its original wording. The tour page is the
original day tabs + elevation panel again. No dead CSS or orphaned ids left
behind.

### The actual reason the layout looked wrong

While reverting, tag counting found **an extra `</div>` in both tour
templates** — 77 opens against 78 closes. It came from the route-map removal
two tasks earlier: that regex was

    <div id="route-map-wrap".*?</div>
[ 	]*<div id="route-map-legend"[^>]*></div>

and the non-greedy `.*?` stopped at the first `</div>` inside the wrapper
(the one closing `<div id="route-map">`), so the match consumed the legend
but left **`route-map-wrap`'s own closing tag** behind.

An unmatched `</div>` closes the route section's parent early, which throws
every section below it — gallery, inclusions, guides, reviews — out of the
page's layout column. That is almost certainly what was being seen, and it
would have persisted whether or not the cards were there. Both pages are now
balanced, confirmed in the browser's own parsed DOM (132/132 and 109/109),
with `day-panel` still nested inside `route-section` and `route-empty` still
following it.

Worth remembering: removing a block from these templates with a non-greedy
regex across nested divs is how this happened, and a tag count afterwards
catches it in seconds. The headless checks run until now counted pins, rows
and NaN but never checked tag balance, so nothing flagged it.

### Kept

The admin-side day editor improvements from task 13 stay — Save & next day,
the progress and totals lines, the up/down renumbering, the single
`GET /api/admin/tours/:id/days` fetch and the field validation. None of those
are the cards and all of them were asked for; say the word if they should go
too.

### Verification

- All seven tour pages: day tabs and panel present, chart canvas sized, zero
  card markup, zero map references, no NaN.
- Day panel populates correctly (Annapurna day 1: 61.3 km, +2,760 m, −910 m,
  high 2,892 m, 7–8 hrs).
- Div balance verified on seven pages, source and rendered DOM.
- 51/51 regression, server log clean.

---
*Generated at the end of this session — see `HANDOFF.md` for the fuller
project history/conventions from earlier sessions.*

---

## Task 16 — The mountain-bike site becomes a universal adventure platform

Worked from the full Website Strategy & Redesign brief, with the owner away
and explicit authority to make the calls.

### The architectural decision everything else follows from

The brief's highest-priority requirement is a universal Adventure model that
does not have to be duplicated per activity. The existing `tours` table was
mountain-bike-shaped in its bones: `riding_style`, `distance_km` and
`elevation_gain_m` as NOT NULL columns, and nothing anywhere recording what
kind of activity a trip even was.

**One row in `tours` per adventure, whatever the activity.** Universal fields
are real columns, because they are what gets filtered and sorted. Anything
that belongs to one activity lives in `activity_data_json`, validated against
per-activity field definitions in `backend/lib/adventures.js`.

Adding an activity is now: a row in `activity_types`, an entry in
`ACTIVITY_FIELDS`, an entry in `DIFFICULTY_DIMENSIONS`. No migration, no new
table, no second detail page, no change to the filters, the finder or the
nav — they all read that table and those two maps. `rafting` and
`trail-running` ship with full field definitions and `enabled = 0` as the
worked example.

The alternative considered and rejected was a column per activity-specific
field: twenty nullable columns of which eighteen are always NULL, and a
migration for every new activity.

### Difficulty, and the honesty problem inside it

Five universal levels, plus per-activity dimensions — mountain biking graded
on fitness/technical/altitude, trekking on fitness/terrain/altitude, rafting
on physical demand/rapid grade/swimming. The brief is explicit that these are
not interchangeable, so they are declared per activity and the frontend
renders whatever labels the API gives it.

The migration had to produce three dimensions from one existing number. The
only honest conversion was to seed all three from the overall level and flag
them, rather than invent a spread nobody had assessed. So `difficulty_assessed`
is false when all three equal the overall level, and both the public trip page
and the admin panel say so in words. The notice clears per trip when somebody
sets them properly.

### What was removed, and why that mattered more than what was added

`tours.html` shipped **nine hand-written tour cards** as a no-JavaScript
fallback, carrying prices (€1,120, €2,890, €95), availability ("6 spaces",
"7 spots") and three trips — Rara Lake Wilderness among them — **that do not
exist in the database**. They were overwritten by real data a moment after
load, which is exactly why they survived for months: nobody saw them in a
working browser. With JavaScript off they were the page.

That is fabricated availability and invented prices, the single thing the
brief is most emphatic about. `tours.html` is now a redirect to
`adventures.html` that translates the old filter params, which also removes
the second catalogue — two listing pages with two filter vocabularies and two
card components was duplication the brief rules out, and it was already
showing: the old filters could not express "trekking" at all.

The homepage went from twelve sections to the brief's eight. Gone: the
hardcoded tour cards, the riding-styles grid, the SVG province map (whose
pins linked to those cards' anchors), a journal of three fake articles, and a
decorative gallery of dead links.

### The shared shell

Twelve pages each carried their own copy of the header. Adding
"Destinations" would have been twelve edits, and the copies had already
drifted — some linked to `#why`, some to `index.html#why`, several menu
entries went to `href="#"`. `frontend/shell.js` renders the header and footer
from one definition, which also gave every page a skip link it did not have.

The nav renders from a static list first (a header must not wait on fetch)
then reconciles against `/api/meta/filters`, dropping a disabled activity and
adding a newly enabled one. That is what keeps "enable an activity in the
admin panel" from needing a frontend change.

### Honesty, enforced rather than intended

Eleven rules are tabulated in README section 11. The ones that cost something:

- **`impact_metrics` ships with 11 rows and no values.** The Our Impact page
  is mostly visible gaps, each naming what has to be supplied. The API
  refuses to let an admin tick `evidenced` on a metric with no figure behind
  it — tested, and the admin panel surfaces the refusal.
- **The Safety page is shorter than most operators'** and has a section
  listing six things that are not documented, telling the reader to get them
  in writing before paying a deposit.
- **The legal pages say they are not professionally reviewed.** Booking
  Conditions reads the refund tiers live from `cancellation_rules`, so it
  cannot quote a different number from the one the refund calculation uses.
- **No cookie banner**, because there is nothing non-essential to consent to.
  The brief forbids a consent UI that does not control what it claims to;
  the honest version on a site with no trackers is no banner and a page
  explaining exactly what is stored.
- **The trekking and multi-activity categories are in the nav and empty**,
  and say so. Listing an invented itinerary to fill them was never an option.
- **The newsletter message** promised "we'll email you when new departures
  open" on a deployment with no outbound mail. It now says the address is
  stored and no email has been sent.

### Accessibility: a real failure found by actually measuring

`accessibility.html` claims AA contrast, so the claim had to be computed
rather than asserted. Twenty colour pairs, real WCAG arithmetic — and white
on the brand saffron `#D86432` is **3.63:1**. That clears AA for large text
and non-text UI, but a button label here is 14px at weight 700, under the
18.66px bold that counts as large, so it needs 4.5:1.

Fixed with `--signal-btn` `#BC4F23` (4.91:1) for solid button fills, the
header CTA, the activity badge and the notification badge, while every
non-text use of the accent keeps `--signal` exactly as the brief specifies.
`--paper-dim` moved from `#6E644F` (4.3:1 — large text only) to `#5E6459`
(5.41:1) for the same reason.

Also: `href="#"` is gone from the whole site. The gallery triggers that used
it became `<button>` (they open a lightbox — they were never links), the
homepage grid became `<figure>` (nothing was wired to it), and the booking
CTA became a `<button>` with its destination on a data attribute. Itineraries
and FAQs are native `<details>`, so they are keyboard-operable and announced
correctly with no JavaScript at all.

### Verification

- **101/101** universal-model assertions. Creates its own scratch adventure,
  exercises every new field and bound, the publish flag, all eight filters,
  the finder's relaxation order, the impact publication rules and the
  activity registry's delete guard, then deletes it and asserts the seven
  real adventures are unchanged. Includes the test that matters most: a
  mountain-bike field sent to a trekking adventure is dropped, not stored.
- **51/51** pre-existing regression. (It first reported five failures, all
  of them a 12-hour admin token that had expired — the database was verified
  directly before anything else: 7 tours, 44 days, 23 departures, 17
  bookings, 8 custom requests, 50 waypoints, 43 legs, all intact.)
- **34/34** admin-panel assertions driven in headless Edge against a scratch
  copy, including the one that proves the architecture: switching a tour's
  activity from mountain-biking to trekking replaces `af-riding_style` with
  `af-walking_hours_per_day` in the form, with no admin-panel code knowing
  either exists.
- **34 pages** rendered and checked for header/footer mount, exactly one
  `<h1>`, zero dead anchors, no `undefined`/`NaN`/`[object Object]` in
  visible text, their own content marker, and rendered-DOM tag balance.
- **20/20** contrast pairs clear their threshold.
- Horizontal overflow measured in a real browser at 320/375/390/768/1024/1440.

### Three tool bugs worth recording, because all three said "defect" about
### working code

1. The dead-link check matched the **string** `href="#"`, so it flagged the
   accessibility page (which discusses it inside `<code>`) and an HTML
   comment explaining why a button replaced one. Now counts anchor elements
   after stripping comments and code blocks.
2. The `[object Object]` check built its regex with `'\\$&'` as the
   replacement, which does not escape — so the pattern compiled to a
   **character class** matching every o, b, j, e, c and t on the page and
   reported 5,626 occurrences of a string that appears zero times. Both
   copies now use `split()`, which cannot be got wrong.
3. The a11y proxy used a fixed port and collided with its own earlier
   background run three times. Now uses port 0.

All three are the same lesson as an earlier false XSS report in this project:
**count the thing, not the text that describes it** — and a test failure is a
claim about the code that needs checking like any other.

### Still outstanding, and reported rather than papered over

Business information nobody has supplied, flagged in place on every page it
would otherwise appear on: company registration and trading address;
region-by-region emergency and evacuation procedure; guide medical
qualifications and renewal dates; operator liability insurance; the 24-hour
emergency contact; deposit amounts (currently 20% placeholders); and every
operational impact figure.

Pre-existing data problems not silently corrected: tour 7 (`dharran`) has
region `bagmati`, a 61 m max altitude on a Himalaya site and a best season
typed as "autom", which is why it matches every month filter. Langtang is
sold as 95 km against a 204.5 km itinerary; Pokhara as 32 km against 13.4 km;
`annapurna-epic` records 3,800 m against Thorong La's 5,416 m; `upper-mustang`
states 320 km against its own 208 km itinerary.

---

## Task 17 — The design pass

Full detail in README section 15. Short version below.

### The ask

Twelve points: font back to how it was, dropdowns that match the site,
spacing fixed, cards all the same size, better filter / sort / calendar /
finder / booking / private-trip controls, two named homepage sections fixed,
bigger and more distinctive destination cards, and a destination detail page
that is not nearly empty.

All twelve done.

### Most of it was bugs, not taste

This is the part worth remembering.

1. **`.section-head` was laying out sideways.** It was `display:flex` over
   three children — the kicker, the heading, the intro — so the kicker
   rendered *beside* the heading instead of above it, and the intro was
   crushed into 360px. Wrong on every section of every page. That was most of
   "the spacing is off".

2. **The filter panel was unstyled, not minimal.** Each group is a
   `<fieldset>` and only `border-bottom` was declared, so the browser's own
   `2px groove` stayed on the other three sides. The `<legend>` titles had no
   styling at all. And `.filter-count` was two different things at once — the
   small count badge *and* a dead block layout rule from the old tours page
   — which is what pushed every filter row apart.

3. **The impact section reordered itself on phones.** "Adventure that gives
   back" reused `.why-item` in a 2-column grid built for text + photo, which
   also carried a mobile rule moving the **last** child to the front. Fine
   when it was a paragraph beside an image; with three peers in it, the third
   reason jumped to the top.

4. **Cards were different sizes because of the pictures — the user was
   right.** `.adv-media` is a flex item, and flex items default to
   `min-height:auto`, meaning they will not shrink below their content. The
   content is an image whose `height:100%` is indefinite, so it falls back to
   the photo's natural height. A photo **wider** than 3:2 fits inside the
   ratio box; a photo **taller** than 3:2 beats it and stretches the box. One
   portrait photo in a row of three gave a 410px image next to two 180px
   ones. Fixed with `min-height:0` plus taking the image out of flow.

5. **Two invisible-text bugs on the destination card**, found by actually
   looking at a screenshot rather than trusting the markup tests. The old
   card's full-card dark scrim (`.dest-card::after`) was still painting over
   the new white card, and `.dest-card p { color: rgba(245,241,232,0.86) }`
   beat `.dest-card-intro` on specificity — near-white text on white. Both
   went when the superseded block was deleted.

That is twice in one pass that **dead CSS became a live bug**, which is why
the rest of the dead blocks were deleted rather than left to collide with a
class name added next year.

### Fonts

`--f-mono` went back to IBM Plex Mono. `--f-display` was changed several
times at the user's request and landed on **DM Sans**.

The lesson: **this design needs a display font with a real italic.** Twenty
headings are set in italic. Big Shoulders Display has none, so the browser
faked a slant and it looked broken at hero size. Headings were then scaled up
about 8%.

### Destination pages

Ten new content columns, a `destination_images` table, and a page with
eleven sections instead of four.

The gallery is built from photos already in this database attributed to trips
in that region, each labelled with the trip it came from. Six of seven
regions therefore have a captioned gallery with nothing uploaded. Everest has
no published trips, so its gallery is the hero image alone and the page says
photographs are missing — rather than borrowing a Khumbu-looking photo from
somewhere else, which would have made the grid look finished and the page
dishonest.

`/api/destinations/:slug` now applies the same "has an intro" test the
Destinations index already used. Before, a bare map pin like `chitwan`
rendered a hero with a name above a list of everything it did not have.

### The admin panel had no interface onto any of it

The destination content API existed with nothing driving it, so those fields
could only be set by a migration, and there was no way to add a destination
photo. Both exist now, plus a completeness column (`4/9 blocks — missing:
seasons, permits`) so an admin can see what the live page is admitting it
lacks.

The multi-paragraph blocks use a `## Heading | extra` syntax, because a
one-per-line textarea cannot hold a blank line. There is a byte-for-byte
round-trip test on a scratch destination: a lossy round-trip would quietly
delete a paragraph every time someone opened a page and saved it, and nobody
would notice for months.

### Accessibility

The destination hero puts text over a photo, so its contrast is only as good
as the lightest photo an admin uploads. Measured against that worst case the
eyebrow was **2.99:1** where small text needs 4.5:1. Scrim darkened 0.74 →
0.82 and two text colours raised. All 50 new colour pairs now pass, computed
rather than asserted, with translucent colours flattened against what is
actually behind them.

### Tests

82/82 design checks, 37/37 destination editor, 50/50 contrast, and the
existing suites unchanged: 27/27 pages, 101/101 adventure model, 51/51
regression, 34/34 admin panel. Database verified intact, no test rows left.

**Not finished:** 320px horizontal overflow. The browser sweep is too slow in
this environment to complete in a session. It is the one unverified item.

### Two process notes

- The regression suite failed 5 checks on its first run, including
  "0 bookings" and "0 custom requests". The database was verified directly
  first — all intact — and the cause was an expired 12-hour admin token.
  **Check a test failure before believing it.** Third time that lesson has
  earned a place in this file.
- The user's editor reformatted `style.css` on save (2,665 → 8,258 lines, one
  declaration per line). Still valid CSS, but trailing comments were pushed
  onto the following line, so a few now sit above the wrong token. Cosmetic.

---

## Task 18 — Finishing v2, removing old pages, and user testing

Full table in `V2_AUDIT.md`; README §16 has the short version.

### The ask

1. User test cases for both visitors/riders and the admin, on every page.
2. Remove pages left over from before v2.
3. Check the v2 brief in detail and finish anything not done.

All three done.

### v2: what was actually missing

The brief was found (the 27-section "master prompt") and checked line by line.
Ten gaps, all closed. The two that matter most:

- **Payments were simulated.** Any well-formed card was "approved", and the
  full card number and CVV were POSTed to our own server. That breaks the brief
  ("do not simulate successful payment") and is a security problem on a live
  backend. Now: no card form, both pay endpoints refuse, and an admin records
  payments when money really arrives. A demo switch exists, off by default.
- **There was no enquiry form.** Asking anything meant creating an account.
  The Contact page now has one, with an admin Enquiries tab.

Also: "You're booked!" → "Place held"; itinerary days gained meals,
accommodation, notes and description; final booking button on trip pages;
Region filter; When to Visit selectors; canonical URLs everywhere.

### Old pages

`build-adventure`, `cancellation-policy`, `safety-policy` and `tours` were
archived, not deleted. Each one's unique job was moved over first. The old
safety page's claims about guide training and satellite phones were **not**
carried over — nobody has verified them.

### What testing caught

Writing real user journeys, not just "does the page load", found bugs that
had been live for a while:

| Bug | Since |
|---|---|
| **Rider dashboard never loaded** | the earlier rebuild (`shell.js` overwrote an element's id) |
| **Signed-in riders couldn't send Private Trips** | the earlier rebuild (wrong token name) |
| **Demo guide's password pre-filled on the live `guide.html`** | before this project's records |
| Trip page too wide on phones; booking box off-screen at 1024px | a grid column that couldn't shrink |
| 32 form labels not tied to their fields | various |

### The test harness had bugs too

Three, each of which made the **site** look broken when it wasn't:

1. A blocking browser call froze the proxy the browser was waiting on —
   every page "never finished".
2. Injecting scripts with a replacement *string* turned `$$` into `$` —
   the test's own helper was overwritten.
3. Checking `document.body.textContent` matched the test's own source code.

Same lesson as before: **a failing test is a claim that needs checking.**

### Results

| Suite | Result |
|---|---|
| Every page × 5 screen widths (175 renders) | 35 / 35 |
| Visitor, rider and admin journeys | 266 / 266 |
| Earlier suites (7 of them) | all passing |

Real data unchanged after every run; no test data left behind.
