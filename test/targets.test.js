/**
 * The target suggester. Every rule here is arithmetic on the user's own data,
 * so the tests pin the arithmetic and, just as importantly, which evidence wins
 * when several are available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestTargets, summarizeHistory, averageApprovedBuy } from '../src/lib/targets.js';

const points = (...prices) => prices.map((price, index) => ({ at: `2026-08-${10 + index}T00:00:00Z`, price }));

test('summarizeHistory reports the shape of a price series', () => {
  const summary = summarizeHistory(points(100, 110, 90, 100));
  assert.equal(summary.count, 4);
  assert.equal(summary.mean, 100);
  assert.equal(summary.min, 90);
  assert.equal(summary.max, 110);
  assert.equal(summary.stdev, 7.07);
  assert.equal(summary.latest, 100);
});

test('summarizeHistory ignores junk and empty series', () => {
  assert.equal(summarizeHistory([]), null);
  assert.equal(summarizeHistory(null), null);
  assert.equal(summarizeHistory([{ price: null }, { price: 'abc' }, { price: -5 }]), null);
  assert.equal(summarizeHistory([{ price: '120.50' }, { price: 119.5 }]).mean, 120);
});

test('averageApprovedBuy counts only approved BUYs for that ticker', () => {
  const decisions = [
    { ticker: 'AAPL', final_action: 'BUY', verdict: 'APPROVED', price: 200 },
    { ticker: 'AAPL', final_action: 'BUY', verdict: 'APPROVED', price: 220 },
    { ticker: 'AAPL', final_action: 'BUY', verdict: 'REJECTED', price: 500 },
    { ticker: 'AAPL', final_action: 'SELL', verdict: 'APPROVED', price: 900 },
    { ticker: 'MSFT', final_action: 'BUY', verdict: 'APPROVED', price: 400 },
  ];
  assert.deepEqual(averageApprovedBuy(decisions, 'AAPL'), { count: 2, mean: 210 });
  assert.equal(averageApprovedBuy(decisions, 'NVDA'), null);
  assert.equal(averageApprovedBuy([], 'AAPL'), null);
});

test('scan history is the strongest anchor, and sets the band from its own spread', () => {
  const suggestion = suggestTargets({
    ticker: 'AAPL',
    snapshot: { ticker: 'AAPL', current_price: 100 },
    history: points(100, 110, 90, 100),
    position: { avg_cost: 500 },                       // ignored: history wins
    decisions: [{ ticker: 'AAPL', final_action: 'BUY', verdict: 'APPROVED', price: 700 }],
  });

  assert.equal(suggestion.basis, 'history');
  assert.equal(suggestion.anchor, 100);
  assert.equal(suggestion.sample_size, 4);
  // stdev 7.07 on a mean of 100 is a 7.07% band
  assert.equal(suggestion.target_buy_below, 92.93);
  assert.equal(suggestion.target_sell_above, 107.07);
  assert.match(suggestion.note, /4 scans averaging 100/);
});

test('a flat series still gets a usable band rather than a zero-width one', () => {
  const suggestion = suggestTargets({ ticker: 'AAPL', history: points(100, 100, 100, 100) });
  assert.equal(suggestion.anchor, 100);
  assert.equal(suggestion.target_buy_below, 95, 'falls back to the flat 5% band');
  assert.equal(suggestion.target_sell_above, 105);
});

test('a wild series has its band clamped', () => {
  const suggestion = suggestTargets({ ticker: 'AAPL', history: points(10, 200, 10, 200) });
  assert.equal(suggestion.band, 0.2, 'never wider than 20%');
});

test('with too little history, approved BUY decisions are the anchor', () => {
  const suggestion = suggestTargets({
    ticker: 'AAPL',
    snapshot: { ticker: 'AAPL', current_price: 300 },
    history: points(100, 110),                          // below the minimum
    position: { avg_cost: 500 },
    decisions: [
      { ticker: 'AAPL', final_action: 'BUY', verdict: 'APPROVED', price: 200 },
      { ticker: 'AAPL', final_action: 'BUY', verdict: 'APPROVED', price: 220 },
    ],
  });
  assert.equal(suggestion.basis, 'decisions');
  assert.equal(suggestion.anchor, 210);
  assert.equal(suggestion.target_buy_below, 199.5);
  assert.equal(suggestion.target_sell_above, 220.5);
  assert.match(suggestion.note, /2 approved BUY decision/);
});

test('failing that, the average cost anchors it', () => {
  const suggestion = suggestTargets({ ticker: 'AAPL', position: { avg_cost: 180 }, snapshot: { current_price: 300 } });
  assert.equal(suggestion.basis, 'cost');
  assert.equal(suggestion.target_buy_below, 171);
  assert.equal(suggestion.target_sell_above, 189);
});

test('a first-ever scan anchors on today, and says so', () => {
  const suggestion = suggestTargets({ ticker: 'AAPL', snapshot: { ticker: 'AAPL', current_price: 200 } });
  assert.equal(suggestion.basis, 'price');
  assert.equal(suggestion.target_buy_below, 190);
  assert.equal(suggestion.target_sell_above, 210);
  assert.match(suggestion.note, /Scan this ticker a few more times/);
});

test('the note warns when a suggestion fires immediately', () => {
  // Cost far above the current price: the band lands under today's quote.
  const sell = suggestTargets({ ticker: 'AAPL', position: { avg_cost: 100 }, snapshot: { current_price: 500 } });
  assert.match(sell.note, /already at or over the sell target/);

  const buy = suggestTargets({ ticker: 'AAPL', position: { avg_cost: 500 }, snapshot: { current_price: 100 } });
  assert.match(buy.note, /already at or under the buy target/);
});

test('with nothing to go on it declines rather than inventing a number', () => {
  assert.equal(suggestTargets({ ticker: 'AAPL' }), null);
  assert.equal(suggestTargets({}), null);
  assert.equal(suggestTargets({ ticker: 'AAPL', position: { avg_cost: 0 }, snapshot: { current_price: null } }), null);
});

test('the buy target is always below the sell target', () => {
  const cases = [
    { history: points(100, 110, 90, 100) },
    { position: { avg_cost: 180 } },
    { snapshot: { current_price: 12.5 } },
    { history: points(10, 200, 10, 200) },
  ];
  for (const input of cases) {
    const suggestion = suggestTargets({ ticker: 'AAPL', ...input });
    assert.ok(suggestion.target_buy_below < suggestion.target_sell_above, JSON.stringify(input));
    assert.ok(suggestion.target_buy_below > 0);
  }
});
