/**
 * Options page: API key, model, self-healing toggles, portfolio targets, and
 * the healed-selector registry.
 *
 * Reads and writes `chrome.storage.local` directly — no service-worker round
 * trip needed — except for the registry reset, which goes through the worker
 * so the reset is logged in one place.
 */
import { MSG, DASHBOARD_PATH, WELCOME_PATH, BRIGHTDATA_MODES } from './lib/constants.js';
import { normalizeBridgeUrl, bridgeOriginPattern, DEFAULT_BRIDGE_URL } from './lib/brightdata.js';
import {
  getSettings, saveSettings, getPortfolio, savePosition, getRegistry, getHealLog, getWatchlist,
} from './lib/storage.js';
import { PROVIDERS, providerFor } from './lib/providers.js';
import { listModels } from './lib/llm.js';

const el = (id) => document.getElementById(id);

function setStatus(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('error', Boolean(isError));
  if (!isError) setTimeout(() => { if (node.textContent === text) node.textContent = ''; }, 4000);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return value === '' || !Number.isFinite(parsed) ? null : parsed;
}

/**
 * The provider fields are edited in memory and only written on save, so
 * switching the dropdown to compare two providers does not persist anything.
 */
let draft = null;

/**
 * Nothing on this card takes effect until Save is pressed, which is easy to
 * forget when a field looks like it committed itself. The marker says out loud
 * that there is something outstanding.
 */
let dirty = false;

function setDirty(value) {
  dirty = value;
  el('settings-dirty').classList.toggle('hidden', !value);
}

/**
 * One line describing what the agent will actually do, kept in the rail so the
 * answer to "is this thing switched on?" never needs scrolling.
 */
function renderAgentState() {
  const provider = providerFor(el('provider').value);
  const hasKey = Boolean(el('api-key').value.trim());
  const node = el('agent-state');
  node.replaceChildren();

  // A status dot, what is answering, and whether it can. The long version -
  // which repairs and advisories this does and does not buy you - is the
  // tooltip: it is context, not the headline.
  const dot = document.createElement('span');
  dot.className = `dot ${hasKey ? 'on' : 'off'}`;

  const which = document.createElement('span');
  which.className = 'agent-model';
  which.textContent = `${provider.label} · ${el('model').value.trim() || provider.defaultModel}`;

  const state = document.createElement('span');
  state.className = hasKey ? 'on' : 'off';
  state.textContent = hasKey ? 'Key set' : 'No key';

  node.title = hasKey
    ? 'Key set — selector repairs and model advisories are available.'
    : 'No key — running on the built-in rules only.';
  node.append(dot, which, state);
}

/**
 * The key field is a password input, so a truncated paste is invisible — and a
 * truncated key fails with the same "invalid API key" a wrong one does. The
 * length is the one safe thing to show: enough to spot a bad paste, useless to
 * anyone reading over a shoulder.
 */
function renderKeyLength() {
  const value = el('api-key').value.trim();
  el('key-length').textContent = value ? `(${value.length} characters)` : '(not set)';
}

function renderProviderFields(id) {
  const provider = providerFor(id);
  const values = draft.providers[provider.id] || {};
  el('key-label').textContent = `${provider.label} API key`;
  el('key-host').textContent = provider.host;
  el('key-link').href = `https://${provider.keyOrigin}`;
  el('key-link').textContent = provider.keyOrigin;
  el('api-key').placeholder = provider.keyPlaceholder;
  el('api-key').value = values.apiKey || '';
  el('model').value = values.model || provider.defaultModel;
  el('model').placeholder = provider.defaultModel;
  renderKeyLength();
  el('load-models').classList.toggle('hidden', !provider.modelsUrl);

  const list = el('model-list');
  list.replaceChildren();
  for (const model of provider.models) {
    const option = document.createElement('option');
    option.value = model;
    list.appendChild(option);
  }
  el('model-status').textContent = '';
  renderAgentState();
}

