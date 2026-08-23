/**
 * The setup guide.
 *
 * Five steps, none of them mandatory. The page writes exactly what the user
 * asked it to write and nothing else: choosing the local rules engine does not
 * quietly leave a half-entered key behind, and skipping a step leaves that part
 * of the configuration at its default rather than at some "onboarded" variant
 * of it.
 *
 * Everything persists as it is entered rather than at the end, so a guide
 * abandoned halfway still leaves a working configuration behind — and
 * `onboardingStep` records how far it got, so reopening it resumes in place.
 */
import { MSG, DASHBOARD_PATH } from './lib/constants.js';
import { getSettings, saveSettings, savePosition, getWatchlist } from './lib/storage.js';
import { PROVIDERS, providerFor } from './lib/providers.js';

const el = (id) => document.getElementById(id);

const STEP_COUNT = 5;
const LAST = STEP_COUNT - 1;

/** The label the forward button carries on each step. */
const NEXT_LABEL = ['Get started', 'Continue', 'Continue', 'Continue', 'Finish'];

const ui = {
  railSteps: el('rail-steps'),
  progressFill: el('progress-fill'),
  progressText: el('progress-text'),
  eyebrow: el('stage-eyebrow'),
  dots: el('dots'),
  back: el('back'),
  next: el('next'),
  skip: el('skip-all'),
  engineLocal: el('engine-local'),
  engineModel: el('engine-model'),
  keyPanel: el('key-panel'),
  provider: el('w-provider'),
  key: el('w-key'),
  keyLabel: el('w-key-label'),
  keyLength: el('w-key-length'),
  keyLink: el('w-key-link'),
  model: el('w-model'),
  modelList: el('w-model-list'),
  test: el('w-test'),
  engineStatus: el('engine-status'),
  ticker: el('w-ticker'),
  buy: el('w-buy'),
  sell: el('w-sell'),
  add: el('w-add'),
  watchlist: el('w-watchlist'),
  trackStatus: el('track-status'),
  monitor: el('w-monitor'),
  recap: el('recap'),
  openDashboard: el('open-dashboard'),
  openSettings: el('open-settings'),
};

const steps = Array.from(document.querySelectorAll('.step'));

let current = 0;
/** The settings as last read, kept so a step can be rendered without a round trip. */
let settings = null;
/** 'local' | 'model' | null — null until the user has actually chosen. */
let engine = null;
/** Tickers added during this run, newest last, for the chip list and the recap. */
let added = [];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function setStatus(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('error', Boolean(isError));
}

function show(node, visible) {
  node.classList.toggle('hidden', !visible);
}

/**
 * Talks to the service worker.
 *
 * MV3 `sendMessage` resolves with the worker's `{ok,data}` envelope, so the
 * unwrapping happens here and every caller sees either a value or a throw.
 */
async function request(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response) throw new Error('The extension service worker did not answer.');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response.data;
}

/** Opens an extension page in a tab, or navigates there if tabs are unavailable. */
function openPage(path) {
  const url = chrome.runtime.getURL ? chrome.runtime.getURL(path) : path;
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.location.href = url;
}

/* ------------------------------------------------------------------ *
 * The rail, the dots and the footer
 * ------------------------------------------------------------------ */

function renderChrome() {
  for (const item of ui.railSteps.querySelectorAll('li')) {
    const index = Number(item.dataset.step);
    item.dataset.state = index < current ? 'done' : (index === current ? 'current' : 'todo');
  }

  // The meter counts the step you are on, not the ones behind you: an empty
  // bar on the first screen reads as "nothing has happened", which is the
  // wrong thing to say to someone who has just arrived.
  const percent = Math.round(((current + 1) / STEP_COUNT) * 100);
  ui.progressFill.style.setProperty('--confidence', String(percent));
  ui.progressText.textContent = `Step ${current + 1} of ${STEP_COUNT}`;

  ui.dots.replaceChildren(...Array.from({ length: STEP_COUNT }, (_, index) => {
    const dot = document.createElement('span');
    dot.dataset.on = index === current ? 'true' : 'false';
    return dot;
  }));

  ui.back.disabled = current === 0;
  ui.next.textContent = NEXT_LABEL[current];
  show(ui.skip, current !== LAST);
  ui.eyebrow.textContent = current === LAST ? 'All set' : 'Getting started';

  for (const section of steps) {
    const index = Number(section.dataset.step);
    section.hidden = index !== current;
    section.classList.toggle('is-active', index === current);
  }
}

/* ------------------------------------------------------------------ *
 * Step 2 — the engine
 * ------------------------------------------------------------------ */

function renderKeyLength() {
  const value = ui.key.value.trim();
  ui.keyLength.textContent = value ? `${value.length} characters` : '';
}

