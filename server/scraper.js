/**
 * scraper.js — scrapeProduct(productId, optionId), the single source of truth.
 * Callable identically from: the manual CLI test script, POST /scrape/all,
 * and the headed debug runner. No scraping logic lives anywhere else.
 *
 * Transport comes from store-client.js (HTTP handshake+quote flow — see the
 * Phase 0 recon note there). If that path ever dies, swap fetchQuote's
 * internals for headless browsing; this module's contract stays unchanged.
 */

const { fetchQuote, RetryableError, FatalError } = require('./store-client');

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000, 9000]; // ROADMAP spec; sleeps happen after attempts 1 and 2

/**
 * @returns { outcome: 'success'|'failed', price: number|null, stock: string|null,
 *            attempts: [{ attemptNumber, outcome: 'retried'|'success'|'failed', errorDetail }] }
 * Never throws — callers rely on always resolving to this shape.
 */
async function scrapeProduct(productId, optionId) {
  const attempts = [];
  try {
    for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber++) {
      try {
        const quote = await fetchQuote(productId, optionId);
        const price = toValidPrice(quote.price);
        const stock = toValidStock(quote.stockCount);
        if (price === null || stock === null) {
          throw new RetryableError(
            `validation failed: price=${JSON.stringify(quote.price)} stock=${JSON.stringify(quote.stockCount)}`
          );
        }
        attempts.push({ attemptNumber, outcome: 'success' });
        return { outcome: 'success', price, stock, attempts };
      } catch (err) {
        // Fatal errors (bad product/option, rejected challenge) won't heal on
        // retry within this run — record this attempt as failed and stop
        // immediately instead of burning backoff sleeps on a hopeless cause.
        if (err instanceof FatalError) {
          attempts.push({
            attemptNumber,
            outcome: 'failed',
            errorDetail: err && err.message ? err.message : String(err),
          });
          return { outcome: 'failed', price: null, stock: null, attempts };
        }
        const last = attemptNumber === MAX_ATTEMPTS;
        attempts.push({
          attemptNumber,
          outcome: last ? 'failed' : 'retried',
          errorDetail: err && err.message ? err.message : String(err),
        });
        if (last) return { outcome: 'failed', price: null, stock: null, attempts };
        await sleep(BACKOFF_MS[attemptNumber - 1]);
      }
    }
  } catch (err) {
    // Absolute backstop — this function never throws.
    attempts.push({
      attemptNumber: attempts.length + 1,
      outcome: 'failed',
      errorDetail: `unexpected: ${err && err.message ? err.message : String(err)}`,
    });
  }
  return { outcome: 'failed', price: null, stock: null, attempts };
}

/**
 * Price must be a real reading: finite number > 0. Anything else (0, NaN,
 * missing) is invalid and must trigger retry/failure — never persisted.
 */
function toValidPrice(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Stock vocabulary, from the store's observed templates:
 *   "<N> units available" | "Last few: <N>" | "Available (<N>)" |
 *   "Stock: <N> remaining" | "Ready to ship · <N> available" | "Sold out"
 * We normalize the quote's numeric count into this family so downstream
 * readers (dashboard, CSV) see the store's own language, not a bare int.
 */
function toValidStock(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  if (count === 0) return 'Sold out';
  return `${Math.floor(count)} units available`;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

module.exports = { scrapeProduct, MAX_ATTEMPTS, BACKOFF_MS };
