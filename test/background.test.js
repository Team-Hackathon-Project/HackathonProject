/**
 * End-to-end coverage of the service worker: injection, extraction, the
 * self-healing round trip, normalization, advisory fallback, and the message
 * router — all with the Chrome APIs and the Anthropic API stubbed out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, installChrome, uninstallChrome, stubFetch, messageResponse } from './helpers.mjs';
import { MSG, WORKER_MESSAGES, STORAGE_KEYS } from '../src/lib/constants.js';
import { HEALTHY_PAGE, BROKEN_PAGE, MISLEADING_PAGE, MISLEADING_ONLY_PAGE, INDEX_RAIL_PAGE } from './fixtures/pages.mjs';
import { makePage, loadContentScript } from './helpers.mjs';

let background;
let openPage = null;

/** Wires the real content script (in jsdom) up to the mocked tabs API. */
function pageBackedTabHandler(html, url) {
  const page = makePage(html, { url });
  const script = loadContentScript(page);
  openPage = page;
  return async (message) => {
    if (message.type === 'PING') return { ok: true, host: new URL(url).host };
    return script.send(message);
  };
}

function closePage() {
  if (openPage) {
    openPage.restore();
    openPage = null;
  }
}

/** Offscreen stand-in: mirrors what `src/offscreen.js` does with the snippet. */
async function offscreenSanitize(message) {
  if (message.type !== MSG.SANITIZE_HTML) return null;
  const { sanitizeSnippet } = await import('../src/lib/sanitize.js');
  const { JSDOM } = await import('jsdom');
  const body = new JSDOM(`<body>${message.payload.html}</body>`).window.document.body;
  return { ok: true, ...sanitizeSnippet(body, { maxChars: message.payload.maxChars }) };
}

test.before(async () => {
  installChrome({ storage: makeStorage() });
  background = await import('../src/background.js');
});

test.afterEach(() => {
  closePage();
  delete globalThis.fetch;
});

test('isScrapableUrl allows http(s) pages and blocks browser surfaces', () => {
  assert.equal(background.isScrapableUrl('https://finance.yahoo.com/quote/AAPL'), true);
  assert.equal(background.isScrapableUrl('http://localhost:8080/x'), true);
  assert.equal(background.isScrapableUrl('chrome://extensions'), false);
  assert.equal(background.isScrapableUrl('chrome-extension://abc/popup.html'), false);
  assert.equal(background.isScrapableUrl('about:blank'), false);
  assert.equal(background.isScrapableUrl('https://chromewebstore.google.com/detail/x'), false);
  assert.equal(background.isScrapableUrl('file:///Users/x/page.html'), false);
  assert.equal(background.isScrapableUrl('not a url'), false);
  assert.equal(background.isScrapableUrl(null), false);
});

test('a restricted tab is refused with a readable message', async () => {
  installChrome({ storage: makeStorage(), tab: { url: 'chrome://extensions' } });
  await assert.rejects(() => background.scrapeActiveTab(), /cannot be scraped/);
});

test('a healthy page scrapes into the documented payload without healing', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const chrome = installChrome({ storage: makeStorage(), tab: { url }, tabHandler: pageBackedTabHandler(HEALTHY_PAGE, url) });

  const result = await background.scrapeActiveTab();
  assert.equal(result.usable, true);
  assert.deepEqual(result.healed, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.snapshot.ticker, 'AAPL');
  assert.equal(result.snapshot.current_price, 224.5);
  assert.equal(result.snapshot.currency, 'USD');
  assert.equal(result.snapshot.change_percentage, '+1.80%');
  assert.equal(result.snapshot.volume, 52300000);
  assert.equal(result.snapshot.news.length, 2);
  assert.equal(result.snapshot.selectors_used.price_selector, '[data-testid="qsp-price"]');
  assert.ok(Date.parse(result.snapshot.extracted_at));

  // PING answered, so no redundant injection happened.
  assert.equal(chrome._calls.executeScript.length, 0);

  const stored = await chrome.storage.local.get(STORAGE_KEYS.SNAPSHOTS);
  assert.equal(stored[STORAGE_KEYS.SNAPSHOTS].AAPL.current_price, 224.5);
});