/** Fills the provider-specific fields from the stored settings for that provider. */
function renderProviderFields(id) {
  const provider = providerFor(id);
  const stored = (settings.providers || {})[provider.id] || {};
  ui.keyLabel.textContent = `${provider.label} key`;
  ui.key.placeholder = provider.keyPlaceholder;
  ui.key.value = stored.apiKey || '';
  ui.model.value = stored.model || provider.defaultModel;
  ui.model.placeholder = provider.defaultModel;
  ui.keyLink.href = `https://${provider.keyOrigin}`;
  ui.keyLink.textContent = provider.keyOrigin;

  ui.modelList.replaceChildren();
  for (const model of provider.models) {
    const option = document.createElement('option');
    option.value = model;
    ui.modelList.appendChild(option);
  }
  renderKeyLength();
}

function renderEngine() {
  const isModel = engine === 'model';
  ui.engineLocal.setAttribute('aria-checked', engine === 'local' ? 'true' : 'false');
  ui.engineModel.setAttribute('aria-checked', isModel ? 'true' : 'false');
  show(ui.keyPanel, isModel);
}

function chooseEngine(choice) {
  engine = choice;
  renderEngine();
  setStatus(ui.engineStatus, choice === 'local'
    ? 'Local rules it is. You can switch to a model any time from Settings.'
    : 'Paste your key above, or leave it empty for now — nothing here is required.');
  if (choice === 'model') ui.key.focus();
}

/**
 * Writes the engine choice.
 *
 * The two toggles are set together and explicitly: choosing the local engine
 * has to switch model advisories *off*, not merely fail to switch them on, or
 * a default would quietly override the answer the user just gave.
 */
async function persistEngine() {
  if (!engine) return;
  const id = providerFor(ui.provider.value).id;
  const useModel = engine === 'model';
  const patch = {
    selfHealEnabled: useModel,
    llmAdviceEnabled: useModel,
  };
  if (useModel) {
    patch.provider = id;
    patch.providers = { [id]: { apiKey: ui.key.value.trim(), model: ui.model.value.trim() || providerFor(id).defaultModel } };
  }
  settings = await saveSettings(patch);
}

/* ------------------------------------------------------------------ *
 * Step 3 — the first ticker
 * ------------------------------------------------------------------ */

function renderAdded() {
  ui.watchlist.replaceChildren(...added.map((ticker) => {
    const item = document.createElement('li');
    item.textContent = ticker;
    return item;
  }));
}

const numberOrNull = (value) => {
  const parsed = Number(value);
  return value === '' || !Number.isFinite(parsed) ? null : parsed;
};

