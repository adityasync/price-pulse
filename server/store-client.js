/**
 * store-client.js — Phase 0 recon findings (documented here per ROADMAP Phase 0.5).
 *
 * RECON (performed 2026-09-26, see ROADMAP Phase 0 steps):
 *  1. Plain HTTP GET / returns a near-empty SPA shell:
 *       <div id="root"></div> + <script src="/assets/index-*.js">
 *     -> NO product data in HTML. Cheerio/BeautifulSoup parsing is NOT viable.
 *  2. The JS bundle calls three clean JSON APIs (found via bundle inspection):
 *       GET /api/v2/listings?page=&limit=      (catalog; caps at 60/page, 960 items total;
 *                                               NO server-side search — q/search params are ignored,
 *                                               so search = paginate + substring filter client-side)
 *       GET /api/v2/items/:id                  (product detail: name, optionAxis, options[{id,label}];
 *                                               contains NO price/stock)
 *       GET /api/v2/ui/manifest                (rotating CSS class names — selectors are
 *                                               unstable by design; another reason not to scrape DOM)
 *  3. Price/stock lives behind a bot-gated quote flow (reverse-engineered from bundle):
 *       GET  /api/v2/handshake            -> { salt, difficulty, wasm (base64), csig, ts }
 *       POST /api/v2/handshake { salt,.., nonce, derived, wasmOut, att, itemId, option }
 *         where nonce   = proof-of-work: sha256(salt + ':' + n) starts with `difficulty` zeros
 *               wasmOut = running the server's wasm blob f(seed),
 *                         seed = sha256(SEASONING + '|seed|' + salt + '|' + sha256(att))[:8] as int32
 *               derived = sha256(SEASONING + '|derive|' + salt + '|' + wasmOut + '|' + sha256(att))
 *               att     = JSON { env: {canvas, gl, hc, scr, frames, at}, ix: {moves, dwell, trusted} }
 *                         (server rejects implausible fingerprints — needs 16-hex canvas/gl,
 *                          8 rAF frame deltas, >=8 mouse moves, dwell >= ~600ms, trusted click)
 *         -> 200 { pass, ttlMs: 30000 } | 401 { error: 'unauthorized' }
 *       GET /api/v2/items/:id/quote?opt=:opt  (header: Authorization: Bearer <pass>)
 *         -> 200 { blob }  (pass expires after 30s — one handshake per quote, no caching)
 *         blob = base64( XOR( JSON, sha256(SEASONING + '|enc|' + pass) ) )
 *         JSON = { q: price, l: mrp, k: sale, o: badgePct, a: stockCount, u: currency,
 *                  w: timestamp, h: rating, hn: ratingCount, vd: seller, eta: deliveryDays,
 *                  z: variant, j: pendingFlag, y: displayFormat, i: ? }
 *
 * DECISION: pure-Node HTTP + crypto. No Playwright anywhere in this path because:
 *  - the DOM route is strictly worse: price renders only after hover (~8 moves + 600ms dwell)
 *    + click on "Check today's price", the click handler randomly drops (35%) or delays (900ms),
 *    class names rotate per manifest revision, price text uses rotating formats
 *    (spaced/euro/trailing/unicode/nbsp/lakh) plus decoy values, stock uses 5 rotating templates.
 *  - HTTP is faster (~1s vs 8-15s browser boot+nav), fits Render free-tier RAM (no Chromium),
 *    and retries cleanly. The browser remains available only via scripts/run-headed.js,
 *    which drives THIS module in headed-debug mode for the recording deliverable.
 *
 *ainer swap point: if the store ever stops serving /api/v2/*, replace fetchQuote()'s
 * internals with a headless-browser pass. scrapeProduct() in scraper.js must not change.
 */

const crypto = require('crypto');

const BASE = (process.env.TARGET_STORE_URL || 'https://demo.inelabteamdev.com/').replace(/\/+$/, '');
// Client "seasoning" constant: dr = P(232)+P(295)+... decoded from the store's own JS bundle.
// It is part of the store's public client code, not a secret — it just keys the hashes.
const SEASONING = 'feffd924900aae681d40425da2e3f3ef53e3ab0a8c2e6acd330b5265f3794b56';

