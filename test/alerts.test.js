/**
 * The alert rules engine.
 *
 * Two properties are worth more than any individual case here, and most of the
 * tests below exist to pin one of them down:
 *
 *   an alert fires on a crossing, not on a state — otherwise every refresh
 *   re-announces the same fact until the user switches notifications off;
 *
 *   a missing number never produces an alert — a price that failed to parse is
 *   not a fall to zero, and a null baseline is not a 100% move.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRules, normalizeRule, inCooldown, baselineFor, describeRule, defaultRulesFor, RULE_KINDS,
} from '../src/lib/alerts.js';

const NOW = Date.parse('2026-08-22T12:00:00Z');

const snap = (price, extra = {}) => ({
  ticker: 'AAPL',
  current_price: price,
  currency: 'USD',
  change_percentage: null,
  extracted_at: '2026-08-22T12:00:00Z',
  ...extra,
});

const run = (rules, context) => evaluateRules({ rules, now: NOW, ...context });

/* ------------------------------------------------------------------ *
 * Rule shape
 * ------------------------------------------------------------------ */

test('a rule of an unknown kind is refused rather than stored dormant', () => {
  assert.equal(normalizeRule({ ticker: 'AAPL', kind: 'vibes' }), null);
  assert.equal(normalizeRule({ ticker: 'AAPL' }), null);
  assert.equal(normalizeRule({ kind: 'target' }), null);
});

test('a percent rule with no usable threshold is refused', () => {
  // A rule that can never fire is worse than no rule: the user believes they
  // are being watched.
  assert.equal(normalizeRule({ ticker: 'AAPL', kind: 'percent' }), null);
  assert.equal(normalizeRule({ ticker: 'AAPL', kind: 'percent', threshold: 0 }), null);
  assert.equal(normalizeRule({ ticker: 'AAPL', kind: 'percent', threshold: -5 }), null);
  assert.ok(normalizeRule({ ticker: 'AAPL', kind: 'percent', threshold: '5' }));
});

test('a level rule with no usable price is refused', () => {
  assert.equal(normalizeRule({ ticker: 'AAPL', kind: 'level' }), null);
  assert.equal(normalizeRule({ ticker: 'AAPL', kind: 'level', price: 0 }), null);
  assert.equal(normalizeRule({ ticker: 'AAPL', kind: 'level', price: '240' }).price, 240);
});

test('defaults are filled in without being invented', () => {
  const rule = normalizeRule({ ticker: 'aapl', kind: 'percent', threshold: 5 });
  assert.equal(rule.ticker, 'AAPL');
  assert.equal(rule.enabled, true);
  assert.equal(rule.direction, 'both');
  assert.equal(rule.baseline, 'previous_scan');
  assert.equal(rule.comparator, undefined, 'a percent rule has no comparator');
});

test('every documented kind normalizes', () => {
  const inputs = {
    target: {},
    percent: { threshold: 5 },
    level: { price: 240 },
    advice_flip: {},
  };
  for (const kind of RULE_KINDS) {
    assert.ok(normalizeRule({ ticker: 'AAPL', kind, ...inputs[kind] }), `${kind} should normalize`);
  }
});

/* ------------------------------------------------------------------ *
 * Nothing fires without a number
 * ------------------------------------------------------------------ */

test('no snapshot, no alerts', () => {
  const rules = [{ ticker: 'AAPL', kind: 'level', price: 100, comparator: 'above' }];
  assert.deepEqual(run(rules, { snapshot: null }).alerts, []);
});

test('a price that failed to parse is not treated as a fall to zero', () => {
  const rules = [{ ticker: 'AAPL', kind: 'level', price: 100, comparator: 'below' }];
  assert.deepEqual(run(rules, { snapshot: snap(null) }).alerts, []);
  assert.deepEqual(run(rules, { snapshot: snap(NaN) }).alerts, []);
});