test('the content script is injected when the page does not answer PING', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const inner = pageBackedTabHandler(HEALTHY_PAGE, url);
  let pinged = 0;
  const chrome = installChrome({
    storage: makeStorage(),
    tab: { url },
    tabHandler: async (message) => {
      if (message.type === 'PING' && pinged++ === 0) return undefined; // no listener yet
      return inner(message);
    },
  });
  const result = await background.scrapeActiveTab();
  assert.equal(result.usable, true);
  assert.equal(chrome._calls.executeScript.length, 1);
  assert.deepEqual(chrome._calls.executeScript[0].files, ['src/content.js']);
  assert.equal(chrome._calls.executeScript[0].target.tabId, 7);
});

test('a renamed layout is healed end to end and the selector is persisted', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' } });
  const chrome = installChrome({
    storage,
    tab: { url },
    tabHandler: pageBackedTabHandler(BROKEN_PAGE, url),
    offscreenHandler: offscreenSanitize,
  });

  // The model answers with the selector that actually works on the new layout.
  const answers = {
    price: '.qz-8f31ab',
    change_percentage: '.qz-delta-19c',
    volume: '.qz-vol-77a',
    news: '.story h3',
    ticker: '.hdr-2026 h1',
  };
  globalThis.fetch = stubFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    const field = /Metric that failed: (\w+)/.exec(body.messages[0].content)[1];
    const payload = { selector: answers[field], strategy: 'css', confidence: 0.9, reason: 'matched the value node' };
    const { json } = messageResponse(payload);
    return { ok: true, status: 200, async text() { return JSON.stringify(json); } };
  });

  const result = await background.scrapeActiveTab();
  assert.equal(result.usable, true, `warnings: ${result.warnings.join(' | ')}`);
  assert.equal(result.snapshot.current_price, 224.5);
  assert.equal(result.snapshot.change_percentage, '+1.80%');
  assert.equal(result.snapshot.volume, 52300000);
  assert.ok(result.healed.some((entry) => entry.field === 'price' && entry.selector === '.qz-8f31ab'));

  // The offscreen document was created once and used for sanitizing.
  assert.equal(chrome._calls.createDocument.length, 1);
  assert.equal(chrome._calls.createDocument[0].reasons[0], 'DOM_PARSER');

  const registry = (await storage.local.get(STORAGE_KEYS.SELECTORS))[STORAGE_KEYS.SELECTORS];
  assert.equal(registry['finance.yahoo.com'].price.selector, '.qz-8f31ab');
  assert.equal(registry['finance.yahoo.com'].price.source, 'healed');

  const healLog = (await storage.local.get(STORAGE_KEYS.HEAL_LOG))[STORAGE_KEYS.HEAL_LOG];
  assert.ok(healLog.some((entry) => entry.healed === true));
});

test('a persisted healed selector is reused on the next scrape with no LLM call', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({
    [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' },
    [STORAGE_KEYS.SELECTORS]: {
      'finance.yahoo.com': {
        price: { selector: '.qz-8f31ab', strategy: 'css', source: 'healed' },
        change_percentage: { selector: '.qz-delta-19c', strategy: 'css', source: 'healed' },
        volume: { selector: '.qz-vol-77a', strategy: 'css', source: 'healed' },
        news: { selector: '.story h3', strategy: 'css', source: 'healed' },
      },
    },
  });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(BROKEN_PAGE, url), offscreenHandler: offscreenSanitize });
  const fetchImpl = stubFetch(messageResponse({}));
  globalThis.fetch = fetchImpl;

  const result = await background.scrapeActiveTab();
  assert.equal(result.snapshot.current_price, 224.5);
  assert.deepEqual(result.healed, []);
  assert.equal(fetchImpl.calls.length, 0, 'no repair call should be needed');
});

test('a selector the model invents but the page rejects is never persisted', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' } });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(BROKEN_PAGE, url), offscreenHandler: offscreenSanitize });
  globalThis.fetch = stubFetch(messageResponse({
    selector: '#does-not-exist', strategy: 'css', confidence: 0.95, reason: 'hallucinated',
  }));

  const result = await background.scrapeActiveTab();
  assert.deepEqual(result.healed, []);
  assert.ok(result.warnings.some((warning) => /Could not repair the price/.test(warning)));
  const registry = (await storage.local.get(STORAGE_KEYS.SELECTORS))[STORAGE_KEYS.SELECTORS];
  assert.equal(registry, undefined);
});

