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
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'offscreen', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://api.anthropic.com/*', 'https://api.groq.com/*']);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.content_scripts, undefined);
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
  for (const page of ['src/popup.html', 'src/options.html', 'src/offscreen.html']) {
    const html = readSource(page);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, `${page} has an inline <script>`);
    assert.doesNotMatch(html, /\son\w+\s*=/, `${page} has an inline event handler`);
  }
});

test('scraped values are never written into the DOM as HTML', () => {
  for (const file of ['src/popup.js', 'src/options.js']) {
    const source = readSource(file);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} assigns innerHTML`);
    assert.doesNotMatch(source, /insertAdjacentHTML/, `${file} uses insertAdjacentHTML`);
  }
});

test('the API key is only ever read in the service-worker side of the extension', () => {
  const popup = readSource('src/popup.js');
  assert.doesNotMatch(popup, /apiKey/, 'the popup must not touch the API key');
  assert.doesNotMatch(readSource('src/content.js'), /apiKey|api\.anthropic\.com|api\.groq\.com/, 'the content script must never see credentials');
});