/** Copies whatever is on screen back into the draft for the given provider. */
function captureProviderFields(id) {
  draft.providers[id] = {
    ...(draft.providers[id] || {}),
    apiKey: el('api-key').value.trim(),
    model: el('model').value.trim() || providerFor(id).defaultModel,
  };
}

async function renderSettings() {
  draft = await getSettings();

  const select = el('provider');
  select.replaceChildren();
  for (const provider of Object.values(PROVIDERS)) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    select.appendChild(option);
  }
  select.value = providerFor(draft.provider).id;

  renderProviderFields(select.value);
  el('self-heal').checked = draft.selfHealEnabled;
  el('llm-advice').checked = draft.llmAdviceEnabled;
  el('snippet-chars').value = draft.maxSnippetChars;
  el('dashboard-origin').value = draft.dashboardOrigin || '';
  setDirty(false);
  renderAgentState();
}

async function renderPortfolio() {
  const portfolio = await getPortfolio();
  const body = el('portfolio-body');
  body.replaceChildren();
  const entries = Object.entries(portfolio).sort(([a], [b]) => a.localeCompare(b));
  for (const [ticker, position] of entries) {
    const row = document.createElement('tr');
    const cells = [
      ticker,
      position.shares ?? '—',
      position.avg_cost ?? '—',
      position.target_buy_below ?? '—',
      position.target_sell_above ?? '—',
      position.auto_targets ? 'auto' : 'manual',
    ];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.appendChild(cell);
    }
    const actionCell = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await savePosition(ticker, null);
      await renderPortfolio();
    });
    actionCell.appendChild(remove);
    row.appendChild(actionCell);
    body.appendChild(row);
  }
  if (!entries.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.textContent = 'No positions yet.';
    row.appendChild(cell);
    body.appendChild(row);
  }
}

/**
 * One record in the registry or the repair log.
 *
 * Both were single monospace lines holding four facts each, which reads as a
 * log file rather than as something you are meant to act on. They are records,
 * so they are set as records: what changed in reading weight, the detail
 * beneath it, the outcome as a chip on the right.
 */
function entryRow({ title, field, detail, when, status }) {
  const item = document.createElement('li');
  item.className = 'entry';

  const main = document.createElement('div');
  main.className = 'entry-main';

  const heading = document.createElement('span');
  heading.className = 'entry-title';
  heading.textContent = `${title} · `;
  const fieldName = document.createElement('span');
  fieldName.className = 'field-name';
  fieldName.textContent = field;
  heading.appendChild(fieldName);
  main.appendChild(heading);

  if (detail) {
    const line = document.createElement('span');
    line.className = 'entry-detail';
    line.textContent = detail;
    main.appendChild(line);
  }

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  if (when) {
    const stamp = document.createElement('span');
    stamp.textContent = when;
    meta.appendChild(stamp);
  }
  if (status) {
    const pill = document.createElement('span');
    pill.className = `pill ${status.tone}`;
    pill.textContent = status.text;
    meta.appendChild(pill);
  }

  item.append(main, meta);
  return item;
}

/** Replaces a list's contents with a centred "nothing here yet" note. */
function renderEmpty(list, text) {
  const item = document.createElement('li');
  item.className = 'empty-note';
  item.textContent = text;
  list.replaceChildren(item);
}

/** A timestamp short enough to sit at the end of a row. */
function shortTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function renderRegistry() {
  const registry = await getRegistry();
  const list = el('registry-list');
  const rows = [];
  for (const [host, fields] of Object.entries(registry)) {
    for (const [field, entry] of Object.entries(fields)) {
      rows.push(entryRow({
        title: host,
        field,
        detail: entry.selector,
        when: shortTime(entry.healed_at),
        status: { tone: 'ok', text: entry.strategy || 'css' },
      }));
    }
  }
  if (!rows.length) {
    renderEmpty(list, 'No healed selectors yet — the shipped defaults are handling every page so far.');
    return;
  }
  list.replaceChildren(...rows);
}

