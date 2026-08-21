/**
 * MV3 service worker — the coordinator.
 *
 * Owns: content-script injection, the selector registry, the self-healing loop,
 * the offscreen parser's lifecycle, and every call to the Anthropic API.
 * The API key never leaves this context.
 *
 * This worker is event-driven and may be torn down at any time; all state lives
 * in `chrome.storage.local`, and every listener is registered synchronously at
 * the top level so it survives a restart.
 */
import {
  MSG, OFFSCREEN_TARGET, OFFSCREEN_PATH, FIELDS, SNIPPET_LIMIT,
} from './lib/constants.js';
import { candidatesFor, isPlausibleSelector } from './lib/selectors.js';
import { buildSnapshot, isUsableSnapshot, valueFitsField } from './lib/normalize.js';
import { activeLlm, providerFor } from './lib/providers.js';
import { heuristicAdvice, validateAdvice, buildAdvisoryContext } from './lib/advisor.js';
import { healSelector, requestAdvice, LlmError, pingProvider } from './lib/llm.js';
import {
  getSettings, getPortfolio, getRegistry, recordHealedSelector, clearRegistry,
  saveSnapshot, getSnapshots, recordDecision, getDecisions, recordHealEvent, getHealLog,
} from './lib/storage.js';

/** How far down the candidate list one bad match may push us. */
const MAX_CANDIDATE_RETRIES = 4;

/** How many times one field may be sent back to the model before giving up. */
const MAX_HEAL_ATTEMPTS = 2;

const RESTRICTED_SCHEMES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'view-source:'];
const CHROME_WEBSTORE = /^https:\/\/chromewebstore\.google\.com/;

/* ------------------------------------------------------------------ *
 * Offscreen document lifecycle
 * ------------------------------------------------------------------ */

let offscreenCreating = null;

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DOM_PARSER'],
    justification: 'Parse and sanitize scraped quote-page HTML off the user\'s active tab.',
  }).catch((error) => {
    // A concurrent call may have won the race; that is not a failure.
    if (!String(error && error.message).includes('Only a single offscreen')) throw error;
  });
  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

/** Tears the offscreen document down once a scrape no longer needs it. */
async function closeOffscreen() {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch (error) {
    console.warn('[market-scraper] could not close the offscreen document:', error);
  }
}

/**
 * Sanitizes a snippet in the offscreen document. Falls back to a plain regex
 * strip if the offscreen API is unavailable, so healing never hard-fails on it.
 */
async function sanitizeSnippet(html, maxChars) {
  if (!html) return { html: '', truncated: false };
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      type: MSG.SANITIZE_HTML,
      payload: { html, maxChars },
    });
    if (response && response.ok) return response;
    throw new Error((response && response.error) || 'offscreen sanitize returned no result');
  } catch (error) {
    console.warn('[market-scraper] offscreen sanitize failed, using fallback:', error);
    const stripped = String(html)
      .replace(/<(script|style|svg|iframe|noscript)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { html: stripped.slice(0, maxChars), truncated: stripped.length > maxChars, fallback: true };
  }
}

/* ------------------------------------------------------------------ *
 * Tab plumbing
 * ------------------------------------------------------------------ */

/**
 * True when a URL is one we may inject into. An empty URL is *not* a refusal:
 * `tab.url` is only populated once activeTab has been granted, so an unknown
 * URL is checked by attempting the injection instead (see `getActiveTab`).
 */
export function isScrapableUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) return false;
  if (CHROME_WEBSTORE.test(url)) return false;
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  // `tab.url` is only readable once activeTab has been granted for this tab.
  // When it is missing we let the injection itself decide.
  if (tab.url && !isScrapableUrl(tab.url)) {
    throw new Error('This page cannot be scraped. Open a stock quote page on an http(s) site and try again.');
  }
  return tab;
}

/** Host for a tab URL we may not have been allowed to read. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Sends a message to the tab, resolving to null instead of throwing. */
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

/** Injects the content script if it is not already listening in this tab. */
async function ensureContentScript(tabId) {
  const ping = await sendToTab(tabId, { type: 'PING' });
  if (ping && ping.ok) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
  } catch (error) {
    // Chrome refuses injection on its own pages and on the Web Store.
    throw new Error(`This page cannot be scraped (${String((error && error.message) || error)}).`);
  }
  const retry = await sendToTab(tabId, { type: 'PING' });
  if (!retry || !retry.ok) throw new Error('Could not reach the page. Reload the tab and try again.');
}

