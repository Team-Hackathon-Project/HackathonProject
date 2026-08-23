/**
 * The Bright Data endpoint parser and the bridge address rules.
 *
 * Two of these tests exist because of a specific, expensive mistake: the Bright
 * Data console masks the zone password until you press the reveal control, and
 * the masked string copies cleanly. Pasted into a config it produces an
 * authentication failure, which sends people to check the zone name, the
 * customer id, their plan, and their firewall — everything except the one thing
 * that is wrong. So the mask is rejected by name, and that is a behaviour worth
 * pinning down rather than a nicety.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEndpoint, buildEndpoint, redactEndpoint, redactSecret, describeEndpoint, isMaskedSecret,
  normalizeBridgeUrl, bridgeRoutes, bridgeOriginPattern, isLoopback, withGeo, geoOf,
  BRIGHTDATA_HOST, BRIGHTDATA_CDP_PORT, DEFAULT_BRIDGE_URL,
} from '../src/lib/brightdata.js';

const ENDPOINT = 'wss://brd-customer-hl_test1234-zone-scraping_browser1:s3cr3tpass@brd.superproxy.io:9222';

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

test('a Scraping Browser endpoint is split into customer, zone, host and port', () => {
  const parsed = parseEndpoint(ENDPOINT);

  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.customer, 'hl_test1234');
  assert.equal(parsed.zone, 'scraping_browser1');
  assert.equal(parsed.host, BRIGHTDATA_HOST);
  assert.equal(parsed.port, BRIGHTDATA_CDP_PORT);
  assert.equal(parsed.password, 's3cr3tpass');
});

test('a zone name containing a dash survives the split', () => {
  const parsed = parseEndpoint('wss://brd-customer-hl_abc-zone-my-browser-zone:pw@brd.superproxy.io:9222');

  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.customer, 'hl_abc');
  assert.equal(parsed.zone, 'my-browser-zone');
});

test('the bare user:password form from the AUTH samples is accepted', () => {
  const parsed = parseEndpoint('brd-customer-hl_test1234-zone-scraping_browser1:s3cr3tpass');

  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.zone, 'scraping_browser1');
  assert.equal(parsed.endpoint, ENDPOINT, 'the default host and port are filled in');
});

test('a password with URL-special characters round-trips through the endpoint', () => {
  const built = buildEndpoint({ customer: 'hl_x', zone: 'z1', password: 'p@ss:w/rd?#' });
  const parsed = parseEndpoint(built);

  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.password, 'p@ss:w/rd?#');
  assert.equal(parsed.zone, 'z1');
});

test('a non-default port is preserved rather than reset to 9222', () => {
  const parsed = parseEndpoint('wss://brd-customer-c-zone-z:pw@brd.superproxy.io:9223');
  assert.equal(parsed.port, 9223);
});

/* ------------------------------------------------------------------ *
 * The masked password, and the other refusals
 * ------------------------------------------------------------------ */

test('the console mask is refused, and the message says how to get the real one', () => {
  const parsed = parseEndpoint('wss://brd-customer-hl_test1234-zone-scraping_browser1:**********@brd.superproxy.io:9222');

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /mask/i);
  assert.match(parsed.error, /reveal/i);
});

test('isMaskedSecret knows a mask from a password that merely contains a star', () => {
  assert.equal(isMaskedSecret('**********'), true);
  assert.equal(isMaskedSecret('••••'), true);
  assert.equal(isMaskedSecret(''), false);
  assert.equal(isMaskedSecret('pa*sword'), false, 'a star is legal inside a real password');
});

test('an http:// endpoint is refused — the Scraping Browser speaks CDP over wss', () => {
  const parsed = parseEndpoint('https://brd-customer-c-zone-z:pw@brd.superproxy.io:9222');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /wss/);
});

test('a username in the wrong shape is named, not guessed at', () => {
  const parsed = parseEndpoint('wss://someuser:pw@brd.superproxy.io:9222');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /brd-customer-/);
});

test('an endpoint with no password is refused', () => {
  assert.equal(parseEndpoint('wss://brd-customer-c-zone-z@brd.superproxy.io:9222').ok, false);
});

