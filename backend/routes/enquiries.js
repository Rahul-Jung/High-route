'use strict';
/* ===========================================================================
   ENQUIRIES — the Contact page form.

   The brief (sections 13 and 19) asks for an enquiry path that does not
   require an account: name, email, phone, the adventure, a departure date,
   how many people, requirements and a message. Before this existed the only
   way to ask anything was Private Trips, which needs a signed-in rider —
   so "is this trip suitable for me?" required creating an account first.

   Honesty rules this follows:
     - The response says the enquiry is STORED, not sent. No outbound email
       is configured, so nothing claims a reply is on its way automatically.
     - A departure is only attached if it really belongs to the adventure
       named, and only if it is not cancelled — the form cannot be used to
       attach an enquiry to a departure that does not exist.
     - A double-submit (same email, same message, within two minutes) returns
       the row already stored instead of filing a second copy.
   =========================================================================== */
const { all, get, run } = require('../db');
const {
  ok, created, badRequest, notFound, sendJson, isEmail, isIsoDate, rateLimited, clientIp,
} = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { notifyAdmins } = require('../lib/notifications');

const TOPICS = ['trip', 'booking', 'other'];
const STATUSES = ['new', 'replied', 'closed'];

function text(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? null : s; // over-length is reported by the caller
}

