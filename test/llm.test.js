import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel, extractStructuredJson, healSelector, requestAdvice, listModels, LlmError } from '../src/lib/llm.js';
import { stubFetch, messageResponse, groqResponse } from './helpers.mjs';
import { activeLlm, providerFor, PROVIDER_HOSTS } from '../src/lib/providers.js';

const KEY = 'sk-ant-test';

test('a request carries the browser-access header, the version and the key', async () => {
  const fetchImpl = stubFetch(messageResponse({ ok: true }));
  await callModel({ model: 'claude-opus-5', max_tokens: 10, messages: [] }, { apiKey: KEY, fetchImpl });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], KEY);
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
});

test('a missing API key fails before any network call', async () => {
  let called = false;
  await assert.rejects(
    () => callModel({}, { apiKey: '', fetchImpl: async () => { called = true; } }),
    (error) => error instanceof LlmError && /API key/.test(error.message)
  );
  assert.equal(called, false);
});

test('HTTP errors surface the API message and a retryable flag', async () => {
  const fetchImpl = stubFetch({ status: 429, json: { error: { message: 'rate limited' } } });
  await assert.rejects(
    () => callModel({}, { apiKey: KEY, fetchImpl }),
    (error) => error.status === 429 && error.retryable === true && /rate limited/.test(error.message)
  );

  const bad = stubFetch({ status: 400, json: { error: { message: 'bad request' } } });
  await assert.rejects(
    () => callModel({}, { apiKey: KEY, fetchImpl: bad }),
    (error) => error.status === 400 && error.retryable === false
  );
});

test('a network failure is reported as retryable', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  await assert.rejects(
    () => callModel({}, { apiKey: KEY, fetchImpl }),
    (error) => error.retryable === true && /Network error/.test(error.message)
  );
});

test('a timeout aborts the request', async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  await assert.rejects(
    () => callModel({}, { apiKey: KEY, fetchImpl, timeoutMs: 20 }),
    (error) => /timed out/.test(error.message)
  );
});

test('a non-JSON body is rejected', async () => {
  const fetchImpl = stubFetch({ status: 200, text: '<html>gateway</html>' });
  await assert.rejects(() => callModel({}, { apiKey: KEY, fetchImpl }), /non-JSON/);
});

