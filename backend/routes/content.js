'use strict';
/* ===========================================================================
   CONTENT API — destination pages, FAQs, and the impact report.

   These three are grouped because they are the same kind of thing: structured
   content an admin maintains, read by a page that renders an empty state
   rather than inventing a substitute when a field is blank.

   The impact endpoints are the ones to read carefully. The brief is
   categorical that sustainability figures must be real or absent, so:

     - GET /api/impact never computes a metric that has not been entered. It
       returns what an admin typed, flagged with whether they confirmed it is
       evidenced, and the Our Impact page renders an unevidenced metric as
       "not yet published" with the note explaining what has to be supplied.

     - The one exception is `derived`, which holds figures this system can
       actually stand behind because it holds the underlying rows: average
       group size and departure count come from the departures table. They
       are returned separately from the published metrics and labelled as
       derived, so nobody mistakes one for the other.
   =========================================================================== */
const { all, get, run } = require('../db');
const { ok, created, notFound, badRequest } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { publicWhere, shapeAdventure, parseJson, activityTypes } = require('../lib/adventures');

const IMPACT_DIMENSIONS = [
  {
    key: 'local_economy',
    label: 'Keep tourism income local',
    blurb: 'Who gets paid, and where they live. The single biggest lever an operator has, and the easiest one to claim without evidence.',
  },
  {
    key: 'community',
    label: 'Travel with communities, not through them',
    blurb: 'The relationships behind a route — who is consulted, who benefits, and what is agreed before a group arrives.',
  },
  {
    key: 'environment',
    label: 'Reduce what can be reduced',
    blurb: 'Group sizes, waste, water and transport. The practical operating decisions, not the offsetting.',
  },
  {
    key: 'conservation',
    label: 'Protect the places we ride and walk',
    blurb: 'Trail maintenance and conservation work, and what was actually contributed to it.',
  },
];

/* ---------------------------------------------------------------------------
   THE DESTINATION GALLERY

   Two sources, kept distinguishable:

     1. destination_images — photos of the PLACE, added in the admin panel.
     2. gallery_images belonging to the trips that run in this destination.

   The second source is why a destination can have a gallery at all without
   anybody uploading anything: there are already captioned photos in this
   database attributed to a trip in that region. They are labelled with the
   trip they came from, so the page never implies a photo of one valley was
   taken in another — which is exactly what would happen if this quietly
   pulled stock images in to fill the grid.

   De-duplicated on URL, because the seed data deliberately reuses a few
   images across a trip's hero and its gallery.
   --------------------------------------------------------------------------- */
function destinationGallery(dest) {
  const out = [];
  const seen = new Set();
  const push = (image_url, caption, source, credit) => {
    if (!image_url) return;
    const key = String(image_url).split('?')[0];
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ image_url, caption: caption || null, source: source || null, credit: credit || null });
  };

  // The hero leads the gallery when there is one — it is a photo of the
  // place by definition, and it is already on the page above.
  push(dest.hero_image_url, dest.name, 'Destination');

  all(
    `SELECT image_url, caption, credit FROM destination_images
       WHERE destination_id = ? ORDER BY sort_order, id`,
    [dest.id]
  ).forEach(r => push(r.image_url, r.caption, 'Destination', r.credit));

  // Trips here, matched the same way the adventure list on the page is:
  // destination_slug first, then the region label.
  const tours = all(
    `SELECT id, name, image_url FROM tours
       WHERE published = 1 AND (destination_slug = ? OR LOWER(region) = LOWER(?))
       ORDER BY id`,
    [dest.slug, dest.name]
  );
  tours.forEach(t => push(t.image_url, t.name, t.name));
  if (tours.length) {
    all(
      `SELECT g.image_url, g.caption, t.name AS tour_name
         FROM gallery_images g JOIN tours t ON t.id = g.tour_id
        WHERE g.tour_id IN (${tours.map(() => '?').join(',')})
        ORDER BY g.category DESC, g.sort_order, g.id`,
      tours.map(t => t.id)
    ).forEach(r => push(r.image_url, r.caption, r.tour_name));
  }

  return out;
}

