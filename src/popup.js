/**
 * Popup dashboard.
 *
 * Rendering rule: every value here originated on an arbitrary web page, so it
 * is written with `textContent` only. Nothing scraped is ever interpolated as
 * HTML.
 *
 * Human-in-the-loop rule: Approve / Reject / Override all route through the
 * confirmation modal, and the extension records the decision locally. No order
 * is ever transmitted anywhere.
 */
import { MSG } from './lib/constants.js';
import { formatCompact } from './lib/advisor.js';

const el = (id) => document.getElementById(id);

const ui = {
  scrape: el('scrape-btn'),
  status: el('status'),
  context: el('context-line'),
  options: el('options-btn'),
  empty: el('empty-state'),
  setupCard: el('setup-card'),
  setupBtn: el('setup-btn'),
  snapshotCard: el('snapshot-card'),
  ticker: el('snapshot-title'),
  price: el('snapshot-price'),
  priceRow: el('snapshot-price').closest('.price'),
  currency: el('snapshot-currency'),
  change: el('snapshot-change'),
  volume: el('snapshot-volume'),
  time: el('snapshot-time'),
  newsWrap: el('snapshot-news-wrap'),
  news: el('snapshot-news'),
  selectors: el('snapshot-selectors'),
  healBanner: el('heal-banner'),
  targetsLine: el('targets-line'),
  warnBanner: el('warn-banner'),
  noticeBanner: el('notice-banner'),
  adviceCard: el('advice-card'),
  action: el('advice-action'),
  score: el('advice-score'),
  rationale: el('advice-rationale'),
  source: el('advice-source'),
  approve: el('approve-btn'),
  reject: el('reject-btn'),
  override: el('override-btn'),
  overridePanel: el('override-panel'),
  overrideAction: el('override-action'),
  overrideNote: el('override-note'),
  overrideConfirm: el('override-confirm'),
  logCard: el('log-card'),
  log: el('decision-log'),
  modal: el('modal'),
  modalBody: el('modal-body'),
  modalConfirm: el('modal-confirm'),
  modalCancel: el('modal-cancel'),
};

let currentSnapshot = null;
let currentAdvice = null;
let pendingConfirm = null;
/** The element focus should return to once the confirmation modal closes. */
let lastFocused = null;

/** Sends a request to the service worker and unwraps the {ok,data} envelope. */
function request(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('No response from the extension service worker.'));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error || 'Unknown error'));
        return;
      }
      resolve(response.data);
    });
  });
}

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', Boolean(isError));
}

function show(node, visible) {
  node.classList.toggle('hidden', !visible);
}

/**
 * Flips a boolean flag on <body>. The stylesheet keys the activity rail, the
 * pulsing mark and the verdict wash off these, so the visual state of the whole
 * panel follows the agent's state without any element-by-element bookkeeping.
 */
function setFlag(name, value) {
  if (value === null || value === false) delete document.body.dataset[name];
  else document.body.dataset[name] = String(value);
}

function replaceList(node, items, render) {
  node.replaceChildren();
  for (const item of items) node.appendChild(render(item));
}

function li(text) {
  const node = document.createElement('li');
  node.textContent = text;
  return node;
}

function renderSnapshot(snapshot) {
  ui.ticker.textContent = snapshot.ticker || 'Unknown';
  ui.price.textContent = Number.isFinite(snapshot.current_price)
    ? snapshot.current_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : '—';
  ui.currency.textContent = snapshot.currency || '';

  // A freshly read price lands rather than appears. Removing the class,
  // reading a layout property and adding it back is what replays a CSS
  // animation on an element that never left the DOM.
  ui.priceRow.classList.remove('is-fresh');
  void ui.priceRow.offsetWidth;
  ui.priceRow.classList.add('is-fresh');

  ui.change.textContent = snapshot.change_percentage || '—';
  ui.change.classList.remove('up', 'down');
  if (Number.isFinite(snapshot.change_value)) {
    ui.change.classList.add(snapshot.change_value >= 0 ? 'up' : 'down');
  }

  ui.volume.textContent = Number.isFinite(snapshot.volume) ? formatCompact(snapshot.volume) : '—';
  ui.time.textContent = snapshot.extracted_at
    ? new Date(snapshot.extracted_at).toLocaleTimeString()
    : '—';

  const news = Array.isArray(snapshot.news) ? snapshot.news : [];
  show(ui.newsWrap, news.length > 0);
  replaceList(ui.news, news, li);

  const selectors = Object.entries(snapshot.selectors_used || {});
  replaceList(ui.selectors, selectors, ([key, value]) => li(`${key}: ${value}`));

  show(ui.snapshotCard, true);
  // The primer has served its purpose once there is real data on screen.
  show(ui.empty, false);
}

