/**
 * Suggested buy/sell targets.
 *
 * Targets are what turn a quote into a signal, and typing two numbers per
 * ticker is the step people skip — so the extension offers to propose them. It
 * proposes; you still save them. Nothing here writes anything.
 *
 * The model is deliberately boring and explainable, because a target you cannot
 * justify is worse than no target:
 *
 *   anchor  what the stock is "normally" worth to you, in this order:
 *             1. the average of the prices you have actually scanned
 *             2. the average price of your own approved BUY decisions
 *             3. your average cost
 *             4. today's price, if that is all there is
 *   band    how far either side of the anchor is worth acting on, taken from
 *           the volatility of the scans when there are enough of them, and a
 *           flat 5% when there are not
 *
 *   buy_below  = anchor × (1 − band)
 *   sell_above = anchor × (1 + band)
 *
 * This is arithmetic on your own data. It is not a forecast, and it does not
 * ask a model what a stock is worth.
 */

const MIN_HISTORY_POINTS = 4;
const MIN_BAND = 0.03;
const MAX_BAND = 0.20;
const DEFAULT_BAND = 0.05;

const round2 = (value) => Math.round(value * 100) / 100;

function finite(value) {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Mean, spread and range of a price series. Returns null when it is too thin. */
export function summarizeHistory(points = []) {
  const prices = (Array.isArray(points) ? points : [])
    .map((point) => finite(point && point.price))
    .filter((price) => price !== null && price > 0);
  if (!prices.length) return null;

  const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + (price - mean) ** 2, 0) / prices.length;
  return {
    count: prices.length,
    mean: round2(mean),
    min: round2(Math.min(...prices)),
    max: round2(Math.max(...prices)),
    stdev: round2(Math.sqrt(variance)),
    latest: round2(prices[0]),
  };
}

/** The average price of the BUY decisions the user actually approved. */
export function averageApprovedBuy(decisions = [], ticker = null) {
  const prices = (Array.isArray(decisions) ? decisions : [])
    .filter((entry) => entry
      && (!ticker || entry.ticker === ticker)
      && entry.verdict === 'APPROVED'
      && entry.final_action === 'BUY')
    .map((entry) => finite(entry.price))
    .filter((price) => price !== null && price > 0);
  if (!prices.length) return null;
  return { count: prices.length, mean: round2(prices.reduce((sum, price) => sum + price, 0) / prices.length) };
}

/**
 * Proposes a target pair, and says where it came from.
 *
 * Returns null only when there is nothing at all to anchor on — no scans, no
 * decisions, no cost basis, no price. Otherwise the `basis` field names the
 * evidence used and `note` is a sentence fit to show a person.
 */
export function suggestTargets({ snapshot = null, history = [], position = {}, decisions = [], ticker = null } = {}) {
  const symbol = ticker || (snapshot && snapshot.ticker) || null;
  const summary = summarizeHistory(history);
  const approved = averageApprovedBuy(decisions, symbol);
  const avgCost = finite(position && position.avg_cost);
  const price = finite(snapshot && snapshot.current_price);

  let anchor = null;
  let basis = null;
  let evidence = null;

  if (summary && summary.count >= MIN_HISTORY_POINTS) {
    anchor = summary.mean;
    basis = 'history';
    evidence = `${summary.count} scans averaging ${summary.mean}`;
  } else if (approved) {
    anchor = approved.mean;
    basis = 'decisions';
    evidence = `${approved.count} approved BUY decision(s) averaging ${approved.mean}`;
  } else if (avgCost !== null && avgCost > 0) {
    anchor = avgCost;
    basis = 'cost';
    evidence = `your average cost of ${round2(avgCost)}`;
  } else if (price !== null && price > 0) {
    anchor = price;
    basis = 'price';
    evidence = `today's price of ${round2(price)}`;
  }

  if (anchor === null || !(anchor > 0)) return null;

  // Volatility gives the band its width when the scans support it: a stock that
  // has barely moved does not deserve a wide band, and a jumpy one does.
  let band = DEFAULT_BAND;
  let bandFrom = `a flat ${Math.round(DEFAULT_BAND * 100)}%`;
  if (summary && summary.count >= MIN_HISTORY_POINTS && summary.stdev > 0) {
    const relative = summary.stdev / summary.mean;
    band = Math.min(MAX_BAND, Math.max(MIN_BAND, relative));
    bandFrom = `the ${(relative * 100).toFixed(1)}% spread of those scans`;
  }

  const buyBelow = round2(anchor * (1 - band));
  const sellAbove = round2(anchor * (1 + band));

  const notes = [`Anchored on ${evidence}, with a ${(band * 100).toFixed(1)}% band from ${bandFrom}.`];
  if (price !== null) {
    if (price <= buyBelow) notes.push('Today\'s price is already at or under the buy target, so this will read as a BUY.');
    else if (price >= sellAbove) notes.push('Today\'s price is already at or over the sell target, so this will read as a SELL.');
  }
  if (basis === 'price') notes.push('Scan this ticker a few more times and the suggestion will improve.');

  return {
    ticker: symbol,
    target_buy_below: buyBelow,
    target_sell_above: sellAbove,
    anchor: round2(anchor),
    band: round2(band * 100) / 100,
    basis,
    sample_size: (summary && summary.count) || (approved && approved.count) || 0,
    note: notes.join(' '),
  };
}
