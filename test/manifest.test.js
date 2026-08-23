import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from '../scripts/validate.mjs';
import { readSource } from './helpers.mjs';

const manifest = JSON.parse(readSource('manifest.json'));

test('the bundle passes static validation', () => {
  assert.deepEqual(validate(), []);
});

test('the manifest keeps the documented permission scope', () => {
  assert.deepEqual(manifest.permissions.sort(),
    ['activeTab', 'alarms', 'notifications', 'offscreen', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://api.anthropic.com/*', 'https://api.groq.com/*']);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.content_scripts, undefined);
});

test('the dashboard origins are narrow and do not widen anything else', () => {
  // externally_connectable is the only way in from outside the extension. It
  // needs no host permission and grants no page access - but the origins it
  // names can call the worker, so the list stays short and literal.
  assert.deepEqual(manifest.externally_connectable.matches.sort(), ['http://127.0.0.1/*', 'http://localhost/*']);
  for (const match of manifest.externally_connectable.matches) {
    assert.doesNotMatch(match, /<all_urls>|\*:\/\/\*|https?:\/\/\*\//, `${match} is a wildcard origin`);
  }
  // Adding the dashboard must not have quietly bought any other capability.
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('site access is optional, never granted at install', () => {
  // Background refresh reads pages the user is not looking at, so it needs a
  // host permission - but as a ceiling that must be asked for one origin at a
  // time, not as something the extension arrives holding.
  assert.deepEqual(manifest.optional_host_permissions.sort(), ['http://*/*', 'https://*/*']);
  assert.ok(!manifest.optional_host_permissions.includes('<all_urls>'));
  // host_permissions is what is granted silently at install, and it stays the
  // two model providers and nothing else.
  assert.deepEqual(manifest.host_permissions, ['https://api.anthropic.com/*', 'https://api.groq.com/*']);
});

test('the extension pages ship a CSP with no remote code', () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|https?:/);
});

test('icons are real PNG files at the declared sizes', () => {
  for (const [size, file] of Object.entries(manifest.icons)) {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${file} is not a PNG`);
    assert.equal(bytes.readUInt32BE(16), Number(size), `${file} is not ${size}px wide`);
  }
});

test('no page inlines a script or a style, which the CSP would block', () => {
  // web/index.html is held to the same rule: inside the extension it is served
  // under the same CSP as every other page.
  for (const page of ['src/popup.html', 'src/options.html', 'src/welcome.html', 'src/offscreen.html', 'web/index.html']) {
    const html = readSource(page);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, `${page} has an inline <script>`);
    assert.doesNotMatch(html, /\son\w+\s*=/, `${page} has an inline event handler`);
  }
});

test('scraped values are never written into the DOM as HTML', () => {
  for (const file of ['src/popup.js', 'src/options.js', 'src/welcome.js', 'web/js/render.js', 'web/js/main.js']) {
    const source = readSource(file);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} assigns innerHTML`);
    assert.doesNotMatch(source, /insertAdjacentHTML/, `${file} uses insertAdjacentHTML`);
  }
});

test('the API key is only ever read in the service-worker side of the extension', () => {
  const popup = readSource('src/popup.js');
  assert.doesNotMatch(popup, /apiKey/, 'the popup must not touch the API key');
  assert.doesNotMatch(readSource('src/content.js'), /apiKey|api\.anthropic\.com|api\.groq\.com/, 'the content script must never see credentials');

  // The dashboard runs on a web origin in one of its two modes. Nothing in it
  // may name a credential, and it must not reach a provider directly.
  for (const file of ['web/js/main.js', 'web/js/state.js', 'web/js/bridge.js', 'web/js/render.js']) {
    assert.doesNotMatch(readSource(file), /apiKey|api\.anthropic\.com|api\.groq\.com/, `${file} must not touch credentials`);
  }
});