test('a disabled rule is skipped', () => {
  const rules = [{ ticker: 'AAPL', kind: 'level', price: 100, comparator: 'above', enabled: false }];
  assert.deepEqual(run(rules, { snapshot: snap(224.5) }).alerts, []);
});

/* ------------------------------------------------------------------ *
 * Level rules
 * ------------------------------------------------------------------ */

test('a level rule fires as the price crosses it', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }];
  const { alerts } = run(rules, { snapshot: snap(224.5), previous: snap(215) });

  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /above 220/);
  assert.equal(alerts[0].direction, 'up');
  assert.equal(alerts[0].seen, false);
});

test('a level rule does not fire again while the price simply stays past it', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }];
  // Already above on the previous reading: this is the same event, not a new one.
  assert.deepEqual(run(rules, { snapshot: snap(226), previous: snap(224.5) }).alerts, []);
});

test('a below rule fires downward and ignores a rise', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 200, comparator: 'below' }];
  assert.equal(run(rules, { snapshot: snap(195), previous: snap(205) }).alerts.length, 1);
  assert.equal(run(rules, { snapshot: snap(205), previous: snap(195) }).alerts.length, 0);
});

test('with no previous reading, a level already crossed still fires once', () => {
  // A freshly added ticker has no history; staying silent would mean the rule
  // never fires until the price happens to cross again.
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }];
  assert.equal(run(rules, { snapshot: snap(224.5), previous: null }).alerts.length, 1);
});

/* ------------------------------------------------------------------ *
 * Percent rules
 * ------------------------------------------------------------------ */

test('a percent rule fires on a move past its threshold', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'percent', threshold: 5, direction: 'both' }];
  const { alerts } = run(rules, { snapshot: snap(210), previous: snap(200) });

  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /\+5\.00%/);
  assert.equal(alerts[0].direction, 'up');
});

test('a move short of the threshold is silent', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'percent', threshold: 5 }];
  assert.deepEqual(run(rules, { snapshot: snap(208), previous: snap(200) }).alerts, []);
});

test('direction filters the half of the move that was not asked for', () => {
  const up = [{ id: 'r1', ticker: 'AAPL', kind: 'percent', threshold: 5, direction: 'up' }];
  const down = [{ id: 'r2', ticker: 'AAPL', kind: 'percent', threshold: 5, direction: 'down' }];

  assert.equal(run(up, { snapshot: snap(210), previous: snap(200) }).alerts.length, 1);
  assert.equal(run(up, { snapshot: snap(190), previous: snap(200) }).alerts.length, 0);
  assert.equal(run(down, { snapshot: snap(190), previous: snap(200) }).alerts.length, 1);
  assert.equal(run(down, { snapshot: snap(210), previous: snap(200) }).alerts.length, 0);
});

test('each baseline measures from what it says it does', () => {
  const context = {
    previous: snap(200),
    position: { avg_cost: 150 },
    history: [{ price: 210 }, { price: 205 }, { price: 180 }],
  };
  const of = (baseline, extra = {}) => baselineFor(
    normalizeRule({ ticker: 'AAPL', kind: 'percent', threshold: 1, baseline, ...extra }),
    context
  );

  assert.equal(of('previous_scan'), 200);
  assert.equal(of('avg_cost'), 150);
  assert.equal(of('session_open'), 180, 'the oldest point held, not the newest');
  assert.equal(of('last_alert', { last_fired_price: 190 }), 190);
});

test('a baseline that is unavailable produces silence, not a substitute', () => {
  // Falling back to another baseline would hand the user a percentage measured
  // from something they did not choose.
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'percent', threshold: 5, baseline: 'avg_cost' }];
  const { alerts } = run(rules, { snapshot: snap(300), previous: snap(200), position: {} });
  assert.deepEqual(alerts, []);
});

test('no previous reading means a previous_scan rule stays quiet', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'percent', threshold: 5 }];
  assert.deepEqual(run(rules, { snapshot: snap(224.5), previous: null }).alerts, []);
});

