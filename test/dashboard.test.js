/**
 * The dashboard's rendering and the rules it has to keep.
 *
 * `web/js/render.js` and `web/js/sparkline.js` are pure DOM builders, so they
 * are driven directly in jsdom rather than through the page. What is asserted
 * here is mostly not layout — it is the handful of promises the dashboard makes
 * about safety and honesty:
 *
 *   - scraped text is inserted as text, never as markup
 *   - a chart is not drawn from a series too thin to mean anything
 *   - the trend is stated in words as well as in colour
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost:8080/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;

const {
  el, watchCard, detailDrawer, summaryBar, relativeTime, directionOf, advisorNote, disconnectedState,
} = await import('../web/js/render.js');
const { sparkline, seriesOf, MIN_CHART_POINTS } = await import('../web/js/sparkline.js');

const SNAPSHOT = {
  ticker: 'AAPL',
  current_price: 224.5,
  currency: 'USD',
  change_percentage: '+1.80%',
  change_value: 1.8,
  volume: 52300000,
  news: ['Apple beats earnings expectations again'],
  extracted_at: new Date().toISOString(),
  source_url: 'https://stockanalysis.com/stocks/aapl/',
  selectors_used: { price_selector: '[data-testid="qsp-price"]' },
};

const history = (count, start = 200) => Array.from({ length: count }, (_, index) => ({
  at: new Date(Date.now() - index * 3600000).toISOString(),
  price: start + index,
  change_value: 1,
}));

const row = (overrides = {}) => ({
  ticker: 'AAPL',
  entry: { ticker: 'AAPL', source_url: SNAPSHOT.source_url, monitor: true, last_refreshed_at: SNAPSHOT.extracted_at },
  snapshot: SNAPSHOT,
  position: null,
  history: [],
  ...overrides,
});

const noop = () => {};
const handlers = { busy: false, onSelect: noop, onRemove: noop, onToggleMonitor: noop };

/* ------------------------------------------------------------------ *
 * The no-markup rule
 * ------------------------------------------------------------------ */

