/**
 * The setup guide, driven against the real `src/welcome.html` in jsdom.
 *
 * What is asserted here is not the layout — it is the three promises the guide
 * makes:
 *
 *   - nothing in it is mandatory, and every step can be walked past
 *   - it writes exactly what was asked for, including switching the model off
 *     when the local engine is chosen rather than merely not switching it on
 *   - a half-finished run still leaves a working configuration behind
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSource, makeStorage } from './helpers.mjs';
import { MSG, STORAGE_KEYS } from '../src/lib/constants.js';

const storage = makeStorage();

const dom = new JSDOM(readSource('src/welcome.html'), { url: 'chrome-extension://test/src/welcome.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// jsdom has no layout, so scrolling is not implemented; the guide calls it on
// every step change.
dom.window.scrollTo = () => {};

const sent = [];
const tabs = [];

globalThis.chrome = {
  storage,
  tabs: {
    async create(options) { tabs.push(options); return { id: 1, ...options }; },
  },
  runtime: {
    lastError: null,
    id: 'abcdefghijklmnopabcdefghijklmnop',
    getURL: (path) => `chrome-extension://test/${path}`,
    openOptionsPage() { sent.push({ type: 'OPEN_OPTIONS' }); },
    // Stands in for the service worker: the guide only ever reaches it through
    // this bus, so the routing is what matters.
    async sendMessage(message) {
      sent.push(message);
      // The stub writes what the real worker would write, because the guide's
      // last step reads its recap back out of storage rather than out of what
      // it believes it sent.
      switch (message.type) {
        case MSG.ADD_WATCH: {
          const key = STORAGE_KEYS.WATCHLIST;
          const watchlist = (await storage.local.get(key))[key] || {};
          watchlist[message.payload.ticker] = { ticker: message.payload.ticker, monitor: true };
          await storage.local.set({ [key]: watchlist });
          return { ok: true, data: { entry: watchlist[message.payload.ticker] } };
        }
        case MSG.SET_MONITOR: {
          const key = STORAGE_KEYS.SETTINGS;
          const settings = (await storage.local.get(key))[key] || {};
          settings.monitorEnabled = message.payload.enabled;
          settings.monitorIntervalMinutes = settings.monitorIntervalMinutes || 15;
          await storage.local.set({ [key]: settings });
          return { ok: true, data: { settings } };
        }
        case MSG.TEST_PROVIDER:
          return { ok: true, data: { label: 'Anthropic (Claude)', model: 'claude-opus-5', ms: 240 } };
        default:
          return { ok: false, error: `unexpected ${message.type}` };
      }
    },
  },
};

const el = (id) => dom.window.document.getElementById(id);
const click = (id) => el(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const stored = async () => (await storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS] || {};
const railState = (index) => dom.window.document.querySelector(`#rail-steps li[data-step="${index}"]`).dataset.state;
const stepHidden = (index) => dom.window.document.querySelector(`.step[data-step="${index}"]`).hidden;

test.before(async () => {
  await import('../src/welcome.js');
  await settle();
});

test('the guide opens on the first step, with the rest still ahead', () => {
  assert.equal(el('progress-text').textContent, 'Step 1 of 5');
  assert.equal(railState(0), 'current');
  assert.equal(railState(4), 'todo');
  assert.equal(stepHidden(0), false);
  assert.equal(stepHidden(1), true);
  assert.equal(el('next').textContent, 'Get started');
  assert.equal(el('back').disabled, true, 'there is nothing behind the first step');
});

test('the progress meter is never empty, so arriving does not read as failure', () => {
  assert.equal(el('progress-fill').style.getPropertyValue('--confidence'), '20');
});

test('moving forward marks the step behind it done and remembers where it got to', async () => {
  click('next');
  await settle();

  assert.equal(el('progress-text').textContent, 'Step 2 of 5');
  assert.equal(railState(0), 'done');
  assert.equal(railState(1), 'current');
  assert.equal(stepHidden(1), false);
  assert.equal((await stored()).onboardingStep, 1, 'an abandoned run has to resume in place');
});

test('choosing the local engine switches the model off, rather than leaving a default on', async () => {
  click('next');
  await settle();
  assert.equal(stepHidden(2), false, 'the engine question is the third step');

  click('engine-local');
  assert.equal(el('engine-local').getAttribute('aria-checked'), 'true');
  assert.equal(el('engine-model').getAttribute('aria-checked'), 'false');
  assert.ok(el('key-panel').classList.contains('hidden'), 'the local engine needs no key field');

  click('next');
  await settle();

  const settings = await stored();
  assert.equal(settings.llmAdviceEnabled, false);
  assert.equal(settings.selfHealEnabled, false);
  assert.equal(settings.providers.anthropic.apiKey, '', 'nothing was typed, so no key is written');
});

test('choosing the model engine stores the key against the provider it belongs to', async () => {
  click('back');
  await settle();

  click('engine-model');
  assert.equal(el('key-panel').classList.contains('hidden'), false);
  el('w-key').value = '  sk-ant-guide-test  ';
  el('w-key').dispatchEvent(new dom.window.Event('input'));
  assert.equal(el('w-key-length').textContent, '17 characters', 'a truncated paste has to be visible');

  click('next');
  await settle();

  const settings = await stored();
  assert.equal(settings.provider, 'anthropic');
  assert.equal(settings.providers.anthropic.apiKey, 'sk-ant-guide-test', 'surrounding whitespace is trimmed');
  assert.equal(settings.llmAdviceEnabled, true);
  assert.equal(settings.selfHealEnabled, true);
});

test('testing the key goes through the service worker, where the real calls are made', async () => {
  click('back');
  await settle();
  sent.length = 0;

  click('w-test');
  await settle();

  const probe = sent.find((message) => message.type === MSG.TEST_PROVIDER);
  assert.ok(probe, 'the probe must not be fired from this page');
  assert.equal(probe.payload.apiKey, 'sk-ant-guide-test');
  assert.match(el('engine-status').textContent, /answered as claude-opus-5/);

  click('next');
  await settle();
});

test('a ticker that is not a ticker is refused before it reaches the worker', async () => {
  assert.equal(stepHidden(3), false, 'the watchlist question is the fourth step');
  sent.length = 0;

  el('w-ticker').value = '!!';
  click('w-add');
  await settle();

  assert.match(el('track-status').textContent, /ticker symbol/);
  assert.ok(el('track-status').classList.contains('error'));
  assert.equal(sent.some((message) => message.type === MSG.ADD_WATCH), false);
});

test('a sell target under the buy target is refused rather than stored backwards', async () => {
  sent.length = 0;
  el('w-ticker').value = 'AAPL';
  el('w-buy').value = '250';
  el('w-sell').value = '200';
  click('w-add');
  await settle();

  assert.match(el('track-status').textContent, /above the buy target/);
  assert.equal(sent.some((message) => message.type === MSG.ADD_WATCH), false);
});

test('a first ticker is normalized, watched through the worker, and its targets stored', async () => {
  sent.length = 0;
  el('w-ticker').value = ' aapl ';
  el('w-buy').value = '200';
  el('w-sell').value = '250';
  click('w-add');
  await settle();

  const added = sent.find((message) => message.type === MSG.ADD_WATCH);
  assert.ok(added, 'watching a ticker goes through the worker, which owns the defaults');
  assert.equal(added.payload.ticker, 'AAPL');

  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.equal(portfolio.AAPL.target_buy_below, 200);
  assert.equal(portfolio.AAPL.target_sell_above, 250);

  assert.match(el('w-watchlist').textContent, /AAPL/);
  assert.equal(el('w-ticker').value, '', 'the form clears so the next entry is deliberate');
});

test('background monitoring is off until the switch is thrown, and then goes through the worker', async () => {
  assert.equal(el('w-monitor').checked, false, 'nothing is fetched on a timer without being asked');
  sent.length = 0;

  el('w-monitor').checked = true;
  el('w-monitor').dispatchEvent(new dom.window.Event('change'));
  await settle();

  const message = sent.find((entry) => entry.type === MSG.SET_MONITOR);
  assert.ok(message);
  assert.equal(message.payload.enabled, true);
});

test('the last step reports what is actually stored, and records that the guide was finished', async () => {
  click('next');
  await settle();

  assert.equal(stepHidden(4), false);
  assert.equal(el('next').textContent, 'Finish');
  assert.ok(el('skip-all').classList.contains('hidden'), 'there is nothing left to skip');
  assert.equal((await stored()).onboardingCompleted, true);

  const rows = Array.from(el('recap').querySelectorAll('li'));
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Model connected/);
  assert.equal(rows[0].dataset.done, 'true');
  assert.match(rows[1].textContent, /Watchlist started/);
  assert.match(rows[1].textContent, /AAPL/);
  assert.match(rows[2].textContent, /Background checks on/);
  assert.equal(rows[2].dataset.done, 'true');
});

test('finishing opens the dashboard rather than leaving the reader on a dead end', async () => {
  tabs.length = 0;
  click('next');
  await settle();

  assert.equal(tabs.length, 1);
  assert.match(tabs[0].url, /web\/index\.html$/);
});

test('the guide never renders anything as markup', () => {
  const source = readSource('src/welcome.js');
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /insertAdjacentHTML/);
});
