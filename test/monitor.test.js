/**
 * The monitor loop: the part that runs with nobody watching.
 *
 * `alerts.test.js` covers when a rule should fire. This covers what the worker
 * does about it — that a pass only evaluates readings it actually just took,
 * that an alert reaches all three channels rather than only the one the
 * operating system might be suppressing, and that monitoring is off until it is
 * asked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installChrome, makeStorage, uninstallChrome, stubPageFetch } from './helpers.mjs';
import { HEALTHY_PAGE, EMPTY_PAGE } from './fixtures/pages.mjs';
import { STORAGE_KEYS, MONITOR_ALARM, MSG } from '../src/lib/constants.js';
import { extractAll } from '../src/lib/extract-core.js';

const URL_FOR = 'https://finance.yahoo.com/quote/AAPL';
const ORIGIN = 'https://finance.yahoo.com/*';

const offscreenHandler = (message) => {
  if (message.type !== 'EXTRACT_HTML') return null;
  const doc = new JSDOM(message.payload.html, { url: URL_FOR }).window.document;
  return { ok: true, ...extractAll(doc, message.payload.candidates) };
};

/** A watchlist of one, monitored, with whatever rules and prior state a test needs. */
function setup({
  rules = [],
  settings = { monitorEnabled: true },
  snapshots = null,
  portfolio = null,
  page = HEALTHY_PAGE,
  granted = [ORIGIN],
} = {}) {
  const initial = {
    [STORAGE_KEYS.WATCHLIST]: { AAPL: { ticker: 'AAPL', source_url: URL_FOR, monitor: true } },
    [STORAGE_KEYS.SETTINGS]: settings,
  };
  if (rules.length) initial[STORAGE_KEYS.ALERT_RULES] = { AAPL: rules };
  if (snapshots) initial[STORAGE_KEYS.SNAPSHOTS] = snapshots;
  if (portfolio) initial[STORAGE_KEYS.PORTFOLIO] = portfolio;

  const storage = makeStorage(initial);
  const chrome = installChrome({
    storage, grantedOrigins: granted, offscreenHandler, tabHandler: async () => null,
  });
  globalThis.fetch = stubPageFetch({ '/quote/AAPL': page });
  return { storage, chrome };
}

test.afterEach(() => {
  uninstallChrome();
  delete globalThis.fetch;
});

const background = () => import('../src/background.js');

/* ------------------------------------------------------------------ *
 * Consent
 * ------------------------------------------------------------------ */

test('monitoring does nothing until it is switched on', async () => {
  // An extension that starts fetching pages on a timer the moment it is
  // installed, unasked, is not one worth trusting.
  setup({ settings: { monitorEnabled: false } });
  const { runMonitorPass } = await background();

  const result = await runMonitorPass();

  assert.equal(result.skipped, 'monitoring is off');
  assert.equal(globalThis.fetch.calls.length, 0);
});

test('the alarm is cleared rather than left running when monitoring is off', async () => {
  const { chrome } = setup({ settings: { monitorEnabled: false } });
  const { syncMonitorAlarm } = await background();

  const result = await syncMonitorAlarm();

  assert.equal(result.scheduled, false);
  assert.ok(chrome._calls.alarmsCleared.includes(MONITOR_ALARM));
  assert.equal(chrome._alarms.size, 0);
});

test('switching monitoring on schedules the alarm at the chosen interval', async () => {
  const { chrome } = setup({ settings: { monitorEnabled: false } });
  const { handleRequest } = await background();

  const result = await handleRequest({ type: MSG.SET_MONITOR, payload: { enabled: true, intervalMinutes: 30 } });

  assert.equal(result.monitorEnabled, true);
  assert.equal(result.minutes, 30);
  assert.equal(chrome._alarms.get(MONITOR_ALARM).periodInMinutes, 30);
});

test('an interval Chrome would refuse is rejected rather than silently changed', async () => {
  setup();
  const { handleRequest } = await background();
  await assert.rejects(
    () => handleRequest({ type: MSG.SET_MONITOR, payload: { intervalMinutes: 0 } }),
    /at least 1 minute/
  );
});

