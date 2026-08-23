/**
 * Dashboard entry point: wires the store to the DOM and owns the render pass.
 *
 * The whole view is rebuilt from state on every change. At the sizes involved —
 * a watchlist is tens of rows, not thousands — that is cheaper to reason about
 * than a diff, and it removes the class of bug where a card keeps a value the
 * store no longer holds. The one thing preserved across a rebuild is focus, so
 * a rebuild triggered by a background poll does not move the caret out from
 * under someone typing.
 */
import { isExtensionPage, getExtensionId, rememberExtensionId, requestHostAccess } from './bridge.js';
import {
  getState, subscribe, start, refresh, mutate, select, watchedRows, decisionsFor, rulesFor, alertsOf,
} from './state.js';
import {
  el, connectionBanner, connectPanel, summaryBar, watchCard, addForm, emptyState, detailDrawer,
  watchlistHeading, disconnectedState, advisorNote, brandMark,
} from './render.js';
import {
  monitorControl, alertFeed, ruleSection, toaster, requestWebNotifications,
} from './alerts-ui.js';

const root = document.getElementById('app');
let showConnectPanel = false;

/**
 * Whether the first paint has happened.
 *
 * The whole view is rebuilt on every state change, so an entrance animation
 * left switched on would replay every time a background poll lands. The
 * stagger is therefore a one-shot: the class goes on for the first render and
 * comes off once it has played out.
 */
let painted = false;

// The toast stack lives outside the re-rendered tree: a toast that vanished
// because a background poll rebuilt the page would be a toast nobody read.
const toastLayer = document.createElement('div');
toastLayer.className = 'toasts';
document.body.appendChild(toastLayer);
const showToasts = toaster({ container: toastLayer, isExtensionPage });

/** Where focus was, as a selector we can find again after the rebuild. */
function captureFocus() {
  const active = document.activeElement;
  if (!active || active === document.body || !active.id) return null;
  const start = 'selectionStart' in active ? active.selectionStart : null;
  return { id: active.id, start };
}

