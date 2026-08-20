/**
 * LLM providers.
 *
 * The extension's reasoning work — repairing a selector, writing an advisory —
 * is the same request in both cases: a system prompt, one user message, and a
 * JSON schema the answer must satisfy. Only the wire format differs. Each
 * provider here owns four things and nothing else:
 *
 *   headers(apiKey)   the auth scheme
 *   buildRequest(...) the request body for a schema-constrained answer
 *   extractJson(...)  pulling the object back out of the response
 *   errorDetail(...)  finding the human-readable message in an error body
 *
 * Anthropic is the default. Groq is there because an Anthropic key is not
 * always obtainable, and Groq's free tier is enough to demo the whole loop.
 */

/** Every host the extension is allowed to reach, asserted by scripts/validate.mjs. */
export const PROVIDER_HOSTS = ['https://api.anthropic.com/*', 'https://api.groq.com/*'];

/**
 * Restates the schema inside the prompt. Needed for the plain-JSON mode some
 * models fall back to, where the schema is not enforced by the API.
 */
function schemaInstruction(schema) {
  return [
    'Reply with one JSON object and nothing else — no prose, no markdown fence.',
    'It must match this JSON Schema exactly:',
    JSON.stringify(schema),
  ].join(' ');
}

/** Pulls the first {...} out of a string a chatty model wrapped in prose. */
function looseJson(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  endpoint: 'https://api.anthropic.com/v1/messages',
  modelsUrl: null,
  defaultModel: 'claude-opus-5',
  models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  keyPlaceholder: 'sk-ant-…',
  keyOrigin: 'console.anthropic.com',
  host: 'api.anthropic.com',

  headers(apiKey) {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calls made from a browser/extension context.
      'anthropic-dangerous-direct-browser-access': 'true',
      // Server-side refusal fallback (see `fallbacks` below).
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    };
  },

  buildRequest({ model, maxTokens, system, userContent, schema, effort }) {
    return {
      model: model || this.defaultModel,
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
  },

  extractJson(response) {
    if (response.stop_reason === 'refusal') {
      const detail = (response.stop_details && response.stop_details.category) || 'unspecified';
      return { error: `Model declined the request (category: ${detail})` };
    }
    const blocks = Array.isArray(response.content) ? response.content : [];
    const textBlock = blocks.find((block) => block && block.type === 'text' && typeof block.text === 'string');
    if (!textBlock) return { error: 'Response contained no text block to parse' };
    try {
      return { value: JSON.parse(textBlock.text) };
    } catch {
      return { error: `Response was not valid JSON: ${textBlock.text.slice(0, 200)}` };
    }
  },

  errorDetail(parsed) {
    return parsed && parsed.error && parsed.error.message;
  },
};

const groq = {
  id: 'groq',
  label: 'Groq (OpenAI-compatible)',
  endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  // The options page can list the account's live models, so nothing here has
  // to guess at an id that Groq may have retired.
  modelsUrl: 'https://api.groq.com/openai/v1/models',
  defaultModel: 'llama-3.3-70b-versatile',
  models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  keyPlaceholder: 'gsk_…',
  keyOrigin: 'console.groq.com/keys',
  host: 'api.groq.com',

  headers(apiKey) {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    };
  },

  /**
   * `plain: true` drops the json_schema response format for models that do not
   * support it, and puts the schema in the prompt instead. `callModel` retries
   * that way when the API rejects the strict form.
   */
  buildRequest({ model, maxTokens, system, userContent, schema, schemaName, plain = false }) {
    const request = {
      model: model || this.defaultModel,
      max_tokens: maxTokens,
      temperature: 0, // these are extraction tasks, not creative ones
      messages: [
        { role: 'system', content: plain ? `${system} ${schemaInstruction(schema)}` : system },
        { role: 'user', content: userContent },
      ],
    };
    request.response_format = plain
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: schemaName || 'answer', strict: true, schema } };
    return request;
  },

  extractJson(response) {
    const choice = Array.isArray(response.choices) ? response.choices[0] : null;
    if (!choice) return { error: 'Response contained no choices to parse' };
    const message = choice.message || {};
    if (message.refusal) return { error: `Model declined the request: ${String(message.refusal).slice(0, 120)}` };
    if (typeof message.content !== 'string' || !message.content.trim()) {
      return { error: 'Response contained no message content to parse' };
    }
    const value = looseJson(message.content);
    if (value === null) return { error: `Response was not valid JSON: ${message.content.slice(0, 200)}` };
    return { value };
  },

  errorDetail(parsed) {
    if (!parsed || !parsed.error) return null;
    // Groq returns { error: { message } }; some gateways return { error: "..." }.
    return typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
  },

  /** True when a 400 is complaining about the strict json_schema mode. */
  needsPlainJson(status, detail) {
    if (status !== 400 || !detail) return false;
    return /response_format|json_schema|structured output/i.test(detail);
  },
};

export const PROVIDERS = { anthropic, groq };
export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const DEFAULT_PROVIDER = 'anthropic';

/** Resolves a provider id to its definition, falling back to the default. */
export function providerFor(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

/**
 * The credentials in force right now: which provider is selected, its key, and
 * its model. Keys are held per provider so switching back and forth does not
 * throw one away.
 */
export function activeLlm(settings = {}) {
  const provider = providerFor(settings.provider);
  const stored = (settings.providers && settings.providers[provider.id]) || {};
  return {
    provider,
    apiKey: (stored.apiKey || '').trim(),
    model: (stored.model || '').trim() || provider.defaultModel,
  };
}
