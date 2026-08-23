/**
 * The Bright Data Scraping Browser session.
 *
 * Connects puppeteer-core to Bright Data's remote Chrome over CDP, loads a
 * quote page through it, and then runs the extension's *own* content script
 * inside that page so the self-healing loop in `healing.mjs` has the same three
 * operations it has in a real tab.
 *
 * Two things are worth stating plainly, because both are easy to get wrong:
 *
 *  1. The endpoint is `wss://user:password@brd.superproxy.io:9222`. The
 *     password shown in the Bright Data console is masked until you reveal it,
 *     and the masked form is a valid-looking string that fails with a bare
 *     authentication error. `parseEndpoint` rejects it by name for that reason.
 *
 *  2. `src/content.js` is injected with `Runtime.evaluate` (which is what
 *     `page.evaluate(source)` compiles to) rather than with a `<script>` tag.
 *     A `<script>` tag is subject to the target page's Content-Security-Policy,
 *     and financial sites routinely ship one strict enough to drop it; CDP
 *     evaluation is not. The script needs a `chrome.runtime.onMessage` object
 *     to attach its listener to, so a three-line shim goes in ahead of it.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { sanitizeSnippet } from '../src/lib/sanitize.js';
import { SNIPPET_LIMIT } from '../src/lib/constants.js';
import { parseEndpoint, describeEndpoint } from '../src/lib/brightdata.js';
import { ROOT } from './config.mjs';

/** The extension's content script, read once. */
const CONTENT_SOURCE = readFileSync(path.join(ROOT, 'src', 'content.js'), 'utf8');

/** The flag `src/content.js` hangs its handlers off. */
const CONTENT_FLAG = '__selfHealingMarketScraper__';

/**
 * Enough of `chrome.runtime` for the content script to register its listener.
 * The listener is never called — the driver reaches the handlers directly, the
 * same way `test/helpers.mjs` does.
 */
const CHROME_SHIM = `
(() => {
  const runtime = { onMessage: { addListener() {} }, sendMessage() {}, id: 'brightdata-agent' };
  if (!window.chrome) window.chrome = { runtime };
  else if (!window.chrome.runtime) window.chrome.runtime = runtime;
  else if (!window.chrome.runtime.onMessage) window.chrome.runtime.onMessage = runtime.onMessage;
})();
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bright Data reports a rejected connection as an HTTP status on the upgrade
 * request, which puppeteer buries inside the WebSocket error. Their own Node
 * sample digs it out the same way; without it a wrong password reads as an
 * unexplained socket close.
 */
export function describeConnectError(error) {
  const response = error && error.target && error.target._req && error.target._req.res;
  if (response) {
    const { statusCode, statusMessage } = response;
    if (statusCode === 407 || statusCode === 401 || statusCode === 403) {
      return `Bright Data rejected the credentials (HTTP ${statusCode} ${statusMessage || ''}`.trim()
        + '). Check the zone name and password on the Scraping Browser zone page.';
    }
    return `Bright Data returned HTTP ${statusCode} ${statusMessage || ''}`.trim();
  }
  return String((error && error.message) || error);
}

/**
 * Opens a Scraping Browser session.
 * `endpoint` is the raw `wss://…` string; it is parsed here so a malformed one
 * fails with a sentence rather than a socket error.
 */
export async function connectBrightData({
  endpoint, connectTimeoutMs = 60000, navigationTimeoutMs = 120000, log = () => {},
}) {
  const parsed = parseEndpoint(endpoint);
  if (!parsed.ok) throw new Error(parsed.error);
  log(`connecting to Bright Data — ${describeEndpoint(parsed)}`);
  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: parsed.endpoint,
      // `protocolTimeout` bounds every CDP call on this connection, and the
      // longest of those is the navigation. Setting it to the *connect* budget
      // caps a 120s navigation at 60s, which surfaces as "Page.navigate timed
      // out" — a timeout on the wrong clock, blaming the page for a limit it
      // was never given. It has to cover the longest call, with headroom.
      protocolTimeout: Math.max(connectTimeoutMs, navigationTimeoutMs + 30000),
    });
    log('connected');
    return browser;
  } catch (error) {
    throw new Error(describeConnectError(error));
  }
}

/** Sanitizes a captured container with the extension's own sanitizer. */
export function sanitizeWithJsdom(html, maxChars) {
  const dom = new JSDOM(String(html || ''));
  try {
    return sanitizeSnippet(dom.window.document.body, { maxChars });
  } finally {
    dom.window.close();
  }
}

