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
  MSG, OFFSCREEN_TARGET, OFFSCREEN_PATH, FIELDS, SNIPPET_LIMIT, FIELD_LABELS, FIELD_PHRASES, HEALABLE_FIELDS,
  EXTERNAL_ALLOWED, REFRESH_FETCH_TIMEOUT_MS, REFRESH_TAB_TIMEOUT_MS, REFRESH_GAP_MS,
  REFRESH_BRIDGE_TIMEOUT_MS, BRIDGE_PROBE_TIMEOUT_MS, BRIGHTDATA_MODES,
  MONITOR_ALARM, MIN_MONITOR_MINUTES, MAX_MONITOR_MINUTES, DASHBOARD_PATH, WELCOME_PATH,
} from './lib/constants.js';
import { normalizeBridgeUrl, bridgeRoutes, bridgeOriginPattern, BRIDGE_PROTOCOL } from './lib/brightdata.js';
import { candidatesFor, isPlausibleSelector } from './lib/selectors.js';
import { buildSnapshot, isUsableSnapshot, valueFitsField, tickerFromUrl, fragmentMentions } from './lib/normalize.js';
import { findStuckPrice } from './lib/verify.js';
import { activeLlm, providerFor } from './lib/providers.js';
import { heuristicAdvice, validateAdvice, buildAdvisoryContext } from './lib/advisor.js';
import { healSelector, requestAdvice, LlmError, pingProvider, humanizeLlmError } from './lib/llm.js';
import {
  getSettings, getPortfolio, getRegistry, recordHealedSelector, clearRegistry, forgetHealedSelector,
  saveSnapshot, getSnapshots, recordDecision, getDecisions, recordHealEvent, getHealLog, mergeHealedRegistry,
  recordPricePoint, getPriceHistory, savePosition,
  getWatchlist, saveWatchEntry, removeWatchEntry, seedWatchlistFromSnapshots,
  getAlertRules, saveAlertRule, applyRuleUpdates, deleteAlertRule, deleteAlertRulesFor,
  getAlerts, recordAlerts, markAlertsSeen, clearAlerts, countUnseenAlerts, saveSettings,
} from './lib/storage.js';
import { suggestTargets } from './lib/targets.js';
import { evaluateRules, normalizeRule, defaultRulesFor } from './lib/alerts.js';

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

const tickerOf = (value) => String(value || '').trim().toUpperCase() || null;

/** Empty string and undefined mean "not set", which is not the same as zero. */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Where to look up a ticker the user typed rather than scanned.
 *
 * stockanalysis.com renders its quotes server-side and is already in the
 * shipped selector registry, so it is the one default that works without a
 * browser tab having to render the page first.
 */
