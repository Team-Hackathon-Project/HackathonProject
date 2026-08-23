/**
 * Shared constants for the Self-Healing Market Scraper & Advisory Engine.
 *
 * NOTE: `src/content.js` intentionally re-declares the message-type strings it
 * needs instead of importing them. Content scripts are injected as classic
 * scripts by `chrome.scripting.executeScript`, so they cannot use ES imports.
 * `test/protocol.test.js` asserts the two copies stay in sync.
 */

import { DEFAULT_BRIDGE_URL } from './brightdata.js';

export const MSG = {
  // popup -> background
  SCRAPE_ACTIVE_TAB: 'SCRAPE_ACTIVE_TAB',
  GET_ADVICE: 'GET_ADVICE',
  RECORD_DECISION: 'RECORD_DECISION',
  GET_STATE: 'GET_STATE',
  RESET_SELECTORS: 'RESET_SELECTORS',
  TEST_PROVIDER: 'TEST_PROVIDER',
  SUGGEST_TARGETS: 'SUGGEST_TARGETS',
  // options page -> background: is the Bright Data agent bridge answering?
  TEST_BRIDGE: 'TEST_BRIDGE',
  // popup/dashboard -> background: read this ticker through Bright Data
  SCRAPE_VIA_BRIDGE: 'SCRAPE_VIA_BRIDGE',
  // dashboard -> background
  GET_DASHBOARD_STATE: 'GET_DASHBOARD_STATE',
  GET_PRICE_HISTORY: 'GET_PRICE_HISTORY',
  ADD_WATCH: 'ADD_WATCH',
  REMOVE_WATCH: 'REMOVE_WATCH',
  SET_WATCH_MONITOR: 'SET_WATCH_MONITOR',
  SAVE_POSITION: 'SAVE_POSITION',
  DELETE_POSITION: 'DELETE_POSITION',
  // content -> background
  SELECTOR_FAILED: 'SELECTOR_FAILED',
  // background -> content
  EXTRACT: 'EXTRACT',
  VALIDATE_SELECTOR: 'VALIDATE_SELECTOR',
  CAPTURE_CONTAINER: 'CAPTURE_CONTAINER',
  // dashboard -> background, refreshing a ticker the user is not looking at
  REFRESH_TICKER: 'REFRESH_TICKER',
  REFRESH_ALL: 'REFRESH_ALL',
  // Which watched hosts the extension may read. Granting one is deliberately
  // NOT a message: chrome.permissions.request() only works from an extension
  // page during a user gesture, which a service worker cannot supply and a web
  // page cannot supply on the extension's behalf. See web/js/bridge.js.
  GET_HOST_ACCESS: 'GET_HOST_ACCESS',
  // alerts
  SAVE_ALERT_RULE: 'SAVE_ALERT_RULE',
  DELETE_ALERT_RULE: 'DELETE_ALERT_RULE',
  MARK_ALERTS_SEEN: 'MARK_ALERTS_SEEN',
  CLEAR_ALERTS: 'CLEAR_ALERTS',
  SET_MONITOR: 'SET_MONITOR',
  // background -> offscreen
  SANITIZE_HTML: 'SANITIZE_HTML',
  EXTRACT_HTML: 'EXTRACT_HTML',
};

/**
 * The messages the service worker's own router must answer.
 *
 * Everything in `MSG` goes somewhere, but not all of it goes here: some names
 * travel the other way, down to the content script or the offscreen document.
 * Listing the worker's own surface explicitly means a new message type has to
 * say which side it belongs on, and `test/background.test.js` proves every name
 * on this list is actually handled rather than falling through to "unknown
 * message type" the first time a page sends it.
 */
