/**
 * Thin promise wrapper around `chrome.storage.local` plus the typed accessors
 * the rest of the extension uses. Keeping every read/write here means the
 * storage shape is defined in exactly one place.
 */
import { STORAGE_KEYS, DEFAULT_SETTINGS, MAX_DECISIONS, MAX_HEAL_LOG } from './constants.js';

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
  return { ...DEFAULT_SETTINGS, ...rest, providers };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const providers = { ...current.providers };
  for (const [id, values] of Object.entries(patch.providers || {})) {
    providers[id] = { ...(providers[id] || {}), ...values };
  }
  const next = { ...current, ...patch, providers };
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