test('a junk match does not stop the candidate list', async () => {
  // `[class*="volume" i]` matches the "Volume" *label*; the count lives in the
  // next cell, which the structural fallback further down the list finds.
  const url = 'https://finance.yahoo.com/quote/AAPL';
  installChrome({ storage: makeStorage(), tab: { url }, tabHandler: pageBackedTabHandler(MISLEADING_PAGE, url) });
  globalThis.fetch = () => { throw new Error('the network must not be touched'); };

  const result = await background.scrapeActiveTab();

  assert.equal(result.snapshot.volume, 52300000);
  assert.equal(result.snapshot.current_price, 224.5);
  assert.deepEqual(result.warnings, []);
});

test('a field with only a junk match is reported, not invented', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  installChrome({ storage: makeStorage(), tab: { url }, tabHandler: pageBackedTabHandler(MISLEADING_ONLY_PAGE, url) });
  globalThis.fetch = () => { throw new Error('the network must not be touched'); };

  const result = await background.scrapeActiveTab();

  assert.equal(result.snapshot.volume, null);
  assert.ok(result.warnings.some((warning) => /Ignored the volume.*"Volume"/.test(warning)));
  assert.equal(result.snapshot.selectors_used.volume_selector, undefined);
  assert.equal(result.usable, true); // ticker + price still recovered
});

test('a selector that resolves to the wrong kind of value is never persisted', async () => {
  // `.qz-delta-19c` holds "(+1.80%)" — a real node, but not a price. The
  // model pointing one field at another field's node must not poison the
  // registry or invent a number in the snapshot.
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' } });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(BROKEN_PAGE, url), offscreenHandler: offscreenSanitize });
  globalThis.fetch = stubFetch(messageResponse({
    selector: '.qz-delta-19c', strategy: 'css', confidence: 0.9, reason: 'looks like the value node',
  }));

  const result = await background.scrapeActiveTab();

  assert.ok(result.warnings.some((warning) => /is not a valid price/.test(warning)));
  assert.equal(result.snapshot.current_price, null);
  assert.ok(!result.healed.some((entry) => entry.field === 'price'));

  const registry = (await storage.local.get(STORAGE_KEYS.SELECTORS))[STORAGE_KEYS.SELECTORS] || {};
  const host = (registry['finance.yahoo.com'] || {});
  assert.equal(host.price, undefined);
  assert.equal(host.news, undefined);
  // The one field the selector genuinely fits is still allowed through.
  assert.equal(host.change_percentage.selector, '.qz-delta-19c');

  const healLog = (await storage.local.get(STORAGE_KEYS.HEAL_LOG))[STORAGE_KEYS.HEAL_LOG] || [];
  const priceAttempt = healLog.find((entry) => entry.field === 'price');
  assert.equal(priceAttempt.healed, false);
  assert.match(priceAttempt.error, /not a valid price/);
});

test('a model that says the metric is absent has its reason reported', async () => {
  // The cooperative answer to "this fragment has no such metric" is confidence
  // 0 and an explanation — which is what the user needs to see, rather than an
  // "unusable selector: " with nothing after the colon.
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' } });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(BROKEN_PAGE, url), offscreenHandler: offscreenSanitize });
  globalThis.fetch = stubFetch(messageResponse({
    selector: '', strategy: 'css', confidence: 0,
    reason: 'The fragment does not contain the requested metric.',
  }));

  const result = await background.scrapeActiveTab();

  assert.ok(result.warnings.some((w) => /The fragment does not contain the requested metric\./.test(w)));
  assert.ok(!result.warnings.some((w) => /unusable selector: *$/m.test(w)));
  const healLog = (await storage.local.get(STORAGE_KEYS.HEAL_LOG))[STORAGE_KEYS.HEAL_LOG] || [];
  assert.match(healLog[0].error, /does not contain the requested metric/);
});

