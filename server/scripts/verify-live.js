// Manual verification per ROADMAP Phase 2: run scrapeProduct N times against
// the live store, confirm consistent sane output; then force failure paths.
// Usage: npm run scrape:live [runs=18] [productId=2321] [optionId=o1]
require('dotenv').config();
const { scrapeProduct } = require('../scraper');

const RUNS = Number(process.argv[2] || 18);
const PRODUCT = process.argv[3] || '2321';
const OPTION = process.argv[4] || 'o1';

(async () => {
  console.log(`Live verification: ${RUNS}x scrapeProduct(${PRODUCT}, ${OPTION})`);
  let ok = 0;
  const prices = [];
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now();
    const r = await scrapeProduct(PRODUCT, OPTION);
    const dt = Date.now() - t0;
    const sane = r.outcome === 'success' && r.price > 0 && typeof r.stock === 'string';
    if (sane) {
      ok++;
      prices.push(r.price);
    }
    console.log(
      `#${i} ${r.outcome} price=${r.price} stock=${r.stock} attempts=${r.attempts.length} ${dt}ms` +
        (sane ? '' : `  DETAIL: ${JSON.stringify(r.attempts)}`)
    );
  }
  console.log(`\n${ok}/${RUNS} clean successes. prices seen: ${[...new Set(prices)].join(', ')}`);

  // Forced failure: nonexistent product + bogus option must resolve (not throw)
  // to a clean { outcome:'failed', price:null, stock:null } with errorDetail.
  console.log('\nForced-failure tests (must resolve failed, never throw):');
  for (const [p, o] of [['99999999', 'o1'], [PRODUCT, 'nope']]) {
    try {
      const r = await scrapeProduct(p, o);
      console.log(
        `scrapeProduct(${p}, ${o}) -> outcome=${r.outcome} price=${r.price} stock=${r.stock} ` +
          `attempts=${r.attempts.map((a) => `${a.attemptNumber}:${a.outcome}`).join(',')} ` +
          `detail=${JSON.stringify(r.attempts[r.attempts.length - 1].errorDetail)}`
      );
    } catch (e) {
      console.log(`THREW (bad): ${e.message}`);
      process.exitCode = 1;
    }
  }

  // Search sanity
  const { searchStore } = require('../store-client');
  const res = await searchStore('camera');
  console.log(`\nsearchStore('camera') -> ${res.length} results, first: ${JSON.stringify(res[0])}`);
  if (ok < RUNS) {
    console.log('\nNote: <100% success is EXPECTED occasionally (store 429s/slowness) — retries must have engaged.');
  }
})();
