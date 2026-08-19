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

async function renderSettings() {
  const settings = await getSettings();
  el('api-key').value = settings.apiKey || '';
  el('model').value = settings.model;
  el('self-heal').checked = settings.selfHealEnabled;
  el('llm-advice').checked = settings.llmAdviceEnabled;
  el('snippet-chars').value = settings.maxSnippetChars;
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
    cell.colSpan = 6;
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

el('save-settings').addEventListener('click', async () => {
  const chars = Number(el('snippet-chars').value);
  await saveSettings({
    apiKey: el('api-key').value.trim(),
    model: el('model').value,
    selfHealEnabled: el('self-heal').checked,
    llmAdviceEnabled: el('llm-advice').checked,
    maxSnippetChars: Number.isFinite(chars) ? Math.min(40000, Math.max(1000, chars)) : 12000,
  });
  await renderSettings();
  setStatus(el('settings-status'), 'Settings saved.');
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
  });
  for (const id of ['pos-ticker', 'pos-shares', 'pos-cost', 'pos-buy', 'pos-sell']) el(id).value = '';
  await renderPortfolio();
  setStatus(el('position-status'), `Saved ${ticker}.`);
});

el('reset-registry').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MSG.RESET_SELECTORS });
  await renderRegistry();
});

(async function init() {
  await Promise.all([renderSettings(), renderPortfolio(), renderRegistry(), renderHealLog()]);
})();
