/**
 * Alert rules: deciding when a price movement is worth interrupting someone for.
 *
 * Pure and dependency-free, like `targets.js` — it is handed the state and
 * returns the alerts that should fire. Nothing here reads storage, writes
 * storage, or shows a notification.
 *
 * Four kinds of rule ship, because they answer genuinely different questions:
 *
 *   target      "tell me when it reaches the price I decided on"
 *               Reads the buy/sell targets already on the position, so anything
 *               set in the options page or proposed by `suggestTargets` alerts
 *               with nothing further to configure.
 *
 *   percent     "tell me when it moves 5%"  — the move, not the level.
 *
 *   level       "tell me when it is above 240" — a level with no opinion about
 *               cost basis or targets attached to it.
 *
 *   advice_flip "tell me when the recommendation changes" — the engine's own
 *               verdict turning over, which is the one rule that fires on
 *               something other than the number itself.
 *
 * Two rules run through everything:
 *
 *   Fire on a crossing, not on a state. A rule that fires while the condition
 *   merely holds re-fires on every pass, and a notification that arrives every
 *   fifteen minutes is one the user turns off. So the previous reading is
 *   consulted wherever there is one, and `cooldown_minutes` catches the rest.
 *
 *   Never fire on a number that is not there. A missing price is not a fall to
 *   zero, and a null baseline is not a 100% move.
 */

const DEFAULT_COOLDOWN_MINUTES = 60;

/** Baselines a percent rule can measure from. */
export const BASELINES = ['previous_scan', 'session_open', 'avg_cost', 'last_alert'];

export const RULE_KINDS = ['target', 'percent', 'level', 'advice_flip'];

const finite = (value) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
};

const round2 = (value) => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ *
 * Rule shape
 * ------------------------------------------------------------------ */

/**
 * Fills a rule out and rejects one that could never fire.
 *
 * A rule that is silently wrong is worse than one refused at the point it was
 * written, because the user believes they are being watched.
 */
export function normalizeRule(input = {}) {
  const kind = String(input.kind || '').trim();
  if (!RULE_KINDS.includes(kind)) return null;

  const ticker = String(input.ticker || '').trim().toUpperCase();
  if (!ticker) return null;

  const rule = {
    id: String(input.id || `${ticker}-${kind}-${Date.now().toString(36)}`),
    ticker,
    kind,
    enabled: input.enabled !== false,
    cooldown_minutes: finite(input.cooldown_minutes) ?? DEFAULT_COOLDOWN_MINUTES,
    created_at: input.created_at || new Date().toISOString(),
    last_fired_at: input.last_fired_at || null,
    last_fired_price: finite(input.last_fired_price),
  };

  if (kind === 'percent') {
    const threshold = finite(input.threshold);
    if (threshold === null || threshold <= 0) return null;
    rule.threshold = threshold;
    rule.direction = ['up', 'down', 'both'].includes(input.direction) ? input.direction : 'both';
    rule.baseline = BASELINES.includes(input.baseline) ? input.baseline : 'previous_scan';
  }

  if (kind === 'level') {
    const price = finite(input.price);
    if (price === null || price <= 0) return null;
    rule.price = price;
    rule.comparator = input.comparator === 'below' ? 'below' : 'above';
  }

  if (kind === 'advice_flip') {
    rule.last_action = input.last_action || null;
  }

  return rule;
}

/** True when this rule fired recently enough that it should stay quiet. */
export function inCooldown(rule, now) {
  if (!rule.last_fired_at) return false;
  const last = Date.parse(rule.last_fired_at);
  if (!Number.isFinite(last)) return false;
  const minutes = finite(rule.cooldown_minutes) ?? DEFAULT_COOLDOWN_MINUTES;
  if (minutes <= 0) return false;
  return now - last < minutes * 60 * 1000;
}

/* ------------------------------------------------------------------ *
 * The baseline a percent rule measures from
 * ------------------------------------------------------------------ */