function renderAdvice(advice) {
  ui.action.textContent = advice.action;
  ui.action.className = `badge ${advice.action}`;
  // The gauge is the ring around the verdict word, and it is drawn from this
  // one number: the arc sweeps `--confidence` percent of the circle. Set on the
  // card rather than on the arc itself so the glow behind the lens reads it too.
  const percent = Math.round((advice.confidence_score || 0) * 100);
  ui.adviceCard.style.setProperty('--confidence', String(percent));
  ui.score.textContent = `${percent}% confidence`;
  ui.rationale.textContent = advice.rationale;

  const origin = advice.source === 'llm'
    ? `${advice.provider_label || 'Model'} (${advice.model || 'model'})`
    : 'Local rules engine';
  ui.source.textContent = advice.note ? `${origin} — ${advice.note}` : origin;

  // Tints the top of the panel in the verdict's hue, so the call registers
  // peripherally before it is read.
  setFlag('verdict', advice.action);

  show(ui.overridePanel, false);
  show(ui.adviceCard, true);
}

function renderDecisions(decisions) {
  const recent = (decisions || []).slice(0, 6);
  show(ui.logCard, recent.length > 0);
  replaceList(ui.log, recent, (entry) => {
    const row = document.createElement('li');
    const left = document.createElement('span');
    left.textContent = `${entry.ticker} · ${entry.final_action}`;
    const right = document.createElement('span');
    right.className = `verdict ${entry.verdict}`;
    right.textContent = entry.verdict;
    row.append(left, right);
    return row;
  });
}

/**
 * Says so when a scan moved the user's own thresholds. Automatic targets are
 * opt-in per position, but "opt-in" is not a licence to change someone's
 * numbers quietly.
 */
function renderTargets(targets) {
  if (targets && targets.applied) {
    ui.targetsLine.textContent =
      `Targets updated automatically: buy below ${targets.target_buy_below}, sell above ${targets.target_sell_above} `
      + `(${targets.basis === 'history' ? `${targets.sample_size} scans` : targets.basis}).`;
  }
  show(ui.targetsLine, Boolean(targets && targets.applied));
}

/** Fills one banner with a title and a list, or hides it when there is nothing. */
function renderBanner(node, title, items) {
  const list = items || [];
  if (list.length) {
    node.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'banner-title';
    heading.textContent = typeof title === 'function' ? title(list) : title;
    const body = document.createElement('ul');
    for (const item of list) body.appendChild(li(item));
    node.append(heading, body);
  }
  show(node, list.length > 0);
}

/**
 * Three separate things get told apart here, because they ask different things
 * of the reader:
 *
 *   healed  — the agent fixed something by itself. Good news.
 *   warned  — something went wrong and a number may be missing. Act on it.
 *   noticed — this page simply does not carry that field. Nothing to do.
 *
 * Lumping the third in with the second is what makes a working scan look
 * broken, so it gets its own quiet banner.
 */
function renderBanners(healed, warnings, notices) {
  const healedList = healed || [];
  renderBanner(
    ui.healBanner,
    (list) => `Self-healed ${list.length} selector${list.length > 1 ? 's' : ''}:`,
    healedList.map((item) => `${item.field} → ${item.selector}`)
  );
  renderBanner(ui.warnBanner, 'Needs your attention', warnings || []);
  renderBanner(ui.noticeBanner, 'Not on this page', notices || []);
}

/** Opens the confirmation modal; resolves the stored callback on confirm. */
function confirmAction(summary, onConfirm) {
  ui.modalBody.textContent = summary;
  pendingConfirm = onConfirm;
  lastFocused = document.activeElement;
  show(ui.modal, true);
  ui.modalConfirm.focus();
}

function closeModal() {
  pendingConfirm = null;
  show(ui.modal, false);
  // Keyboard users land back on the button they opened the dialog from.
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  lastFocused = null;
}

