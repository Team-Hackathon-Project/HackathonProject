/**
 * Popup UI behaviour, driven against the real `src/popup.html` in jsdom.
 *
 * `src/popup.js` runs once per process (ES modules are cached), so this file
 * imports it a single time and then drives the live DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSource } from './helpers.mjs';
import { MSG } from '../src/lib/constants.js';

const SNAPSHOT = {
  ticker: 'AAPL',
  current_price: 224.5,
  currency: 'USD',
  change_percentage: '+1.80%',
  change_value: 1.8,
  volume: 52300000,
  news: ['Apple beats earnings expectations again'],
  extracted_at: '2026-08-19T20:55:00Z',
  source_url: 'https://finance.yahoo.com/quote/AAPL',
  selectors_used: { price_selector: '[data-testid="qsp-price"]' },
};

const ADVICE = {
  ticker: 'AAPL',
  action: 'SELL',
  confidence_score: 0.72,
  rationale: 'Price cleared the configured sell target of USD 220.00 on above-average volume.',
  user_action_required: true,
  source: 'llm',
  model: 'claude-opus-5',
  provider_label: 'Anthropic (Claude)',
};

const sent = [];
let scrapeResult = { snapshot: SNAPSHOT, usable: true, healed: [], warnings: [], host: 'finance.yahoo.com' };
let adviceResult = ADVICE;
let stateResult = { hasApiKey: true, settings: { model: 'claude-opus-5' }, portfolio: {}, snapshots: {}, decisions: [], registry: {}, healLog: [] };

const dom = new JSDOM(readSource('src/popup.html'), { url: 'chrome-extension://test/popup.html' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;

globalThis.chrome = {
  runtime: {
    lastError: null,
    openOptionsPage() { sent.push({ type: 'OPEN_OPTIONS' }); },
    sendMessage(message, callback) {
      sent.push(message);
      queueMicrotask(() => {
        switch (message.type) {
          case MSG.GET_STATE: return callback({ ok: true, data: stateResult });
          case MSG.SCRAPE_ACTIVE_TAB: return callback({ ok: true, data: scrapeResult });
          case MSG.GET_ADVICE: return callback({ ok: true, data: adviceResult });
          case MSG.RECORD_DECISION: return callback({ ok: true, data: { ...message.payload, decided_at: 'now', executed: false } });
          default: return callback({ ok: false, error: `unexpected ${message.type}` });
        }
      });
    },
  },
};

const el = (id) => window.document.getElementById(id);
const click = (id) => el(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test.before(async () => {
  await import('../src/popup.js');
  await settle();
});

test('the popup starts with the advisory hidden and the decision log empty', () => {
  assert.ok(el('advice-card').classList.contains('hidden'));
  assert.ok(el('snapshot-card').classList.contains('hidden'));
  assert.ok(sent.some((message) => message.type === MSG.GET_STATE));
});

test('scanning renders the snapshot and the advisory card', async () => {
  click('scrape-btn');
  await settle();

  assert.equal(el('snapshot-title').textContent, 'AAPL');
  assert.equal(el('snapshot-price').textContent, '224.50');
  assert.equal(el('snapshot-currency').textContent, 'USD');
  assert.equal(el('snapshot-change').textContent, '+1.80%');
  assert.ok(el('snapshot-change').classList.contains('up'));
  assert.equal(el('snapshot-volume').textContent, '52.30M');
  assert.equal(el('snapshot-selectors').children.length, 1);
  assert.equal(el('context-line').textContent, 'finance.yahoo.com');

  assert.equal(el('advice-action').textContent, 'SELL');
  assert.equal(el('advice-action').className, 'badge SELL');
  // The confidence gauge is the ring around the verdict word, swept from this
  // one custom property.
  assert.equal(el('advice-card').style.getPropertyValue('--confidence'), '72');
  assert.equal(el('advice-score').textContent, '72% confidence');
  assert.match(el('advice-rationale').textContent, /sell target/);
  assert.match(el('advice-source').textContent, /Anthropic \(Claude\)/);
  assert.equal(el('advice-card').classList.contains('hidden'), false);
});

test('healed selectors and warnings surface as banners', async () => {
  scrapeResult = {
    ...scrapeResult,
    healed: [{ field: 'price', selector: '.qz-8f31ab', strategy: 'css' }],
    warnings: ['Could not heal "volume": selector matched no elements'],
  };
  click('scrape-btn');
  await settle();

  assert.equal(el('heal-banner').classList.contains('hidden'), false);
  assert.match(el('heal-banner').textContent, /Self-healed 1 selector/);
  assert.match(el('heal-banner').textContent, /price → \.qz-8f31ab/);
  assert.equal(el('warn-banner').classList.contains('hidden'), false);
  assert.match(el('warn-banner').textContent, /Could not heal "volume"/);
});

test('scraped text is inserted as text, never as markup', async () => {
  scrapeResult = {
    ...scrapeResult,
    healed: [],
    warnings: [],
    snapshot: { ...SNAPSHOT, news: ['<img src=x onerror="window.__pwned=1">Breaking: a headline'] },
  };
  click('scrape-btn');
  await settle();

  assert.equal(el('snapshot-news').querySelectorAll('img').length, 0);
  assert.equal(window.__pwned, undefined);
  assert.match(el('snapshot-news').textContent, /<img src=x/);
});

test('approving requires the confirmation modal and records a non-executed decision', async () => {
  scrapeResult = { ...scrapeResult, snapshot: SNAPSHOT };
  click('scrape-btn');
  await settle();
  sent.length = 0;

  click('approve-btn');
  assert.equal(el('modal').classList.contains('hidden'), false);
  assert.match(el('modal-body').textContent, /Approve the SELL signal for AAPL/);
  assert.equal(sent.length, 0, 'nothing may be recorded before the user confirms');

  click('modal-confirm');
  await settle();

  const decision = sent.find((message) => message.type === MSG.RECORD_DECISION);
  assert.ok(decision, 'the decision should have been recorded');
  assert.equal(decision.payload.verdict, 'APPROVED');
  assert.equal(decision.payload.final_action, 'SELL');
  assert.equal(decision.payload.suggested_action, 'SELL');
  assert.equal(el('modal').classList.contains('hidden'), true);
  assert.match(el('status').textContent, /No order was placed/);
});

test('cancelling the modal records nothing', async () => {
  sent.length = 0;
  click('reject-btn');
  assert.equal(el('modal').classList.contains('hidden'), false);
  click('modal-cancel');
  await settle();
  assert.equal(sent.filter((message) => message.type === MSG.RECORD_DECISION).length, 0);
  assert.equal(el('modal').classList.contains('hidden'), true);
});

test('an override records the user action, not the model action', async () => {
  sent.length = 0;
  click('override-btn');
  assert.equal(el('override-panel').classList.contains('hidden'), false);
  el('override-action').value = 'HOLD';
  el('override-note').value = 'waiting for earnings';
  click('override-confirm');
  assert.match(el('modal-body').textContent, /record HOLD for AAPL/);
  click('modal-confirm');
  await settle();

  const decision = sent.find((message) => message.type === MSG.RECORD_DECISION);
  assert.equal(decision.payload.verdict, 'OVERRIDDEN');
  assert.equal(decision.payload.final_action, 'HOLD');
  assert.equal(decision.payload.suggested_action, 'SELL');
  assert.equal(decision.payload.note, 'waiting for earnings');
});

test('an unusable page reports the error and shows no advisory', async () => {
  scrapeResult = { snapshot: { ...SNAPSHOT, ticker: null, current_price: null }, usable: false, healed: [], warnings: [], host: 'example.com' };
  sent.length = 0;
  click('scrape-btn');
  await settle();

  assert.ok(el('status').classList.contains('error'));
  assert.match(el('status').textContent, /Could not read a ticker and price/);
  assert.equal(sent.some((message) => message.type === MSG.GET_ADVICE), false);
  assert.ok(el('advice-card').classList.contains('hidden'));
});

test('a service-worker error is shown instead of crashing the popup', async () => {
  const original = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = (message, callback) => queueMicrotask(() => callback({ ok: false, error: 'boom' }));
  click('scrape-btn');
  await settle();
  assert.match(el('status').textContent, /boom/);
  assert.ok(el('status').classList.contains('error'));
  assert.equal(el('scrape-btn').disabled, false, 'the button must be re-enabled after a failure');
  globalThis.chrome.runtime.sendMessage = original;
});

test('an automatic target update is announced, never silent', async () => {
  scrapeResult = {
    ...scrapeResult,
    targets: {
      applied: true, basis: 'history', sample_size: 7,
      target_buy_below: 92.93, target_sell_above: 107.07,
    },
  };
  click('scrape-btn');
  await settle();

  assert.equal(el('targets-line').classList.contains('hidden'), false);
  assert.match(el('targets-line').textContent, /buy below 92\.93/);
  assert.match(el('targets-line').textContent, /sell above 107\.07/);
  assert.match(el('targets-line').textContent, /7 scans/);
});

test('a manual position shows no targets line', async () => {
  scrapeResult = { ...scrapeResult, targets: null };
  click('scrape-btn');
  await settle();
  assert.equal(el('targets-line').classList.contains('hidden'), true);
});

test('a field the page lacks is a quiet notice, not a warning', async () => {
  scrapeResult = {
    ...scrapeResult,
    healed: [],
    warnings: [],
    notices: ['This page does not show a volume figure.', 'This page does not show any headlines.'],
  };
  click('scrape-btn');
  await settle();

  assert.equal(el('notice-banner').classList.contains('hidden'), false);
  assert.match(el('notice-banner').textContent, /Not on this page/);
  assert.match(el('notice-banner').textContent, /does not show a volume figure/);
  assert.equal(el('warn-banner').classList.contains('hidden'), true, 'nothing here is a fault');
});

test('warnings keep their own banner, headed so they read as actionable', async () => {
  scrapeResult = { ...scrapeResult, notices: [], warnings: ['Could not repair the price: selector matched no elements'] };
  click('scrape-btn');
  await settle();

  assert.equal(el('warn-banner').classList.contains('hidden'), false);
  assert.match(el('warn-banner').textContent, /Needs your attention/);
  assert.equal(el('notice-banner').classList.contains('hidden'), true);
});

test('with a key configured the setup prompt stays out of the way', () => {
  assert.ok(el('setup-card').classList.contains('hidden'));
});

test('the setup prompt opens the options page', () => {
  sent.length = 0;
  click('setup-btn');
  assert.ok(sent.some((message) => message.type === 'OPEN_OPTIONS'));
});
