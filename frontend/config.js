// Which backend the frontend talks to.
//
// On a real domain (Vercel) that's the live Railway backend. When the page is
// being served from localhost it's the backend running on your own machine —
// otherwise `python -m http.server 8080` in this folder would serve a local
// site wired to the PRODUCTION API, so nothing you changed locally would show
// up and any booking you made while testing would land in the live database.
//
// This used to be a single hardcoded Railway URL, with a comment claiming
// "local development is unaffected" — which was only true if you remembered
// to delete this file first.
window.HIGHROUTE_API_BASE =
  ['localhost', '127.0.0.1', '[::1]', '::1', ''].includes(location.hostname)
    ? 'http://localhost:4000'
    : 'https://high-route-backend-production.up.railway.app';
