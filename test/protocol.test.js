/**
 * `src/content.js` cannot import the shared constants (it is injected as a
 * classic script), so it re-declares the message types it handles. These tests
 * pin the two copies together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MSG, OFFSCREEN_TARGET, FIELDS } from '../src/lib/constants.js';
import { readSource } from './helpers.mjs';

const content = readSource('src/content.js');
const background = readSource('src/background.js');

test('the content script declares the same message strings as the shared constants', () => {
  for (const type of ['EXTRACT', 'VALIDATE_SELECTOR']) {
    assert.match(content, new RegExp(`${type}:\\s*'${MSG[type]}'`), `content.js is missing ${type}`);
  }
  assert.match(content, /PING:\s*'PING'/);
  assert.match(background, /type:\s*'PING'/, 'background.js must use the same PING literal');
});

test('the content script handles every message the worker sends it', () => {
  const sent = [...background.matchAll(/sendToTab\([^,]+,\s*\{\s*type:\s*(?:MSG\.(\w+)|'(\w+)')/g)]
    .map(([, constant, literal]) => (constant ? MSG[constant] : literal));
  assert.ok(sent.length >= 3);
  for (const type of new Set(sent)) {
    assert.match(content, new RegExp(`'${type}'`), `content.js does not handle ${type}`);
  }
});

test('the content script stays free of ES module syntax', () => {
  assert.doesNotMatch(content, /^\s*import[\s({]/m);
  assert.doesNotMatch(content, /^\s*export\s/m);
});

test('the offscreen document only answers messages addressed to it', () => {
  const offscreen = readSource('src/offscreen.js');
  assert.match(offscreen, new RegExp(`message\\.target !== OFFSCREEN_TARGET`));
  assert.match(background, /message\.target === OFFSCREEN_TARGET/, 'the worker must ignore offscreen traffic');
  assert.equal(OFFSCREEN_TARGET, 'offscreen');
});

test('every documented field is requested by the worker', () => {
  assert.deepEqual(FIELDS, ['ticker', 'price', 'change_percentage', 'volume', 'news']);
  assert.match(background, /for \(const field of FIELDS\)/);
});

test('the worker never claims to have executed a trade', () => {
  assert.match(background, /executed: false/);
  assert.doesNotMatch(background, /placeOrder|submitOrder|executeTrade/);
});