async function renderHealLog() {
  const log = await getHealLog();
  const list = el('heal-log');
  const entries = log.slice(0, 25);
  if (!entries.length) {
    renderEmpty(list, 'No repair attempts recorded.');
    return;
  }
  list.replaceChildren(...entries.map((entry) => entryRow({
    title: entry.host,
    field: entry.field,
    // A failure explains itself; a success shows the selector it adopted.
    detail: entry.healed ? entry.proposed : (entry.error || entry.reason || ''),
    when: shortTime(entry.at),
    status: entry.healed
      ? { tone: 'ok', text: `healed ${Math.round((entry.confidence || 0) * 100)}%` }
      : { tone: 'bad', text: 'failed' },
  })));
}

let shownProvider = null;
el('provider').addEventListener('change', () => {
  if (shownProvider) captureProviderFields(shownProvider);
  shownProvider = el('provider').value;
  renderProviderFields(shownProvider);
});

el('load-models').addEventListener('click', async () => {
  const id = el('provider').value;
  const apiKey = el('api-key').value.trim();
  if (!apiKey) {
    setStatus(el('model-status'), 'Enter the API key first, then load the list.', true);
    return;
  }
  setStatus(el('model-status'), 'Loading…');
  try {
    const models = await listModels({ provider: id, apiKey });
    if (!models || !models.length) {
      setStatus(el('model-status'), 'The provider returned no models.', true);
      return;
    }
    const list = el('model-list');
    list.replaceChildren();
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model;
      list.appendChild(option);
    }
    setStatus(el('model-status'), `${models.length} models available — pick one from the field above.`);
  } catch (error) {
    setStatus(el('model-status'), String((error && error.message) || error), true);
  }
});

el('api-key').addEventListener('input', renderKeyLength);

// Anything the user touches on the Agent card counts as an unsaved edit. The
// provider dropdown is excluded: switching it only swaps which stored key is on
// screen, and both survive whether or not Save is pressed.
for (const id of ['api-key', 'model', 'self-heal', 'llm-advice', 'snippet-chars']) {
  el(id).addEventListener('input', () => { setDirty(true); renderAgentState(); });
  el(id).addEventListener('change', () => { setDirty(true); renderAgentState(); });
}

// Enter in a text field means "save" everywhere else; it should here too.
for (const id of ['api-key', 'model', 'snippet-chars']) {
  el(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') el('save-settings').click();
  });
}

for (const id of ['pos-ticker', 'pos-shares', 'pos-cost', 'pos-buy', 'pos-sell']) {
  el(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') el('save-position').click();
  });
}

el('test-provider').addEventListener('click', async () => {
  const id = el('provider').value;
  const apiKey = el('api-key').value.trim();
  if (!apiKey) {
    setStatus(el('model-status'), 'Enter the API key first.', true);
    return;
  }
  setStatus(el('model-status'), 'Testing…');
  // Goes through the service worker on purpose: that is where real calls are
  // made, so this proves the path the extension actually uses.
  const response = await chrome.runtime.sendMessage({
    type: MSG.TEST_PROVIDER,
    payload: { provider: id, apiKey, model: el('model').value.trim() },
  });
  if (response && response.ok) {
    const { label, model, ms, note } = response.data;
    setStatus(el('model-status'), `${label} answered as ${model} in ${ms} ms${note ? ` — “${note}”` : ''}.`);
  } else {
    setStatus(el('model-status'), (response && response.error) || 'The provider could not be reached.', true);
  }
});

