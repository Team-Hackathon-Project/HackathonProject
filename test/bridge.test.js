/**
 * The loopback bridge, from both ends.
 *
 * The extension end is the interesting one, and what it is guarding is not the
 * happy path: a Bright Data scrape spends someone's plan and reaches a third
 * party, so the tests below pin down when it is allowed to happen at all —
 * switched on, origin granted, and in the order the user chose — and that a
 * refusal on any of those is silent rather than partial.
 *
 * The agent end is two small functions with outsized consequences: the origin
 * allowlist and the token comparison are all that stand between the bridge and
 * any page in the browser, which can reach localhost as easily as the extension.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, makeStorage, uninstallChrome } from './helpers.mjs';
import { HEALTHY_PAGE } from './fixtures/pages.mjs';
import { STORAGE_KEYS, MSG, DEFAULT_SETTINGS } from '../src/lib/constants.js';
import { extractAll } from '../src/lib/extract-core.js';
import { originAllowed, tokenMatches } from '../agent/server.mjs';
import { JSDOM } from 'jsdom';

const URL_FOR = 'https://finance.yahoo.com/quote/AAPL';
const QUOTE_ORIGIN = 'https://finance.yahoo.com/*';
const BRIDGE = 'http://127.0.0.1:8791';
const BRIDGE_ORIGIN = 'http://127.0.0.1/*';

const offscreenHandler = (message) => {
  if (message.type !== 'EXTRACT_HTML') return null;
  const { html, candidates } = message.payload;
  const doc = new JSDOM(html, { url: URL_FOR }).window.document;
  return { ok: true, ...extractAll(doc, candidates) };
};

const SNAPSHOT = {
  ticker: 'AAPL',
  current_price: 311.42,
  currency: 'USD',
  change_percentage: '+0.90%',
  change_value: 0.9,
  volume: 41000000,
  news: [],
  extracted_at: '2026-08-22T10:00:00.000Z',
  source_url: URL_FOR,
  selectors_used: { price_selector: '.healed-price' },
};

/** A `/scrape` answer in the shape `agent/scrape.mjs` returns. */
function scrapeAnswer(overrides = {}) {
  return {
    ok: true,
    ticker: 'AAPL',
    method: 'brightdata',
    snapshot: SNAPSHOT,
    url: URL_FOR,
    host: 'finance.yahoo.com',
    healed: [{ field: 'price', selector: '.healed-price', strategy: 'css' }],
    warnings: [],
    notices: [],
    captcha: { attempted: true, status: 'not_detected', error: null },
    registry: {
      'finance.yahoo.com': {
        price: {
          selector: '.healed-price',
          strategy: 'css',
          confidence: 0.9,
          source: 'healed',
          healed_at: '2026-08-22T10:00:00.000Z',
        },
      },
    },
    duration_ms: 21000,
    ...overrides,
  };
}

/**
 * A `fetch` that answers the bridge routes and records what it was asked.
 * Anything that is not the bridge is served the healthy quote page, so the
 * plain-fetch route stays available in the tests that need it to win.
 */
function studioAnswer(overrides = {}) {
  return {
    ok: true,
    method: 'scraper-studio',
    collector: 'c_test123',
    collection_id: 'j_test456',
    snapshots: [{ ...SNAPSHOT, method: 'scraper-studio' }],
    unusable: [],
    duration_ms: 18000,
    ...overrides,
  };
}

function stubBridgeFetch({ health = null, scrape = scrapeAnswer(), studio = studioAnswer(), page = HEALTHY_PAGE, fail = null } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    if (target.startsWith(BRIDGE)) {
      if (fail) throw fail;
      let body;
      if (target.endsWith('/health')) {
        body = health || { ok: true, service: 'brightdata-bridge', protocol: 1, tokenRequired: false, brightdata: { configured: true, zone: 'z1', description: 'zone z1' }, llm: {}, selfHealing: { available: true }, heals: [] };
      } else if (target.endsWith('/studio')) {
        body = studio;
      } else {
        body = scrape;
      }
      return { ok: true, status: 200, statusText: 'OK', async text() { return JSON.stringify(body); } };
    }
    if (page === null) return { ok: false, status: 404, async text() { return ''; } };
    return { ok: true, status: 200, async text() { return page; } };
  };
  impl.calls = calls;
  impl.bridgeCalls = () => calls.filter((call) => call.url.startsWith(BRIDGE));
  return impl;
}

