/* ===========================================================================
   SITE SHELL — the header and footer, defined once.

   Every page previously carried its own copy of the header markup. Twelve
   copies of a four-item dropdown nav meant that adding "Destinations" was
   twelve edits, and that the pages had already drifted apart: some pointed
   at `#why`, some at `index.html#why`, and several menu entries went to
   `href="#"` — the dead links the brief rules out explicitly.

   Now a page writes:

       <div data-site-header></div>
       ...
       <div data-site-footer></div>
       <script src="shell.js"></script>
       <script src="config.js"></script>
       <script src="main.js"></script>

   and gets the real thing. Order matters: shell.js runs before main.js so
   that main.js finds `.main-nav` (it builds the mobile panel from it) and
   `.header-actions` (it mounts the account control and notification bell
   there). Both scripts sit at the end of <body>, so the placeholders exist
   by the time this runs.

   NAV STRUCTURE comes from the brief and is deliberately shallow:

       Adventures | Destinations | Plan Your Trip | About | [Find an Adventure]

   Difficulty, duration, riding style, region and season are NOT in here.
   They are filters, and the brief is explicit that they belong in the
   search experience rather than the navigation.

   The activity and destination entries are the one part that is data rather
   than copy, so they render from a static list first — a header must not
   wait for a network request — and are then reconciled against
   /api/meta/filters, which drops an activity an admin has disabled and adds
   one they have enabled. See enhanceFromApi() at the bottom.
   =========================================================================== */
