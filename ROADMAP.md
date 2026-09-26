# Roadmap — Mock Storefront Product Search & Scheduled Price Tracker
## Full Technical Specification (self-contained — agent should not need outside input to start building)

**Deadline:** Sunday, Sept 27, 2026 — 1:00 PM IST
**Target store:** https://demo.inelabteamdev.com/
**Grading priority:** scraper reliability > correctness under difficulty > honest logging > judgment/deployment > bonus features.

This document is written so an autonomous coding agent can execute it end to end, including the initial store recon, without a human having pre-investigated the site. Every phase includes the concrete technical contract (schema, endpoints, request/response shapes, logic) needed to implement it — not just a task description.

---

## Phase 0 — Recon (agent performs this itself, first)

**Task for the agent:** before writing the scraper, programmatically determine how the store serves data. Do NOT assume Playwright is required — check first.

1. Fetch `https://demo.inelabteamdev.com/` with a plain HTTP client and inspect the raw HTML response.
   - If price/stock/product data appears directly in the HTML → plain HTTP + HTML parsing (Cheerio/BeautifulSoup) is viable.
   - If the HTML is a near-empty shell (a `<div id="root">` / SPA mount point with no product data) → the store is client-rendered; check for an underlying API next.
2. Check common API path patterns before assuming you need a browser:
   - Try `GET /api/products`, `/api/products?q=<term>`, `/api/search?q=<term>`, `/products.json`, or inspect any `<script>` tags in the HTML for embedded JSON (`__NEXT_DATA__`, `window.__INITIAL_STATE__`, etc.) — many SPAs ship initial data this way even if later interaction is client-rendered.
   - If a clean JSON API responds with product data, prefer hitting it directly — this is the most reliable path and satisfies the assignment's "prefer lightweight fetching" guidance.
3. If no API surfaces and the HTML genuinely has no product data, fall back to headless browsing (Playwright preferred over Puppeteer for its built-in auto-waiting):
   - Launch, navigate to the store, search for a term, open a product page, and log the resulting DOM to identify real selectors for: product name, product ID (from the URL), option selector (size/kit/pack), price, stock.
   - Confirm whether price/stock render immediately on page load or after a delay (test by taking a DOM snapshot immediately vs. after 2–3 seconds) — this determines whether a `waitForSelector`/`waitForFunction` strategy is needed.
4. **Build the scraper defensively for both cases** rather than hard-committing to one path discovered once: wrap store access behind a single `fetchProductData(productId, optionId)` function whose *internal* implementation can be swapped (HTTP-first, with a documented fallback point to headless if HTTP stops returning data). This protects against the store's structure or rendering behavior differing between when the agent explores it and when it runs unattended later.
5. Record whatever is discovered (API shape, selectors, product ID format visible in the URL) as inline comments/constants in the scraper module — this becomes the factual basis for the design note later, so capture it as you go rather than reconstructing it afterward.

**Output of this phase:** a `scraper/store-client.js` (or `.py`) module with the access method decided, documented with comments, and a small manual test script that logs one product's raw scraped output to the console.

---

## Phase 1 — Infrastructure

### Database schema (Supabase / Postgres) — exact DDL

```sql
create table products (
  id text primary key,             -- store's product ID as shown in the product page URL
  name text not null,
  raw_meta jsonb,                  -- optional: description, image url, other option prices, etc.
  created_at timestamptz default now()
);

create table tracked_products (
  id uuid primary key default gen_random_uuid(),
  product_id text references products(id) not null,
  option_id text not null,         -- store's option identifier (size/kit/pack)
  option_label text not null,      -- human-readable label for display
  added_at timestamptz default now(),
  unique (product_id, option_id)
);

create table price_history (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  option_id text not null,
  timestamp timestamptz not null,  -- UTC, when the scrape ran
  price numeric,                   -- null if outcome != 'success'
  stock text,                      -- null if outcome != 'success'
  outcome text not null check (outcome in ('success','retried','failed'))
);
create index on price_history (product_id, option_id, timestamp);

create table scrape_log (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  option_id text not null,
  timestamp timestamptz not null,
  attempt_number int not null,
  outcome text not null check (outcome in ('success','retried','failed')),
  error_detail text
);
create index on scrape_log (product_id, option_id, timestamp);
```

Notes for the agent:
- `price_history` gets exactly one row per scrape *run* (the final outcome of that run, after all internal retries).
- `scrape_log` gets one row per *attempt within a run* — if a run retries twice before succeeding, that's 3 log rows (`retried`, `retried`, `success`) and 1 `price_history` row.
- A run that exhausts all retries writes one `failed` row to both tables, with `price`/`stock` left `null` in `price_history`.

