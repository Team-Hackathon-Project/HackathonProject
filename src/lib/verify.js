/**
 * Post-scrape sanity checks.
 *
 * Healing can produce a selector that resolves, holds a number of the right
 * shape, and is still wrong: it points at something that belongs to the *page*
 * rather than to the *instrument* — an index tile in a market-summary rail, a
 * row in a "top movers" table. The value looks perfectly plausible on its own.
 * It only gives itself away across scans: every ticker on that host reports the
 * identical number.
 *
 * That is what this module looks for. Pure functions, so the rule is testable
 * without a browser.
 */

/** Host for a URL, or '' when it is missing or unparseable. */
export function hostOfUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Looks for a previously stored snapshot from the same host, for a *different*
 * ticker, carrying the exact same price.
 *
 * Two different instruments printing the identical price to the cent is
 * possible but vanishingly unlikely; the same selector reading one page-global
 * number is the ordinary explanation. Returns the conflicting snapshot's ticker
 * and price, or null.
 */
export function findStuckPrice({ snapshot, snapshots }) {
  if (!snapshot || !Number.isFinite(snapshot.current_price) || !snapshot.ticker) return null;
  const host = hostOfUrl(snapshot.source_url);
  if (!host) return null;

  for (const [ticker, previous] of Object.entries(snapshots || {})) {
    if (!previous || ticker === snapshot.ticker) continue;
    if (hostOfUrl(previous.source_url) !== host) continue;
    if (previous.current_price !== snapshot.current_price) continue;
    return { ticker, price: previous.current_price, host };
  }
  return null;
}
