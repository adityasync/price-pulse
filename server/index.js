require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { supabase } = require('./db');
const { scrapeProduct } = require('./scraper');
const { searchStore, getProductDetail } = require('./store-client');
const { runStructureCheck } = require('./structure-check');
const { detectAlert, sendAlertEmail } = require('./alerts');

// Reliability: retry transient Supabase writes (3x, 400ms apart) so a
// single DB hiccup during an unattended run doesn't silently lose logging.
async function dbInsert(table, row) {
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    const { error } = await supabase.from(table).insert(row);
    if (!error) return null;
    lastErr = error;
    if (i < 3) await new Promise((r) => setTimeout(r, 400 * i));
  }
  return lastErr;
}

// Reliability: overlap guard — cron-job.org + keep-warm + manual hits can
// overlap on slow runs; concurrent batches would 429-storm the store and
// double-write history. Second caller gets 409 instead of a duplicate run.
let scrapeRunning = false;

const app = express();
app.use(cors());
app.use(express.json());

// Root: service index (prevents a bare-URL 404 confusing humans/uptime checks).
app.get('/', (_req, res) =>
  res.json({ service: 'price-pulse', status: 'ok', endpoints: ['/health', '/search', '/track', '/track/bulk', '/tracked', '/export.csv', '/scrape/all', '/structure-check'] })
);

// Liveness check + Render keep-warm ping target.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Bonus: change detection — validates the store endpoints/shapes our scraper
// depends on. Poll this from the dashboard banner or a cron job; ok:false
// means "store changed, check scraper before trusting new readings".
app.get('/structure-check', async (req, res) => {
  try {
    const result = await runStructureCheck(req.query.productId);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Live search against the store (product + option picker data).
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'missing query param q' });
  try {
    const results = await searchStore(q);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: 'store search failed', detail: err.message });
  }
});

