/**
 * The Bright Data path, end to end, against the real service.
 *
 *   npm run e2e:brightdata
 *   npm run e2e:brightdata -- --url https://finance.yahoo.com/quote/AAPL --ticker AAPL
 *
 * Six stages, in the order a demo would run them:
 *
 *   1. The endpoint parses, and Bright Data accepts the credentials.
 *   2. A quote page loads through the Scraping Browser and yields a snapshot.
 *   3. A page whose shipped selector is known to be dead is *repaired* — the
 *      model proposes a selector, it is validated inside the remote page, and
 *      the value that comes back parses as a price.
 *   4. The repair is persisted, and the next pass uses it without a model call.
 *   5. The loopback bridge serves the same scrape to the extension's shape.
 *   6. A real Chrome with the real unpacked extension drives that bridge from
 *      its own service worker, and the reading lands in its own storage.
 *
 * Needs a Bright Data endpoint in `.env`. Stage 3 additionally needs a model
 * key; without one the run says so and skips it rather than reporting a pass.
 *
 * This costs real Bright Data minutes and real model tokens. It is not part of
 * `npm test`.
 */
import { loadAgentConfig, loadAgentEnv } from '../agent/config.mjs';
import { connectBrightData } from '../agent/brightdata.mjs';
import { scrapeThroughBrightData, defaultQuoteUrl } from '../agent/scrape.mjs';
import { getRegistry, getHealLog, forgetHealedSelector } from '../agent/registry.mjs';
import { startBridge } from '../agent/server.mjs';
import { bridgeRoutes } from '../src/lib/brightdata.js';
import { stageExtension, launch, serviceWorker, sleep } from './harness.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const log = (...args) => console.log('[brightdata]', ...args);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] || fallback);
}

const TICKER = (arg('ticker', 'AAPL') || 'AAPL').toUpperCase();
const HEALTHY_URL = arg('url', defaultQuoteUrl(TICKER));

/**
 * A page the shipped registry deliberately cannot read.
 *
 * `src/lib/selectors.js` records that Google Finance Beta rewrote its markup
 * and that the remaining hooks resolve to the market-summary rail rather than
 * the instrument — so the price there is left to healing on purpose. That makes
 * it the honest test of the repair path: nothing has been sabotaged for the
 * demo, the selector is simply out of date, which is the situation the whole
 * mechanism exists for.
 */
const HEAL_URL = arg('heal-url', `https://www.google.com/finance/quote/${TICKER}:NASDAQ`);

const OUT_DIR = path.join(process.cwd(), 'e2e', 'shots-brightdata');
const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
};

loadAgentEnv();
const config = loadAgentConfig();
let bridge = null;
let browser = null;
let extensionDir = null;