function restoreFocus(saved) {
  if (!saved) return;
  const node = document.getElementById(saved.id);
  if (!node) return;
  node.focus();
  if (saved.start !== null && 'setSelectionRange' in node) {
    try {
      node.setSelectionRange(saved.start, saved.start);
    } catch {
      // Not every input type supports a selection range; focus alone is enough.
    }
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

const onAdd = (ticker, url) => mutate('ADD_WATCH', { ticker, source_url: url || null }, { ticker });
const onToggleMonitor = (ticker, monitor) => mutate('SET_WATCH_MONITOR', { ticker, monitor }, { ticker });
const onRefresh = (ticker) => mutate('REFRESH_TICKER', { ticker }, { ticker });

/**
 * Asks for one host, then refreshes that ticker if the answer was yes.
 *
 * `requestHostAccess` is called first and without an `await` in front of it,
 * because Chrome only honours a permission request inside the gesture that
 * started it — anything awaited beforehand spends the gesture and the prompt
 * never appears.
 */
function onGrant(ticker, origin) {
  requestHostAccess([origin])
    .then((granted) => (granted ? mutate('REFRESH_TICKER', { ticker }, { ticker }) : refresh()))
    .catch((error) => alert(String((error && error.message) || error)));
}

const onSaveRule = (payload) => mutate('SAVE_ALERT_RULE', payload, { ticker: payload.ticker });
const onDeleteRule = (rule) => mutate('DELETE_ALERT_RULE', { ticker: rule.ticker, id: rule.id }, { ticker: rule.ticker });
const onMarkSeen = () => mutate('MARK_ALERTS_SEEN', { ids: null });
const onClearAlerts = () => mutate('CLEAR_ALERTS', {});
const onInterval = (intervalMinutes) => mutate('SET_MONITOR', { intervalMinutes });

/**
 * Turning monitoring on is also the moment to ask about notifications, since
 * that is when they start being useful. Inside the extension the worker raises
 * them itself and no permission is needed.
 */
function onToggleMonitorAll(enabled) {
  if (enabled && !isExtensionPage) requestWebNotifications().catch(() => {});
  mutate('SET_MONITOR', { enabled });
}

async function onRefreshAll() {
  const state = getState();
  if (state.refreshing) return;
  state.refreshing = true;
  render(state);
  try {
    await mutate('REFRESH_ALL', {});
  } catch {
    // `mutate` has already recorded the message for the banner.
  } finally {
    state.refreshing = false;
    render(getState());
  }
}

function onRemove(ticker) {
  // Removing is reversible — the snapshot and the price history stay — so this
  // asks once rather than opening a modal.
  if (!confirm(`Stop watching ${ticker}?\n\nIts price history and any recorded decisions are kept.`)) return;
  mutate('REMOVE_WATCH', { ticker }, { ticker });
}

function onConnect(id) {
  if (!/^[a-p]{32}$/.test(id)) {
    alert('That does not look like a Chrome extension ID. It is 32 letters, a through p.');
    return;
  }
  rememberExtensionId(id);
  showConnectPanel = false;
  refresh();
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

/**
 * The line under the title.
 *
 * It has to agree with the banner beneath it: claiming a connection while the
 * banner reports the extension is unreachable is worse than saying nothing.
 */
function subtitleFor(state) {
  if (isExtensionPage) return 'Running inside the extension.';
  const id = getExtensionId();
  if (state.status === 'disconnected' || !id) return 'Not connected to an extension yet.';
  return `Connected to extension ${id}.`;
}

function render(state) {
  const saved = captureFocus();
  const rows = watchedRows();
  const connectable = !isExtensionPage;

  const banner = connectionBanner({
    status: state.status,
    error: state.error,
    canConnect: connectable,
    onConnect: () => { showConnectPanel = true; render(state); },
    onRetry: () => refresh(),
  });

  const children = [
    el('header.top',
      el('div.brand.top-title',
        brandMark(),
        el('div.brand-text',
          el('h1', { text: 'Market Dashboard' }),
          el('p.muted.small', { text: subtitleFor(state) }))),
      el('div.top-actions',
        state.data ? advisorNote(state.data) : null,
        state.data
          ? el('button.btn.primary.small', {
            type: 'button', id: 'refresh-all', disabled: state.refreshing,
            text: state.refreshing ? 'Refreshing…' : 'Refresh prices',
            title: 'Re-read every monitored ticker from its quote page',
            onClick: onRefreshAll,
          })
          : null,
        el('button.btn.small', { type: 'button', text: 'Reload', onClick: () => refresh() }))),
    banner,
    showConnectPanel && connectable
      ? connectPanel({
        extensionId: getExtensionId(),
        onSubmit: onConnect,
        onCancel: () => { showConnectPanel = false; render(state); },
      })
      : null,
  ];

  if (state.status === 'connecting' && !state.data) {
    children.push(el('div.empty', el('p.muted', { text: 'Reading your watchlist…' })));
  } else if (!state.data) {
    // Disconnected and with nothing cached: say what to do, rather than leaving
    // a banner floating over an empty page.
    children.push(disconnectedState({
      canConnect: connectable && !showConnectPanel,
      onConnect: () => { showConnectPanel = true; render(state); },
    }));
  } else {
    const alerts = alertsOf(state.data);
    // Only the unseen ones are worth interrupting for; the rest are history.
    showToasts(alerts.filter((alert) => !alert.seen).slice(0, 3).reverse());

    children.push(
      summaryBar({ rows, lastLoadedAt: state.lastLoadedAt }),
      monitorControl({
        settings: (state.data && state.data.settings) || {},
        onToggle: onToggleMonitorAll,
        onInterval,
      }),
      alertFeed({ alerts, onSelect: select, onMarkSeen, onClear: onClearAlerts }),
      addForm({ onAdd }),
      rows.length
        ? el('section.watchlist',
          watchlistHeading(rows.length),
          el('div.grid', rows.map((row) => watchCard(row, {
            busy: state.busy.has(row.ticker),
            onSelect: select,
            onRemove,
            onToggleMonitor,
            onRefresh,
            onGrant,
          }))))
        : emptyState()
    );

    const selected = rows.find((row) => row.ticker === state.selected);
    if (selected) {
      children.push(detailDrawer(selected, {
        decisions: decisionsFor(selected.ticker),
        onClose: () => select(null),
        rulesPanel: ruleSection(selected.ticker, rulesFor(selected.ticker), {
          onSave: onSaveRule,
          onDelete: onDeleteRule,
        }),
      }));
    }

    children.push(el('footer.foot',
      el('p.muted.small', {
        text: 'Recommendations only. This dashboard never places an order, and every action ends with you.',
      })));
  }

  root.replaceChildren(...children.filter(Boolean));
  restoreFocus(saved);

  if (!painted) {
    painted = true;
    root.classList.add('stagger');
    // Long enough for the last delayed pane to finish, short enough that a
    // poll landing afterwards does not re-run the sequence.
    setTimeout(() => root.classList.remove('stagger'), 900);
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && getState().selected) select(null);
});

/**
 * A notification click opens this page with `?ticker=`. Honoured once, then
 * dropped from the URL so a reload does not keep reopening the same drawer.
 */
function openRequestedTicker() {
  const wanted = new URLSearchParams(location.search).get('ticker');
  if (!wanted) return;
  select(wanted.toUpperCase());
  const url = new URL(location.href);
  url.searchParams.delete('ticker');
  history.replaceState(null, '', url);
}

subscribe(render);
render(getState());
start();
openRequestedTicker();
