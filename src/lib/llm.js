/**
 * Anthropic Messages API client.
 *
 * Raw `fetch` rather than the official SDK: this runs inside an MV3 service
 * worker with no bundler step, and MV3's CSP forbids loading remote code.
 * Requests go out from the service worker (never the content script) so the
 * API key never touches a page context.
 */
import { ANTHROPIC_URL, ANTHROPIC_VERSION } from './constants.js';

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
 * POSTs one non-streaming request to /v1/messages and returns the parsed body.
 * `fetchImpl` is injectable so the transport can be tested without a network.
 */
export async function callMessages(body, { apiKey, timeoutMs = 45000, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new LlmError('No Anthropic API key configured. Add one in the extension options.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        // Required for calls made from a browser/extension context.
        'anthropic-dangerous-direct-browser-access': 'true',
        // Server-side refusal fallback (see `fallbacks` in buildRequest).
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
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
    const detail = (parsed && parsed.error && parsed.error.message) || text.slice(0, 300) || response.statusText;
    throw new LlmError(`Anthropic API ${response.status}: ${detail}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500 || response.status === 408,
    });
  }
  if (!parsed) throw new LlmError('Anthropic API returned a non-JSON body', { status: response.status });
  return parsed;
}

/** Wraps a request in the shared defaults (model, fallbacks, effort). */
function buildRequest({ model, maxTokens, system, userContent, schema, effort }) {
  return {
    model: model || 'claude-opus-5',
    max_tokens: maxTokens,
    system,
    // Opus 5 may decline a request outright; `fallbacks: "default"` lets the
    // API rescue the call on another model inside the same request.
    fallbacks: 'default',
    output_config: {
      effort,
      format: { type: 'json_schema', schema },
    },
    messages: [{ role: 'user', content: userContent }],
  };
}

/**
 * Pulls the JSON object out of a Messages response.
 * `output_config.format` guarantees the first text block is valid JSON, but we
 * still parse defensively — a refusal returns no usable text at all.
 */
export function extractStructuredJson(response) {
  if (!response) throw new LlmError('Empty response from Anthropic API');
  if (response.stop_reason === 'refusal') {
    const detail = (response.stop_details && response.stop_details.category) || 'unspecified';
    throw new LlmError(`Model declined the request (category: ${detail})`);
  }
  const blocks = Array.isArray(response.content) ? response.content : [];
  const textBlock = blocks.find((block) => block && block.type === 'text' && typeof block.text === 'string');
  if (!textBlock) throw new LlmError('Response contained no text block to parse');
  try {
    return JSON.parse(textBlock.text);
  } catch (error) {
    throw new LlmError(`Response was not valid JSON: ${textBlock.text.slice(0, 200)}`, { cause: error });
  }
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
export async function healSelector({ field, host, snippet, previousSelector, model, apiKey, fetchImpl, timeoutMs }) {
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

  const response = await callMessages(
    buildRequest({
      model,
      maxTokens: 4096,
      system: HEAL_SYSTEM,
      userContent,
      schema: SELECTOR_SCHEMA,
      effort: 'medium',
    }),
    { apiKey, fetchImpl, timeoutMs }
  );
  const parsed = extractStructuredJson(response);
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
export async function requestAdvice({ context, model, apiKey, fetchImpl, timeoutMs }) {
  const userContent = [
    'Live snapshot and user portfolio context (JSON):',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
    'Produce the advisory for this ticker.',
  ].join('\n');

  const response = await callMessages(
    buildRequest({
      model,
      maxTokens: 8192,
      system: ADVICE_SYSTEM,
      userContent,
      schema: ADVICE_SCHEMA,
      effort: 'medium',
    }),
    { apiKey, fetchImpl, timeoutMs }
  );
  return extractStructuredJson(response);
}
