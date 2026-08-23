/**
 * The agent's copy of the selector registry, the heal log and the snapshots it
 * has taken — the same three stores `src/lib/storage.js` keeps in
 * `chrome.storage.local`, backed by one JSON file instead.
 *
 * The agent has to own a copy rather than reach into the extension's: they are
 * separate processes with separate storage, and the agent must be usable on its
 * own (`npm run brightdata`) with no browser running at all. The bridge is what
 * reconciles them — a scrape returns whatever it healed, and the extension
 * merges that into its registry, so a repair found by the Bright Data path is
 * available to the popup on the next scan and vice versa.
 *
 * Writes are whole-file and synchronous. The state is a few kilobytes and the
 * bridge handles one scrape at a time; a database here would be furniture.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const MAX_HEAL_LOG = 100;
const MAX_SNAPSHOTS = 200;

export const STATE_DIR = path.join(ROOT, 'agent', 'state');
export const STATE_FILE = path.join(STATE_DIR, 'registry.json');

const EMPTY = { version: 1, selector_registry: {}, heal_log: [], snapshots: {} };

/** Reads the state file, tolerating absence and corruption alike. */
export function loadState(file = STATE_FILE) {
  if (!existsSync(file)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      ...structuredClone(EMPTY),
      ...parsed,
      selector_registry: parsed.selector_registry || {},
      heal_log: Array.isArray(parsed.heal_log) ? parsed.heal_log : [],
      snapshots: parsed.snapshots || {},
    };
  } catch {
    // A truncated write from a killed process should cost the healed selectors,
    // not every future run. They are re-derivable; a hard crash on boot is not.
    return structuredClone(EMPTY);
  }
}

/** Writes via a temporary file so an interrupted run cannot leave a partial one. */
export function saveState(state, file = STATE_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, file);
  return state;
}

export function getRegistry(file = STATE_FILE) {
  return loadState(file).selector_registry;
}

/**
 * Persists one healed selector for a host/field pair.
 * Mirrors `recordHealedSelector` in `src/lib/storage.js` field for field, so
 * the two registries are the same shape and can be merged in either direction.
 */
export function recordHealedSelector(host, field, entry, file = STATE_FILE) {
  const state = loadState(file);
  const forHost = { ...(state.selector_registry[host] || {}) };
  forHost[field] = {
    selector: entry.selector,
    strategy: entry.strategy || 'css',
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
    source: 'healed',
    healed_at: new Date().toISOString(),
  };
  state.selector_registry[host] = forHost;
  saveState(state, file);
  return forHost[field];
}

/** Drops one healed selector — used when it later proves to be wrong. */
export function forgetHealedSelector(host, field, file = STATE_FILE) {
  const state = loadState(file);
  if (!state.selector_registry[host] || !state.selector_registry[host][field]) return false;
  delete state.selector_registry[host][field];
  if (!Object.keys(state.selector_registry[host]).length) delete state.selector_registry[host];
  saveState(state, file);
  return true;
}

export function recordHealEvent(event, file = STATE_FILE) {
  const state = loadState(file);
  state.heal_log = [event, ...state.heal_log].slice(0, MAX_HEAL_LOG);
  saveState(state, file);
  return state.heal_log;
}

export function getHealLog(file = STATE_FILE) {
  return loadState(file).heal_log;
}

export function getSnapshots(file = STATE_FILE) {
  return loadState(file).snapshots;
}

export function saveSnapshot(snapshot, file = STATE_FILE) {
  if (!snapshot || !snapshot.ticker) return null;
  const state = loadState(file);
  state.snapshots[snapshot.ticker] = snapshot;
  const tickers = Object.keys(state.snapshots);
  if (tickers.length > MAX_SNAPSHOTS) {
    for (const ticker of tickers.slice(0, tickers.length - MAX_SNAPSHOTS)) delete state.snapshots[ticker];
  }
  saveState(state, file);
  return snapshot;
}

/**
 * Folds a registry received from elsewhere into this one, newest `healed_at`
 * winning. Used by the bridge so the extension's repairs and the agent's are
 * one set rather than two that drift.
 */
export function mergeRegistry(incoming = {}, file = STATE_FILE) {
  const state = loadState(file);
  let merged = 0;
  for (const [host, fields] of Object.entries(incoming || {})) {
    if (!fields || typeof fields !== 'object') continue;
    const target = { ...(state.selector_registry[host] || {}) };
    for (const [field, entry] of Object.entries(fields)) {
      if (!entry || typeof entry.selector !== 'string' || !entry.selector.trim()) continue;
      const existing = target[field];
      if (existing && Date.parse(existing.healed_at || 0) >= Date.parse(entry.healed_at || 0)) continue;
      target[field] = {
        selector: entry.selector,
        strategy: entry.strategy === 'xpath' ? 'xpath' : 'css',
        confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
        source: 'healed',
        healed_at: entry.healed_at || new Date().toISOString(),
      };
      merged++;
    }
    if (Object.keys(target).length) state.selector_registry[host] = target;
  }
  if (merged) saveState(state, file);
  return { merged, registry: state.selector_registry };
}
