/**
 * The agent's own state file, and how it resolves its configuration.
 *
 * The registry is the interesting half. The agent and the extension each keep a
 * copy of the healed selectors, because they are separate processes with
 * separate storage and the agent has to work with no browser running at all.
 * Two copies that both accept writes is a merge problem, and the merge rule —
 * newest `healed_at` wins, per host and field — is what keeps a repair made on
 * one side from being reverted by the other's older answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadState, saveState, getRegistry, recordHealedSelector, forgetHealedSelector,
  recordHealEvent, getHealLog, getSnapshots, saveSnapshot, mergeRegistry,
} from '../agent/registry.mjs';
import { endpointFromEnv, bridgeFromEnv, tuningFromEnv, loadAgentConfig } from '../agent/config.mjs';

let dir = null;
let file = null;

test.beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-state-'));
  file = path.join(dir, 'registry.json');
});

test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const proposal = (selector, extra = {}) => ({ selector, strategy: 'css', confidence: 0.9, ...extra });

/* ------------------------------------------------------------------ *
 * The file
 * ------------------------------------------------------------------ */

test('a missing state file reads as empty rather than throwing', () => {
  const state = loadState(file);
  assert.deepEqual(state.selector_registry, {});
  assert.deepEqual(state.heal_log, []);
  assert.equal(existsSync(file), false, 'reading must not create it');
});

test('a truncated state file costs the healed selectors, not the run', () => {
  writeFileSync(file, '{"selector_registry": {"a": ');
  const state = loadState(file);
  assert.deepEqual(state.selector_registry, {}, 'a killed process mid-write must not brick every future run');
});

test('a healed selector survives a write and a re-read', () => {
  recordHealedSelector('finance.yahoo.com', 'price', proposal('.qz-8f31ab'), file);

  const stored = getRegistry(file)['finance.yahoo.com'].price;
  assert.equal(stored.selector, '.qz-8f31ab');
  assert.equal(stored.source, 'healed');
  assert.equal(typeof stored.healed_at, 'string');
});

test('forgetting the last selector for a host drops the host with it', () => {
  recordHealedSelector('h1.example', 'price', proposal('.p'), file);
  assert.equal(forgetHealedSelector('h1.example', 'price', file), true);
  assert.deepEqual(getRegistry(file), {});
  assert.equal(forgetHealedSelector('h1.example', 'price', file), false, 'forgetting twice is not an error');
});

test('the heal log is newest first and capped', () => {
  for (let index = 0; index < 105; index++) {
    recordHealEvent({ field: 'price', host: 'h', at: new Date(index).toISOString(), attempt: index }, file);
  }
  const log = getHealLog(file);
  assert.equal(log.length, 100);
  assert.equal(log[0].attempt, 104);
});

test('a snapshot without a ticker is not stored', () => {
  assert.equal(saveSnapshot({ current_price: 1 }, file), null);
  assert.deepEqual(getSnapshots(file), {});
});

test('snapshots are stored per ticker and overwritten in place', () => {
  saveSnapshot({ ticker: 'AAPL', current_price: 1 }, file);
  saveSnapshot({ ticker: 'AAPL', current_price: 2 }, file);
  saveSnapshot({ ticker: 'MSFT', current_price: 3 }, file);

  const snapshots = getSnapshots(file);
  assert.equal(snapshots.AAPL.current_price, 2);
  assert.equal(Object.keys(snapshots).length, 2);
});

/* ------------------------------------------------------------------ *
 * The merge
 * ------------------------------------------------------------------ */

test('a newer selector from the extension replaces the agent\'s older one', () => {
  saveState({
    version: 1,
    selector_registry: { h: { price: { selector: '.old', strategy: 'css', healed_at: '2026-01-01T00:00:00.000Z' } } },
    heal_log: [],
    snapshots: {},
  }, file);

  const { merged } = mergeRegistry({ h: { price: { selector: '.new', strategy: 'css', healed_at: '2026-06-01T00:00:00.000Z' } } }, file);

  assert.equal(merged, 1);
  assert.equal(getRegistry(file).h.price.selector, '.new');
});

