import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesFor, toSelectorEntry, isPlausibleSelector, hostsRelated, DEFAULT_REGISTRY, GENERIC_SELECTORS,
} from '../src/lib/selectors.js';
import { FIELDS } from '../src/lib/constants.js';

test('a healed selector outranks every shipped default', () => {
  const registry = { 'finance.yahoo.com': { price: { selector: '#healed', strategy: 'css' } } };
  const list = candidatesFor('finance.yahoo.com', 'price', registry);
  assert.equal(list[0].selector, '#healed');
  assert.equal(list[0].source, 'healed');
  assert.equal(list[1].source, 'default');
});

test('generic fallbacks are appended for an unknown host', () => {
  const list = candidatesFor('brand-new-broker.example', 'price');
  assert.ok(list.length >= GENERIC_SELECTORS.price.length);
  assert.ok(list.every((entry) => entry.source === 'generic'));
});

test('a related host contributes its defaults', () => {
  const list = candidatesFor('uk.finance.yahoo.com', 'price');
  assert.ok(list.some((entry) => entry.source === 'default-related'));
  assert.ok(list.some((entry) => entry.selector === '[data-testid="qsp-price"]'));
});

test('duplicate selectors are collapsed while order is preserved', () => {
  const registry = { 'finance.yahoo.com': { price: '[data-testid="qsp-price"]' } };
  const list = candidatesFor('finance.yahoo.com', 'price', registry);
  const seen = list.map((entry) => `${entry.strategy}::${entry.selector}`);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(list[0].source, 'healed');
});

test('every documented field resolves to at least one candidate', () => {
  for (const field of FIELDS) {
    assert.ok(candidatesFor('anything.example', field).length > 0, `no candidates for ${field}`);
  }
});

test('toSelectorEntry normalizes strings, objects and junk', () => {
  assert.deepEqual(toSelectorEntry('#a'), { selector: '#a', strategy: 'css' });
  assert.deepEqual(toSelectorEntry({ selector: ' //div ', strategy: 'xpath' }), { selector: '//div', strategy: 'xpath' });
  assert.deepEqual(toSelectorEntry({ selector: '#a', strategy: 'nonsense' }), { selector: '#a', strategy: 'css' });
  assert.equal(toSelectorEntry(null), null);
  assert.equal(toSelectorEntry({ selector: '   ' }), null);
  assert.equal(toSelectorEntry({}), null);
});

test('isPlausibleSelector blocks page-wide and malformed selectors', () => {
  assert.equal(isPlausibleSelector('*'), false);
  assert.equal(isPlausibleSelector('BODY'), false);
  assert.equal(isPlausibleSelector(':root'), false);
  assert.equal(isPlausibleSelector('<div>'), false);
  assert.equal(isPlausibleSelector('#a'.repeat(300)), false);
  assert.equal(isPlausibleSelector({ selector: 'div > span', strategy: 'css' }), true);
  assert.equal(isPlausibleSelector({ selector: '//span[@id="p"]', strategy: 'xpath' }), true);
  assert.equal(isPlausibleSelector({ selector: 'span', strategy: 'xpath' }), false);
});

test('hostsRelated matches on the registrable suffix only', () => {
  assert.equal(hostsRelated('uk.finance.yahoo.com', 'finance.yahoo.com'), true);
  assert.equal(hostsRelated('finance.yahoo.com', 'www.google.com'), false);
  assert.equal(hostsRelated(null, 'a.com'), false);
});

test('shipped defaults are syntactically usable', () => {
  for (const [host, fields] of Object.entries(DEFAULT_REGISTRY)) {
    for (const [field, list] of Object.entries(fields)) {
      assert.ok(FIELDS.includes(field), `${host} declares unknown field ${field}`);
      for (const entry of list) {
        assert.ok(isPlausibleSelector(entry), `${host}/${field}: ${JSON.stringify(entry)}`);
      }
    }
  }
});

test('the structural volume fallback survives a class-name rewrite', () => {
  const candidates = candidatesFor('unknown.example', 'volume', {});
  const structural = candidates.filter((entry) => entry.strategy === 'xpath');
  assert.ok(structural.length >= 1, 'expected a label-anchored xpath fallback for volume');
  assert.ok(structural.every((entry) => /Volume/.test(entry.selector)));
});