test('a rejected selector is sent back to the model with the reason', async () => {
  // The first answer names the right element but is not valid CSS. Told why it
  // was rejected, the model gets a second go — this is what makes the repair
  // loop work against real pages rather than fixtures.
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' } });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(BROKEN_PAGE, url), offscreenHandler: offscreenSanitize });

  const prompts = [];
  globalThis.fetch = stubFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    prompts.push(body.messages[0].content);
    const first = prompts.filter((p) => /Metric that failed: price/.test(p)).length === 1;
    const payload = first
      ? { selector: 'div.max-w-[50%]', strategy: 'css', confidence: 0.9, reason: 'the price wrapper' }
      : { selector: '.qz-8f31ab', strategy: 'css', confidence: 0.9, reason: 'the value node' };
    return {
      ok: true, status: 200, statusText: '200',
      async text() { return JSON.stringify(messageResponse(payload).json); },
    };
  });

  const result = await background.scrapeActiveTab();

  assert.equal(result.snapshot.current_price, 224.5, 'the retry recovered the price');
  assert.ok(result.healed.some((entry) => entry.field === 'price' && entry.selector === '.qz-8f31ab'));

  const retried = prompts.filter((p) => /Your previous answer was rejected/.test(p));
  assert.ok(retried.length >= 1, 'the rejection must be handed back to the model');
  assert.match(retried[0], /invalid selector syntax/);

  const healLog = (await storage.local.get(STORAGE_KEYS.HEAL_LOG))[STORAGE_KEYS.HEAL_LOG] || [];
  const priceAttempts = healLog.filter((entry) => entry.field === 'price');
  assert.equal(priceAttempts.length, 2, 'both attempts are recorded');
  assert.equal(priceAttempts.find((entry) => entry.attempt === 2).healed, true);
});

test('an honest "the metric is not here" is not retried', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' } });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(BROKEN_PAGE, url), offscreenHandler: offscreenSanitize });
  const fetchImpl = stubFetch(messageResponse({
    selector: '', strategy: 'css', confidence: 0, reason: 'The fragment does not contain that metric.',
  }));
  globalThis.fetch = fetchImpl;

  await background.scrapeActiveTab();

  const healLog = (await storage.local.get(STORAGE_KEYS.HEAL_LOG))[STORAGE_KEYS.HEAL_LOG] || [];
  const priceAttempts = healLog.filter((entry) => entry.field === 'price');
  assert.equal(priceAttempts.length, 1, 'asking again cannot conjure a metric that is not there');
});

test('a page-wide selector from the model is rejected before it reaches the page', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' } });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(BROKEN_PAGE, url), offscreenHandler: offscreenSanitize });
  globalThis.fetch = stubFetch(messageResponse({ selector: '*', strategy: 'css', confidence: 1, reason: 'everything' }));

  const result = await background.scrapeActiveTab();
  assert.ok(result.warnings.some((warning) => /unusable selector/.test(warning)));
});

test('without an API key the scrape degrades instead of failing', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  installChrome({ storage: makeStorage(), tab: { url }, tabHandler: pageBackedTabHandler(BROKEN_PAGE, url) });
  globalThis.fetch = () => { throw new Error('the network must not be touched'); };

  const result = await background.scrapeActiveTab();
  assert.equal(result.snapshot.ticker, 'AAPL'); // recovered from the h1 / URL
  assert.equal(result.snapshot.current_price, null);
  assert.equal(result.usable, false);
  assert.ok(result.warnings.some((warning) => /automatic repair needs an API key/.test(warning)));
});

