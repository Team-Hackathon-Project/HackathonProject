/**
 * Drives the target suggester in a real browser, offline.
 *
 *   npm run e2e:targets
 *
 * Serves a quote page whose price it can vary between scans, so the price
 * history genuinely accumulates and the suggestion moves with it. No model is
 * involved: this is arithmetic on the user's own data, and the point is to
 * prove it survives the round trip through the options page, the worker and
 * `chrome.storage.local`.
 */
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, stageExtension, launch, serviceWorker, popupDriver, sleep, SCAN_SETTLED } from './harness.mjs';

const PORT = Number(process.env.PORT || 8732);
const OUT = path.join(ROOT, 'e2e', 'shots-targets');
mkdirSync(OUT, { recursive: true });

const log = (...args) => console.log('[targets]', ...args);
const report = { steps: [], errors: [] };
const fail = (message) => { report.errors.push(message); log('FAIL:', message); };

// The page reports whatever price the harness last set, so a "scan" can be
// repeated at different prices the way a real quote would drift.
let price = 100;
const page = (value) => `<!doctype html><html><head><title>NVDA</title></head><body><main>
  <h1>NVDA</h1>
  <div data-testid="qsp-price">$${value.toFixed(2)}</div>
  <div data-testid="qsp-price-change-percent">(+0.50%)</div>
  <table><tr><td>Volume</td><td>1,000,000</td></tr></table>
</main></body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(price));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const extensionDir = stageExtension(['http://localhost/*']);
const browser = await launch(extensionDir, 'market-scraper-e2e-targets');

try {
  const { worker: sw, extensionId } = await serviceWorker(browser);

  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await sleep(600);

  // A position on automatic, with no targets set yet.
  await options.evaluate(async () => {
    await chrome.storage.local.set({ portfolio: { NVDA: { shares: 10, avg_cost: 90, auto_targets: true } } });
  });

  const quote = await browser.newPage();
  await quote.setViewport({ width: 1000, height: 700 });
  await quote.goto(`http://localhost:${PORT}/quote/NVDA`, { waitUntil: 'domcontentloaded' });
  await quote.bringToFront();
  await sleep(500);

  const popup = await popupDriver(browser, sw, { tabUrlPattern: 'http://localhost/*' });
  const scanAt = async (value) => {
    price = value;
    await quote.reload({ waitUntil: 'domcontentloaded' });
    await sleep(400);
    await popup.evaluate("document.getElementById('scrape-btn').click()");
    if (!(await popup.waitFor(SCAN_SETTLED))) fail(`the scan at ${value} never settled`);
    await sleep(1200);
  };

  const readState = async () => options.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return { position: (all.portfolio || {}).NVDA, history: (all.price_history || {}).NVDA || [] };
  });

  // 1. one scan: too little history, so it anchors on the average cost of 90
  await sleep(1000);
  await scanAt(100);
  let state = await readState();
  report.steps.push({ step: 'first-scan', ...state.position, points: state.history.length });
  log('after 1 scan:', JSON.stringify({ ...state.position, points: state.history.length }));
  if (state.history.length !== 1) fail(`expected 1 price point, got ${state.history.length}`);
  if (state.position.target_buy_below !== 85.5 || state.position.target_sell_above !== 94.5) {
    fail(`expected the cost-anchored 85.5/94.5, got ${state.position.target_buy_below}/${state.position.target_sell_above}`);
  }

  // 2. four scans at a spread of prices: history takes over as the anchor
  for (const value of [110, 90, 105, 95]) await scanAt(value);
  state = await readState();
  report.steps.push({ step: 'after-history', ...state.position, points: state.history.length });
  log('after 5 scans:', JSON.stringify({ ...state.position, points: state.history.length }));
  if (state.history.length !== 5) fail(`expected 5 price points, got ${state.history.length}`);

  const mean = state.history.reduce((sum, p) => sum + p.price, 0) / state.history.length;
  const mid = (state.position.target_buy_below + state.position.target_sell_above) / 2;
  if (Math.abs(mid - mean) > 0.05) fail(`the band should straddle the mean ${mean.toFixed(2)}, got a midpoint of ${mid}`);
  if (!(state.position.target_buy_below < state.position.target_sell_above)) fail('buy target is not below the sell target');
  if (state.position.shares !== 10 || state.position.avg_cost !== 90) fail('the rest of the position was disturbed');
  log(`band straddles the ${mean.toFixed(2)} mean of the scans — buy < ${state.position.target_buy_below}, sell > ${state.position.target_sell_above}`);

  // 3. turning automatic off must freeze them
  await options.evaluate(async () => {
    const all = await chrome.storage.local.get('portfolio');
    all.portfolio.NVDA.auto_targets = false;
    all.portfolio.NVDA.target_buy_below = 1;
    all.portfolio.NVDA.target_sell_above = 999;
    await chrome.storage.local.set({ portfolio: all.portfolio });
  });
  await scanAt(200);
  state = await readState();
  report.steps.push({ step: 'manual', ...state.position });
  log('after switching to manual:', JSON.stringify(state.position));
  if (state.position.target_buy_below !== 1 || state.position.target_sell_above !== 999) {
    fail('a manual position was rewritten by a scan');
  }

  // 4. the options page can propose without saving
  await options.reload({ waitUntil: 'load' });
  await sleep(600);
  const proposed = await options.evaluate(async () => {
    document.getElementById('pos-ticker').value = 'NVDA';
    document.getElementById('suggest-targets').click();
    await new Promise((r) => setTimeout(r, 1500));
    return {
      buy: document.getElementById('pos-buy').value,
      sell: document.getElementById('pos-sell').value,
      status: document.getElementById('position-status').textContent,
    };
  });
  report.steps.push({ step: 'suggest-button', ...proposed });
  log('Suggest targets ->', JSON.stringify(proposed));
  if (!proposed.buy || !proposed.sell) fail('the Suggest button did not fill the boxes');
  if (!/scans averaging/.test(proposed.status)) fail(`expected the note to cite the scans, got: ${proposed.status}`);

  const untouched = await readState();
  if (untouched.position.target_buy_below !== 1) fail('the suggestion wrote to storage; it must only fill the form');

  await options.screenshot({ path: path.join(OUT, '1-options-suggested.png'), fullPage: true });
  report.errors.push(...popup.errors);
} catch (error) {
  report.errors.push('FATAL: ' + (error && error.stack ? error.stack : String(error)));
  log('FATAL', error);
} finally {
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
  log(report.errors.length ? `FAILED (${report.errors.length})` : 'all checks passed');
  await browser.close();
  server.close();
  process.exitCode = report.errors.length ? 1 : 0;
}
