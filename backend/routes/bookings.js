'use strict';
const { all, get, run, transaction } = require('../db');
const { ok, created, badRequest, notFound, unauthorized, forbidden, newToken, verifyPassword, validateCard } = require('../lib/util');
const { requireAdmin, requireAuth, sessionFromRequest } = require('../lib/auth');
const { evaluatePromoCode } = require('./promo');
const { logRequestEvent } = require('../lib/requestAudit');
const { notifyAdmins } = require('../lib/notifications');
const { paymentConfig, refuseIfPaymentsDisabled } = require('../lib/payments');

// A held-but-unpaid booking has this long to get its deposit recorded before
// it auto-cancels and the seats go back into the pool. Demo-scale value —
// a real deployment would likely make this configurable per tour/season.
const PAYMENT_HOLD_HOURS = 72;

/** A short, human-friendly booking reference for display (invoices, the
 *  confirmation page, customer support calls) — derived from the primary
 *  key rather than stored, since it's guaranteed unique and stable for free. */
function bookingReference(id) {
  return 'HR-' + String(id).padStart(6, '0');
}

/** Recomputes a departure's open/few_spaces/full status from its current
 *  seats_booked, the same way after a cancellation as after a new booking.
 *  Leaves 'cancelled' and 'request_only' alone — those are admin-set, not
 *  capacity-driven. */
function recalcDepartureStatus(departureId) {
  const dep = get('SELECT * FROM departures WHERE id = ?', [departureId]);
  if (!dep || dep.status === 'cancelled' || dep.status === 'request_only') return;
  const status = capacityStatus(dep.capacity, dep.seats_booked);
  if (status !== dep.status) run('UPDATE departures SET status = ? WHERE id = ?', [status, departureId]);
}

/** The single definition of which capacity-driven status a departure should
 *  have. Exported so routes/departures.js can reuse it when an admin reopens a
 *  cancelled date — otherwise that code would have to repeat these thresholds
 *  and could drift out of step with the ones bookings actually apply. */
function capacityStatus(capacity, seatsBooked) {
  const remaining = capacity - seatsBooked;
  return remaining <= 0 ? 'full' : remaining <= 3 ? 'few_spaces' : 'open';
}

/** Releases a cancelled/expired booking's seats back to its departure. */
function releaseSeats(booking) {
  const riderCount = get('SELECT COUNT(*) n FROM booking_riders WHERE booking_id = ?', [booking.id]).n;
  run('UPDATE departures SET seats_booked = MAX(0, seats_booked - ?) WHERE id = ?', [riderCount, booking.departure_id]);
  recalcDepartureStatus(booking.departure_id);
}

/** Auto-cancels any 'pending' (nothing paid yet) booking whose payment hold
 *  has expired, freeing its seats. Cheap (indexed-ish, small table) enough to
 *  call at the top of every booking-list endpoint for demo-instant feedback,
 *  and also run on a timer from server.js so it happens without anyone
 *  loading a page. */
function expireOverdueBookings() {
  const overdue = all(
    `SELECT * FROM bookings WHERE status = 'pending' AND payment_due_at < datetime('now')`);
  overdue.forEach(b => {
    run("UPDATE bookings SET status = 'cancelled', notes = COALESCE(notes || ' ', '') || '[auto-cancelled: payment hold expired]' WHERE id = ?", [b.id]);
    releaseSeats(b);
  });
  return overdue.length;
}

/** Prices every requested addon key against the live, admin-managed catalog
 *  — a client can only ever supply which addons it wants, never their
 *  price. Unknown/inactive keys are silently dropped (matches the old
 *  hardcoded-catalog behaviour). 'per_booking' addons (e.g. a private
 *  guide) are charged once regardless of group size; everything else scales
 *  with the number of riders on the booking. */
function priceAddons(addonKeys, riderCount) {
  const catalog = all('SELECT * FROM addon_catalog WHERE active = 1');
  const byKey = Object.fromEntries(catalog.map(a => [a.key, a]));
  const uniqueKeys = [...new Set(Array.isArray(addonKeys) ? addonKeys : [])];
  return uniqueKeys.filter(k => byKey[k]).map(k => {
    const addon = byKey[k];
    const quantity = addon.unit === 'per_booking' ? 1 : riderCount;
    return {
      addon_key: addon.key, label: addon.label, unit_price_cents: addon.price_cents,
      unit: addon.unit, quantity, line_total_cents: addon.price_cents * quantity,
    };
  });
}

