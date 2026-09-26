# AGENT.md — Mock Storefront Price Tracker

## Source of truth

**`roadmap.md` in this repo root is the authoritative technical spec** — exact
DB schema (DDL), API contracts, the scraper's retry algorithm, and the
phase-by-phase build order all live there. This file (AGENT.md) holds
standing rules and conventions that apply across every phase. If the two
ever disagree, `roadmap.md` wins for schema/endpoints/algorithms; this file
wins for how to work.

Read `roadmap.md` in full before starting. Re-check it before each phase —
don't work from memory of it once it's out of context.

## Context

Deadline: **Sun Sep 27, 2026, 1:00 PM IST** — time is tight, so default to
shipping the smallest thing that satisfies each requirement in `roadmap.md`
before polishing anything.

Target store: <https://demo.inelabteamdev.com/> (client-rendered on last check
— Phase 0 in `roadmap.md` tells you how to determine the actual access
method yourself; don't assume it needs Playwright without checking first).
**Scrape only this store.**

## Non-negotiable priorities (in this order)

1. **Scraper reliability** — retries, honest failure handling, never writes
   wrong/empty data as if it were real. This is graded hardest.
2. **Correctness under difficulty** — handles slow/async-loaded content and
   occasional errors without misreading price/stock.
3. **Honest logging** — every scrape attempt (success/retried/failed) is
   logged; failures are visible, not hidden or dropped.
4. Working dashboard, export, deploy.
5. Bonus features — only after 1–4 are solid and only with time to spare.

## Tech stack (fixed by assignment — don't substitute)

- Frontend: React (Vite or Next), deployed to Vercel
- Backend: Node.js/Express, deployed to Render
- DB: Supabase (Postgres) — see `roadmap.md` for exact DDL
- Scraping: prefer plain `fetch`/`axios` + Cheerio; use Playwright only if
  Phase 0's recon shows the store genuinely requires JS execution
- Scheduling: external cron (cron-job.org) hitting `/scrape/all` — no
  always-on loop, Render free tier sleeps

## Working conventions for the agent

- Do Phase 0 (recon) yourself before writing scraper code — don't hard-code
  assumptions about the store's structure without verifying them first.
- Build the scraper as one isolated, reusable module (`scrapeProduct`) —
  never duplicate scraping logic between the manual test script, the cron
  endpoint, and the headed debug runner.
- When in doubt about scraper behavior, favor an explicit `failed` log entry
  over a best-effort guess written as if it succeeded. Never persist
  `price: 0` or a null-coalesced value as if it were a real reading.
- Don't add bonus features (alerts, CI/CD, configurable frequency, etc.)
  until core scraping + logging + export + deploy are verified working end
  to end against the live store.
- After any scraper change, re-run it several times against the live store
  (not mocked data) before moving on — grading is about behavior over many
  real unattended runs, not passing a single test.
- Keep a running note of anything a first implementation attempt got wrong
  (e.g. fixed sleeps instead of selector waits, missing retry/fail
  distinction) — this is required content for the submission's design note.
- Commit early and often to the public GitHub repo; the repo itself is a
  deliverable.
- Track 2–3 real products on the live dashboard as early as possible so
  history reflects genuine unattended runs, not last-minute seeding.

## Deliverables checklist

- [ ] Live hosted site link
- [ ] Public GitHub repo
- [ ] 2–4 min headed screen recording (normal + slow/failing case)
- [ ] README: setup, scrape schedule, env vars
- [ ] Design note: reliability approach, trade-offs, what first attempt got
      wrong and how it was corrected
- [ ] PDF resume
- [ ] Live dashboard has 2–3 products already tracked with real history