function defaultQuoteUrl(ticker) {
  return `https://stockanalysis.com/stocks/${encodeURIComponent(String(ticker).toLowerCase())}/`;
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
 * Thrown when retrying would be pointless: the answer will not change.
 *
 * `kind` separates "we have nothing to send" from "the model says the metric is
 * absent" — the second is a claim about a fragment we are holding, and so is
 * checkable.
 */
class TerminalHealError extends Error {
  constructor(message, { kind = 'terminal' } = {}) {
    super(message);
    this.kind = kind;
  }
}

const labelFor = (field) => FIELD_LABELS[field] || field;
const phraseFor = (field) => FIELD_PHRASES[field] || field;

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
    throw new TerminalHealError(proposal.reason || 'model reported the metric is not in the snippet', { kind: 'absent' });
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
      if (error instanceof LlmError) break;
      if (error instanceof TerminalHealError) {
        // "It is not in there" is normally final — asking again cannot conjure
        // an absent value. But it is a claim, and the fragment is right here:
        // when it plainly holds a value of the right shape the claim is wrong,
        // and giving up on it loses a repair that was available.
        const evidence = error.kind === 'absent' ? fragmentMentions(field, snippetHtml) : null;
        if (!evidence || attempt >= MAX_HEAL_ATTEMPTS) break;
        feedback = `You said the metric is absent, but the fragment contains "${evidence}", `
          + `which looks like a ${field}. Find the element holding it.`;
        continue;
      }
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

  // The ticker in the URL is the most reliable thing we know about the page
  // before reading it, and the content script uses it to tell this instrument's
  // quote apart from the other instruments a page happens to list.
  let anchorText = tickerFromUrl(tab.url);

  let result = await sendToTab(tab.id, {
    type: MSG.EXTRACT,
    payload: { candidates, snippetLimit: SNIPPET_LIMIT, anchorText },
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
      payload: { candidates: hostCandidates, snippetLimit: SNIPPET_LIMIT, anchorText },
    });
    if (retry && retry.ok) {
      result = retry;
      candidateMap = hostCandidates;
    }
  }

  anchorText = anchorText || tickerFromUrl(result.url);

  const raw = { ...result.raw };
  const used = { ...result.used };
  const healed = [];
  const warnings = [];
  // Notices are not failures: they record what this page simply does not show.
  const notices = [];
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
        payload: { candidates: { [field]: remaining }, snippetLimit: SNIPPET_LIMIT, anchorText },
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
      payload: { field, snippetLimit: SNIPPET_LIMIT, anchorText },
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
  // Not every miss is a fault worth a model call.
  //
  //   - The URL usually names the instrument, so a ticker the DOM withheld is
  //     already recovered and there is nothing to repair.
  //   - An empty container means the content script found no text of that shape
  //     anywhere on the page. Plenty of quote pages carry no volume and no
  //     headlines; asking the model can only cost a call to be told the same.
  const urlTicker = tickerFromUrl(result.url) || anchorText;
  const repairable = [];
  for (const failure of failures) {
    if (failure.field === 'ticker' && urlTicker) continue;
    if (!HEALABLE_FIELDS.includes(failure.field) || !failure.snippet) {
      notices.push(`This page does not show ${phraseFor(failure.field)}.`);
      continue;
    }
    repairable.push(failure);
  }

  if (repairable.length && settings.selfHealEnabled && activeLlm(settings).apiKey) {
    try {
      // Heal sequentially: each call is a separate LLM round trip and the
      // failures are usually correlated (one layout change breaks several).
      for (const failure of repairable) {
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
          // The raw provider text is kept in the repair log; the banner gets
          // the version a person can act on.
          const why = humanizeLlmError(outcome.error, activeLlm(settings).provider.label);
          warnings.push(`Could not repair the ${labelFor(failure.field)}: ${why}`);
        }
      }
    } finally {
      // The parser is only needed while repairs are running; MV3 allows one
      // offscreen document per extension, so hand it back.
      await closeOffscreen();
    }
  } else if (repairable.length) {
    const reason = !activeLlm(settings).apiKey
      ? 'automatic repair needs an API key'
      : 'automatic repair is switched off';
    for (const failure of repairable) {
      warnings.push(failure.mismatch
        ? `Ignored the ${labelFor(failure.field)}: the page returned "${failure.mismatch}" (${reason}).`
        : `Could not read the ${labelFor(failure.field)} (${reason}).`);
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

  // A repaired selector can resolve, hold a number of exactly the right shape,
  // and still be reading something that belongs to the page rather than to the
  // instrument — an index tile in a market-summary rail is the classic case.
  // Nothing about one scan gives that away; two do, because every ticker on the
  // host reports the identical figure. When that happens the price is dropped
  // and the selector behind it is forgotten, so the next scan repairs it again
  // instead of serving the same wrong number forever.
  const stuck = findStuckPrice({ snapshot, snapshots: await getSnapshots() });
  if (stuck) {
    const wasHealed = used.price && used.price.source === 'healed';
    if (wasHealed) await forgetHealedSelector(stuck.host, 'price');
    warnings.push(
      `Discarded the price: ${stuck.host} reported the same ${stuck.price} for ${snapshot.ticker} `
      + `and for ${stuck.ticker}, so it is a figure belonging to the page, not to this stock`
      + `${wasHealed ? ' — the repaired selector has been reset' : ''}.`
    );
    snapshot.current_price = null;
    delete snapshot.selectors_used.price_selector;
  }

  let targets = null;
  if (isUsableSnapshot(snapshot)) {
    await saveSnapshot(snapshot);
    // Every usable scan is one more data point the target suggester can average
    // over, so record it before recomputing anything from it.
    await recordPricePoint(snapshot);
    // Scanning a ticker is the clearest statement of interest there is, so it
    // is also what puts it on the dashboard. The URL is recorded with it
    // because that is the page a later refresh has to go back to.
    await saveWatchEntry(snapshot.ticker, {
      source_url: snapshot.source_url,
      last_refreshed_at: snapshot.extracted_at,
      last_method: 'tab',
      last_error: null,
    });
    targets = await refreshAutoTargets(snapshot);
  } else if (!stuck) {
    // Name what was actually missing: "could not read both" is wrong half the
    // time, and the half it is wrong about is the half the user can act on.
    const missing = [];
    if (!snapshot.ticker) missing.push(labelFor('ticker'));
    if (!Number.isFinite(snapshot.current_price)) missing.push(labelFor('price'));
    warnings.push(`Could not read the ${missing.join(' or the ')} on this page, so nothing was saved.`);
  }

  return {
    snapshot,
    usable: isUsableSnapshot(snapshot),
    healed,
    targets,
    warnings,
    notices,
    failedFields: failures.map((failure) => failure.field),
    host: result.host || host,
    title: result.title,
  };
}

/**
 * Recomputes targets for a ticker the user has put on automatic.
 *
 * Opt-in per position, because silently rewriting someone's own thresholds
 * would be the opposite of keeping them in charge. Returns what it wrote, or
 * null when the position is manual or there is nothing to anchor on.
 */
async function refreshAutoTargets(snapshot) {
  const portfolio = await getPortfolio();
  const position = portfolio[snapshot.ticker];
  if (!position || !position.auto_targets) return null;

  const suggestion = suggestTargets({
    snapshot,
    history: await getPriceHistory(snapshot.ticker),
    position,
    decisions: await getDecisions(),
  });
  if (!suggestion) return null;

  await savePosition(snapshot.ticker, {
    target_buy_below: suggestion.target_buy_below,
    target_sell_above: suggestion.target_sell_above,
    targets_updated_at: new Date().toISOString(),
  });
  return { ...suggestion, applied: true };
}

/* ------------------------------------------------------------------ *
 * Background refresh
 *
 * Re-reads a quote page the user is not looking at. Two ways, in order of how
 * much they cost:
 *
 *   1. fetch the page and run the selectors over the served HTML. Silent, fast,
 *      and no tab appears. It only works on a server-rendered quote page --
 *      plenty of finance sites paint the price with JavaScript and serve HTML
 *      that does not contain it anywhere.
 *
 *   2. open the page in a background tab and run the real content script in it.
 *      Slower, and briefly visible in the tab strip, but it is a real render, so
 *      it works everywhere the popup does -- including the self-healing path.
 *
 * Neither runs without the user having granted access to that origin, which is
 * asked for one host at a time, from a gesture, and can be taken back.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The Bright Data bridge
 *
 * Bright Data's Scraping Browser is a remote Chrome addressed over CDP at
 *
 *     wss://brd-customer-<id>-zone-<zone>:<password>@brd.superproxy.io:9222
 *
 * and this worker cannot open that socket. The HTML standard requires the
 * `WebSocket` constructor to throw a SyntaxError when the URL includes
 * credentials, Chrome implements exactly that, and the API exposes no headers
 * to carry the auth some other way. So the session lives in the Node agent
 * under `agent/`, and the worker talks to it over loopback HTTP.
 *
 * What comes back is a finished snapshot built by the same `normalize.js` this
 * file uses, plus whatever selectors the agent had to repair to produce it —
 * which are merged straight into the registry, so a repair made out there is
 * one the popup already has the next time the user scans that host.
 * ------------------------------------------------------------------ */

/** Resolves the bridge configuration, or explains why there is not one. */
export function bridgeSettings(settings) {
  const stored = (settings && settings.brightdata) || {};
  const mode = BRIGHTDATA_MODES.includes(stored.mode) ? stored.mode : 'fallback';
  const normalized = normalizeBridgeUrl(stored.bridgeUrl);
  if (!normalized.ok) {
    return { enabled: false, mode, token: '', origin: null, routes: null, error: normalized.error };
  }
  return {
    enabled: stored.enabled === true,
    mode,
    token: (stored.token || '').trim(),
    origin: normalized.url,
    routes: bridgeRoutes(normalized.url),
    error: null,
  };
}

/** True when the user has granted the worker access to the bridge's origin. */
export async function hasBridgeAccess(bridge) {
  const origin = bridge && bridge.origin && bridgeOriginPattern(bridge.origin);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * One request to the agent.
 *
 * Every failure mode is turned into a sentence naming the agent, because the
 * overwhelmingly likely cause is that it is not running — and "Failed to fetch"
 * does not say so.
 */
async function callBridge(bridge, url, { method = 'GET', body = null, timeoutMs = BRIDGE_PROBE_TIMEOUT_MS } = {}) {
  if (!bridge.origin) throw new Error(bridge.error || 'No bridge address configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { accept: 'application/json' };
  if (bridge.token) headers['x-bridge-token'] = bridge.token;
  if (body) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || controller.signal.aborted);
    throw new Error(aborted
      ? `The Bright Data agent did not answer within ${Math.round(timeoutMs / 1000)}s.`
      : `Could not reach the Bright Data agent at ${bridge.origin}. Start it with \`npm run agent\`.`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (response.status === 401) throw new Error('The Bright Data agent rejected the bridge token.');
  if (!response.ok) {
    throw new Error((parsed && parsed.error) || `The Bright Data agent returned HTTP ${response.status}.`);
  }
  if (!parsed) throw new Error('The Bright Data agent returned a non-JSON body.');
  return parsed;
}

/** Reads `/health`: what the agent is configured with, and whether it can heal. */
export async function probeBridge(settings) {
  const bridge = bridgeSettings(settings);
  if (!bridge.origin) return { ok: false, error: bridge.error || 'No bridge address configured.' };
  if (!(await hasBridgeAccess(bridge))) {
    return {
      ok: false,
      needsPermission: bridgeOriginPattern(bridge.origin),
      error: `Access to ${bridge.origin} has not been granted yet.`,
    };
  }
  const health = await callBridge(bridge, bridge.routes.health);
  if (health.protocol !== BRIDGE_PROTOCOL) {
    return {
      ok: false,
      error: `The agent speaks bridge protocol ${health.protocol}, this extension speaks ${BRIDGE_PROTOCOL}. Update whichever is older.`,
      health,
    };
  }
  return { ok: health.ok === true, health, error: health.ok === true ? null : (health.brightdata && health.brightdata.error) || 'The agent is running but Bright Data is not configured.' };
}

/**
 * Asks the agent to read one quote page through the Scraping Browser.
 *
 * The extension's own healed selectors go out with the request and the agent's
 * come back with the answer, so neither side has to be the one that repaired a
 * field for both to benefit from it.
 */
async function bridgeScrape(bridge, { url, ticker, selfHeal = true }) {
  const result = await callBridge(bridge, bridge.routes.scrape, {
    method: 'POST',
    timeoutMs: REFRESH_BRIDGE_TIMEOUT_MS,
    body: { url, ticker, selfHeal, registry: await getRegistry() },
  });
  if (result && result.registry) {
    const { merged } = await mergeHealedRegistry(result.registry);
    if (merged) result.merged_selectors = merged;
  }
  for (const entry of (result && result.healed) || []) {
    await recordHealEvent({
      field: entry.field,
      host: result.host || hostOf(url),
      at: new Date().toISOString(),
      healed: true,
      via: 'brightdata',
      proposed: entry.selector,
      strategy: entry.strategy,
    });
  }
  return result;
}

/** The `https://host/*` pattern one URL needs permission for. */
export function originPatternFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

async function hasOriginAccess(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/** `fetch` with a deadline, so one unresponsive host cannot stall a pass. */
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
    if (!response.ok) throw new Error(`the page returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the candidate map over fetched HTML, in the offscreen document. */
async function extractFromHtml(html, candidates) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: MSG.EXTRACT_HTML,
    payload: { html, candidates },
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || 'the offscreen parser returned no result');
  }
  return response;
}

/** Resolves once the tab finishes loading, or rejects on the deadline. */
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(null);
    };
    const timer = setTimeout(() => finish(new Error('the page took too long to load')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // The tab may already have finished before the listener was attached.
    chrome.tabs.get(tabId)
      .then((tab) => { if (tab && tab.status === 'complete') finish(null); })
      .catch(() => finish(new Error('the tab went away')));
  });
}

/**
 * Opens the page in an inactive tab, extracts, and always closes the tab again.
 *
 * `active: false` keeps the user where they were. The close runs in a `finally`
 * because a tab left behind by a failed refresh is the kind of litter that
 * accumulates silently over a day of monitoring.
 */
async function extractFromTab(url, candidates, anchorText) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, REFRESH_TAB_TIMEOUT_MS);
    await ensureContentScript(tab.id);
    const result = await sendToTab(tab.id, {
      type: MSG.EXTRACT,
      payload: { candidates, snippetLimit: SNIPPET_LIMIT, anchorText },
    });
    if (!result || !result.ok) throw new Error((result && result.error) || 'the page did not answer');
    return result;
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // Already gone, or the window closed underneath us. Nothing to clean up.
    }
  }
}

/** Records a failed refresh on the entry and returns the failure. */
async function refreshFailed(symbol, error, extra = {}) {
  await saveWatchEntry(symbol, {
    last_error: error,
    last_refreshed_at: new Date().toISOString(),
    ...extra,
  });
  return { ticker: symbol, ok: false, error, ...extra };
}

/**
 * Refreshes one watched ticker and records what it found.
 *
 * Never throws: a pass over a watchlist must not stop because one host is down.
 * The failure is written to the watchlist entry, where the dashboard shows it
 * on that ticker's card.
 */
export async function refreshTicker(ticker, { allowTab = true } = {}) {
  const symbol = tickerOf(ticker);
  const watchlist = await getWatchlist();
  const entry = watchlist[symbol];
  if (!entry) return { ticker: symbol, ok: false, error: `${symbol} is not on the watchlist.` };

  const url = entry.source_url;
  if (!url || !isScrapableUrl(url)) {
    return refreshFailed(symbol, 'No quote page URL is stored for this ticker.');
  }

  const settings = await getSettings();
  const bridge = bridgeSettings(settings);
  const bridgeReady = bridge.enabled && (await hasBridgeAccess(bridge));

  // Two different permissions are in play, and they are not interchangeable.
  // The local routes read the quote page from this browser, so they need the
  // quote host. The Bright Data route never touches it — the agent's remote
  // browser does — so it needs the bridge origin instead, and a host the user
  // has not granted is still readable that way.
  const localAllowed = await hasOriginAccess(url);
  if (!localAllowed && !bridgeReady) {
    const origin = originPatternFor(url);
    return refreshFailed(symbol, `Access to ${hostOf(url)} has not been granted.`, { needs_permission: origin });
  }

  const registry = await getRegistry();
  const candidates = await buildCandidateMap(hostOf(url), registry);
  const anchorText = tickerFromUrl(url) || symbol;

  let result = null;
  let snapshot = null;
  let method = null;
  let healed = [];
  const notes = [];

  /** The cheap path: no tab, no render, no third party. */
  const tryFetch = async () => {
    if (!localAllowed) {
      notes.push(`fetch skipped (access to ${hostOf(url)} has not been granted)`);
      return;
    }
    try {
      const html = await fetchWithTimeout(url, REFRESH_FETCH_TIMEOUT_MS);
      const extracted = await extractFromHtml(html, candidates);
      if (valueFitsField('price', extracted.raw.price)) {
        result = extracted;
        method = 'fetch';
      } else {
        notes.push('the served HTML carried no price');
      }
    } catch (error) {
      notes.push(`fetch failed (${String((error && error.message) || error)})`);
    } finally {
      await closeOffscreen();
    }
  };

  /** Bright Data: a real remote browser, and the self-healing loop with it. */
  const tryBridge = async () => {
    if (!bridgeReady) {
      if (bridge.enabled) notes.push(`Bright Data skipped (access to ${bridge.origin || 'the agent'} has not been granted)`);
      return;
    }
    try {
      const answer = await bridgeScrape(bridge, { url, ticker: symbol, selfHeal: settings.selfHealEnabled !== false });
      if (answer && answer.ok && answer.snapshot) {
        snapshot = answer.snapshot;
        method = 'brightdata';
        healed = answer.healed || [];
        for (const warning of answer.warnings || []) notes.push(warning);
      } else {
        notes.push(`Bright Data could not read the page (${(answer && answer.error) || 'no reason given'})`);
      }
    } catch (error) {
      notes.push(`Bright Data failed (${String((error && error.message) || error)})`);
    }
  };

  /** The local render, for pages that paint their price with JavaScript. */
  const tryTab = async () => {
    if (!allowTab || !localAllowed) return;
    try {
      result = await extractFromTab(url, candidates, anchorText);
      method = 'tab';
    } catch (error) {
      notes.push(`opening the page failed (${String((error && error.message) || error)})`);
    }
  };

  // `mode` is the user's call on how much of their Bright Data plan a routine
  // refresh may spend: last resort, first choice, or the only route allowed.
  const order = !bridge.enabled ? [tryFetch, tryTab]
    : bridge.mode === 'only' ? [tryBridge]
      : bridge.mode === 'first' ? [tryBridge, tryFetch, tryTab]
        : [tryFetch, tryBridge, tryTab];

  for (const attempt of order) {
    if (result || snapshot) break;
    await attempt();
  }

  if (!result && !snapshot) return refreshFailed(symbol, notes.join('; ') || 'the page could not be read');

  if (!snapshot) {
    const selectorsUsed = {};
    for (const [field, used] of Object.entries(result.used || {})) {
      selectorsUsed[`${field}_selector`] = used.selector;
    }
    snapshot = buildSnapshot(result.raw, { source_url: url, selectors_used: selectorsUsed });
  }

  // A price read off the wrong page is worse than no reading at all: it would be
  // filed under this symbol and charted as its history.
  if (snapshot.ticker && snapshot.ticker !== symbol) {
    return refreshFailed(symbol, `that page reported ${snapshot.ticker}, not ${symbol}`);
  }
  snapshot.ticker = symbol;

  if (!isUsableSnapshot(snapshot)) {
    return refreshFailed(symbol, 'no price could be read from that page');
  }

  // The same page-global-price check the interactive scrape runs.
  const stuck = findStuckPrice({ snapshot, snapshots: await getSnapshots() });
  if (stuck) {
    return refreshFailed(symbol, `${stuck.host} reports the same ${stuck.price} for ${symbol} and ${stuck.ticker}`);
  }

  const previous = (await getSnapshots())[symbol] || null;
  await saveSnapshot(snapshot);
  await recordPricePoint(snapshot);
  await refreshAutoTargets(snapshot);
  await saveWatchEntry(symbol, {
    last_refreshed_at: snapshot.extracted_at,
    last_method: method,
    last_error: null,
    needs_permission: null,
  });

  return { ticker: symbol, ok: true, method, snapshot, previous, notes, healed };
}

/**
 * Refreshes every monitored ticker, one at a time.
 *
 * Sequential and spaced out on purpose. A watchlist of twenty tickers fired in
 * parallel is twenty simultaneous requests to a handful of finance sites, which
 * is both rude and the fastest way to be rate-limited.
 */
export async function refreshAll({ onlyMonitored = true } = {}) {
  const watchlist = await getWatchlist();
  const tickers = Object.keys(watchlist)
    .filter((ticker) => (onlyMonitored ? watchlist[ticker].monitor !== false : true))
    .sort();

  const results = [];
  for (const [index, ticker] of tickers.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, REFRESH_GAP_MS));
    results.push(await refreshTicker(ticker));
  }
  return {
    refreshed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

/* ------------------------------------------------------------------ *
 * Alerts and the monitor loop
 *
 * The part of this that runs with nobody watching. A `chrome.alarms` tick wakes
 * the worker, refreshes what is being monitored, evaluates the rules against
 * each new reading, and raises anything that fired on three channels at once:
 * an OS notification, the toolbar badge, and the stored feed the dashboard
 * renders. The three are deliberate — a notification can be suppressed by the
 * operating system without telling anyone, so it is never the only record.
 * ------------------------------------------------------------------ */

/** Keeps the toolbar badge showing how many alerts have not been looked at. */
async function refreshBadge() {
  const unseen = await countUnseenAlerts();
  try {
    await chrome.action.setBadgeText({ text: unseen ? String(Math.min(unseen, 99)) : '' });
    if (unseen) await chrome.action.setBadgeBackgroundColor({ color: '#b4532c' });
  } catch {
    // Badge support is not worth failing a monitor pass over.
  }
}

/**
 * Raises one alert as an OS notification.
 *
 * The notification id is the alert id, so clicking it can find the alert again,
 * and a repeat of the same alert replaces rather than stacks.
 */
async function notify(alert) {
  try {
    await chrome.notifications.create(alert.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('src/icons/icon128.png'),
      title: alert.title,
      message: alert.body,
      contextMessage: 'Recommendation only — you decide.',
      priority: 1,
    });
  } catch (error) {
    // Focus Assist, Do Not Disturb, or a platform without notifications. The
    // badge and the stored feed still carry it, which is why they exist.
    console.warn('[market-scraper] could not raise a notification:', error);
  }
}

/**
 * The advisory an advice_flip rule compares against.
 *
 * Uses the free local rules engine unless the user has explicitly opted into
 * spending a model call per ticker per pass. A monitor loop is the one place
 * where an LLM call is charged on a timer rather than on a click.
 */
async function verdictFor(snapshot, settings, position) {
  if (!settings.alertsUseLlm) return heuristicAdvice(snapshot, position);
  try {
    return await adviseOn(snapshot);
  } catch {
    return heuristicAdvice(snapshot, position);
  }
}

/**
 * Evaluates one ticker's rules against a fresh reading and raises what fired.
 *
 * Exported so a test can drive it without an alarm.
 */
export async function evaluateAlertsFor(ticker, { snapshot, previous }) {
  const rules = await getAlertRules(ticker);
  if (!rules.length) return [];

  const settings = await getSettings();
  const portfolio = await getPortfolio();
  const position = portfolio[ticker] || null;

  // Only pay for a verdict when a rule actually asks for one.
  const wantsAdvice = rules.some((rule) => rule.kind === 'advice_flip' && rule.enabled !== false);
  const advice = wantsAdvice ? await verdictFor(snapshot, settings, position || {}) : null;

  const { alerts, updates } = evaluateRules({
    rules,
    snapshot,
    previous,
    position,
    history: await getPriceHistory(ticker),
    advice,
  });

  await applyRuleUpdates(updates);
  if (!alerts.length) return [];

  await recordAlerts(alerts);
  for (const alert of alerts) await notify(alert);
  await refreshBadge();
  return alerts;
}

/**
 * One monitor pass: refresh everything monitored, then evaluate its rules.
 *
 * Rules are evaluated only for tickers whose refresh actually produced a new
 * reading. Evaluating against a stale snapshot would re-fire on a crossing that
 * happened hours ago.
 */
export async function runMonitorPass() {
  const settings = await getSettings();
  if (!settings.monitorEnabled) return { skipped: 'monitoring is off' };

  const summary = await refreshAll({ onlyMonitored: true });
  const raised = [];
  for (const result of summary.results) {
    if (!result.ok) continue;
    raised.push(...await evaluateAlertsFor(result.ticker, result));
  }
  return { ...summary, alerts: raised.length };
}

/**
 * Puts the monitor alarm in step with the settings.
 *
 * Chrome will not fire an alarm more than once a minute, and an interval longer
 * than a day is indistinguishable from off, so the stored value is clamped
 * rather than trusted.
 */
export async function syncMonitorAlarm(settings = null) {
  const current = settings || await getSettings();
  try {
    await chrome.alarms.clear(MONITOR_ALARM);
    if (!current.monitorEnabled) return { scheduled: false };
    const minutes = Math.min(
      MAX_MONITOR_MINUTES,
      Math.max(MIN_MONITOR_MINUTES, Number(current.monitorIntervalMinutes) || 15)
    );
    await chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: minutes, delayInMinutes: minutes });
    return { scheduled: true, minutes };
  } catch (error) {
    console.warn('[market-scraper] could not schedule the monitor alarm:', error);
    return { scheduled: false, error: String((error && error.message) || error) };
  }
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
    const why = humanizeLlmError(message, llm.provider.label);
    return { ...fallback, note: `${why} Showing the rules-based signal instead.` };
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
    case MSG.GET_DASHBOARD_STATE: {
      // One round trip for the whole dashboard. The popup's GET_STATE is left
      // alone: it deliberately returns less, and the popup does not need more.
      await seedWatchlistFromSnapshots();
      const stored = await getSettings();
      const llm = activeLlm(stored);
      return {
        // Never the key itself, on any transport — and this one can be a web page.
        hasApiKey: Boolean(llm.apiKey),
        provider: llm.provider.id,
        providerLabel: llm.provider.label,
        model: llm.model,
        settings: {
          selfHealEnabled: stored.selfHealEnabled,
          llmAdviceEnabled: stored.llmAdviceEnabled,
          dashboardOrigin: stored.dashboardOrigin,
          monitorEnabled: stored.monitorEnabled,
          monitorIntervalMinutes: stored.monitorIntervalMinutes,
          alertsUseLlm: stored.alertsUseLlm,
        },
        watchlist: await getWatchlist(),
        alertRules: await getAlertRules(),
        alerts: await getAlerts(),
        snapshots: await getSnapshots(),
        portfolio: await getPortfolio(),
        priceHistory: await getPriceHistory(),
        decisions: await getDecisions(),
        healLog: (await getHealLog()).slice(0, 20),
        generated_at: new Date().toISOString(),
      };
    }
    case MSG.GET_PRICE_HISTORY: {
      const ticker = tickerOf(message.payload && message.payload.ticker);
      return { ticker, history: await getPriceHistory(ticker) };
    }
    case MSG.ADD_WATCH: {
      const payload = message.payload || {};
      const ticker = tickerOf(payload.ticker);
      if (!ticker) throw new Error('No ticker supplied.');
      const sourceUrl = String(payload.source_url || '').trim();
      if (sourceUrl && !isScrapableUrl(sourceUrl)) {
        throw new Error('That is not an http(s) quote page URL.');
      }
      const entry = await saveWatchEntry(ticker, {
        source_url: sourceUrl || defaultQuoteUrl(ticker),
        monitor: payload.monitor !== false,
      });
      // A target rule costs nothing and does nothing until targets exist, so a
      // new ticker starts watched rather than starting silent.
      if (!(await getAlertRules(ticker)).length) {
        for (const rule of defaultRulesFor(ticker)) await saveAlertRule(rule);
      }
      return { entry, rules: await getAlertRules(), watchlist: await getWatchlist() };
    }
    case MSG.REMOVE_WATCH: {
      const ticker = tickerOf(message.payload && message.payload.ticker);
      if (!ticker) throw new Error('No ticker supplied.');
      const removed = await removeWatchEntry(ticker);
      // Rules for a ticker nobody watches would fire on nothing forever.
      await deleteAlertRulesFor(ticker);
      return { removed, watchlist: await getWatchlist(), rules: await getAlertRules() };
    }
    case MSG.SET_WATCH_MONITOR: {
      const payload = message.payload || {};
      const ticker = tickerOf(payload.ticker);
      if (!ticker) throw new Error('No ticker supplied.');
      const watchlist = await getWatchlist();
      if (!watchlist[ticker]) throw new Error(`${ticker} is not on the watchlist.`);
      const entry = await saveWatchEntry(ticker, { monitor: Boolean(payload.monitor) });
      return { entry, watchlist: await getWatchlist() };
    }
    case MSG.REFRESH_TICKER: {
      const ticker = tickerOf(message.payload && message.payload.ticker);
      if (!ticker) throw new Error('No ticker supplied.');
      return refreshTicker(ticker);
    }
    case MSG.REFRESH_ALL:
      return refreshAll({ onlyMonitored: !(message.payload && message.payload.includePaused) });
    case MSG.GET_HOST_ACCESS: {
      // Which of the watched hosts the extension may actually read. The
      // dashboard uses this to show what still needs granting; it cannot do the
      // granting itself, because that needs a gesture on an extension page.
      const watchlist = await getWatchlist();
      const hosts = {};
      for (const entry of Object.values(watchlist)) {
        const origin = originPatternFor(entry.source_url);
        if (!origin || origin in hosts) continue;
        hosts[origin] = await hasOriginAccess(entry.source_url);
      }
      return { hosts };
    }
    case MSG.SAVE_ALERT_RULE: {
      const rule = normalizeRule(message.payload || {});
      if (!rule) throw new Error('That rule is incomplete — it could never fire.');
      await saveAlertRule(rule);
      return { rule, rules: await getAlertRules() };
    }
    case MSG.DELETE_ALERT_RULE: {
      const payload = message.payload || {};
      const ticker = tickerOf(payload.ticker);
      const removed = await deleteAlertRule(ticker, String(payload.id || ''));
      return { removed, rules: await getAlertRules() };
    }
    case MSG.MARK_ALERTS_SEEN: {
      const ids = (message.payload && message.payload.ids) || null;
      const alerts = await markAlertsSeen(ids);
      await refreshBadge();
      return { alerts };
    }
    case MSG.CLEAR_ALERTS: {
      const alerts = await clearAlerts();
      await refreshBadge();
      return { alerts };
    }
    case MSG.SET_MONITOR: {
      const payload = message.payload || {};
      const patch = {};
      if ('enabled' in payload) patch.monitorEnabled = Boolean(payload.enabled);
      if ('intervalMinutes' in payload) {
        const minutes = Number(payload.intervalMinutes);
        if (!Number.isFinite(minutes) || minutes < MIN_MONITOR_MINUTES) {
          throw new Error(`The interval must be at least ${MIN_MONITOR_MINUTES} minute.`);
        }
        patch.monitorIntervalMinutes = Math.min(MAX_MONITOR_MINUTES, Math.round(minutes));
      }
      const settings = await saveSettings(patch);
      const alarm = await syncMonitorAlarm(settings);
      return {
        monitorEnabled: settings.monitorEnabled,
        monitorIntervalMinutes: settings.monitorIntervalMinutes,
        ...alarm,
      };
    }
    case MSG.SAVE_POSITION: {
      const payload = message.payload || {};
      const ticker = tickerOf(payload.ticker);
      if (!ticker) throw new Error('No ticker supplied.');
      const position = {};
      for (const field of ['shares', 'avg_cost', 'target_buy_below', 'target_sell_above']) {
        if (field in payload) position[field] = numberOrNull(payload[field]);
      }
      if ('auto_targets' in payload) position.auto_targets = Boolean(payload.auto_targets);
      const portfolio = await savePosition(ticker, position);
      return { ticker, position: portfolio[ticker], portfolio };
    }
    case MSG.DELETE_POSITION: {
      const ticker = tickerOf(message.payload && message.payload.ticker);
      if (!ticker) throw new Error('No ticker supplied.');
      return { ticker, portfolio: await savePosition(ticker, null) };
    }
    case MSG.SUGGEST_TARGETS: {
      const ticker = String((message.payload && message.payload.ticker) || '').trim().toUpperCase();
      if (!ticker) throw new Error('No ticker supplied.');
      const portfolio = await getPortfolio();
      const suggestion = suggestTargets({
        ticker,
        snapshot: (await getSnapshots())[ticker] || null,
        history: await getPriceHistory(ticker),
        position: portfolio[ticker] || {},
        decisions: await getDecisions(),
      });
      if (!suggestion) {
        throw new Error(`Nothing to go on for ${ticker} yet — scan it once, or enter an average cost.`);
      }
      return suggestion;
    }
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
    case MSG.TEST_BRIDGE: {
      // Same shape as TEST_PROVIDER: the payload lets the options page check an
      // address and token before committing them to storage.
      const stored = await getSettings();
      const payload = message.payload || {};
      const settings = {
        ...stored,
        brightdata: {
          ...stored.brightdata,
          ...(payload.bridgeUrl === undefined ? {} : { bridgeUrl: payload.bridgeUrl }),
          ...(payload.token === undefined ? {} : { token: payload.token }),
        },
      };
      const started = Date.now();
      const probe = await probeBridge(settings);
      return { ...probe, ms: Date.now() - started, origin: bridgeSettings(settings).origin };
    }
    case MSG.SCRAPE_VIA_BRIDGE: {
      // An explicit, user-initiated read through the Scraping Browser. Unlike a
      // refresh it does not require the ticker to be on the watchlist already —
      // scraping something is the clearest statement of interest there is, so
      // it goes on the list the same way a tab scan does.
      const settings = await getSettings();
      const bridge = bridgeSettings(settings);
      if (!bridge.enabled) throw new Error('Bright Data is switched off in the extension options.');
      if (!(await hasBridgeAccess(bridge))) {
        const error = new Error(`Access to ${bridge.origin} has not been granted yet. Grant it on the options page.`);
        error.needsPermission = bridgeOriginPattern(bridge.origin);
        throw error;
      }
      const payload = message.payload || {};
      const symbol = tickerOf(payload.ticker);
      const url = String(payload.url || '').trim() || (symbol ? defaultQuoteUrl(symbol) : '');
      if (!url) throw new Error('A ticker or a quote page URL is required.');
      if (!isScrapableUrl(url)) throw new Error('That is not an http(s) quote page URL.');

      const answer = await bridgeScrape(bridge, {
        url,
        ticker: symbol,
        selfHeal: settings.selfHealEnabled !== false,
      });
      if (!answer || !answer.ok || !answer.snapshot) {
        throw new Error((answer && answer.error) || 'Bright Data could not read that page.');
      }
      const snapshot = answer.snapshot;
      if (symbol) snapshot.ticker = symbol;

      // Everything a tab scan records, recorded the same way — a snapshot read
      // through Bright Data is not a lesser reading.
      let targets = null;
      if (isUsableSnapshot(snapshot)) {
        await saveSnapshot(snapshot);
        await recordPricePoint(snapshot);
        await saveWatchEntry(snapshot.ticker, {
          source_url: snapshot.source_url || url,
          last_refreshed_at: snapshot.extracted_at,
          last_method: 'brightdata',
          last_error: null,
          needs_permission: null,
        });
        targets = await refreshAutoTargets(snapshot);
      }
      return {
        snapshot,
        usable: isUsableSnapshot(snapshot),
        method: 'brightdata',
        healed: answer.healed || [],
        warnings: answer.warnings || [],
        notices: answer.notices || [],
        captcha: answer.captcha || null,
        host: answer.host || hostOf(url),
        targets,
        duration_ms: answer.duration_ms || null,
      };
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

/* ------------------------------------------------------------------ *
 * Lifecycle listeners
 *
 * Registered at the top level, synchronously, because the worker is torn down
 * between events and only listeners attached during evaluation survive that.
 * ------------------------------------------------------------------ */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MONITOR_ALARM) return;
  runMonitorPass().catch((error) => {
    console.warn('[market-scraper] the monitor pass failed:', error);
  });
});

// A browser restart or an update clears alarms; re-arm from what was stored.
chrome.runtime.onStartup.addListener(() => { syncMonitorAlarm(); });
/**
 * A fresh install opens the setup guide once.
 *
 * Only on `install` — an update or a browser reload must not reopen it, and a
 * user who has already walked it (or skipped it) never sees it again, because
 * the guide itself sets `onboardingCompleted`. The tab is opened best-effort:
 * a failure here must not take the rest of the install listener down with it.
 */
chrome.runtime.onInstalled.addListener((details) => {
  syncMonitorAlarm();
  refreshBadge();
  if (!details || details.reason !== 'install') return;
  (async () => {
    const stored = await getSettings();
    if (stored.onboardingCompleted) return;
    await chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PATH) });
  })().catch((error) => console.warn('[market-scraper] could not open the setup guide:', error));
});

/**
 * Clicking a notification opens the dashboard at that ticker and marks the
 * alert seen — a notification acted on should not still be counted as unread.
 */
chrome.notifications.onClicked.addListener((notificationId) => {
  (async () => {
    const alert = (await getAlerts()).find((entry) => entry.id === notificationId);
    await markAlertsSeen([notificationId]);
    await refreshBadge();
    const url = chrome.runtime.getURL(
      alert ? `${DASHBOARD_PATH}?ticker=${encodeURIComponent(alert.ticker)}` : DASHBOARD_PATH
    );
    await chrome.tabs.create({ url });
    try {
      await chrome.notifications.clear(notificationId);
    } catch {
      // Already dismissed.
    }
  })().catch((error) => console.warn('[market-scraper] notification click failed:', error));
});

/* ------------------------------------------------------------------ *
 * External bus — the dashboard, when it is served as a real website
 * ------------------------------------------------------------------ */

const externalAllowed = new Set(EXTERNAL_ALLOWED);

/**
 * Resolves one request from a page on an `externally_connectable` origin.
 *
 * Chrome has already checked the sender against the manifest's match list by
 * the time this runs, so the job here is narrowing *what* such a page may ask
 * for. Anything outside `EXTERNAL_ALLOWED` is refused by name rather than
 * silently dropped, because a dashboard calling a message the extension will
 * never answer is a bug worth seeing.
 *
 * Exported so the test suite can drive the boundary directly.
 */
export async function handleExternalRequest(message) {
  if (!message || typeof message.type !== 'string') {
    throw new Error('Malformed request.');
  }
  if (!externalAllowed.has(message.type)) {
    throw new Error(`"${message.type}" is not available to the dashboard.`);
  }
  return handleRequest(message);
}

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  handleExternalRequest(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true; // response is asynchronous
});
