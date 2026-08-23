/**
 * One scrape, end to end: open a Bright Data session, run the self-healing
 * extraction, verify the result, persist what survives.
 *
 * Both entry points call this and nothing else — `agent/cli.mjs` for a person
 * at a terminal, `agent/server.mjs` for the extension over the loopback bridge —
 * so the two cannot drift in what a scrape means.
 */
import { withQuotePage, sanitizeWithJsdom, safeHost } from './brightdata.mjs';
import { extractWithHealing } from './healing.mjs';
import {
  getRegistry, recordHealedSelector, forgetHealedSelector, recordHealEvent,
  getSnapshots, saveSnapshot,
} from './registry.mjs';
import { isUsableSnapshot } from '../src/lib/normalize.js';

/**
 * Where to look up a ticker given without a URL.
 *
 * stockanalysis.com renders its quotes server-side and is already in the
 * shipped selector registry — the same default `src/background.js` uses, so a
 * ticker added in the dashboard and a ticker scraped here land on one page.
 */
export function defaultQuoteUrl(ticker) {
  return `https://stockanalysis.com/stocks/${encodeURIComponent(String(ticker).toLowerCase())}/`;
}

export function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase() || null;
}

/**
 * Scrapes one quote page through Bright Data.
 *
 * Never throws for a page-level problem — a site that is down, a page with no
 * price, a ticker mismatch — because the bridge turns this into a JSON answer
 * and a monitoring pass must survive one bad host. A missing endpoint or a
 * refused connection *does* throw: that is a configuration fault, not a page.
 */
export async function scrapeThroughBrightData({
  url,
  ticker = null,
  config,
  log = () => {},
  selfHeal = true,
}) {
  if (!config || !config.endpoint || !config.endpoint.ok) {
    throw new Error((config && config.endpoint && config.endpoint.error) || 'Bright Data is not configured.');
  }
  const symbol = normalizeTicker(ticker);
  const target = String(url || '').trim() || (symbol ? defaultQuoteUrl(symbol) : '');
  if (!target) throw new Error('A url or a ticker is required.');

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`"${target}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http(s) quote pages can be scraped.');
  }

  const registry = getRegistry();
  const snapshots = getSnapshots();
  const startedAt = Date.now();

  const outcome = await withQuotePage({
    endpoint: config.endpoint.endpoint,
    url: target,
    tuning: config.tuning,
    log,
  }, async ({ driver, host, url: landedUrl, captcha }) => {
    // A redirect off the host that was asked for is almost never a redirect to
    // the same page: it is a consent wall, a login wall, or a geo-gate. Reading
    // it produces "this page does not show a price", which is true and useless —
    // the page it names is not the page anyone asked for. So it is detected
    // here and reported as itself.
    const landedElsewhere = crossHostRedirect(target, landedUrl);
    if (landedElsewhere) {
      return { interstitial: landedElsewhere, captcha, landedUrl, host };
    }
    const result = await extractWithHealing({
      driver,
      url: landedUrl,
      host: host || safeHost(target),
      ticker: symbol,
      registry,
      llm: { provider: config.llm.provider, model: config.llm.model, apiKey: config.llm.apiKey },
      sanitize: async (html, maxChars) => sanitizeWithJsdom(html, maxChars),
      onHeal: async (healHost, field, proposal) => recordHealedSelector(healHost, field, proposal),
      onForget: async (healHost, field) => forgetHealedSelector(healHost, field),
      onEvent: async (event) => { recordHealEvent({ ...event, via: 'brightdata' }); },
      snapshots,
      maxSnippetChars: config.tuning.maxSnippetChars,
      selfHeal,
    });
    return { ...result, captcha, landedUrl };
  });

  if (outcome.interstitial) {
    return {
      ok: false,
      ticker: symbol,
      method: 'brightdata',
      error: outcome.interstitial,
      url: outcome.landedUrl,
      host: outcome.host,
      requested_url: target,
      healed: [],
      warnings: [],
      notices: [],
      captcha: outcome.captcha,
      duration_ms: Date.now() - startedAt,
    };
  }

  const snapshot = outcome.snapshot;
  const warnings = [...outcome.warnings];

  // A price filed under the wrong symbol is worse than no price: it would be
  // charted as this ticker's history. Same rule the background refresh applies.
  if (symbol && snapshot.ticker && snapshot.ticker !== symbol) {
    return {
      ok: false,
      ticker: symbol,
      method: 'brightdata',
      error: `that page reported ${snapshot.ticker}, not ${symbol}`,
      url: outcome.landedUrl,
      host: outcome.host,
      healed: outcome.healed,
      warnings,
      notices: outcome.notices,
      captcha: outcome.captcha,
      duration_ms: Date.now() - startedAt,
    };
  }
  if (symbol) snapshot.ticker = symbol;

  const usable = isUsableSnapshot(snapshot);
  if (usable) saveSnapshot(snapshot);

  return {
    ok: usable,
    ticker: snapshot.ticker || symbol,
    method: 'brightdata',
    error: usable ? null : (warnings[0] || 'no price could be read from that page'),
    snapshot,
    url: outcome.landedUrl,
    host: outcome.host,
    title: outcome.title,
    healed: outcome.healed,
    warnings,
    notices: outcome.notices,
    failedFields: outcome.failedFields,
    captcha: outcome.captcha,
    /**
     * Only the hosts this scrape touched. The extension merges this into
     * `chrome.storage.local`, which is how a repair made out here reaches the
     * popup without either side reading the other's storage.
     */
    registry: registrySliceFor(outcome.host),
    duration_ms: Date.now() - startedAt,
  };
}

/** Words in a host that name it as a gate rather than as the content. */
const INTERSTITIAL_HINTS = ['consent', 'login', 'signin', 'sign-in', 'auth', 'accounts', 'sorry', 'captcha', 'verify', 'blocked'];

/**
 * Describes a redirect that left the requested host, or returns null.
 *
 * Same-site movement is normal and ignored: `google.com` to `www.google.com`,
 * `finance.yahoo.com` to `uk.finance.yahoo.com`. What matters is arriving
 * somewhere that is not the site at all.
 */
export function crossHostRedirect(requested, landed) {
  const from = safeHost(requested);
  const to = safeHost(landed);
  if (!from || !to || from === to) return null;

  const registrable = (host) => host.split('.').slice(-2).join('.');
  if (registrable(from) === registrable(to)) {
    // Still the same site, but a named gate on it — `consent.google.com` from
    // `www.google.com` is the case that started this.
    const gate = INTERSTITIAL_HINTS.find((hint) => to.split('.')[0].includes(hint));
    if (!gate) return null;
    return `the site redirected to ${to}, which is a ${gate} page rather than the quote`
      + ' — pin the session to a country that is not gated, with BRIGHTDATA_COUNTRY in the agent\'s .env';
  }
  return `the request for ${from} ended up on ${to}, so the page read was not the quote page`;
}

/** The healed selectors for one host, as the bridge returns them. */
export function registrySliceFor(host) {
  if (!host) return {};
  const registry = getRegistry();
  return registry[host] ? { [host]: registry[host] } : {};
}