/**
 * Injects the content script and returns the driver `healing.mjs` expects.
 *
 * Each method is one `page.evaluate` against the handler the content script
 * exposes, so the values that come back are byte-for-byte what the popup would
 * have received from a real tab.
 */
export async function attachDriver(page) {
  await page.evaluate(`${CHROME_SHIM}\n${CONTENT_SOURCE}\n;undefined;`);
  const ready = await page.evaluate(
    (flag) => Boolean(window[flag] && typeof window[flag].handleExtract === 'function'),
    CONTENT_FLAG,
  );
  if (!ready) throw new Error('the content script did not initialise in the Bright Data page');

  const call = (method) => async (payload) => page.evaluate(
    ({ flag, name, args }) => window[flag][name](args),
    { flag: CONTENT_FLAG, name: method, args: payload },
  );

  return {
    extract: call('handleExtract'),
    validate: call('handleValidate'),
    capture: call('handleCapture'),
  };
}

/**
 * Loads one URL through the Scraping Browser and hands back a ready driver.
 *
 * The CAPTCHA wait is best-effort by design: `Captcha.waitForSolve` is a Bright
 * Data CDP extension, so a zone or plan without it throws, and that is not a
 * reason to abandon a page that loaded perfectly well.
 */
export async function openQuotePage(browser, url, tuning = {}, log = () => {}) {
  const {
    navigationTimeoutMs = 120000,
    captchaDetectTimeoutMs = 10000,
    settleMs = 1500,
    solveCaptcha = true,
  } = tuning;

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  page.setDefaultTimeout(navigationTimeoutMs);

  const client = await page.createCDPSession();
  log(`navigating to ${url}`);
  // `domcontentloaded` rather than `networkidle`: a quote page holds open a
  // price stream, so "the network went quiet" is a condition that never arrives.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });

  let captcha = { attempted: false, status: null, error: null };
  if (solveCaptcha) {
    captcha.attempted = true;
    try {
      const result = await client.send('Captcha.waitForSolve', { detectTimeout: captchaDetectTimeoutMs });
      captcha.status = (result && result.status) || null;
      log(`captcha status: ${captcha.status}`);
    } catch (error) {
      captcha.error = String((error && error.message) || error);
      log(`captcha check unavailable: ${captcha.error}`);
    }
  }

  // Quote pages routinely paint the live number a beat after DOMContentLoaded.
  if (settleMs > 0) await sleep(settleMs);

  const driver = await attachDriver(page);
  return { page, client, driver, captcha, url: page.url(), requestedUrl: url };
}

/**
 * True when an error means the remote session died rather than the page failing.
 *
 * A Scraping Browser session is a real browser on someone else's machine: it
 * can be recycled underneath a scrape, and the CDP call in flight then fails
 * with "Target closed" or "Session closed". That is worth one clean retry with
 * a fresh session, and worth *not* retrying anything else — a page that has no
 * price will not grow one on a second connection.
 */
export function isTransientSessionError(error) {
  const message = String((error && error.message) || error);
  return /Target closed|Session closed|Connection closed|WebSocket is not open|Protocol error .*(?:Target|Session) closed/i.test(message);
}

/**
 * Everything above, for one ticker, including the session teardown.
 *
 * `run` receives `{ driver, page, host, url, captcha }` and returns whatever the
 * caller wants; the session is closed either way. Closing matters — a Scraping
 * Browser session that is left open keeps billing.
 */
export async function withQuotePage({ endpoint, url, tuning = {}, log = () => {}, attempts = 2 }, run) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await runOnce({ endpoint, url, tuning, log }, run);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientSessionError(error)) throw error;
      log(`the remote session dropped (${String(error.message || error)}) — reconnecting`);
    }
  }
  throw lastError;
}

async function runOnce({ endpoint, url, tuning, log }, run) {
  const browser = await connectBrightData({
    endpoint,
    connectTimeoutMs: tuning.connectTimeoutMs,
    navigationTimeoutMs: tuning.navigationTimeoutMs,
    log,
  });
  let page = null;
  try {
    const opened = await openQuotePage(browser, url, tuning, log);
    page = opened.page;
    const host = safeHost(opened.url) || safeHost(url);
    return await run({ ...opened, host });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // The session may already be gone; the browser close below is what matters.
      }
    }
    try {
      await browser.close();
    } catch {
      // Nothing left to release.
    }
  }
}

export function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export { SNIPPET_LIMIT };
