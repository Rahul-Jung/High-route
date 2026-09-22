// Points the deployed frontend (Vercel) at the live backend (Railway).
// Local development is unaffected — main.js falls back to localhost:4000
// when this isn't loaded, or when this file is deleted/overridden.
window.HIGHROUTE_API_BASE = 'https://high-route-backend-production.up.railway.app';
