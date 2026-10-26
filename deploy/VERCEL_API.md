# Backend on Vercel (free, temporary data)

Live API: https://high-route-api.vercel.app (project `high-route-api`). Frontend: https://high-route-mtb.vercel.app.

**Data is not permanent.** The database lives in `/tmp` and resets to the bundled snapshot
whenever the function restarts after being idle. Bookings, enquiries and accounts made on the
live site are lost. For real customers use a host with a persistent disk (e.g. Railway paid plan).

## Redeploy
1. Build a staging folder `.vercel-api-stage/` (git-ignored): `api/index.js` (`module.exports = (req,res)=>require('../backend/server').emit('request',req,res)`),
   a copy of `backend/` (without `data/`), `frontend/routemap.js`, and `vercel.json`
   (rewrite `/(.*)` -> `/api/index`, `includeFiles: {backend/**,frontend/routemap.js}`), plus `package.json` with `"engines":{"node":"24.x"}`.
2. `node deploy/make-seed-snapshot.js` writes `backend/seed-snapshot.db` into the stage: your local catalogue
   with riders, bookings, sessions and admin accounts removed.
3. `cd .vercel-api-stage && vercel --prod`.

## Required env vars (Vercel project `high-route-api`, Production)
`ADMIN_EMAIL`, `ADMIN_PASSWORD` (without these the admin password is random on every restart),
`RESEND_API_KEY` (without it verification codes only appear in the function logs).
