import test from 'node:test';
import assert from 'node:assert/strict';
import { makePage, loadContentScript } from './helpers.mjs';
import { candidatesFor } from '../src/lib/selectors.js';
import { FIELDS, SNIPPET_LIMIT } from '../src/lib/constants.js';
import { HEALTHY_PAGE, BROKEN_PAGE, EMPTY_PAGE, INDEX_RAIL_PAGE } from './fixtures/pages.mjs';

function candidateMap(host, registry = {}) {
  const map = {};
  for (const field of FIELDS) map[field] = candidatesFor(host, field, registry);
  return map;
}

async function withPage(html, url, fn) {
  const page = makePage(html, { url });
  try {
    return await fn(page, loadContentScript(page));
  } finally {
    page.restore();
  }
}

const YAHOO = 'https://finance.yahoo.com/quote/AAPL';

test('a healthy page extracts every field with no failures', async () => {
  await withPage(HEALTHY_PAGE, YAHOO, async (_page, script) => {
    const result = await script.send({ type: 'EXTRACT', payload: { candidates: candidateMap('finance.yahoo.com'), snippetLimit: SNIPPET_LIMIT } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.raw.price, '224.50');
    assert.equal(result.raw.change_percentage, '(+1.80%)');
    assert.equal(result.raw.volume, '52,300,000');
    assert.match(result.raw.ticker, /AAPL/);
    assert.equal(result.raw.news.length, 2);
    assert.equal(result.used.price.selector, '[data-testid="qsp-price"]');
    assert.equal(result.host, 'finance.yahoo.com');
  });
});

test('a renamed layout reports failures and hands back a container snippet', async () => {
  await withPage(BROKEN_PAGE, YAHOO, async (_page, script) => {
    const result = await script.send({ type: 'EXTRACT', payload: { candidates: candidateMap('finance.yahoo.com'), snippetLimit: SNIPPET_LIMIT } });
    const failed = result.failures.map((failure) => failure.field);
    assert.ok(failed.includes('price'), `expected price to fail, got ${failed.join(',')}`);

    const priceFailure = result.failures.find((failure) => failure.field === 'price');
    assert.match(priceFailure.snippet, /224\.50/);
    assert.match(priceFailure.snippet, /qz-8f31ab/);
    assert.doesNotMatch(priceFailure.snippet, /__tracking/);
    assert.ok(priceFailure.tried.length > 0);
  });
});

test('the ticker still resolves on a renamed layout via the h1 fallback', async () => {
  await withPage(BROKEN_PAGE, YAHOO, async (_page, script) => {
    const result = await script.send({ type: 'EXTRACT', payload: { candidates: candidateMap('finance.yahoo.com'), snippetLimit: SNIPPET_LIMIT } });
    assert.match(result.raw.ticker, /AAPL/);
  });
});

test('a healed selector supplied by the registry is used first', async () => {
  await withPage(BROKEN_PAGE, YAHOO, async (_page, script) => {
    const registry = { 'finance.yahoo.com': { price: { selector: '.qz-8f31ab', strategy: 'css' } } };
    const result = await script.send({ type: 'EXTRACT', payload: { candidates: candidateMap('finance.yahoo.com', registry), snippetLimit: SNIPPET_LIMIT } });
    assert.equal(result.raw.price, '224.50');
    assert.equal(result.used.price.source, 'healed');
    assert.ok(!result.failures.some((failure) => failure.field === 'price'));
  });
});

test('VALIDATE_SELECTOR accepts a working CSS selector', async () => {
  await withPage(BROKEN_PAGE, YAHOO, async (_page, script) => {
    const response = await script.send({ type: 'VALIDATE_SELECTOR', payload: { field: 'price', selector: '.qz-8f31ab', strategy: 'css' } });
    assert.deepEqual(response, { ok: true, value: '224.50', matchCount: 1 });
  });
});

test('VALIDATE_SELECTOR accepts an XPath expression', async () => {
  await withPage(BROKEN_PAGE, YAHOO, async (_page, script) => {
    const response = await script.send({ type: 'VALIDATE_SELECTOR', payload: { field: 'price', selector: '//span[@class="qz-8f31ab"]', strategy: 'xpath' } });
    assert.equal(response.ok, true);
    assert.equal(response.value, '224.50');
  });
});

test('VALIDATE_SELECTOR rejects bad syntax, no match, and container matches', async () => {
  await withPage(BROKEN_PAGE, YAHOO, async (_page, script) => {
    const broken = await script.send({ type: 'VALIDATE_SELECTOR', payload: { field: 'price', selector: 'div:::bad', strategy: 'css' } });
    assert.deepEqual(broken, { ok: false, error: 'invalid selector syntax' });

    const missing = await script.send({ type: 'VALIDATE_SELECTOR', payload: { field: 'price', selector: '#nothing-here', strategy: 'css' } });
    assert.deepEqual(missing, { ok: false, error: 'selector matched no elements' });

    const container = await script.send({ type: 'VALIDATE_SELECTOR', payload: { field: 'price', selector: 'main', strategy: 'css' } });
    assert.equal(container.ok, false);
    assert.match(container.error, /container, not a value/);

    const none = await script.send({ type: 'VALIDATE_SELECTOR', payload: { field: 'price' } });
    assert.deepEqual(none, { ok: false, error: 'no selector supplied' });
  });
});

test('a page with no quote data fails every metric without throwing', async () => {
  await withPage(EMPTY_PAGE, 'https://example.com/about', async (_page, script) => {
    const result = await script.send({ type: 'EXTRACT', payload: { candidates: candidateMap('example.com'), snippetLimit: SNIPPET_LIMIT } });
    assert.equal(result.ok, true);
    assert.equal(result.raw.price, null);
    assert.deepEqual(result.raw.news, []);
    assert.ok(result.failures.length >= 3);
  });
});

test('PING answers so the worker can skip a redundant injection', async () => {
  await withPage(HEALTHY_PAGE, YAHOO, async (_page, script) => {
    assert.deepEqual(await script.send({ type: 'PING' }), { ok: true, host: 'finance.yahoo.com' });
  });
});

test('re-injecting into the same frame does not register a duplicate listener', async () => {
  await withPage(HEALTHY_PAGE, YAHOO, async (page, script) => {
    const before = page.window.__selfHealingMarketScraper__;
    // A second executeScript on the same tab re-runs the file; the guard must
    // stop it from installing a second message listener.
    loadContentScript(page);
    assert.equal(page.window.__selfHealingMarketScraper__, before);
    assert.equal(page.window.__listenerCount, 1);
    assert.deepEqual(await script.send({ type: 'PING' }), { ok: true, host: 'finance.yahoo.com' });
  });
});

test('the snippet is capped at the requested limit', async () => {
  await withPage(BROKEN_PAGE, YAHOO, async (_page, script) => {
    const result = await script.send({ type: 'EXTRACT', payload: { candidates: candidateMap('finance.yahoo.com'), snippetLimit: 120 } });
    for (const failure of result.failures) {
      assert.ok(failure.snippet.length <= 120 + 20, `snippet too long: ${failure.snippet.length}`);
    }
  });
});


test('a price inside a rail of other instruments is never taken for this one', async () => {
  const url = 'https://www.google.com/finance/quote/AAPL:NASDAQ';
  await withPage(INDEX_RAIL_PAGE, url, async (_page, script) => {
    const result = await script.send({
      type: 'EXTRACT',
      payload: { candidates: candidateMap('www.google.com'), snippetLimit: SNIPPET_LIMIT, anchorText: 'AAPL' },
    });

    assert.equal(result.raw.price, null, 'an index level is not this stock price');
    assert.equal(result.raw.change_percentage, null);

    // And there is nothing worth sending to the model: every price-shaped
    // string on the page belongs to a different instrument.
    const priceFailure = result.failures.find((failure) => failure.field === 'price');
    assert.ok(priceFailure, 'price should be reported as a miss');
    assert.equal(priceFailure.snippet, '', 'no container should be offered for repair');
  });
});

test('a selector aimed at a row of another instrument is refused', async () => {
  const url = 'https://www.google.com/finance/quote/AAPL:NASDAQ';
  await withPage(INDEX_RAIL_PAGE, url, async (_page, script) => {
    const check = await script.send({
      type: 'VALIDATE_SELECTOR',
      payload: { field: 'price', selector: '.movers td + td', strategy: 'css' },
    });
    assert.equal(check.ok, false);
    assert.match(check.error, /list of other instruments/);
  });
});

test('a page with no volume at all offers no container to repair', async () => {
  await withPage(EMPTY_PAGE, 'https://example.com/quote/AAPL', async (_page, script) => {
    const result = await script.send({
      type: 'CAPTURE_CONTAINER',
      payload: { field: 'volume', snippetLimit: SNIPPET_LIMIT },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no container/);
  });
});
