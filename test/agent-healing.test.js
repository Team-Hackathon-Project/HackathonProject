/**
 * The self-healing loop as the Bright Data agent runs it.
 *
 * The point of these tests is not that "healing works" — `background.test.js`
 * already covers that for the tab path. It is that the Bright Data path is the
 * *same* loop, held to the same refusals, and reaches them through the same
 * three messages the content script answers in a real tab.
 *
 * So the driver here is `src/content.js` itself, loaded into jsdom and driven
 * through its real `chrome.runtime.onMessage` listener. In production that
 * listener is replaced by a `page.evaluate` hop into the remote browser
 * (`agent/brightdata.mjs`), and nothing else about the pipeline changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makePage, loadContentScript, stubFetch, groqResponse } from './helpers.mjs';
import { HEALTHY_PAGE, BROKEN_PAGE, EMPTY_PAGE } from './fixtures/pages.mjs';
import { extractWithHealing, buildCandidateMap } from '../agent/healing.mjs';
import { sanitizeSnippet } from '../src/lib/sanitize.js';
import { crossHostRedirect } from '../agent/scrape.mjs';
import { isTransientSessionError } from '../agent/brightdata.mjs';

const URL_FOR = 'https://finance.yahoo.com/quote/AAPL';
const HOST = 'finance.yahoo.com';

/** The sanitizer, without dragging puppeteer into a unit test. */
function sanitize(html, maxChars) {
  const dom = new JSDOM(String(html || ''));
  try {
    return sanitizeSnippet(dom.window.document.body, { maxChars });
  } finally {
    dom.window.close();
  }
}

/**
 * A driver over the real content script.
 *
 * Every call goes through the script's message listener, so the values are
 * JSON-detached from the jsdom realm exactly as they are when they cross the
 * CDP boundary from the Bright Data page.
 */
function driverFor(html, { url = URL_FOR } = {}) {
  const page = makePage(html, { url });
  const script = loadContentScript(page);
  return {
    page,
    driver: {
      extract: (payload) => script.send({ type: 'EXTRACT', payload }),
      validate: (payload) => script.send({ type: 'VALIDATE_SELECTOR', payload }),
      capture: (payload) => script.send({ type: 'CAPTURE_CONTAINER', payload }),
    },
  };
}

/** Collects what the pipeline asked to persist, instead of touching a file. */
function recorder() {
  const healed = {};
  const forgotten = [];
  const events = [];
  return {
    healed,
    forgotten,
    events,
    onHeal: async (host, field, proposal) => {
      healed[`${host}::${field}`] = { ...proposal, healed_at: new Date().toISOString(), source: 'healed' };
      return { selector: proposal.selector, strategy: proposal.strategy, source: 'healed' };
    },
    onForget: async (host, field) => { forgotten.push(`${host}::${field}`); return true; },
    onEvent: async (event) => { events.push(event); },
  };
}

const GROQ = { provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: 'gsk_test' };
const OFFLINE = { provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: '' };

test.afterEach(() => { delete globalThis.fetch; });

/* ------------------------------------------------------------------ *
 * The page that still works
 * ------------------------------------------------------------------ */

test('a page matching the shipped selectors is read without a single model call', async () => {
  const { page, driver } = driverFor(HEALTHY_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch({ status: 500, json: { error: 'must not be called' } });

  const result = await extractWithHealing({
    driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: GROQ, sanitize, ...store,
  });

  assert.equal(result.usable, true);
  assert.equal(result.snapshot.ticker, 'AAPL');
  assert.equal(result.snapshot.current_price, 224.5);
  assert.equal(result.snapshot.change_percentage, '+1.80%');
  assert.equal(result.snapshot.volume, 52300000);
  assert.equal(result.healed.length, 0);
  assert.equal(globalThis.fetch.calls.length, 0, 'nothing was broken, so nothing was sent to a model');
  page.restore();
});

/* ------------------------------------------------------------------ *
 * The page that changed underneath us
 * ------------------------------------------------------------------ */

test('a renamed price hook is repaired, validated in the page, and persisted', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch(groqResponse({
    selector: '.qz-8f31ab',
    strategy: 'css',
    confidence: 0.9,
    reason: 'the span holding the last traded price',
  }));

  const result = await extractWithHealing({
    driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: GROQ, sanitize, ...store,
  });

  const priceHeal = result.healed.find((entry) => entry.field === 'price');
  assert.ok(priceHeal, `price was not repaired: ${JSON.stringify(result.warnings)}`);
  assert.equal(priceHeal.selector, '.qz-8f31ab');
  assert.equal(result.snapshot.current_price, 224.5);
  assert.equal(result.snapshot.selectors_used.price_selector, '.qz-8f31ab');
  assert.equal(store.healed[`${HOST}::price`].selector, '.qz-8f31ab', 'the repair was handed to the store');
  page.restore();
});