el('save-settings').addEventListener('click', async () => {
  const chars = Number(el('snippet-chars').value);
  const id = el('provider').value;
  captureProviderFields(id);
  await saveSettings({
    provider: id,
    providers: draft.providers,
    selfHealEnabled: el('self-heal').checked,
    llmAdviceEnabled: el('llm-advice').checked,
    maxSnippetChars: Number.isFinite(chars) ? Math.min(40000, Math.max(1000, chars)) : 12000,
  });
  await renderSettings();
  await renderChecklist();
  shownProvider = el('provider').value;
  setDirty(false);
  setStatus(el('settings-status'), 'Settings saved.');
});

/** Fills the two target boxes from the worker's suggestion. Saves nothing. */
el('suggest-targets').addEventListener('click', async () => {
  const ticker = el('pos-ticker').value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    setStatus(el('position-status'), 'Enter a ticker first, then ask for a suggestion.', true);
    return;
  }
  setStatus(el('position-status'), 'Working it out…');
  const response = await chrome.runtime.sendMessage({ type: MSG.SUGGEST_TARGETS, payload: { ticker } });
  if (!response || !response.ok) {
    setStatus(el('position-status'), (response && response.error) || 'Could not suggest targets.', true);
    return;
  }
  const suggestion = response.data;
  el('pos-buy').value = suggestion.target_buy_below;
  el('pos-sell').value = suggestion.target_sell_above;
  setStatus(el('position-status'), `${suggestion.note} Press Save position to keep them.`);
});

el('save-position').addEventListener('click', async () => {
  const ticker = el('pos-ticker').value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    setStatus(el('position-status'), 'Enter a valid ticker symbol first.', true);
    return;
  }
  await savePosition(ticker, {
    shares: numberOrNull(el('pos-shares').value) ?? 0,
    avg_cost: numberOrNull(el('pos-cost').value),
    target_buy_below: numberOrNull(el('pos-buy').value),
    target_sell_above: numberOrNull(el('pos-sell').value),
    auto_targets: el('pos-auto').checked,
  });
  for (const id of ['pos-ticker', 'pos-shares', 'pos-cost', 'pos-buy', 'pos-sell']) el(id).value = '';
  el('pos-auto').checked = false;
  await renderPortfolio();
  await renderChecklist();
  setStatus(el('position-status'), `Saved ${ticker}.`);
});

/* ------------------------------------------------------------------ *
 * Getting started
 *
 * The panel the page opens on. It reports rather than asks: every row is a
 * fact read back out of storage, so what is on screen is what is configured
 * and not what some earlier screen intended to configure.
 * ------------------------------------------------------------------ */

/** One checklist row: a state mark, what it is, and the reading on the right. */
function checkRow({ done, title, detail, value }) {
  const item = document.createElement('li');
  item.dataset.done = done ? 'true' : 'false';

  const state = document.createElement('span');
  state.className = 'check-state';

  const text = document.createElement('div');
  text.className = 'check-text';
  const heading = document.createElement('b');
  heading.textContent = title;
  const sub = document.createElement('span');
  sub.textContent = detail;
  text.append(heading, sub);

  const reading = document.createElement('span');
  reading.className = 'check-value';
  reading.textContent = value;

  item.append(state, text, reading);
  return item;
}