/**
 * Resolves what "moved 5%" is measured against.
 *
 * Returns null when the chosen baseline is unavailable, and the rule then does
 * not fire. Falling back to another baseline would be worse than silence: the
 * user would get an alert whose number means something they did not ask for.
 */
export function baselineFor(rule, { previous, position, history }) {
  switch (rule.baseline) {
    case 'avg_cost':
      return finite(position && position.avg_cost);
    case 'last_alert':
      // Before the first alert there is nothing to measure from, so the last
      // reading stands in — otherwise the rule could never fire at all.
      return finite(rule.last_fired_price) ?? finite(previous && previous.current_price);
    case 'session_open': {
      // The oldest reading still held for this ticker. `price_history` is
      // capped, so this is "as far back as we can see", not a true open.
      const points = Array.isArray(history) ? history : [];
      const oldest = points[points.length - 1];
      return finite(oldest && oldest.price);
    }
    case 'previous_scan':
    default:
      return finite(previous && previous.current_price);
  }
}

const BASELINE_LABELS = {
  previous_scan: 'the previous reading',
  session_open: 'the oldest reading held',
  avg_cost: 'your average cost',
  last_alert: 'the last alert',
};

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

function alertFrom(rule, snapshot, { title, body, direction = null }) {
  return {
    id: `${rule.id}-${Date.parse(snapshot.extracted_at) || Date.now()}`,
    rule_id: rule.id,
    ticker: rule.ticker,
    kind: rule.kind,
    title,
    body,
    direction,
    price: snapshot.current_price,
    currency: snapshot.currency || 'USD',
    change_percentage: snapshot.change_percentage || null,
    at: snapshot.extracted_at || new Date().toISOString(),
    seen: false,
  };
}

/**
 * A target rule: the price reached a level the user already decided on.
 *
 * Crossing matters here. Holding above the sell target for a week is one event,
 * not one every refresh, so a previous reading already past the line suppresses
 * it.
 */
function evaluateTarget(rule, { snapshot, previous, position }) {
  if (!position) return null;
  const price = snapshot.current_price;
  const before = finite(previous && previous.current_price);

  const sell = finite(position.target_sell_above);
  if (sell !== null && sell > 0 && price >= sell && !(before !== null && before >= sell)) {
    return alertFrom(rule, snapshot, {
      direction: 'up',
      title: `${rule.ticker} reached your sell target`,
      body: `${round2(price)} is at or above the ${round2(sell)} you set to sell above.`,
    });
  }

  const buy = finite(position.target_buy_below);
  if (buy !== null && buy > 0 && price <= buy && !(before !== null && before <= buy)) {
    return alertFrom(rule, snapshot, {
      direction: 'down',
      title: `${rule.ticker} reached your buy target`,
      body: `${round2(price)} is at or below the ${round2(buy)} you set to buy below.`,
    });
  }
  return null;
}

/** A percent rule: the move itself, measured from a stated baseline. */
function evaluatePercent(rule, context) {
  const { snapshot } = context;
  const baseline = baselineFor(rule, context);
  if (baseline === null || baseline <= 0) return null;

  const move = ((snapshot.current_price - baseline) / baseline) * 100;
  const magnitude = Math.abs(move);
  if (magnitude < rule.threshold) return null;

  const direction = move > 0 ? 'up' : 'down';
  if (rule.direction !== 'both' && rule.direction !== direction) return null;

  const sign = move > 0 ? '+' : '';
  return alertFrom(rule, snapshot, {
    direction,
    title: `${rule.ticker} moved ${sign}${move.toFixed(2)}%`,
    body: `Now ${round2(snapshot.current_price)}, against ${round2(baseline)} — ${BASELINE_LABELS[rule.baseline] || 'the baseline'}.`,
  });
}

/** A level rule: a plain threshold, crossed rather than merely held. */
function evaluateLevel(rule, { snapshot, previous }) {
  const price = snapshot.current_price;
  const before = finite(previous && previous.current_price);
  const above = rule.comparator === 'above';

  const nowPast = above ? price >= rule.price : price <= rule.price;
  if (!nowPast) return null;
  const wasPast = before !== null && (above ? before >= rule.price : before <= rule.price);
  if (wasPast) return null;

  return alertFrom(rule, snapshot, {
    direction: above ? 'up' : 'down',
    title: `${rule.ticker} is ${above ? 'above' : 'below'} ${round2(rule.price)}`,
    body: `Last read at ${round2(price)}.`,
  });
}

