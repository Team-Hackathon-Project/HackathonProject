/**
 * The real thing: a live quote page, a real key, real model calls.
 *
 *   npm run e2e:live
 *   npm run e2e:live -- https://finance.yahoo.com/quote/AAPL/
 *
 * The key comes from `.env` (see `.env.example`) — never from the command line,
 * so it stays out of your shell history. Nothing here prints it.
 *
 * The default page is stockanalysis.com because its `change_percentage` hook is
 * genuinely stale: the shipped selector misses, which forces a real repair. So
 * one run exercises the whole loop end to end — scrape, fail, sanitize, ask the
 * model, validate the answer in the live DOM, persist it, then write an
 * advisory from the model rather than the local rules engine.
 *
 * This spends tokens. It is one scan: a repair call per broken field, plus one
 * advisory.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, stageExtension, launch, serviceWorker, popupDriver, sleep,
  credentialsFromEnv, describeKey, READ_POPUP, SCAN_SETTLED,
} from './harness.mjs';

const url = process.argv[2] || 'https://stockanalysis.com/stocks/aapl/';
const origin = new URL(url).origin;
const OUT = path.join(ROOT, 'e2e', 'shots-live');
mkdirSync(OUT, { recursive: true });

const log = (...args) => console.log('[live]', ...args);
const report = { url, steps: [], errors: [] };
const fail = (message) => { report.errors.push(message); log('FAIL:', message); };

const { provider, apiKey, model } = credentialsFromEnv();
if (!apiKey) {
  console.error([
    'No API key found.',
    '',
    '  cp .env.example .env',
    '  # then paste your key into GROQ_API_KEY (or ANTHROPIC_API_KEY)',
    '',
    'That file is gitignored and is never packaged.',
  ].join('\n'));
  process.exit(1);
}

log(`provider: ${provider} · model: ${model || '(provider default)'} · key: ${describeKey(apiKey)}`);
log('page:', url);

const extensionDir = stageExtension([`${origin}/*`]);
const browser = await launch(extensionDir, 'market-scraper-e2e-live');

try {
  const { worker: sw, extensionId } = await serviceWorker(browser);

  // 1. seed the key the way the options page would
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await sleep(600);
  await options.evaluate(async (id, key, chosenModel) => {
    const current = (await chrome.storage.local.get('settings')).settings || {};
    const providers = { ...(current.providers || {}) };
    providers[id] = { ...(providers[id] || {}), apiKey: key };
    if (chosenModel) providers[id].model = chosenModel;
    await chrome.storage.local.set({
      settings: { ...current, provider: id, providers, selfHealEnabled: true, llmAdviceEnabled: true },
    });
  }, provider, apiKey, model);

  // 2. the key answers at all — fail fast and clearly if not
  const probe = await options.evaluate(async () => chrome.runtime.sendMessage({ type: 'TEST_PROVIDER', payload: {} }));
  if (!probe || !probe.ok) {
    fail(`the provider rejected the key or the model: ${(probe && probe.error) || 'no response'}`);
    throw new Error('stopping before spending a scan on a key that does not work');
  }
  log(`connection ok — ${probe.data.label} answered as ${probe.data.model} in ${probe.data.ms} ms`);
  report.probe = probe.data;

  // 3. the real scan
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront();
  await sleep(Number(process.env.SETTLE_MS || 2500));
  await page.screenshot({ path: path.join(OUT, '1-quote-page.png') });

  const popup = await popupDriver(browser, sw);
  await sleep(1200);
  await popup.evaluate("document.getElementById('scrape-btn').click()");
  if (!(await popup.waitFor(SCAN_SETTLED, 120000))) fail('the scan never settled');
  await sleep(4000);
  await popup.screenshot(path.join(OUT, '2-popup-scanned.png'));

  const state = await popup.evaluate(READ_POPUP);
  report.steps.push({ step: 'scan', ...state });
  log('popup state:', JSON.stringify(state, null, 2));

  // 4. what a real run has to show for itself
  if (!state.snapshotVisible) fail('no snapshot card appeared');
  if (!state.adviceVisible) fail('no advisory card appeared');
  if (state.source && /Local rules engine/.test(state.source)) {
    fail(`the advisory came from the rules engine, not the model: ${state.source}`);
  }
  if (!['BUY', 'SELL', 'HOLD'].includes(state.action)) fail(`unexpected action: ${state.action}`);

  const stored = await options.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return { registry: all.selector_registry || {}, healLog: all.heal_log || [], snapshots: all.snapshots || {} };
  });
  report.storage = stored;

  const attempts = stored.healLog.length;
  const repaired = stored.healLog.filter((entry) => entry.healed);
  const refused = stored.healLog.filter((entry) => !entry.healed);
  log(`repair attempts: ${attempts} — ${repaired.length} accepted, ${refused.length} refused`);
  for (const entry of stored.healLog) {
    log(`  ${entry.healed ? 'OK  ' : 'NO  '} ${entry.field} → ${entry.proposed || '(none)'}${entry.healed ? '' : ` — ${entry.error}`}`);
    if (entry.reason) log(`       model said: ${entry.reason}`);
  }
  log('registry now:', JSON.stringify(stored.registry));
  log('snapshot:', JSON.stringify(Object.values(stored.snapshots)[0] || null));

  if (!attempts) {
    log('note: nothing needed repairing on this page — the shipped selectors all held.');
  } else if (!repaired.length) {
    fail('every repair attempt failed; the model never produced a usable selector');
  }

  await popup.screenshot(path.join(OUT, '3-final.png'));
  report.errors.push(...popup.errors);
} catch (error) {
  report.errors.push('FATAL: ' + (error && error.stack ? error.stack : String(error)));
  log('FATAL', error);
} finally {
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
  log(report.errors.length ? `FAILED (${report.errors.length})` : 'all checks passed');
  await browser.close();
  process.exitCode = report.errors.length ? 1 : 0;
}
