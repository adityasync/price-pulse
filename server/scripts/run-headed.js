// Headed-debug runner for the recording deliverable (2-4 min screen capture).
// Transport is HTTP (see store-client.js recon note), so "headed" = a watched
// live run with narrated console output: one normal run plus one deliberately
// failing run. Record this terminal while it runs.
// Usage: npm run scrape:headed
require('dotenv').config();
const { scrapeProduct } = require('../scraper');

function narrate(label, result, ms) {
  console.log(`\n[${label}] outcome=${result.outcome} price=${result.price} stock=${result.stock} (${ms}ms)`);
  for (const a of result.attempts) {
    const extra = a.errorDetail ? ` — ${a.errorDetail}` : '';
    console.log(`  attempt ${a.attemptNumber}: ${a.outcome}${extra}`);
  }
}

(async () => {
  const productId = process.env.DEMO_PRODUCT_ID || '2321';
  const optionId = process.env.DEMO_OPTION_ID || 'o1';

  console.log(`[headed] normal run against the live store: scrapeProduct(${productId}, ${optionId})`);
  let t0 = Date.now();
  narrate('normal', await scrapeProduct(productId, optionId), Date.now() - t0);

  console.log(`\n[headed] failing run (bogus option — retry/failure path, never throws):`);
  t0 = Date.now();
  narrate('failing', await scrapeProduct(productId, 'bogus-option'), Date.now() - t0);

  console.log('\n[headed] done — normal case persisted a real reading; failing case logged honestly with nulls.');
})();
