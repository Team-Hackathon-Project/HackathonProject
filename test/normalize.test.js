import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText, parsePrice, parseDecimal, parseChangePercentage, parseVolume,
  parseTicker, tickerFromUrl, normalizeNews, buildSnapshot, isUsableSnapshot, detectCurrency, valueFitsField,
} from '../src/lib/normalize.js';

test('cleanText strips zero-width, nbsp and collapses whitespace', () => {
  assert.equal(cleanText('  AA​PL   Inc\n\n'), 'AAPL Inc');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(42), '');
});

test('parseDecimal handles US and EU grouping', () => {
  assert.equal(parseDecimal('1,234.56'), 1234.56);
  assert.equal(parseDecimal('1.234,56'), 1234.56);
  assert.equal(parseDecimal('1,234'), 1234);
  assert.equal(parseDecimal('1,5'), 1.5);
  assert.equal(parseDecimal('224.50'), 224.5);
  assert.equal(parseDecimal('nope'), null);
});

test('parsePrice recovers value and currency', () => {
  assert.deepEqual(parsePrice('$224.50'), { value: 224.5, currency: 'USD' });
  assert.deepEqual(parsePrice('1,234.56 USD'), { value: 1234.56, currency: 'USD' });
  assert.deepEqual(parsePrice('€1.234,56'), { value: 1234.56, currency: 'EUR' });
  assert.equal(parsePrice('—'), null);
  assert.equal(parsePrice(''), null);
});

test('detectCurrency does not match a code inside a word', () => {
  assert.equal(detectCurrency('CRUSD'), null);
  assert.equal(detectCurrency('12.00 CAD'), 'CAD');
});

test('parseChangePercentage normalizes sign and formatting', () => {
  assert.deepEqual(parseChangePercentage('+1.8%'), { value: 1.8, text: '+1.80%' });
  assert.deepEqual(parseChangePercentage('-0.42 %'), { value: -0.42, text: '-0.42%' });
  assert.deepEqual(parseChangePercentage('(0.42%)'), { value: -0.42, text: '-0.42%' });
  assert.deepEqual(parseChangePercentage('−3.5%'), { value: -3.5, text: '-3.50%' });
  assert.deepEqual(parseChangePercentage('0.00%'), { value: 0, text: '0.00%' });
  assert.equal(parseChangePercentage('n/a'), null);
});

test('parseVolume expands magnitude suffixes', () => {
  assert.equal(parseVolume('52.3M'), 52300000);
  assert.equal(parseVolume('1,234,567'), 1234567);
  assert.equal(parseVolume('3.1 B'), 3100000000);
  assert.equal(parseVolume('—'), null);
});

test('parseTicker prefers a parenthesized symbol', () => {
  assert.equal(parseTicker('Apple Inc. (AAPL)'), 'AAPL');
  assert.equal(parseTicker('AAPL'), 'AAPL');
  assert.equal(parseTicker('BRK.B'), 'BRK.B');
  assert.equal(parseTicker('a lowercase sentence'), null);
});

test('tickerFromUrl reads path anchors and query parameters', () => {
  assert.equal(tickerFromUrl('https://finance.yahoo.com/quote/AAPL/'), 'AAPL');
  assert.equal(tickerFromUrl('https://example.com/x?symbol=msft'), 'MSFT');
  assert.equal(tickerFromUrl('https://example.com/about'), null);
  assert.equal(tickerFromUrl('not a url'), null);
  assert.equal(tickerFromUrl(null), null);
});

test('normalizeNews dedupes, trims and caps', () => {
  const items = ['Apple beats earnings', 'apple beats earnings ', 'short', 'Second real headline here', null];
  assert.deepEqual(normalizeNews(items, 5), ['Apple beats earnings', 'Second real headline here']);
  assert.deepEqual(normalizeNews('not an array'), []);
});