test('the last-alert baseline falls back to the last reading before any alert', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'percent', threshold: 5, baseline: 'last_alert' }];
  const { alerts } = run(rules, { snapshot: snap(210), previous: snap(200) });
  assert.equal(alerts.length, 1);
});

/* ------------------------------------------------------------------ *
 * Target rules
 * ------------------------------------------------------------------ */

test('a target rule uses the targets already on the position', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'target' }];
  const position = { target_buy_below: 200, target_sell_above: 250 };

  const sell = run(rules, { snapshot: snap(255), previous: snap(240), position });
  assert.equal(sell.alerts.length, 1);
  assert.match(sell.alerts[0].title, /sell target/);

  const buy = run(rules, { snapshot: snap(195), previous: snap(205), position });
  assert.equal(buy.alerts.length, 1);
  assert.match(buy.alerts[0].title, /buy target/);
});

test('a target rule is silent between the two targets', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'target' }];
  const position = { target_buy_below: 200, target_sell_above: 250 };
  assert.deepEqual(run(rules, { snapshot: snap(224.5), previous: snap(220), position }).alerts, []);
});

test('a target rule with no position and no targets cannot fire', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'target' }];
  assert.deepEqual(run(rules, { snapshot: snap(224.5), previous: snap(200) }).alerts, []);
  assert.deepEqual(run(rules, { snapshot: snap(224.5), previous: snap(200), position: {} }).alerts, []);
});

test('a target rule does not re-announce a level already held', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'target' }];
  const position = { target_sell_above: 250 };
  assert.deepEqual(run(rules, { snapshot: snap(260), previous: snap(255), position }).alerts, []);
});

/* ------------------------------------------------------------------ *
 * Advice flips
 * ------------------------------------------------------------------ */

test('the first verdict is recorded without being announced', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'advice_flip' }];
  const { alerts, updates } = run(rules, { snapshot: snap(224.5), advice: { action: 'HOLD' } });

  assert.deepEqual(alerts, []);
  assert.equal(updates.r1.last_action, 'HOLD');
});

test('a changed verdict fires and records the new one', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'advice_flip', last_action: 'HOLD' }];
  const { alerts, updates } = run(rules, {
    snapshot: snap(224.5),
    advice: { action: 'BUY', rationale: 'Price cleared the buy target.' },
  });

  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /HOLD → BUY/);
  assert.equal(updates.r1.last_action, 'BUY');
});

test('an unchanged verdict is silent', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'advice_flip', last_action: 'BUY' }];
  assert.deepEqual(run(rules, { snapshot: snap(224.5), advice: { action: 'BUY' } }).alerts, []);
});

test('no advice at all leaves the rule untouched', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'advice_flip', last_action: 'BUY' }];
  const { alerts, updates } = run(rules, { snapshot: snap(224.5), advice: null });
  assert.deepEqual(alerts, []);
  assert.deepEqual(updates, {});
});

/* ------------------------------------------------------------------ *
 * Cooldown
 * ------------------------------------------------------------------ */

test('a rule that just fired stays quiet for its cooldown', () => {
  const rules = [{
    id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above',
    cooldown_minutes: 60, last_fired_at: '2026-08-22T11:30:00Z',
  }];
  assert.deepEqual(run(rules, { snapshot: snap(224.5), previous: snap(215) }).alerts, []);
});

test('the same rule fires once the cooldown has passed', () => {
  const rules = [{
    id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above',
    cooldown_minutes: 60, last_fired_at: '2026-08-22T10:30:00Z',
  }];
  assert.equal(run(rules, { snapshot: snap(224.5), previous: snap(215) }).alerts.length, 1);
});

test('a zero cooldown means no suppression', () => {
  const rule = { last_fired_at: '2026-08-22T11:59:00Z', cooldown_minutes: 0 };
  assert.equal(inCooldown(rule, NOW), false);
});

test('a rule that has never fired is never in cooldown', () => {
  assert.equal(inCooldown({ cooldown_minutes: 60 }, NOW), false);
  assert.equal(inCooldown({ last_fired_at: 'nonsense', cooldown_minutes: 60 }, NOW), false);
});