function setup({ brightdata = {}, granted = [QUOTE_ORIGIN, BRIDGE_ORIGIN], fetchImpl = stubBridgeFetch(), snapshots = {} } = {}) {
  const storage = makeStorage({
    [STORAGE_KEYS.WATCHLIST]: { AAPL: { ticker: 'AAPL', source_url: URL_FOR, monitor: true } },
    [STORAGE_KEYS.SNAPSHOTS]: snapshots,
    [STORAGE_KEYS.SETTINGS]: {
      brightdata: { ...DEFAULT_SETTINGS.brightdata, bridgeUrl: BRIDGE, ...brightdata },
    },
  });
  const chrome = installChrome({ storage, grantedOrigins: granted, offscreenHandler });
  globalThis.fetch = fetchImpl;
  return { storage, chrome, fetchImpl };
}

test.afterEach(() => {
  uninstallChrome();
  delete globalThis.fetch;
});

const background = () => import('../src/background.js');

/* ------------------------------------------------------------------ *
 * When the bridge is allowed to be used at all
 * ------------------------------------------------------------------ */

test('with Bright Data switched off the agent is never contacted', async () => {
  const { fetchImpl } = setup({ brightdata: { enabled: false } });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, true, result.error);
  assert.equal(result.method, 'fetch');
  assert.equal(fetchImpl.bridgeCalls().length, 0);
});

test('switched on but with the agent origin not granted, the local routes still run', async () => {
  const { fetchImpl } = setup({
    brightdata: { enabled: true, mode: 'first' },
    granted: [QUOTE_ORIGIN],
  });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, true, result.error);
  assert.equal(result.method, 'fetch', 'an ungranted bridge is skipped, not fatal');
  assert.equal(fetchImpl.bridgeCalls().length, 0, 'the permission gate comes before the request');
  assert.ok(result.notes.some((note) => /Bright Data skipped/.test(note)));
});

test('mode "only" refuses rather than falling back to a local tab', async () => {
  const { fetchImpl } = setup({
    brightdata: { enabled: true, mode: 'only' },
    granted: [QUOTE_ORIGIN],
  });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 0, 'no local fetch, no tab — "only" means only');
});

/* ------------------------------------------------------------------ *
 * The refresh order
 * ------------------------------------------------------------------ */

test('mode "fallback" tries a plain fetch first and never pays for the bridge', async () => {
  const { fetchImpl } = setup({ brightdata: { enabled: true, mode: 'fallback' } });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.method, 'fetch');
  assert.equal(fetchImpl.bridgeCalls().length, 0);
});

test('mode "fallback" reaches the bridge when the served HTML carries no price', async () => {
  const fetchImpl = stubBridgeFetch({ page: '<html><body><h1>Nothing here</h1></body></html>' });
  setup({ brightdata: { enabled: true, mode: 'fallback' }, fetchImpl });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, true, result.error);
  assert.equal(result.method, 'brightdata');
  assert.equal(result.snapshot.current_price, 311.42);
});

test('mode "first" goes to Bright Data before touching the site', async () => {
  const { fetchImpl } = setup({ brightdata: { enabled: true, mode: 'first' } });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.method, 'brightdata');
  assert.equal(fetchImpl.calls[0].url, `${BRIDGE}/scrape`, 'the quote host is not contacted at all');
});

test('a host the user has not granted is still readable through Bright Data', async () => {
  // The agent's browser reads the page, not this one, so the quote-host
  // permission is not the gate on that route — the bridge origin is.
  const { fetchImpl } = setup({
    brightdata: { enabled: true, mode: 'fallback' },
    granted: [BRIDGE_ORIGIN],
  });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, true, result.error);
  assert.equal(result.method, 'brightdata');
  assert.equal(fetchImpl.calls.some((call) => call.url === URL_FOR), false, 'the ungranted host was never fetched here');
});

test('with neither the host nor the bridge granted, the refresh asks for the host', async () => {
  setup({ brightdata: { enabled: true, mode: 'fallback' }, granted: [] });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.equal(result.needs_permission, QUOTE_ORIGIN);
});

/* ------------------------------------------------------------------ *
 * What comes back
 * ------------------------------------------------------------------ */

test('the agent\'s healed selectors are merged into this machine\'s registry', async () => {
  const { storage } = setup({ brightdata: { enabled: true, mode: 'first' } });
  const { refreshTicker } = await background();

  await refreshTicker('AAPL');

  const registry = storage._dump()[STORAGE_KEYS.SELECTORS];
  assert.equal(registry['finance.yahoo.com'].price.selector, '.healed-price');
  assert.equal(registry['finance.yahoo.com'].price.source, 'healed');
});