const FETCH_TIMEOUT_MS = 15000;
const LISTINGS_LIMIT = 60; // server cap — requesting more still returns 60
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class RetryableError extends Error {} // 429 / 5xx / timeouts / slow responses — safe to retry
class FatalError extends Error {} // 401/403 challenge rejection, bad product/option — retry won't help

function shaHex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function shaBytes(s) {
  return crypto.createHash('sha256').update(s).digest();
}
function randHex(n) {
  return crypto.randomBytes(n).toString('hex').slice(0, n);
}

async function getJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
    return res;
  } catch (err) {
    throw new RetryableError(`request failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build a plausible interaction attestation. Values are jittered per run so
 * consecutive scrapes don't look like exact replays; shape matches what the
 * store's own client sends (see recon note above).
 */
function buildAttestation() {
  const now = Date.now();
  const dwell = 800 + Math.floor(Math.random() * 700); // 800–1500ms, above the ~600ms minimum
  const nMoves = 9 + Math.floor(Math.random() * 4); // 9–12, above the 8-move minimum
  const moves = [];
  let x = 100 + Math.floor(Math.random() * 60);
  let y = 190 + Math.floor(Math.random() * 40);
  for (let i = 0; i < nMoves; i++) {
    x += 5 + Math.floor(Math.random() * 8);
    y += 2 + Math.floor(Math.random() * 5);
    moves.push([x, y, now - dwell + Math.floor((dwell / nMoves) * i)]);
  }
  const frames = Array.from({ length: 8 }, () => +(16 + Math.random() * 1.2).toFixed(1));
  return JSON.stringify({
    env: {
      canvas: randHex(16),
      gl: randHex(16),
      hc: 4,
      scr: [1920, 1080, 1],
      frames,
      at: now,
    },
    ix: { hoverAt: now - dwell, dwellMs: dwell, moves, clickAt: now, trusted: true },
  });
}

function solvePow(salt, difficulty) {
  const need = '0'.repeat(difficulty);
  let n = 0;
  for (;;) {
    if (shaHex(`${salt}:${n}`).slice(0, difficulty) === need) return n;
    n++;
    if (n > 50_000_000) throw new RetryableError('proof-of-work did not converge');
  }
}

async function runWasm(wasmB64, seed) {
  let bytes;
  try {
    bytes = Buffer.from(wasmB64, 'base64');
  } catch {
    throw new RetryableError('handshake returned undecodable wasm');
  }
  try {
    const mod = await WebAssembly.compile(bytes);
    const inst = await WebAssembly.instantiate(mod);
    if (typeof inst.exports.f !== 'function') throw new Error('missing export f');
    return inst.exports.f(seed | 0) | 0;
  } catch (err) {
    throw new RetryableError(`wasm challenge failed: ${err.message}`);
  }
}

/**
 * Single source of truth for live price/stock. Throws RetryableError | FatalError.
 * Returns { price, stockCount, currency, raw } where raw is the full decrypted quote
 * (kept for products.raw_meta + dashboard extras).
 */
async function fetchQuote(productId, optionId) {
  // 1. challenge
  const chalRes = await getJson(`${BASE}/api/v2/handshake`);
  if (!chalRes.ok) {
    if (chalRes.status === 429 || chalRes.status >= 500)
      throw new RetryableError(`handshake GET ${chalRes.status}`);
    throw new FatalError(`handshake GET ${chalRes.status}`);
  }
  const chal = await chalRes.json();

  // 2. solve: PoW + wasm + derived key, all bound to our attestation
  const att = buildAttestation();
  const attHash = shaHex(att);
  const seed = parseInt(shaHex(`${SEASONING}|seed|${chal.salt}|${attHash}`).slice(0, 8), 16) | 0;
  const wasmOut = await runWasm(chal.wasm, seed);
  const nonce = solvePow(chal.salt, chal.difficulty);
  const derived = shaHex(`${SEASONING}|derive|${chal.salt}|${wasmOut}|${attHash}`);

  // 3. answer the challenge
  const ansRes = await getJson(`${BASE}/api/v2/handshake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...chal,
      nonce,
      derived,
      wasmOut,
      att,
      itemId: Number(productId),
      option: optionId,
    }),
  });
  if (ansRes.status === 429) throw new RetryableError('handshake POST 429');
  if (ansRes.status === 400 || ansRes.status === 401 || ansRes.status === 403)
    throw new FatalError(`challenge rejected (${ansRes.status})`);
  if (!ansRes.ok) throw new RetryableError(`handshake POST ${ansRes.status}`);
  const { pass } = await ansRes.json();
  if (!pass) throw new RetryableError('handshake answer missing pass');

  // 4. fetch + decrypt the quote (pass TTL is ~30s — use immediately)
  const qRes = await getJson(
    `${BASE}/api/v2/items/${encodeURIComponent(productId)}/quote?opt=${encodeURIComponent(optionId)}`,
    { headers: { Authorization: `Bearer ${pass}` } }
  );
  if (qRes.status === 400 || qRes.status === 401 || qRes.status === 403)
    throw new FatalError('quote unauthorized (bad product/option or expired pass)');
  if (qRes.status === 404) throw new FatalError('unknown product or option');
  if (qRes.status === 429 || qRes.status >= 500)
    throw new RetryableError(`quote ${qRes.status}`);
  if (!qRes.ok) throw new RetryableError(`quote ${qRes.status}`);

  const { blob } = await qRes.json();
  let quote;
  try {
    const key = shaBytes(`${SEASONING}|enc|${pass}`);
    const enc = Buffer.from(blob, 'base64');
    const out = Buffer.alloc(enc.length);
    for (let i = 0; i < enc.length; i++) out[i] = enc[i] ^ key[i % key.length];
    quote = JSON.parse(new TextDecoder().decode(out));
  } catch {
    throw new RetryableError('quote payload failed to decrypt/parse');
  }
  return {
    price: quote.q,
    stockCount: quote.a,
    currency: quote.u,
    raw: quote,
  };
}

