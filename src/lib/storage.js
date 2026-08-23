/**
 * Thin promise wrapper around `chrome.storage.local` plus the typed accessors
 * the rest of the extension uses. Keeping every read/write here means the
 * storage shape is defined in exactly one place.
 */
import {
  STORAGE_KEYS, DEFAULT_SETTINGS, MAX_DECISIONS, MAX_HEAL_LOG, MAX_PRICE_POINTS, MAX_ALERTS,
} from './constants.js';

function area() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    throw new Error('chrome.storage.local is unavailable in this context');
  }
  return chrome.storage.local;
}

export async function getRaw(keys) {
  return area().get(keys);
}

export async function setRaw(items) {
  return area().set(items);
}

/**
 * Merges stored settings over the defaults, one level deep for `providers` so
 * a stored Groq key does not wipe the Anthropic defaults (or vice versa).
 *
 * Settings written before providers existed carried a bare `apiKey`/`model`
 * pair; those belonged to Anthropic, so they are folded in here.
 */
export async function getSettings() {
  const stored = (await getRaw(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS] || {};
  const providers = {};
  for (const [id, defaults] of Object.entries(DEFAULT_SETTINGS.providers)) {
    providers[id] = { ...defaults, ...((stored.providers || {})[id] || {}) };
  }
  if (stored.apiKey && !((stored.providers || {}).anthropic || {}).apiKey) {
    providers.anthropic.apiKey = stored.apiKey;
  }
  if (stored.model && !((stored.providers || {}).anthropic || {}).model) {
    providers.anthropic.model = stored.model;
  }
  const { apiKey, model, ...rest } = stored;
  // `brightdata` gets the same one-level merge as `providers`: settings written
  // before it existed carry no such key, and a later release adding a field to
  // it must not be blanked out by an older stored object.
  const brightdata = { ...DEFAULT_SETTINGS.brightdata, ...(stored.brightdata || {}) };
  return { ...DEFAULT_SETTINGS, ...rest, providers, brightdata };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const providers = { ...current.providers };
  for (const [id, values] of Object.entries(patch.providers || {})) {
    providers[id] = { ...(providers[id] || {}), ...values };
  }
  const brightdata = { ...current.brightdata, ...(patch.brightdata || {}) };
  const next = { ...current, ...patch, providers, brightdata };
  await setRaw({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

export async function getPortfolio() {
  const stored = await getRaw(STORAGE_KEYS.PORTFOLIO);
  return stored[STORAGE_KEYS.PORTFOLIO] || {};
}

export async function savePosition(ticker, position) {
  const portfolio = await getPortfolio();
  if (position === null) delete portfolio[ticker];
  else portfolio[ticker] = { ...(portfolio[ticker] || {}), ...position };
  await setRaw({ [STORAGE_KEYS.PORTFOLIO]: portfolio });
  return portfolio;
}

/* ------------------------------------------------------------------ *
 * Watchlist
 *
 * The set of tickers the dashboard shows. Kept separate from `portfolio`
 * because watching something and owning it are different claims: you can track
 * a stock you have never bought, and you can hold one you would rather not be
 * reminded about. `source_url` is the part that matters operationally — it is
 * the page a refresh goes back to.
 * ------------------------------------------------------------------ */

export async function getWatchlist() {
  const stored = await getRaw(STORAGE_KEYS.WATCHLIST);
  return stored[STORAGE_KEYS.WATCHLIST] || {};
}

export async function saveWatchlist(watchlist) {
  await setRaw({ [STORAGE_KEYS.WATCHLIST]: watchlist });
  return watchlist;
}

/**
 * Adds or updates one watched ticker, merging over whatever is already there.
 *
 * Merging matters: a scan knows a fresh `source_url` but nothing about whether
 * the user has since switched monitoring off, and it must not clobber that.
 */
export async function saveWatchEntry(ticker, patch = {}) {
  const symbol = String(ticker || '').trim().toUpperCase();
  if (!symbol) return null;
  const watchlist = await getWatchlist();
  const existing = watchlist[symbol] || null;
  watchlist[symbol] = {
    ticker: symbol,
    source_url: null,
    monitor: true,
    added_at: new Date().toISOString(),
    last_refreshed_at: null,
    last_error: null,
    last_method: null,
    ...(existing || {}),
    ...patch,
    ticker: symbol,
  };
  await saveWatchlist(watchlist);
  return watchlist[symbol];
}

export async function removeWatchEntry(ticker) {
  const symbol = String(ticker || '').trim().toUpperCase();
  const watchlist = await getWatchlist();
  if (!watchlist[symbol]) return false;
  delete watchlist[symbol];
  await saveWatchlist(watchlist);
  return true;
}

/**
 * Back-fills the watchlist from snapshots taken before the watchlist existed,
 * once. Every snapshot already carries the `source_url` it came from, so an
 * upgrading user opens the dashboard to their real history rather than to an
 * empty page.
 *
 * The `watchlistSeeded` flag is what stops this from resurrecting tickers the
 * user has since deliberately removed.
 */
export async function seedWatchlistFromSnapshots() {
  const settings = await getSettings();
  if (settings.watchlistSeeded) return { seeded: false, added: [] };

  const snapshots = await getSnapshots();
  const watchlist = await getWatchlist();
  const added = [];
  for (const [ticker, snapshot] of Object.entries(snapshots)) {
    if (watchlist[ticker] || !snapshot) continue;
    watchlist[ticker] = {
      ticker,
      source_url: snapshot.source_url || null,
      monitor: true,
      added_at: snapshot.extracted_at || new Date().toISOString(),
      last_refreshed_at: snapshot.extracted_at || null,
      last_error: null,
      last_method: null,
    };
    added.push(ticker);
  }
  if (added.length) await saveWatchlist(watchlist);
  await saveSettings({ watchlistSeeded: true });
  return { seeded: true, added };
}

/* ------------------------------------------------------------------ *
 * Alert rules and the alerts they raise
 * ------------------------------------------------------------------ */

export async function getAlertRules(ticker = null) {
  const stored = await getRaw(STORAGE_KEYS.ALERT_RULES);
  const rules = stored[STORAGE_KEYS.ALERT_RULES] || {};
  return ticker ? (rules[ticker] || []) : rules;
}

/** Adds or replaces one rule, matched on id. */
export async function saveAlertRule(rule) {
  if (!rule || !rule.ticker || !rule.id) return null;
  const all = await getAlertRules();
  const forTicker = [...(all[rule.ticker] || [])];
  const index = forTicker.findIndex((existing) => existing.id === rule.id);
  if (index === -1) forTicker.push(rule);
  else forTicker[index] = { ...forTicker[index], ...rule };
  all[rule.ticker] = forTicker;
  await setRaw({ [STORAGE_KEYS.ALERT_RULES]: all });
  return rule;
}

/**
 * Folds the per-rule bookkeeping from one evaluation back into storage.
 *
 * Separate from `saveAlertRule` because it is the hot path: a monitor pass
 * writes these on every tick, and it must not disturb anything the user has
 * edited in the meantime beyond the fields it owns.
 */
export async function applyRuleUpdates(updates = {}) {
  const ids = Object.keys(updates);
  if (!ids.length) return null;
  const all = await getAlertRules();
  for (const [ticker, rules] of Object.entries(all)) {
    all[ticker] = rules.map((rule) => (updates[rule.id] ? { ...rule, ...updates[rule.id] } : rule));
  }
  await setRaw({ [STORAGE_KEYS.ALERT_RULES]: all });
  return all;
}

export async function deleteAlertRule(ticker, ruleId) {
  const all = await getAlertRules();
  const forTicker = all[ticker] || [];
  const remaining = forTicker.filter((rule) => rule.id !== ruleId);
  if (remaining.length === forTicker.length) return false;
  if (remaining.length) all[ticker] = remaining;
  else delete all[ticker];
  await setRaw({ [STORAGE_KEYS.ALERT_RULES]: all });
  return true;
}

/** Drops every rule for a ticker, for when it leaves the watchlist. */
export async function deleteAlertRulesFor(ticker) {
  const all = await getAlertRules();
  if (!all[ticker]) return false;
  delete all[ticker];
  await setRaw({ [STORAGE_KEYS.ALERT_RULES]: all });
  return true;
}

export async function getAlerts() {
  const stored = await getRaw(STORAGE_KEYS.ALERTS);
  return stored[STORAGE_KEYS.ALERTS] || [];
}

/** Records alerts newest-first, skipping any id already present. */
export async function recordAlerts(alerts = []) {
  if (!alerts.length) return getAlerts();
  const existing = await getAlerts();
  const seen = new Set(existing.map((alert) => alert.id));
  const fresh = alerts.filter((alert) => alert && !seen.has(alert.id));
  if (!fresh.length) return existing;
  const list = [...fresh, ...existing].slice(0, MAX_ALERTS);
  await setRaw({ [STORAGE_KEYS.ALERTS]: list });
  return list;
}

export async function markAlertsSeen(ids = null) {
  const alerts = await getAlerts();
  const wanted = ids === null ? null : new Set(ids);
  const list = alerts.map((alert) => (
    wanted === null || wanted.has(alert.id) ? { ...alert, seen: true } : alert
  ));
  await setRaw({ [STORAGE_KEYS.ALERTS]: list });
  return list;
}

export async function clearAlerts() {
  await setRaw({ [STORAGE_KEYS.ALERTS]: [] });
  return [];
}

export async function countUnseenAlerts() {
  return (await getAlerts()).filter((alert) => !alert.seen).length;
}

export async function getRegistry() {
  const stored = await getRaw(STORAGE_KEYS.SELECTORS);
  return stored[STORAGE_KEYS.SELECTORS] || {};
}

export async function saveRegistry(registry) {
  await setRaw({ [STORAGE_KEYS.SELECTORS]: registry });
  return registry;
}

/** Persists one healed selector for a host/field pair. */
export async function recordHealedSelector(host, field, entry) {
  const registry = await getRegistry();
  const forHost = { ...(registry[host] || {}) };
  forHost[field] = {
    selector: entry.selector,
    strategy: entry.strategy || 'css',
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
    source: 'healed',
    healed_at: new Date().toISOString(),
  };
  registry[host] = forHost;
  await saveRegistry(registry);
  return registry[host][field];
}

/**
 * Drops one healed selector, leaving the rest of the registry alone.
 *
 * Used when a repaired selector is later found to be wrong — it resolved and
 * held a plausible value, but the value belonged to the page rather than to the
 * instrument. Forgetting it lets the next scan repair the field properly
 * instead of serving the same wrong number forever.
 */
export async function forgetHealedSelector(host, field) {
  const registry = await getRegistry();
  if (!registry[host] || !registry[host][field]) return false;
  delete registry[host][field];
  if (!Object.keys(registry[host]).length) delete registry[host];
  await saveRegistry(registry);
  return true;
}

/**
 * Folds a registry received from the Bright Data agent into this one.
 *
 * The agent keeps its own copy of the healed selectors — it is a separate
 * process with separate storage, and it has to work with no browser running at
 * all. This is the reconciliation: whichever side repaired a field more
 * recently wins, so a repair made against a page opened through the Scraping
 * Browser is available to the popup on the very next scan.
 *
 * Entries are re-validated rather than trusted. The bridge is loopback and
 * token-guarded, but a selector is a string that gets run against pages, and
 * "it arrived over the local socket" is not a reason to skip checking its shape.
 */
export async function mergeHealedRegistry(incoming = {}) {
  const registry = await getRegistry();
  let merged = 0;
  for (const [host, fields] of Object.entries(incoming || {})) {
    if (!host || !fields || typeof fields !== 'object') continue;
    const forHost = { ...(registry[host] || {}) };
    for (const [field, entry] of Object.entries(fields)) {
      if (!entry || typeof entry.selector !== 'string' || !entry.selector.trim()) continue;
      const existing = forHost[field];
      if (existing && Date.parse(existing.healed_at || 0) >= Date.parse(entry.healed_at || 0)) continue;
      forHost[field] = {
        selector: entry.selector.trim(),
        strategy: entry.strategy === 'xpath' ? 'xpath' : 'css',
        confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
        source: 'healed',
        healed_at: entry.healed_at || new Date().toISOString(),
      };
      merged++;
    }
    if (Object.keys(forHost).length) registry[host] = forHost;
  }
  if (merged) await saveRegistry(registry);
  return { merged, registry };
}

export async function clearRegistry() {
  await setRaw({ [STORAGE_KEYS.SELECTORS]: {} });
  return {};
}

export async function saveSnapshot(snapshot) {
  const stored = await getRaw(STORAGE_KEYS.SNAPSHOTS);
  const snapshots = stored[STORAGE_KEYS.SNAPSHOTS] || {};
  snapshots[snapshot.ticker] = snapshot;
  await setRaw({ [STORAGE_KEYS.SNAPSHOTS]: snapshots });
  return snapshots;
}

export async function getSnapshots() {
  const stored = await getRaw(STORAGE_KEYS.SNAPSHOTS);
  return stored[STORAGE_KEYS.SNAPSHOTS] || {};
}

/**
 * Appends one price point for a ticker, newest first and capped.
 *
 * `snapshots` only ever holds the latest scan; this is the series the target
 * suggester averages over. Points are only worth keeping when the price parsed.
 */
export async function recordPricePoint(snapshot) {
  if (!snapshot || !snapshot.ticker || !Number.isFinite(snapshot.current_price)) return null;
  const stored = await getRaw(STORAGE_KEYS.PRICE_HISTORY);
  const history = stored[STORAGE_KEYS.PRICE_HISTORY] || {};
  const point = {
    at: snapshot.extracted_at || new Date().toISOString(),
    price: snapshot.current_price,
    change_value: Number.isFinite(snapshot.change_value) ? snapshot.change_value : null,
  };
  history[snapshot.ticker] = [point, ...(history[snapshot.ticker] || [])].slice(0, MAX_PRICE_POINTS);
  await setRaw({ [STORAGE_KEYS.PRICE_HISTORY]: history });
  return history[snapshot.ticker];
}

export async function getPriceHistory(ticker = null) {
  const stored = await getRaw(STORAGE_KEYS.PRICE_HISTORY);
  const history = stored[STORAGE_KEYS.PRICE_HISTORY] || {};
  return ticker ? (history[ticker] || []) : history;
}

/** Appends to a capped, newest-first log stored under `key`. */
async function appendCapped(key, entry, cap) {
  const stored = await getRaw(key);
  const list = [entry, ...(stored[key] || [])].slice(0, cap);
  await setRaw({ [key]: list });
  return list;
}

export async function recordDecision(decision) {
  return appendCapped(STORAGE_KEYS.DECISIONS, decision, MAX_DECISIONS);
}

export async function getDecisions() {
  const stored = await getRaw(STORAGE_KEYS.DECISIONS);
  return stored[STORAGE_KEYS.DECISIONS] || [];
}

export async function recordHealEvent(event) {
  return appendCapped(STORAGE_KEYS.HEAL_LOG, event, MAX_HEAL_LOG);
}

export async function getHealLog() {
  const stored = await getRaw(STORAGE_KEYS.HEAL_LOG);
  return stored[STORAGE_KEYS.HEAL_LOG] || [];
}
