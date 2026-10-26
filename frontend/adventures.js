/* ===========================================================================
   UNIVERSAL ADVENTURE COMPONENTS + PAGE LOGIC

   Loaded after main.js on every page that shows adventures. main.js keeps
   doing what it already did — the booking flow, the account modal, the
   mountain-bike tour catalogue, the elevation chart — and this file owns
   everything the universal adventure model added.

   The split is deliberate rather than tidy-minded: main.js is 3,300 lines
   that a working checkout depends on, and rewriting it to be
   activity-agnostic would have meant re-testing payment. Everything new is
   here, built on /api/adventures, and the two meet only through the small
   set of globals main.js already exposes (escapeHtml, apiGet, showToast).

   STRUCTURE
     1. helpers
     2. universal components  — card, difficulty meter, at-a-glance, empties
     3. page controllers      — each runs only if its root element exists,
                                the same pattern main.js uses, so one file
                                can serve every page without a router.
   =========================================================================== */
(function () {
  'use strict';

  /* =======================================================================
     1. HELPERS
     ======================================================================= */

  var API = (typeof API_BASE !== 'undefined' && API_BASE) || window.HIGHROUTE_API_BASE || 'http://localhost:4000';

  /** Escape on render, at every interpolation site. Falls back to its own
   *  implementation if main.js is not present, so a page can load this file
   *  alone. */
  var esc = typeof escapeHtml === 'function' ? escapeHtml : function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** GET JSON. Resolves to null on any failure rather than throwing, because
   *  every caller's correct response to a failure is the same: render the
   *  page's error state. A rejected promise here just meant a .catch() on
   *  every single call site. */
  function jget(path) {
    return fetch(API + path, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function jpost(path, body, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API + path, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      })
      .catch(function () { return { ok: false, status: 0, data: { error: 'Could not reach the server. Check your connection and try again.' } }; });
  }

  var CURRENCY_SYMBOL = { EUR: '€', USD: '$', GBP: '£', NPR: 'Rs ' };

  function money(cents, currency) {
    if (cents === null || cents === undefined) return null;
    var sym = CURRENCY_SYMBOL[currency || 'EUR'] || (currency || '') + ' ';
    return sym + Math.round(cents / 100).toLocaleString();
  }

  /** Formats a number with thousands separators, or returns null.
   *
   *  Null and 0 are different answers and this keeps them different. A day
   *  with 0 km is a rest day; an adventure with no elevation_gain_m recorded
   *  is not a trip with no climbing. Printing "0 m" for the second is the
   *  failure mode this whole function exists to avoid, so callers get null
   *  and decide what absence should say.
   */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString() : null;
  }

  function fmtDate(iso, opts) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, opts || { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }

  /** Sets the document title and meta description from the page's content,
   *  which the brief's SEO section asks for and which a static <title> on a
   *  template-driven page cannot do. */
  function setMeta(title, description) {
    if (title) document.title = title;
    if (description) {
      var m = document.querySelector('meta[name="description"]');
      if (m) m.setAttribute('content', description);
    }
    // Keep Open Graph in step rather than letting it describe the template.
    [['og:title', title], ['og:description', description]].forEach(function (pair) {
      if (!pair[1]) return;
      var el = document.querySelector('meta[property="' + pair[0] + '"]');
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute('property', pair[0]);
        document.head.appendChild(el);
      }
      el.setAttribute('content', pair[1]);
    });
    // The canonical URL is set by shell.js on every page, keeping only the
    // parameters that change what the page is. This used to overwrite it
    // with the full query string — filters, tracking parameters and all —
    // which made every filtered view its own page to a search engine.
  }

  /** Reads the rider's session token the way main.js stores it, so a form
   *  here can post to an authenticated endpoint. Returns null when signed
   *  out, which the caller must handle by asking them to sign in rather than
   *  by posting and getting a 401. */
  function riderToken() {
    try {
      // 'hr_rider_token' is the key main.js's Auth actually writes. This used
      // to read only 'highroute_token' / 'hr_token' — keys nothing sets — so
      // a signed-in rider was always treated as signed out, and Private Trips
      // could never be submitted at all. The old keys stay as fallbacks.
      return localStorage.getItem('hr_rider_token')
        || localStorage.getItem('highroute_token')
        || localStorage.getItem('hr_token')
        || sessionStorage.getItem('highroute_token')
        || null;
    } catch (e) {
      return null; // private mode / storage blocked
    }
  }

  /* =======================================================================
     2. UNIVERSAL COMPONENTS
     ======================================================================= */

  /** The availability line on a card.
   *
   *  Three states, matching exactly what the data can support: a real open
   *  departure with seats, a trip whose dates are all gone or cancelled, and
   *  a trip that has never had a departure scheduled. There is deliberately
   *  no "selling fast" or "only 2 left!" unless seats_available really is 2
   *  on a real row — the brief forbids invented scarcity and that is the
   *  easiest line in the world to cross by accident.
   */
  function availability(a) {
    var deps = a.departures || [];
    var open = deps.filter(function (d) { return d.status !== 'cancelled' && d.seats_available > 0; });
    if (open.length) {
      var next = open[0];
      if (next.status === 'request_only') return { pip: 'pip-amber', text: 'Request only' };
      return {
        pip: next.seats_available <= 3 ? 'pip-amber' : 'pip-green',
        text: next.seats_available + ' ' + plural(next.seats_available, 'space') + ' left',
      };
    }
    if (deps.length) return { pip: 'pip-amber', text: 'No dates currently open' };
    return { pip: 'pip-amber', text: 'Dates on request' };
  }

  /** The metric row on a card.
   *
   *  Built from whichever figures this adventure actually has, which is how
   *  one card renders a bike trip and a rafting trip. Caps at three so the
   *  row never wraps into a block, and prefers the activity's own glance
   *  fields (river days, walking hours) over the generic ones.
   */
  function cardMetrics(a) {
    var out = [];
    (a.activity_glance || []).forEach(function (f) {
      if (out.length >= 3) return;
      if (f.type === 'number') {
        var n = num(f.value);
        if (n) out.push({ value: n + (f.unit ? f.unit : ''), label: f.label });
      }
    });
    if (out.length < 3 && num(a.distance_km) && !out.some(function (m) { return /km/.test(m.value); })) {
      out.push({ value: num(a.distance_km) + 'km', label: 'distance' });
    }
    if (out.length < 3 && num(a.elevation_gain_m)) {
      out.push({ value: '+' + num(a.elevation_gain_m) + 'm', label: 'climbing' });
    }
    if (out.length < 3 && num(a.max_altitude_m)) {
      out.push({ value: num(a.max_altitude_m) + 'm', label: 'max alt.' });
    }
    if (out.length < 3) out.push({ value: a.duration_days + '', label: plural(a.duration_days, 'day') });
    return out.slice(0, 3);
  }

  var FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1652361561822-b2aa3f30416a?auto=format&fit=crop&w=1200&q=80';

  /** THE universal adventure card. Every listing on the site uses this one
   *  function — homepage, adventures listing, search, destination page,
   *  finder results, when-to-visit. The brief's "reusable components" and
   *  "single source of truth" both come down to there being one of these. */
  function advCard(a, opts) {
    opts = opts || {};
    var avail = availability(a);
    var href = 'tour-detail.html?slug=' + encodeURIComponent(a.slug);
    var level = a.difficulty || {};
    var metrics = cardMetrics(a);

    var facts = [a.duration_days + ' ' + plural(a.duration_days, 'day')];
    if (a.best_season) facts.push(a.best_season);
    if (a.accommodation_type) facts.push(a.accommodation_type.charAt(0).toUpperCase() + a.accommodation_type.slice(1));
    facts.push('Max ' + a.group_size_max);

    var nextDep = (a.departures || []).filter(function (d) {
      return d.status !== 'cancelled' && d.seats_available > 0;
    })[0];

    return ''
      + '<article class="adv-card">'
      +   '<div class="adv-media">'
      +     '<img src="' + esc(a.image_url || FALLBACK_IMAGE) + '" alt="' + esc(a.name) + '"'
      +       (opts.eager ? '' : ' loading="lazy"') + ' decoding="async" width="600" height="400">'
      +     '<div class="adv-badges">'
      +       '<span class="adv-badge adv-badge-activity">' + esc(a.activity_label || a.activity) + '</span>'
      +       '<span class="adv-badge">' + esc((level.label || 'Level ' + a.difficulty_level)) + '</span>'
      +     '</div>'
      +     (a.region ? '<span class="adv-place">' + esc(a.region) + '</span>' : '')
      +   '</div>'
      +   '<div class="adv-body">'
      +     '<h3><a href="' + href + '">' + esc(a.name) + '</a></h3>'
      +     (a.summary ? '<p class="adv-summary">' + esc(a.summary) + '</p>' : '')
      +     '<div class="adv-facts">' + facts.map(function (f) { return '<span>' + esc(f) + '</span>'; }).join('') + '</div>'
      +     '<div class="adv-metrics">'
      +       metrics.map(function (m) {
                return '<div><b>' + esc(m.value) + '</b><span>' + esc(m.label) + '</span></div>';
              }).join('')
      +     '</div>'
      +     '<div class="adv-facts" style="margin-bottom:12px">'
      +       '<span><span class="pip ' + avail.pip + '"></span>' + esc(avail.text) + '</span>'
      +     '</div>'
      +     '<div class="adv-foot">'
      +       '<div class="adv-price">From <b>' + esc(money(a.price_from_cents, a.currency)) + '</b></div>'
      +       '<a href="' + href + '" class="adv-link">View adventure →</a>'
      +     '</div>'
      +   '</div>'
      +   (nextDep
            ? '<p class="adv-dep">Next departure <b>' + esc(fmtDate(nextDep.start_date)) + '</b></p>'
            : '')
      + '</article>';
  }

  /** Pretty-prints an activity slug for a card pill. The labelled version
   *  comes from the API wherever the API was asked; this is for the index
   *  payload, which carries slugs only. */
  function activityLabel(slug) {
    return String(slug || '').replace(/-/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  /** THE universal destination card. See the note above renderCards for why
   *  it is not shaped like the adventure card. */
  function destCard(d, opts) {
    opts = opts || {};
    var href = 'destination.html?d=' + encodeURIComponent(d.slug);
    var intro = String(d.intro || d.description || '');

    // The two facts that decide whether you can go, in their short form.
    // best_time and elevation_range are paragraphs and belong on the page.
    var facts = [];
    if (d.altitude_summary) facts.push(['Elevation', d.altitude_summary]);
    else if (d.elevation_range && d.elevation_range.length <= 26) facts.push(['Elevation', d.elevation_range]);
    if (d.best_months) facts.push(['Best months', d.best_months]);

    // What this destination is described as suiting. Shown even where
    // nothing is published yet, because "Everest, trekking, no trips on the
    // site" is the honest answer and the destination page says so too.
    var acts = (d.declared_activities && d.declared_activities.length)
      ? d.declared_activities
      : (d.activities || []);

    var count = d.adventure_count;
    var tag = count ? count + ' ' + plural(count, 'adventure') : 'Trips on request';

    return ''
      + '<a class="dest-card" href="' + href + '">'
      +   '<div class="dest-card-media">'
      +     (d.hero_image_url
              ? '<img src="' + esc(d.hero_image_url) + '" alt="" loading="lazy" decoding="async">'
              : '<span class="dest-card-noimg">No photo yet</span>')
      +     '<span class="dest-card-tag">' + esc(tag) + '</span>'
      +   '</div>'
      +   '<div class="dest-card-body">'
      +     (d.region && d.region !== d.name
              ? '<p class="dest-card-region">' + esc(d.region) + '</p>'
              : '<p class="dest-card-region">Nepal</p>')
      +     '<h3>' + esc(d.name) + '</h3>'
      +     (intro ? '<p class="dest-card-intro">' + esc(intro) + '</p>' : '')
      +     (!opts.compact && facts.length
              ? '<dl class="dest-card-facts">' + facts.map(function (f) {
                  return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>';
                }).join('') + '</dl>'
              : '')
      +     (!opts.compact && acts.length
              ? '<div class="pill-row">' + acts.slice(0, 3).map(function (a) {
                  return '<span class="pill">' + esc(activityLabel(a)) + '</span>';
                }).join('') + '</div>'
              : '')
      +     '<span class="dest-card-go">Explore ' + esc(d.name) + '</span>'
      +   '</div>'
      + '</a>';
  }

  /** Renders a list of adventures into a container, with an empty state that
   *  explains itself. `emptyHtml` lets a caller give a context-specific one —
   *  a trekking category with nothing in it needs to say something quite
   *  different from a filter combination that matched nothing. */
  function renderCards(container, adventures, emptyHtml, opts) {
    if (!container) return;
    if (!adventures || !adventures.length) {
      container.className = '';
      container.innerHTML = emptyHtml || ''
        + '<div class="empty-state"><h3>Nothing matches yet</h3>'
        + '<p>No adventures match what you have selected. Widening the dates or the difficulty usually finds something.</p>'
        + '<a href="adventures.html" class="btn btn-solid">See all adventures</a>'
        + '<a href="private-trips.html" class="btn btn-ghost">Have one built for you</a></div>';
      return;
    }
    container.className = 'adv-grid';
    container.innerHTML = adventures.map(function (a, i) {
      return advCard(a, { eager: i < 3 && !!(opts && opts.eagerFirst) });
    }).join('');
  }

  /** THE universal difficulty component.
   *
   *  Overall level plus the per-activity dimensions, where the dimension
   *  labels and descriptions come from the API. That is the whole point: this
   *  function has no idea that rafting is graded on swimming ability and
   *  trekking on terrain, and it does not need to.
   */
  function difficultyBlock(a) {
    var level = a.difficulty || {};
    var dims = (a.difficulty_dimensions || []).filter(function (d) { return d.score !== null; });

    var pips = function (score) {
      var out = '';
      for (var i = 1; i <= 5; i++) out += '<span class="diff-pip' + (i <= score ? ' on' : '') + '"></span>';
      return out;
    };

    return ''
      + '<div class="diff">'
      +   '<div class="diff-head">'
      +     '<span class="diff-level">' + a.difficulty_level + '<small>/5</small></span>'
      +     '<span class="diff-label">' + esc(level.label || '') + '</span>'
      +   '</div>'
      +   (level.meaning ? '<p class="diff-meaning">' + esc(level.meaning) + '</p>' : '')
      +   (level.commitment ? '<p class="diff-commitment">' + esc(level.commitment) + '</p>' : '')
      +   (dims.length
            ? '<div class="diff-dims">' + dims.map(function (d) {
                return '<div class="diff-dim">'
                  + '<span class="diff-dim-label">' + esc(d.label) + '</span>'
                  + '<span class="diff-bar" role="img" aria-label="' + esc(d.label) + ': ' + d.score + ' out of 5">'
                  +   pips(d.score)
                  + '</span>'
                  + '<p class="diff-dim-desc">' + esc(d.description || '') + '</p>'
                  + '</div>';
              }).join('') + '</div>'
            : '')
      +   // The migration seeded all three dimensions from the single overall
          // level, so a trip where they are all identical has not actually
          // been assessed. Saying so beats presenting three matching bars as
          // a judgement somebody made.
          (a.difficulty_assessed === false
            ? '<div class="note diff-unassessed"><div><p><strong>These three scores have not been assessed separately yet.</strong> '
              + 'They currently mirror the overall level, which came across when this trip was migrated from the '
              + 'old mountain-bike-only catalogue. Fitness, technical demand and altitude are genuinely different '
              + 'on most routes, and High Route needs to set them per trip in the admin panel.</p></div></div>'
            : '')
      + '</div>';
  }

  /** "Trip at a glance" — universal rows first, then whichever
   *  activity-specific fields this activity marks as glance fields. One
   *  template; a trekking page shows walking hours exactly where a riding
   *  page shows riding style, and neither shows the other's. */
  function glanceBlock(a) {
    var rows = [
      ['Activity', esc(a.activity_label || a.activity)],
      ['Duration', a.duration_days + ' ' + plural(a.duration_days, 'day')],
      ['Difficulty', a.difficulty_level + '/5 <small>' + esc((a.difficulty || {}).label || '') + '</small>'],
      ['Group size', a.group_size_min + '–' + a.group_size_max],
    ];
    if (a.accommodation_type) {
      rows.push(['Accommodation', esc(a.accommodation_type.charAt(0).toUpperCase() + a.accommodation_type.slice(1))]);
    }
    if (a.best_season) rows.push(['Best season', esc(a.best_season)]);
    if (a.trip_format) {
      rows.push(['Trip format', esc(a.trip_format.replace('-', ' ').replace(/^./, function (c) { return c.toUpperCase(); }))]);
    }
    if (num(a.max_altitude_m)) rows.push(['Highest point', num(a.max_altitude_m) + '<small> m</small>']);
    if (num(a.distance_km)) rows.push(['Distance', num(a.distance_km) + '<small> km</small>']);
    if (num(a.elevation_gain_m)) rows.push(['Total ascent', '+' + num(a.elevation_gain_m) + '<small> m</small>']);
    if (num(a.elevation_loss_m)) rows.push(['Total descent', '−' + num(a.elevation_loss_m) + '<small> m</small>']);

    (a.activity_glance || []).forEach(function (f) {
      var value = Array.isArray(f.value) ? f.value.join(', ') : f.value;
      if (value === null || value === undefined || value === '') return;
      // Skip anything already covered by a universal row above, so a bike
      // trip does not list its distance twice under two different names.
      if (/^riding_km$/.test(f.key) && num(a.distance_km)) return;
      if (/^highest_altitude_m$/.test(f.key) && num(a.max_altitude_m)) return;
      rows.push([f.label, esc(value) + (f.unit ? '<small> ' + esc(f.unit) + '</small>' : '')]);
    });

    return '<dl class="glance">' + rows.map(function (r) {
      return '<div><dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd></div>';
    }).join('') + '</dl>';
  }

  /** <details> accordion. No JS needed to open one, which is why it is built
   *  on the native element: keyboard support and screen-reader announcement
   *  come free, and the page still works if this file fails to load. */
  function accordion(items) {
    return '<div class="acc">' + items.map(function (it) {
      return '<details class="acc-item"' + (it.open ? ' open' : '') + '>'
        + '<summary>'
        +   (it.num ? '<span class="acc-num">' + esc(it.num) + '</span>' : '')
        +   '<span class="acc-title">' + esc(it.title) + '</span>'
        +   (it.aside ? '<span class="acc-aside">' + esc(it.aside) + '</span>' : '')
        + '</summary>'
        + '<div class="acc-body">' + it.body + '</div>'
        + '</details>';
    }).join('') + '</div>';
  }

  function errorState(container, what) {
    if (!container) return;
    container.innerHTML = ''
      + '<div class="empty-state"><h3>Could not load ' + esc(what) + '</h3>'
      + '<p>The site could not reach the database just now. This is a connection problem rather than an '
      + 'empty page — reloading usually fixes it.</p>'
      + '<button class="btn btn-solid" onclick="location.reload()">Reload</button></div>';
  }

  function loading(container, what) {
    if (container) container.innerHTML = '<p class="result-count" role="status">Loading ' + esc(what) + '…</p>';
  }

  /* =======================================================================
     3. PAGE CONTROLLERS
     ======================================================================= */

  /* ------------------------------------------------------------------
     ADVENTURES LISTING (adventures.html)

     Also serves the Mountain Biking / Trekking / Multi-Activity category
     pages via ?activity=, which is why there is one listing template rather
     than four near-identical pages. Filter state lives in the URL, so a
     filtered listing is shareable and the back button works.
     ------------------------------------------------------------------ */
  (function () {
    var root = $('#adv-listing');
    if (!root) return;

    var grid = $('#adv-results');
    var filtersEl = $('#adv-filters');
    var chipsEl = $('#adv-chips');
    var countEl = $('#adv-count');
    var sortEl = $('#adv-sort');
    var titleEl = $('#adv-page-title');
    var ledeEl = $('#adv-page-lede');

    // Multi-value filters are arrays in the URL as comma-separated lists;
    // single-value ones are scalars. Keeping that distinction here is what
    // lets the chip row know whether removing one value should clear the
    // filter or just drop that value.
    var MULTI = ['activity', 'destination', 'region', 'difficulty', 'duration', 'format', 'accommodation'];
    var SINGLE = ['month', 'minPrice', 'maxPrice', 'q', 'sort'];

    var state = {};
    function readUrl() {
      var p = new URLSearchParams(location.search);
      state = {};
      MULTI.forEach(function (k) {
        var v = p.get(k);
        if (v) state[k] = v.split(',').filter(Boolean);
      });
      SINGLE.forEach(function (k) {
        var v = p.get(k);
        if (v) state[k] = v;
      });
    }

    function toQuery() {
      var p = new URLSearchParams();
      Object.keys(state).forEach(function (k) {
        var v = state[k];
        if (Array.isArray(v)) { if (v.length) p.set(k, v.join(',')); }
        else if (v !== '' && v !== null && v !== undefined) p.set(k, v);
      });
      return p;
    }

    function pushUrl(replace) {
      var qs = toQuery().toString();
      var url = location.pathname + (qs ? '?' + qs : '');
      if (replace) history.replaceState(null, '', url);
      else history.pushState(null, '', url);
    }

    var meta = null;

    function filterGroup(title, key, options, labelKey, valueKey) {
      var current = state[key] || [];
      return ''
        + '<fieldset class="filter-group">'
        +   '<legend>' + esc(title) + '</legend>'
        +   options.map(function (o) {
              var value = String(o[valueKey]);
              var checked = current.indexOf(value) !== -1;
              var count = o.adventure_count;
              // A filter value that matches nothing is still shown but
              // disabled, so the set of options does not shuffle on every
              // interaction — a checkbox that vanishes as you use it is a
              // worse experience than one that is visibly unavailable.
              var disabled = count === 0 && !checked;
              return '<label class="filter-opt' + (disabled ? ' is-disabled' : '') + '">'
                + '<input type="checkbox" data-filter="' + esc(key) + '" value="' + esc(value) + '"'
                +   (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '>'
                + '<span>' + esc(o[labelKey]) + '</span>'
                + (count === undefined ? '' : '<span class="filter-opt-count">' + count + '</span>')
                + '</label>';
            }).join('')
        + '</fieldset>';
    }

    function renderFilters() {
      if (!filtersEl || !meta) return;
      var html = '';

      html += '<fieldset class="filter-group"><legend>Search</legend>'
        + '<label class="sr-only" for="adv-q">Search adventures</label>'
        + '<input type="search" id="adv-q" class="checkout-input" placeholder="Name, region, keyword"'
        + ' value="' + esc(state.q || '') + '">'
        + '</fieldset>';

      if ((meta.activities || []).length > 1) {
        html += filterGroup('Activity', 'activity', meta.activities, 'plural_label', 'slug');
      }
      html += filterGroup('Difficulty', 'difficulty', meta.difficulty_levels.map(function (l) {
        return { label: l.level + ' · ' + l.label, slug: String(l.level), adventure_count: l.adventure_count };
      }), 'label', 'slug');
      html += filterGroup('Duration', 'duration', meta.duration_bands, 'label', 'key');
      html += filterGroup('Destination', 'destination', (meta.destinations || []).filter(function (d) {
        return d.adventure_count > 0;
      }), 'name', 'slug');
      // Regions that no destination page covers. The API has always offered
      // these (an adventure whose destination is unset or unpublished has to
      // be reachable by SOME filter), but the panel never rendered them — so
      // such a trip could only be found by clearing every filter.
      if ((meta.regions || []).length) {
        html += filterGroup('Other regions', 'region', meta.regions.map(function (r) {
          return { name: r, slug: r };
        }), 'name', 'slug');
      }
      html += filterGroup('Trip format', 'format', meta.trip_formats, 'label', 'key');
      html += filterGroup('Accommodation', 'accommodation', meta.accommodation_types, 'label', 'key');

      html += '<fieldset class="filter-group"><legend>When</legend>'
        + '<label class="sr-only" for="adv-month">Month of travel</label>'
        + '<select id="adv-month" class="checkout-input">'
        +   '<option value="">Any month</option>'
        +   meta.months.map(function (m) {
              return '<option value="' + m.month + '"' + (String(state.month) === String(m.month) ? ' selected' : '') + '>'
                + esc(m.name) + ' (' + m.adventure_count + ')</option>';
            }).join('')
        + '</select></fieldset>';

      if (meta.price) {
        var maxUnits = Math.ceil(meta.price.max_cents / 100);
        var minUnits = Math.floor(meta.price.min_cents / 100);
        html += '<fieldset class="filter-group"><legend>Budget</legend>'
          + '<p class="filter-range"><label for="adv-maxprice">Up to '
          + '<output id="adv-maxprice-out">' + esc(money(state.maxPrice ? state.maxPrice * 100 : meta.price.max_cents, meta.price.currency)) + '</output>'
          + '</label>'
          + '<input type="range" id="adv-maxprice" min="' + minUnits + '" max="' + maxUnits + '" step="10"'
          + ' value="' + (state.maxPrice || maxUnits) + '"></p>'
          + '</fieldset>';
      }

      html += '<button type="button" class="btn btn-ghost btn-block filters-clear" id="adv-clear">Clear all filters</button>';
      filtersEl.innerHTML = html;
      wireFilters();
    }

    function wireFilters() {
      $$('[data-filter]', filtersEl).forEach(function (input) {
        input.addEventListener('change', function () {
          var key = input.getAttribute('data-filter');
          var list = state[key] ? state[key].slice() : [];
          var i = list.indexOf(input.value);
          if (input.checked && i === -1) list.push(input.value);
          if (!input.checked && i !== -1) list.splice(i, 1);
          if (list.length) state[key] = list; else delete state[key];
          apply();
        });
      });

      var q = $('#adv-q', filtersEl);
      if (q) {
        var timer = null;
        q.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(function () {
            if (q.value.trim()) state.q = q.value.trim(); else delete state.q;
            apply({ keepFocus: 'adv-q' });
          }, 350);
        });
      }

      var month = $('#adv-month', filtersEl);
      if (month) {
        month.addEventListener('change', function () {
          if (month.value) state.month = month.value; else delete state.month;
          apply();
        });
      }

      var price = $('#adv-maxprice', filtersEl);
      if (price) {
        var out = $('#adv-maxprice-out', filtersEl);
        price.addEventListener('input', function () {
          if (out) out.textContent = money(Number(price.value) * 100, meta.price.currency);
        });
        price.addEventListener('change', function () {
          if (Number(price.value) >= Math.ceil(meta.price.max_cents / 100)) delete state.maxPrice;
          else state.maxPrice = price.value;
          apply();
        });
      }

      var clear = $('#adv-clear', filtersEl);
      if (clear) {
        clear.addEventListener('click', function () {
          // Deliberately keeps nothing: "Clear all" that silently preserves
          // the activity is the single most confusing filter behaviour there
          // is. The category pages reach their state through the URL, and
          // the chip row above shows the activity as a removable filter like
          // any other, so clearing all of it is both honest and recoverable.
          state = {};
          apply();
        });
      }
    }

    var FILTER_LABELS = {
      activity: 'Activity', destination: 'Destination', region: 'Region', difficulty: 'Difficulty',
      duration: 'Duration', format: 'Format', accommodation: 'Accommodation',
      month: 'Month', maxPrice: 'Max price', minPrice: 'Min price', q: 'Search',
    };

    function labelFor(key, value) {
      if (!meta) return value;
      var find = function (list, vKey, lKey) {
        var hit = (list || []).filter(function (o) { return String(o[vKey]) === String(value); })[0];
        return hit ? hit[lKey] : value;
      };
      switch (key) {
        case 'activity': return find(meta.activities, 'slug', 'plural_label');
        case 'destination': return find(meta.destinations, 'slug', 'name');
        case 'duration': return find(meta.duration_bands, 'key', 'label');
        case 'format': return find(meta.trip_formats, 'key', 'label');
        case 'accommodation': return find(meta.accommodation_types, 'key', 'label');
        case 'difficulty': return find(meta.difficulty_levels, 'level', 'label');
        case 'month': return find(meta.months, 'month', 'name');
        case 'maxPrice': return 'up to ' + money(Number(value) * 100, meta.price && meta.price.currency);
        default: return value;
      }
    }

    function renderChips() {
      if (!chipsEl) return;
      var chips = [];
      Object.keys(state).forEach(function (key) {
        if (key === 'sort') return;
        var v = state[key];
        (Array.isArray(v) ? v : [v]).forEach(function (one) {
          chips.push('<span class="chip">' + esc(FILTER_LABELS[key] || key) + ': ' + esc(labelFor(key, one))
            + '<button type="button" data-remove-key="' + esc(key) + '" data-remove-value="' + esc(one) + '"'
            + ' aria-label="Remove filter ' + esc(FILTER_LABELS[key] || key) + ' ' + esc(labelFor(key, one)) + '">×</button></span>');
        });
      });
      if (!chips.length) { chipsEl.innerHTML = ''; return; }
      chips.push('<button type="button" class="chip chip-clear" id="adv-chip-clear">Clear all</button>');
      chipsEl.innerHTML = chips.join('');
      $$('[data-remove-key]', chipsEl).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.getAttribute('data-remove-key');
          var value = btn.getAttribute('data-remove-value');
          if (Array.isArray(state[key])) {
            state[key] = state[key].filter(function (x) { return x !== value; });
            if (!state[key].length) delete state[key];
          } else {
            delete state[key];
          }
          apply();
        });
      });
      var clearAll = $('#adv-chip-clear', chipsEl);
      if (clearAll) clearAll.addEventListener('click', function () { state = {}; apply(); });
    }

    /** The page's heading and intro, which change with the activity filter.
     *  This is what makes adventures.html?activity=trekking a real page with
     *  its own title and description rather than a filtered view with a
     *  generic heading. */
    function renderHeading() {
      var acts = state.activity || [];
      var one = acts.length === 1 && meta
        ? (meta.activities || []).filter(function (a) { return a.slug === acts[0]; })[0]
        : null;
      var title = one ? one.plural_label : 'All Adventures';
      if (titleEl) titleEl.textContent = title;
      if (ledeEl && one) {
        ledeEl.textContent = (meta.activitySummaries && meta.activitySummaries[one.slug]) || ledeEl.textContent;
      }
      setMeta(
        title + ' in Nepal | High Route',
        one
          ? title + ' with High Route — small groups, Nepali guides, real departure dates and prices.'
          : 'Every High Route adventure in Nepal: mountain biking, trekking and multi-activity trips, filterable by difficulty, duration, destination and month.'
      );
    }

    var inFlight = 0;

    function apply(opts) {
      opts = opts || {};
      pushUrl(false);
      load(opts);
    }

    function load(opts) {
      opts = opts || {};
      var mine = ++inFlight;
      loading(grid, 'adventures');
      var qs = toQuery();
      jget('/api/adventures?' + qs.toString()).then(function (data) {
        // A slow earlier request must not overwrite a newer result. Typing
        // in the search box fires several of these and they can come back
        // out of order.
        if (mine !== inFlight) return;
        if (!data) return errorState(grid, 'adventures');

        renderCards(grid, data.adventures, emptyFor(), { eagerFirst: true });
        if (countEl) {
          countEl.innerHTML = '<b>' + data.total + '</b> ' + plural(data.total, 'adventure')
            + (data.total === 0 ? '' : ' found');
        }
        renderChips();
        renderHeading();
        if (opts.keepFocus) {
          var el = document.getElementById(opts.keepFocus);
          if (el && document.activeElement !== el) { /* leave focus where the user put it */ }
        }
      });
    }

    /** The empty state, specific to why it is empty. A disabled-but-listed
     *  category and a too-narrow filter combination are different problems
     *  and deserve different sentences. */
    function emptyFor() {
      var acts = state.activity || [];
      var others = Object.keys(state).filter(function (k) { return k !== 'activity' && k !== 'sort'; });
      if (acts.length === 1 && !others.length) {
        var name = labelFor('activity', acts[0]);
        return '<div class="empty-state">'
          + '<h3>No ' + esc(name).toLowerCase() + ' published yet</h3>'
          + '<p>This category is set up and ready — there are no trips in it on the site yet, and we are not '
          + 'going to list one that does not exist. If this is what you want to do in Nepal, tell us and we will '
          + 'build it: the guides, the permits and the logistics are the same ones we already run.</p>'
          + '<a href="private-trips.html?activity=' + encodeURIComponent(acts[0]) + '" class="btn btn-solid">Ask us to build one</a>'
          + '<a href="adventures.html" class="btn btn-ghost">See what is running</a>'
          + '</div>';
      }
      return null;
    }

    if (sortEl) {
      sortEl.addEventListener('change', function () {
        state.sort = sortEl.value;
        apply();
      });
    }

    window.addEventListener('popstate', function () {
      readUrl();
      if (sortEl && state.sort) sortEl.value = state.sort;
      renderFilters();
      load();
    });

    /* The filter rail, collapsed by default on a narrow screen. Collapsing
       is done here rather than with a <details> because the right default
       differs by viewport, and a <details open> attribute cannot. */
    (function wireFilterToggle() {
      var panel = $('#adv-filters-panel');
      var btn = $('#adv-filters-toggle');
      if (!panel || !btn) return;
      var narrow = window.matchMedia('(max-width: 980px)');
      var setState = function (collapsed) {
        panel.classList.toggle('is-collapsed', collapsed);
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.textContent = collapsed ? 'Filters' : 'Hide';
      };
      setState(narrow.matches);
      btn.addEventListener('click', function () {
        setState(!panel.classList.contains('is-collapsed'));
      });
      // Crossing the breakpoint resets to that viewport's sensible default,
      // but only if the reader has not touched the control themselves.
      var touched = false;
      btn.addEventListener('click', function () { touched = true; });
      var onChange = function () { if (!touched) setState(narrow.matches); };
      if (narrow.addEventListener) narrow.addEventListener('change', onChange);
      else if (narrow.addListener) narrow.addListener(onChange);
    })();

    readUrl();
    if (sortEl && state.sort) sortEl.value = state.sort;
    jget('/api/meta/filters').then(function (data) {
      meta = data;
      if (!meta) { errorState(filtersEl, 'the filters'); }
      else renderFilters();
      load();
    });
  })();

  /* ------------------------------------------------------------------
     DESTINATIONS INDEX (destinations.html)
     ------------------------------------------------------------------ */
  (function () {
    var grid = $('#dest-index');
    if (!grid) return;
    loading(grid, 'destinations');
    jget('/api/destination-pages').then(function (data) {
      if (!data) return errorState(grid, 'destinations');
      var rows = data.destinations || [];
      if (!rows.length) {
        grid.innerHTML = '<div class="empty-state"><h3>No destination pages yet</h3>'
          + '<p>Destination pages are written in the admin panel. None has content yet.</p>'
          + '<a href="adventures.html" class="btn btn-solid">Browse adventures instead</a></div>';
        return;
      }
      grid.className = 'dest-grid';
      grid.innerHTML = rows.map(function (d) { return destCard(d); }).join('');
    });
  })();

  /* ------------------------------------------------------------------
     DESTINATION DETAIL (destination.html?d=slug)
     ------------------------------------------------------------------ */
  (function () {
    var root = $('#dest-detail');
    if (!root) return;
    var slug = new URLSearchParams(location.search).get('d');
    if (!slug) {
      // A page-head with a real <h1>: every page needs exactly one, and an
      // empty state's own heading is only an <h3>.
      root.innerHTML = '<header class="page-head"><div class="wrap">'
        + '<p class="crumbs"><a href="index.html">Home</a><span>/</span><a href="destinations.html">Destinations</a></p>'
        + '<h1>No destination selected</h1></div></header>'
        + '<section class="section"><div class="wrap"><div class="empty-state">'
        + '<p>This page needs a destination in its address.</p>'
        + '<a href="destinations.html" class="btn btn-solid">All destinations</a></div></div></section>';
      return;
    }

    loading(root, 'this destination');
    jget('/api/destinations/' + encodeURIComponent(slug)).then(function (d) {
      if (!d) {
        root.innerHTML = '<header class="page-head"><div class="wrap">'
          + '<p class="crumbs"><a href="index.html">Home</a><span>/</span><a href="destinations.html">Destinations</a></p>'
          + '<h1>No page for that destination</h1></div></header>'
          + '<section class="section"><div class="wrap"><div class="empty-state">'
          + '<p>There is no written-up page for “' + esc(slug) + '”. Some regions exist on this site only as a '
          + 'pin on the map — a trip runs through them but nobody has written the destination page yet, and we '
          + 'would rather have no page than a heading over an empty one.</p>'
          + '<a href="destinations.html" class="btn btn-solid">All destinations</a>'
          + '<a href="private-trips.html" class="btn btn-ghost">Ask us about this region</a></div></div></section>';
        return;
      }

      setMeta(
        d.name + ' — adventures, seasons and practicalities | High Route',
        (d.intro || d.description || '').slice(0, 155)
      );

      /* -----------------------------------------------------------------
         The page is built in the order a reader needs it: what the place
         is, whether they can go (altitude, season, permits), what it looks
         like, what runs there, then the detail.

         Every block below is conditional on there being content for it. A
         destination nobody has written up yet therefore renders fewer
         sections rather than a column of empty headings — and d.missing
         drives one note at the foot of the page naming what is not written
         yet, which is the same rule the impact report follows.
         ----------------------------------------------------------------- */
      var html = '';
      var paras = function (text) {
        return String(text || '').split(/\n\n+/)
          .map(function (p) { return p.trim(); })
          .filter(Boolean)
          .map(function (p) { return '<p>' + esc(p) + '</p>'; })
          .join('');
      };

      /* --- hero ------------------------------------------------------- */
      var heroBits = [esc(d.region || 'Nepal')];
      if (d.best_months) heroBits.push('Best ' + esc(d.best_months));
      if (d.altitude_summary) heroBits.push(esc(d.altitude_summary));

      html += '<header class="dest-hero">'
        + (d.hero_image_url
            ? '<img class="dest-hero-bg" src="' + esc(d.hero_image_url) + '" alt="" aria-hidden="true"'
              + ' fetchpriority="high" decoding="async">'
            : '')
        + '<div class="wrap">'
        +   '<p class="crumbs"><a href="index.html">Home</a><span>/</span><a href="destinations.html">Destinations</a>'
        +     '<span>/</span>' + esc(d.name) + '</p>'
        +   '<p class="dest-hero-eyebrow"><span class="dot" aria-hidden="true"></span>'
        +     heroBits.map(function (b) { return '<span>' + b + '</span>'; }).join('')
        +   '</p>'
        +   '<h1>' + esc(d.name) + '</h1>'
        +   (d.intro
                // The first two sentences of the intro, with the rest kept
                // for the About section below rather than printed twice.
                ? '<p class="dest-hero-lede">' + esc(d.intro.split('. ').slice(0, 2).join('. ').replace(/\.?$/, '.')) + '</p>'
                : '')
        +   '<div class="dest-hero-ctas">'
        +     (d.adventures.length
                ? '<a href="#dest-adventures" class="btn btn-solid">' + d.adventures.length + ' '
                  + plural(d.adventures.length, 'adventure') + ' here</a>'
                : '<a href="private-trips.html" class="btn btn-solid">Ask us to build a trip here</a>')
        +     (d.gallery && d.gallery.length ? '<a href="#dest-gallery" class="btn btn-ghost">Photos</a>' : '')
        +     '<a href="#dest-practical" class="btn btn-ghost">Permits &amp; practicalities</a>'
        +   '</div>'
        + '</div></header>';

      /* --- the glance bar, straddling the hero edge -------------------- */
      /* Built from at_a_glance if an admin has written one, and otherwise
         from whichever short fields exist — so the bar appears for a
         destination that has only an elevation and a season, rather than
         waiting for somebody to fill in a structured block. */
      var glance = (d.at_a_glance || []).slice();
      if (!glance.length) {
        if (d.altitude_summary || d.elevation_range) {
          glance.push({ label: 'Elevation', value: d.altitude_summary || d.elevation_range });
        }
        if (d.best_months) glance.push({ label: 'Best months', value: d.best_months });
        if (d.adventures.length) {
          glance.push({ label: 'Trips here', value: String(d.adventures.length) });
        }
      }
      if (glance.length) {
        html += '<div class="wrap dest-glance-wrap"><dl class="dest-glance">'
          + glance.slice(0, 8).map(function (g) {
              return '<div><dt>' + esc(g.label) + '</dt><dd>' + esc(g.value)
                + (g.note ? '<small>' + esc(g.note) + '</small>' : '')
                + '</dd></div>';
            }).join('')
          + '</dl></div>';
      }

      /* --- about, highlights, and a sticky aside ----------------------- */
      var asideCards = '';
      if (d.activities.length) {
        asideCards += '<div class="card"><h3>What you can do here</h3><ul class="list-plain">'
          + d.activities.map(function (a) {
              return '<li><strong>' + esc(a.name) + '</strong>'
                + (a.has_adventures
                    ? ' &mdash; ' + a.adventure_count + ' '
                      + plural(a.adventure_count, 'trip') + ' published'
                    : ' &mdash; <span style="color:var(--paper-dim)">no trips published yet</span>')
                + '</li>';
            }).join('')
          + '</ul></div>';
      }
      if (d.best_months || d.best_time) {
        asideCards += '<div class="card"><h3>When to come</h3>'
          + (d.best_months ? '<p style="font-size:17px;font-weight:600;margin-bottom:8px">' + esc(d.best_months) + '</p>' : '')
          + (d.best_time ? '<p style="font-size:14px;line-height:1.65;color:var(--paper-dim)">' + esc(d.best_time) + '</p>' : '')
          + '<p style="margin-top:12px"><a class="adv-link" href="when-to-visit.html">Month-by-month for all of Nepal &rarr;</a></p>'
          + '</div>';
      }
      asideCards += '<div class="card"><h3>Not sure yet?</h3>'
        + '<p style="font-size:14px;line-height:1.65;color:var(--paper-dim);margin-bottom:14px">Four questions and we will '
        + 'show you what fits &mdash; no account and no email address.</p>'
        + '<a href="finder.html" class="btn btn-solid btn-block">Find an Adventure</a></div>';

      html += '<section class="section"><div class="wrap"><div class="dest-body">'
        + '<div>'
        +   '<div class="prose"><h2>About ' + esc(d.name) + '</h2>' + paras(d.intro || d.description) + '</div>';

      if ((d.highlights || []).length) {
        html += '<h2 style="font-family:var(--f-display);font-size:clamp(21px,2.6vw,28px);'
          + 'margin:clamp(30px,4vw,44px) 0 18px">Why come here</h2>'
          + '<div class="dest-highlights">'
          + d.highlights.map(function (h, i2) {
              return '<div class="dest-highlight">'
                + '<span class="dest-highlight-num" aria-hidden="true">' + ('0' + (i2 + 1)).slice(-2) + '</span>'
                + '<div><h3>' + esc(h.title) + '</h3><p>' + esc(h.text) + '</p></div>'
                + '</div>';
            }).join('')
          + '</div>';
      }

      html += '</div><aside class="dest-aside">' + asideCards + '</aside>'
        + '</div></div></section>';

      /* --- gallery ----------------------------------------------------- */
      /* Captions carry where the photo came from, because most of this
         gallery is assembled from the trips that run in the region rather
         than shot for the destination page. A photo labelled with the trip
         it belongs to is honest; the same photo presented as a picture of
         the valley in general is not. */
      if (d.gallery && d.gallery.length) {
        html += '<section class="section-tight" id="dest-gallery" style="background:var(--ink-soft);'
          + 'border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding-top:clamp(40px,5vw,64px);'
          + 'padding-bottom:clamp(40px,5vw,64px)"><div class="wrap">'
          + '<div class="section-head"><p class="section-kicker">Photographs</p>'
          + '<h2>' + esc(d.name) + ' in pictures</h2>'
          + '<p>' + d.gallery.length + ' ' + plural(d.gallery.length, 'photo')
          + ', each captioned with where it was taken or which trip it is from. Select one to see it full size.</p></div>'
          + '<div class="dest-gallery">'
          + d.gallery.slice(0, 12).map(function (g, i2) {
              var cap = g.caption || g.source || '';
              return '<button type="button" data-gi="' + i2 + '"'
                + ' aria-label="View photo: ' + esc(cap || 'photograph ' + (i2 + 1)) + '">'
                + '<img src="' + esc(g.image_url) + '" alt="' + esc(cap) + '"'
                + (i2 === 0 ? '' : ' loading="lazy"') + ' decoding="async">'
                + (cap ? '<span class="dg-cap">' + esc(cap) + '</span>' : '')
                + '</button>';
            }).join('')
          + '</div>';
        if (d.gallery.length > 12) {
          html += '<p class="dest-gallery-note" style="font-size:13px;color:var(--paper-dim);margin-top:14px">'
            + 'Showing 12 of ' + d.gallery.length + '. The rest are on the individual trip pages.</p>';
        }
        html += '</div></section>';
      }

      /* --- the trips that run here ------------------------------------- */
      // The link under the grid hands over to the main listing with this
      // destination already selected, so the visitor can narrow it by
      // difficulty, month or price from here (brief section 10: destination
      // pages must work with the filtering system).
      html += '<section class="section" id="dest-adventures"><div class="wrap">'
        + '<div class="section-head"><p class="section-kicker">Adventures</p>'
        + '<h2>Trips in ' + esc(d.name) + '</h2>'
        + '<p>Every figure on these cards is the real trip &mdash; the distance, the climbing, the altitude and the '
        + 'spaces genuinely left on the next departure.</p></div>'
        + '<div id="dest-adv-grid"></div>'
        + (d.adventures.length
            ? '<p class="section-more"><a class="btn btn-ghost" href="adventures.html?destination='
              + encodeURIComponent(d.slug) + '">Filter ' + esc(d.name) + ' adventures by difficulty, month or price</a></p>'
            : '')
        + '</div></section>';

      /* --- season by season -------------------------------------------- */
      if ((d.seasons || []).length) {
        html += '<section class="section section-tight"><div class="wrap">'
          + '<div class="section-head"><p class="section-kicker">Seasons</p>'
          + '<h2>When to come, and what you get</h2>'
          + '<p>Four windows, with the honest version of each &mdash; including the months we would steer you away '
          + 'from and why.</p></div>'
          + '<div class="dest-seasons">'
          + d.seasons.map(function (sn) {
              return '<div class="dest-season' + (sn.best ? ' is-best' : '') + '">'
                + '<h3>' + esc(sn.label) + '</h3>'
                + (sn.months ? '<p class="dest-season-months">' + esc(sn.months) + '</p>' : '')
                + (sn.note ? '<p>' + esc(sn.note) + '</p>' : '')
                + (sn.best ? '<p class="dest-season-flag">Recommended window</p>' : '')
                + '</div>';
            }).join('')
          + '</div></div></section>';
      }

      /* --- practical: permits, transport, health ----------------------- */
      var panels = '';
      if (d.permits) panels += '<div class="dest-panel is-permit"><h3>Permits and paperwork</h3>' + paras(d.permits) + '</div>';
      if (d.getting_there) panels += '<div class="dest-panel"><h3>Getting there</h3>' + paras(d.getting_there) + '</div>';
      if (d.getting_around) panels += '<div class="dest-panel"><h3>Getting around</h3>' + paras(d.getting_around) + '</div>';
      if (d.health_notes) panels += '<div class="dest-panel is-health"><h3>Health and altitude</h3>' + paras(d.health_notes) + '</div>';

      if (panels || (d.practical && d.practical.length)) {
        html += '<section class="section section-tight" id="dest-practical" style="background:var(--stone);'
          + 'border-top:1px solid var(--line);border-bottom:1px solid var(--line)"><div class="wrap">'
          + '<div class="section-head"><p class="section-kicker">Practical information</p>'
          + '<h2>What to know before you come</h2>'
          + '<p>Permits, transport and altitude. Where a figure is set by somebody else &mdash; a park authority, the '
          + 'government, an airline &mdash; it is confirmed in your quote rather than printed here where it would go '
          + 'stale.</p></div>'
          + (panels ? '<div class="dest-panels">' + panels + '</div>' : '');
        if (d.practical && d.practical.length) {
          html += '<h3 style="font-family:var(--f-display);font-size:clamp(19px,2.2vw,23px);'
            + 'margin:clamp(26px,3.4vw,38px) 0 10px">Worth knowing</h3>'
            + '<ul class="dest-practical" style="max-width:80ch">'
            + d.practical.map(function (p) { return '<li><span>' + esc(p) + '</span></li>'; }).join('')
            + '</ul>';
        }
        html += '</div></section>';
      }

      /* --- culture and the free-form sections -------------------------- */
      if (d.culture || (d.sections || []).length) {
        html += '<section class="section section-tight"><div class="wrap">'
          + '<div class="section-head"><p class="section-kicker">In more detail</p>'
          + '<h2>The place itself</h2></div>'
          + '<div style="max-width:78ch">';
        if (d.culture) {
          html += '<div class="dest-section"><h3>People and culture</h3>' + paras(d.culture) + '</div>';
        }
        (d.sections || []).forEach(function (sec) {
          html += '<div class="dest-section"><h3>' + esc(sec.heading) + '</h3>' + paras(sec.body) + '</div>';
        });
        html += '</div></div></section>';
      }

      /* --- FAQs -------------------------------------------------------- */
      if (d.faqs && d.faqs.length) {
        html += '<section class="section section-tight" style="background:var(--ink-soft);'
          + 'border-top:1px solid var(--line);border-bottom:1px solid var(--line)"><div class="wrap">'
          + '<div class="section-head"><p class="section-kicker">Questions</p><h2>Frequently asked</h2></div>'
          + '<div style="max-width:80ch">'
          + accordion(d.faqs.map(function (f) {
              return { title: f.question, body: '<p>' + esc(f.answer) + '</p>' };
            }))
          + '</div>'
          + '<p style="margin-top:18px"><a href="faqs.html" class="adv-link">All frequently asked questions &rarr;</a></p>'
          + '</div></section>';
      }

      /* --- related ----------------------------------------------------- */
      if (d.related && d.related.length) {
        html += '<section class="section section-tight"><div class="wrap">'
          + '<div class="section-head"><p class="section-kicker">Nearby</p><h2>Related destinations</h2></div>'
          + '<div class="dest-grid dest-grid-compact">'
          + d.related.map(function (r) { return destCard(r, { compact: true }); }).join('')
          + '</div></div></section>';
      }

      /* --- what is not written yet ------------------------------------- */
      /* The brief forbids filling a gap with something plausible, so the
         gap is named instead. This is the only place on the page that
         mentions the missing blocks; everywhere else they are simply absent
         rather than rendered as an empty heading. */
      if ((d.missing || []).length) {
        var list = d.missing.length === 1
          ? d.missing[0]
          : d.missing.slice(0, -1).join(', ') + ' and ' + d.missing[d.missing.length - 1];
        html += '<section class="section-tight" style="padding-bottom:clamp(40px,5vw,64px)"><div class="wrap">'
          + '<div class="note note-action" style="max-width:76ch"><div>'
          + '<p><strong>This page does not yet have ' + esc(list) + '.</strong> Those sections are written in the '
          + 'admin panel and this destination has not had them filled in. We would rather the page be visibly short '
          + 'than fill it with something that reads well and nobody has checked &mdash; '
          + '<a href="contact.html">ask us</a> and you will get the real answer.</p>'
          + '</div></div></div></section>';
      }

      /* --- CTA --------------------------------------------------------- */
      html += '<section class="section section-forest"><div class="wrap text-center">'
        + '<div class="section-head"><h2>Thinking about ' + esc(d.name) + '?</h2>'
        + '<p>Browse what already runs here, or tell us what you had in mind and we will say honestly whether it '
        + 'works and when.</p></div>'
        + '<div class="hero-ctas" style="justify-content:center">'
        +   '<a href="adventures.html" class="btn btn-solid">See all adventures</a>'
        +   '<a href="private-trips.html" class="btn btn-ghost">Plan a Custom Trip</a>'
        +   '<a href="contact.html" class="btn btn-ghost">Contact us</a>'
        + '</div>'
        + '</div></section>';

      root.innerHTML = html;

      /* The gallery reuses main.js's lightbox, which already handles
         keyboard, arrows, backdrop click and the body scroll lock. These
         are <button>s rather than anchors because they open an overlay —
         they were never links, and href="#" is the dead link the brief
         rules out. */
      var galleryEl = $('#dest-gallery');
      if (galleryEl && d.gallery && d.gallery.length) {
        $$('button[data-gi]', galleryEl).forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (typeof window.openLightbox === 'function') {
              window.openLightbox(d.gallery, Number(btn.getAttribute('data-gi')));
            }
          });
        });
      }

      renderCards($('#dest-adv-grid'), d.adventures,
        '<div class="empty-state"><h3>No published trips in ' + esc(d.name) + ' yet</h3>'
        + '<p>' + (d.activities.length
            ? 'This region suits ' + d.activities.map(function (a) { return esc(a.name.toLowerCase()); }).join(' and ')
              + ', and we run trips in it — but nothing is on the site under this destination at the moment. '
              + 'Rather than list a placeholder, ask us and we will tell you what is actually possible and when.'
            : 'Nothing is published here at the moment.')
        + '</p>'
        + '<a href="private-trips.html" class="btn btn-solid">Ask about ' + esc(d.name) + '</a>'
        + '<a href="adventures.html" class="btn btn-ghost">See all adventures</a></div>');
    });
  })();

  /* ------------------------------------------------------------------
     ADVENTURE FINDER (finder.html)

     Four questions, anonymous, stores nothing. Answers live in the URL so
     the results are shareable and the back button works, and in
     sessionStorage so that following a result and coming back preserves
     them — which the brief asks for explicitly.
     ------------------------------------------------------------------ */
  (function () {
    var root = $('#finder-page');
    if (!root) return;

    var formEl = $('#finder-form');
    var resultsEl = $('#finder-results');
    var summaryEl = $('#finder-summary');
    var saveWrap = $('#finder-save');
    var STORAGE_KEY = 'highroute_finder';

    var answers = {};

    function restore() {
      var p = new URLSearchParams(location.search);
      ['what', 'challenge', 'time', 'month'].forEach(function (k) {
        if (p.get(k)) answers[k] = p.get(k);
      });
      if (Object.keys(answers).length) return;
      try {
        var saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
        if (saved && typeof saved === 'object') answers = saved;
      } catch (e) { /* storage blocked; the finder still works */ }
    }

    function persist() {
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(answers)); }
      catch (e) { /* nothing to do; the URL still carries the answers */ }
      var p = new URLSearchParams();
      Object.keys(answers).forEach(function (k) { if (answers[k]) p.set(k, answers[k]); });
      history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
    }

    function renderQuestions(questions) {
      formEl.innerHTML = questions.map(function (q, i) {
        var isMonth = q.key === 'month';
        return '<fieldset class="finder-q">'
          + '<legend class="sr-only">' + esc(q.question) + '</legend>'
          + '<h3><span class="finder-q-num">' + (i + 1) + '</span>' + esc(q.question) + '</h3>'
          + (q.key === 'challenge'
              ? '<p>Not sure? The <a href="difficulty-guide.html">Difficulty Guide</a> explains each level.</p>'
              : '')
          + '<div class="' + (isMonth ? 'finder-months' : 'finder-opts') + '">'
          +   q.options.map(function (o) {
                var id = 'f-' + q.key + '-' + o.key;
                var label = isMonth ? o.label.slice(0, 3) : o.label;
                return '<label class="finder-opt" for="' + esc(id) + '">'
                  + '<input type="radio" id="' + esc(id) + '" name="' + esc(q.key) + '" value="' + esc(o.key) + '"'
                  +   (answers[q.key] === o.key ? ' checked' : '') + '>'
                  + '<span' + (isMonth ? ' title="' + esc(o.label) + '"' : '') + '>' + esc(label) + '</span>'
                  + '</label>';
              }).join('')
          + '</div></fieldset>';
      }).join('')
      + '<div class="finder-actions">'
      +   '<button type="submit" class="btn btn-solid">Show me what fits</button>'
      +   '<button type="button" class="btn btn-ghost" id="finder-reset">Start again</button>'
      +   '<span class="result-count">No account needed. We do not ask for your email to use this.</span>'
      + '</div>';

      $$('input[type=radio]', formEl).forEach(function (input) {
        input.addEventListener('change', function () {
          answers[input.name] = input.value;
          persist();
          run();
        });
      });
      var reset = $('#finder-reset', formEl);
      if (reset) {
        reset.addEventListener('click', function () {
          answers = {};
          try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
          history.replaceState(null, '', location.pathname);
          $$('input[type=radio]', formEl).forEach(function (i) { i.checked = false; });
          if (resultsEl) resultsEl.innerHTML = '';
          if (summaryEl) summaryEl.innerHTML = '';
          if (saveWrap) saveWrap.innerHTML = '';
        });
      }
      formEl.addEventListener('submit', function (e) { e.preventDefault(); run(); });
    }

    var RELAX_WORD = { month: 'the month you chose', time: 'the trip length you chose', challenge: 'the difficulty you chose' };

    function run() {
      if (!Object.keys(answers).length) return;
      loading(resultsEl, 'adventures');
      var p = new URLSearchParams();
      Object.keys(answers).forEach(function (k) { if (answers[k]) p.set(k, answers[k]); });

      jget('/api/finder?' + p.toString()).then(function (data) {
        if (!data) return errorState(resultsEl, 'your recommendations');

        if (summaryEl) {
          summaryEl.innerHTML = data.total
            ? '<div class="section-head" style="margin-bottom:12px"><p class="section-kicker">Your matches</p>'
              + '<h2>' + data.total + ' ' + plural(data.total, 'adventure') + ' that ' + (data.total === 1 ? 'fits' : 'fit') + '</h2></div>'
              + (data.relaxed.length
                  // Saying which answer had to be relaxed, and why, rather
                  // than quietly returning near-misses as if they were exact.
                  ? '<div class="note note-action finder-relaxed"><div><p><strong>Nothing matched everything you asked for.</strong> '
                    + 'These are the closest, ignoring ' + data.relaxed.map(function (r) { return esc(RELAX_WORD[r] || r); }).join(' and ')
                    + '. Your activity is never ignored — if you asked for a trek we will not show you a bike trip.</p></div></div>'
                  : '')
            : '';
        }

        renderCards(resultsEl, data.adventures, finderEmpty(data), { eagerFirst: true });
        renderSave(data);
      });
    }

    function finderEmpty(data) {
      var what = (data.answers || {}).what;
      if (what && what !== 'surprise') {
        return '<div class="empty-state"><h3>Nothing published for that yet</h3>'
          + '<p>We have no trips on the site for that activity at the moment, and we are not going to show you a '
          + 'different one and hope you do not notice. Tell us what you had in mind and we will say honestly '
          + 'whether we can run it and when.</p>'
          + '<a href="private-trips.html" class="btn btn-solid">Tell us what you want</a>'
          + '<a href="adventures.html" class="btn btn-ghost">See what is running</a></div>';
      }
      return null;
    }

    /** The optional email capture. It is optional, it is under the results
     *  rather than in front of them, and its success message says the truth:
     *  the answers are stored, no email has been sent, because no outbound
     *  mail is connected. */
    function renderSave(data) {
      if (!saveWrap) return;
      if (!data.total) { saveWrap.innerHTML = ''; return; }
      saveWrap.innerHTML = ''
        + '<div class="card" style="margin-top:32px;max-width:58ch">'
        +   '<h3>Want these saved?</h3>'
        +   '<p class="adv-summary">Optional. The finder works without it — this just keeps your answers on '
        +     'file so the team can pick them up.</p>'
        +   '<form class="save-form" id="finder-save-form" novalidate>'
        +     '<label class="sr-only" for="finder-email">Your email address</label>'
        +     '<input type="email" id="finder-email" placeholder="you@email.com" autocomplete="email" required>'
        +     '<button type="submit" class="btn btn-solid">Save my matches</button>'
        +   '</form>'
        +   '<p class="form-status" id="finder-save-status" role="status" aria-live="polite"></p>'
        + '</div>';

      var form = $('#finder-save-form', saveWrap);
      var input = $('#finder-email', saveWrap);
      var status = $('#finder-save-status', saveWrap);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = input.value.trim();
        if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
          input.setAttribute('aria-invalid', 'true');
          status.className = 'form-status is-err';
          status.textContent = 'That does not look like an email address — check it and try again.';
          input.focus();
          return;
        }
        input.removeAttribute('aria-invalid');
        var btn = form.querySelector('button');
        btn.disabled = true;
        var original = btn.textContent;
        btn.textContent = 'Saving…';
        status.className = 'form-status';
        status.textContent = '';

        jpost('/api/finder/save', { email: email, answers: answers, resultCount: data.total })
          .then(function (res) {
            btn.disabled = false;
            btn.textContent = original;
            if (res.ok) {
              form.reset();
              status.className = 'form-status is-ok';
              status.textContent = res.data.message || 'Saved.';
            } else {
              status.className = 'form-status is-err';
              status.textContent = res.data.error || 'Could not save that just now.';
            }
          });
      });
    }

    restore();
    jget('/api/finder').then(function (data) {
      if (!data) return errorState(formEl, 'the finder');
      renderQuestions(data.questions);
      if (Object.keys(answers).length) run();
    });
  })();

  /* ------------------------------------------------------------------
     WHEN TO VISIT (when-to-visit.html)
     ------------------------------------------------------------------ */
  (function () {
    var grid = $('#when-months');
    if (!grid) return;
    var bar = $('#when-filters');
    loading(grid, 'the month-by-month guide');

    // Activity and destination narrow the trips shown in every month (brief
    // section 17: "adventure activities" and "destination selection"). The
    // month conditions text never changes with them — the weather in
    // October is the weather in October whatever you came to do.
    var state = {};
    var p = new URLSearchParams(location.search);
    if (p.get('activity')) state.activity = p.get('activity');
    if (p.get('destination')) state.destination = p.get('destination');
    var data = null;

    function matches(a) {
      if (state.activity && a.activity !== state.activity) return false;
      if (state.destination && a.destination_slug !== state.destination) return false;
      return true;
    }

    function render() {
      var months = data.months.map(function (m) {
        var trips = m.adventures.filter(matches);
        return { m: m, trips: trips };
      });
      var peak = Math.max.apply(null, months.map(function (x) { return x.trips.length; }));
      var qs = (state.activity ? '&activity=' + encodeURIComponent(state.activity) : '')
             + (state.destination ? '&destination=' + encodeURIComponent(state.destination) : '');
      grid.className = 'month-grid';
      grid.innerHTML = months.map(function (x) {
        var m = x.m, trips = x.trips;
        return '<article class="month-card' + (trips.length === peak && peak > 0 ? ' is-peak' : '') + '" id="month-' + m.month + '">'
          + '<h3>' + esc(m.name)
          +   '<span class="month-count">' + trips.length + ' ' + plural(trips.length, 'trip') + '</span>'
          + '</h3>'
          + '<p>' + esc(m.conditions) + '</p>'
          + (trips.length
              ? '<div class="month-trips">'
                + trips.map(function (a) {
                    return '<a href="tour-detail.html?slug=' + encodeURIComponent(a.slug) + '">'
                      + esc(a.name) + ' · ' + a.duration_days + 'd</a>';
                  }).join('')
                + '<a href="adventures.html?month=' + m.month + qs + '"><strong>All ' + esc(m.name) + ' trips →</strong></a>'
                + '</div>'
              : '<div class="month-trips"><a href="private-trips.html">'
                + (Object.keys(state).length ? 'Nothing matching in ' + esc(m.name) : 'Nothing scheduled')
                + ' — ask about a private trip →</a></div>')
          + '</article>';
      }).join('');
      // Keep the choice in the URL so it can be shared and survives Back.
      var q = new URLSearchParams();
      Object.keys(state).forEach(function (k) { q.set(k, state[k]); });
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
    }

    Promise.all([jget('/api/when-to-visit'), jget('/api/meta/filters')]).then(function (res) {
      data = res[0];
      var meta = res[1];
      if (!data) return errorState(grid, 'the month-by-month guide');

      if (bar && meta) {
        var opt = function (rows, vKey, lKey, current) {
          return rows.map(function (r) {
            return '<option value="' + esc(r[vKey]) + '"' + (String(current) === String(r[vKey]) ? ' selected' : '') + '>'
              + esc(r[lKey]) + '</option>';
          }).join('');
        };
        bar.innerHTML = '<div class="cal-filters" role="group" aria-label="Narrow the months">'
          + '<label class="sr-only" for="wtv-activity">Activity</label>'
          + '<select id="wtv-activity"><option value="">Every activity</option>'
          +   opt(meta.activities || [], 'slug', 'plural_label', state.activity) + '</select>'
          + '<label class="sr-only" for="wtv-destination">Destination</label>'
          + '<select id="wtv-destination"><option value="">Every destination</option>'
          +   opt(meta.destinations || [], 'slug', 'name', state.destination) + '</select>'
          + '</div>';
        ['activity', 'destination'].forEach(function (k) {
          $('#wtv-' + k).addEventListener('change', function (e) {
            if (e.target.value) state[k] = e.target.value; else delete state[k];
            render();
          });
        });
      }
      render();

      var caveat = $('#when-caveat');
      if (caveat && data.caveat) {
        caveat.innerHTML = '<div class="note"><div><p>' + esc(data.caveat) + '</p></div></div>';
      }
    });
  })();

  /* ------------------------------------------------------------------
     DIFFICULTY GUIDE (difficulty-guide.html)

     Rendered from /api/activities, which carries each activity's own
     dimension definitions. So the page explains that rafting is graded on
     swimming ability without this file knowing that rafting exists.
     ------------------------------------------------------------------ */
  (function () {
    var levelsEl = $('#diff-levels');
    if (!levelsEl) return;
    var actsEl = $('#diff-activities');
    var examplesEl = $('#diff-examples');

    loading(levelsEl, 'the difficulty levels');

    Promise.all([
      jget('/api/meta/filters'),
      jget('/api/activities?all=1'),
      jget('/api/adventures?sort=difficulty-asc'),
    ]).then(function (res) {
      var meta = res[0], acts = res[1], list = res[2];
      if (!meta) return errorState(levelsEl, 'the difficulty levels');

      levelsEl.innerHTML = meta.difficulty_levels.map(function (l) {
        var examples = list ? (list.adventures || []).filter(function (a) { return a.difficulty_level === l.level; }) : [];
        var pips = '';
        for (var i = 1; i <= 5; i++) pips += '<span class="diff-pip' + (i <= l.level ? ' on' : '') + '"></span>';
        return '<article class="card" id="level-' + l.level + '" style="margin-bottom:16px">'
          + '<div class="diff-head">'
          +   '<span class="diff-level">' + l.level + '<small>/5</small></span>'
          +   '<span class="diff-label">' + esc(l.label) + '</span>'
          +   '<span class="diff-bar" style="width:90px" role="img" aria-label="Level ' + l.level + ' of 5">' + pips + '</span>'
          + '</div>'
          + '<p class="diff-meaning">' + esc(l.meaning) + '</p>'
          + '<p class="diff-commitment">' + esc(l.commitment) + '</p>'
          + (examples.length
              ? '<p class="result-count">On this site at level ' + l.level + ': '
                + examples.map(function (a) {
                    return '<a class="adv-link" href="tour-detail.html?slug=' + encodeURIComponent(a.slug) + '">' + esc(a.name) + '</a>';
                  }).join(', ') + '</p>'
                + '<p style="margin:10px 0 0"><a class="adv-link" href="adventures.html?difficulty=' + l.level + '">'
                + 'Compare all level-' + l.level + ' adventures →</a></p>'
              : '<p class="result-count">Nothing on the site is at this level at the moment.</p>')
          + '</article>';
      }).join('');

      if (actsEl && acts) {
        actsEl.innerHTML = (acts.activities || []).map(function (a) {
          return '<article class="impact-dim">'
            + '<h3>' + esc(a.name) + (a.enabled ? '' : ' <span class="metric-flag">not yet on the site</span>') + '</h3>'
            + (a.summary ? '<p>' + esc(a.summary) + '</p>' : '')
            + '<div class="diff-dims">'
            + (a.difficulty_dimensions || []).map(function (d) {
                return '<div class="diff-dim" style="grid-template-columns:1fr">'
                  + '<span class="diff-dim-label">' + esc(d.label) + '</span>'
                  + '<p class="diff-dim-desc" style="grid-column:1">' + esc(d.description) + '</p>'
                  + '</div>';
              }).join('')
            + '</div>'
            + (a.adventure_count
                ? '<p style="margin:16px 0 0"><a class="adv-link" href="adventures.html?activity='
                  + encodeURIComponent(a.slug) + '">' + a.adventure_count + ' ' + plural(a.adventure_count, 'trip')
                  + ' →</a></p>'
                : '')
            + '</article>';
        }).join('');
      }

      if (examplesEl && list) {
        var hardest = (list.adventures || []).slice().sort(function (x, y) {
          return y.difficulty_level - x.difficulty_level;
        })[0];
        if (hardest) {
          examplesEl.innerHTML = '<div class="section-head"><p class="section-kicker">Worked example</p>'
            + '<h2>' + esc(hardest.name) + '</h2></div>' + difficultyBlock(hardest);
        }
      }
    });
  })();

  /* ------------------------------------------------------------------
     FAQS (faqs.html)
     ------------------------------------------------------------------ */
  (function () {
    var root = $('#faq-list');
    if (!root) return;
    var navEl = $('#faq-nav');
    var searchEl = $('#faq-search');

    var CATEGORY_LABEL = {
      booking: 'Booking', pricing: 'Pricing and payment', difficulty: 'Difficulty',
      fitness: 'Fitness and experience', equipment: 'Equipment', accommodation: 'Accommodation',
      transport: 'Transport', safety: 'Safety and insurance', weather: 'Weather and seasons',
      cancellation: 'Changes and cancellation', general: 'General',
    };
    var ORDER = ['booking', 'pricing', 'difficulty', 'fitness', 'equipment', 'accommodation',
      'transport', 'safety', 'weather', 'cancellation', 'general'];

    loading(root, 'the questions');
    jget('/api/faqs').then(function (data) {
      if (!data) return errorState(root, 'the questions');
      var grouped = data.grouped || {};
      var cats = Object.keys(grouped).sort(function (a, b) {
        var ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });

      function render(filter) {
        var term = (filter || '').trim().toLowerCase();
        var shown = 0;
        var html = cats.map(function (cat) {
          var items = grouped[cat].filter(function (f) {
            return !term
              || f.question.toLowerCase().indexOf(term) !== -1
              || f.answer.toLowerCase().indexOf(term) !== -1;
          });
          if (!items.length) return '';
          shown += items.length;
          return '<section class="section-tight" id="faq-' + esc(cat) + '" style="margin-bottom:34px">'
            + '<h2 style="font-family:var(--f-display);font-size:clamp(20px,3vw,26px);margin:0 0 14px">'
            +   esc(CATEGORY_LABEL[cat] || cat) + '</h2>'
            + accordion(items.map(function (f) {
                return { title: f.question, body: '<p>' + esc(f.answer) + '</p>', open: !!term };
              }))
            + '</section>';
        }).join('');

        root.innerHTML = html || '<div class="empty-state"><h3>No questions match “' + esc(filter) + '”</h3>'
          + '<p>Try a different word, or ask us directly — if it is not answered here it is probably worth adding.</p>'
          + '<a href="contact.html" class="btn btn-solid">Ask us</a></div>';

        var count = $('#faq-count');
        if (count) count.innerHTML = '<b>' + shown + '</b> ' + plural(shown, 'question');
      }

      if (navEl) {
        navEl.innerHTML = '<h4>Jump to</h4><ul>' + cats.map(function (c) {
          return '<li><a href="#faq-' + esc(c) + '">' + esc(CATEGORY_LABEL[c] || c)
            + ' <span class="pill-count">' + grouped[c].length + '</span></a></li>';
        }).join('') + '</ul>';
      }

      render('');

      if (searchEl) {
        var timer = null;
        searchEl.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(function () { render(searchEl.value); }, 200);
        });
      }
    });
  })();

  /* ------------------------------------------------------------------
     GUIDES (guides.html)

     Only verified qualifications are published; the API filters them, and
     the page says so rather than leaving a visitor to assume the list is
     exhaustive.
     ------------------------------------------------------------------ */
  (function () {
    var root = $('#guides-list');
    if (!root) return;
    loading(root, 'the guides');
    jget('/api/guides').then(function (data) {
      if (!data) return errorState(root, 'the guides');
      var guides = data.guides || data || [];
      if (!guides.length) {
        root.innerHTML = '<div class="empty-state"><h3>No guide profiles published yet</h3>'
          + '<p>Guide profiles are entered in the admin panel. Nothing has been published yet, and we are not '
          + 'going to put up an invented one.</p>'
          + '<a href="contact.html" class="btn btn-solid">Ask who will be guiding</a></div>';
        return;
      }
      root.className = 'guide-grid-full';
      root.innerHTML = guides.map(function (g) {
        var quals = g.qualifications || [];
        var acts = g.activities || [];
        return '<article class="guide-card">'
          + (g.photo_url
              ? '<div class="guide-photo"><img src="' + esc(g.photo_url) + '" alt="' + esc(g.name) + '" loading="lazy" decoding="async"></div>'
              : '')
          + '<div class="guide-info">'
          +   '<h3>' + esc(g.name) + '</h3>'
          +   '<p class="guide-role">' + esc(g.role) + '</p>'
          +   (g.bio ? '<p class="adv-summary">' + esc(g.bio) + '</p>' : '')
          +   '<div class="guide-stats">'
          +     '<div><b>' + esc(g.years_experience) + '</b><span>' + plural(g.years_experience, 'year') + ' guiding</span></div>'
          +     (g.trips_led ? '<div><b>' + esc(g.trips_led) + '</b><span>trips led</span></div>' : '')
          +   '</div>'
          +   (g.languages ? '<p class="guide-acts"><strong>Languages:</strong> ' + esc(g.languages) + '</p>' : '')
          +   (acts.length ? '<p class="guide-acts"><strong>Guides:</strong> ' + acts.map(function (a) {
                return esc(String(a).replace(/-/g, ' '));
              }).join(', ') + '</p>' : '')
          +   (quals.length
                ? '<div class="guide-quals">' + quals.map(function (q) {
                    return '<span class="guide-qual">' + esc(q) + '</span>';
                  }).join('') + '</div>'
                : '')
          + '</div></article>';
      }).join('');

      var note = $('#guides-note');
      if (note) {
        note.innerHTML = '<div class="note"><div><p><strong>Only qualifications we have actually seen are listed.</strong> '
          + 'A certificate recorded in the admin panel does not appear on these profiles until somebody has '
          + 'checked it, which means a short list here is a verified list rather than a complete one. '
          + 'If a specific qualification matters for your trip, ask and we will tell you exactly who holds it.</p></div></div>';
      }
    });
  })();

  /* ------------------------------------------------------------------
     OUR IMPACT (our-impact.html)
     ------------------------------------------------------------------ */
  (function () {
    var root = $('#impact-metrics');
    if (!root) return;
    loading(root, 'the impact figures');
    jget('/api/impact').then(function (data) {
      if (!data) return errorState(root, 'the impact figures');

      var byDim = {};
      data.published.forEach(function (m) { (byDim[m.dimension] = byDim[m.dimension] || { published: [], pending: [] }).published.push(m); });
      data.pending.forEach(function (m) { (byDim[m.dimension] = byDim[m.dimension] || { published: [], pending: [] }).pending.push(m); });

      root.className = 'impact-dims';
      root.innerHTML = data.dimensions.map(function (dim) {
        var group = byDim[dim.key] || { published: [], pending: [] };
        var metrics = group.published.map(function (m) {
          return '<div class="metric">'
            + '<p class="metric-label">' + esc(m.label) + '</p>'
            + '<p class="metric-value">' + esc(m.value) + (m.unit ? '<small>' + esc(m.unit) + '</small>' : '') + '</p>'
            + (m.source ? '<p class="metric-source">Source: ' + esc(m.source) + '</p>' : '')
            + '</div>';
        }).concat(group.pending.map(function (m) {
          // The visible gap. A progress report with the unmeasured rows
          // removed would look better and mean less.
          return '<div class="metric metric-pending">'
            + '<p class="metric-label">' + esc(m.label)
            +   '<span class="metric-flag">' + (m.has_value ? 'unverified' : 'not yet measured') + '</span></p>'
            + '<p class="metric-value">Not published for ' + data.year + '</p>'
            + (m.needs ? '<p class="metric-needs">' + esc(m.needs) + '</p>' : '')
            + '</div>';
        })).join('');

        return '<article class="impact-dim">'
          + '<h3>' + esc(dim.label) + '</h3>'
          + '<p>' + esc(dim.blurb) + '</p>'
          + (metrics ? '<div class="metric-list">' + metrics + '</div>' : '<p class="result-count">No metrics defined for this area yet.</p>')
          + '</article>';
      }).join('');

      /* --- derived figures, kept visibly separate from the published ones --- */
      var derivedEl = $('#impact-derived');
      if (derivedEl) {
        var d = data.derived;
        var rows = [];
        if (d.max_group_size_offered) rows.push(['Largest group we will take', d.max_group_size_offered, 'people']);
        if (d.average_group_size !== null) rows.push(['Average group size on trips that ran', d.average_group_size, 'people']);
        if (d.departures_completed) rows.push(['Departures completed in ' + data.year, d.departures_completed, '']);
        if (d.travellers) rows.push(['Travellers on them', d.travellers, '']);
        derivedEl.innerHTML = rows.length
          ? '<div class="metric-list">' + rows.map(function (r) {
              return '<div class="metric metric-derived">'
                + '<p class="metric-label">' + esc(r[0]) + '<span class="metric-flag">derived</span></p>'
                + '<p class="metric-value">' + esc(num(r[1])) + (r[2] ? '<small>' + esc(r[2]) + '</small>' : '') + '</p>'
                + '</div>';
            }).join('') + '</div>'
          : '<p class="result-count">No completed departures recorded for ' + data.year + ' yet.</p>';
      }

      /* --- the state of the reporting itself --- */
      var statusEl = $('#impact-status');
      if (statusEl) {
        var total = data.published.length + data.pending.length;
        statusEl.innerHTML = '<div class="note note-action"><div>'
          + '<p><strong>' + data.published.length + ' of ' + total + ' figures for ' + data.year
          + ' are published. The rest are not, and that is what this page shows.</strong></p>'
          + '<p>Each unpublished figure says what has to be supplied before it can appear. '
          + (data.records.count === 0
              ? 'There are currently <strong>no operational records</strong> behind any of them — the per-departure '
                + 'spending, wages, accommodation nights and transport figures have not been entered yet, so these '
                + 'are not merely unpublished, they are unmeasured. '
              : 'There are ' + data.records.count + ' operational ' + plural(data.records.count, 'record') + ' entered so far. ')
          + 'The structure for recording all of it exists in the admin panel; the numbers have to come from '
          + 'High Route’s own books.</p>'
          + '<p>We would rather publish a page with visible gaps than a page of figures nobody can stand behind. '
          + 'Group sizes and departure counts below are the exception — they come out of the booking data '
          + 'this site actually holds, and are labelled as derived.</p>'
          + '</div></div>';
      }
    });
  })();

  /* ------------------------------------------------------------------
     SEARCH (search.html)
     ------------------------------------------------------------------ */
  (function () {
    var root = $('#search-page');
    if (!root) return;
    var form = $('#search-form');
    var input = $('#search-q');
    var resultsEl = $('#search-results');
    var countEl = $('#search-count');

    function run(term) {
      if (!term) {
        resultsEl.innerHTML = '';
        if (countEl) countEl.textContent = '';
        return;
      }
      loading(resultsEl, 'results');
      jget('/api/adventures?q=' + encodeURIComponent(term)).then(function (data) {
        if (!data) return errorState(resultsEl, 'the results');
        if (countEl) {
          countEl.innerHTML = '<b>' + data.total + '</b> ' + plural(data.total, 'adventure')
            + ' matching “' + esc(term) + '”';
        }
        renderCards(resultsEl, data.adventures,
          '<div class="empty-state"><h3>Nothing matches “' + esc(term) + '”</h3>'
          + '<p>This searches adventure names, summaries, descriptions and regions. '
          + 'Try a region (Mustang, Annapurna), an activity, or browse everything.</p>'
          + '<a href="adventures.html" class="btn btn-solid">All adventures</a>'
          + '<a href="finder.html" class="btn btn-ghost">Use the finder instead</a></div>');
        setMeta('Search: ' + term + ' | High Route',
          data.total + ' High Route ' + plural(data.total, 'adventure') + ' matching “' + term + '” — '
          + 'mountain biking, trekking and multi-activity trips in Nepal, with real dates and prices.');
      });
    }

    var initial = new URLSearchParams(location.search).get('q') || '';
    if (input) input.value = initial;
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var term = input.value.trim();
        history.replaceState(null, '', location.pathname + (term ? '?q=' + encodeURIComponent(term) : ''));
        run(term);
      });
    }
    run(initial);
  })();

  /* ------------------------------------------------------------------
     PRIVATE TRIPS (private-trips.html)

     Posts to the real POST /api/custom-requests, which requires a rider
     session. That is a genuine constraint of the existing backend and the
     form says so up front rather than letting someone fill in nine fields
     and then meet a 401.
     ------------------------------------------------------------------ */
  (function () {
    var form = $('#private-form');
    if (!form) return;
    var status = $('#private-status');
    var gate = $('#private-gate');

    // ?tour=<slug>: the visitor came from a specific trip ("Ask for a private
    // departure" on a full or request-only date). The request is filed
    // "based on" that tour, which the CRM and the proposal builder both use
    // as the starting point. This is what the retired Build Your Adventure
    // wizard did with its tourId, and it is why that wizard could be removed
    // without losing anything.
    var basedOn = null;
    var params = new URLSearchParams(location.search);
    var wantedTour = params.get('tour');
    var tourP = wantedTour
      ? jget('/api/adventures/' + encodeURIComponent(wantedTour))
      : Promise.resolve(null);

    Promise.all([jget('/api/meta/filters'), tourP]).then(function (res) {
      var meta = res[0];
      var tourData = res[1];
      if (!meta) return;
      var fill = function (id, rows, valueKey, labelKey, placeholder) {
        var sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">' + esc(placeholder) + '</option>'
          + rows.map(function (r) {
              return '<option value="' + esc(r[valueKey]) + '">' + esc(r[labelKey]) + '</option>';
            }).join('');
      };
      fill('pt-activity', meta.activities, 'slug', 'plural_label', 'Any — help me choose');
      fill('pt-destination', meta.destinations, 'slug', 'name', 'Anywhere — suggest somewhere');
      fill('pt-duration', meta.duration_bands, 'key', 'label', 'Not sure yet');
      fill('pt-accommodation', meta.accommodation_types, 'key', 'label', 'No preference');

      // Pre-select the activity when the visitor arrived from an empty
      // category page's "ask us to build one" button.
      var wanted = params.get('activity');
      if (wanted) {
        var sel = document.getElementById('pt-activity');
        if (sel) sel.value = wanted;
      }

      var a = tourData && (tourData.adventure || tourData);
      if (a && a.id) {
        basedOn = a;
        var actSel = document.getElementById('pt-activity');
        var destSel = document.getElementById('pt-destination');
        if (actSel && a.activity) actSel.value = a.activity;
        if (destSel && a.destination_slug) destSel.value = a.destination_slug;
        var banner = document.createElement('div');
        banner.className = 'note';
        banner.id = 'pt-based-on';
        banner.innerHTML = '<div><p><strong>Based on ' + esc(a.name) + '.</strong> We will use it as the '
          + 'starting point — the dates, group size, difficulty and route can all change.</p>'
          + '<p style="margin:0"><button type="button" class="chip chip-clear" id="pt-based-on-clear">'
          + 'Start from scratch instead</button></p></div>';
        form.parentNode.insertBefore(banner, form);
        $('#pt-based-on-clear').addEventListener('click', function () {
          basedOn = null;
          banner.remove();
          history.replaceState(null, '', location.pathname);
        });
      }
    });

    function showGate() {
      if (!gate) return;
      gate.innerHTML = '<div class="note note-action"><div>'
        + '<p><strong>You need to be signed in to send this.</strong> Enquiries are attached to an account so '
        + 'that you can see the itinerary and quote we send back, and so that the name and email on the '
        + 'request are definitely yours — the API takes them from your account rather than from this form.</p>'
        + '<p>Use the account button in the header to sign in or create an account; your answers here are kept '
        + 'while you do.</p></div></div>';
    }

    if (!riderToken()) showGate();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      status.className = 'form-status';
      status.textContent = '';

      // Client-side validation that mirrors the server's, so the common
      // mistakes are caught without a round trip. The server validates
      // again regardless — this is a convenience, not the gate.
      var errors = [];
      $$('[data-error-for]', form).forEach(function (el) { el.textContent = ''; });
      $$('input,select,textarea', form).forEach(function (el) { el.removeAttribute('aria-invalid'); });

      var groupSize = Number($('#pt-group', form).value);
      if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 100) {
        errors.push(['pt-group', 'Enter how many people are travelling, from 1 to 100.']);
      }
      var from = $('#pt-from', form).value;
      var to = $('#pt-to', form).value;
      if (from && to && from > to) errors.push(['pt-to', 'The end of your window cannot be before the start.']);

      if (errors.length) {
        errors.forEach(function (pair) {
          var field = document.getElementById(pair[0]);
          var msg = form.querySelector('[data-error-for="' + pair[0] + '"]');
          if (field) field.setAttribute('aria-invalid', 'true');
          if (msg) msg.textContent = pair[1];
        });
        status.className = 'form-status is-err';
        status.textContent = 'Check the highlighted ' + plural(errors.length, 'field') + ' and try again.';
        var firstBad = document.getElementById(errors[0][0]);
        if (firstBad) firstBad.focus();
        return;
      }

      var token = riderToken();
      if (!token) {
        showGate();
        status.className = 'form-status is-err';
        status.textContent = 'Sign in from the header first — your answers are still here.';
        if (gate) gate.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      var btn = form.querySelector('button[type=submit]');
      var original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending…';

      var payload = {
        activity: $('#pt-activity', form).value || null,
        destination: $('#pt-destination', form).value || null,
        duration: $('#pt-duration', form).value || null,
        accommodationPref: $('#pt-accommodation', form).value || null,
        difficultyPref: $('#pt-difficulty', form).value || null,
        groupSize: groupSize,
        dateFrom: from || null,
        dateTo: to || null,
        budget: $('#pt-budget', form).value || null,
        experience: $('#pt-experience', form).value || null,
        specialRequirements: $('#pt-requirements', form).value || null,
        phone: $('#pt-phone', form).value || null,
        contactPreference: $('#pt-contact', form).value || null,
        source: 'private-trips',
        // The trip this request is based on, if the visitor came from one.
        tourId: basedOn ? basedOn.id : null,
      };

      jpost('/api/custom-requests', payload, token).then(function (res) {
        btn.disabled = false;
        btn.textContent = original;
        if (res.ok) {
          form.reset();
          status.className = 'form-status is-ok';
          // The message comes from the server, which is the thing that
          // actually knows whether the row was written.
          status.textContent = (res.data.message || 'Enquiry received.')
            + ' You can see it, and any quote we send back, on your dashboard.';
          if (typeof showToast === 'function') showToast('Enquiry sent.', 'success');
        } else if (res.status === 401) {
          showGate();
          status.className = 'form-status is-err';
          status.textContent = 'Your session has expired — sign in from the header and send it again.';
        } else {
          status.className = 'form-status is-err';
          status.textContent = res.data.error || 'Could not send that just now. Nothing has been saved — try again.';
        }
      });
    });
  })();

  /* ------------------------------------------------------------------
     CONTACT ENQUIRY (contact.html)

     Posts to POST /api/enquiries, which needs no account. Arriving with
     ?adventure=<slug>[&departure=<id>] — the "ask a question" link on a
     trip page — pre-selects both, so the question arrives attached to the
     trip it is about.
     ------------------------------------------------------------------ */
  (function () {
    var form = $('#enquiry-form');
    if (!form) return;
    var status = $('#enquiry-status');
    var advSel = $('#eq-adventure', form);
    var depSel = $('#eq-departure', form);
    var dateField = $('#eq-date-field');
    var topicSel = $('#eq-topic', form);
    var params = new URLSearchParams(location.search);
    var wantedAdventure = params.get('adventure');
    var wantedDeparture = params.get('departure');

    // The date box only makes sense when no specific departure is picked.
    function syncDateField() {
      if (dateField) dateField.hidden = !!depSel.value;
    }

    function loadDepartures(slug, preselect) {
      depSel.innerHTML = '<option value="">' + (slug ? 'Loading dates…' : 'Choose an adventure first') + '</option>';
      depSel.disabled = !slug;
      syncDateField();
      if (!slug) return;
      jget('/api/adventures/' + encodeURIComponent(slug)).then(function (data) {
        var a = data && (data.adventure || data);
        var deps = ((a && a.departures) || []).filter(function (d) { return d.status !== 'cancelled'; });
        if (!deps.length) {
          // Said plainly rather than an empty dropdown.
          depSel.innerHTML = '<option value="">No dates scheduled — use the date box below</option>';
          depSel.disabled = true;
          syncDateField();
          return;
        }
        depSel.disabled = false;
        depSel.innerHTML = '<option value="">Not a specific departure</option>'
          + deps.map(function (d) {
              var label = fmtDate(d.start_date) + ' – ' + fmtDate(d.end_date);
              if (d.status === 'full') label += ' (full)';
              else if (d.status === 'request_only') label += ' (on request)';
              return '<option value="' + esc(d.id) + '">' + esc(label) + '</option>';
            }).join('');
        if (preselect) depSel.value = String(preselect);
        syncDateField();
      });
    }

    // 100 is the API's maximum page size; asking for more is a 400, which
    // left this dropdown stuck on "Loading adventures…".
    jget('/api/adventures?limit=100&sort=name').then(function (data) {
      var rows = (data && data.adventures) || [];
      advSel.innerHTML = '<option value="">Not about a specific adventure</option>'
        + rows.map(function (a) {
            return '<option value="' + esc(a.slug) + '">' + esc(a.name) + '</option>';
          }).join('');
      if (wantedAdventure && rows.some(function (a) { return a.slug === wantedAdventure; })) {
        advSel.value = wantedAdventure;
        loadDepartures(wantedAdventure, wantedDeparture);
      }
    });

    advSel.addEventListener('change', function () { loadDepartures(advSel.value, null); });
    depSel.addEventListener('change', syncDateField);
    if (wantedAdventure && topicSel) topicSel.value = 'trip';

    var sending = false;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (sending) return; // a second click while the first is in flight
      status.className = 'form-status';
      status.textContent = '';
      $$('[data-error-for]', form).forEach(function (el) { el.textContent = ''; });
      $$('input,select,textarea', form).forEach(function (el) { el.removeAttribute('aria-invalid'); });

      var fieldIds = {
        name: 'eq-name', email: 'eq-email', phone: 'eq-phone', travellers: 'eq-travellers',
        adventure: 'eq-adventure', departureId: 'eq-departure', preferredDate: 'eq-date',
        requirements: 'eq-requirements', message: 'eq-message',
      };
      function showErrors(errs) {
        var first = null;
        Object.keys(errs).forEach(function (k) {
          var el = document.getElementById(fieldIds[k]);
          var msg = form.querySelector('[data-error-for="' + k + '"]');
          if (el) { el.setAttribute('aria-invalid', 'true'); if (!first) first = el; }
          if (msg) msg.textContent = errs[k];
        });
        status.className = 'form-status is-err';
        status.textContent = 'Check the highlighted ' + plural(Object.keys(errs).length, 'field') + ' and try again.';
        if (first) first.focus();
      }

      // Mirrors the server's checks so the common mistakes are caught here;
      // the server validates again regardless.
      var payload = {
        topic: topicSel ? topicSel.value : 'trip',
        name: $('#eq-name', form).value.trim(),
        email: $('#eq-email', form).value.trim(),
        phone: $('#eq-phone', form).value.trim(),
        travellers: $('#eq-travellers', form).value.trim(),
        adventure: advSel.value || null,
        departureId: depSel.value || null,
        preferredDate: depSel.value ? null : ($('#eq-date', form).value || null),
        requirements: $('#eq-requirements', form).value.trim(),
        message: $('#eq-message', form).value.trim(),
      };
      var errs = {};
      if (!payload.name) errs.name = 'Enter your name.';
      if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(payload.email)) errs.email = 'Enter an email address we can reply to.';
      if (payload.travellers && (!/^\d+$/.test(payload.travellers) || +payload.travellers < 1 || +payload.travellers > 100)) {
        errs.travellers = 'Enter a number of people from 1 to 100.';
      }
      if (!payload.message) errs.message = 'Tell us what you would like to know.';
      if (Object.keys(errs).length) return showErrors(errs);

      var btn = form.querySelector('button[type=submit]');
      var original = btn.textContent;
      sending = true;
      btn.disabled = true;
      btn.textContent = 'Sending…';

      jpost('/api/enquiries', payload).then(function (res) {
        sending = false;
        btn.disabled = false;
        btn.textContent = original;
        if (res.ok) {
          form.reset();
          loadDepartures('', null);
          status.className = 'form-status is-ok';
          // The server's own words: saved, read by a person, no auto-email.
          status.textContent = res.data.message;
          if (typeof showToast === 'function') showToast('Question saved.', 'success');
        } else if (res.data && res.data.fields) {
          showErrors(res.data.fields);
        } else {
          status.className = 'form-status is-err';
          status.textContent = (res.data && res.data.error) || 'Could not send that just now. Nothing has been saved — try again.';
        }
      });
    });
  })();

  /* ------------------------------------------------------------------
     HOMEPAGE BLOCKS
     ------------------------------------------------------------------ */
  (function () {
    /* The hero's figures, derived from the live API rather than typed into
       the HTML. The four previously hardcoded there were a claim nobody
       could check and the first thing on the page that would go stale; each
       of these is a count of rows that exist. The guiding-years figure is
       the most experienced guide on the books, labelled as such rather than
       as a company age, which is not something this data can support. */
    var heroStats = $('#hero-stats');
    if (heroStats) {
      Promise.all([jget('/api/meta/filters'), jget('/api/guides')]).then(function (res) {
        var meta = res[0];
        var guides = res[1] && (res[1].guides || res[1]) || [];
        if (!meta) { heroStats.remove(); return; }
        var years = guides.length
          ? Math.max.apply(null, guides.map(function (g) { return Number(g.years_experience) || 0; }))
          : null;
        var bits = [
          [meta.total, plural(meta.total, 'adventure') + ' running'],
          [(meta.destinations || []).filter(function (d) { return d.adventure_count > 0; }).length, 'regions'],
          [(meta.activities || []).length, plural((meta.activities || []).length, 'activity', 'activities')],
        ];
        if (years) bits.push([years + ' yrs', 'most experienced guide']);
        heroStats.innerHTML = bits.map(function (b) {
          return '<div><b>' + esc(b[0]) + '</b><span>' + esc(b[1]) + '</span></div>';
        }).join('');
      });
    }

    var featured = $('#home-featured');
    if (featured) {
      jget('/api/adventures?sort=featured&limit=6').then(function (data) {
        if (!data) return errorState(featured, 'the adventures');
        renderCards(featured, data.adventures, null, { eagerFirst: true });
      });
    }

    var dests = $('#home-destinations');
    if (dests) {
      jget('/api/destination-pages').then(function (data) {
        if (!data) return;
        dests.className = 'dest-grid';
        dests.innerHTML = (data.destinations || []).slice(0, 4).map(function (d) {
          return destCard(d);
        }).join('');
      });
    }

    // The homepage's four-question finder, which posts straight to
    // finder.html rather than fetching results inline — the homepage's job
    // is to start the journey, and the results page is where it continues.
    var quick = $('#home-finder');
    if (quick) {
      jget('/api/finder').then(function (data) {
        if (!data) return;
        var qs = data.questions;
        quick.innerHTML = '<form id="home-finder-form" class="finder-row">'
          + qs.filter(function (q) { return q.key !== 'month'; }).map(function (q) {
              return '<div class="finder-field">'
                + '<label for="hf-' + esc(q.key) + '">' + esc(q.question) + '</label>'
                + '<select id="hf-' + esc(q.key) + '" name="' + esc(q.key) + '">'
                +   '<option value="">Any</option>'
                +   q.options.map(function (o) {
                      return '<option value="' + esc(o.key) + '">' + esc(o.label) + '</option>';
                    }).join('')
                + '</select></div>';
            }).join('')
          + '<div class="finder-field">'
          +   '<label for="hf-month">When are you coming?</label>'
          +   '<select id="hf-month" name="month"><option value="">Any month</option>'
          +     (qs.filter(function (q) { return q.key === 'month'; })[0] || { options: [] }).options.map(function (o) {
                  return '<option value="' + esc(o.key) + '">' + esc(o.label) + '</option>';
                }).join('')
          +   '</select></div>'
          + '<button type="submit" class="btn btn-solid">Find an Adventure</button>'
          + '</form>';

        $('#home-finder-form').addEventListener('submit', function (e) {
          e.preventDefault();
          var p = new URLSearchParams();
          ['what', 'challenge', 'time', 'month'].forEach(function (k) {
            var el = document.getElementById('hf-' + k);
            if (el && el.value) p.set(k, el.value);
          });
          location.href = 'finder.html' + (p.toString() ? '?' + p : '');
        });
      });
    }

    var impactStrip = $('#home-impact');
    if (impactStrip) {
      jget('/api/impact').then(function (data) {
        if (!data) return;
        var d = data.derived;
        var bits = [];
        if (d.max_group_size_offered) bits.push([d.max_group_size_offered, 'the largest group we will take']);
        if (d.average_group_size !== null) bits.push([d.average_group_size, 'average group size on trips that ran']);
        bits.push([data.published.length + '/' + (data.published.length + data.pending.length), 'impact figures published for ' + data.year]);
        impactStrip.innerHTML = '<div class="metric-list">' + bits.map(function (b) {
          return '<div class="metric metric-derived"><p class="metric-value">' + esc(b[0]) + '</p>'
            + '<p class="metric-label" style="font-weight:400;color:var(--paper-dim)">' + esc(b[1]) + '</p></div>';
        }).join('') + '</div>';
      });
    }
  })();

  /* ------------------------------------------------------------------
     ADVENTURE DETAIL additions (tour-detail.html)

     main.js already renders this page's hero, day tabs, elevation chart,
     gallery, guides, inclusions, equipment, safety and cancellation from
     /api/tours/:slug. Everything the universal model added — the activity
     badge, at a glance, why you'll love it, is this trip for me, the
     universal difficulty block, accommodation, mandatory charges and
     optional extras, before you book, dates and prices, reviews, FAQs and
     impact — is rendered here from /api/adventures/:slug.

     That is a second request for the same adventure, which is a real cost
     and a deliberate one: the alternative was rewriting main.js's renderers
     (and with them the booking flow they feed) to consume a new payload
     shape. One extra local API call is a smaller price than re-testing
     checkout.
     ------------------------------------------------------------------ */
  (function () {
    if (!$('#adv-detail')) return;
    var slug = new URLSearchParams(location.search).get('slug');
    if (!slug) return;

    // Every "private trip" and "ask a question" link on this page carries the
    // trip, so the enquiry arrives attached to the adventure it is about.
    // Done from the URL straight away rather than after the fetch, so the
    // links are right even if the API is slow.
    $$('[data-private-trip-link]').forEach(function (el) {
      el.href = 'private-trips.html?tour=' + encodeURIComponent(slug);
    });
    $$('[data-ask-link]').forEach(function (el) {
      el.href = 'contact.html?adventure=' + encodeURIComponent(slug);
    });

    jget('/api/adventures/' + encodeURIComponent(slug)).then(function (a) {
      if (!a) return;

      setMeta(
        a.name + ' — ' + a.duration_days + ' days, ' + (a.activity_label || a.activity) + ' in '
          + (a.region || 'Nepal') + ' | High Route',
        (a.summary || '').slice(0, 155)
      );

      var set = function (id, html) {
        var el = document.getElementById(id);
        if (!el) return;
        if (!html) { el.remove(); return; } // no content: no empty section
        el.innerHTML = html;
      };

      /* --- at a glance --- */
      set('adv-glance', glanceBlock(a));

      /* --- why you'll love it --- */
      set('adv-highlights', (a.highlights || []).length
        ? '<div class="section-head"><p class="section-kicker">Why you will love it</p>'
          + '<h2>What makes this trip</h2></div>'
          + '<ul class="list-check" style="max-width:72ch">'
          + a.highlights.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('')
          + '</ul>'
        : null);

      /* --- is this trip for me --- */
      var suit = a.suitability || {};
      var suitRows = [
        ['Fitness', suit.fitness], ['Technical demand', suit.technical],
        ['Altitude', suit.altitude], ['A typical day', suit.daily],
        ['Previous experience', suit.experience],
      ].filter(function (r) { return r[1]; });

      set('adv-suitability',
        '<div class="section-head"><p class="section-kicker">Is this trip for me?</p>'
        + '<h2>What it asks of you</h2></div>'
        + '<div class="two-col">'
        +   '<div>' + difficultyBlock(a) + '</div>'
        +   '<div>'
        +     (suitRows.length
                ? '<ul class="list-plain">' + suitRows.map(function (r) {
                    return '<li><strong>' + esc(r[0]) + '</strong><br>' + esc(r[1]) + '</li>';
                  }).join('') + '</ul>'
                : '<div class="note note-action"><div><p><strong>The written requirements for this trip have '
                  + 'not been filled in yet.</strong> The scores on the left are real, and so is the overall '
                  + 'level — but the sentences explaining what the fitness, technical and altitude demands '
                  + 'mean in practice on this route have to be written by whoever runs it. '
                  + 'Ask us and you will get a straight answer.</p></div></div>')
        +     (a.activity_fields || []).filter(function (f) { return /fitness_notes|bike_requirements|swimming_requirement|porter_support/.test(f.key); })
                .map(function (f) {
                  return '<div class="card" style="margin-top:16px"><h3>' + esc(f.label) + '</h3><p>'
                    + esc(Array.isArray(f.value) ? f.value.join(', ') : f.value) + '</p></div>';
                }).join('')
        +   '</div>'
        + '</div>');

      /* --- accommodation --- */
      var accomField = (a.activity_fields || []).filter(function (f) { return f.key === 'accommodation_detail'; })[0];
      set('adv-accommodation', (a.accommodation_type || a.accommodation_notes || accomField)
        ? '<div class="section-head"><p class="section-kicker">Accommodation</p>'
          + '<h2>Where you sleep</h2></div>'
          + '<div class="card" style="max-width:72ch">'
          +   (a.accommodation_type
                ? '<h3>' + esc(a.accommodation_type.charAt(0).toUpperCase() + a.accommodation_type.slice(1)) + '</h3>'
                : '')
          +   (a.accommodation_notes ? '<p>' + esc(a.accommodation_notes) + '</p>' : '')
          +   (accomField ? '<p>' + esc(accomField.value) + '</p>' : '')
          +   (!a.accommodation_notes && !accomField
                ? '<p>This trip is listed as ' + esc(a.accommodation_type || 'unspecified')
                  + ' accommodation. The specific lodges and guesthouses used depend on the dates and on what '
                  + 'is open, so they are confirmed before departure rather than named here — naming a '
                  + 'property we cannot guarantee would be worse than this.</p>'
                : '')
          + '</div>'
        : null);

      /* --- itinerary, as an accordion --- */
      set('adv-itinerary', (a.days || []).length
        ? '<div class="section-head"><p class="section-kicker">Day by day</p>'
          + '<h2>The itinerary</h2></div>'
          + '<div class="acc-expand">'
          +   '<button type="button" class="btn btn-small btn-ghost" data-acc-all="open">Expand all</button>'
          +   '<button type="button" class="btn btn-small btn-ghost" data-acc-all="close">Collapse all</button>'
          + '</div>'
          + accordion(a.days.map(function (d) {
              var stats = [];
              // 0 km is a rest day, which is a fact; a missing figure is not
              // 0 and is not printed as one.
              if (d.distance_km === 0) stats.push(['Rest day', '']);
              else if (num(d.distance_km)) stats.push([num(d.distance_km) + ' km', 'distance']);
              if (num(d.elevation_gain_m)) stats.push(['+' + num(d.elevation_gain_m) + ' m', 'ascent']);
              if (num(d.elevation_loss_m)) stats.push(['−' + num(d.elevation_loss_m) + ' m', 'descent']);
              if (num(d.high_point_m)) stats.push([num(d.high_point_m) + ' m', 'high point']);
              if (d.riding_hours) stats.push([d.riding_hours, 'hours active']);
              return {
                num: 'D' + d.day_number,
                title: d.title,
                aside: d.distance_km === 0 ? 'Rest day' : (num(d.distance_km) ? num(d.distance_km) + ' km' : ''),
                body: (stats.length
                        ? '<div class="acc-stats">' + stats.map(function (s) {
                            return '<div><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></div>';
                          }).join('') + '</div>'
                        : '')
                      + (d.terrain ? '<p><strong>Terrain:</strong> ' + esc(d.terrain) + '</p>' : '')
                      + (d.overnight_place ? '<p><strong>Overnight:</strong> ' + esc(d.overnight_place) + '</p>' : ''),
              };
            }))
        : null);

      /* --- included / not included / charges / extras --- */
      var priceCols = [
        ['Included', a.inclusions, 'list-check'],
        ['Not included', a.exclusions, 'list-cross'],
        ['Mandatory charges', a.mandatory_charges, 'list-plain'],
        ['Optional extras', a.optional_extras, 'list-plain'],
      ].filter(function (c) { return (c[1] || []).length; });

      set('adv-pricing-detail', priceCols.length
        ? '<div class="section-head"><p class="section-kicker">What the price covers</p>'
          + '<h2>Included and not included</h2></div>'
          + '<div class="two-col">'
          + priceCols.map(function (c) {
              return '<div class="card"><h3>' + esc(c[0]) + '</h3><ul class="' + c[2] + '">'
                + c[1].map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('')
                + '</ul></div>';
            }).join('')
          + '</div>'
          + ((a.mandatory_charges || []).length
              ? ''
              : '<div class="note"><div><p><strong>No mandatory local charges are recorded for this trip.</strong> '
                + 'Permit and conservation-area fees are set by Nepali government bodies and apply to most routes, '
                + 'so if this trip needs any they have not been entered yet. They are confirmed at booking — '
                + 'ask before you pay a deposit if you want the figure in writing.</p></div></div>')
        : null);

      /* --- before you book --- */
      var byb = a.before_you_book || {};
      var bybRows = [
        ['Insurance', byb.insurance], ['Visa and entry', byb.visa], ['Health', byb.health],
        ['Age restrictions', byb.age], ['Cancellation', byb.cancellation],
      ].filter(function (r) { return r[1]; });

      set('adv-before-book',
        '<div class="section-head"><p class="section-kicker">Before you book</p>'
        + '<h2>The practical conditions</h2></div>'
        + (bybRows.length
            ? '<div style="max-width:80ch">' + accordion(bybRows.map(function (r) {
                return { title: r[0], body: '<p>' + esc(r[1]) + '</p>' };
              })) + '</div>'
            : '')
        // These four are conditions of travel on every trip on the site,
        // whether or not the per-trip fields have been written, so they are
        // stated here rather than left to a blank section.
        + '<div class="note note-action" style="max-width:80ch"><div>'
        +   '<p><strong>These apply to every trip here, including this one:</strong></p>'
        +   '<ul><li>Travel insurance covering mountain activity to this trip’s maximum altitude'
        +     (num(a.max_altitude_m) ? ' (' + num(a.max_altitude_m) + ' m)' : '')
        +     ', including helicopter evacuation and repatriation, is a condition of booking. '
        +     'Many standard policies exclude activity above 3,000 m — check that clause specifically.</li>'
        +     '<li>A visa is required for almost every nationality and the rules are set by Nepal’s Department '
        +     'of Immigration. Check the current requirement with them or your embassy, not with us.</li>'
        +     '<li>Trips above 3,000 m carry a real risk of altitude sickness regardless of fitness. '
        +     'Talk to a travel-health professional before booking if you have any cardiovascular or '
        +     'respiratory condition.</li>'
        +     '<li>' + (byb.age ? esc(byb.age) : 'No age limit has been set for this trip. Ask before booking for anyone under 18 or over 70.') + '</li>'
        +   '</ul>'
        +   '<p>Region-specific emergency and evacuation procedure is still being documented with High Route '
        +     'and appears on the <a href="safety.html">Safety page</a> as it is confirmed. '
        +     'We are not going to describe a procedure we have not been given.</p>'
        + '</div></div>'
        + '<p style="margin-top:16px"><a class="adv-link" href="booking-conditions.html">Full booking conditions →</a></p>');

      /* --- dates and prices --- */
      var deps = a.departures || [];
      set('adv-dates',
        '<div class="section-head"><p class="section-kicker">Dates and prices</p>'
        + '<h2>When you can go</h2></div>'
        + '<div class="card" style="margin-bottom:20px"><div class="glance" style="border:0">'
        +   '<div><dt>From</dt><dd>' + esc(money(a.price_from_cents, a.currency)) + '<small> per person</small></dd></div>'
        +   (a.deposit_cents !== null
                ? '<div><dt>Deposit</dt><dd>' + esc(money(a.deposit_cents, a.currency)) + '</dd></div>'
                : '')
        +   '<div><dt>Group size</dt><dd>' + a.group_size_min + '–' + a.group_size_max + '</dd></div>'
        + '</div>'
        + '<div class="note"><div><p>The deposit figure shown is a placeholder set at 20% when this catalogue '
        +   'was migrated and <strong>has not been confirmed by High Route</strong>. The amount at checkout is '
        +   'the authority. Balance due before departure; see '
        +   '<a href="booking-conditions.html">booking conditions</a>.</p></div></div></div>'
        + (deps.length
            ? '<table class="dates-table"><thead><tr>'
              + '<th scope="col">Departure</th><th scope="col">Returns</th><th scope="col">Availability</th>'
              + '<th scope="col">Guide</th><th scope="col"></th></tr></thead><tbody>'
              + deps.map(function (d) {
                  var left = d.seats_available;
                  var label = d.status === 'cancelled' ? 'Cancelled'
                    : d.status === 'full' || left <= 0 ? 'Fully booked'
                    : d.status === 'request_only' ? 'Request only'
                    : left + ' of ' + d.capacity + ' ' + plural(left, 'space') + ' left';
                  var pip = d.status === 'cancelled' || left <= 0 ? 'pip-red' : left <= 3 ? 'pip-amber' : 'pip-green';
                  var bookable = d.status !== 'cancelled' && d.status !== 'full' && left > 0;
                  return '<tr>'
                    + '<td data-label="Departure" class="num">' + esc(fmtDate(d.start_date)) + '</td>'
                    + '<td data-label="Returns" class="num">' + esc(fmtDate(d.end_date)) + '</td>'
                    + '<td data-label="Availability"><span class="pip ' + pip + '"></span>' + esc(label) + '</td>'
                    + '<td data-label="Guide">' + esc(d.guide_name || 'To be assigned') + '</td>'
                    + '<td data-label="">' + (bookable
                        ? '<a class="btn btn-small btn-solid" href="checkout.html?departure=' + d.id + '">Book this date</a>'
                        : '<a class="adv-link" href="private-trips.html">Ask about dates</a>') + '</td>'
                    + '</tr>';
                }).join('')
              + '</tbody></table>'
            : '<div class="empty-state"><h3>No dates currently open</h3>'
              + '<p>There are no scheduled departures for this trip on the books right now. That is the actual '
              + 'state of the calendar rather than a placeholder — we are not going to show you a date we '
              + 'cannot run. It can be run privately on dates that suit you.</p>'
              + '<a href="private-trips.html" class="btn btn-solid">Ask about private dates</a></div>'));

      /* --- reviews --- */
      var reviews = a.reviews || [];
      set('adv-reviews', '<div class="section-head"><p class="section-kicker">Traveller reviews</p>'
        + '<h2>What riders said</h2></div>'
        + (reviews.length
            ? (a.ratings
                ? '<p class="result-count" style="margin-bottom:16px"><b>' + a.ratings.average + '/5</b> from '
                  + a.ratings.count + ' scored ' + plural(a.ratings.count, 'review')
                  + (a.ratings.would_recommend ? ' · ' + a.ratings.would_recommend + ' would recommend it' : '')
                  + '</p>'
                : '')
              + '<div class="adv-grid-2">'
              + reviews.map(function (r) {
                  return '<figure class="card" style="margin:0">'
                    + (r.quote ? '<blockquote style="margin:0 0 12px;font-size:16px;line-height:1.65">“'
                        + esc(r.quote) + '”</blockquote>' : '')
                    + '<figcaption class="result-count"><strong>' + esc(r.rider_name) + '</strong>'
                    + (r.rating ? ' · ' + r.rating + '/5' : '')
                    + ' · ' + esc(fmtDate(r.created_at, { month: 'long', year: 'numeric' }))
                    + '</figcaption></figure>';
                }).join('')
              + '</div>'
            : '<div class="empty-state"><h3>No reviews for this trip yet</h3>'
              + '<p>Reviews here are written by riders who actually rode the departure, from their own dashboard '
              + 'afterwards. Nobody has reviewed this one yet, and we do not borrow reviews from other trips '
              + 'or write our own.</p></div>'));

      /* --- FAQs: this trip's own, then the site-wide ones that apply --- */
      var ownFaqs = (a.faqs || []).map(function (f) {
        return { title: f.question || f.q, body: '<p>' + esc(f.answer || f.a) + '</p>' };
      });
      var siteFaqs = (a.site_faqs || []).slice(0, 8).map(function (f) {
        return { title: f.question, body: '<p>' + esc(f.answer) + '</p>' };
      });
      set('adv-faqs', (ownFaqs.length + siteFaqs.length)
        ? '<div class="section-head"><p class="section-kicker">Questions</p><h2>Frequently asked</h2></div>'
          + '<div style="max-width:80ch">' + accordion(ownFaqs.concat(siteFaqs)) + '</div>'
          + '<p style="margin-top:18px"><a class="adv-link" href="faqs.html">All frequently asked questions →</a></p>'
        : null);

      /* --- impact --- */
      var impact = a.impact || {};
      var impactKeys = Object.keys(impact).filter(function (k) { return impact[k]; });
      set('adv-impact',
        '<div class="section-head"><p class="section-kicker">Impact</p>'
        + '<h2>What this trip puts back</h2></div>'
        + (impactKeys.length
            ? '<ul class="list-plain" style="max-width:76ch">' + impactKeys.map(function (k) {
                return '<li><strong>' + esc(k.replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }))
                  + '</strong><br>' + esc(impact[k]) + '</li>';
              }).join('') + '</ul>'
            : '<div class="note" style="max-width:76ch"><div>'
              + '<p><strong>Nothing specific to this trip has been recorded yet.</strong> The structure for it '
              + 'exists — which lodges on this route are locally owned, what is paid to the guides and '
              + 'porters on it, what it contributes to trail maintenance, how far it travels by road and in '
              + 'what — and it is recorded per departure in the admin panel.</p>'
              + '<p>What can be said about this trip without inventing anything: it runs with a maximum of '
              + esc(a.group_size_max) + ' travellers and Nepali guides. Everything else belongs on the '
              + '<a href="our-impact.html">Our Impact page</a>, which shows exactly which figures are '
              + 'published and which are not.</p></div></div>')
        + '<p style="margin-top:16px"><a class="adv-link" href="our-impact.html">How we measure this →</a></p>');

      /* --- final booking CTA (brief 8.14) ---------------------------------
         One primary action — the dates — and two quieter ones. "Check dates"
         goes to the dates section when this trip has one and to the booking
         card when it does not, so the button never lands on nothing. */
      var openDep = (a.departures || []).filter(function (d) {
        return d.status !== 'cancelled' && d.seats_available > 0;
      })[0];
      var datesTarget = document.getElementById('adv-dates') ? '#adv-dates' : '#book';
      set('adv-final-cta',
        '<div class="adv-final-cta">'
        + '<p class="section-kicker">Ready when you are</p>'
        + '<h2>' + esc(a.name) + '</h2>'
        + '<p class="adv-final-cta-line">'
        + esc(a.duration_days + ' ' + plural(a.duration_days, 'day')) + ' · '
        + esc((a.difficulty && a.difficulty.label) || ('Level ' + a.difficulty_level)) + ' · '
        + 'from ' + esc(money(a.price_from_cents, a.currency))
        + (openDep ? ' · next departure ' + esc(fmtDate(openDep.start_date)) : ' · dates on request')
        + '</p>'
        + '<div class="hero-ctas">'
        +   '<a href="' + datesTarget + '" class="btn btn-solid">' + (openDep ? 'Check dates' : 'See dates') + '</a>'
        +   '<a href="contact.html?adventure=' + encodeURIComponent(a.slug) + '" class="btn btn-ghost">Ask a question</a>'
        +   '<a href="private-trips.html?tour=' + encodeURIComponent(a.slug) + '" class="btn btn-ghost">Run it privately</a>'
        + '</div>'
        + '</div>');

      /* Expand/collapse all, for the itinerary accordion. */
      $$('[data-acc-all]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var open = btn.getAttribute('data-acc-all') === 'open';
          var scope = btn.closest('section') || document;
          $$('details.acc-item', scope).forEach(function (d) { d.open = open; });
        });
      });

      /* Structured data. Only fields backed by real rows are emitted: no
         aggregateRating unless there are scored reviews, and no offer
         availability unless a departure with seats actually exists. The
         brief forbids fabricated review markup and "bookable" claims the
         data does not support. */
      var ld = {
        '@context': 'https://schema.org',
        '@type': 'TouristTrip',
        name: a.name,
        description: a.summary || undefined,
        touristType: a.activity_label,
        itinerary: (a.days || []).length
          ? { '@type': 'ItemList', numberOfItems: a.days.length }
          : undefined,
      };
      if (a.image_url) ld.image = a.image_url;
      var bookable = deps.filter(function (d) {
        return d.status !== 'cancelled' && d.status !== 'full' && d.seats_available > 0;
      });
      if (bookable.length) {
        ld.offers = {
          '@type': 'Offer',
          price: (a.price_from_cents / 100).toFixed(2),
          priceCurrency: a.currency || 'EUR',
          availability: 'https://schema.org/InStock',
          validFrom: bookable[0].start_date,
        };
      }
      if (a.ratings && a.ratings.count > 0) {
        ld.aggregateRating = {
          '@type': 'AggregateRating',
          ratingValue: a.ratings.average,
          reviewCount: a.ratings.count,
        };
      }
      var script = document.createElement('script');
      script.type = 'application/ld+json';
      script.textContent = JSON.stringify(ld);
      document.head.appendChild(script);
    });
  })();

  // Exposed for the admin panel's preview and for any page that wants one
  // card without reimplementing it.
  window.HighRouteAdventures = {
    card: advCard,
    destCard: destCard,
    difficulty: difficultyBlock,
    glance: glanceBlock,
    accordion: accordion,
    money: money,
  };
})();
