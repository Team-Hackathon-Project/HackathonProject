/**
 * The self-healing extraction loop, with the page held at arm's length.
 *
 * This is the same pipeline `scrapeActiveTab()` runs in `src/background.js` —
 * extract, step past junk matches, capture a container, ask the model, validate
 * the answer *in the live page*, persist only what survives — expressed against
 * a three-method driver instead of `chrome.tabs.sendMessage`:
 *
 *   driver.extract({ candidates, snippetLimit, anchorText })
 *   driver.validate({ field, selector, strategy })
 *   driver.capture({ field, snippetLimit, anchorText })
 *
 * Those are exactly the three messages `src/content.js` answers, so the Bright
 * Data driver is a thin `page.evaluate` wrapper around the extension's own
 * content script running inside the remote browser (see `brightdata.mjs`), and
 * the test driver is the same script in jsdom. There is no second extractor and
 * no second healing policy: a repair proven here is a repair the popup would
 * have made, and vice versa.
 */
import {
  FIELDS, SNIPPET_LIMIT, HEALABLE_FIELDS, FIELD_LABELS, FIELD_PHRASES,
} from '../src/lib/constants.js';
import { candidatesFor, isPlausibleSelector } from '../src/lib/selectors.js';
import { buildSnapshot, isUsableSnapshot, valueFitsField, tickerFromUrl } from '../src/lib/normalize.js';
import { findStuckPrice } from '../src/lib/verify.js';
import { healSelector, LlmError, humanizeLlmError } from '../src/lib/llm.js';
import { providerFor } from '../src/lib/providers.js';

/** How far down the candidate list one bad match may push us. */
const MAX_CANDIDATE_RETRIES = 4;

/** How many times one field may be sent back to the model before giving up. */
const MAX_HEAL_ATTEMPTS = 2;

const labelFor = (field) => FIELD_LABELS[field] || field;
const phraseFor = (field) => FIELD_PHRASES[field] || field;

/** Thrown when retrying would be pointless: the answer will not change. */
class TerminalHealError extends Error {}

export function buildCandidateMap(host, registry = {}) {
  const map = {};
  for (const field of FIELDS) map[field] = candidatesFor(host, field, registry);
  return map;
}

/**
 * One repair round trip: ask, sanity-check, validate in the live page, persist.
 * Throws on failure so the caller can decide whether another attempt is worth
 * making. `feedback` carries the previous attempt's rejection back to the model.
 */
async function attemptHeal({ driver, host, field, snippetHtml, tried, llm, feedback, entry, onHeal }) {
  const proposal = await healSelector({
    field,
    host,
    snippet: snippetHtml,
    previousSelector: (tried || [])[0] || null,
    feedback,
    provider: llm.provider,
    model: llm.model,
    apiKey: llm.apiKey,
  });
  entry.proposed = proposal.selector;
  entry.strategy = proposal.strategy;
  entry.confidence = proposal.confidence;
  entry.reason = proposal.reason;

  // Confidence first: a model that correctly reports "this metric is not in the
  // fragment" also returns no selector, and its explanation is more useful than
  // "unusable selector: ". Asking again will not conjure a metric that is absent.
  if (proposal.confidence <= 0 || !proposal.selector) {
    throw new TerminalHealError(proposal.reason || 'model reported the metric is not in the snippet');
  }
  if (!isPlausibleSelector(proposal)) throw new Error(`model returned an unusable selector: ${proposal.selector}`);

  const check = await driver.validate({ field, selector: proposal.selector, strategy: proposal.strategy });
  if (!check || !check.ok) throw new Error((check && check.error) || 'validation in the page failed');
  // A selector that resolves is not yet a selector that is right: the model can
  // point at a neighbouring node. Refuse to persist one whose value is the
  // wrong shape for the field.
  if (!valueFitsField(field, check.value)) {
    throw new Error(`selector matched, but "${String(check.value).slice(0, 60)}" is not a valid ${field}`);
  }

  const stored = await onHeal(host, field, proposal);
  entry.healed = true;
  entry.value = check.value;
  return { healed: true, field, value: check.value, used: { ...stored, source: 'healed' } };
}

/**
 * Repairs one failed field, retrying once with the rejection handed back.
 *
 * The retry is what makes this work against real pages: the first answer is
 * often the right element expressed badly — a Tailwind class that needs CSS
 * escaping, a selector landing on the label instead of the value. Told exactly
 * why it was rejected, the model usually fixes it. Never throws.
 */
async function healField({ driver, host, field, snippet, tried, llm, sanitize, maxSnippetChars, onHeal, onEvent }) {
  let snippetHtml = null;
  let feedback = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    const entry = { field, host, at: new Date().toISOString(), healed: false, provider: llm.provider, attempt };
    try {
      if (snippetHtml === null) {
        if (!snippet) throw new TerminalHealError('no container HTML captured for this field');
        const cleaned = await sanitize(snippet, maxSnippetChars);
        if (!cleaned || !cleaned.html) throw new TerminalHealError('sanitized container was empty');
        snippetHtml = cleaned.html;
      }
      const outcome = await attemptHeal({ driver, host, field, snippetHtml, tried, llm, feedback, entry, onHeal });
      await onEvent(entry);
      return outcome;
    } catch (error) {
      lastError = error instanceof LlmError ? error.message : String((error && error.message) || error);
      entry.error = lastError;
      await onEvent(entry);
      // A transport failure or an honest "it is not in there" will not improve
      // on a second ask; a rejected selector often will.
      if (error instanceof TerminalHealError || error instanceof LlmError) break;
      feedback = lastError;
    }
  }
  return { healed: false, field, error: lastError };
}

