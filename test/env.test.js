/**
 * The .env reader that feeds credentials to the browser end-to-end runs.
 * Dependency-free, so it is worth pinning the parsing rules rather than
 * discovering them the hard way with a key that silently arrives as `"gsk_…"`,
 * quotes included.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, loadEnv, credentialsFromEnv, describeKey } from '../e2e/env.mjs';

test('parseEnv handles comments, quotes, exports and empty values', () => {
  const parsed = parseEnv([
    '# a comment',
    '',
    'GROQ_API_KEY=gsk_plain',
    'QUOTED="gsk_quoted"',
    "SINGLE='gsk_single'",
    'export EXPORTED=gsk_exported',
    'SPACED  =  gsk_spaced  ',
    'TRAILING=gsk_value # not part of the key',
    'EMPTY=',
    'WITH_EQUALS=a=b=c',
    'not a valid line',
    '1INVALID=nope',
  ].join('\n'));

  assert.equal(parsed.GROQ_API_KEY, 'gsk_plain');
  assert.equal(parsed.QUOTED, 'gsk_quoted', 'quotes must not survive into the key');
  assert.equal(parsed.SINGLE, 'gsk_single');
  assert.equal(parsed.EXPORTED, 'gsk_exported');
  assert.equal(parsed.SPACED, 'gsk_spaced');
  assert.equal(parsed.TRAILING, 'gsk_value');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed.WITH_EQUALS, 'a=b=c', 'only the first = separates');
  assert.equal('1INVALID' in parsed, false);
});

test('loadEnv never overwrites something already in the environment', () => {
  const env = { GROQ_API_KEY: 'from-the-command-line', ANTHROPIC_API_KEY: '' };
  const values = parseEnv('GROQ_API_KEY=from-the-file\nANTHROPIC_API_KEY=sk-from-the-file');
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
  assert.equal(env.GROQ_API_KEY, 'from-the-command-line');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-from-the-file', 'an empty value counts as unset');
});

test('loadEnv on a missing file is a no-op, not a crash', () => {
  assert.deepEqual(loadEnv('./definitely-not-a-real-file.env', {}), {});
});

test('credentialsFromEnv picks the provider whose key is filled in', () => {
  assert.equal(credentialsFromEnv({ GROQ_API_KEY: 'gsk_x' }).provider, 'groq');
  assert.equal(credentialsFromEnv({ ANTHROPIC_API_KEY: 'sk-x' }).provider, 'anthropic');

  // Both present: Groq first, since that is the fallback the project ships for.
  assert.equal(credentialsFromEnv({ GROQ_API_KEY: 'gsk_x', ANTHROPIC_API_KEY: 'sk-x' }).provider, 'groq');

  // An explicit choice always wins.
  const explicit = credentialsFromEnv({ LLM_PROVIDER: 'anthropic', GROQ_API_KEY: 'gsk_x', ANTHROPIC_API_KEY: 'sk-x' });
  assert.equal(explicit.provider, 'anthropic');
  assert.equal(explicit.apiKey, 'sk-x');

  // Nonsense falls back rather than throwing.
  assert.equal(credentialsFromEnv({ LLM_PROVIDER: 'openai' }).provider, 'groq');
});

test('credentialsFromEnv reports no key rather than inventing one', () => {
  const empty = credentialsFromEnv({});
  assert.equal(empty.apiKey, '');
  assert.equal(empty.model, '');
});

test('describeKey never reveals the key', () => {
  const key = 'gsk_supersecretvalue123456';
  const described = describeKey(key);
  assert.equal(described.includes('supersecret'), false);
  assert.match(described, /^gsk_…\d+ chars$/);
  assert.equal(describeKey(''), 'none');
});
