/**
 *   npm run e2e:studio
 *
 * Proves the extension itself uses Bright Data Scraper Studio: the options page
 * asks the service worker, the worker asks the agent, the agent runs the real
 * published collector, and the row lands in the extension's own storage.
 *
 * Nothing is stubbed. This spends collector page loads.
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, stageExtension, launch, serviceWorker, sleep } from './harness.mjs';
import { startBridge } from '../agent/server.mjs';
import { loadAgentConfig, loadAgentEnv } from '../agent/config.mjs';

const log = (...a) => console.log('[studio-ext]', ...a);
const BRIDGE = 'http://127.0.0.1:8791';

loadAgentEnv();
const config = loadAgentConfig();
log('collector configured:', config.summary.studio.configured, '·', config.summary.studio.collector || config.summary.studio.error);

const bridge = await startBridge(config);
// The loopback origin is granted at install rather than requested at runtime:
// chrome.permissions.request() needs a user gesture, which page.evaluate has no
// way to supply, so it hangs on a prompt nobody can click.
const extensionDir = stageExtension(['http://127.0.0.1/*', 'http://localhost/*']);
const browser = await launch(extensionDir, 'studio-in-extension', { protocolTimeout: 300000 });
let failed = false;

try {
  const { extensionId } = await serviceWorker(browser);
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await sleep(800);

  // Grant the loopback origin and switch Bright Data on, the way the options
  // page does when a person clicks through it.
  const ready = await page.evaluate(async (bridgeUrl) => {
    const granted = await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }).catch(() => false);
    const current = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({
      settings: { ...current, brightdata: { ...(current.brightdata || {}), enabled: true, bridgeUrl } },
    });
    return { granted };
  }, BRIDGE);
  log('loopback origin granted:', ready.granted);

  log('asking the extension to collect AAPL through Scraper Studio…');
  const answer = await page.evaluate(async () => {
    const started = Date.now();
    const response = await chrome.runtime.sendMessage({
      type: 'SCRAPE_VIA_STUDIO',
      payload: { ticker: 'AAPL' },
    });
    return { ...response, roundTripMs: Date.now() - started };
  });

  if (!answer || !answer.ok) {
    failed = true;
    log('FAIL:', (answer && answer.error) || 'no response from the service worker');
  } else {
    const d = answer.data;
    log(`PASS: ${d.snapshot.ticker} at ${d.snapshot.current_price} ${d.snapshot.currency} via ${d.method}`);
    log(`      collector ${d.collector} · snapshot ${d.collection_id} · ${Math.round((d.duration_ms || 0) / 1000)}s`);

    const stored = await page.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return {
        snapshot: (all.snapshots || {}).AAPL || null,
        watch: (all.watchlist || {}).AAPL || null,
        history: ((all.price_history || {}).AAPL || []).length,
      };
    });

    const checks = [
      ['the row is stored as a snapshot', stored.snapshot && stored.snapshot.current_price > 0],
      ['it is marked as coming from the collector', stored.watch && stored.watch.last_method === 'scraper-studio'],
      ['it appends to the price history', stored.history >= 1],
      ['the method is reported to the caller', d.method === 'scraper-studio'],
      ['a traceable snapshot id comes back', Boolean(d.collection_id)],
    ];
    for (const [label, ok] of checks) {
      log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
      if (!ok) failed = true;
    }

    writeFileSync(
      'studio-extension-result.json',
      `${JSON.stringify({ ran_at: new Date().toISOString(), answer: d, stored }, null, 2)}\n`,
    );
    log('wrote studio-extension-result.json');
  }
} catch (error) {
  failed = true;
  log('FATAL', error);
} finally {
  await browser.close();
  await new Promise((resolve) => bridge.close(resolve));
  log(failed ? 'FAILED' : 'all checks passed');
  process.exitCode = failed ? 1 : 0;
}