test('an older selector from the extension does not revert a fresher repair', () => {
  saveState({
    version: 1,
    selector_registry: { h: { price: { selector: '.new', strategy: 'css', healed_at: '2026-06-01T00:00:00.000Z' } } },
    heal_log: [],
    snapshots: {},
  }, file);

  const { merged } = mergeRegistry({ h: { price: { selector: '.old', strategy: 'css', healed_at: '2026-01-01T00:00:00.000Z' } } }, file);

  assert.equal(merged, 0);
  assert.equal(getRegistry(file).h.price.selector, '.new');
});

test('rubbish in the incoming registry is skipped rather than stored', () => {
  const { merged } = mergeRegistry({
    h: { price: { selector: '   ' }, volume: null, ticker: { selector: 42 } },
    bad: 'not an object',
  }, file);

  assert.equal(merged, 0);
  assert.deepEqual(getRegistry(file), {});
});

test('an unknown strategy is normalized to css rather than trusted', () => {
  mergeRegistry({ h: { price: { selector: '.p', strategy: 'jquery', healed_at: '2026-06-01T00:00:00.000Z' } } }, file);
  assert.equal(getRegistry(file).h.price.strategy, 'css');
});

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

test('BRIGHTDATA_BROWSER_URL wins over the other two spellings', () => {
  const resolved = endpointFromEnv({
    BRIGHTDATA_BROWSER_URL: 'wss://brd-customer-a-zone-z1:pw@brd.superproxy.io:9222',
    BRIGHTDATA_AUTH: 'brd-customer-b-zone-z2:pw2',
    BRIGHTDATA_CUSTOMER: 'c', BRIGHTDATA_ZONE: 'z3', BRIGHTDATA_PASSWORD: 'pw3',
  });

  assert.equal(resolved.ok, true, resolved.error);
  assert.equal(resolved.zone, 'z1');
  assert.equal(resolved.source, 'BRIGHTDATA_BROWSER_URL');
});

test('the bare AUTH pair from Bright Data\'s samples is accepted', () => {
  const resolved = endpointFromEnv({ AUTH: 'brd-customer-b-zone-z2:pw2' });
  assert.equal(resolved.ok, true, resolved.error);
  assert.equal(resolved.zone, 'z2');
  assert.equal(resolved.source, 'AUTH');
});

test('the three separate parts are assembled when nothing else is set', () => {
  const resolved = endpointFromEnv({ BRIGHTDATA_CUSTOMER: 'c', BRIGHTDATA_ZONE: 'z3', BRIGHTDATA_PASSWORD: 'pw3' });
  assert.equal(resolved.ok, true, resolved.error);
  assert.equal(resolved.customer, 'c');
  assert.equal(resolved.zone, 'z3');
});

test('an empty environment reports how to fix it', () => {
  const resolved = endpointFromEnv({});
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /BRIGHTDATA_BROWSER_URL/);
});

test('the bridge defaults to loopback on 8791', () => {
  const bridge = bridgeFromEnv({});
  assert.equal(bridge.host, '127.0.0.1');
  assert.equal(bridge.port, 8791);
  assert.equal(bridge.token, '');
});

test('a garbled timeout falls back to the default instead of becoming NaN', () => {
  const tuning = tuningFromEnv({ BRIGHTDATA_NAV_TIMEOUT_MS: 'soon', BRIGHTDATA_SETTLE_MS: '-5' });
  assert.equal(tuning.navigationTimeoutMs, 120000);
  assert.equal(tuning.settleMs, 1500);
});

test('captcha solving is on unless it is explicitly switched off', () => {
  assert.equal(tuningFromEnv({}).solveCaptcha, true);
  assert.equal(tuningFromEnv({ BRIGHTDATA_SOLVE_CAPTCHA: 'FALSE' }).solveCaptcha, false);
});

test('the printable summary never contains the password', () => {
  const config = loadAgentConfig({
    BRIGHTDATA_BROWSER_URL: 'wss://brd-customer-a-zone-z1:s3cr3tpass@brd.superproxy.io:9222',
    GROQ_API_KEY: 'gsk_abcdefghijklmnop',
  });

  const printed = JSON.stringify(config.summary);
  assert.equal(printed.includes('s3cr3tpass'), false, 'this object is logged and served over the bridge');
  assert.equal(printed.includes('gsk_abcdefghijklmnop'), false);
  assert.match(printed, /z1/);
});
