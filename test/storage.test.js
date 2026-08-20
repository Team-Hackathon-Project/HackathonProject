import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, installChrome, uninstallChrome } from './helpers.mjs';
import { STORAGE_KEYS, DEFAULT_SETTINGS, MAX_DECISIONS } from '../src/lib/constants.js';
import {
  getSettings, saveSettings, setRaw, getPortfolio, savePosition, getRegistry, recordHealedSelector,
  clearRegistry, saveSnapshot, getSnapshots, recordDecision, getDecisions, recordHealEvent, getHealLog,
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
  await saveSettings({ provider: 'groq', providers: { groq: { apiKey: 'gsk_y', model: 'llama-3.1-8b-instant' } } });
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
    'decisions', 'heal_log', 'portfolio', 'selector_registry', 'settings', 'snapshots',
  ]);
});