async function renderChecklist() {
  const stored = await getSettings();
  const provider = providerFor(stored.provider);
  const key = (stored.providers[provider.id] || {}).apiKey || '';
  const watched = Object.keys(await getWatchlist());
  const positions = Object.keys(await getPortfolio());

  el('checklist').replaceChildren(
    checkRow({
      done: Boolean(key),
      title: key ? 'A model is connected' : 'Running on the local rules',
      detail: key
        ? 'Selector repair and written rationales are available.'
        : 'Verdicts come from your targets and price history. Nothing is sent anywhere.',
      value: key ? provider.label : 'no key',
    }),
    checkRow({
      done: watched.length > 0,
      title: watched.length ? 'Watchlist started' : 'Nothing watched yet',
      detail: watched.length
        ? 'These appear on the dashboard and can be refreshed on a timer.'
        : 'Scan any quote page from the toolbar and it lands on the watchlist by itself.',
      value: watched.length ? `${watched.length} ticker${watched.length === 1 ? '' : 's'}` : '—',
    }),
    checkRow({
      done: positions.length > 0,
      title: positions.length ? 'Targets set' : 'No targets yet',
      detail: positions.length
        ? 'A buy and a sell level are what turn a quote into a signal.'
        : 'Without targets every verdict falls back to the price trend alone.',
      value: positions.length ? `${positions.length} position${positions.length === 1 ? '' : 's'}` : '—',
    }),
    checkRow({
      done: Boolean(stored.monitorEnabled),
      title: stored.monitorEnabled ? 'Background checks on' : 'Background checks off',
      detail: stored.monitorEnabled
        ? 'Watched tickers are re-read on a timer and alerts are raised for you.'
        : 'Nothing is fetched unless you ask. Switch it on from the dashboard.',
      value: stored.monitorEnabled ? `every ${stored.monitorIntervalMinutes} min` : 'off',
    })
  );
}

el('open-guide').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PATH) });
});

/* ------------------------------------------------------------------ *
 * Site access
 * ------------------------------------------------------------------ */

/** The `https://host/*` pattern one quote-page URL needs permission for. */
export function originPatternFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

/** Every distinct origin the watchlist would need to refresh itself. */
export function originsInWatchlist(watchlist) {
  const origins = new Map();
  for (const entry of Object.values(watchlist || {})) {
    const origin = originPatternFor(entry && entry.source_url);
    if (!origin) continue;
    if (!origins.has(origin)) origins.set(origin, []);
    origins.get(origin).push(entry.ticker);
  }
  return origins;
}

async function renderAccess() {
  const list = el('access-list');
  const origins = originsInWatchlist(await getWatchlist());
  list.replaceChildren();

  if (!origins.size) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Nothing on the watchlist yet, so there is nothing to grant.';
    list.appendChild(empty);
    return;
  }

  for (const [origin, tickers] of origins) {
    const granted = await chrome.permissions.contains({ origins: [origin] });
    const row = document.createElement('div');
    row.className = 'row-item';

    const label = document.createElement('div');
    const host = document.createElement('strong');
    host.textContent = origin.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
    const who = document.createElement('span');
    who.className = 'hint';
    who.textContent = ` ${tickers.sort().join(', ')}`;
    label.append(host, who);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = granted ? 'btn small' : 'btn primary small';
    button.textContent = granted ? 'Revoke' : 'Grant';
    // Called straight from the click: Chrome only honours a permission request
    // inside the gesture that started it.
    button.addEventListener('click', async () => {
      try {
        const changed = granted
          ? await chrome.permissions.remove({ origins: [origin] })
          : await chrome.permissions.request({ origins: [origin] });
        setStatus(el('access-status'), changed
          ? `${granted ? 'Revoked' : 'Granted'} access to ${host.textContent}.`
          : 'Nothing changed.');
      } catch (error) {
        setStatus(el('access-status'), String((error && error.message) || error), true);
      }
      await renderAccess();
    });

    row.append(label, button);
    list.appendChild(row);
  }
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

/**
 * Builds the URL the "Open dashboard" button goes to.
 *
 * With no origin configured this is the copy inside the extension, which needs
 * nothing running. With one configured it is that origin, carrying `?ext=` so
 * nobody has to copy an extension ID out of chrome://extensions by hand — the
 * page remembers it after the first visit.
 *
 * Exported for the tests; the origin is user-typed, so it is parsed rather
 * than concatenated.
 */
export function dashboardUrl(origin, extensionId) {
  const trimmed = String(origin || '').trim();
  if (!trimmed) return chrome.runtime.getURL(DASHBOARD_PATH);
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('That is not a URL. Try http://localhost:8080.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The dashboard address must be an http(s) URL.');
  }
  if (extensionId) parsed.searchParams.set('ext', extensionId);
  return parsed.href;
}

