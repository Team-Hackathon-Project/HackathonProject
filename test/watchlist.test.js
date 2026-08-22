/**
 * The watchlist: its storage accessors, and the boundary the dashboard reaches
 * the worker across.
 *
 * The external bus is the part worth being strict about. Everything else in
 * this extension is reachable only from its own pages; `onMessageExternal` is
 * reachable by any script running on a matched origin, so what it will and will
 * not answer is asserted here rather than left to the manifest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, makeStorage, uninstallChrome } from './helpers.mjs';
import { STORAGE_KEYS, EXTERNAL_ALLOWED, MSG } from '../src/lib/constants.js';

// `src/background.js` registers its listeners once, at import, against
// whichever `chrome` double is installed at that moment. So it is imported
// here — before the per-test doubles start cycling — and the calls recorded on
// that first double are what the registration test inspects. Its handlers read
// `globalThis.chrome` when they run, so they still see each test's own storage.
const bootChrome = installChrome({ storage: makeStorage() });
const { handleExternalRequest } = await import('../src/background.js');

let storage;

test.beforeEach(() => {
  storage = makeStorage();
  installChrome({ storage });
});

test.after(() => uninstallChrome());

const load = () => import('../src/lib/storage.js');

/* ------------------------------------------------------------------ *
 * Accessors
 * ------------------------------------------------------------------ */

test('a watched ticker is stored upper-cased with usable defaults', async () => {
  const { saveWatchEntry, getWatchlist } = await load();
  const entry = await saveWatchEntry('aapl', { source_url: 'https://example.com/q/AAPL' });

  assert.equal(entry.ticker, 'AAPL');
  assert.equal(entry.monitor, true);
  assert.equal(entry.source_url, 'https://example.com/q/AAPL');
  assert.ok(entry.added_at);
  assert.deepEqual(Object.keys(await getWatchlist()), ['AAPL']);
});

test('an empty ticker is refused rather than stored under a blank key', async () => {
  const { saveWatchEntry, getWatchlist } = await load();
  assert.equal(await saveWatchEntry('   '), null);
  assert.deepEqual(await getWatchlist(), {});
});

test('a later write merges instead of resetting the fields it does not mention', async () => {
  const { saveWatchEntry } = await load();
  await saveWatchEntry('AAPL', { source_url: 'https://example.com/a', monitor: false });
  // A scan knows a fresh URL but nothing about the monitor switch.
  const entry = await saveWatchEntry('AAPL', { source_url: 'https://example.com/b' });

  assert.equal(entry.source_url, 'https://example.com/b');
  assert.equal(entry.monitor, false, 'a scan must not switch monitoring back on');
});

test('the original added_at survives an update', async () => {
  const { saveWatchEntry } = await load();
  const first = await saveWatchEntry('AAPL', {});
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await saveWatchEntry('AAPL', { last_method: 'fetch' });
  assert.equal(second.added_at, first.added_at);
});

test('removing reports whether there was anything to remove', async () => {
  const { saveWatchEntry, removeWatchEntry, getWatchlist } = await load();
  await saveWatchEntry('AAPL', {});
  assert.equal(await removeWatchEntry('aapl'), true);
  assert.equal(await removeWatchEntry('AAPL'), false);
  assert.deepEqual(await getWatchlist(), {});
});

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

test('snapshots taken before the watchlist existed are back-filled once', async () => {
  const { saveSnapshot, seedWatchlistFromSnapshots, getWatchlist } = await load();
  await saveSnapshot({ ticker: 'AAPL', current_price: 224.5, source_url: 'https://x/AAPL', extracted_at: '2026-08-01T00:00:00Z' });
  await saveSnapshot({ ticker: 'MSFT', current_price: 480, source_url: 'https://x/MSFT', extracted_at: '2026-08-02T00:00:00Z' });

  const first = await seedWatchlistFromSnapshots();
  assert.equal(first.seeded, true);
  assert.deepEqual(first.added.sort(), ['AAPL', 'MSFT']);

  const watchlist = await getWatchlist();
  assert.equal(watchlist.AAPL.source_url, 'https://x/AAPL');
  assert.equal(watchlist.AAPL.added_at, '2026-08-01T00:00:00Z');
});

