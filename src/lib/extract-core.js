/**
 * Selector resolution against a parsed document.
 *
 * This is the headless half of extraction. `src/content.js` does the same job
 * inside a live tab; it cannot be shared, because a content script is injected
 * as a classic script and so cannot import anything. The project already lives
 * with that split for the message names, kept honest by
 * `test/protocol.test.js`, and `test/extract-core.test.js` does the same here:
 * it runs both implementations over the same fixtures and requires the same
 * answer.
 *
 * The split is contained by design. This module runs first, against HTML
 * fetched without a browser; anything it cannot read falls through to the tab
 * path, which renders the page for real and can repair its own selectors. So a
 * divergence costs a slower scrape, never a wrong number.
 *
 * Everything here takes an explicit `doc`, and nothing touches `chrome.*`.
 */

const LIST_FIELDS = new Set(['news']);
const MAX_SCALAR_LEN = 120;
const MAX_SCALAR_CHILDREN = 4;
const MAX_SCALAR_MATCHES = 8;
const MAX_LIST_ITEMS = 8;

/** Fields that identify *this* instrument, and so must not come from a list. */
const INSTRUMENT_FIELDS = new Set(['price', 'change_percentage', 'ticker']);

/** Regions that exist to list instruments other than this one. */
const FOREIGN_REGION_HOOKS = [
  '[role="listbox"]', '[role="tablist"]', '[role="menu"]', '[role="navigation"]',
  '[class*="market-summary" i]', '[class*="marketsummary" i]', '[class*="watchlist" i]',
  '[class*="ticker-tape" i]', '[class*="movers" i]', '[class*="index-list" i]',
  '[aria-label*="market summary" i]',
].join(',');

const LIST_LIKE = 'table,ul,ol,[role="table"],[role="list"],[role="listbox"],[role="grid"]';

const CROSS_INSTRUMENT_MIN_PEERS = 3;