function shape(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    topic: r.topic,
    adventure: r.tour_id ? { id: r.tour_id, slug: r.tour_slug, name: r.tour_name } : null,
    departure: r.departure_id ? { id: r.departure_id, start_date: r.dep_start, end_date: r.dep_end } : null,
    preferred_date: r.preferred_date,
    travellers: r.travellers,
    requirements: r.requirements,
    message: r.message,
    status: r.status,
    admin_note: r.admin_note,
    email_status: r.email_status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const SELECT = `
  SELECT e.*, t.slug AS tour_slug, t.name AS tour_name,
         d.start_date AS dep_start, d.end_date AS dep_end
    FROM enquiries e
    LEFT JOIN tours t ON t.id = e.tour_id
    LEFT JOIN departures d ON d.id = e.departure_id`;

function register(router) {
  /* ---------------------------------------------------------------------
     POST /api/enquiries — public
     --------------------------------------------------------------------- */
  router.post('/api/enquiries', (req, res) => {
    // Generous for a person, tight for a script.
    if (rateLimited('enquiry:' + clientIp(req), { max: 6, windowMs: 15 * 60 * 1000 })) {
      return sendJson(res, 429, { error: 'Too many enquiries from this connection in a short time. Wait a few minutes and try again.' });
    }
    const b = req.body || {};
    const errors = {};

    const name = text(b.name, 120);
    if (!name) errors.name = String(b.name || '').trim().length > 120 ? 'Your name is 120 characters at most.' : 'Enter your name.';

    const email = text(b.email, 254);
    if (!email || !isEmail(email)) errors.email = 'Enter an email address we can reply to.';

    const phone = text(b.phone, 40);
    if (b.phone && String(b.phone).trim() && !phone) errors.phone = 'That phone number is too long.';
    if (phone && !/^[+()0-9 .-]{6,40}$/.test(phone)) errors.phone = 'Use digits, spaces and + ( ) - only.';

    const topic = TOPICS.includes(b.topic) ? b.topic : 'trip';

    const message = text(b.message, 4000);
    if (!message) errors.message = String(b.message || '').trim().length > 4000
      ? 'The message is 4,000 characters at most.'
      : 'Tell us what you would like to know.';

    const requirements = text(b.requirements, 2000);
    if (b.requirements && String(b.requirements).trim() && !requirements) errors.requirements = 'Requirements are 2,000 characters at most.';

    let travellers = null;
    if (b.travellers !== undefined && b.travellers !== null && String(b.travellers).trim() !== '') {
      travellers = Number(b.travellers);
      if (!Number.isInteger(travellers) || travellers < 1 || travellers > 100) errors.travellers = 'Enter a number of people from 1 to 100.';
    }

    let preferredDate = null;
    if (b.preferredDate) {
      if (!isIsoDate(b.preferredDate)) errors.preferredDate = 'Use a real date.';
      else preferredDate = b.preferredDate;
    }

    // The adventure, by slug. Unknown slugs are an error rather than being
    // silently dropped, because the person believes they asked about it.
    let tour = null;
    if (b.adventure) {
      tour = get('SELECT id, name, slug FROM tours WHERE slug = ?', [String(b.adventure)]);
      if (!tour) errors.adventure = 'That adventure was not found — choose it from the list.';
    }

    // A departure must belong to that adventure and still be running.
    let departure = null;
    if (b.departureId !== undefined && b.departureId !== null && String(b.departureId) !== '') {
      const depId = Number(b.departureId);
      if (!Number.isInteger(depId) || depId < 1) {
        errors.departureId = 'Choose a departure from the list.';
      } else {
        departure = get('SELECT id, tour_id, start_date, status FROM departures WHERE id = ?', [depId]);
        if (!departure || !tour || departure.tour_id !== tour.id) {
          errors.departureId = 'That departure does not belong to the adventure chosen.';
          departure = null;
        } else if (departure.status === 'cancelled') {
          errors.departureId = 'That departure has been cancelled — choose another date or leave it blank.';
          departure = null;
        }
      }
    }

    if (Object.keys(errors).length) {
      return sendJson(res, 400, { error: 'Check the highlighted fields.', fields: errors });
    }

    // Double-submit guard: a second click, a back-and-resubmit, a flaky
    // connection retrying. Returns what is already stored.
    const dup = get(
      `SELECT id FROM enquiries
        WHERE LOWER(email) = LOWER(?) AND message = ?
          AND created_at >= datetime('now', '-2 minutes')`,
      [email, message]
    );
    if (dup) {
      return ok(res, {
        enquiry_id: dup.id,
        duplicate: true,
        stored: true,
        email_sent: false,
        message: 'We already have this one — it arrived a moment ago. Nothing has been filed twice.',
      });
    }

    const id = run(
      `INSERT INTO enquiries (name, email, phone, topic, tour_id, departure_id, preferred_date,
                              travellers, requirements, message, ip)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [name, email, phone, topic, tour ? tour.id : null, departure ? departure.id : null,
        preferredDate, travellers, requirements, message, clientIp(req)]
    ).lastInsertRowid;

    notifyAdmins({
      type: 'enquiry_received',
      title: 'New enquiry',
      body: name + (tour ? ' about ' + tour.name : '') + ': ' + message.slice(0, 140) + (message.length > 140 ? '…' : ''),
      linkUrl: 'admin.html',
    });

    return created(res, {
      enquiry_id: id,
      stored: true,
      email_sent: false,
      // Said plainly: it is saved, a person reads it, and no automatic email
      // has gone anywhere.
      message: 'Thank you — your enquiry is saved and a member of the team will reply to ' + email +
        '. No automatic confirmation email is sent, so do not wait for one.',
    });
  });

  /* ---------------------------------------------------------------------
     Admin
     --------------------------------------------------------------------- */
  router.get('/api/admin/enquiries', requireAdmin((req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const rows = all(
      SELECT + (status ? ' WHERE e.status = ?' : '') + ' ORDER BY (e.status = \'new\') DESC, e.created_at DESC',
      status ? [status] : []
    );
    const counts = Object.fromEntries(
      all('SELECT status, COUNT(*) n FROM enquiries GROUP BY status').map(r => [r.status, r.n])
    );
    return ok(res, { enquiries: rows.map(shape), counts });
  }));

  router.patch('/api/admin/enquiries/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM enquiries WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'No such enquiry');
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return badRequest(res, 'status must be new, replied or closed');
      sets.push('status = ?'); params.push(b.status);
    }
    if (b.adminNote !== undefined) {
      const note = b.adminNote === null ? null : String(b.adminNote).trim();
      if (note && note.length > 2000) return badRequest(res, 'The note is 2,000 characters at most.');
      sets.push('admin_note = ?'); params.push(note || null);
    }
    if (!sets.length) return badRequest(res, 'Nothing to update');
    sets.push("updated_at = datetime('now')");
    params.push(row.id);
    run(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`, params);
    return ok(res, { enquiry: shape(get(SELECT + ' WHERE e.id = ?', [row.id])) });
  }));

  router.delete('/api/admin/enquiries/:id', requireAdmin((req, res) => {
    const row = get('SELECT id FROM enquiries WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'No such enquiry');
    run('DELETE FROM enquiries WHERE id = ?', [row.id]);
    return ok(res, { deleted: true });
  }));
}

module.exports = { register };
