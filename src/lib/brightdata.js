/**
 * Bright Data Scraping Browser: endpoint parsing, redaction, and the shape of
 * the local bridge the extension talks to.
 *
 * Everything here is pure — no `chrome.*`, no `node:*`, no imports — because
 * three different runtimes need it: the MV3 service worker, the options page,
 * and the Node agent in `agent/`.
 *
 * ## Why there is a bridge at all
 *
 * Bright Data's Scraping Browser is a remote Chrome spoken to over the DevTools
 * Protocol, and the endpoint carries its credentials in the URL:
 *
 *     wss://brd-customer-<CUSTOMER>-zone-<ZONE>:<PASSWORD>@brd.superproxy.io:9222
 *
 * A page — and an MV3 service worker is a page context — cannot open that. The
 * HTML standard requires the `WebSocket` constructor to throw a SyntaxError
 * when the URL "includes credentials", and Chrome implements that to the
 * letter. There is no header to set instead: the WebSocket API exposes no
 * request headers, so the Basic-auth workaround Bright Data's C# sample uses is
 * not available in a browser either.
 *
 * So the Scraping Browser session runs in Node (`agent/`), where puppeteer-core
 * can dial the endpoint directly, and the extension reaches it over a small
 * loopback HTTP bridge. That split is what the project architecture already
 * describes: a Chrome extension plus an agent engine.
 */

export const BRIGHTDATA_HOST = 'brd.superproxy.io';
export const BRIGHTDATA_CDP_PORT = 9222;

/** The bridge's default address. Loopback only — see `normalizeBridgeUrl`. */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8791';

/** Bridge protocol version, so a stale agent is reported rather than guessed at. */
export const BRIDGE_PROTOCOL = 1;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** `brd-customer-<customer>-zone-<zone>`, non-greedy so the first `-zone-` splits. */
const USERNAME_SHAPE = /^brd-customer-(.+?)-zone-(.+)$/;

/**
 * True when a value is the console's masked placeholder rather than a secret.
 *
 * Bright Data's dashboard prints the password as a row of asterisks until you
 * press the reveal control, and that masked string is what usually gets copied
 * first. It is worth naming precisely: pasted into a config it fails with a
 * bare "authentication failed", which sends people looking at the wrong thing.
 */
export function isMaskedSecret(value) {
  const text = String(value || '');
  if (!text) return false;
  return /^[*•·●\s]+$/.test(text);
}

/** Replaces all but the first two characters of a secret with bullets. */
export function redactSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 4) return '•'.repeat(text.length);
  return `${text.slice(0, 2)}${'•'.repeat(Math.min(text.length - 2, 10))}`;
}

/**
 * Parses a Scraping Browser endpoint into its parts.
 *
 * Accepts the full `wss://user:pass@host:port` URL, which is what the Bright
 * Data console hands you, and also a bare `user:pass` pair, which is the form
 * the `AUTH` variable in their code samples takes.
 *
 * Returns `{ ok: true, ... }` or `{ ok: false, error }`. Never throws, and
 * never puts the password in the error message.
 */
export function parseEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, error: 'No Bright Data endpoint configured.' };

  let username = '';
  let password = '';
  let host = BRIGHTDATA_HOST;
  let port = BRIGHTDATA_CDP_PORT;
  let protocol = 'wss:';

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: 'That is not a valid URL.' };
    }
    protocol = url.protocol;
    if (protocol !== 'wss:' && protocol !== 'ws:') {
      return { ok: false, error: `Expected a wss:// endpoint, got ${protocol}//.` };
    }
    if (!url.username) {
      return {
        ok: false,
        error: 'The endpoint carries no username. Copy the whole wss:// line from the Bright Data console.',
      };
    }
    // `new URL` percent-encodes the userinfo; the credentials are the decoded form.
    username = safeDecode(url.username);
    password = safeDecode(url.password);
    host = url.hostname;
    port = url.port ? Number(url.port) : BRIGHTDATA_CDP_PORT;
  } else {
    const split = raw.indexOf(':');
    if (split <= 0) {
      return { ok: false, error: 'Expected "wss://user:password@host:9222", or a bare "user:password" pair.' };
    }
    username = raw.slice(0, split);
    password = raw.slice(split + 1);
  }

  if (!password) return { ok: false, error: 'The endpoint carries no password.' };
  if (isMaskedSecret(password)) {
    return {
      ok: false,
      error: 'That password is the console’s mask (a row of asterisks), not the password itself. Reveal it on the Bright Data zone page, then copy the endpoint again.',
    };
  }

  const shape = USERNAME_SHAPE.exec(username);
  if (!shape) {
    return { ok: false, error: 'The username should read "brd-customer-<customer id>-zone-<zone name>".' };
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, error: 'The endpoint port is not a valid port number.' };
  }

  return {
    ok: true,
    endpoint: `${protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
    username,
    password,
    customer: shape[1],
    zone: shape[2],
    host,
    port,
  };
}

/** Rebuilds an endpoint URL from its parts. */
export function buildEndpoint({ customer, zone, password, host = BRIGHTDATA_HOST, port = BRIGHTDATA_CDP_PORT }) {
  const username = `brd-customer-${customer}-zone-${zone}`;
  return `wss://${encodeURIComponent(username)}:${encodeURIComponent(String(password))}@${host}:${port}`;
}

