/**
 * Provider-agnostic LLM client.
 *
 * Raw `fetch` rather than an official SDK: this runs inside an MV3 service
 * worker with no bundler step, and MV3's CSP forbids loading remote code.
 * Requests go out from the service worker (never the content script) so the
 * API key never touches a page context.
 *
 * The wire format lives in `providers.js`; everything here is about the two
 * jobs the extension actually needs — repair a selector, write an advisory —
 * plus timeouts, error classification, and the structured-output retry.
 */
import { providerFor } from './providers.js';

/** Structured-output schema for a healed selector. */
const SELECTOR_SCHEMA = {
  type: 'object',
  properties: {
    selector: { type: 'string', description: 'A CSS selector, or an XPath expression when strategy is "xpath".' },
    strategy: { type: 'string', enum: ['css', 'xpath'] },
    confidence: { type: 'number', description: '0..1 confidence that this selector targets the requested metric.' },
    reason: { type: 'string', description: 'One sentence naming the element that was matched.' },
  },
  required: ['selector', 'strategy', 'confidence', 'reason'],
  additionalProperties: false,
};

/** Structured-output schema for an advisory — mirrors the documented output JSON. */
const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
    confidence_score: { type: 'number', description: '0..1' },
    rationale: {
      type: 'string',
      description: 'Concise paragraph citing the specific scraped numbers and the user targets that drive the call.',
    },
    user_action_required: { type: 'boolean' },
  },
  required: ['ticker', 'action', 'confidence_score', 'rationale', 'user_action_required'],
  additionalProperties: false,
};