test('a flip during a cooldown is still recorded, just not announced', () => {
  // Otherwise the verdict change is lost entirely and the next real flip is
  // measured against a stale action.
  const rules = [{
    id: 'r1', ticker: 'AAPL', kind: 'advice_flip', last_action: 'HOLD',
    cooldown_minutes: 60, last_fired_at: '2026-08-22T11:30:00Z',
  }];
  const { alerts, updates } = run(rules, { snapshot: snap(224.5), advice: { action: 'SELL' } });

  assert.deepEqual(alerts, []);
  assert.equal(updates.r1.last_action, 'SELL');
});

test('firing records what it fired on, for the next pass to measure from', () => {
  const rules = [{ id: 'r1', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' }];
  const { updates } = run(rules, { snapshot: snap(224.5), previous: snap(215) });

  assert.equal(updates.r1.last_fired_price, 224.5);
  assert.equal(updates.r1.last_fired_at, new Date(NOW).toISOString());
});

/* ------------------------------------------------------------------ *
 * Several rules at once
 * ------------------------------------------------------------------ */

test('independent rules fire independently', () => {
  const rules = [
    { id: 'level', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' },
    { id: 'pct', ticker: 'AAPL', kind: 'percent', threshold: 5 },
    { id: 'tgt', ticker: 'AAPL', kind: 'target' },
  ];
  const { alerts } = run(rules, {
    snapshot: snap(224.5),
    previous: snap(200),
    position: { target_sell_above: 222 },
  });

  assert.deepEqual(alerts.map((alert) => alert.rule_id).sort(), ['level', 'pct', 'tgt']);
  // Every alert carries enough to render without looking anything else up.
  for (const alert of alerts) {
    assert.equal(alert.ticker, 'AAPL');
    assert.equal(alert.price, 224.5);
    assert.equal(alert.currency, 'USD');
    assert.ok(alert.title && alert.body && alert.at);
  }
});

test('one malformed rule does not stop the others', () => {
  const rules = [
    { id: 'bad', ticker: 'AAPL', kind: 'percent' }, // no threshold
    { id: 'good', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' },
  ];
  const { alerts } = run(rules, { snapshot: snap(224.5), previous: snap(215) });
  assert.deepEqual(alerts.map((alert) => alert.rule_id), ['good']);
});

test('alert ids are distinct per rule so nothing overwrites anything', () => {
  const rules = [
    { id: 'a', ticker: 'AAPL', kind: 'level', price: 220, comparator: 'above' },
    { id: 'b', ticker: 'AAPL', kind: 'level', price: 221, comparator: 'above' },
  ];
  const { alerts } = run(rules, { snapshot: snap(224.5), previous: snap(215) });
  assert.equal(new Set(alerts.map((alert) => alert.id)).size, 2);
});

/* ------------------------------------------------------------------ *
 * Description and defaults
 * ------------------------------------------------------------------ */

test('a new ticker gets a target rule and nothing noisier', () => {
  const rules = defaultRulesFor('AAPL');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].kind, 'target');
  // And it does nothing at all until targets exist.
  assert.deepEqual(run(rules, { snapshot: snap(224.5), previous: snap(200) }).alerts, []);
});

test('every rule kind describes itself in words', () => {
  assert.equal(describeRule({ ticker: 'AAPL', kind: 'target' }), 'reaches your buy or sell target');
  assert.match(describeRule({ ticker: 'AAPL', kind: 'percent', threshold: 5, direction: 'up' }), /moves up 5%/);
  assert.match(describeRule({ ticker: 'AAPL', kind: 'level', price: 240, comparator: 'below' }), /goes below 240/);
  assert.equal(describeRule({ ticker: 'AAPL', kind: 'advice_flip' }), 'the recommendation changes');
  assert.equal(describeRule({ kind: 'nonsense' }), 'an invalid rule');
});
