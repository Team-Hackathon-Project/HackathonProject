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

/** Origins the fake browser has granted, and what the next request will answer. */
const granted = new Set();
let grantOutcome = true;

/** What the fake service worker should answer the next TEST_BRIDGE with. */
let bridgeProbe = {
  ok: true,
  ms: 12,
  health: {
    ok: true,
    protocol: 1,
    tokenRequired: false,
    brightdata: { configured: true, zone: 'scraping_browser1', description: 'zone scraping_browser1', redacted: 'wss://brd-customer-c-zone-scraping_browser1:b7••••@brd.superproxy.io:9222' },
    llm: { provider: 'groq', model: 'openai/gpt-oss-120b' },
    selfHealing: { available: true, reason: null },
    heals: [],
  },
};

globalThis.chrome = {
  storage,
  permissions: {
    async contains({ origins }) {
      return origins.every((origin) => granted.has(origin));
    },
    async request({ origins }) {
      if (!grantOutcome) return false;
      for (const origin of origins) granted.add(origin);
      return true;
    },
    async remove({ origins }) {
      for (const origin of origins) granted.delete(origin);
      return true;
    },
  },
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
      if (message.type === 'TEST_BRIDGE') return { ok: true, data: bridgeProbe };
      if (message.type === 'SCRAPE_VIA_BRIDGE') {
        return {
          ok: true,
          data: {
            snapshot: { ticker: message.payload.ticker, current_price: 309.35, currency: 'USD' },
            usable: true,
            method: 'brightdata',
            healed: [{ field: 'price', selector: '.LhDNu span', strategy: 'css' }],
            warnings: [],
            notices: [],
            duration_ms: 24000,
          },
        };
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

test('existing healed selectors and the repair log render as records', () => {
  const entry = el('registry-list').querySelector('.entry');
  assert.match(entry.querySelector('.entry-title').textContent, /finance\.yahoo\.com · price/);
  assert.equal(entry.querySelector('.entry-detail').textContent, '.qz-8f31ab');

  const rows = Array.from(el('heal-log').querySelectorAll('.entry'));
  const healed = rows.find((row) => row.querySelector('.pill.ok'));
  const failed = rows.find((row) => row.querySelector('.pill.bad'));

  // A success shows the selector it adopted; a failure shows why it did not.
  assert.equal(healed.querySelector('.entry-detail').textContent, '.qz-8f31ab');
  assert.equal(failed.querySelector('.entry-detail').textContent, 'selector matched no elements');
  assert.equal(failed.querySelector('.pill.bad').textContent, 'failed');
});

test('an empty registry says so instead of rendering an empty box', async () => {
  const { clearRegistry } = await import('../src/lib/storage.js');
  await clearRegistry();
  click('reset-registry');
  await settle();
  assert.match(el('registry-list').textContent, /No healed selectors yet/);
  assert.ok(el('registry-list').querySelector('.empty-note'));
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

test('the key field reports its length, so a truncated paste is visible', async () => {
  const input = el('api-key');
  input.value = '';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(el('key-length').textContent, '(not set)');

  input.value = '  gsk_1234567890  ';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(el('key-length').textContent, '(14 characters)', 'surrounding whitespace is not counted');
  assert.equal(el('key-length').textContent.includes('gsk_'), false, 'the key itself is never shown');
});

test('the rail says whether the agent can actually reach a model', async () => {
  el('api-key').value = '';
  el('api-key').dispatchEvent(new window.Event('input'));
  assert.match(el('agent-state').textContent, /No key/);

  el('api-key').value = 'gsk_something';
  el('api-key').dispatchEvent(new window.Event('input'));
  assert.match(el('agent-state').textContent, /Key set/);
});

test('an edit is flagged as unsaved until it is saved', async () => {
  assert.equal(el('settings-dirty').classList.contains('hidden'), false, 'the edit above is still pending');

  click('save-settings');
  await settle();
  assert.equal(el('settings-dirty').classList.contains('hidden'), true, 'saving clears the marker');
});

test('each provider links to the page its key comes from', async () => {
  const select = el('provider');
  select.value = 'anthropic';
  select.dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(el('key-link').getAttribute('href'), 'https://console.anthropic.com');

  select.value = 'groq';
  select.dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(el('key-link').getAttribute('href'), 'https://console.groq.com/keys');
});

/* ------------------------------------------------------------------ *
 * Bright Data
 *
 * The panel configures the local agent, never the Scraping Browser credentials
 * themselves — those live in the agent's `.env` and must not be reachable from
 * a page that the extension renders.
 * ------------------------------------------------------------------ */

test('the Bright Data panel defaults to off, on loopback, as a last resort', () => {
  assert.equal(el('bd-enabled').checked, false, 'nothing reaches a third party until it is asked for');
  assert.equal(el('bd-url').value, 'http://127.0.0.1:8791');
  assert.equal(el('bd-mode').value, 'fallback');
  assert.equal(el('bd-token').getAttribute('type'), 'password', 'the shared token is not shoulder-readable');
});

test('the panel offers no field for the Bright Data password', () => {
  // The Scraping Browser credentials belong in the agent's .env, on the machine
  // that dials the endpoint. Everything here configures the agent's *address*.
  const ids = Array.from(dom.window.document.querySelectorAll('#brightdata input, #brightdata select')).map((node) => node.id);
  assert.deepEqual(ids.sort(), ['bd-enabled', 'bd-mode', 'bd-ticker', 'bd-token', 'bd-url']);
});

test('an address that is not loopback is refused before it is saved', async () => {
  el('bd-url').value = 'http://scraper.example.com:8791';
  click('bd-save');
  await settle();

  assert.match(el('bd-status').textContent, /127\.0\.0\.1|localhost/);
  const stored = (await storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.notEqual(stored.brightdata && stored.brightdata.bridgeUrl, 'http://scraper.example.com:8791');
});

test('a valid configuration is saved, and the address is normalized to an origin', async () => {
  el('bd-url').value = 'http://localhost:8791/ignored/path';
  el('bd-enabled').checked = true;
  el('bd-mode').value = 'first';
  el('bd-token').value = 'hunter2';
  click('bd-save');
  await settle();

  const stored = (await storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.deepEqual(stored.brightdata, {
    enabled: true, bridgeUrl: 'http://localhost:8791', token: 'hunter2', mode: 'first',
  });
  assert.match(el('bd-status').textContent, /Saved/);
});

test('granting access asks the browser for the agent origin, without the port', async () => {
  click('bd-grant');
  await settle();

  assert.equal(granted.has('http://localhost/*'), true, 'Chrome match patterns carry no port');
  assert.match(el('bd-grant').textContent, /Revoke/);
});

test('granting again revokes, and the button says so', async () => {
  click('bd-grant');
  await settle();

  assert.equal(granted.has('http://localhost/*'), false);
  assert.match(el('bd-grant').textContent, /Grant/);
});

test('testing the agent goes through the service worker and reports what it found', async () => {
  runtimeMessages.length = 0;
  click('bd-test');
  await settle();

  const sent = runtimeMessages.find((message) => message.type === 'TEST_BRIDGE');
  assert.ok(sent, 'the probe must run where the real calls are made, not from this page');
  assert.equal(sent.payload.bridgeUrl, 'http://localhost:8791');
  assert.match(el('bd-status').textContent, /scraping_browser1/);
  assert.match(el('bd-report').textContent, /Self-healing/);
});

test('the report shows the redacted endpoint and never a password', async () => {
  click('bd-test');
  await settle();
  assert.match(el('bd-report').textContent, /brd-customer-c-zone-scraping_browser1/);
  assert.match(el('bd-report').textContent, /•/);
});

test('an agent that answers but is not ready says why', async () => {
  bridgeProbe = {
    ok: false,
    ms: 8,
    error: 'The agent is running but Bright Data is not configured.',
    health: {
      ok: false,
      protocol: 1,
      tokenRequired: false,
      brightdata: { configured: false, error: 'No Bright Data endpoint in the environment.' },
      llm: { provider: 'groq', model: 'x' },
      selfHealing: { available: false, reason: 'no model API key in .env' },
      heals: [],
    },
  };
  click('bd-test');
  await settle();

  assert.match(el('bd-status').textContent, /not configured/);
  assert.match(el('bd-report').textContent, /No Bright Data endpoint/);
  assert.match(el('bd-report').textContent, /no model API key/);
});

test('an on-demand scrape refuses a ticker that is not one', async () => {
  runtimeMessages.length = 0;
  el('bd-ticker').value = '!!';
  click('bd-scrape');
  await settle();

  assert.match(el('bd-status').textContent, /Enter a ticker/);
  assert.equal(runtimeMessages.some((message) => message.type === 'SCRAPE_VIA_BRIDGE'), false);
});

test('an on-demand scrape refuses to run against unsaved settings', async () => {
  runtimeMessages.length = 0;
  el('bd-mode').value = 'only';
  el('bd-mode').dispatchEvent(new window.Event('change'));
  el('bd-ticker').value = 'AAPL';
  click('bd-scrape');
  await settle();

  // The worker reads the settings from storage, so scraping against a form that
  // has not been saved would silently use the previous configuration.
  assert.match(el('bd-status').textContent, /Save the settings first/);
  assert.equal(runtimeMessages.some((message) => message.type === 'SCRAPE_VIA_BRIDGE'), false);
});

test('an on-demand scrape goes through the worker and reports what came back', async () => {
  click('bd-save');
  await settle();

  runtimeMessages.length = 0;
  el('bd-ticker').value = ' aapl ';
  click('bd-scrape');
  await settle();

  const sent = runtimeMessages.find((message) => message.type === 'SCRAPE_VIA_BRIDGE');
  assert.ok(sent, 'the scrape must run in the worker, which is where the bridge call is made');
  assert.equal(sent.payload.ticker, 'AAPL');
  assert.match(el('bd-status').textContent, /AAPL at 309\.35 USD/);
  assert.match(el('bd-status').textContent, /Repaired price/);
  assert.equal(el('bd-ticker').value, '', 'the field resets after a successful read');
});
