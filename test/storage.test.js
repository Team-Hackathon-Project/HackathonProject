import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, installChrome, uninstallChrome } from './helpers.mjs';
import { STORAGE_KEYS, DEFAULT_SETTINGS, MAX_DECISIONS, MAX_PRICE_POINTS } from '../src/lib/constants.js';
import {
  getSettings, saveSettings, setRaw, getPortfolio, savePosition, getRegistry, recordHealedSelector,
  clearRegistry, saveSnapshot, getSnapshots, recordDecision, getDecisions, recordHealEvent, getHealLog,
  recordPricePoint, getPriceHistory,
} from '../src/lib/storage.js';

test.beforeEach(() => installChrome({ storage: makeStorage() }));
test.afterEach(() => uninstallChrome());

test('settings fall back to the documented defaults and merge on save', async () => {
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
  await saveSettings({ providers: { anthropic: { apiKey: 'sk-ant-x' } } });
  const settings = await getSettings();
  assert.equal(settings.providers.anthropic.apiKey, 'sk-ant-x');
  assert.equal(settings.providers.anthropic.model, DEFAULT_SETTINGS.providers.anthropic.model);
  assert.equal(settings.provider, 'anthropic');
});

test('a key saved for one provider does not disturb the other', async () => {
  await saveSettings({ providers: { anthropic: { apiKey: 'sk-ant-x' } } });
  await saveSettings({ provider: 'groq', providers: { groq: { apiKey: 'gsk_y', model: 'openai/gpt-oss-20b' } } });
  const settings = await getSettings();
  assert.equal(settings.provider, 'groq');
  assert.equal(settings.providers.groq.apiKey, 'gsk_y');
  assert.equal(settings.providers.anthropic.apiKey, 'sk-ant-x', 'switching provider must not discard the other key');
});

test('settings written before providers existed are migrated to Anthropic', async () => {
  await setRaw({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-legacy', model: 'claude-sonnet-5', maxSnippetChars: 9000 } });
  const settings = await getSettings();
  assert.equal(settings.provider, 'anthropic');
  assert.equal(settings.providers.anthropic.apiKey, 'sk-ant-legacy');
  assert.equal(settings.providers.anthropic.model, 'claude-sonnet-5');
  assert.equal(settings.maxSnippetChars, 9000);
  assert.equal('apiKey' in settings, false, 'the flat legacy fields must not survive the merge');
});

test('positions merge on write and delete on null', async () => {
  await savePosition('AAPL', { shares: 10 });
  await savePosition('AAPL', { target_sell_above: 250 });
  assert.deepEqual((await getPortfolio()).AAPL, { shares: 10, target_sell_above: 250 });
  await savePosition('AAPL', null);
  assert.deepEqual(await getPortfolio(), {});
});

test('a healed selector is stamped and namespaced by host', async () => {
  await recordHealedSelector('finance.yahoo.com', 'price', { selector: '#p', strategy: 'css', confidence: 0.9 });
  const registry = await getRegistry();
  assert.equal(registry['finance.yahoo.com'].price.selector, '#p');
  assert.equal(registry['finance.yahoo.com'].price.source, 'healed');
  assert.ok(Date.parse(registry['finance.yahoo.com'].price.healed_at));

  await recordHealedSelector('other.example', 'volume', { selector: '#v' });
  assert.equal((await getRegistry())['finance.yahoo.com'].price.selector, '#p');
  assert.deepEqual(await clearRegistry(), {});
  assert.deepEqual(await getRegistry(), {});
});

test('snapshots are keyed by ticker and overwritten in place', async () => {
  await saveSnapshot({ ticker: 'AAPL', current_price: 1 });
  await saveSnapshot({ ticker: 'AAPL', current_price: 2 });
  await saveSnapshot({ ticker: 'MSFT', current_price: 3 });
  const snapshots = await getSnapshots();
  assert.equal(snapshots.AAPL.current_price, 2);
  assert.equal(Object.keys(snapshots).length, 2);
});

test('decision and repair logs are newest-first and capped', async () => {
  for (let i = 0; i < MAX_DECISIONS + 5; i++) await recordDecision({ n: i });
  const decisions = await getDecisions();
  assert.equal(decisions.length, MAX_DECISIONS);
  assert.equal(decisions[0].n, MAX_DECISIONS + 4);

  await recordHealEvent({ field: 'price', healed: true });
  assert.equal((await getHealLog())[0].field, 'price');
});

test('storage access without a chrome runtime fails loudly', async () => {
  uninstallChrome();
  await assert.rejects(() => getSettings(), /chrome\.storage\.local is unavailable/);
  installChrome({ storage: makeStorage() });
});

test('the storage keys match the documented schema names', () => {
  assert.deepEqual(Object.values(STORAGE_KEYS).sort(), [
    'decisions', 'heal_log', 'portfolio', 'price_history', 'selector_registry', 'settings', 'snapshots',
  ]);
});

test('price points accumulate per ticker, newest first and capped', async () => {
  for (let i = 0; i < MAX_PRICE_POINTS + 5; i++) {
    await recordPricePoint({ ticker: 'AAPL', current_price: 200 + i, change_value: 1, extracted_at: `2026-08-2${i % 9}T00:00:00Z` });
  }
  await recordPricePoint({ ticker: 'MSFT', current_price: 480 });

  const aapl = await getPriceHistory('AAPL');
  assert.equal(aapl.length, MAX_PRICE_POINTS, 'the series is capped');
  assert.equal(aapl[0].price, 200 + MAX_PRICE_POINTS + 4, 'newest first');
  assert.equal((await getPriceHistory('MSFT')).length, 1, 'tickers do not share a series');
  assert.deepEqual(Object.keys(await getPriceHistory()).sort(), ['AAPL', 'MSFT']);
});

test('a snapshot with no usable price is not recorded as a price point', async () => {
  assert.equal(await recordPricePoint({ ticker: 'AAPL', current_price: null }), null);
  assert.equal(await recordPricePoint(null), null);
  assert.deepEqual(await getPriceHistory('AAPL'), []);
});
