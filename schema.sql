-- Run this in the Supabase SQL editor.
-- Matches ROADMAP.md Phase 1 DDL exactly (authoritative spec).
--
-- price_history gets exactly one row per scrape RUN (final outcome after retries).
-- scrape_log gets one row per ATTEMPT within a run.

create table if not exists products (
  id text primary key,             -- store's product ID as shown in the product page URL (/item/<id>)
  name text not null,
  raw_meta jsonb,                  -- optional: description, image url, other option prices, etc.
  created_at timestamptz default now()
);

create table if not exists tracked_products (
  id uuid primary key default gen_random_uuid(),
  product_id text references products(id) not null,
  option_id text not null,         -- store's option identifier (size/kit/pack, e.g. 'o1')
  option_label text not null,      -- human-readable label for display
  added_at timestamptz default now(),
  unique (product_id, option_id)
);

create table if not exists price_history (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  option_id text not null,
  timestamp timestamptz not null,  -- UTC, when the scrape ran
  price numeric,                   -- null if outcome != 'success'
  stock text,                      -- null if outcome != 'success'
  outcome text not null check (outcome in ('success','retried','failed'))
);
create index if not exists idx_price_history_lookup on price_history (product_id, option_id, timestamp);

create table if not exists scrape_log (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  option_id text not null,
  timestamp timestamptz not null,
  attempt_number int not null,
  outcome text not null check (outcome in ('success','retried','failed')),
  error_detail text
);
create index if not exists idx_scrape_log_lookup on scrape_log (product_id, option_id, timestamp);
