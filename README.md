# Mock Storefront Price Tracker

Search products on the mock store, track a product+option, scrape price/stock
every 2 hours, chart history, inspect per-attempt logs, export CSV.

## Architecture

- `server/` — Express backend (Node 18+). **No headless browser**: the store is
  a client-rendered SPA whose price API is bot-gated; `store-client.js`
  replicates the store's own handshake (PoW + wasm + attestation) over plain
  HTTP — see the Phase 0 recon note at the top of that file. Faster (~0.3s vs
  8–15s browser boot) and fits Render's free-tier RAM (no Chromium).
- `frontend/` — React + Recharts dashboard (Vite), deployed to Vercel.
- Supabase (Postgres) — `products`, `tracked_products`, `price_history`, `scrape_log`.
- Scheduling — cron-job.org POSTs `/scrape/all` every 2 hours.

## Setup

```bash
# 1. Database: run schema.sql in Supabase's SQL editor (safe to re-run —
#    it includes the bonus frequency column plus an idempotent ALTER tail
#    for DBs created before the bonus).
# 2. Backend:
cd server
npm install
cp .env.example .env   # fill in values below
npm run dev
# 3. Frontend (new terminal):
cd frontend
npm install
cp .env.example .env   # VITE_API_BASE_URL=http://localhost:3001 for local, Render URL in prod
npm run dev
```

Verify the scraper against the live store (no DB needed):

```bash
cd server
npm run scrape:live        # 18 runs + forced-failure + search sanity check
npm run scrape:headed      # verbose single run for the recording deliverable
```

## Scraping schedule

- Every 2 hours, cron-job.org sends `POST /scrape/all` with header
  `X-Cron-Secret: <CRON_SECRET>`.
- Each tracked product gets up to 3 attempts with backoff 1s/3s/9s.
  `price_history` gets one row per run; `scrape_log` one row per attempt.
  Failures store `price: null, stock: null` — never a guessed value.
- Runs are paced ~2s apart: live testing showed the store 429s bursts of handshakes.
- Optional keep-warm: if Render cold starts cause missed windows, add a second
  cron-job.org job hitting `GET /health` every ~10–14 minutes.
- Hardening: `POST /scrape/all` has an overlap guard (concurrent run → 409),
  DB writes retried 3×, jittered pacing, per-product frequency gating
  (`frequency_minutes`, default 120 — run cron every 30 min only if you use
  custom frequencies), `skipped` count in the response.

## Bonus features (all implemented)

- **Alerts:** in-app price-drop/back-in-stock badges (list + detail) + optional
  SendGrid email (set `SENDGRID_API_KEY` + `ALERT_TO_EMAIL`; no-op otherwise).
- **Multi-product dashboard + extras:** tracked list with latest price/stock,
  product panel (brand/category/SKU/seller/MRP/rating).
- **Change detection:** `GET /structure-check` validates manifest/listings/
  detail/handshake shapes; dashboard shows a red banner when `ok:false`.
- **Configurable frequency:** `PATCH /tracked/:id { frequencyMinutes 15..10080 }`
  or the per-row dropdown; `/scrape/all` skips not-due items (see `skipped`).
- **Multi-option in one run:** `POST /track/bulk { productId, options[] }` +
  "Track all N" button; `/scrape/all` scrapes every tracked option each batch.
- **CI/CD:** `.github/workflows/ci.yml` (backend `node --check`, frontend build).

## Environment variables

| Variable | Where used | Purpose |
|---|---|---|
| `SUPABASE_URL` | backend | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | backend | Service-role key (backend only, never in frontend) |
| `TARGET_STORE_URL` | backend | `https://demo.inelabteamdev.com/` |
| `CRON_SECRET` | backend | Shared secret required on `/scrape/all` |
| `PORT` | backend | Server port (Render sets automatically) |
| `VITE_API_BASE_URL` | frontend | Deployed backend base URL |
| `SENDGRID_API_KEY` | backend | Optional: enables email alerts |
| `ALERT_TO_EMAIL` | backend | Optional: alert recipient |
| `ALERT_FROM_EMAIL` | backend | Optional: sender (default alerts@price-pulse.local) |

## Deployment

- **Render (backend):** Web Service, root directory `server/`,
  build `npm install`, start `npm start`. Set the 5 backend env vars above in
  Render's dashboard (never commit `.env`).
- **Vercel (frontend):** root directory `frontend/`, set `VITE_API_BASE_URL`
  to the Render backend URL. `vercel.json` handles SPA rewrites.
- **cron-job.org:** job 1 — `POST <backend>/scrape/all` + `X-Cron-Secret`
  header, every 2 hours. Job 2 (only if cold starts bite) — `GET <backend>/health`
  every ~12 minutes.

## Design note (submission)

See `DESIGN_NOTE.md`: Phase 0 decision (HTTP handshake over Playwright) and
why, retry/validation approach, and what the first implementation attempt got
wrong plus corrections. Bonus features: all six implemented (in-app + SendGrid
alerts, multi-product dashboard + info panel, `/structure-check` change
detection, per-product frequency, bulk multi-option tracking, CI via GitHub
Actions (`.github/workflows/ci.yml`)).
