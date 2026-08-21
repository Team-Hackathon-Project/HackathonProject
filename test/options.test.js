/**
 * Options page behaviour, driven against the real `src/options.html`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSource, makeStorage } from './helpers.mjs';
import { STORAGE_KEYS } from '../src/lib/constants.js';
import { suggestTargets } from '../src/lib/targets.js';

const storage = makeStorage({
  [STORAGE_KEYS.SELECTORS]: {
    'finance.yahoo.com': { price: { selector: '.qz-8f31ab', strategy: 'css', source: 'healed', healed_at: '2026-08-19T20:00:00Z' } },
  },
  [STORAGE_KEYS.HEAL_LOG]: [
    { at: '2026-08-19T20:00:00Z', host: 'finance.yahoo.com', field: 'price', healed: true, proposed: '.qz-8f31ab', confidence: 0.9 },
    { at: '2026-08-19T19:00:00Z', host: 'finance.yahoo.com', field: 'volume', healed: false, error: 'selector matched no elements' },
  ],
});

const dom = new JSDOM(readSource('src/options.html'), { url: 'chrome-extension://test/options.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const runtimeMessages = [];
globalThis.chrome = {
  storage,
  runtime: {
    lastError: null,
    // Stands in for the service worker: the options page only ever talks to it
    // through this bus, so the routing is what matters here.
    async sendMessage(message) {
      runtimeMessages.push(message);
      if (message.type === 'SUGGEST_TARGETS') {
        const ticker = message.payload.ticker;
        const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO] || {};
        const suggestion = suggestTargets({ ticker, position: portfolio[ticker] || {} });
        return suggestion ? { ok: true, data: suggestion } : { ok: false, error: `Nothing to go on for ${ticker} yet.` };
      }
      await storage.local.set({ [STORAGE_KEYS.SELECTORS]: {} });
      return { ok: true };
    },
  },
};

const el = (id) => dom.window.document.getElementById(id);
const click = (id) => el(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test.before(async () => {
  await import('../src/options.js');
  await settle();
});

test('defaults populate the form on load', () => {
  assert.equal(el('model').value, 'claude-opus-5');
  assert.equal(el('api-key').value, '');
  assert.equal(el('self-heal').checked, true);
  assert.equal(el('llm-advice').checked, true);
  assert.equal(el('snippet-chars').value, '12000');
});

test('the API key field is a password input so it is not shoulder-readable', () => {
  assert.equal(el('api-key').getAttribute('type'), 'password');
});

test('existing healed selectors and the repair log render', () => {
  assert.match(el('registry-list').textContent, /finance\.yahoo\.com · price → \.qz-8f31ab/);
  const log = el('heal-log').textContent;
  assert.match(log, /price → \.qz-8f31ab/);
  assert.match(log, /FAILED: selector matched no elements/);
});

test('saving settings persists them and clamps the snippet budget', async () => {
  el('api-key').value = '  sk-ant-test  ';
  el('model').value = 'claude-haiku-4-5';
  el('self-heal').checked = false;
  el('snippet-chars').value = '999999';
  click('save-settings');
  await settle();

  const stored = (await storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.equal(stored.provider, 'anthropic');
  assert.equal(stored.providers.anthropic.apiKey, 'sk-ant-test');
  assert.equal(stored.providers.anthropic.model, 'claude-haiku-4-5');
  assert.equal(stored.selfHealEnabled, false);
  assert.equal(stored.maxSnippetChars, 40000);
  assert.match(el('settings-status').textContent, /saved/i);
});

test('switching provider swaps the fields and keeps both keys', async () => {
  const select = el('provider');
  assert.deepEqual(Array.from(select.options).map((o) => o.value), ['anthropic', 'groq']);

  select.value = 'groq';
  select.dispatchEvent(new window.Event('change'));
  await settle();

  assert.match(el('key-label').textContent, /Groq/);
  assert.equal(el('key-host').textContent, 'api.groq.com');
  assert.equal(el('api-key').value, '', 'the Groq key field starts empty');
  assert.equal(el('model').value, 'openai/gpt-oss-120b');
  assert.equal(el('load-models').classList.contains('hidden'), false, 'Groq can list its models');

  el('api-key').value = 'gsk_test';
  click('save-settings');
  await settle();

  const stored = (await storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.equal(stored.provider, 'groq');
  assert.equal(stored.providers.groq.apiKey, 'gsk_test');
  assert.equal(stored.providers.anthropic.apiKey, 'sk-ant-test', 'the Anthropic key must survive the switch');
});

test('a position is normalized, saved and listed', async () => {
  el('pos-ticker').value = ' aapl ';
  el('pos-shares').value = '10';
  el('pos-cost').value = '180';
  el('pos-buy').value = '';
  el('pos-sell').value = '220';
  click('save-position');
  await settle();

  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.deepEqual(portfolio.AAPL, {
    shares: 10, avg_cost: 180, target_buy_below: null, target_sell_above: 220, auto_targets: false,
  });
  assert.match(el('portfolio-body').textContent, /AAPL/);
  assert.equal(el('pos-ticker').value, '', 'the form should reset after a save');
});

test('an invalid ticker is refused before it reaches storage', async () => {
  el('pos-ticker').value = '!!';
  click('save-position');
  await settle();
  assert.match(el('position-status').textContent, /valid ticker/);
  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.deepEqual(Object.keys(portfolio), ['AAPL']);
});

test('a position can be removed from the table', async () => {
  const removeButton = el('portfolio-body').querySelector('button');
  removeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();
  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.deepEqual(portfolio, {});
  assert.match(el('portfolio-body').textContent, /No positions yet/);
});

test('resetting the registry goes through the service worker', async () => {
  click('reset-registry');
  await settle();
  assert.equal(runtimeMessages[0].type, 'RESET_SELECTORS');
  assert.match(el('registry-list').textContent, /No healed selectors yet/);
});

test('Suggest targets fills the boxes from the position, and saves nothing by itself', async () => {
  await storage.local.set({
    [STORAGE_KEYS.PORTFOLIO]: {
      ...(await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO],
      NVDA: { shares: 4, avg_cost: 100 },
    },
  });

  el('pos-ticker').value = 'nvda';
  el('pos-buy').value = '';
  el('pos-sell').value = '';
  click('suggest-targets');
  await settle();

  assert.equal(el('pos-buy').value, '95');
  assert.equal(el('pos-sell').value, '105');
  assert.match(el('position-status').textContent, /average cost/);
  assert.match(el('position-status').textContent, /Press Save position/);

  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.equal(portfolio.NVDA.target_buy_below, undefined, 'suggesting must not write');
});

test('Suggest targets refuses a ticker it knows nothing about', async () => {
  el('pos-ticker').value = 'ZZZZ';
  click('suggest-targets');
  await settle();
  assert.match(el('position-status').textContent, /Nothing to go on for ZZZZ/);
  assert.equal(el('position-status').classList.contains('error'), true);
});

test('the automatic checkbox rides along with the saved position', async () => {
  el('pos-ticker').value = 'TSLA';
  el('pos-shares').value = '2';
  el('pos-cost').value = '250';
  el('pos-buy').value = '240';
  el('pos-sell').value = '300';
  el('pos-auto').checked = true;
  click('save-position');
  await settle();

  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.equal(portfolio.TSLA.auto_targets, true);
  assert.match(el('portfolio-body').textContent, /TSLA/);
  assert.match(el('portfolio-body').textContent, /auto/);
  assert.equal(el('pos-auto').checked, false, 'the box resets so the next entry is deliberate');
});