/** Validates one rider's required fields (brief section: full name, age,
 *  country, riding experience, bike info, emergency contact, optional
 *  special requirements). Age (not date of birth) is the field this
 *  business collects — it's the minimum needed to gauge trip suitability,
 *  so storing a full birth date would be unnecessary data collection.
 *  Returns an array of human-readable error strings (empty = valid). */
function validateRider(r, index) {
  const errors = [];
  const label = 'Rider ' + (index + 1);
  if (!String(r.name || '').trim()) errors.push(`${label}: full name is required`);
  const age = Number(r.age);
  if (!Number.isInteger(age) || age < 1 || age > 120) errors.push(`${label}: a valid age is required`);
  if (!String(r.country || '').trim()) errors.push(`${label}: country is required`);
  if (!String(r.ridingExperience || '').trim()) errors.push(`${label}: riding experience is required`);
  if (!String(r.bikeInfo || '').trim()) errors.push(`${label}: bike information is required`);
  if (!String(r.emergencyContactName || '').trim() || !String(r.emergencyContactPhone || '').trim()) {
    errors.push(`${label}: emergency contact name and phone are required`);
  }
  return errors;
}

/** Server-side refund entitlement for a cancellation happening right now,
 *  against the admin-configurable cancellation_rules tiers (largest
 *  min_days_before_departure that's still met wins; no match = 0%). This is
 *  an ENTITLEMENT calculation only — see the refunds table comment in
 *  schema.sql for why a computed row here is not the same as money moved. */
function computeRefundEntitlement(departureStartDate) {
  const daysBeforeDeparture = Math.floor((new Date(departureStartDate + 'T00:00:00Z') - new Date()) / 86400000);
  const rules = all('SELECT * FROM cancellation_rules ORDER BY min_days_before_departure DESC');
  const rule = rules.find(rl => daysBeforeDeparture >= rl.min_days_before_departure) || null;
  return { percent: rule ? rule.refund_percent : 0, days_before_departure: daysBeforeDeparture };
}

/** What cancelling this booking right now would entitle the rider to, used to
 *  show the figure up-front in the dashboard's cancel confirmation rather than
 *  only in the toast after the fact. Computed from exactly the same tiers and
 *  the same amount-paid figure as the real cancel endpoint, so the preview and
 *  the outcome can never disagree. */
function refundPreview(bookingRow) {
  if (bookingRow.status === 'cancelled') return { refund_preview_percent: 0, refund_preview_cents: 0 };
  const entitlement = computeRefundEntitlement(bookingRow.start_date);
  return {
    refund_preview_percent: entitlement.percent,
    refund_preview_cents: Math.round(bookingRow.amount_paid_cents * (entitlement.percent / 100)),
  };
}