test('advice falls back to the rules engine when the model output is malformed', async () => {
  installChrome({
    storage: makeStorage({
      [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' },
      [STORAGE_KEYS.PORTFOLIO]: { AAPL: { shares: 10, avg_cost: 180, target_sell_above: 220 } },
    }),
  });
  globalThis.fetch = stubFetch(messageResponse({ action: 'YOLO', confidence_score: 3 }));

  const advice = await background.adviseOn({ ticker: 'AAPL', current_price: 224.5, currency: 'USD', change_value: 1.8, news: [] });
  assert.equal(advice.source, 'heuristic');
  assert.equal(advice.action, 'SELL');
  assert.match(advice.note, /failed schema validation\./);
  assert.match(advice.note, /Showing the rules-based signal/);
  assert.equal(advice.user_action_required, true);
});

test('a valid model advisory is returned and forced human-in-the-loop', async () => {
  installChrome({
    storage: makeStorage({
      [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' },
      [STORAGE_KEYS.PORTFOLIO]: { AAPL: { shares: 10, target_sell_above: 220 } },
    }),
  });
  globalThis.fetch = stubFetch(messageResponse({
    ticker: 'AAPL', action: 'SELL', confidence_score: 0.71,
    rationale: 'Price cleared the configured sell target with strong volume.',
    user_action_required: false, // the model must not be able to switch this off
  }));

  const advice = await background.adviseOn({ ticker: 'AAPL', current_price: 224.5, currency: 'USD', news: [] });
  assert.equal(advice.source, 'llm');
  assert.equal(advice.action, 'SELL');
  assert.equal(advice.confidence_score, 0.71);
  assert.equal(advice.user_action_required, true);
});

test('advice on an unusable snapshot is refused', async () => {
  installChrome({ storage: makeStorage() });
  await assert.rejects(() => background.adviseOn({ ticker: null, current_price: null }), /without a ticker and a price/);
});

test('a position on automatic has its targets refreshed by a scan', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({
    [STORAGE_KEYS.PORTFOLIO]: { AAPL: { shares: 10, avg_cost: 200, auto_targets: true } },
  });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(HEALTHY_PAGE, url) });
  globalThis.fetch = () => { throw new Error('the network must not be touched'); };

  const result = await background.scrapeActiveTab();

  // One scan is not enough history, so it anchors on the 200 average cost.
  assert.equal(result.targets.basis, 'cost');
  assert.equal(result.targets.applied, true);
  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.equal(portfolio.AAPL.target_buy_below, 190);
  assert.equal(portfolio.AAPL.target_sell_above, 210);
  assert.ok(portfolio.AAPL.targets_updated_at, 'the write is stamped');
  assert.equal(portfolio.AAPL.shares, 10, 'the rest of the position is untouched');

  const history = (await storage.local.get(STORAGE_KEYS.PRICE_HISTORY))[STORAGE_KEYS.PRICE_HISTORY];
  assert.equal(history.AAPL.length, 1, 'the scan is kept as a price point');
  assert.equal(history.AAPL[0].price, 224.5);
});

test('a manual position is never rewritten behind the back of whoever set it', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({
    [STORAGE_KEYS.PORTFOLIO]: { AAPL: { shares: 10, avg_cost: 200, target_buy_below: 1, target_sell_above: 999 } },
  });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(HEALTHY_PAGE, url) });
  globalThis.fetch = () => { throw new Error('the network must not be touched'); };

  const result = await background.scrapeActiveTab();

  assert.equal(result.targets, null);
  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.equal(portfolio.AAPL.target_buy_below, 1);
  assert.equal(portfolio.AAPL.target_sell_above, 999);
});

test('SUGGEST_TARGETS proposes without saving, and refuses when it has nothing', async () => {
  const storage = makeStorage({
    [STORAGE_KEYS.PORTFOLIO]: { AAPL: { shares: 5, avg_cost: 180 } },
  });
  installChrome({ storage });

  const suggestion = await background.handleRequest({ type: MSG.SUGGEST_TARGETS, payload: { ticker: 'aapl' } });
  assert.equal(suggestion.ticker, 'AAPL');
  assert.equal(suggestion.basis, 'cost');
  assert.equal(suggestion.target_buy_below, 171);

  const portfolio = (await storage.local.get(STORAGE_KEYS.PORTFOLIO))[STORAGE_KEYS.PORTFOLIO];
  assert.equal(portfolio.AAPL.target_buy_below, undefined, 'a suggestion is not a save');

  await assert.rejects(
    () => background.handleRequest({ type: MSG.SUGGEST_TARGETS, payload: { ticker: 'NVDA' } }),
    /Nothing to go on for NVDA/
  );
  await assert.rejects(() => background.handleRequest({ type: MSG.SUGGEST_TARGETS, payload: {} }), /No ticker/);
});

