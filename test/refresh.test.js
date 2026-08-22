/**
 * Background refresh: reading a quote page the user is not looking at.
 *
 * Two things matter more than the happy path here, and both are about a
 * dashboard that runs unattended:
 *
 *   1. It must never write a number it is not sure of. A price from the wrong
 *      page, or one the host reports for every ticker, is worse than no price:
 *      it is filed under the symbol and charted as its history.
 *   2. It must never read anything the user has not allowed it to. The origin
 *      check is the gate, and it is checked before the fetch, not after.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, makeStorage, uninstallChrome, stubPageFetch } from './helpers.mjs';
import { HEALTHY_PAGE, EMPTY_PAGE, INDEX_RAIL_PAGE } from './fixtures/pages.mjs';
import { STORAGE_KEYS } from '../src/lib/constants.js';
import { extractAll } from '../src/lib/extract-core.js';
import { JSDOM } from 'jsdom';

const URL_FOR = 'https://finance.yahoo.com/quote/AAPL';
const ORIGIN = 'https://finance.yahoo.com/*';

/**
 * Stands in for the offscreen document, running the real extractor over the
 * real fixture HTML in jsdom — the same work the offscreen page does, minus the
 * message hop.
 */
const offscreenHandler = (message) => {
  if (message.type !== 'EXTRACT_HTML') return null;
  const { html, candidates } = message.payload;
  const doc = new JSDOM(html, { url: URL_FOR }).window.document;
  return { ok: true, ...extractAll(doc, candidates) };
};

const watchlistWith = (overrides = {}) => ({
  [STORAGE_KEYS.WATCHLIST]: {
    AAPL: { ticker: 'AAPL', source_url: URL_FOR, monitor: true, ...overrides },
  },
});

function setup({ storageExtra = {}, granted = [ORIGIN], fetchMap = { '/quote/AAPL': HEALTHY_PAGE }, tabHandler } = {}) {
  const storage = makeStorage({ ...watchlistWith(), ...storageExtra });
  const chrome = installChrome({ storage, grantedOrigins: granted, offscreenHandler, tabHandler });
  globalThis.fetch = stubPageFetch(fetchMap);
  return { storage, chrome };
}

test.afterEach(() => {
  uninstallChrome();
  delete globalThis.fetch;
});

const background = () => import('../src/background.js');

/* ------------------------------------------------------------------ *
 * The permission gate
 * ------------------------------------------------------------------ */

test('nothing is fetched from an origin the user has not granted', async () => {
  setup({ granted: [] });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.match(result.error, /has not been granted/);
  assert.equal(globalThis.fetch.calls.length, 0, 'the gate must come before the request');
  assert.equal(result.needs_permission, ORIGIN);
});

test('the origin needing a grant is recorded where the dashboard can show it', async () => {
  const { storage } = setup({ granted: [] });
  const { refreshTicker } = await background();
  await refreshTicker('AAPL');

  const entry = storage._dump()[STORAGE_KEYS.WATCHLIST].AAPL;
  assert.equal(entry.needs_permission, ORIGIN);
  assert.match(entry.last_error, /has not been granted/);
});

test('a granted origin is read, and the grant is cleared from the entry', async () => {
  const { storage } = setup();
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, true, result.error);
  assert.equal(result.method, 'fetch');
  assert.equal(result.snapshot.current_price, 224.5);
  assert.equal(storage._dump()[STORAGE_KEYS.WATCHLIST].AAPL.needs_permission, null);
});

/* ------------------------------------------------------------------ *
 * What gets written
 * ------------------------------------------------------------------ */

test('a good read updates the snapshot, the history and the entry together', async () => {
  const { storage } = setup();
  const { refreshTicker } = await background();
  await refreshTicker('AAPL');

  const dump = storage._dump();
  assert.equal(dump[STORAGE_KEYS.SNAPSHOTS].AAPL.current_price, 224.5);
  assert.equal(dump[STORAGE_KEYS.PRICE_HISTORY].AAPL.length, 1);
  assert.equal(dump[STORAGE_KEYS.PRICE_HISTORY].AAPL[0].price, 224.5);
  assert.equal(dump[STORAGE_KEYS.WATCHLIST].AAPL.last_method, 'fetch');
  assert.equal(dump[STORAGE_KEYS.WATCHLIST].AAPL.last_error, null);
});