test('an empty value is refused without throwing', () => {
  for (const value of [undefined, null, '', '   ', 'not a url at all']) {
    const parsed = parseEndpoint(value);
    assert.equal(parsed.ok, false);
    assert.equal(typeof parsed.error, 'string');
  }
});

/* ------------------------------------------------------------------ *
 * Redaction
 *
 * The endpoint is printed by the CLI, returned by /health, and shown on the
 * options page. Every one of those paths goes through redactEndpoint, so a
 * leak here is a leak in three places at once.
 * ------------------------------------------------------------------ */

test('a redacted endpoint keeps the zone and loses the password', () => {
  const redacted = redactEndpoint(ENDPOINT);

  assert.match(redacted, /brd-customer-hl_test1234-zone-scraping_browser1/);
  assert.equal(redacted.includes('s3cr3tpass'), false);
  assert.match(redacted, /•/);
});

test('no error message ever carries the password', () => {
  const parsed = parseEndpoint('wss://nope:s3cr3tpass@brd.superproxy.io:9222');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.includes('s3cr3tpass'), false);
});

test('a short secret is redacted whole rather than half-shown', () => {
  assert.equal(redactSecret('abcd'), '••••');
  assert.equal(redactSecret(''), '');
  assert.match(redactSecret('abcdefghij'), /^ab•+$/);
});

test('redacting an unparseable endpoint returns nothing at all', () => {
  assert.equal(redactEndpoint('garbage'), '');
});

test('describeEndpoint names the zone and never the password', () => {
  const description = describeEndpoint(parseEndpoint(ENDPOINT));
  assert.match(description, /scraping_browser1/);
  assert.equal(description.includes('s3cr3tpass'), false);
  assert.equal(describeEndpoint(parseEndpoint('garbage')), 'not configured');
});

/* ------------------------------------------------------------------ *
 * The bridge address
 * ------------------------------------------------------------------ */

test('the default bridge address is loopback and normalizes to itself', () => {
  const normalized = normalizeBridgeUrl(DEFAULT_BRIDGE_URL);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.url, DEFAULT_BRIDGE_URL);
});

test('plain http to a named host is refused, because the bridge answers with page data', () => {
  const normalized = normalizeBridgeUrl('http://agent.example.com:8791');
  assert.equal(normalized.ok, false);
  assert.match(normalized.error, /127\.0\.0\.1|localhost/);
});

test('https to a named host is allowed', () => {
  assert.equal(normalizeBridgeUrl('https://agent.example.com').ok, true);
});

test('a path on the bridge address is discarded — the routes are ours to pick', () => {
  assert.equal(normalizeBridgeUrl('http://localhost:8791/some/path').url, 'http://localhost:8791');
});

test('credentials in the bridge URL are refused rather than quietly used', () => {
  const normalized = normalizeBridgeUrl('http://user:pass@127.0.0.1:8791');
  assert.equal(normalized.ok, false);
  assert.match(normalized.error, /token field/);
});

test('a non-http scheme is refused', () => {
  assert.equal(normalizeBridgeUrl('ws://127.0.0.1:8791').ok, false);
  assert.equal(normalizeBridgeUrl('file:///tmp').ok, false);
});

test('the routes are derived from the origin, with no double slashes', () => {
  const routes = bridgeRoutes('http://127.0.0.1:8791/');
  assert.equal(routes.health, 'http://127.0.0.1:8791/health');
  assert.equal(routes.scrape, 'http://127.0.0.1:8791/scrape');
  assert.equal(routes.registry, 'http://127.0.0.1:8791/registry');
});

test('the permission pattern drops the port, as Chrome match patterns require', () => {
  assert.equal(bridgeOriginPattern('http://127.0.0.1:8791'), 'http://127.0.0.1/*');
  assert.equal(bridgeOriginPattern('nonsense'), null);
});

test('isLoopback covers the three spellings of this machine', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('localhost'), true);
  assert.equal(isLoopback('[::1]'), true);
  assert.equal(isLoopback('example.com'), false);
});