/**
 * Geo-targeting parameters Bright Data reads off the proxy username, in the
 * order their documentation gives them.
 */
export const GEO_PARAMS = ['country', 'city', 'state', 'asn', 'zip'];

/**
 * Pins the session's exit node to a place.
 *
 * Bright Data takes these as suffixes on the username —
 * `brd-customer-…-zone-…-country-us` — and it is not a nicety. Which country
 * the request appears to come from decides what the site serves: a European
 * exit node turns `google.com/finance` into `consent.google.com`, which has no
 * price on it at all, and the scrape then reports a page that "does not show a
 * price" when the truth is that it never reached the quote.
 *
 * Returns the endpoint unchanged when nothing is pinned.
 */
export function withGeo(endpoint, geo = {}) {
  const parsed = parseEndpoint(endpoint);
  if (!parsed.ok) return endpoint;

  let username = parsed.username;
  for (const key of GEO_PARAMS) {
    const value = String((geo && geo[key]) || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!value) continue;
    // Re-pinning an endpoint that already carries this parameter would produce
    // two of them, and Bright Data reads the first.
    if (new RegExp(`-${key}-`).test(username)) continue;
    username += `-${key}-${value}`;
  }
  if (username === parsed.username) return parsed.endpoint;
  return `wss://${encodeURIComponent(username)}:${encodeURIComponent(parsed.password)}@${parsed.host}:${parsed.port}`;
}

/** The geo suffixes present on an endpoint's username, as a plain object. */
export function geoOf(endpoint) {
  const parsed = parseEndpoint(endpoint);
  if (!parsed.ok) return {};
  const geo = {};
  for (const key of GEO_PARAMS) {
    const match = new RegExp(`-${key}-([^-]+)`).exec(parsed.username);
    if (match) geo[key] = match[1];
  }
  return geo;
}

/**
 * The endpoint with its password bulleted out — the only form that may be
 * logged, shown in the options page, or returned over the bridge.
 */
export function redactEndpoint(value) {
  const parsed = parseEndpoint(value);
  if (!parsed.ok) return '';
  return `wss://${parsed.username}:${redactSecret(parsed.password)}@${parsed.host}:${parsed.port}`;
}

/** A one-line description of a parsed endpoint, safe to display. */
export function describeEndpoint(parsed) {
  if (!parsed || !parsed.ok) return 'not configured';
  // The geo suffixes live inside the zone segment of the username, so they have
  // to be lifted back out to read as what they are rather than as a zone with
  // an odd name.
  const geo = geoOf(parsed.endpoint);
  const zone = parsed.zone.replace(/-(?:country|city|state|asn|zip)-[^-]+/g, '');
  const pinned = GEO_PARAMS.filter((key) => geo[key]).map((key) => `${key} ${geo[key]}`).join(', ');
  return [
    `zone ${zone}`,
    `customer ${parsed.customer}`,
    pinned ? `exit ${pinned}` : null,
    `${parsed.host}:${parsed.port}`,
  ].filter(Boolean).join(' · ');
}

/**
 * Validates a bridge address.
 *
 * Plain HTTP is accepted only on loopback. The bridge answers with scraped page
 * content and holds the Bright Data password; shipping that to a named host
 * over cleartext because a field was mistyped is not a failure mode worth
 * having.
 */
export function normalizeBridgeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, error: 'No bridge address configured.' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `The bridge address must be http:// or https://, got ${url.protocol}//.` };
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return { ok: false, error: 'A plain http:// bridge is only allowed on 127.0.0.1 or localhost.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Put the bridge token in the token field, not in the URL.' };
  }
  // Normalized to an origin: the paths are this module's to decide.
  return { ok: true, url: `${url.protocol}//${url.host}` };
}

export function isLoopback(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

/** The bridge's routes, derived from a normalized origin. */
export function bridgeRoutes(origin) {
  const base = String(origin || '').replace(/\/+$/, '');
  return {
    health: `${base}/health`,
    scrape: `${base}/scrape`,
    registry: `${base}/registry`,
    // Scraper Studio: a collector published in Bright Data's IDE, run on their
    // infrastructure. The bridge fronts it for the same reason it fronts the
    // Scraping Browser — the credentials belong on the agent's side, not in a
    // browser extension.
    studio: `${base}/studio`,
  };
}

/** The `http://host/*` permission pattern a bridge origin needs. */
export function bridgeOriginPattern(origin) {
  const normalized = normalizeBridgeUrl(origin);
  if (!normalized.ok) return null;
  const url = new URL(normalized.url);
  return `${url.protocol}//${url.hostname}/*`;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
