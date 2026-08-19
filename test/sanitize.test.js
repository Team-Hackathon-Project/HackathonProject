import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { sanitizeSnippet, looksLikeAd } from '../src/lib/sanitize.js';

function parse(html) {
  return new JSDOM(`<body>${html}</body>`).window.document.body;
}

test('scripts, styles, nav chrome and ads are removed', () => {
  const root = parse(`
    <div id="wrap">
      <script>var tracking = 1;</script>
      <style>.a{color:red}</style>
      <nav>menu</nav>
      <div class="ad-slot">buy now</div>
      <div id="cookie-consent">accept?</div>
      <span data-testid="qsp-price">224.50</span>
    </div>`);
  const { html, removed } = sanitizeSnippet(root);
  assert.ok(removed >= 5);
  assert.doesNotMatch(html, /tracking/);
  assert.doesNotMatch(html, /color:red/);
  assert.doesNotMatch(html, /buy now/);
  assert.doesNotMatch(html, /accept\?/);
  assert.match(html, /224\.50/);
  assert.match(html, /data-testid="qsp-price"/);
});

test('selector-bearing attributes survive and noise attributes do not', () => {
  const root = parse('<span id="p" class="x" data-field="regularMarketPrice" aria-label="price" style="color:red" onclick="x()" srcset="a.png">1</span>');
  const { html } = sanitizeSnippet(root);
  assert.match(html, /id="p"/);
  assert.match(html, /data-field="regularMarketPrice"/);
  assert.match(html, /aria-label="price"/);
  assert.doesNotMatch(html, /style=/);
  assert.doesNotMatch(html, /onclick/);
  assert.doesNotMatch(html, /srcset/);
});

test('hashed build classes are dropped but meaningful ones are kept', () => {
  const root = parse('<span class="css-1x7f2q9 quote-price yf-8m2k1x">1</span>');
  const { html } = sanitizeSnippet(root);
  assert.match(html, /quote-price/);
  assert.doesNotMatch(html, /css-1x7f2q9/);
});

test('a class list of only hashed names is kept rather than emptied', () => {
  const root = parse('<span class="css-1x7f2q9 ab-99ff11">1</span>');
  const { html } = sanitizeSnippet(root);
  assert.match(html, /class="css-1x7f2q9 ab-99ff11"/);
});

test('output is capped at the character budget', () => {
  const root = parse(`<div>${'<span data-x="1">value</span>'.repeat(500)}</div>`);
  const result = sanitizeSnippet(root, { maxChars: 500 });
  assert.equal(result.truncated, true);
  assert.ok(result.html.length <= 500 + 20);
  assert.match(result.html, /truncated/);
});

test('an over-long attribute value is clipped', () => {
  const root = parse(`<span data-blob="${'a'.repeat(400)}">1</span>`);
  const { html } = sanitizeSnippet(root);
  assert.doesNotMatch(html, /a{200}/);
});

test('looksLikeAd matches ad and consent markers only', () => {
  const doc = new JSDOM('<body></body>').window.document;
  const make = (attrs) => {
    const node = doc.createElement('div');
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  assert.equal(looksLikeAd(make({ class: 'advert-wrap' })), true);
  assert.equal(looksLikeAd(make({ id: 'cookie-banner' })), true);
  assert.equal(looksLikeAd(make({ 'data-testid': 'taboola-feed' })), true);
  assert.equal(looksLikeAd(make({ class: 'quote-price' })), false);
  assert.equal(looksLikeAd(make({})), false);
});

test('a null root is handled', () => {
  assert.deepEqual(sanitizeSnippet(null), { html: '', removed: 0, truncated: false, chars: 0 });
});