/**
 * An advice_flip rule: the recommendation itself changed.
 *
 * The first evaluation records the verdict without firing — there is nothing to
 * have flipped from, and announcing "it is now HOLD" the moment a rule is
 * created is noise.
 */
function evaluateAdviceFlip(rule, { snapshot, advice }) {
  const action = advice && advice.action;
  if (!action) return null;
  if (!rule.last_action) return { rule_update: { last_action: action } };
  if (rule.last_action === action) return null;

  return {
    alert: alertFrom(rule, snapshot, {
      direction: action === 'BUY' ? 'down' : (action === 'SELL' ? 'up' : null),
      title: `${rule.ticker}: ${rule.last_action} → ${action}`,
      body: (advice.rationale || 'The recommendation changed.').slice(0, 200),
    }),
    rule_update: { last_action: action },
  };
}

const EVALUATORS = {
  target: evaluateTarget,
  percent: evaluatePercent,
  level: evaluateLevel,
  advice_flip: evaluateAdviceFlip,
};

/**
 * Runs every rule for one ticker against a fresh snapshot.
 *
 * Returns `{ alerts, updates }` — the alerts to raise, and the per-rule
 * bookkeeping the caller must persist so the next pass knows what already
 * fired. Nothing is written here.
 */
export function evaluateRules({
  rules = [],
  snapshot = null,
  previous = null,
  position = null,
  history = [],
  advice = null,
  now = Date.now(),
} = {}) {
  const alerts = [];
  const updates = {};

  // No price is not a fall to zero.
  if (!snapshot || !Number.isFinite(snapshot.current_price)) return { alerts, updates };

  for (const raw of rules) {
    const rule = normalizeRule(raw);
    if (!rule || !rule.enabled) continue;

    const evaluator = EVALUATORS[rule.kind];
    if (!evaluator) continue;

    const outcome = evaluator(rule, { snapshot, previous, position, history, advice });
    if (!outcome) continue;

    // An evaluator may return an alert, bookkeeping, or both.
    const alert = outcome.alert || (outcome.rule_id ? outcome : null);
    const update = outcome.rule_update || null;
    if (update) updates[rule.id] = { ...(updates[rule.id] || {}), ...update };

    if (!alert) continue;
    // The cooldown is checked last so that bookkeeping still happens while a
    // rule is quiet — otherwise a flip during a cooldown would be missed
    // entirely rather than merely not announced.
    if (inCooldown(rule, now)) continue;

    alerts.push(alert);
    updates[rule.id] = {
      ...(updates[rule.id] || {}),
      last_fired_at: new Date(now).toISOString(),
      last_fired_price: snapshot.current_price,
    };
  }

  return { alerts, updates };
}

/**
 * The default rules for a ticker the user has just started watching.
 *
 * One target rule, which costs nothing and does nothing until targets exist.
 * Anything noisier should be the user's decision, not a default.
 */
export function defaultRulesFor(ticker) {
  const rule = normalizeRule({ ticker, kind: 'target' });
  return rule ? [rule] : [];
}

/** A one-line summary of what a rule watches for, fit to show a person. */
export function describeRule(rule) {
  const normalized = normalizeRule(rule);
  if (!normalized) return 'an invalid rule';
  switch (normalized.kind) {
    case 'target':
      return 'reaches your buy or sell target';
    case 'percent': {
      const way = normalized.direction === 'both' ? 'moves' : `moves ${normalized.direction}`;
      return `${way} ${normalized.threshold}% from ${BASELINE_LABELS[normalized.baseline]}`;
    }
    case 'level':
      return `goes ${normalized.comparator} ${round2(normalized.price)}`;
    case 'advice_flip':
      return 'the recommendation changes';
    default:
      return normalized.kind;
  }
}