test('an absurd interval is clamped rather than scheduled', async () => {
  setup();
  const { handleRequest } = await background();
  const result = await handleRequest({ type: MSG.SET_MONITOR, payload: { enabled: true, intervalMinutes: 99999 } });
  assert.equal(result.monitorIntervalMinutes, 24 * 60);
});

/* ------------------------------------------------------------------ *
 * A pass
 * ------------------------------------------------------------------ */

test('a pass refreshes, evaluates, and raises on every channel at once', async () => {
  const { chrome, storage } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }],
    snapshots: { AAPL: { ticker: 'AAPL', current_price: 210, source_url: URL_FOR } },
  });
  const { runMonitorPass } = await background();

  const result = await runMonitorPass();

  assert.equal(result.refreshed, 1);
  assert.equal(result.alerts, 1);

  // 1. the stored feed
  const stored = storage._dump()[STORAGE_KEYS.ALERTS];
  assert.equal(stored.length, 1);
  assert.match(stored[0].title, /above 220/);
  assert.equal(stored[0].seen, false);

  // 2. the OS notification, keyed by the alert id so a click can find it
  assert.equal(chrome._calls.notifications.length, 1);
  assert.equal(chrome._calls.notifications[0].id, stored[0].id);

  // 3. the toolbar badge
  assert.equal(chrome._calls.badge.at(-1), '1');
});

test('a pass that changes nothing raises nothing', async () => {
  const { chrome, storage } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }],
    // Already above the level on the previous reading: same event, not a new one.
    snapshots: { AAPL: { ticker: 'AAPL', current_price: 223, source_url: URL_FOR } },
  });
  const { runMonitorPass } = await background();

  assert.equal((await runMonitorPass()).alerts, 0);
  assert.equal(chrome._calls.notifications.length, 0);
  assert.equal(storage._dump()[STORAGE_KEYS.ALERTS], undefined);
});

test('a ticker whose refresh failed is not evaluated against a stale reading', async () => {
  // Otherwise a crossing from hours ago re-fires every time the page is down.
  const { chrome } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 100, comparator: 'above' }],
    snapshots: { AAPL: { ticker: 'AAPL', current_price: 224.5, source_url: URL_FOR } },
    page: EMPTY_PAGE,
  });
  const { runMonitorPass } = await background();

  const result = await runMonitorPass();

  assert.equal(result.failed, 1);
  assert.equal(result.alerts, 0);
  assert.equal(chrome._calls.notifications.length, 0);
});

test('the rule bookkeeping is written back so the next pass is quiet', async () => {
  const { storage } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }],
    snapshots: { AAPL: { ticker: 'AAPL', current_price: 210, source_url: URL_FOR } },
  });
  const { runMonitorPass } = await background();
  await runMonitorPass();

  const rule = storage._dump()[STORAGE_KEYS.ALERT_RULES].AAPL[0];
  assert.equal(rule.last_fired_price, 224.5);
  assert.ok(rule.last_fired_at);
});

test('an advice_flip rule uses the free local engine unless told otherwise', async () => {
  // A model call every fifteen minutes per ticker is real money spent on a
  // question that mostly answers "HOLD, same as last time".
  const { storage } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'advice_flip' }],
    settings: {
      monitorEnabled: true,
      providers: { anthropic: { apiKey: 'sk-ant-should-not-be-used', model: 'claude-opus-5' } },
    },
  });
  globalThis.fetch = stubPageFetch({ '/quote/AAPL': HEALTHY_PAGE });
  const { runMonitorPass } = await background();

  await runMonitorPass();

  // The only fetch was the quote page; nothing went to a provider.
  for (const url of globalThis.fetch.calls) {
    assert.doesNotMatch(url, /api\.anthropic\.com|api\.groq\.com/);
  }
  // And the verdict was recorded rather than announced, first time round.
  assert.ok(storage._dump()[STORAGE_KEYS.ALERT_RULES].AAPL[0].last_action);
  assert.equal(storage._dump()[STORAGE_KEYS.ALERTS], undefined);
});

test('a target rule fires off the targets already on the position', async () => {
  const { storage } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'target' }],
    portfolio: { AAPL: { shares: 10, avg_cost: 190, target_sell_above: 220 } },
    snapshots: { AAPL: { ticker: 'AAPL', current_price: 210, source_url: URL_FOR } },
  });
  const { runMonitorPass } = await background();

  assert.equal((await runMonitorPass()).alerts, 1);
  assert.match(storage._dump()[STORAGE_KEYS.ALERTS][0].title, /sell target/);
});

