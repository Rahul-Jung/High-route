/* ===========================================================================
   ROUTEMAP — a dependency-free slippy map for tour route pins.

   Why this exists rather than a library: this project has no build step, no
   framework and no third-party JS (see README). Leaflet/Mapbox would be the
   obvious reach, so this implements the small part of them that's actually
   needed — Web Mercator tile math, pan/zoom, and an SVG overlay — in about
   the space their loader script would take.

   It renders raster map tiles (real terrain and village names, so a pin can
   be placed somewhere recognisable) with an SVG trail and pins on top. Two
   modes:

     RouteMap.mount({ el, waypoints })                 — read-only, for riders
     RouteMap.mount({ el, waypoints, editable: true,
                      onPlace, onMove })               — admin pin editor

   Served from ONE place: the frontend loads frontend/routemap.js and the
   admin panel loads /routemap.js, which backend/server.js maps to this same
   file. There is deliberately no second copy to drift out of sync.

   Degrades honestly: if tile imagery can't load (offline, blocked, tile
   server down) the pins and trail still draw on a plain graticule and the
   map says so, rather than showing an empty white box.

   GPS DISCLAIMER (see README): pins are admin-entered planning positions,
   not surveyed GPX data. Distances shown between pins are STRAIGHT LINES
   between coordinates and are not riding distance — the per-day riding
   distance is the admin-entered figure in the day-by-day itinerary.
   =========================================================================== */
