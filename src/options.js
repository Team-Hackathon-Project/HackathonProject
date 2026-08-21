/**
 * Options page: API key, model, self-healing toggles, portfolio targets, and
 * the healed-selector registry.
 *
 * Reads and writes `chrome.storage.local` directly — no service-worker round
 * trip needed — except for the registry reset, which goes through the worker
 * so the reset is logged in one place.
 */
import { MSG } from './lib/constants.js';
import { getSettings, saveSettings, getPortfolio, savePosition, getRegistry, getHealLog } from './lib/storage.js';
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

  const line = document.createElement('span');
  line.textContent = `${provider.label} · ${el('model').value.trim() || provider.defaultModel}`;
  const state = document.createElement('span');
  state.className = hasKey ? 'on' : 'off';
  state.textContent = hasKey
    ? 'Key set — repairs and model advisories are available.'
    : 'No key — running on the built-in rules only.';
  node.append(line, document.createElement('br'), state);
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

async function renderRegistry() {
  const registry = await getRegistry();
  const list = el('registry-list');
  list.replaceChildren();
  const rows = [];
  for (const [host, fields] of Object.entries(registry)) {
    for (const [field, entry] of Object.entries(fields)) {
      rows.push(`${host} · ${field} → ${entry.selector} (${entry.strategy}, healed ${new Date(entry.healed_at).toLocaleString()})`);
    }
  }
  if (!rows.length) rows.push('No healed selectors yet — the shipped defaults are handling every page so far.');
  for (const text of rows) {
    const item = document.createElement('li');
    item.textContent = text;
    list.appendChild(item);
  }
}

async function renderHealLog() {
  const log = await getHealLog();
  const list = el('heal-log');
  list.replaceChildren();
  const entries = log.slice(0, 25);
  if (!entries.length) {
    const item = document.createElement('li');
    item.textContent = 'No repair attempts recorded.';
    list.appendChild(item);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement('li');
    const when = new Date(entry.at).toLocaleString();
    item.textContent = entry.healed
      ? `${when} · ${entry.host} · ${entry.field} → ${entry.proposed} (confidence ${entry.confidence})`
      : `${when} · ${entry.host} · ${entry.field} · FAILED: ${entry.error}`;
    list.appendChild(item);
  }
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
  setStatus(el('position-status'), `Saved ${ticker}.`);
});

el('reset-registry').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MSG.RESET_SELECTORS });
  await renderRegistry();
});

/**
 * Keeps the sidebar rail in step with whichever section is being read.
 *
 * Guarded twice over: the options page is also driven headlessly in jsdom,
 * which ships neither `IntersectionObserver` nor layout, so this is a no-op
 * there rather than a crash on import.
 */
function trackSections() {
  const links = Array.from(document.querySelectorAll('.nav-link'));
  if (!links.length || typeof IntersectionObserver !== 'function') return;

  const sections = links
    .map((link) => document.getElementById((link.getAttribute('href') || '').slice(1)))
    .filter(Boolean);
  if (!sections.length) return;

  const onscreen = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) onscreen.add(entry.target.id);
      else onscreen.delete(entry.target.id);
    }
    // The first section still inside the reading band wins, so scrolling down
    // hands the highlight on rather than flickering between two neighbours.
    const active = sections.find((section) => onscreen.has(section.id));
    if (!active) return;
    for (const link of links) {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${active.id}`);
    }
  }, { rootMargin: '-8% 0px -60% 0px', threshold: 0 });

  for (const section of sections) observer.observe(section);
}

(async function init() {
  await Promise.all([renderSettings(), renderPortfolio(), renderRegistry(), renderHealLog()]);
  shownProvider = el('provider').value;
  trackSections();
})();