/**
 * A full extract-and-repair pass over one already-loaded page.
 *
 * Returns the same shape `scrapeActiveTab()` does, so the bridge, the CLI and
 * the popup can all describe a scrape the same way.
 */
export async function extractWithHealing({
  driver,
  url,
  host,
  ticker = null,
  registry = {},
  llm = { provider: 'anthropic', model: '', apiKey: '' },
  sanitize,
  onHeal = async (_host, _field, proposal) => ({ selector: proposal.selector, strategy: proposal.strategy }),
  onForget = async () => false,
  onEvent = async () => {},
  snapshots = {},
  maxSnippetChars = 12000,
  selfHeal = true,
  snippetLimit = SNIPPET_LIMIT,
}) {
  const candidateMap = buildCandidateMap(host, registry);
  const anchorText = tickerFromUrl(url) || ticker || null;

  const result = await driver.extract({ candidates: candidateMap, snippetLimit, anchorText });
  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'the page did not answer the extraction request');
  }

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
    for (let attempt = 0; attempt < MAX_CANDIDATE_RETRIES && current && !valueFitsField(field, current.value); attempt++) {
      if (current.entry) rejected.push(current.entry.selector);
      const remaining = (candidateMap[field] || []).filter((entry) => !rejected.includes(entry.selector));
      if (!remaining.length) { current = null; break; }
      const next = await driver.extract({ candidates: { [field]: remaining }, snippetLimit, anchorText });
      const nextValue = next && next.ok ? next.raw[field] : null;
      current = nextValue === null || nextValue === undefined ? null : { value: nextValue, entry: next.used[field] };
    }

    if (current && valueFitsField(field, current.value)) {
      raw[field] = current.value;
      used[field] = current.entry;
      continue;
    }

    const container = await driver.capture({ field, snippetLimit, anchorText });
    failures.push({
      field,
      snippet: (container && container.ok && container.snippet) || '',
      tried: rejected,
      mismatch: String(value).slice(0, 60),
    });
    raw[field] = null;
    delete used[field];
  }

  // Not every miss is a fault worth a model call. The URL usually names the
  // instrument, so a ticker the DOM withheld is already recovered; and an empty
  // container means the page carries no text of that shape anywhere, which is
  // an answer rather than a breakage.
  const urlTicker = tickerFromUrl(result.url || url) || anchorText;
  const repairable = [];
  for (const failure of failures) {
    if (failure.field === 'ticker' && urlTicker) continue;
    if (!HEALABLE_FIELDS.includes(failure.field) || !failure.snippet) {
      notices.push(`This page does not show ${phraseFor(failure.field)}.`);
      continue;
    }
    repairable.push(failure);
  }

  if (repairable.length && selfHeal && llm.apiKey) {
    // Heal sequentially: each call is a separate LLM round trip and the
    // failures are usually correlated (one layout change breaks several).
    for (const failure of repairable) {
      const outcome = await healField({
        driver,
        host: result.host || host,
        field: failure.field,
        snippet: failure.snippet,
        tried: failure.tried,
        llm,
        sanitize,
        maxSnippetChars,
        onHeal,
        onEvent,
      });
      if (outcome.healed) {
        raw[failure.field] = outcome.value;
        used[failure.field] = outcome.used;
        healed.push({ field: failure.field, selector: outcome.used.selector, strategy: outcome.used.strategy });
      } else {
        warnings.push(`Could not repair the ${labelFor(failure.field)}: ${humanizeLlmError(outcome.error, providerFor(llm.provider).label)}`);
      }
    }
  } else if (repairable.length) {
    const reason = !llm.apiKey ? 'automatic repair needs an API key' : 'automatic repair is switched off';
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

  const snapshot = buildSnapshot(raw, { source_url: result.url || url, selectors_used: selectorsUsed });

  // A repaired selector can resolve, hold a number of exactly the right shape,
  // and still read something belonging to the page rather than to the
  // instrument — an index tile in a market-summary rail is the classic case.
  // Two scans give it away: every ticker on the host reports the same figure.
  const stuck = findStuckPrice({ snapshot, snapshots });
  if (stuck) {
    const wasHealed = used.price && used.price.source === 'healed';
    if (wasHealed) await onForget(stuck.host, 'price');
    warnings.push(
      `Discarded the price: ${stuck.host} reported the same ${stuck.price} for ${snapshot.ticker} `
      + `and for ${stuck.ticker}, so it is a figure belonging to the page, not to this stock`
      + `${wasHealed ? ' — the repaired selector has been reset' : ''}.`
    );
    snapshot.current_price = null;
    delete snapshot.selectors_used.price_selector;
  }

  if (!isUsableSnapshot(snapshot) && !stuck) {
    const missing = [];
    if (!snapshot.ticker) missing.push(labelFor('ticker'));
    if (!Number.isFinite(snapshot.current_price)) missing.push(labelFor('price'));
    warnings.push(`Could not read the ${missing.join(' or the ')} on this page, so nothing was saved.`);
  }

  return {
    snapshot,
    usable: isUsableSnapshot(snapshot),
    healed,
    warnings,
    notices,
    failedFields: failures.map((failure) => failure.field),
    host: result.host || host,
    title: result.title || null,
  };
}
