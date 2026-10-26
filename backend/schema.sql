-- ============================================================================
-- HIGH ROUTE MTB — Database Schema
--
-- Written to run as-is on SQLite (via Node's built-in node:sqlite module —
-- see db.js). The types and constraints are kept deliberately close to
-- PostgreSQL so this file is also the reference schema for a production
-- migration (swap INTEGER PRIMARY KEY -> SERIAL/IDENTITY, TEXT dates ->
-- TIMESTAMPTZ, and JSON-as-TEXT columns -> JSONB).
--
-- Money is stored in integer cents to avoid floating-point rounding.
-- Timestamps are stored as ISO-8601 TEXT (SQLite has no native datetime type).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- TOURS  — the fixed-departure catalogue (brief section 6/7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tours (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  region              TEXT NOT NULL,
  -- Free-text Nepal district name (typos tolerated — see lib/geo.js's
  -- resolveDistrict), used only to auto-place this tour's pin on the
  -- homepage map. Distinct from `region`, which stays a general
  -- descriptive label for display/filtering and is not used for pinning.
  district            TEXT,
  summary             TEXT NOT NULL,
  duration_days       INTEGER NOT NULL,
  difficulty_level    INTEGER NOT NULL CHECK (difficulty_level BETWEEN 1 AND 5),
  riding_style        TEXT NOT NULL,
  distance_km         INTEGER NOT NULL,
  elevation_gain_m    INTEGER NOT NULL,
  max_altitude_m      INTEGER NOT NULL,
  price_from_cents    INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'EUR',
  image_url           TEXT,
  best_season         TEXT,
  group_size_min      INTEGER NOT NULL DEFAULT 2,
  group_size_max      INTEGER NOT NULL DEFAULT 10,
  -- Structured tour-detail-page content, all admin-editable and all
  -- optional — a tour with none of this filled in still works, it just
  -- shows the corresponding section's empty state rather than fabricated
  -- copy (see frontend/main.js's renderInclusions/renderEquipment/
  -- renderSafety/renderCancellation). The *_json columns hold a plain
  -- JSON array of strings, following the addons_json/preferences_json
  -- convention used elsewhere in this schema.
  inclusions_json           TEXT NOT NULL DEFAULT '[]',
  exclusions_json           TEXT NOT NULL DEFAULT '[]',
  equipment_essential_json  TEXT NOT NULL DEFAULT '[]',
  equipment_recommended_json TEXT NOT NULL DEFAULT '[]',
  safety_hazards      TEXT,
  safety_preparation  TEXT,
  safety_emergency    TEXT,
  cancellation_policy TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- TOUR_DAYS — day-by-day route breakdown (brief section 8/9)
-- lat/lng are the overnight stop location. See the GPS DISCLAIMER in
-- README.md — these are approximate demo coordinates, not surveyed GPX data.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tour_days (
  id                  INTEGER PRIMARY KEY,
  tour_id             INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  day_number          INTEGER NOT NULL,
  title               TEXT NOT NULL,
  distance_km         REAL NOT NULL,
  elevation_gain_m    INTEGER NOT NULL,
  elevation_loss_m    INTEGER NOT NULL,
  high_point_m        INTEGER NOT NULL,
  riding_hours        TEXT NOT NULL,
  terrain             TEXT NOT NULL,
  overnight_place     TEXT NOT NULL,
  overnight_lat       REAL,
  overnight_lng       REAL,
  UNIQUE(tour_id, day_number)
);

-- ---------------------------------------------------------------------------
-- GUIDES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guides (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  role                TEXT NOT NULL,
  years_experience    INTEGER NOT NULL,
  languages           TEXT NOT NULL,
  specialties         TEXT,
  rating              REAL NOT NULL DEFAULT 5.0,
  trips_led           INTEGER NOT NULL DEFAULT 0,
  bio                 TEXT,
  photo_url           TEXT,
  -- Array of { title, verified } objects, admin-managed. Only entries with
  -- verified:true are ever shown on public-facing guide profiles — an
  -- admin can record a claimed qualification without it being displayed
  -- until they've actually checked it (see "if verified" in the brief).
  qualifications_json TEXT NOT NULL DEFAULT '[]',
  email               TEXT UNIQUE,
  password_hash       TEXT,
  password_salt       TEXT
);

-- ---------------------------------------------------------------------------
-- DEPARTURES — a scheduled instance of a tour (brief section 12/13)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departures (
  id                  INTEGER PRIMARY KEY,
  tour_id             INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  guide_id            INTEGER REFERENCES guides(id),
  start_date          TEXT NOT NULL,
  end_date            TEXT NOT NULL,
  capacity            INTEGER NOT NULL,
  seats_booked        INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','few_spaces','full','request_only','cancelled')),
  -- Auto-created the moment a custom_requests proposal's deposit is paid
  -- (see routes/proposals.js) — a private reservation for that one group,
  -- never a publicly bookable date. Every public-facing departure listing
  -- (GET /api/departures for non-admins, the tour catalogue/detail pages)
  -- excludes these; only the admin Departures tab and the linked customer's
  -- own booking ever see them.
  is_custom           INTEGER NOT NULL DEFAULT 0,
  custom_request_id   INTEGER REFERENCES custom_requests(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- RIDERS — customer accounts (brief section 17)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS riders (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT NOT NULL,
  email                   TEXT UNIQUE NOT NULL,
  phone                   TEXT,
  country                 TEXT,
  riding_experience       TEXT,
  preferred_style         TEXT,
  bike_info               TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  password_hash           TEXT NOT NULL,
  password_salt           TEXT NOT NULL,
  -- NULL until the rider enters the code emailed to them at signup (see
  -- email_verifications below and POST /api/auth/verify-email). Login is
  -- refused while this is NULL — see routes/auth.js.
  email_verified_at       TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One outstanding code per signup/resend — a new row invalidates any earlier
-- unused one for the same rider (see routes/auth.js). code_hash stores
-- SHA-256(code), never the raw 6-digit code, same reasoning as sessions'
-- token_hash below.
CREATE TABLE IF NOT EXISTS email_verifications (
  id          INTEGER PRIMARY KEY,
  rider_id    INTEGER NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- token_hash stores SHA-256(token), never the raw token — if this file or the
-- .db is ever leaked, the tokens inside it are not directly usable to sign in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('rider','guide','admin')),
  subject_id  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- ADMINS — real staff accounts replacing the old single shared bearer token.
-- Sessions are short-lived (see ADMIN_SESSION_HOURS in lib/auth.js) so a
-- stolen admin token has a small blast radius — "minimal token" by design.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  email               TEXT UNIQUE NOT NULL,
  password_hash       TEXT NOT NULL,
  password_salt       TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- BOOKINGS + BOOKING_RIDERS (brief section 14)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id                  INTEGER PRIMARY KEY,
  departure_id        INTEGER NOT NULL REFERENCES departures(id),
  -- SET NULL (not the default RESTRICT) so deleting a rider account from the
  -- admin Users tab always succeeds — the booking record itself is kept for
  -- the business's records, just detached from the deleted personal account.
  lead_rider_id       INTEGER REFERENCES riders(id) ON DELETE SET NULL,
  -- unguessable per-booking secret, returned once at creation time. A guest
  -- (no rider account) needs it to look their own booking back up later —
  -- this is what stops booking IDs (sequential ints) from being an IDOR.
  access_token        TEXT UNIQUE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','deposit_paid','paid','balance_due','cancelled','completed')),
  -- Legacy flat list of addon keys — kept for backward-compatible reads of
  -- old rows. New bookings also get a real booking_addons row per line item
  -- (with a price snapshot), which is what checkout/invoice actually price
  -- from — see routes/bookings.js.
  addons_json         TEXT NOT NULL DEFAULT '[]',
  -- subtotal_cents (base fare + addons, before discount/tax) and discount_cents
  -- are kept separately so a booking's price breakdown can always be shown
  -- honestly later, even after a promo code's own row changes or expires.
  subtotal_cents      INTEGER NOT NULL DEFAULT 0,
  promo_code_id       INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
  discount_cents      INTEGER NOT NULL DEFAULT 0,
  -- Tax/fees on top of the discounted subtotal — 0 unless a real tax rule
  -- ever applies; never fabricated, see routes/bookings.js computeTotals().
  tax_cents           INTEGER NOT NULL DEFAULT 0,
  total_cents         INTEGER NOT NULL,
  deposit_cents       INTEGER NOT NULL,
  amount_paid_cents   INTEGER NOT NULL DEFAULT 0,
  -- Cumulative refund bookkeeping. refunded_cents only ever increases when an
  -- admin explicitly marks a refunds row 'processed' (see the refunds table)
  -- — never on cancellation alone, since no real payment provider is wired
  -- up to confirm money has actually moved. 'none' = nothing owed/requested.
  refunded_cents      INTEGER NOT NULL DEFAULT 0,
  refund_status       TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','pending','processed','denied')),
  -- deposit hold expiry: a 'pending' (no money in yet) booking auto-cancels
  -- once this passes, freeing the seats. See expireOverdueBookings() in
  -- routes/bookings.js. Not affected once any payment is recorded.
  payment_due_at      TEXT NOT NULL,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS booking_riders (
  id                      INTEGER PRIMARY KEY,
  booking_id              INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  rider_id                INTEGER REFERENCES riders(id) ON DELETE SET NULL,
  name                    TEXT NOT NULL,
  age                     INTEGER,
  country                 TEXT,
  riding_experience       TEXT,
  bike_info               TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  -- Free-text medical/dietary/accessibility notes the rider chooses to
  -- share. Only ever returned by the same access-controlled endpoints as
  -- the rest of a booking's rider details (canAccessBooking) — never
  -- included in any public or bulk-listing query. See "data minimization"
  -- in routes/bookings.js.
  special_requirements    TEXT,
  is_lead                 INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- ADDON_CATALOG — the published, admin-priced list of optional extras a
-- rider can add to a booking (bike rental, e-bike, airport transfer, extra
-- hotel night, extra riding day, porter, photography, GoPro/video, private
-- guide, single room, insurance assistance). Replaces what used to be a
-- hardcoded price object in routes/bookings.js so prices are admin-editable
-- without a code change, and so the frontend never hardcodes a price either
-- — it always reads GET /api/addons.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS addon_catalog (
  id                  INTEGER PRIMARY KEY,
  key                 TEXT UNIQUE NOT NULL,
  label               TEXT NOT NULL,
  description         TEXT,
  price_cents         INTEGER NOT NULL,
  -- per_rider: price × number of riders on the booking (bike rental, e-bike,
  -- single room, insurance, etc). per_booking: charged once regardless of
  -- group size (a single private guide serves the whole group).
  unit                TEXT NOT NULL DEFAULT 'per_rider' CHECK (unit IN ('per_rider','per_booking')),
  active              INTEGER NOT NULL DEFAULT 1,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- BOOKING_ADDONS — one row per addon line item on a booking, with the price
-- snapshotted at booking time so a later catalog price change never
-- rewrites a past booking's or invoice's numbers.
CREATE TABLE IF NOT EXISTS booking_addons (
  id                  INTEGER PRIMARY KEY,
  booking_id          INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  addon_key           TEXT NOT NULL,
  label               TEXT NOT NULL,
  unit_price_cents    INTEGER NOT NULL,
  unit                TEXT NOT NULL CHECK (unit IN ('per_rider','per_booking')),
  quantity            INTEGER NOT NULL,
  line_total_cents    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- PROMO_CODES — admin-managed discount codes, validated and priced
-- server-side only (routes/promo.js / routes/bookings.js) — a client can
-- never supply its own discount amount.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_codes (
  id                  INTEGER PRIMARY KEY,
  code                TEXT UNIQUE NOT NULL,
  description         TEXT,
  discount_type       TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  -- percent: 1-100 (% off subtotal). fixed: cents off subtotal (never below 0).
  discount_value      INTEGER NOT NULL,
  -- NULL = unlimited. Both are enforced server-side at redemption time.
  max_uses            INTEGER,
  used_count          INTEGER NOT NULL DEFAULT 0,
  min_riders          INTEGER,
  tour_id             INTEGER REFERENCES tours(id) ON DELETE CASCADE,
  valid_from          TEXT,
  valid_until         TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- INVOICES — one per booking, generated lazily the first time it's
-- requested and reused after that so a booking's invoice number is stable
-- once issued, even if the booking is later modified or cancelled.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id                  INTEGER PRIMARY KEY,
  booking_id          INTEGER UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  invoice_number      TEXT UNIQUE NOT NULL,
  issued_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- CANCELLATION_RULES — admin-configurable tiered refund policy. Whichever
-- row has the largest min_days_before_departure that the actual number of
-- days-until-departure (at cancellation time) still meets or exceeds wins;
-- if none match, the refund is 0%. See computeRefundPercent() in
-- routes/bookings.js. Seeded with reasonable demo defaults — an admin can
-- add/edit/remove tiers from the Refunds tab.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cancellation_rules (
  id                          INTEGER PRIMARY KEY,
  min_days_before_departure   INTEGER NOT NULL,
  refund_percent              INTEGER NOT NULL CHECK (refund_percent BETWEEN 0 AND 100)
);

-- ---------------------------------------------------------------------------
-- REFUNDS — an audit trail of refund requests/decisions against a booking.
-- A row here starting 'pending' is a computed ENTITLEMENT, not a payment
-- event — it only becomes 'processed' once an admin explicitly confirms the
-- money has actually been returned to the rider through whatever real-world
-- payment channel was used (there is no live payment gateway in this build
-- to confirm it automatically). Never surface a 'pending' row to a rider as
-- "refunded" — see the frontend's refund-status labels.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refunds (
  id                  INTEGER PRIMARY KEY,
  booking_id          INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount_cents        INTEGER NOT NULL,
  refund_percent      INTEGER NOT NULL,
  reason              TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','denied')),
  requested_by        TEXT NOT NULL CHECK (requested_by IN ('rider','admin')),
  requested_at        TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at        TEXT,
  processed_by_admin_id INTEGER REFERENCES admins(id),
  admin_notes         TEXT
);

-- ---------------------------------------------------------------------------
-- CUSTOM_REQUESTS — "Build Your Adventure" CRM leads (brief section 15/44)
-- Pipeline: new -> contacted -> proposal_sent -> approved -> deposit ->
-- confirmed -> completed (or declined/cancelled at any point before
-- confirmed). 'approved' sits between a customer approving a proposal and
-- their deposit landing — see custom_proposals below for the itinerary
-- content itself and custom_request_events for the audit trail of every
-- transition through this pipeline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_requests (
  id                  INTEGER PRIMARY KEY,
  -- set automatically from the session when a signed-in rider submits the
  -- Build Your Adventure wizard; stays NULL for an anonymous/guest request.
  -- A proposal can only be approved/paid against a request with a rider_id
  -- — see routes/proposals.js's requireRequestOwner.
  rider_id            INTEGER REFERENCES riders(id) ON DELETE SET NULL,
  -- The catalogue tour this request is based on — the "Build Your
  -- Adventure" wizard only lets a customer pick from real tours (a dropdown
  -- of GET /api/tours), never free text, so a proposal always starts from an
  -- itinerary that actually exists. SET NULL if the tour is later deleted —
  -- the request/proposal history is kept either way.
  tour_id             INTEGER REFERENCES tours(id) ON DELETE SET NULL,
  -- The customer's own preferred start date — independent of the base
  -- tour's fixed departures, since a custom trip is scheduled bespoke.
  preferred_date      TEXT,
  name                TEXT,
  email               TEXT,
  destination         TEXT,
  duration_bucket     TEXT,
  riding_style        TEXT,
  experience          TEXT,
  group_size          TEXT,
  budget              TEXT,
  preferences_json    TEXT NOT NULL DEFAULT '[]',
  -- 'declined' = admin turned it down, or the customer declined a proposal;
  -- 'cancelled' = the requester withdrew it themselves from their dashboard.
  -- Kept distinct so the CRM view can tell the two apart at a glance.
  status              TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','contacted','proposal_sent','approved','deposit','confirmed','completed','declined','cancelled')),
  internal_notes      TEXT,
  -- Points at the latest custom_proposals row for this request (any status)
  -- so a single join always finds "the current proposal" without a subquery
  -- — full version history is still every row in custom_proposals.
  active_proposal_id  INTEGER REFERENCES custom_proposals(id) ON DELETE SET NULL,
  -- Cumulative payments recorded against this request's approved proposal —
  -- covers both the initial deposit and any later balance payment, up to
  -- the proposal's full price_cents. See custom_request_payments for the
  -- per-payment audit trail.
  amount_paid_cents   INTEGER NOT NULL DEFAULT 0,
  -- Set the moment the deposit is first paid — a real departures row (see
  -- its is_custom comment) and a real bookings row are created together at
  -- that point, so the customer's dashboard, trip.html, invoice.html and the
  -- admin's Departures/Bookings tabs all just work for a confirmed custom
  -- trip the same way they already do for a catalogue booking, instead of a
  -- second parallel "view your custom trip" system. Once set, the proposal
  -- itself is frozen (see routes/proposals.js) — real money and a real
  -- departure now exist against these exact terms, so further changes go
  -- through the normal Departures/Bookings admin tools, not the proposal.
  booking_id          INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- CUSTOM_PROPOSALS — an admin-authored itinerary + price offered against a
-- custom_requests lead. Editable only while 'draft'; once 'sent' its content
-- is frozen (edits go into a new, higher `version` row instead, and the old
-- row becomes 'superseded') so a customer who already approved/declined a
-- specific offer never has its terms silently change under them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_proposals (
  id                  INTEGER PRIMARY KEY,
  custom_request_id   INTEGER NOT NULL REFERENCES custom_requests(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  -- Every proposal is built from a real catalogue tour, picked from a
  -- dropdown (never typed free text) so its content is always grounded in
  -- data that actually exists — see the tour-detail fetch in
  -- custom-request.html. destination is a denormalized copy of that tour's
  -- name at proposal-creation time, kept even if the tour is later renamed
  -- or deleted, so a proposal a customer already saw never reads differently
  -- later. SET NULL (not RESTRICT) on tour deletion — the proposal's own
  -- text/price/itinerary already stand on their own.
  tour_id             INTEGER REFERENCES tours(id) ON DELETE SET NULL,
  destination         TEXT NOT NULL,
  start_date          TEXT,
  duration_days       INTEGER,
  riding_details      TEXT,
  accommodation       TEXT,
  transport           TEXT,
  price_cents         INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'EUR',
  deposit_percent     INTEGER NOT NULL DEFAULT 20 CHECK (deposit_percent BETWEEN 1 AND 100),
  inclusions_json     TEXT NOT NULL DEFAULT '[]',
  exclusions_json     TEXT NOT NULL DEFAULT '[]',
  -- After this date the proposal can no longer be approved or paid against —
  -- see expireOverdueProposals() in routes/proposals.js. NULL = no expiry.
  expires_at          TEXT,
  -- Shown to the customer alongside the itinerary (a cover note, e.g. "let us
  -- know if the dates need to shift"). Internal-only notes stay on
  -- custom_requests.internal_notes, never duplicated here.
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','sent','approved','declined','changes_requested','expired','withdrawn','superseded')),
  -- The customer's decline reason or requested-changes message, or NULL.
  customer_response_message TEXT,
  created_by_admin_id INTEGER REFERENCES admins(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at             TEXT,
  responded_at        TEXT,
  UNIQUE(custom_request_id, version)
);
CREATE INDEX IF NOT EXISTS idx_proposals_request ON custom_proposals(custom_request_id, version DESC);

-- ---------------------------------------------------------------------------
-- CUSTOM_REQUEST_EVENTS — append-only audit trail of every status change on a
-- custom_requests row or one of its proposals: who did it (admin/rider/
-- system), what changed, and any accompanying message. Never updated or
-- deleted, so the CRM can always answer "what happened to this lead and
-- when" — see brief's "ensure every status change is auditable".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_request_events (
  id                  INTEGER PRIMARY KEY,
  custom_request_id   INTEGER NOT NULL REFERENCES custom_requests(id) ON DELETE CASCADE,
  proposal_id         INTEGER REFERENCES custom_proposals(id) ON DELETE SET NULL,
  event_type          TEXT NOT NULL,
  from_status         TEXT,
  to_status           TEXT,
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('admin','rider','system')),
  actor_id            INTEGER,
  message             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cr_events_request ON custom_request_events(custom_request_id, created_at);

-- ---------------------------------------------------------------------------
-- CUSTOM_REQUEST_PAYMENTS — audit trail of deposit payments recorded against
-- an approved custom_proposals row. Same "no real payment gateway" demo
-- model as bookings/pay — see routes/proposals.js.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_request_payments (
  id                  INTEGER PRIMARY KEY,
  custom_request_id   INTEGER NOT NULL REFERENCES custom_requests(id) ON DELETE CASCADE,
  proposal_id         INTEGER NOT NULL REFERENCES custom_proposals(id),
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'EUR',
  card_last4          TEXT,
  paid_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS — lightweight in-app notifications for riders and admins
-- (this demo has no outbound email/SMS provider wired up — see README).
-- recipient_id NULL with recipient_type='admin' means "every admin sees it",
-- since this app has no per-admin assignment of CRM leads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id                  INTEGER PRIMARY KEY,
  recipient_type      TEXT NOT NULL CHECK (recipient_type IN ('rider','admin')),
  recipient_id        INTEGER,
  type                TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT,
  link_url            TEXT,
  custom_request_id   INTEGER REFERENCES custom_requests(id) ON DELETE CASCADE,
  read_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_type, recipient_id, created_at);

-- ---------------------------------------------------------------------------
-- REVIEWS (brief section 31)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id                  INTEGER PRIMARY KEY,
  tour_id             INTEGER REFERENCES tours(id),
  departure_id        INTEGER REFERENCES departures(id),
  -- the rider who actually rode this departure — SET NULL (not RESTRICT) so
  -- deleting a rider account never blocks, matching bookings.lead_rider_id.
  -- Nullable so legacy/seed-authored reviews (no linked account) stay valid.
  rider_id            INTEGER REFERENCES riders(id) ON DELETE SET NULL,
  rider_name          TEXT NOT NULL,
  riding_score        INTEGER CHECK (riding_score BETWEEN 1 AND 5),
  guide_score         INTEGER CHECK (guide_score BETWEEN 1 AND 5),
  scenery_score       INTEGER CHECK (scenery_score BETWEEN 1 AND 5),
  organization_score  INTEGER CHECK (organization_score BETWEEN 1 AND 5),
  accommodation_score INTEGER CHECK (accommodation_score BETWEEN 1 AND 5),
  would_recommend     INTEGER NOT NULL DEFAULT 1,
  quote               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- GPS_PINGS — location tracking (brief section 19/20/21)
-- DEMO / SIMULATION ONLY — see README "GPS & Safety disclaimer".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gps_pings (
  id                  INTEGER PRIMARY KEY,
  departure_id        INTEGER NOT NULL REFERENCES departures(id),
  booking_rider_id    INTEGER REFERENCES booking_riders(id),
  label               TEXT,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  altitude_m          INTEGER,
  speed_kmh           REAL,
  source              TEXT NOT NULL DEFAULT 'simulated' CHECK (source IN ('device','simulated','guide')),
  recorded_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gps_departure ON gps_pings(departure_id, recorded_at);

-- ---------------------------------------------------------------------------
-- EMERGENCY_ALERTS — SOS workflow (brief section 22)
-- DEMO / SIMULATION ONLY. Real deployments must route this to an actual
-- satellite communicator, a 24/7 operations desk, and a response plan built
-- with qualified local safety/medical professionals — not a software-only
-- feature. See README.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emergency_alerts (
  id                  INTEGER PRIMARY KEY,
  departure_id        INTEGER NOT NULL REFERENCES departures(id),
  booking_rider_id    INTEGER REFERENCES booking_riders(id),
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  altitude_m          INTEGER,
  message             TEXT,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  responder           TEXT,
  triggered_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at         TEXT
);

-- ---------------------------------------------------------------------------
-- TRIP_UPDATES — guide check-ins, incident reports, status posts (section 21)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_updates (
  id                  INTEGER PRIMARY KEY,
  departure_id        INTEGER NOT NULL REFERENCES departures(id),
  guide_id            INTEGER REFERENCES guides(id),
  type                TEXT NOT NULL CHECK (type IN ('checkin','incident','photo','status','briefing')),
  booking_rider_id    INTEGER REFERENCES booking_riders(id),
  message             TEXT,
  photo_url           TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- DESTINATIONS — the regions pinned on the homepage map (brief section 5/46).
-- Admin-manageable so new regions can be added without touching the frontend.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS destinations (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  region              TEXT,
  description         TEXT,
  hero_image_url      TEXT,
  lat                 REAL,
  lng                 REAL,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  -- Set only by ensureDestinationForDistrict (routes/admin.js) when a
  -- tour's district first needs a pin. Only auto-created rows are ever
  -- auto-removed when no tour references their district/place anymore — a
  -- destination an admin added by hand here is never touched by that cleanup.
  auto_created        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- GALLERY_IMAGES — the photo gallery (brief section 36), admin-managed.
-- category groups where an image is eligible to show: the homepage hero
-- strip, the general gallery grid, a guide profile, or a specific tour.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gallery_images (
  id                  INTEGER PRIMARY KEY,
  image_url           TEXT NOT NULL,
  caption             TEXT,
  category            TEXT NOT NULL DEFAULT 'gallery' CHECK (category IN ('hero','gallery','guide','tour')),
  tour_id             INTEGER REFERENCES tours(id) ON DELETE SET NULL,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- NEWSLETTER_SUBSCRIBERS — homepage "Don't miss a departure" signup.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id                  INTEGER PRIMARY KEY,
  email               TEXT UNIQUE NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- TOUR_WAYPOINTS — the route map. An ordered list of real pinned positions
-- along a tour, placed by an admin (by clicking the map in the admin panel's
-- Route map editor, or by typing coordinates by hand).
--
-- Deliberately NOT the same thing as tour_days.overnight_lat/lng, which
-- holds exactly ONE position per day: where the group sleeps. A route needs
-- more than that — a trailhead, a pass crossed mid-morning, a viewpoint, a
-- river crossing, a hazard to brief riders on. None of those can be stored
-- as a tour_days row without inventing a whole day around them.
--
-- `seq` is the position along the route (1, 2, 3 …) and is what the map
-- draws its trail through. `day_number` is optional and purely for grouping
-- pins under a day in the UI — it is NOT the draw order, because several
-- pins can share one day and a pin can belong to no particular day.
-- Intentionally not UNIQUE(tour_id, seq): reordering would otherwise need a
-- two-phase shuffle to dodge the constraint, which is a 500 waiting to
-- happen. Reads order by seq then id, so ties are stable rather than fatal.
--
-- See the GPS DISCLAIMER in README.md — these are admin-entered planning
-- positions, not surveyed GPX data, and must not be used for navigation.
-- Straight-line distances between consecutive pins are computed on read
-- (see haversineKm in lib/geo.js) and are explicitly NOT trail distance;
-- the real per-day riding distance is tour_days.distance_km.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tour_waypoints (
  id                  INTEGER PRIMARY KEY,
  tour_id             INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  day_number          INTEGER,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'waypoint'
                        CHECK (kind IN ('start','waypoint','pass','viewpoint','overnight','hazard','finish')),
  lat                 REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                 REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  elevation_m         INTEGER,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tour_waypoints_tour ON tour_waypoints(tour_id, seq);

-- ---------------------------------------------------------------------------
-- TOUR_ROUTE_LEGS — the road/trail-following line between two consecutive
-- route pins, as returned by a real routing engine (see lib/routing.js).
--
-- This is what makes the tour map draw an actual trail rather than a
-- straight line between pins: the admin drops pins 1-2-3-4 and the route
-- between them is snapped to the roads and tracks in OpenStreetMap, the
-- way a consumer maps app does it.
--
-- Cached here rather than fetched per page view for three reasons: the
-- public tour page must not depend on a third-party routing service being
-- up, a tour page would otherwise fire one routing request per leg on every
-- single visit (which the public routing instance would rightly throttle),
-- and the geometry is stable until a pin actually moves.
--
-- from_lat/lng and to_lat/lng record the pin positions this leg was
-- computed FROM. That is the cache key: if a pin is dragged, its legs no
-- longer match and get recomputed, rather than leaving a line that silently
-- no longer joins its pins.
--
-- status:
--   'routed'   — a real road/trail route was found; geometry_json holds it
--   'no_route' — the engine could not connect these two points (nothing
--                routable in between). The map falls back to a dashed
--                straight line for this leg and says so.
--   'error'    — the routing service failed or timed out. Same fallback.
--
-- snap_from_m/snap_to_m are how far the engine had to move each endpoint to
-- reach the nearest routable way. A large value means the pin isn't on a
-- mapped road, so the drawn route starts somewhere other than the pin — the
-- admin editor surfaces this so the pin can be nudged onto the trail.
--
-- geometry_json is [[lat,lng], ...], simplified (lib/routing.js) and rounded
-- to 5 decimals — about a metre, far finer than a hand-placed pin — because
-- the raw geometry for one leg can be well over a thousand points.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tour_route_legs (
  id                  INTEGER PRIMARY KEY,
  tour_id             INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  from_waypoint_id    INTEGER NOT NULL REFERENCES tour_waypoints(id) ON DELETE CASCADE,
  to_waypoint_id      INTEGER NOT NULL REFERENCES tour_waypoints(id) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN ('routed','no_route','error')),
  provider            TEXT,
  profile             TEXT,
  distance_m          REAL,
  duration_s          REAL,
  snap_from_m         REAL,
  snap_to_m           REAL,
  from_lat            REAL NOT NULL,
  from_lng            REAL NOT NULL,
  to_lat              REAL NOT NULL,
  to_lng              REAL NOT NULL,
  geometry_json       TEXT,
  error               TEXT,
  computed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_waypoint_id, to_waypoint_id)
);
CREATE INDEX IF NOT EXISTS idx_route_legs_tour ON tour_route_legs(tour_id);

-- ===========================================================================
-- UNIVERSAL ADVENTURE MODEL — additions
--
-- The platform launched mountain-bike-only, and `tours` carried that in its
-- bones: riding_style, distance_km and elevation_gain_m as NOT NULL columns
-- with no notion of what activity a trip even was. Adding trekking by
-- copying the table would have given two tables, two detail templates and
-- two of every query — the duplication the brief specifically rules out.
--
-- The shape used instead: every adventure keeps ONE row in `tours` carrying
-- the universal fields (title, duration, difficulty, price, season, format,
-- accommodation), and anything that only makes sense for one activity lives
-- in activity_data_json, validated per activity by ACTIVITY_FIELDS in
-- backend/lib/adventures.js. A new activity is then a row in
-- `activity_types` plus an entry in that map — no migration, no new table,
-- no second detail page. See README section 4.
--
-- The columns themselves are added by the migration block in db.js, because
-- CREATE TABLE IF NOT EXISTS above will not alter the table that already
-- exists in every deployed database. They are listed here, as comments, so
-- this file still reads as the full picture of the tours table:
--
--   activity, destination_slug, description_full, trip_format,
--   accommodation_type, accommodation_notes, elevation_loss_m, deposit_cents,
--   difficulty_fitness, difficulty_technical, difficulty_altitude,
--   highlights_json, suitability_*, mandatory_charges_json,
--   optional_extras_json, booking_insurance, booking_visa, booking_health,
--   booking_age, activity_data_json, impact_json, faqs_json, published,
--   updated_at
-- ===========================================================================

-- Which activities the site offers, and which are switched on. A new
-- adventure category is enabled by flipping `enabled` here (admin panel ->
-- Activities), not by deploying code: the nav, the finder, the filters and
-- the adventures listing all read this table.
CREATE TABLE IF NOT EXISTS activity_types (
  id            INTEGER PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  -- Plural label for nav and listing headings ("Mountain Biking" vs
  -- "Mountain Bike Adventures"), kept as data so copy changes don't need code.
  plural_label  TEXT,
  summary       TEXT,
  icon          TEXT,
  -- 0 keeps the activity in the data model and the admin panel but hides it
  -- from the public site — how trekking sits until High Route has real
  -- trekking trips to sell, rather than an empty category page.
  enabled       INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Site-wide and per-category FAQs. Separate from tours.faqs_json, which
-- holds the questions specific to one adventure: this is the FAQ page, the
-- destination-page FAQ blocks and the "before you book" questions that are
-- the same whichever trip you pick.
CREATE TABLE IF NOT EXISTS faqs (
  id            INTEGER PRIMARY KEY,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  -- booking | pricing | difficulty | equipment | accommodation | transport
  -- | safety | weather | cancellation | general. Free text rather than a
  -- CHECK so an admin can add a category without a migration; the FAQ page
  -- groups by whatever distinct values exist.
  category      TEXT NOT NULL DEFAULT 'general',
  -- Optional scoping: an FAQ can apply to one activity, one destination, or
  -- (both null) the whole site.
  activity      TEXT,
  destination_slug TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operational impact measurement. One row per departure (or per tour, for
-- things measured at that level), holding what was actually spent and where.
--
-- Deliberately a table of records rather than a few summary columns on
-- `tours`: the Our Impact page's annual figures have to be defensible, and
-- "we spent X with local suppliers in 2026" is only defensible if it is the
-- sum of departures that actually ran. Nothing here is estimated or
-- extrapolated by the code — a field left null reads as "not recorded" on
-- the public page, never as zero.
CREATE TABLE IF NOT EXISTS impact_records (
  id                    INTEGER PRIMARY KEY,
  tour_id               INTEGER REFERENCES tours(id) ON DELETE SET NULL,
  departure_id          INTEGER REFERENCES departures(id) ON DELETE SET NULL,
  -- The year the spending belongs to, for annual reporting. Stored rather
  -- than derived from the departure date so a trip that straddles New Year
  -- can be attributed deliberately.
  year                  INTEGER NOT NULL,
  local_supplier_spend_cents  INTEGER,
  guide_wages_cents           INTEGER,
  local_accommodation_nights  INTEGER,
  community_contribution_cents INTEGER,
  trail_contribution_cents    INTEGER,
  waste_initiatives     TEXT,
  single_use_plastic_notes TEXT,
  transport_km          REAL,
  -- bus | jeep | domestic_flight | mixed | none
  transport_type        TEXT,
  group_size            INTEGER,
  currency              TEXT NOT NULL DEFAULT 'EUR',
  notes                 TEXT,
  recorded_by           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Published annual progress figures for the Our Impact page.
--
-- `evidenced` is the point of this table. A metric with evidenced = 0 is
-- shown as "not yet verified" or withheld entirely rather than printed as a
-- fact — the brief forbids publishing sustainability numbers that cannot be
-- backed up, and a boolean an admin has to tick is a harder thing to fudge
-- than a note in a spreadsheet somewhere.
CREATE TABLE IF NOT EXISTS impact_metrics (
  id            INTEGER PRIMARY KEY,
  year          INTEGER NOT NULL,
  metric_key    TEXT NOT NULL,
  label         TEXT NOT NULL,
  value         TEXT,
  unit          TEXT,
  -- local_economy | community | environment | conservation
  dimension     TEXT NOT NULL DEFAULT 'local_economy',
  notes         TEXT,
  evidenced     INTEGER NOT NULL DEFAULT 0,
  source        TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(year, metric_key)
);

-- Adventure Finder answers, saved only when a visitor explicitly asks for
-- their recommendations by email.
--
-- The finder itself works anonymously and stores nothing: this table is
-- written to only by the optional "email me these" form under the results.
-- `email_status` is 'stored' and not 'sent', because no outbound mail is
-- configured — the row is a real saved lead, and the UI says exactly that
-- rather than claiming an email is on its way. See lib/email.js.
CREATE TABLE IF NOT EXISTS finder_leads (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL,
  activity      TEXT,
  difficulty    TEXT,
  duration      TEXT,
  month         TEXT,
  result_count  INTEGER,
  -- stored | queued | sent | failed
  email_status  TEXT NOT NULL DEFAULT 'stored',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_faqs_category ON faqs(category);
CREATE INDEX IF NOT EXISTS idx_impact_records_year ON impact_records(year);
CREATE INDEX IF NOT EXISTS idx_impact_metrics_year ON impact_metrics(year);

-- ---------------------------------------------------------------------------
-- DESTINATION_IMAGES — the photo gallery on a destination page.
--
-- A separate table rather than another `category` on gallery_images, because
-- that column carries a CHECK constraint ('hero','gallery','guide','tour')
-- and SQLite cannot ALTER a CHECK — widening it means rebuilding the table,
-- which is a far bigger operation than one new table for one new use.
--
-- A destination page also shows the photos from the trips that run there
-- (gallery_images joined through tours.destination_slug), so this table is
-- for images that belong to the PLACE rather than to a trip: the town, the
-- monastery, the airstrip, the valley nobody rides through. Rows here are
-- shown first and the trip photos after, each labelled with where it is from,
-- so the page never implies a trip photo was taken somewhere it was not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS destination_images (
  id             INTEGER PRIMARY KEY,
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  image_url      TEXT NOT NULL,
  caption        TEXT,
  credit         TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_destination_images_dest
  ON destination_images(destination_id, sort_order);

-- ---------------------------------------------------------------------------
-- ENQUIRIES — the Contact page's "ask us a question" form.
--
-- Separate from custom_requests on purpose. A custom request is a trip being
-- designed: it needs an account, it moves through a proposal pipeline, it
-- ends in a booking. An enquiry is a question — "is the October Mustang
-- departure suitable for a first trip at altitude?" — from somebody who has
-- not signed up and should not have to in order to ask it.
--
-- `email_status` is 'stored', never 'sent': no outbound mail is configured,
-- and the form says so rather than implying a reply is already on its way.
-- An admin replies from their own mailbox and marks the row replied.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enquiries (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  topic           TEXT NOT NULL DEFAULT 'trip' CHECK (topic IN ('trip','booking','other')),
  tour_id         INTEGER REFERENCES tours(id) ON DELETE SET NULL,
  departure_id    INTEGER REFERENCES departures(id) ON DELETE SET NULL,
  preferred_date  TEXT,
  travellers      INTEGER,
  requirements    TEXT,
  message         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','replied','closed')),
  admin_note      TEXT,
  email_status    TEXT NOT NULL DEFAULT 'stored',
  ip              TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_enquiries_status ON enquiries(status, created_at);
