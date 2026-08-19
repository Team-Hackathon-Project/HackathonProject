/**
 * Advisory engine.
 *
 * `heuristicAdvice()` is a deterministic, offline rules engine over the user's
 * own portfolio targets — it is the source of truth when no API key is set and
 * the safety net whenever the LLM answer fails validation.
 *
 * Nothing here ever executes a trade. Every result carries
 * `user_action_required: true`; the UI must collect an explicit human decision.
 */

const ACTIONS = ['BUY', 'SELL', 'HOLD'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Coerces a stored field to a number. Empty strings, null and undefined all
 * mean "not configured" — Number('') is 0, which would otherwise read as a
 * real target of zero.
 */
export function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Validates and repairs an advisory object against the documented output schema. */
export function validateAdvice(candidate, fallbackTicker = null) {
  if (!candidate || typeof candidate !== 'object') return null;
  const action = String(candidate.action || '').toUpperCase().trim();
  if (!ACTIONS.includes(action)) return null;
  const rationale = typeof candidate.rationale === 'string' ? candidate.rationale.trim() : '';
  if (rationale.length < 20) return null;
  let score = Number(candidate.confidence_score);
  if (!Number.isFinite(score)) return null;
  if (score > 1 && score <= 100) score = score / 100; // tolerate a percentage
  if (score < 0 || score > 1) return null;
  const ticker = typeof candidate.ticker === 'string' && candidate.ticker.trim()
    ? candidate.ticker.trim().toUpperCase()
    : fallbackTicker;
  if (!ticker) return null;
  return {
    ticker,
    action,
    confidence_score: round2(score),
    rationale,
    user_action_required: true, // never negotiable: the human decides
  };
}

/** Unrealized profit/loss for a held position, or null when unknown. */
export function positionPnl(snapshot, position) {
  const avgCost = position ? toNumberOrNull(position.avg_cost) : null;
  if (avgCost === null || avgCost <= 0) return null;
  if (!snapshot || !Number.isFinite(snapshot.current_price)) return null;
  const shares = toNumberOrNull(position.shares) || 0;
  const perShare = snapshot.current_price - avgCost;
  return {
    avg_cost: avgCost,
    shares,
    per_share: round2(perShare),
    percent: round2((perShare / avgCost) * 100),
    total: round2(perShare * shares),
  };
}

/**
 * Deterministic BUY/SELL/HOLD over the user's targets and the day's move.
 * Returns the documented output schema plus a `source` marker.
 */
export function heuristicAdvice(snapshot, position = {}, options = {}) {
  const price = snapshot.current_price;
  const ticker = snapshot.ticker;
  const change = Number.isFinite(snapshot.change_value) ? snapshot.change_value : null;
  // A non-positive target is not a threshold anyone can act on: treat it as unset.
  const positive = (value) => (value !== null && value > 0 ? value : null);
  const buyBelow = positive(toNumberOrNull(position.target_buy_below));
  const sellAbove = positive(toNumberOrNull(position.target_sell_above));
  const shares = toNumberOrNull(position.shares) || 0;
  const pnl = positionPnl(snapshot, position);
  const facts = [];

  facts.push(`${ticker} trades at ${formatMoney(price, snapshot.currency)}`);
  if (change !== null) {
    facts.push(`${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(2)}% on the session`);
  }
  if (Number.isFinite(snapshot.volume)) facts.push(`volume ${formatCompact(snapshot.volume)}`);

  let action = 'HOLD';
  let confidence = 0.4;
  let driver;

  if (sellAbove !== null && price >= sellAbove && shares > 0) {
    action = 'SELL';
    const overshoot = (price - sellAbove) / sellAbove;
    confidence = clamp(0.6 + overshoot * 4, 0.6, 0.92);
    driver = `Price is at or above your sell target of ${formatMoney(sellAbove, snapshot.currency)}`;
  } else if (buyBelow !== null && price <= buyBelow) {
    action = 'BUY';
    const discount = (buyBelow - price) / buyBelow;
    confidence = clamp(0.6 + discount * 4, 0.6, 0.92);
    driver = `Price is at or below your buy target of ${formatMoney(buyBelow, snapshot.currency)}`;
  } else if (buyBelow === null && sellAbove === null) {
    action = 'HOLD';
    confidence = 0.35;
    driver = 'No buy or sell target is configured for this ticker, so there is no threshold to act on';
  } else {
    action = 'HOLD';
    driver = 'Price sits inside your configured target band';
    const distances = [];
    if (buyBelow !== null) distances.push(Math.abs(price - buyBelow) / buyBelow);
    if (sellAbove !== null) distances.push(Math.abs(price - sellAbove) / sellAbove);
    const nearest = distances.length ? Math.min(...distances) : 1;
    confidence = clamp(0.45 + nearest * 2, 0.45, 0.8);
  }

  // A large intraday move against a threshold decision lowers our confidence:
  // the quote may be mid-swing and the snapshot is a single point in time.
  if (change !== null && Math.abs(change) >= 5 && action !== 'HOLD') {
    confidence = clamp(confidence - 0.15, 0.3, 0.9);
    facts.push('the intraday move is unusually large, so this single snapshot may not be representative');
  }

  const sentences = [`${driver}. ${capitalize(facts.join(', '))}.`];
  if (pnl) {
    sentences.push(
      `Your position of ${pnl.shares} share(s) at ${formatMoney(pnl.avg_cost, snapshot.currency)} average cost is ` +
      `${pnl.percent >= 0 ? 'up' : 'down'} ${Math.abs(pnl.percent).toFixed(2)}% ` +
      `(${formatMoney(pnl.total, snapshot.currency)} unrealized).`
    );
  } else if (shares === 0) {
    sentences.push('No recorded position, so a SELL is not actionable for this account.');
  }
  if (Array.isArray(snapshot.news) && snapshot.news.length) {
    sentences.push(`Headline context on the page: "${snapshot.news[0]}".`);
  }
  sentences.push('Rules-based signal from your own targets and the scraped quote only — no forecast, and no order is placed. Confirm before acting.');

  return {
    ticker,
    action,
    confidence_score: round2(clamp(confidence, 0, 1)),
    rationale: sentences.join(' '),
    user_action_required: true,
    source: options.source || 'heuristic',
    generated_at: new Date().toISOString(),
  };
}

/** Compact context object handed to the LLM advisor. */
export function buildAdvisoryContext(snapshot, position = {}) {
  return {
    ticker: snapshot.ticker,
    current_price: snapshot.current_price,
    currency: snapshot.currency,
    change_percentage: snapshot.change_percentage,
    volume: snapshot.volume,
    news_headlines: Array.isArray(snapshot.news) ? snapshot.news.slice(0, 5) : [],
    extracted_at: snapshot.extracted_at,
    source_url: snapshot.source_url,
    user_position: {
      shares: toNumberOrNull(position.shares) || 0,
      avg_cost: toNumberOrNull(position.avg_cost),
      target_buy_below: toNumberOrNull(position.target_buy_below),
      target_sell_above: toNumberOrNull(position.target_sell_above),
    },
    unrealized_pnl: positionPnl(snapshot, position),
  };
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatMoney(value, currency = 'USD') {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value < 0 ? '-' : '';
  return `${sign}${currency ? `${currency} ` : ''}${Math.abs(value).toFixed(2)}`;
}

export function formatCompact(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [scale, suffix] of units) {
    if (Math.abs(value) >= scale) return `${(value / scale).toFixed(2)}${suffix}`;
  }
  return String(value);
}
