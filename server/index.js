require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { supabase } = require('./db');
const { scrapeProduct } = require('./scraper');
const { searchStore, getProductDetail } = require('./store-client');

const app = express();
app.use(cors());
app.use(express.json());

// Root: service index (prevents a bare-URL 404 confusing humans/uptime checks).
app.get('/', (_req, res) =>
  res.json({ service: 'price-pulse', status: 'ok', endpoints: ['/health', '/search', '/track', '/tracked', '/export.csv', '/scrape/all'] })
);

// Liveness check + Render keep-warm ping target.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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

// All tracked products (joined with product names for display).
app.get('/tracked', async (_req, res) => {
  const { data, error } = await supabase
    .from('tracked_products')
    .select('id, product_id, option_id, option_label, added_at, products ( name )')
    .order('added_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    tracked: (data || []).map((t) => ({
      id: t.id,
      productId: t.product_id,
      name: t.products ? t.products.name : t.product_id,
      optionId: t.option_id,
      optionLabel: t.option_label,
      addedAt: t.added_at,
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
  res.setHeader('Content-Disposition', 'attachment; filename="price_history.csv"');
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
app.post('/scrape/all', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { data: tracked, error } = await supabase.from('tracked_products').select('*');
  if (error) return res.status(500).json({ error: error.message });

  let succeeded = 0;
  let failed = 0;
  for (const t of tracked || []) {
    // Pacing: live testing showed the store 429s bursts of handshakes.
    // scrapeProduct's own backoff is fixed by spec, so we space runs apart here.
    if (succeeded + failed > 0) await new Promise((r) => setTimeout(r, 2000));
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

    await supabase.from('price_history').insert({
      product_id: t.product_id,
      option_id: t.option_id,
      timestamp: runTimestamp,
      price: result.outcome === 'success' ? result.price : null,
      stock: result.outcome === 'success' ? result.stock : null,
      outcome: result.outcome, // 'success' (even after retries) or 'failed'; per-attempt detail is in scrape_log
    });

    for (const a of result.attempts) {
      await supabase.from('scrape_log').insert({
        product_id: t.product_id,
        option_id: t.option_id,
        timestamp: runTimestamp,
        attempt_number: a.attemptNumber,
        outcome: a.outcome,
        error_detail: a.errorDetail || null,
      });
    }
  }

  res.json({ ran: (tracked || []).length, succeeded, failed });
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
