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
import { buildSnapshot, isUsableSnapshot } from './lib/normalize.js';
import { heuristicAdvice, validateAdvice, buildAdvisoryContext } from './lib/advisor.js';
import { healSelector, requestAdvice, LlmError } from './lib/llm.js';
import {
  getSettings, getPortfolio, getRegistry, recordHealedSelector, clearRegistry,
  saveSnapshot, getSnapshots, recordDecision, getDecisions, recordHealEvent, getHealLog,
} from './lib/storage.js';

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

/**
 * Attempts to repair one failed field: sanitize the container, ask the model
 * for a selector, validate it against the live DOM, then persist it.
 * Returns { healed, value, selector, ... } — never throws.
 */
async function healField({ tabId, host, field, snippet, tried, settings }) {
  const attempt = { field, host, at: new Date().toISOString(), healed: false };
  try {
    if (!snippet) throw new Error('no container HTML captured for this field');
    const cleaned = await sanitizeSnippet(snippet, settings.maxSnippetChars);
    if (!cleaned.html) throw new Error('sanitized container was empty');

    const proposal = await healSelector({
      field,
      host,
      snippet: cleaned.html,
      previousSelector: (tried || [])[0] || null,
      model: settings.model,
      apiKey: settings.apiKey,
    });
    attempt.proposed = proposal.selector;
    attempt.strategy = proposal.strategy;
    attempt.confidence = proposal.confidence;
    attempt.reason = proposal.reason;

    if (!isPlausibleSelector(proposal)) throw new Error(`model returned an unusable selector: ${proposal.selector}`);
    if (proposal.confidence <= 0) throw new Error(proposal.reason || 'model reported the metric is not in the snippet');

    // Re-attempt extraction in the live page — no reload required.
    const check = await sendToTab(tabId, {
      type: MSG.VALIDATE_SELECTOR,
      payload: { field, selector: proposal.selector, strategy: proposal.strategy },
    });
    if (!check || !check.ok) throw new Error((check && check.error) || 'validation in the page failed');

    const stored = await recordHealedSelector(host, field, proposal);
    attempt.healed = true;
    attempt.value = check.value;
    await recordHealEvent(attempt);
    return { healed: true, field, value: check.value, used: { ...stored, source: 'healed' } };
  } catch (error) {
    attempt.error = error instanceof LlmError ? error.message : String((error && error.message) || error);
    await recordHealEvent(attempt);
    return { healed: false, field, error: attempt.error };
  }
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
  if (!host && result.host) {
    const retry = await sendToTab(tab.id, {
      type: MSG.EXTRACT,
      payload: { candidates: await buildCandidateMap(result.host, registry), snippetLimit: SNIPPET_LIMIT },
    });
    if (retry && retry.ok) result = retry;
  }

  const raw = { ...result.raw };
  const used = { ...result.used };
  const healed = [];
  const warnings = [];

  const failures = result.failures || [];
  if (failures.length && settings.selfHealEnabled && settings.apiKey) {
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
    const reason = !settings.apiKey ? 'no API key configured' : 'self-healing is disabled in options';
    for (const failure of failures) warnings.push(`Missing "${failure.field}" (${reason}).`);
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

  if (!settings.llmAdviceEnabled || !settings.apiKey) {
    return {
      ...fallback,
      note: settings.apiKey ? 'LLM advice is disabled in options.' : 'No API key configured — showing the rules-based signal.',
    };
  }

  try {
    const parsed = await requestAdvice({
      context: buildAdvisoryContext(snapshot, position),
      model: settings.model,
      apiKey: settings.apiKey,
    });
    const advice = validateAdvice(parsed, snapshot.ticker);
    if (!advice) throw new Error('the model returned an advisory that failed schema validation');
    return { ...advice, source: 'llm', model: settings.model, generated_at: new Date().toISOString() };
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
      const { apiKey, ...settings } = await getSettings();
      return {
        hasApiKey: Boolean(apiKey),
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
