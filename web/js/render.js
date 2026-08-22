/**
 * Every DOM node the dashboard puts on screen.
 *
 * One rule holds throughout, the same one the popup follows: scraped text is
 * never markup. Everything here goes in through `textContent`, and there is no
 * `innerHTML` assignment in this file or any other under `web/js/`. A headline
 * lifted off a quote page is attacker-influenced input, and the dashboard
 * renders it next to a price the user is about to act on.
 */
import { formatMoney, formatCompact, positionPnl } from '../vendor/lib/advisor.js';
import { sparkline, seriesOf, MIN_CHART_POINTS } from './sparkline.js';

/* ------------------------------------------------------------------ *
 * Element helpers
 * ------------------------------------------------------------------ */

/**
 * `el('div.card', 'text')` or `el('div', {class: 'card'}, child, child)`.
 *
 * Accepts a tag with optional dot-classes, an optional attribute object, and
 * any number of children. Strings become text nodes; null and false are
 * dropped so callers can inline a condition without a wrapper.
 */
export function el(spec, ...rest) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');

  let children = rest;
  const first = rest[0];
  if (first && typeof first === 'object' && !(first instanceof Node) && !Array.isArray(first)) {
    for (const [key, value] of Object.entries(first)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? '' : String(value));
    }
    children = rest.slice(1);
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Appends only the children that exist, so an absent section adds nothing. */
export function append(parent, ...children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/**
 * "4 min ago". Absolute timestamps are the wrong unit here — the only question
 * a dashboard answers about a price is how stale it is.
 */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'never';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** 'up' | 'down' | 'flat', the class hook the palette keys off. */
export const directionOf = (value) => {
  if (!Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
};

const signed = (value, suffix = '%') => `${value > 0 ? '+' : ''}${value.toFixed(2)}${suffix}`;

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

/**
 * The banner shown when the extension cannot be reached.
 *
 * This is the failure the website build fails with most often — extension
 * disabled, wrong id, or simply not installed — and a blank grid explains none
 * of it. `onConnect` is omitted on the in-extension route, where there is
 * nothing for the user to connect.
 */
export function connectionBanner({ status, error, canConnect, onConnect, onRetry }) {
  if (status === 'connected' && !error) return null;
  const disconnected = status === 'disconnected';

  return el('div.banner', { class: disconnected ? 'banner-warn' : 'banner-error', role: 'status' },
    el('div.banner-body',
      el('strong', { text: disconnected ? 'Extension not reachable' : 'Something went wrong' }),
      el('p', { text: error || 'The dashboard could not read anything from the extension.' })),
    el('div.banner-actions',
      canConnect && el('button.btn.ghost.small', { type: 'button', text: 'Connect extension', onClick: onConnect }),
      el('button.btn.ghost.small', { type: 'button', text: 'Retry', onClick: onRetry })));
}

/** Says the advisory is coming from the local rules engine, not a model. */
export function advisorNote(data) {
  if (!data || data.hasApiKey) return null;
  return el('span.chip.chip-warn', {
    title: 'No API key is configured, so advisories come from the local rules engine.',
    text: 'rules-only advisor',
  });
}

/** The panel that takes an extension id, for the website build. */
export function connectPanel({ extensionId, onSubmit, onCancel }) {
  const input = el('input', {
    type: 'text', id: 'ext-id', class: 'mono wide', spellcheck: 'false',
    placeholder: 'abcdefghijklmnopabcdefghijklmnop', value: extensionId || '',
  });

  return el('form.card.connect', {
    onSubmit: (event) => { event.preventDefault(); onSubmit(input.value.trim()); },
  },
  el('h2', { text: 'Connect the extension' }),
  el('p.muted.small', { text: 'Open chrome://extensions, switch on Developer mode, and copy the extension’s ID. The dashboard remembers it after this.' }),
  el('label.label', { for: 'ext-id', text: 'Extension ID' }),
  input,
  el('p.muted.small', { text: 'Shortcut: the extension’s options page has an "Open dashboard" button that fills this in for you.' }),
  el('div.row',
    el('button.btn.primary.small', { type: 'submit', text: 'Connect' }),
    onCancel && el('button.btn.ghost.small', { type: 'button', text: 'Cancel', onClick: onCancel })));
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

export function summaryBar({ rows, lastLoadedAt }) {
  const priced = rows.filter((row) => row.snapshot && Number.isFinite(row.snapshot.current_price));
  const movers = priced.filter((row) => Number.isFinite(row.snapshot.change_value));
  const up = movers.filter((row) => row.snapshot.change_value > 0).length;
  const down = movers.filter((row) => row.snapshot.change_value < 0).length;

  // Only positions with both a cost and a share count contribute; a target-only
  // entry is being watched, not held, and folding it in at zero would understate
  // the book rather than leave it out.
  let held = 0;
  let pnl = 0;
  let pnlKnown = false;
  for (const row of rows) {
    const result = row.snapshot && row.position ? positionPnl(row.snapshot, row.position) : null;
    if (!result || !Number.isFinite(result.total)) continue;
    held += 1;
    pnl += result.total;
    pnlKnown = true;
  }

  return el('div.summary',
    stat('Watching', String(rows.length)),
    stat('Priced', `${priced.length}`),
    stat('Up / down', `${up} / ${down}`, up === down ? 'flat' : (up > down ? 'up' : 'down')),
    held ? stat('Open P/L', formatMoney(pnl, currencyOf(rows)), directionOf(pnlKnown ? pnl : null)) : null,
    stat('Updated', relativeTime(lastLoadedAt)));
}

function stat(label, value, tone = null) {
  const node = el('div.stat', el('span.stat-label', { text: label }), el('span.stat-value', { text: value }));
  if (tone) node.dataset.tone = tone;
  return node;
}

/** The currency the book is quoted in, taken from what was actually scraped. */
function currencyOf(rows) {
  for (const row of rows) {
    if (row.snapshot && row.snapshot.currency) return row.snapshot.currency;
  }
  return 'USD';
}

/* ------------------------------------------------------------------ *
 * Watchlist
 * ------------------------------------------------------------------ */

export function watchCard(row, { busy, onSelect, onRemove, onToggleMonitor, onRefresh, onGrant }) {
  const { ticker, entry, snapshot, position, history } = row;
  const price = snapshot && Number.isFinite(snapshot.current_price) ? snapshot.current_price : null;
  const change = snapshot && Number.isFinite(snapshot.change_value) ? snapshot.change_value : null;
  const direction = directionOf(change);

  const card = el('article.card.watch-card', {
    dataset: { ticker, direction },
    tabindex: '0',
    role: 'button',
    'aria-label': `${ticker} details`,
    onClick: (event) => {
      // The card is the target, but the controls inside it are not.
      if (event.target.closest('button, input, label, a')) return;
      onSelect(ticker);
    },
    onKeydown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target !== card) return;
      event.preventDefault();
      onSelect(ticker);
    },
  });
  if (busy) card.dataset.busy = 'true';

  // Native `append` stringifies null into a literal "null" text node, so the
  // optional children are filtered rather than passed straight through. `el`
  // already does this for its own children; this call does not go through it.
  append(card,
    el('header.watch-head',
      el('div.watch-id',
        el('span.watch-ticker', { text: ticker }),
        position && Number.isFinite(position.shares) && position.shares > 0
          ? el('span.chip', { text: `${formatCompact(position.shares)} sh` })
          : null),
      el('div.watch-move',
        el('span.watch-price', { text: price === null ? '—' : formatMoney(price, snapshot.currency) }),
        change === null
          ? el('span.watch-change.flat', { text: 'no change data' })
          : el('span.watch-change', { class: direction, text: snapshot.change_percentage || signed(change) }))),
    chartOrPlaceholder(history, direction),
    targetBar(price, position),
    entry && entry.needs_permission ? grantPrompt(entry, onGrant) : null,
    el('footer.watch-foot',
      el('span.muted.small', { text: statusLine(entry, snapshot) }),
      el('div.watch-actions',
        monitorToggle(ticker, entry, onToggleMonitor),
        el('button.icon-btn.plain-icon', {
          type: 'button', title: `Refresh ${ticker} now`, 'aria-label': `Refresh ${ticker} now`,
          text: '\u21bb', onClick: () => onRefresh(ticker),
        }),
        el('button.icon-btn.plain-icon.remove', {
          type: 'button', title: `Remove ${ticker}`, 'aria-label': `Remove ${ticker} from the watchlist`,
          text: '\u00d7', onClick: () => onRemove(ticker),
        }))));
  return card;
}

/**
 * The price series, drawn if there is enough of it and described either way.
 *
 * The range line is not decoration. The chart carries its trend in colour and
 * shape alone, so the same fact is stated in text underneath — that is what a
 * screen reader reads, and what survives a monochrome display or a reader who
 * cannot separate the two hues.
 */
/**
 * Offers to grant access to the host this ticker lives on.
 *
 * Site access is asked for one origin at a time, at the moment it is actually
 * needed, rather than as a wall of permissions at install. The button has to be
 * a real click: `chrome.permissions.request()` will not run without one.
 */
function grantPrompt(entry, onGrant) {
  const origin = entry.needs_permission;
  const host = origin.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
  return el('div.grant',
    el('span.small', { text: `Needs access to ${host} to refresh on its own.` }),
    el('button.btn.small', {
      type: 'button', text: 'Grant', onClick: () => onGrant(entry.ticker, origin),
    }));
}

function chartOrPlaceholder(history, direction) {
  const prices = seriesOf(history);
  const chart = sparkline(history, { direction });

  if (!chart) {
    const need = MIN_CHART_POINTS - prices.length;
    return el('div.watch-chart.watch-chart-empty',
      el('span.muted.small', {
        text: prices.length
          ? `${prices.length} scan${prices.length === 1 ? '' : 's'} so far · ${need} more to chart`
          : 'no history yet',
      }));
  }

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return el('div.watch-chart', chart,
    el('span.watch-range.small', { text: `${prices.length} scans · ${low} to ${high}` }));
}

/**
 * Where today's price sits between the buy and sell targets.
 *
 * Rendered only when both ends exist: a bar with one end open would put the
 * marker at a position that means nothing.
 */
function targetBar(price, position) {
  const buy = position && Number.isFinite(position.target_buy_below) ? position.target_buy_below : null;
  const sell = position && Number.isFinite(position.target_sell_above) ? position.target_sell_above : null;
  if (price === null || buy === null || sell === null || !(sell > buy)) return null;

  const ratio = Math.min(1, Math.max(0, (price - buy) / (sell - buy)));
  const zone = price <= buy ? 'buy' : (price >= sell ? 'sell' : 'hold');

  const marker = el('span.target-marker');
  marker.style.left = `${(ratio * 100).toFixed(2)}%`;

  return el('div.target', { dataset: { zone } },
    el('div.target-track', marker),
    el('div.target-legend',
      el('span', { text: `buy ${buy}` }),
      el('span.target-zone', { text: zone.toUpperCase() }),
      el('span', { text: `sell ${sell}` })));
}

function monitorToggle(ticker, entry, onToggleMonitor) {
  const input = el('input', {
    type: 'checkbox', id: `monitor-${ticker}`,
    onChange: (event) => onToggleMonitor(ticker, event.target.checked),
  });
  input.checked = Boolean(entry && entry.monitor);
  return el('label.monitor', { for: `monitor-${ticker}`, title: 'Keep this ticker refreshed in the background' },
    input, el('span.small.muted', { text: 'monitor' }));
}

function statusLine(entry, snapshot) {
  if (entry && entry.last_error) return `failed: ${entry.last_error}`;
  // Only a snapshot proves a scan produced something. A watchlist entry can
  // carry a refresh timestamp from an attempt that read nothing, and reporting
  // that as "updated" would date a price the card is not showing.
  if (!snapshot) return 'not scanned yet';
  const at = snapshot.extracted_at || (entry && entry.last_refreshed_at);
  if (!at) return 'not scanned yet';
  const how = entry && entry.last_method === 'fetch' ? ' · headless' : '';
  return `updated ${relativeTime(at)}${how}`;
}

/* ------------------------------------------------------------------ *
 * Add a ticker
 * ------------------------------------------------------------------ */

export function addForm({ onAdd }) {
  const ticker = el('input', {
    type: 'text', id: 'add-ticker', class: 'mono', placeholder: 'AAPL',
    maxlength: '12', spellcheck: 'false', required: true, 'aria-label': 'Ticker symbol',
  });
  const url = el('input', {
    type: 'url', id: 'add-url', class: 'wide', placeholder: 'https://… quote page (optional)',
    spellcheck: 'false', 'aria-label': 'Quote page URL',
  });

  return el('form.add-form', {
    onSubmit: (event) => {
      event.preventDefault();
      const symbol = ticker.value.trim().toUpperCase();
      if (!symbol) return;
      onAdd(symbol, url.value.trim());
      ticker.value = '';
      url.value = '';
    },
  },
  ticker, url,
  el('button.btn.primary.small', { type: 'submit', text: 'Watch' }));
}

/** Names the grid region for anyone navigating by heading. */
export function watchlistHeading(count) {
  return el('h2.label', { text: `Watchlist · ${count} ${count === 1 ? 'ticker' : 'tickers'}` });
}

/**
 * What a website build shows before it can reach an extension.
 *
 * The banner says what is wrong; this says what to do about it. Without it the
 * page is a warning over a void, which reads like the app is broken rather than
 * like a step is missing.
 */
export function disconnectedState({ canConnect, onConnect }) {
  return el('div.empty',
    el('h2', { text: 'No extension connected' }),
    el('p.muted', { text: 'This page is only a view. The watchlist, the scraping and your API key all live in the extension, and nothing is stored here.' }),
    el('p.muted', { text: 'Install the extension, then open its options page and press "Open dashboard" — it opens this page with the right ID already attached.' }),
    canConnect ? el('div.row.center', el('button.btn.primary.small', { type: 'button', text: 'Enter the ID manually', onClick: onConnect })) : null);
}

export function emptyState() {
  return el('div.empty',
    el('h2', { text: 'Nothing on the watchlist yet' }),
    el('p.muted', { text: 'Open a stock quote page, click the extension’s toolbar icon, and press Scan this tab. Whatever you scan lands here.' }),
    el('p.muted', { text: 'Or add a ticker above and the dashboard will look it up on stockanalysis.com.' }));
}

/* ------------------------------------------------------------------ *
 * Detail drawer
 * ------------------------------------------------------------------ */

export function detailDrawer(row, { decisions, onClose, rulesPanel = null }) {
  const { ticker, entry, snapshot, position, history } = row;

  const panel = el('div.drawer-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${ticker} detail` },
    el('header.drawer-head',
      el('h2', { text: ticker }),
      el('button.icon-btn.plain-icon', { type: 'button', text: '×', 'aria-label': 'Close', onClick: onClose })),
    snapshot ? quoteFacts(snapshot, position) : el('p.muted', { text: 'This ticker has not been scanned yet.' }),
    entry && entry.source_url ? sourceLink(entry.source_url) : null,
    rulesPanel,
    headlines(snapshot),
    selectorList(snapshot),
    historyList(history),
    decisionList(decisions));

  return el('div.drawer', {
    onClick: (event) => { if (event.target.classList.contains('drawer')) onClose(); },
  }, panel);
}

function quoteFacts(snapshot, position) {
  const pnl = position ? positionPnl(snapshot, position) : null;
  const rows = [
    ['Price', formatMoney(snapshot.current_price, snapshot.currency)],
    ['Change', snapshot.change_percentage || '—'],
    ['Volume', Number.isFinite(snapshot.volume) ? formatCompact(snapshot.volume) : '—'],
    ['Scraped', relativeTime(snapshot.extracted_at)],
  ];
  if (pnl) {
    rows.push(['Shares', formatCompact(pnl.shares)]);
    rows.push(['Avg cost', formatMoney(pnl.avg_cost, snapshot.currency)]);
    rows.push(['Open P/L', `${formatMoney(pnl.total, snapshot.currency)} (${signed(pnl.percent)})`]);
  }
  if (position && Number.isFinite(position.target_buy_below)) rows.push(['Buy below', String(position.target_buy_below)]);
  if (position && Number.isFinite(position.target_sell_above)) rows.push(['Sell above', String(position.target_sell_above)]);

  return el('dl.facts', rows.flatMap(([label, value]) => [
    el('dt', { text: label }),
    el('dd', { text: value }),
  ]));
}

function sourceLink(url) {
  return el('p.small',
    el('a', {
      href: url, target: '_blank', rel: 'noreferrer noopener', class: 'link', text: 'Open the source page',
    }));
}

function headlines(snapshot) {
  const items = (snapshot && Array.isArray(snapshot.news) ? snapshot.news : []).filter(Boolean);
  if (!items.length) return null;
  return el('section.drawer-section',
    el('h3', { text: 'Headlines' }),
    el('ul.plain', items.map((item) => el('li', { text: item }))));
}

function selectorList(snapshot) {
  const used = (snapshot && snapshot.selectors_used) || {};
  const entries = Object.entries(used);
  if (!entries.length) return null;
  return el('section.drawer-section',
    el('h3', { text: 'Selectors used' }),
    el('ul.plain.mono.small', entries.map(([field, selector]) =>
      el('li', { text: `${field.replace(/_selector$/, '')}: ${selector}` }))));
}

function historyList(history) {
  if (!history.length) return null;
  return el('section.drawer-section',
    el('h3', { text: `Price history (${history.length})` }),
    el('ul.plain.small.scroll', history.slice(0, 20).map((point) =>
      el('li',
        el('span.mono', { text: String(point.price) }),
        el('span.muted', { text: ` · ${relativeTime(point.at)}` })))));
}

function decisionList(decisions) {
  if (!decisions.length) return null;
  return el('section.drawer-section',
    el('h3', { text: 'Your decisions' }),
    el('ul.plain.small', decisions.slice(0, 10).map((entry) =>
      el('li',
        el('span.verdict', { dataset: { verdict: entry.verdict }, text: entry.verdict }),
        el('span', { text: ` ${entry.final_action} at ${entry.price === null || entry.price === undefined ? '—' : entry.price}` }),
        el('span.muted', { text: ` · ${relativeTime(entry.decided_at)}` })))));
}