el('open-dashboard').addEventListener('click', async () => {
  const origin = el('dashboard-origin').value.trim();
  let url;
  try {
    url = dashboardUrl(origin, chrome.runtime.id);
  } catch (error) {
    setStatus(el('dashboard-status'), String(error.message), true);
    return;
  }
  // Remembered so the next visit does not need it typed again.
  await saveSettings({ dashboardOrigin: origin });
  await chrome.tabs.create({ url });
});

el('reset-registry').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MSG.RESET_SELECTORS });
  await renderRegistry();
});

/**
 * Switches panels from the sidebar.
 *
 * Replaces the scroll-spy this page used to have. Six sections stacked on one
 * page meant the rail only ever reported where you already were; now it is the
 * thing that moves you, and only one section is on screen at a time.
 *
 * The hash is kept in step so a panel can be linked to and survives a reload,
 * and `history.replaceState` is used rather than assigning `location.hash` so
 * clicking through the rail does not fill the back button with settings panels.
 */
/* ------------------------------------------------------------------ *
 * Bright Data
 *
 * The extension cannot dial the Scraping Browser itself — the endpoint carries
 * credentials in the URL, which `new WebSocket()` is required to refuse — so
 * everything here configures the local agent that can, and the loopback address
 * this extension reaches it on. The credentials themselves never come near this
 * page: they live in the agent's `.env`.
 * ------------------------------------------------------------------ */

let brightdataDirty = false;

function setBrightdataDirty(value) {
  brightdataDirty = value;
  el('bd-dirty').classList.toggle('hidden', !value);
}

function readBrightdataForm() {
  const mode = el('bd-mode').value;
  return {
    enabled: el('bd-enabled').checked,
    bridgeUrl: el('bd-url').value.trim(),
    token: el('bd-token').value,
    mode: BRIGHTDATA_MODES.includes(mode) ? mode : 'fallback',
  };
}

async function renderBrightdata() {
  const settings = await getSettings();
  const stored = settings.brightdata || {};
  el('bd-enabled').checked = stored.enabled === true;
  el('bd-url').value = stored.bridgeUrl || DEFAULT_BRIDGE_URL;
  el('bd-token').value = stored.token || '';
  el('bd-mode').value = BRIGHTDATA_MODES.includes(stored.mode) ? stored.mode : 'fallback';
  setBrightdataDirty(false);
  // Says what the panel is waiting for, rather than leaving a blank space where
  // the agent's report will eventually be.
  renderBrightdataReport(null);
  await renderBrightdataAccess();
}

/** One row saying whether the worker may talk to the address in the box. */
async function renderBrightdataAccess() {
  const pattern = bridgeOriginPattern(el('bd-url').value.trim());
  const button = el('bd-grant');
  if (!pattern) {
    button.disabled = true;
    button.textContent = 'Grant access';
    return null;
  }
  button.disabled = false;
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    granted = false;
  }
  button.textContent = granted ? 'Revoke access' : 'Grant access';
  button.className = granted ? 'btn small' : 'btn primary small';
  return { pattern, granted };
}

/** Renders what `/health` reported. None of it is secret — see `agent/server.mjs`. */
function renderBrightdataReport(probe) {
  const list = el('bd-report');
  list.replaceChildren();
  const health = probe && probe.health;
  if (!health) {
    renderEmpty(list, 'Press "Test agent" to see what the agent is configured with.');
    return;
  }
  const rows = [
    ['Agent', `bridge protocol ${health.protocol}${health.tokenRequired ? ' · token required' : ' · no token set'}`],
    ['Bright Data', health.brightdata && health.brightdata.configured
      ? String(health.brightdata.description)
      : `not configured — ${(health.brightdata && health.brightdata.error) || 'unknown reason'}`],
    ['Endpoint', (health.brightdata && health.brightdata.redacted) || '—'],
    ['Self-healing', health.selfHealing && health.selfHealing.available
      ? `on · ${health.llm.provider} · ${health.llm.model}`
      : `off — ${(health.selfHealing && health.selfHealing.reason) || 'no model key'}`],
  ];
  for (const [title, detail] of rows) list.appendChild(entryRow({ title, detail }));

  for (const event of (health.heals || []).slice(0, 5)) {
    list.appendChild(entryRow({
      title: event.host,
      field: event.field,
      detail: event.healed ? event.proposed : (event.error || 'not repaired'),
      when: event.at,
      status: event.healed ? 'ok' : 'warn',
    }));
  }
}

