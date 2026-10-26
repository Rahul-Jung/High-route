'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound, unauthorized, forbidden, isIsoDate, validateNumbers } = require('../lib/util');
const { requireAdmin, requireAuth, sessionFromRequest } = require('../lib/auth');
const { logRequestEvent } = require('../lib/requestAudit');
const { notifyAdmins } = require('../lib/notifications');
const { withActiveProposal } = require('./proposals');
const { bookingReference } = require('./bookings');

const STATUSES = ['new', 'contacted', 'proposal_sent', 'approved', 'deposit', 'confirmed', 'completed', 'declined', 'cancelled'];
// States a requester can still back out of themselves — once an admin has
// moved it to confirmed/completed (or it's already declined/cancelled), the
// dashboard's "Cancel request" button stops being offered.
const RIDER_CANCELLABLE_STATUSES = ['new', 'contacted', 'proposal_sent', 'deposit'];
// The only two stages PATCH /api/admin/custom-requests/:id is allowed to set
// by hand — see the comment on that route for why every other stage is
// locked to the real proposal/payment lifecycle instead.
const ADMIN_MANUAL_STATUSES = ['contacted', 'completed'];

// Shared by both the admin CRM listing and the rider's own listing: turns
// the LEFT JOIN tours columns (aliased tour_*) into a nested based_on_tour
// object, or null if this request isn't linked to a catalogue tour (an old
// pre-dropdown request, or one someone submitted before signing in ever
// resolved a tour). Keeps the flat tour_* columns out of the response.
function attachTourInfo(row) {
  const { tour_name, tour_slug, tour_image_url, tour_duration_days, tour_difficulty_level,
          tour_price_from_cents, tour_currency, tour_region, tour_summary, ...rest } = row;
  return {
    ...rest,
    based_on_tour: row.tour_id && tour_name ? {
      id: row.tour_id, name: tour_name, slug: tour_slug, image_url: tour_image_url,
      duration_days: tour_duration_days, difficulty_level: tour_difficulty_level,
      price_from_cents: tour_price_from_cents, currency: tour_currency, region: tour_region, summary: tour_summary,
    } : null,
  };
}
const TOUR_JOIN = `LEFT JOIN tours t ON t.id = cr.tour_id`;
const TOUR_COLS = `t.name AS tour_name, t.slug AS tour_slug, t.image_url AS tour_image_url, t.duration_days AS tour_duration_days,
                    t.difficulty_level AS tour_difficulty_level, t.price_from_cents AS tour_price_from_cents,
                    t.currency AS tour_currency, t.region AS tour_region, t.summary AS tour_summary`;

/** A human-friendly reference for the row's booking, if it has one (see the
 *  booking_id comment on custom_requests in schema.sql) — the frontend uses
 *  its presence to know a confirmed real trip already exists, and its
 *  absence is what still allows proposal editing. */
function attachBookingRef(row) {
  return { ...row, booking_reference: row.booking_id ? bookingReference(row.booking_id) : null };
}