function register(router) {
  // GET /api/payments/config — public. The frontend asks this before it
  // renders a card form, so a form is only ever shown when something will
  // actually happen to what is typed into it. See lib/payments.js.
  router.get('/api/payments/config', (req, res) => ok(res, paymentConfig()));

  // POST /api/bookings — requires a signed-in rider (Authorization: Bearer <token>).
  // { departureId,
  //   riders: [{name, age, country, ridingExperience, bikeInfo, emergencyContactName, emergencyContactPhone, specialRequirements}],
  //   addons: ["bike_rental","single_room"], promoCode: "SAVE10" }
  // The lead rider is always the signed-in account, never a client-supplied
  // email — that email-lookup used to let anyone attribute a booking to any
  // rider account just by typing their address in the request body.
  router.post('/api/bookings', requireAuth('rider', (req, res) => {
    expireOverdueBookings();
    const b = req.body || {};
    const departureId = Number(b.departureId);
    const riders = Array.isArray(b.riders) ? b.riders : [];
    if (!departureId || riders.length === 0) return badRequest(res, 'departureId and at least one rider are required');

    const riderErrors = riders.flatMap(validateRider);
    if (riderErrors.length) return badRequest(res, riderErrors.join('; '));

    const dep = get('SELECT d.*, t.price_from_cents FROM departures d JOIN tours t ON t.id = d.tour_id WHERE d.id = ?', [departureId]);
    if (!dep) return notFound(res, 'Departure not found');
    if (dep.status === 'cancelled') return badRequest(res, 'This departure has been cancelled');
    if (new Date(dep.end_date) < new Date()) return badRequest(res, 'This departure has already happened and can no longer be booked');

    const spacesLeft = dep.capacity - dep.seats_booked;
    if (dep.status === 'full' || spacesLeft < riders.length) {
      return badRequest(res, 'Not enough spaces on this departure for ' + riders.length + ' rider(s)');
    }

    const leadRiderId = req.session.subject_id;

    // A rider can't be on two departures at once, and can't book the same
    // departure twice — check against every non-cancelled booking they hold.
    const activeBookings = all(
      `SELECT b.id, b.departure_id, d.start_date, d.end_date, t.name AS tour_name
       FROM bookings b JOIN departures d ON d.id = b.departure_id JOIN tours t ON t.id = d.tour_id
       WHERE b.lead_rider_id = ? AND b.status != 'cancelled'`, [leadRiderId]);

    if (activeBookings.some(existing => existing.departure_id === departureId)) {
      return badRequest(res, 'You already have a booking for this departure');
    }
    const overlap = activeBookings.find(existing => dep.start_date <= existing.end_date && existing.start_date <= dep.end_date);
    if (overlap) {
      return badRequest(res,
        `These dates overlap with your ${overlap.tour_name} booking (${overlap.start_date} to ${overlap.end_date}) — you can't be on two tours at the same time`);
    }

    // --- pricing: base fare + addons (server-priced) - promo discount + tax ---
    const addonItems = priceAddons(b.addons, riders.length);
    const addonsCents = addonItems.reduce((sum, a) => sum + a.line_total_cents, 0);
    const subtotalCents = dep.price_from_cents * riders.length + addonsCents;

    let discountCents = 0, promo = null;
    if (b.promoCode) {
      const result = evaluatePromoCode(b.promoCode, { tourId: dep.tour_id, riderCount: riders.length, subtotalCents });
      if (!result.valid) return badRequest(res, result.error);
      discountCents = result.discount_cents;
      promo = result.promo;
    }

    // No tax/fee rule is currently configured for this business — 0 rather
    // than an invented rate. See schema.sql's comment on bookings.tax_cents.
    const taxCents = 0;
    const totalCents = Math.max(0, subtotalCents - discountCents) + taxCents;
    const depositCents = Math.round(totalCents * 0.2);

    const accessToken = newToken();
    const paymentDueAt = new Date(Date.now() + PAYMENT_HOLD_HOURS * 3600 * 1000).toISOString();
    const addonKeys = addonItems.map(a => a.addon_key);

    // The booking row, every rider row, every addon line item, the promo
    // redemption count, and the departure's seat count all have to land
    // together or not at all — see db.js's transaction() for why (crash-
    // safety, not concurrency, given this server's synchronous single-
    // threaded request handling).
    const { bookingId } = transaction(() => {
      const newBookingId = run(
        `INSERT INTO bookings (departure_id, lead_rider_id, access_token, status, addons_json,
                                subtotal_cents, promo_code_id, discount_cents, tax_cents, total_cents, deposit_cents, payment_due_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [departureId, leadRiderId, accessToken, 'pending', JSON.stringify(addonKeys),
         subtotalCents, promo ? promo.id : null, discountCents, taxCents, totalCents, depositCents, paymentDueAt]
      ).lastInsertRowid;

      riders.forEach((r, i) => {
        run(`INSERT INTO booking_riders (booking_id, rider_id, name, age, country, riding_experience, bike_info,
                                          emergency_contact_name, emergency_contact_phone, special_requirements, is_lead)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [newBookingId, i === 0 ? leadRiderId : null, r.name.trim(), Number(r.age), r.country.trim(), r.ridingExperience.trim(),
           r.bikeInfo.trim(), r.emergencyContactName.trim(), r.emergencyContactPhone.trim(),
           String(r.specialRequirements || '').trim() || null, i === 0 ? 1 : 0]);
      });

      addonItems.forEach(a => {
        run(`INSERT INTO booking_addons (booking_id, addon_key, label, unit_price_cents, unit, quantity, line_total_cents)
             VALUES (?,?,?,?,?,?,?)`,
          [newBookingId, a.addon_key, a.label, a.unit_price_cents, a.unit, a.quantity, a.line_total_cents]);
      });

      if (promo) run('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?', [promo.id]);

      run('UPDATE departures SET seats_booked = seats_booked + ? WHERE id = ?', [riders.length, departureId]);
      return { bookingId: newBookingId };
    });
    recalcDepartureStatus(departureId);

    // Tell the admins a new place has been held (shows as a popup on their next sign-in / poll).
    try {
      const who = get('SELECT name FROM riders WHERE id = ?', [leadRiderId]);
      const trip = get('SELECT t.name AS tour, d.start_date FROM departures d JOIN tours t ON t.id = d.tour_id WHERE d.id = ?', [departureId]);
      notifyAdmins({
        type: 'booking_new',
        title: 'New booking: ' + (trip ? trip.tour : 'departure #' + departureId),
        body: (who ? who.name : 'A rider') + ' held ' + riders.length + ' place' + (riders.length === 1 ? '' : 's') + (trip ? ' for ' + trip.start_date : '') + '.',
        linkUrl: 'admin.html#bookings',
      });
    } catch (e) { /* a failed notification must never fail the booking */ }

    const booking = get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    const bookingRiders = all('SELECT * FROM booking_riders WHERE booking_id = ?', [bookingId]);
    created(res, {
      booking: { ...booking, addons: JSON.parse(booking.addons_json), booking_reference: bookingReference(booking.id) },
      riders: bookingRiders,
      addon_items: addonItems,
      payment: {
        subtotal_cents: subtotalCents,
        discount_cents: discountCents,
        tax_cents: taxCents,
        total_cents: totalCents,
        deposit_due_cents: depositCents,
        balance_due_cents: totalCents - depositCents,
        currency: 'EUR',
        pay_by: paymentDueAt,
        note: 'No real payment gateway is wired up in this demo — integrate Stripe (or similar) in production, per brief section 39. ' +
              'This hold auto-cancels in ' + PAYMENT_HOLD_HOURS + ' hours if no payment is recorded.',
      },
    });
  }));

  // A booking is visible to: an admin, the rider it belongs to, or whoever
  // holds its access_token (the unguessable secret returned once at booking
  // time — this is how a guest checkout, with no rider account, looks its
  // own booking back up). Booking IDs are sequential and guessable, so none
  // of GET/PATCH below trust the :id alone. Token can come as ?token= or the
  // X-Booking-Token header.
  function canAccessBooking(req, booking) {
    const session = sessionFromRequest(req);
    if (session && session.subject_type === 'admin') return true;
    if (session && session.subject_type === 'rider' && booking.lead_rider_id === session.subject_id) return true;
    const suppliedToken = req.query.token || req.headers['x-booking-token'];
    return !!suppliedToken && suppliedToken === booking.access_token;
  }

  /** Rejects a booking read with the right status and a message that matches
   *  the reader's actual situation: a signed-in rider looking at someone
   *  else's booking is a 403 they can't fix by signing in again, whereas an
   *  anonymous visitor really does just need to sign in (or use the
   *  access-token link from their confirmation). */
  function denyBookingAccess(req, res, action) {
    const session = sessionFromRequest(req);
    if (session) return forbidden(res, `This booking belongs to a different account, so you can't ${action}.`);
    return unauthorized(res, `Sign in, or open this booking's own link from your confirmation, to ${action}.`);
  }

  /** Shared enrichment for a single booking response: parsed addons, its
   *  priced line items, any refund records, and the display reference. */
  function enrichBooking(booking) {
    return {
      ...booking,
      addons: JSON.parse(booking.addons_json),
      addon_items: all('SELECT * FROM booking_addons WHERE booking_id = ?', [booking.id]),
      refunds: all('SELECT * FROM refunds WHERE booking_id = ? ORDER BY requested_at DESC', [booking.id]),
      booking_reference: bookingReference(booking.id),
    };
  }

  // GET /api/bookings/:id?token=<access_token>
  router.get('/api/bookings/:id', (req, res) => {
    const booking = get('SELECT * FROM bookings WHERE id = ?', [Number(req.params.id)]);
    if (!booking) return notFound(res, 'Booking not found');
    if (!canAccessBooking(req, booking)) return denyBookingAccess(req, res, 'view it');
    const riders = all('SELECT * FROM booking_riders WHERE booking_id = ?', [booking.id]);
    // Joins in everything a "my trip" page needs in one call: which tour (+
    // its slug, to link to the full tour-detail page for the day-by-day
    // itinerary) and which guide (full public profile, not just their name)
    // is actually leading this specific departure.
    const departure = get(
      `SELECT d.*, t.name AS tour_name, t.slug AS tour_slug,
              g.name AS guide_name, g.role AS guide_role, g.bio AS guide_bio, g.photo_url AS guide_photo_url,
              g.years_experience AS guide_years_experience, g.languages AS guide_languages,
              g.trips_led AS guide_trips_led, g.rating AS guide_rating
       FROM departures d JOIN tours t ON t.id = d.tour_id LEFT JOIN guides g ON g.id = d.guide_id
       WHERE d.id = ?`,
      [booking.departure_id]);
    ok(res, { ...enrichBooking(booking), riders, departure });
  });

  // GET /api/bookings/:id/invoice?token=<access_token> — generates (once,
  // lazily) and returns this booking's invoice: line items, customer name
  // only (data minimization — no emergency/medical fields here), and
  // payment status. Numbering is sequential and stable once issued.
  router.get('/api/bookings/:id/invoice', (req, res) => {
    const booking = get('SELECT * FROM bookings WHERE id = ?', [Number(req.params.id)]);
    if (!booking) return notFound(res, 'Booking not found');
    if (!canAccessBooking(req, booking)) return denyBookingAccess(req, res, 'view its invoice');

    let invoice = get('SELECT * FROM invoices WHERE booking_id = ?', [booking.id]);
    if (!invoice) {
      const seq = get('SELECT COUNT(*) n FROM invoices').n + 1;
      const invoiceNumber = `HR-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`;
      const invoiceId = run('INSERT INTO invoices (booking_id, invoice_number) VALUES (?,?)', [booking.id, invoiceNumber]).lastInsertRowid;
      invoice = get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    }

    const departure = get(
      `SELECT d.start_date, d.end_date, t.name AS tour_name, t.currency
       FROM departures d JOIN tours t ON t.id = d.tour_id WHERE d.id = ?`, [booking.departure_id]);
    const riders = all('SELECT name, is_lead FROM booking_riders WHERE booking_id = ?', [booking.id]);
    const addonItems = all('SELECT * FROM booking_addons WHERE booking_id = ?', [booking.id]);
    const leadAccount = booking.lead_rider_id ? get('SELECT name, email FROM riders WHERE id = ?', [booking.lead_rider_id]) : null;
    const leadRider = riders.find(r => r.is_lead);

    // Base fare is subtotal minus addons, not tour.price_from_cents × riders
    // recomputed fresh — the tour's list price can differ from what this
    // booking actually agreed to (most importantly for a confirmed custom
    // trip, whose subtotal is a bespoke negotiated price, but this is also
    // just more correct in general: subtotal_cents is the number that was
    // actually charged, price_from_cents is only ever a live "current list
    // price" lookup that could itself have changed since).
    const addonsCents = addonItems.reduce((sum, a) => sum + a.line_total_cents, 0);
    const lineItems = [
      { label: `${departure.tour_name} — base fare × ${riders.length} rider(s)`, amount_cents: booking.subtotal_cents - addonsCents },
      ...addonItems.map(a => ({ label: a.label + (a.unit === 'per_rider' ? ` × ${a.quantity}` : ''), amount_cents: a.line_total_cents })),
    ];
    if (booking.discount_cents > 0) lineItems.push({ label: 'Promo code discount', amount_cents: -booking.discount_cents });
    if (booking.tax_cents > 0) lineItems.push({ label: 'Tax / fees', amount_cents: booking.tax_cents });

    ok(res, {
      invoice_number: invoice.invoice_number,
      issued_at: invoice.issued_at,
      booking_id: booking.id,
      booking_reference: bookingReference(booking.id),
      customer: { name: (leadAccount && leadAccount.name) || (leadRider && leadRider.name) || 'Guest', email: leadAccount ? leadAccount.email : null },
      tour_name: departure.tour_name,
      start_date: departure.start_date,
      end_date: departure.end_date,
      rider_count: riders.length,
      line_items: lineItems,
      subtotal_cents: booking.subtotal_cents,
      discount_cents: booking.discount_cents,
      tax_cents: booking.tax_cents,
      total_cents: booking.total_cents,
      deposit_cents: booking.deposit_cents,
      amount_paid_cents: booking.amount_paid_cents,
      balance_due_cents: booking.total_cents - booking.amount_paid_cents,
      payment_status: booking.status,
      currency: departure.currency || 'EUR',
    });
  });

  // POST /api/bookings/:id/cancel — the owning rider, or an admin. Also
  // computes (never fabricates) a refund entitlement from the admin-
  // configured cancellation_rules tiers against whatever's actually been
  // paid — the resulting refunds row starts 'pending' and only becomes
  // 'processed' once an admin explicitly confirms the money has moved
  // (PATCH /api/admin/refunds/:id), since no live payment gateway exists to
  // confirm that automatically.
  router.post('/api/bookings/:id/cancel', (req, res) => {
    const booking = get('SELECT * FROM bookings WHERE id = ?', [Number(req.params.id)]);
    if (!booking) return notFound(res, 'Booking not found');
    const session = sessionFromRequest(req);
    const isAdmin = session && session.subject_type === 'admin';
    const isOwner = session && session.subject_type === 'rider' && booking.lead_rider_id === session.subject_id;
    if (!isAdmin && !isOwner) {
      return session
        ? forbidden(res, 'This booking belongs to a different account, so you can\'t cancel it.')
        : unauthorized(res, 'Sign in as the booking owner, or as an admin, to cancel it');
    }
    if (booking.status === 'cancelled') return badRequest(res, 'This booking is already cancelled');
    // NOTE: there is deliberately no 'completed' guard here any more.
    // bookings.status === 'completed' means "paid in full", NOT "the ride
    // happened" (see schema.sql) — so refusing to cancel a completed booking
    // locked every rider who paid in full out of cancelling at all, and out of
    // the 90%-refund tier the cancellation policy page promises them. Admins
    // couldn't override it either (there is no admin booking-status endpoint),
    // which made the highest-value refund case the one the system could not
    // handle. Whether the trip has actually run is decided below, from the
    // departure's own dates — the only thing that genuinely rules out a
    // self-service cancellation.
    const dep = get('SELECT * FROM departures WHERE id = ?', [booking.departure_id]);
    if (dep && new Date(dep.start_date) < new Date() && !isAdmin) {
      return badRequest(res, 'This departure has already happened, so it can\'t be self-cancelled — contact us directly');
    }
    const entitlement = dep ? computeRefundEntitlement(dep.start_date) : { percent: 0, days_before_departure: null };
    const refundAmount = Math.round(booking.amount_paid_cents * (entitlement.percent / 100));

    const refund = transaction(() => {
      run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [booking.id]);
      releaseSeats(booking);
      // A custom trip's own custom_requests row tracks its pipeline stage
      // independently of the booking (see schema.sql's booking_id comment) —
      // without this, cancelling the real booking here would leave that row
      // still saying 'confirmed' forever, exactly the kind of status/reality
      // mismatch this whole custom-trip workflow exists to avoid.
      if (dep && dep.is_custom && dep.custom_request_id) {
        const reqRow = get('SELECT * FROM custom_requests WHERE id = ?', [dep.custom_request_id]);
        if (reqRow && reqRow.status !== 'cancelled') {
          run("UPDATE custom_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", [reqRow.id]);
          logRequestEvent({
            customRequestId: reqRow.id, eventType: 'status_change', fromStatus: reqRow.status, toStatus: 'cancelled',
            actorType: isAdmin ? 'admin' : 'rider', actorId: session.subject_id,
            message: `Booking ${bookingReference(booking.id)} was cancelled.`,
          });
        }
      }
      if (refundAmount > 0) {
        const reason = `Cancelled ${entitlement.days_before_departure} day(s) before departure (${entitlement.percent}% refund tier)`;
        const refundId = run(
          `INSERT INTO refunds (booking_id, amount_cents, refund_percent, reason, requested_by) VALUES (?,?,?,?,?)`,
          [booking.id, refundAmount, entitlement.percent, reason, isAdmin ? 'admin' : 'rider']
        ).lastInsertRowid;
        run("UPDATE bookings SET refund_status = 'pending' WHERE id = ?", [booking.id]);
        return get('SELECT * FROM refunds WHERE id = ?', [refundId]);
      }
      run("UPDATE bookings SET refund_status = 'none' WHERE id = ?", [booking.id]);
      return null;
    });
    ok(res, { cancelled: true, refund_percent: entitlement.percent, refund_eligible_cents: refundAmount, refund });
  });

  // PATCH /api/bookings/:id/payment  { amountCents } — admin-only: in a real
  // deployment this is what a Stripe (or similar) webhook confirms, not
  // something a rider's own browser should be able to trigger. Reaching the
  // full total marks the booking 'completed' directly (no separate "paid"
  // holding state) — that is the checkout's finish line in this demo.
  router.patch('/api/bookings/:id/payment', requireAdmin((req, res) => {
    const booking = get('SELECT * FROM bookings WHERE id = ?', [Number(req.params.id)]);
    if (!booking) return notFound(res, 'Booking not found');
    if (booking.status === 'cancelled') return badRequest(res, 'Cannot record payment on a cancelled booking');
    const amount = Number((req.body || {}).amountCents || 0);
    if (!(amount > 0)) return badRequest(res, 'amountCents must be a positive number');
    const paid = booking.amount_paid_cents + amount;
    let status = booking.status;
    if (paid >= booking.total_cents) status = 'completed';
    else if (paid >= booking.deposit_cents) status = 'deposit_paid';
    run('UPDATE bookings SET amount_paid_cents = ?, status = ? WHERE id = ?', [paid, status, booking.id]);
    ok(res, { amount_paid_cents: paid, status });
  }));

  // POST /api/bookings/:id/pay — the owning rider pays from their own dashboard.
  // No real payment gateway is wired up in this demo (see the note returned at
  // booking time); any well-formed card is treated as an approved charge and
  // the booking's paid amount/status update immediately, with no admin step.
  // A production build would call Stripe (or similar) here and only update
  // state from its webhook, never trust the client's "it went through".
  router.post('/api/bookings/:id/pay', requireAuth('rider', (req, res) => {
    // No payment provider is connected. Refuse before the body is read, so a
    // card number sent anyway is never validated, used or logged.
    if (refuseIfPaymentsDisabled(res)) return;
    const booking = get('SELECT * FROM bookings WHERE id = ?', [Number(req.params.id)]);
    if (!booking) return notFound(res, 'Booking not found');
    if (booking.lead_rider_id !== req.session.subject_id) return forbidden(res, 'You can only pay for your own booking.');
    if (booking.status === 'cancelled') return badRequest(res, 'This booking is cancelled and can\'t be paid');
    if (booking.status === 'completed') return badRequest(res, 'This booking is already paid in full');

    const b = req.body || {};
    const amount = Math.round(Number(b.amountCents || 0));
    const balanceDue = booking.total_cents - booking.amount_paid_cents;
    if (!(amount > 0)) return badRequest(res, 'amountCents must be a positive number');
    if (amount > balanceDue) return badRequest(res, 'That amount is more than the remaining balance of ' + balanceDue + ' cents');

    // Shared with the custom-proposal pay endpoint, and now also rejects a
    // card whose expiry month has already passed — the old inline check only
    // matched the MM/YY *shape*, so "01/20" was accepted as a live card.
    const cardCheck = validateCard(b.card);
    if (cardCheck.error) return badRequest(res, cardCheck.error);

    const paid = booking.amount_paid_cents + amount;
    let status = booking.status;
    if (paid >= booking.total_cents) status = 'completed';
    else if (paid >= booking.deposit_cents) status = 'deposit_paid';
    run('UPDATE bookings SET amount_paid_cents = ?, status = ? WHERE id = ?', [paid, status, booking.id]);
    ok(res, { amount_paid_cents: paid, status, receipt: { last4: cardCheck.last4, amount_cents: amount } });
  }));

  // GET /api/riders/me/bookings — the signed-in rider's own booking history.
  router.get('/api/riders/me/bookings', requireAuth('rider', (req, res) => {
    expireOverdueBookings();
    const rows = all(
      `SELECT b.*, t.name AS tour_name, t.slug AS tour_slug, d.start_date, d.end_date, d.status AS departure_status
       FROM bookings b JOIN departures d ON d.id = b.departure_id JOIN tours t ON t.id = d.tour_id
       WHERE b.lead_rider_id = ? ORDER BY b.created_at DESC`, [req.session.subject_id]);
    const withRiders = rows.map(r => {
      // "Ridden" = the departure's end date has passed and the booking
      // wasn't cancelled — see the matching check in routes/reviews.js.
      const rideFinished = r.status !== 'cancelled' && new Date(r.end_date) < new Date();
      const alreadyReviewed = rideFinished && !!get(
        'SELECT id FROM reviews WHERE rider_id = ? AND departure_id = ?', [req.session.subject_id, r.departure_id]);
      return {
        ...enrichBooking(r),
        riders: all('SELECT * FROM booking_riders WHERE booking_id = ?', [r.id]),
        // 'completed' (= paid in full) is NOT a reason to hide Cancel — see the
        // matching note in POST /api/bookings/:id/cancel. The only bar is the
        // departure having already started.
        can_cancel: r.status !== 'cancelled' && new Date(r.start_date) > new Date(),
        // So the dashboard can tell the rider what cancelling would actually
        // refund *before* they commit to it, instead of only revealing the
        // number in the toast afterwards.
        ...refundPreview(r),
        can_review: rideFinished && !alreadyReviewed,
        already_reviewed: alreadyReviewed,
      };
    });
    ok(res, { count: withRiders.length, bookings: withRiders });
  }));

  // ---------------------------------------------------------------------
  // ADMIN — refunds queue + configurable cancellation-refund tiers.
  // ---------------------------------------------------------------------

  // GET /api/admin/refunds — every refund record, newest first.
  router.get('/api/admin/refunds', requireAdmin((req, res) => {
    const rows = all(
      `SELECT r.*, b.total_cents, b.amount_paid_cents, t.name AS tour_name, lr.name AS rider_name, lr.email AS rider_email
       FROM refunds r JOIN bookings b ON b.id = r.booking_id
       JOIN departures d ON d.id = b.departure_id JOIN tours t ON t.id = d.tour_id
       LEFT JOIN riders lr ON lr.id = b.lead_rider_id
       ORDER BY r.requested_at DESC`);
    ok(res, { count: rows.length, refunds: rows });
  }));

  // PATCH /api/admin/refunds/:id  { status: 'processed'|'denied', password?, adminNotes? }
  // Marking 'processed' requires the acting admin's own password as
  // step-up confirmation — see the refunds table comment in schema.sql for
  // why this manual attestation matters while no payment gateway exists.
  router.patch('/api/admin/refunds/:id', requireAdmin((req, res) => {
    const refund = get('SELECT * FROM refunds WHERE id = ?', [Number(req.params.id)]);
    if (!refund) return notFound(res, 'Refund not found');
    if (refund.status !== 'pending') return badRequest(res, 'This refund has already been ' + refund.status);
    const b = req.body || {};
    if (!['processed', 'denied'].includes(b.status)) return badRequest(res, "status must be 'processed' or 'denied'");

    if (b.status === 'processed') {
      const admin = get('SELECT * FROM admins WHERE id = ?', [req.session.subject_id]);
      // Same split as the rider-deletion step-up in routes/admin.js: a missing
      // confirmation is a 400 ("you still need to do this"), a wrong one a 401.
      if (!b.password) return badRequest(res, 'Enter your own admin password to confirm you have actually sent this refund.');
      if (!admin || !verifyPassword(b.password, admin.password_hash, admin.password_salt)) {
        return unauthorized(res, 'That admin password is incorrect — this refund was not marked as processed.');
      }
    }
    transaction(() => {
      run('UPDATE refunds SET status = ?, processed_at = datetime(\'now\'), processed_by_admin_id = ?, admin_notes = ? WHERE id = ?',
        [b.status, req.session.subject_id, b.adminNotes || null, refund.id]);
      if (b.status === 'processed') {
        run('UPDATE bookings SET refunded_cents = refunded_cents + ?, refund_status = ? WHERE id = ?', [refund.amount_cents, 'processed', refund.booking_id]);
      } else {
        run("UPDATE bookings SET refund_status = 'denied' WHERE id = ?", [refund.booking_id]);
      }
    });
    ok(res, get('SELECT * FROM refunds WHERE id = ?', [refund.id]));
  }));

  // GET /api/admin/cancellation-rules
  router.get('/api/admin/cancellation-rules', requireAdmin((req, res) => {
    ok(res, { rules: all('SELECT * FROM cancellation_rules ORDER BY min_days_before_departure DESC') });
  }));

  // POST /api/admin/cancellation-rules  { minDaysBeforeDeparture, refundPercent }
  router.post('/api/admin/cancellation-rules', requireAdmin((req, res) => {
    const b = req.body || {};
    if (b.minDaysBeforeDeparture == null || b.refundPercent == null) {
      return badRequest(res, 'minDaysBeforeDeparture and refundPercent are required');
    }
    if (!(b.refundPercent >= 0 && b.refundPercent <= 100)) return badRequest(res, 'refundPercent must be between 0 and 100');
    const id = run('INSERT INTO cancellation_rules (min_days_before_departure, refund_percent) VALUES (?,?)',
      [Math.round(Number(b.minDaysBeforeDeparture)), Math.round(Number(b.refundPercent))]).lastInsertRowid;
    created(res, get('SELECT * FROM cancellation_rules WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/cancellation-rules/:id
  router.patch('/api/admin/cancellation-rules/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM cancellation_rules WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Rule not found');
    const b = req.body || {};
    if (b.refundPercent != null && !(b.refundPercent >= 0 && b.refundPercent <= 100)) {
      return badRequest(res, 'refundPercent must be between 0 and 100');
    }
    run('UPDATE cancellation_rules SET min_days_before_departure=COALESCE(?,min_days_before_departure), refund_percent=COALESCE(?,refund_percent) WHERE id=?',
      [b.minDaysBeforeDeparture != null ? Math.round(Number(b.minDaysBeforeDeparture)) : null,
       b.refundPercent != null ? Math.round(Number(b.refundPercent)) : null, row.id]);
    ok(res, get('SELECT * FROM cancellation_rules WHERE id = ?', [row.id]));
  }));

  // DELETE /api/admin/cancellation-rules/:id
  router.delete('/api/admin/cancellation-rules/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM cancellation_rules WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Rule not found');
    run('DELETE FROM cancellation_rules WHERE id = ?', [row.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register, expireOverdueBookings, bookingReference, priceAddons, validateRider, capacityStatus };