try {
  /* 1. Credentials ---------------------------------------------------- */
  if (!config.endpoint.ok) {
    record('endpoint configured', false, config.endpoint.error);
    throw new Error('nothing else can run without an endpoint');
  }
  log(`endpoint: ${config.summary.brightdata.redacted}`);
  log(`zone: ${config.endpoint.zone} · customer: ${config.endpoint.customer}`);
  log(`self-healing: ${config.llm.apiKey ? `${config.llm.provider} · ${config.summary.llm.model}` : 'OFF (no model key in .env)'}`);

  const session = await connectBrightData({ endpoint: config.endpoint.endpoint, log: (line) => log(` ${line}`) });
  const version = await session.version().catch(() => 'unknown');
  await session.close();
  record('Bright Data accepts the credentials', true, `remote browser is ${version}`);

  /* 2. A real page ---------------------------------------------------- */
  log(`scraping ${HEALTHY_URL}`);
  const healthy = await scrapeThroughBrightData({ url: HEALTHY_URL, ticker: TICKER, config, log: (line) => log(` ${line}`) });
  record(
    'a quote page yields a usable snapshot',
    healthy.ok && Number.isFinite(healthy.snapshot.current_price),
    healthy.ok ? `${healthy.ticker} at ${healthy.snapshot.current_price} ${healthy.snapshot.currency} in ${healthy.duration_ms}ms` : healthy.error,
  );
  record(
    'the CAPTCHA solver was reachable',
    Boolean(healthy.captcha && (healthy.captcha.status || healthy.captcha.error === null)),
    healthy.captcha ? `status: ${healthy.captcha.status || 'none reported'}` : 'not attempted',
  );

  /* 3. A page that needs repairing ------------------------------------ */
  let healed = null;
  if (!config.llm.apiKey) {
    record('a broken selector is repaired', false, 'SKIPPED — no model key in .env, so there is nothing to repair with');
  } else {
    // A previous run will have healed this host already, and a repair that is
    // already in the registry is not a repair this run performed. Forgetting it
    // puts the check back on a fresh-install footing rather than letting an
    // earlier success stand in for this one.
    const healHost = new URL(HEAL_URL).host;
    if (forgetHealedSelector(healHost, 'price')) {
      log(`forgot the stored ${healHost} price selector, so the repair path is exercised for real`);
    }

    log(`scraping ${HEAL_URL} — the shipped price selector for this host is out of date`);
    const attemptsBefore = getHealLog().filter((event) => event.field === 'price').length;
    healed = await scrapeThroughBrightData({ url: HEAL_URL, ticker: TICKER, config, log: (line) => log(` ${line}`) });
    const priceHeal = (healed.healed || []).find((entry) => entry.field === 'price');
    log(`price repair attempts this pass: ${getHealLog().filter((event) => event.field === 'price').length - attemptsBefore}`);
    // A consent or login wall is a condition of the run, not a verdict on the
    // repair path: the page that loaded had no quote on it to repair. Reported
    // as itself so nobody reads it as a broken healer.
    if (healed.requested_url) {
      record('a broken selector is repaired inside the remote page', false, `SKIPPED — ${healed.error}`);
    } else {
      record(
        'a broken selector is repaired inside the remote page',
        Boolean(priceHeal) && healed.ok,
        priceHeal ? `price -> ${priceHeal.strategy}: ${priceHeal.selector} (value ${healed.snapshot.current_price})` : (healed.error || 'nothing was repaired'),
      );
    }

    /* 4. And the repair sticks ---------------------------------------- */
    const host = healed.host;
    const stored = (getRegistry()[host] || {}).price;
    record(
      'the repair is persisted for the next pass',
      Boolean(stored && priceHeal && stored.selector === priceHeal.selector),
      stored ? `${host} price = ${stored.selector}` : `nothing stored for ${host}`,
    );

    if (stored) {
      log('scraping the same page again — the healed selector should carry it with no model call');
      const before = getHealLog().filter((event) => event.field === 'price').length;
      const again = await scrapeThroughBrightData({ url: HEAL_URL, ticker: TICKER, config, log: () => {} });
      const priceSelector = again.snapshot && again.snapshot.selectors_used.price_selector;
      const priceAttempts = getHealLog().filter((event) => event.field === 'price').length - before;
      record(
        'the second pass reuses the repair rather than re-buying it',
        again.ok && priceSelector === stored.selector && priceAttempts === 0,
        priceSelector ? `used ${priceSelector}; ${priceAttempts} price repair call(s)` : (again.error || 'no price selector recorded'),
      );
    }
  }

  /* 5. The bridge the extension uses ---------------------------------- */
  bridge = await startBridge(config);
  const routes = bridgeRoutes(config.bridge.url);
  const headers = config.bridge.token ? { 'x-bridge-token': config.bridge.token } : {};

  const health = await (await fetch(routes.health, { headers })).json();
  record(
    'the bridge reports itself ready, with no secret in the payload',
    health.ok === true && !JSON.stringify(health).includes(config.endpoint.password),
    `protocol ${health.protocol} · ${health.brightdata.description}`,
  );

  const viaBridge = await (await fetch(routes.scrape, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ ticker: TICKER }),
  })).json();
  record(
    'the bridge returns the snapshot shape the extension stores',
    viaBridge.ok === true && typeof viaBridge.snapshot.current_price === 'number' && viaBridge.method === 'brightdata',
    viaBridge.ok ? `${viaBridge.ticker} at ${viaBridge.snapshot.current_price} in ${viaBridge.duration_ms}ms` : viaBridge.error,
  );

  /* 6. The extension actually using it -------------------------------- */
  // Everything above proves the agent works. This proves the *extension* can
  // reach it: a real Chrome with the real unpacked extension, the real service
  // worker making the bridge call, and the result landing in the real storage.
  extensionDir = stageExtension(['http://127.0.0.1/*', 'http://localhost/*']);
  // A remote-browser scrape has been seen to take 90s end to end.
  browser = await launch(extensionDir, 'market-scraper-e2e-brightdata', { protocolTimeout: 240000 });
  const { extensionId } = await serviceWorker(browser);
  const page = await browser.newPage();
  // An uncaught exception on the options page does not fail a `page.evaluate`,
  // so it has to be collected deliberately or it goes unnoticed.
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await sleep(600);

  await page.evaluate(async (settings) => {
    await chrome.storage.local.set({ settings });
  }, {
    provider: config.llm.provider,
    providers: {
      anthropic: { apiKey: config.llm.provider === 'anthropic' ? config.llm.apiKey : '', model: '' },
      groq: { apiKey: config.llm.provider === 'groq' ? config.llm.apiKey : '', model: config.llm.model || '' },
    },
    selfHealEnabled: true,
    brightdata: { enabled: true, bridgeUrl: config.bridge.url, token: config.bridge.token, mode: 'first' },
  });
  await page.reload({ waitUntil: 'load' });
  await sleep(600);

  const bridgeProbe = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'TEST_BRIDGE', payload: {} }));
  record(
    'the extension reaches the agent from its service worker',
    Boolean(bridgeProbe && bridgeProbe.ok && bridgeProbe.data && bridgeProbe.data.ok),
    bridgeProbe && bridgeProbe.ok
      ? bridgeProbe.data.health.brightdata.description
      : ((bridgeProbe && bridgeProbe.error) || 'no answer'),
  );

  const fromExtension = await page.evaluate(
    (ticker) => chrome.runtime.sendMessage({ type: 'SCRAPE_VIA_BRIDGE', payload: { ticker } }),
    TICKER,
  );
  record(
    'a scrape driven from the extension returns a usable snapshot',
    Boolean(fromExtension && fromExtension.ok && fromExtension.data.usable),
    fromExtension && fromExtension.ok
      ? `${fromExtension.data.snapshot.ticker} at ${fromExtension.data.snapshot.current_price} via ${fromExtension.data.method}`
      : ((fromExtension && fromExtension.error) || 'no answer'),
  );

  const stored = await page.evaluate(() => chrome.storage.local.get(['snapshots', 'watchlist', 'selector_registry']));
  record(
    'the reading is written to the extension\'s own storage, as a tab scan would be',
    Boolean(stored.snapshots && stored.snapshots[TICKER] && stored.watchlist[TICKER]
      && stored.watchlist[TICKER].last_method === 'brightdata'),
    stored.snapshots && stored.snapshots[TICKER]
      ? `snapshots.${TICKER} = ${stored.snapshots[TICKER].current_price}, watchlist method = ${stored.watchlist[TICKER].last_method}`
      : 'nothing was stored',
  );

  record('the options page raised no exceptions', pageErrors.length === 0, pageErrors.join(' | ') || 'clean');

  // `page.click` waits on an intersection check in the page, which hangs when
  // the tab is not the frontmost one — a backgrounded renderer is throttled and
  // the CDP call never returns. Focus it, then click through the DOM directly.
  await page.bringToFront().catch(() => {});
  await page.evaluate(() => {
    const link = document.querySelector('a[href="#brightdata"]');
    if (link) link.click();
  });
  await sleep(400);
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(OUT_DIR, 'options-brightdata.png'), fullPage: true });

  /* Artefacts --------------------------------------------------------- */
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'result.json'), `${JSON.stringify({
    ran_at: new Date().toISOString(),
    zone: config.endpoint.zone,
    endpoint: config.summary.brightdata.redacted,
    checks,
    healthy,
    healed,
    registry: getRegistry(),
    heal_log: getHealLog().slice(0, 10),
  }, null, 2)}\n`);
  log(`wrote ${path.join('e2e', 'shots-brightdata', 'result.json')}`);
} catch (error) {
  record('run completed', false, String((error && error.message) || error));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (bridge) await new Promise((resolve) => bridge.close(resolve));
  const failures = checks.filter((check) => !check.ok);
  log(`${checks.length - failures.length}/${checks.length} checks passed`);
  process.exitCode = failures.length ? 1 : 0;
}
