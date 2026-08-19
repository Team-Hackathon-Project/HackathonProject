/**
 * The selector registry: shipped defaults per host, plus the merge logic that
 * puts LLM-healed selectors ahead of the defaults.
 *
 * Selector shape used everywhere: { selector, strategy: 'css' | 'xpath' }.
 */

const css = (selector) => ({ selector, strategy: 'css' });

/**
 * Generic candidates. These are deliberately structural/semantic rather than
 * class-name based, because class names are the first thing a site rewrites.
 */
export const GENERIC_SELECTORS = {
  ticker: [
    css('[data-testid*="symbol" i]'),
    css('[data-symbol]'),
    css('[itemprop="tickerSymbol"]'),
    css('h1'),
  ],
  price: [
    css('[data-testid*="price" i]'),
    css('[data-field="regularMarketPrice"]'),
    css('[itemprop="price"]'),
    css('[class*="last-price" i]'),
    css('[class*="quote-price" i]'),
  ],
  change_percentage: [
    css('[data-field="regularMarketChangePercent"]'),
    css('[data-testid*="change-percent" i]'),
    css('[class*="change-percent" i]'),
    css('[class*="percent-change" i]'),
  ],
  volume: [
    css('[data-field="regularMarketVolume"]'),
    css('[data-testid*="volume" i]'),
    css('[class*="volume" i]'),
  ],
  news: [
    css('[data-testid*="storyitem" i] h3'),
    css('article h3'),
    css('[class*="news" i] a[href]'),
  ],
};

/** Per-host overrides, tried before the generic list. */
export const DEFAULT_REGISTRY = {
  'finance.yahoo.com': {
    ticker: [css('[data-testid="quote-hdr"] h1'), css('h1[class*="yf-"]')],
    price: [css('[data-testid="qsp-price"]'), css('fin-streamer[data-field="regularMarketPrice"]')],
    change_percentage: [
      css('[data-testid="qsp-price-change-percent"]'),
      css('fin-streamer[data-field="regularMarketChangePercent"]'),
    ],
    volume: [css('fin-streamer[data-field="regularMarketVolume"]'), css('[data-testid="VOLUME-value"]')],
    news: [css('[data-testid="storyitem"] h3'), css('section[data-testid="recent-news"] a h3')],
  },
  'www.google.com': {
    ticker: [css('[data-attrid="Symbol"]'), css('c-wiz h1')],
    price: [css('[data-last-price]'), css('.YMlKec.fxKbKc')],
    change_percentage: [css('.JwB6zf'), css('[data-percent-change]')],
    volume: [css('[data-metric="volume"]')],
    news: [css('div[role="heading"]')],
  },
  'www.marketwatch.com': {
    ticker: [css('.company__ticker'), css('h1.company__name')],
    price: [css('bg-quote.value'), css('.intraday__price .value')],
    change_percentage: [css('.change--percent--q bg-quote'), css('.intraday__change .percent')],
    volume: [css('[data-field="volume"] .primary')],
    news: [css('.article__headline a')],
  },
  'stockanalysis.com': {
    ticker: [css('main h1')],
    price: [css('[data-test="quote-price"]'), css('.text-4xl')],
    change_percentage: [css('[data-test="quote-change"]')],
    volume: [css('[data-test="volume"]')],
    news: [css('.news-item h3')],
  },
};

/** Normalizes anything registry-shaped into the canonical selector object. */
export function toSelectorEntry(value) {
  if (!value) return null;
  if (typeof value === 'string') return { selector: value, strategy: 'css' };
  if (typeof value.selector !== 'string' || !value.selector.trim()) return null;
  const strategy = value.strategy === 'xpath' ? 'xpath' : 'css';
  return { selector: value.selector.trim(), strategy };
}

/**
 * Builds the ordered candidate list for one field on one host:
 * healed selector first, then host defaults, then generic fallbacks.
 * Duplicates are removed while preserving order.
 */
export function candidatesFor(host, field, healedRegistry = {}) {
  const out = [];
  const push = (value, source) => {
    const entry = toSelectorEntry(value);
    if (!entry) return;
    const key = `${entry.strategy}::${entry.selector}`;
    if (out.some((existing) => `${existing.strategy}::${existing.selector}` === key)) return;
    out.push({ ...entry, source });
  };

  push((healedRegistry[host] || {})[field], 'healed');
  for (const value of (DEFAULT_REGISTRY[host] || {})[field] || []) push(value, 'default');

  // A host default for a sibling host (e.g. yahoo without the "finance." prefix)
  // is more useful than nothing, so fall back to any registered host suffix match.
  for (const [knownHost, fields] of Object.entries(DEFAULT_REGISTRY)) {
    if (knownHost === host) continue;
    if (!hostsRelated(host, knownHost)) continue;
    for (const value of fields[field] || []) push(value, 'default-related');
  }

  for (const value of GENERIC_SELECTORS[field] || []) push(value, 'generic');
  return out;
}

/** True when two hosts share a registrable-looking suffix (naive but adequate). */
export function hostsRelated(a, b) {
  if (!a || !b) return false;
  const tail = (host) => host.split('.').slice(-2).join('.');
  return tail(a) === tail(b);
}

/** Rejects selectors that are syntactically hostile or obviously useless. */
export function isPlausibleSelector(entry) {
  const normalized = toSelectorEntry(entry);
  if (!normalized) return false;
  const { selector, strategy } = normalized;
  if (selector.length > 400) return false;
  // '>' is the CSS child combinator; '<' only ever means the model handed back HTML.
  if (selector.includes('<')) return false;
  if (strategy === 'xpath') return selector.startsWith('/') || selector.startsWith('(') || selector.startsWith('.');
  // A bare universal or html/body selector matches the whole page: useless.
  if (['*', 'html', 'body', ':root'].includes(selector.toLowerCase())) return false;
  return true;
}
