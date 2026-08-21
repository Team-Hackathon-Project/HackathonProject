/**
 * The cross-scan check that catches a selector reading a page-global number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findStuckPrice, hostOfUrl } from '../src/lib/verify.js';

const snap = (ticker, price, url) => ({ ticker, current_price: price, source_url: url });

test('hostOfUrl survives junk', () => {
  assert.equal(hostOfUrl('https://finance.yahoo.com/quote/AAPL'), 'finance.yahoo.com');
  assert.equal(hostOfUrl('not a url'), '');
  assert.equal(hostOfUrl(null), '');
});

test('the same price for a different ticker on the same host is flagged', () => {
  const stuck = findStuckPrice({
    snapshot: snap('AAPL', 54106.2, 'https://www.google.com/finance/quote/AAPL:NASDAQ'),
    snapshots: { MSFT: snap('MSFT', 54106.2, 'https://www.google.com/finance/quote/MSFT:NASDAQ') },
  });
  assert.ok(stuck);
  assert.equal(stuck.ticker, 'MSFT');
  assert.equal(stuck.host, 'www.google.com');
});

test('the same ticker rescanned at an unchanged price is not a conflict', () => {
  const stuck = findStuckPrice({
    snapshot: snap('AAPL', 224.5, 'https://finance.yahoo.com/quote/AAPL'),
    snapshots: { AAPL: snap('AAPL', 224.5, 'https://finance.yahoo.com/quote/AAPL') },
  });
  assert.equal(stuck, null);
});

test('the same price on a different host is not a conflict', () => {
  const stuck = findStuckPrice({
    snapshot: snap('AAPL', 224.5, 'https://finance.yahoo.com/quote/AAPL'),
    snapshots: { MSFT: snap('MSFT', 224.5, 'https://stockanalysis.com/stocks/msft/') },
  });
  assert.equal(stuck, null);
});

test('different prices on the same host are fine', () => {
  const stuck = findStuckPrice({
    snapshot: snap('AAPL', 224.5, 'https://finance.yahoo.com/quote/AAPL'),
    snapshots: { MSFT: snap('MSFT', 484.45, 'https://finance.yahoo.com/quote/MSFT') },
  });
  assert.equal(stuck, null);
});

test('a snapshot with no price cannot be stuck', () => {
  const stuck = findStuckPrice({
    snapshot: snap('AAPL', null, 'https://finance.yahoo.com/quote/AAPL'),
    snapshots: { MSFT: snap('MSFT', null, 'https://finance.yahoo.com/quote/MSFT') },
  });
  assert.equal(stuck, null);
});