test('a repair made by the agent is written to the repair log the options page shows', async () => {
  const { storage } = setup({ brightdata: { enabled: true, mode: 'first' } });
  const { refreshTicker } = await background();

  await refreshTicker('AAPL');

  const log = storage._dump()[STORAGE_KEYS.HEAL_LOG];
  const entry = log.find((event) => event.via === 'brightdata');
  assert.ok(entry, 'a Bright Data repair must be visible next to the tab repairs');
  assert.equal(entry.field, 'price');
  assert.equal(entry.healed, true);
});

test('this machine\'s healed selectors go out with the request', async () => {
  const { fetchImpl } = setup({ brightdata: { enabled: true, mode: 'first' } });
  const { handleRequest, refreshTicker } = await background();
  await handleRequest({ type: MSG.GET_STATE });
  await refreshTicker('AAPL');

  const scrape = fetchImpl.bridgeCalls().find((call) => call.url.endsWith('/scrape'));
  assert.ok(scrape, 'a scrape request was made');
  assert.equal(typeof scrape.body.registry, 'object', 'the agent gets our repairs, not just the other way round');
  assert.equal(scrape.body.ticker, 'AAPL');
});

test('the shared token rides on the request when one is configured', async () => {
  const { fetchImpl } = setup({ brightdata: { enabled: true, mode: 'first', token: 'hunter2' } });
  const { refreshTicker } = await background();

  await refreshTicker('AAPL');

  const scrape = fetchImpl.bridgeCalls().find((call) => call.url.endsWith('/scrape'));
  assert.equal(scrape.headers['x-bridge-token'], 'hunter2');
});

test('a page reporting a different ticker is refused, however it was read', async () => {
  const fetchImpl = stubBridgeFetch({
    scrape: scrapeAnswer({ snapshot: { ...SNAPSHOT, ticker: 'MSFT' } }),
    page: '<html><body></body></html>',
  });
  setup({ brightdata: { enabled: true, mode: 'first' }, fetchImpl });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.match(result.error, /reported MSFT, not AAPL/);
});

test('a price the host already reported for another ticker is refused from the bridge too', async () => {
  const fetchImpl = stubBridgeFetch({ page: '<html><body></body></html>' });
  setup({
    brightdata: { enabled: true, mode: 'first' },
    fetchImpl,
    snapshots: { MSFT: { ticker: 'MSFT', current_price: 311.42, source_url: 'https://finance.yahoo.com/quote/MSFT' } },
  });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.match(result.error, /same 311\.42/);
});

/* ------------------------------------------------------------------ *
 * When the agent is not there
 * ------------------------------------------------------------------ */

test('an agent that is not running is reported as such, not as "failed to fetch"', async () => {
  const fetchImpl = stubBridgeFetch({ fail: new TypeError('Failed to fetch'), page: '<html><body></body></html>' });
  setup({ brightdata: { enabled: true, mode: 'only' }, fetchImpl });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.match(result.error, /npm run agent/);
});

test('TEST_BRIDGE reports a protocol mismatch instead of failing obscurely later', async () => {
  const fetchImpl = stubBridgeFetch({ health: { ok: true, protocol: 99, brightdata: { configured: true } } });
  setup({ brightdata: { enabled: true }, fetchImpl });
  const { handleRequest } = await background();

  const probe = await handleRequest({ type: MSG.TEST_BRIDGE, payload: { bridgeUrl: BRIDGE } });

  assert.equal(probe.ok, false);
  assert.match(probe.error, /protocol 99/);
});

test('TEST_BRIDGE says which permission is missing rather than just failing', async () => {
  setup({ brightdata: { enabled: true }, granted: [] });
  const { handleRequest } = await background();

  const probe = await handleRequest({ type: MSG.TEST_BRIDGE, payload: { bridgeUrl: BRIDGE } });

  assert.equal(probe.ok, false);
  assert.equal(probe.needsPermission, BRIDGE_ORIGIN);
});

test('SCRAPE_VIA_BRIDGE refuses while Bright Data is switched off', async () => {
  setup({ brightdata: { enabled: false } });
  const { handleRequest } = await background();

  await assert.rejects(
    () => handleRequest({ type: MSG.SCRAPE_VIA_BRIDGE, payload: { ticker: 'AAPL' } }),
    /switched off/,
  );
});

test('SCRAPE_VIA_BRIDGE records the reading the same way a tab scan does', async () => {
  const { storage } = setup({ brightdata: { enabled: true } });
  const { handleRequest } = await background();

  const result = await handleRequest({ type: MSG.SCRAPE_VIA_BRIDGE, payload: { ticker: 'AAPL', url: URL_FOR } });

  assert.equal(result.usable, true);
  assert.equal(result.method, 'brightdata');
  const dump = storage._dump();
  assert.equal(dump[STORAGE_KEYS.SNAPSHOTS].AAPL.current_price, 311.42);
  assert.equal(dump[STORAGE_KEYS.PRICE_HISTORY].AAPL.length, 1);
  assert.equal(dump[STORAGE_KEYS.WATCHLIST].AAPL.last_method, 'brightdata');
});

