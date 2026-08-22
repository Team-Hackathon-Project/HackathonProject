/** Test doubles for the Chrome extension APIs and a jsdom page loader. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Minimal in-memory `chrome.storage.local` with the promise-based MV3 API. */
export function makeStorage(initial = {}) {
  let data = structuredClone(initial);
  return {
    _dump: () => structuredClone(data),
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return structuredClone(data);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in data) out[key] = structuredClone(data[key]);
        return out;
      },
      async set(items) {
        data = { ...data, ...structuredClone(items) };
      },
      async clear() {
        data = {};
      },
    },
  };
}

/**
 * Installs a `globalThis.chrome` double.
 * `tabHandler(message)` stands in for the content script.
 */
export function installChrome({
  storage = makeStorage(),
  tab = {},
  tabHandler = async () => null,
  offscreenHandler = null,
  /** Origins the user has granted. Background refresh reads nothing without one. */
  grantedOrigins = [],
} = {}) {
  const calls = {
    executeScript: [], createDocument: [], closeDocument: [], runtimeMessages: [],
    messageListeners: [], externalListeners: [],
    permissionRequests: [], tabsCreated: [], tabsRemoved: [],
    alarms: [], alarmsCleared: [], alarmListeners: [],
    notifications: [], notificationsCleared: [], notificationListeners: [],
    badge: [],
  };
  const granted = new Set(grantedOrigins);
  const alarms = new Map();
  let grantPermission = true;
  const chrome = {
    _calls: calls,
    storage,
    runtime: {
      lastError: null,
      id: 'abcdefghijklmnopabcdefghijklmnop',
      onMessage: { addListener(fn) { calls.messageListeners.push(fn); } },
      // The dashboard's bus. Registered the same way the popup's is, so a
      // worker that forgets to answer external callers fails a test rather
      // than silently dropping every request the website makes.
      onMessageExternal: { addListener(fn) { calls.externalListeners.push(fn); } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      async getContexts() {
        const open = calls.createDocument.length > calls.closeDocument.length;
        return open ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
      },
      async sendMessage(message) {
        calls.runtimeMessages.push(message);
        if (offscreenHandler) return offscreenHandler(message);
        return null;
      },
      openOptionsPage() {},
    },
    tabs: {
      async query() {
        return [{ id: 7, url: 'https://finance.example.com/quote/AAPL', ...tab }];
      },
      async sendMessage(_tabId, message) {
        const response = await tabHandler(message);
        if (response === undefined) throw new Error('Could not establish connection.');
        return response;
      },
      // The background-refresh fallback opens a tab, waits for it, then closes
      // it. The double reports "complete" straight away so the wait resolves on
      // the already-loaded branch rather than needing a fake event.
      async create(options) {
        const created = { id: 900 + calls.tabsCreated.length, status: 'complete', ...options };
        calls.tabsCreated.push(created);
        return created;
      },
      async get(tabId) {
        const found = calls.tabsCreated.find((entry) => entry.id === tabId);
        if (!found) throw new Error('No tab with id ' + tabId);
        return found;
      },
      async remove(tabId) {
        calls.tabsRemoved.push(tabId);
      },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    scripting: {
      async executeScript(options) {
        calls.executeScript.push(options);
        return [{ result: null }];
      },
    },
    /**
     * The monitor loop's clock. Alarms are recorded rather than run, so a test
     * fires a pass by calling it directly and still gets to assert on what the
     * worker asked to be scheduled.
     */
    alarms: {
      async create(name, options) {
        calls.alarms.push({ name, options });
        alarms.set(name, options);
      },
      async clear(name) {
        calls.alarmsCleared.push(name);
        return alarms.delete(name);
      },
      async getAll() {
        return [...alarms.entries()].map(([name, options]) => ({ name, ...options }));
      },
      onAlarm: { addListener(fn) { calls.alarmListeners.push(fn); } },
    },
    notifications: {
      async create(id, options) {
        calls.notifications.push({ id, options });
        return id;
      },
      async clear(id) {
        calls.notificationsCleared.push(id);
        return true;
      },
      onClicked: { addListener(fn) { calls.notificationListeners.push(fn); } },
    },
    action: {
      async setBadgeText(options) { calls.badge.push(options.text); },
      async setBadgeBackgroundColor() {},
    },
    /**
     * Optional host permissions. `contains` is what gates every background
     * refresh, so a test that forgets to grant an origin sees the same refusal
     * a user who has not granted it would.
     */
    permissions: {
      async contains({ origins = [] }) {
        return origins.every((origin) => granted.has(origin));
      },
      async request({ origins = [] }) {
        calls.permissionRequests.push(origins);
        if (!grantPermission) return false;
        for (const origin of origins) granted.add(origin);
        return true;
      },
      async remove({ origins = [] }) {
        for (const origin of origins) granted.delete(origin);
        return true;
      },
    },
    offscreen: {
      async createDocument(options) {
        if (calls.createDocument.length > calls.closeDocument.length) {
          throw new Error('Only a single offscreen document may be created.');
        }
        calls.createDocument.push(options);
      },
      async closeDocument() {
        calls.closeDocument.push(Date.now());
      },
    },
  };
  chrome._alarms = alarms;
  chrome._grant = (origin) => granted.add(origin);
  chrome._revoke = (origin) => granted.delete(origin);
  chrome._refusePermission = () => { grantPermission = false; };
  globalThis.chrome = chrome;
  return chrome;
}

/**
 * A `fetch` double for the background-refresh tests.
 *
 * `responses` maps a URL substring to the HTML to serve, or to an Error to
 * throw. Anything unmatched 404s, which is what an unconfigured URL should look
 * like rather than a silent empty page.
 */
export function stubPageFetch(responses = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const match = Object.keys(responses).find((key) => String(url).includes(key));
    const body = match === undefined ? null : responses[match];
    if (body instanceof Error) throw body;
    if (body === null) return { ok: false, status: 404, async text() { return ''; } };
    return { ok: true, status: 200, async text() { return body; } };
  };
  impl.calls = calls;
  return impl;
}

export function uninstallChrome() {
  delete globalThis.chrome;
}

const root = new URL('../', import.meta.url);

export function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, root)), 'utf8');
}