(function () {
  'use strict';

  var TILE_SIZE = 256;
  var MIN_ZOOM = 4;
  var MAX_ZOOM = 16;

  // Overridable so a deployment can point at its own tile cache or a
  // topographic style without editing this file. Defaults to OpenStreetMap's
  // standard tiles — attribution is rendered on the map, as their usage
  // policy requires.
  var TILE_URL = window.HIGHROUTE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var TILE_ATTRIB = window.HIGHROUTE_TILE_ATTRIB || '© OpenStreetMap contributors';

  // How the seven tour_waypoints.kind values present on the map. `r` is the
  // pin radius; `label` is what the tooltip calls it. These are fixed
  // colours rather than theme variables on purpose: a pin sits on map
  // imagery, not on the page background, so it needs to read against
  // terrain in both the light public site and the dark admin panel. Each
  // gets a white outline in CSS for the same reason.
  var KIND = {
    start:     { label: 'Start',     color: '#3D7D45', r: 8 },
    finish:    { label: 'Finish',    color: '#C1461E', r: 8 },
    overnight: { label: 'Overnight', color: '#B5892A', r: 6 },
    pass:      { label: 'Pass',      color: '#2C6E74', r: 6 },
    viewpoint: { label: 'Viewpoint', color: '#3E6E9E', r: 6 },
    hazard:    { label: 'Hazard',    color: '#C9761E', r: 6 },
    waypoint:  { label: 'Waypoint',  color: '#4A4335', r: 5 }
  };
  function kindOf(k) { return KIND[k] || KIND.waypoint; }

  /* The component ships its own styles and injects them once. The two pages
     that use it live on different origins with opposite themes (the cream
     public site and the dark admin panel), so a shared stylesheet would have
     to be duplicated in both and kept in sync by hand. The map's chrome is
     deliberately its own dark context in both — the same choice the tour
     gallery's lightbox makes — because it sits on map imagery rather than on
     the page. */
  var CSS = [
    '.rm-root{position:relative;overflow:hidden;background:#DCD6C8;cursor:grab;',
    '  border-radius:12px;touch-action:none;user-select:none;-webkit-user-select:none}',
    '.rm-root.rm-dragging{cursor:grabbing}',
    '.rm-tiles{position:absolute;inset:0}',
    '.rm-tile{position:absolute;width:256px;height:256px;pointer-events:none;',
    '  -webkit-user-drag:none}',
    '.rm-overlay{position:absolute;inset:0;overflow:visible}',
    /* The plain graticule shown when imagery can't load, so pins still have
       a frame of reference instead of floating on nothing. */
    '.rm-root.rm-no-imagery{background:#DCD6C8;background-image:',
    '  linear-gradient(rgba(36,31,23,0.11) 1px,transparent 1px),',
    '  linear-gradient(90deg,rgba(36,31,23,0.11) 1px,transparent 1px);',
    '  background-size:40px 40px}',
    '.rm-trail-casing{fill:none;stroke:#FFFFFF;stroke-width:6;stroke-opacity:0.85;',
    '  stroke-linejoin:round;stroke-linecap:round}',
    '.rm-trail{fill:none;stroke:#C1461E;stroke-width:2.5;stroke-dasharray:7 5;',
    '  stroke-linejoin:round;stroke-linecap:round}',
    /* A leg snapped to real roads: solid, because we know where it goes. */
    '.rm-road{fill:none;stroke:#C1461E;stroke-width:3.5;stroke-linejoin:round;',
    '  stroke-linecap:round}',
    /* The short hop from a pin to where the mapped road actually starts. */
    '.rm-stub{stroke:#C1461E;stroke-width:1.5;stroke-dasharray:3 3;stroke-opacity:0.6}',
    '.rm-leader{stroke:#24201A;stroke-width:1;stroke-dasharray:2 2;stroke-opacity:0.5}',
    '.rm-pin{cursor:pointer;outline:none}',
    '.rm-pin-draggable{cursor:move}',
    '.rm-halo{fill:#FFFFFF;fill-opacity:0.01}',
    '.rm-dot{stroke:#FFFFFF;stroke-width:2.5;transition:r 90ms ease}',
    '.rm-pin:hover .rm-dot,.rm-pin:focus .rm-dot{stroke-width:3.5}',
    '.rm-pin:focus .rm-halo{fill-opacity:0.3;stroke:#24201A;stroke-width:1.5}',
    '.rm-pin-dragging .rm-dot{stroke:#C1461E;stroke-width:4}',
    '.rm-num{font:600 10px/1 ui-monospace,monospace;fill:#FFFFFF;text-anchor:middle;',
    '  pointer-events:none;paint-order:stroke;stroke:rgba(0,0,0,0.35);stroke-width:2px}',
    /* Tooltip: the only place a pin's name and onward distance appear. */
    '.rm-tip{position:absolute;z-index:5;max-width:250px;pointer-events:none;',
    '  background:rgba(21,20,15,0.95);color:#F2EEE2;border:1px solid rgba(242,238,226,0.16);',
    '  border-radius:10px;padding:10px 12px;font:13px/1.45 system-ui,sans-serif;',
    '  box-shadow:0 14px 34px -12px rgba(0,0,0,0.7)}',
    '.rm-tip[hidden]{display:none}',
    '.rm-tip-head{display:flex;align-items:baseline;gap:7px;margin-bottom:3px;font-size:14px}',
    '.rm-tip-seq{flex:none;min-width:18px;height:18px;border-radius:50%;background:#C1461E;',
    '  color:#fff;font:600 10px/18px ui-monospace,monospace;text-align:center}',
    '.rm-tip-meta{font:11px/1.4 ui-monospace,monospace;color:#C9C4B2;',
    '  text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px}',
    '.rm-tip-kind{font-weight:600}',
    '.rm-tip-leg{border-top:1px solid rgba(242,238,226,0.14);padding-top:6px;margin-top:2px}',
    '.rm-tip-end{color:#C9C4B2;font-style:italic}',
    '.rm-tip-sub{color:#A79F8C;font-size:11px}',
    '.rm-tip-notes{margin-top:6px;color:#C9C4B2;font-size:12px}',
    '.rm-tip-note{margin-top:6px;color:#9A9382;font-size:11px;font-style:italic}',
    '.rm-tip-coord{margin-top:6px;font:10px/1 ui-monospace,monospace;color:#8A8372}',
    /* Chrome */
    '.rm-zoom{position:absolute;top:10px;right:10px;z-index:4;display:flex;',
    '  flex-direction:column;gap:4px}',
    '.rm-zoom button{width:30px;height:30px;padding:0;border:1px solid rgba(36,31,23,0.2);',
    '  border-radius:7px;background:rgba(255,255,255,0.95);color:#24201A;font-size:15px;',
    '  line-height:1;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.18)}',
    '.rm-zoom button:hover{background:#fff;border-color:rgba(36,31,23,0.4)}',
    '.rm-attrib{position:absolute;bottom:0;right:0;z-index:4;',
    '  background:rgba(255,255,255,0.86);color:#3A342A;',
    '  font:10px/1.5 system-ui,sans-serif;padding:2px 7px;border-radius:7px 0 0 0}',
    '.rm-hint{position:absolute;bottom:8px;left:8px;z-index:4;',
    '  background:rgba(21,20,15,0.86);color:#F2EEE2;font:11px/1.4 ui-monospace,monospace;',
    '  padding:5px 9px;border-radius:7px;pointer-events:none}',
    '@media (max-width:600px){.rm-tip{max-width:190px;font-size:12px}}'
  ].join('');

  function injectStyles() {
    if (document.getElementById('rm-styles')) return;
    var s = document.createElement('style');
    s.id = 'rm-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- Web Mercator ----------------
     World pixel space at a given zoom: 256 * 2^z pixels square, x east from
     -180deg, y south from +85.05deg. Everything else is offsets from the
     centre of the viewport. */
  function lngToX(lng, z) {
    return ((lng + 180) / 360) * TILE_SIZE * Math.pow(2, z);
  }
  function latToY(lat, z) {
    var s = Math.sin((lat * Math.PI) / 180);
    // Clamped: the projection is undefined at the poles, and an out-of-range
    // latitude would otherwise produce Infinity and blank the whole map.
    s = Math.max(-0.9999, Math.min(0.9999, s));
    var y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return y * TILE_SIZE * Math.pow(2, z);
  }
  function xToLng(x, z) {
    return (x / (TILE_SIZE * Math.pow(2, z))) * 360 - 180;
  }
  function yToLat(y, z) {
    var n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * Math.pow(2, z));
    return (180 / Math.PI) * Math.atan(Math.sinh(n));
  }

  function usable(w) {
    return w && w.lat !== null && w.lat !== undefined && w.lat !== '' &&
           w.lng !== null && w.lng !== undefined && w.lng !== '' &&
           isFinite(Number(w.lat)) && isFinite(Number(w.lng));
  }

  function mount(opts) {
    var el = typeof opts.el === 'string' ? document.getElementById(opts.el) : opts.el;
    if (!el) return null;
    injectStyles();

    var editable = !!opts.editable;
    var points = (opts.waypoints || []).filter(usable).map(function (w) {
      return {
        id: w.id, seq: w.seq, name: w.name, kind: w.kind,
        lat: Number(w.lat), lng: Number(w.lng),
        elevation_m: w.elevation_m, day_number: w.day_number, notes: w.notes,
        next_name: w.next_name,
        straight_km_to_next: w.straight_km_to_next,
        // The snapped road/trail leg from this pin to the next one
        // (backend/lib/routing.js). null when it has never been
        // computed; status says whether it actually routed.
        route: w.route || null
      };
    });

    /* ---- DOM scaffold. Built here rather than asked of the host page so
       the markup can't drift between the two pages that use this. ---- */
    el.classList.add('rm-root');
    el.innerHTML =
      '<div class="rm-tiles"></div>' +
      '<svg class="rm-overlay" xmlns="http://www.w3.org/2000/svg"></svg>' +
      '<div class="rm-tip" hidden></div>' +
      '<div class="rm-zoom">' +
        '<button type="button" class="rm-in" title="Zoom in" aria-label="Zoom in">+</button>' +
        '<button type="button" class="rm-out" title="Zoom out" aria-label="Zoom out">−</button>' +
        '<button type="button" class="rm-fit" title="Fit the whole route" aria-label="Fit route">⌗</button>' +
      '</div>' +
      '<div class="rm-attrib"></div>' +
      (editable ? '<div class="rm-hint">Click the map to drop a pin · drag a pin to move it</div>' : '');

    var tileLayer = el.querySelector('.rm-tiles');
    var svg = el.querySelector('.rm-overlay');
    var tip = el.querySelector('.rm-tip');
    var attrib = el.querySelector('.rm-attrib');

    var view = { lat: 28.3949, lng: 84.124, zoom: 7 }; // Nepal, as a fallback centre
    var tileFailures = 0, tileAttempts = 0, imageryBroken = false;

    function size() {
      return { w: el.clientWidth || 600, h: el.clientHeight || 400 };
    }

    /** Fits the viewport to every pin. With a single pin there are no bounds
     *  to fit, so it just centres at a sensible close-up zoom. */
    function fit() {
      if (!points.length) { draw(); return; }
      if (points.length === 1) {
        view.lat = points[0].lat; view.lng = points[0].lng; view.zoom = 12;
        draw(); return;
      }
      var s = size();
      var latMin = Math.min.apply(null, points.map(function (p) { return p.lat; }));
      var latMax = Math.max.apply(null, points.map(function (p) { return p.lat; }));
      var lngMin = Math.min.apply(null, points.map(function (p) { return p.lng; }));
      var lngMax = Math.max.apply(null, points.map(function (p) { return p.lng; }));
      var best = MIN_ZOOM;
      for (var z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
        var w = Math.abs(lngToX(lngMax, z) - lngToX(lngMin, z));
        var h = Math.abs(latToY(latMin, z) - latToY(latMax, z));
        if (w < s.w - 80 && h < s.h - 80) { best = z; break; }
      }
      view.zoom = best;
      view.lat = (latMin + latMax) / 2;
      view.lng = (lngMin + lngMax) / 2;
      draw();
    }

    function project(lat, lng) {
      var s = size();
      var cx = lngToX(view.lng, view.zoom), cy = latToY(view.lat, view.zoom);
      return { x: lngToX(lng, view.zoom) - cx + s.w / 2, y: latToY(lat, view.zoom) - cy + s.h / 2 };
    }
    function unproject(px, py) {
      var s = size();
      var cx = lngToX(view.lng, view.zoom), cy = latToY(view.lat, view.zoom);
      return { lat: yToLat(cy - s.h / 2 + py, view.zoom), lng: xToLng(cx - s.w / 2 + px, view.zoom) };
    }

    /* ---- Tile layer ---- */
    function drawTiles() {
      var s = size();
      var n = Math.pow(2, view.zoom);
      var cx = lngToX(view.lng, view.zoom), cy = latToY(view.lat, view.zoom);
      var left = cx - s.w / 2, top = cy - s.h / 2;
      var x0 = Math.floor(left / TILE_SIZE), x1 = Math.floor((left + s.w) / TILE_SIZE);
      var y0 = Math.floor(top / TILE_SIZE), y1 = Math.floor((top + s.h) / TILE_SIZE);
      // Built as real elements rather than an innerHTML string so the error
      // handler can be attached BEFORE src is set (an inline onerror= would
      // also be the first thing a Content-Security-Policy breaks, and a
      // cached failure can fire before a later-attached listener exists).
      var frag = document.createDocumentFragment();
      for (var ty = y0; ty <= y1; ty++) {
        // Vertically out of the world: no tile exists, leave it blank rather
        // than requesting a 404 for every pan past the pole.
        if (ty < 0 || ty >= n) continue;
        for (var tx = x0; tx <= x1; tx++) {
          var wrapped = ((tx % n) + n) % n; // horizontal wraparound at the date line
          var img = document.createElement('img');
          img.className = 'rm-tile';
          img.alt = '';
          img.draggable = false;
          img.style.left = (tx * TILE_SIZE - left) + 'px';
          img.style.top = (ty * TILE_SIZE - top) + 'px';
          img.addEventListener('error', onTileError);
          img.src = TILE_URL.replace('{z}', view.zoom).replace('{x}', wrapped).replace('{y}', ty);
          tileAttempts++;
          frag.appendChild(img);
        }
      }
      tileLayer.innerHTML = '';
      tileLayer.appendChild(frag);
    }

    /** If essentially every tile fails (offline, blocked, tile server down),
     *  say so rather than leaving pins floating on a blank rectangle. */
    function onTileError() {
      this.style.visibility = 'hidden';
      tileFailures++;
      if (!imageryBroken && tileAttempts >= 4 && tileFailures >= tileAttempts * 0.75) {
        imageryBroken = true;
        el.classList.add('rm-no-imagery');
        renderAttrib();
      }
    }

    function renderAttrib() {
      attrib.innerHTML = imageryBroken
        ? 'Map imagery unavailable — pins shown on a plain grid.'
        : esc(TILE_ATTRIB);
    }

    /* ---- Pins and trail ----
       Several pins can share one position for real reasons (a rest day spent
       at the previous night's stop is the obvious one), which would stack
       them into a single unhoverable dot. Coincident pins are fanned out
       around their shared point so each stays reachable, with the true
       position still marked. */
    function layout() {
      var placed = points.map(function (p) {
        var q = project(p.lat, p.lng);
        return { p: p, x: q.x, y: q.y, trueX: q.x, trueY: q.y, fanned: false };
      });
      var groups = {};
      placed.forEach(function (m) {
        var key = Math.round(m.trueX / 12) + ':' + Math.round(m.trueY / 12);
        (groups[key] = groups[key] || []).push(m);
      });
      Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        if (g.length < 2) return;
        var radius = 13 + g.length;
        g.forEach(function (m, i) {
          var a = (i / g.length) * Math.PI * 2 - Math.PI / 2;
          m.x = m.trueX + Math.cos(a) * radius;
          m.y = m.trueY + Math.sin(a) * radius;
          m.fanned = true;
        });
      });
      return placed;
    }

    var markers = [];

    function draw() {
      drawTiles();
      renderAttrib();
      var s = size();
      svg.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);
      svg.setAttribute('width', s.w);
      svg.setAttribute('height', s.h);

      markers = layout();

      // The drawn route, leg by leg. A leg that was snapped to real roads
      // and trails (backend/lib/routing.js) is drawn as its actual shape in
      // a solid line; a leg with no road route falls back to a dashed
      // straight line between the two pins, which reads as "we don't have
      // the trail for this stretch" rather than pretending it's a route.
      //
      // Geometry follows true pin positions, not the fanned-out display
      // ones, so the line is the route as entered rather than as
      // decluttered.
      var trail = '';
      for (var li = 0; li < markers.length - 1; li++) {
        var mA = markers[li], mB = markers[li + 1];
        var leg = mA.p.route;
        var hasShape = leg && leg.status === 'routed' && leg.geometry && leg.geometry.length > 1;

        if (hasShape) {
          var proj = leg.geometry.map(function (c) {
            var q = project(c[0], c[1]);
            return q.x.toFixed(1) + ',' + q.y.toFixed(1);
          }).join(' ');
          trail += '<polyline class="rm-trail-casing" points="' + proj + '"/>' +
                   '<polyline class="rm-road" points="' + proj + '"/>';

          // The routing engine snaps each end to the nearest mapped way, so
          // where a pin sits off-road the line genuinely starts somewhere
          // else. A faint stub joins the pin to it instead of leaving a
          // mystery gap — the pin is where we say the stop is, the road is
          // where the road is, and both are true.
          var g0 = project(leg.geometry[0][0], leg.geometry[0][1]);
          var gN = project(leg.geometry[leg.geometry.length - 1][0], leg.geometry[leg.geometry.length - 1][1]);
          if (Math.hypot(g0.x - mA.trueX, g0.y - mA.trueY) > 6) {
            trail += '<line class="rm-stub" x1="' + mA.trueX.toFixed(1) + '" y1="' + mA.trueY.toFixed(1) +
                     '" x2="' + g0.x.toFixed(1) + '" y2="' + g0.y.toFixed(1) + '"/>';
          }
          if (Math.hypot(gN.x - mB.trueX, gN.y - mB.trueY) > 6) {
            trail += '<line class="rm-stub" x1="' + gN.x.toFixed(1) + '" y1="' + gN.y.toFixed(1) +
                     '" x2="' + mB.trueX.toFixed(1) + '" y2="' + mB.trueY.toFixed(1) + '"/>';
          }
        } else {
          var straight = mA.trueX.toFixed(1) + ',' + mA.trueY.toFixed(1) + ' ' +
                         mB.trueX.toFixed(1) + ',' + mB.trueY.toFixed(1);
          trail += '<polyline class="rm-trail-casing" points="' + straight + '"/>' +
                   '<polyline class="rm-trail" points="' + straight + '"/>';
        }
      }
      var line = trail;

      var leaders = markers.filter(function (m) { return m.fanned; }).map(function (m) {
        return '<line class="rm-leader" x1="' + m.trueX.toFixed(1) + '" y1="' + m.trueY.toFixed(1) +
               '" x2="' + m.x.toFixed(1) + '" y2="' + m.y.toFixed(1) + '"/>';
      }).join('');

      var pins = markers.map(function (m, i) {
        var k = kindOf(m.p.kind);
        return '<g class="rm-pin" data-i="' + i + '" tabindex="0" role="button" ' +
               'aria-label="' + esc((m.p.seq ? 'Pin ' + m.p.seq + ': ' : '') + m.p.name) + '">' +
               '<circle class="rm-halo" cx="' + m.x.toFixed(1) + '" cy="' + m.y.toFixed(1) + '" r="' + (k.r + 7) + '"/>' +
               '<circle class="rm-dot" cx="' + m.x.toFixed(1) + '" cy="' + m.y.toFixed(1) + '" r="' + k.r + '" ' +
               'style="fill:' + k.color + '"/>' +
               (m.p.seq ? '<text class="rm-num" x="' + m.x.toFixed(1) + '" y="' + (m.y + 3.5).toFixed(1) + '">' + esc(m.p.seq) + '</text>' : '') +
               '</g>';
      }).join('');

      svg.innerHTML = line + leaders + pins;
      bindPins();
    }

    /* ---- Tooltip ---- */
    function tipHtml(p, m) {
      var k = kindOf(p.kind);
      var rows = [];
      rows.push('<div class="rm-tip-head">' +
        (p.seq ? '<span class="rm-tip-seq">' + esc(p.seq) + '</span>' : '') +
        '<strong>' + esc(p.name) + '</strong></div>');
      var meta = ['<span class="rm-tip-kind" style="color:' + k.color + '">' + esc(k.label) + '</span>'];
      if (p.day_number) meta.push('Day ' + esc(p.day_number));
      if (p.elevation_m !== null && p.elevation_m !== undefined && p.elevation_m !== '') {
        meta.push(esc(Number(p.elevation_m).toLocaleString()) + ' m');
      }
      rows.push('<div class="rm-tip-meta">' + meta.join(' · ') + '</div>');

      // The distance line. Which number this shows depends on what we
      // actually know, and it always says which it is:
      //
      //   routed            -> distance along the real road/trail, the
      //                        number a rider cares about
      //   no route / error  -> the straight line, explicitly labelled as
      //                        such, because that is all we have
      //
      // These are never silently interchanged. A straight line across a
      // Himalayan valley can be a third of the real riding distance, so
      // presenting one as the other would materially mislead someone
      // planning a day's ride.
      var leg = p.route;
      var routed = leg && leg.status === 'routed' && leg.km !== null && leg.km !== undefined;

      if (!p.next_name) {
        rows.push('<div class="rm-tip-leg rm-tip-end">Last pin on this route</div>');
      } else if (routed && leg.km === 0) {
        rows.push('<div class="rm-tip-leg">Same position as <strong>' + esc(p.next_name) + '</strong>' +
                  ' — the route stays put here</div>');
      } else if (routed) {
        var hrs = '';
        if (leg.duration_s) {
          var h = leg.duration_s / 3600;
          hrs = ' <span class="rm-tip-sub">· about ' +
                (h < 1 ? Math.round(h * 60) + ' min' : (Math.round(h * 10) / 10) + ' h') +
                ' riding</span>';
        }
        rows.push('<div class="rm-tip-leg"><strong>' + esc(leg.km) + ' km</strong> by trail to ' +
                  '<strong>' + esc(p.next_name) + '</strong>' + hrs + '</div>');
      } else if (p.straight_km_to_next === 0) {
        rows.push('<div class="rm-tip-leg">Same position as <strong>' + esc(p.next_name) + '</strong>' +
                  ' — the route stays put here</div>');
      } else if (p.straight_km_to_next !== null && p.straight_km_to_next !== undefined) {
        rows.push('<div class="rm-tip-leg"><strong>' + esc(p.straight_km_to_next) + ' km</strong> straight line to ' +
                  '<strong>' + esc(p.next_name) + '</strong>' +
                  '<span class="rm-tip-sub"> · no mapped trail for this stretch, so the real ride is longer</span></div>');
      } else {
        rows.push('<div class="rm-tip-leg rm-tip-end">Next: <strong>' + esc(p.next_name) + '</strong></div>');
      }
      if (p.notes) rows.push('<div class="rm-tip-notes">' + esc(p.notes) + '</div>');
      rows.push('<div class="rm-tip-coord">' + esc(p.lat.toFixed(4)) + ', ' + esc(p.lng.toFixed(4)) + '</div>');
      if (m && m.fanned) {
        rows.push('<div class="rm-tip-note">Nudged aside on the map so overlapping pins stay clickable.</div>');
      }
      return rows.join('');
    }

    function showTip(i) {
      var m = markers[i];
      if (!m) return;
      tip.innerHTML = tipHtml(m.p, m);
      tip.hidden = false;
      var s = size();
      // Flip to whichever side has room so the tooltip never hangs off the
      // map, and never covers the pin it describes.
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var x = m.x + 16, y = m.y - th / 2;
      if (x + tw > s.w - 6) x = m.x - tw - 16;
      if (x < 6) x = 6;
      if (y < 6) y = 6;
      if (y + th > s.h - 6) y = s.h - th - 6;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }
    function hideTip() { tip.hidden = true; }

    function bindPins() {
      Array.prototype.forEach.call(svg.querySelectorAll('.rm-pin'), function (g) {
        var i = Number(g.getAttribute('data-i'));
        g.addEventListener('mouseenter', function () { showTip(i); });
        g.addEventListener('mouseleave', hideTip);
        // Keyboard parity: the hover tooltip is the only place a pin's name
        // and distance appear, so it has to be reachable without a mouse.
        g.addEventListener('focus', function () { showTip(i); });
        g.addEventListener('blur', hideTip);
        if (editable) {
          g.addEventListener('pointerdown', function (ev) { startPinDrag(ev, i, g); });
          g.classList.add('rm-pin-draggable');
        }
      });
    }

    /* ---- Pan, zoom, click-to-place ---- */
    var drag = null;

    el.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest('.rm-zoom')) return;
      if (ev.target.closest('.rm-pin')) return; // handled by startPinDrag
      drag = { x: ev.clientX, y: ev.clientY, lat: view.lat, lng: view.lng, moved: 0, id: ev.pointerId };
      el.setPointerCapture(ev.pointerId);
      el.classList.add('rm-dragging');
    });

    el.addEventListener('pointermove', function (ev) {
      if (pinDrag) return movePinDrag(ev);
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      var cx = lngToX(drag.lng, view.zoom) - dx;
      var cy = latToY(drag.lat, view.zoom) - dy;
      view.lng = xToLng(cx, view.zoom);
      view.lat = yToLat(cy, view.zoom);
      hideTip();
      draw();
    });

    el.addEventListener('pointerup', function (ev) {
      if (pinDrag) return endPinDrag(ev);
      if (!drag) return;
      var wasClick = drag.moved < 5;
      drag = null;
      el.classList.remove('rm-dragging');
      try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
      // A pan that happens to end where it started is a click; a real drag
      // isn't. 5px of slop keeps a shaky hand from dropping a stray pin.
      if (wasClick && editable && typeof opts.onPlace === 'function') {
        // A double-click is two pointerups, which would otherwise drop two
        // pins on top of each other — and the second one is never what the
        // admin meant. Ignore a second placement in the same spot within
        // 350ms.
        var now = Date.now();
        if (lastPlace && now - lastPlace.t < 350 &&
            Math.abs(ev.clientX - lastPlace.x) < 12 && Math.abs(ev.clientY - lastPlace.y) < 12) {
          return;
        }
        lastPlace = { t: now, x: ev.clientX, y: ev.clientY };
        var r = el.getBoundingClientRect();
        var ll = unproject(ev.clientX - r.left, ev.clientY - r.top);
        opts.onPlace(Number(ll.lat.toFixed(5)), Number(ll.lng.toFixed(5)));
      }
    });

    var lastPlace = null;

    el.addEventListener('pointercancel', function () {
      drag = null; pinDrag = null; el.classList.remove('rm-dragging');
    });

    // Plain wheel is deliberately left alone. The tour page is a long scroll
    // and a map that swallows the wheel traps the reader halfway down it.
    // Ctrl/Cmd+wheel zooms (which is also what a trackpad pinch sends), and
    // the +/- buttons and double-click are always there.
    el.addEventListener('wheel', function (ev) {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1 : -1, ev.clientX, ev.clientY);
    }, { passive: false });

    // Double-click zooms in — but not in edit mode, where a click already
    // means "place a pin" and zooming would fight it.
    el.addEventListener('dblclick', function (ev) {
      if (editable) return;
      if (ev.target.closest('.rm-zoom')) return;
      zoomBy(1, ev.clientX, ev.clientY);
    });

    function zoomBy(delta, clientX, clientY) {
      var next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom + delta));
      if (next === view.zoom) return;
      // Zoom toward the cursor when there is one, so the thing being looked
      // at stays put instead of sliding away from under the pointer.
      if (clientX !== undefined) {
        var r = el.getBoundingClientRect();
        var before = unproject(clientX - r.left, clientY - r.top);
        view.zoom = next;
        var after = unproject(clientX - r.left, clientY - r.top);
        view.lat += before.lat - after.lat;
        view.lng += before.lng - after.lng;
      } else {
        view.zoom = next;
      }
      hideTip();
      draw();
    }

    el.querySelector('.rm-in').addEventListener('click', function () { zoomBy(1); });
    el.querySelector('.rm-out').addEventListener('click', function () { zoomBy(-1); });
    el.querySelector('.rm-fit').addEventListener('click', function () { fit(); });

    /* ---- Dragging an existing pin (edit mode) ---- */
    var pinDrag = null;
    function startPinDrag(ev, i, g) {
      if (!editable) return;
      ev.stopPropagation();
      pinDrag = { i: i, g: g, id: ev.pointerId, moved: 0, x: ev.clientX, y: ev.clientY };
      el.setPointerCapture(ev.pointerId);
      g.classList.add('rm-pin-dragging');
      hideTip();
    }
    function movePinDrag(ev) {
      pinDrag.moved = Math.max(pinDrag.moved, Math.abs(ev.clientX - pinDrag.x) + Math.abs(ev.clientY - pinDrag.y));
      var r = el.getBoundingClientRect();
      var ll = unproject(ev.clientX - r.left, ev.clientY - r.top);
      var m = markers[pinDrag.i];
      if (!m) return;
      m.p.lat = ll.lat; m.p.lng = ll.lng;
      draw();
    }
    function endPinDrag(ev) {
      var pd = pinDrag;
      pinDrag = null;
      try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
      if (pd.g) pd.g.classList.remove('rm-pin-dragging');
      var m = markers[pd.i];
      if (!m) return;
      // Below the slop threshold this was a click on the pin, not a move —
      // don't write a no-op position change back to the database.
      if (pd.moved < 5) { showTip(pd.i); return; }
      if (typeof opts.onMove === 'function') {
        opts.onMove(m.p.id, Number(m.p.lat.toFixed(5)), Number(m.p.lng.toFixed(5)));
      }
    }

    /* ---- Keep the map correct when its box changes size ---- */
    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      var last = 0;
      ro = new ResizeObserver(function () {
        // Coalesced: a CSS transition can fire this dozens of times a second,
        // and each draw rebuilds every tile img.
        var now = Date.now();
        if (now - last < 80) return;
        last = now;
        draw();
      });
      ro.observe(el);
    } else {
      window.addEventListener('resize', draw);
    }

    fit();

    return {
      /** Replace the pins and refit — used by the admin editor after every
       *  add/move/delete so the map always reflects what's in the database
       *  rather than an optimistic local guess. */
      setWaypoints: function (list, keepView) {
        points = (list || []).filter(usable).map(function (w) {
          return {
            id: w.id, seq: w.seq, name: w.name, kind: w.kind,
            lat: Number(w.lat), lng: Number(w.lng),
            elevation_m: w.elevation_m, day_number: w.day_number, notes: w.notes,
            next_name: w.next_name,
        straight_km_to_next: w.straight_km_to_next,
        // The snapped road/trail leg from this pin to the next one
        // (backend/lib/routing.js). null when it has never been
        // computed; status says whether it actually routed.
        route: w.route || null
          };
        });
        hideTip();
        if (keepView) draw(); else fit();
      },
      fit: fit,
      focus: function (id) {
        var p = points.filter(function (q) { return q.id === id; })[0];
        if (!p) return;
        view.lat = p.lat; view.lng = p.lng;
        if (view.zoom < 11) view.zoom = 13;
        draw();
        var idx = -1;
        markers.forEach(function (m, i) { if (m.p.id === id) idx = i; });
        if (idx >= 0) showTip(idx);
      },
      destroy: function () {
        if (ro) ro.disconnect(); else window.removeEventListener('resize', draw);
        el.innerHTML = '';
        el.classList.remove('rm-root');
      }
    };
  }

  window.RouteMap = { mount: mount, KIND: KIND, TILE_ATTRIB: TILE_ATTRIB };
})();
