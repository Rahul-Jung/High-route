'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Router } = require('./lib/router');
const { readJsonBody, sendJson, notFound, serverError } = require('./lib/util');
require('./db'); // ensures schema is applied before routes touch it
const { seed } = require('./seed');

const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Seed on first run so the API is immediately useful.
seed();

const router = new Router();
require('./routes/tours').register(router);
require('./routes/departures').register(router);
require('./routes/addons').register(router);
require('./routes/promo').register(router);
const bookingsRoute = require('./routes/bookings');
bookingsRoute.register(router);
const proposalsRoute = require('./routes/proposals');
proposalsRoute.register(router);
require('./routes/customRequests').register(router);
require('./routes/notifications').register(router);
require('./routes/reviews').register(router);
require('./routes/auth').register(router);
require('./routes/gps').register(router);
require('./routes/emergency').register(router);
require('./routes/guide').register(router);
require('./routes/guides').register(router);
require('./routes/destinations').register(router);
require('./routes/gallery').register(router);
require('./routes/newsletter').register(router);
require('./routes/admin').register(router);

router.get('/api/health', (req, res) => sendJson(res, 200, { ok: true, time: new Date().toISOString() }));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res); // path traversal guard
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res, 'Not found');
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (req.url.startsWith('/api/')) {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        try { req.body = await readJsonBody(req); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      const handled = await router.handle(req, res);
      if (handled === null) return notFound(res, 'No such API route: ' + req.method + ' ' + req.url);
      return;
    }
    return serveStatic(req, res);
  } catch (err) {
    return serverError(res, err);
  }
});

server.listen(PORT, () => {
  console.log(`High Route MTB backend running at http://localhost:${PORT}`);
  console.log(`Demo dashboards: /tracker.html  /admin.html  /guide.html`);
});

// Auto-cancels unpaid ("pending") bookings once their payment hold expires,
// releasing the seats — so this happens on its own, not only when someone
// happens to load a bookings list. See PAYMENT_HOLD_HOURS in routes/bookings.js.
const EXPIRY_SWEEP_MS = 5 * 60 * 1000;
setInterval(() => {
  const cancelled = bookingsRoute.expireOverdueBookings();
  if (cancelled > 0) console.log(`Auto-cancelled ${cancelled} unpaid booking(s) past their payment hold.`);
  const expiredProposals = proposalsRoute.expireOverdueProposals();
  if (expiredProposals > 0) console.log(`Expired ${expiredProposals} custom-tour proposal(s) past their expiry date.`);
}, EXPIRY_SWEEP_MS).unref();
