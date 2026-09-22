'use strict';
const { all, get, run, transaction } = require('../db');
const { ok, created, badRequest, notFound, unauthorized, newToken } = require('../lib/util');
const { requireAdmin, requireAuth, sessionFromRequest } = require('../lib/auth');
const { notifyAdmins, notifyRider } = require('../lib/notifications');
const { logRequestEvent } = require('../lib/requestAudit');
const { computeEndDate } = require('./departures');
const { bookingReference, priceAddons, validateRider } = require('./bookings');

const PROPOSAL_TERMINAL = ['declined', 'expired', 'withdrawn', 'superseded'];
// A proposal still awaiting a customer's first response, or one they've
// already asked changes on — either can be superseded by a fresh version.
const SUPERSEDABLE = ['sent', 'approved', 'changes_requested'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function money(cents) { return Math.round(Number(cents) || 0); }

/** Once a custom_requests row has a booking_id, its proposal is frozen —
 *  real money and a real departure now exist against those exact terms.
 *  Returns an error message string to reject with, or null if it's fine to
 *  proceed. Called at the top of every proposal-mutating admin endpoint
 *  (create new version, edit, send, withdraw). */
function lockedMessage(reqRow) {
  if (!reqRow.booking_id) return null;
  return `This request already has a confirmed booking (${bookingReference(reqRow.booking_id)}) — manage dates/guide from the Departures tab and payments from the Bookings tab instead of editing the proposal.`;
}

/** Creates the real departures + bookings rows for a custom trip the moment
 *  its deposit is paid (see the booking_id comment on custom_requests in
 *  schema.sql) — from then on the customer's dashboard, trip.html,
 *  invoice.html and the admin's Departures/Bookings tabs all handle it
 *  exactly like a catalogue booking. amountPaidCents is the NEW cumulative
 *  total (after the payment that triggered this), used to decide whether
 *  the booking starts 'deposit_paid' or jumps straight to 'completed'.
 *  riders/addonItems come from custom-checkout.html's real rider-count/
 *  rider-details/add-ons steps (see POST /api/proposals/:id/pay) — every
 *  real rider gets their own booking_riders row and every add-on its own
 *  priced booking_addons row, exactly like a catalogue POST /api/bookings,
 *  so a custom trip's booking is never a second-class, less-detailed one.
 *  Both are optional (falls back to a single lead-rider-only row, no
 *  add-ons) for PATCH /api/admin/custom-requests/:id/payment, where an
 *  admin recording a payment made outside the platform isn't expected to
 *  also collect a full rider roster through that same action.
 *  Must run inside the same transaction as the payment that triggers it.
 *  Returns the new booking id, or null if it couldn't be created (missing
 *  tour_id on a legacy pre-dropdown proposal — the payment itself still
 *  succeeds; an admin is notified to fix the link). */
function createBookingForConfirmedProposal(reqRow, proposal, amountPaidCents, riders, addonItems) {
  if (!proposal.tour_id || !proposal.start_date) return null;

  const endDate = computeEndDate(proposal.start_date, proposal.duration_days || 1);
  const hasRealRiders = Array.isArray(riders) && riders.length > 0;
  const riderCount = hasRealRiders ? riders.length : Math.max(1, parseInt(reqRow.group_size, 10) || 1);
  const items = addonItems || [];
  const addonsCents = items.reduce((sum, a) => sum + a.line_total_cents, 0);
  const subtotalCents = proposal.price_cents + addonsCents;
  const depositCents = Math.round(subtotalCents * proposal.deposit_percent / 100);

  const departureId = run(
    `INSERT INTO departures (tour_id, guide_id, start_date, end_date, capacity, seats_booked, status, is_custom, custom_request_id)
     VALUES (?,NULL,?,?,?,?,?,1,?)`,
    [proposal.tour_id, proposal.start_date, endDate, riderCount, riderCount, 'full', reqRow.id]
  ).lastInsertRowid;

  const bookingStatus = amountPaidCents >= subtotalCents ? 'completed' : 'deposit_paid';
  const bookingId = run(
    `INSERT INTO bookings (departure_id, lead_rider_id, access_token, status, addons_json,
                            subtotal_cents, discount_cents, tax_cents, total_cents, deposit_cents, amount_paid_cents,
                            payment_due_at, notes)
     VALUES (?,?,?,?,?,?,0,0,?,?,?,datetime('now'),?)`,
    [departureId, reqRow.rider_id, newToken(), bookingStatus, JSON.stringify(items.map(a => a.addon_key)),
     subtotalCents, subtotalCents, depositCents, amountPaidCents, `Custom trip — request #${reqRow.id}, proposal v${proposal.version}.`]
  ).lastInsertRowid;

  if (hasRealRiders) {
    riders.forEach((r, i) => {
      run(
        `INSERT INTO booking_riders (booking_id, rider_id, name, age, country, riding_experience, bike_info,
                                      emergency_contact_name, emergency_contact_phone, special_requirements, is_lead)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [bookingId, i === 0 ? reqRow.rider_id : null, r.name.trim(), Number(r.age), r.country.trim(), r.ridingExperience.trim(),
         r.bikeInfo.trim(), r.emergencyContactName.trim(), r.emergencyContactPhone.trim(),
         String(r.specialRequirements || '').trim() || null, i === 0 ? 1 : 0]
      );
    });
  } else {
    const rider = get('SELECT * FROM riders WHERE id = ?', [reqRow.rider_id]);
    run(
      `INSERT INTO booking_riders (booking_id, rider_id, name, country, riding_experience, bike_info,
                                    emergency_contact_name, emergency_contact_phone, is_lead)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      [bookingId, rider.id, rider.name, rider.country, rider.riding_experience, rider.bike_info,
       rider.emergency_contact_name, rider.emergency_contact_phone]
    );
  }

  items.forEach(a => {
    run(
      `INSERT INTO booking_addons (booking_id, addon_key, label, unit_price_cents, unit, quantity, line_total_cents)
       VALUES (?,?,?,?,?,?,?)`,
      [bookingId, a.addon_key, a.label, a.unit_price_cents, a.unit, a.quantity, a.line_total_cents]
    );
  });

  run('UPDATE custom_requests SET booking_id = ? WHERE id = ?', [bookingId, reqRow.id]);
  logRequestEvent({
    customRequestId: reqRow.id, proposalId: proposal.id, eventType: 'booking_created', actorType: 'system',
    message: `Departure and booking ${bookingReference(bookingId)} created for ${proposal.start_date} → ${endDate}` +
      `${hasRealRiders ? ` with ${riderCount} rider(s)` : ''}${items.length ? ` and ${items.length} add-on(s)` : ''}.`,
  });
  return bookingId;
}

/** Every proposal is built from a real catalogue tour (see
 *  validateProposalFields/resolveTour below) — this attaches a small
 *  reference object {id, slug, name, image_url, region} for the frontend to
 *  link back to the tour or show its thumbnail, alongside the proposal's own
 *  denormalized `destination` text. `tour` is null only for a legacy
 *  proposal created before this field existed, or one whose tour was since
 *  deleted — its own destination/itinerary text still stands on its own. */
function parseProposal(p) {
  if (!p) return p;
  const depositCents = Math.round(p.price_cents * p.deposit_percent / 100);
  const tour = p.tour_id ? get('SELECT id, slug, name, image_url, region FROM tours WHERE id = ?', [p.tour_id]) : null;
  return {
    ...p,
    inclusions: JSON.parse(p.inclusions_json),
    exclusions: JSON.parse(p.exclusions_json),
    deposit_cents: depositCents,
    tour,
  };
}

/** Enriches a custom_requests row with its active proposal (parsed) if any
 *  — shared by both routes/customRequests.js listings so admin and rider
 *  views never drift apart on what "the current proposal" looks like. */
function withActiveProposal(reqRow) {
  const proposal = reqRow.active_proposal_id
    ? get('SELECT * FROM custom_proposals WHERE id = ?', [reqRow.active_proposal_id])
    : null;
  return { ...reqRow, active_proposal: parseProposal(proposal) };
}

/** Flips any 'sent'/'approved' proposal whose expiry date has passed to
 *  'expired', so it can no longer be approved or paid against. Cheap enough
 *  to call at the top of every proposal-touching endpoint (mirrors
 *  expireOverdueBookings in routes/bookings.js), and also run on a timer
 *  from server.js. */
function expireOverdueProposals() {
  const overdue = all(
    `SELECT * FROM custom_proposals WHERE status IN ('sent','approved') AND expires_at IS NOT NULL AND expires_at < date('now')`);
  overdue.forEach(p => {
    run("UPDATE custom_proposals SET status = 'expired' WHERE id = ?", [p.id]);
    logRequestEvent({
      customRequestId: p.custom_request_id, proposalId: p.id, eventType: 'proposal_expired',
      fromStatus: p.status, toStatus: 'expired', actorType: 'system', message: 'Expiry date passed with no response.',
    });
  });
  return overdue.length;
}

function canAccessRequest(req, reqRow) {
  const session = sessionFromRequest(req);
  if (session && session.subject_type === 'admin') return true;
  return !!(session && session.subject_type === 'rider' && reqRow.rider_id === session.subject_id);
}

/** Looks up the tour a proposal is being built from — always a dropdown
 *  selection from the real catalogue (GET /api/tours), never free text, so
 *  a proposal's destination/itinerary is always grounded in a tour that
 *  actually exists. Returns null if tourId wasn't supplied (fine on a
 *  partial edit that isn't changing it), or the tour row if it was and
 *  matched, or false if it was supplied but didn't match anything. */
function resolveTour(tourId) {
  if (tourId == null || tourId === '') return null;
  return get('SELECT id, name FROM tours WHERE id = ?', [Number(tourId)]) || false;
}

/** Validates the admin-supplied proposal fields shared by create + edit.
 *  Returns an array of error strings (empty = valid). */
function validateProposalFields(b, { partial } = {}) {
  const errors = [];
  if (!partial && !b.tourId) errors.push('tourId is required — pick the base tour from the dropdown');
  if (!partial || b.priceCents !== undefined) {
    if (!(Number(b.priceCents) > 0)) errors.push('priceCents must be a positive number');
  }
  if (b.durationDays !== undefined && b.durationDays !== null && !(Number.isInteger(Number(b.durationDays)) && b.durationDays > 0)) {
    errors.push('durationDays must be a positive whole number');
  }
  if (b.depositPercent !== undefined && b.depositPercent !== null) {
    const dp = Number(b.depositPercent);
    if (!(Number.isInteger(dp) && dp >= 1 && dp <= 100)) errors.push('depositPercent must be a whole number between 1 and 100');
  }
  if (b.startDate && !DATE_RE.test(b.startDate)) errors.push('startDate must be an ISO date (YYYY-MM-DD)');
  if (b.expiresAt && !DATE_RE.test(b.expiresAt)) errors.push('expiresAt must be an ISO date (YYYY-MM-DD)');
  if (b.inclusions !== undefined && !Array.isArray(b.inclusions)) errors.push('inclusions must be an array of strings');
  if (b.exclusions !== undefined && !Array.isArray(b.exclusions)) errors.push('exclusions must be an array of strings');
  return errors;
}

function register(router) {
  // ---------------------------------------------------------------------
  // ADMIN — create / edit / send / withdraw a proposal.
  // ---------------------------------------------------------------------

  // POST /api/admin/custom-requests/:id/proposals — creates a new draft
  // version. Blocked while an unsent draft already exists (edit it via
  // PATCH instead); supersedes a prior sent/approved/changes_requested
  // version so only one proposal is ever "active" at a time.
  router.post('/api/admin/custom-requests/:id/proposals', requireAdmin((req, res) => {
    const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [Number(req.params.id)]);
    if (!reqRow) return notFound(res, 'Request not found');
    const lockMsg = lockedMessage(reqRow);
    if (lockMsg) return badRequest(res, lockMsg);

    const current = reqRow.active_proposal_id ? get('SELECT * FROM custom_proposals WHERE id = ?', [reqRow.active_proposal_id]) : null;
    if (current && current.status === 'draft') {
      return badRequest(res, 'An unsent draft proposal already exists for this request — edit or send it instead of creating another.');
    }

    const b = req.body || {};
    const errors = validateProposalFields(b);
    if (errors.length) return badRequest(res, errors.join('; '));
    const tour = resolveTour(b.tourId);
    if (tour === false) return badRequest(res, 'Selected tour not found');

    const nextVersion = get('SELECT COALESCE(MAX(version), 0) v FROM custom_proposals WHERE custom_request_id = ?', [reqRow.id]).v + 1;

    const proposalId = transaction(() => {
      if (current && SUPERSEDABLE.includes(current.status)) {
        run("UPDATE custom_proposals SET status = 'superseded' WHERE id = ?", [current.id]);
        logRequestEvent({
          customRequestId: reqRow.id, proposalId: current.id, eventType: 'proposal_superseded',
          fromStatus: current.status, toStatus: 'superseded', actorType: 'admin', actorId: req.session.subject_id,
          message: 'Superseded by a new proposal version.',
        });
      }
      const newId = run(
        `INSERT INTO custom_proposals (custom_request_id, version, tour_id, destination, start_date, duration_days, riding_details,
                                        accommodation, transport, price_cents, currency, deposit_percent,
                                        inclusions_json, exclusions_json, expires_at, notes, status, created_by_admin_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
        [reqRow.id, nextVersion, tour.id, tour.name, b.startDate || null, b.durationDays ? Number(b.durationDays) : null,
         b.ridingDetails || null, b.accommodation || null, b.transport || null, money(b.priceCents), b.currency || 'EUR',
         b.depositPercent ? Number(b.depositPercent) : 20, JSON.stringify(b.inclusions || []), JSON.stringify(b.exclusions || []),
         b.expiresAt || null, b.notes || null, req.session.subject_id]
      ).lastInsertRowid;
      run('UPDATE custom_requests SET active_proposal_id = ? WHERE id = ?', [newId, reqRow.id]);
      logRequestEvent({
        customRequestId: reqRow.id, proposalId: newId, eventType: 'proposal_created',
        toStatus: 'draft', actorType: 'admin', actorId: req.session.subject_id, message: `Version ${nextVersion} drafted.`,
      });
      return newId;
    });

    created(res, parseProposal(get('SELECT * FROM custom_proposals WHERE id = ?', [proposalId])));
  }));

  // PATCH /api/admin/proposals/:id — edits a still-draft proposal in place.
  // Once sent, a proposal is frozen — see the schema.sql comment on why.
  router.patch('/api/admin/proposals/:id', requireAdmin((req, res) => {
    const proposal = get('SELECT * FROM custom_proposals WHERE id = ?', [Number(req.params.id)]);
    if (!proposal) return notFound(res, 'Proposal not found');
    if (proposal.status !== 'draft') return badRequest(res, `This proposal is already ${proposal.status} and can no longer be edited — create a new version instead.`);
    const lockMsgEdit = lockedMessage(get('SELECT booking_id FROM custom_requests WHERE id = ?', [proposal.custom_request_id]));
    if (lockMsgEdit) return badRequest(res, lockMsgEdit);

    const b = req.body || {};
    const errors = validateProposalFields(b, { partial: true });
    if (errors.length) return badRequest(res, errors.join('; '));
    const tour = b.tourId !== undefined ? resolveTour(b.tourId) : null;
    if (tour === false) return badRequest(res, 'Selected tour not found');

    run(
      `UPDATE custom_proposals SET
         tour_id = COALESCE(?, tour_id), destination = COALESCE(?, destination),
         start_date = COALESCE(?, start_date), duration_days = COALESCE(?, duration_days),
         riding_details = COALESCE(?, riding_details), accommodation = COALESCE(?, accommodation), transport = COALESCE(?, transport),
         price_cents = COALESCE(?, price_cents), currency = COALESCE(?, currency), deposit_percent = COALESCE(?, deposit_percent),
         inclusions_json = COALESCE(?, inclusions_json), exclusions_json = COALESCE(?, exclusions_json),
         expires_at = COALESCE(?, expires_at), notes = COALESCE(?, notes)
       WHERE id = ?`,
      [tour ? tour.id : null, tour ? tour.name : null, b.startDate || null, b.durationDays ? Number(b.durationDays) : null,
       b.ridingDetails !== undefined ? b.ridingDetails : null, b.accommodation !== undefined ? b.accommodation : null,
       b.transport !== undefined ? b.transport : null, b.priceCents ? money(b.priceCents) : null, b.currency || null,
       b.depositPercent ? Number(b.depositPercent) : null, b.inclusions ? JSON.stringify(b.inclusions) : null,
       b.exclusions ? JSON.stringify(b.exclusions) : null, b.expiresAt || null, b.notes !== undefined ? b.notes : null,
       proposal.id]
    );
    logRequestEvent({
      customRequestId: proposal.custom_request_id, proposalId: proposal.id, eventType: 'proposal_edited',
      actorType: 'admin', actorId: req.session.subject_id, message: `Draft version ${proposal.version} edited.`,
    });
    ok(res, parseProposal(get('SELECT * FROM custom_proposals WHERE id = ?', [proposal.id])));
  }));

  // POST /api/admin/proposals/:id/send — draft -> sent. Notifies the
  // customer and moves the parent request into the 'proposal_sent' stage.
  router.post('/api/admin/proposals/:id/send', requireAdmin((req, res) => {
    const proposal = get('SELECT * FROM custom_proposals WHERE id = ?', [Number(req.params.id)]);
    if (!proposal) return notFound(res, 'Proposal not found');
    if (proposal.status !== 'draft') return badRequest(res, `Only a draft proposal can be sent (this one is ${proposal.status}).`);
    const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [proposal.custom_request_id]);
    const lockMsgSend = lockedMessage(reqRow);
    if (lockMsgSend) return badRequest(res, lockMsgSend);
    if (!reqRow.rider_id) {
      return badRequest(res, 'This request has no linked rider account — the customer must be signed in under the account used for this request before a proposal can be approved or paid. Ask them to sign in and resubmit, or link the account manually.');
    }
    // A start date is required before sending, not just recommended — the
    // moment the customer pays their deposit, that date becomes a real
    // departure (see createBookingForConfirmedProposal below), so it can't
    // be missing by the time approval/payment is even possible.
    if (!proposal.start_date) {
      return badRequest(res, 'Set a start date before sending — it becomes the real departure date once the customer pays their deposit.');
    }

    transaction(() => {
      run("UPDATE custom_proposals SET status = 'sent', sent_at = datetime('now') WHERE id = ?", [proposal.id]);
      run("UPDATE custom_requests SET status = 'proposal_sent', updated_at = datetime('now') WHERE id = ?", [reqRow.id]);
      logRequestEvent({
        customRequestId: reqRow.id, proposalId: proposal.id, eventType: 'proposal_sent',
        fromStatus: reqRow.status, toStatus: 'proposal_sent', actorType: 'admin', actorId: req.session.subject_id,
      });
    });
    notifyRider(reqRow.rider_id, {
      type: 'proposal_sent', title: 'Your custom trip proposal is ready',
      body: `A ${proposal.duration_days || '?'}-day ${proposal.destination} proposal is ready to review — ${(proposal.price_cents / 100).toLocaleString()} ${proposal.currency}.`,
      linkUrl: 'dashboard.html', customRequestId: reqRow.id,
    });
    ok(res, parseProposal(get('SELECT * FROM custom_proposals WHERE id = ?', [proposal.id])));
  }));

  // POST /api/admin/proposals/:id/withdraw — pulls back a sent/approved/
  // changes_requested offer (e.g. it was sent in error, or terms changed).
  // Drops the parent request back to 'contacted' since no offer is live.
  router.post('/api/admin/proposals/:id/withdraw', requireAdmin((req, res) => {
    const proposal = get('SELECT * FROM custom_proposals WHERE id = ?', [Number(req.params.id)]);
    if (!proposal) return notFound(res, 'Proposal not found');
    if (!SUPERSEDABLE.includes(proposal.status)) return badRequest(res, `This proposal is ${proposal.status} and can't be withdrawn.`);
    const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [proposal.custom_request_id]);
    // Critical guard: once a deposit's been paid, a real departure/booking
    // exists against this proposal's exact terms — withdrawing it here would
    // orphan that payment with no live offer behind it. Cancel the booking
    // itself (Bookings tab) if the trip is really off; that path already
    // computes a proper refund entitlement, which withdrawal never did.
    const lockMsgWithdraw = lockedMessage(reqRow);
    if (lockMsgWithdraw) return badRequest(res, lockMsgWithdraw);

    transaction(() => {
      run("UPDATE custom_proposals SET status = 'withdrawn' WHERE id = ?", [proposal.id]);
      run("UPDATE custom_requests SET status = 'contacted', updated_at = datetime('now') WHERE id = ?", [reqRow.id]);
      logRequestEvent({
        customRequestId: reqRow.id, proposalId: proposal.id, eventType: 'proposal_withdrawn',
        fromStatus: proposal.status, toStatus: 'withdrawn', actorType: 'admin', actorId: req.session.subject_id,
        message: (req.body || {}).reason || null,
      });
    });
    if (reqRow.rider_id) {
      notifyRider(reqRow.rider_id, {
        type: 'proposal_withdrawn', title: 'A proposal was withdrawn',
        body: `The ${proposal.destination} proposal was withdrawn by our team — we'll follow up with an updated one.`,
        linkUrl: 'dashboard.html', customRequestId: reqRow.id,
      });
    }
    ok(res, parseProposal(get('SELECT * FROM custom_proposals WHERE id = ?', [proposal.id])));
  }));

  // GET /api/custom-requests/:id/proposals — full version history, oldest
  // first. Available to the owning rider or an admin (see canAccessRequest).
  router.get('/api/custom-requests/:id/proposals', (req, res) => {
    const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [Number(req.params.id)]);
    if (!reqRow) return notFound(res, 'Request not found');
    if (!canAccessRequest(req, reqRow)) return unauthorized(res, 'Sign in as this request\'s owner, or as an admin, to view its proposals');
    const session = sessionFromRequest(req);
    const isAdmin = session && session.subject_type === 'admin';
    let rows = all('SELECT * FROM custom_proposals WHERE custom_request_id = ? ORDER BY version ASC', [reqRow.id]);
    // A 'draft' is admin-only work-in-progress — never shown to the customer
    // until it's sent, same rule as the active_proposal enrichment in
    // routes/customRequests.js.
    if (!isAdmin) rows = rows.filter(p => p.status !== 'draft');
    ok(res, { count: rows.length, proposals: rows.map(parseProposal) });
  });

  // ---------------------------------------------------------------------
  // CUSTOMER — approve / decline / request changes / pay the deposit.
  // Every action below requires a signed-in rider who owns the parent
  // request — an admin can't approve on a customer's behalf, and a rider
  // can't act on someone else's request even if they guess the proposal id.
  // ---------------------------------------------------------------------
  function loadOwnedProposal(req, res) {
    const proposal = get('SELECT * FROM custom_proposals WHERE id = ?', [Number(req.params.id)]);
    if (!proposal) { notFound(res, 'Proposal not found'); return null; }
    const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [proposal.custom_request_id]);
    if (!reqRow || reqRow.rider_id !== req.session.subject_id) {
      unauthorized(res, 'You can only respond to a proposal made against your own request');
      return null;
    }
    return { proposal, reqRow };
  }

  router.post('/api/proposals/:id/approve', requireAuth('rider', (req, res) => {
    expireOverdueProposals();
    const loaded = loadOwnedProposal(req, res);
    if (!loaded) return;
    const { proposal, reqRow } = loaded;
    if (proposal.status !== 'sent') return badRequest(res, `This proposal is ${proposal.status} and can no longer be approved.`);

    transaction(() => {
      run("UPDATE custom_proposals SET status = 'approved', responded_at = datetime('now') WHERE id = ?", [proposal.id]);
      run("UPDATE custom_requests SET status = 'approved', updated_at = datetime('now') WHERE id = ?", [reqRow.id]);
      logRequestEvent({
        customRequestId: reqRow.id, proposalId: proposal.id, eventType: 'proposal_approved',
        fromStatus: 'proposal_sent', toStatus: 'approved', actorType: 'rider', actorId: req.session.subject_id,
      });
    });
    notifyAdmins({
      type: 'proposal_approved', title: 'A customer approved a proposal',
      body: `${reqRow.name || reqRow.email || 'A customer'} approved the ${proposal.destination} proposal (v${proposal.version}) — awaiting deposit.`,
      linkUrl: 'admin.html', customRequestId: reqRow.id,
    });
    ok(res, parseProposal(get('SELECT * FROM custom_proposals WHERE id = ?', [proposal.id])));
  }));

  router.post('/api/proposals/:id/decline', requireAuth('rider', (req, res) => {
    expireOverdueProposals();
    const loaded = loadOwnedProposal(req, res);
    if (!loaded) return;
    const { proposal, reqRow } = loaded;
    if (proposal.status !== 'sent') return badRequest(res, `This proposal is ${proposal.status} and can no longer be declined.`);
    const reason = String((req.body || {}).reason || '').trim() || null;

    transaction(() => {
      run("UPDATE custom_proposals SET status = 'declined', responded_at = datetime('now'), customer_response_message = ? WHERE id = ?", [reason, proposal.id]);
      run("UPDATE custom_requests SET status = 'declined', updated_at = datetime('now') WHERE id = ?", [reqRow.id]);
      logRequestEvent({
        customRequestId: reqRow.id, proposalId: proposal.id, eventType: 'proposal_declined',
        fromStatus: 'proposal_sent', toStatus: 'declined', actorType: 'rider', actorId: req.session.subject_id, message: reason,
      });
    });
    notifyAdmins({
      type: 'proposal_declined', title: 'A customer declined a proposal',
      body: `${reqRow.name || reqRow.email || 'A customer'} declined the ${proposal.destination} proposal (v${proposal.version})${reason ? ': ' + reason : '.'}`,
      linkUrl: 'admin.html', customRequestId: reqRow.id,
    });
    ok(res, parseProposal(get('SELECT * FROM custom_proposals WHERE id = ?', [proposal.id])));
  }));

  router.post('/api/proposals/:id/request-changes', requireAuth('rider', (req, res) => {
    expireOverdueProposals();
    const loaded = loadOwnedProposal(req, res);
    if (!loaded) return;
    const { proposal, reqRow } = loaded;
    if (proposal.status !== 'sent') return badRequest(res, `This proposal is ${proposal.status} — changes can only be requested on a proposal awaiting review.`);
    const message = String((req.body || {}).message || '').trim();
    if (!message) return badRequest(res, 'Describe what you\'d like changed');

    transaction(() => {
      run("UPDATE custom_proposals SET status = 'changes_requested', responded_at = datetime('now'), customer_response_message = ? WHERE id = ?", [message, proposal.id]);
      logRequestEvent({
        customRequestId: reqRow.id, proposalId: proposal.id, eventType: 'proposal_changes_requested',
        fromStatus: 'sent', toStatus: 'changes_requested', actorType: 'rider', actorId: req.session.subject_id, message,
      });
    });
    notifyAdmins({
      type: 'proposal_changes_requested', title: 'A customer requested changes',
      body: `${reqRow.name || reqRow.email || 'A customer'} asked for changes to the ${proposal.destination} proposal (v${proposal.version}): ${message}`,
      linkUrl: 'admin.html', customRequestId: reqRow.id,
    });
    ok(res, parseProposal(get('SELECT * FROM custom_proposals WHERE id = ?', [proposal.id])));
  }));

  // POST /api/proposals/:id/pay — pays some or all of what's still owed on
  // an approved proposal: the initial deposit, and — once the deposit is
  // met — the remaining balance, up to the proposal's full price_cents.
  // proposal.status stays 'approved' for the whole payment lifecycle (only
  // custom_requests.status advances deposit -> confirmed as money comes in),
  // so this endpoint stays open the entire time, capped by the full price
  // rather than the deposit alone — capping at the deposit was the original
  // bug that made a balance payment impossible after the deposit was paid.
  // No real payment gateway exists in this demo (see the identical note on
  // POST /api/bookings/:id/pay) — any well-formed card is accepted and the
  // amount is recorded immediately.
  router.post('/api/proposals/:id/pay', requireAuth('rider', (req, res) => {
    expireOverdueProposals();
    const loaded = loadOwnedProposal(req, res);
    if (!loaded) return;
    const { proposal, reqRow } = loaded;
    if (proposal.status !== 'approved') {
      return badRequest(res, proposal.status === 'expired' || proposal.status === 'withdrawn'
        ? `This proposal was ${proposal.status} and can no longer be paid against.`
        : `Approve this proposal before paying its deposit (it is currently ${proposal.status}).`);
    }
    // Once the deposit's been paid, a real booking exists and owns payment
    // from here on (its own amount_paid_cents, not this row's) — see
    // createBookingForConfirmedProposal. Paying through this endpoint
    // afterwards would silently drift the two figures apart.
    if (reqRow.booking_id) {
      return badRequest(res, `This trip is already booked (${bookingReference(reqRow.booking_id)}) — pay any remaining balance from "Your bookings" on your dashboard instead.`);
    }

    // custom-checkout.html always submits the real rider roster (and any
    // add-ons) together with this one deliberate deposit charge — this is
    // the only place a custom trip's actual rider count/details/add-ons
    // ever get collected, mirroring the catalogue POST /api/bookings flow
    // (rider count -> rider details -> add-ons -> review -> confirm). A
    // balance payment never reaches this far (reqRow.booking_id is already
    // set by then, rejected above), so riders are always required here.
    const b = req.body || {};
    if (!Array.isArray(b.riders) || !b.riders.length) {
      return badRequest(res, 'riders are required to confirm this trip — see custom-checkout.html.');
    }
    const riderErrors = b.riders.flatMap(validateRider);
    if (riderErrors.length) return badRequest(res, riderErrors.join('; '));
    const riders = b.riders;
    const addonItems = priceAddons(b.addons, riders.length);
    const addonsCents = addonItems.reduce((sum, a) => sum + a.line_total_cents, 0);
    const fullTotalCents = proposal.price_cents + addonsCents;
    const depositCents = Math.round(fullTotalCents * proposal.deposit_percent / 100);
    const alreadyPaid = reqRow.amount_paid_cents;
    // Every pre-booking payment charges exactly what's still owed toward the
    // deposit in one deliberate step — custom-checkout.html's whole point is
    // reviewing the full price (base + add-ons) before that one charge, not
    // incremental partial payments against a booking that doesn't exist yet.
    const amount = depositCents - alreadyPaid;
    if (!(amount > 0)) return badRequest(res, 'This proposal has already been paid in full.');

    const card = b.card || {};
    const cardNumber = String(card.number || '').replace(/[\s-]+/g, '');
    if (!/^\d{13,19}$/.test(cardNumber)) return badRequest(res, 'Enter a valid card number');
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(String(card.expiry || '').trim())) return badRequest(res, 'Enter a valid expiry date (MM/YY)');
    if (!/^\d{3,4}$/.test(String(card.cvv || '').trim())) return badRequest(res, 'Enter a valid CVV');

    const newPaidTotal = alreadyPaid + amount;
    // The deposit threshold being met is what turns this from "a paid
    // promise" into a real, scheduled trip — see createBookingForConfirmed
    // Proposal's own comment. Always true here (amount was computed to
    // exactly reach it), kept explicit for clarity.
    const depositMetNow = newPaidTotal >= depositCents;
    const newStatus = depositMetNow ? 'confirmed' : reqRow.status;

    const bookingId = transaction(() => {
      run('INSERT INTO custom_request_payments (custom_request_id, proposal_id, amount_cents, currency, card_last4) VALUES (?,?,?,?,?)',
        [reqRow.id, proposal.id, amount, proposal.currency, cardNumber.slice(-4)]);
      run('UPDATE custom_requests SET amount_paid_cents = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [newPaidTotal, newStatus, reqRow.id]);
      logRequestEvent({
        customRequestId: reqRow.id, proposalId: proposal.id, eventType: 'payment_recorded',
        fromStatus: reqRow.status, toStatus: newStatus !== reqRow.status ? newStatus : null,
        actorType: 'rider', actorId: req.session.subject_id,
        message: `Paid ${(amount / 100).toFixed(2)} ${proposal.currency} toward the deposit for ${riders.length} rider(s)${addonItems.length ? ` and ${addonItems.length} add-on(s)` : ''}.`,
      });
      return (depositMetNow && !reqRow.booking_id) ? createBookingForConfirmedProposal(reqRow, proposal, newPaidTotal, riders, addonItems) : null;
    });
    const receiptNote = `${(amount / 100).toFixed(2)} ${proposal.currency} received toward the ${proposal.destination} deposit` +
      `, ${((fullTotalCents - newPaidTotal) / 100).toFixed(2)} ${proposal.currency} remaining.`;
    notifyAdmins({
      type: 'payment_recorded', title: 'Payment received', body: `${reqRow.name || reqRow.email || 'A customer'}: ${receiptNote}`,
      linkUrl: 'admin.html', customRequestId: reqRow.id,
    });
    notifyRider(reqRow.rider_id, {
      type: 'payment_recorded', title: 'Payment received',
      body: receiptNote + (bookingId ? ` Your trip is booked — view it under "Your bookings" (${bookingReference(bookingId)}).` : ''),
      linkUrl: 'dashboard.html', customRequestId: reqRow.id,
    });

    ok(res, {
      amount_paid_cents: newPaidTotal, deposit_cents: depositCents, price_cents: fullTotalCents,
      balance_due_cents: fullTotalCents - newPaidTotal,
      status: newStatus, receipt: { last4: cardNumber.slice(-4), amount_cents: amount },
      booking_id: bookingId,
    });
  }));

  // PATCH /api/admin/custom-requests/:id/payment  { amountCents } — admin-
  // recorded payment (cash, bank transfer, a card charged over the phone —
  // whatever channel was actually used). Mirrors PATCH
  // /api/bookings/:id/payment: in a real deployment this is what a payment
  // gateway's webhook confirms, not something a rider's own browser should
  // trigger directly. Same deposit -> confirmed advancement rule as the
  // rider-facing pay endpoint above.
  router.patch('/api/admin/custom-requests/:id/payment', requireAdmin((req, res) => {
    const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [Number(req.params.id)]);
    if (!reqRow) return notFound(res, 'Request not found');
    if (!reqRow.active_proposal_id) return badRequest(res, 'This request has no proposal to record a payment against.');
    const proposal = get('SELECT * FROM custom_proposals WHERE id = ?', [reqRow.active_proposal_id]);
    if (proposal.status !== 'approved') return badRequest(res, `The active proposal is ${proposal.status}, not approved — no payment can be recorded against it.`);
    // Same rule as the rider-facing pay endpoint: once booked, the booking's
    // own PATCH /api/bookings/:id/payment is the one true payment path.
    if (reqRow.booking_id) {
      return badRequest(res, `This trip is already booked (${bookingReference(reqRow.booking_id)}) — record further payments against the booking from the Bookings tab instead.`);
    }

    const amount = Math.round(Number((req.body || {}).amountCents || 0));
    if (!(amount > 0)) return badRequest(res, 'amountCents must be a positive number');
    const totalDue = proposal.price_cents - reqRow.amount_paid_cents;
    if (amount > totalDue) return badRequest(res, 'That amount is more than the remaining balance of ' + totalDue + ' cents');

    const depositCents = Math.round(proposal.price_cents * proposal.deposit_percent / 100);
    const newPaidTotal = reqRow.amount_paid_cents + amount;
    const depositMetNow = newPaidTotal >= depositCents;
    const newStatus = depositMetNow ? 'confirmed' : reqRow.status;

    const bookingId = transaction(() => {
      run('INSERT INTO custom_request_payments (custom_request_id, proposal_id, amount_cents, currency, card_last4) VALUES (?,?,?,?,?)',
        [reqRow.id, proposal.id, amount, proposal.currency, null]);
      run('UPDATE custom_requests SET amount_paid_cents = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [newPaidTotal, newStatus, reqRow.id]);
      logRequestEvent({
        customRequestId: reqRow.id, proposalId: proposal.id, eventType: 'payment_recorded',
        fromStatus: reqRow.status, toStatus: newStatus !== reqRow.status ? newStatus : null,
        actorType: 'admin', actorId: req.session.subject_id,
        message: `Recorded ${(amount / 100).toFixed(2)} ${proposal.currency} received outside the platform.`,
      });
      return (depositMetNow && !reqRow.booking_id) ? createBookingForConfirmedProposal(reqRow, proposal, newPaidTotal) : null;
    });
    if (reqRow.rider_id) {
      notifyRider(reqRow.rider_id, {
        type: 'payment_recorded', title: 'Payment recorded',
        body: `We recorded ${(amount / 100).toFixed(2)} ${proposal.currency} toward your ${proposal.destination} trip.` +
          (bookingId ? ` Your trip is booked — view it under "Your bookings" (${bookingReference(bookingId)}).` : ''),
        linkUrl: 'dashboard.html', customRequestId: reqRow.id,
      });
    }
    ok(res, { amount_paid_cents: newPaidTotal, status: newStatus, booking_id: bookingId });
  }));
}

module.exports = { register, expireOverdueProposals, parseProposal, withActiveProposal };