/** The shape each field's value takes, used to spot a list of instruments. */
const FIELD_PATTERNS = {
  price: /^[^\d]{0,3}\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?[^\d%]{0,4}$/,
  change_percentage: /[-+−(]?\s*\d+(?:[.,]\d+)?\s*%/,
  volume: /^\s*\d[\d.,]*\s*[KkMmBbTt]?\s*$/,
  ticker: /^[A-Z][A-Z0-9.\-]{0,9}$/,
  news: /\S{3,}\s+\S{3,}/,
};

/* ------------------------------------------------------------------ *
 * Querying
 * ------------------------------------------------------------------ */

function runCss(doc, selector, all) {
  try {
    return all
      ? Array.from(doc.querySelectorAll(selector))
      : [doc.querySelector(selector)].filter(Boolean);
  } catch {
    return null; // invalid selector syntax
  }
}

function runXpath(doc, expression, all) {
  try {
    // A document from DOMParser has no defaultView, so the result-type
    // constants come from whichever realm is actually available.
    const XPathResultRef = (doc.defaultView && doc.defaultView.XPathResult)
      || (typeof XPathResult !== 'undefined' ? XPathResult : null);
    if (!XPathResultRef || typeof doc.evaluate !== 'function') return null;

    const type = all ? XPathResultRef.ORDERED_NODE_SNAPSHOT_TYPE : XPathResultRef.FIRST_ORDERED_NODE_TYPE;
    const result = doc.evaluate(expression, doc, null, type, null);
    if (!all) return result.singleNodeValue ? [result.singleNodeValue] : [];
    const nodes = [];
    for (let index = 0; index < result.snapshotLength; index++) nodes.push(result.snapshotItem(index));
    return nodes;
  } catch {
    return null;
  }
}

/** Runs one selector entry. Returns null on a syntactically invalid selector. */
export function query(doc, entry, all) {
  const nodes = entry.strategy === 'xpath'
    ? runXpath(doc, entry.selector, all)
    : runCss(doc, entry.selector, all);
  if (nodes === null) return null;
  return nodes.filter((node) => node && node.nodeType === 1);
}

/* ------------------------------------------------------------------ *
 * Reading a value out of an element
 * ------------------------------------------------------------------ */

/** Pulls display text out of an element, including value-carrying attributes. */
export function readText(element) {
  if (!element) return '';
  for (const attribute of ['data-value', 'data-last-price', 'value', 'content']) {
    const raw = element.getAttribute && element.getAttribute(attribute);
    if (raw && raw.trim()) return raw.trim();
  }
  return (element.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * A metric selector must land on the value itself, not on a wrapper that
 * happens to contain it. A node with many element children is a container.
 */
export function isValueElement(element) {
  if (!element) return false;
  return element.querySelectorAll('*').length <= MAX_SCALAR_CHILDREN;
}

/* ------------------------------------------------------------------ *
 * Rejecting another instrument's numbers
 * ------------------------------------------------------------------ */

/**
 * True when `element` sits inside a region whose whole job is to list *other*
 * instruments: an index rail, a watchlist, a top-movers strip.
 */
export function isForeignRegion(doc, element) {
  // Starts at the element itself: a candidate can *be* the rail, not merely
  // sit inside one.
  let node = element;
  for (let depth = 0; depth < 8 && node && node !== doc.body; depth++) {
    try {
      if (node.matches(FOREIGN_REGION_HOOKS)) return true;
    } catch {
      // A selector list this engine cannot parse is not a scrape failure.
    }
    node = node.parentElement;
  }
  return false;
}

/** How many leaf descendants of `root` read as a value of this shape. */
function countPeers(root, pattern) {
  let peers = 0;
  const nodes = root.querySelectorAll('*');
  for (let index = 0; index < nodes.length && index < 400; index++) {
    const node = nodes[index];
    if (node.children.length) continue;
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 40 && pattern.test(text)) peers++;
    if (peers >= CROSS_INSTRUMENT_MIN_PEERS) return peers;
  }
  return peers;
}

/**
 * True when `element` holds a value belonging to some other instrument.
 *
 * Stricter than `isForeignRegion`: it adds a structural test — a list-like
 * ancestor holding three or more values of the same shape is a table of
 * instruments rather than one quote — and applies only to the fields that
 * identify the instrument. A plain table of three numbers is exactly where a
 * quote page keeps *this* stock's volume.
 */
export function isCrossInstrument(doc, element, field) {
  if (!element || !INSTRUMENT_FIELDS.has(field)) return false;
  if (isForeignRegion(doc, element)) return true;
  const pattern = FIELD_PATTERNS[field];
  if (!pattern) return false;

  let node = element;
  for (let depth = 0; depth < 8 && node && node !== doc.body; depth++) {
    try {
      if (node.matches(LIST_LIKE) && countPeers(node, pattern) >= CROSS_INSTRUMENT_MIN_PEERS) return true;
    } catch {
      // As above.
    }
    node = node.parentElement;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

/** Walks one field's candidates in order and returns the first real value. */
export function extractField(doc, field, candidates) {
  const wantList = LIST_FIELDS.has(field);
  for (const entry of candidates || []) {
    // Scalars still produce one value, but every match is collected so a first
    // hit inside an index rail can be stepped over instead of taken.
    const nodes = query(doc, entry, true);
    if (!nodes || nodes.length === 0) continue;

    if (wantList) {
      const values = nodes.map(readText).filter((text) => text.length >= 12).slice(0, MAX_LIST_ITEMS);
      if (values.length) return { value: values, used: entry };
    } else {
      for (const node of nodes.slice(0, MAX_SCALAR_MATCHES)) {
        if (isCrossInstrument(doc, node, field)) continue;
        const value = readText(node);
        if (value && value.length <= MAX_SCALAR_LEN && isValueElement(node)) return { value, used: entry };
      }
    }
  }
  return null;
}

/**
 * Runs a whole candidate map against a document.
 *
 * Returns the same `{ raw, used, failures }` shape the content script's
 * `handleExtract` returns, minus the container snippets: this path does not
 * heal, so there is nothing to send a model. A field it cannot read is simply
 * reported, and the caller falls back to the tab.
 */
export function extractAll(doc, candidates = {}) {
  const raw = {};
  const used = {};
  const failures = [];

  for (const [field, entries] of Object.entries(candidates)) {
    const found = extractField(doc, field, entries);
    if (found) {
      raw[field] = found.value;
      used[field] = found.used;
    } else {
      // Matches the content script exactly: a list field that found nothing is
      // an empty list, not a null. `normalizeNews` and the parity test both
      // depend on the two paths agreeing about that.
      raw[field] = LIST_FIELDS.has(field) ? [] : null;
      failures.push({ field, tried: (entries || []).map((entry) => entry.selector) });
    }
  }

  return { raw, used, failures };
}