for (const id of ['bd-enabled', 'bd-url', 'bd-token', 'bd-mode']) {
  el(id).addEventListener('input', () => setBrightdataDirty(true));
  el(id).addEventListener('change', () => setBrightdataDirty(true));
}
el('bd-url').addEventListener('change', renderBrightdataAccess);

// Called straight from the click: Chrome only honours a permission request
// inside the user gesture that started it, which a service worker cannot supply.
el('bd-grant').addEventListener('click', async () => {
  const state = await renderBrightdataAccess();
  if (!state) {
    setStatus(el('bd-status'), 'Enter a valid loopback address first.', true);
    return;
  }
  try {
    const changed = state.granted
      ? await chrome.permissions.remove({ origins: [state.pattern] })
      : await chrome.permissions.request({ origins: [state.pattern] });
    setStatus(el('bd-status'), changed
      ? `${state.granted ? 'Revoked' : 'Granted'} access to ${state.pattern}.`
      : 'Nothing changed.');
  } catch (error) {
    setStatus(el('bd-status'), String((error && error.message) || error), true);
  }
  await renderBrightdataAccess();
});

el('bd-test').addEventListener('click', async () => {
  const form = readBrightdataForm();
  const normalized = normalizeBridgeUrl(form.bridgeUrl);
  if (!normalized.ok) {
    setStatus(el('bd-status'), normalized.error, true);
    return;
  }
  setStatus(el('bd-status'), 'Asking the agent…');
  // Through the service worker, because that is the context that makes the real
  // calls — a probe fired from this page would prove the wrong thing.
  const response = await chrome.runtime.sendMessage({
    type: MSG.TEST_BRIDGE,
    payload: { bridgeUrl: form.bridgeUrl, token: form.token },
  });
  if (!response || !response.ok) {
    setStatus(el('bd-status'), (response && response.error) || 'The agent could not be reached.', true);
    renderBrightdataReport(null);
    return;
  }
  const probe = response.data;
  renderBrightdataReport(probe);
  if (probe.ok) {
    setStatus(el('bd-status'), `Agent answered in ${probe.ms} ms — ${probe.health.brightdata.description}.`);
  } else {
    setStatus(el('bd-status'), probe.error || 'The agent answered, but is not ready.', true);
  }
  await renderBrightdataAccess();
});

el('bd-scrape').addEventListener('click', async () => {
  const ticker = el('bd-ticker').value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    setStatus(el('bd-status'), 'Enter a ticker to read, such as AAPL.', true);
    return;
  }
  if (brightdataDirty) {
    setStatus(el('bd-status'), 'Save the settings first — the worker reads them from storage, not from this form.', true);
    return;
  }
  setStatus(el('bd-status'), `Reading ${ticker} through the Scraping Browser — this takes a while…`);
  const response = await chrome.runtime.sendMessage({ type: MSG.SCRAPE_VIA_BRIDGE, payload: { ticker } });
  if (!response || !response.ok) {
    setStatus(el('bd-status'), (response && response.error) || 'The scrape failed.', true);
    return;
  }
  const { snapshot, healed, duration_ms: took } = response.data;
  const repaired = healed.length ? ` Repaired ${healed.map((entry) => entry.field).join(', ')}.` : '';
  setStatus(el('bd-status'), `${snapshot.ticker} at ${snapshot.current_price} ${snapshot.currency} in ${Math.round((took || 0) / 1000)}s.${repaired}`);
  el('bd-ticker').value = '';
  // A repair made out there lands in this machine's registry, so the two lists
  // below are stale the moment the scrape returns.
  await Promise.all([renderRegistry(), renderHealLog()]);
});