// Track a product+option. Upserts products (by store ID) and tracked_products
// (unique on productId+optionId — re-track is a no-op returning 200).
app.post('/track', async (req, res) => {
  const { productId, optionId, optionLabel } = req.body || {};
  if (!productId || !optionId || !optionLabel) {
    return res.status(400).json({ error: 'body must include productId, optionId, optionLabel' });
  }

  let detail;
  try {
    detail = await getProductDetail(productId);
  } catch (err) {
    return res.status(502).json({ error: 'could not fetch product from store', detail: err.message });
  }
  const opt = (detail.options || []).find((o) => o.id === optionId);
  if (!opt) return res.status(400).json({ error: `unknown optionId '${optionId}' for product ${productId}` });

  const { error: pErr } = await supabase.from('products').upsert(
    {
      id: String(detail.id),
      name: detail.name,
      raw_meta: {
        brand: detail.brand,
        category: detail.category,
        sku: detail.sku,
        description: detail.description,
        optionAxis: detail.optionAxis,
        options: detail.options,
      },
    },
    { onConflict: 'id' }
  );
  if (pErr) return res.status(500).json({ error: pErr.message });

  const { data: existing } = await supabase
    .from('tracked_products')
    .select('*')
    .eq('product_id', String(detail.id))
    .eq('option_id', optionId)
    .maybeSingle();

  if (existing) {
    return res.status(200).json({
      id: existing.id,
      productId: existing.product_id,
      optionId: existing.option_id,
      optionLabel: existing.option_label,
      addedAt: existing.added_at,
    });
  }

  const { data, error } = await supabase
    .from('tracked_products')
    .insert({
      product_id: String(detail.id),
      option_id: optionId,
      option_label: optionLabel,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({
    id: data.id,
    productId: data.product_id,
    optionId: data.option_id,
    optionLabel: data.option_label,
    addedAt: data.added_at,
  });
});

// Bonus: track MULTIPLE options of one product in a single call/run.
// body: { productId, options: [{ optionId, optionLabel }] }
// Upserts the product once, then upserts each option. Returns per-option results.
// This is how "scrape multiple options for the same product in one scrape run"
// is fulfilled: each option becomes a tracked_products row and /scrape/all
// scrapes them all in one batch (grouped per product where possible).
app.post('/track/bulk', async (req, res) => {
  const { productId, options } = req.body || {};
  if (!productId || !Array.isArray(options) || options.length === 0) {
    return res.status(400).json({ error: 'body must include productId and non-empty options[]' });
  }
  if (options.length > 20) return res.status(400).json({ error: 'max 20 options per bulk call' });

  let detail;
  try {
    detail = await getProductDetail(productId);
  } catch (err) {
    return res.status(502).json({ error: 'could not fetch product from store', detail: err.message });
  }

  const { error: pErr } = await supabase.from('products').upsert(
    {
      id: String(detail.id),
      name: detail.name,
      raw_meta: {
        brand: detail.brand,
        category: detail.category,
        sku: detail.sku,
        description: detail.description,
        optionAxis: detail.optionAxis,
        options: detail.options,
      },
    },
    { onConflict: 'id' }
  );
  if (pErr) return res.status(500).json({ error: pErr.message });

  const validIds = new Set((detail.options || []).map((o) => o.id));
  const results = [];
  for (const o of options) {
    if (!o || !o.optionId || !o.optionLabel || !validIds.has(o.optionId)) {
      results.push({ optionId: (o && o.optionId) || null, ok: false, error: 'unknown optionId' });
      continue;
    }
    const { data: existing } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('product_id', String(detail.id))
      .eq('option_id', o.optionId)
      .maybeSingle();
    if (existing) {
      results.push({ optionId: o.optionId, ok: true, id: existing.id, existed: true });
      continue;
    }
    const { data, error } = await supabase
      .from('tracked_products')
      .insert({ product_id: String(detail.id), option_id: o.optionId, option_label: o.optionLabel })
      .select()
      .single();
    if (error) results.push({ optionId: o.optionId, ok: false, error: error.message });
    else results.push({ optionId: o.optionId, ok: true, id: data.id, existed: false });
  }
  res.status(201).json({ productId: String(detail.id), results });
});

// Bonus: configurable scrape frequency per product (default 120 min).
// PATCH /tracked/:id  body: { frequencyMinutes: 15..10080 }
app.patch('/tracked/:id', async (req, res) => {
  const mins = Number((req.body || {}).frequencyMinutes);
  if (!Number.isFinite(mins) || mins < 15 || mins > 10080) {
    return res.status(400).json({ error: 'frequencyMinutes must be 15..10080' });
  }
  const { data, error } = await supabase
    .from('tracked_products')
    .update({ frequency_minutes: Math.floor(mins) })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json({ id: data.id, frequencyMinutes: data.frequency_minutes ?? Math.floor(mins) });
});

// All tracked products (joined with product names for display).
app.get('/tracked', async (_req, res) => {
  // frequency_minutes may not exist on DBs created before the bonus
  // migration — select * and default to 120 so old DBs keep working.
  const { data, error } = await supabase
    .from('tracked_products')
    .select('id, product_id, option_id, option_label, added_at, products ( name, raw_meta )')
    .order('added_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  let freqById = {};
  try {
    const { data: frows } = await supabase.from('tracked_products').select('id, frequency_minutes');
    for (const r of frows || []) freqById[r.id] = r.frequency_minutes;
  } catch {
    /* pre-migration DB — all default */
  }
  res.json({
    tracked: (data || []).map((t) => ({
      id: t.id,
      productId: t.product_id,
      name: t.products ? t.products.name : t.product_id,
      optionId: t.option_id,
      optionLabel: t.option_label,
      addedAt: t.added_at,
      frequencyMinutes: freqById[t.id] ?? 120,
      meta: (t.products && t.products.raw_meta) || null, // brand/category/sku + lastQuote extras
    })),
  });
});

// Price history for charting — ascending by timestamp.
app.get('/products/:productId/history', async (req, res) => {
  const { optionId } = req.query;
  if (!optionId) return res.status(400).json({ error: 'missing query param optionId' });
  const { data, error } = await supabase
    .from('price_history')
    .select('timestamp, price, stock, outcome')
    .eq('product_id', req.params.productId)
    .eq('option_id', optionId)
    .order('timestamp', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    history: (data || []).map((h) => ({
      timestamp: h.timestamp,
      price: h.price === null ? null : Number(h.price),
      stock: h.stock,
      outcome: h.outcome,
    })),
  });
});

// Scrape log — most recent attempts first.
app.get('/products/:productId/logs', async (req, res) => {
  const { optionId } = req.query;
  if (!optionId) return res.status(400).json({ error: 'missing query param optionId' });
  const { data, error } = await supabase
    .from('scrape_log')
    .select('timestamp, attempt_number, outcome, error_detail')
    .eq('product_id', req.params.productId)
    .eq('option_id', optionId)
    .order('timestamp', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    logs: (data || []).map((l) => ({
      timestamp: l.timestamp,
      attemptNumber: l.attempt_number,
      outcome: l.outcome,
      errorDetail: l.error_detail,
    })),
  });
});

// CSV export: one row per scrape_log entry (not just successes).
// price/stock are filled only for outcome == 'success' rows, via the run's
// price_history row (same product/option/run-timestamp); empty otherwise.
app.get('/export.csv', async (_req, res) => {
  const { data: logs, error } = await supabase
    .from('scrape_log')
    .select('product_id, option_id, timestamp, outcome')
    .order('timestamp', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const { data: tracked } = await supabase
    .from('tracked_products')
    .select('product_id, option_id, option_label');
  const labelOf = new Map((tracked || []).map((t) => [`${t.product_id}|${t.option_id}`, t.option_label]));

  const { data: products } = await supabase.from('products').select('id, name');
  const nameOf = new Map((products || []).map((p) => [p.id, p.name]));

  const { data: hist } = await supabase
    .from('price_history')
    .select('product_id, option_id, timestamp, price, stock, outcome');
  const histOf = new Map(
    (hist || []).map((h) => [
      `${h.product_id}|${h.option_id}|${h.timestamp}`,
      { price: h.price, stock: h.stock, outcome: h.outcome },
    ])
  );

  const header = 'product_id,product_name,option,timestamp,price,stock,outcome';
  const rows = (logs || []).map((l) => {
    const key = `${l.product_id}|${l.option_id}`;
    let price = '';
    let stock = '';
    if (l.outcome === 'success') {
      const h = histOf.get(`${key}|${l.timestamp}`);
      if (h && h.outcome === 'success') {
        price = h.price === null || h.price === undefined ? '' : String(h.price);
        stock = h.stock || '';
      }
    }
    return [
      l.product_id,
      csvEscape(nameOf.get(l.product_id) || ''),
      csvEscape(labelOf.get(key) || l.option_id),
      new Date(l.timestamp).toISOString(),
      price,
      csvEscape(stock),
      l.outcome,
    ].join(',');
  });

  res.setHeader('Content-Type', 'text/csv');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  res.setHeader('Content-Disposition', `attachment; filename="price-pulse-${stamp}.csv"`);
  res.send(header + '\n' + rows.join('\n') + (rows.length ? '\n' : ''));
});

// Cron target (cron-job.org POSTs here every 2 hours with X-Cron-Secret).
// GET on the same path returns 200 info instead of 404, so URL validators
// and uptime checks that probe with GET don't report the endpoint as dead.
// GET never triggers a scrape — only POST does.
app.get('/scrape/all', (_req, res) =>
  res.json({ info: 'POST here with X-Cron-Secret to run the scheduled scrape', method: 'POST' })
);
// One bad product must never abort the batch — per-item catch + continue.
// All rows of a run share one timestamp so the CSV export can join
// scrape_log rows to their run's price_history row.
//
// Bonus behavior folded in without changing the default 2h contract:
//  - frequency_minutes per product (default 120): items scraped more recently
//    than their cadence are SKIPPED (counted separately). Run cron-job.org
//    MORE often than 2h (e.g. every 30 min) only if you use custom frequencies;
//    otherwise the default 2h job scrapes everything each time as before.
//  - overlap guard: concurrent POSTs get 409 instead of double-scraping.
//  - jittered pacing (~2s + 0-1s) so handshake bursts don't self-429.
//  - DB writes retried 3x; a DB failure is recorded in the response, never silent.
//  - post-scrape email alerts (SendGrid, optional) on price-drop/back-in-stock.
app.post('/scrape/all', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (scrapeRunning) return res.status(409).json({ error: 'scrape already running' });
  scrapeRunning = true;
  try {
    const { data: tracked, error } = await supabase.from('tracked_products').select('*');
    if (error) return res.status(500).json({ error: error.message });

    // Pre-fetch last-run timestamps for frequency gating (best-effort: if the
    // history query fails we scrape everything rather than skipping silently).
    let lastRunByKey = {};
    try {
      const { data: hist } = await supabase
        .from('price_history')
        .select('product_id, option_id, timestamp')
        .order('timestamp', { ascending: false })
        .limit(2000);
      for (const h of hist || []) {
        const k = `${h.product_id}|${h.option_id}`;
        if (!lastRunByKey[k]) lastRunByKey[k] = new Date(h.timestamp).getTime();
      }
    } catch {
      lastRunByKey = {};
    }

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const dbErrors = [];
    const now = Date.now();
    for (const t of tracked || []) {
      const freqMins = Number(t.frequency_minutes) >= 15 ? Number(t.frequency_minutes) : 120;
      const lastRun = lastRunByKey[`${t.product_id}|${t.option_id}`] || 0;
      if (now - lastRun < (freqMins * 60 * 1000) - 60000) {
        skipped++; // not due yet — honest skip, no rows written
        continue;
      }
      // Pacing: live testing showed the store 429s bursts of handshakes.
      // scrapeProduct's own backoff is fixed by spec, so we space runs apart here.
      // Jitter avoids lock-step bursts when cron overlaps with keep-warm traffic.
      if (succeeded + failed > 0) await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
      const runTimestamp = new Date().toISOString();
      let result;
      try {
        result = await scrapeProduct(t.product_id, t.option_id);
      } catch (err) {
        result = {
          outcome: 'failed',
          price: null,
          stock: null,
          attempts: [{ attemptNumber: 1, outcome: 'failed', errorDetail: String(err && err.message || err) }],
        };
      }

      if (result.outcome === 'success') succeeded++;
      else failed++;

      const hErr = await dbInsert('price_history', {
        product_id: t.product_id,
        option_id: t.option_id,
        timestamp: runTimestamp,
        price: result.outcome === 'success' ? result.price : null,
        stock: result.outcome === 'success' ? result.stock : null,
        outcome: result.outcome, // 'success' (even after retries) or 'failed'; per-attempt detail is in scrape_log
      });
      if (hErr) dbErrors.push(`price_history ${t.product_id}/${t.option_id}: ${hErr.message}`);

      // Stash display-only quote detail for the dashboard info panel.
      // Best-effort: meta must never break scrape logging.
      if (result.outcome === 'success' && result.extras) {
        try {
          const { data: prod } = await supabase
            .from('products')
            .select('raw_meta')
            .eq('id', t.product_id)
            .single();
          await supabase
            .from('products')
            .update({ raw_meta: { ...((prod && prod.raw_meta) || {}), lastQuote: result.extras } })
            .eq('id', t.product_id);
        } catch {
          /* ignore — logging above already succeeded */
        }
      }

      for (const a of result.attempts) {
        const lErr = await dbInsert('scrape_log', {
          product_id: t.product_id,
          option_id: t.option_id,
          timestamp: runTimestamp,
          attempt_number: a.attemptNumber,
          outcome: a.outcome,
          error_detail: a.errorDetail || null,
        });
        if (lErr) dbErrors.push(`scrape_log ${t.product_id}/${t.option_id}: ${lErr.message}`);
      }

      // Bonus email alerts (no-op unless SendGrid env set). Best-effort.
      if (result.outcome === 'success') {
        try {
          const { data: hist } = await supabase
            .from('price_history')
            .select('price, stock, outcome, timestamp')
            .eq('product_id', t.product_id)
            .eq('option_id', t.option_id)
            .order('timestamp', { ascending: false })
            .limit(5);
          const ordered = (hist || []).slice().reverse();
          const alert = await detectAlert(ordered);
          if (alert) {
            let pname = t.product_id;
            try {
              const { data: p } = await supabase.from('products').select('name').eq('id', t.product_id).single();
              if (p && p.name) pname = p.name;
            } catch { /* keep id */ }
            await sendAlertEmail({ productName: pname, productId: t.product_id, optionLabel: t.option_label, alert });
          }
        } catch {
          /* alerts must never break the batch */
        }
      }
    }

    res.json({ ran: (tracked || []).length, succeeded, failed, skipped, dbErrors });
  } finally {
    scrapeRunning = false;
  }
});

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}
module.exports = { app };