test('no file under web/js assigns innerHTML', () => {
  const root = fileURLToPath(new URL('../web/js/', import.meta.url));
  const offenders = [];
  for (const name of readdirSync(root)) {
    const source = readFileSync(path.join(root, name), 'utf8');
    // outerHTML and insertAdjacentHTML parse markup just the same.
    if (/\b(innerHTML|outerHTML|insertAdjacentHTML)\s*[=(]/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test('a headline carrying markup is rendered as text, not parsed', () => {
  const hostile = '<img src=x onerror="globalThis.__pwned = true"> Apple beats earnings';
  const node = detailDrawer(
    row({ snapshot: { ...SNAPSHOT, news: [hostile] } }),
    { decisions: [], onClose: noop }
  );
  assert.equal(node.querySelectorAll('img').length, 0);
  assert.equal(globalThis.__pwned, undefined);
  assert.ok(node.textContent.includes(hostile));
});

test('a ticker carrying markup cannot inject an element', () => {
  const card = watchCard(row({ ticker: '<b>AAPL</b>' }), handlers);
  assert.equal(card.querySelectorAll('b').length, 0);
  assert.ok(card.textContent.includes('<b>AAPL</b>'));
});

/* ------------------------------------------------------------------ *
 * The chart tells the truth, or is not drawn
 * ------------------------------------------------------------------ */

test('a series thinner than the minimum is not charted', () => {
  for (let count = 0; count < MIN_CHART_POINTS; count++) {
    assert.equal(sparkline(history(count)), null, `${count} points should not draw`);
  }
  assert.ok(sparkline(history(MIN_CHART_POINTS)));
});

test('the chart floor matches the floor targets.js will anchor on', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/lib/targets.js', import.meta.url)), 'utf8');
  const declared = /MIN_HISTORY_POINTS\s*=\s*(\d+)/.exec(source);
  assert.ok(declared, 'targets.js should declare MIN_HISTORY_POINTS');
  assert.equal(MIN_CHART_POINTS, Number(declared[1]));
});

test('an unchartable card says how many more scans it needs', () => {
  const card = watchCard(row({ history: history(2) }), handlers);
  assert.equal(card.querySelectorAll('svg').length, 0);
  assert.match(card.textContent, /2 scans so far . 2 more to chart/);
});

test('a charted card states its range in text, not only in colour', () => {
  const card = watchCard(row({ history: history(6, 210) }), handlers);
  const svg = card.querySelector('svg');
  assert.ok(svg);
  // The drawing is decorative: the same facts are available as text.
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.match(card.textContent, /6 scans . 210 to 215/);
});

test('the series is ordered oldest-first for drawing', () => {
  // Stored newest-first, so the drawn line must be the reverse of storage.
  assert.deepEqual(seriesOf([{ price: 3 }, { price: 2 }, { price: 1 }]), [1, 2, 3]);
});

test('points with no usable price are dropped rather than drawn as zero', () => {
  assert.deepEqual(seriesOf([{ price: 5 }, { price: null }, { price: 'x' }, { price: 7 }]), [7, 5]);
});

test('a flat series does not divide by zero', () => {
  const svg = sparkline([{ price: 10 }, { price: 10 }, { price: 10 }, { price: 10 }]);
  assert.ok(svg);
  assert.ok(!svg.querySelector('polyline').getAttribute('points').includes('NaN'));
});

/* ------------------------------------------------------------------ *
 * Card content
 * ------------------------------------------------------------------ */

test('a watched ticker that has never been scanned still renders', () => {
  const card = watchCard(row({ snapshot: null, history: [] }), handlers);
  assert.match(card.textContent, /AAPL/);
  assert.match(card.textContent, /not scanned yet/);
  assert.ok(card.textContent.includes('—')); // no price, said plainly
});

test('a page that reported no change says so instead of showing a fake zero', () => {
  const card = watchCard(row({ snapshot: { ...SNAPSHOT, change_value: null, change_percentage: null } }), handlers);
  assert.match(card.textContent, /no change data/);
});

test('the target band places the marker and names the zone', () => {
  const card = watchCard(row({ position: { target_buy_below: 200, target_sell_above: 250 } }), handlers);
  const band = card.querySelector('.target');
  assert.equal(band.dataset.zone, 'hold');
  // 224.50 sits 49% of the way from 200 to 250.
  assert.equal(parseFloat(card.querySelector('.target-marker').style.left), 49);
});

test('a price past the sell target reads as the sell zone', () => {
  const card = watchCard(row({ position: { target_buy_below: 100, target_sell_above: 200 } }), handlers);
  assert.equal(card.querySelector('.target').dataset.zone, 'sell');
});

test('a half-configured target draws no band at all', () => {
  const card = watchCard(row({ position: { target_buy_below: 200 } }), handlers);
  assert.equal(card.querySelector('.target'), null);
});

test('a failed refresh is surfaced on the card', () => {
  const card = watchCard(
    row({ entry: { ticker: 'AAPL', monitor: false, last_error: 'no price on that page' } }),
    handlers
  );
  assert.match(card.textContent, /failed: no price on that page/);
  assert.equal(card.querySelector('input[type="checkbox"]').checked, false);
});

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

test('the summary counts only what actually has a price', () => {
  const rows = [
    row(),
    row({ ticker: 'MSFT', snapshot: { ...SNAPSHOT, ticker: 'MSFT', change_value: -2 } }),
    row({ ticker: 'TSLA', snapshot: null }),
  ];
  const bar = summaryBar({ rows, lastLoadedAt: new Date().toISOString() });
  const values = Array.from(bar.querySelectorAll('.stat-value')).map((node) => node.textContent);
  assert.equal(values[0], '3'); // watching
  assert.equal(values[1], '2'); // priced
  assert.equal(values[2], '1 / 1');
});

test('a missing key is flagged as a warning, not smuggled in as a statistic', () => {
  // The stat strip reports counts; "no key configured" is a caveat about every
  // advisory on the page, so it belongs with the controls, not among the tiles.
  assert.equal(advisorNote({ hasApiKey: true }), null);
  const note = advisorNote({ hasApiKey: false });
  assert.match(note.textContent, /rules-only/);

  const bar = summaryBar({ rows: [row()], lastLoadedAt: null });
  assert.ok(!bar.textContent.includes('rules'));
});

test('a disconnected website says what to do about it', () => {
  const panel = disconnectedState({ canConnect: true, onConnect: () => {} });
  assert.match(panel.textContent, /No extension connected/);
  assert.match(panel.textContent, /Open dashboard/);
  // It must not imply the page itself is holding any of the user's data.
  assert.match(panel.textContent, /nothing is stored here/);
});

test('open P/L is omitted when nothing is actually held', () => {
  const bar = summaryBar({ rows: [row()], lastLoadedAt: null });
  assert.ok(!bar.textContent.includes('Open P/L'));
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

test('relative time degrades to "never" rather than to Invalid Date', () => {
  assert.equal(relativeTime(null), 'never');
  assert.equal(relativeTime('not a date'), 'never');
});

test('relative time reads in the unit that fits', () => {
  const now = Date.parse('2026-08-22T12:00:00Z');
  assert.equal(relativeTime('2026-08-22T11:59:40Z', now), 'just now');
  assert.equal(relativeTime('2026-08-22T11:30:00Z', now), '30 min ago');
  assert.equal(relativeTime('2026-08-22T06:00:00Z', now), '6 hr ago');
  assert.equal(relativeTime('2026-08-21T12:00:00Z', now), 'yesterday');
  assert.equal(relativeTime('2026-08-18T12:00:00Z', now), '4 days ago');
});

test('direction treats an unknown move as flat, not as a fall', () => {
  assert.equal(directionOf(1.8), 'up');
  assert.equal(directionOf(-1.8), 'down');
  assert.equal(directionOf(0), 'flat');
  assert.equal(directionOf(null), 'flat');
  assert.equal(directionOf(NaN), 'flat');
});

test('el drops nullish children instead of printing them', () => {
  const node = el('div', 'a', null, undefined, false, 'b');
  assert.equal(node.textContent, 'ab');
});

test('el sets dataset and listeners rather than stringifying them', () => {
  let clicked = 0;
  const node = el('button', { dataset: { ticker: 'AAPL' }, onClick: () => { clicked += 1; } }, 'go');
  node.dispatchEvent(new dom.window.Event('click'));
  assert.equal(node.dataset.ticker, 'AAPL');
  assert.equal(clicked, 1);
});
