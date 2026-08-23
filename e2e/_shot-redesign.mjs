/**
 * Throwaway: screenshots every surface in the product, with realistic data.
 *
 *   SHOT_DIR=... node e2e/_shot-redesign.mjs
 *
 * The quote page is served from a local loopback fixture rather than a live
 * site, so the run is deterministic and needs no network and no API key.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { ROOT, stageExtension, launch, serviceWorker, popupDriver, sleep, SCAN_SETTLED } from './harness.mjs';

const OUT = process.env.SHOT_DIR || path.join(ROOT, 'e2e', 'shots-redesign');
mkdirSync(OUT, { recursive: true });

// A quote page whose markup the shipped generic selectors already understand,
// so the run needs no model key to produce a full reading.
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>NVDA — Quote</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:32px;background:#0b1020;color:#e6e9f2}
main{max-width:760px;margin:0 auto}h1{font-size:28px;margin:0 0 4px}
.price{font-size:44px;font-weight:700;color:#4ade80}nav,footer{opacity:.4}</style></head>
<body><nav>Home · Markets · Screener</nav><main>
<h1 data-testid="quote-symbol">NVDA</h1><p>NVIDIA Corporation · NASDAQ</p>
<section><div class="price" data-testid="quote-price">$182.44</div>
<div data-testid="quote-change-percent">+2.41%</div>
<table><tr><td>Volume</td><td data-testid="quote-volume">44,102,880</td></tr></table></section>
<section><article><h3><a href="/a">Nvidia lifts data-center guidance again</a></h3></article>
<article><h3><a href="/b">Supply constraints ease for Blackwell accelerators</a></h3></article></section>
</main><footer>&copy; Example Exchange</footer></body></html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const quoteUrl = `http://127.0.0.1:${port}/quote/NVDA`;

const DASHBOARD_FIXTURE = {
  settings: {
    provider: 'anthropic',
    providers: { anthropic: { apiKey: 'sk-ant-demo-key-not-real-000', model: 'claude-opus-5' }, groq: { apiKey: '', model: 'openai/gpt-oss-120b' } },
    selfHealEnabled: true, llmAdviceEnabled: true, maxSnippetChars: 12000,
    monitorEnabled: true, monitorIntervalMinutes: 15, watchlistSeeded: true,
    onboardingCompleted: true, onboardingStep: 4,
  },
  watchlist: {
    AAPL: { ticker: 'AAPL', source_url: 'https://stockanalysis.com/stocks/aapl/', monitor: true, last_refreshed_at: new Date().toISOString(), last_method: 'fetch' },
    MSFT: { ticker: 'MSFT', source_url: 'https://finance.yahoo.com/quote/MSFT', monitor: true, last_refreshed_at: new Date().toISOString(), last_method: 'tab' },
    NVDA: { ticker: 'NVDA', source_url: 'https://stockanalysis.com/stocks/nvda/', monitor: true, last_refreshed_at: new Date().toISOString(), last_method: 'brightdata' },
    TSLA: { ticker: 'TSLA', source_url: 'https://stockanalysis.com/stocks/tsla/', monitor: false, last_error: 'no price on that page' },
  },
  portfolio: {
    AAPL: { shares: 12, avg_cost: 190, target_buy_below: 200, target_sell_above: 250, auto_targets: false },
    MSFT: { shares: 4, avg_cost: 380, target_buy_below: 360, target_sell_above: 430, auto_targets: true },
    NVDA: { shares: 30, avg_cost: 120, target_buy_below: 150, target_sell_above: 200, auto_targets: false },
  },
  snapshots: {
    AAPL: { ticker: 'AAPL', current_price: 224.5, currency: 'USD', change_percentage: '+1.80%', change_value: 1.8, volume: 52300000, extracted_at: new Date().toISOString(), source_url: 'https://stockanalysis.com/stocks/aapl/', selectors_used: { price_selector: '[data-test="quote-price"]' }, news: ['Apple beats earnings expectations again'] },
    MSFT: { ticker: 'MSFT', current_price: 411.2, currency: 'USD', change_percentage: '-0.62%', change_value: -0.62, volume: 18400000, extracted_at: new Date().toISOString(), source_url: 'https://finance.yahoo.com/quote/MSFT', selectors_used: {} },
    NVDA: { ticker: 'NVDA', current_price: 182.44, currency: 'USD', change_percentage: '+2.41%', change_value: 2.41, volume: 44102880, extracted_at: new Date().toISOString(), source_url: 'https://stockanalysis.com/stocks/nvda/', selectors_used: { price_selector: '.qz-8f31ab' } },
  },
  price_history: {
    AAPL: Array.from({ length: 14 }, (_, i) => ({ at: new Date(Date.now() - i * 3600000).toISOString(), price: Number((224.5 - i * 1.2 + Math.sin(i) * 2).toFixed(2)), change_value: 1 })),
    MSFT: Array.from({ length: 12 }, (_, i) => ({ at: new Date(Date.now() - i * 3600000).toISOString(), price: Number((411.2 + i * 1.6 + Math.cos(i) * 3).toFixed(2)), change_value: -1 })),
    NVDA: Array.from({ length: 16 }, (_, i) => ({ at: new Date(Date.now() - i * 3600000).toISOString(), price: Number((182.44 - i * 0.9 + Math.sin(i / 2) * 4).toFixed(2)), change_value: 1 })),
  },
  alerts: [
    { id: 'a1', ticker: 'NVDA', title: 'NVDA crossed its sell target', body: '182.44 is above the 200 you set — up 2.41% today.', at: new Date(Date.now() - 240000).toISOString(), seen: false, direction: 'up' },
    { id: 'a2', ticker: 'MSFT', title: 'MSFT moved 3% since the last reading', body: 'Down from 424.10 to 411.20 since the previous scan.', at: new Date(Date.now() - 5400000).toISOString(), seen: true, direction: 'down' },
  ],
  decisions: [
    { ticker: 'NVDA', verdict: 'APPROVED', final_action: 'BUY', suggested_action: 'BUY', price: 178.2, decided_at: new Date(Date.now() - 86400000).toISOString() },
    { ticker: 'AAPL', verdict: 'REJECTED', final_action: 'NONE', suggested_action: 'SELL', price: 226.1, decided_at: new Date(Date.now() - 172800000).toISOString() },
  ],
  selector_registry: {
    'finance.yahoo.com': { price: { selector: '.qz-8f31ab', strategy: 'css', confidence: 0.93, source: 'healed', healed_at: new Date().toISOString() } },
    'stockanalysis.com': { change_percentage: { selector: '[data-test="chg"]', strategy: 'css', confidence: 0.88, source: 'healed', healed_at: new Date().toISOString() } },
  },
  heal_log: Array.from({ length: 6 }, (_, i) => ({
    field: i % 2 ? 'price' : 'volume', host: 'finance.yahoo.com', at: new Date(Date.now() - i * 3600000).toISOString(),
    healed: i % 3 !== 0, provider: 'anthropic', attempt: 1, proposed: '.qz-8f31ab', confidence: 0.9,
    reason: 'The price sits in a span carrying a data-testid hook.', value: '224.50',
  })),
};

const dir = stageExtension([`http://127.0.0.1/*`]);
const browser = await launch(dir, 'redesign-shot');
const problems = [];

try {
  const { worker: sw, extensionId } = await serviceWorker(browser);
  console.log('[shot] extension:', extensionId);

  /* --- The setup guide, fresh --------------------------------------- */
  const welcome = await browser.newPage();
  welcome.on('pageerror', (error) => problems.push(`welcome: ${error.message}`));
  welcome.on('console', (m) => { if (m.type() === 'error') problems.push(`welcome console: ${m.text()}`); });
  await welcome.setViewport({ width: 1280, height: 900 });
  await welcome.goto(`chrome-extension://${extensionId}/src/welcome.html`, { waitUntil: 'load' });
  await welcome.bringToFront();
  await sleep(700);
  for (let step = 0; step < 5; step++) {
    await welcome.screenshot({ path: path.join(OUT, `welcome-${step}.png`) });
    if (step === 2) {
      await welcome.click('#engine-model');
      await sleep(400);
      await welcome.screenshot({ path: path.join(OUT, 'welcome-2-model.png') });
    }
    if (step < 4) { await welcome.click('#next'); await sleep(650); }
  }

  /* --- The popup, against a real scan -------------------------------- */
  const quote = await browser.newPage();
  await quote.setViewport({ width: 1100, height: 800 });
  await quote.goto(quoteUrl, { waitUntil: 'domcontentloaded' });
  await quote.bringToFront();
  await sleep(700);

  // A key with model advisories switched off: the setup card stays out of the
  // way and the verdict comes from the local rules, so no network is touched.
  await sw.evaluate(() => chrome.storage.local.set({
    settings: {
      provider: 'anthropic',
      providers: { anthropic: { apiKey: 'sk-ant-demo-key-not-real-000', model: 'claude-opus-5' }, groq: { apiKey: '', model: 'openai/gpt-oss-120b' } },
      selfHealEnabled: true, llmAdviceEnabled: false, maxSnippetChars: 12000,
      onboardingCompleted: true, onboardingStep: 4,
    },
    portfolio: { NVDA: { shares: 30, avg_cost: 120, target_buy_below: 150, target_sell_above: 175, auto_targets: false } },
  }));

  const popup = await popupDriver(browser, sw);
  await sleep(1000);
  await popup.screenshot(path.join(OUT, 'popup-1-initial.png'));
  await popup.evaluate("document.getElementById('scrape-btn').click()");
  if (!(await popup.waitFor(SCAN_SETTLED, 40000))) problems.push('the scan never settled');
  await sleep(2500);
  await popup.screenshot(path.join(OUT, 'popup-2-scanned.png'));
  await popup.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(500);
  await popup.screenshot(path.join(OUT, 'popup-2b-actions.png'));
  await popup.evaluate('window.scrollTo(0, 0)');
  await sleep(300);
  await popup.evaluate("document.getElementById('approve-btn').click()");
  await sleep(600);
  await popup.screenshot(path.join(OUT, 'popup-3-modal.png'));
  await popup.evaluate("document.getElementById('modal-confirm').click()");
  await sleep(900);
  await popup.screenshot(path.join(OUT, 'popup-4-logged.png'));
  problems.push(...popup.errors);

  /* --- Settings and dashboard, with a full fixture -------------------- */
  const options = await browser.newPage();
  options.on('pageerror', (error) => problems.push(`options: ${error.message}`));
  options.on('console', (m) => { if (m.type() === 'error') problems.push(`options console: ${m.text()}`); });
  await options.setViewport({ width: 1280, height: 900 });
  await options.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await options.bringToFront();
  await sleep(400);
  await options.evaluate((f) => chrome.storage.local.set(f), DASHBOARD_FIXTURE);
  await options.reload({ waitUntil: 'load' });
  await sleep(900);
  for (const id of ['start', 'dashboard', 'agent', 'targets', 'access', 'brightdata', 'registry', 'repairs']) {
    await options.click(`a[href="#${id}"]`);
    await sleep(400);
    await options.screenshot({ path: path.join(OUT, `options-${id}.png`), fullPage: true });
  }

  const dash = await browser.newPage();
  dash.on('pageerror', (error) => problems.push(`dashboard: ${error.message}`));
  dash.on('console', (m) => { if (m.type() === 'error') problems.push(`dashboard console: ${m.text()}`); });
  await dash.setViewport({ width: 1440, height: 950 });
  await dash.goto(`chrome-extension://${extensionId}/web/index.html`, { waitUntil: 'load' });
  await dash.bringToFront();
  await sleep(1600);
  await dash.screenshot({ path: path.join(OUT, 'dashboard-fold.png') });
  await dash.screenshot({ path: path.join(OUT, 'dashboard-full.png'), fullPage: true });
  await dash.evaluate(() => document.querySelector('.watch-card').click());
  await sleep(700);
  await dash.screenshot({ path: path.join(OUT, 'dashboard-drawer.png') });

  // The empty dashboard is the onboarding surface, so it is worth a look too.
  await dash.evaluate(() => chrome.storage.local.set({ watchlist: {}, snapshots: {}, alerts: [] }));
  await dash.reload({ waitUntil: 'load' });
  await sleep(1400);
  await dash.screenshot({ path: path.join(OUT, 'dashboard-empty.png'), fullPage: true });

  /* --- The same surfaces in light mode -------------------------------- */
  const light = [{ name: 'prefers-color-scheme', value: 'light' }];
  await dash.evaluate((f) => chrome.storage.local.set(f), DASHBOARD_FIXTURE);
  await dash.emulateMediaFeatures(light);
  await dash.reload({ waitUntil: 'load' });
  await dash.bringToFront();
  await sleep(1500);
  await dash.screenshot({ path: path.join(OUT, 'light-dashboard.png') });

  await options.emulateMediaFeatures(light);
  await options.reload({ waitUntil: 'load' });
  await options.bringToFront();
  await sleep(800);
  await options.click('a[href="#agent"]');
  await sleep(400);
  await options.screenshot({ path: path.join(OUT, 'light-options.png'), fullPage: true });

  await welcome.emulateMediaFeatures(light);
  await welcome.goto(`chrome-extension://${extensionId}/src/welcome.html`, { waitUntil: 'load' });
  await welcome.bringToFront();
  await sleep(700);
  await welcome.click('#next');
  await sleep(500);
  await welcome.click('#next');
  await sleep(500);
  await welcome.click('#engine-model');
  await sleep(400);
  await welcome.screenshot({ path: path.join(OUT, 'light-welcome.png') });

  console.log(problems.length ? `[shot] PROBLEMS:\n  ${problems.join('\n  ')}` : '[shot] no console errors on any surface');
  console.log('[shot] written to', OUT);
} finally {
  await browser.close().catch(() => {});
  server.close();
}