function register(router) {
  // POST /api/custom-requests — from the "Build Your Adventure" wizard.
  // Requires a signed-in rider (the wizard's submit button itself gates on
  // Auth.requireSignIn on the frontend, popping the sign-in modal and resuming
  // the already-filled-out wizard the moment sign-in succeeds) so every lead
  // in the admin CRM is tied to a real account from the start, not just
  // whatever name/email someone typed. destination is only ever picked from
  // the real tour catalogue (a dropdown of GET /api/tours) — tourId is
  // validated against it and its name is what gets stored as destination, so
  // a proposal always starts from an itinerary that actually exists.
  // preferredDate is the customer's own free choice, independent of that
  // tour's fixed departure dates.
  router.post('/api/custom-requests', requireAuth('rider', (req, res) => {
    const b = req.body || {};
    if (b.preferredDate && !isIsoDate(b.preferredDate)) return badRequest(res, 'preferredDate must be a real date in YYYY-MM-DD form');
    const nums = validateNumbers({
      tourId: [b.tourId, { min: 1 }],
      groupSize: [b.groupSize, { min: 1, max: 100 }],
    });
    if (nums.error) return badRequest(res, nums.error);

    let tour = null;
    if (nums.values.tourId !== null) {
      tour = get('SELECT id, name FROM tours WHERE id = ?', [nums.values.tourId]);
      if (!tour) return badRequest(res, 'Selected tour not found');
    }

    // Name and email come from the authenticated account, never the request
    // body. They used to be client-supplied (and `email` was even *required*,
    // on an endpoint that already knows exactly who is calling it), so a
    // signed-in rider could file a request under anyone else's address — and
    // the CRM then displayed that address next to the real account's, with no
    // indication of which one was true. Same fix that POST /api/bookings got
    // for its lead rider; this endpoint was simply missed at the time.
    // The Private Trips page's extra fields (see migration 003). All
    // optional, all validated against the same vocabularies the public site
    // uses, so a request cannot arrive carrying an activity or an
    // accommodation type that does not exist. The build-adventure wizard
    // sends none of them and is unaffected.
    const { isKnownActivity, ACCOMMODATION_TYPES } = require('../lib/adventures');
    const DIFFICULTY_PREFS = ['relaxed', 'active', 'moderate', 'challenging', 'tough', 'no-preference'];
    const CONTACT_PREFS = ['email', 'phone', 'either'];

    if (b.activity && !isKnownActivity(b.activity)) return badRequest(res, 'Unknown activity');
    if (b.difficultyPref && !DIFFICULTY_PREFS.includes(b.difficultyPref)) {
      return badRequest(res, `difficultyPref must be one of: ${DIFFICULTY_PREFS.join(', ')}`);
    }
    if (b.accommodationPref && b.accommodationPref !== 'no-preference'
        && !ACCOMMODATION_TYPES.some(a => a.key === b.accommodationPref)) {
      return badRequest(res, 'Unknown accommodation preference');
    }
    if (b.contactPreference && !CONTACT_PREFS.includes(b.contactPreference)) {
      return badRequest(res, `contactPreference must be one of: ${CONTACT_PREFS.join(', ')}`);
    }
    for (const field of ['dateFrom', 'dateTo']) {
      if (b[field] && !isIsoDate(b[field])) return badRequest(res, `${field} must be a real date in YYYY-MM-DD form`);
    }
    if (b.dateFrom && b.dateTo && b.dateFrom > b.dateTo) {
      return badRequest(res, 'dateFrom cannot be after dateTo');
    }
    const clip = (v, n) => (v ? String(v).trim().slice(0, n) || null : null);

    const riderId = req.session.subject_id;
    const rider = get('SELECT id, name, email FROM riders WHERE id = ?', [riderId]);
    const id = run(
      `INSERT INTO custom_requests (rider_id, tour_id, preferred_date, name, email, destination,
              duration_bucket, riding_style, experience, group_size, budget, preferences_json,
              activity, difficulty_pref, accommodation_pref, special_requirements,
              date_from, date_to, phone, contact_preference, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [riderId, tour ? tour.id : null, b.preferredDate || null, rider.name, rider.email,
       tour ? tour.name : (b.destination || null), b.duration || null, b.style || null,
       // group_size is a TEXT column (see schema.sql), so binding the number
       // 4 stores the string "4.0" — which then shows as "4.0 people" on the
       // CRM board. Every row written before this came from the wizard, which
       // posted a string; the Private Trips form posts a number, which is how
       // this surfaced. Stringify the integer explicitly.
       b.experience || null,
       nums.values.groupSize === null ? null : String(Math.round(nums.values.groupSize)),
       b.budget || null, JSON.stringify(b.preferences || []),
       b.activity || null, b.difficultyPref || null, b.accommodationPref || null,
       clip(b.specialRequirements, 2000), b.dateFrom || null, b.dateTo || null,
       clip(b.phone, 40), b.contactPreference || null, clip(b.source, 40)]
    ).lastInsertRowid;
    logRequestEvent({ customRequestId: id, eventType: 'request_created', toStatus: 'new', actorType: 'rider', actorId: riderId });
    try {
      notifyAdmins({
        type: 'custom_request_new',
        title: 'New private-trip request',
        body: rider.name + ' asked about ' + (tour ? tour.name : (b.destination || 'a custom trip')) + '.',
        linkUrl: 'custom-request.html?id=' + id,
        customRequestId: id,
      });
    } catch (e) { /* best-effort */ }
    created(res, { id, status: 'new', message: 'Request received — a guide will reply within two working days.' });
  }));

  // GET /api/admin/custom-requests?status=new — CRM board, admin only
  router.get('/api/admin/custom-requests', requireAdmin((req, res) => {
    const { status } = req.query;
    let sql = `SELECT cr.*, r.name AS rider_name, r.email AS rider_email, ${TOUR_COLS} FROM custom_requests cr
               LEFT JOIN riders r ON r.id = cr.rider_id ${TOUR_JOIN} WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND cr.status = ?'; params.push(status); }
    sql += ' ORDER BY cr.created_at DESC';
    const rows = all(sql, params).map(r => attachBookingRef(withActiveProposal(attachTourInfo({ ...r, preferences: JSON.parse(r.preferences_json) }))));
    ok(res, { count: rows.length, requests: rows, pipeline_statuses: STATUSES });
  }));

  // GET /api/admin/custom-requests/:id — single request, admin only. Backs
  // the dedicated custom-request.html proposal-builder page, which needs a
  // fresh, single-item fetch (not the whole CRM list) on every page load.
  router.get('/api/admin/custom-requests/:id', requireAdmin((req, res) => {
    const row = get(
      `SELECT cr.*, r.name AS rider_name, r.email AS rider_email, r.phone AS rider_phone, ${TOUR_COLS}
       FROM custom_requests cr LEFT JOIN riders r ON r.id = cr.rider_id ${TOUR_JOIN} WHERE cr.id = ?`,
      [Number(req.params.id)]);
    if (!row) return notFound(res, 'Request not found');
    ok(res, attachBookingRef(withActiveProposal(attachTourInfo({ ...row, preferences: JSON.parse(row.preferences_json) }))));
  }));

  // PATCH /api/admin/custom-requests/:id  { status, internalNotes } — manual
  // admin override, deliberately limited to the two pipeline stages nothing
  // else ever sets automatically: 'contacted' (a lead-tracking note before
  // any proposal exists) and 'completed' (the trip actually happened, after
  // the fact — no system event marks that). Every OTHER stage — proposal_sent/
  // approved/deposit/confirmed/declined — is driven exclusively by the real
  // proposal/payment lifecycle in routes/proposals.js, and 'cancelled' goes
  // through the dedicated POST .../cancel below. Letting an admin hand-pick
  // any of those here used to let a request's status silently disagree with
  // its actual proposal/payment state (e.g. manually marked "declined" while
  // its proposal was in fact approved and paid, with a real booking behind
  // it) — status must always be an honest reflection of what the customer
  // and the proposal actually did, never a free-standing admin opinion.
  router.patch('/api/admin/custom-requests/:id', requireAdmin((req, res) => {
    const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [Number(req.params.id)]);
    if (!reqRow) return notFound(res, 'Request not found');
    const { status, internalNotes } = req.body || {};
    if (status) {
      if (!ADMIN_MANUAL_STATUSES.includes(status)) {
        return badRequest(res, `status can only be manually set to ${ADMIN_MANUAL_STATUSES.join(' or ')} here — every ` +
          `other stage follows automatically from the proposal/payment lifecycle, or from POST /api/custom-requests/:id/cancel.`);
      }
      if (status === 'completed' && !reqRow.booking_id) {
        return badRequest(res, 'Only a request with a confirmed booking can be marked completed.');
      }
    }
    run(`UPDATE custom_requests SET status = COALESCE(?, status), internal_notes = COALESCE(?, internal_notes), updated_at = datetime('now') WHERE id = ?`,
      [status || null, internalNotes || null, reqRow.id]);
    if (status && status !== reqRow.status) {
      logRequestEvent({
        customRequestId: reqRow.id, eventType: 'status_change', fromStatus: reqRow.status, toStatus: status,
        actorType: 'admin', actorId: req.session.subject_id,
      });
    }
    ok(res, attachBookingRef(withActiveProposal(attachTourInfo(get(
      `SELECT cr.*, ${TOUR_COLS} FROM custom_requests cr ${TOUR_JOIN} WHERE cr.id = ?`, [reqRow.id])))));
  }));

  // POST /api/custom-requests/:id/cancel — the requester withdrawing their
  // own lead from their dashboard (or an admin, on their behalf). Once a real
  // booking exists (see the booking_id comment on custom_requests in
  // schema.sql), cancelling HERE would just flip this row to 'cancelled'
  // while the real departure/booking/payment behind it carry on completely
  // untouched — no seats released, no refund computed. That's the booking's
  // own POST /api/bookings/:id/cancel to do instead (it already computes a
  // proper refund entitlement and, per the fix in that route, mirrors its
  // cancellation back onto this row automatically) — same "frozen once
  // real money exists" rule proposals.js's lockedMessage enforces.
  router.post('/api/custom-requests/:id/cancel', (req, res) => {
    const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [Number(req.params.id)]);
    if (!reqRow) return notFound(res, 'Request not found');
    if (reqRow.booking_id) {
      return badRequest(res, `This request already has a confirmed booking (${bookingReference(reqRow.booking_id)}) — cancel it from "Your bookings" (or the admin Bookings tab) instead, which also handles any refund.`);
    }
    const session = sessionFromRequest(req);
    const isAdmin = session && session.subject_type === 'admin';
    const isOwner = session && session.subject_type === 'rider' && reqRow.rider_id === session.subject_id;
    if (!isAdmin && !isOwner) {
      return session
        ? forbidden(res, 'This request belongs to a different account, so you can\'t cancel it.')
        : unauthorized(res, 'Sign in as the requester, or as an admin, to cancel this request');
    }
    if (!isAdmin && !RIDER_CANCELLABLE_STATUSES.includes(reqRow.status)) {
      return badRequest(res, 'This request is already ' + reqRow.status + ' and can no longer be self-cancelled — contact us directly');
    }
    run(`UPDATE custom_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, [reqRow.id]);
    logRequestEvent({
      customRequestId: reqRow.id, eventType: 'status_change', fromStatus: reqRow.status, toStatus: 'cancelled',
      actorType: isAdmin ? 'admin' : 'rider', actorId: session.subject_id,
    });
    ok(res, { cancelled: true });
  });

  // GET /api/admin/custom-requests/:id/events — the full audit trail for a
  // request: every status change and proposal lifecycle event, oldest first.
  router.get('/api/admin/custom-requests/:id/events', requireAdmin((req, res) => {
    const reqRow = get('SELECT id FROM custom_requests WHERE id = ?', [Number(req.params.id)]);
    if (!reqRow) return notFound(res, 'Request not found');
    const rows = all('SELECT * FROM custom_request_events WHERE custom_request_id = ? ORDER BY created_at ASC, id ASC', [reqRow.id]);
    ok(res, { count: rows.length, events: rows });
  }));

  // GET /api/riders/me/requests/:id — a single one of the signed-in rider's
  // own custom requests, owner-checked. Backs custom-trip.html's detail view,
  // which needs a fresh single-item fetch the same way GET
  // /api/admin/custom-requests/:id backs the admin proposal-builder page.
  router.get('/api/riders/me/requests/:id', requireAuth('rider', (req, res) => {
    const row = get(
      `SELECT cr.*, ${TOUR_COLS} FROM custom_requests cr ${TOUR_JOIN} WHERE cr.id = ? AND cr.rider_id = ?`,
      [Number(req.params.id), req.session.subject_id]);
    if (!row) return notFound(res, 'Request not found');
    const enriched = attachBookingRef(withActiveProposal(attachTourInfo({
      ...row, preferences: JSON.parse(row.preferences_json), can_cancel: RIDER_CANCELLABLE_STATUSES.includes(row.status),
    })));
    ok(res, (enriched.active_proposal && enriched.active_proposal.status === 'draft') ? { ...enriched, active_proposal: null } : enriched);
  }));

  // GET /api/riders/me/requests — the signed-in rider's own custom requests.
  router.get('/api/riders/me/requests', requireAuth('rider', (req, res) => {
    const rows = all(
      `SELECT cr.*, ${TOUR_COLS} FROM custom_requests cr ${TOUR_JOIN} WHERE cr.rider_id = ? ORDER BY cr.created_at DESC`,
      [req.session.subject_id])
      .map(r => attachBookingRef(withActiveProposal(attachTourInfo({ ...r, preferences: JSON.parse(r.preferences_json), can_cancel: RIDER_CANCELLABLE_STATUSES.includes(r.status) }))))
      // A 'draft' proposal is an admin work-in-progress, never shown to the
      // customer until sent — see the schema.sql comment on custom_proposals.
      .map(r => (r.active_proposal && r.active_proposal.status === 'draft') ? { ...r, active_proposal: null } : r);
    ok(res, { count: rows.length, requests: rows });
  }));
}

module.exports = { register };
