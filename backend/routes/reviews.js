'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound } = require('../lib/util');
const { requireAuth } = require('../lib/auth');

function register(router) {
  // GET /api/reviews?limit=6 — most recent reviews across every tour, for the
  // homepage's "Rider stories" section. Public: each tour's own reviews are
  // already public via GET /api/tours/:slug/reviews below, so this exposes
  // nothing new, just aggregates the newest ones site-wide. Only reviews with
  // an actual quote are included (a "story" card with no text to show isn't
  // useful there), and a deleted tour's reviews are naturally excluded by the
  // INNER JOIN.
  router.get('/api/reviews', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 12, 50);
    const rows = all(
      `SELECT r.*, t.name AS tour_name, t.slug AS tour_slug, d.start_date AS departure_start_date
       FROM reviews r JOIN tours t ON t.id = r.tour_id LEFT JOIN departures d ON d.id = r.departure_id
       WHERE r.quote IS NOT NULL AND r.quote != ''
       ORDER BY r.created_at DESC LIMIT ?`, [limit]);
    ok(res, { count: rows.length, reviews: rows });
  });

  // GET /api/tours/:slug/reviews
  router.get('/api/tours/:slug/reviews', (req, res) => {
    const tour = get('SELECT id FROM tours WHERE slug = ?', [req.params.slug]);
    if (!tour) return notFound(res, 'Tour not found');
    const reviews = all('SELECT * FROM reviews WHERE tour_id = ? ORDER BY created_at DESC', [tour.id]);
    const avg = (field) => {
      const vals = reviews.map(r => r[field]).filter(v => v != null);
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    };
    ok(res, {
      count: reviews.length,
      averages: {
        riding: avg('riding_score'), guide: avg('guide_score'), scenery: avg('scenery_score'),
        organization: avg('organization_score'), accommodation: avg('accommodation_score'),
      },
      reviews,
    });
  });

  // POST /api/tours/:slug/reviews  { departureId, ridingScore, guideScore, sceneryScore,
  //   organizationScore, accommodationScore, wouldRecommend, quote }
  // Requires a signed-in rider, and only for a departure they actually rode:
  // a non-cancelled booking of theirs on that exact departure, whose end
  // date has already passed. Deliberately NOT gated on booking.status ===
  // 'completed' — in this app that status means "paid in full", which a
  // rider can reach before the trip even happens (paid up front), so it's
  // the wrong signal for "did they actually ride it". One review per rider
  // per departure.
  router.post('/api/tours/:slug/reviews', requireAuth('rider', (req, res) => {
    const tour = get('SELECT id FROM tours WHERE slug = ?', [req.params.slug]);
    if (!tour) return notFound(res, 'Tour not found');
    const b = req.body || {};
    const departureId = Number(b.departureId);
    if (!departureId) return badRequest(res, 'departureId is required');

    const riderId = req.session.subject_id;
    const completedBooking = get(
      `SELECT b.id FROM bookings b JOIN departures d ON d.id = b.departure_id
       WHERE b.lead_rider_id = ? AND d.id = ? AND d.tour_id = ? AND b.status != 'cancelled' AND date(d.end_date) < date('now')`,
      [riderId, departureId, tour.id]);
    if (!completedBooking) {
      return badRequest(res, "You can only review a departure you've booked and actually ridden — this one hasn't happened yet, isn't yours, or was cancelled.");
    }
    if (get('SELECT id FROM reviews WHERE rider_id = ? AND departure_id = ?', [riderId, departureId])) {
      return badRequest(res, "You've already reviewed this ride.");
    }

    const rider = get('SELECT name FROM riders WHERE id = ?', [riderId]);
    const id = run(
      `INSERT INTO reviews (tour_id, departure_id, rider_id, rider_name, riding_score, guide_score, scenery_score, organization_score, accommodation_score, would_recommend, quote)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [tour.id, departureId, riderId, rider.name, b.ridingScore || null, b.guideScore || null, b.sceneryScore || null,
       b.organizationScore || null, b.accommodationScore || null, b.wouldRecommend === false ? 0 : 1, b.quote || null]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM reviews WHERE id = ?', [id]));
  }));
}

module.exports = { register };
