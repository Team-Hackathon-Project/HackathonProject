/**
 * Offscreen document — the extension's HTML parser.
 *
 * The MV3 service worker has no DOM, so the heavy work of sanitizing a scraped
 * container (dropping ads/nav/inline payloads, stripping volatile attributes,
 * budgeting the fragment down to something worth sending to an LLM) happens
 * here instead of on the user's active tab.
 */
import { MSG, OFFSCREEN_TARGET } from './lib/constants.js';
import { sanitizeSnippet } from './lib/sanitize.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== OFFSCREEN_TARGET) return undefined;
  if (message.type !== MSG.SANITIZE_HTML) return undefined;
  try {
    const { html, maxChars } = message.payload || {};
    const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
    sendResponse({ ok: true, ...sanitizeSnippet(parsed.body, { maxChars }) });
  } catch (error) {
    sendResponse({ ok: false, error: String((error && error.message) || error) });
  }
  return undefined;
});
