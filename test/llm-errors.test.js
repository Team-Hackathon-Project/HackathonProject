import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeLlmError } from '../src/lib/llm.js';

test('a rate limit says how long to wait, not which organisation id', () => {
  const raw = 'Groq API 429: Rate limit reached for model `openai/gpt-oss-120b` in organization '
    + '`org_01kt6` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7794, '
    + 'Requested 3747. Please try again in 26.5575s. Upgrade at https://console.groq.com/settings/billing';
  const out = humanizeLlmError(raw, 'Groq');
  assert.match(out, /Groq is rate limiting this key/);
  assert.match(out, /about 27 seconds/);
  assert.doesNotMatch(out, /org_01kt6/);
  assert.doesNotMatch(out, /https:/);
});

test('a rejected key points at the place it is fixed', () => {
  assert.match(humanizeLlmError('API 401: invalid api key', 'Anthropic'), /rejected the API key\. Check it in Settings\./);
});

test('an oversized request names the setting that controls it', () => {
  const out = humanizeLlmError('API 413: Request too large for model', 'Groq');
  assert.match(out, /too big for this model/);
  assert.match(out, /how much of the page is sent/);
});

test('an unreachable provider is not confused with a rejected one', () => {
  assert.match(humanizeLlmError('Network error: fetch failed', 'Groq'), /Could not reach Groq/);
});

test('anything unrecognised survives, as a sentence', () => {
  const out = humanizeLlmError('selector matched, but "$182.44" is not a valid volume');
  assert.match(out, /is not a valid volume\./);
  assert.match(out, /^Selector matched/);
});

test('an empty error still says something', () => {
  assert.equal(humanizeLlmError(''), 'The model did not answer.');
});
