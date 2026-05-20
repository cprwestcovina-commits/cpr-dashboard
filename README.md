# CPR Dashboard

Internal booking dashboard for CPR West Covina. Hosted on Vercel.

- `dashboard.html` — main SPA
- `api/make/[...path].js` — Vercel Edge proxy to Make.com API (CORS + auth gate)
- Env vars (set in Vercel): `MAKE_TOKEN`, `DASHBOARD_PASSWORD`

Push to `main` → auto-deploys to production via Vercel GitHub integration.
