import test from 'node:test';
import assert from 'node:assert/strict';
import {
  heuristicAdvice, validateAdvice, positionPnl, buildAdvisoryContext, formatMoney, formatCompact,
  toNumberOrNull,
} from '../src/lib/advisor.js';

const snapshot = {
  ticker: 'AAPL',
  current_price: 224.5,
  currency: 'USD',
  change_percentage: '+1.80%',
  change_value: 1.8,
  volume: 52300000,
  news: ['Apple beats earnings expectations again'],
  extracted_at: '2026-08-19T20:55:00Z',
  source_url: 'https://finance.example.com/quote/AAPL',
};

test('price above the sell target with shares held yields SELL', () => {
  const advice = heuristicAdvice(snapshot, { shares: 10, avg_cost: 180, target_sell_above: 220 });
  assert.equal(advice.action, 'SELL');
  assert.ok(advice.confidence_score > 0.6);
  assert.match(advice.rationale, /sell target/i);
  assert.match(advice.rationale, /224\.50/);
  assert.equal(advice.user_action_required, true);
});

test('sell target hit with no shares held is not a SELL', () => {
  const advice = heuristicAdvice(snapshot, { shares: 0, target_sell_above: 220 });
  assert.equal(advice.action, 'HOLD');
  assert.match(advice.rationale, /No recorded position/);
});

test('price below the buy target yields BUY', () => {
  const advice = heuristicAdvice(snapshot, { target_buy_below: 240 });
  assert.equal(advice.action, 'BUY');
  assert.match(advice.rationale, /buy target/i);
});

test('no configured targets yields a low-confidence HOLD', () => {
  const advice = heuristicAdvice(snapshot, {});
  assert.equal(advice.action, 'HOLD');
  assert.equal(advice.confidence_score, 0.35);
  assert.match(advice.rationale, /No buy or sell target/i);
});

test('inside the target band yields HOLD', () => {
  const advice = heuristicAdvice(snapshot, { shares: 5, target_buy_below: 200, target_sell_above: 260 });
  assert.equal(advice.action, 'HOLD');
  assert.match(advice.rationale, /target band/i);
});

test('a violent intraday move discounts confidence on an actionable call', () => {
  const calm = heuristicAdvice(snapshot, { target_buy_below: 240 });
  const wild = heuristicAdvice({ ...snapshot, change_value: -12.5 }, { target_buy_below: 240 });
  assert.ok(wild.confidence_score < calm.confidence_score);
  assert.match(wild.rationale, /unusually large/);
});

test('every advisory keeps the human in the loop', () => {
  for (const position of [{}, { shares: 10, target_sell_above: 1 }, { target_buy_below: 1e9 }]) {
    assert.equal(heuristicAdvice(snapshot, position).user_action_required, true);
  }
});

test('confidence always lands inside 0..1', () => {
  const extremes = [
    { shares: 10, target_sell_above: 0.01 },
    { target_buy_below: 1e9 },
    { shares: 1, target_buy_below: 224.49, target_sell_above: 224.51 },
  ];
  for (const position of extremes) {
    const score = heuristicAdvice(snapshot, position).confidence_score;
    assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
  }
});

test('positionPnl computes unrealized profit or null', () => {
  assert.deepEqual(positionPnl(snapshot, { shares: 10, avg_cost: 200 }), {
    avg_cost: 200, shares: 10, per_share: 24.5, percent: 12.25, total: 245,
  });
  assert.equal(positionPnl(snapshot, {}), null);
  assert.equal(positionPnl(snapshot, { avg_cost: 0 }), null);
  assert.equal(positionPnl({ ...snapshot, current_price: null }, { avg_cost: 10 }), null);
});

test('validateAdvice accepts a well-formed advisory and normalizes it', () => {
  const advice = validateAdvice({
    ticker: 'aapl', action: 'buy', confidence_score: 0.777, rationale: 'A'.repeat(40), user_action_required: false,
  });
  assert.deepEqual(advice, {
    ticker: 'AAPL', action: 'BUY', confidence_score: 0.78, rationale: 'A'.repeat(40), user_action_required: true,
  });
});

test('validateAdvice rejects malformed model output', () => {
  const base = { ticker: 'AAPL', action: 'BUY', confidence_score: 0.5, rationale: 'A'.repeat(40) };
  assert.equal(validateAdvice(null), null);
  assert.equal(validateAdvice({ ...base, action: 'MAYBE' }), null);
  assert.equal(validateAdvice({ ...base, rationale: 'too short' }), null);
  assert.equal(validateAdvice({ ...base, confidence_score: 'high' }), null);
  assert.equal(validateAdvice({ ...base, confidence_score: -1 }), null);
  assert.equal(validateAdvice({ ...base, confidence_score: 500 }), null);
  assert.equal(validateAdvice({ ...base, ticker: undefined }), null);
});

test('validateAdvice tolerates a percentage confidence and a missing ticker', () => {
  const advice = validateAdvice({ action: 'HOLD', confidence_score: 62, rationale: 'A'.repeat(40) }, 'MSFT');
  assert.equal(advice.confidence_score, 0.62);
  assert.equal(advice.ticker, 'MSFT');
});

test('buildAdvisoryContext carries only normalized fields', () => {
  const context = buildAdvisoryContext(snapshot, { shares: '10', avg_cost: '200', target_buy_below: '' });
  assert.equal(context.user_position.shares, 10);
  assert.equal(context.user_position.avg_cost, 200);
  assert.equal(context.user_position.target_buy_below, null);
  assert.equal(context.news_headlines.length, 1);
  assert.ok(context.unrealized_pnl);
});

test('formatters degrade gracefully', () => {
  assert.equal(formatMoney(224.5, 'USD'), 'USD 224.50');
  assert.equal(formatMoney(-3.5, 'EUR'), '-EUR 3.50');
  assert.equal(formatMoney(null), 'n/a');
  assert.equal(formatCompact(52300000), '52.30M');
  assert.equal(formatCompact(950), '950');
  assert.equal(formatCompact(NaN), 'n/a');
});

test('empty-string and zero targets read as unset, not as a target of zero', () => {
  const blank = heuristicAdvice(snapshot, { target_buy_below: '', target_sell_above: null, shares: '' });
  assert.equal(blank.action, 'HOLD');
  assert.match(blank.rationale, /No buy or sell target/i);

  const zeroed = heuristicAdvice(snapshot, { target_buy_below: 0, target_sell_above: 0, shares: 5 });
  assert.equal(zeroed.action, 'HOLD');
  assert.match(zeroed.rationale, /No buy or sell target/i);
});

test('toNumberOrNull distinguishes blank from zero', () => {
  assert.equal(toNumberOrNull(''), null);
  assert.equal(toNumberOrNull('  '), null);
  assert.equal(toNumberOrNull(null), null);
  assert.equal(toNumberOrNull(undefined), null);
  assert.equal(toNumberOrNull('0'), 0);
  assert.equal(toNumberOrNull('12.5'), 12.5);
  assert.equal(toNumberOrNull('abc'), null);
});