async function addTicker() {
  const ticker = ui.ticker.value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    setStatus(ui.trackStatus, 'Enter a ticker symbol first, such as AAPL.', true);
    return;
  }
  const buy = numberOrNull(ui.buy.value);
  const sell = numberOrNull(ui.sell.value);
  if (buy !== null && sell !== null && sell <= buy) {
    setStatus(ui.trackStatus, 'The sell target has to sit above the buy target.', true);
    return;
  }

  ui.add.disabled = true;
  try {
    await request(MSG.ADD_WATCH, { ticker });
    if (buy !== null || sell !== null) {
      await savePosition(ticker, { target_buy_below: buy, target_sell_above: sell });
    }
    if (!added.includes(ticker)) added.push(ticker);
    renderAdded();
    for (const node of [ui.ticker, ui.buy, ui.sell]) node.value = '';
    ui.ticker.focus();
    setStatus(ui.trackStatus, `${ticker} is on the watchlist. Add another, or carry on.`);
  } catch (error) {
    setStatus(ui.trackStatus, String((error && error.message) || error), true);
  } finally {
    ui.add.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Step 4 — the recap
 * ------------------------------------------------------------------ */

function recapRow({ done, title, detail, value }) {
  const item = document.createElement('li');
  item.dataset.done = done ? 'true' : 'false';

  const state = document.createElement('span');
  state.className = 'recap-state';

  const text = document.createElement('div');
  text.className = 'recap-text';
  const heading = document.createElement('b');
  heading.textContent = title;
  const sub = document.createElement('span');
  sub.textContent = detail;
  text.append(heading, sub);

  const reading = document.createElement('span');
  reading.className = 'recap-value';
  reading.textContent = value;

  item.append(state, text, reading);
  return item;
}

/**
 * States what is actually configured, read back from storage rather than from
 * what this page believes it wrote. A recap that reports the intention rather
 * than the result is worse than no recap.
 */
async function renderRecap() {
  settings = await getSettings();
  const watchlist = await getWatchlist();
  const provider = providerFor(settings.provider);
  const key = ((settings.providers || {})[provider.id] || {}).apiKey || '';
  const watched = Object.keys(watchlist);

  ui.recap.replaceChildren(
    recapRow({
      done: Boolean(key),
      title: key ? 'Model connected' : 'Running on local rules',
      detail: key
        ? 'Selector repair and written rationales are available.'
        : 'Verdicts come from your targets and price history. No network call is made.',
      value: key ? `${provider.label}` : 'no key',
    }),
    recapRow({
      done: watched.length > 0,
      title: watched.length ? 'Watchlist started' : 'Nothing watched yet',
      detail: watched.length
        ? 'These appear on the dashboard and can be refreshed on a timer.'
        : 'Scan any quote page from the toolbar and it lands on the watchlist by itself.',
      value: watched.length ? watched.slice(0, 3).join(' ') + (watched.length > 3 ? ` +${watched.length - 3}` : '') : '—',
    }),
    recapRow({
      done: Boolean(settings.monitorEnabled),
      title: settings.monitorEnabled ? 'Background checks on' : 'Background checks off',
      detail: settings.monitorEnabled
        ? 'Watched tickers are re-read on a timer and alerts are raised for you.'
        : 'Nothing is fetched unless you ask for it. This can be turned on from the dashboard.',
      value: settings.monitorEnabled ? `every ${settings.monitorIntervalMinutes} min` : 'off',
    })
  );
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

/** Everything a step has to write before the flow may move past it. */
async function commitStep(index) {
  if (index === 2) await persistEngine();
  if (index === 4) await saveSettings({ onboardingCompleted: true });
}

async function goTo(index) {
  const target = Math.max(0, Math.min(LAST, index));
  if (target > current) await commitStep(current);
  current = target;
  renderChrome();
  await saveSettings({ onboardingStep: current, ...(current === LAST ? { onboardingCompleted: true } : {}) });
  if (current === LAST) await renderRecap();
  if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

ui.next.addEventListener('click', async () => {
  if (current === LAST) {
    await saveSettings({ onboardingCompleted: true });
    openPage(DASHBOARD_PATH);
    return;
  }
  await goTo(current + 1);
});

ui.back.addEventListener('click', () => goTo(current - 1));

ui.skip.addEventListener('click', async () => {
  await commitStep(current);
  await saveSettings({ onboardingCompleted: true, onboardingStep: LAST });
  await goTo(LAST);
});

ui.engineLocal.addEventListener('click', () => chooseEngine('local'));
ui.engineModel.addEventListener('click', () => chooseEngine('model'));

ui.provider.addEventListener('change', () => renderProviderFields(ui.provider.value));
ui.key.addEventListener('input', renderKeyLength);

ui.test.addEventListener('click', async () => {
  const apiKey = ui.key.value.trim();
  if (!apiKey) {
    setStatus(ui.engineStatus, 'Paste the API key first, then test it.', true);
    return;
  }
  setStatus(ui.engineStatus, 'Asking the provider…');
  ui.test.disabled = true;
  try {
    // Through the service worker on purpose: that is the context that makes the
    // real calls, so this proves the path the extension actually uses.
    const data = await request(MSG.TEST_PROVIDER, {
      provider: ui.provider.value,
      apiKey,
      model: ui.model.value.trim(),
    });
    setStatus(ui.engineStatus, `${data.label} answered as ${data.model} in ${data.ms} ms. The key works.`);
  } catch (error) {
    setStatus(ui.engineStatus, String((error && error.message) || error), true);
  } finally {
    ui.test.disabled = false;
  }
});

ui.add.addEventListener('click', addTicker);

for (const node of [ui.ticker, ui.buy, ui.sell]) {
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addTicker(); }
  });
}

ui.monitor.addEventListener('change', async () => {
  const enabled = ui.monitor.checked;
  try {
    await request(MSG.SET_MONITOR, { enabled });
    setStatus(ui.trackStatus, enabled
      ? 'Background checks are on. Every watched ticker is re-read on a timer.'
      : 'Background checks are off. Nothing is fetched unless you ask.');
  } catch (error) {
    ui.monitor.checked = !enabled;
    setStatus(ui.trackStatus, String((error && error.message) || error), true);
  }
});

ui.openDashboard.addEventListener('click', async () => {
  await saveSettings({ onboardingCompleted: true });
  openPage(DASHBOARD_PATH);
});

ui.openSettings.addEventListener('click', async () => {
  await saveSettings({ onboardingCompleted: true });
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

// Left and right arrows walk the flow, as long as the caret is not in a field.
document.addEventListener('keydown', (event) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (event.key === 'ArrowRight' && current < LAST) goTo(current + 1);
  if (event.key === 'ArrowLeft' && current > 0) goTo(current - 1);
});

/* ------------------------------------------------------------------ *
 * Init
 * ------------------------------------------------------------------ */

(async function init() {
  settings = await getSettings();

  for (const provider of Object.values(PROVIDERS)) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    ui.provider.appendChild(option);
  }
  ui.provider.value = providerFor(settings.provider).id;
  renderProviderFields(ui.provider.value);

  // A key that is already stored means the engine question is already answered,
  // so the choice arrives pre-selected rather than blank.
  const stored = (settings.providers || {})[providerFor(settings.provider).id] || {};
  if (stored.apiKey) engine = 'model';
  else if (settings.onboardingStep > 2) engine = 'local';
  renderEngine();

  ui.monitor.checked = Boolean(settings.monitorEnabled);
  added = Object.keys(await getWatchlist());
  renderAdded();

  // A guide left half-done resumes where it stopped, but a finished one starts
  // again from the top: reopening it deliberately means wanting to read it.
  current = settings.onboardingCompleted
    ? 0
    : Math.max(0, Math.min(LAST, Number(settings.onboardingStep) || 0));
  renderChrome();
  if (current === LAST) await renderRecap();
})();