export const WORKER_MESSAGES = [
  MSG.SCRAPE_ACTIVE_TAB,
  MSG.GET_ADVICE,
  MSG.RECORD_DECISION,
  MSG.GET_STATE,
  MSG.RESET_SELECTORS,
  MSG.TEST_PROVIDER,
  MSG.SUGGEST_TARGETS,
  MSG.TEST_BRIDGE,
  MSG.SCRAPE_VIA_BRIDGE,
  MSG.GET_DASHBOARD_STATE,
  MSG.GET_PRICE_HISTORY,
  MSG.ADD_WATCH,
  MSG.REMOVE_WATCH,
  MSG.SET_WATCH_MONITOR,
  MSG.SAVE_POSITION,
  MSG.DELETE_POSITION,
  MSG.REFRESH_TICKER,
  MSG.REFRESH_ALL,
  MSG.GET_HOST_ACCESS,
  MSG.SAVE_ALERT_RULE,
  MSG.DELETE_ALERT_RULE,
  MSG.MARK_ALERTS_SEEN,
  MSG.CLEAR_ALERTS,
  MSG.SET_MONITOR,
];

/**
 * The messages a web page on a matched origin is allowed to send.
 *
 * `chrome.runtime.onMessageExternal` is a far weaker trust boundary than the
 * popup's bus: any script on the dashboard origin can reach it. So the external
 * surface is an allowlist rather than a denylist, and everything that touches a
 * credential or the active tab is left out of it on purpose:
 *
 *   TEST_PROVIDER        accepts an API key as a payload
 *   SCRAPE_ACTIVE_TAB    activeTab means nothing when the caller is a web page
 *   RESET_SELECTORS      destructive, and belongs with the other options-page controls
 *   GET_STATE            superseded by GET_DASHBOARD_STATE, which is shaped for this
 *   TEST_BRIDGE          accepts the bridge token as a payload
 *   SCRAPE_VIA_BRIDGE    spends the user's Bright Data plan, one session per call,
 *                        and nothing on the dashboard asks for it — the control
 *                        that does live on the options page. An allowlist entry
 *                        with no caller is surface for free.
 */
export const EXTERNAL_ALLOWED = [
  MSG.GET_DASHBOARD_STATE,
  MSG.GET_PRICE_HISTORY,
  MSG.ADD_WATCH,
  MSG.REMOVE_WATCH,
  MSG.SET_WATCH_MONITOR,
  MSG.SAVE_POSITION,
  MSG.DELETE_POSITION,
  MSG.GET_ADVICE,
  MSG.RECORD_DECISION,
  MSG.SUGGEST_TARGETS,
  MSG.REFRESH_TICKER,
  MSG.REFRESH_ALL,
  MSG.GET_HOST_ACCESS,
];

export const OFFSCREEN_TARGET = 'offscreen';
export const OFFSCREEN_PATH = 'src/offscreen.html';

/** The dashboard, as served from inside the extension bundle. */
export const DASHBOARD_PATH = 'web/index.html';

export const STORAGE_KEYS = {
  SELECTORS: 'selector_registry',
  SNAPSHOTS: 'snapshots',
  DECISIONS: 'decisions',
  SETTINGS: 'settings',
  PORTFOLIO: 'portfolio',
  HEAL_LOG: 'heal_log',
  PRICE_HISTORY: 'price_history',
  WATCHLIST: 'watchlist',
  ALERT_RULES: 'alert_rules',
  ALERTS: 'alerts',
};

/** Fields the scraper tries to extract from a quote page. */
export const FIELDS = ['ticker', 'price', 'change_percentage', 'volume', 'news'];

/** Fields that must be present for a snapshot to be considered usable. */
export const REQUIRED_FIELDS = ['ticker', 'price'];

/** How each field is named when the extension talks to the user about it. */
export const FIELD_LABELS = {
  ticker: 'ticker symbol',
  price: 'price',
  change_percentage: 'daily change',
  volume: 'volume',
  news: 'headlines',
};

/**
 * Fields worth spending a model call to repair.
 *
 * Headlines are deliberately absent. They are optional colour for the
 * rationale, the pattern that locates them matches almost any prose on any
 * page, and the repair therefore fires constantly and usually fails — one call
 * spent per scan, and a warning, for something the advisory does not need.
 */
export const HEALABLE_FIELDS = ['ticker', 'price', 'change_percentage', 'volume'];

/** The same names as a noun phrase, for sentences that need an article. */
export const FIELD_PHRASES = {
  ticker: 'a ticker symbol',
  price: 'a price',
  change_percentage: 'a daily change',
  volume: 'a volume figure',
  news: 'any headlines',
};

