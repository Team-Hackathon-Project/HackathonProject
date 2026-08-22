/**
 * The headless extractor, and its agreement with the injected one.
 *
 * `src/lib/extract-core.js` and `src/content.js` do the same job in two places
 * that cannot share code: one is an ES module running in the offscreen
 * document, the other a classic script injected into a tab. The project already
 * carries that split for the message names, asserted by `test/protocol.test.js`.
 *
 * The parity block below is the equivalent for extraction: both are run over
 * the same fixtures and required to return the same values, from the same
 * selectors. Without it the two drift, and the drift shows up as a background
 * refresh quietly disagreeing with what the popup showed a minute earlier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makePage, loadContentScript } from './helpers.mjs';
import { extractAll, extractField, readText, isValueElement, isCrossInstrument, query } from '../src/lib/extract-core.js';
import { candidatesFor } from '../src/lib/selectors.js';
import { FIELDS } from '../src/lib/constants.js';
import {
  HEALTHY_PAGE, BROKEN_PAGE, EMPTY_PAGE, MISLEADING_PAGE, MISLEADING_ONLY_PAGE, INDEX_RAIL_PAGE,
} from './fixtures/pages.mjs';

const HOST = 'finance.yahoo.com';
const URL_FOR = `https://${HOST}/quote/AAPL`;

/** A document parsed the way the offscreen document parses fetched HTML. */
const parse = (html) => new JSDOM(html, { url: URL_FOR }).window.document;

const candidateMap = (host = HOST) => {
  const map = {};
  for (const field of FIELDS) map[field] = candidatesFor(host, field, {});
  return map;
};

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

test('a healthy page yields every field from the shipped selectors', () => {
  const { raw, used, failures } = extractAll(parse(HEALTHY_PAGE), candidateMap());

  assert.equal(raw.price, '224.50');
  assert.equal(raw.change_percentage, '(+1.80%)');
  assert.equal(raw.volume, '52,300,000');
  assert.match(raw.ticker, /AAPL/);
  assert.ok(raw.news.includes('Apple beats earnings expectations again'));
  assert.equal(failures.length, 0);
  assert.equal(used.price.selector, '[data-testid="qsp-price"]');
});

test('a renamed layout fails cleanly rather than inventing values', () => {
  const { raw, failures } = extractAll(parse(BROKEN_PAGE), candidateMap());
  const failed = failures.map((failure) => failure.field);

  assert.ok(failed.includes('price'), 'the renamed price hook must be reported as a miss');
  assert.equal(raw.price, null);
  // A failure names what was tried, so the caller can explain itself.
  assert.ok(failures.find((failure) => failure.field === 'price').tried.length > 0);
});

test('a page holding none of the metrics reports them as missing', () => {
  const { raw, failures } = extractAll(parse(EMPTY_PAGE), candidateMap());
  const failed = failures.map((failure) => failure.field);

  assert.equal(raw.price, null);
  assert.equal(raw.change_percentage, null);
  assert.equal(raw.volume, null);
  for (const field of ['price', 'change_percentage', 'volume', 'news']) {
    assert.ok(failed.includes(field), field + ' should be reported as missing');
  }
  // A list field that found nothing is an empty list, matching content.js.
  assert.deepEqual(raw.news, []);
});

test('a page that is only other instruments yields no price at all', () => {
  // Every number here belongs to something else: an index rail and a movers
  // table. Refusing to answer is the correct answer - taking the Dow as this
  // stock's price would be filed under the ticker and charted as its history.
  const doc = parse(INDEX_RAIL_PAGE);
  const { raw } = extractAll(doc, candidateMap());

  assert.equal(raw.price, null, 'took a number belonging to another instrument: ' + raw.price);
  assert.equal(raw.change_percentage, null);
});

test('an unparseable selector is skipped instead of throwing', () => {
  const doc = parse(HEALTHY_PAGE);
  assert.equal(query(doc, { selector: 'div[', strategy: 'css' }, true), null);
  const found = extractField(doc, 'price', [
    { selector: 'div[', strategy: 'css' },
    { selector: '[data-testid="qsp-price"]', strategy: 'css' },
  ]);
  assert.equal(found.value, '224.50');
});

test('an xpath candidate resolves the same as a css one', () => {
  const doc = parse(HEALTHY_PAGE);
  const found = extractField(doc, 'price', [
    { selector: '//span[@data-testid="qsp-price"]', strategy: 'xpath' },
  ]);
  assert.equal(found.value, '224.50');
});

test('a value-carrying attribute is preferred over the rendered text', () => {
  const doc = parse('<html><body><span id="p" data-value="224.50">$224.50 USD</span></body></html>');
  assert.equal(readText(doc.getElementById('p')), '224.50');
});

test('a wrapper full of elements is not accepted as a value', () => {
  const doc = parse('<html><body><div id="w"><a/><a/><a/><a/><a/><a/></div><span id="v">224.50</span></body></html>');
  assert.equal(isValueElement(doc.getElementById('w')), false);
  assert.equal(isValueElement(doc.getElementById('v')), true);
});

test('the cross-instrument guard applies to identity fields only', () => {
  const doc = parse(INDEX_RAIL_PAGE);
  const inRail = doc.querySelector('.market-summary [role="option"] span');
  assert.ok(inRail, 'the fixture should have a market-summary rail');

  assert.equal(isCrossInstrument(doc, inRail, 'price'), true);
  // Volume legitimately lives in a small table on a real quote page, so the
  // structural test must not be applied to it.
  assert.equal(isCrossInstrument(doc, inRail, 'volume'), false);
});

test('a missing candidate list is a miss, not a crash', () => {
  const doc = parse(HEALTHY_PAGE);
  assert.equal(extractField(doc, 'price', undefined), null);
  assert.deepEqual(extractAll(doc, {}), { raw: {}, used: {}, failures: [] });
});

/* ------------------------------------------------------------------ *
 * Parity with the injected content script
 * ------------------------------------------------------------------ */

const FIXTURES = {
  HEALTHY_PAGE,
  BROKEN_PAGE,
  EMPTY_PAGE,
  MISLEADING_PAGE,
  MISLEADING_ONLY_PAGE,
  INDEX_RAIL_PAGE,
};

for (const [name, html] of Object.entries(FIXTURES)) {
  test(`the headless and injected extractors agree on ${name}`, async () => {
    const candidates = candidateMap();

    const page = makePage(html, { url: URL_FOR });
    let injected;
    try {
      const script = loadContentScript(page);
      injected = await script.send({
        type: 'EXTRACT',
        payload: { candidates, snippetLimit: 20000, anchorText: 'AAPL' },
      });
    } finally {
      page.restore();
    }

    const headless = extractAll(parse(html), candidates);

    for (const field of FIELDS) {
      assert.deepEqual(
        headless.raw[field] ?? null,
        injected.raw[field] ?? null,
        `${name}: the two extractors disagree on ${field}`
      );
    }
    // And they must have got there by the same route, not by luck.
    for (const field of Object.keys(headless.used)) {
      assert.equal(
        headless.used[field].selector,
        (injected.used[field] || {}).selector,
        `${name}: ${field} was read by different selectors`
      );
    }
  });
}
