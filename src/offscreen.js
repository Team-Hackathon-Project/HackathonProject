/**
 * Offscreen document — the extension's HTML parser.
 *
 * The MV3 service worker has no DOM, so anything that needs one happens here
 * instead of on the user's active tab. Two jobs:
 *
 *   SANITIZE_HTML   Trim a scraped container down to something worth sending to
 *                   a model: drop ads, nav and inline payloads, strip volatile
 *                   attributes, hold to a character budget.
 *
 *   EXTRACT_HTML    Run the selector registry against a page fetched without a
 *                   browser, for a background refresh. Deliberately *not*
 *                   sanitized first — the sanitizer removes exactly the hooks
 *                   selectors match on.
 *
 * A `Document` cannot cross the message boundary, so the extraction runs here
 * and only the resulting values are sent back.
 */
import { MSG, OFFSCREEN_TARGET } from './lib/constants.js';
import { sanitizeSnippet } from './lib/sanitize.js';
import { extractAll } from './lib/extract-core.js';

const parse = (html) => new DOMParser().parseFromString(String(html || ''), 'text/html');

const HANDLERS = {
  [MSG.SANITIZE_HTML]({ html, maxChars }) {
    return sanitizeSnippet(parse(html).body, { maxChars });
  },
  [MSG.EXTRACT_HTML]({ html, candidates }) {
    return extractAll(parse(html), candidates || {});
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== OFFSCREEN_TARGET) return undefined;
  const handler = HANDLERS[message.type];
  if (!handler) return undefined;
  try {
    sendResponse({ ok: true, ...handler(message.payload || {}) });
  } catch (error) {
    sendResponse({ ok: false, error: String((error && error.message) || error) });
  }
  return undefined;
});