test('the message router answers every documented request type', async () => {
  const storage = makeStorage({ [STORAGE_KEYS.SELECTORS]: { 'a.com': { price: { selector: '#p' } } } });
  installChrome({ storage });

  const decision = await background.handleRequest({
    type: MSG.RECORD_DECISION,
    payload: { ticker: 'AAPL', suggested_action: 'SELL', final_action: 'SELL', verdict: 'APPROVED' },
  });
  assert.equal(decision.executed, false, 'the extension must never mark a decision as executed');
  assert.ok(Date.parse(decision.decided_at));

  const state = await background.handleRequest({ type: MSG.GET_STATE });
  assert.equal(state.decisions.length, 1);
  assert.equal(state.provider, 'anthropic');
  assert.equal(state.model, 'claude-opus-5');
  assert.equal(state.settings.providers, undefined, 'GET_STATE must not hand provider credentials to the popup');
  assert.ok(state.registry['a.com']);
  assert.equal('apiKey' in state.settings, false, 'GET_STATE must not hand the key to the popup');
  assert.doesNotMatch(JSON.stringify(state.settings), /sk-ant|gsk_/, 'no credential may appear anywhere in the state');
  assert.equal(state.hasApiKey, false);

  const reset = await background.handleRequest({ type: MSG.RESET_SELECTORS });
  assert.deepEqual(reset.registry, {});

  // The dashboard's requests ride the same router, so an unhandled name here
  // would be a message the website can send and never get an answer to.
  const dashboard = await background.handleRequest({ type: MSG.GET_DASHBOARD_STATE });
  assert.ok(dashboard.watchlist);
  assert.ok(dashboard.priceHistory);
  assert.equal(dashboard.decisions.length, 1);
  assert.equal(dashboard.settings.providers, undefined);

  await background.handleRequest({ type: MSG.ADD_WATCH, payload: { ticker: 'AAPL' } });
  const monitored = await background.handleRequest({
    type: MSG.SET_WATCH_MONITOR, payload: { ticker: 'AAPL', monitor: false },
  });
  assert.equal(monitored.entry.monitor, false);
  assert.equal((await background.handleRequest({ type: MSG.REMOVE_WATCH, payload: { ticker: 'AAPL' } })).removed, true);

  const history = await background.handleRequest({ type: MSG.GET_PRICE_HISTORY, payload: { ticker: 'AAPL' } });
  assert.deepEqual(history, { ticker: 'AAPL', history: [] });

  // Every message the worker claims to own must actually be routed.
  for (const type of WORKER_MESSAGES) {
    await assert.doesNotReject(
      async () => {
        try {
          await background.handleRequest({ type, payload: { ticker: 'AAPL' } });
        } catch (error) {
          // A handler that refuses its input has still been reached; only an
          // unrouted name is a failure here.
          if (/Unknown message type/.test(error.message)) throw error;
        }
      },
      `${type} is not routed`
    );
  }

  await assert.rejects(() => background.handleRequest({ type: 'NOPE' }), /Unknown message type/);

  // And nothing may be on that list twice, or be a name that does not exist.
  assert.equal(new Set(WORKER_MESSAGES).size, WORKER_MESSAGES.length);
  const known = new Set(Object.values(MSG));
  for (const type of WORKER_MESSAGES) assert.ok(known.has(type), `${type} is not in MSG`);
});

test('a tab whose URL activeTab has not revealed yet is still scraped', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const chrome = installChrome({
    storage: makeStorage(),
    tab: { url: undefined },
    tabHandler: pageBackedTabHandler(HEALTHY_PAGE, url),
  });
  const result = await background.scrapeActiveTab();
  assert.equal(result.usable, true);
  assert.equal(result.host, 'finance.yahoo.com');
  // The host-specific selectors were applied on the second pass.
  assert.equal(result.snapshot.selectors_used.price_selector, '[data-testid="qsp-price"]');
  assert.equal(chrome._calls.executeScript.length, 0);
});

test('an injection Chrome refuses is reported as an unscrapable page', async () => {
  installChrome({
    storage: makeStorage(),
    tab: { url: undefined },
    tabHandler: async () => undefined,
  });
  globalThis.chrome.scripting.executeScript = async () => {
    throw new Error('Cannot access contents of the page');
  };
  await assert.rejects(() => background.scrapeActiveTab(), /cannot be scraped.*Cannot access contents/);
});

test('the offscreen parser is opened once per scrape and handed back', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { apiKey: 'sk-ant-test' } });
  const chrome = installChrome({
    storage,
    tab: { url },
    tabHandler: pageBackedTabHandler(BROKEN_PAGE, url),
    offscreenHandler: offscreenSanitize,
  });
  globalThis.fetch = stubFetch(messageResponse({ selector: '.qz-8f31ab', strategy: 'css', confidence: 0.9, reason: 'value node' }));

  await background.scrapeActiveTab();
  assert.equal(chrome._calls.createDocument.length, 1, 'several repairs must share one offscreen document');
  assert.equal(chrome._calls.closeDocument.length, 1, 'the offscreen document must be released');

  // A second scrape can open it again — which would throw if it was left open.
  closePage();
  globalThis.chrome.tabs.sendMessage = (await (async () => {
    const handler = pageBackedTabHandler(BROKEN_PAGE, url);
    return async (_tabId, message) => handler(message);
  })());
  await background.scrapeActiveTab();
  assert.equal(chrome._calls.createDocument.length, 2);
  assert.equal(chrome._calls.closeDocument.length, 2);
});


