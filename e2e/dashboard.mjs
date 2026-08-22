/**
 * Drives the real dashboard in a real browser, both ways it is served
 * (`npm run e2e:dashboard`).
 *
 * The two routes fail differently, and only a browser shows it:
 *
 *   chrome-extension://<id>/web/index.html   an extension page. If `web/` is
 *                                            missing from the bundle this is a
 *                                            blank tab, and nothing in the unit
 *                                            tests would notice.
 *
 *   http://localhost:<port>/                 a web page reaching the worker
 *                                            through externally_connectable.
 *                                            Nothing about that boundary is
 *                                            exercisable outside Chrome: the
 *                                            manifest match list, the external
 *                                            listener, and the allowlist all
 *                                            only exist at runtime.
 *
 * No API key and no network are needed — the run seeds storage directly and
 * asserts on what the dashboard renders from it.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, stageExtension, launch, serviceWorker, sleep } from './harness.mjs';

const SHOTS = path.join(ROOT, 'e2e', 'shots-dashboard');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/** The same static server `npm run web` runs, inline so the run is self-contained. */
function serveWeb() {
  const root = path.join(ROOT, 'web');
  const server = createServer(async (request, response) => {
    const name = (request.url || '/').split('?')[0];
    const file = path.join(root, name === '/' ? 'index.html' : `.${name}`);
    if (!path.resolve(file).startsWith(path.resolve(root))) {
      response.writeHead(403).end('no');
      return;
    }
    try {
      // Read before writing the header: a 200 sent first cannot be taken back
      // when the read turns out to fail.
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': `${TYPES[path.extname(file)] || 'text/plain'}; charset=utf-8`,
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Two tickers with enough price history that one of them charts. */
const FIXTURE = {
  snapshots: {
    AAPL: {
      ticker: 'AAPL', current_price: 224.5, currency: 'USD', change_percentage: '+1.80%',
      change_value: 1.8, volume: 52300000, news: ['Apple beats earnings expectations again'],
      extracted_at: new Date().toISOString(), source_url: 'https://stockanalysis.com/stocks/aapl/',
      selectors_used: { price_selector: '[data-testid="qsp-price"]' },
    },
    MSFT: {
      ticker: 'MSFT', current_price: 402.1, currency: 'USD', change_percentage: '-0.90%',
      change_value: -0.9, volume: 18400000, news: [],
      extracted_at: new Date().toISOString(), source_url: 'https://stockanalysis.com/stocks/msft/',
      selectors_used: {},
    },
  },
  price_history: {
    AAPL: [226, 224, 221, 219, 218, 215].map((price, index) => ({
      at: new Date(Date.now() - index * 3600000).toISOString(), price, change_value: 1,
    })),
    MSFT: [{ at: new Date().toISOString(), price: 402.1, change_value: -0.9 }],
  },
  portfolio: {
    AAPL: { shares: 12, avg_cost: 190, target_buy_below: 200, target_sell_above: 250, auto_targets: false },
  },
  decisions: [{
    ticker: 'AAPL', suggested_action: 'HOLD', final_action: 'BUY', verdict: 'OVERRIDDEN',
    price: 219, currency: 'USD', decided_at: new Date().toISOString(), executed: false,
  }],
  alert_rules: {
    AAPL: [
      { id: 'r-target', ticker: 'AAPL', kind: 'target', enabled: true, cooldown_minutes: 60 },
      {
        id: 'r-pct', ticker: 'AAPL', kind: 'percent', enabled: true, threshold: 5,
        direction: 'both', baseline: 'previous_scan', cooldown_minutes: 60,
      },
    ],
  },
  alerts: [{
    id: 'a1', rule_id: 'r-pct', ticker: 'AAPL', kind: 'percent',
    title: 'AAPL moved +5.20%', body: 'Now 224.50, against 213.40 - the previous reading.',
    direction: 'up', price: 224.5, currency: 'USD', at: new Date().toISOString(), seen: false,
  }],
};

/** What the page is showing, read back out of the live DOM. */
const readCards = () => Array.from(document.querySelectorAll('.watch-card')).map((card) => ({
  ticker: card.dataset.ticker,
  text: card.textContent,
  charted: Boolean(card.querySelector('svg')),
  zone: card.querySelector('.target') ? card.querySelector('.target').dataset.zone : null,
}));

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok    ${label}`);
    return 0;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  return 1;
};

async function run() {
  mkdirSync(SHOTS, { recursive: true });
  const { server, port } = await serveWeb();
  const extensionDir = stageExtension([]);
  const browser = await launch(extensionDir, 'market-scraper-dashboard');
  let failures = 0;

  try {
    const { extensionId } = await serviceWorker(browser);
    console.log(`[e2e] extension ${extensionId}`);

    // Storage is seeded from an extension page rather than from the worker:
    // the worker's isolated evaluation world does not expose `chrome.storage`,
    // and the options page is a real extension context that does.
    const options = await browser.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
    await sleep(400);
    // Seeded as snapshots only — the watchlist back-fill is part of what is
    // under test, so it is not handed to the dashboard ready-made.
    await options.evaluate((fixture) => chrome.storage.local.set(fixture), FIXTURE);

    /* -------------------------------------------------- *
     * Route 1: inside the extension
     * -------------------------------------------------- */
    console.log('\n[e2e] chrome-extension:// route');
    const inside = await browser.newPage();
    const errors = [];
    inside.on('pageerror', (error) => errors.push(String(error)));
    inside.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await inside.goto(`chrome-extension://${extensionId}/web/index.html`, { waitUntil: 'load' });
    await inside.waitForSelector('.watch-card', { timeout: 10000 });
    await sleep(300);

    const cards = await inside.evaluate(readCards);
    failures += check('both seeded tickers render', cards.length === 2, `saw ${cards.length}`);
    failures += check('the six-point series is charted', cards.find((c) => c.ticker === 'AAPL').charted);
    failures += check(
      'the one-point series is not charted',
      !cards.find((c) => c.ticker === 'MSFT').charted
    );
    failures += check(
      'the target band reads as HOLD at 224.50 between 200 and 250',
      cards.find((c) => c.ticker === 'AAPL').zone === 'hold'
    );
    failures += check(
      'open P/L is summarised for the held position',
      await inside.evaluate(() => document.querySelector('.summary').textContent.includes('Open P/L'))
    );
    failures += check('the page raised no errors', errors.length === 0, errors[0]);

    await inside.screenshot({ path: path.join(SHOTS, '01-extension-route.png') });

    // The drawer is the only place the scraped headline is shown.
    await inside.click('.watch-card[data-ticker="AAPL"]');
    await inside.waitForSelector('.drawer-panel', { timeout: 5000 });
    await sleep(400); // let the slide-in settle, or the shot catches it half-faded
    failures += check(
      'the drawer shows the headline and the selector that read the price',
      await inside.evaluate(() => {
        const text = document.querySelector('.drawer-panel').textContent;
        return text.includes('Apple beats earnings') && text.includes('qsp-price');
      })
    );
    failures += check(
      'the drawer lists the rules and offers to add one',
      await inside.evaluate(() => {
        const text = document.querySelector('.drawer-panel').textContent;
        return text.includes('Alert me when it')
          && text.includes('reaches your buy or sell target')
          && text.includes('moves 5%')
          && Boolean(document.querySelector('.rule-form'));
      })
    );
    await inside.screenshot({ path: path.join(SHOTS, '02-detail-drawer.png') });
    await inside.keyboard.press('Escape');

    /* -------------------------------------------------- *
     * Alerts
     * -------------------------------------------------- */
    console.log('\n[e2e] alerts');

    failures += check(
      'the seeded alert appears in the feed, marked unread',
      await inside.evaluate(() => {
        const row = document.querySelector('.alert-row');
        return Boolean(row) && row.dataset.seen === 'false' && row.textContent.includes('+5.20%');
      })
    );
    failures += check(
      'background monitoring is off until it is switched on',
      await inside.evaluate(() => document.getElementById('monitor-enabled').checked === false)
    );

    // Switching it on must actually schedule the alarm in the worker.
    await inside.click('label[for="monitor-enabled"]');
    await inside.waitForFunction(
      () => document.getElementById('monitor-enabled').checked === true,
      { timeout: 5000 }
    );
    await sleep(500);
    const alarm = await options.evaluate(() => chrome.alarms.get('market-scraper-monitor'));
    failures += check('switching monitoring on schedules the alarm', Boolean(alarm), JSON.stringify(alarm));
    await inside.screenshot({ path: path.join(SHOTS, '05-alerts.png') });

    // And reading them clears the badge.
    await inside.click('.feed-head button');
    await sleep(500);
    failures += check(
      'marking everything read clears the unread state',
      await inside.evaluate(() => {
        const row = document.querySelector('.alert-row');
        return Boolean(row) && row.dataset.seen === 'true';
      })
    );
    const badge = await options.evaluate(() => chrome.action.getBadgeText({}));
    failures += check('the toolbar badge clears with it', badge === '', `badge was "${badge}"`);

    /* -------------------------------------------------- *
     * The options page, which gained two sections
     * -------------------------------------------------- */
    console.log('\n[e2e] options page');
    const optionErrors = [];
    options.on('pageerror', (error) => optionErrors.push(String(error)));
    await options.reload({ waitUntil: 'load' });
    await sleep(600);

    failures += check(
      'the options page still renders, with the dashboard and access sections',
      await options.evaluate(() => Boolean(
        document.getElementById('open-dashboard')
        && document.getElementById('dashboard-origin')
        && document.getElementById('access-list')
      ))
    );
    failures += check(
      'site access lists the host the watchlist would need, ungranted',
      await options.evaluate(() => {
        const text = document.getElementById('access-list').textContent;
        return text.includes('stockanalysis.com') && text.includes('Grant');
      })
    );
    failures += check('the options page raised no errors', optionErrors.length === 0, optionErrors[0]);
    await options.screenshot({ path: path.join(SHOTS, '06-options-access.png') });

    /* -------------------------------------------------- *
     * Route 2: served as a website, over the external bus
     * -------------------------------------------------- */
    console.log('\n[e2e] http://localhost route');
    const site = await browser.newPage();
    const siteErrors = [];
    site.on('pageerror', (error) => siteErrors.push(String(error)));

    // No ?ext= yet: the page must say so rather than render an empty grid.
    await site.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
    await site.waitForSelector('.banner', { timeout: 10000 });
    failures += check(
      'an unconnected website explains itself',
      await site.evaluate(() => document.querySelector('.banner').textContent.includes('not reachable'))
    );
    await site.screenshot({ path: path.join(SHOTS, '03-not-connected.png') });

    // With the id, the same page comes up over externally_connectable.
    await site.goto(`http://localhost:${port}/?ext=${extensionId}`, { waitUntil: 'load' });
    await site.waitForSelector('.watch-card', { timeout: 10000 });
    await sleep(300);

    const siteCards = await site.evaluate(readCards);
    failures += check('the website renders the same watchlist', siteCards.length === 2);
    failures += check(
      'the id is remembered for next time',
      await site.evaluate(() => Boolean(localStorage.getItem('market-dashboard.extension-id')))
    );
    failures += check('the website raised no errors', siteErrors.length === 0, siteErrors[0]);
    await site.screenshot({ path: path.join(SHOTS, '04-website-route.png') });

    /* -------------------------------------------------- *
     * The boundary itself
     * -------------------------------------------------- */
    console.log('\n[e2e] the external boundary');

    const ask = (type, payload) => site.evaluate((id, t, p) => new Promise((resolve) => {
      chrome.runtime.sendMessage(id, { type: t, payload: p }, (response) => {
        resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response);
      });
    }), extensionId, type, payload);

    const denied = await ask('TEST_PROVIDER', { provider: 'anthropic', apiKey: 'sk-ant-probe' });
    failures += check(
      'a web page cannot reach TEST_PROVIDER',
      denied && denied.ok === false && /not available/.test(denied.error || ''),
      JSON.stringify(denied)
    );

    const scrape = await ask('SCRAPE_ACTIVE_TAB', {});
    failures += check(
      'a web page cannot drive the active-tab scrape',
      scrape && scrape.ok === false, JSON.stringify(scrape)
    );

    const state = await ask('GET_DASHBOARD_STATE', {});
    failures += check(
      'no credential is present anywhere in the state it can read',
      state && state.ok && !JSON.stringify(state.data).match(/sk-ant|gsk_|apiKey/),
    );

    // A write from the website has to actually land in the extension's store.
    await ask('ADD_WATCH', { ticker: 'NVDA' });
    const stored = await options.evaluate(async () => {
      const { watchlist } = await chrome.storage.local.get('watchlist');
      return Object.keys(watchlist || {}).sort();
    });
    failures += check(
      'a ticker added from the website is stored by the extension',
      stored.includes('NVDA'), stored.join(',')
    );

    writeFileSync(path.join(SHOTS, 'result.json'), JSON.stringify({
      extensionId, port, cards, siteCards, stored, failures,
    }, null, 2));
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log('');
  if (failures) {
    console.error(`✖ ${failures} check(s) failed. Screenshots in e2e/shots-dashboard/`);
    process.exit(1);
  }
  console.log('✔ dashboard verified on both routes. Screenshots in e2e/shots-dashboard/');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