async function logDecision(verdict, finalAction, note) {
  if (!currentSnapshot || !currentAdvice) return;
  const entry = await request(MSG.RECORD_DECISION, {
    ticker: currentSnapshot.ticker,
    suggested_action: currentAdvice.action,
    final_action: finalAction,
    verdict,
    confidence_score: currentAdvice.confidence_score,
    rationale: currentAdvice.rationale,
    advice_source: currentAdvice.source || 'heuristic',
    price: currentSnapshot.current_price,
    currency: currentSnapshot.currency,
    note: note || null,
  });
  setStatus(`Logged: ${verdict} — ${finalAction} ${entry.ticker}. No order was placed.`);
  const state = await request(MSG.GET_STATE);
  renderDecisions(state.decisions);
}

async function runScrape() {
  ui.scrape.disabled = true;
  setFlag('busy', '1');
  setFlag('verdict', null);
  setStatus('Reading the active tab…');
  show(ui.adviceCard, false);
  try {
    const result = await request(MSG.SCRAPE_ACTIVE_TAB);
    currentSnapshot = result.snapshot;
    ui.context.textContent = result.host || 'Self-healing scraper';
    // A host is an identifier and is typeset as one; the fallback is a
    // sentence, and setting prose in the monospace face reads as a bug.
    ui.context.classList.toggle('is-host', Boolean(result.host));
    renderSnapshot(result.snapshot);
    renderTargets(result.targets);
    renderBanners(result.healed, result.warnings, result.notices);

    if (!result.usable) {
      setStatus('Could not read a ticker and price from this page.', true);
      return;
    }
    setStatus('Generating advisory…');
    currentAdvice = await request(MSG.GET_ADVICE, { snapshot: result.snapshot });
    renderAdvice(currentAdvice);
    setStatus('Review the rationale, then approve, reject, or override.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setFlag('busy', null);
    ui.scrape.disabled = false;
  }
}

ui.scrape.addEventListener('click', runScrape);

ui.options.addEventListener('click', () => chrome.runtime.openOptionsPage());

ui.setupBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

ui.approve.addEventListener('click', () => {
  if (!currentAdvice) return;
  confirmAction(
    `Approve the ${currentAdvice.action} signal for ${currentSnapshot.ticker}?`,
    () => logDecision('APPROVED', currentAdvice.action, null)
  );
});

ui.reject.addEventListener('click', () => {
  if (!currentAdvice) return;
  confirmAction(
    `Reject the ${currentAdvice.action} signal for ${currentSnapshot.ticker}?`,
    () => logDecision('REJECTED', 'NONE', null)
  );
});

ui.override.addEventListener('click', () => {
  show(ui.overridePanel, ui.overridePanel.classList.contains('hidden'));
});

ui.overrideConfirm.addEventListener('click', () => {
  if (!currentAdvice) return;
  const action = ui.overrideAction.value;
  const note = ui.overrideNote.value.trim();
  confirmAction(
    `Override the ${currentAdvice.action} signal and record ${action} for ${currentSnapshot.ticker}?`,
    () => logDecision('OVERRIDDEN', action, note)
  );
});

ui.modalCancel.addEventListener('click', closeModal);

ui.modalConfirm.addEventListener('click', async () => {
  const callback = pendingConfirm;
  closeModal();
  if (!callback) return;
  try {
    await callback();
  } catch (error) {
    setStatus(error.message, true);
  }
});

ui.modal.addEventListener('click', (event) => {
  if (event.target === ui.modal) closeModal();
});

/**
 * While the confirmation dialog is up it is the only thing on screen that
 * should be reachable: it is `aria-modal`, and a Tab that wandered back into
 * the page behind it would let someone approve a trade they cannot see.
 */
document.addEventListener('keydown', (event) => {
  if (ui.modal.classList.contains('hidden')) return;

  if (event.key === 'Escape') {
    closeModal();
    return;
  }
  if (event.key !== 'Tab') return;

  const stops = [ui.modalCancel, ui.modalConfirm];
  const here = stops.indexOf(document.activeElement);
  const next = (here + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
  event.preventDefault();
  stops[next].focus();
});

/** Restores the last snapshot for the active host so the popup opens warm. */
(async function init() {
  try {
    const state = await request(MSG.GET_STATE);
    renderDecisions(state.decisions);
    // A missing key is a thing to *do*, not a thing to read, so it gets a card
    // with a button rather than a line of grey text above the fold.
    show(ui.setupCard, !state.hasApiKey);
  } catch (error) {
    setStatus(error.message, true);
  }
})();