test('extractStructuredJson handles refusals, empty content and bad JSON', () => {
  assert.deepEqual(extractStructuredJson({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.throws(
    () => extractStructuredJson({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }),
    /declined/
  );
  assert.throws(() => extractStructuredJson({ content: [{ type: 'thinking', thinking: '' }] }), /no text block/);
  assert.throws(() => extractStructuredJson({ content: [{ type: 'text', text: 'not json' }] }), /not valid JSON/);
  assert.throws(() => extractStructuredJson(null), /Empty response/);
});

test('healSelector sends the schema and normalizes the answer', async () => {
  const fetchImpl = stubFetch(messageResponse({
    selector: ' [data-testid="qsp-price"] ', strategy: 'weird', confidence: '0.9', reason: 'the live price node',
  }));
  const result = await healSelector({
    field: 'price', host: 'finance.yahoo.com', snippet: '<div>224.50</div>',
    previousSelector: '#old', apiKey: KEY, fetchImpl,
  });
  assert.deepEqual(result, {
    selector: '[data-testid="qsp-price"]', strategy: 'css', confidence: 0.9, reason: 'the live price node',
  });

  const body = fetchImpl.calls[0].body;
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema.required, ['selector', 'strategy', 'confidence', 'reason']);
  assert.match(body.messages[0].content, /Metric that failed: price/);
  assert.match(body.messages[0].content, /#old/);
});

test('requestAdvice constrains the response to the documented advisory schema', async () => {
  const payload = { ticker: 'AAPL', action: 'HOLD', confidence_score: 0.5, rationale: 'x'.repeat(30), user_action_required: true };
  const fetchImpl = stubFetch(messageResponse(payload));
  const result = await requestAdvice({ context: { ticker: 'AAPL' }, apiKey: KEY, fetchImpl });
  assert.deepEqual(result, payload);

  const schema = fetchImpl.calls[0].body.output_config.format.schema;
  assert.deepEqual(schema.required, ['ticker', 'action', 'confidence_score', 'rationale', 'user_action_required']);
  assert.deepEqual(schema.properties.action.enum, ['BUY', 'SELL', 'HOLD']);
  assert.equal(schema.additionalProperties, false);
});

test('the system prompt forbids inventing data and keeps the human in the loop', async () => {
  const fetchImpl = stubFetch(messageResponse({ ticker: 'A', action: 'HOLD', confidence_score: 0.1, rationale: 'x'.repeat(30), user_action_required: true }));
  await requestAdvice({ context: {}, apiKey: KEY, fetchImpl });
  const system = fetchImpl.calls[0].body.system;
  assert.match(system, /Never invent/);
  assert.match(system, /You do not place orders/);
});

/* ------------------------------------------------------------------ *
 * Groq — the alternative when an Anthropic key is not available
 * ------------------------------------------------------------------ */

const GROQ_KEY = 'gsk_test';

test('a Groq request uses bearer auth, the chat endpoint and a strict schema', async () => {
  const fetchImpl = stubFetch(groqResponse({
    selector: '.qz-8f31ab', strategy: 'css', confidence: 0.9, reason: 'the live price node',
  }));
  const result = await healSelector({
    field: 'price', host: 'example.com', snippet: '<div>182.44</div>',
    provider: 'groq', apiKey: GROQ_KEY, fetchImpl,
  });
  assert.equal(result.selector, '.qz-8f31ab');

  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(init.headers.authorization, `Bearer ${GROQ_KEY}`);
  assert.equal(init.headers['x-api-key'], undefined, 'the Anthropic scheme must not leak into a Groq call');
  assert.equal(body.model, 'llama-3.3-70b-versatile');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['selector', 'strategy', 'confidence', 'reason']);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[1].content, /Metric that failed: price/);
});

test('a model that rejects json_schema is retried with the schema in the prompt', async () => {
  let call = 0;
  const fetchImpl = stubFetch(async (_url, init) => {
    call += 1;
    const body = JSON.parse(init.body);
    if (call === 1) {
      assert.equal(body.response_format.type, 'json_schema');
      return {
        ok: false, status: 400, statusText: '400',
        async text() { return JSON.stringify({ error: { message: "'response_format.json_schema' is not supported by this model" } }); },
      };
    }
    assert.equal(body.response_format.type, 'json_object');
    assert.match(body.messages[0].content, /must match this JSON Schema/);
    return {
      ok: true, status: 200, statusText: '200',
      async text() { return JSON.stringify(groqResponse({ selector: '.p', strategy: 'css', confidence: 0.8, reason: 'ok' }).json); },
    };
  });

  const result = await healSelector({ field: 'price', host: 'x.com', snippet: '<i>1</i>', provider: 'groq', apiKey: GROQ_KEY, fetchImpl });
  assert.equal(result.selector, '.p');
  assert.equal(call, 2, 'exactly one retry');
});

test('a Groq answer wrapped in prose or a code fence is still parsed', () => {
  const fenced = groqResponse(null, { raw: ['```json', '{"action":"HOLD"}', '```'].join('\n') }).json;
  assert.deepEqual(extractStructuredJson(fenced, 'groq'), { action: 'HOLD' });

  const chatty = groqResponse(null, { raw: 'Here you go: {"action":"BUY"} — hope that helps.' }).json;
  assert.deepEqual(extractStructuredJson(chatty, 'groq'), { action: 'BUY' });

  const refusal = { choices: [{ message: { role: 'assistant', refusal: 'I cannot help with that' } }] };
  assert.throws(() => extractStructuredJson(refusal, 'groq'), /declined/);
  assert.throws(() => extractStructuredJson({ choices: [] }, 'groq'), /no choices/);
});

test('a Groq HTTP error surfaces its message and the provider name', async () => {
  const fetchImpl = stubFetch({ status: 401, json: { error: { message: 'Invalid API Key' } } });
  await assert.rejects(
    () => callModel({}, { provider: 'groq', apiKey: GROQ_KEY, fetchImpl }),
    (error) => error.status === 401 && /Groq/.test(error.message) && /Invalid API Key/.test(error.message)
  );
});

test('listModels reads the catalogue for providers that publish one', async () => {
  const fetchImpl = stubFetch({ status: 200, json: { data: [{ id: 'llama-3.1-8b-instant' }, { id: 'llama-3.3-70b-versatile' }] } });
  const models = await listModels({ provider: 'groq', apiKey: GROQ_KEY, fetchImpl });
  assert.deepEqual(models, ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
  assert.equal(fetchImpl.calls[0].url, 'https://api.groq.com/openai/v1/models');
  assert.equal(await listModels({ provider: 'anthropic', apiKey: KEY, fetchImpl }), null);
});

test('activeLlm resolves the selected provider, its key and its model', () => {
  const settings = {
    provider: 'groq',
    providers: { anthropic: { apiKey: 'sk-ant-a', model: 'claude-opus-5' }, groq: { apiKey: ' gsk_b ', model: '' } },
  };
  const active = activeLlm(settings);
  assert.equal(active.provider.id, 'groq');
  assert.equal(active.apiKey, 'gsk_b');
  assert.equal(active.model, 'llama-3.3-70b-versatile', 'an empty model falls back to the provider default');

  assert.equal(activeLlm({}).provider.id, 'anthropic', 'Anthropic stays the default');
  assert.equal(providerFor('nonsense').id, 'anthropic');
});

test('every provider endpoint is covered by a declared host permission', () => {
  for (const id of ['anthropic', 'groq']) {
    const provider = providerFor(id);
    const origin = new URL(provider.endpoint).origin;
    assert.ok(
      PROVIDER_HOSTS.includes(`${origin}/*`),
      `${id} calls ${origin} but no host permission covers it`
    );
  }
});