test('the previous snapshot is handed back, so a caller can compare', async () => {
  const { storage } = setup({
    storageExtra: { [STORAGE_KEYS.SNAPSHOTS]: { AAPL: { ticker: 'AAPL', current_price: 200, source_url: URL_FOR } } },
  });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.previous.current_price, 200);
  assert.equal(result.snapshot.current_price, 224.5);
  assert.equal(storage._dump()[STORAGE_KEYS.SNAPSHOTS].AAPL.current_price, 224.5);
});

test('a page with no price writes nothing and says why', async () => {
  const { storage } = setup({ fetchMap: { '/quote/AAPL': EMPTY_PAGE }, tabHandler: async () => null });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.equal(storage._dump()[STORAGE_KEYS.SNAPSHOTS], undefined);
  assert.equal(storage._dump()[STORAGE_KEYS.PRICE_HISTORY], undefined);
  assert.match(storage._dump()[STORAGE_KEYS.WATCHLIST].AAPL.last_error, /no price|fetch failed|could not be read/i);
});

test('a page that is only other instruments produces no snapshot', async () => {
  const { storage } = setup({ fetchMap: { '/quote/AAPL': INDEX_RAIL_PAGE }, tabHandler: async () => null });
  const { refreshTicker } = await background();

  assert.equal((await refreshTicker('AAPL')).ok, false);
  assert.equal(storage._dump()[STORAGE_KEYS.SNAPSHOTS], undefined);
});

test('a page reporting a different ticker is refused, not filed under this one', async () => {
  // The URL says AAPL; the page is Microsoft's. A redirect or a stale link does
  // exactly this, and the resulting point would be indistinguishable later.
  const msft = HEALTHY_PAGE.replace(/AAPL/g, 'MSFT').replace('Apple Inc.', 'Microsoft Corp.');
  const { storage } = setup({ fetchMap: { '/quote/AAPL': msft }, tabHandler: async () => null });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.match(result.error, /reported MSFT, not AAPL/);
  assert.equal(storage._dump()[STORAGE_KEYS.SNAPSHOTS], undefined);
});

test('a price the host reports for every ticker is discarded', async () => {
  const { storage } = setup({
    storageExtra: {
      // Another ticker on the same host already carries this exact price.
      [STORAGE_KEYS.SNAPSHOTS]: {
        MSFT: { ticker: 'MSFT', current_price: 224.5, source_url: 'https://finance.yahoo.com/quote/MSFT' },
      },
    },
    tabHandler: async () => null,
  });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.match(result.error, /same 224\.5 for AAPL and MSFT/);
  assert.equal(storage._dump()[STORAGE_KEYS.SNAPSHOTS].AAPL, undefined);
});

/* ------------------------------------------------------------------ *
 * Falling through to a real tab
 * ------------------------------------------------------------------ */

test('a page whose HTML carries no price is opened for real, and the tab is closed', async () => {
  // The served HTML is the empty page; the rendered one has the quote. This is
  // exactly the JavaScript-rendered case the fetch path cannot handle.
  const { chrome, storage } = setup({
    fetchMap: { '/quote/AAPL': EMPTY_PAGE },
    tabHandler: async (message) => {
      if (message.type === 'PING') return { ok: true, host: 'finance.yahoo.com' };
      if (message.type !== 'EXTRACT') return null;
      const doc = new JSDOM(HEALTHY_PAGE, { url: URL_FOR }).window.document;
      return { ok: true, url: URL_FOR, host: 'finance.yahoo.com', ...extractAll(doc, message.payload.candidates) };
    },
  });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, true, result.error);
  assert.equal(result.method, 'tab');
  assert.equal(storage._dump()[STORAGE_KEYS.SNAPSHOTS].AAPL.current_price, 224.5);
  assert.equal(chrome._calls.tabsCreated.length, 1);
  assert.equal(chrome._calls.tabsCreated[0].url, URL_FOR);
  assert.deepEqual(chrome._calls.tabsRemoved, [chrome._calls.tabsCreated[0].id]);
});