### Backend API contract (Express, adapt directly to Django if used instead)

```
GET /health
→ 200 { status: "ok" }
  Used both as a liveness check and a Render keep-warm ping target.

GET /search?q=<partial-or-full-name>
→ 200 { results: [ { productId, name, options: [ { optionId, label } ] } ] }
  Proxies a live search against the store (Phase 0's access method).

POST /track
  body: { productId, optionId, optionLabel }
→ 201 { id, productId, optionId, optionLabel, addedAt }
  Upserts into tracked_products (unique on productId+optionId — treat re-track as no-op/200).

GET /tracked
→ 200 { tracked: [ { id, productId, name, optionId, optionLabel, addedAt } ] }
  Joins tracked_products with products for display.

GET /products/:productId/history?optionId=<id>
→ 200 { history: [ { timestamp, price, stock, outcome } ] }
  Ordered by timestamp ascending, for charting.

GET /products/:productId/logs?optionId=<id>
→ 200 { logs: [ { timestamp, attemptNumber, outcome, errorDetail } ] }
  Ordered by timestamp descending, most recent attempts first.

GET /export.csv
→ 200 text/csv
  Header: product_id,product_name,option,timestamp,price,stock,outcome
  One row per scrape_log entry (not just successes). timestamp is ISO 8601 UTC
  (e.g. 2026-09-26T14:03:11Z). price/stock empty string when outcome != success.

POST /scrape/all
  header: X-Cron-Secret: <CRON_SECRET>
→ 200 { ran: <n>, succeeded: <n>, failed: <n> }
  401 if secret missing/incorrect.
  Iterates every row in tracked_products, calls the scraper module for each,
  writes results to price_history + scrape_log. This is the endpoint cron-job.org
  calls every 2 hours. Must not throw on an individual product's failure — one
  bad scrape must not abort the batch; catch per-item and continue.
```

### Frontend routes/components (React)
- `/` — search bar (`GET /search`) → results list with an option picker per result → "Track" button (`POST /track`).
- `/dashboard` — list of tracked products (`GET /tracked`); clicking one opens its detail view.
- Detail view: chart (price over time, Recharts `LineChart`) + toggleable table, both fed by `GET /products/:id/history`; scrape log table fed by `GET /products/:id/logs`; "Export CSV" button linking directly to `GET /export.csv`.

---

## Phase 2 — Scraper core (build this against whatever Phase 0 discovered)

### Module contract

```
async function scrapeProduct(productId, optionId) -> {
  outcome: 'success' | 'failed',
  price: number | null,
  stock: string | null,
  attempts: [ { attemptNumber, outcome: 'retried'|'success'|'failed', errorDetail } ]
}
```

This function is the single source of truth, callable identically from: a manual CLI test script, `/scrape/all`, and a headed-mode debug runner. Do not duplicate scraping logic in more than one place.

### Retry algorithm (implement exactly this shape)

```
attempts = []
for attemptNumber in 1..MAX_ATTEMPTS (=3):
  try:
    raw = await fetchOrNavigate(productId, optionId)   # Phase 0's chosen method
    if using headless: await waitForSelector(priceSelector, { timeout: 8000 })
    parsed = parse(raw)                                 # extract price, stock
    if not isValid(parsed):                              # price numeric >0, stock in known set
      throw new Error('validation failed: ' + describe(parsed))
    attempts.push({ attemptNumber, outcome: 'success' })
    return { outcome: 'success', price: parsed.price, stock: parsed.stock, attempts }
  catch (err):
    if attemptNumber < MAX_ATTEMPTS:
      attempts.push({ attemptNumber, outcome: 'retried', errorDetail: err.message })
      await sleep(BACKOFF_MS[attemptNumber - 1])          # [1000, 3000, 9000]
    else:
      attempts.push({ attemptNumber, outcome: 'failed', errorDetail: err.message })
      return { outcome: 'failed', price: null, stock: null, attempts }
```

Rules the agent must follow when implementing this:
- `isValid` must actually check the value, not just that parsing didn't throw — e.g. a price of `0` or `NaN`, or a stock value not in the store's known vocabulary, is invalid and must trigger a retry/failure, never be persisted as-is.
- Never write `price: 0` or `stock: null` into `price_history` as if it were a real successful reading — `null` fields in that table only ever pair with `outcome != 'success'`.
- If using Playwright: re-run the selector query on each attempt rather than reusing a handle captured on an earlier attempt, in case the DOM was replaced between attempts.
- Wrap the whole function so it can never throw uncaught — callers (`/scrape/all`) rely on it always resolving to the shape above, even on total failure.