test('seeding never resurrects a ticker the user removed on purpose', async () => {
  const { saveSnapshot, seedWatchlistFromSnapshots, removeWatchEntry, getWatchlist } = await load();
  await saveSnapshot({ ticker: 'AAPL', current_price: 224.5, source_url: 'https://x/AAPL' });
  await seedWatchlistFromSnapshots();
  await removeWatchEntry('AAPL');

  const second = await seedWatchlistFromSnapshots();
  assert.equal(second.seeded, false);
  assert.deepEqual(await getWatchlist(), {});
});

test('seeding leaves an entry the user has already customised alone', async () => {
  const { saveSnapshot, saveWatchEntry, seedWatchlistFromSnapshots, getWatchlist } = await load();
  await saveSnapshot({ ticker: 'AAPL', current_price: 224.5, source_url: 'https://scraped/AAPL' });
  await saveWatchEntry('AAPL', { source_url: 'https://chosen/AAPL', monitor: false });

  await seedWatchlistFromSnapshots();
  const entry = (await getWatchlist()).AAPL;
  assert.equal(entry.source_url, 'https://chosen/AAPL');
  assert.equal(entry.monitor, false);
});

test('the watchlist lives under its documented key', async () => {
  const { saveWatchEntry } = await load();
  await saveWatchEntry('AAPL', {});
  assert.ok(STORAGE_KEYS.WATCHLIST in storage._dump());
});

/* ------------------------------------------------------------------ *
 * The external bus
 * ------------------------------------------------------------------ */

test('the dashboard can read state and manage the watchlist', async () => {
  await handleExternalRequest({ type: MSG.ADD_WATCH, payload: { ticker: 'aapl' } });
  const state = await handleExternalRequest({ type: MSG.GET_DASHBOARD_STATE });

  assert.ok(state.watchlist.AAPL);
  // A ticker added by symbol alone still gets somewhere to look it up.
  assert.match(state.watchlist.AAPL.source_url, /^https:\/\/stockanalysis\.com\/stocks\/aapl\//);
});

test('the API key never crosses the external boundary', async () => {
  const { saveSettings } = await load();
  await saveSettings({ providers: { anthropic: { apiKey: 'sk-ant-secret' } } });

  const state = await handleExternalRequest({ type: MSG.GET_DASHBOARD_STATE });

  assert.equal(state.hasApiKey, true);
  assert.equal(state.providers, undefined);
  assert.ok(!JSON.stringify(state).includes('sk-ant-secret'));
});

test('a message outside the allowlist is refused by name', async () => {
  for (const type of [MSG.TEST_PROVIDER, MSG.SCRAPE_ACTIVE_TAB, MSG.RESET_SELECTORS, MSG.GET_STATE]) {
    await assert.rejects(
      () => handleExternalRequest({ type }),
      (error) => error.message.includes(type) && error.message.includes('not available'),
      `${type} must not be reachable from a web page`
    );
  }
});

test('the allowlist itself excludes everything credential-bearing', () => {
  for (const type of [MSG.TEST_PROVIDER, MSG.SCRAPE_ACTIVE_TAB, MSG.RESET_SELECTORS, MSG.GET_STATE]) {
    assert.ok(!EXTERNAL_ALLOWED.includes(type), `${type} must stay off the external allowlist`);
  }
  // Every allowlisted name must be a message the router actually knows.
  const known = new Set(Object.values(MSG));
  for (const type of EXTERNAL_ALLOWED) assert.ok(known.has(type), `${type} is not a real message type`);
});

test('a malformed external request is rejected, not passed through', async () => {
  for (const message of [null, undefined, {}, { type: 42 }]) {
    await assert.rejects(() => handleExternalRequest(message));
  }
});

test('the worker registers an external listener at all', () => {
  assert.equal(bootChrome._calls.externalListeners.length, 1);
  // The popup's bus must still be wired too - the external one does not replace it.
  assert.equal(bootChrome._calls.messageListeners.length, 1);
});

test('adding a watch refuses a URL that is not an http(s) page', async () => {
  await assert.rejects(
    () => handleExternalRequest({ type: MSG.ADD_WATCH, payload: { ticker: 'AAPL', source_url: 'javascript:alert(1)' } }),
    /not an http\(s\) quote page URL/
  );
});

test('a position saved from the dashboard keeps blank fields null, not zero', async () => {
  const result = await handleExternalRequest({
    type: MSG.SAVE_POSITION,
    payload: { ticker: 'aapl', shares: '10', avg_cost: '', target_sell_above: '250' },
  });

  assert.equal(result.position.shares, 10);
  assert.equal(result.position.avg_cost, null);
  assert.equal(result.position.target_sell_above, 250);
});
