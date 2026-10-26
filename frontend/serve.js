'use strict';
/* ===========================================================================
   Static dev server for the frontend.
                                node serve.js          -> http://localhost:8080
                                node serve.js 5500     -> a different port

   `python -m http.server` works too and is still fine, but it sends only
   Last-Modified and no Cache-Control. With no build step and no hashed
   filenames, a browser then applies heuristic caching to main.js, style.css
   and the pages themselves — so you edit a file, reload, and get served the
   previous version with no indication anything is stale. That is a genuinely
   confusing way to lose twenty minutes.

   This serves the same files with `Cache-Control: no-store`, so a plain
   reload always shows what is on disk. Zero dependencies, like the rest of
   the project; it needs nothing but the Node that already runs the backend.
   =========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let reqPath;
  try {
    reqPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  } catch {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
  }
  if (reqPath === '/' || reqPath.endsWith('/')) reqPath += 'index.html';

  // Resolve first, then check the result is still inside ROOT — the same
  // containment check the backend's serveStatic uses. Checking the raw path
  // for ".." instead would miss encoded and symlinked variants.
  const filePath = path.resolve(ROOT, '.' + reqPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, 'Not found: ' + reqPath, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) return send(res, 500, 'Could not read file', { 'Content-Type': 'text/plain' });
      send(res, 200, data, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('High Route MTB frontend on http://127.0.0.1:' + PORT);
  console.log('Serving ' + ROOT);
  console.log('Cache-Control: no-store — a plain reload always shows the current files.');
});