/* ------------------------------------------------------------------ *
 * The feed
 * ------------------------------------------------------------------ */

test('alerts are readable, markable and clearable from the dashboard', async () => {
  const { chrome } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }],
    snapshots: { AAPL: { ticker: 'AAPL', current_price: 210, source_url: URL_FOR } },
  });
  const { runMonitorPass, handleRequest } = await background();
  await runMonitorPass();

  const state = await handleRequest({ type: MSG.GET_DASHBOARD_STATE });
  assert.equal(state.alerts.length, 1);
  assert.ok(state.alertRules.AAPL);

  const seen = await handleRequest({ type: MSG.MARK_ALERTS_SEEN, payload: { ids: null } });
  assert.equal(seen.alerts.every((alert) => alert.seen), true);
  assert.equal(chrome._calls.badge.at(-1), '', 'the badge clears once everything is read');

  const cleared = await handleRequest({ type: MSG.CLEAR_ALERTS });
  assert.deepEqual(cleared.alerts, []);
});

test('the same alert is never recorded twice', async () => {
  const { storage } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }],
    snapshots: { AAPL: { ticker: 'AAPL', current_price: 210, source_url: URL_FOR } },
  });
  const { evaluateAlertsFor } = await background();
  const snapshot = { ticker: 'AAPL', current_price: 224.5, currency: 'USD', extracted_at: '2026-08-22T12:00:00Z' };
  const previous = { ticker: 'AAPL', current_price: 210 };

  await evaluateAlertsFor('AAPL', { snapshot, previous });
  // Same reading, same rule: the id matches and the second is dropped.
  await evaluateAlertsFor('AAPL', { snapshot, previous });

  assert.equal(storage._dump()[STORAGE_KEYS.ALERTS].length, 1);
});

/* ------------------------------------------------------------------ *
 * Rule management
 * ------------------------------------------------------------------ */

test('a new watch starts with a target rule and nothing noisier', async () => {
  setup();
  const { handleRequest } = await background();

  const result = await handleRequest({ type: MSG.ADD_WATCH, payload: { ticker: 'NVDA' } });

  assert.equal(result.rules.NVDA.length, 1);
  assert.equal(result.rules.NVDA[0].kind, 'target');
});

test('removing a ticker takes its rules with it', async () => {
  const { storage } = setup({
    rules: [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }],
  });
  const { handleRequest } = await background();

  await handleRequest({ type: MSG.REMOVE_WATCH, payload: { ticker: 'AAPL' } });

  // Rules for a ticker nobody watches would evaluate against nothing forever.
  assert.deepEqual(storage._dump()[STORAGE_KEYS.ALERT_RULES], {});
});

test('a rule that could never fire is refused at the point it is written', async () => {
  setup();
  const { handleRequest } = await background();
  await assert.rejects(
    () => handleRequest({ type: MSG.SAVE_ALERT_RULE, payload: { ticker: 'AAPL', kind: 'percent' } }),
    /could never fire/
  );
});

test('a rule can be saved, edited in place, and deleted', async () => {
  setup();
  const { handleRequest } = await background();

  const saved = await handleRequest({
    type: MSG.SAVE_ALERT_RULE,
    payload: { id: 'r9', ticker: 'AAPL', kind: 'percent', threshold: 5, direction: 'up' },
  });
  assert.equal(saved.rules.AAPL.length, 1);

  const edited = await handleRequest({
    type: MSG.SAVE_ALERT_RULE,
    payload: { id: 'r9', ticker: 'AAPL', kind: 'percent', threshold: 8, direction: 'both' },
  });
  assert.equal(edited.rules.AAPL.length, 1, 'editing must not duplicate the rule');
  assert.equal(edited.rules.AAPL[0].threshold, 8);

  const deleted = await handleRequest({
    type: MSG.DELETE_ALERT_RULE, payload: { ticker: 'AAPL', id: 'r9' },
  });
  assert.equal(deleted.removed, true);
  assert.equal(deleted.rules.AAPL, undefined);
});