el('bd-studio').addEventListener('click', async () => {
  const ticker = el('bd-ticker').value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    setStatus(el('bd-status'), 'Enter a ticker to collect, such as AAPL.', true);
    return;
  }
  if (brightdataDirty) {
    setStatus(el('bd-status'), 'Save the settings first — the worker reads them from storage, not from this form.', true);
    return;
  }
  setStatus(el('bd-status'), `Queuing ${ticker} with the Scraper Studio collector — it runs on Bright Data's side…`);
  const response = await chrome.runtime.sendMessage({ type: MSG.SCRAPE_VIA_STUDIO, payload: { ticker } });
  if (!response || !response.ok) {
    setStatus(el('bd-status'), (response && response.error) || 'The collector run failed.', true);
    return;
  }
  const { snapshot, collection_id: snapshotId, duration_ms: took } = response.data;
  const job = snapshotId ? ` (snapshot ${snapshotId})` : '';
  setStatus(
    el('bd-status'),
    `${snapshot.ticker} at ${snapshot.current_price} ${snapshot.currency} from the collector in `
    + `${Math.round((took || 0) / 1000)}s${job}.`
  );
  el('bd-ticker').value = '';
});

el('bd-ticker').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el('bd-scrape').click();
});

el('bd-save').addEventListener('click', async () => {
  const form = readBrightdataForm();
  const normalized = normalizeBridgeUrl(form.bridgeUrl);
  if (!normalized.ok) {
    setStatus(el('bd-status'), normalized.error, true);
    return;
  }
  await saveSettings({ brightdata: { ...form, bridgeUrl: normalized.url } });
  await renderBrightdata();
  setStatus(el('bd-status'), form.enabled
    ? 'Saved. Refreshes will use the Scraping Browser once the agent is running.'
    : 'Saved. Bright Data is switched off.');
});

/**
 * The hash, read defensively.
 *
 * The options page is also driven headlessly, where a document exists but a
 * `location` global may not. Reaching for the bare global there throws during
 * init and takes the whole page down with it.
 */
function currentHash() {
  const source = (typeof window !== 'undefined' && window.location)
    || (typeof location !== 'undefined' ? location : null);
  return source ? String(source.hash || '').slice(1) : '';
}

function setupTabs() {
  const links = Array.from(document.querySelectorAll('.nav-link'));
  const panels = Array.from(document.querySelectorAll('.panel'));
  if (!links.length || !panels.length) return;

  function show(id, { updateHash = true } = {}) {
    const target = panels.find((panel) => panel.id === id) || panels[0];
    for (const panel of panels) panel.hidden = panel !== target;
    for (const link of links) {
      const active = link.getAttribute('href') === `#${target.id}`;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    // jsdom has no history implementation worth relying on, and this is
    // cosmetic either way.
    if (updateHash && typeof history !== 'undefined' && history.replaceState) {
      try {
        history.replaceState(null, '', `#${target.id}`);
      } catch {
        // A file:// or sandboxed context can refuse this. Not worth failing over.
      }
    }
    if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
  }

  for (const link of links) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      show((link.getAttribute('href') || '').slice(1));
    });
  }

  const fromHash = currentHash();
  show(panels.some((panel) => panel.id === fromHash) ? fromHash : panels[0].id, { updateHash: false });
}

(async function init() {
  await Promise.all([
    renderSettings(), renderPortfolio(), renderRegistry(), renderHealLog(), renderAccess(),
    renderBrightdata(), renderChecklist(),
  ]);
  shownProvider = el('provider').value;
  setupTabs();
})();
