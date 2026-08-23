/**
 * Ticker and quote-URL helpers.
 *
 * A leaf module on purpose: both the Scraping Browser path and the Scraper
 * Studio path need these, and the Studio client must not drag in the browser
 * driver — that import chain runs back through `config.mjs` and forms a cycle.
 */

/** The quote page this project scrapes when it is given only a symbol. */
export function defaultQuoteUrl(ticker) {
  return `https://stockanalysis.com/stocks/${encodeURIComponent(String(ticker).toLowerCase())}/`;
}

/** Upper-cased symbol, or null for anything blank. */
export function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase() || null;
}