test('a price the host reports for every ticker is discarded, not shown', async () => {
  // The scan itself looks perfect: 224.50 parses, the selector resolved. What
  // gives it away is that the same host already reported 224.50 for a
  // different stock, so the number belongs to the page, not the instrument.
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({
    [STORAGE_KEYS.SNAPSHOTS]: {
      MSFT: { ticker: 'MSFT', current_price: 224.5, source_url: 'https://finance.yahoo.com/quote/MSFT' },
    },
  });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(HEALTHY_PAGE, url) });
  globalThis.fetch = () => { throw new Error('the network must not be touched'); };

  const result = await background.scrapeActiveTab();

  assert.equal(result.snapshot.current_price, null, 'the page-global price must not be shown');
  assert.equal(result.usable, false);
  assert.equal(result.snapshot.selectors_used.price_selector, undefined);
  assert.ok(result.warnings.some((warning) => /belonging to the page, not to this stock/.test(warning)));
  assert.ok(result.warnings.some((warning) => /MSFT/.test(warning)), 'the clash should name the other ticker');

  const saved = (await storage.local.get(STORAGE_KEYS.SNAPSHOTS))[STORAGE_KEYS.SNAPSHOTS];
  assert.equal(saved.AAPL, undefined, 'an unusable snapshot is not stored');
});

test('the healed selector behind a page-global price is forgotten', async () => {
  const url = 'https://finance.yahoo.com/quote/AAPL';
  const storage = makeStorage({
    [STORAGE_KEYS.SELECTORS]: {
      'finance.yahoo.com': {
        price: { selector: '[data-testid="qsp-price"]', strategy: 'css', source: 'healed', healed_at: 'earlier' },
        volume: { selector: 'fin-streamer', strategy: 'css', source: 'healed', healed_at: 'earlier' },
      },
    },
    [STORAGE_KEYS.SNAPSHOTS]: {
      MSFT: { ticker: 'MSFT', current_price: 224.5, source_url: 'https://finance.yahoo.com/quote/MSFT' },
    },
  });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(HEALTHY_PAGE, url) });
  globalThis.fetch = () => { throw new Error('the network must not be touched'); };

  const result = await background.scrapeActiveTab();

  assert.ok(result.warnings.some((warning) => /repaired selector has been reset/.test(warning)));
  const registry = (await storage.local.get(STORAGE_KEYS.SELECTORS))[STORAGE_KEYS.SELECTORS];
  assert.equal(registry['finance.yahoo.com'].price, undefined, 'the bad repair is dropped');
  assert.ok(registry['finance.yahoo.com'].volume, 'unrelated repairs are left alone');
});

test('a page that simply lacks a field says so instead of paying for a repair', async () => {
  // Google Finance as the extension actually sees it: no instrument block, an
  // h1 reading "Finance", and nothing but other instruments to look at.
  const url = 'https://www.google.com/finance/quote/AAPL:NASDAQ';
  const storage = makeStorage({ [STORAGE_KEYS.SETTINGS]: { providers: { anthropic: { apiKey: 'sk-ant-test' } } } });
  installChrome({ storage, tab: { url }, tabHandler: pageBackedTabHandler(INDEX_RAIL_PAGE, url) });
  const fetchImpl = stubFetch(messageResponse({ selector: '.x', strategy: 'css', confidence: 0.9, reason: 'guess' }));
  globalThis.fetch = fetchImpl;

  const result = await background.scrapeActiveTab();

  assert.equal(fetchImpl.calls.length, 0, 'nothing on this page is repairable, so nothing is asked');
  assert.equal(result.snapshot.ticker, 'AAPL', 'the ticker still comes from the URL');
  assert.equal(result.snapshot.current_price, null, 'no index level is passed off as a price');
  assert.ok(
    !result.warnings.some((warning) => /ticker/.test(warning)),
    'a ticker recovered from the URL is not worth warning about'
  );
  assert.ok(result.notices.some((notice) => /does not show a price/.test(notice)));
  assert.ok(result.notices.some((notice) => /does not show a volume figure/.test(notice)));
});
