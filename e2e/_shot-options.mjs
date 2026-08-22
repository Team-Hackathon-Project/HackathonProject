/** Throwaway: full-page screenshot of the options page with realistic data. */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, stageExtension, launch, serviceWorker, sleep } from './harness.mjs';

const OUT = process.env.SHOT_DIR;
mkdirSync(OUT, { recursive: true });

const FIXTURE = {
  settings: {
    provider: 'anthropic',
    providers: { anthropic: { apiKey: 'sk-ant-demo-key-not-real-000', model: 'claude-opus-5' }, groq: { apiKey: '', model: 'openai/gpt-oss-120b' } },
    selfHealEnabled: true, llmAdviceEnabled: true, maxSnippetChars: 12000,
    monitorEnabled: true, monitorIntervalMinutes: 15,
  },
  watchlist: {
    AAPL: { ticker: 'AAPL', source_url: 'https://stockanalysis.com/stocks/aapl/', monitor: true },
    MSFT: { ticker: 'MSFT', source_url: 'https://finance.yahoo.com/quote/MSFT', monitor: true },
    NVDA: { ticker: 'NVDA', source_url: 'https://stockanalysis.com/stocks/nvda/', monitor: true },
  },
  portfolio: {
    AAPL: { shares: 12, avg_cost: 190, target_buy_below: 200, target_sell_above: 250, auto_targets: false },
    MSFT: { shares: 4, avg_cost: 380, target_buy_below: 360, target_sell_above: 430, auto_targets: true },
  },
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

const dir = stageExtension([]);
const browser = await launch(dir, 'options-shot');
try {
  const { extensionId } = await serviceWorker(browser);
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate((f) => chrome.storage.local.set(f), FIXTURE);
  await page.reload({ waitUntil: 'load' });
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, 'options-fold.png') });
  for (const id of ['agent', 'targets', 'access', 'registry', 'repairs']) {
    await page.click(`a[href="#${id}"]`);
    await sleep(450);
    await page.screenshot({ path: path.join(OUT, `panel-${id}.png`), fullPage: true });
  }
  console.log('shots written to', OUT);
} finally {
  await browser.close().catch(() => {});
}
