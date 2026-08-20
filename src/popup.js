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
  snapshotCard: el('snapshot-card'),
  ticker: el('snapshot-title'),
  price: el('snapshot-price'),
  currency: el('snapshot-currency'),
  change: el('snapshot-change'),
  volume: el('snapshot-volume'),
  time: el('snapshot-time'),
  newsWrap: el('snapshot-news-wrap'),
  news: el('snapshot-news'),
  selectors: el('snapshot-selectors'),
  healBanner: el('heal-banner'),
  warnBanner: el('warn-banner'),
  adviceCard: el('advice-card'),
  action: el('advice-action'),
  bar: el('advice-bar'),
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
}

function renderAdvice(advice) {
  ui.action.textContent = advice.action;
  ui.action.className = `badge ${advice.action}`;
  const percent = Math.round((advice.confidence_score || 0) * 100);
  ui.bar.style.width = `${percent}%`;
  ui.score.textContent = `${percent}% confidence`;
  ui.rationale.textContent = advice.rationale;

  const origin = advice.source === 'llm'
    ? `${advice.provider_label || 'Model'} (${advice.model || 'model'})`
    : 'Local rules engine';
  ui.source.textContent = advice.note ? `${origin} — ${advice.note}` : origin;

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

function renderBanners(healed, warnings) {
  const healedList = healed || [];
  if (healedList.length) {
    ui.healBanner.replaceChildren();
    const title = document.createElement('div');
    title.textContent = `Self-healed ${healedList.length} selector${healedList.length > 1 ? 's' : ''}:`;
    const list = document.createElement('ul');
    for (const item of healedList) list.appendChild(li(`${item.field} → ${item.selector}`));
    ui.healBanner.append(title, list);
  }
  show(ui.healBanner, healedList.length > 0);

  const warnList = warnings || [];
  if (warnList.length) {
    ui.warnBanner.replaceChildren();
    const list = document.createElement('ul');
    for (const item of warnList) list.appendChild(li(item));
    ui.warnBanner.append(list);
  }
  show(ui.warnBanner, warnList.length > 0);
}

/** Opens the confirmation modal; resolves the stored callback on confirm. */
function confirmAction(summary, onConfirm) {
  ui.modalBody.textContent = summary;
  pendingConfirm = onConfirm;
  show(ui.modal, true);
  ui.modalConfirm.focus();
}

function closeModal() {
  pendingConfirm = null;
  show(ui.modal, false);
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
  setStatus('Reading the active tab…');
  show(ui.adviceCard, false);
  try {
    const result = await request(MSG.SCRAPE_ACTIVE_TAB);
    currentSnapshot = result.snapshot;
    ui.context.textContent = result.host || 'Self-healing scraper';
    renderSnapshot(result.snapshot);
    renderBanners(result.healed, result.warnings);

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
    ui.scrape.disabled = false;
  }
}

ui.scrape.addEventListener('click', runScrape);

ui.options.addEventListener('click', () => chrome.runtime.openOptionsPage());

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

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !ui.modal.classList.contains('hidden')) closeModal();
});

/** Restores the last snapshot for the active host so the popup opens warm. */
(async function init() {
  try {
    const state = await request(MSG.GET_STATE);
    renderDecisions(state.decisions);
    if (!state.hasApiKey) {
      setStatus('No API key set — self-healing is off and advice falls back to local rules.');
    }
  } catch (error) {
    setStatus(error.message, true);
  }
})();