test('the snippet sent to the model is the sanitized container, not the whole page', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch(groqResponse({
    selector: '.qz-8f31ab', strategy: 'css', confidence: 0.9, reason: 'price',
  }));

  await extractWithHealing({ driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: GROQ, sanitize, ...store });

  const sent = JSON.stringify(globalThis.fetch.calls[0].body);
  assert.equal(sent.includes('__tracking'), false, 'inline script payloads must not be shipped to a provider');
  assert.equal(sent.includes('ad-slot'), false, 'ad markup is stripped before the call');
  assert.match(sent, /qz-8f31ab/, 'the hook the model has to find is still in the fragment');
  page.restore();
});

test('a proposal that resolves to the wrong kind of value is refused and retried', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  // Two fields need repair on this fixture, price first. The second one gets a
  // wrong answer to begin with: a selector that resolves to a real element
  // holding the *price*, where a percentage belongs.
  globalThis.fetch = stubFetch([
    groqResponse({ selector: '.qz-8f31ab', strategy: 'css', confidence: 0.9, reason: 'price' }),
    groqResponse({ selector: '.qz-8f31ab', strategy: 'css', confidence: 0.8, reason: 'change, wrongly' }),
    groqResponse({ selector: '.qz-delta-19c', strategy: 'css', confidence: 0.9, reason: 'change, second try' }),
  ]);

  const result = await extractWithHealing({
    driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: GROQ, sanitize, ...store,
  });

  assert.equal(result.snapshot.change_percentage, '+1.80%', 'the second proposal is the one that stuck');
  assert.equal(store.healed[`${HOST}::change_percentage`].selector, '.qz-delta-19c');

  const rejected = store.events.find((event) => event.field === 'change_percentage' && event.error);
  assert.ok(rejected, 'the refusal is recorded');
  assert.match(rejected.error, /is not a valid change_percentage/);

  // The rejection has to reach the model, or the retry is just a re-roll.
  const retry = globalThis.fetch.calls.find((call) => JSON.stringify(call.body).includes('previous answer was rejected'));
  assert.ok(retry, 'the second ask carries the reason the first was refused');
  page.restore();
});

test('a field the shipped xpath fallback still finds is never sent to a model', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch(groqResponse({
    selector: '.qz-8f31ab', strategy: 'css', confidence: 0.9, reason: 'price',
  }));

  const result = await extractWithHealing({
    driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: GROQ, sanitize, ...store,
  });

  // The generic `//*[text()="Volume"]/following-sibling::*[1]` outlives the
  // class rename that broke everything around it, which is the whole reason the
  // structural fallbacks exist ahead of the model.
  assert.equal(result.snapshot.volume, 52300000);
  assert.equal(store.healed[`${HOST}::volume`], undefined, 'a working fallback must not cost a repair call');
  page.restore();
});

test('a selector the model invents that matches nothing is never persisted', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch(groqResponse({
    selector: '.does-not-exist', strategy: 'css', confidence: 0.95, reason: 'confidently wrong',
  }));

  const result = await extractWithHealing({
    driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: GROQ, sanitize, ...store,
  });

  assert.equal(store.healed[`${HOST}::price`], undefined, 'a selector that matches nothing must not be stored');
  assert.equal(result.snapshot.current_price, null);
  assert.ok(result.warnings.some((warning) => /price/i.test(warning)));
  page.restore();
});

test('a model answer of "it is not in this fragment" is taken at its word, not retried', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch(groqResponse({
    selector: '', strategy: 'css', confidence: 0, reason: 'the fragment holds no price',
  }));

  await extractWithHealing({ driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: GROQ, sanitize, ...store });

  const priceCalls = store.events.filter((event) => event.field === 'price');
  assert.equal(priceCalls.length, 1, 'confidence 0 is a terminal answer — asking again cannot change it');
  page.restore();
});

/* ------------------------------------------------------------------ *
 * Not every miss is a fault
 * ------------------------------------------------------------------ */

test('with no API key nothing is sent anywhere, and the miss is reported plainly', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch({ status: 500, json: { error: 'must not be called' } });

  const result = await extractWithHealing({
    driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: OFFLINE, sanitize, ...store,
  });

  assert.equal(globalThis.fetch.calls.length, 0);
  assert.equal(result.healed.length, 0);
  assert.ok(result.warnings.some((warning) => /needs an API key/.test(warning)));
  page.restore();
});

test('selfHeal:false is honoured even when a key is present', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch({ status: 500, json: { error: 'must not be called' } });

  const result = await extractWithHealing({
    driver, url: URL_FOR, host: HOST, ticker: 'AAPL', llm: GROQ, sanitize, selfHeal: false, ...store,
  });

  assert.equal(globalThis.fetch.calls.length, 0);
  assert.ok(result.warnings.some((warning) => /switched off/.test(warning)));
  page.restore();
});