### Manual verification the agent should run before wiring up cron
- Invoke `scrapeProduct` directly (via a small script) 15–20 times in a row against the live store; confirm consistent, sane output.
- Force a failure path deliberately (point at a wrong selector, or a nonexistent product/option ID) and confirm it returns a clean `failed` result with a real `errorDetail`, not a thrown exception or a crash.
- If possible, simulate a slow response (introduce an artificial delay in a test double, or throttle via a local proxy) to confirm the retry/backoff path actually engages rather than the request appearing to hang indefinitely.

---

## Phase 3 — Scheduling

- `/scrape/all` (contract above) is the cron target.
- cron-job.org config: URL = deployed `/scrape/all`, method POST, header `X-Cron-Secret`, interval every 2 hours.
- If Render free-tier cold starts risk missing the 2-hour window, add a second cron-job.org job hitting `/health` every ~10–14 minutes to keep the instance warm — only add this if a cold scrape run is observed to actually fail/timeout in testing, not preemptively.

---

## Phase 4 — Dashboard implementation detail

- Chart: Recharts `LineChart`, x-axis = timestamp, y-axis = price; render a secondary indicator (color/marker) for `outcome != 'success'` points so gaps/failures are visually honest rather than interpolated over.
- Log table columns: timestamp (local display OK, underlying data is UTC), attempt number, outcome (badge-styled: green success / yellow retried / red failed), error detail (expandable/tooltip for failed rows).
- CSV export: stream directly from `scrape_log` joined to `products`/`tracked_products` for name/option label — do not regenerate from `price_history` alone, since that table doesn't carry per-attempt granularity.

---

## Phase 5 — Deployment configuration

- **Vercel (frontend):** standard static/SSR deploy; set `VITE_API_BASE_URL` (or Next equivalent) to the Render backend URL.
- **Render (backend):** Web Service, build command per framework (`npm install && npm run build` if TS), start command (`node server.js` / `npm start`); set env vars below in Render's dashboard, not committed to the repo.
- **Supabase:** use the service role key only on the backend, never exposed to the frontend; frontend talks only to your own backend API, never directly to Supabase.

### Environment variables (document all in README)
| Variable | Where used | Purpose |
|---|---|---|
| `SUPABASE_URL` | backend | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | backend | Service-role key for full table access |
| `TARGET_STORE_URL` | backend | `https://demo.inelabteamdev.com/` |
| `CRON_SECRET` | backend | Shared secret required on `/scrape/all` |
| `PORT` | backend | Server port |
| `VITE_API_BASE_URL` (or equivalent) | frontend | Deployed backend base URL |

---

## Phase 6 — Recording + documentation

- **Recording (2–4 min, headed):** run the scraper module directly (headed browser visible, or console output visible if HTTP-based) showing one normal run and one deliberately slow/failing run with the retry path visibly engaging.
- **README.md:** setup steps, exact schedule (`every 2 hours via cron-job.org POST /scrape/all`), full env var table above.
- **Design note:** state the Phase 0 decision (API/HTML/headless) and why, describe the retry/validation approach above, and honestly log whatever the agent's first implementation attempt got wrong (e.g., initially used a fixed sleep instead of `waitForSelector`, initially didn't distinguish `retried` from `failed`, initially wrote `0`/`null` on failure) and how it was corrected — this is a required deliverable, not optional framing.

---

## Cut list if time runs short (in this order)

1. All bonus features (alerts, CI/CD, configurable frequency, multi-option-per-run scraping, structure-change detection).
2. Extra `raw_meta` dashboard display.
3. UI styling polish.

**Never cut:** the retry/validation logic, honest `scrape_log` recording, the headed recording, the design note.

---

## Definition of done

- [ ] Phase 0 access method decided and documented in code comments.
- [ ] All 4 tables created in Supabase matching the DDL above.
- [ ] All 7 backend endpoints implemented matching the contracts above.
- [ ] `scrapeProduct` passes 15–20 consecutive manual live-store runs plus a deliberate forced-failure test.
- [ ] `/scrape/all` running on a live 2-hour cron against the deployed backend.
- [ ] Dashboard shows 2–3 tracked products with real accumulated history at submission time.
- [ ] CSV export matches the exact column spec, including blank price/stock on failed rows.
- [ ] Recording, README, design note, and resume ready.