/* ------------------------------------------------------------------ *
 * Geo-targeting
 *
 * Which country the exit node sits in decides what the site serves. A European
 * exit turns google.com/finance into consent.google.com, which has no quote on
 * it — and the scrape then reports "this page does not show a price", which is
 * true about the page it reached and useless about the one that was asked for.
 * ------------------------------------------------------------------ */

test('a country pin is appended to the username, where Bright Data reads it', () => {
  const pinned = withGeo(ENDPOINT, { country: 'us' });
  const parsed = parseEndpoint(pinned);

  assert.equal(parsed.ok, true, parsed.error);
  assert.match(parsed.username, /-zone-scraping_browser1-country-us$/);
  assert.equal(parsed.password, 's3cr3tpass', 'pinning must not disturb the credentials');
});

test('country, city and state are applied in the documented order', () => {
  const parsed = parseEndpoint(withGeo(ENDPOINT, { state: 'ny', country: 'us', city: 'new york' }));
  assert.match(parsed.username, /-country-us-city-newyork-state-ny$/);
});

test('an endpoint already carrying a country is not pinned twice', () => {
  const once = withGeo(ENDPOINT, { country: 'us' });
  const twice = withGeo(once, { country: 'de' });
  assert.equal(geoOf(twice).country, 'us', 'Bright Data reads the first, so a second would be a silent lie');
});

test('pinning nothing leaves the endpoint alone', () => {
  assert.equal(parseEndpoint(withGeo(ENDPOINT, {})).username, parseEndpoint(ENDPOINT).username);
  assert.deepEqual(geoOf(ENDPOINT), {});
});

test('pinning an unparseable endpoint returns it untouched rather than mangling it', () => {
  assert.equal(withGeo('garbage', { country: 'us' }), 'garbage');
});

test('the description lifts the pin out of the zone name so it reads as what it is', () => {
  const described = describeEndpoint(parseEndpoint(withGeo(ENDPOINT, { country: 'us' })));
  assert.match(described, /zone scraping_browser1 /, 'the zone name is shown without the suffix glued on');
  assert.match(described, /exit country us/);
});

/**
 * A live run once failed with `normalizeTicker is not defined` while the whole
 * unit suite stayed green: `export … from` publishes a name to importers but
 * does not bind it in the exporting module's own scope, so every test that
 * imported the helper passed while the scrape that *calls* it threw. This
 * reaches the scrape's own call sites, which is where the difference shows.
 */
test('the scrape resolves its ticker helpers in its own scope', async () => {
  const { scrapeThroughBrightData } = await import('../agent/scrape.mjs');
  await assert.rejects(
    () => scrapeThroughBrightData({
      ticker: 'aapl',
      config: { ok: false, endpoint: { ok: false, error: 'endpoint not configured' } },
      selfHeal: false,
    }),
    (error) => {
      assert.doesNotMatch(error.message, /is not defined/, error.message);
      assert.match(error.message, /endpoint not configured/);
      return true;
    }
  );
});

/**
 * `protocolTimeout` bounds every CDP call on the connection, and the longest of
 * those is the navigation. Setting it to the connect budget caps a 120s
 * navigation at 60s, which surfaces as "Page.navigate timed out" — a timeout on
 * the wrong clock, blaming the page for a limit it was never given.
 */
test('the connection outlives the navigation it has to carry', async () => {
  const { connectBrightData } = await import('../agent/brightdata.mjs');
  const seen = [];
  const puppeteer = (await import('puppeteer-core')).default;
  const realConnect = puppeteer.connect;
  puppeteer.connect = async (options) => {
    seen.push(options);
    return { mock: true };
  };
  try {
    await connectBrightData({ endpoint: ENDPOINT, connectTimeoutMs: 60000, navigationTimeoutMs: 120000 });
    assert.ok(
      seen[0].protocolTimeout >= 120000,
      `protocolTimeout ${seen[0].protocolTimeout} must cover a 120000ms navigation`
    );

    // A connect budget larger than the navigation still wins.
    await connectBrightData({ endpoint: ENDPOINT, connectTimeoutMs: 300000, navigationTimeoutMs: 5000 });
    assert.equal(seen[1].protocolTimeout, 300000);
  } finally {
    puppeteer.connect = realConnect;
  }
});
