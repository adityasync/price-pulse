// Headed-debug runner for the recording deliverable.
// Transport is HTTP (see store-client.js recon note), so "headed" here means
// a watched live run with verbose console output: one normal run plus one
// deliberately failing run showing the retry path engaging.
// Usage: npm run scrape:headed
require('dotenv').config();
const { scrapeProduct } = require('../scraper');

(async () => {
  const productId = process.env.DEMO_PRODUCT_ID || '2321';
  const optionId = process.env.DEMO_OPTION_ID || 'o1';

  console.log(`[headed] normal run: scrapeProduct(${productId}, ${optionId})`);
  console.log(JSON.stringify(await scrapeProduct(productId, optionId), null, 2));

  console.log('\n[headed] failing run (bogus option — watch retries engage):');
  console.log(JSON.stringify(await scrapeProduct(productId, 'bogus-option'), null, 2));
})();
