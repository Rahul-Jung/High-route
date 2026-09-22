'use strict';
const { URL } = require('url');

/**
 * A deliberately tiny router — no Express, no dependencies. Supports
 * :params in paths (e.g. /api/tours/:slug) and attaches req.params /
 * req.query to the request object before calling the handler.
 */
class Router {
  constructor() {
    this.routes = []; // { method, segments, handler }
  }

  add(method, path, handler) {
    const segments = path.split('/').filter(Boolean);
    this.routes.push({ method: method.toUpperCase(), segments, handler });
  }
  get(path, handler) { this.add('GET', path, handler); }
  post(path, handler) { this.add('POST', path, handler); }
  patch(path, handler) { this.add('PATCH', path, handler); }
  delete(path, handler) { this.add('DELETE', path, handler); }

  match(method, pathname) {
    const reqSegments = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== reqSegments.length) continue;
      const params = {};
      let isMatch = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i];
        const reqSeg = decodeURIComponent(reqSegments[i]);
        if (routeSeg.startsWith(':')) params[routeSeg.slice(1)] = reqSeg;
        else if (routeSeg !== reqSeg) { isMatch = false; break; }
      }
      if (isMatch) return { handler: route.handler, params };
    }
    return null;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      });
      return res.end();
    }

    const found = this.match(req.method, url.pathname);
    if (!found) return null; // let the server fall through to static files / 404
    req.params = found.params;
    return found.handler(req, res);
  }
}

module.exports = { Router };