/** Product catalog detail (name/options) — plain JSON, no handshake needed. */
async function getProductDetail(productId) {
  const res = await getJson(`${BASE}/api/v2/items/${encodeURIComponent(productId)}`);
  if (res.status === 404) throw new FatalError('unknown product');
  if (!res.ok) throw new RetryableError(`product detail ${res.status}`);
  return res.json(); // { id, name, brand, ..., optionAxis, options: [{id,label}] }
}

/**
 * Live search against the store. The listings endpoint ignores server-side
 * query params, so we pull all pages (16 x 60) with modest concurrency and
 * substring-match locally. Details (options) are fetched per match.
 */
async function searchStore(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const first = await getJson(`${BASE}/api/v2/listings?page=1&limit=${LISTINGS_LIMIT}`);
  if (!first.ok) throw new RetryableError(`catalog ${first.status}`);
  const head = await first.json();
  const totalPages = head.totalPages || 1;

  const pages = [head];
  const rest = [];
  for (let p = 2; p <= totalPages; p++) rest.push(p);
  const CONCURRENCY = 4;
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      rest.slice(i, i + CONCURRENCY).map(async (p) => {
        const r = await getJson(`${BASE}/api/v2/listings?page=${p}&limit=${LISTINGS_LIMIT}`);
        if (!r.ok) throw new RetryableError(`catalog page ${p}: ${r.status}`);
        return r.json();
      })
    );
    pages.push(...batch);
  }

  const matches = [];
  for (const pg of pages) {
    for (const item of pg.results || []) {
      if (String(item.name || '').toLowerCase().includes(q)) matches.push(item);
      if (matches.length >= 20) break;
    }
    if (matches.length >= 20) break;
  }

  // Attach real option lists so the UI can offer the product+option picker.
  const results = [];
  for (const m of matches) {
    try {
      const detail = await getProductDetail(m.id);
      results.push({
        productId: String(detail.id),
        name: detail.name,
        options: (detail.options || []).map((o) => ({ optionId: o.id, label: o.label })),
      });
    } catch {
      // One bad detail must not fail the whole search — skip it.
    }
  }
  return results;
}

module.exports = {
  fetchQuote,
  getProductDetail,
  searchStore,
  RetryableError,
  FatalError,
};
