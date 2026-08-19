import test from 'node:test';
import assert from 'node:assert/strict';
import { callMessages, extractStructuredJson, healSelector, requestAdvice, LlmError } from '../src/lib/llm.js';
import { stubFetch, messageResponse } from './helpers.mjs';

const KEY = 'sk-ant-test';

test('a request carries the browser-access header, the version and the key', async () => {
  const fetchImpl = stubFetch(messageResponse({ ok: true }));
  await callMessages({ model: 'claude-opus-5', max_tokens: 10, messages: [] }, { apiKey: KEY, fetchImpl });
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
    () => callMessages({}, { apiKey: '', fetchImpl: async () => { called = true; } }),
    (error) => error instanceof LlmError && /API key/.test(error.message)
  );
  assert.equal(called, false);
});

test('HTTP errors surface the API message and a retryable flag', async () => {
  const fetchImpl = stubFetch({ status: 429, json: { error: { message: 'rate limited' } } });
  await assert.rejects(
    () => callMessages({}, { apiKey: KEY, fetchImpl }),
    (error) => error.status === 429 && error.retryable === true && /rate limited/.test(error.message)
  );

  const bad = stubFetch({ status: 400, json: { error: { message: 'bad request' } } });
  await assert.rejects(
    () => callMessages({}, { apiKey: KEY, fetchImpl: bad }),
    (error) => error.status === 400 && error.retryable === false
  );
});

test('a network failure is reported as retryable', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  await assert.rejects(
    () => callMessages({}, { apiKey: KEY, fetchImpl }),
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
    () => callMessages({}, { apiKey: KEY, fetchImpl, timeoutMs: 20 }),
    (error) => /timed out/.test(error.message)
  );
});

test('a non-JSON body is rejected', async () => {
  const fetchImpl = stubFetch({ status: 200, text: '<html>gateway</html>' });
  await assert.rejects(() => callMessages({}, { apiKey: KEY, fetchImpl }), /non-JSON/);
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