test('the tab is opened in the background, never stealing focus', async () => {
  const { chrome } = setup({
    fetchMap: { '/quote/AAPL': EMPTY_PAGE },
    tabHandler: async () => null,
  });
  const { refreshTicker } = await background();
  await refreshTicker('AAPL');

  assert.equal(chrome._calls.tabsCreated.length, 1);
  assert.equal(chrome._calls.tabsCreated[0].active, false, 'a refresh must not pull the user off their tab');
  assert.deepEqual(chrome._calls.tabsRemoved, [chrome._calls.tabsCreated[0].id]);
});

test('a failed tab read still closes the tab it opened', async () => {
  const { chrome } = setup({
    fetchMap: { '/quote/AAPL': EMPTY_PAGE },
    tabHandler: async () => null, // never answers PING, so injection "fails"
  });
  const { refreshTicker } = await background();

  assert.equal((await refreshTicker('AAPL')).ok, false);
  assert.equal(chrome._calls.tabsRemoved.length, 1, 'a failed refresh must not leave a tab behind');
});

test('the tab path can be switched off for a fetch-only pass', async () => {
  const { chrome } = setup({ fetchMap: { '/quote/AAPL': EMPTY_PAGE } });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL', { allowTab: false });

  assert.equal(result.ok, false);
  assert.equal(chrome._calls.tabsCreated.length, 0);
});

/* ------------------------------------------------------------------ *
 * Failure handling
 * ------------------------------------------------------------------ */

test('a network failure is reported rather than thrown', async () => {
  const { storage } = setup({
    fetchMap: { '/quote/AAPL': new Error('getaddrinfo ENOTFOUND') },
    tabHandler: async () => null,
  });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.equal(result.ok, false);
  assert.match(result.error, /fetch failed/);
  assert.ok(storage._dump()[STORAGE_KEYS.WATCHLIST].AAPL.last_refreshed_at);
});

test('a ticker with no stored URL is refused before anything is attempted', async () => {
  setup({ storageExtra: watchlistWith({ source_url: null }) });
  const { refreshTicker } = await background();

  const result = await refreshTicker('AAPL');

  assert.match(result.error, /No quote page URL/);
  assert.equal(globalThis.fetch.calls.length, 0);
});

test('refreshing something that is not watched is refused', async () => {
  setup();
  const { refreshTicker } = await background();
  assert.match((await refreshTicker('NVDA')).error, /not on the watchlist/);
});

/* ------------------------------------------------------------------ *
 * A whole pass
 * ------------------------------------------------------------------ */

test('a pass covers the monitored tickers and skips the paused ones', async () => {
  const storage = makeStorage({
    [STORAGE_KEYS.WATCHLIST]: {
      AAPL: { ticker: 'AAPL', source_url: URL_FOR, monitor: true },
      MSFT: { ticker: 'MSFT', source_url: 'https://finance.yahoo.com/quote/MSFT', monitor: false },
    },
  });
  installChrome({ storage, grantedOrigins: [ORIGIN], offscreenHandler, tabHandler: async () => null });
  globalThis.fetch = stubPageFetch({ '/quote/AAPL': HEALTHY_PAGE });

  const { refreshAll } = await background();
  const summary = await refreshAll();

  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].ticker, 'AAPL');
  assert.equal(summary.refreshed, 1);
  assert.equal(summary.failed, 0);
});

test('one broken ticker does not stop the rest of the pass', async () => {
  const storage = makeStorage({
    [STORAGE_KEYS.WATCHLIST]: {
      AAPL: { ticker: 'AAPL', source_url: URL_FOR, monitor: true },
      BAD: { ticker: 'BAD', source_url: 'https://finance.yahoo.com/quote/BAD', monitor: true },
    },
  });
  installChrome({ storage, grantedOrigins: [ORIGIN], offscreenHandler, tabHandler: async () => null });
  globalThis.fetch = stubPageFetch({ '/quote/AAPL': HEALTHY_PAGE, '/quote/BAD': new Error('boom') });

  const { refreshAll } = await background();
  const summary = await refreshAll();

  assert.equal(summary.refreshed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(storage._dump()[STORAGE_KEYS.SNAPSHOTS].AAPL.current_price, 224.5);
});
