/**
 * Data normalization: turns raw scraped page text into structured, typed JSON.
 * Everything here is pure so it can be unit tested outside the browser.
 */

const CURRENCY_SYMBOLS = {
  '$': 'USD',
  '€': 'EUR',   // euro
  '£': 'GBP',   // pound
  '¥': 'JPY',   // yen
  '₹': 'INR',   // rupee
  '₩': 'KRW',   // won
  '₽': 'RUB',   // ruble
};

const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'CAD', 'AUD', 'CHF', 'CNY', 'HKD', 'KRW', 'SGD', 'RUB'];

const MAGNITUDES = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** One percentage reading, with optional accounting parentheses and sign. */
const PERCENT_READING = /\(?\s*[-+−]?\s*\d[\d.,]*\s*%\s*\)?/g;

/** Collapses whitespace and strips zero-width/non-breaking characters. */
export function cleanText(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses a price string such as "$224.50", "1,234.56 USD", "€1.234,56".
 * Returns null when no number can be recovered.
 */
export function parsePrice(input) {
  const text = cleanText(input);
  if (!text) return null;
  const match = text.match(/-?\d[\d.,\s]*/);
  if (!match) return null;
  const value = parseDecimal(match[0]);
  if (value === null) return null;
  return { value, currency: detectCurrency(text) };
}

/** Detects an ISO currency code from a symbol or a trailing code in the text. */
export function detectCurrency(input) {
  const text = cleanText(input).toUpperCase();
  for (const code of CURRENCY_CODES) {
    if (new RegExp(`(^|[^A-Z])${code}([^A-Z]|$)`).test(text)) return code;
  }
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (cleanText(input).includes(symbol)) return code;
  }
  return null;
}

/**
 * Parses a decimal that may use either "1,234.56" (US) or "1.234,56" (EU)
 * grouping. Returns null on anything that is not a finite number.
 */
export function parseDecimal(raw) {
  let text = String(raw).replace(/\s/g, '');
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // The right-most separator is the decimal point.
    text = lastComma > lastDot
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimals = text.length - lastComma - 1;
    // "1,234" is grouping; "1,5" and "1,50" are decimals.
    text = decimals === 3 ? text.replace(/,/g, '') : text.replace(',', '.');
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses "+1.8%", "-0.42 %", "(1.8%)" into a normalized
 * { text: "+1.80%", value: 1.8 } pair. Returns null when unparseable.
 */
export function parseChangePercentage(input) {
  const text = cleanText(input);
  if (!text) return null;
  const match = text.match(/([-+−(]?)\s*(\d[\d.,]*)\s*%/);
  if (!match) return null;
  let value = parseDecimal(match[2]);
  if (value === null) return null;
  // A wrapping parenthesis means negative in accounting style — but only when
  // no explicit sign is present: sites also render "(+1.80%)" next to a price.
  const sign = match[1];
  const negative = sign === '-' || sign === '\u2212' || sign === '('
    || (!sign && /^\(/.test(text));
  if (negative) value = -value;
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  return { value, text: `${prefix}${Math.abs(value).toFixed(2)}%` };
}

/** Parses "52.3M", "1,234,567", "3.1 B" into an integer share count. */
export function parseVolume(input) {
  const text = cleanText(input);
  if (!text) return null;
  const match = text.match(/(\d[\d.,]*)\s*([KkMmBbTt])?/);
  if (!match) return null;
  const base = parseDecimal(match[1]);
  if (base === null) return null;
  const scale = match[2] ? MAGNITUDES[match[2].toLowerCase()] : 1;
  return Math.round(base * scale);
}

/** Extracts an uppercase ticker from a label like "Apple Inc. (AAPL)" or "AAPL". */
export function parseTicker(input) {
  const text = cleanText(input);
  if (!text) return null;
  const parenthesized = text.match(/\(([A-Z][A-Z0-9.\-]{0,9})\)/);
  if (parenthesized) return parenthesized[1];
  const bare = text.match(/\b([A-Z][A-Z0-9.\-]{0,9})\b/);
  return bare ? bare[1] : null;
}

/** Best-effort ticker recovery from a quote URL when the DOM gives us nothing. */
export function tickerFromUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const params = ['symbol', 'ticker', 's', 't', 'q'];
  for (const key of params) {
    const value = parsed.searchParams.get(key);
    const candidate = value && parseTicker(value.toUpperCase());
    if (candidate) return candidate;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const anchors = ['quote', 'quotes', 'symbol', 'stocks', 'stock', 'chart', 'company'];
  for (let i = 0; i < segments.length; i++) {
    if (anchors.includes(segments[i].toLowerCase()) && segments[i + 1]) {
      const candidate = parseTicker(decodeURIComponent(segments[i + 1]).toUpperCase());
      if (candidate) return candidate;
    }
  }
  return null;
}

/** Trims a news blob down to a short, ad-free headline list. */
export function normalizeNews(items, limit = 5) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const headline = cleanText(item).slice(0, 180);
    if (headline.length < 12) continue;
    const key = headline.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(headline);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Sanity check that a scraped string is the *kind* of value the field expects.
 *
 * The parsers are deliberately forgiving — `parseVolume("$182.44")` happily
 * returns 182 — so a selector pointed at the wrong node yields a number that
 * looks fine downstream. This is the guard that keeps a price out of the
 * volume field, and it is what a healed selector must satisfy before it is
 * trusted and persisted.
 */
export function valueFitsField(field, input) {
  const text = cleanText(input);
  if (!text) return false;
  switch (field) {
    case 'ticker':
      return parseTicker(text) !== null;
    case 'price': {
      if (parsePrice(text) === null) return false;
      // Strip percentage readings — "(+1.80%)" is a change, not a price — and
      // require a number to survive. "182.44 (+1.80%)" still qualifies.
      return /\d/.test(text.replace(PERCENT_READING, ' '));
    }
    case 'change_percentage':
      return parseChangePercentage(text) !== null;
    case 'volume':
      // Share counts carry neither a percent sign nor a currency marker.
      if (/%/.test(text)) return false;
      if (detectCurrency(text) !== null) return false;
      return parseVolume(text) !== null;
    case 'news':
      return true;
    default:
      return true;
  }
}

/**
 * Builds the canonical scraping payload stored in `chrome.storage.local`.
 * `raw` carries the strings the content script pulled out of the DOM.
 */
export function buildSnapshot(raw, meta = {}) {
  // Only parse a field when the raw text is the right shape for it, so a
  // mis-aimed selector drops the field instead of inventing a value.
  const price = valueFitsField('price', raw.price) ? parsePrice(raw.price) : null;
  const change = parseChangePercentage(raw.change_percentage);
  const ticker = parseTicker(raw.ticker) || tickerFromUrl(meta.source_url);
  return {
    ticker: ticker || null,
    current_price: price ? price.value : null,
    currency: (price && price.currency) || meta.currency || 'USD',
    change_percentage: change ? change.text : null,
    change_value: change ? change.value : null,
    volume: valueFitsField('volume', raw.volume) ? parseVolume(raw.volume) : null,
    news: normalizeNews(raw.news),
    extracted_at: meta.extracted_at || new Date().toISOString(),
    source_url: meta.source_url || null,
    selectors_used: meta.selectors_used || {},
  };
}

/** A snapshot is usable only when we recovered a ticker and a finite price. */
export function isUsableSnapshot(snapshot) {
  return Boolean(
    snapshot &&
    typeof snapshot.ticker === 'string' &&
    snapshot.ticker.length > 0 &&
    Number.isFinite(snapshot.current_price)
  );
}