test('a page with no quote data at all costs no model call and saves nothing', async () => {
  const { page, driver } = driverFor(EMPTY_PAGE, { url: 'https://example.com/about' });
  const store = recorder();
  globalThis.fetch = stubFetch({ status: 500, json: { error: 'must not be called' } });

  const result = await extractWithHealing({
    driver, url: 'https://example.com/about', host: 'example.com', llm: GROQ, sanitize, ...store,
  });

  assert.equal(result.usable, false);
  assert.equal(globalThis.fetch.calls.length, 0, 'no text of the right shape anywhere means nothing to repair');
  assert.ok(result.notices.length > 0);
  page.restore();
});

/* ------------------------------------------------------------------ *
 * The page-global price
 * ------------------------------------------------------------------ */

test('a price the host already reported for another ticker is discarded and the selector forgotten', async () => {
  const { page, driver } = driverFor(BROKEN_PAGE);
  const store = recorder();
  globalThis.fetch = stubFetch(groqResponse({
    selector: '.qz-8f31ab', strategy: 'css', confidence: 0.9, reason: 'price',
  }));

  const result = await extractWithHealing({
    driver,
    url: URL_FOR,
    host: HOST,
    ticker: 'AAPL',
    llm: GROQ,
    sanitize,
    // MSFT was read from the same host at the identical price: that is a figure
    // belonging to the page, not to either instrument.
    snapshots: { MSFT: { ticker: 'MSFT', current_price: 224.5, source_url: 'https://finance.yahoo.com/quote/MSFT' } },
    ...store,
  });

  assert.equal(result.snapshot.current_price, null);
  assert.equal(result.snapshot.selectors_used.price_selector, undefined);
  assert.ok(store.forgotten.includes(`${HOST}::price`), 'the repaired selector is reset, not kept serving a wrong number');
  assert.ok(result.warnings.some((warning) => /belonging to the page/.test(warning)));
  page.restore();
});

/* ------------------------------------------------------------------ *
 * The candidate order
 * ------------------------------------------------------------------ */

test('a healed selector is tried ahead of the shipped defaults on the next pass', () => {
  const registry = { [HOST]: { price: { selector: '.qz-8f31ab', strategy: 'css', source: 'healed' } } };
  const map = buildCandidateMap(HOST, registry);

  assert.equal(map.price[0].selector, '.qz-8f31ab');
  assert.equal(map.price[0].source, 'healed');
  assert.ok(map.price.length > 1, 'the defaults stay behind it as a fallback');
});

test('the candidate map covers every field the snapshot schema names', () => {
  const map = buildCandidateMap(HOST, {});
  for (const field of ['ticker', 'price', 'change_percentage', 'volume', 'news']) {
    assert.ok(Array.isArray(map[field]) && map[field].length, `no candidates for ${field}`);
  }
});

/* ------------------------------------------------------------------ *
 * The remote session, and where it lands
 *
 * Both of these are about telling a page-level answer apart from an
 * infrastructure one. A consent wall and a dropped session both surface as "no
 * price", and neither of them is a scraper that needs fixing.
 * ------------------------------------------------------------------ */

test('a redirect to a consent wall is named, and says how to avoid it', () => {
  const detail = crossHostRedirect(
    'https://www.google.com/finance/quote/AAPL:NASDAQ',
    'https://consent.google.com/m?continue=https://www.google.com/finance/quote/AAPL:NASDAQ&gl=BG',
  );
  assert.match(detail, /consent\.google\.com/);
  assert.match(detail, /BRIGHTDATA_COUNTRY/);
});

test('a redirect right off the site is reported as such', () => {
  const detail = crossHostRedirect('https://stockanalysis.com/stocks/aapl/', 'https://login.example.com/');
  assert.match(detail, /ended up on login\.example\.com/);
});

test('ordinary same-site movement is not treated as an interstitial', () => {
  assert.equal(crossHostRedirect('https://www.google.com/finance', 'https://www.google.com/finance/beta/quote/AAPL'), null);
  assert.equal(crossHostRedirect('https://finance.yahoo.com/quote/AAPL', 'https://uk.finance.yahoo.com/quote/AAPL'), null);
  assert.equal(crossHostRedirect('https://x.com/a', 'https://x.com/b'), null);
});

test('a dropped remote session is retryable; a page with no price is not', () => {
  assert.equal(isTransientSessionError(new Error('Protocol error (Runtime.callFunctionOn): Target closed')), true);
  assert.equal(isTransientSessionError(new Error('Session closed. Most likely the page has been closed.')), true);
  assert.equal(isTransientSessionError(new Error('Navigation timeout of 120000 ms exceeded')), false);
  assert.equal(isTransientSessionError(new Error('no price could be read from that page')), false);
});