/* ------------------------------------------------------------------ *
 * Self-healing scrape
 * ------------------------------------------------------------------ */

async function buildCandidateMap(host, registry) {
  const map = {};
  for (const field of FIELDS) map[field] = candidatesFor(host, field, registry);
  return map;
}

/** Thrown when retrying would be pointless: the answer will not change. */
class TerminalHealError extends Error {}

/**
 * One repair round trip: ask, sanity-check, validate in the live page, persist.
 * Throws on failure so the caller can decide whether another attempt is worth
 * making. `feedback` carries the previous attempt's rejection back to the model.
 */
async function attemptHeal({ tabId, host, field, snippetHtml, tried, llm, feedback, entry }) {
  const proposal = await healSelector({
    field,
    host,
    snippet: snippetHtml,
    previousSelector: (tried || [])[0] || null,
    feedback,
    provider: llm.provider.id,
    model: llm.model,
    apiKey: llm.apiKey,
  });
  entry.proposed = proposal.selector;
  entry.strategy = proposal.strategy;
  entry.confidence = proposal.confidence;
  entry.reason = proposal.reason;

  // Confidence first: a model that correctly reports "this metric is not in
  // the fragment" also returns no selector, and its explanation is far more
  // useful to the user than "unusable selector: ". Asking again will not
  // conjure a metric the fragment does not hold.
  if (proposal.confidence <= 0 || !proposal.selector) {
    throw new TerminalHealError(proposal.reason || 'model reported the metric is not in the snippet');
  }
  if (!isPlausibleSelector(proposal)) throw new Error(`model returned an unusable selector: ${proposal.selector}`);

  // Re-attempt extraction in the live page — no reload required.
  const check = await sendToTab(tabId, {
    type: MSG.VALIDATE_SELECTOR,
    payload: { field, selector: proposal.selector, strategy: proposal.strategy },
  });
  if (!check || !check.ok) throw new Error((check && check.error) || 'validation in the page failed');
  // A selector that resolves is not yet a selector that is *right*: the model
  // can point at a neighbouring node. Refuse to persist one whose value is the
  // wrong shape for the field.
  if (!valueFitsField(field, check.value)) {
    throw new Error(`selector matched, but "${String(check.value).slice(0, 60)}" is not a valid ${field}`);
  }

  const stored = await recordHealedSelector(host, field, proposal);
  entry.healed = true;
  entry.value = check.value;
  return { healed: true, field, value: check.value, used: { ...stored, source: 'healed' } };
}

/**
 * Repairs one failed field, retrying once with the rejection handed back.
 *
 * The retry is what makes this work against real pages: the first answer is
 * often the right *element* expressed badly — a Tailwind class that needs CSS
 * escaping, a selector landing on the label instead of the value. Told exactly
 * why it was rejected, the model usually fixes it. Never throws.
 */
async function healField({ tabId, host, field, snippet, tried, settings }) {
  const llm = activeLlm(settings);
  let snippetHtml = null;
  let feedback = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    const entry = { field, host, at: new Date().toISOString(), healed: false, provider: llm.provider.id, attempt };
    try {
      if (snippetHtml === null) {
        if (!snippet) throw new TerminalHealError('no container HTML captured for this field');
        const cleaned = await sanitizeSnippet(snippet, settings.maxSnippetChars);
        if (!cleaned.html) throw new TerminalHealError('sanitized container was empty');
        snippetHtml = cleaned.html;
      }
      const outcome = await attemptHeal({ tabId, host, field, snippetHtml, tried, llm, feedback, entry });
      await recordHealEvent(entry);
      return outcome;
    } catch (error) {
      lastError = error instanceof LlmError ? error.message : String((error && error.message) || error);
      entry.error = lastError;
      await recordHealEvent(entry);
      // A transport failure or an honest "it is not in there" will not improve
      // on a second ask; a rejected selector often will.
      if (error instanceof TerminalHealError || error instanceof LlmError) break;
      feedback = lastError;
    }
  }
  return { healed: false, field, error: lastError };
}

/**
 * Full scrape pass: extract, heal what failed, normalize, persist.
 * Returns { snapshot, failures, healed, warnings }.
 */