/* ------------------------------------------------------------------ *
 * Scraper Studio — the collector, not a page read
 * ------------------------------------------------------------------ */

test('SCRAPE_VIA_STUDIO refuses while Bright Data is switched off', async () => {
  setup({ brightdata: { enabled: false } });
  const { handleRequest } = await background();

  await assert.rejects(
    () => handleRequest({ type: MSG.SCRAPE_VIA_STUDIO, payload: { ticker: 'AAPL' } }),
    /switched off/,
  );
});

test('SCRAPE_VIA_STUDIO stores a collector row exactly as a tab scan is stored', async () => {
  const { storage, fetchImpl } = setup({ brightdata: { enabled: true } });
  const { handleRequest } = await background();

  const result = await handleRequest({ type: MSG.SCRAPE_VIA_STUDIO, payload: { ticker: 'AAPL' } });

  assert.equal(result.usable, true);
  assert.equal(result.method, 'scraper-studio');
  assert.equal(result.collection_id, 'j_test456', 'the snapshot id comes back so a run is traceable');

  // The collector is asked for a ticker; it does the page-reading, not us.
  const call = fetchImpl.bridgeCalls().find((entry) => entry.url.endsWith('/studio'));
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, { tickers: ['AAPL'] });

  const dump = storage._dump();
  assert.equal(dump[STORAGE_KEYS.SNAPSHOTS].AAPL.current_price, 311.42);
  assert.equal(dump[STORAGE_KEYS.PRICE_HISTORY].AAPL.length, 1);
  assert.equal(dump[STORAGE_KEYS.WATCHLIST].AAPL.last_method, 'scraper-studio');
});

test('a collector that returns nothing usable is reported, not stored', async () => {
  const { storage } = setup({
    brightdata: { enabled: true },
    fetchImpl: stubBridgeFetch({ studio: studioAnswer({ snapshots: [], unusable: [{ index: 0, row: { ticker: 'AAPL' } }] }) }),
  });
  const { handleRequest } = await background();

  await assert.rejects(
    () => handleRequest({ type: MSG.SCRAPE_VIA_STUDIO, payload: { ticker: 'AAPL' } }),
    /no usable rows/,
  );
  assert.equal((storage._dump()[STORAGE_KEYS.SNAPSHOTS] || {}).AAPL, undefined, 'nothing is stored from an empty run');
});

test('a web page cannot spend the collector budget either', async () => {
  setup({ brightdata: { enabled: true } });
  const { handleExternalRequest } = await background();

  await assert.rejects(
    () => handleExternalRequest({ type: MSG.SCRAPE_VIA_STUDIO, payload: { ticker: 'AAPL' } }),
    /not available/,
    'a collector run costs page loads on the team plan, and no dashboard control asks for it',
  );
});

/* ------------------------------------------------------------------ *
 * The agent's own guards
 * ------------------------------------------------------------------ */

test('only extension and loopback origins get past the agent\'s allowlist', () => {
  assert.equal(originAllowed('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), true);
  assert.equal(originAllowed('http://127.0.0.1:8080'), true);
  assert.equal(originAllowed('http://localhost:3000'), true);
  assert.equal(originAllowed(''), true, 'curl and same-origin requests send no Origin');

  assert.equal(originAllowed('https://evil.example.com'), false);
  assert.equal(originAllowed('http://127.0.0.1.evil.com'), false, 'a prefix match would be a hole');
  assert.equal(originAllowed('null'), false);
});

test('a web page cannot spend the Bright Data plan', async () => {
  setup({ brightdata: { enabled: true } });
  const { handleExternalRequest } = await background();

  await assert.rejects(
    () => handleExternalRequest({ type: MSG.SCRAPE_VIA_BRIDGE, payload: { ticker: 'AAPL' } }),
    /not available/,
    'one call is one remote browser session, and no dashboard control asks for it',
  );
});

test('the token comparison rejects a wrong token and a truncated one alike', () => {
  assert.equal(tokenMatches('', undefined), true, 'no token configured means no check');
  assert.equal(tokenMatches('hunter2', 'hunter2'), true);
  assert.equal(tokenMatches('hunter2', 'hunter3'), false);
  assert.equal(tokenMatches('hunter2', 'hunter'), false);
  assert.equal(tokenMatches('hunter2', ''), false);
  assert.equal(tokenMatches('hunter2', undefined), false);
});
