/**
 * The dashboard's store.
 *
 * Small on purpose: one snapshot of extension state, a connection status, and a
 * subscriber list. There is no reducer and no diffing because there is one
 * writer — `refresh()` — and the render pass is cheap enough to run whole.
 */
import { request, subscribe as subscribeToChanges, NotConnectedError } from './bridge.js';

const listeners = new Set();

const state = {
  /** 'connecting' | 'connected' | 'disconnected' */
  status: 'connecting',
  error: null,
  data: null,
  lastLoadedAt: null,
  /** Tickers with a request in flight, so cards can show their own spinner. */
  busy: new Set(),
  selected: null,
  /** True while a whole-watchlist pass is running; it can take a while. */
  refreshing: false,
};

export const getState = () => state;

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(state);
}

/**
 * Re-reads everything from the extension.
 *
 * A failed refresh does not clear `data`: a dashboard that blanks itself
 * because one poll missed is worse than one showing a stale price next to a
 * visible "disconnected" banner.
 */
export async function refresh() {
  try {
    const data = await request('GET_DASHBOARD_STATE');
    state.data = data;
    state.status = 'connected';
    state.error = null;
    state.lastLoadedAt = new Date().toISOString();
  } catch (error) {
    state.status = error instanceof NotConnectedError ? 'disconnected' : 'connected';
    state.error = String((error && error.message) || error);
  }
  emit();
  return state;
}

/**
 * Runs one mutating call, keeping the affected ticker marked busy throughout,
 * then re-reads. The re-read is what makes the extension the single source of
 * truth: nothing here guesses at the result of a write.
 */
export async function mutate(type, payload, { ticker = null } = {}) {
  if (ticker) {
    state.busy.add(ticker);
    emit();
  }
  try {
    await request(type, payload);
    await refresh();
  } catch (error) {
    state.error = String((error && error.message) || error);
    emit();
    throw error;
  } finally {
    if (ticker) {
      state.busy.delete(ticker);
      emit();
    }
  }
}

export function select(ticker) {
  state.selected = ticker;
  emit();
}

export function clearError() {
  state.error = null;
  emit();
}

/** Starts the refresh loop. Returns an unsubscribe function. */
export function start() {
  const stop = subscribeToChanges(() => { refresh(); });
  refresh();
  return stop;
}

/* ------------------------------------------------------------------ *
 * Derived views
 * ------------------------------------------------------------------ */

/**
 * The watchlist as a sorted array, with each ticker's snapshot, position and
 * price history attached.
 *
 * A watched ticker that has never been scanned still appears, with a null
 * snapshot — it is on the list because the user put it there, and hiding it
 * until it happens to have a price would lose the thing they just added.
 */
export function watchedRows(data = state.data) {
  if (!data) return [];
  const watchlist = data.watchlist || {};
  const snapshots = data.snapshots || {};
  const portfolio = data.portfolio || {};
  const history = data.priceHistory || {};

  return Object.keys(watchlist)
    .sort((a, b) => a.localeCompare(b))
    .map((ticker) => ({
      ticker,
      entry: watchlist[ticker],
      snapshot: snapshots[ticker] || null,
      position: portfolio[ticker] || null,
      history: history[ticker] || [],
    }));
}

/** The alert rules for one ticker. */
export function rulesFor(ticker, data = state.data) {
  return ((data && data.alertRules) || {})[ticker] || [];
}

/** Every alert, newest first, as the worker stored them. */
export function alertsOf(data = state.data) {
  return (data && data.alerts) || [];
}

/** The decisions recorded for one ticker, newest first. */
export function decisionsFor(ticker, data = state.data) {
  return ((data && data.decisions) || []).filter((entry) => entry && entry.ticker === ticker);
}