function register(router) {
  /* =====================================================================
     DESTINATIONS
     ===================================================================== */

  // GET /api/destinations/:slug — the destination page payload.
  //
  // Registered before any other :slug route on this path would be, and
  // distinct from the existing GET /api/destinations (routes/destinations.js)
  // which serves the homepage map pins and stays untouched.
  router.get('/api/destinations/:slug', (req, res) => {
    // `intro IS NOT NULL` is the same test GET /api/destination-pages uses
    // to decide what belongs in the index, and it has to be the same test
    // here. A destination row with no intro is an auto-created map pin (see
    // destinations.auto_created and ensureDestinationForDistrict), not a
    // page: without it there is no hero text and nothing for the page to
    // open with, so serving one produces a heading above a list of the
    // things it does not have.
    const d = get(
      'SELECT * FROM destinations WHERE slug = ? AND published = 1 AND intro IS NOT NULL',
      [req.params.slug]
    );
    if (!d) return notFound(res, 'No such destination');

    const pub = publicWhere('t');
    // Matched on destination_slug first, falling back to the region label so
    // a tour an admin created without picking a destination still shows up on
    // the page a visitor would expect to find it on.
    const adventures = all(
      `SELECT t.* FROM tours t
        WHERE ${pub.sql} AND (t.destination_slug = ? OR LOWER(t.region) = LOWER(?))
        ORDER BY t.price_from_cents DESC`,
      [...pub.params, d.slug, d.name]
    ).map(r => shapeAdventure(r));

    const declaredActivities = parseJson(d.activities_json, []);
    // Which activities this destination actually has trips in, versus which
    // it is described as suiting. Both are useful and they are different
    // things: Everest is a trekking destination with no published trips, and
    // the page needs to be able to say exactly that.
    const withAdventures = [...new Set(adventures.map(a => a.activity))];
    const enabled = activityTypes({ enabledOnly: true });

    const relatedSlugs = parseJson(d.related_json, []);
    const related = relatedSlugs.length
      ? all(
          `SELECT slug, name, region, hero_image_url, intro FROM destinations
            WHERE published = 1 AND slug IN (${relatedSlugs.map(() => '?').join(',')})`,
          relatedSlugs
        )
      : [];

    const faqs = all(
      `SELECT question, answer, category FROM faqs
        WHERE published = 1 AND (destination_slug = ? OR destination_slug IS NULL)
        ORDER BY (destination_slug IS NULL), category, sort_order
        LIMIT 8`,
      [d.slug]
    );

    const gallery = destinationGallery(d);

    /* Which of the page's blocks have nothing behind them yet. The page uses
       this to say what is missing instead of rendering a heading over an
       empty div — the same rule the impact report follows. */
    const missing = [];
    if (!parseJson(d.highlights_json, []).length) missing.push('highlights');
    if (!parseJson(d.seasons_json, []).length) missing.push('a season-by-season breakdown');
    if (!d.permits) missing.push('a permits note');
    if (!d.health_notes) missing.push('health and altitude notes');
    if (!d.culture) missing.push('a note on local culture');
    if (!gallery.length) missing.push('photographs');

    return ok(res, {
      slug: d.slug,
      name: d.name,
      region: d.region,
      description: d.description,
      intro: d.intro,
      hero_image_url: d.hero_image_url,
      best_time: d.best_time,
      best_months: d.best_months,
      elevation_range: d.elevation_range,
      altitude_summary: d.altitude_summary,
      getting_there: d.getting_there,
      getting_around: d.getting_around,
      permits: d.permits,
      health_notes: d.health_notes,
      culture: d.culture,
      at_a_glance: parseJson(d.at_a_glance_json, []),
      highlights: parseJson(d.highlights_json, []),
      seasons: parseJson(d.seasons_json, []),
      sections: parseJson(d.sections_json, []),
      gallery,
      missing,
      practical: parseJson(d.practical_json, []),
      lat: d.lat,
      lng: d.lng,
      activities: declaredActivities
        .map(slug => {
          const t = enabled.find(a => a.slug === slug);
          if (!t) return null;
          return {
            slug,
            name: t.name,
            summary: t.summary,
            adventure_count: adventures.filter(a => a.activity === slug).length,
            has_adventures: withAdventures.includes(slug),
          };
        })
        .filter(Boolean),
      adventures,
      related,
      faqs,
    });
  });

  // GET /api/destination-pages — the Destinations index.
  router.get('/api/destination-pages', (req, res) => {
    const pub = publicWhere('t');
    const rows = all('SELECT * FROM destinations WHERE published = 1 ORDER BY sort_order, name');
    const tours = all(`SELECT t.destination_slug, t.region, t.activity FROM tours t WHERE ${pub.sql}`, pub.params);
    return ok(res, {
      destinations: rows
        // A destination with no page content is an auto-created map pin (see
        // destinations.auto_created), not a page. Listing it would send a
        // visitor to a hero image above three empty sections.
        .filter(d => d.intro)
        .map(d => {
          const mine = tours.filter(t => t.destination_slug === d.slug || (t.region || '').toLowerCase() === d.name.toLowerCase());
          // The card shows the short labels; best_time and elevation_range
          // are paragraphs and belong on the page, not in a 200px cell.
          return {
            slug: d.slug,
            name: d.name,
            region: d.region,
            intro: d.intro,
            description: d.description,
            hero_image_url: d.hero_image_url,
            best_time: d.best_time,
            best_months: d.best_months,
            elevation_range: d.elevation_range,
            altitude_summary: d.altitude_summary,
            adventure_count: mine.length,
            // What this destination is described as suiting, which is not the
            // same as what has trips in it — Everest is a trekking
            // destination with nothing published.
            declared_activities: parseJson(d.activities_json, []),
            activities: [...new Set(mine.map(t => t.activity))],
          };
        }),
    });
  });

  // Admin: the destination page content fields. The existing
  // POST/PATCH/DELETE /api/admin/destinations (routes/destinations.js)
  // handles the map-pin fields and is untouched; this handles the page.
  router.patch('/api/admin/destinations/:id/content', requireAdmin((req, res) => {
    const d = get('SELECT * FROM destinations WHERE id = ?', [req.params.id]);
    if (!d) return notFound(res, 'No such destination');
    const b = req.body || {};
    const sets = [];
    const params = [];

    const textField = (field, col, max) => {
      if (b[field] === undefined) return;
      const v = b[field] === null ? null : String(b[field]).trim();
      if (v && v.length > max) throw new Error(`${field} is too long (${max} characters max)`);
      sets.push(`${col} = ?`);
      params.push(v || null);
    };
    const listField = (field, col) => {
      if (b[field] === undefined) return;
      if (!Array.isArray(b[field])) throw new Error(`${field} must be a list`);
      const items = b[field].map(x => String(x).trim()).filter(Boolean);
      if (items.some(i => i.length > 1000)) throw new Error(`${field} entries must be under 1000 characters`);
      sets.push(`${col} = ?`);
      params.push(JSON.stringify(items));
    };

    /* The structured blocks. Each entry is validated against the shape its
       component renders, and an entry missing the field that gives it a
       heading is dropped rather than stored — a highlight with no title
       would render as a numbered box with nothing in it. */
    const objectListField = (field, col, required, optional) => {
      if (b[field] === undefined) return;
      if (!Array.isArray(b[field])) throw new Error(`${field} must be a list`);
      const keys = required.concat(optional);
      const items = b[field].map(raw => {
        if (!raw || typeof raw !== 'object') return null;
        const item = {};
        keys.forEach(k => {
          if (raw[k] === undefined || raw[k] === null) return;
          const v = typeof raw[k] === 'number' ? raw[k] : String(raw[k]).trim();
          if (v === '') return;
          if (typeof v === 'string' && v.length > 6000) {
            throw new Error(`${field}: "${k}" is too long (6000 characters max)`);
          }
          item[k] = v;
        });
        return required.every(k => item[k] !== undefined) ? item : null;
      }).filter(Boolean);
      if (items.length > 40) throw new Error(`${field}: 40 entries is the limit`);
      sets.push(`${col} = ?`);
      params.push(JSON.stringify(items));
    };

    try {
      textField('intro', 'intro', 4000);
      textField('bestTime', 'best_time', 2000);
      textField('bestMonths', 'best_months', 120);
      textField('elevationRange', 'elevation_range', 200);
      textField('altitudeSummary', 'altitude_summary', 120);
      textField('gettingThere', 'getting_there', 4000);
      textField('gettingAround', 'getting_around', 4000);
      textField('permits', 'permits', 6000);
      textField('healthNotes', 'health_notes', 6000);
      textField('culture', 'culture', 6000);
      listField('practical', 'practical_json');
      listField('activities', 'activities_json');
      listField('related', 'related_json');
      objectListField('atAGlance', 'at_a_glance_json', ['label', 'value'], ['note']);
      objectListField('highlights', 'highlights_json', ['title', 'text'], []);
      objectListField('seasons', 'seasons_json', ['label'], ['months', 'note', 'best']);
      objectListField('sections', 'sections_json', ['heading', 'body'], []);
    } catch (e) {
      return badRequest(res, e.message);
    }

    if (b.published !== undefined) { sets.push('published = ?'); params.push(b.published ? 1 : 0); }
    if (!sets.length) return badRequest(res, 'Nothing to update');

    params.push(d.id);
    run(`UPDATE destinations SET ${sets.join(', ')} WHERE id = ?`, params);
    return ok(res, { destination: get('SELECT * FROM destinations WHERE id = ?', [d.id]) });
  }));

  /* ---------------------------------------------------------------------
     DESTINATION GALLERY (admin)

     The admin panel needs to see both halves of what the page will show —
     the rows it can edit, and the trip photos it cannot — otherwise
     "this destination has no photos" is indistinguishable from "this
     destination has six photos that came from its trips".
     --------------------------------------------------------------------- */
  router.get('/api/admin/destinations/:id/images', requireAdmin((req, res) => {
    const d = get('SELECT * FROM destinations WHERE id = ?', [req.params.id]);
    if (!d) return notFound(res, 'No such destination');
    const own = all(
      `SELECT id, image_url, caption, credit, sort_order FROM destination_images
         WHERE destination_id = ? ORDER BY sort_order, id`,
      [d.id]
    );
    const gallery = destinationGallery(d);
    const ownUrls = new Set(own.map(r => String(r.image_url).split('?')[0]));
    return ok(res, {
      destination: { id: d.id, slug: d.slug, name: d.name },
      images: own,
      // Everything the page will show that is NOT editable here, so the
      // panel can say where it came from.
      inherited: gallery.filter(g => !ownUrls.has(String(g.image_url).split('?')[0])),
      total: gallery.length,
    });
  }));

  function imageFields(b) {
    const url = b.imageUrl === undefined ? undefined : String(b.imageUrl || '').trim();
    if (url !== undefined) {
      if (!url) throw new Error('An image URL is required');
      if (!/^https?:\/\/|^\//.test(url)) throw new Error('The image URL must be an http(s) address or a site-relative path');
      if (url.length > 1000) throw new Error('That image URL is too long');
    }
    const caption = b.caption === undefined ? undefined : String(b.caption || '').trim();
    if (caption && caption.length > 300) throw new Error('A caption is 300 characters at most');
    const credit = b.credit === undefined ? undefined : String(b.credit || '').trim();
    if (credit && credit.length > 200) throw new Error('A credit is 200 characters at most');
    const sort = b.sortOrder === undefined ? undefined : Number(b.sortOrder);
    if (sort !== undefined && (!Number.isFinite(sort) || sort < 0 || sort > 9999)) {
      throw new Error('Sort order must be a number between 0 and 9999');
    }
    return { url, caption, credit, sort };
  }

  router.post('/api/admin/destinations/:id/images', requireAdmin((req, res) => {
    const d = get('SELECT id FROM destinations WHERE id = ?', [req.params.id]);
    if (!d) return notFound(res, 'No such destination');
    let f;
    try { f = imageFields(req.body || {}); } catch (e) { return badRequest(res, e.message); }
    if (!f.url) return badRequest(res, 'An image URL is required');
    const next = get(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM destination_images WHERE destination_id = ?',
      [d.id]
    );
    const info = run(
      `INSERT INTO destination_images (destination_id, image_url, caption, credit, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [d.id, f.url, f.caption || null, f.credit || null, f.sort === undefined ? next.n : f.sort]
    );
    return created(res, {
      image: get('SELECT * FROM destination_images WHERE id = ?', [info.lastInsertRowid]),
    });
  }));

  router.patch('/api/admin/destination-images/:imageId', requireAdmin((req, res) => {
    const row = get('SELECT * FROM destination_images WHERE id = ?', [req.params.imageId]);
    if (!row) return notFound(res, 'No such image');
    let f;
    try { f = imageFields(req.body || {}); } catch (e) { return badRequest(res, e.message); }
    const sets = [];
    const params = [];
    if (f.url !== undefined) { sets.push('image_url = ?'); params.push(f.url); }
    if (f.caption !== undefined) { sets.push('caption = ?'); params.push(f.caption || null); }
    if (f.credit !== undefined) { sets.push('credit = ?'); params.push(f.credit || null); }
    if (f.sort !== undefined) { sets.push('sort_order = ?'); params.push(f.sort); }
    if (!sets.length) return badRequest(res, 'Nothing to update');
    params.push(row.id);
    run(`UPDATE destination_images SET ${sets.join(', ')} WHERE id = ?`, params);
    return ok(res, { image: get('SELECT * FROM destination_images WHERE id = ?', [row.id]) });
  }));

  router.delete('/api/admin/destination-images/:imageId', requireAdmin((req, res) => {
    const row = get('SELECT id FROM destination_images WHERE id = ?', [req.params.imageId]);
    if (!row) return notFound(res, 'No such image');
    run('DELETE FROM destination_images WHERE id = ?', [row.id]);
    return ok(res, { deleted: true });
  }));

  /* =====================================================================
     FAQS
     ===================================================================== */
  router.get('/api/faqs', (req, res) => {
    const { category, activity, destination } = req.query;
    let sql = 'SELECT id, question, answer, category, activity, destination_slug FROM faqs WHERE published = 1';
    const params = [];
    if (category) { sql += ' AND category = ?'; params.push(String(category)); }
    // A null activity/destination means "applies site-wide", so these filters
    // include the general FAQs rather than excluding them.
    if (activity) { sql += ' AND (activity IS NULL OR activity = ?)'; params.push(String(activity)); }
    if (destination) { sql += ' AND (destination_slug IS NULL OR destination_slug = ?)'; params.push(String(destination)); }
    sql += ' ORDER BY category, sort_order, id';

    const rows = all(sql, params);
    const byCategory = {};
    for (const r of rows) (byCategory[r.category] ||= []).push(r);

    return ok(res, {
      faqs: rows,
      categories: Object.keys(byCategory).map(key => ({ key, count: byCategory[key].length })),
      grouped: byCategory,
      total: rows.length,
    });
  });

  router.get('/api/admin/faqs', requireAdmin((req, res) => ok(res, {
    faqs: all('SELECT * FROM faqs ORDER BY category, sort_order, id'),
  })));

  const validateFaq = (b, { partial = false } = {}) => {
    const out = {};
    const need = f => !partial || b[f] !== undefined;
    if (need('question')) {
      const v = String(b.question || '').trim();
      if (!v) return { error: 'question is required' };
      if (v.length > 300) return { error: 'question is too long (300 characters max)' };
      out.question = v;
    }
    if (need('answer')) {
      const v = String(b.answer || '').trim();
      if (!v) return { error: 'answer is required' };
      if (v.length > 5000) return { error: 'answer is too long (5000 characters max)' };
      out.answer = v;
    }
    if (b.category !== undefined) {
      const v = String(b.category || '').trim().toLowerCase();
      if (!/^[a-z-]{2,40}$/.test(v)) return { error: 'category must be 2-40 lowercase letters or hyphens' };
      out.category = v;
    }
    if (b.activity !== undefined) out.activity = b.activity ? String(b.activity).trim() : null;
    if (b.destinationSlug !== undefined) out.destination_slug = b.destinationSlug ? String(b.destinationSlug).trim() : null;
    if (b.sortOrder !== undefined) {
      if (!Number.isInteger(b.sortOrder)) return { error: 'sortOrder must be a whole number' };
      out.sort_order = b.sortOrder;
    }
    if (b.published !== undefined) out.published = b.published ? 1 : 0;
    return { value: out };
  };

  router.post('/api/admin/faqs', requireAdmin((req, res) => {
    const { error, value } = validateFaq(req.body || {});
    if (error) return badRequest(res, error);
    const cols = Object.keys(value);
    const info = run(
      `INSERT INTO faqs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => value[c])
    );
    return created(res, { faq: get('SELECT * FROM faqs WHERE id = ?', [info.lastInsertRowid]) });
  }));

  router.patch('/api/admin/faqs/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM faqs WHERE id = ?', [req.params.id]);
    if (!row) return notFound(res, 'No such FAQ');
    const { error, value } = validateFaq(req.body || {}, { partial: true });
    if (error) return badRequest(res, error);
    const cols = Object.keys(value);
    if (!cols.length) return badRequest(res, 'Nothing to update');
    run(`UPDATE faqs SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => value[c]), row.id]);
    return ok(res, { faq: get('SELECT * FROM faqs WHERE id = ?', [row.id]) });
  }));

  router.delete('/api/admin/faqs/:id', requireAdmin((req, res) => {
    const row = get('SELECT id FROM faqs WHERE id = ?', [req.params.id]);
    if (!row) return notFound(res, 'No such FAQ');
    run('DELETE FROM faqs WHERE id = ?', [row.id]);
    return ok(res, { deleted: true });
  }));

  /* =====================================================================
     IMPACT

     GET /api/impact?year=YYYY

     Returns three distinct things, kept apart on purpose:

       published  — metrics an admin entered AND marked evidenced. Facts.
       pending    — metrics with no value or not yet evidenced, each with the
                    note saying what has to be supplied. The page shows these
                    as gaps rather than hiding them, because a progress
                    report with the awkward rows quietly removed is not a
                    progress report.
       derived    — figures computed from rows this system actually holds
                    (departures that ran, average group size). Labelled as
                    derived so they are never read as audited.
     ===================================================================== */
  router.get('/api/impact', (req, res) => {
    let year = new Date().getFullYear();
    if (req.query.year) {
      if (!/^\d{4}$/.test(req.query.year)) return badRequest(res, 'year must be a four-digit year');
      year = Number(req.query.year);
    }

    const metrics = all(
      'SELECT * FROM impact_metrics WHERE year = ? AND published = 1 ORDER BY dimension, sort_order, id',
      [year]
    );
    const hasValue = m => m.value !== null && m.value !== undefined && String(m.value).trim() !== '';
    const published = metrics.filter(m => hasValue(m) && m.evidenced === 1);
    const pending = metrics.filter(m => !(hasValue(m) && m.evidenced === 1));

    // Derived figures. Only from departures that have actually finished, so
    // this never counts a trip that has not run yet.
    const departures = all(
      `SELECT d.id, d.capacity, d.seats_booked, d.start_date, d.end_date, t.name tour_name
         FROM departures d JOIN tours t ON t.id = d.tour_id
        WHERE d.status != 'cancelled'
          AND strftime('%Y', d.start_date) = ?
          AND date(d.end_date) < date('now')`,
      [String(year)]
    );
    const withRiders = departures.filter(d => d.seats_booked > 0);
    const derived = {
      departures_completed: departures.length,
      travellers: withRiders.reduce((s, d) => s + d.seats_booked, 0),
      average_group_size: withRiders.length
        ? Math.round((withRiders.reduce((s, d) => s + d.seats_booked, 0) / withRiders.length) * 10) / 10
        : null,
      largest_group: withRiders.length ? Math.max(...withRiders.map(d => d.seats_booked)) : null,
      // The cap, which is a policy rather than an outcome, and is worth
      // publishing precisely because it is verifiable from the catalogue.
      max_group_size_offered: (get('SELECT MAX(group_size_max) m FROM tours WHERE published = 1') || {}).m || null,
    };

    const records = all(
      `SELECT COUNT(*) n,
              SUM(local_supplier_spend_cents) supplier,
              SUM(guide_wages_cents) wages,
              SUM(local_accommodation_nights) nights,
              SUM(community_contribution_cents) community,
              SUM(trail_contribution_cents) trail,
              SUM(transport_km) transport_km
         FROM impact_records WHERE year = ?`,
      [year]
    )[0];

    const years = all('SELECT DISTINCT year FROM impact_metrics ORDER BY year DESC').map(r => r.year);

    return ok(res, {
      year,
      years,
      dimensions: IMPACT_DIMENSIONS,
      published: published.map(m => ({
        key: m.metric_key, label: m.label, value: m.value, unit: m.unit,
        dimension: m.dimension, source: m.source, evidenced: true,
      })),
      pending: pending.map(m => ({
        key: m.metric_key, label: m.label, unit: m.unit, dimension: m.dimension,
        // The reason it is not published, in the words of whoever has to fix
        // it. Shown on the page — a visible gap is the point.
        needs: m.notes,
        has_value: hasValue(m),
        evidenced: m.evidenced === 1,
      })),
      derived,
      // How many operational records exist behind all of this. Zero is the
      // honest answer today and the page says so rather than implying the
      // metrics are merely unpublished rather than unmeasured.
      records: {
        count: records.n || 0,
        local_supplier_spend_cents: records.supplier,
        guide_wages_cents: records.wages,
        local_accommodation_nights: records.nights,
        community_contribution_cents: records.community,
        trail_contribution_cents: records.trail,
        transport_km: records.transport_km,
      },
    });
  });

  router.get('/api/admin/impact/metrics', requireAdmin((req, res) => ok(res, {
    metrics: all('SELECT * FROM impact_metrics ORDER BY year DESC, dimension, sort_order'),
    dimensions: IMPACT_DIMENSIONS,
  })));

  router.patch('/api/admin/impact/metrics/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM impact_metrics WHERE id = ?', [req.params.id]);
    if (!row) return notFound(res, 'No such metric');
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.value !== undefined) {
      const v = b.value === null ? null : String(b.value).trim();
      if (v && v.length > 120) return badRequest(res, 'value is too long (120 characters max)');
      sets.push('value = ?'); params.push(v || null);
    }
    if (b.label !== undefined) {
      const v = String(b.label || '').trim();
      if (!v) return badRequest(res, 'label cannot be empty');
      sets.push('label = ?'); params.push(v.slice(0, 200));
    }
    if (b.unit !== undefined) { sets.push('unit = ?'); params.push(b.unit ? String(b.unit).trim().slice(0, 40) : null); }
    if (b.notes !== undefined) { sets.push('notes = ?'); params.push(b.notes ? String(b.notes).trim().slice(0, 2000) : null); }
    if (b.source !== undefined) { sets.push('source = ?'); params.push(b.source ? String(b.source).trim().slice(0, 500) : null); }
    if (b.published !== undefined) { sets.push('published = ?'); params.push(b.published ? 1 : 0); }
    if (b.evidenced !== undefined) {
      // Marking a metric evidenced with no value behind it would publish an
      // empty fact. Refuse, and say which order to do it in.
      const finalValue = b.value !== undefined ? b.value : row.value;
      if (b.evidenced && (finalValue === null || String(finalValue).trim() === '')) {
        return badRequest(res, 'Enter the figure before marking it evidenced — an evidenced metric with no value would publish an empty claim.');
      }
      sets.push('evidenced = ?'); params.push(b.evidenced ? 1 : 0);
    }
    if (!sets.length) return badRequest(res, 'Nothing to update');
    params.push(row.id);
    run(`UPDATE impact_metrics SET ${sets.join(', ')} WHERE id = ?`, params);
    return ok(res, { metric: get('SELECT * FROM impact_metrics WHERE id = ?', [row.id]) });
  }));

  router.post('/api/admin/impact/metrics', requireAdmin((req, res) => {
    const b = req.body || {};
    const year = Number(b.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return badRequest(res, 'year must be a four-digit year');
    const key = String(b.metricKey || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,60}$/.test(key)) return badRequest(res, 'metricKey must be 2-60 lowercase letters, numbers or underscores');
    const label = String(b.label || '').trim();
    if (!label) return badRequest(res, 'label is required');
    if (!IMPACT_DIMENSIONS.some(d => d.key === b.dimension)) {
      return badRequest(res, `dimension must be one of: ${IMPACT_DIMENSIONS.map(d => d.key).join(', ')}`);
    }
    if (get('SELECT id FROM impact_metrics WHERE year = ? AND metric_key = ?', [year, key])) {
      return badRequest(res, 'A metric with that key already exists for that year');
    }
    const value = b.value === undefined || b.value === null ? null : String(b.value).trim() || null;
    if (b.evidenced && !value) {
      return badRequest(res, 'Enter the figure before marking it evidenced.');
    }
    const info = run(
      `INSERT INTO impact_metrics (year, metric_key, label, value, unit, dimension, notes, source, evidenced, sort_order, published)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [year, key, label.slice(0, 200), value,
       b.unit ? String(b.unit).trim().slice(0, 40) : null, b.dimension,
       b.notes ? String(b.notes).trim().slice(0, 2000) : null,
       b.source ? String(b.source).trim().slice(0, 500) : null,
       b.evidenced ? 1 : 0, Number.isInteger(b.sortOrder) ? b.sortOrder : 99,
       b.published === false ? 0 : 1]
    );
    return created(res, { metric: get('SELECT * FROM impact_metrics WHERE id = ?', [info.lastInsertRowid]) });
  }));

  router.delete('/api/admin/impact/metrics/:id', requireAdmin((req, res) => {
    const row = get('SELECT id FROM impact_metrics WHERE id = ?', [req.params.id]);
    if (!row) return notFound(res, 'No such metric');
    run('DELETE FROM impact_metrics WHERE id = ?', [row.id]);
    return ok(res, { deleted: true });
  }));

  /* ---- operational records: what was actually spent, per departure ---- */
  router.get('/api/admin/impact/records', requireAdmin((req, res) => {
    let sql = `SELECT r.*, t.name tour_name, d.start_date
                 FROM impact_records r
                 LEFT JOIN tours t ON t.id = r.tour_id
                 LEFT JOIN departures d ON d.id = r.departure_id`;
    const params = [];
    if (req.query.year) {
      if (!/^\d{4}$/.test(req.query.year)) return badRequest(res, 'year must be a four-digit year');
      sql += ' WHERE r.year = ?';
      params.push(Number(req.query.year));
    }
    sql += ' ORDER BY r.year DESC, r.id DESC';
    return ok(res, { records: all(sql, params) });
  }));

  const RECORD_NUMERIC = [
    ['localSupplierSpend', 'local_supplier_spend_cents', 'cents', 0, 100000000],
    ['guideWages', 'guide_wages_cents', 'cents', 0, 100000000],
    ['localAccommodationNights', 'local_accommodation_nights', 'nights', 0, 10000],
    ['communityContribution', 'community_contribution_cents', 'cents', 0, 100000000],
    ['trailContribution', 'trail_contribution_cents', 'cents', 0, 100000000],
    ['transportKm', 'transport_km', 'km', 0, 100000],
    ['groupSize', 'group_size', 'people', 0, 200],
  ];
  const TRANSPORT_TYPES = ['bus', 'jeep', 'domestic_flight', 'mixed', 'none'];

  router.post('/api/admin/impact/records', requireAdmin((req, res) => {
    const b = req.body || {};
    const year = Number(b.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return badRequest(res, 'year must be a four-digit year');

    let tourId = null;
    let departureId = null;
    if (b.departureId) {
      const d = get('SELECT id, tour_id FROM departures WHERE id = ?', [b.departureId]);
      if (!d) return notFound(res, 'No such departure');
      departureId = d.id;
      tourId = d.tour_id;
    } else if (b.tourId) {
      const t = get('SELECT id FROM tours WHERE id = ?', [b.tourId]);
      if (!t) return notFound(res, 'No such adventure');
      tourId = t.id;
    }

    const cols = { year, tour_id: tourId, departure_id: departureId };
    for (const [field, col, unit, min, max] of RECORD_NUMERIC) {
      if (b[field] === undefined || b[field] === null || b[field] === '') continue;
      const n = Number(b[field]);
      if (!Number.isFinite(n) || n < min || n > max) {
        return badRequest(res, `${field} must be a number between ${min} and ${max} ${unit}`);
      }
      cols[col] = col.endsWith('_cents') ? Math.round(n) : n;
    }
    if (b.transportType) {
      if (!TRANSPORT_TYPES.includes(b.transportType)) {
        return badRequest(res, `transportType must be one of: ${TRANSPORT_TYPES.join(', ')}`);
      }
      cols.transport_type = b.transportType;
    }
    for (const [field, col] of [['wasteInitiatives', 'waste_initiatives'], ['singleUsePlasticNotes', 'single_use_plastic_notes'], ['notes', 'notes'], ['recordedBy', 'recorded_by']]) {
      if (b[field] === undefined) continue;
      cols[col] = b[field] ? String(b[field]).trim().slice(0, 2000) : null;
    }
    if (b.currency) cols.currency = String(b.currency).trim().toUpperCase().slice(0, 3);

    const keys = Object.keys(cols);
    const info = run(
      `INSERT INTO impact_records (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map(k => cols[k])
    );
    return created(res, { record: get('SELECT * FROM impact_records WHERE id = ?', [info.lastInsertRowid]) });
  }));

  router.delete('/api/admin/impact/records/:id', requireAdmin((req, res) => {
    const row = get('SELECT id FROM impact_records WHERE id = ?', [req.params.id]);
    if (!row) return notFound(res, 'No such record');
    run('DELETE FROM impact_records WHERE id = ?', [row.id]);
    return ok(res, { deleted: true });
  }));

  /* =====================================================================
     GET /api/when-to-visit — the month-by-month page.

     Built entirely from each adventure's best_season, so it cannot
     contradict what a trip's own page says. The conditions text per month is
     general Nepali seasonality, which is a fact about the country rather
     than a forecast; the page says explicitly that conditions vary.
     ===================================================================== */
  const MONTH_NOTES = [
    ['January', 'Clear and cold. Settled weather and the best mountain visibility of the year, but hard frosts above 3,000 m and snow closing the high passes. Low-altitude riding around Pokhara and the Kathmandu Valley is at its best.'],
    ['February', 'Still cold at altitude, warming in the valleys. Haze starts to build on the plains. High passes remain unreliable.'],
    ['March', 'Spring opens up. Warm days, rhododendron coming into flower in the middle hills, and the high routes starting to clear. Visibility is hazier than autumn.'],
    ['April', 'Warm and busy. Good conditions on most routes and the main pre-monsoon trekking and riding window. Afternoon cloud builds in the hills.'],
    ['May', 'Hot and hazy low down, good high up. The last reliable month before the monsoon, and the high passes are generally open.'],
    ['June', 'Monsoon arrives. Wet trails, leeches in the forest, and a real landslide risk on mountain roads. Upper Mustang, in the rain shadow, keeps going.'],
    ['July', 'Deep monsoon everywhere except the rain-shadow valleys. Mustang is the trip that works this month.'],
    ['August', 'As July. Green, humid, and unreliable except behind the Annapurna and Dhaulagiri wall.'],
    ['September', 'The monsoon withdraws through the month. Trails are green and washed clean, and the second half of September is often superb. Some road sections still need repair.'],
    ['October', 'The best month of the year for most of the country. Stable weather, clean air and the clearest mountain views. Also the busiest.'],
    ['November', 'October conditions with fewer people and colder nights. Excellent for high routes early in the month.'],
    ['December', 'Cold, clear and quiet. High passes are closing or closed; the Kathmandu Valley and Pokhara ride beautifully.'],
  ];

  router.get('/api/when-to-visit', (req, res) => {
    const { seasonCoversMonth } = require('../lib/adventures');
    const pub = publicWhere('t');
    const rows = all(`SELECT t.* FROM tours t WHERE ${pub.sql}`, pub.params);
    return ok(res, {
      months: MONTH_NOTES.map(([name, conditions], i) => {
        const month = i + 1;
        const matching = rows.filter(r => seasonCoversMonth(r.best_season, month));
        return {
          month,
          name,
          conditions,
          adventure_count: matching.length,
          adventures: matching
            .sort((a, b) => b.price_from_cents - a.price_from_cents)
            .slice(0, 4)
            .map(r => shapeAdventure(r)),
        };
      }),
      caveat: 'These are typical conditions, not a forecast. Himalayan weather varies year to year, '
        + 'and a route is confirmed close to departure rather than months out.',
    });
  });
}

module.exports = { register, IMPACT_DIMENSIONS };