export async function scrapeActiveTab() {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);

  const settings = await getSettings();
  const registry = await getRegistry();
  const host = hostOf(tab.url);
  const candidates = await buildCandidateMap(host, registry);

  let result = await sendToTab(tab.id, {
    type: MSG.EXTRACT,
    payload: { candidates, snippetLimit: SNIPPET_LIMIT },
  });
  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'The page did not respond to the extraction request.');
  }

  // If we could not read the tab URL up front, the candidate list was built
  // from the generic fallbacks. Now that the page has told us its host, retry
  // once with the host-specific selectors.
  let candidateMap = candidates;
  if (!host && result.host) {
    const hostCandidates = await buildCandidateMap(result.host, registry);
    const retry = await sendToTab(tab.id, {
      type: MSG.EXTRACT,
      payload: { candidates: hostCandidates, snippetLimit: SNIPPET_LIMIT },
    });
    if (retry && retry.ok) {
      result = retry;
      candidateMap = hostCandidates;
    }
  }

  const raw = { ...result.raw };
  const used = { ...result.used };
  const healed = [];
  const warnings = [];
  const failures = [...(result.failures || [])];

  // A selector can match a real node and still hand back the wrong kind of
  // value — a "Volume" label instead of the count, a price where a percentage
  // belongs. Treat that exactly like a miss: drop it, fetch the container, and
  // let the repair path have a go at it.
  for (const [field, value] of Object.entries(result.raw || {})) {
    if (value === null || value === undefined || Array.isArray(value)) continue;
    if (valueFitsField(field, value)) continue;

    const rejected = [];
    let current = { value, entry: used[field] };
    // Walk down the remaining candidates; a junk match must not stop the list.
    for (let attempt = 0; attempt < MAX_CANDIDATE_RETRIES && current && !valueFitsField(field, current.value); attempt++) {
      if (current.entry) rejected.push(current.entry.selector);
      const remaining = (candidateMap[field] || []).filter((entry) => !rejected.includes(entry.selector));
      if (!remaining.length) { current = null; break; }
      const next = await sendToTab(tab.id, {
        type: MSG.EXTRACT,
        payload: { candidates: { [field]: remaining }, snippetLimit: SNIPPET_LIMIT },
      });
      const nextValue = next && next.ok ? next.raw[field] : null;
      current = nextValue === null || nextValue === undefined
        ? null
        : { value: nextValue, entry: next.used[field] };
    }

    if (current && valueFitsField(field, current.value)) {
      raw[field] = current.value;
      used[field] = current.entry;
      continue;
    }

    const container = await sendToTab(tab.id, {
      type: MSG.CAPTURE_CONTAINER,
      payload: { field, snippetLimit: SNIPPET_LIMIT },
    });
    failures.push({
      field,
      snippet: (container && container.ok && container.snippet) || '',
      tried: rejected,
      mismatch: String(value).slice(0, 60),
    });
    raw[field] = null;
    delete used[field];
  }
  if (failures.length && settings.selfHealEnabled && activeLlm(settings).apiKey) {
    try {
      // Heal sequentially: each call is a separate LLM round trip and the
      // failures are usually correlated (one layout change breaks several).
      for (const failure of failures) {
        const outcome = await healField({
          tabId: tab.id,
          host: result.host || host,
          field: failure.field,
          snippet: failure.snippet,
          tried: failure.tried,
          settings,
        });
        if (outcome.healed) {
          raw[failure.field] = outcome.value;
          used[failure.field] = outcome.used;
          healed.push({ field: failure.field, selector: outcome.used.selector, strategy: outcome.used.strategy });
        } else {
          warnings.push(`Could not heal "${failure.field}": ${outcome.error}`);
        }
      }
    } finally {
      // The parser is only needed while repairs are running; MV3 allows one
      // offscreen document per extension, so hand it back.
      await closeOffscreen();
    }
  } else if (failures.length) {
    const reason = !activeLlm(settings).apiKey ? 'no API key configured' : 'self-healing is disabled in options';
    for (const failure of failures) {
      warnings.push(failure.mismatch
        ? `Ignored "${failure.field}": the page returned "${failure.mismatch}" (${reason}).`
        : `Missing "${failure.field}" (${reason}).`);
    }
  }

  const selectorsUsed = {};
  for (const [field, entry] of Object.entries(used)) {
    selectorsUsed[`${field}_selector`] = entry.selector;
  }

  const snapshot = buildSnapshot(raw, {
    source_url: result.url,
    selectors_used: selectorsUsed,
  });

  if (isUsableSnapshot(snapshot)) {
    await saveSnapshot(snapshot);
  } else {
    warnings.push('Could not recover both a ticker and a price, so this snapshot was not saved.');
  }

  return {
    snapshot,
    usable: isUsableSnapshot(snapshot),
    healed,
    warnings,
    failedFields: failures.map((failure) => failure.field),
    host: result.host || host,
    title: result.title,
  };
}

