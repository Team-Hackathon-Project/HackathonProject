/**
 * Options page behaviour, driven against the real `src/options.html`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSource, makeStorage } from './helpers.mjs';
import { STORAGE_KEYS } from '../src/lib/constants.js';

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
    async sendMessage(message) {
      runtimeMessages.push(message);
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
  assert.equal(stored.apiKey, 'sk-ant-test');
  assert.equal(stored.model, 'claude-haiku-4-5');
  assert.equal(stored.selfHealEnabled, false);
  assert.equal(stored.maxSnippetChars, 40000);
  assert.match(el('settings-status').textContent, /saved/i);
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
  assert.deepEqual(portfolio.AAPL, { shares: 10, avg_cost: 180, target_buy_below: null, target_sell_above: 220 });
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