/**
 * Credentials are held per provider so switching between them does not throw a
 * key away. `provider` selects which of them is in force; `activeLlm()` in
 * `providers.js` resolves the pair.
 */
export const DEFAULT_SETTINGS = {
  provider: 'anthropic',
  providers: {
    anthropic: { apiKey: '', model: 'claude-opus-5' },
    groq: { apiKey: '', model: 'openai/gpt-oss-120b' },
  },
  selfHealEnabled: true,
  llmAdviceEnabled: true,
  maxSnippetChars: 12000,
  /**
   * Where the standalone dashboard is served, for the options page's "Open
   * dashboard" button. Empty means "use the copy inside the extension", which
   * needs no server and no extension id.
   *
   * Changing this does not widen anything: only an origin listed in the
   * manifest's `externally_connectable.matches` can actually reach the worker,
   * and that list is fixed at build time.
   */
  dashboardOrigin: '',
  /** Set once the watchlist has been back-filled from pre-existing snapshots. */
  watchlistSeeded: false,
  /**
   * Background monitoring. Off until asked for: an extension that starts
   * fetching pages on a timer the moment it is installed, without the user
   * having said so, is not one worth trusting.
   */
  monitorEnabled: false,
  monitorIntervalMinutes: 15,
  /**
   * Whether an advice_flip rule may spend a model call on each pass.
   *
   * Off by default. The local rules engine answers the same question for free,
   * and a model call every fifteen minutes per ticker is real money spent on a
   * question that mostly answers "HOLD, same as last time".
   */
  alertsUseLlm: false,
  /**
   * The Bright Data Scraping Browser, reached through the local agent bridge.
   *
   * Off until configured, and configured means two things are running: the
   * agent (`npm run agent`) and a Bright Data zone behind it. The extension
   * cannot dial the Scraping Browser itself — the endpoint carries credentials
   * in the URL, and `new WebSocket()` is required by the HTML standard to throw
   * on those — so the bridge is not a convenience, it is the whole mechanism.
   * `src/lib/brightdata.js` documents it at length.
   *
   * `mode` places it in the background-refresh order:
   *   fallback  plain fetch, then Bright Data, then a local background tab
   *   first     Bright Data, then fetch, then a local tab
   *   only      Bright Data, and report a failure rather than opening a tab
   */
  brightdata: {
    enabled: false,
    bridgeUrl: DEFAULT_BRIDGE_URL,
    token: '',
    mode: 'fallback',
  },
};

/** The refresh-order settings `brightdata.mode` may take. */
export const BRIGHTDATA_MODES = ['fallback', 'first', 'only'];

/** Max characters of raw container HTML the content script hands to the healer. */
export const SNIPPET_LIMIT = 20000;

/**
 * How long a background refresh may spend on one page before giving up.
 *
 * Generous for a fetch and tight for a tab: a quote page that has not painted
 * a price in fifteen seconds is not going to.
 */
export const REFRESH_FETCH_TIMEOUT_MS = 12000;
export const REFRESH_TAB_TIMEOUT_MS = 15000;

/**
 * How long the worker waits on the Bright Data bridge.
 *
 * Far longer than the other two, and deliberately: the request behind it is a
 * remote browser session — connect, navigate, wait out a CAPTCHA, and possibly
 * two model round trips to repair a selector. The agent's own navigation
 * timeout is 120s, so this has to sit above it or the worker gives up on a
 * scrape that is about to succeed.
 */
export const REFRESH_BRIDGE_TIMEOUT_MS = 180000;

/** The options page's connectivity probe, which only reads /health. */
export const BRIDGE_PROBE_TIMEOUT_MS = 8000;

/** Pause between tickers in one refresh pass, so a pass is not a burst. */
export const REFRESH_GAP_MS = 700;

export const MAX_DECISIONS = 200;
/** Price points kept per ticker — enough to average over, small enough to store. */
export const MAX_PRICE_POINTS = 60;
export const MAX_HEAL_LOG = 100;
export const MAX_ALERTS = 200;

/** Chrome will not run an alarm more often than once a minute. */
export const MIN_MONITOR_MINUTES = 1;
export const MAX_MONITOR_MINUTES = 24 * 60;
export const MONITOR_ALARM = 'market-scraper-monitor';
