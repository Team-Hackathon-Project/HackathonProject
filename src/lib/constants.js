/**
 * Shared constants for the Self-Healing Market Scraper & Advisory Engine.
 *
 * NOTE: `src/content.js` intentionally re-declares the message-type strings it
 * needs instead of importing them. Content scripts are injected as classic
 * scripts by `chrome.scripting.executeScript`, so they cannot use ES imports.
 * `test/protocol.test.js` asserts the two copies stay in sync.
 */

export const MSG = {
  // popup -> background
  SCRAPE_ACTIVE_TAB: 'SCRAPE_ACTIVE_TAB',
  GET_ADVICE: 'GET_ADVICE',
  RECORD_DECISION: 'RECORD_DECISION',
  GET_STATE: 'GET_STATE',
  RESET_SELECTORS: 'RESET_SELECTORS',
  TEST_PROVIDER: 'TEST_PROVIDER',
  SUGGEST_TARGETS: 'SUGGEST_TARGETS',
  // content -> background
  SELECTOR_FAILED: 'SELECTOR_FAILED',
  // background -> content
  EXTRACT: 'EXTRACT',
  VALIDATE_SELECTOR: 'VALIDATE_SELECTOR',
  CAPTURE_CONTAINER: 'CAPTURE_CONTAINER',
  // background -> offscreen
  SANITIZE_HTML: 'SANITIZE_HTML',
};

export const OFFSCREEN_TARGET = 'offscreen';
export const OFFSCREEN_PATH = 'src/offscreen.html';

export const STORAGE_KEYS = {
  SELECTORS: 'selector_registry',
  SNAPSHOTS: 'snapshots',
  DECISIONS: 'decisions',
  SETTINGS: 'settings',
  PORTFOLIO: 'portfolio',
  HEAL_LOG: 'heal_log',
  PRICE_HISTORY: 'price_history',
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
};

/** Max characters of raw container HTML the content script hands to the healer. */
export const SNIPPET_LIMIT = 20000;

export const MAX_DECISIONS = 200;
/** Price points kept per ticker — enough to average over, small enough to store. */
export const MAX_PRICE_POINTS = 60;
export const MAX_HEAL_LOG = 100;