/* ------------------------------------------------------------------ *
 * Advisory
 * ------------------------------------------------------------------ */

/**
 * Produces one advisory for a snapshot. Uses the LLM when configured and
 * always falls back to the deterministic rules engine, so the popup is never
 * left without a recommendation to show.
 */
export async function adviseOn(snapshot) {
  if (!isUsableSnapshot(snapshot)) throw new Error('Cannot advise without a ticker and a price.');
  const settings = await getSettings();
  const portfolio = await getPortfolio();
  const position = portfolio[snapshot.ticker] || {};
  const fallback = heuristicAdvice(snapshot, position);

  const llm = activeLlm(settings);
  if (!settings.llmAdviceEnabled || !llm.apiKey) {
    return {
      ...fallback,
      note: llm.apiKey ? 'LLM advice is disabled in options.' : 'No API key configured — showing the rules-based signal.',
    };
  }

  try {
    const parsed = await requestAdvice({
      context: buildAdvisoryContext(snapshot, position),
      provider: llm.provider.id,
      model: llm.model,
      apiKey: llm.apiKey,
    });
    const advice = validateAdvice(parsed, snapshot.ticker);
    if (!advice) throw new Error('the model returned an advisory that failed schema validation');
    return {
      ...advice,
      source: 'llm',
      provider: llm.provider.id,
      provider_label: llm.provider.label,
      model: llm.model,
      generated_at: new Date().toISOString(),
    };
  } catch (error) {
    const message = String((error && error.message) || error);
    console.warn('[market-scraper] LLM advice failed, using heuristic:', message);
    return { ...fallback, note: `LLM advice unavailable (${message}). Showing the rules-based signal.` };
  }
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

/** Resolves one popup/options request. Exported so tests can drive it directly. */
export async function handleRequest(message) {
  switch (message.type) {
    case MSG.SCRAPE_ACTIVE_TAB:
      return scrapeActiveTab();
    case MSG.GET_ADVICE:
      return adviseOn(message.payload && message.payload.snapshot);
    case MSG.RECORD_DECISION: {
      const entry = {
        ...message.payload,
        decided_at: new Date().toISOString(),
        executed: false, // this extension never places orders
      };
      await recordDecision(entry);
      return entry;
    }
    case MSG.GET_STATE: {
      // The popup never needs the key itself, only whether one is configured.
      const stored = await getSettings();
      const llm = activeLlm(stored);
      const settings = { ...stored, providers: undefined };
      return {
        hasApiKey: Boolean(llm.apiKey),
        provider: llm.provider.id,
        providerLabel: llm.provider.label,
        model: llm.model,
        settings,
        portfolio: await getPortfolio(),
        snapshots: await getSnapshots(),
        decisions: (await getDecisions()).slice(0, 20),
        registry: await getRegistry(),
        healLog: (await getHealLog()).slice(0, 20),
      };
    }
    case MSG.RESET_SELECTORS:
      return { registry: await clearRegistry() };
    case MSG.TEST_PROVIDER: {
      // Runs from the worker, with the real client — the same path a repair
      // takes. The payload lets the options page test a key before saving it.
      const settings = await getSettings();
      const payload = message.payload || {};
      const definition = providerFor(payload.provider || settings.provider);
      const stored = (settings.providers && settings.providers[definition.id]) || {};
      const apiKey = String(payload.apiKey || stored.apiKey || '').trim();
      const model = String(payload.model || stored.model || '').trim() || definition.defaultModel;
      const started = Date.now();
      const probe = await pingProvider({ provider: definition.id, model, apiKey });
      return { provider: definition.id, label: definition.label, model, ms: Date.now() - started, ...probe };
    }
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Offscreen traffic rides the same bus; leave it to the offscreen listener.
  if (!message || typeof message.type !== 'string' || message.target === OFFSCREEN_TARGET) return undefined;
  handleRequest(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true; // response is asynchronous
});