test('buildSnapshot produces the documented payload shape', () => {
  const snapshot = buildSnapshot(
    { ticker: 'Apple Inc. (AAPL)', price: '$224.50', change_percentage: '+1.8%', volume: '52.3M', news: ['Apple beats earnings expectations'] },
    { source_url: 'https://finance.example.com/quote/AAPL', extracted_at: '2026-08-19T20:55:00Z', selectors_used: { price_selector: '#p' } }
  );
  assert.deepEqual(snapshot, {
    ticker: 'AAPL',
    current_price: 224.5,
    currency: 'USD',
    change_percentage: '+1.80%',
    change_value: 1.8,
    volume: 52300000,
    news: ['Apple beats earnings expectations'],
    extracted_at: '2026-08-19T20:55:00Z',
    source_url: 'https://finance.example.com/quote/AAPL',
    selectors_used: { price_selector: '#p' },
  });
  assert.equal(isUsableSnapshot(snapshot), true);
});

test('buildSnapshot falls back to the URL for the ticker', () => {
  const snapshot = buildSnapshot({ price: '224.50' }, { source_url: 'https://x.com/quote/TSLA' });
  assert.equal(snapshot.ticker, 'TSLA');
  assert.equal(snapshot.volume, null);
  assert.deepEqual(snapshot.news, []);
});

test('isUsableSnapshot rejects incomplete payloads', () => {
  assert.equal(isUsableSnapshot(null), false);
  assert.equal(isUsableSnapshot({ ticker: 'AAPL', current_price: null }), false);
  assert.equal(isUsableSnapshot({ ticker: null, current_price: 1 }), false);
});

test('a wrapping parenthesis only means negative without an explicit sign', () => {
  assert.deepEqual(parseChangePercentage('(+1.80%)'), { value: 1.8, text: '+1.80%' });
  assert.deepEqual(parseChangePercentage('(-1.80%)'), { value: -1.8, text: '-1.80%' });
  assert.deepEqual(parseChangePercentage('(1.80%)'), { value: -1.8, text: '-1.80%' });
  assert.deepEqual(parseChangePercentage('+1.80% (up today)'), { value: 1.8, text: '+1.80%' });
});

test('valueFitsField keeps a value out of a field it does not belong to', () => {
  // The bug this guards: parseVolume("$182.44") returns 182, so a price
  // selector healed onto the volume field silently invents a share count.
  assert.equal(valueFitsField('volume', '$182.44'), false);
  assert.equal(valueFitsField('volume', '+2.41%'), false);
  assert.equal(valueFitsField('volume', 'Vol 44,102,880'), true);
  assert.equal(valueFitsField('volume', '52.3M'), true);

  assert.equal(valueFitsField('price', '+2.41%'), false);
  assert.equal(valueFitsField('price', '(1.80%)'), false);
  assert.equal(valueFitsField('price', '(+1.80%)'), false);
  assert.equal(valueFitsField('price', '$182.44'), true);
  assert.equal(valueFitsField('price', '182.44 (+1.80%)'), true);

  assert.equal(valueFitsField('change_percentage', '224.50'), false);
  assert.equal(valueFitsField('change_percentage', '(+1.80%)'), true);

  assert.equal(valueFitsField('ticker', 'Apple Inc. (AAPL)'), true);
  assert.equal(valueFitsField('ticker', '...'), false);

  assert.equal(valueFitsField('price', ''), false);
  assert.equal(valueFitsField('volume', null), false);
});

test('buildSnapshot drops fields whose scraped text is the wrong shape', () => {
  const snapshot = buildSnapshot({
    ticker: 'NVDA',
    price: '$182.44',
    change_percentage: '$182.44', // a price node aimed at the change field
    volume: '$182.44',            // ...and at the volume field
    news: [],
  }, { source_url: 'https://example.com/quote/NVDA' });

  assert.equal(snapshot.current_price, 182.44);
  assert.equal(snapshot.change_percentage, null);
  assert.equal(snapshot.volume, null); // not 182
});

test('buildSnapshot refuses a percentage as the price', () => {
  const snapshot = buildSnapshot({ ticker: 'NVDA', price: '+2.41%' }, {});
  assert.equal(snapshot.current_price, null);
  assert.equal(isUsableSnapshot(snapshot), false);
});