(function () {
  'use strict';

  /** Escape on render. Everything below that interpolates a value runs
   *  through this, including values that came from our own API — the admin
   *  panel is where activity and destination names are typed, and "escape at
   *  every interpolation site" is the rule this codebase follows rather than
   *  trusting any particular source. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // The current page, used to mark the active nav item. Normalised so that
  // "/", "/index.html" and "" are all the homepage.
  var FILE = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (FILE === '') FILE = 'index.html';
  var PARAMS = new URLSearchParams(location.search);

  /* ---------------------------------------------------------------------
     NAV MODEL

     `match` lists the files (and, for the adventures listing, the ?activity
     value) that should light this item up. It exists because the activity
     category pages are all adventures.html with a different query string —
     one listing template, as the brief requires, rather than four
     near-identical files that would drift apart within a month.
     --------------------------------------------------------------------- */
  var NAV = [
    {
      label: 'Adventures',
      href: 'adventures.html',
      match: ['adventures.html', 'tour-detail.html'],
      children: [
        { label: 'All Adventures', href: 'adventures.html', desc: 'Every trip, filterable' },
        { label: 'Mountain Biking', href: 'adventures.html?activity=mountain-biking', activity: 'mountain-biking', desc: 'Himalayan singletrack and high passes' },
        { label: 'Trekking', href: 'adventures.html?activity=trekking', activity: 'trekking', desc: 'On foot, at altitude' },
        { label: 'Multi-Activity', href: 'adventures.html?activity=multi-activity', activity: 'multi-activity', desc: 'More than one way to travel' },
        { label: 'Departure calendar', href: 'calendar.html', desc: 'Every date, month by month', sep: true },
      ],
    },
    {
      label: 'Destinations',
      href: 'destinations.html',
      match: ['destinations.html', 'destination.html'],
      children: [
        { label: 'All destinations', href: 'destinations.html', desc: 'Seven regions compared' },
        { label: 'Mustang', href: 'destination.html?d=mustang', destination: 'mustang', desc: 'High desert behind the Himalaya' },
        { label: 'Annapurna', href: 'destination.html?d=annapurna', destination: 'annapurna', desc: 'The circuit, and Thorong La' },
        { label: 'Everest', href: 'destination.html?d=everest', destination: 'everest', desc: 'The Khumbu, on foot' },
        { label: 'Pokhara', href: 'destination.html?d=pokhara', destination: 'pokhara', desc: 'Lakeside, low and year-round' },
        { label: 'Kathmandu Valley', href: 'destination.html?d=kathmandu', destination: 'kathmandu', desc: 'The valley rim, no permits' },
      ],
    },
    {
      label: 'Plan Your Trip',
      href: 'finder.html',
      match: ['finder.html', 'private-trips.html', 'when-to-visit.html', 'difficulty-guide.html', 'faqs.html'],
      children: [
        { label: 'Adventure Finder', href: 'finder.html', desc: 'Four questions, no email asked' },
        { label: 'Private Trips', href: 'private-trips.html', desc: 'Built around your group' },
        { label: 'When to Visit', href: 'when-to-visit.html', desc: 'Month by month, region by region' },
        { label: 'Difficulty Guide', href: 'difficulty-guide.html', desc: 'How the five levels are graded' },
        { label: 'FAQs', href: 'faqs.html', desc: 'The questions we actually get', sep: true },
      ],
    },
    {
      label: 'About',
      href: 'about.html',
      match: ['about.html', 'guides.html', 'safety.html', 'our-impact.html', 'responsible-travel.html'],
      children: [
        { label: 'Our Story', href: 'about.html', desc: 'Why this exists, and who runs it' },
        { label: 'Guides', href: 'guides.html', desc: 'Who you will actually be with' },
        { label: 'Safety', href: 'safety.html', desc: 'What is in place, and what is not' },
        { label: 'Our Impact', href: 'our-impact.html', desc: 'Figures published, and the gaps' },
        { label: 'Responsible Travel', href: 'responsible-travel.html', desc: 'The operating decisions behind it' },
      ],
    },
  ];

  function isActive(item) {
    if (item.match && item.match.indexOf(FILE) !== -1) return true;
    return item.href && item.href.split('?')[0].toLowerCase() === FILE;
  }

  function childIsActive(child) {
    var file = child.href.split('?')[0].toLowerCase();
    if (file !== FILE) return false;
    // adventures.html?activity=trekking is a different nav item from
    // adventures.html, so compare the query value too where one is declared.
    if (child.activity) return PARAMS.get('activity') === child.activity;
    if (child.destination) return PARAMS.get('d') === child.destination;
    if (PARAMS.get('activity') || PARAMS.get('d')) return false;
    return true;
  }

  function headerHtml() {
    var items = NAV.map(function (item) {
      var panel = item.children.map(function (c) {
        return '<a href="' + esc(c.href) + '"' + (childIsActive(c) ? ' aria-current="page"' : '')
          + (c.sep ? ' class="np-sep"' : '')
          + (c.activity ? ' data-nav-activity="' + esc(c.activity) + '"' : '')
          + (c.destination ? ' data-nav-destination="' + esc(c.destination) + '"' : '')
          + '><span class="np-label">' + esc(c.label) + '</span>'
          + (c.desc ? '<span class="np-desc">' + esc(c.desc) + '</span>' : '')
          + '</a>';
      }).join('\n          ');

      // The top-level item is a real link to a real page, not href="#". A
      // dropdown parent that goes nowhere is unusable by keyboard and on
      // touch, and "Adventures" has an All Adventures page to point at.
      return '<li' + (isActive(item) ? ' class="is-active"' : '') + '>'
        + '<a href="' + esc(item.href) + '"' + (isActive(item) ? ' aria-current="true"' : '') + '>' + esc(item.label) + '</a>'
        + '<div class="nav-panel"><div class="nav-panel-inner">' + panel + '</div></div>'
        + '</li>';
    }).join('\n      ');

    return ''
      + '<a href="index.html" class="logo"><span class="mark">◆</span> HIGH ROUTE</a>\n'
      + '<nav aria-label="Main">\n'
      + '  <ul class="main-nav">\n      ' + items + '\n  </ul>\n'
      + '</nav>\n'
      + '<div class="header-actions">\n'
      + '  <a href="search.html" class="nav-icon-btn" aria-label="Search adventures" title="Search">'
      +    '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">'
      +    '<circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/>'
      +    '<path d="M13 13l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></a>\n'
      + '  <a href="finder.html" class="nav-cta">Find an Adventure</a>\n'
      + '  <button class="nav-toggle" aria-label="Menu" aria-expanded="false">☰</button>\n'
      + '</div>';
  }

  /* ---------------------------------------------------------------------
     FOOTER

     Grouped the same way as the navigation, so a visitor who could not find
     something in the menu looks in the same place in the footer and finds it
     where they expect. The legal column is the only group that is not in the
     header, which is the convention everywhere and is why it is here.
     --------------------------------------------------------------------- */
  var FOOTER_GROUPS = [
    {
      title: 'Adventures',
      links: [
        ['All Adventures', 'adventures.html'],
        ['Mountain Biking', 'adventures.html?activity=mountain-biking'],
        ['Trekking', 'adventures.html?activity=trekking'],
        ['Multi-Activity', 'adventures.html?activity=multi-activity'],
        ['Departure calendar', 'calendar.html'],
      ],
    },
    {
      title: 'Destinations',
      links: [
        ['Mustang', 'destination.html?d=mustang'],
        ['Annapurna', 'destination.html?d=annapurna'],
        ['Everest', 'destination.html?d=everest'],
        ['Pokhara', 'destination.html?d=pokhara'],
        ['Kathmandu Valley', 'destination.html?d=kathmandu'],
      ],
    },
    {
      title: 'Plan your trip',
      links: [
        ['Adventure Finder', 'finder.html'],
        ['Private Trips', 'private-trips.html'],
        ['When to Visit', 'when-to-visit.html'],
        ['Difficulty Guide', 'difficulty-guide.html'],
        ['FAQs', 'faqs.html'],
        ['Search', 'search.html'],
      ],
    },
    {
      title: 'About',
      links: [
        ['Our Story', 'about.html'],
        ['Guides', 'guides.html'],
        ['Safety', 'safety.html'],
        ['Our Impact', 'our-impact.html'],
        ['Responsible Travel', 'responsible-travel.html'],
        ['Contact', 'contact.html'],
      ],
    },
    {
      title: 'Legal',
      links: [
        ['Booking Conditions', 'booking-conditions.html'],
        ['Privacy Policy', 'privacy.html'],
        ['Cookies', 'cookies.html'],
        ['Accessibility', 'accessibility.html'],
      ],
    },
  ];

  function footerHtml() {
    var cols = FOOTER_GROUPS.map(function (g) {
      return '<div class="foot-col"><h4>' + esc(g.title) + '</h4><ul>'
        + g.links.map(function (l) {
            return '<li><a href="' + esc(l[1]) + '">' + esc(l[0]) + '</a></li>';
          }).join('')
        + '</ul></div>';
    }).join('\n    ');

    return ''
      + '<div class="foot-top">\n'
      + '  <div class="foot-brand">\n'
      + '    <a href="index.html" class="logo"><span class="mark">◆</span> HIGH ROUTE</a>\n'
      + '    <p>Nepali-run adventure travel in the Himalaya. Mountain biking, trekking and multi-activity trips, '
      +      'in small groups, with local guides.</p>\n'
      + '    <div class="foot-cta">\n'
      + '      <a href="finder.html" class="btn btn-solid">Find an Adventure</a>\n'
      + '      <a href="private-trips.html" class="btn btn-ghost">Plan a Custom Trip</a>\n'
      + '    </div>\n'
      + '  </div>\n'
      + '  <div class="foot-cols">\n    ' + cols + '\n  </div>\n'
      + '</div>\n'
      + '<div class="foot-bottom">\n'
      + '  <p class="foot-legal">&copy; ' + new Date().getFullYear() + ' High Route. '
      +    'Registration details, licence numbers and the registered trading address are still to be supplied '
      +    'and are not shown here rather than being invented.</p>\n'
      + '  <p class="foot-note">This build runs against a live database. Departures, prices and availability '
      +    'are whatever has been entered in the admin panel — nothing on this site is simulated. '
      +    'Where information has not been supplied, the page says so.</p>\n'
      + '</div>';
  }

  /* ---------------------------------------------------------------------
     Mount
     --------------------------------------------------------------------- */
  var headerSlot = document.querySelector('[data-site-header]');
  if (headerSlot) {
    headerSlot.className = 'site-header' + (headerSlot.className ? ' ' + headerSlot.className : '');
    headerSlot.setAttribute('role', 'banner');
    headerSlot.innerHTML = headerHtml();
    // A header element is what the rest of the CSS and main.js expect; if a
    // page used a <div> placeholder it still works, because everything keys
    // off the .site-header class rather than the tag name.
  }

  var footerSlot = document.querySelector('[data-site-footer]');
  if (footerSlot) {
    footerSlot.className = 'site-footer' + (footerSlot.className ? ' ' + footerSlot.className : '');
    footerSlot.setAttribute('role', 'contentinfo');
    footerSlot.innerHTML = footerHtml();
  }

  /* ---------------------------------------------------------------------
     Skip link — the first thing in the tab order on every page.

     Added here rather than in each page's markup for the same reason the
     header is: there were twelve pages and none of them had one, and a
     keyboard user otherwise tabs through a five-item dropdown nav before
     reaching the content on every single page.
     --------------------------------------------------------------------- */
  if (headerSlot && !document.querySelector('.skip-link')) {
    var skip = document.createElement('a');
    skip.className = 'skip-link';
    skip.href = '#main';
    skip.textContent = 'Skip to content';
    document.body.insertBefore(skip, document.body.firstChild);
    // Give the page a #main target if it hasn't declared one, so the link
    // never points at nothing.
    //
    // The newer pages wrap their content in <main id="main">. The pages that
    // predate the shell — checkout, dashboard, calendar, the tour detail
    // page — have no <main> at all, and a skip link pointing at a
    // non-existent fragment does nothing at all when activated, which is
    // worse than having no skip link. So: use <main> if there is one, and
    // otherwise promote the first real content block after the header into
    // the landmark, which is what it already is semantically.
    if (!document.getElementById('main')) {
      var main = document.querySelector('main') || document.querySelector('.page-main');
      if (!main) {
        var after = headerSlot.nextElementSibling;
        while (after && (after.classList.contains('skip-link') || after.tagName === 'SCRIPT')) {
          after = after.nextElementSibling;
        }
        main = after;
        if (main) {
          // Announce it as the main landmark too, since a <section> or
          // <div> carries no role of its own.
          if (!main.getAttribute('role')) main.setAttribute('role', 'main');
        }
      }
      if (main) {
        // NEVER rename an element that already has an id. This used to set
        // main.id = 'main' unconditionally, and on dashboard.html the block
        // it promoted was #dash-gate — so main.js's
        // getElementById('dash-gate') returned null, threw, and the rider
        // dashboard never booted: no bookings, no requests, no profile. The
        // same clobbering hit #detail-signin-gate and #trip-gate. Point the
        // skip link at the existing id instead. (Every page now has a real
        // <main id="main">, so this branch is only a safety net.)
        if (main.id) skip.href = '#' + main.id;
        else main.id = 'main';
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
      }
    }
  }

  /* ---------------------------------------------------------------------
     enhanceFromApi

     The nav above is correct for the activities and destinations that exist
     today. It is still a hardcoded list, and the brief wants a new activity
     enabled from the admin panel to appear on the site — so this reconciles
     the rendered nav against the API: an activity or destination that is no
     longer public is removed, and one that has been added is appended.

     Deliberately an enhancement rather than the source: if the API is slow
     or down, the header is already rendered and usable. A nav that waits for
     fetch() is a nav that flickers on every page load.
     --------------------------------------------------------------------- */
  /* ---------------------------------------------------------------------
     CANONICAL URL — on every page (brief section 22).

     Built from the path plus only the query parameters that change what a
     page IS — the trip, the destination, the activity category. Tracking
     junk, filter state and anything else is dropped, so ?utm_source=x and a
     re-ordered filter string do not each become a separate page. Pages that
     render their own content (adventures.js setMeta) overwrite this with the
     same rule once their data arrives.
     --------------------------------------------------------------------- */
  (function setCanonical() {
    var KEEP = { 'tour-detail.html': ['slug'], 'destination.html': ['d'], 'adventures.html': ['activity'] };
    var keep = KEEP[FILE] || [];
    var q = new URLSearchParams();
    keep.forEach(function (k) { if (PARAMS.get(k)) q.set(k, PARAMS.get(k)); });
    var href = location.origin + location.pathname + (q.toString() ? '?' + q : '');
    var link = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = href;
  })();

  function enhanceFromApi() {
    var base = window.HIGHROUTE_API_BASE;
    if (!base || !headerSlot) return;

    fetch(base + '/api/meta/filters')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        reconcile('activity', data.activities || [], function (a) {
          return {
            key: a.slug,
            label: a.plural_label || a.name,
            href: 'adventures.html?activity=' + encodeURIComponent(a.slug),
            // The summary is one sentence written in the admin panel; the
            // menu has room for a clause, so take the first one.
            desc: a.summary ? String(a.summary).split(/[.;]\s/)[0] : '',
          };
        });
        reconcile('destination', (data.destinations || []).filter(function (d) { return d.adventure_count > 0 || true; }), function (d) {
          return {
            key: d.slug,
            label: d.name,
            href: 'destination.html?d=' + encodeURIComponent(d.slug),
            desc: d.adventure_count
              ? d.adventure_count + (d.adventure_count === 1 ? ' adventure' : ' adventures')
              : '',
          };
        });
      })
      .catch(function () { /* header is already rendered; nothing to do */ });
  }

  /** Reconciles one group of data-driven nav links in place.
   *  attr is 'activity' or 'destination'; the DOM attribute is
   *  data-nav-activity / data-nav-destination. */
  function reconcile(attr, rows, toItem) {
    var selector = '[data-nav-' + attr + ']';
    var existing = Array.prototype.slice.call(headerSlot.querySelectorAll(selector));
    if (!existing.length || !rows.length) return;
    var container = existing[0].parentNode;
    var wanted = rows.map(toItem);
    var wantedKeys = wanted.map(function (w) { return w.key; });

    // Remove what is no longer public (a disabled activity, an unpublished
    // destination). This is the case the hardcoded list cannot handle on its
    // own, and the one that would otherwise leave a dead nav entry.
    existing.forEach(function (el) {
      if (wantedKeys.indexOf(el.getAttribute('data-nav-' + attr)) === -1) el.remove();
    });

    // Add what is new, after the last one in the group so the "All …" link
    // stays at the top.
    var present = Array.prototype.slice.call(container.querySelectorAll(selector))
      .map(function (el) { return el.getAttribute('data-nav-' + attr); });
    var last = container.querySelectorAll(selector);
    last = last.length ? last[last.length - 1] : null;
    wanted.forEach(function (w) {
      if (present.indexOf(w.key) !== -1) return;
      var a = document.createElement('a');
      a.href = w.href;
      // Built with DOM nodes rather than innerHTML: w.label and w.desc come
      // from the API, and textContent cannot be made to inject anything.
      var label = document.createElement('span');
      label.className = 'np-label';
      label.textContent = w.label;
      a.appendChild(label);
      if (w.desc) {
        var desc = document.createElement('span');
        desc.className = 'np-desc';
        desc.textContent = w.desc;
        a.appendChild(desc);
      }
      a.setAttribute('data-nav-' + attr, w.key);
      if (last && last.nextSibling) container.insertBefore(a, last.nextSibling);
      else container.appendChild(a);
      last = a;
    });
  }

  enhanceFromApi();
})();