/** Builds a jsdom window and exposes it on the globals the source expects. */
export function makePage(html, { url = 'https://finance.example.com/quote/AAPL' } = {}) {
    // `outside-only` gives the page a real `window.eval` in the jsdom realm
  // without letting the fixture's own <script> tags run.
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    XPathResult: globalThis.XPathResult,
    DOMParser: globalThis.DOMParser,
  };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.XPathResult = window.XPathResult;
  globalThis.DOMParser = window.DOMParser;
  return {
    window,
    document: window.document,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
      window.close();
    },
  };
}

/** Loads `src/content.js` into a jsdom page and returns its exposed internals. */
export function loadContentScript(page) {
  const source = readSource('src/content.js');
  // Listeners accumulate across injections so a test can assert the guard held.
  const listeners = page.window.__listeners || (page.window.__listeners = []);
  page.window.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
          page.window.__listenerCount = listeners.length;
        },
      },
    },
  };
  page.window.eval(source);
  const api = page.window.__selfHealingMarketScraper__;
  return {
    api,
    /**
     * Drives the script through its real message listener. The response is
     * round-tripped through JSON because chrome.runtime messaging serializes
     * it the same way — and it detaches the value from the jsdom realm.
     */
    send(message) {
      return new Promise((resolve) => {
        listeners[0](message, {}, (response) => resolve(JSON.parse(JSON.stringify(response))));
      });
    },
  };
}

/** A stub `fetch` that returns the given Anthropic-shaped JSON body. */
export function stubFetch(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(url, init);
    const { status = 200, json = {}, text = null } = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      async text() {
        return text === null ? JSON.stringify(json) : text;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

/** Anthropic response envelope carrying one structured-output JSON payload. */
export function messageResponse(payload) {
  return {
    json: {
      id: 'msg_test',
      type: 'message',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

/** Groq/OpenAI-shaped response envelope carrying one JSON payload. */
export function groqResponse(payload, { raw = null } = {}) {
  return {
    json: {
      id: 'chatcmpl_test',
      object: 'chat.completion',
      model: 'openai/gpt-oss-120b',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: raw === null ? JSON.stringify(payload) : raw },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    },
  };
}