export class LlmError extends Error {
  constructor(message, { status = null, retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * POSTs one non-streaming request and returns the parsed body.
 * `fetchImpl` is injectable so the transport can be tested without a network.
 */
export async function callModel(body, { provider, apiKey, timeoutMs = 45000, fetchImpl = globalThis.fetch } = {}) {
  const definition = providerFor(provider);
  if (!apiKey) {
    throw new LlmError(`No ${definition.label} API key configured. Add one in the extension options.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(definition.endpoint, {
      method: 'POST',
      headers: definition.headers(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || controller.signal.aborted);
    throw new LlmError(aborted ? `Request timed out after ${timeoutMs}ms` : `Network error: ${error.message}`, {
      retryable: true,
      cause: error,
    });
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

  if (!response.ok) {
    const detail = definition.errorDetail(parsed) || text.slice(0, 300) || response.statusText;
    throw new LlmError(`${definition.label} API ${response.status}: ${detail}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500 || response.status === 408,
    });
  }
  if (!parsed) throw new LlmError(`${definition.label} API returned a non-JSON body`, { status: response.status });
  return parsed;
}

/** Pulls the JSON object out of a response, in that provider's shape. */
export function extractStructuredJson(response, provider) {
  const definition = providerFor(provider);
  if (!response) throw new LlmError('Empty response from the model API');
  const { value, error } = definition.extractJson(response);
  if (error) throw new LlmError(error);
  return value;
}

/**
 * One schema-constrained round trip.
 *
 * Not every model behind an OpenAI-compatible endpoint supports strict
 * `json_schema`. When the API rejects it, the request is rebuilt once with the
 * schema moved into the prompt instead of enforced by the server.
 */
async function runStructured({
  provider, model, apiKey, maxTokens, system, userContent, schema, schemaName, effort, fetchImpl, timeoutMs,
}) {
  const definition = providerFor(provider);
  let plain = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = definition.buildRequest({ model, maxTokens, system, userContent, schema, schemaName, effort, plain });
    let response;
    try {
      response = await callModel(body, { provider: definition.id, apiKey, fetchImpl, timeoutMs });
    } catch (error) {
      const canRetry = !plain
        && typeof definition.needsPlainJson === 'function'
        && definition.needsPlainJson(error.status, error.message);
      if (!canRetry) throw error;
      plain = true;
      continue;
    }
    return extractStructuredJson(response, definition.id);
  }
  throw new LlmError(`${definition.label} rejected both the strict and the plain JSON request formats`);
}

const HEAL_SYSTEM = [
  'You repair broken web scrapers.',
  'You are given a sanitized HTML fragment from a financial quote page and the name of one metric that could no longer be located.',
  'Identify the single element inside the fragment that holds that metric and return a selector that resolves to it.',
  'Prefer stable hooks in this order: data-* attributes, ARIA/test ids, semantic tags, structural paths. Avoid hashed or randomly generated class names.',
  'Prefer a CSS selector. Use an XPath expression only when no CSS selector can express the match.',
  'The selector must resolve to a single element whose text content is the metric value itself, not a wrapper containing several metrics.',
  'If the fragment genuinely does not contain the metric, return confidence 0 and explain why in one sentence.',
].join(' ');

/**
 * Asks the model for a replacement selector for one broken field.
 * Returns { selector, strategy, confidence, reason }.
 */
export async function healSelector({ field, host, snippet, previousSelector, provider, model, apiKey, fetchImpl, timeoutMs }) {
  const userContent = [
    `Host: ${host}`,
    `Metric that failed: ${field}`,
    previousSelector ? `Selector that no longer matches: ${previousSelector}` : 'No previous selector recorded.',
    '',
    'Sanitized HTML fragment:',
    '```html',
    snippet,
    '```',
  ].join('\n');

  const parsed = await runStructured({
    provider,
    model,
    apiKey,
    maxTokens: 4096,
    system: HEAL_SYSTEM,
    userContent,
    schema: SELECTOR_SCHEMA,
    schemaName: 'healed_selector',
    effort: 'medium',
    fetchImpl,
    timeoutMs,
  });

  return {
    selector: typeof parsed.selector === 'string' ? parsed.selector.trim() : '',
    strategy: parsed.strategy === 'xpath' ? 'xpath' : 'css',
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

const ADVICE_SYSTEM = [
  'You are a market analysis assistant inside a browser extension.',
  'You are given one live quote snapshot scraped from the page the user is looking at, plus that user\'s own position and price targets.',
  'Return exactly one advisory: BUY, SELL, or HOLD.',
  'Ground the rationale in the numbers you were given — cite the price, the percentage change, the volume, the user targets, and any headline you were handed.',
  'Never invent prices, fundamentals, analyst ratings, or news that is not in the input. If a field is null, say it is unavailable rather than guessing.',
  'A SELL is not actionable when the user holds zero shares; say so instead.',
  'One snapshot is a single point in time. Keep confidence_score calibrated: below 0.5 when the inputs are thin or the targets are unset.',
  'You do not place orders. Always set user_action_required to true — the human makes the final decision.',
  'Keep the rationale under 120 words.',
].join(' ');

/** Asks the model for a BUY/SELL/HOLD advisory. Returns the raw parsed object. */
export async function requestAdvice({ context, provider, model, apiKey, fetchImpl, timeoutMs }) {
  const userContent = [
    'Live snapshot and user portfolio context (JSON):',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
    'Produce the advisory for this ticker.',
  ].join('\n');

  return runStructured({
    provider,
    model,
    apiKey,
    maxTokens: 8192,
    system: ADVICE_SYSTEM,
    userContent,
    schema: ADVICE_SCHEMA,
    schemaName: 'advisory',
    effort: 'medium',
    fetchImpl,
    timeoutMs,
  });
}

/** Smallest possible schema-constrained request, used to verify a key. */
const PROBE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
  required: ['ok', 'note'],
  additionalProperties: false,
};

/**
 * Sends one tiny structured request so a user can confirm a key and a model
 * work before relying on them mid-demo. Throws `LlmError` on any failure, so
 * the caller gets the provider's own message rather than a generic one.
 */
export async function pingProvider({ provider, model, apiKey, fetchImpl, timeoutMs = 20000 }) {
  const parsed = await runStructured({
    provider,
    model,
    apiKey,
    maxTokens: 256,
    system: 'You are a connectivity probe for a browser extension. Answer with ok=true and a short note naming the model answering.',
    userContent: 'Reply now.',
    schema: PROBE_SCHEMA,
    schemaName: 'probe',
    effort: 'low',
    fetchImpl,
    timeoutMs,
  });
  return { ok: parsed.ok === true, note: typeof parsed.note === 'string' ? parsed.note : '' };
}

/**
 * Lists the models the key can actually use. Only providers that expose a
 * catalogue (Groq) support this; it is what keeps the options page from
 * offering a model id the provider has since retired.
 */
export async function listModels({ provider, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const definition = providerFor(provider);
  if (!definition.modelsUrl) return null;
  if (!apiKey) throw new LlmError(`No ${definition.label} API key configured.`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(definition.modelsUrl, { headers: definition.headers(apiKey), signal: controller.signal });
  } catch (error) {
    throw new LlmError(`Network error: ${error.message}`, { retryable: true, cause: error });
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
  if (!response.ok) {
    throw new LlmError(`${definition.label} API ${response.status}: ${definition.errorDetail(parsed) || response.statusText}`, {
      status: response.status,
    });
  }
  const rows = (parsed && Array.isArray(parsed.data) ? parsed.data : [])
    .map((row) => row && row.id)
    .filter((id) => typeof id === 'string');
  return rows.sort();
}
